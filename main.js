// MeMoo (formerly KeepNotes) - main process
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
  Tray, Menu, nativeImage, protocol, net, screen, Notification
} = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');
const { pathToFileURL } = require('url');

let win = null;
let tray = null;
let autoUpdater = null; // lazily required in setupAutoUpdater(); stays null in dev
let isQuitting = false;
let widgetActive = false;
let previousBounds = null;

// ---------- popped-out cluster windows ----------
// A cluster can be "popped" into its own BrowserWindow (see cluster:popOut
// below); while popped it's removed from settings.clusters (so the main
// window's stack doesn't also show it) and tracked here instead. Popped
// windows are session-only - they aren't restored on the next launch.
const poppedWindows = new Map(); // clusterId -> BrowserWindow
const poppedSide = new Map(); // clusterId -> 'left' | 'right', widget mode only
const WIDGET_STACK_GAP = 8;
const WIDGET_SIDE_MARGIN = 16;
const MAX_PER_SIDE = 3;

// keepnotes-asset:// / keepnotes-gallery:// must be registered as privileged
// before app is ready. `stream: true` on the gallery scheme lets Chromium
// issue ranged requests, which <video> needs to seek/play.
protocol.registerSchemesAsPrivileged([
  { scheme: 'keepnotes-asset', privileges: { secure: true, supportFetchAPI: true, corsEnabled: false } },
  { scheme: 'keepnotes-gallery', privileges: { secure: true, supportFetchAPI: true, corsEnabled: false, stream: true } }
]);

// ---------- settings ----------
const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');

// The app was renamed from KeepNotes to MeMoo, which moves Electron's
// userData folder (%APPDATA%\<productName>). Carry the old settings and
// gallery metadata over once, so an upgrade keeps the user's notes folder,
// theme and layout. Only runs while the new folder has no settings yet.
const LEGACY_USERDATA_FILES = ['settings.json', 'gallery-meta.json'];
function migrateLegacyUserData() {
  try {
    const legacyDir = path.join(app.getPath('appData'), 'KeepNotes');
    const userData = app.getPath('userData');
    if (path.resolve(legacyDir) === path.resolve(userData)) return;
    if (fs.existsSync(settingsPath()) || !fs.existsSync(path.join(legacyDir, 'settings.json'))) return;
    fs.mkdirSync(userData, { recursive: true });
    for (const name of LEGACY_USERDATA_FILES) {
      const from = path.join(legacyDir, name);
      if (fs.existsSync(from)) fs.copyFileSync(from, path.join(userData, name));
    }
  } catch (err) {
    console.error('Could not migrate KeepNotes settings:', err);
  }
}

// New installs keep notes in Documents\MeMoo, but someone who used the
// default Documents\KeepNotes folder keeps using it rather than starting
// out with an empty notes list.
function defaultNotesDir() {
  const docs = app.getPath('documents');
  const legacy = path.join(docs, 'KeepNotes');
  const current = path.join(docs, 'MeMoo');
  return fs.existsSync(legacy) && !fs.existsSync(current) ? legacy : current;
}

// Mirrors NOTE_FONTS in renderer/app.js.
const NOTE_FONTS = new Set([
  'segoe', 'calibri', 'arial', 'verdana', 'tahoma', 'trebuchet',
  'georgia', 'cambria', 'times', 'consolas', 'comic', 'nunito'
]);

const THEMES = new Set([
  'light-paper', 'light-mist', 'light-sage', 'light-blossom', 'light-sand', 'light-ice',
  'dark-slate', 'dark-midnight', 'dark-coffee', 'dark-plum', 'dark-forest', 'dark-ocean'
]);
const THEME_BG = {
  'light-paper': '#f6f3ec',
  'light-mist': '#eef1f5',
  'light-sage': '#eef4ec',
  'light-blossom': '#fbeef2',
  'light-sand': '#f6ecd9',
  'light-ice': '#eef6f7',
  'dark-slate': '#1e1f22',
  'dark-midnight': '#0d1117',
  'dark-coffee': '#161211',
  'dark-plum': '#1c1522',
  'dark-forest': '#10190f',
  'dark-ocean': '#071620'
};
const CLOSE_ACTIONS = new Set(['ask', 'quit', 'tray']);

// ---------- clusters ----------
// Clusters are the toggleable sections (Notes, Calendar, Gallery, ...) that
// stack in the main window. `settings.clusters` is an ordered array of
// enabled ids, front = most-recently-enabled; that order is both the
// membership set and the visual stacking order (see applyLayout below).
const KNOWN_CLUSTERS = new Set(['notes', 'calendar', 'gallery']);
const WIDGET_WIDTH = 320;
const WIDGET_HEIGHT = { notes: 420, calendar: 220, gallery: 260 };
const NORMAL_HEIGHT = 700;
const NORMAL_WIDTH = { notes: 980, calendar: 340, gallery: 380 };
// Floor for a cluster's own size when the user drags the divider between it
// and a neighbor - keeps a dragged-down panel from collapsing to nothing.
const CLUSTER_MIN_SIZE = { widget: 120, normal: 220 };
const CLUSTER_MAX_SIZE = 4000;

function maxClustersFor(widgetMode) {
  return widgetMode ? 3 : 5;
}

