#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const release = path.join(root, 'release');
if (!fs.existsSync(release)) throw new Error('release/ wurde noch nicht erzeugt.');
const executables = fs.readdirSync(release).filter((name) => name.toLowerCase().endsWith('.exe'));
if (!executables.length) throw new Error('Keine Windows-EXE in release/ gefunden.');
for (const name of executables) {
  const bytes = fs.readFileSync(path.join(release, name));
  const digest = createHash('sha256').update(bytes).digest('hex');
  fs.writeFileSync(path.join(release, `${name}.sha256.txt`), `${digest}  ${name}\n`);
  console.log(`${name}: ${digest}`);
}
