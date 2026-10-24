import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

const MAX_UPDATE_BYTES = 250 * 1024 * 1024;
const DEFAULT_REPOSITORY = 'alamerstudios/ArenaBridgeRoblox';

export function compareVersions(left, right) {
  const parse = (value) => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(value ?? '').trim());
    if (!match) return null;
    return { numbers: match.slice(1, 4).map(Number), prerelease: match[4] ?? null };
  };
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) throw new Error(`Ungültige Versionsnummer: ${left} / ${right}`);
  for (let index = 0; index < 3; index += 1) {
    if (a.numbers[index] !== b.numbers[index]) return a.numbers[index] > b.numbers[index] ? 1 : -1;
  }
  if (a.prerelease === b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  return a.prerelease.localeCompare(b.prerelease, undefined, { numeric: true });
}

function updateScript() {
  return `$ErrorActionPreference = 'Stop'
$source = $env:ASC_UPDATE_SOURCE
$target = $env:ASC_UPDATE_TARGET
$backup = $env:ASC_UPDATE_BACKUP
$arenaPid = [int]$env:ASC_UPDATE_PID
function Show-UpdateError([string]$message) {
  try { Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show($message, 'Arena Studio Connecter Update') | Out-Null } catch {}
}
try {
  Wait-Process -Id $arenaPid -Timeout 120 -ErrorAction SilentlyContinue
  Copy-Item -LiteralPath $target -Destination $backup -Force
  $installed = $false
  for ($attempt = 0; $attempt -lt 40 -and -not $installed; $attempt++) {
    try {
      Copy-Item -LiteralPath $source -Destination ($target + '.new') -Force
      Move-Item -LiteralPath ($target + '.new') -Destination $target -Force
      $installed = $true
    } catch { Start-Sleep -Milliseconds 500 }
  }
  if (-not $installed) { throw 'Die neue EXE konnte nicht über die laufende Datei kopiert werden.' }
  Start-Process -FilePath $target
  Remove-Item -LiteralPath $source -Force -ErrorAction SilentlyContinue
  # Das Backup bleibt bis zum naechsten Update als Rollback-Sicherung erhalten.
} catch {
  $reason = $_.Exception.Message
  try {
    if (Test-Path -LiteralPath $backup) { Copy-Item -LiteralPath $backup -Destination $target -Force }
    Start-Process -FilePath $target
  } catch {}
  Show-UpdateError("Das Update wurde nicht installiert. Die vorherige Version wird wieder geöffnet." + [Environment]::NewLine + [Environment]::NewLine + $reason)
}`;
}

function verifyPortableExecutable(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const header = Buffer.alloc(4096);
    const read = fs.readSync(fd, header, 0, header.length, 0);
    if (read < 128 || header.subarray(0, 2).toString('ascii') !== 'MZ') throw new Error('Das Update ist keine Windows-EXE.');
    const peOffset = header.readUInt32LE(0x3c);
    if (peOffset + 6 > read || header.subarray(peOffset, peOffset + 4).toString('hex') !== '50450000') {
      throw new Error('Das Update enthält keinen gültigen PE-Header.');
    }
  } finally {
    fs.closeSync(fd);
  }
}

/** SHA-256 verified self-updater for the direct, portable Windows EXE. */
export class UpdateManager {
  constructor({
    currentVersion,
    executablePath,
    dataDirectory,
    artifactPrefix = 'Arena-Studio-Connecter-Portable',
    repository = DEFAULT_REPOSITORY,
    fetchImpl = globalThis.fetch,
    spawnImpl = spawn,
    onState = () => {},
  }) {
    this.currentVersion = currentVersion;
    this.executablePath = executablePath;
    this.dataDirectory = dataDirectory;
    this.artifactPrefix = artifactPrefix;
    this.repository = repository;
    this.fetch = fetchImpl;
    this.spawn = spawnImpl;
    this.onState = onState;
    this.release = null;
    this.stagedPath = null;
    this.autoTimer = null;
    this.state = {
      status: 'idle', supported: true, currentVersion, latestVersion: null,
      message: 'Noch nicht nach Updates gesucht.', checkedAt: null,
      progress: 0, releaseUrl: null,
    };
  }

