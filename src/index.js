#!/usr/bin/env node
/**
 * NexusAI Bridge — entry point.
 *
 * Generates a fresh token on every start, boots the HTTP server and prints the
 * machine-readable ---BRIDGE--- block consumed by the .bat/.ps1 launchers.
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig, HELP_TEXT } from './core/config.js';
import { BridgeServer } from './server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function readVersion() {
  try {
    return JSON.parse(readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8')).version;
  } catch {
    return '0.0.0';
  }
}

function openBrowser(url) {
  const platform = process.platform;
  const cmd = platform === 'win32' ? 'cmd' : platform === 'darwin' ? 'open' : 'xdg-open';
  const args = platform === 'win32' ? ['/c', 'start', '""', url] : [url];
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
  } catch { /* ignore */ }
}

async function main() {
  const { config, flags } = loadConfig(process.argv.slice(2), process.env);

  if (flags.help) {
    process.stdout.write(HELP_TEXT + '\n');
    return;
  }
  if (flags.version) {
    process.stdout.write(`nexusai-bridge ${readVersion()}\n`);
    return;
  }
  if (flags.printConfig) {
    process.stdout.write(JSON.stringify(config, null, 2) + '\n');
    return;
  }

  const bridge = new BridgeServer(config);

  let info;
  try {
    info = await bridge.start();
  } catch (err) {
    process.stderr.write(`\n[NexusAI Bridge] Start fehlgeschlagen: ${err.message}\n\n`);
    process.exitCode = 1;
    return;
  }

  if (config.openBrowser && config.dashboard) {
    openBrowser(`${info.url}/dashboard?token=${encodeURIComponent(info.token)}`);
  }

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    bridge.logger.info(`received ${signal}`);
    await bridge.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => { void shutdown('SIGINT'); });
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('uncaughtException', (err) => {
    bridge.logger.error(`uncaught exception: ${err.stack ?? err.message}`);
  });
  process.on('unhandledRejection', (reason) => {
    bridge.logger.error(`unhandled rejection: ${reason instanceof Error ? reason.stack : String(reason)}`);
  });
}

main();
