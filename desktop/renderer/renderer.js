const api = window.arenaDesktop;
const byId = (id) => document.getElementById(id);

let currentState = null;
let selectedClientId = null;
let placesSignature = '';
let noticeDismissed = false;

const icons = {
  place: '<svg viewBox="0 0 24 24"><path d="M4 7.5 12 3l8 4.5v9L12 21l-8-4.5v-9Z"/><path d="m4.4 7.7 7.6 4.4 7.6-4.4M12 12.1V21"/></svg>',
  user: '<svg viewBox="0 0 20 20"><circle cx="10" cy="7" r="3"/><path d="M4.5 17c.5-3 2.4-4.5 5.5-4.5s5 1.5 5.5 4.5"/></svg>',
  copy: '<svg viewBox="0 0 20 20"><rect x="6.5" y="6.5" width="9" height="9" rx="1.5"/><path d="M4.5 13.5h-.3A1.7 1.7 0 0 1 2.5 11.8V4.2a1.7 1.7 0 0 1 1.7-1.7h7.6a1.7 1.7 0 0 1 1.7 1.7v.3"/></svg>',
  check: '<svg viewBox="0 0 20 20"><path d="m4 10.5 3.5 3.5L16 5.5"/></svg>',
};

function text(value, fallback = '—') {
  return value === undefined || value === null || value === '' ? fallback : String(value);
}

function statusClass(status) {
  if (['online', 'installed'].includes(status)) return 'online';
  if (['starting', 'idle'].includes(status)) return 'starting';
  return status === 'error' ? 'error' : '';
}

function setStatus(dotId, labelId, status, label) {
  byId(dotId).className = `status-dot ${statusClass(status)}`;
  byId(labelId).textContent = label;
}

function showToast(title, message, kind = 'success') {
  const toast = document.createElement('div');
  toast.className = `toast ${kind}`;
  const icon = document.createElement('span');
  icon.className = 'toast-icon';
  icon.textContent = kind === 'error' ? '!' : '✓';
  const copy = document.createElement('p');
  const strong = document.createElement('strong');
  const detail = document.createElement('span');
  strong.textContent = title;
  detail.textContent = message;
  copy.append(strong, detail);
  toast.append(icon, copy);
  byId('toast-region').append(toast);
  setTimeout(() => {
    toast.classList.add('out');
    setTimeout(() => toast.remove(), 240);
  }, 3_400);
}

function renderPlaceCard(client, index, tunnelOnline) {
  const card = document.createElement('article');
  card.className = `place-card${client.id === selectedClientId ? ' selected' : ''}`;
  card.style.setProperty('--i', index);
  card.dataset.clientId = client.id;

  const top = document.createElement('div');
  top.className = 'place-top';
  const icon = document.createElement('div');
  icon.className = 'place-icon';
  icon.innerHTML = icons.place;
  const title = document.createElement('div');
  title.className = 'place-title';
  const h3 = document.createElement('h3');
  const placeId = client.placeId ?? client.place;
  h3.textContent = text(client.placeName, Number(placeId) > 0 ? `Place ${placeId}` : 'Unveröffentlichte Place');
  const identifier = document.createElement('p');
  identifier.textContent = Number(placeId) > 0 ? `PLACE ID  ·  ${placeId}` : 'LOKALE / UNVERÖFFENTLICHTE PLACE';
  title.append(h3, identifier);
  const live = document.createElement('span');
  live.className = 'live-pill';
  live.innerHTML = '<i></i> LIVE';
  top.append(icon, title, live);

  const meta = document.createElement('div');
  meta.className = 'place-meta';
  const values = [
    ['Universe', client.gameId && Number(client.gameId) > 0 ? client.gameId : 'Lokal'],
    ['Place Version', client.placeVersion && Number(client.placeVersion) > 0 ? `v${client.placeVersion}` : 'Entwurf'],
    ['Plugin', `v${text(client.version, '1.0')}`],
  ];
  for (const [label, value] of values) {
    const box = document.createElement('div');
    const caption = document.createElement('span');
    const result = document.createElement('strong');
    caption.textContent = label;
    result.textContent = text(value);
    box.append(caption, result);
    meta.append(box);
  }

  const bottom = document.createElement('div');
  bottom.className = 'place-bottom';
  const account = document.createElement('div');
  account.className = 'place-account';
  account.innerHTML = icons.user;
  const accountText = document.createElement('span');
  accountText.textContent = text(client.accountName, client.accountUserId ? `User ${client.accountUserId}` : 'Studio Account');
  account.append(accountText);

  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'copy-prompt';
  copy.disabled = !tunnelOnline;
  copy.title = tunnelOnline ? 'Fertigen Verbindungs-Prompt kopieren' : 'Warte, bis der Cloudflare-Tunnel online ist';
  copy.innerHTML = `${icons.copy}<span>${tunnelOnline ? 'Prompt kopieren' : 'Tunnel startet …'}</span>`;
  copy.addEventListener('click', async (event) => {
    event.stopPropagation();
    selectedClientId = client.id;
    renderAccount(currentState.places);
    try {
      copy.disabled = true;
      const result = await api.copyPrompt(client.id);
      copy.classList.add('copied');
      copy.innerHTML = `${icons.check}<span>Kopiert!</span>`;
      showToast('Prompt kopiert', 'Füge ihn jetzt in einen neuen Arena-Agent-Chat ein.');
      setTimeout(() => {
        copy.classList.remove('copied');
        copy.disabled = false;
        copy.innerHTML = `${icons.copy}<span>Prompt kopieren</span>`;
      }, 1_800);
      return result;
    } catch (error) {
      copy.disabled = false;
      showToast('Kopieren fehlgeschlagen', error.message, 'error');
    }
  });

  bottom.append(account, copy);
  card.append(top, meta, bottom);
  card.addEventListener('click', () => {
    selectedClientId = client.id;
    document.querySelectorAll('.place-card').forEach((entry) => entry.classList.toggle('selected', entry.dataset.clientId === client.id));
    renderAccount(currentState.places);
  });
  return card;
}

