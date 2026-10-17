import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateToken, safeCompare, maskToken, extractToken } from '../src/core/token.js';
import { Session } from '../src/core/session.js';

test('generateToken produces a unique token on every call', () => {
  const tokens = new Set();
  for (let i = 0; i < 1000; i += 1) tokens.add(generateToken());
  assert.equal(tokens.size, 1000, 'all generated tokens must be unique');
});

test('generateToken uses the asc_ prefix and sufficient entropy', () => {
  const token = generateToken();
  assert.match(token, /^asc_[A-Za-z0-9_-]{32,}$/);
  assert.ok(token.length >= 36);
});

test('generateToken honours a custom byte length', () => {
  const short = generateToken({ bytes: 16 });
  const long = generateToken({ bytes: 48 });
  assert.ok(long.length > short.length);
});

test('safeCompare only accepts an exact match', () => {
  const token = generateToken();
  assert.equal(safeCompare(token, token), true);
  assert.equal(safeCompare(token, token + 'x'), false);
  assert.equal(safeCompare(token, token.slice(0, -1)), false);
  assert.equal(safeCompare(token, ''), false);
  assert.equal(safeCompare(token, generateToken()), false);
  assert.equal(safeCompare(token, null), false);
  assert.equal(safeCompare(token, undefined), false);
});

test('maskToken never reveals the middle of the token', () => {
  const token = generateToken();
  const masked = maskToken(token);
  assert.ok(masked.includes('...'));
  assert.ok(masked.length < token.length);
  assert.equal(masked.startsWith(token.slice(0, 8)), true);
  assert.equal(masked.includes(token.slice(10, 24)), false);
});

test('extractToken reads all supported locations', () => {
  const url = new URL('http://localhost/status');

  assert.deepEqual(
    extractToken({ headers: { authorization: 'Bearer abc123' } }, url),
    { token: 'abc123', source: 'authorization' },
  );
  assert.deepEqual(
    extractToken({ headers: { 'x-bridge-token': 'abc123' } }, url),
    { token: 'abc123', source: 'x-bridge-token' },
  );
  assert.deepEqual(
    extractToken({ headers: { 'x-api-key': 'abc123' } }, url),
    { token: 'abc123', source: 'x-api-key' },
  );
  assert.deepEqual(
    extractToken({ headers: {} }, new URL('http://localhost/status?token=abc123')),
    { token: 'abc123', source: 'query' },
  );
  assert.deepEqual(extractToken({ headers: {} }, url), { token: null, source: null });
});

test('a Session generates a fresh token per instance', () => {
  const a = new Session({ sessionFile: null });
  const b = new Session({ sessionFile: null });
  assert.notEqual(a.token, b.token);
  assert.notEqual(a.id, b.id);
});

test('Session.validate accepts only the current token', () => {
  const session = new Session({ sessionFile: null });
  const original = session.token;
  assert.equal(session.validate(original), true);
  assert.equal(session.validate('asc_wrong'), false);

  session.rotate();
  assert.equal(session.validate(original), false, 'rotated-out token must be rejected');
  assert.equal(session.validate(session.token), true);
  assert.equal(session.rotations, 1);
});

test('Session status hides the raw token by default', () => {
  const session = new Session({ sessionFile: null });
  const status = session.toStatus();
  assert.equal(status.token, undefined);
  assert.ok(status.tokenMasked.includes('...'));
  assert.equal(session.toStatus({ includeToken: true }).token, session.token);
});

test('no real token literal exists anywhere in the repository', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const candidates = ['src', 'desktop', 'public', 'scripts', 'roblox', 'tests', 'docs', 'README.md', 'start-bridge.bat'];
  const matches = [];

  const scan = (entry) => {
    const stat = fs.statSync(entry);
    if (stat.isDirectory()) {
      for (const child of fs.readdirSync(entry)) scan(path.join(entry, child));
      return;
    }
    const content = fs.readFileSync(entry, 'utf8');
    content.split(/\r?\n/).forEach((line, index) => {
      if (/asc_[A-Za-z0-9_-]{20,}/.test(line) && !/BEISPIEL|EXAMPLE|PLACEHOLDER/i.test(line)) {
        matches.push(`${path.relative(root, entry)}:${index + 1}:${line.trim()}`);
      }
    });
  };

  for (const candidate of candidates) scan(path.join(root, candidate));
  assert.deepEqual(matches, [], `hardcoded token found:\n${matches.join('\n')}`);
});
