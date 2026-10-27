const { contextBridge, ipcRenderer, webUtils } = require('electron');

// The renderer only ever sees this small surface. No Node, no fs, no shell.
contextBridge.exposeInMainWorld('keepnotes', {
  getVersion: () => ipcRenderer.invoke('app:getVersion'),

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

  listEvents: () => ipcRenderer.invoke('calendar:list'),
  createEvent: (patch) => ipcRenderer.invoke('calendar:create', patch),
  updateEvent: (id, patch) => ipcRenderer.invoke('calendar:update', id, patch),
  deleteEvent: (id) => ipcRenderer.invoke('calendar:delete', id),

  listGallery: () => ipcRenderer.invoke('gallery:list'),
  setGalleryMeta: (id, patch) => ipcRenderer.invoke('gallery:setMeta', id, patch),
  renameGalleryItem: (id, title) => ipcRenderer.invoke('gallery:rename', id, title),
  deleteGalleryItem: (id) => ipcRenderer.invoke('gallery:delete', id),
  chooseGalleryFolder: () => ipcRenderer.invoke('gallery:chooseFolder'),
  openGalleryInDefaultApp: (id) => ipcRenderer.invoke('gallery:openInDefaultApp', id),
  pickAndImportGallery: () => ipcRenderer.invoke('gallery:pickAndImport'),
  importGalleryFromPaths: (paths) => ipcRenderer.invoke('gallery:importFromPaths', paths),

  popOutCluster: (id) => ipcRenderer.invoke('cluster:popOut', id),
  popInCluster: (id) => ipcRenderer.invoke('cluster:popIn', id),
  getPoppedClusters: () => ipcRenderer.invoke('cluster:getPopped'),
  onPoppedClustersChanged: (callback) => ipcRenderer.on('cluster:popped-changed', callback),

  onSettingsChanged: (callback) => ipcRenderer.on('settings:changed', callback),
  onDataChanged: (callback) => ipcRenderer.on('data:changed', callback),

  respondCloseAction: (action) => ipcRenderer.invoke('app:closeAction', action),
  onConfirmClose: (callback) => ipcRenderer.on('app:confirm-close', callback),
  onReminderOpen: (callback) => ipcRenderer.on('reminder:open-note', callback),
  onCalendarReminderOpen: (callback) => ipcRenderer.on('calendar:open-event', callback),

  onUpdateReady: (callback) => ipcRenderer.on('app:update-ready', callback),
  installUpdate: () => ipcRenderer.invoke('app:installUpdate'),

  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  toggleMaximizeWindow: () => ipcRenderer.invoke('window:toggleMaximize'),
  isWindowMaximized: () => ipcRenderer.invoke('window:isMaximized'),
  onWindowMaximizedChanged: (callback) => ipcRenderer.on('window:maximized-changed', callback),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  reportChromeHeight: (height) => ipcRenderer.invoke('window:reportChromeHeight', height)
});
