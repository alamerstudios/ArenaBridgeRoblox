/**
 * Core API routes: /status, /command, /logs, /token/rotate, /ping.
 */

import { sendJson, sendError, readJsonBody } from '../core/http.js';
import { maskToken, generateId } from '../core/token.js';
import { resolveStudioTarget } from '../core/commandTarget.js';

/** Actions exposed to Arena through REST and MCP. Desktop actions never leave the local host. */
export const SUPPORTED_ACTIONS = [
  { action: 'ping', description: 'Round-trip check against the Studio plugin', params: {} },
  { action: 'run_luau', description: 'Execute a Luau snippet inside Studio and return its output', params: { code: 'string', timeoutMs: 'number?' } },
  { action: 'get_place_info', description: 'Return PlaceId, GameId, place name and DataModel stats', params: {} },
  { action: 'play_game', description: 'Start a real Studio playtest (mode play) or server simulation (mode run)', params: { mode: "'play' | 'run'?" } },
  { action: 'stop_game', description: 'Stop the active Studio playtest/simulation and return to edit mode', params: {} },
  { action: 'get_play_state', description: 'Read whether Studio is editing, starting or running a playtest', params: {} },
  { action: 'list_instances', description: 'List children of a path, e.g. game.Workspace', params: { path: 'string', depth: 'number?' } },
  { action: 'get_instance', description: 'Read properties of a single instance', params: { path: 'string' } },
  { action: 'create_instance', description: 'Create an instance under a parent path', params: { className: 'string', parent: 'string', properties: 'object?' } },
  { action: 'insert_model', description: 'Insert an uploaded Roblox Model asset by ID, including Blender/Open-Cloud models', params: { assetId: 'string|number', parent: 'string?', position: 'Vector3?', name: 'string?' } },
  { action: 'set_property', description: 'Set a property on an instance', params: { path: 'string', property: 'string', value: 'any' } },
  { action: 'delete_instance', description: 'Destroy an instance', params: { path: 'string' } },
  { action: 'get_script_source', description: 'Read the source of a Script/LocalScript/ModuleScript', params: { path: 'string' } },
  { action: 'set_script_source', description: 'Overwrite the source of a script instance', params: { path: 'string', source: 'string' } },
  { action: 'get_selection', description: 'Return the current Studio selection', params: {} },
  { action: 'set_selection', description: 'Select instances by path', params: { paths: 'string[]' } },
  { action: 'get_output', description: 'Return recent Studio output/log messages captured by the plugin', params: { limit: 'number?' } },
  { action: 'get_blender_status', description: 'Check local Blender, Open-Cloud key and Creator configuration on the desktop', scope: 'desktop', params: {} },
  { action: 'create_blender_mesh', description: 'Build meshes locally in Blender from safe structured objects, export FBX/GLB and optionally upload through Open Cloud', scope: 'desktop', params: { name: 'string', description: 'string?', format: "'fbx' | 'glb'?", upload: 'boolean?', objects: 'Array<mesh | primitive>', creatorId: 'string?', creatorType: "'user' | 'group'?" } },
];

const ACTION_NAMES = new Set(SUPPORTED_ACTIONS.map((a) => a.action));
export const LOCAL_ACTION_NAMES = new Set(SUPPORTED_ACTIONS.filter((entry) => entry.scope === 'desktop').map((entry) => entry.action));

export function commandFailure(command, scope = 'studio') {
  const timeout = command.state === 'timeout';
  return {
    code: timeout ? 'COMMAND_TIMEOUT' : (scope === 'desktop' ? 'LOCAL_ACTION_FAILED' : 'STUDIO_ACTION_FAILED'),
    message: typeof command.error === 'string' ? command.error : 'Die Aktion wurde ohne Fehlerdetails beendet.',
    details: {
      ...(command.errorDetails ?? {}),
      commandId: command.id,
      action: command.action,
      state: command.state,
      targetClientId: command.targetClientId,
      assignedClientId: command.assignedClientId,
      durationMs: command.durationMs,
    },
  };
}

function commandPayload(command, scope = 'studio') {
  const pending = command.state === 'pending' || command.state === 'dispatched' || command.state === 'running';
  const succeeded = pending || command.ok === true;
  return {
    ok: succeeded,
    command,
    result: command.result ?? null,
    error: succeeded ? null : commandFailure(command, scope),
    ...(pending ? { pending: true } : {}),
  };
}

