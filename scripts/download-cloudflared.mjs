#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';

const VERSION = process.env.CLOUDFLARED_VERSION || '2026.10.1';
const target = path.resolve('vendor', 'cloudflared-windows-amd64.exe');
const url = `https://github.com/cloudflare/cloudflared/releases/download/${VERSION}/cloudflared-windows-amd64.exe`;

function download(source, destination, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 8) return reject(new Error('Too many redirects while downloading cloudflared.'));
    const request = https.get(source, { headers: { 'User-Agent': 'Arena-Studio-Connecter-Build' } }, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
        response.resume();
        return resolve(download(new URL(response.headers.location, source), destination, redirects + 1));
      }
      if (response.statusCode !== 200) {
        response.resume();
        return reject(new Error(`cloudflared download returned HTTP ${response.statusCode}`));
      }
      const stream = fs.createWriteStream(destination);
      response.pipe(stream);
      stream.on('finish', () => stream.close(resolve));
      stream.on('error', reject);
    });
    request.on('error', reject);
  });
}

async function main() {
  if (fs.existsSync(target) && fs.statSync(target).size > 40_000_000) {
    console.log(`cloudflared ${VERSION} already available: ${target}`);
    return;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.download`;
  fs.rmSync(temporary, { force: true });
  console.log(`Downloading cloudflared ${VERSION} for Windows x64 ...`);
  try {
    await download(url, temporary);
    const descriptor = fs.openSync(temporary, 'r');
    const signature = Buffer.alloc(2);
    fs.readSync(descriptor, signature, 0, 2, 0);
    fs.closeSync(descriptor);
    const size = fs.statSync(temporary).size;
    if (signature.toString('ascii') !== 'MZ' || size < 40_000_000) throw new Error('Downloaded file is not a valid cloudflared Windows executable.');
    fs.renameSync(temporary, target);
    console.log(`Saved ${(size / 1024 / 1024).toFixed(1)} MB to ${target}`);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
