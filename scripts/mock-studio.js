#!/usr/bin/env node
/**
 * Mock Roblox Studio client.
 *
 * Simulates the Studio plugin (handshake + long-poll + result) so the bridge,
 * the dashboard and the MCP endpoint can be exercised without Roblox running.
 *
 * Usage:
 *   node scripts/mock-studio.js                       # auto-discovers the session
 *   node scripts/mock-studio.js --url ... --token ...
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_FILE = path.resolve(__dirname, '..', '.runtime', 'session.json');

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) options[argv[i].slice(2)] = argv[i + 1];
  }
  return options;
}

function resolveConnection(options) {
  const url = options.url ?? process.env.NEXUSAI_BRIDGE_URL;
  const token = options.token ?? process.env.NEXUSAI_BRIDGE_TOKEN;
  if (url && token) return { url: url.replace(/\/+$/, ''), token };
  const data = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
  return { url: String(data.url).replace(/\/+$/, ''), token: data.token };
}

const CLIENT_ID = `mock-studio-${Math.random().toString(36).slice(2, 8)}`;

/** Fake implementations of the Studio-side actions. */
const handlers = {
  ping: () => ({ pong: true, studio: 'mock', version: '1.0.0' }),
  get_place_info: () => ({ placeId: 0, gameId: 0, name: 'MockPlace', workspaceChildren: 3, isEdit: true }),
  run_luau: (p) => ({ returned: null, output: [`[mock] would execute ${String(p.code).length} chars of Luau`], durationMs: 1 }),
  list_instances: (p) => ({
    name: 'Workspace', className: 'Workspace', path: p.path ?? 'game.Workspace', childCount: 2,
    children: [
      { name: 'Baseplate', className: 'Part', path: 'game.Workspace.Baseplate', childCount: 0 },
      { name: 'Camera', className: 'Camera', path: 'game.Workspace.Camera', childCount: 0 },
    ],
  }),
  get_instance: (p) => ({ path: p.path, className: 'Part', properties: { Name: 'Baseplate', Anchored: true }, childCount: 0 }),
  create_instance: (p) => ({ created: true, path: `${p.parent}.${p.properties?.Name ?? p.className}`, className: p.className }),
  set_property: (p) => ({ updated: true, path: p.path, property: p.property }),
  delete_instance: (p) => ({ deleted: true, path: p.path }),
  get_script_source: (p) => ({ path: p.path, className: 'Script', source: 'print("mock source")' }),
  set_script_source: (p) => ({ updated: true, path: p.path, length: String(p.source ?? '').length }),
  get_selection: () => ({ count: 0, selection: [] }),
  set_selection: (p) => ({ selected: (p.paths ?? []).length, missing: [] }),
  get_output: () => ({ count: 1, entries: [{ level: 'info', message: '[mock] output line', at: Math.floor(Date.now() / 1000) }] }),
};

async function main() {
  const conn = resolveConnection(parseArgs(process.argv.slice(2)));
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${conn.token}`,
    'X-Client-Id': CLIENT_ID,
    'X-Client-Name': 'Mock Studio',
  };

  const handshake = await fetch(`${conn.url}/studio/handshake`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ clientId: CLIENT_ID, name: 'Mock Studio', version: '1.0.0', place: 'mock' }),
  });
  if (!handshake.ok) {
    throw new Error(`Handshake fehlgeschlagen: HTTP ${handshake.status} ${await handshake.text()}`);
  }
  console.log(`[mock-studio] verbunden mit ${conn.url} als ${CLIENT_ID}`);
  console.log('[mock-studio] warte auf Befehle... (Strg+C zum Beenden)');

  let running = true;
  process.on('SIGINT', () => { running = false; process.exit(0); });

  while (running) {
    try {
      const poll = await fetch(`${conn.url}/studio/poll`, { headers });
      if (!poll.ok) {
        console.error(`[mock-studio] poll HTTP ${poll.status}`);
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      const { command } = await poll.json();
      if (!command) continue;

      console.log(`[mock-studio] Befehl: ${command.action} (${command.id})`);
      const handler = handlers[command.action];
      const payload = handler
        ? { id: command.id, ok: true, result: handler(command.params ?? {}) }
        : { id: command.id, ok: false, error: `Mock kennt die Aktion "${command.action}" nicht` };

      await fetch(`${conn.url}/studio/result`, { method: 'POST', headers, body: JSON.stringify(payload) });
    } catch (err) {
      console.error(`[mock-studio] Fehler: ${err.message}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

main().catch((err) => {
  console.error(`\n[mock-studio] ${err.message}\n`);
  process.exitCode = 1;
});
