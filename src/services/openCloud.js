import fs from 'node:fs';
import path from 'node:path';

const ASSETS_URL = 'https://apis.roblox.com/assets/v1/assets';
const OPERATIONS_BASE_URL = 'https://apis.roblox.com/assets/v1/';
const MAX_MODEL_BYTES = 20 * 1024 * 1024;
const FORMATS = {
  '.fbx': 'model/fbx',
  '.glb': 'model/gltf-binary',
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function cloudMessage(body, status) {
  const issue = body?.errors?.[0] ?? body?.error ?? body;
  const message = issue?.userFacingMessage ?? issue?.message ?? body?.message ?? `Open Cloud HTTP ${status}`;
  return typeof message === 'string' ? message : `Open Cloud HTTP ${status}`;
}

/** Small, secret-safe client for the Open Cloud Assets API. */
export class OpenCloudAssetsClient {
  constructor({ getApiKey, fetchImpl = globalThis.fetch, sleep = wait, now = () => Date.now() } = {}) {
    this.getApiKey = getApiKey;
    this.fetch = fetchImpl;
    this.sleep = sleep;
    this.now = now;
  }

  async request(url, options = {}) {
    const apiKey = String(this.getApiKey?.() ?? '').trim();
    if (!apiKey) throw new Error('Kein Open-Cloud-API-Key gespeichert. Trage ihn zuerst in den Einstellungen ein.');
    if (typeof this.fetch !== 'function') throw new Error('HTTP Fetch ist in dieser Laufzeit nicht verfügbar.');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    try {
      const response = await this.fetch(url, {
        ...options,
        headers: { ...(options.headers ?? {}), 'x-api-key': apiKey },
        signal: controller.signal,
      });
      const text = await response.text();
      let body = null;
      try { body = text ? JSON.parse(text) : {}; } catch { body = { message: text.slice(0, 500) }; }
      if (!response.ok) {
        const error = new Error(`Open Cloud (${response.status}): ${cloudMessage(body, response.status)}`);
        error.status = response.status;
        throw error;
      }
      return body;
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('Open Cloud hat nicht rechtzeitig geantwortet. Bitte erneut versuchen.');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async uploadModel({ filePath, displayName, description = '', creatorType = 'user', creatorId }) {
    const extension = path.extname(filePath).toLowerCase();
    const contentType = FORMATS[extension];
    if (!contentType) throw new Error('Open Cloud akzeptiert hier nur Blender-Exporte als .fbx oder .glb.');
    if (!/^[1-9]\d{0,19}$/.test(String(creatorId ?? ''))) {
      throw new Error('Für den Upload wird eine gültige Roblox-Creator-ID benötigt.');
    }
    if (!['user', 'group'].includes(creatorType)) throw new Error('Creator-Typ muss "user" oder "group" sein.');

    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size <= 0) throw new Error('Der Blender-Export ist leer oder nicht vorhanden.');
    if (stat.size > MAX_MODEL_BYTES) throw new Error('Der Export ist größer als 20 MB. Reduziere das Mesh und versuche es erneut.');

    const creator = creatorType === 'group' ? { groupId: String(creatorId) } : { userId: String(creatorId) };
    const form = new FormData();
    form.append('request', JSON.stringify({
      assetType: 'Model',
      displayName: String(displayName).slice(0, 100),
      description: String(description ?? '').slice(0, 1000),
      creationContext: { creator },
    }));
    const bytes = fs.readFileSync(filePath);
    form.append('fileContent', new Blob([bytes], { type: contentType }), path.basename(filePath));

    let operation = await this.request(ASSETS_URL, { method: 'POST', body: form });
    const deadline = this.now() + 180_000;
    while (!operation?.done || !operation?.response?.assetId) {
      if (operation?.error) throw new Error(`Open-Cloud-Upload fehlgeschlagen: ${cloudMessage(operation.error, 'unknown')}`);
      const operationPath = String(operation?.path ?? '');
      if (!/^operations\/[A-Za-z0-9_-]+$/.test(operationPath)) {
        throw new Error('Open Cloud hat keine gültige Upload-Operation zurückgegeben.');
      }
      if (this.now() >= deadline) throw new Error('Der Open-Cloud-Upload ist noch in Bearbeitung. Prüfe dein Inventar und versuche es später erneut.');
      await this.sleep(1_500);
      operation = await this.request(`${OPERATIONS_BASE_URL}${operationPath}`);
    }

    const asset = operation.response;
    const assetId = String(asset.assetId);
    return {
      assetId,
      assetUrl: `https://www.roblox.com/library/${assetId}/`,
      displayName: asset.displayName ?? displayName,
      revisionId: asset.revisionId ?? null,
      moderationState: asset.moderationResult?.moderationState ?? null,
    };
  }
}

export { MAX_MODEL_BYTES };
