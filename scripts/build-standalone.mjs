#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Unsupported package version "${version}".`);
const fileVersion = `${version}.0`;
const exeName = `Arena-Studio-Connecter-Portable-${version}-x64.exe`;
const release = path.join(root, 'release');
const unbranded = path.join(release, '.Arena-Studio-Connecter-unbranded.exe');
const brandedRuntime = path.join(release, '.Arena-Studio-Connecter-runtime.exe');
const output = path.join(release, exeName);
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const node = process.execPath;
let runtimeBackup = null;
let runtimePath = null;

function run(command, args) {
  console.log(`> ${path.basename(command)} ${args.join(' ')}`);
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${path.basename(command)} exited with status ${result.status ?? 'unknown'}`);
}

function bunBuild(destination, extra = []) {
  run(npx, [
    '--yes', 'bun@1.4.3', 'build', '--compile', '--target=bun-windows-x64',
    `--outfile=${destination}`, '--windows-hide-console', ...extra, 'standalone/main.js',
  ]);
}

function resourceArguments(input, destination) {
  return [
    '--yes', 'resedit-cli@3.1.1', input, destination, '--ignore-signed',
    '--icon', path.join(root, 'desktop/assets/icon.ico'),
    '--company-name', 'Arena Studio',
    '--file-description', 'Arena Agent bridge for Roblox Studio',
    '--file-version', fileVersion,
    '--internal-name', 'Arena Studio Connecter',
    '--original-filename', exeName,
    '--product-name', 'Arena Studio Connecter',
    '--product-version', fileVersion,
  ];
}

function findCrossCompileRuntime() {
  const bunHome = process.env.BUN_INSTALL || path.join(os.homedir(), '.bun');
  const candidates = [
    path.join(bunHome, 'install', 'cache', 'bun-windows-x64-v1.4.3'),
    path.join(os.homedir(), '.bun', 'install', 'cache', 'bun-windows-x64-v1.4.3'),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate));
}

try {
  fs.mkdirSync(release, { recursive: true });
  for (const target of [unbranded, brandedRuntime, output, `${output}.sha256.txt`]) fs.rmSync(target, { force: true });
  run(node, ['scripts/prepare-standalone.mjs']);

  if (process.platform === 'win32') {
    bunBuild(output, [
      `--windows-icon=${path.join(root, 'desktop/assets/icon.ico')}`,
      '--windows-title=Arena Studio Connecter',
      '--windows-publisher=Arena Studio',
      `--windows-version=${fileVersion}`,
      '--windows-description=Arena Agent bridge for Roblox Studio',
    ]);
  } else {
    // Bun currently applies icons only on a Windows build host. Seed its target
    // runtime cache, brand that PE with a platform-neutral resource editor, and
    // compile from the branded runtime. The cache is restored in all outcomes.
    bunBuild(unbranded);
    runtimePath = findCrossCompileRuntime();
    if (!runtimePath) throw new Error('Bun Windows cross-compile runtime was not found after the seed build.');
    run(npx, resourceArguments(runtimePath, brandedRuntime));
    runtimeBackup = `${runtimePath}.arena-backup-${process.pid}`;
    fs.copyFileSync(runtimePath, runtimeBackup);
    fs.copyFileSync(brandedRuntime, runtimePath);
    try {
      bunBuild(output);
    } finally {
      fs.copyFileSync(runtimeBackup, runtimePath);
      fs.rmSync(runtimeBackup, { force: true });
      runtimeBackup = null;
    }
  }

  const bytes = fs.readFileSync(output);
  const peOffset = bytes.readUInt32LE(0x3c);
  if (bytes.subarray(0, 2).toString('ascii') !== 'MZ' || bytes.subarray(peOffset, peOffset + 4).toString('hex') !== '50450000') {
    throw new Error('Build output is not a Windows PE executable.');
  }
  if (bytes.readUInt16LE(peOffset + 4) !== 0x8664) throw new Error('Build output is not Windows x64.');
  if (bytes.readUInt16LE(peOffset + 24 + 68) !== 2) throw new Error('Build output is not a windowed Windows application.');
  if (!bytes.includes(Buffer.from('Arena Studio Connecter', 'utf16le'))) throw new Error('Windows product resources were not embedded.');

  const digest = createHash('sha256').update(bytes).digest('hex');
  fs.writeFileSync(`${output}.sha256.txt`, `${digest}  ${path.basename(output)}\n`, 'utf8');
  console.log(`\nCreated ${path.relative(root, output)} (${(bytes.length / 1024 / 1024).toFixed(1)} MB)`);
  console.log(`SHA-256 ${digest}`);
} catch (error) {
  console.error(`\nStandalone build failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (runtimeBackup && runtimePath && fs.existsSync(runtimeBackup)) {
    fs.copyFileSync(runtimeBackup, runtimePath);
    fs.rmSync(runtimeBackup, { force: true });
  }
  fs.rmSync(unbranded, { force: true });
  fs.rmSync(brandedRuntime, { force: true });
}
