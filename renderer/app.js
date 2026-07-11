/* KeepNotes renderer. All DOM is built with createElement/textContent,
   never innerHTML with note data, so note content can't inject markup.
   The one exception is icon()/hydrateIcons(), which inline our own bundled
   Lucide SVG assets (never user data) via innerHTML. */

const api = window.keepnotes;

const COLORS = ['paper', 'sun', 'mint', 'sky', 'blush', 'lilac'];
const CHECK_RE = /^\[( |x|X)\]\s?(.*)$/;

const THEMES = [
  { id: 'light-paper', label: 'Paper', mode: 'light', bg: '#f6f3ec', accent: '#1f6f54' },
  { id: 'light-mist', label: 'Mist', mode: 'light', bg: '#eef1f5', accent: '#3b6ea5' },
  { id: 'light-sage', label: 'Sage', mode: 'light', bg: '#eef4ec', accent: '#4c7a3f' },
  { id: 'dark-slate', label: 'Slate', mode: 'dark', bg: '#1e1f22', accent: '#5bb98c' },
  { id: 'dark-midnight', label: 'Midnight', mode: 'dark', bg: '#0d1117', accent: '#5b9bd5' },
  { id: 'dark-coffee', label: 'Coffee', mode: 'dark', bg: '#161211', accent: '#d99a4e' }
];
const THEME_PAIRS = {};
THEMES.filter((t) => t.mode === 'light').forEach((t, i) => {
  const d = THEMES.filter((x) => x.mode === 'dark')[i];
  THEME_PAIRS[t.id] = d.id;
  THEME_PAIRS[d.id] = t.id;
});

let notes = [];
let current = null; // { file, content, meta }
let saveTimer = null;
let searchTimer = null;
let activeTag = null;
let editorMode = 'edit';
let currentTheme = 'light-paper';
let firstLoadDone = false;

const $ = (id) => document.getElementById(id);
const grid = $('grid');
const empty = $('empty');

// ---------- icons ----------
function icon(name, extraClass) {
  const span = document.createElement('span');
  span.className = 'icon' + (extraClass ? ` ${extraClass}` : '');
  span.innerHTML = (window.KEEPNOTES_ICONS && window.KEEPNOTES_ICONS[name]) || '';
  return span;
}

function hydrateIcons() {
  document.querySelectorAll('[data-icon]').forEach((el) => {
    if (el.querySelector('.icon')) return;
    el.prepend(icon(el.dataset.icon));
  });
}

// ---------- theme ----------
function setTheme(themeId, persist) {
  currentTheme = themeId;
  document.documentElement.dataset.theme = themeId;
  const isDark = themeId.startsWith('dark');
  const btn = $('themeToggleBtn');
  btn.innerHTML = '';
  btn.appendChild(icon(isDark ? 'moon' : 'sun'));
  btn.title = isDark ? 'Switch to light theme' : 'Switch to dark theme';
  if (persist) api.setSettings({ theme: themeId });
}

function renderThemeSwatches() {
  const lightWrap = $('lightThemeSwatches');
  const darkWrap = $('darkThemeSwatches');
  lightWrap.textContent = '';
  darkWrap.textContent = '';
  for (const t of THEMES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'theme-swatch' + (t.id === currentTheme ? ' active' : '');
    b.title = t.label;
    b.setAttribute('aria-label', t.label);
    const bg = document.createElement('span');
    bg.className = 'half';
    bg.style.background = t.bg;
    const ac = document.createElement('span');
    ac.className = 'half accent';
    ac.style.background = t.accent;
    b.append(bg, ac);
    b.addEventListener('click', () => {
      setTheme(t.id, true);
      renderThemeSwatches();
    });
    (t.mode === 'light' ? lightWrap : darkWrap).appendChild(b);
  }
}

$('themeToggleBtn').addEventListener('click', () => {
  setTheme(THEME_PAIRS[currentTheme] || 'dark-slate', true);
  renderThemeSwatches();
});

// ---------- rendering ----------
function titleOf(file) {
  return file.replace(/\.txt$/i, '');
}