function renderPlaces(state) {
  const places = state.places ?? [];
  const tunnelOnline = state.tunnel?.status === 'online';
  if (!places.some((place) => place.id === selectedClientId)) selectedClientId = places[0]?.id ?? null;

  byId('place-count').textContent = String(places.length);
  byId('empty-state').classList.toggle('hidden', places.length > 0);
  byId('place-grid').classList.toggle('hidden', places.length === 0);
  byId('session-subtitle').textContent = places.length
    ? `${places.length} ${places.length === 1 ? 'Place ist' : 'Places sind'} gerade verbunden`
    : 'Suche nach geöffneten Places …';

  const signature = JSON.stringify({
    tunnelOnline,
    selectedClientId,
    places: places.map((place) => [
      place.id, place.placeName, place.placeId, place.place, place.gameId, place.placeVersion,
      place.version, place.accountName, place.accountUserId,
    ]),
  });
  if (signature !== placesSignature) {
    placesSignature = signature;
    const grid = byId('place-grid');
    grid.replaceChildren(...places.map((client, index) => renderPlaceCard(client, index, tunnelOnline)));
  }
  renderAccount(places);
}

function renderAccount(places) {
  const client = places.find((place) => place.id === selectedClientId) ?? places[0];
  const name = client?.accountDisplayName || client?.accountName;
  byId('account-name').textContent = text(name, client ? 'Studio Account' : 'Nicht verbunden');
  byId('account-id').textContent = client?.accountUserId ? `@${text(client.accountName, 'Roblox')} · ID ${client.accountUserId}` : (client ? text(client.placeName, 'Place verbunden') : 'Öffne eine Place');
  byId('account-avatar').textContent = name ? name.trim().charAt(0).toUpperCase() : '?';
  byId('account-online').classList.toggle('online', Boolean(client));
}

