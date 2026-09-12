/**
 * /mcp — JSON-RPC 2.0 endpoint following the Model Context Protocol shape.
 *
 * Supported methods:
 *   initialize, ping, tools/list, tools/call, resources/list, resources/read,
 *   notifications/initialized
 *
 * Every MCP tool maps onto a Studio command and therefore requires the same
 * dynamic session token as the rest of the API.
 */

import { sendJson, sendError, readJsonBody } from '../core/http.js';
import { SUPPORTED_ACTIONS } from './api.js';

const PROTOCOL_VERSION = '2024-11-05';

const TOOL_SCHEMAS = {
  ping: { type: 'object', properties: {}, additionalProperties: false },
  run_luau: {
    type: 'object',
    properties: {
      code: { type: 'string', description: 'Luau source to execute inside Roblox Studio' },
      timeoutMs: { type: 'number', description: 'Optional execution timeout in milliseconds' },
    },
    required: ['code'],
  },
  get_place_info: { type: 'object', properties: {}, additionalProperties: false },
  list_instances: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Instance path, e.g. game.Workspace' },
      depth: { type: 'number', description: 'Recursion depth (default 1)' },
    },
    required: ['path'],
  },
  get_instance: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
  },
  create_instance: {
    type: 'object',
    properties: {
      className: { type: 'string' },
      parent: { type: 'string' },
      properties: { type: 'object' },
    },
    required: ['className', 'parent'],
  },
  set_property: {
    type: 'object',
    properties: { path: { type: 'string' }, property: { type: 'string' }, value: {} },
    required: ['path', 'property', 'value'],
  },
  delete_instance: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
  },
  get_script_source: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
  },
  set_script_source: {
    type: 'object',
    properties: { path: { type: 'string' }, source: { type: 'string' } },
    required: ['path', 'source'],
  },
  get_selection: { type: 'object', properties: {}, additionalProperties: false },
  set_selection: {
    type: 'object',
    properties: { paths: { type: 'array', items: { type: 'string' } } },
    required: ['paths'],
  },
  get_output: {
    type: 'object',
    properties: { limit: { type: 'number' } },
    additionalProperties: false,
  },
};

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id, code, message, data) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data ? { data } : {}) } };
}

export function createMcpRoutes(ctx) {
  const { session, queue, logger, config } = ctx;

  const tools = SUPPORTED_ACTIONS.map((a) => ({
    name: a.action,
    description: a.description,
    inputSchema: TOOL_SCHEMAS[a.action] ?? { type: 'object', properties: {} },
  }));

  async function handleMethod(method, params, id) {
    switch (method) {
      case 'initialize':
        return rpcResult(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false }, resources: { subscribe: false, listChanged: false }, logging: {} },
          serverInfo: { name: 'nexusai-bridge', version: '1.0.0' },
          instructions: 'Tools run inside the connected Roblox Studio session. Start the NexusAI plugin in Studio first.',
        });

      case 'notifications/initialized':
        return null; // notification, no response

      case 'ping':
        return rpcResult(id, { ok: true, sessionId: session.id, uptimeSeconds: session.uptimeSeconds() });

      case 'tools/list':
        return rpcResult(id, { tools });

      case 'tools/call': {
        const name = params?.name;
        const args = params?.arguments ?? {};
        if (!name || !tools.some((t) => t.name === name)) {
          return rpcError(id, -32602, `Unknown tool: ${name}`, { available: tools.map((t) => t.name) });
        }

        session.stats.commandsQueued += 1;
        const { promise } = queue.enqueue({ action: name, params: args, source: 'mcp', timeoutMs: config.commandTimeoutMs });
        const done = await promise;
        if (done.ok) session.stats.commandsCompleted += 1; else session.stats.commandsFailed += 1;

        if (!done.ok) {
          return rpcResult(id, {
            isError: true,
            content: [{ type: 'text', text: `Command "${name}" failed: ${done.error}` }],
          });
        }

        const text = typeof done.result === 'string' ? done.result : JSON.stringify(done.result, null, 2);
        return rpcResult(id, {
          isError: false,
          content: [{ type: 'text', text }],
          structuredContent: typeof done.result === 'object' && done.result !== null ? done.result : undefined,
        });
      }

      case 'resources/list':
        return rpcResult(id, {
          resources: [
            { uri: 'nexusai://status', name: 'Bridge status', description: 'Live bridge status JSON', mimeType: 'application/json' },
            { uri: 'nexusai://logs', name: 'Bridge logs', description: 'Recent bridge log entries', mimeType: 'application/json' },
          ],
        });

      case 'resources/read': {
        const uri = params?.uri;
        if (uri === 'nexusai://status') {
          return rpcResult(id, {
            contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(session.toStatus(), null, 2) }],
          });
        }
        if (uri === 'nexusai://logs') {
          return rpcResult(id, {
            contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(logger.recent(100), null, 2) }],
          });
        }
        return rpcError(id, -32602, `Unknown resource: ${uri}`);
      }

      default:
        return rpcError(id, -32601, `Method not found: ${method}`);
    }
  }

  return {
    /** GET /mcp — descriptor so clients can discover the endpoint. */
    async describe(req, res) {
      sendJson(res, 200, {
        ok: true,
        protocol: 'jsonrpc-2.0',
        protocolVersion: PROTOCOL_VERSION,
        transport: 'http',
        serverInfo: { name: 'nexusai-bridge', version: '1.0.0' },
        tools: tools.map((t) => ({ name: t.name, description: t.description })),
        usage: 'POST JSON-RPC 2.0 requests to this same URL with the bridge token in the Authorization header.',
      });
    },

    /** POST /mcp — JSON-RPC 2.0, supports single requests and batches. */
    async rpc(req, res) {
      const body = await readJsonBody(req, config.maxBodyBytes);
      if (!body.ok) return sendJson(res, 400, rpcError(null, -32700, `Parse error: ${body.error}`));

      const payload = body.data;
      const isBatch = Array.isArray(payload);
      const requests = isBatch ? payload : [payload];

      if (isBatch && requests.length === 0) {
        return sendJson(res, 400, rpcError(null, -32600, 'Invalid Request: empty batch'));
      }

      const responses = [];
      for (const request of requests) {
        if (!request || typeof request !== 'object' || typeof request.method !== 'string') {
          responses.push(rpcError(request?.id ?? null, -32600, 'Invalid Request'));
          continue;
        }
        logger.debug(`mcp ${request.method}`, { id: request.id ?? null });
        try {
          const response = await handleMethod(request.method, request.params, request.id ?? null);
          if (response !== null) responses.push(response);
        } catch (err) {
          logger.error(`mcp handler error: ${err.message}`, { method: request.method });
          responses.push(rpcError(request.id ?? null, -32603, `Internal error: ${err.message}`));
        }
      }

      if (responses.length === 0) return res.writeHead(204).end(); // notifications only
      sendJson(res, 200, isBatch ? responses : responses[0]);
    },
  };
}

export { PROTOCOL_VERSION };
