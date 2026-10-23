import { app, BrowserWindow, clipboard, ipcMain, safeStorage, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { BridgeServer } from '../src/server.js';
import { DEFAULTS } from '../src/core/config.js';
import { buildAgentPrompt, buildGuideUrl } from '../src/core/agentPrompt.js';
import { PluginDiscoveryServer } from './discoveryServer.js';
import { CloudflareTunnel } from './cloudflareTunnel.js';
import { installStudioPlugin } from './pluginInstaller.js';
import { SettingsStore } from './settingsStore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, '..');
const ARENA_AGENT_URL = 'https://arena.ai/agent';

let mainWindow = null;
let bridge = null;
let discovery = null;
let tunnel = null;
let settings = null;
let pluginState = { status: 'starting', installed: false, message: 'Plugin wird installiert …' };
let bridgeState = { status: 'starting', message: 'Lokale Bridge wird gestartet …' };
let discoveryState = { status: 'starting', message: 'Studio-Erkennung wird gestartet …' };
let stateTimer = null;
let shuttingDown = false;
let allowQuit = false;

function resourcePath(...parts) {
  return path.join(app.isPackaged ? app.getAppPath() : APP_ROOT, ...parts);
}

function cloudflaredPath() {
  if (process.env.CLOUDFLARED_PATH && fs.existsSync(process.env.CLOUDFLARED_PATH)) return process.env.CLOUDFLARED_PATH;
  if (app.isPackaged) return path.join(process.resourcesPath, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
  const platformName = process.platform === 'win32'
    ? 'cloudflared-windows-amd64.exe'
    : process.platform === 'darwin'
      ? 'cloudflared-darwin-amd64'
      : 'cloudflared-linux-amd64';
  return path.join(APP_ROOT, 'vendor', platformName);
}

function installPlugin() {
  pluginState = installStudioPlugin({
    sourcePath: resourcePath('roblox', 'ArenaStudioConnecter.server.lua'),
  });
  broadcastState();
  return pluginState;
}

function snapshot() {
  const places = bridge?.session.activeClients(65_000) ?? [];
  const tunnelState = tunnel?.snapshot() ?? { status: 'idle', url: null, message: 'Tunnel nicht gestartet.' };
  return {
    app: {
      name: 'Arena Studio Connecter',
      version: app.getVersion(),
      platform: process.platform,
      packaged: app.isPackaged,
    },
    bridge: {
      ...bridgeState,
      localUrl: bridge?.url ?? null,
      uptimeSeconds: bridge?.session.uptimeSeconds() ?? 0,
      tokenMasked: bridge?.session ? `${bridge.session.token.slice(0, 8)}••••${bridge.session.token.slice(-4)}` : null,
    },
    tunnel: tunnelState,
    plugin: {
      ...pluginState,
      connected: places.length > 0,
      connectedPlaces: places.length,
      discovery: { ...discoveryState, ...(discovery?.diagnostics?.() ?? {}) },
    },
    places,
    settings: settings?.publicState() ?? {
      hasApiKey: false,
      apiKeyMasked: null,
      encryptionAvailable: false,
      launchAtLogin: false,
    },
    now: Date.now(),
  };
}

function broadcastState() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('app:state', snapshot());
}

async function startServices() {
  installPlugin();

  const userData = app.getPath('userData');
  const config = {
    ...DEFAULTS,
    host: '127.0.0.1',
    port: 0,
    dashboard: false,
    openBrowser: false,
    logFile: path.join(app.getPath('logs'), 'bridge.log'),
    sessionFile: path.join(userData, 'runtime', 'session.json'),
  };

  try {
    bridge = new BridgeServer(config);
    const info = await bridge.start();
    bridgeState = { status: 'online', message: 'Lokale Bridge läuft.', localUrl: info.url };
  } catch (error) {
    bridgeState = { status: 'error', message: `Bridge-Start fehlgeschlagen: ${error.message}` };
    broadcastState();
    return;
  }

  discovery = new PluginDiscoveryServer({ getSession: () => bridge?.session });
  try {
    const info = await discovery.start();
    discoveryState = { status: 'online', message: `Plugin-Erkennung läuft auf Port ${info.port}.` };
  } catch (error) {
    discoveryState = { status: 'error', message: error.message };
  }

  tunnel = new CloudflareTunnel({ executable: cloudflaredPath() });
  tunnel.on('state', broadcastState);
  void tunnel.start(bridge.url);
  broadcastState();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 790,
    minWidth: 980,
    minHeight: 650,
    show: false,
    frame: false,
    backgroundColor: '#060a16',
    icon: resourcePath('desktop', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged,
    },
  });

  mainWindow.loadFile(resourcePath('desktop', 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
    broadcastState();
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url === ARENA_AGENT_URL) void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.on('closed', () => { mainWindow = null; });
}

