import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { RobloxMetadataService } from '../desktop/robloxMetadata.js';
import { UpdateManager, compareVersions, updateScript } from '../desktop/updateManager.js';
import { OpenCloudAssetsClient } from '../src/services/openCloud.js';
import { BlenderService, normalizeMeshSpec } from '../src/services/blenderService.js';
import { WindowsSettingsStore } from '../standalone/windowsSettingsStore.js';

const temporaryDirectory = () => fs.mkdtempSync(path.join(os.tmpdir(), 'arena-features-'));
const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

function portableExecutable() {
  const bytes = Buffer.alloc(256);
  bytes.write('MZ', 0, 'ascii');
  bytes.writeUInt32LE(128, 0x3c);
  bytes.write('PE\0\0', 128, 'binary');
  return bytes;
}

test('Roblox metadata resolves real Place names and a CSP-safe avatar, then caches both', async () => {
  const calls = [];
  const png = Buffer.from('fake-png-for-transport-test');
  const service = new RobloxMetadataService({
    fetchImpl: async (url) => {
      const value = String(url);
      calls.push(value);
      if (value.includes('economy.roblox.com')) return jsonResponse({ Name: 'Die echte Place' });
      if (value.includes('thumbnails.roblox.com')) {
        return jsonResponse({ data: [{ targetId: 42, state: 'Completed', imageUrl: 'https://t0.rbxcdn.com/avatar.png' }] });
      }
      assert.equal(value, 'https://t0.rbxcdn.com/avatar.png');
      return new Response(png, { status: 200, headers: { 'Content-Type': 'image/png' } });
    },
  });
  const input = [{ id: 'edit', placeId: 123, placeName: 'Place', accountUserId: 42 }];
  service.decorate(input);
  for (let attempt = 0; attempt < 30 && calls.length < 3; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await new Promise((resolve) => setTimeout(resolve, 10));
  const [decorated] = service.decorate(input);
  assert.equal(decorated.placeName, 'Die echte Place');
  assert.match(decorated.accountAvatar, /^data:image\/png;base64,/);
  assert.equal(calls.length, 3);
  service.decorate(input);
  assert.equal(calls.length, 3, 'fresh cache entries must not trigger more requests');
});

test('avatar loader refuses a non-Roblox image host', async () => {
  const service = new RobloxMetadataService({
    fetchImpl: async () => jsonResponse({ data: [{ targetId: 42, state: 'Completed', imageUrl: 'https://example.com/tracker.png' }] }),
  });
  await assert.rejects(service.loadAvatar(42), /Nicht vertrauenswürdiger Avatar-Host/);
});

test('Open Cloud uploads a Model and polls the documented operations endpoint without leaking the key', async () => {
  const directory = temporaryDirectory();
  const filePath = path.join(directory, 'model.fbx');
  fs.writeFileSync(filePath, 'local-model-data');
  const calls = [];
  const client = new OpenCloudAssetsClient({
    getApiKey: () => 'local-open-cloud-secret',
    sleep: async () => {},
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      if (calls.length === 1) return jsonResponse({ path: 'operations/operation_123', done: false });
      return jsonResponse({ done: true, response: { assetId: '987654', displayName: 'Arena Mesh', moderationResult: { moderationState: 'Approved' } } });
    },
  });
  const result = await client.uploadModel({ filePath, displayName: 'Arena Mesh', creatorType: 'user', creatorId: '42' });
  assert.equal(result.assetId, '987654');
  assert.equal(calls[0].url, 'https://apis.roblox.com/assets/v1/assets');
  assert.equal(calls[1].url, 'https://apis.roblox.com/assets/v1/operations/operation_123');
  assert.equal(calls[0].options.headers['x-api-key'], 'local-open-cloud-secret');
  const request = JSON.parse(calls[0].options.body.get('request'));
  assert.equal(request.assetType, 'Model');
  assert.deepEqual(request.creationContext.creator, { userId: '42' });
  assert.equal(!JSON.stringify(request).includes('local-open-cloud-secret'), true);
});

test('declarative Blender meshes are bounded and reject invalid geometry', () => {
  const mesh = normalizeMeshSpec({ name: 'Test', objects: [{ primitive: 'cube', size: 4, material: { color: [1, 0, 0, 1] } }] });
  assert.equal(mesh.format, 'fbx');
  assert.equal(mesh.objects[0].size, 4);
  assert.throws(() => normalizeMeshSpec({ objects: [{ primitive: 'not-a-primitive' }] }), /Unbekanntes Primitive/);
  assert.throws(() => normalizeMeshSpec({ objects: [{ vertices: [[0, 0, 0]], faces: [[0, 1, 2]] }] }), /ungültigen Vertex-Index/);
  assert.throws(() => normalizeMeshSpec({ objects: [{ primitive: 'cube', size: Number.POSITIVE_INFINITY }] }), /endlich/);
});

