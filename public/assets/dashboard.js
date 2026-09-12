/* NexusAI Bridge dashboard — dependency free.
   The token is never baked in: it comes from ?token= or the input field and
   is kept in sessionStorage only. */

const $ = (id) => document.getElementById(id);

const state = {
  token: '',
  connected: false,
  timer: null,
  actions: [],
};

const EXAMPLES = {
  ping: {},
  run_luau: { code: 'print("Hello from NexusAI Bridge")\nreturn workspace:GetChildren()' },
  get_place_info: {},
  list_instances: { path: 'game.Workspace', depth: 1 },
  get_instance: { path: 'game.Workspace.Baseplate' },
  create_instance: { className: 'Part', parent: 'game.Workspace', properties: { Name: 'NexusPart', Anchored: true } },
  set_property: { path: 'game.Workspace.NexusPart', property: 'Transparency', value: 0.5 },
  delete_instance: { path: 'game.Workspace.NexusPart' },
  get_script_source: { path: 'game.ServerScriptService.Main' },
  set_script_source: { path: 'game.ServerScriptService.Main', source: 'print("updated")' },
  get_selection: {},
  set_selection: { paths: ['game.Workspace.Baseplate'] },
  get_output: { limit: 50 },
};

// ---------------------------------------------------------------- transport

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${state.token}`,
      'X-Client-Name': 'dashboard',
      ...(options.headers || {}),
    },
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    const message = data?.error?.message || `HTTP ${res.status}`;
    const err = new Error(message);
    err.status = res.status;
    err.payload = data;
    throw err;
  }
  return data;
}

// ------------------------------------------------------------------ helpers

function setConnected(ok, label) {
  state.connected = ok;
  $('dot').className = `dot ${ok ? 'ok' : 'err'}`;
  $('conn').textContent = label ?? (ok ? 'verbunden' : 'getrennt');
}

function fmtDuration(seconds) {
  if (!Number.isFinite(seconds)) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h > 0 ? `${h}h ${m}m ${s}s` : m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// -------------------------------------------------------------- rendering

function renderStatus(data) {
  $('s-status').textContent = data.status ?? '—';
  $('s-id').textContent = data.sessionId ?? '—';
  $('s-url').textContent = data.url ?? '—';
  $('s-pid').textContent = data.pid ?? '—';
  $('s-started').textContent = data.startedAt ? new Date(data.startedAt).toLocaleString() : '—';
  $('s-token').textContent = data.tokenMasked ?? '—';
  $('s-rot').textContent = data.tokenRotations ?? 0;
  $('uptime').textContent = `uptime ${fmtDuration(data.uptimeSeconds)}`;

  const s = data.stats ?? {};
  $('st-req').textContent = s.requests ?? 0;
  $('st-ok').textContent = s.authOk ?? 0;
  $('st-fail').textContent = s.authFailed ?? 0;
  $('st-q').textContent = s.commandsQueued ?? 0;
  $('st-done').textContent = s.commandsCompleted ?? 0;
  $('st-err').textContent = s.commandsFailed ?? 0;

  const clients = data.clients ?? [];
  $('clients').innerHTML = clients.length
    ? clients.map((c) => `<tr><td class="mono">${escapeHtml(c.name)}</td><td class="mono">${escapeHtml(c.version)}</td><td class="mono">${escapeHtml(c.place ?? '—')}</td><td>${Math.round(c.lastSeenMs / 1000)}s</td></tr>`).join('')
    : '<tr><td colspan="4" style="color:var(--muted)">Kein Client verbunden — starte das NexusAI-Plugin in Roblox Studio.</td></tr>';

  const history = data.queue?.history ?? [];
  $('history').innerHTML = history.length
    ? history.map((c) => `<tr><td class="mono">${escapeHtml(c.id)}</td><td class="mono">${escapeHtml(c.action)}</td><td><span class="tag ${escapeHtml(c.state)}">${escapeHtml(c.state)}</span></td><td>${c.durationMs ?? '—'} ms</td></tr>`).join('')
    : '<tr><td colspan="4" style="color:var(--muted)">—</td></tr>';

  if (state.actions.length === 0 && Array.isArray(data.actions)) {
    state.actions = data.actions;
    $('action').innerHTML = data.actions.map((a) => `<option value="${escapeHtml(a)}">${escapeHtml(a)}</option>`).join('');
    $('action').value = 'run_luau';
    fillExample();
  }

  const base = data.url ?? location.origin;
  $('snippet').textContent = [
    '# curl',
    `curl -H "Authorization: Bearer ${state.token}" ${base}/status`,
    '',
    '# Befehl senden',
    `curl -X POST ${base}/command -H "Authorization: Bearer ${state.token}" \\`,
    `  -H "Content-Type: application/json" -d '{"action":"ping"}'`,
    '',
    '# MCP (JSON-RPC)',
    `curl -X POST ${base}/mcp -H "Authorization: Bearer ${state.token}" \\`,
    `  -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`,
  ].join('\n');
}

function renderLogs(entries) {
  const box = $('logs');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  box.innerHTML = entries.length
    ? entries.map((e) => `<div><time>${escapeHtml(e.ts.slice(11, 23))}</time><span class="lvl ${escapeHtml(e.level)}">${escapeHtml(e.level)}</span><span>${escapeHtml(e.msg)}</span></div>`).join('')
    : '<div style="color:var(--muted)">Keine Logeinträge.</div>';
  if ($('autoscroll').checked && nearBottom) box.scrollTop = box.scrollHeight;
}

// ------------------------------------------------------------------ polling

async function refresh() {
  if (!state.token) return;
  try {
    const [status, logs] = await Promise.all([
      api('/status'),
      api(`/logs?limit=150&level=${encodeURIComponent($('loglevel').value)}`),
    ]);
    setConnected(true);
    renderStatus(status);
    renderLogs(logs.entries ?? []);
  } catch (err) {
    setConnected(false, err.status === 403 ? 'Token ungültig' : err.status === 401 ? 'Token fehlt' : 'Bridge offline');
  }
}

function startPolling() {
  if (state.timer) clearInterval(state.timer);
  refresh();
  state.timer = setInterval(refresh, 2000);
}

// ------------------------------------------------------------------ actions

function fillExample() {
  const action = $('action').value;
  $('params').value = JSON.stringify(EXAMPLES[action] ?? {}, null, 2);
}

async function sendCommand() {
  $('cmd-err').textContent = '';
  let params;
  try {
    params = JSON.parse($('params').value || '{}');
  } catch (err) {
    $('cmd-err').textContent = `Ungültiges JSON: ${err.message}`;
    return;
  }

  const button = $('send');
  button.disabled = true;
  button.textContent = 'Läuft…';
  $('cmd-out').textContent = 'Warte auf Roblox Studio…';
  try {
    const data = await api('/command', {
      method: 'POST',
      body: JSON.stringify({ action: $('action').value, params }),
    });
    $('cmd-out').textContent = JSON.stringify(data.command, null, 2);
  } catch (err) {
    $('cmd-out').textContent = JSON.stringify(err.payload ?? { error: err.message }, null, 2);
    $('cmd-err').textContent = err.message;
  } finally {
    button.disabled = false;
    button.textContent = 'Senden';
    refresh();
  }
}

async function rotateToken() {
  if (!confirm('Neuen Token erzeugen? Der aktuelle Token wird sofort ungültig.')) return;
  try {
    const data = await api('/token/rotate', { method: 'POST' });
    state.token = data.token;
    sessionStorage.setItem('nexusai_token', data.token);
    $('token').value = data.token;
    alert(`Neuer Token:\n\n${data.token}\n\nBitte in allen Clients (Studio-Plugin, CLI) aktualisieren.`);
    refresh();
  } catch (err) {
    alert(`Rotation fehlgeschlagen: ${err.message}`);
  }
}

function connect() {
  const token = $('token').value.trim();
  if (!token) { setConnected(false, 'Token fehlt'); return; }
  state.token = token;
  sessionStorage.setItem('nexusai_token', token);
  startPolling();
}

// --------------------------------------------------------------------- init

$('connect').addEventListener('click', connect);
$('token').addEventListener('keydown', (e) => { if (e.key === 'Enter') connect(); });
$('toggle').addEventListener('click', () => {
  $('token').type = $('token').type === 'password' ? 'text' : 'password';
});
$('send').addEventListener('click', sendCommand);
$('fill').addEventListener('click', fillExample);
$('action').addEventListener('change', fillExample);
$('rotate').addEventListener('click', rotateToken);
$('loglevel').addEventListener('change', refresh);
$('copy').addEventListener('click', async () => {
  if (!state.token) return;
  try {
    await navigator.clipboard.writeText(state.token);
    $('copy').textContent = 'Kopiert!';
    setTimeout(() => { $('copy').textContent = 'Token kopieren'; }, 1500);
  } catch {
    alert(state.token);
  }
});

// Token from ?token= (bridge start link) or sessionStorage
const urlToken = new URLSearchParams(location.search).get('token');
const savedToken = sessionStorage.getItem('nexusai_token');
if (urlToken) {
  $('token').value = urlToken;
  // Remove the token from the address bar so it does not linger in history.
  history.replaceState(null, '', location.pathname);
  connect();
} else if (savedToken) {
  $('token').value = savedToken;
  connect();
}
