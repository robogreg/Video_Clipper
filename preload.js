const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('clipper', {
  openDialog: () => ipcRenderer.invoke('open-dialog'),
  openDropped: (file) => ipcRenderer.invoke('open-path', webUtils.getPathForFile(file)),
  exportClip: (opts) => ipcRenderer.invoke('export', opts),
  cancelExport: () => ipcRenderer.invoke('cancel-export'),
  showInFolder: (file) => ipcRenderer.invoke('show-in-folder', file),
  onProgress: (fn) => ipcRenderer.on('export-progress', (_e, p) => fn(p)),
  onOpenFile: (fn) => ipcRenderer.on('open-file', (_e, data) => fn(data)),
});