test('Blender export and Open Cloud upload run locally through the desktop service', async () => {
  const directory = temporaryDirectory();
  const executable = path.join(directory, 'fake-blender');
  const helper = path.join(directory, 'fake-blender.cjs');
  fs.writeFileSync(helper, `
    const fs = require('node:fs');
    const job = JSON.parse(fs.readFileSync(process.env.ARENA_MESH_JOB, 'utf8'));
    fs.writeFileSync(job.output, 'exported-fbx');
    fs.writeFileSync(process.env.ARENA_MESH_JOB + '.result', JSON.stringify({ objects: job.objects.map((item) => item.name) }));
  `);
  fs.writeFileSync(executable, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "Blender 4.5 Test"; exit 0; fi\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(helper)}\n`, { mode: 0o700 });
  const settings = {
    getApiKey: () => 'never-return-this-key',
    getBlenderConfig: () => ({ blenderPath: executable, creatorType: 'user', creatorId: '42' }),
  };
  const cloudCalls = [];
  const service = new BlenderService({
    settings,
    workDirectory: path.join(directory, 'jobs'),
    fetchImpl: async (url, options) => {
      cloudCalls.push({ url: String(url), options });
      return jsonResponse({ done: true, response: { assetId: '7654321', displayName: 'Lokaler Würfel' } });
    },
  });
  const status = await service.refreshStatus();
  assert.equal(status.available, true);
  const result = await service.createMesh({ name: 'Lokaler Würfel', objects: [{ primitive: 'cube', size: 2 }] });
  assert.equal(result.uploaded, true);
  assert.equal(result.assetId, '7654321');
  assert.equal(result.objectCount, 1);
  assert.equal(fs.readFileSync(result.outputPath, 'utf8'), 'exported-fbx');
  assert.equal(cloudCalls.length, 1);
  assert.equal(!JSON.stringify(service.snapshot()).includes('never-return-this-key'), true);
});

test('portable updater supports raw-tag fallback, verifies SHA-256 and stages a PE executable', async () => {
  const directory = temporaryDirectory();
  const bytes = portableExecutable();
  const digest = createHash('sha256').update(bytes).digest('hex');
  const name = 'Arena-Studio-Connecter-Portable-2.1.0-x64.exe';
  const urls = [];
  const manager = new UpdateManager({
    currentVersion: '2.0.1',
    executablePath: path.join(directory, 'current.exe'),
    dataDirectory: path.join(directory, 'updates'),
    fetchImpl: async (url) => {
      urls.push(String(url));
      if (String(url).includes('api.github.com')) {
        return jsonResponse({ tag_name: 'v2.1.0', html_url: 'https://github.com/alamerstudios/ArenaBridgeRoblox/releases/tag/v2.1.0', assets: [] });
      }
      if (String(url).endsWith('.sha256.txt')) return new Response(`${digest}  ${name}\n`, { status: 200 });
      return new Response(bytes, { status: 200, headers: { 'Content-Length': String(bytes.length) } });
    },
  });
  const state = await manager.checkForUpdates();
  assert.equal(state.status, 'ready');
  assert.equal(state.latestVersion, '2.1.0');
  assert.deepEqual(fs.readFileSync(manager.stagedPath), bytes);
  assert.ok(urls.some((url) => url.includes('/v2.1.0/downloads/')));
  assert.equal(compareVersions('2.1.0', '2.0.1'), 1);
  assert.match(updateScript(), /previous-version|ASC_UPDATE_BACKUP/);
});

test('portable updater discards a checksum mismatch', async () => {
  const directory = temporaryDirectory();
  const manager = new UpdateManager({
    currentVersion: '2.0.1',
    executablePath: path.join(directory, 'current.exe'),
    dataDirectory: path.join(directory, 'updates'),
    fetchImpl: async (url) => {
      if (String(url).includes('api.github.com')) return jsonResponse({ tag_name: 'v2.1.0', assets: [] });
      if (String(url).endsWith('.sha256.txt')) return new Response(`${'0'.repeat(64)}  update.exe`, { status: 200 });
      return new Response(portableExecutable(), { status: 200 });
    },
  });
  await assert.rejects(manager.checkForUpdates(), /SHA-256 stimmt nicht/);
  assert.equal(manager.state.status, 'error');
  assert.equal(fs.readdirSync(path.join(directory, 'updates')).length, 0);
});

test('Windows settings writes are atomic and public settings contain no plaintext key', () => {
  const directory = temporaryDirectory();
  const filePath = path.join(directory, 'settings.json');
  const store = new WindowsSettingsStore({ filePath });
  store.setAutoUpdate(false);
  store.saveBlenderConfig({ blenderPath: 'C:\\Tools\\blender.exe', creatorType: 'group', creatorId: '123' });
  assert.equal(store.getAutoUpdate(), false);
  assert.deepEqual(store.getBlenderConfig(), { blenderPath: 'C:\\Tools\\blender.exe', creatorType: 'group', creatorId: '123' });
  assert.deepEqual(fs.readdirSync(directory), ['settings.json']);
  assert.equal(Object.hasOwn(store.publicState(), 'apiKey'), false);
  assert.throws(() => store.saveBlenderConfig({ creatorId: 'not-a-number' }), /Creator-ID/);
});
