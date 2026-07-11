const { contextBridge, ipcRenderer, webUtils } = require('electron');

// The renderer only ever sees this small surface. No Node, no fs, no shell.
contextBridge.exposeInMainWorld('keepnotes', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  chooseFolder: () => ipcRenderer.invoke('settings:chooseFolder'),
  openFolder: () => ipcRenderer.invoke('settings:openFolder'),

  listNotes: () => ipcRenderer.invoke('notes:list'),
  saveNote: (file, content) => ipcRenderer.invoke('notes:save', file, content),
  createNote: (title) => ipcRenderer.invoke('notes:create', title),
  deleteNote: (file) => ipcRenderer.invoke('notes:delete', file),
  renameNote: (file, title) => ipcRenderer.invoke('notes:rename', file, title),
  setNoteMeta: (file, patch) => ipcRenderer.invoke('notes:setMeta', file, patch),

  pickImage: () => ipcRenderer.invoke('images:pickAndCopy'),
  saveImageDataUrl: (dataUrl) => ipcRenderer.invoke('images:saveDataUrl', dataUrl),
  saveImageFromPath: (absPath) => ipcRenderer.invoke('images:saveFromPath', absPath),
  getPathForFile: (file) => webUtils.getPathForFile(file),

  respondCloseAction: (action) => ipcRenderer.invoke('app:closeAction', action),
  onConfirmClose: (callback) => ipcRenderer.on('app:confirm-close', callback),

  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  toggleMaximizeWindow: () => ipcRenderer.invoke('window:toggleMaximize'),
  closeWindow: () => ipcRenderer.invoke('window:close')
});