// ---------- reminders ----------
function formatReminder(ms) {
  const d = new Date(ms);
  const now = new Date();
  const opts = { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
  if (d.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
  return d.toLocaleString(undefined, opts);
}

function toDatetimeLocalValue(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function computeTagCounts() {
  const counts = new Map();
  for (const n of notes) {
    for (const t of window.KeepNotesMarkdown.extractTags(n.content)) {
      counts.set(t, (counts.get(t) || 0) + 1);
    }
  }
  return counts;
}

function renderTagBar() {
  const bar = $('tagBar');
  const counts = computeTagCounts();
  bar.textContent = '';
  if (counts.size === 0) {
    bar.hidden = true;
    activeTag = null;
    return;
  }
  bar.hidden = false;
  const allChip = document.createElement('button');
  allChip.type = 'button';
  allChip.className = 'tag-chip' + (!activeTag ? ' active' : '');
  allChip.textContent = 'All';
  allChip.addEventListener('click', () => { activeTag = null; renderTagBar(); renderGrid(); });
  bar.appendChild(allChip);
  for (const [tag, count] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'tag-chip' + (activeTag === tag ? ' active' : '');
    chip.textContent = `#${tag} (${count})`;
    chip.addEventListener('click', () => {
      activeTag = activeTag === tag ? null : tag;
      renderTagBar();
      renderGrid();
    });
    bar.appendChild(chip);
  }
}

function renderGrid() {
  const q = $('search').value.trim().toLowerCase();
  grid.textContent = '';
  let shown = 0;

  for (const n of notes) {
    const hay = (titleOf(n.file) + '\n' + n.content).toLowerCase();
    if (q && !hay.includes(q)) continue;
    if (activeTag && !window.KeepNotesMarkdown.extractTags(n.content).has(activeTag)) continue;
    shown++;

    const card = document.createElement('article');
    card.className = `note ${n.meta.color || 'paper'}${n.meta.urgent ? ' urgent' : ''}`;
    card.tabIndex = 0;
    card.setAttribute('role', 'button');

    const head = document.createElement('div');
    head.className = 'note-head';
    const h = document.createElement('h3');
    h.className = 'note-title';
    h.textContent = titleOf(n.file);
    head.appendChild(h);
    if (n.meta.pinned) {
      const pin = document.createElement('span');
      pin.className = 'note-pin';
      pin.title = 'Pinned';
      pin.appendChild(icon('pin'));
      head.appendChild(pin);
    }
    if (n.meta.urgent) {
      const urgent = document.createElement('span');
      urgent.className = 'note-urgent-badge';
      urgent.title = 'Urgent';
      urgent.appendChild(icon('triangle-alert'));
      head.appendChild(urgent);
    }
    card.appendChild(head);

    if (typeof n.meta.reminderAt === 'number') {
      const rem = document.createElement('div');
      const isDue = n.meta.reminderAt <= Date.now() && !n.meta.reminderNotified;
      rem.className = 'note-reminder' + (isDue ? ' due' : '');
      rem.appendChild(icon('bell'));
      const span = document.createElement('span');
      span.textContent = formatReminder(n.meta.reminderAt);
      rem.appendChild(span);
      card.appendChild(rem);
    }

    const body = document.createElement('div');
    body.className = 'note-body';

    for (const line of n.content.split('\n').slice(0, 40)) {
      const m = line.match(CHECK_RE);
      if (m) {
        const done = m[1].toLowerCase() === 'x';
        const row = document.createElement('label');
        row.className = 'check' + (done ? ' done' : '');
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = done;
        cb.addEventListener('click', (e) => {
          e.stopPropagation();
          toggleLine(n, line);
        });
        const span = document.createElement('span');
        span.textContent = m[2];
        row.append(cb, span);
        body.appendChild(row);
      } else {
        const p = document.createElement('div');
        p.textContent = line;
        body.appendChild(p);
      }
    }
    card.appendChild(body);

    const open = () => openEditor(n);
    card.addEventListener('click', open);
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    });

    grid.appendChild(card);
  }

  empty.hidden = shown !== 0;
}

async function toggleLine(note, line) {
  const lines = note.content.split('\n');
  const i = lines.indexOf(line);
  if (i === -1) return;
  const m = lines[i].match(CHECK_RE);
  lines[i] = (m[1].toLowerCase() === 'x' ? '[ ] ' : '[x] ') + m[2];
  note.content = lines.join('\n');
  await api.saveNote(note.file, note.content);
  renderGrid();
}

// ---------- editor ----------
function updatePinBtn() {
  const pinned = !!current.meta.pinned;
  $('pinBtn').classList.toggle('is-pinned', pinned);
  $('pinBtn').title = pinned ? 'Unpin' : 'Pin';
}

function updateReminderBtn() {
  const has = typeof current.meta.reminderAt === 'number';
  $('reminderBtn').classList.toggle('has-reminder', has);
  $('reminderBtn').title = has ? `Reminder: ${formatReminder(current.meta.reminderAt)}` : 'Set reminder';
}

function updateUrgentBtn() {
  const urgent = !!current.meta.urgent;
  $('urgentBtn').classList.toggle('is-urgent', urgent);
  $('urgentBtn').title = urgent ? 'Marked urgent (click to unmark)' : 'Mark urgent';
  document.querySelector('.editor').classList.toggle('urgent', urgent);
}

function setEditorMode(mode) {
  editorMode = mode;
  const isPreview = mode === 'preview';
  $('editorBody').hidden = isPreview;
  $('editorPreview').hidden = !isPreview;
  $('editTabBtn').classList.toggle('active', !isPreview);
  $('previewTabBtn').classList.toggle('active', isPreview);
  if (isPreview) renderPreview();
}

function renderPreview() {
  if (!current) return;
  window.KeepNotesMarkdown.renderInto($('editorPreview'), $('editorBody').value, {
    isKnownTitle: (title) => notes.some((n) => titleOf(n.file).toLowerCase() === title.toLowerCase()),
    onWikilinkClick: (title) => openWikilink(title),
    onTagClick: (tag) => { activeTag = tag; $('editorOverlay').hidden = true; renderTagBar(); renderGrid(); },
    onToggleLine: (line) => toggleLineInEditor(line)
  });
}

function toggleLineInEditor(line) {
  const ta = $('editorBody');
  const lines = ta.value.split('\n');
  const i = lines.indexOf(line);
  if (i === -1) return;
  const m = lines[i].match(CHECK_RE);
  lines[i] = (m[1].toLowerCase() === 'x' ? '[ ] ' : '[x] ') + m[2];
  ta.value = lines.join('\n');
  scheduleSave();
  renderPreview();
}

async function openWikilink(title) {
  await saveEditor();
  let n = notes.find((x) => titleOf(x.file).toLowerCase() === title.toLowerCase());
  if (!n) {
    const file = await api.createNote(title);
    await refresh();
    n = notes.find((x) => x.file === file);
  }
  if (n) openEditor(n);
}

function renderBacklinks() {
  if (!current) return;
  const title = titleOf(current.file).toLowerCase();
  const linked = notes.filter((n) => {
    if (n.file === current.file) return false;
    for (const link of window.KeepNotesMarkdown.extractWikilinks(n.content)) {
      if (link.toLowerCase() === title) return true;
    }
    return false;
  });
  const wrap = $('backlinks');
  const list = $('backlinksList');
  list.textContent = '';
  wrap.hidden = linked.length === 0;
  for (const n of linked) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn btn-ghost';
    b.textContent = titleOf(n.file);
    b.addEventListener('click', () => openWikilink(titleOf(n.file)));
    list.appendChild(b);
  }
}

