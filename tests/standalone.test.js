import test from 'node:test';
import assert from 'node:assert/strict';

import { extractTarEntry, isVerifiedCloudflared } from '../standalone/cloudflaredBootstrap.js';

function tarWithFile(name, content) {
  const body = Buffer.from(content);
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
  header[156] = '0'.charCodeAt(0);
  const padding = Buffer.alloc(Math.ceil(body.length / 512) * 512 - body.length);
  return Buffer.concat([header, body, padding, Buffer.alloc(1024)]);
}

test('standalone bootstrap extracts the pinned cloudflared file from an npm tar', () => {
  const name = 'package/vendor/cloudflared-windows-amd64.exe';
  const expected = Buffer.from('MZ-test-cloudflared');
  const extracted = extractTarEntry(tarWithFile(name, expected), name);
  assert.deepEqual(extracted, expected);
});

test('standalone bootstrap rejects an unverified executable', () => {
  assert.equal(isVerifiedCloudflared(Buffer.from('MZ-not-the-pinned-binary')), false);
});
