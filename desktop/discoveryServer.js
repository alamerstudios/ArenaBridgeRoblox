import http from 'node:http';

const DEFAULT_PORT = 32192;

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

/**
 * Loopback-only discovery endpoint used by the installed Studio plugin. This
 * endpoint is intentionally on a separate port that is never exposed through
 * Cloudflare. It lets the plugin discover a freshly rotated token without any
 * fields or persisted credentials in Roblox Studio.
 */
export class PluginDiscoveryServer {
  constructor({ getSession, port = DEFAULT_PORT, logger = console } = {}) {
    this.getSession = getSession;
    this.port = port;
    this.logger = logger;
    this.server = null;
  }

  start() {
    if (this.server) return Promise.resolve({ port: this.port });
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        const remote = req.socket.remoteAddress ?? '';
        const isLoopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
        if (!isLoopback) return json(res, 403, { ok: false, error: 'loopback_only' });
        if (req.method !== 'GET' || req.url?.split('?')[0] !== '/v1/session') {
          return json(res, 404, { ok: false, error: 'not_found' });
        }

        const session = this.getSession?.();
        if (!session?.url || !session?.token) {
          return json(res, 503, { ok: false, error: 'bridge_starting', retryAfterMs: 1500 });
        }
        return json(res, 200, {
          ok: true,
          service: 'arena-studio-connecter',
          url: session.url,
          token: session.token,
          sessionId: session.id,
          issuedAt: session.tokenIssuedAt?.toISOString?.() ?? new Date().toISOString(),
        });
      });

      const onError = (error) => {
        this.server = null;
        reject(new Error(error.code === 'EADDRINUSE'
          ? `Plugin discovery port ${this.port} is already in use.`
          : `Plugin discovery failed: ${error.message}`));
      };
      this.server.once('error', onError);
      this.server.listen(this.port, '127.0.0.1', () => {
        this.server.removeListener('error', onError);
        const address = this.server.address();
        const boundPort = typeof address === 'object' && address ? address.port : this.port;
        this.boundPort = boundPort;
        resolve({ port: boundPort, url: `http://127.0.0.1:${boundPort}` });
      });
    });
  }

  stop() {
    if (!this.server) return Promise.resolve();
    const server = this.server;
    this.server = null;
    return new Promise((resolve) => server.close(() => resolve()));
  }
}

export { DEFAULT_PORT as PLUGIN_DISCOVERY_PORT };