function openEditor(note) {
  current = note;
  $('editorTitle').value = titleOf(note.file);
  $('editorBody').value = note.content;
  updatePinBtn();
  const ed = document.querySelector('.editor');
  ed.className = `editor card ${note.meta.color || 'paper'}`;
  renderSwatches();
  updateReminderBtn();
  updateUrgentBtn();
  setEditorMode('edit');
  renderBacklinks();
  $('editorOverlay').hidden = false;
  $('editorBody').focus();
}

function renderSwatches() {
  const wrap = $('swatches');
  wrap.textContent = '';
  const active = current?.meta.color || 'paper';
  for (const c of COLORS) {
    const b = document.createElement('button');
    b.className = 'swatch' + (c === active ? ' active' : '');
    b.title = c;
    b.style.background = getComputedStyle(document.documentElement)
      .getPropertyValue(`--card-${c}`);
    b.addEventListener('click', async () => {
      current.meta = await api.setNoteMeta(current.file, { color: c });
      document.querySelector('.editor').className = `editor card ${c}`;
      renderSwatches();
      renderGrid();
    });
    wrap.appendChild(b);
  }
}

function insertAtCursor(text) {
  const ta = $('editorBody');
  const pos = ta.selectionStart;
  const before = ta.value.slice(0, pos);
  const insert = (before && !before.endsWith('\n') ? '\n' : '') + text + '\n';
  ta.setRangeText(insert, pos, pos, 'end');
  ta.focus();
  scheduleSave();
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveEditor, 400);
}

