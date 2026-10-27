import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildAgentPrompt, buildGuideUrl } from '../src/core/agentPrompt.js';
import { BridgeServer } from '../src/server.js';
import { DEFAULTS } from '../src/core/config.js';
import { PluginDiscoveryServer } from '../desktop/discoveryServer.js';
import { buildPluginModel, installStudioPlugin } from '../desktop/pluginInstaller.js';
import { SettingsStore } from '../desktop/settingsStore.js';

const client = {
  id: 'studio-client-123',
  placeName: 'Neon District',
  placeId: 123456,
  gameId: 98765,
  accountName: 'ArenaBuilder',
};

test('Arena prompt contains tunnel and token but never puts the token in a URL', () => {
  const token = 'asc_EXAMPLE_TOKEN_NOT_REAL_123456789';
  const tunnelUrl = 'https://bright-place.trycloudflare.com/';
  const prompt = buildAgentPrompt({ tunnelUrl, token, client });

  assert.match(prompt, /Cloudflare-Tunnel: https:\/\/bright-place\.trycloudflare\.com/);
  assert.ok(prompt.includes(`Bridge-Token: ${token}`));
  assert.ok(prompt.includes(`"targetClientId": "${client.id}"`));
  assert.ok(prompt.includes('/agent/guide?clientId=studio-client-123'));
  assert.equal(prompt.includes(`?token=${token}`), false);
  assert.equal(buildGuideUrl(tunnelUrl, client.id).includes(token), false);
});

test('plugin model safely embeds the Luau source', () => {
  const model = buildPluginModel('print("hello")\n-- ]]> marker');
  assert.match(model, /<Item class="Script"/);
  assert.match(model, /Arena Studio Connecter/);
  assert.ok(model.includes('print("hello")'));
  assert.equal((model.match(/<\?xml/g) ?? []).length, 1);
});

test('plugin installer creates an rbxmx and only removes known legacy files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-plugin-'));
  const sourcePath = path.join(root, 'plugin.lua');
  const pluginsDirectory = path.join(root, 'Plugins');
  fs.writeFileSync(sourcePath, 'print("arena")');
  fs.mkdirSync(pluginsDirectory);
  fs.writeFileSync(path.join(pluginsDirectory, 'NexusAIPlugin.server.lua'), 'old');
  fs.writeFileSync(path.join(pluginsDirectory, 'MyOtherPlugin.rbxmx'), 'keep');

  const first = installStudioPlugin({ sourcePath, pluginsDirectory });
  const second = installStudioPlugin({ sourcePath, pluginsDirectory });
  assert.equal(first.installed, true);
  assert.equal(first.updated, true);
  assert.equal(second.updated, false);
  assert.equal(fs.existsSync(first.path), true);
  assert.equal(fs.existsSync(path.join(pluginsDirectory, 'NexusAIPlugin.server.lua')), false);
  assert.equal(fs.readFileSync(path.join(pluginsDirectory, 'MyOtherPlugin.rbxmx'), 'utf8'), 'keep');
  fs.rmSync(root, { recursive: true, force: true });
});

