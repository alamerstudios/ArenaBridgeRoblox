/**
 * Session state for Arena Studio Connecter.
 * Holds the per-start token and live metadata for every Roblox Studio process.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { generateToken, generateId, safeCompare, maskToken } from './token.js';

const CLIENT_FIELDS = [
  'name',
  'version',
  'place',
  'placeId',
  'placeName',
  'gameId',
  'placeVersion',
  'studioVersion',
  'accountUserId',
  'accountName',
  'accountDisplayName',
  'isEdit',
  'isRunning',
  'editModeActive',
  'dataModelRole',
  'editClientId',
  'playtestActive',
  'playtestMode',
];

export class Session {
  /** @param {{ tokenBytes?: number, sessionFile?: string|null }} [options] */
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

    /** @type {Map<string, object>} */
    this.clients = new Map();
  }

  validate(candidate) {
    return safeCompare(this.token, candidate);
  }

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

  /** Register or refresh a connected Studio process without losing handshake metadata. */
  touchClient(id, info = {}) {
    if (!id) return;
    const existing = this.clients.get(id) ?? {
      name: 'Roblox Studio',
      version: 'unknown',
      place: null,
    };
    const updated = { ...existing };
    for (const field of CLIENT_FIELDS) {
      if (info[field] !== undefined && info[field] !== null) updated[field] = info[field];
    }
    updated.lastSeen = Date.now();
    this.clients.set(id, updated);
  }

  activeClients(windowMs = 60_000) {
    const now = Date.now();
    return [...this.clients.entries()]
      .filter(([, client]) => now - client.lastSeen <= windowMs)
      .map(([id, client]) => ({ ...client, id, lastSeenMs: now - client.lastSeen }))
      .sort((a, b) => a.lastSeenMs - b.lastSeenMs);
  }

  editableClients(windowMs = 60_000) {
    return this.activeClients(windowMs).filter((client) => !client.dataModelRole || client.dataModelRole === 'edit');
  }

  hasActiveClient(id, windowMs = 60_000) {
    return this.activeClients(windowMs).some((client) => client.id === id);
  }

  removeClient(id) {
    this.clients.delete(id);
  }

  removePlaytestClients(editClientId) {
    for (const [id, client] of this.clients) {
      if (client.dataModelRole === 'play-server' && client.editClientId === editClientId) this.clients.delete(id);
    }
  }

  uptimeSeconds() {
    return Math.round((Date.now() - this.startedAt.getTime()) / 1000);
  }

  toStatus({ includeToken = false } = {}) {
    return {
      service: 'arena-studio-connecter',
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
      clients: this.editableClients(),
    };
  }

  persist() {
    if (!this.sessionFile) return;
    try {
      const abs = path.resolve(this.sessionFile);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      const payload = {
        service: 'arena-studio-connecter',
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
      // Non-fatal: desktop discovery and the startup banner still work.
    }
  }

  cleanup() {
    if (!this.sessionFileAbs) return;
    try { fs.rmSync(this.sessionFileAbs, { force: true }); } catch { /* ignore */ }
  }
}
