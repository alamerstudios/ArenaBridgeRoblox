const PLACE_TTL_MS = 6 * 60 * 60 * 1000;
const AVATAR_TTL_MS = 24 * 60 * 60 * 1000;
const ERROR_TTL_MS = 5 * 60 * 1000;
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

function numericId(value) {
  const text = String(value ?? '');
  return /^[1-9]\d{0,19}$/.test(text) ? text : null;
}

async function responseBuffer(response, maximum) {
  if (!response.body) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maximum) throw new Error('Roblox-Antwort ist zu groß.');
    return bytes;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maximum) throw new Error('Roblox-Antwort ist zu groß.');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * Resolves public Roblox metadata outside the renderer. Avatars are cached as
 * data URLs, so the WebView never needs an external-content CSP exception.
 */
export class RobloxMetadataService {
  constructor({ fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
    if (typeof fetchImpl !== 'function') throw new Error('Fetch wird für Roblox-Metadaten benötigt.');
    this.fetch = fetchImpl;
    this.now = now;
    this.places = new Map();
    this.avatars = new Map();
  }

  async request(url, accept = 'application/json') {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      return await this.fetch(url, {
        headers: { Accept: accept, 'User-Agent': 'Arena-Studio-Connecter/2' },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  cached(map, key) {
    const entry = map.get(key);
    if (!entry || entry.expires <= this.now()) return undefined;
    return entry.value;
  }

  remember(map, key, value, ttl) {
    map.set(key, { value, expires: this.now() + ttl });
  }

  schedule(map, key, loader) {
    if (!key || map.has(key) && (map.get(key).pending || map.get(key).expires > this.now())) return;
    const pending = loader()
      .then((value) => {
        this.remember(map, key, value, value ? (map === this.avatars ? AVATAR_TTL_MS : PLACE_TTL_MS) : ERROR_TTL_MS);
      })
      .catch(() => {
        this.remember(map, key, null, ERROR_TTL_MS);
      })
      .finally(() => {
        const entry = map.get(key);
        if (entry) delete entry.pending;
      });
    map.set(key, { pending, expires: Infinity, value: null });
  }

  async loadPlaceName(placeId) {
    const response = await this.request(`https://economy.roblox.com/v2/assets/${placeId}/details`);
    if (!response.ok) throw new Error(`Place-Metadaten HTTP ${response.status}`);
    const body = await response.json();
    const name = typeof body?.Name === 'string' ? body.Name.trim() : '';
    return name || null;
  }

  async loadAvatar(userId) {
    const response = await this.request(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userId}&size=150x150&format=Png&isCircular=false`);
    if (!response.ok) throw new Error(`Avatar-Metadaten HTTP ${response.status}`);
    const body = await response.json();
    const item = body?.data?.find((entry) => String(entry?.targetId) === String(userId)) ?? body?.data?.[0];
    if (!item?.imageUrl || !['Completed', 'Pending'].includes(item.state)) return null;
    if (item.state === 'Pending') return null;

    const imageUrl = new URL(item.imageUrl);
    if (imageUrl.protocol !== 'https:' || !(imageUrl.hostname === 'rbxcdn.com' || imageUrl.hostname.endsWith('.rbxcdn.com'))) {
      throw new Error('Nicht vertrauenswürdiger Avatar-Host.');
    }
    const image = await this.request(imageUrl, 'image/*');
    if (!image.ok) throw new Error(`Avatar-Bild HTTP ${image.status}`);
    const contentType = String(image.headers.get('content-type') ?? '').split(';')[0].toLowerCase();
    if (!/^image\/(png|jpeg|webp|gif)$/.test(contentType)) throw new Error('Ungültiges Avatar-Bildformat.');
    const bytes = await responseBuffer(image, MAX_AVATAR_BYTES);
    if (!bytes.length) return null;
    return `data:${contentType};base64,${bytes.toString('base64')}`;
  }

  /** Synchronously decorate a snapshot and refresh stale values in background. */
  decorate(places) {
    for (const place of places) {
      const placeId = numericId(place.placeId ?? place.place);
      const userId = numericId(place.accountUserId);
      if (placeId && this.cached(this.places, placeId) === undefined) {
        this.schedule(this.places, placeId, () => this.loadPlaceName(placeId));
      }
      if (userId && this.cached(this.avatars, userId) === undefined) {
        this.schedule(this.avatars, userId, () => this.loadAvatar(userId));
      }
    }

    return places.map((place) => {
      const placeId = numericId(place.placeId ?? place.place);
      const userId = numericId(place.accountUserId);
      const publishedName = placeId ? this.cached(this.places, placeId) : undefined;
      const accountAvatar = userId ? this.cached(this.avatars, userId) : undefined;
      return {
        ...place,
        ...(publishedName ? { placeName: publishedName } : {}),
        ...(accountAvatar ? { accountAvatar } : {}),
      };
    });
  }
}

export { numericId };
