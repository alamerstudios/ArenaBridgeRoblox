/**
 * NexusAI Bridge HTTP server: routing, auth middleware and lifecycle.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Logger } from './core/logger.js';
import { Session } from './core/session.js';
import { CommandQueue } from './core/commandQueue.js';
import { extractToken, maskToken } from './core/token.js';
import { sendJson, sendError, sendText, RateLimiter, clientIp, CORS_HEADERS } from './core/http.js';
import { renderBanner, renderHints } from './core/banner.js';
import { createApiRoutes, ENDPOINTS } from './routes/api.js';
import { createStudioRoutes } from './routes/studio.js';
import { createMcpRoutes } from './routes/mcp.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/** Routes reachable without a token. */
const PUBLIC_ROUTES = new Set(['/health', '/', '/dashboard', '/favicon.ico']);

export class BridgeServer {
  /** @param {object} config */
  constructor(config) {
    this.config = config;

    this.logger = new Logger({
      level: config.logLevel,
      file: config.logFile,
      json: config.jsonLogs,
    });

    this.session = new Session({
      tokenBytes: config.tokenBytes,
      sessionFile: config.sessionFile,
    });
    this.logger.addSecret(this.session.token);

    this.queue = new CommandQueue({
      timeoutMs: config.commandTimeoutMs,
      logger: this.logger,
    });

    this.rateLimiter = new RateLimiter({
      windowMs: config.rateLimitWindowMs,
      max: config.rateLimitMax,
    });

    /** @type {Map<string, number>} consecutive auth failures per ip */
    this.authFailures = new Map();

    const ctx = { session: this.session, queue: this.queue, logger: this.logger, config };
    this.api = createApiRoutes(ctx);
    this.studio = createStudioRoutes(ctx);
    this.mcp = createMcpRoutes(ctx);

    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        this.logger.error(`unhandled request error: ${err.stack ?? err.message}`);
        if (!res.headersSent) sendError(res, 500, 'INTERNAL_ERROR', 'Internal bridge error.');
      });
    });
    this.server.keepAliveTimeout = 65_000;
    this.server.headersTimeout = 70_000;
  }

  // ---------------------------------------------------------------- routing

  async handle(req, res) {
    const started = Date.now();
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    const method = (req.method ?? 'GET').toUpperCase();

    this.session.stats.requests += 1;

    if (method === 'OPTIONS') {
      res.writeHead(204, CORS_HEADERS);
      return res.end();
    }

    const ip = clientIp(req);
    const limit = this.rateLimiter.check(ip);
    if (!limit.allowed) {
      this.logger.warn('rate limit exceeded', { ip, pathname });
      return sendError(res, 429, 'RATE_LIMITED', 'Too many requests.', { retryAfterSeconds: limit.retryAfterSeconds });
    }

    // -------- public routes (no token) ------------------------------------
    if (pathname === '/health') {
      return sendJson(res, 200, {
        ok: true,
        service: 'nexusai-bridge',
        status: 'running',
        sessionId: this.session.id,
        uptimeSeconds: this.session.uptimeSeconds(),
        authRequired: true,
        timestamp: new Date().toISOString(),
      });
    }

    if (method === 'GET' && (pathname === '/' || pathname === '/dashboard')) {
      if (!this.config.dashboard) return sendError(res, 404, 'DASHBOARD_DISABLED', 'Dashboard is disabled (--no-dashboard).');
      return this.serveStatic(res, 'index.html');
    }

    if (method === 'GET' && (pathname.startsWith('/assets/') || pathname === '/favicon.ico')) {
      return this.serveStatic(res, pathname.replace(/^\//, ''));
    }

    // -------- authentication ----------------------------------------------
    if (!PUBLIC_ROUTES.has(pathname)) {
      const auth = this.authenticate(req, url, ip, pathname);
      if (!auth.ok) {
        return sendError(res, auth.status, auth.code, auth.message, auth.details);
      }
    }

    // -------- authenticated routes ----------------------------------------
    const route = `${method} ${pathname}`;
    const commandMatch = /^\/command\/([A-Za-z0-9_-]+)$/.exec(pathname);

    let handled = true;
    switch (true) {
      case route === 'GET /status': await this.api.status(req, res); break;
      case route === 'GET /ping': await this.api.ping(req, res); break;
      case route === 'GET /actions': await this.api.actions(req, res); break;
      case route === 'POST /command': await this.api.command(req, res); break;
      case route === 'GET /queue': await this.api.queueState(req, res); break;
      case route === 'GET /logs': await this.api.logs(req, res, {}, url); break;
      case route === 'POST /token/rotate': await this.api.rotateToken(req, res); break;

      case route === 'POST /mcp': await this.mcp.rpc(req, res); break;
      case route === 'GET /mcp': await this.mcp.describe(req, res); break;

      case route === 'POST /studio/handshake': await this.studio.handshake(req, res); break;
      case route === 'GET /studio/poll': await this.studio.poll(req, res); break;
      case route === 'POST /studio/result': await this.studio.result(req, res); break;
      case route === 'POST /studio/log': await this.studio.log(req, res); break;

      case method === 'GET' && commandMatch !== null:
        await this.api.commandById(req, res, { id: commandMatch[1] });
        break;

      default:
        handled = false;
        sendError(res, 404, 'NOT_FOUND', `No route for ${route}.`, { endpoints: ENDPOINTS });
    }

    const level = pathname === '/studio/poll' ? 'debug' : 'debug';
    this.logger[level](`${method} ${pathname} -> ${res.statusCode}`, {
      ms: Date.now() - started,
      ip,
      ...(handled ? {} : { unmatched: true }),
    });
  }

  // ------------------------------------------------------------------ auth

  /**
   * Validate the dynamic session token on an incoming request.
   */
  authenticate(req, url, ip, pathname) {
    const { token, source } = extractToken(req, url);

    if (!token) {
      this.session.stats.authFailed += 1;
      this.logger.warn('request without token rejected', { ip, pathname });
      return {
        ok: false,
        status: 401,
        code: 'TOKEN_MISSING',
        message: 'Missing bridge token. Send it as "Authorization: Bearer <token>", header "X-Bridge-Token", or "?token=".',
        details: { hint: 'The token is printed in the ---BRIDGE--- block when the bridge starts and changes on every start.' },
      };
    }

    if (!this.session.validate(token)) {
      this.session.stats.authFailed += 1;
      const failures = (this.authFailures.get(ip) ?? 0) + 1;
      this.authFailures.set(ip, failures);
      this.logger.warn('invalid token rejected', { ip, pathname, source, presented: maskToken(token), failures });

      if (failures >= this.config.authFailBanThreshold) {
        return {
          ok: false,
          status: 429,
          code: 'TOO_MANY_AUTH_FAILURES',
          message: 'Too many invalid tokens from this client. Restart the bridge to get a fresh token.',
        };
      }

      return {
        ok: false,
        status: 403,
        code: 'TOKEN_INVALID',
        message: 'Invalid bridge token. Tokens are regenerated on every bridge start.',
        details: { hint: 'Copy the current token from the ---BRIDGE--- block or from the session file.' },
      };
    }

    this.authFailures.delete(ip);
    this.session.stats.authOk += 1;

    const clientId = req.headers['x-client-id'];
    if (clientId) {
      this.session.touchClient(String(clientId), {
        name: req.headers['x-client-name'] ? String(req.headers['x-client-name']) : undefined,
      });
    }

    return { ok: true };
  }

  // ---------------------------------------------------------------- static

  serveStatic(res, relativePath) {
    const safe = path.normalize(relativePath).replace(/^(\.\.(\/|\\|$))+/, '');
    const file = path.join(PUBLIC_DIR, safe);
    if (!file.startsWith(PUBLIC_DIR)) return sendError(res, 403, 'FORBIDDEN', 'Path traversal blocked.');

    fs.readFile(file, (err, data) => {
      if (err) return sendError(res, 404, 'NOT_FOUND', `Static file not found: ${safe}`);
      const type = STATIC_TYPES[path.extname(file)] ?? 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': data.length, 'Cache-Control': 'no-store' });
      res.end(data);
    });
  }

  // ------------------------------------------------------------- lifecycle

  /** @returns {Promise<{url: string, token: string, port: number}>} */
  start() {
    return new Promise((resolve, reject) => {
      const onError = (err) => {
        if (err.code === 'EADDRINUSE') {
          reject(new Error(`Port ${this.config.port} is already in use. Start with --port 0 to pick a free port automatically.`));
        } else {
          reject(err);
        }
      };
      this.server.once('error', onError);

      this.server.listen(this.config.port, this.config.host, () => {
        this.server.removeListener('error', onError);
        const address = this.server.address();
        const port = typeof address === 'object' && address ? address.port : this.config.port;
        const host = this.config.host === '0.0.0.0' || this.config.host === '::' ? '127.0.0.1' : this.config.host;
        const url = `http://${host}:${port}`;

        this.session.setUrl(url);
        this.port = port;
        this.url = url;

        // ---- the contract banner ----
        this.logger.raw(renderBanner({ url, token: this.session.token }));
        this.logger.raw(renderHints({
          url,
          token: this.session.token,
          dashboard: this.config.dashboard,
          sessionFile: this.session.sessionFileAbs ?? null,
          logFile: this.logger.filePath ?? null,
        }));

        this.logger.info('bridge listening', { url, sessionId: this.session.id, token: maskToken(this.session.token) });
        resolve({ url, token: this.session.token, port });
      });
    });
  }

  async stop() {
    this.logger.info('shutting down bridge');
    this.studio.closeWaiters();
    this.queue.drain('bridge shutting down');
    this.session.cleanup();
    await new Promise((resolve) => this.server.close(() => resolve()));
    this.logger.info('bridge stopped');
    this.logger.close();
  }
}
