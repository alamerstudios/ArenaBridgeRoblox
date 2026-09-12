/**
 * Small HTTP helpers: JSON responses, body parsing, CORS, rate limiting.
 */

export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Bridge-Token, X-Api-Key, X-Client-Id, X-Client-Name',
  'Access-Control-Max-Age': '600',
};

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {any} payload
 * @param {object} [extraHeaders]
 */
export function sendJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...CORS_HEADERS,
    ...extraHeaders,
  });
  res.end(body);
}

export function sendText(res, status, text, contentType = 'text/plain; charset=utf-8') {
  const body = typeof text === 'string' ? text : String(text);
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...CORS_HEADERS,
  });
  res.end(body);
}

export function sendError(res, status, code, message, details) {
  sendJson(res, status, {
    ok: false,
    error: { code, message, ...(details ? { details } : {}) },
    timestamp: new Date().toISOString(),
  });
}

/**
 * Read and JSON-parse a request body.
 * @param {import('node:http').IncomingMessage} req
 * @param {number} maxBytes
 * @returns {Promise<{ ok: true, data: any } | { ok: false, error: string }>}
 */
export function readJsonBody(req, maxBytes = 2 * 1024 * 1024) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let settled = false;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        finish({ ok: false, error: `body exceeds ${maxBytes} bytes` });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return finish({ ok: true, data: {} });
      try {
        finish({ ok: true, data: JSON.parse(raw) });
      } catch (err) {
        finish({ ok: false, error: `invalid JSON body: ${err.message}` });
      }
    });

    req.on('error', (err) => finish({ ok: false, error: err.message }));
  });
}

/** Simple fixed-window rate limiter keyed by remote address. */
export class RateLimiter {
  constructor({ windowMs = 60_000, max = 600 } = {}) {
    this.windowMs = windowMs;
    this.max = max;
    /** @type {Map<string, {count:number, reset:number}>} */
    this.buckets = new Map();
  }

  check(key) {
    const now = Date.now();
    let bucket = this.buckets.get(key);
    if (!bucket || bucket.reset <= now) {
      bucket = { count: 0, reset: now + this.windowMs };
      this.buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (this.buckets.size > 1000) {
      for (const [k, b] of this.buckets) if (b.reset <= now) this.buckets.delete(k);
    }
    return {
      allowed: bucket.count <= this.max,
      remaining: Math.max(0, this.max - bucket.count),
      retryAfterSeconds: Math.ceil((bucket.reset - now) / 1000),
    };
  }
}

export function clientIp(req) {
  return req.socket?.remoteAddress ?? 'unknown';
}
