import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';

import rendererHtml from '../desktop/renderer/index.html' with { type: 'text' };
import rendererCss from '../desktop/renderer/styles.css' with { type: 'text' };
import rendererJs from '../desktop/renderer/renderer.js' with { type: 'text' };
import logoSvg from '../desktop/assets/logo.svg' with { type: 'text' };
import pluginLua from '../roblox/ArenaStudioConnecter.server.lua' with { type: 'text' };
import iconAsset from '../desktop/assets/icon.ico' with { type: 'file' };
import iconPngAsset from '../desktop/assets/icon.png' with { type: 'file' };
import nativeAddonAsset from '../.standalone-cache/native-window.win32-x64-msvc.node' with { type: 'file' };
import cloudflaredAsset from '../.standalone-cache/cloudflared-windows-amd64.exe' with { type: 'file' };

import { BridgeServer } from '../src/server.js';
import { DEFAULTS } from '../src/core/config.js';
import { buildAgentPrompt, buildGuideUrl } from '../src/core/agentPrompt.js';
import { PluginDiscoveryServer } from '../desktop/discoveryServer.js';
import { CloudflareTunnel } from '../desktop/cloudflareTunnel.js';
import { installStudioPlugin } from '../desktop/pluginInstaller.js';
import { WindowsSettingsStore } from './windowsSettingsStore.js';

const APP_VERSION = '2.0.0';
const ARENA_URL = 'https://arena.ai/agent';
const appData = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Arena Studio Connecter');
const runtimeDir = path.join(appData, 'runtime');
const require = createRequire(import.meta.url);

let bridge = null;
let discovery = null;
let tunnel = null;
let nativeWindow = null;
let controlServer = null;
let controlOrigin = null;
let shuttingDown = false;
let maximized = false;
let windowPosition = { x: 50, y: 20 };
let dragState = null;
let bridgeState = { status: 'starting', message: 'Lokale Bridge wird gestartet …' };
let discoveryState = { status: 'starting', message: 'Studio-Erkennung wird gestartet …' };
let pluginState = { status: 'starting', installed: false, message: 'Plugin wird installiert …' };

fs.mkdirSync(runtimeDir, { recursive: true });
const launcherCandidate = String(process.env.ASC_LAUNCHER_PATH ?? '').replace(/^"|"$/g, '');
const launchExecutable = launcherCandidate
  && path.isAbsolute(launcherCandidate)
  && path.extname(launcherCandidate).toLowerCase() === '.exe'
  && fs.existsSync(launcherCandidate)
  ? launcherCandidate
  : process.execPath;
const settings = new WindowsSettingsStore({
  filePath: path.join(appData, 'settings.json'),
  // A compressed download wrapper runs the app from a temporary directory.
  // In that case autostart must point back to the persistent wrapper itself.
  executablePath: launchExecutable,
});

function materialize(asset, destination, minimumSize = 1) {
  try {
    if (fs.existsSync(destination) && fs.statSync(destination).size >= minimumSize) return destination;
  } catch { /* rewrite */ }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const bytes = fs.readFileSync(asset);
  if (bytes.length < minimumSize) throw new Error(`Eingebettete Resource ist unvollständig: ${path.basename(destination)}`);
  fs.writeFileSync(destination, bytes);
  return destination;
}

const nativeAddonPath = materialize(nativeAddonAsset, path.join(runtimeDir, 'native-window.node'), 1_000_000);
const cloudflaredPath = materialize(cloudflaredAsset, path.join(runtimeDir, 'cloudflared.exe'), 40_000_000);
const iconPath = materialize(iconAsset, path.join(runtimeDir, 'icon.ico'), 10_000);

function snapshot() {
  const places = bridge?.session.activeClients(65_000) ?? [];
  return {
    app: { name: 'Arena Studio Connecter', version: APP_VERSION, platform: 'win32', packaged: true },
    bridge: {
      ...bridgeState,
      localUrl: bridge?.url ?? null,
      uptimeSeconds: bridge?.session.uptimeSeconds() ?? 0,
      tokenMasked: bridge?.session ? `${bridge.session.token.slice(0, 8)}••••${bridge.session.token.slice(-4)}` : null,
    },
    tunnel: tunnel?.snapshot() ?? { status: 'starting', url: null, message: 'Tunnel wird gestartet …' },
    plugin: { ...pluginState, connected: places.length > 0, connectedPlaces: places.length, discovery: discoveryState },
    places,
    settings: settings.publicState(),
    now: Date.now(),
  };
}