async function saveEditor() {
  if (!current) return;
  const body = $('editorBody').value;
  if (body !== current.content) {
    current.content = body;
    await api.saveNote(current.file, body);
  }
  const title = $('editorTitle').value.trim();
  if (title && title !== titleOf(current.file)) {
    const newFile = await api.renameNote(current.file, title);
    current.file = newFile;
    $('editorTitle').value = titleOf(newFile);
  }
  renderGrid();
}

async function closeEditor() {
  clearTimeout(saveTimer);
  await saveEditor();
  current = null;
  $('editorOverlay').hidden = true;
  await refresh();
}

// ---------- images ----------
$('imageBtn').addEventListener('click', async () => {
  try {
    const snippet = await api.pickImage();
    if (snippet) insertAtCursor(snippet);
  } catch (err) {
    console.error(err);
  }
});

$('editorBody').addEventListener('paste', (e) => {
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  for (const item of items) {
    if (!item.type.startsWith('image/')) continue;
    e.preventDefault();
    const file = item.getAsFile();
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const snippet = await api.saveImageDataUrl(reader.result);
        if (snippet) insertAtCursor(snippet);
      } catch (err) {
        console.error(err);
      }
    };
    reader.readAsDataURL(file);
    return;
  }
});

$('editorBody').addEventListener('dragover', (e) => e.preventDefault());
$('editorBody').addEventListener('drop', async (e) => {
  e.preventDefault();
  const files = e.dataTransfer && e.dataTransfer.files;
  if (!files || !files.length) return;
  for (const file of files) {
    if (!file.type.startsWith('image/')) continue;
    try {
      const absPath = api.getPathForFile(file);
      const snippet = await api.saveImageFromPath(absPath);
      if (snippet) insertAtCursor(snippet);
    } catch (err) {
      console.error(err);
    }
  }
});

// Prevent any stray drag/drop elsewhere in the window from navigating it.
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => e.preventDefault());

// ---------- settings ----------
async function openSettings() {
  const s = await api.getSettings();
  $('optStartup').checked = s.launchAtStartup;
  $('optOnTop').checked = s.alwaysOnTop;
  $('optWidget').checked = s.widgetMode;
  $('optBorderless').checked = s.borderless;
  $('optMinimizeTray').checked = s.minimizeToTray;
  $('optCloseAction').value = s.closeAction;
  $('folderPath').textContent = s.notesDir;
  renderThemeSwatches();
  $('settingsOverlay').hidden = false;
}

// ---------- close confirmation ----------
api.onConfirmClose(() => { $('closeConfirmOverlay').hidden = false; });

// ---------- reminder notification click ----------
api.onReminderOpen(async (_e, fileName) => {
  await refresh();
  const n = notes.find((x) => x.file === fileName);
  if (n) openEditor(n);
});

$('confirmCancelBtn').addEventListener('click', () => {
  $('closeConfirmOverlay').hidden = true;
  api.respondCloseAction('cancel');
});
$('confirmTrayBtn').addEventListener('click', () => {
  $('closeConfirmOverlay').hidden = true;
  api.respondCloseAction('tray');
});
$('confirmQuitBtn').addEventListener('click', () => {
  api.respondCloseAction('quit');
});

