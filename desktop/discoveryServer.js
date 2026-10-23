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
 *
 * The server also records when the plugin last asked for a session. The
 * desktop UI shows this so "no Place is listed" can be told apart from
 * "the plugin never reached this app" at a glance.
 */
export class PluginDiscoveryServer {
  constructor({ getSession, port = DEFAULT_PORT, logger = console } = {}) {
    this.getSession = getSession;
    this.port = port;
    this.logger = logger;
    this.server = null;
    this.boundPort = null;
    this.lastError = null;
    this.counters = {
      requests: 0,
      sessionsServed: 0,
      lastRequestAt: null,
      lastServedAt: null,
      lastOutcome: null,
    };
  }

  /** Secret-free contact statistics for the desktop UI. */
  diagnostics() {
    return {
      listening: Boolean(this.server),
      port: this.boundPort ?? this.port,
      lastError: this.lastError,
      ...this.counters,
    };
  }

  #note(outcome) {
    this.counters.requests += 1;
    this.counters.lastRequestAt = Date.now();
    this.counters.lastOutcome = outcome;
    if (outcome === 'served') {
      this.counters.sessionsServed += 1;
      this.counters.lastServedAt = this.counters.lastRequestAt;
    }
  }

  start() {
    if (this.server) return Promise.resolve({ port: this.boundPort ?? this.port });
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        const remote = req.socket.remoteAddress ?? '';
        const isLoopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
        if (!isLoopback) {
          this.#note('loopback_only');
          return json(res, 403, { ok: false, error: 'loopback_only' });
        }
        if (req.method !== 'GET' || req.url?.split('?')[0] !== '/v1/session') {
          this.#note('not_found');
          return json(res, 404, { ok: false, error: 'not_found' });
        }

        const session = this.getSession?.();
        if (!session?.url || !session?.token) {
          this.#note('bridge_starting');
          return json(res, 503, { ok: false, error: 'bridge_starting', retryAfterMs: 1500 });
        }
        this.#note('served');
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
        this.lastError = error.code === 'EADDRINUSE'
          ? `Plugin-Port ${this.port} ist bereits belegt. Läuft der Arena Studio Connecter schon? Schließe die andere Instanz, damit das Studio-Plugin diese App findet.`
          : `Plugin-Erkennung konnte nicht starten: ${error.message}`;
        reject(new Error(this.lastError));
      };
      this.server.once('error', onError);
      this.server.listen(this.port, '127.0.0.1', () => {
        this.server.removeListener('error', onError);
        const address = this.server.address();
        const boundPort = typeof address === 'object' && address ? address.port : this.port;
        this.boundPort = boundPort;
        this.lastError = null;
        resolve({ port: boundPort, url: `http://127.0.0.1:${boundPort}` });
      });
    });
  }

  stop() {
    if (!this.server) return Promise.resolve();
    const server = this.server;
    this.server = null;
    this.boundPort = null;
    return new Promise((resolve) => server.close(() => resolve()));
  }
}

export { DEFAULT_PORT as PLUGIN_DISCOVERY_PORT };
