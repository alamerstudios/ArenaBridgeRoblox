/**
 * Command queue.
 *
 * Roblox Studio plugins cannot be reached from outside (no inbound sockets),
 * so the plugin long-polls the bridge for work. Flow:
 *
 *   POST /command        -> caller enqueues a command, awaits the result
 *   GET  /studio/poll    -> Studio plugin picks up the next pending command
 *   POST /studio/result  -> Studio plugin returns the result, caller unblocks
 */

import { EventEmitter } from 'node:events';
import { generateId } from './token.js';

/** @typedef {'pending'|'dispatched'|'completed'|'failed'|'timeout'} CommandState */

export class CommandQueue extends EventEmitter {
  /**
   * @param {{ timeoutMs?: number, historySize?: number, logger?: import('./logger.js').Logger }} [options]
   */
  constructor(options = {}) {
    super();
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.historySize = options.historySize ?? 100;
    this.logger = options.logger ?? null;

    /** @type {Array<object>} */
    this.pending = [];
    /** @type {Map<string, object>} */
    this.inFlight = new Map();
    /** @type {Array<object>} */
    this.history = [];
  }

  /**
   * Enqueue a command and return a promise resolving with the Studio result.
   * @param {{ action: string, params?: object, source?: string, timeoutMs?: number }} input
   */
  enqueue(input) {
    const command = {
      id: generateId(6),
      action: input.action,
      params: input.params ?? {},
      source: input.source ?? 'api',
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
        command.state = 'timeout';
        command.completedAt = Date.now();
        command.error = `No response from Roblox Studio within ${timeoutMs}ms. Is the NexusAI plugin running?`;
        this.#finish(command);
        resolve(this.describe(command));
      }, timeoutMs);
      // Do not hold the event loop open just for a pending command.
      if (typeof command.timer.unref === 'function') command.timer.unref();
      command.resolve = resolve;
    });

    this.pending.push(command);
    this.logger?.info(`command queued: ${command.action}`, { id: command.id, source: command.source });
    this.emit('queued', this.describe(command));

    return { command, promise };
  }

  /** Studio picks up the next pending command (or null when idle). */
  dequeue() {
    const command = this.pending.shift();
    if (!command) return null;
    command.state = 'dispatched';
    command.dispatchedAt = Date.now();
    this.inFlight.set(command.id, command);
    this.emit('dispatched', this.describe(command));
    return command;
  }

  /** Studio reports a result for a previously dispatched command. */
  complete(id, { ok = true, result = null, error = null } = {}) {
    const command = this.inFlight.get(id);
    if (!command) return null;
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

  /** Fail everything still outstanding (used on shutdown). */
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
