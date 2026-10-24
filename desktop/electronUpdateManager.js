import { autoUpdater } from 'electron-updater';

/** NSIS updates use electron-builder's latest.yml, SHA-512 metadata and blockmaps. */
export class ElectronUpdateManager {
  constructor({ currentVersion, supported = true, onState = () => {} }) {
    this.currentVersion = currentVersion;
    this.supported = supported;
    this.onState = onState;
    this.state = {
      status: supported ? 'idle' : 'unavailable', supported, currentVersion,
      latestVersion: null, message: supported ? 'Noch nicht nach Updates gesucht.' : 'Updates sind nur in der paketierten Windows-App verfügbar.',
      checkedAt: null, progress: 0, releaseUrl: 'https://github.com/alamerstudios/ArenaBridgeRoblox/releases',
    };
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.allowPrerelease = false;
    autoUpdater.on('checking-for-update', () => this.setState({ status: 'checking', message: 'Suche nach einer neuen Version …' }));
    autoUpdater.on('update-available', (info) => this.setState({
      status: 'downloading', latestVersion: info.version, checkedAt: Date.now(),
      message: `Lade Version ${info.version} herunter …`, progress: 0,
    }));
    autoUpdater.on('update-not-available', (info) => this.setState({
      status: 'up-to-date', latestVersion: info?.version ?? this.currentVersion, checkedAt: Date.now(),
      message: `Version ${this.currentVersion} ist aktuell.`, progress: 0,
    }));
    autoUpdater.on('download-progress', (progress) => this.setState({
      status: 'downloading', progress: Math.round(progress.percent ?? 0),
      message: `Update wird heruntergeladen … ${Math.round(progress.percent ?? 0)} %`,
    }));
    autoUpdater.on('update-downloaded', (info) => this.setState({
      status: 'ready', latestVersion: info.version, progress: 100,
      message: `Version ${info.version} ist bereit. Zum Installieren nur noch neu starten.`,
    }));
    autoUpdater.on('error', (error) => this.setState({ status: 'error', message: `Update fehlgeschlagen: ${error.message}` }));
  }

  snapshot() { return { ...this.state }; }
  setState(patch) { this.state = { ...this.state, ...patch }; this.onState(this.snapshot()); }

  async checkForUpdates() {
    if (!this.supported) throw new Error('Updates sind in diesem Entwicklungsmodus nicht verfügbar.');
    if (['checking', 'downloading', 'installing'].includes(this.state.status)) return this.snapshot();
    if (this.state.status === 'ready') return this.snapshot();
    try {
      const result = await autoUpdater.checkForUpdates();
      if (result?.downloadPromise) await result.downloadPromise;
      return this.snapshot();
    } catch (error) {
      this.setState({ status: 'error', message: `Update-Suche fehlgeschlagen: ${error.message}` });
      throw error;
    }
  }

  async installUpdate() {
    if (this.state.status !== 'ready') throw new Error('Es ist noch kein heruntergeladenes Update bereit.');
    this.setState({ status: 'installing', message: 'Update wird installiert. Die App startet anschließend neu.' });
    autoUpdater.quitAndInstall(true, true);
    return { ok: true, restarting: true };
  }

  startAutomatic(isEnabled) {
    this.stopAutomatic();
    const run = () => {
      if (this.supported && isEnabled() && ['idle', 'up-to-date', 'error'].includes(this.state.status)) {
        void this.checkForUpdates().catch(() => {});
      }
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
