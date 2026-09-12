/**
 * Configuration resolution: defaults < environment variables < CLI flags.
 * Note: NEXUSAI_TOKEN is intentionally NOT supported as a way to pin a static
 * token for normal use. The bridge always generates a fresh token per start.
 */

import { LOG_LEVELS } from './logger.js';

export const DEFAULTS = {
  host: '127.0.0.1',
  port: 0, // 0 = pick a free ephemeral port automatically
  logLevel: 'info',
  logFile: 'logs/bridge.log',
  jsonLogs: false,
  dashboard: true,
  openBrowser: false,
  commandTimeoutMs: 30_000,
  pollTimeoutMs: 25_000,
  sessionFile: '.runtime/session.json',
  tokenBytes: 24,
  maxBodyBytes: 2 * 1024 * 1024, // 2 MB
  rateLimitWindowMs: 60_000,
  rateLimitMax: 600,
  authFailBanThreshold: 20,
};

function parseBool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const v = String(value).toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  return fallback;
}

function parseInteger(value, fallback) {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * @param {string[]} argv raw process.argv.slice(2)
 * @param {NodeJS.ProcessEnv} env
 */
export function loadConfig(argv = [], env = process.env) {
  const config = { ...DEFAULTS };

  // ---- environment -------------------------------------------------------
  config.host = env.NEXUSAI_HOST || config.host;
  config.port = parseInteger(env.NEXUSAI_PORT, config.port);
  config.logLevel = env.NEXUSAI_LOG_LEVEL || config.logLevel;
  config.logFile = env.NEXUSAI_LOG_FILE ?? config.logFile;
  config.jsonLogs = parseBool(env.NEXUSAI_JSON_LOGS, config.jsonLogs);
  config.dashboard = parseBool(env.NEXUSAI_DASHBOARD, config.dashboard);
  config.openBrowser = parseBool(env.NEXUSAI_OPEN_BROWSER, config.openBrowser);
  config.commandTimeoutMs = parseInteger(env.NEXUSAI_COMMAND_TIMEOUT_MS, config.commandTimeoutMs);
  config.sessionFile = env.NEXUSAI_SESSION_FILE || config.sessionFile;
  config.tokenBytes = parseInteger(env.NEXUSAI_TOKEN_BYTES, config.tokenBytes);

  // ---- CLI flags ---------------------------------------------------------
  const flags = { help: false, version: false, printConfig: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    switch (arg) {
      case '-h':
      case '--help': flags.help = true; break;
      case '-v':
      case '--version': flags.version = true; break;
      case '--print-config': flags.printConfig = true; break;
      case '--host': config.host = next(); break;
      case '-p':
      case '--port': config.port = parseInteger(next(), config.port); break;
      case '--log-level': config.logLevel = next(); break;
      case '--log-file': config.logFile = next(); break;
      case '--json-logs': config.jsonLogs = true; break;
      case '--no-log-file': config.logFile = null; break;
      case '--no-dashboard': config.dashboard = false; break;
      case '--open': config.openBrowser = true; break;
      case '--session-file': config.sessionFile = next(); break;
      case '--token-bytes': config.tokenBytes = parseInteger(next(), config.tokenBytes); break;
      case '--command-timeout': config.commandTimeoutMs = parseInteger(next(), config.commandTimeoutMs); break;
      default:
        if (arg.startsWith('--port=')) config.port = parseInteger(arg.slice(7), config.port);
        else if (arg.startsWith('--host=')) config.host = arg.slice(7);
        else if (arg.startsWith('--log-level=')) config.logLevel = arg.slice(12);
        break;
    }
  }

  if (!LOG_LEVELS.includes(config.logLevel)) config.logLevel = DEFAULTS.logLevel;
  if (config.port < 0 || config.port > 65535) config.port = DEFAULTS.port;
  if (config.tokenBytes < 16 || config.tokenBytes > 64) config.tokenBytes = DEFAULTS.tokenBytes;

  return { config, flags };
}

export const HELP_TEXT = `
NexusAI Bridge - local bridge for Roblox Studio

Usage: node src/index.js [options]

Options:
  -p, --port <n>            Port to listen on (default: 0 = auto-select free port)
      --host <addr>         Bind address (default: 127.0.0.1)
      --log-level <level>   debug | info | warn | error | silent   (default: info)
      --log-file <path>     Log file path (default: logs/bridge.log)
      --no-log-file         Disable file logging
      --json-logs           Emit newline-delimited JSON logs
      --no-dashboard        Disable the web dashboard
      --open                Open the dashboard in the default browser
      --session-file <path> Where to write the session descriptor
      --token-bytes <n>     Token entropy in bytes, 16-64 (default: 24)
      --command-timeout <ms> Max wait for a Studio command result (default: 30000)
      --print-config        Print resolved configuration and exit
  -h, --help                Show this help
  -v, --version             Show version

A fresh token is generated on every start. There is no static token.
`.trim();