/** Execute a host-local action without sending its secrets or files to Studio. */
export async function performLocalAction(ctx, { action, params = {}, targetClientId = null, source = 'http' }) {
  const { session, config, logger } = ctx;
  const startedAt = Date.now();
  const command = { id: generateId(8), action, state: 'running', createdAt: startedAt, source, targetClientId };
  const handler = config.localActions?.[action];
  session.stats.commandsQueued += 1;
  if (typeof handler !== 'function') {
    session.stats.commandsFailed += 1;
    return { ...command, state: 'failed', ok: false, result: null, error: 'Diese Desktop-Aktion ist nur in der Arena Studio Connecter EXE verfügbar.', durationMs: 0 };
  }
  try {
    const result = await handler(params, { session, targetClientId, source });
    session.stats.commandsCompleted += 1;
    return { ...command, state: 'completed', ok: true, result, error: null, durationMs: Date.now() - startedAt };
  } catch (error) {
    session.stats.commandsFailed += 1;
    logger.warn(`local command failed: ${action}`, { error: error.message, targetClientId });
    return { ...command, state: 'failed', ok: false, result: null, error: error.message, durationMs: Date.now() - startedAt };
  }
}

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

      const { action, params, timeoutMs, async: isAsync, targetClientId } = body.data ?? {};
      if (typeof action !== 'string' || !action.trim()) {
        return sendError(res, 400, 'MISSING_ACTION', 'Field "action" is required.', { supported: [...ACTION_NAMES] });
      }
      if (!ACTION_NAMES.has(action)) {
        return sendError(res, 400, 'UNKNOWN_ACTION', `Unknown action "${action}".`, { supported: [...ACTION_NAMES] });
      }
      if (params !== undefined && (typeof params !== 'object' || params === null || Array.isArray(params))) {
        return sendError(res, 400, 'INVALID_PARAMS', 'Field "params" must be an object.');
      }
      if (targetClientId !== undefined && (typeof targetClientId !== 'string' || !targetClientId.trim())) {
        return sendError(res, 400, 'INVALID_TARGET', 'Field "targetClientId" must be a non-empty string.');
      }

      const activeClients = session.editableClients();
      if (targetClientId && !activeClients.some((client) => client.id === targetClientId)) {
        return sendError(res, 409, 'STUDIO_CLIENT_OFFLINE', `Studio client "${targetClientId}" is not connected.`, {
          connectedClientIds: activeClients.map((client) => client.id),
        });
      }

      const source = req.headers['x-client-name'] ? String(req.headers['x-client-name']) : 'http';
      if (LOCAL_ACTION_NAMES.has(action)) {
        if (isAsync === true) return sendError(res, 400, 'ASYNC_NOT_SUPPORTED', 'Desktop actions are synchronous.');
        const done = await performLocalAction({ session, queue, logger, config }, {
          action, params: params ?? {}, targetClientId: targetClientId || null, source,
        });
        return sendJson(res, 200, commandPayload(done, 'desktop'));
      }

      const resolved = resolveStudioTarget(session, action, targetClientId || null);
      if (resolved.error === 'STUDIO_CLIENT_OFFLINE') {
        return sendError(res, 409, 'STUDIO_CLIENT_OFFLINE', `Studio client "${targetClientId}" is not connected.`);
      }
      if (!targetClientId && resolved.clients.length > 1) {
        return sendError(res, 400, 'TARGET_REQUIRED', 'Multiple Studio Places are open. Set "targetClientId" to select one.', {
          clients: resolved.clients.map((client) => ({ id: client.id, placeName: client.placeName, placeId: client.placeId ?? client.place })),
        });
      }

      session.stats.commandsQueued += 1;
      const { command, promise } = queue.enqueue({
        action,
        params,
        source,
        targetClientId: resolved.targetClientId,
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

      if (done.ok && action === 'play_game') {
        const mode = done.result?.mode ?? params?.mode ?? 'play';
        session.touchClient(resolved.targetClientId, {
          playtestActive: true,
          playtestMode: mode,
          isRunning: mode === 'simulation',
          editModeActive: mode === 'simulation',
        });
      }
      sendJson(res, done.state === 'timeout' ? 504 : 200, commandPayload(done));
    },

    /** GET /command/:id — look up a previously issued command. */
    async commandById(req, res, { id }) {
      const found = queue.history.find((c) => c.id === id)
        ?? (queue.inFlight.has(id) ? queue.describe(queue.inFlight.get(id)) : null)
        ?? (queue.pending.find((c) => c.id === id) ? queue.describe(queue.pending.find((c) => c.id === id)) : null);
      if (!found) return sendError(res, 404, 'COMMAND_NOT_FOUND', `No command with id "${id}".`);
      sendJson(res, 200, commandPayload(found));
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
  { method: 'GET', path: '/agent/guide', auth: false, description: 'Secret-free Arena Agent connection guide' },
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
