// KeepNotes - main process
// Security posture:
//  - contextIsolation: true, sandbox: true, nodeIntegration: false
//  - Renderer never touches the filesystem directly; all IO goes through
//    validated IPC handlers below.
//  - File access is confined to the user-chosen notes folder, .txt only,
//    plus a hidden .attachments subfolder for images (also validated).
//  - No remote content is ever loaded; navigation and window.open are blocked.
//  - The keepnotes-asset:// protocol only ever serves files that live
//    inside <notesDir>/.attachments and match a strict filename pattern.

const {
  app, BrowserWindow, ipcMain, dialog, shell,
  Tray, Menu, nativeImage, protocol, net, screen
} = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');
const { pathToFileURL } = require('url');

let win = null;
let tray = null;
let isQuitting = false;
let widgetActive = false;
let previousBounds = null;

// keepnotes-asset:// must be registered as privileged before app is ready.
protocol.registerSchemesAsPrivileged([
  { scheme: 'keepnotes-asset', privileges: { secure: true, supportFetchAPI: true, corsEnabled: false } }
]);

// ---------- settings ----------
const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');

const THEMES = new Set([
  'light-paper', 'light-mist', 'light-sage',
  'dark-slate', 'dark-midnight', 'dark-coffee'
]);
const THEME_BG = {
  'light-paper': '#f6f3ec',
  'light-mist': '#eef1f5',
  'light-sage': '#eef4ec',
  'dark-slate': '#1e1f22',
  'dark-midnight': '#0d1117',
  'dark-coffee': '#161211'
};
const CLOSE_ACTIONS = new Set(['ask', 'quit', 'tray']);

const defaultSettings = () => ({
  notesDir: path.join(app.getPath('documents'), 'KeepNotes'),
  alwaysOnTop: false,
  launchAtStartup: true,
  theme: 'light-paper',
  widgetMode: false,
  minimizeToTray: true,
  closeAction: 'ask',
  borderless: false
});

function migrateTheme(theme) {
  if (theme === 'light') return 'light-paper';
  if (theme === 'dark') return 'dark-slate';
  return theme;
}

function loadSettings() {
  try {
    const raw = fs.readFileSync(settingsPath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.theme === 'string') parsed.theme = migrateTheme(parsed.theme);
    return { ...defaultSettings(), ...sanitizeSettings(parsed) };
  } catch {
    return defaultSettings();
  }
}

function sanitizeSettings(s) {
  const out = {};
  if (typeof s.notesDir === 'string' && s.notesDir.length < 1024) out.notesDir = s.notesDir;
  if (typeof s.alwaysOnTop === 'boolean') out.alwaysOnTop = s.alwaysOnTop;
  if (typeof s.launchAtStartup === 'boolean') out.launchAtStartup = s.launchAtStartup;
  if (typeof s.theme === 'string' && THEMES.has(s.theme)) out.theme = s.theme;
  if (typeof s.widgetMode === 'boolean') out.widgetMode = s.widgetMode;
  if (typeof s.minimizeToTray === 'boolean') out.minimizeToTray = s.minimizeToTray;
  if (typeof s.closeAction === 'string' && CLOSE_ACTIONS.has(s.closeAction)) out.closeAction = s.closeAction;
  if (typeof s.borderless === 'boolean') out.borderless = s.borderless;
  return out;
}

function saveSettings(s) {
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(s, null, 2), 'utf8');
}

let settings = null;

function applySettings() {
  if (win && !win.isDestroyed()) {
    win.setAlwaysOnTop(!!settings.alwaysOnTop, 'normal');
    applyWidgetMode();
  }
  // Startup entry only makes sense in a packaged build; in dev it would
  // register the electron binary instead of the app.
  if (app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: !!settings.launchAtStartup });
  }
  fs.mkdirSync(settings.notesDir, { recursive: true });
}