// Per-cluster size the user dragged to, if any, else the built-in default
// for that mode. `mode` is 'widget' (height) or 'normal' (width).
function effectiveClusterSize(mode, id) {
  const custom = settings.clusterSizes && settings.clusterSizes[mode] && settings.clusterSizes[mode][id];
  if (typeof custom === 'number' && Number.isFinite(custom)) return custom;
  const table = mode === 'widget' ? WIDGET_HEIGHT : NORMAL_WIDTH;
  return table[id] || 0;
}

// Slices settings.clusters down to what the current widgetMode allows,
// dropping the least-recently-enabled extras first. Falls back to ['notes']
// if that would otherwise leave the window with nothing to show.
function clampClusters(s) {
  const max = maxClustersFor(s.widgetMode);
  s.clusters = (s.clusters || []).slice(0, max);
  if (s.clusters.length === 0) s.clusters = ['notes'];
  return s;
}

const defaultSettings = () => ({
  notesDir: defaultNotesDir(),
  alwaysOnTop: false,
  launchAtStartup: true,
  theme: 'light-paper',
  widgetMode: false,
  minimizeToTray: true,
  closeAction: 'ask',
  borderless: false,
  clusters: ['notes'],
  galleryDir: null,
  clusterSizes: { widget: {}, normal: {} },
  noteFont: 'segoe'
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
    return clampClusters({ ...defaultSettings(), ...sanitizeSettings(parsed) });
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
  if (typeof s.noteFont === 'string' && NOTE_FONTS.has(s.noteFont)) out.noteFont = s.noteFont;
  if (Array.isArray(s.clusters)) {
    const seen = new Set();
    const list = [];
    for (const id of s.clusters) {
      if (typeof id === 'string' && KNOWN_CLUSTERS.has(id) && !seen.has(id)) {
        seen.add(id);
        list.push(id);
      }
    }
    out.clusters = list;
  }
  if (s.galleryDir === null) out.galleryDir = null;
  else if (typeof s.galleryDir === 'string' && s.galleryDir.length < 1024) out.galleryDir = s.galleryDir;
  if (s.clusterSizes && typeof s.clusterSizes === 'object') {
    const clean = {};
    for (const mode of ['widget', 'normal']) {
      const src = s.clusterSizes[mode];
      if (!src || typeof src !== 'object') continue;
      const min = CLUSTER_MIN_SIZE[mode];
      const sizes = {};
      for (const id of KNOWN_CLUSTERS) {
        const v = src[id];
        if (typeof v === 'number' && Number.isFinite(v)) {
          sizes[id] = Math.round(Math.max(min, Math.min(CLUSTER_MAX_SIZE, v)));
        }
      }
      if (Object.keys(sizes).length) clean[mode] = sizes;
    }
    out.clusterSizes = clean;
  }
  return out;
}

function saveSettings(s) {
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(s, null, 2), 'utf8');
}

let settings = null;

// `skipResize` is used when only settings.clusterSizes changed (dragging a
// divider between two panels) - that's a zero-sum trade between two panels
// within the window's EXISTING size, not a reason to resize the window
// itself. Recomputing bounds here anyway would fight the divider drag: the
// stack's actual content height also includes the topbar/tagbar chrome above
// it, which this size math doesn't know about, so re-deriving window height
// from the just-dragged (slightly squeezed) panel sizes shrank the window a
// little more on every drag.
function applySettings(skipResize) {
  if (win && !win.isDestroyed()) {
    win.setAlwaysOnTop(!!settings.alwaysOnTop, 'normal');
    if (!skipResize) applyLayout();
  }
  // Startup entry only makes sense in a packaged build; in dev it would
  // register the electron binary instead of the app.
  if (app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: !!settings.launchAtStartup });
  }
  fs.mkdirSync(settings.notesDir, { recursive: true });
}

// Height of whatever sits above #clusterStack in the main window - the
// topbar, and the tag bar/update banner when they're showing - reported by
// the renderer (see window:reportChromeHeight) since only it knows the real
// DOM/CSS layout. Widget-mode height has to add this in, or the cluster
// stack gets squeezed into less room than its declared size and the bottom
// of the last panel ends up visually cut off.
let chromeHeight = 0;

