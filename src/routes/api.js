/**
 * Core API routes: /status, /command, /logs, /token/rotate, /ping.
 */

import { sendJson, sendError, readJsonBody } from '../core/http.js';
import { maskToken } from '../core/token.js';

/** Actions the Roblox Studio plugin knows how to execute. */
export const SUPPORTED_ACTIONS = [
  { action: 'ping', description: 'Round-trip check against the Studio plugin', params: {} },
  { action: 'run_luau', description: 'Execute a Luau snippet inside Studio and return its output', params: { code: 'string', timeoutMs: 'number?' } },
  { action: 'get_place_info', description: 'Return PlaceId, GameId, place name and DataModel stats', params: {} },
  { action: 'list_instances', description: 'List children of a path, e.g. game.Workspace', params: { path: 'string', depth: 'number?' } },
  { action: 'get_instance', description: 'Read properties of a single instance', params: { path: 'string' } },
  { action: 'create_instance', description: 'Create an instance under a parent path', params: { className: 'string', parent: 'string', properties: 'object?' } },
  { action: 'set_property', description: 'Set a property on an instance', params: { path: 'string', property: 'string', value: 'any' } },
  { action: 'delete_instance', description: 'Destroy an instance', params: { path: 'string' } },
  { action: 'get_script_source', description: 'Read the source of a Script/LocalScript/ModuleScript', params: { path: 'string' } },
  { action: 'set_script_source', description: 'Overwrite the source of a script instance', params: { path: 'string', source: 'string' } },
  { action: 'get_selection', description: 'Return the current Studio selection', params: {} },
  { action: 'set_selection', description: 'Select instances by path', params: { paths: 'string[]' } },
  { action: 'get_output', description: 'Return recent Studio output/log messages captured by the plugin', params: { limit: 'number?' } },
];

const ACTION_NAMES = new Set(SUPPORTED_ACTIONS.map((a) => a.action));

/**
 * @param {object} ctx
 * @param {import('../core/session.js').Session} ctx.session
 * @param {import('../core/commandQueue.js').CommandQueue} ctx.queue
 * @param {import('../core/logger.js').Logger} ctx.logger
 * @param {object} ctx.config
 */
