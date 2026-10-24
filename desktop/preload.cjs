const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('arenaDesktop', {
  getState: () => ipcRenderer.invoke('app:get-state'),
  onState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('app:state', listener);
    return () => ipcRenderer.removeListener('app:state', listener);
  },
  copyPrompt: (clientId) => ipcRenderer.invoke('place:copy-prompt', clientId),
  openArena: () => ipcRenderer.invoke('app:open-arena'),
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
  checkForUpdates: () => ipcRenderer.invoke('updates:check'),
  installUpdate: () => ipcRenderer.invoke('updates:install'),
  retryTunnel: () => ipcRenderer.invoke('tunnel:retry'),
  reinstallPlugin: () => ipcRenderer.invoke('plugin:reinstall'),
  showPluginFile: () => ipcRenderer.invoke('plugin:show-file'),
  saveApiKey: (value) => ipcRenderer.invoke('settings:save-api-key', value),
  clearApiKey: () => ipcRenderer.invoke('settings:clear-api-key'),
  setLaunchAtLogin: (enabled) => ipcRenderer.invoke('settings:set-launch-at-login', enabled),
  setAutoUpdate: (enabled) => ipcRenderer.invoke('settings:set-auto-update', enabled),
  saveBlenderSettings: (value) => ipcRenderer.invoke('settings:save-blender', value),
  minimize: () => ipcRenderer.send('window:minimize'),
  toggleMaximize: () => ipcRenderer.send('window:toggle-maximize'),
  close: () => ipcRenderer.send('window:close'),
});
