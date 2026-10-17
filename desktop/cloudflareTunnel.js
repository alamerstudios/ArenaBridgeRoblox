import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/gi;

export class CloudflareTunnel extends EventEmitter {
  constructor({ executable, logger = console } = {}) {
    super();
    this.executable = executable;
    this.logger = logger;
    this.process = null;
    this.stopping = false;
    this.readyTimer = null;
    this.state = {
      status: 'idle',
      url: null,
      message: 'Tunnel wurde noch nicht gestartet.',
      startedAt: null,
    };
    this.output = '';
  }

  snapshot() {
    return { ...this.state };
  }

  #set(patch) {
    this.state = { ...this.state, ...patch };
    this.emit('state', this.snapshot());
  }

  async start(localUrl) {
    await this.stop();
    this.stopping = false;
    this.output = '';

    if (!this.executable || !fs.existsSync(this.executable)) {
      this.#set({
        status: 'error',
        url: null,
        message: 'Cloudflared wurde in dieser App-Installation nicht gefunden.',
      });
      return this.snapshot();
    }

    this.#set({ status: 'starting', url: null, message: 'Sicherer Cloudflare-Tunnel wird aufgebaut …', startedAt: Date.now() });
    const args = ['tunnel', '--url', localUrl, '--no-autoupdate', '--loglevel', 'info'];
    const child = spawn(this.executable, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NO_AUTOUPDATE: 'true' },
    });
    this.process = child;

    const consume = (chunk) => {
      this.output = (this.output + chunk.toString('utf8')).slice(-32_000);
      const matches = this.output.match(URL_PATTERN);
      if (matches?.length && this.state.status !== 'online') {
        const url = matches[matches.length - 1].replace(/\/+$/, '');
        clearTimeout(this.readyTimer);
        this.#set({ status: 'online', url, message: 'Cloudflare-Tunnel ist online.' });
      }
    };
    child.stdout.on('data', consume);
    child.stderr.on('data', consume);

    child.once('error', (error) => {
      clearTimeout(this.readyTimer);
      this.process = null;
      if (!this.stopping) this.#set({ status: 'error', url: null, message: `Tunnel konnte nicht starten: ${error.message}` });
    });

    child.once('exit', (code) => {
      clearTimeout(this.readyTimer);
      if (this.process === child) this.process = null;
      if (this.stopping) {
        this.#set({ status: 'stopped', url: null, message: 'Tunnel wurde beendet.' });
        return;
      }
      const finalLine = this.output.trim().split(/\r?\n/).pop()?.replace(/^.*?ERR\s+/i, '').slice(0, 240);
      this.#set({
        status: 'error',
        url: null,
        message: finalLine || `Cloudflared wurde unerwartet beendet (Code ${code ?? 'unbekannt'}).`,
      });
    });

    this.readyTimer = setTimeout(() => {
      if (this.state.status === 'starting') {
        this.#set({ status: 'error', url: null, message: 'Cloudflare-Tunnel antwortet nicht. Prüfe Firewall und Internetverbindung.' });
      }
    }, 30_000);
    this.readyTimer.unref?.();

    return this.snapshot();
  }

  stop() {
    clearTimeout(this.readyTimer);
    this.readyTimer = null;
    const child = this.process;
    if (!child) return Promise.resolve();
    this.stopping = true;
    this.process = null;

    return new Promise((resolve) => {
      const done = () => resolve();
      child.once('exit', done);
      try { child.kill(); } catch { resolve(); return; }
      const forceTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* already stopped */ }
        resolve();
      }, 2_000);
      forceTimer.unref?.();
    });
  }
}