// Sizes the window from the enabled clusters: widget mode keeps a fixed
// width and stacks clusters into the height; normal mode keeps a fixed
// height and lines clusters up beside each other into the width.
function applyLayout() {
  win.setSkipTaskbar(!!settings.widgetMode);
  // A maximized window keeps filling the screen - the renderer lays clusters
  // out side by side for it - unless widget mode was just switched, which
  // has to restore the window so the new mode's bounds can apply.
  if (win.isMaximized()) {
    if (widgetActive === !!settings.widgetMode) return;
    win.unmaximize();
  }
  const { workArea } = screen.getPrimaryDisplay();

  if (settings.widgetMode) {
    if (!widgetActive) {
      previousBounds = win.getContentBounds();
      widgetActive = true;
    }
    const height = Math.min(
      chromeHeight + settings.clusters.reduce((sum, id) => sum + effectiveClusterSize('widget', id), 0),
      workArea.height
    );
    // Content bounds, not outer bounds - width/height here need to match
    // exactly what the renderer's CSS sees, or the native titlebar/frame
    // (when not borderless) eats into it and the last cluster's bottom edge
    // ends up outside the visible window.
    win.setContentBounds({
      width: WIDGET_WIDTH,
      height,
      x: workArea.x + workArea.width - WIDGET_WIDTH - 16,
      y: workArea.y + workArea.height - height - 16
    });
    return;
  }

  const width = settings.clusters.reduce((sum, id) => sum + effectiveClusterSize('normal', id), 0);
  const b = win.getContentBounds();
  if (widgetActive) {
    widgetActive = false;
    win.setContentBounds({
      x: previousBounds ? previousBounds.x : b.x,
      y: previousBounds ? previousBounds.y : b.y,
      width,
      height: NORMAL_HEIGHT
    });
  } else if (b.width !== width || b.height !== NORMAL_HEIGHT) {
    win.setContentBounds({ x: b.x, y: b.y, width, height: NORMAL_HEIGHT });
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

// ---------- calendar ----------
// Events live in their own sidecar next to the notes, same shape as the
// note-meta sidecar above: { [id]: event }.
const calendarPath = () => path.join(settings.notesDir, '.keepnotes-calendar.json');
const CAL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CAL_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const CAL_MAX_TITLE = 120;
const CAL_MAX_NOTES = 2000;
// Same palette notes use for their card color, reused here so an event's
// color and a note's color always mean the same swatch.
const CAL_COLORS = new Set(['paper', 'sun', 'mint', 'sky', 'blush', 'lilac']);

async function readCalendar() {
  try {
    return JSON.parse(await fsp.readFile(calendarPath(), 'utf8'));
  } catch {
    return {};
  }
}

async function writeCalendar(events) {
  await fsp.writeFile(calendarPath(), JSON.stringify(events, null, 2), 'utf8');
}

// Shared by calendar:create and calendar:update - only copies over fields
// that are present and valid, same "clean patch" shape as notes:setMeta.
function sanitizeEventPatch(patch) {
  const clean = {};
  if (typeof patch.date === 'string' && CAL_DATE_RE.test(patch.date)) clean.date = patch.date;
  if ('time' in patch) {
    if (patch.time === null) clean.time = null;
    else if (typeof patch.time === 'string' && CAL_TIME_RE.test(patch.time)) clean.time = patch.time;
  }
  if (typeof patch.title === 'string') clean.title = patch.title.trim().slice(0, CAL_MAX_TITLE) || 'Event';
  if (typeof patch.notes === 'string') clean.notes = patch.notes.slice(0, CAL_MAX_NOTES);
  if ('color' in patch) {
    if (patch.color === null) clean.color = null;
    else if (typeof patch.color === 'string' && CAL_COLORS.has(patch.color)) clean.color = patch.color;
  }
  if (patch && 'reminderAt' in patch) {
    if (patch.reminderAt === null) {
      clean.reminderAt = null;
    } else if (typeof patch.reminderAt === 'number' && Number.isFinite(patch.reminderAt) &&
               patch.reminderAt > 0 && patch.reminderAt < 4102444800000 /* year 2100 */) {
      clean.reminderAt = patch.reminderAt;
    }
    clean.reminderNotified = false;
  }
  if (patch && 'reminderRepeat' in patch) {
    if (typeof patch.reminderRepeat === 'string' && REPEAT_OPTIONS.has(patch.reminderRepeat)) {
      clean.reminderRepeat = patch.reminderRepeat;
    } else if (patch.reminderRepeat == null) {
      clean.reminderRepeat = 'none';
    }
  }
  return clean;
}

// ---------- gallery ----------
// Gallery files can live anywhere on disk (Pictures/Videos by default, or a
// chosen folder), so unlike notes/attachments we can't trust a filename
// alone. Every id is a hash of its resolved path, and `galleryIndex` (built
// fresh on every scan) is the ONLY way an id resolves back to a real path -
// the renderer never sends a raw path for reads or writes.
const GALLERY_IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp']);
const GALLERY_VIDEO_EXT = new Set(['mp4', 'webm', 'mov', 'mkv', 'avi', 'm4v']);
const GALLERY_MAX_FILES = 4000;
const GALLERY_MAX_DEPTH = 6;
const GALLERY_IMPORT_MAX_BYTES = 300 * 1024 * 1024;

let galleryIndex = new Map(); // id -> absolute path, rebuilt by every scanGallery()

const galleryMetaPath = () => path.join(app.getPath('userData'), 'gallery-meta.json');

async function readGalleryMeta() {
  try {
    return JSON.parse(await fsp.readFile(galleryMetaPath(), 'utf8'));
  } catch {
    return {};
  }
}

async function writeGalleryMeta(meta) {
  await fsp.writeFile(galleryMetaPath(), JSON.stringify(meta, null, 2), 'utf8');
}

function galleryRoots() {
  if (settings.galleryDir) return [settings.galleryDir];
  return [app.getPath('pictures'), app.getPath('videos')];
}

function galleryIdFor(absPath) {
  return crypto.createHash('sha1').update(absPath.toLowerCase()).digest('hex');
}

async function walkGallery(dir, depth, out) {
  if (depth > GALLERY_MAX_DEPTH || out.length >= GALLERY_MAX_FILES) return;
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return; // folder missing/unreadable - just contributes nothing
  }
  for (const ent of entries) {
    if (out.length >= GALLERY_MAX_FILES) return;
    if (ent.name.startsWith('.')) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      await walkGallery(full, depth + 1, out);
    } else if (ent.isFile()) {
      const ext = path.extname(ent.name).slice(1).toLowerCase();
      if (GALLERY_IMAGE_EXT.has(ext) || GALLERY_VIDEO_EXT.has(ext)) out.push(full);
    }
  }
}

