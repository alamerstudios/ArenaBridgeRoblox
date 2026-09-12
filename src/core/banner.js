/**
 * Startup banner.
 *
 * The exact machine-parsable block below is contract: the .bat / .ps1 launchers
 * and any external tooling scrape it to discover url + token. Do not reformat
 * the ---BRIDGE--- / ---END--- section without updating scripts/ as well.
 */

const LINE = '='.repeat(60);

/**
 * @param {{ url: string, token: string }} info
 * @returns {string}
 */
export function renderBanner({ url, token }) {
  return [
    LINE,
    'NexusAI Bridge: LAEUFT',
    LINE,
    '---BRIDGE---',
    `url: ${url}`,
    `token: ${token}`,
    '---END---',
  ].join('\n');
}

/**
 * Extra human-oriented hints printed after the machine block.
 * @param {{ url: string, token: string, dashboard: boolean, sessionFile: string|null, logFile: string|null }} info
 */
export function renderHints({ url, token, dashboard, sessionFile, logFile }) {
  const lines = [];
  lines.push('');
  if (dashboard) lines.push(`Dashboard : ${url}/dashboard?token=${encodeURIComponent(token)}`);
  lines.push(`Status    : ${url}/status   (Header: Authorization: Bearer <token>)`);
  lines.push(`MCP       : ${url}/mcp      (JSON-RPC 2.0)`);
  if (sessionFile) lines.push(`Session   : ${sessionFile}`);
  if (logFile) lines.push(`Logfile   : ${logFile}`);
  lines.push('');
  lines.push('Der Token wird bei jedem Start neu erzeugt. Stop: Strg+C');
  lines.push(LINE);
  return lines.join('\n');
}

export { LINE as BANNER_LINE };
