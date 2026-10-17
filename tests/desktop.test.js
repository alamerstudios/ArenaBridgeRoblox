import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildAgentPrompt, buildGuideUrl } from '../src/core/agentPrompt.js';
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