async function scanGallery() {
  const files = [];
  for (const root of galleryRoots()) {
    await walkGallery(root, 0, files);
  }
  galleryIndex = new Map(files.map((full) => [galleryIdFor(full), full]));
  return files;
}

// Picks the folder a newly-imported file should land in: the configured
// galleryDir if set (everything goes there), otherwise Pictures/Videos
// split by file type, matching how galleryRoots() scans by default.
function targetGalleryDirFor(ext) {
  if (settings.galleryDir) return settings.galleryDir;
  return GALLERY_VIDEO_EXT.has(ext) ? app.getPath('videos') : app.getPath('pictures');
}

function dedupeFileName(dir, base, ext) {
  let name = `${base}${ext}`;
  let i = 2;
  while (fs.existsSync(path.join(dir, name))) name = `${base} (${i++})${ext}`;
  return name;
}

// Copies a file the user picked or dropped into the appropriate gallery
// folder. Only known image/video extensions are accepted, same as scanGallery.
async function importGalleryFile(srcPath) {
  if (typeof srcPath !== 'string' || !srcPath) throw new Error('Invalid path');
  const ext = path.extname(srcPath).slice(1).toLowerCase();
  if (!GALLERY_IMAGE_EXT.has(ext) && !GALLERY_VIDEO_EXT.has(ext)) throw new Error('Unsupported file type');
  const stat = await fsp.stat(srcPath);
  if (!stat.isFile()) throw new Error('Not a file');
  if (stat.size > GALLERY_IMPORT_MAX_BYTES) throw new Error('File too large (max 300MB)');
  const dir = targetGalleryDirFor(ext);
  await fsp.mkdir(dir, { recursive: true });
  const base = path.basename(srcPath, path.extname(srcPath)).replace(/[\\/:*?"<>|]/g, '').trim().slice(0, 100) || 'file';
  const name = dedupeFileName(dir, base, path.extname(srcPath).toLowerCase());
  const dest = path.join(dir, name);
  await fsp.copyFile(srcPath, dest);
  return dest;
}

// ---------- reminders ----------
// Notes carry an optional reminderAt (epoch ms) + reminderNotified flag in the
// meta sidecar. A lightweight poller checks for due reminders instead of
// scheduling per-note timers, since reminders can be added/changed/cleared
// at any time and the note count is small - polling is simpler and just as
// accurate for a minutes-granularity feature like this.
const REMINDER_POLL_MS = 20000;
const REPEAT_OPTIONS = new Set(['none', 'daily', 'weekly', 'monthly', 'yearly']);
let reminderTimer = null;

// Advances `ms` by one repeat interval, clamping day-of-month overflow
// (e.g. Jan 31 + 1 month lands on the last day of Feb, not Mar 3) so
// monthly/yearly reminders behave the way Google Keep-style repeats do.
function addRepeatInterval(ms, repeat) {
  const d = new Date(ms);
  switch (repeat) {
    case 'daily':
      d.setDate(d.getDate() + 1);
      return d.getTime();
    case 'weekly':
      d.setDate(d.getDate() + 7);
      return d.getTime();
    case 'monthly': {
      const day = d.getDate();
      d.setDate(1);
      d.setMonth(d.getMonth() + 1);
      const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
      d.setDate(Math.min(day, lastDay));
      return d.getTime();
    }
    case 'yearly': {
      const month = d.getMonth();
      d.setFullYear(d.getFullYear() + 1);
      if (d.getMonth() !== month) d.setDate(0); // Feb 29 -> Feb 28 on non-leap years
      return d.getTime();
    }
    default:
      return null;
  }
}

// If the app was closed through one or more occurrences, skip forward to
// the next one that's still in the future rather than notifying once per
// missed occurrence.
function nextRepeatAfter(ms, repeat, now) {
  let next = addRepeatInterval(ms, repeat);
  if (next === null) return null;
  while (next <= now) {
    next = addRepeatInterval(next, repeat);
  }
  return next;
}

function fireReminderNotification(fileName) {
  if (!Notification.isSupported()) return;
  const title = fileName.replace(/\.txt$/i, '');
  let body = 'Reminder';
  try {
    const content = fs.readFileSync(path.join(settings.notesDir, fileName), 'utf8');
    const firstLine = content.split('\n').find((l) => l.trim().length > 0);
    if (firstLine) body = firstLine.trim().slice(0, 120);
  } catch {
    // note may have no readable content yet; fall back to generic body
  }
  const notification = new Notification({
    title: `Reminder: ${title}`,
    body,
    silent: false
  });
  notification.on('click', () => {
    const target = windowForCluster('notes');
    if (!target || target.isDestroyed()) return;
    if (target.isMinimized()) target.restore();
    target.show();
    target.focus();
    target.webContents.send('reminder:open-note', fileName);
  });
  notification.show();
}

async function checkReminders() {
  try {
    const meta = await readMeta();
    const now = Date.now();
    let changed = false;
    for (const [fileName, m] of Object.entries(meta)) {
      if (!m || typeof m.reminderAt !== 'number' || m.reminderNotified) continue;
      if (m.reminderAt > now) continue;
      if (!fs.existsSync(path.join(settings.notesDir, fileName))) {
        delete meta[fileName].reminderAt;
        delete meta[fileName].reminderNotified;
        changed = true;
        continue;
      }
      fireReminderNotification(fileName);
      if (m.reminderRepeat && m.reminderRepeat !== 'none') {
        const next = nextRepeatAfter(m.reminderAt, m.reminderRepeat, now);
        meta[fileName] = { ...m, reminderAt: next, reminderNotified: false };
      } else {
        meta[fileName] = { ...m, reminderNotified: true };
      }
      changed = true;
    }
    if (changed) await writeMeta(meta);
  } catch (err) {
    console.error('Reminder check failed', err);
  }
}

function fireCalendarReminderNotification(id, event) {
  if (!Notification.isSupported()) return;
  const body = event.notes ? event.notes.slice(0, 120) : (event.time ? `${event.date} ${event.time}` : event.date);
  const notification = new Notification({
    title: `Event: ${event.title}`,
    body,
    silent: false
  });
  notification.on('click', () => {
    const target = windowForCluster('calendar');
    if (!target || target.isDestroyed()) return;
    if (target.isMinimized()) target.restore();
    target.show();
    target.focus();
    target.webContents.send('calendar:open-event', id);
  });
  notification.show();
}

async function checkCalendarReminders() {
  try {
    const events = await readCalendar();
    const now = Date.now();
    let changed = false;
    for (const [id, ev] of Object.entries(events)) {
      if (!ev || typeof ev.reminderAt !== 'number' || ev.reminderNotified) continue;
      if (ev.reminderAt > now) continue;
      fireCalendarReminderNotification(id, ev);
      if (ev.reminderRepeat && ev.reminderRepeat !== 'none') {
        const next = nextRepeatAfter(ev.reminderAt, ev.reminderRepeat, now);
        events[id] = { ...ev, reminderAt: next, reminderNotified: false };
      } else {
        events[id] = { ...ev, reminderNotified: true };
      }
      changed = true;
    }
    if (changed) await writeCalendar(events);
  } catch (err) {
    console.error('Calendar reminder check failed', err);
  }
}

function startReminderScheduler() {
  checkReminders();
  checkCalendarReminders();
  reminderTimer = setInterval(() => {
    checkReminders();
    checkCalendarReminders();
  }, REMINDER_POLL_MS);
}

// ---------- auto-update ----------
// Checks GitHub Releases (see build.publish in package.json) for a newer
// version. Only meaningful in a packaged build - dev runs have no update
// feed and checkForUpdates() would just error. Offline checks fail quietly
// via the 'error' event; the next scheduled check (or app restart) retries.
const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours

function setupAutoUpdater() {
  if (!app.isPackaged) return;
  autoUpdater = require('electron-updater').autoUpdater;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-downloaded', (info) => {
    if (win && !win.isDestroyed()) {
      win.webContents.send('app:update-ready', info.version);
    }
    if (Notification.isSupported()) {
      const notification = new Notification({
        title: 'MeMoo update ready',
        body: `Version ${info.version} has been downloaded. Restart to install it.`,
        silent: false
      });
      notification.on('click', () => {
        isQuitting = true;
        autoUpdater.quitAndInstall();
      });
      notification.show();
    }
  });

  autoUpdater.on('error', (err) => {
    console.error('Auto-update check failed', err);
  });

  const check = () => autoUpdater.checkForUpdates().catch((err) => console.error('Update check failed', err));
  check();
  setInterval(check, UPDATE_CHECK_INTERVAL_MS);
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
    const onlyClusterSizesChanged = Object.keys(clean).length > 0 &&
      Object.keys(clean).every((k) => k === 'clusterSizes');
    settings = clampClusters({ ...settings, ...clean });
    saveSettings(settings);
    if (frameChanged) {
      recreateWindow();
    } else {
      applySettings(onlyClusterSizesChanged);
    }
    broadcastSettings();
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
    broadcastToAll('data:changed', 'notes');
    return name;
  });

  ipcMain.handle('notes:delete', async (_e, fileName) => {
    const full = safeNotePath(fileName);
    await shell.trashItem(full); // recycle bin, not permanent delete
    const meta = await readMeta();
    delete meta[fileName];
    await writeMeta(meta);
    notesCache.delete(fileName);
    broadcastToAll('data:changed', 'notes');
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
    broadcastToAll('data:changed', 'notes');
    return name;
  });

  ipcMain.handle('notes:setMeta', async (_e, fileName, patch) => {
    safeNotePath(fileName); // validates the name
    const meta = await readMeta();
    const cur = meta[fileName] || {};
    const clean = {};
    if (typeof patch.pinned === 'boolean') clean.pinned = patch.pinned;
    if (typeof patch.color === 'string' && /^[a-z]{3,12}$/.test(patch.color)) clean.color = patch.color;
    if (typeof patch.icon === 'string' && /^[a-z][a-z0-9-]{1,30}$/.test(patch.icon)) clean.icon = patch.icon;
    if (typeof patch.urgent === 'boolean') clean.urgent = patch.urgent;
    if (typeof patch.archived === 'boolean') clean.archived = patch.archived;
    if (patch && 'reminderAt' in patch) {
      if (patch.reminderAt === null) {
        clean.reminderAt = null;
      } else if (typeof patch.reminderAt === 'number' && Number.isFinite(patch.reminderAt) &&
                 patch.reminderAt > 0 && patch.reminderAt < 4102444800000 /* year 2100 */) {
        clean.reminderAt = patch.reminderAt;
      }
      // Any change to the reminder time re-arms it so it can fire again.
      clean.reminderNotified = false;
    }
    if (patch && 'reminderRepeat' in patch) {
      if (typeof patch.reminderRepeat === 'string' && REPEAT_OPTIONS.has(patch.reminderRepeat)) {
        clean.reminderRepeat = patch.reminderRepeat;
      } else if (patch.reminderRepeat == null) {
        clean.reminderRepeat = 'none';
      }
    }
    const next = { ...cur, ...clean };
    if (next.reminderAt == null) {
      delete next.reminderAt;
      delete next.reminderNotified;
      delete next.reminderRepeat;
    } else if (!next.reminderRepeat || next.reminderRepeat === 'none') {
      delete next.reminderRepeat;
    }
    meta[fileName] = next;
    await writeMeta(meta);
    broadcastToAll('data:changed', 'notes');
    return meta[fileName];
  });

  // ---- calendar ----
  ipcMain.handle('calendar:list', async () => {
    const events = await readCalendar();
    return Object.entries(events).map(([id, e]) => ({ id, ...e }));
  });

  ipcMain.handle('calendar:create', async (_e, patch) => {
    const clean = sanitizeEventPatch(patch || {});
    if (!clean.date) throw new Error('Event needs a date');
    const events = await readCalendar();
    const id = crypto.randomBytes(8).toString('hex');
    const event = {
      date: clean.date,
      time: clean.time ?? null,
      title: clean.title || 'Event',
      notes: clean.notes || '',
      color: clean.color ?? null,
      reminderAt: clean.reminderAt ?? null,
      reminderRepeat: clean.reminderRepeat || 'none',
      reminderNotified: false
    };
    events[id] = event;
    await writeCalendar(events);
    broadcastToAll('data:changed', 'calendar');
    return { id, ...event };
  });

  ipcMain.handle('calendar:update', async (_e, id, patch) => {
    const events = await readCalendar();
    if (!events[id]) throw new Error('Event not found');
    events[id] = { ...events[id], ...sanitizeEventPatch(patch || {}) };
    await writeCalendar(events);
    broadcastToAll('data:changed', 'calendar');
    return { id, ...events[id] };
  });

  ipcMain.handle('calendar:delete', async (_e, id) => {
    const events = await readCalendar();
    delete events[id];
    await writeCalendar(events);
    broadcastToAll('data:changed', 'calendar');
    return true;
  });

  // ---- gallery ----
  ipcMain.handle('gallery:list', async () => {
    await scanGallery();
    const meta = await readGalleryMeta();
    const items = [];
    for (const [id, full] of galleryIndex.entries()) {
      let stat;
      try {
        stat = await fsp.stat(full);
      } catch {
        continue; // vanished between scan and stat
      }
      const ext = path.extname(full).slice(1).toLowerCase();
      items.push({
        id,
        name: path.basename(full),
        ext,
        kind: GALLERY_VIDEO_EXT.has(ext) ? 'video' : 'image',
        size: stat.size,
        mtime: stat.mtimeMs,
        meta: meta[id] || {}
      });
    }
    items.sort((a, b) => (b.meta.pinned === true) - (a.meta.pinned === true) || b.mtime - a.mtime);
    return items;
  });

  ipcMain.handle('gallery:setMeta', async (_e, id, patch) => {
    if (!galleryIndex.has(id)) throw new Error('Not found');
    const meta = await readGalleryMeta();
    const cur = meta[id] || {};
    const clean = {};
    if (typeof patch.pinned === 'boolean') clean.pinned = patch.pinned;
    if (Array.isArray(patch.tags)) {
      clean.tags = patch.tags
        .filter((t) => typeof t === 'string')
        .map((t) => t.trim().slice(0, 30))
        .filter(Boolean)
        .slice(0, 20);
    }
    meta[id] = { ...cur, ...clean };
    await writeGalleryMeta(meta);
    broadcastToAll('data:changed', 'gallery');
    return meta[id];
  });

  ipcMain.handle('gallery:rename', async (_e, id, newTitle) => {
    const full = galleryIndex.get(id);
    if (!full) throw new Error('Not found');
    const ext = path.extname(full);
    const dir = path.dirname(full);
    const base = String(newTitle || '').replace(/[\\/:*?"<>|]/g, '').trim().slice(0, 100);
    if (!base) throw new Error('Invalid name');
    const name = dedupeFileName(dir, base, ext);
    const dest = path.join(dir, name);
    await fsp.rename(full, dest);
    galleryIndex.delete(id);
    const newId = galleryIdFor(dest);
    galleryIndex.set(newId, dest);
    const meta = await readGalleryMeta();
    if (meta[id]) {
      meta[newId] = meta[id];
      delete meta[id];
      await writeGalleryMeta(meta);
    }
    broadcastToAll('data:changed', 'gallery');
    return { id: newId, name };
  });

  ipcMain.handle('gallery:delete', async (_e, id) => {
    const full = galleryIndex.get(id);
    if (!full) throw new Error('Not found');
    await shell.trashItem(full);
    galleryIndex.delete(id);
    const meta = await readGalleryMeta();
    delete meta[id];
    await writeGalleryMeta(meta);
    broadcastToAll('data:changed', 'gallery');
    return true;
  });

  ipcMain.handle('gallery:chooseFolder', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Choose a folder for the Gallery',
      properties: ['openDirectory']
    });
    if (res.canceled || !res.filePaths[0]) return null;
    return res.filePaths[0];
  });

  // Editing (crop/rotate/etc.) happens in the user's own default app for the
  // file, not in MeMoo - this just hands the real file off to Windows.
  ipcMain.handle('gallery:openInDefaultApp', async (_e, id) => {
    const full = galleryIndex.get(id);
    if (!full) throw new Error('Not found');
    const err = await shell.openPath(full);
    if (err) throw new Error(err);
    return true;
  });

  ipcMain.handle('gallery:pickAndImport', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Add photos or videos',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Photos & videos', extensions: [...GALLERY_IMAGE_EXT, ...GALLERY_VIDEO_EXT] }]
    });
    if (res.canceled || !res.filePaths.length) return { imported: 0 };
    let imported = 0;
    for (const p of res.filePaths) {
      try {
        await importGalleryFile(p);
        imported++;
      } catch (err) {
        console.error('Gallery import failed', err);
      }
    }
    if (imported > 0) broadcastToAll('data:changed', 'gallery');
    return { imported };
  });

  // Backs the drag-and-drop import path: the renderer resolves each dropped
  // File to an absolute path via webUtils.getPathForFile and sends the list here.
  ipcMain.handle('gallery:importFromPaths', async (_e, paths) => {
    if (!Array.isArray(paths)) return { imported: 0 };
    let imported = 0;
    for (const p of paths) {
      try {
        await importGalleryFile(p);
        imported++;
      } catch (err) {
        console.error('Gallery import failed', err);
      }
    }
    if (imported > 0) broadcastToAll('data:changed', 'gallery');
    return { imported };
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

  ipcMain.handle('app:getVersion', () => app.getVersion());

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

  // ---- updates ----
  ipcMain.handle('app:installUpdate', () => {
    if (!autoUpdater) return;
    isQuitting = true;
    autoUpdater.quitAndInstall();
  });

  // ---- window controls (used by the custom titlebar in borderless mode) ----
  // Acts on whichever window sent the request, not always the main one - a
  // popped-out cluster window has its own custom titlebar too.
  ipcMain.handle('window:minimize', (e) => BrowserWindow.fromWebContents(e.sender)?.minimize());
  ipcMain.handle('window:toggleMaximize', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (!w) return;
    if (w.isMaximized()) w.unmaximize();
    else w.maximize();
  });
  ipcMain.handle('window:isMaximized', (e) => !!BrowserWindow.fromWebContents(e.sender)?.isMaximized());
  ipcMain.handle('window:close', (e) => BrowserWindow.fromWebContents(e.sender)?.close());

  // The main window reports how tall its own topbar/tagbar/titlebar chrome
  // is measuring out to right now, so widget-mode sizing can add it in (see
  // chromeHeight / applyLayout). Popped windows don't affect this - each
  // shows only one cluster sized to fill whatever space it's given.
  ipcMain.handle('window:reportChromeHeight', (e, height) => {
    if (typeof height !== 'number' || !Number.isFinite(height) || height < 0) return;
    if (BrowserWindow.fromWebContents(e.sender) !== win) return;
    if (Math.abs(height - chromeHeight) < 2) return;
    chromeHeight = height;
    if (settings.widgetMode) applyLayout();
  });

  // ---- popped-out cluster windows ----
  ipcMain.handle('cluster:popOut', (_e, id) => {
    if (!KNOWN_CLUSTERS.has(id)) return false;
    const existing = poppedWindows.get(id);
    if (existing && !existing.isDestroyed()) {
      existing.show();
      existing.focus();
      return true;
    }
    // A disabled cluster isn't shown anywhere, so there's nothing to pop out
    // until it's switched back on (mirrors the greyed-out button in the
    // renderer's cluster settings list).
    if (!settings.clusters.includes(id)) return false;
    // Never leave the main window with nothing to show.
    if (settings.clusters.length <= 1) return false;
    settings.clusters = settings.clusters.filter((c) => c !== id);
    saveSettings(settings);
    applySettings();
    broadcastSettings();
    createClusterWindow(id);
    broadcastPoppedState();
    return true;
  });

  ipcMain.handle('cluster:popIn', (_e, id) => {
    const w = poppedWindows.get(id);
    if (w && !w.isDestroyed()) w.close();
    return true;
  });

  ipcMain.handle('cluster:getPopped', () => [...poppedWindows.keys()]);
}