function registerIpc() {
  ipcMain.handle('app:get-state', () => snapshot());

  ipcMain.handle('place:copy-prompt', (_event, clientId) => {
    const client = bridge?.session.activeClients(65_000).find((entry) => entry.id === clientId);
    const tunnelUrl = tunnel?.snapshot().url;
    if (!client) throw new Error('Diese Place ist nicht mehr mit Roblox Studio verbunden.');
    if (!tunnelUrl) throw new Error('Der Cloudflare-Tunnel ist noch nicht online.');
    const prompt = buildAgentPrompt({ tunnelUrl, token: bridge.session.token, client });
    clipboard.writeText(prompt);
    return { ok: true, guideUrl: buildGuideUrl(tunnelUrl, client.id), message: 'Arena-Prompt wurde kopiert.' };
  });

  ipcMain.handle('app:open-arena', async () => {
    await shell.openExternal(ARENA_AGENT_URL);
    return { ok: true };
  });

  ipcMain.handle('tunnel:retry', async () => {
    if (!bridge?.url || !tunnel) throw new Error('Die lokale Bridge läuft noch nicht.');
    await tunnel.start(bridge.url);
    broadcastState();
    return tunnel.snapshot();
  });

  ipcMain.handle('plugin:reinstall', () => installPlugin());
  ipcMain.handle('plugin:show-file', () => {
    if (pluginState.path) shell.showItemInFolder(pluginState.path);
    return { ok: Boolean(pluginState.path) };
  });

  ipcMain.handle('settings:save-api-key', (_event, key) => {
    const result = settings.saveApiKey(key);
    broadcastState();
    return result;
  });
  ipcMain.handle('settings:clear-api-key', () => {
    const result = settings.clearApiKey();
    broadcastState();
    return result;
  });
  ipcMain.handle('settings:set-launch-at-login', (_event, enabled) => {
    const value = enabled === true;
    settings.setLaunchAtLogin(value);
    if (process.platform === 'win32' && app.isPackaged) {
      app.setLoginItemSettings({ openAtLogin: value, path: process.execPath });
    }
    broadcastState();
    return settings.publicState();
  });

  ipcMain.on('window:minimize', () => mainWindow?.minimize());
  ipcMain.on('window:toggle-maximize', () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize(); else mainWindow.maximize();
  });
  ipcMain.on('window:close', () => mainWindow?.close());
}

async function cleanup() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(stateTimer);
  await tunnel?.stop().catch(() => {});
  await discovery?.stop().catch(() => {});
  await bridge?.stop().catch(() => {});
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    settings = new SettingsStore({ filePath: path.join(app.getPath('userData'), 'settings.json'), safeStorage });
    registerIpc();
    createWindow();
    stateTimer = setInterval(broadcastState, 1_000);
    stateTimer.unref?.();
    await startServices();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', (event) => {
    if (allowQuit) return;
    event.preventDefault();
    void cleanup().finally(() => {
      allowQuit = true;
      app.quit();
    });
  });
}
