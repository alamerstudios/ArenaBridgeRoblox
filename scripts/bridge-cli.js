#!/usr/bin/env node
/**
 * NexusAI Bridge CLI — talk to a running bridge from the terminal.
 *
 * The url + token are discovered automatically from the session file written
 * by the running bridge (.runtime/session.json), or can be passed explicitly.
 * Nothing is hardcoded.
 *
 * Usage:
 *   node scripts/bridge-cli.js status
 *   node scripts/bridge-cli.js ping
 *   node scripts/bridge-cli.js actions
 *   node scripts/bridge-cli.js logs --limit 50
 *   node scripts/bridge-cli.js command run_luau '{"code":"return 1+1"}'
 *   node scripts/bridge-cli.js mcp tools/list
 *   node scripts/bridge-cli.js rotate
 *
 * Explicit connection:
 *   node scripts/bridge-cli.js status --url http://127.0.0.1:8787 --token nxs_xxx
 *   NEXUSAI_BRIDGE_URL / NEXUSAI_BRIDGE_TOKEN environment variables also work.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SESSION_FILE = path.resolve(__dirname, '..', '.runtime', 'session.json');

function parseArgs(argv) {
  const positional = [];
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) options[key] = true;
      else { options[key] = next; i += 1; }
    } else {
      positional.push(arg);
    }
  }
  return { positional, options };
}

function resolveConnection(options) {
  const url = options.url ?? process.env.NEXUSAI_BRIDGE_URL;
  const token = options.token ?? process.env.NEXUSAI_BRIDGE_TOKEN;
  if (url && token) return { url: url.replace(/\/+$/, ''), token, source: 'flags/env' };

  const sessionFile = options.session ?? DEFAULT_SESSION_FILE;
  try {
    const data = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    if (data.url && data.token) {
      return { url: String(data.url).replace(/\/+$/, ''), token: data.token, source: sessionFile };
    }
  } catch { /* fall through */ }

  throw new Error(
    'Bridge-Verbindung nicht gefunden.\n' +
    'Starte die Bridge (start-bridge.bat / npm start) oder gib --url und --token an.\n' +
    `Gesucht in: ${sessionFile}`
  );
}

async function call(conn, pathname, { method = 'GET', body } = {}) {
  const res = await fetch(`${conn.url}${pathname}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${conn.token}`,
      'X-Client-Name': 'bridge-cli',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { status: res.status, ok: res.ok, data };
}

function print(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

const HELP = `
NexusAI Bridge CLI

Befehle:
  status                        Bridge-Status abfragen
  ping                          Authentifizierter Ping
  actions                       Unterstuetzte Studio-Aktionen auflisten
  queue                         Aktuelle Warteschlange
  logs [--limit n] [--level l]  Logeintraege abrufen
  command <action> [jsonParams] Befehl an Roblox Studio senden
  mcp <method> [jsonParams]     JSON-RPC Aufruf gegen /mcp
  rotate                        Neuen Token erzeugen (alter wird ungueltig)
  health                        Oeffentlicher Health-Check (ohne Token)

Optionen:
  --url <url>       Bridge-URL (sonst aus .runtime/session.json oder ENV)
  --token <token>   Bridge-Token (sonst aus .runtime/session.json oder ENV)
  --session <file>  Alternative Session-Datei
`.trim();

async function main() {
  const { positional, options } = parseArgs(process.argv.slice(2));
  const command = positional[0];

  if (!command || command === 'help' || options.help) {
    process.stdout.write(HELP + '\n');
    return;
  }

  if (command === 'health') {
    const url = (options.url ?? process.env.NEXUSAI_BRIDGE_URL ?? '').replace(/\/+$/, '')
      || resolveConnection({ ...options, token: 'unused' }).url;
    const res = await fetch(`${url}/health`);
    print(await res.json());
    return;
  }

  const conn = resolveConnection(options);

  switch (command) {
    case 'status': {
      const { data } = await call(conn, '/status');
      print(data);
      break;
    }
    case 'ping': {
      const { data } = await call(conn, '/ping');
      print(data);
      break;
    }
    case 'actions': {
      const { data } = await call(conn, '/actions');
      print(data);
      break;
    }
    case 'queue': {
      const { data } = await call(conn, '/queue');
      print(data);
      break;
    }
    case 'logs': {
      const limit = options.limit ?? 50;
      const level = options.level ? `&level=${options.level}` : '';
      const { data } = await call(conn, `/logs?limit=${limit}${level}`);
      print(data);
      break;
    }
    case 'rotate': {
      const { data } = await call(conn, '/token/rotate', { method: 'POST' });
      print(data);
      break;
    }
    case 'command': {
      const action = positional[1];
      if (!action) throw new Error('Aktion fehlt. Beispiel: command run_luau \'{"code":"return 1+1"}\'');
      const params = positional[2] ? JSON.parse(positional[2]) : {};
      const { status, data } = await call(conn, '/command', { method: 'POST', body: { action, params } });
      print(data);
      if (status >= 400) process.exitCode = 1;
      break;
    }
    case 'mcp': {
      const method = positional[1];
      if (!method) throw new Error('Methode fehlt. Beispiel: mcp tools/list');
      const params = positional[2] ? JSON.parse(positional[2]) : undefined;
      const { data } = await call(conn, '/mcp', {
        method: 'POST',
        body: { jsonrpc: '2.0', id: Date.now(), method, ...(params ? { params } : {}) },
      });
      print(data);
      break;
    }
    default:
      process.stderr.write(`Unbekannter Befehl: ${command}\n\n${HELP}\n`);
      process.exitCode = 1;
  }
}

main().catch((err) => {
  process.stderr.write(`\n[bridge-cli] ${err.message}\n\n`);
  process.exitCode = 1;
});