// ---------- command palette ----------
const COMMANDS = [
  { id: 'new-note', label: 'New note', icon: 'plus', run: () => $('newNoteBtn').click() },
  { id: 'settings', label: 'Open settings', icon: 'settings', run: () => openSettings() },
  { id: 'toggle-theme', label: 'Toggle light/dark theme', icon: 'sun', run: () => $('themeToggleBtn').click() },
  { id: 'open-folder', label: 'Open notes folder', icon: 'folder-open', run: () => api.openFolder() }
];

function openPalette() {
  $('paletteOverlay').hidden = false;
  $('paletteInput').value = '';
  renderPaletteResults('');
  $('paletteInput').focus();
}

function closePalette() {
  $('paletteOverlay').hidden = true;
}

function renderPaletteResults(query) {
  const q = query.trim().toLowerCase();
  const wrap = $('paletteResults');
  wrap.textContent = '';
  const noteMatches = notes.filter((n) => !q || titleOf(n.file).toLowerCase().includes(q)).slice(0, 8);
  const cmdMatches = COMMANDS.filter((c) => !q || c.label.toLowerCase().includes(q));

  if (noteMatches.length === 0 && cmdMatches.length === 0) {
    const e = document.createElement('div');
    e.className = 'palette-empty';
    e.textContent = 'No matches';
    wrap.appendChild(e);
    return;
  }

  for (const n of noteMatches) {
    const item = document.createElement('div');
    item.className = 'palette-item';
    item.appendChild(icon('search'));
    const span = document.createElement('span');
    span.textContent = titleOf(n.file);
    item.appendChild(span);
    item.addEventListener('click', () => { closePalette(); openEditor(n); });
    wrap.appendChild(item);
  }
  for (const c of cmdMatches) {
    const item = document.createElement('div');
    item.className = 'palette-item';
    item.appendChild(icon(c.icon));
    const span = document.createElement('span');
    span.textContent = c.label;
    item.appendChild(span);
    item.addEventListener('click', () => { closePalette(); c.run(); });
    wrap.appendChild(item);
  }
}

$('paletteInput').addEventListener('input', (e) => renderPaletteResults(e.target.value));
$('paletteOverlay').addEventListener('click', (e) => {
  if (e.target === $('paletteOverlay')) closePalette();
});

// ---------- data ----------
async function refresh() {
  if (!firstLoadDone) $('loading').hidden = false;
  notes = await api.listNotes();
  firstLoadDone = true;
  $('loading').hidden = true;
  renderTagBar();
  renderGrid();
}

// ---------- wiring ----------
$('newNoteBtn').addEventListener('click', async () => {
  const file = await api.createNote('Note');
  await refresh();
  const n = notes.find((x) => x.file === file);
  if (n) openEditor(n);
});

$('search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(renderGrid, 120);
});

$('closeEditorBtn').addEventListener('click', closeEditor);
$('editorOverlay').addEventListener('click', (e) => {
  if (e.target === $('editorOverlay')) closeEditor();
});
$('editorBody').addEventListener('input', scheduleSave);
$('editorTitle').addEventListener('input', scheduleSave);

$('editTabBtn').addEventListener('click', () => setEditorMode('edit'));
$('previewTabBtn').addEventListener('click', () => setEditorMode('preview'));

$('checklistBtn').addEventListener('click', () => {
  const ta = $('editorBody');
  const pos = ta.selectionStart;
  const before = ta.value.slice(0, pos);
  const insert = (before && !before.endsWith('\n') ? '\n' : '') + '[ ] ';
  ta.setRangeText(insert, pos, pos, 'end');
  ta.focus();
  scheduleSave();
});

$('pinBtn').addEventListener('click', async () => {
  current.meta = await api.setNoteMeta(current.file, { pinned: !current.meta.pinned });
  updatePinBtn();
  renderGrid();
});

$('urgentBtn').addEventListener('click', async () => {
  current.meta = await api.setNoteMeta(current.file, { urgent: !current.meta.urgent });
  updateUrgentBtn();
  renderGrid();
});

