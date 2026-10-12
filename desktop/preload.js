const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('burrowDesktop', {
  minimize: () => ipcRenderer.send('win', 'minimize'),
  maximize: () => ipcRenderer.send('win', 'maximize'),
  close: () => ipcRenderer.send('win', 'close'),
  onQuickAdd: (cb) => ipcRenderer.on('quick-add', () => cb()),
  raiseBrowser: () => ipcRenderer.send('raise-browser'),
  raise: () => ipcRenderer.send('raise-self'),
});
