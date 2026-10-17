#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const input = path.join(root, 'release', 'Arena-Studio-Connecter-Portable-2.0.0-x64.exe');
const outputDir = path.join(root, 'downloads');
const output = path.join(outputDir, 'Arena-Studio-Connecter-Portable-2.0.0-x64.exe');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-download-'));
const payload = path.join(temporary, 'payload');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

function run(command, args, options = {}) {
  console.log(`> ${path.basename(command)} ${args.join(' ')}`);
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', ...options });
  if (result.status !== 0) throw new Error(`${path.basename(command)} exited with status ${result.status ?? 'unknown'}`);
}

function pack(spec, destination) {
  fs.mkdirSync(destination, { recursive: true });
  const result = spawnSync(npm, ['pack', spec, '--silent', '--pack-destination', destination], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  if (result.status !== 0) throw new Error(`Could not download ${spec}.`);
  const archive = path.join(destination, result.stdout.trim().split(/\r?\n/).pop());
  run('tar', ['-xzf', archive, '-C', destination]);
  return path.join(destination, 'package');
}

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function append(destinationFd, source) {
  const sourceFd = fs.openSync(source, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let count;
    while ((count = fs.readSync(sourceFd, buffer, 0, buffer.length, null)) > 0) {
      fs.writeSync(destinationFd, buffer, 0, count);
    }
  } finally {
    fs.closeSync(sourceFd);
  }
}

try {
  if (!fs.existsSync(input)) throw new Error('Build the standalone EXE first with "npm run dist:standalone".');
  fs.mkdirSync(payload, { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });

  const sevenZipPackage = pack('7zip-bin-full@26.4.1', path.join(temporary, 'sevenzip'));
  const sfxPackage = pack('maker-7z-sfx@1.0.3', path.join(temporary, 'sfx'));
  const hostArch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const sevenZip = process.platform === 'win32'
    ? path.join(sevenZipPackage, 'win', 'x64', '7z.exe')
    : process.platform === 'darwin'
      ? path.join(sevenZipPackage, 'mac', hostArch, '7zz')
      : path.join(sevenZipPackage, 'linux', hostArch, '7zz');

  const innerName = 'Arena Studio Connecter.exe';
  fs.copyFileSync(input, path.join(payload, innerName));
  fs.copyFileSync(
    path.join(sfxPackage, '7zsd_extra_162_3888', 'License.txt'),
    path.join(payload, '7-Zip-SFX-LICENSE.txt'),
  );
  fs.writeFileSync(
    path.join(payload, 'SHA256.txt'),
    `${sha256(input)}  ${innerName}\r\n`,
    'utf8',
  );

  const archive = path.join(temporary, 'payload.7z');
  run(sevenZip, [
    'a', archive, '*', '-t7z', '-mx=9', '-m0=LZMA2', '-md=128m', '-ms=on', '-mmt=on',
  ], { cwd: payload });

  const rawSfx = path.join(sfxPackage, '7zsd_extra_162_3888', '7zsd_All_x64.sfx');
  const brandedSfx = path.join(temporary, 'ArenaStudioConnecter.sfx');
  run(npx, [
    '--yes', 'resedit-cli@3.1.1', rawSfx, brandedSfx, '--ignore-signed',
    '--icon', path.join(root, 'desktop', 'assets', 'icon.ico'),
    '--company-name', 'Arena Studio',
    '--file-description', 'Portable Arena Agent bridge for Roblox Studio',
    '--file-version', '2.0.0.0',
    '--internal-name', 'Arena Studio Connecter',
    '--original-filename', path.basename(output),
    '--product-name', 'Arena Studio Connecter',
    '--product-version', '2.0.0.0',
  ]);

  const config = path.join(temporary, 'config.txt');
  fs.writeFileSync(config, [
    ';!@Install@!UTF-8!',
    'Title="Arena Studio Connecter"',
    'GUIMode="1"',
    'GUIFlags="8+32+2048"',
    'ExtractTitle="Arena Studio Connecter wird gestartet ..."',
    'ExtractDialogText="Die portable App wird vorbereitet."',
    'SetEnvironment="ASC_LAUNCHER_PATH=%%S"',
    `RunProgram="${innerName}"`,
    ';!@InstallEnd@!',
    '',
  ].join('\r\n'), 'utf8');

  const fd = fs.openSync(output, 'w');
  try {
    append(fd, brandedSfx);
    append(fd, config);
    append(fd, archive);
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(output, 0o755);

  const bytes = fs.readFileSync(output);
  if (bytes.subarray(0, 2).toString('ascii') !== 'MZ') throw new Error('Download wrapper is not a Windows executable.');
  if (bytes.length >= 100 * 1024 * 1024) throw new Error('Download wrapper exceeds GitHub’s 100 MiB file limit.');
  const digest = createHash('sha256').update(bytes).digest('hex');
  fs.writeFileSync(`${output}.sha256.txt`, `${digest}  ${path.basename(output)}\n`, 'utf8');
  console.log(`\nCreated ${path.relative(root, output)} (${(bytes.length / 1024 / 1024).toFixed(1)} MB)`);
  console.log(`SHA-256 ${digest}`);
} catch (error) {
  console.error(`\nDownload build failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