// ---------- reminder picker ----------
$('reminderBtn').addEventListener('click', () => {
  const input = $('reminderTimeInput');
  const hasReminder = typeof current.meta.reminderAt === 'number';
  input.value = toDatetimeLocalValue(hasReminder ? current.meta.reminderAt : Date.now() + 60 * 60 * 1000);
  $('reminderClearBtn').hidden = !hasReminder;
  $('reminderOverlay').hidden = false;
  input.focus();
});

function closeReminderOverlay() {
  $('reminderOverlay').hidden = true;
}

$('reminderCancelBtn').addEventListener('click', closeReminderOverlay);
$('reminderOverlay').addEventListener('click', (e) => {
  if (e.target === $('reminderOverlay')) closeReminderOverlay();
});

$('reminderSaveBtn').addEventListener('click', async () => {
  const val = $('reminderTimeInput').value;
  if (!val) return;
  const ms = new Date(val).getTime();
  if (Number.isNaN(ms)) return;
  current.meta = await api.setNoteMeta(current.file, { reminderAt: ms });
  updateReminderBtn();
  renderGrid();
  closeReminderOverlay();
});

$('reminderClearBtn').addEventListener('click', async () => {
  current.meta = await api.setNoteMeta(current.file, { reminderAt: null });
  updateReminderBtn();
  renderGrid();
  closeReminderOverlay();
});

$('deleteBtn').addEventListener('click', async () => {
  if (!current) return;
  if (!confirm(`Move "${titleOf(current.file)}" to the Recycle Bin?`)) return;
  await api.deleteNote(current.file);
  current = null;
  $('editorOverlay').hidden = true;
  await refresh();
});

$('settingsBtn').addEventListener('click', openSettings);
$('closeSettingsBtn').addEventListener('click', () => { $('settingsOverlay').hidden = true; });
$('settingsOverlay').addEventListener('click', (e) => {
  if (e.target === $('settingsOverlay')) $('settingsOverlay').hidden = true;
});

$('optStartup').addEventListener('change', (e) => api.setSettings({ launchAtStartup: e.target.checked }));
$('optOnTop').addEventListener('change', (e) => api.setSettings({ alwaysOnTop: e.target.checked }));
$('optWidget').addEventListener('change', (e) => api.setSettings({ widgetMode: e.target.checked }));
$('optBorderless').addEventListener('change', (e) => api.setSettings({ borderless: e.target.checked }));
$('optMinimizeTray').addEventListener('change', (e) => api.setSettings({ minimizeToTray: e.target.checked }));
$('optCloseAction').addEventListener('change', (e) => api.setSettings({ closeAction: e.target.value }));

$('changeFolderBtn').addEventListener('click', async () => {
  const dir = await api.chooseFolder();
  if (!dir) return;
  await api.setSettings({ notesDir: dir });
  $('folderPath').textContent = dir;
  await refresh();
});

$('openFolderBtn').addEventListener('click', () => api.openFolder());

// reload notes when the window regains focus so external .txt edits show up
window.addEventListener('focus', refresh);

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    if ($('paletteOverlay').hidden) openPalette(); else closePalette();
    return;
  }
  if (e.key === 'Escape') {
    if (!$('reminderOverlay').hidden) closeReminderOverlay();
    else if (!$('paletteOverlay').hidden) closePalette();
    else if (!$('editorOverlay').hidden) closeEditor();
    else if (!$('settingsOverlay').hidden) $('settingsOverlay').hidden = true;
    else if (!$('closeConfirmOverlay').hidden) {
      $('closeConfirmOverlay').hidden = true;
      api.respondCloseAction('cancel');
    }
  }
});

// ---------- custom titlebar (borderless mode) ----------
$('winMinBtn').addEventListener('click', () => api.minimizeWindow());
$('winMaxBtn').addEventListener('click', () => api.toggleMaximizeWindow());
$('winCloseBtn').addEventListener('click', () => api.closeWindow());

// ---------- startup ----------
async function init() {
  hydrateIcons();
  const s = await api.getSettings();
  setTheme(s.theme, false);
  $('customTitlebar').hidden = !s.borderless;
  await refresh();
}

init();