function send(res, status, body, contentType = 'application/json; charset=utf-8') {
  const data = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': data.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-src 'none'",
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 64 * 1024) {
        reject(new Error('Request ist zu groß.'));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(new Error('Ungültiges JSON.')); }
    });
    req.on('error', reject);
  });
}

function openExternal(url) {
  if (url !== ARENA_URL) throw new Error('External URL blocked.');
  spawn('cmd.exe', ['/d', '/s', '/c', 'start', '""', url], { detached: true, windowsHide: true, stdio: 'ignore' }).unref();
}

function copyToClipboard(value) {
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-Command', 'Set-Clipboard -Value $env:ASC_CLIPBOARD'], {
    windowsHide: true,
    encoding: 'utf8',
    env: { ...process.env, ASC_CLIPBOARD: value },
    timeout: 10_000,
  });
  if (result.status !== 0) throw new Error('Der Prompt konnte nicht in die Zwischenablage kopiert werden.');
}

async function retryTunnel() {
  if (!bridge?.url || !tunnel) throw new Error('Die lokale Bridge läuft noch nicht.');
  await tunnel.start(bridge.url);
  return tunnel.snapshot();
}

function installPlugin() {
  pluginState = installStudioPlugin({ source: pluginLua });
  return pluginState;
}

async function handleApi(req, res, pathname) {
  const origin = req.headers.origin;
  if (origin && origin !== controlOrigin) return send(res, 403, { error: 'Origin blocked.' });

  if (req.method === 'GET' && pathname === '/api/state') return send(res, 200, snapshot());
  if (req.method !== 'POST' || !pathname.startsWith('/api/')) return send(res, 404, { error: 'Not found.' });
  if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) return send(res, 415, { error: 'JSON required.' });

  const body = await readBody(req);
  switch (pathname) {
    case '/api/copy-prompt': {
      const client = bridge?.session.activeClients(65_000).find((entry) => entry.id === body.clientId);
      const tunnelUrl = tunnel?.snapshot().url;
      if (!client) throw new Error('Diese Place ist nicht mehr verbunden.');
      if (!tunnelUrl) throw new Error('Der Cloudflare-Tunnel ist noch nicht online.');
      copyToClipboard(buildAgentPrompt({ tunnelUrl, token: bridge.session.token, client }));
      return send(res, 200, { ok: true, guideUrl: buildGuideUrl(tunnelUrl, client.id), message: 'Arena-Prompt wurde kopiert.' });
    }
    case '/api/open-arena': openExternal(ARENA_URL); return send(res, 200, { ok: true });
    case '/api/retry-tunnel': return send(res, 200, await retryTunnel());
    case '/api/reinstall-plugin': return send(res, 200, installPlugin());
    case '/api/show-plugin':
      if (pluginState.path) spawn('explorer.exe', ['/select,', pluginState.path], { detached: true, windowsHide: true }).unref();
      return send(res, 200, { ok: Boolean(pluginState.path) });
    case '/api/save-api-key': return send(res, 200, settings.saveApiKey(body.value));
    case '/api/clear-api-key': return send(res, 200, settings.clearApiKey());
    case '/api/launch-at-login': return send(res, 200, settings.setLaunchAtLogin(body.enabled));
    case '/api/window/minimize': nativeWindow?.minimize(); return send(res, 200, { ok: true });
    case '/api/window/maximize':
      if (maximized) nativeWindow?.unmaximize(); else nativeWindow?.maximize();
      maximized = !maximized;
      return send(res, 200, { ok: true });
    case '/api/window/close': send(res, 200, { ok: true }); nativeWindow?.close(); return;
    default: return send(res, 404, { error: 'Not found.' });
  }
}

function startControlServer() {
  return new Promise((resolve, reject) => {
    controlServer = http.createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const pathname = url.pathname;
      const statics = {
        '/': [rendererHtml, 'text/html; charset=utf-8'],
        '/index.html': [rendererHtml, 'text/html; charset=utf-8'],
        '/styles.css': [rendererCss, 'text/css; charset=utf-8'],
        '/renderer.js': [rendererJs, 'text/javascript; charset=utf-8'],
        '/assets/logo.svg': [logoSvg, 'image/svg+xml; charset=utf-8'],
        '/assets/icon.png': [fs.readFileSync(iconPngAsset), 'image/png'],
      };
      if (statics[pathname] && req.method === 'GET') return send(res, 200, statics[pathname][0], statics[pathname][1]);
      handleApi(req, res, pathname).catch((error) => send(res, 500, { error: error.message }));
    });
    controlServer.once('error', reject);
    controlServer.listen(0, '127.0.0.1', () => {
      const port = controlServer.address().port;
      controlOrigin = `http://127.0.0.1:${port}`;
      resolve(controlOrigin);
    });
  });
}

