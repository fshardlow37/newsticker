const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getHeadlines: () => ipcRenderer.invoke('get-headlines'),
  getVersion: () => ipcRenderer.invoke('get-version'),
  closeWindow: () => ipcRenderer.send('close-window'),
  openExternal: (url) => ipcRenderer.send('open-external', url),
  refreshNow: () => ipcRenderer.invoke('refresh-now'),
  onHeadlinesUpdated: (callback) => ipcRenderer.on('headlines-updated', (_, data) => callback(data)),
  onStatusUpdate: (callback) => ipcRenderer.on('status-update', (_, msg) => callback(msg)),
});