function renderServices(state) {
  const bridgeStatus = state.bridge?.status ?? 'starting';
  const tunnelStatus = state.tunnel?.status ?? 'starting';
  const pluginStatus = state.plugin?.status ?? 'starting';
  const connectedPlaces = state.places?.length ?? 0;

  setStatus('bridge-dot', 'bridge-label', bridgeStatus, bridgeStatus === 'online' ? 'Online' : text(state.bridge?.message, 'Startet …'));
  setStatus('tunnel-dot', 'tunnel-label', tunnelStatus, tunnelStatus === 'online' ? 'HTTPS online' : text(state.tunnel?.message, 'Startet …'));
  setStatus('plugin-dot', 'plugin-label', pluginStatus,
    connectedPlaces ? `${connectedPlaces} ${connectedPlaces === 1 ? 'Place verbunden' : 'Places verbunden'}` : (pluginStatus === 'installed' ? 'Installiert' : text(state.plugin?.message, 'Prüfe …')));

  const allCoreOnline = bridgeStatus === 'online' && tunnelStatus === 'online';
  const heading = byId('heading-status');
  const ring = heading.querySelector('.pulse-ring');
  const title = heading.querySelector('strong');
  const detail = heading.querySelector('small');
  ring.className = `pulse-ring ${allCoreOnline ? 'online' : (bridgeStatus === 'error' || tunnelStatus === 'error' ? 'error' : '')}`;
  if (allCoreOnline && connectedPlaces) {
    title.textContent = 'Bereit für Arena Agent';
    detail.textContent = `${connectedPlaces} aktive Studio-${connectedPlaces === 1 ? 'Session' : 'Sessions'}`;
  } else if (allCoreOnline) {
    title.textContent = 'Warte auf Roblox Studio';
    detail.textContent = 'Bridge und Tunnel sind bereit';
  } else if (bridgeStatus === 'error' || tunnelStatus === 'error') {
    title.textContent = 'Aktion erforderlich';
    detail.textContent = bridgeStatus === 'error' ? 'Lokale Bridge prüfen' : 'Tunnel erneut verbinden';
  } else {
    title.textContent = 'System startet';
    detail.textContent = 'Verbindungen werden vorbereitet';
  }

  const tunnelFailed = tunnelStatus === 'error';
  byId('retry-tunnel').classList.toggle('hidden', !tunnelFailed);
  const showNotice = state.plugin?.updated === true && connectedPlaces === 0 && !noticeDismissed;
  byId('restart-notice').classList.toggle('hidden', !showNotice);
}

function setBadge(element, label, status = '') {
  element.textContent = label;
  element.className = `config-badge ${statusClass(status)}`;
}

function renderSettings(state) {
  const settings = state.settings ?? {};
  setBadge(byId('api-key-badge'), settings.hasApiKey ? 'SICHER GESPEICHERT' : 'NICHT GESETZT', settings.hasApiKey ? 'online' : '');
  byId('api-key').placeholder = settings.hasApiKey ? `Gespeichert: ${settings.apiKeyMasked}` : 'Open Cloud API Key einfügen';
  byId('clear-api-key').classList.toggle('hidden', !settings.hasApiKey);
  byId('launch-at-login').checked = settings.launchAtLogin === true;

  const plugin = state.plugin ?? {};
  setBadge(byId('plugin-badge'), plugin.installed ? (plugin.connected ? 'VERBUNDEN' : 'INSTALLIERT') : 'FEHLER', plugin.installed ? 'online' : 'error');
  byId('plugin-detail-status').textContent = text(plugin.message, 'Unbekannt');
  byId('plugin-path').textContent = text(plugin.path);

  const tunnel = state.tunnel ?? {};
  setBadge(byId('tunnel-badge'), tunnel.status === 'online' ? 'ONLINE' : tunnel.status === 'error' ? 'FEHLER' : 'STARTET …', tunnel.status);
  byId('tunnel-url').textContent = text(tunnel.url, 'Noch nicht verfügbar');
}

function render(state) {
  currentState = state;
  byId('title-version').textContent = `v${text(state.app?.version, '—')}`;
  renderServices(state);
  renderPlaces(state);
  renderSettings(state);
}

