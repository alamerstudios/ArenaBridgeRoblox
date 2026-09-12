/**
 * Session state: the per-start identity of the bridge.
 * Holds the dynamically generated token, tracks auth statistics and
 * persists a machine-readable descriptor so helper scripts (.bat/.ps1) and
 * the Roblox plugin can discover url + token without any hardcoding.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { generateToken, generateId, safeCompare, maskToken } from './token.js';

export class Session {
  /**
   * @param {{ tokenBytes?: number, sessionFile?: string|null }} [options]
   */
  constructor(options = {}) {
    this.id = generateId(8);
    this.token = generateToken({ bytes: options.tokenBytes });
    this.startedAt = new Date();
    this.tokenIssuedAt = new Date();
    this.rotations = 0;
    this.sessionFile = options.sessionFile ?? null;
    this.url = null;
    this.pid = process.pid;
    this.host = os.hostname();

    this.stats = {
      requests: 0,
      authOk: 0,
      authFailed: 0,
      commandsQueued: 0,
      commandsCompleted: 0,
      commandsFailed: 0,
    };

    /** @type {Map<string, {lastSeen:number, name:string, version:string, place:string|null}>} */
    this.clients = new Map();
  }

  /** Validate a presented token against the current session token. */
  validate(candidate) {
    return safeCompare(this.token, candidate);
  }

  /** Generate a brand new token, invalidating the previous one immediately. */
  rotate(tokenBytes) {
    const previous = this.token;
    this.token = generateToken({ bytes: tokenBytes });
    this.tokenIssuedAt = new Date();
    this.rotations += 1;
    this.persist();
    return { previous, current: this.token };
  }

  setUrl(url) {
    this.url = url;
    this.persist();
  }

  /** Register/refresh a connected client (Roblox Studio plugin, CLI, MCP client). */
  touchClient(id, info = {}) {
    if (!id) return;
    const existing = this.clients.get(id) ?? {};
    this.clients.set(id, {
      name: info.name ?? existing.name ?? 'unknown',
      version: info.version ?? existing.version ?? '0',
      place: info.place ?? existing.place ?? null,
      lastSeen: Date.now(),
    });
  }

  activeClients(windowMs = 60_000) {
    const now = Date.now();
    return [...this.clients.entries()]
      .filter(([, c]) => now - c.lastSeen <= windowMs)
      .map(([id, c]) => ({ id, name: c.name, version: c.version, place: c.place, lastSeenMs: now - c.lastSeen }));
  }

  uptimeSeconds() {
    return Math.round((Date.now() - this.startedAt.getTime()) / 1000);
  }

  /**
   * Public status payload. `includeToken` is only true for authenticated calls.
   */
  toStatus({ includeToken = false } = {}) {
    return {
      service: 'nexusai-bridge',
      status: 'running',
      sessionId: this.id,
      url: this.url,
      pid: this.pid,
      host: this.host,
      startedAt: this.startedAt.toISOString(),
      uptimeSeconds: this.uptimeSeconds(),
      tokenIssuedAt: this.tokenIssuedAt.toISOString(),
      tokenRotations: this.rotations,
      token: includeToken ? this.token : undefined,
      tokenMasked: maskToken(this.token),
      stats: { ...this.stats },
      clients: this.activeClients(),
    };
  }

  /**
   * Write the session descriptor to disk (gitignored) so that shell helpers,
   * the dashboard launcher and the Roblox plugin can pick up url + token.
   */
  persist() {
    if (!this.sessionFile) return;
    try {
      const abs = path.resolve(this.sessionFile);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      const payload = {
        service: 'nexusai-bridge',
        sessionId: this.id,
        url: this.url,
        token: this.token,
        pid: this.pid,
        startedAt: this.startedAt.toISOString(),
        tokenIssuedAt: this.tokenIssuedAt.toISOString(),
      };
      fs.writeFileSync(abs, JSON.stringify(payload, null, 2), { mode: 0o600 });
      this.sessionFileAbs = abs;
    } catch {
      /* non-fatal: the banner still prints url + token */
    }
  }

  cleanup() {
    if (!this.sessionFileAbs) return;
    try { fs.rmSync(this.sessionFileAbs, { force: true }); } catch { /* ignore */ }
  }
}
