/**
 * Tiny dependency-free logger with levels, colored console output,
 * an in-memory ring buffer (used by /logs + dashboard) and optional file sink.
 */

import fs from 'node:fs';
import path from 'node:path';
import { maskToken } from './token.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

const COLORS = {
  debug: '\u001b[90m',
  info: '\u001b[36m',
  warn: '\u001b[33m',
  error: '\u001b[31m',
  reset: '\u001b[0m',
  dim: '\u001b[2m',
};

export class Logger {
  /**
   * @param {{ level?: string, file?: string|null, color?: boolean, bufferSize?: number, json?: boolean }} [options]
   */
  constructor(options = {}) {
    this.level = LEVELS[options.level] ?? LEVELS.info;
    this.levelName = options.level ?? 'info';
    this.color = options.color ?? (process.stdout.isTTY === true && !process.env.NO_COLOR);
    this.json = options.json ?? false;
    this.bufferSize = options.bufferSize ?? 500;
    /** @type {Array<{ts:string, level:string, msg:string, meta?:object}>} */
    this.buffer = [];
    this.fileStream = null;
    this.secrets = new Set();

    if (options.file) this.attachFile(options.file);
  }

  /** Register a value that must never appear verbatim in logs (e.g. the token). */
  addSecret(value) {
    if (typeof value === 'string' && value.length >= 8) this.secrets.add(value);
  }

  attachFile(filePath) {
    try {
      const abs = path.resolve(filePath);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      this.fileStream = fs.createWriteStream(abs, { flags: 'a' });
      this.filePath = abs;
    } catch (err) {
      process.stderr.write(`[logger] could not open log file: ${err.message}\n`);
    }
  }

  setLevel(name) {
    if (LEVELS[name] !== undefined) {
      this.level = LEVELS[name];
      this.levelName = name;
    }
  }

  /** Replace any registered secret with a masked variant. */
  redact(text) {
    let out = text;
    for (const secret of this.secrets) {
      if (out.includes(secret)) out = out.split(secret).join(maskToken(secret));
    }
    return out;
  }

  #write(level, msg, meta) {
    if (LEVELS[level] < this.level) return;

    const ts = new Date().toISOString();
    const safeMsg = this.redact(String(msg));
    let safeMeta;
    if (meta !== undefined) {
      try {
        safeMeta = JSON.parse(this.redact(JSON.stringify(meta)));
      } catch {
        safeMeta = { meta: '[unserializable]' };
      }
    }

    const entry = { ts, level, msg: safeMsg, ...(safeMeta ? { meta: safeMeta } : {}) };

    this.buffer.push(entry);
    if (this.buffer.length > this.bufferSize) this.buffer.shift();

    const line = this.json
      ? JSON.stringify(entry)
      : `${ts} ${level.toUpperCase().padEnd(5)} ${safeMsg}${safeMeta ? ' ' + JSON.stringify(safeMeta) : ''}`;

    if (this.fileStream) this.fileStream.write(line + '\n');

    if (this.level === LEVELS.silent) return;
    const stream = LEVELS[level] >= LEVELS.error ? process.stderr : process.stdout;
    if (this.color && !this.json) {
      const time = `${COLORS.dim}${ts.slice(11, 23)}${COLORS.reset}`;
      const tag = `${COLORS[level]}${level.toUpperCase().padEnd(5)}${COLORS.reset}`;
      stream.write(`${time} ${tag} ${safeMsg}${safeMeta ? ` ${COLORS.dim}${JSON.stringify(safeMeta)}${COLORS.reset}` : ''}\n`);
    } else {
      stream.write(line + '\n');
    }
  }

  debug(msg, meta) { this.#write('debug', msg, meta); }
  info(msg, meta) { this.#write('info', msg, meta); }
  warn(msg, meta) { this.#write('warn', msg, meta); }
  error(msg, meta) { this.#write('error', msg, meta); }

  /** Raw stdout print that bypasses level filtering (used for the start banner). */
  raw(text) {
    process.stdout.write(text + '\n');
    if (this.fileStream) this.fileStream.write(this.redact(text) + '\n');
  }

  /** @param {number} [limit] */
  recent(limit = 100, level) {
    let items = this.buffer;
    if (level && LEVELS[level] !== undefined) {
      items = items.filter((e) => LEVELS[e.level] >= LEVELS[level]);
    }
    return items.slice(-limit);
  }

  close() {
    if (this.fileStream) this.fileStream.end();
  }
}

export const LOG_LEVELS = Object.keys(LEVELS);
