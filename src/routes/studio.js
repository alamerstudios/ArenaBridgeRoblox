/**
 * Roblox Studio plugin routes.
 *
 * Roblox's HttpService can only make outbound requests, so the plugin drives
 * everything by polling. All routes below require the dynamic session token.
 */

import { sendJson, sendError, readJsonBody } from '../core/http.js';

export function createStudioRoutes(ctx) {
  const { session, queue, logger, config } = ctx;

  /** @type {Set<{res: import('node:http').ServerResponse, timer: NodeJS.Timeout}>} */
  const waiters = new Set();

  // When a command is queued, immediately hand it to a waiting poller.
  queue.on('queued', () => {
    for (const waiter of waiters) {
      const command = queue.dequeue();
      if (!command) break;
      waiters.delete(waiter);
      clearTimeout(waiter.timer);
      sendJson(waiter.res, 200, { ok: true, command: publicCommand(command) });
    }
  });

  function publicCommand(command) {
    return { id: command.id, action: command.action, params: command.params, createdAt: new Date(command.createdAt).toISOString() };
  }

  return {
    /** POST /studio/handshake — plugin announces itself. */
    async handshake(req, res) {
      const body = await readJsonBody(req, config.maxBodyBytes);
      if (!body.ok) return sendError(res, 400, 'INVALID_BODY', body.error);

      const { clientId, name, version, place } = body.data ?? {};
      const id = clientId || req.headers['x-client-id'] || `studio-${Math.random().toString(36).slice(2, 8)}`;
      session.touchClient(String(id), {
        name: name ?? 'Roblox Studio',
        version: version ?? 'unknown',
        place: place ?? null,
      });
      logger.info('Roblox Studio connected', { clientId: String(id), place: place ?? null, version: version ?? 'unknown' });

      sendJson(res, 200, {
        ok: true,
        clientId: String(id),
        sessionId: session.id,
        serverTime: new Date().toISOString(),
        pollIntervalMs: 1000,
        pollTimeoutMs: config.pollTimeoutMs,
      });
    },

    /**
     * GET /studio/poll — long poll for the next command.
     * Returns { command: null } after pollTimeoutMs so HttpService never times out.
     */
    async poll(req, res) {
      // Refresh liveness only — never overwrite the name registered at handshake.
      const clientId = req.headers['x-client-id'];
      if (clientId) session.touchClient(String(clientId));

      const command = queue.dequeue();
      if (command) {
        return sendJson(res, 200, { ok: true, command: publicCommand(command) });
      }

      const waiter = {
        res,
        timer: setTimeout(() => {
          waiters.delete(waiter);
          sendJson(res, 200, { ok: true, command: null, idle: true });
        }, config.pollTimeoutMs),
      };
      waiters.add(waiter);

      req.on('close', () => {
        if (waiters.has(waiter)) {
          waiters.delete(waiter);
          clearTimeout(waiter.timer);
        }
      });
    },

    /** POST /studio/result — plugin returns a command result. */
    async result(req, res) {
      const body = await readJsonBody(req, config.maxBodyBytes);
      if (!body.ok) return sendError(res, 400, 'INVALID_BODY', body.error);

      const { id, ok, result, error } = body.data ?? {};
      if (typeof id !== 'string' || !id) return sendError(res, 400, 'MISSING_ID', 'Field "id" is required.');

      const completed = queue.complete(id, { ok: ok !== false, result: result ?? null, error: error ?? null });
      if (!completed) return sendError(res, 404, 'COMMAND_NOT_FOUND', `No in-flight command with id "${id}".`);

      logger[completed.ok ? 'info' : 'warn'](`command ${completed.ok ? 'completed' : 'failed'}: ${completed.action}`, {
        id: completed.id,
        durationMs: completed.durationMs,
        ...(completed.ok ? {} : { error: completed.error }),
      });

      sendJson(res, 200, { ok: true, acknowledged: completed.id });
    },

    /** POST /studio/log — forward Studio output into the bridge log. */
    async log(req, res) {
      const body = await readJsonBody(req, config.maxBodyBytes);
      if (!body.ok) return sendError(res, 400, 'INVALID_BODY', body.error);

      const entries = Array.isArray(body.data?.entries) ? body.data.entries : [body.data];
      let count = 0;
      for (const entry of entries) {
        if (!entry || typeof entry.message !== 'string') continue;
        const level = ['debug', 'info', 'warn', 'error'].includes(entry.level) ? entry.level : 'info';
        logger[level](`[studio] ${entry.message}`);
        count += 1;
      }
      sendJson(res, 200, { ok: true, received: count });
    },

    /** Release all long-poll waiters (shutdown). */
    closeWaiters() {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        try { sendJson(waiter.res, 200, { ok: true, command: null, shuttingDown: true }); } catch { /* ignore */ }
      }
      waiters.clear();
    },
  };
}
