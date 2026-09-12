/**
 * Dynamic token generation & validation.
 *
 * IMPORTANT: There is deliberately NO hardcoded/static token anywhere in this
 * project. A fresh, cryptographically random token is generated on every single
 * bridge start (and can be rotated at runtime). Tokens only ever live in memory
 * and in the gitignored runtime session file.
 */

import crypto from 'node:crypto';

const DEFAULT_BYTES = 24; // 24 bytes -> 32 base64url chars -> 192 bits of entropy

/**
 * Create a new random token.
 * Format: nxs_<base64url>  (prefix makes it greppable in logs/issues)
 *
 * @param {{ bytes?: number, prefix?: string }} [options]
 * @returns {string}
 */
export function generateToken(options = {}) {
  const bytes = Number.isInteger(options.bytes) && options.bytes >= 16 ? options.bytes : DEFAULT_BYTES;
  const prefix = options.prefix ?? 'nxs';
  const raw = crypto.randomBytes(bytes).toString('base64url');
  return `${prefix}_${raw}`;
}

/**
 * Short, human friendly id (session id, job id, request id).
 * @param {number} [bytes]
 * @returns {string}
 */
export function generateId(bytes = 8) {
  return crypto.randomBytes(bytes).toString('hex');
}

/**
 * Constant-time token comparison, safe against length-leaking and timing attacks.
 *
 * @param {string} expected
 * @param {string} provided
 * @returns {boolean}
 */
export function safeCompare(expected, provided) {
  if (typeof expected !== 'string' || typeof provided !== 'string') return false;
  if (expected.length === 0 || provided.length === 0) return false;

  // Hash both sides first so buffers always have equal length; this keeps the
  // comparison constant-time even when the lengths differ.
  const a = crypto.createHash('sha256').update(expected, 'utf8').digest();
  const b = crypto.createHash('sha256').update(provided, 'utf8').digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * Mask a token for log output: nxs_AbCd...WxYz
 * @param {string} token
 * @returns {string}
 */
export function maskToken(token) {
  if (typeof token !== 'string' || token.length < 12) return '***';
  return `${token.slice(0, 8)}...${token.slice(-4)}`;
}

/**
 * Extract a token from an incoming request.
 * Accepted (in priority order):
 *   1. Authorization: Bearer <token>
 *   2. X-Bridge-Token: <token>        (Roblox Studio HttpService friendly)
 *   3. X-Api-Key: <token>
 *   4. ?token=<token>                 (browser / dashboard friendly)
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {URL} url
 * @returns {{ token: string|null, source: string|null }}
 */
export function extractToken(req, url) {
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && auth.trim()) {
    const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (match) return { token: match[1].trim(), source: 'authorization' };
    return { token: auth.trim(), source: 'authorization' };
  }

  const bridgeHeader = req.headers['x-bridge-token'];
  if (typeof bridgeHeader === 'string' && bridgeHeader.trim()) {
    return { token: bridgeHeader.trim(), source: 'x-bridge-token' };
  }

  const apiKey = req.headers['x-api-key'];
  if (typeof apiKey === 'string' && apiKey.trim()) {
    return { token: apiKey.trim(), source: 'x-api-key' };
  }

  const queryToken = url.searchParams.get('token');
  if (queryToken && queryToken.trim()) {
    return { token: queryToken.trim(), source: 'query' };
  }

  return { token: null, source: null };
}