function applyWidgetMode() {
  if (settings.widgetMode) {
    if (!widgetActive) {
      previousBounds = win.getBounds();
      widgetActive = true;
    }
    win.setSkipTaskbar(true);
    const { workArea } = screen.getPrimaryDisplay();
    const width = 320;
    const height = 420;
    win.setBounds({
      width,
      height,
      x: workArea.x + workArea.width - width - 16,
      y: workArea.y + workArea.height - height - 16
    });
  } else if (widgetActive) {
    win.setSkipTaskbar(false);
    if (previousBounds) win.setBounds(previousBounds);
    widgetActive = false;
  }
}

// ---------- path safety ----------
const NAME_RE = /^[\w][\w \-().\[\]']{0,120}\.txt$/;
const IMAGE_NAME_RE = /^[\w-]{1,90}\.(png|jpe?g|gif|webp)$/i;
const IMAGE_EXT_ALLOW = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const DATA_URL_RE = /^data:image\/(png|jpeg|gif|webp);base64,([A-Za-z0-9+/=]+)$/;

function safeNotePath(fileName) {
  if (typeof fileName !== 'string' || !NAME_RE.test(fileName)) {
    throw new Error('Invalid file name');
  }
  const full = path.resolve(settings.notesDir, fileName);
  const root = path.resolve(settings.notesDir) + path.sep;
  if (!full.startsWith(root)) throw new Error('Path escapes notes folder');
  return full;
}

const attachmentsDir = () => path.join(settings.notesDir, '.attachments');

function safeAttachmentPath(fileName) {
  if (typeof fileName !== 'string' || !IMAGE_NAME_RE.test(fileName)) {
    throw new Error('Invalid attachment name');
  }
  const full = path.resolve(attachmentsDir(), fileName);
  const root = path.resolve(attachmentsDir()) + path.sep;
  if (!full.startsWith(root)) throw new Error('Path escapes attachments folder');
  return full;
}

async function copyImageIntoAttachments(srcPath) {
  const ext = path.extname(srcPath).slice(1).toLowerCase();
  if (!IMAGE_EXT_ALLOW.has(ext)) throw new Error('Unsupported image type');
  const stat = await fsp.stat(srcPath);
  if (!stat.isFile()) throw new Error('Not a file');
  if (stat.size > MAX_IMAGE_BYTES) throw new Error('Image too large (max 8MB)');
  await fsp.mkdir(attachmentsDir(), { recursive: true });
  const name = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
  const dest = safeAttachmentPath(name);
  await fsp.copyFile(srcPath, dest);
  return `![](.attachments/${name})`;
}

// Card metadata (color, pinned, checklist mode) lives in a small sidecar JSON
// so the .txt files stay pure, portable plain text.
const metaPath = () => path.join(settings.notesDir, '.keepnotes-meta.json');

async function readMeta() {
  try {
    return JSON.parse(await fsp.readFile(metaPath(), 'utf8'));
  } catch {
    return {};
  }
}

async function writeMeta(meta) {
  await fsp.writeFile(metaPath(), JSON.stringify(meta, null, 2), 'utf8');
}

// ---------- notes cache ----------
// Avoids re-reading every .txt file from disk on every notes:list call
// (e.g. on each window-focus refresh); only changed/new files are re-read.
const notesCache = new Map(); // fileName -> { mtimeMs, content }

// ---------- IPC ----------
function registerIpc() {
  ipcMain.handle('settings:get', () => ({ ...settings }));

  ipcMain.handle('settings:set', async (_e, patch) => {
    const clean = sanitizeSettings(patch || {});
    if (clean.notesDir && clean.notesDir !== settings.notesDir) {
      await fsp.mkdir(clean.notesDir, { recursive: true });
      notesCache.clear();
    }
    const frameChanged = typeof clean.borderless === 'boolean' && clean.borderless !== settings.borderless;
    settings = { ...settings, ...clean };
    saveSettings(settings);
    if (frameChanged) {
      recreateWindow();
    } else {
      applySettings();
    }
    return { ...settings };
  });

  ipcMain.handle('settings:chooseFolder', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Choose where your notes are stored',
      properties: ['openDirectory', 'createDirectory']
    });
    if (res.canceled || !res.filePaths[0]) return null;
    return res.filePaths[0];
  });

  ipcMain.handle('settings:openFolder', () => shell.openPath(settings.notesDir));

  ipcMain.handle('notes:list', async () => {
    await fsp.mkdir(settings.notesDir, { recursive: true });
    const entries = await fsp.readdir(settings.notesDir, { withFileTypes: true });
    const meta = await readMeta();
    const notes = [];
    const seen = new Set();
    for (const ent of entries) {
      if (!ent.isFile() || !ent.name.toLowerCase().endsWith('.txt')) continue;
      if (!NAME_RE.test(ent.name)) continue;
      seen.add(ent.name);
      const full = path.join(settings.notesDir, ent.name);
      const stat = await fsp.stat(full);
      if (stat.size > 512 * 1024) continue; // ignore huge files
      const cached = notesCache.get(ent.name);
      let content;
      if (cached && cached.mtimeMs === stat.mtimeMs) {
        content = cached.content;
      } else {
        content = await fsp.readFile(full, 'utf8');
        notesCache.set(ent.name, { mtimeMs: stat.mtimeMs, content });
      }
      notes.push({
        file: ent.name,
        content,
        mtime: stat.mtimeMs,
        meta: meta[ent.name] || {}
      });
    }
    for (const key of notesCache.keys()) {
      if (!seen.has(key)) notesCache.delete(key);
    }
    notes.sort((a, b) => (b.meta.pinned === true) - (a.meta.pinned === true) || b.mtime - a.mtime);
    return notes;
  });

  ipcMain.handle('notes:save', async (_e, fileName, content) => {
    if (typeof content !== 'string' || content.length > 512 * 1024) {
      throw new Error('Note too large');
    }
    const full = safeNotePath(fileName);
    await fsp.writeFile(full, content, 'utf8');
    return true;
  });

  ipcMain.handle('notes:create', async (_e, title) => {
    const base = String(title || 'Note')
      .replace(/[^\w \-()\[\]']/g, '')
      .trim()
      .slice(0, 60) || 'Note';
    let name = `${base}.txt`;
    let i = 2;
    while (fs.existsSync(path.join(settings.notesDir, name))) {
      name = `${base} (${i++}).txt`;
    }
    const full = safeNotePath(name);
    await fsp.writeFile(full, '', 'utf8');
    return name;
  });

  ipcMain.handle('notes:delete', async (_e, fileName) => {
    const full = safeNotePath(fileName);
    await shell.trashItem(full); // recycle bin, not permanent delete
    const meta = await readMeta();
    delete meta[fileName];
    await writeMeta(meta);
    notesCache.delete(fileName);
    return true;
  });

  ipcMain.handle('notes:rename', async (_e, oldName, newTitle) => {
    const from = safeNotePath(oldName);
    const base = String(newTitle || '')
      .replace(/[^\w \-()\[\]']/g, '')
      .trim()
      .slice(0, 60);
    if (!base) throw new Error('Invalid title');
    let name = `${base}.txt`;
    let i = 2;
    while (name !== oldName && fs.existsSync(path.join(settings.notesDir, name))) {
      name = `${base} (${i++}).txt`;
    }
    if (name === oldName) return oldName;
    await fsp.rename(from, safeNotePath(name));
    const meta = await readMeta();
    if (meta[oldName]) {
      meta[name] = meta[oldName];
      delete meta[oldName];
      await writeMeta(meta);
    }
    const cached = notesCache.get(oldName);
    if (cached) {
      notesCache.delete(oldName);
      notesCache.set(name, cached);
    }
    return name;
  });

  ipcMain.handle('notes:setMeta', async (_e, fileName, patch) => {
    safeNotePath(fileName); // validates the name
    const meta = await readMeta();
    const cur = meta[fileName] || {};
    const clean = {};
    if (typeof patch.pinned === 'boolean') clean.pinned = patch.pinned;
    if (typeof patch.color === 'string' && /^[a-z]{3,12}$/.test(patch.color)) clean.color = patch.color;
    meta[fileName] = { ...cur, ...clean };
    await writeMeta(meta);
    return meta[fileName];
  });

  // ---- images ----
  ipcMain.handle('images:pickAndCopy', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Insert image',
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }]
    });
    if (res.canceled || !res.filePaths[0]) return null;
    return copyImageIntoAttachments(res.filePaths[0]);
  });

  ipcMain.handle('images:saveDataUrl', async (_e, dataUrl) => {
    const m = typeof dataUrl === 'string' && dataUrl.match(DATA_URL_RE);
    if (!m) throw new Error('Unsupported image data');
    const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > MAX_IMAGE_BYTES) throw new Error('Image too large (max 8MB)');
    await fsp.mkdir(attachmentsDir(), { recursive: true });
    const name = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
    await fsp.writeFile(safeAttachmentPath(name), buf);
    return `![](.attachments/${name})`;
  });

  ipcMain.handle('images:saveFromPath', async (_e, absPath) => {
    if (typeof absPath !== 'string' || !absPath) throw new Error('Invalid path');
    return copyImageIntoAttachments(absPath);
  });

  // ---- close/minimize-to-tray ----
  ipcMain.handle('app:closeAction', (_e, action) => {
    if (action === 'quit') {
      isQuitting = true;
      app.quit();
    } else if (action === 'tray') {
      win.hide();
    }
    // 'cancel': window is already visible, nothing to do
  });

  // ---- window controls (used by the custom titlebar in borderless mode) ----
  ipcMain.handle('window:minimize', () => win.minimize());
  ipcMain.handle('window:toggleMaximize', () => {
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  ipcMain.handle('window:close', () => win.close());
}

// ---------- window ----------
function bgForTheme(theme) {
  return THEME_BG[theme] || THEME_BG['light-paper'];
}

// Widget mode needs to shrink the window down to 320x420 (see applyWidgetMode),
// so the minimum size has to accommodate that plus the borderless titlebar.
const MIN_WIDTH = 300;
const MIN_HEIGHT = 340;

function createWindow(bounds) {
  win = new BrowserWindow({
    width: 980,
    height: 700,
    ...(bounds || {}),
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    backgroundColor: bgForTheme(settings.theme),
    autoHideMenuBar: true,
    frame: !settings.borderless,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: true
    }
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Block any navigation or popups; this app never loads remote content.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  win.on('minimize', (e) => {
    if (settings.minimizeToTray) {
      e.preventDefault();
      win.hide();
    }
  });

  win.on('close', (e) => {
    if (isQuitting) return;
    if (settings.closeAction === 'quit') return;
    if (settings.closeAction === 'tray') {
      e.preventDefault();
      win.hide();
      return;
    }
    e.preventDefault();
    win.show();
    win.webContents.send('app:confirm-close');
  });

  applySettings();
}

// The `frame` option is constructor-only, so toggling "Borderless window"
// has to tear down and recreate the BrowserWindow. Bounds are preserved;
// unsaved renderer state is not (the settings toggle notes this).
function recreateWindow() {
  const bounds = win.getBounds();
  const old = win;
  old.removeAllListeners('close');
  old.removeAllListeners('minimize');
  createWindow(bounds);
  old.destroy();
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.png')).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip('KeepNotes');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open KeepNotes', click: () => { win.show(); win.focus(); } },
    { type: 'separator' },
    { label: 'Quit KeepNotes', click: () => { isQuitting = true; app.quit(); } }
  ]));
  tray.on('click', () => {
    if (win.isVisible()) {
      win.focus();
    } else {
      win.show();
      win.focus();
    }
  });
}

function registerAssetProtocol() {
  protocol.handle('keepnotes-asset', async (request) => {
    try {
      const url = new URL(request.url);
      const name = decodeURIComponent(url.hostname + url.pathname).replace(/^\/+/, '');
      const full = safeAttachmentPath(name);
      return net.fetch(pathToFileURL(full).toString());
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    settings = loadSettings();
    registerIpc();
    registerAssetProtocol();
    createWindow();
    createTray();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
