/** Roblox Studio plugin routes. All routes require the dynamic bridge token. */

import { sendJson, sendError, readJsonBody } from '../core/http.js';

export function createStudioRoutes(ctx) {
  const { session, queue, logger, config } = ctx;
  /** @type {Set<{res: import('node:http').ServerResponse, timer: NodeJS.Timeout, clientId:string|null}>} */
  const waiters = new Set();

  queue.on('queued', () => {
    for (const waiter of [...waiters]) {
      const command = queue.dequeue(waiter.clientId);
      if (!command) continue;
      waiters.delete(waiter);
      clearTimeout(waiter.timer);
      sendJson(waiter.res, 200, { ok: true, command: publicCommand(command) });
    }
  });

  function publicCommand(command) {
    return {
      id: command.id,
      action: command.action,
      params: command.params,
      createdAt: new Date(command.createdAt).toISOString(),
    };
  }

  return {
    async handshake(req, res) {
      const body = await readJsonBody(req, config.maxBodyBytes);
      if (!body.ok) return sendError(res, 400, 'INVALID_BODY', body.error);

      const data = body.data ?? {};
      const id = data.clientId || req.headers['x-client-id'] || `studio-${Math.random().toString(36).slice(2, 8)}`;
      session.touchClient(String(id), {
        name: data.name ?? 'Roblox Studio',
        version: data.version ?? 'unknown',
        place: data.place ?? data.placeId ?? null,
        placeId: data.placeId,
        placeName: data.placeName,
        gameId: data.gameId,
        placeVersion: data.placeVersion,
        studioVersion: data.studioVersion,
        accountUserId: data.accountUserId,
        accountName: data.accountName,
        accountDisplayName: data.accountDisplayName,
        isEdit: data.isEdit,
        isRunning: data.isRunning,
      });
      logger.info('Roblox Studio connected', {
        clientId: String(id),
        placeId: data.placeId ?? data.place ?? null,
        placeName: data.placeName ?? null,
        accountName: data.accountName ?? null,
        version: data.version ?? 'unknown',
      });

      sendJson(res, 200, {
        ok: true,
        clientId: String(id),
        sessionId: session.id,
        serverTime: new Date().toISOString(),
        pollIntervalMs: 1000,
        pollTimeoutMs: config.pollTimeoutMs,
      });
    },

    async poll(req, res) {
      const headerId = req.headers['x-client-id'];
      const clientId = headerId ? String(headerId) : null;
      if (clientId) session.touchClient(clientId);

      const command = queue.dequeue(clientId);
      if (command) return sendJson(res, 200, { ok: true, command: publicCommand(command) });

      const waiter = {
        res,
        clientId,
        timer: setTimeout(() => {
          waiters.delete(waiter);
          sendJson(res, 200, { ok: true, command: null, idle: true });
        }, config.pollTimeoutMs),
      };
      waiters.add(waiter);

      // IncomingMessage "close" can fire as soon as the request body is done,
      // even while the long-poll response is intentionally still open. Track
      // the response instead so only a real client disconnect removes it.
      res.on('close', () => {
        if (!waiters.has(waiter)) return;
        waiters.delete(waiter);
        clearTimeout(waiter.timer);
      });
    },

    async result(req, res) {
      const body = await readJsonBody(req, config.maxBodyBytes);
      if (!body.ok) return sendError(res, 400, 'INVALID_BODY', body.error);

      const { id, ok, result, error } = body.data ?? {};
      if (typeof id !== 'string' || !id) return sendError(res, 400, 'MISSING_ID', 'Field "id" is required.');
      const clientId = req.headers['x-client-id'] ? String(req.headers['x-client-id']) : null;
      const inFlight = queue.inFlight.get(id);
      if (inFlight?.assignedClientId && inFlight.assignedClientId !== clientId) {
        return sendError(res, 409, 'WRONG_STUDIO_CLIENT', 'This command belongs to a different Studio Place.');
      }

      const completed = queue.complete(id, { ok: ok !== false, result: result ?? null, error: error ?? null }, clientId);
      if (!completed) return sendError(res, 404, 'COMMAND_NOT_FOUND', `No in-flight command with id "${id}".`);

      logger[completed.ok ? 'info' : 'warn'](`command ${completed.ok ? 'completed' : 'failed'}: ${completed.action}`, {
        id: completed.id,
        clientId,
        durationMs: completed.durationMs,
        ...(completed.ok ? {} : { error: completed.error }),
      });
      sendJson(res, 200, { ok: true, acknowledged: completed.id });
    },

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

    closeWaiters() {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        try { sendJson(waiter.res, 200, { ok: true, command: null, shuttingDown: true }); } catch { /* ignore */ }
      }
      waiters.clear();
    },
  };
}
