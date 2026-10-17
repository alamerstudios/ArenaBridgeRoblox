import fs from 'node:fs';
import path from 'node:path';

function maskSecret(value) {
  if (!value) return null;
  if (value.length < 10) return '••••••••';
  return `${value.slice(0, 5)}••••••••${value.slice(-4)}`;
}

export class SettingsStore {
  constructor({ filePath, safeStorage }) {
    this.filePath = filePath;
    this.safeStorage = safeStorage;
    this.data = this.#read();
  }

  #read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  #write() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(temp, this.filePath);
  }

  getApiKey() {
    const encrypted = this.data.openCloudApiKey;
    if (!encrypted || !this.safeStorage?.isEncryptionAvailable?.()) return null;
    try {
      return this.safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
    } catch {
      return null;
    }
  }

  saveApiKey(value) {
    const key = String(value ?? '').trim();
    if (key.length < 12) throw new Error('Der Open-Cloud-API-Key ist zu kurz.');
    if (!this.safeStorage?.isEncryptionAvailable?.()) {
      throw new Error('Windows-Datenschutz (DPAPI) ist nicht verfügbar. Der Key wurde nicht gespeichert.');
    }
    this.data.openCloudApiKey = this.safeStorage.encryptString(key).toString('base64');
    this.#write();
    return this.publicState();
  }

  clearApiKey() {
    delete this.data.openCloudApiKey;
    this.#write();
    return this.publicState();
  }

  getLaunchAtLogin() {
    return this.data.launchAtLogin === true;
  }

  setLaunchAtLogin(enabled) {
    this.data.launchAtLogin = enabled === true;
    this.#write();
    return this.publicState();
  }

  publicState() {
    const apiKey = this.getApiKey();
    return {
      hasApiKey: Boolean(apiKey),
      apiKeyMasked: maskSecret(apiKey),
      encryptionAvailable: Boolean(this.safeStorage?.isEncryptionAvailable?.()),
      launchAtLogin: this.getLaunchAtLogin(),
    };
  }
}

export { maskSecret };
