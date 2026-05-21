const { contextBridge, ipcRenderer } = require('electron');

const allowedEvents = new Set([
  'status',
  'config',
  'events',
  'detailLog',
  'probeStatus',
  'progress',
  'metrics',
  'update-available',
  'update',
  'networkInfo',
]);

contextBridge.exposeInMainWorld('api', {
  start: () => ipcRenderer.invoke('start'),
  stop: () => ipcRenderer.invoke('stop'),
  copy: (text) => ipcRenderer.invoke('copy', text),
  getState: () => ipcRenderer.invoke('getState'),
  getEvents: () => ipcRenderer.invoke('getEvents'),
  getDetailLog: () => ipcRenderer.invoke('getDetailLog'),
  getNetworkInfo: () => ipcRenderer.invoke('getNetworkInfo'),
  checkForUpdates: () => ipcRenderer.invoke('checkForUpdates'),
  downloadUpdate: () => ipcRenderer.invoke('downloadUpdate'),
  installUpdate: () => ipcRenderer.invoke('installUpdate'),
  runSelfCheck: () => ipcRenderer.invoke('runSelfCheck'),
  buildDiagnostic: () => ipcRenderer.invoke('buildDiagnostic'),
  toggleShare: (enabled) => ipcRenderer.invoke('toggleShare', enabled),
  getEarnings: () => ipcRenderer.invoke('getEarnings'),
  openExternal: (url) => ipcRenderer.invoke('openExternal', url),
  on: (channel, callback) => {
    if (!allowedEvents.has(channel)) return undefined;
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
