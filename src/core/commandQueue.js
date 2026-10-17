/**
 * Command queue shared by Arena Agent and the polling Roblox Studio plugins.
 * Commands can target one exact Studio client so multiple open Places never
 * consume each other's work.
 */

import { EventEmitter } from 'node:events';
import { generateId } from './token.js';

/** @typedef {'pending'|'dispatched'|'completed'|'failed'|'timeout'} CommandState */

export class CommandQueue extends EventEmitter {
  constructor(options = {}) {
    super();
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.historySize = options.historySize ?? 100;
    this.logger = options.logger ?? null;
    this.pending = [];
    this.inFlight = new Map();
    this.history = [];
  }

  /**
   * @param {{ action: string, params?: object, source?: string, timeoutMs?: number, targetClientId?: string|null }} input
   */
  enqueue(input) {
    const command = {
      id: generateId(6),
      action: input.action,
      params: input.params ?? {},
      source: input.source ?? 'api',
      targetClientId: input.targetClientId || null,
      assignedClientId: null,
      state: /** @type {CommandState} */ ('pending'),
      createdAt: Date.now(),
      dispatchedAt: null,
      completedAt: null,
      result: null,
      error: null,
    };

    const timeoutMs = input.timeoutMs ?? this.timeoutMs;
    const promise = new Promise((resolve) => {
      command.timer = setTimeout(() => {
        if (command.state === 'completed' || command.state === 'failed') return;
        const previousState = command.state;
        command.state = 'timeout';
        command.completedAt = Date.now();
        command.error = `No response from the selected Roblox Studio client within ${timeoutMs}ms. Is Arena Studio Connecter running?`;
        if (previousState === 'dispatched') this.inFlight.delete(command.id);
        else this.pending = this.pending.filter((candidate) => candidate !== command);
        this.#finish(command);
      }, timeoutMs);
      if (typeof command.timer.unref === 'function') command.timer.unref();
      command.resolve = resolve;
    });

    this.pending.push(command);
    this.logger?.info(`command queued: ${command.action}`, {
      id: command.id,
      source: command.source,
      targetClientId: command.targetClientId,
    });
    this.emit('queued', this.describe(command));
    return { command, promise };
  }

  /**
   * Return the next command this polling client is allowed to execute.
   * Untargeted commands may be consumed by any client for backwards
   * compatibility; targeted commands only match the selected Place.
   */
  dequeue(clientId = null) {
    const index = this.pending.findIndex((command) => (
      command.targetClientId === null || (clientId && command.targetClientId === clientId)
    ));
    if (index < 0) return null;

    const [command] = this.pending.splice(index, 1);
    command.state = 'dispatched';
    command.dispatchedAt = Date.now();
    command.assignedClientId = clientId || null;
    this.inFlight.set(command.id, command);
    this.emit('dispatched', this.describe(command));
    return command;
  }

  /** Studio reports a result for a previously dispatched command. */
  complete(id, { ok = true, result = null, error = null } = {}, clientId = null) {
    const command = this.inFlight.get(id);
    if (!command) return null;
    if (command.assignedClientId && command.assignedClientId !== clientId) return null;

    this.inFlight.delete(id);
    command.state = ok ? 'completed' : 'failed';
    command.result = result;
    command.error = ok ? null : (error ?? 'unknown error');
    command.completedAt = Date.now();
    this.#finish(command);
    return this.describe(command);
  }

  #finish(command) {
    if (command.timer) clearTimeout(command.timer);
    const described = this.describe(command);
    this.history.push(described);
    if (this.history.length > this.historySize) this.history.shift();
    this.emit('completed', described);
    if (command.resolve) {
      const resolve = command.resolve;
      command.resolve = null;
      resolve(described);
    }
  }

  describe(command) {
    return {
      id: command.id,
      action: command.action,
      params: command.params,
      source: command.source,
      targetClientId: command.targetClientId,
      assignedClientId: command.assignedClientId,
      state: command.state,
      createdAt: new Date(command.createdAt).toISOString(),
      durationMs: command.completedAt ? command.completedAt - command.createdAt : null,
      ok: command.state === 'completed',
      result: command.result,
      error: command.error,
    };
  }

  snapshot() {
    return {
      pending: this.pending.length,
      inFlight: this.inFlight.size,
      history: this.history.slice(-25).reverse(),
    };
  }

  drain(reason = 'bridge shutting down') {
    for (const command of [...this.pending, ...this.inFlight.values()]) {
      if (command.state === 'completed' || command.state === 'failed') continue;
      command.state = 'failed';
      command.error = reason;
      command.completedAt = Date.now();
      this.#finish(command);
    }
    this.pending = [];
    this.inFlight.clear();
  }
}