test('plugin installer accepts embedded Luau for the single-file Windows build', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-embedded-plugin-'));
  const result = installStudioPlugin({
    source: 'print("embedded arena plugin")',
    pluginsDirectory: root,
  });
  assert.equal(result.installed, true);
  assert.match(fs.readFileSync(result.path, 'utf8'), /embedded arena plugin/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('loopback discovery gives the plugin the current in-memory session', async () => {
  const session = {
    id: 'session-1',
    url: 'http://127.0.0.1:45678',
    token: 'asc_EXAMPLE_DISCOVERY_TOKEN_12345',
    tokenIssuedAt: new Date('2026-01-01T00:00:00Z'),
  };
  const discovery = new PluginDiscoveryServer({ port: 0, getSession: () => session });
  const info = await discovery.start();
  try {
    const response = await fetch(`${info.url}/v1/session`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.url, session.url);
    assert.equal(body.token, session.token);
    assert.equal(body.service, 'arena-studio-connecter');
  } finally {
    await discovery.stop();
  }
});

test('Studio plugin never touches the protected HTTP setting and reconnects resiliently', () => {
  // Regression test for "no Places load in the EXE": the per-Place HTTP
  // setting has LocalUserSecurity, so a plugin may neither read nor write it.
  // Version 2.0.0 gated every request behind exactly that access, which meant
  // the plugin never contacted the app at all on a fresh Place.
  const lua = fs.readFileSync(new URL('../roblox/ArenaStudioConnecter.server.lua', import.meta.url), 'utf8');
  assert.equal(lua.includes('HttpEnabled'), false, 'plugin must not access the LocalUserSecurity HTTP setting');
  assert.equal(lua.includes('ensureHttpEnabled'), false);
  assert.ok(lua.includes('HttpService:RequestAsync'), 'plugin must request the local app directly');
  assert.ok(lua.includes('pcall(runConnectedSession)'), 'a single failed cycle must not kill the connection loop');
  assert.ok(lua.includes('ensureConnectionLoop'), 'the retry button must be able to restart the loop');

  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(lua.includes(`local PLUGIN_VERSION = "${pkg.version}"`), 'plugin version must match the app version');
});

test('playtest control uses the server plugin instance without injecting a Script', () => {
  const lua = fs.readFileSync(new URL('../roblox/ArenaStudioConnecter.server.lua', import.meta.url), 'utf8');
  assert.ok(lua.includes('if RunService:IsServer() then'));
  assert.ok(lua.includes('StudioTestService:EndTest("Arena AI Stop")'));
  assert.ok(lua.includes('plugin:GetSetting("arenaPlaytestEditClientId")'));
  assert.ok(lua.includes('debug.traceback'), 'action failures must retain the Luau traceback');
  assert.ok(lua.includes('pluginVersion = PLUGIN_VERSION'));
  assert.equal(lua.includes('ServerScriptService'), false, 'no temporary server Script may be injected');
  assert.equal(lua.includes('ChangeHistoryService'), false, 'playtest control must not mutate the edit DataModel');
});

test('generated plugin model embeds the shipped Luau source byte for byte', () => {
  const lua = fs.readFileSync(new URL('../roblox/ArenaStudioConnecter.server.lua', import.meta.url), 'utf8');
  const model = buildPluginModel(lua);
  const chunks = [...model.matchAll(/<!\[CDATA\[([\s\S]*?)\]\]>/g)].map((match) => match[1]);
  assert.equal(chunks.join(''), lua);
});

test('discovery reports plugin contact for the desktop diagnosis', async () => {
  const session = {
    id: 'session-diagnostics',
    url: 'http://127.0.0.1:45679',
    token: 'asc_EXAMPLE_DIAGNOSTICS_TOKEN_12345',
    tokenIssuedAt: new Date('2026-01-01T00:00:00Z'),
  };
  const discovery = new PluginDiscoveryServer({ port: 0, getSession: () => session });
  const info = await discovery.start();
  try {
    assert.equal(discovery.diagnostics().lastServedAt, null);
    const response = await fetch(`${info.url}/v1/session`);
    assert.equal(response.status, 200);
    await response.json();
    const diagnostics = discovery.diagnostics();
    assert.equal(diagnostics.listening, true);
    assert.equal(diagnostics.requests, 1);
    assert.equal(diagnostics.sessionsServed, 1);
    assert.equal(typeof diagnostics.lastServedAt, 'number');
    assert.equal(diagnostics.lastOutcome, 'served');
    assert.equal(JSON.stringify(diagnostics).includes(session.token), false, 'diagnostics must never contain the token');
  } finally {
    await discovery.stop();
  }
});

test('full EXE chain: discovery session turns a Studio handshake into a listed Place', async () => {
  // Mirrors the service wiring of the standalone/Electron hosts exactly, with
  // a free discovery port instead of the fixed one.
  const bridge = new BridgeServer({
    ...DEFAULTS,
    host: '127.0.0.1',
    port: 0,
    dashboard: false,
    openBrowser: false,
    logLevel: 'silent',
    logFile: null,
    sessionFile: null,
  });
  await bridge.start();
  const discovery = new PluginDiscoveryServer({ getSession: () => bridge.session, port: 0 });
  const discoveryInfo = await discovery.start();
  try {
    const discovered = await (await fetch(`${discoveryInfo.url}/v1/session`, {
      headers: { Accept: 'application/json' },
    })).json();
    assert.equal(discovered.ok, true);
    assert.equal(discovered.url, bridge.url);

    const clientId = 'exe-chain-studio';
    const handshake = await fetch(`${discovered.url}/studio/handshake`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${discovered.token}`,
        'X-Client-Id': clientId,
        'X-Client-Name': 'Roblox Studio',
      },
      body: JSON.stringify({
        clientId,
        name: 'Roblox Studio',
        version: '2.0.1',
        place: '4242',
        placeId: 4242,
        placeName: 'EXE Chain Place',
        gameId: 777,
        placeVersion: 3,
        accountUserId: 42,
        accountName: 'Tester',
        isEdit: true,
        isRunning: false,
      }),
    });
    assert.equal(handshake.status, 200);
    await handshake.json();

    const places = bridge.session.activeClients(65_000);
    assert.equal(places.length, 1);
    assert.equal(places[0].id, clientId);
    assert.equal(places[0].placeName, 'EXE Chain Place');
    assert.equal(places[0].placeId, 4242);
  } finally {
    await discovery.stop();
    await bridge.stop();
  }
});

test('settings store encrypts the Open Cloud key and never writes plaintext', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-settings-'));
  const filePath = path.join(root, 'settings.json');
  const fakeSafeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`encrypted:${value}`, 'utf8'),
    decryptString: (value) => value.toString('utf8').replace(/^encrypted:/, ''),
  };
  const store = new SettingsStore({ filePath, safeStorage: fakeSafeStorage });
  const secret = 'rblx-EXAMPLE-OPEN-CLOUD-KEY';
  store.saveApiKey(secret);
  assert.equal(store.getApiKey(), secret);
  assert.equal(fs.readFileSync(filePath, 'utf8').includes(secret), false);
  assert.equal(store.publicState().hasApiKey, true);
  assert.equal(store.publicState().apiKeyMasked.includes('EXAMPLE'), false);
  store.clearApiKey();
  assert.equal(store.getApiKey(), null);
  fs.rmSync(root, { recursive: true, force: true });
});
