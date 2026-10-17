#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cache = path.join(root, '.standalone-cache');
const temporary = path.join(cache, 'packages');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const assets = [
  {
    spec: '@nativewindow/webview-win32-x64-msvc@1.0.6',
    source: path.join('package', 'native-window.win32-x64-msvc.node'),
    destination: 'native-window.win32-x64-msvc.node',
    sha256: '18f086daf0b555c3cecdf1ebd3b3514914be66c7102d5812567eb9f04cd2c0aa',
  },
  {
    spec: 'agentroam-cloudflared-win32-x64@0.2.0-preview.18',
    source: path.join('package', 'vendor', 'cloudflared-windows-amd64.exe'),
    destination: 'cloudflared-windows-amd64.exe',
    // Matches the digest published on Cloudflare's official 2026.8.2 release.
    sha256: 'c29eee2b121f5436a642eed69fd9767da7e7b8c510fa50aaa130337f931357b5',
  },
];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed:\n${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

fs.mkdirSync(cache, { recursive: true });
fs.rmSync(temporary, { recursive: true, force: true });
fs.mkdirSync(temporary, { recursive: true });

for (const asset of assets) {
  const destination = path.join(cache, asset.destination);
  if (fs.existsSync(destination) && sha256(destination) === asset.sha256) {
    console.log(`Ready: ${asset.destination} (SHA-256 verified)`);
    continue;
  }

  const packageDir = path.join(temporary, asset.destination.replace(/[^a-z0-9.-]/gi, '_'));
  fs.mkdirSync(packageDir, { recursive: true });
  const archiveName = run(npm, ['pack', asset.spec, '--silent', '--pack-destination', packageDir]).split(/\r?\n/).pop();
  const archive = path.join(packageDir, archiveName);
  run('tar', ['-xzf', archive, '-C', packageDir]);
  const source = path.join(packageDir, asset.source);
  if (!fs.existsSync(source) || sha256(source) !== asset.sha256) {
    throw new Error(`Package ${asset.spec} did not contain the expected SHA-256 verified asset.`);
  }
  fs.copyFileSync(source, destination);
  const signature = fs.readFileSync(destination).subarray(0, 2).toString('ascii');
  if (signature !== 'MZ') throw new Error(`${asset.destination} is not a Windows PE file.`);
  console.log(`Prepared ${asset.destination} (${(fs.statSync(destination).size / 1024 / 1024).toFixed(1)} MB)`);
}

fs.rmSync(temporary, { recursive: true, force: true });