  snapshot() { return { ...this.state }; }

  setState(patch) {
    this.state = { ...this.state, ...patch };
    this.onState(this.snapshot());
  }

  async fetchResponse(url, accept = 'application/octet-stream') {
    if (typeof this.fetch !== 'function') throw new Error('HTTP Fetch ist nicht verfügbar.');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    try {
      return await this.fetch(url, {
        headers: {
          Accept: accept,
          'User-Agent': `Arena-Studio-Connecter/${this.currentVersion}`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: controller.signal,
      });
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('Der Update-Server hat nicht rechtzeitig geantwortet.');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  artifactName(version) {
    return `${this.artifactPrefix}-${version}-x64.exe`;
  }

  async resolveDownload(release, version) {
    const name = this.artifactName(version);
    const assets = Array.isArray(release.assets) ? release.assets : [];
    const executable = assets.find((asset) => asset.name === name);
    const checksum = assets.find((asset) => asset.name === `${name}.sha256.txt`);
    const tag = String(release.tag_name);
    const rawBase = `https://raw.githubusercontent.com/${this.repository}/${encodeURIComponent(tag)}/downloads`;
    return {
      name,
      url: executable?.browser_download_url ?? `${rawBase}/${name}`,
      checksumUrl: checksum?.browser_download_url ?? `${rawBase}/${name}.sha256.txt`,
      digest: String(executable?.digest ?? '').replace(/^sha256:/i, '') || null,
    };
  }

  async checkForUpdates() {
    if (['checking', 'downloading', 'installing'].includes(this.state.status)) return this.snapshot();
    if (this.state.status === 'ready' && this.stagedPath && fs.existsSync(this.stagedPath)) return this.snapshot();
    this.setState({ status: 'checking', message: 'Suche auf GitHub nach einer neuen Version …', progress: 0 });
    try {
      const response = await this.fetchResponse(`https://api.github.com/repos/${this.repository}/releases/latest`, 'application/vnd.github+json');
      if (!response.ok) throw new Error(`GitHub-Releaseabfrage fehlgeschlagen (HTTP ${response.status}).`);
      const release = await response.json();
      const version = String(release.tag_name ?? '').replace(/^v/, '');
      if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('Das neueste Release hat keine gültige Versionsnummer.');
      this.release = release;
      this.setState({ latestVersion: version, checkedAt: Date.now(), releaseUrl: release.html_url ?? null });
      if (compareVersions(version, this.currentVersion) <= 0) {
        this.setState({ status: 'up-to-date', message: `Version ${this.currentVersion} ist aktuell.`, progress: 0 });
        return this.snapshot();
      }
      this.setState({ status: 'available', message: `Version ${version} wurde gefunden. Download wird vorbereitet …` });
      return await this.downloadUpdate();
    } catch (error) {
      this.setState({ status: 'error', message: `Update-Suche fehlgeschlagen: ${error.message}`, progress: 0 });
      throw error;
    }
  }

  async expectedChecksum(download) {
    if (download.digest && /^[a-f0-9]{64}$/i.test(download.digest)) return download.digest.toLowerCase();
    const response = await this.fetchResponse(download.checksumUrl, 'text/plain');
    if (!response.ok) throw new Error('Die SHA-256-Prüfsumme fehlt im Release. Das Update wird aus Sicherheitsgründen nicht installiert.');
    const text = await response.text();
    const match = /\b([a-f0-9]{64})\b/i.exec(text);
    if (!match) throw new Error('Die SHA-256-Prüfsumme konnte nicht gelesen werden.');
    return match[1].toLowerCase();
  }

  async downloadUpdate() {
    if (!this.release) return this.checkForUpdates();
    if (['downloading', 'installing'].includes(this.state.status)) return this.snapshot();
    if (this.state.status === 'ready' && this.stagedPath && fs.existsSync(this.stagedPath)) return this.snapshot();
    const version = String(this.release.tag_name).replace(/^v/, '');
    const download = await this.resolveDownload(this.release, version);
    const expected = await this.expectedChecksum(download);
    this.setState({ status: 'downloading', message: `Lade Version ${version} herunter …`, progress: 0 });
    fs.mkdirSync(this.dataDirectory, { recursive: true });
    const destination = path.join(this.dataDirectory, download.name);
    const temporary = `${destination}.${process.pid}.download`;
    const hash = createHash('sha256');
    let size = 0;
    try {
      const response = await this.fetchResponse(download.url);
      if (!response.ok) throw new Error(`Update-Download fehlgeschlagen (HTTP ${response.status}).`);
      const total = Number(response.headers.get('content-length')) || 0;
      if (total > MAX_UPDATE_BYTES) throw new Error('Das Update ist unerwartet groß und wird nicht geladen.');
      const output = fs.createWriteStream(temporary, { mode: 0o700 });
      for await (const chunk of response.body) {
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > MAX_UPDATE_BYTES) throw new Error('Das Update überschreitet das Größenlimit.');
        hash.update(bytes);
        if (!output.write(bytes)) await new Promise((resolve) => output.once('drain', resolve));
        if (total) {
          const progress = Math.min(99, Math.round(size / total * 100));
          if (progress !== this.state.progress) this.setState({ progress });
        }
      }
      await new Promise((resolve, reject) => {
        output.once('error', reject);
        output.end(resolve);
      });
      const actual = hash.digest('hex');
      if (actual !== expected) throw new Error('SHA-256 stimmt nicht überein. Die Datei wurde verworfen.');
      verifyPortableExecutable(temporary);
      fs.rmSync(destination, { force: true });
      fs.renameSync(temporary, destination);
      this.stagedPath = destination;
      this.setState({ status: 'ready', progress: 100, message: `Version ${version} ist bereit. Zum Installieren nur noch neu starten.` });
      return this.snapshot();
    } catch (error) {
      fs.rmSync(temporary, { force: true });
      this.setState({ status: 'error', message: `Update-Download fehlgeschlagen: ${error.message}`, progress: 0 });
      throw error;
    }
  }

  async installUpdate() {
    if (this.state.status !== 'ready' || !this.stagedPath || !fs.existsSync(this.stagedPath)) {
      throw new Error('Es ist noch kein heruntergeladenes Update bereit.');
    }
    if (process.platform !== 'win32') throw new Error('Der portable Selbstaustausch ist nur unter Windows verfügbar.');
    const script = updateScript();
    const environment = {
      ...process.env,
      ASC_UPDATE_SOURCE: this.stagedPath,
      ASC_UPDATE_TARGET: this.executablePath,
      ASC_UPDATE_BACKUP: path.join(this.dataDirectory, 'previous-version.exe.backup'),
      ASC_UPDATE_PID: String(process.pid),
    };
    const child = this.spawn('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
    ], { detached: true, windowsHide: true, stdio: 'ignore', env: environment });
    child.unref();
    this.setState({ status: 'installing', message: 'Update wird installiert. Die App schließt und startet anschließend neu.' });
    return { ok: true, restarting: true };
  }

  startAutomatic(isEnabled) {
    this.stopAutomatic();
    const run = () => {
      if (!isEnabled()) return;
      if (!['idle', 'up-to-date', 'error'].includes(this.state.status)) return;
      void this.checkForUpdates().catch(() => {});
    };
    this.autoTimer = setTimeout(run, 4_000);
    this.autoInterval = setInterval(run, 6 * 60 * 60 * 1000);
    this.autoTimer.unref?.();
    this.autoInterval.unref?.();
  }

  stopAutomatic() {
    clearTimeout(this.autoTimer);
    clearInterval(this.autoInterval);
  }
}

export { verifyPortableExecutable, updateScript, MAX_UPDATE_BYTES };