// ---------- window ----------
function bgForTheme(theme) {
  return THEME_BG[theme] || THEME_BG['light-paper'];
}

// Widget mode can shrink the window down to a single small cluster (see
// applyLayout / WIDGET_HEIGHT), so the minimum has to accommodate that.
const MIN_WIDTH = 300;
const MIN_HEIGHT = 200;

function createWindow(bounds) {
  win = new BrowserWindow({
    width: 980,
    height: 700,
    ...(bounds || {}),
    // width/height above (and every later setContentBounds/getContentBounds
    // call) are the web page's own size, not the outer window - otherwise
    // the native titlebar/frame eats into that space and the bottom of the
    // last cluster panel renders outside the visible window.
    useContentSize: true,
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

  win.on('maximize', () => win.webContents.send('window:maximized-changed', true));
  win.on('unmaximize', () => win.webContents.send('window:maximized-changed', false));

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
  const bounds = win.getContentBounds();
  const old = win;
  old.removeAllListeners('close');
  old.removeAllListeners('minimize');
  createWindow(bounds);
  old.destroy();
}

// ---------- popped-out cluster windows ----------
function broadcastToAll(channel, ...args) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, ...args);
  }
}

function broadcastSettings() {
  broadcastToAll('settings:changed', { ...settings });
}