export function createApiRoutes(ctx) {
  const { session, queue, logger, config } = ctx;

  return {
    /** GET /status — full authenticated status of the bridge. */
    async status(req, res) {
      sendJson(res, 200, {
        ok: true,
        ...session.toStatus({ includeToken: false }),
        queue: queue.snapshot(),
        actions: SUPPORTED_ACTIONS.map((a) => a.action),
        endpoints: ENDPOINTS,
      });
    },

    /** GET /ping — lightweight authenticated liveness probe. */
    async ping(req, res) {
      sendJson(res, 200, { ok: true, pong: true, sessionId: session.id, uptimeSeconds: session.uptimeSeconds(), timestamp: new Date().toISOString() });
    },

    /** GET /actions — machine-readable catalogue of supported commands. */
    async actions(req, res) {
      sendJson(res, 200, { ok: true, actions: SUPPORTED_ACTIONS });
    },

    /**
     * POST /command — enqueue a command for Roblox Studio and wait for the result.
     * Body: { action: string, params?: object, timeoutMs?: number, async?: boolean }
     */
    async command(req, res) {
      const body = await readJsonBody(req, config.maxBodyBytes);
      if (!body.ok) return sendError(res, 400, 'INVALID_BODY', body.error);

      const { action, params, timeoutMs, async: isAsync } = body.data ?? {};
      if (typeof action !== 'string' || !action.trim()) {
        return sendError(res, 400, 'MISSING_ACTION', 'Field "action" is required.', { supported: [...ACTION_NAMES] });
      }
      if (!ACTION_NAMES.has(action)) {
        return sendError(res, 400, 'UNKNOWN_ACTION', `Unknown action "${action}".`, { supported: [...ACTION_NAMES] });
      }
      if (params !== undefined && (typeof params !== 'object' || params === null || Array.isArray(params))) {
        return sendError(res, 400, 'INVALID_PARAMS', 'Field "params" must be an object.');
      }

      session.stats.commandsQueued += 1;
      const { command, promise } = queue.enqueue({
        action,
        params,
        source: req.headers['x-client-name'] ? String(req.headers['x-client-name']) : 'http',
        timeoutMs: Number.isFinite(timeoutMs) ? Math.min(Math.max(timeoutMs, 1000), 300_000) : config.commandTimeoutMs,
      });

      if (isAsync === true) {
        promise.then((done) => {
          if (done.ok) session.stats.commandsCompleted += 1; else session.stats.commandsFailed += 1;
        });
        return sendJson(res, 202, { ok: true, accepted: true, commandId: command.id, poll: `/command/${command.id}` });
      }

      const done = await promise;
      if (done.ok) session.stats.commandsCompleted += 1; else session.stats.commandsFailed += 1;

      const status = done.ok ? 200 : (done.state === 'timeout' ? 504 : 502);
      sendJson(res, status, { ok: done.ok, command: done });
    },

    /** GET /command/:id — look up a previously issued command. */
    async commandById(req, res, { id }) {
      const found = queue.history.find((c) => c.id === id)
        ?? (queue.inFlight.has(id) ? queue.describe(queue.inFlight.get(id)) : null)
        ?? (queue.pending.find((c) => c.id === id) ? queue.describe(queue.pending.find((c) => c.id === id)) : null);
      if (!found) return sendError(res, 404, 'COMMAND_NOT_FOUND', `No command with id "${id}".`);
      sendJson(res, 200, { ok: true, command: found });
    },

    /** GET /queue — current queue snapshot. */
    async queueState(req, res) {
      sendJson(res, 200, { ok: true, queue: queue.snapshot() });
    },

    /** GET /logs?limit=100&level=info */
    async logs(req, res, _params, url) {
      const limit = Math.min(Math.max(Number.parseInt(url.searchParams.get('limit') ?? '100', 10) || 100, 1), 500);
      const level = url.searchParams.get('level') ?? undefined;
      sendJson(res, 200, { ok: true, count: logger.buffer.length, entries: logger.recent(limit, level) });
    },

    /**
     * POST /token/rotate — issue a brand new token immediately.
     * The response is the only place the new token is returned in full.
     */
    async rotateToken(req, res) {
      const { current } = session.rotate(config.tokenBytes);
      logger.addSecret(current);
      logger.warn('token rotated - previous token is now invalid', { sessionId: session.id, token: maskToken(current) });
      sendJson(res, 200, {
        ok: true,
        rotated: true,
        token: current,
        tokenIssuedAt: session.tokenIssuedAt.toISOString(),
        rotations: session.rotations,
        note: 'The previous token is invalid as of now. Update all clients.',
      });
    },
  };
}

export const ENDPOINTS = [
  { method: 'GET', path: '/health', auth: false, description: 'Public liveness probe (no token needed)' },
  { method: 'GET', path: '/status', auth: true, description: 'Full bridge status, stats and connected clients' },
  { method: 'GET', path: '/ping', auth: true, description: 'Authenticated liveness probe' },
  { method: 'GET', path: '/actions', auth: true, description: 'Catalogue of supported Studio actions' },
  { method: 'POST', path: '/command', auth: true, description: 'Send a command to Roblox Studio and await the result' },
  { method: 'GET', path: '/command/:id', auth: true, description: 'Look up a command by id' },
  { method: 'GET', path: '/queue', auth: true, description: 'Queue snapshot' },
  { method: 'GET', path: '/logs', auth: true, description: 'Recent log entries' },
  { method: 'POST', path: '/token/rotate', auth: true, description: 'Generate a new token and invalidate the old one' },
  { method: 'POST', path: '/mcp', auth: true, description: 'JSON-RPC 2.0 / MCP endpoint (initialize, tools/list, tools/call)' },
  { method: 'GET', path: '/mcp', auth: true, description: 'MCP server descriptor' },
  { method: 'POST', path: '/studio/handshake', auth: true, description: 'Roblox plugin registers itself' },
  { method: 'GET', path: '/studio/poll', auth: true, description: 'Roblox plugin long-polls for the next command' },
  { method: 'POST', path: '/studio/result', auth: true, description: 'Roblox plugin returns a command result' },
  { method: 'POST', path: '/studio/log', auth: true, description: 'Roblox plugin forwards Studio output' },
  { method: 'GET', path: '/dashboard', auth: false, description: 'Web dashboard (token entered in the UI)' },
];
