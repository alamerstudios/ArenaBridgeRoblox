import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

export const CLOUDFLARED_VERSION = '2026.8.2';
export const CLOUDFLARED_SHA256 = 'c29eee2b121f5436a642eed69fd9767da7e7b8c510fa50aaa130337f931357b5';
export const CLOUDFLARED_SIZE = 54_893_480;

const OFFICIAL_URL = `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-windows-amd64.exe`;
const NPM_URL = 'https://registry.npmjs.org/agentroam-cloudflared-win32-x64/-/agentroam-cloudflared-win32-x64-0.2.0-preview.18.tgz';
const NPM_ENTRY = 'package/vendor/cloudflared-windows-amd64.exe';

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function isVerifiedCloudflared(bytes) {
  return bytes.length === CLOUDFLARED_SIZE
    && bytes.subarray(0, 2).toString('ascii') === 'MZ'
    && digest(bytes) === CLOUDFLARED_SHA256;
}

/** Extract one regular file from a standard npm tar archive. */
export function extractTarEntry(tar, expectedName) {
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
    const fullName = prefix ? `${prefix}/${name}` : name;
    const sizeText = header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim();
    const size = Number.parseInt(sizeText || '0', 8);
    if (!Number.isFinite(size) || size < 0) throw new Error('Das Cloudflared-Paket enthält einen ungültigen TAR-Header.');
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.length) throw new Error('Das Cloudflared-Paket ist unvollständig.');
    if (fullName === expectedName) return Buffer.from(tar.subarray(dataStart, dataEnd));
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  throw new Error(`Datei ${expectedName} fehlt im Cloudflared-Paket.`);
}

async function fetchBytes(fetchImpl, url) {
  const response = await fetchImpl(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(120_000),
    headers: { 'User-Agent': 'Arena-Studio-Connecter/2.1.0' },
  });
  if (!response.ok) throw new Error(`Download antwortete mit HTTP ${response.status}.`);
  return Buffer.from(await response.arrayBuffer());
}

let pending = null;

/**
 * Install the pinned official Windows cloudflared binary on first launch.
 * The direct GitHub asset is preferred; the SHA-verified npm mirror is the
 * fallback. No downloaded bytes are executed before the digest matches.
 */
export async function ensureCloudflared({ destination, fetchImpl = globalThis.fetch, onState = () => {} }) {
  try {
    if (fs.existsSync(destination)) {
      const current = fs.readFileSync(destination);
      if (isVerifiedCloudflared(current)) return destination;
    }
  } catch { /* replace an unreadable cache */ }

  if (pending) return pending;
  pending = (async () => {
    onState({ status: 'starting', url: null, message: 'Cloudflared wird beim ersten Start sicher geladen …' });
    let binary;
    let officialError;
    try {
      binary = await fetchBytes(fetchImpl, OFFICIAL_URL);
      if (!isVerifiedCloudflared(binary)) throw new Error('SHA-256-Prüfung des offiziellen Downloads fehlgeschlagen.');
    } catch (error) {
      officialError = error;
      onState({ status: 'starting', url: null, message: 'Verifizierter Ersatz-Download wird geladen …' });
      try {
        const packageBytes = await fetchBytes(fetchImpl, NPM_URL);
        binary = extractTarEntry(gunzipSync(packageBytes), NPM_ENTRY);
        if (!isVerifiedCloudflared(binary)) throw new Error('SHA-256-Prüfung des Ersatz-Downloads fehlgeschlagen.');
      } catch (fallbackError) {
        throw new Error(`Cloudflared konnte nicht geladen werden: ${officialError.message}; ${fallbackError.message}`);
      }
    }

    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const temporary = `${destination}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, binary);
    try {
      fs.renameSync(temporary, destination);
    } catch (error) {
      if (!['EEXIST', 'EPERM'].includes(error.code)) throw error;
      fs.rmSync(destination, { force: true });
      fs.renameSync(temporary, destination);
    }
    return destination;
  })().finally(() => { pending = null; });
  return pending;
}