function broadcastPoppedState() {
  broadcastToAll('cluster:popped-changed', [...poppedWindows.keys()]);
}

// The window currently showing a given cluster's live UI - its own popped
// window if it has one, otherwise the main window. Notification click
// handlers use this so a reminder always opens in the right place even when
// Notes/Calendar has been popped out.
function windowForCluster(id) {
  const w = poppedWindows.get(id);
  return (w && !w.isDestroyed()) ? w : win;
}

// The main window always anchors to the bottom-right corner in widget mode
// (see applyLayout), so it's treated as occupying the right side's base slot
// when deciding where a newly popped-out widget should stack.
function pickSideForNewPopout() {
  const rightCount = 1 + [...poppedSide.values()].filter((s) => s === 'right').length;
  return rightCount < MAX_PER_SIDE ? 'right' : 'left';
}

// Y of the topmost edge of whatever's already stacked on this side (main
// window included, for 'right'), so a new widget can be placed just above it.
function stackTopY(side) {
  const { workArea } = screen.getPrimaryDisplay();
  let top = workArea.y + workArea.height - WIDGET_SIDE_MARGIN;
  if (side === 'right' && win && !win.isDestroyed()) {
    top = Math.min(top, win.getContentBounds().y);
  }
  for (const [id, w] of poppedWindows) {
    if (poppedSide.get(id) === side && !w.isDestroyed()) {
      top = Math.min(top, w.getContentBounds().y);
    }
  }
  return top;
}