function switchView(name) {
  document.querySelectorAll('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.view === name));
  document.querySelectorAll('.view').forEach((view) => view.classList.toggle('active', view.id === `view-${name}`));
  byId(`view-${name}`)?.closest('.main-content')?.scrollTo({ top: 0, behavior: 'smooth' });
}

async function retryTunnel(button) {
  const previous = button.textContent;
  button.disabled = true;
  button.textContent = 'Verbinde …';
  try {
    await api.retryTunnel();
    showToast('Tunnel wird aufgebaut', 'Die neue HTTPS-Adresse ist gleich verfügbar.');
  } catch (error) {
    showToast('Tunnel-Fehler', error.message, 'error');
  } finally {
    button.disabled = false;
    button.textContent = previous;
  }
}

function wireEvents() {
  document.querySelectorAll('.nav-item').forEach((item) => item.addEventListener('click', () => switchView(item.dataset.view)));
  byId('window-minimize').addEventListener('click', () => api.minimize());
  byId('window-maximize').addEventListener('click', () => api.toggleMaximize());
  byId('window-close').addEventListener('click', () => api.close());
  byId('open-arena').addEventListener('click', async () => {
    try { await api.openArena(); } catch (error) { showToast('Browser konnte nicht geöffnet werden', error.message, 'error'); }
  });
  byId('dismiss-notice').addEventListener('click', () => {
    noticeDismissed = true;
    byId('restart-notice').classList.add('hidden');
  });
  byId('retry-tunnel').addEventListener('click', (event) => retryTunnel(event.currentTarget));
  byId('settings-retry-tunnel').addEventListener('click', (event) => retryTunnel(event.currentTarget));

  byId('toggle-api-key').addEventListener('click', () => {
    const input = byId('api-key');
    input.type = input.type === 'password' ? 'text' : 'password';
  });
  byId('save-api-key').addEventListener('click', async () => {
    const input = byId('api-key');
    if (!input.value.trim()) return showToast('API Key fehlt', 'Füge zuerst deinen Open-Cloud-API-Key ein.', 'error');
    try {
      await api.saveApiKey(input.value);
      input.value = '';
      input.type = 'password';
      showToast('API Key gespeichert', 'Der Key wurde lokal mit Windows DPAPI verschlüsselt.');
    } catch (error) {
      showToast('Speichern fehlgeschlagen', error.message, 'error');
    }
  });
  byId('clear-api-key').addEventListener('click', async () => {
    try {
      await api.clearApiKey();
      byId('api-key').value = '';
      showToast('API Key gelöscht', 'Der gespeicherte Key wurde von diesem Gerät entfernt.');
    } catch (error) { showToast('Löschen fehlgeschlagen', error.message, 'error'); }
  });
  byId('launch-at-login').addEventListener('change', async (event) => {
    try {
      await api.setLaunchAtLogin(event.currentTarget.checked);
      showToast('Windows-Start aktualisiert', event.currentTarget.checked ? 'Die App startet nach deiner Anmeldung.' : 'Autostart wurde deaktiviert.');
    } catch (error) { showToast('Einstellung fehlgeschlagen', error.message, 'error'); }
  });
  byId('reinstall-plugin').addEventListener('click', async () => {
    try {
      const result = await api.reinstallPlugin();
      noticeDismissed = false;
      showToast(result.installed ? 'Plugin installiert' : 'Plugin-Fehler', result.message, result.installed ? 'success' : 'error');
    } catch (error) { showToast('Plugin-Fehler', error.message, 'error'); }
  });
  byId('show-plugin').addEventListener('click', async () => {
    try { await api.showPluginFile(); } catch (error) { showToast('Datei nicht gefunden', error.message, 'error'); }
  });
}

const demoState = {
  app: { version: '1.1.0' },
  bridge: { status: 'online', message: 'Lokale Bridge läuft.' },
  tunnel: { status: 'online', url: 'https://studio-arena-demo.trycloudflare.com', message: 'Cloudflare-Tunnel ist online.' },
  plugin: { status: 'installed', installed: true, connected: true, connectedPlaces: 2, message: 'Plugin ist installiert und aktuell.', path: 'C:\\Users\\Arena\\AppData\\Local\\Roblox\\Plugins\\ArenaStudioConnecter.rbxmx' },
  settings: { hasApiKey: true, apiKeyMasked: 'rblx-••••••••7K2A', encryptionAvailable: true, launchAtLogin: true },
  places: [
    { id: 'studio-a91e4c', placeName: 'Neon District', placeId: 18402938401, gameId: 6129473051, placeVersion: 87, version: '2.0.0', accountName: 'ArenaBuilder', accountDisplayName: 'Arena Builder', accountUserId: 48192017 },
    { id: 'studio-c44f2a', placeName: 'Obby Prototype', placeId: 9981726304, gameId: 4430291882, placeVersion: 12, version: '2.0.0', accountName: 'ArenaBuilder', accountDisplayName: 'Arena Builder', accountUserId: 48192017 },
  ],
};

wireEvents();
if (api) {
  api.onState(render);
  api.getState().then(render).catch((error) => showToast('App-Start fehlgeschlagen', error.message, 'error'));
} else if (new URLSearchParams(location.search).has('demo')) {
  render(demoState);
} else {
  render({ ...demoState, places: [], tunnel: { status: 'starting' }, bridge: { status: 'starting' }, plugin: { status: 'starting' }, settings: {} });
}
