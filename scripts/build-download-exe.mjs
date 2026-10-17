#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const name = 'Arena-Studio-Connecter-Portable-2.0.0-x64.exe';
const input = path.join(root, 'release', name);
const outputDir = path.join(root, 'downloads');
const output = path.join(outputDir, name);

if (!fs.existsSync(input)) throw new Error('Build the standalone EXE first with "npm run dist:standalone".');
const bytes = fs.readFileSync(input);
if (bytes.subarray(0, 2).toString('ascii') !== 'MZ') throw new Error('Standalone output is not a Windows executable.');
if (bytes.length >= 100_000_000) {
  throw new Error(`Direct EXE is ${bytes.length} bytes and exceeds GitHub's 100 MB repository limit.`);
}

fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(output, bytes, { mode: 0o755 });
const digest = createHash('sha256').update(bytes).digest('hex');
fs.writeFileSync(`${output}.sha256.txt`, `${digest}  ${name}\n`, 'utf8');
console.log(`Published ${path.relative(root, output)} (${(bytes.length / 1024 / 1024).toFixed(1)} MB)`);
console.log(`SHA-256 ${digest}`);