function widgetPopoutBounds(side, height) {
  const { workArea } = screen.getPrimaryDisplay();
  const x = side === 'right'
    ? workArea.x + workArea.width - WIDGET_WIDTH - WIDGET_SIDE_MARGIN
    : workArea.x + WIDGET_SIDE_MARGIN;
  const y = Math.max(workArea.y, stackTopY(side) - WIDGET_STACK_GAP - height);
  return { x, y, width: WIDGET_WIDTH, height };
}

function createClusterWindow(id) {
  const isWidget = !!settings.widgetMode;
  let bounds;
  let side = null;
  if (isWidget) {
    side = pickSideForNewPopout();
    const height = Math.min(effectiveClusterSize('widget', id), screen.getPrimaryDisplay().workArea.height);
    bounds = widgetPopoutBounds(side, height);
  } else {
    // Not in widget mode: just a normal, freely-movable desktop window.
    bounds = { width: effectiveClusterSize('normal', id), height: NORMAL_HEIGHT };
  }

  const popWin = new BrowserWindow({
    ...bounds,
    useContentSize: true,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    backgroundColor: bgForTheme(settings.theme),
    autoHideMenuBar: true,
    frame: !settings.borderless,
    skipTaskbar: isWidget,
    alwaysOnTop: !!settings.alwaysOnTop,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: true
    }
  });

  popWin.loadFile(path.join(__dirname, 'renderer', 'index.html'), { query: { pop: id } });
  popWin.webContents.on('will-navigate', (e) => e.preventDefault());
  popWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  poppedWindows.set(id, popWin);
  if (side) poppedSide.set(id, side);

  popWin.on('closed', () => {
    poppedWindows.delete(id);
    poppedSide.delete(id);
    // Hand the cluster back to the main window's stack if it isn't already
    // showing somewhere else, so closing the popped window never just loses it.
    if (!settings.clusters.includes(id)) {
      settings = clampClusters({ ...settings, clusters: [id, ...settings.clusters] });
      saveSettings(settings);
      applySettings();
      broadcastSettings();
    }
    broadcastPoppedState();
  });

  return popWin;
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.png')).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip('MeMoo');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open MeMoo', click: () => { win.show(); win.focus(); } },
    { type: 'separator' },
    { label: 'Quit MeMoo', click: () => { isQuitting = true; app.quit(); } }
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

// Only ever resolves through galleryIndex (built by the last scanGallery()),
// never a path the renderer supplies - see the gallery comment block above.
function registerGalleryProtocol() {
  protocol.handle('keepnotes-gallery', async (request) => {
    try {
      const url = new URL(request.url);
      const id = decodeURIComponent(url.hostname + url.pathname).replace(/^\/+/, '');
      const full = galleryIndex.get(id);
      if (!full) return new Response('Not found', { status: 404 });
      // Forward the incoming Range header so seeks get back a proper 206
      // Partial Content response - without it every request (including the
      // ones <video> issues to decode a frame at a given time) returns the
      // whole file from byte 0, so Chromium's seek never resolves and the
      // video element stays blank/black instead of showing a frame.
      return net.fetch(pathToFileURL(full).toString(), { headers: request.headers });
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
    // Required for Windows toast notifications to show MeMoo's icon/name
    // correctly instead of falling back to Electron's defaults.
    app.setAppUserModelId('com.moocalf.keepnotes');
    migrateLegacyUserData();
    settings = loadSettings();
    registerIpc();
    registerAssetProtocol();
    registerGalleryProtocol();
    createWindow();
    createTray();
    startReminderScheduler();
    setupAutoUpdater();
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
