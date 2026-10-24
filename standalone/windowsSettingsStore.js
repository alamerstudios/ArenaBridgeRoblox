import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { normalizeBlenderConfig, DEFAULT_BLENDER_CONFIG } from '../src/core/blenderConfig.js';

function powershell(script, env = {}) {
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    windowsHide: true,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 15_000,
  });
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || 'PowerShell error').trim());
  return result.stdout.trim();
}

function encrypt(value) {
  return powershell(
    "Add-Type -AssemblyName System.Security; $b=[Text.Encoding]::UTF8.GetBytes($env:ASC_SECRET); $e=[Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Convert]::ToBase64String($e)",
    { ASC_SECRET: value },
  );
}

function decrypt(value) {
  return powershell(
    "Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String($env:ASC_SECRET); $d=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Text.Encoding]::UTF8.GetString($d)",
    { ASC_SECRET: value },
  );
}

function maskSecret(value) {
  if (!value) return null;
  if (value.length < 10) return '••••••••';
  return `${value.slice(0, 5)}••••••••${value.slice(-4)}`;
}

export class WindowsSettingsStore {
  constructor({ filePath, executablePath }) {
    this.filePath = filePath;
    this.executablePath = executablePath;
    this.encryptionAvailable = process.platform === 'win32';
    this.data = this.#read();
    this.apiKey = this.#decryptStoredKey();
  }

  #read() {
    try { return JSON.parse(fs.readFileSync(this.filePath, 'utf8')); } catch { return {}; }
  }

  #write() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(temp, this.filePath);
  }

  #decryptStoredKey() {
    if (!this.data.openCloudApiKey || !this.encryptionAvailable) return null;
    try { return decrypt(this.data.openCloudApiKey); } catch { return null; }
  }

  getApiKey() { return this.apiKey; }

  saveApiKey(value) {
    const key = String(value ?? '').trim();
    if (key.length < 12) throw new Error('Der Open-Cloud-API-Key ist zu kurz.');
    if (!this.encryptionAvailable) throw new Error('Windows DPAPI ist nicht verfügbar.');
    this.data.openCloudApiKey = encrypt(key);
    this.apiKey = key;
    this.#write();
    return this.publicState();
  }

  clearApiKey() {
    delete this.data.openCloudApiKey;
    this.apiKey = null;
    this.#write();
    return this.publicState();
  }

  setLaunchAtLogin(enabled) {
    const active = enabled === true;
    const registryPath = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
    if (process.platform === 'win32') {
      const args = active
        ? ['add', registryPath, '/v', 'ArenaStudioConnecter', '/t', 'REG_SZ', '/d', `"${this.executablePath}"`, '/f']
        : ['delete', registryPath, '/v', 'ArenaStudioConnecter', '/f'];
      const result = spawnSync('reg.exe', args, { windowsHide: true, encoding: 'utf8' });
      if (active && result.status !== 0) throw new Error('Windows-Autostart konnte nicht gesetzt werden.');
    }
    this.data.launchAtLogin = active;
    this.#write();
    return this.publicState();
  }

  getLaunchAtLogin() { return this.data.launchAtLogin === true; }

  getAutoUpdate() { return this.data.autoUpdate !== false; }

  setAutoUpdate(enabled) {
    this.data.autoUpdate = enabled === true;
    this.#write();
    return this.publicState();
  }

  getBlenderConfig() {
    return normalizeBlenderConfig(this.data.blender ?? {}, DEFAULT_BLENDER_CONFIG);
  }

  saveBlenderConfig(value) {
    this.data.blender = normalizeBlenderConfig(value, this.getBlenderConfig());
    this.#write();
    return this.publicState();
  }

  publicState() {
    const key = this.getApiKey();
    return {
      hasApiKey: Boolean(key),
      apiKeyMasked: maskSecret(key),
      encryptionAvailable: this.encryptionAvailable,
      launchAtLogin: this.getLaunchAtLogin(),
      autoUpdate: this.getAutoUpdate(),
      blender: this.getBlenderConfig(),
    };
  }
}