async function startServices() {
  installPlugin();
  bridge = new BridgeServer({
    ...DEFAULTS,
    host: '127.0.0.1',
    port: 0,
    dashboard: false,
    openBrowser: false,
    logFile: path.join(appData, 'logs', 'bridge.log'),
    sessionFile: path.join(runtimeDir, 'session.json'),
  });
  try {
    await bridge.start();
    bridgeState = { status: 'online', message: 'Lokale Bridge läuft.' };
  } catch (error) {
    bridgeState = { status: 'error', message: `Bridge-Start fehlgeschlagen: ${error.message}` };
    return;
  }

  discovery = new PluginDiscoveryServer({ getSession: () => bridge.session });
  try {
    const info = await discovery.start();
    discoveryState = { status: 'online', message: `Plugin-Erkennung läuft auf Port ${info.port}.` };
  } catch (error) {
    discoveryState = { status: 'error', message: error.message };
  }

  tunnel = new CloudflareTunnel({ executable: cloudflaredPath });
  void tunnel.start(bridge.url);
}

function handleWindowMessage(raw, sourceUrl) {
  if (!String(sourceUrl).startsWith(controlOrigin)) return;
  let message;
  try { message = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return; }
  switch (message?.type) {
    case 'window:minimize': nativeWindow.minimize(); break;
    case 'window:toggle-maximize':
      if (maximized) nativeWindow.unmaximize(); else nativeWindow.maximize();
      maximized = !maximized;
      break;
    case 'window:close': nativeWindow.close(); break;
    case 'window:drag-start':
      dragState = { mouseX: message.screenX, mouseY: message.screenY, x: windowPosition.x, y: windowPosition.y };
      break;
    case 'window:drag-move':
      if (dragState && !maximized) nativeWindow.setPosition(
        Math.round(dragState.x + message.screenX - dragState.mouseX),
        Math.round(dragState.y + message.screenY - dragState.mouseY),
      );
      break;
    case 'window:drag-end': dragState = null; break;
    default: break;
  }
}

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await tunnel?.stop().catch(() => {});
  await discovery?.stop().catch(() => {});
  await bridge?.stop().catch(() => {});
  await new Promise((resolve) => controlServer?.close(() => resolve()) ?? resolve());
  process.exit(0);
}

function showFatal(error) {
  spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show($env:ASC_ERROR, "Arena Studio Connecter")'], {
    windowsHide: true,
    env: { ...process.env, ASC_ERROR: String(error?.message ?? error) },
  });
}

try {
  await startControlServer();
  const binding = require(nativeAddonPath);
  const runtime = binding.checkRuntime();
  if (!runtime.available) binding.ensureRuntime();

  nativeWindow = new binding.NativeWindow({
    title: 'Arena Studio Connecter',
    x: windowPosition.x,
    y: windowPosition.y,
    width: 1180,
    height: 690,
    minWidth: 900,
    minHeight: 600,
    decorations: false,
    resizable: true,
    visible: true,
    devtools: false,
    icon: iconPath,
    incognito: true,
    trustedOrigins: [controlOrigin],
    allowedHosts: ['127.0.0.1'],
  });
  nativeWindow.onMessage(handleWindowMessage);
  nativeWindow.onMove((x, y) => { windowPosition = { x, y }; });
  nativeWindow.onClose(() => { void shutdown(); });
  nativeWindow.loadUrl(controlOrigin);
  void startServices();

  process.on('SIGINT', () => { void shutdown(); });
  process.on('SIGTERM', () => { void shutdown(); });
  process.on('uncaughtException', (error) => {
    try { fs.appendFileSync(path.join(appData, 'fatal.log'), `${new Date().toISOString()} ${error.stack || error}\n`); } catch { /* ignore */ }
  });
} catch (error) {
  showFatal(error);
  await shutdown();
}
