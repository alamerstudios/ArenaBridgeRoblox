import { sendText } from '../core/http.js';
import { SUPPORTED_ACTIONS } from './api.js';

function requestOrigin(req) {
  const forwarded = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim();
  const protocol = forwarded === 'https' ? 'https' : (req.socket?.encrypted ? 'https' : 'http');
  const host = String(req.headers.host ?? '127.0.0.1').replace(/[\r\n]/g, '');
  return `${protocol}://${host}`;
}

function value(input, fallback = 'unknown') {
  return input === undefined || input === null || input === '' ? fallback : String(input);
}

/**
 * A secret-free, machine-readable guide for Arena Agent. It is intentionally a
 * public route so an agent can read it with a normal URL reader. All modifying
 * API routes still require the per-start Bearer token.
 */
export function createAgentRoutes({ session }) {
  return {
    guide(req, res, url) {
      const requestedClientId = url.searchParams.get('clientId') ?? '';
      const clients = session.activeClients();
      const client = clients.find((candidate) => candidate.id === requestedClientId) ?? null;
      const origin = requestOrigin(req);

      const targetBlock = client
        ? [
            `- Client ID: \`${client.id}\``,
            `- Place: ${value(client.placeName, client.place ?? 'unknown')}`,
            `- Place ID: ${value(client.placeId, client.place ?? 'not published')}`,
            `- Universe ID: ${value(client.gameId)}`,
            `- Studio account: ${value(client.accountName)}`,
          ]
        : [
            requestedClientId
              ? `- The requested client \`${requestedClientId}\` is not connected right now.`
              : '- No target client was supplied. Read authenticated GET /status and choose a client ID.',
          ];

      const actions = SUPPORTED_ACTIONS
        .map((action) => `- \`${action.action}\`: ${action.description}`)
        .join('\n');

      const guide = [
        '# Arena Studio Connecter — Agent Guide',
        '',
        'This bridge controls a live Roblox Studio session through its installed plugin.',
        'The guide contains no token. Use the token from the user’s copied prompt only as a Bearer header.',
        '',
        '## Target',
        '',
        ...targetBlock,
        '',
        '## Authentication',
        '',
        `Base URL: \`${origin}\``,
        '',
        'For every authenticated request send:',
        '',
        '```text',
        'Authorization: Bearer TOKEN_FROM_THE_COPIED_PROMPT',
        'Content-Type: application/json',
        'X-Client-Name: Arena Agent',
        '```',
        '',
        '**Never put the token in a URL or query string. Never persist or print it.**',
        '',
        '## Safe workflow',
        '',
        `1. Check the bridge and connected Places with \`GET ${origin}/status\`.`,
        '2. Inspect before editing (`get_place_info`, `list_instances`, `get_instance`, `get_script_source`).',
        '3. Send commands using `POST /command` and include the exact `targetClientId` below.',
        '4. Verify changes with a read command. Do not assume a write succeeded.',
        '5. If Studio is disconnected, stop and ask the user to open/restart Studio and enable HTTP Requests.',
        '',
        'Request shape:',
        '',
        '```json',
        JSON.stringify({
          action: 'list_instances',
          params: { path: 'game.Workspace', depth: 2 },
          targetClientId: client?.id ?? 'CLIENT_ID_FROM_STATUS',
        }, null, 2),
        '```',
        '',
        'Example with curl:',
        '',
        '```bash',
        `curl -sS -X POST "${origin}/command" \\`,
        '  -H "Authorization: Bearer $BRIDGE_TOKEN" \\',
        '  -H "Content-Type: application/json" \\',
        `  --data '${JSON.stringify({ action: 'get_place_info', params: {}, targetClientId: client?.id ?? 'CLIENT_ID_FROM_STATUS' })}'`,
        '```',
        '',
        '## Available Studio actions',
        '',
        actions,
        '',
        `A structured action catalogue is available at authenticated \`GET ${origin}/actions\`.`,
        'The MCP-compatible endpoint is `POST /mcp`; select a Place with the `X-Studio-Client-Id` header.',
        '',
        '## Constraints',
        '',
        '- Work only in the selected client unless the user explicitly selects another Place.',
        '- Prefer focused, reversible edits. Preserve existing project conventions.',
        '- Do not run arbitrary code unrelated to the user’s Roblox task.',
        '- Report what changed and how it was verified.',
        '',
      ].join('\n');

      sendText(res, 200, guide, 'text/markdown; charset=utf-8');
    },
  };
}
