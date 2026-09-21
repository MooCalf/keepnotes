/* KeepNotes renderer. All DOM is built with createElement/textContent,
   never innerHTML with note data, so note content can't inject markup.
   The one exception is icon()/hydrateIcons(), which inline our own bundled
   Lucide SVG assets (never user data) via innerHTML. */

const api = window.keepnotes;

const COLORS = ['paper', 'sun', 'mint', 'sky', 'blush', 'lilac'];
const CHECK_RE = /^\[( |x|X)\]\s?(.*)$/;

const DEFAULT_NOTE_ICON = 'sticky-note';
const NOTE_ICON_CHOICES = [
  'sticky-note', 'book-open', 'briefcase', 'heart', 'star', 'lightbulb', 'flag', 'coffee',
  'music', 'code', 'graduation-cap', 'shopping-cart', 'plane', 'home', 'dumbbell', 'utensils',
  'wallet', 'calendar', 'map-pin', 'camera', 'gift', 'target', 'rocket', 'leaf', 'smile',
  'gamepad-2', 'clipboard-list', 'folder', 'sparkles', 'cake', 'paw-print', 'cloud'
];

const THEMES = [
  { id: 'light-paper', label: 'Paper', mode: 'light', bg: '#f6f3ec', accent: '#1f6f54' },
  { id: 'light-mist', label: 'Mist', mode: 'light', bg: '#eef1f5', accent: '#3b6ea5' },
  { id: 'light-sage', label: 'Sage', mode: 'light', bg: '#eef4ec', accent: '#4c7a3f' },
  { id: 'light-blossom', label: 'Blossom', mode: 'light', bg: '#fbeef2', accent: '#c05f7e' },
  { id: 'light-sand', label: 'Sand', mode: 'light', bg: '#f6ecd9', accent: '#b8802f' },
  { id: 'light-ice', label: 'Ice', mode: 'light', bg: '#eef6f7', accent: '#2f8fa0' },
  { id: 'dark-slate', label: 'Slate', mode: 'dark', bg: '#1e1f22', accent: '#5bb98c' },
  { id: 'dark-midnight', label: 'Midnight', mode: 'dark', bg: '#0d1117', accent: '#5b9bd5' },
  { id: 'dark-coffee', label: 'Coffee', mode: 'dark', bg: '#161211', accent: '#d99a4e' },
  { id: 'dark-plum', label: 'Plum', mode: 'dark', bg: '#1c1522', accent: '#b98be0' },
  { id: 'dark-forest', label: 'Forest', mode: 'dark', bg: '#10190f', accent: '#7cc46b' },
  { id: 'dark-ocean', label: 'Ocean', mode: 'dark', bg: '#071620', accent: '#3fc1e0' }
];
// ---------- custom scrollbars ----------
// Any element that scrolls gets a .scrollbar-active class for 3s after the
// last scroll event (see styles.css); 'scroll' doesn't bubble, so this has
// to listen in the capture phase to catch it on nested scrollable elements.
(function () {
  const HIDE_DELAY = 3000;
  const timers = new WeakMap();
  document.addEventListener('scroll', (e) => {
    const el = e.target === document ? document.scrollingElement : e.target;
    if (!el || typeof el.classList === 'undefined') return;
    el.classList.add('scrollbar-active');
    clearTimeout(timers.get(el));
    timers.set(el, setTimeout(() => el.classList.remove('scrollbar-active'), HIDE_DELAY));
  }, true);
})();

let notes = [];
let current = null; // { file, content, meta }
let saveTimer = null;
let searchTimer = null;
let activeTag = null;
let editorMode = 'edit';
let currentTheme = 'light-paper';
let firstLoadDone = false;
let iconPickerNote = null;
let currentView = 'notes'; // 'notes' | 'archive'

// ---------- clusters ----------
// Mirrors main.js's WIDGET_HEIGHT/NORMAL_WIDTH tables so each panel's size
// matches the window bounds main.js computed from the same settings. A user
// drag overrides these via settings.clusterSizes (see effectiveClusterSize).
const CLUSTER_SIZES = {
  widget: { notes: 420, calendar: 220, gallery: 260 },
  normal: { notes: 980, calendar: 340, gallery: 380 }
};
// Mirrors main.js's CLUSTER_MIN_SIZE - the floor a dragged divider can't push
// a panel below, so it never gets dragged down to unusably small.
const CLUSTER_MIN_SIZE = { widget: 120, normal: 220 };
const CLUSTER_LABELS = { notes: 'Notes', calendar: 'Calendar', gallery: 'Gallery' };
const CLUSTER_ICONS = { notes: 'sticky-note', calendar: 'calendar', gallery: 'image' };
// Calendar/Gallery are heavier (disk scans, event storage) so they only ever
// mount the first time their panel is actually enabled, not at app startup.
const CLUSTER_MODULES = {
  calendar: () => window.KeepNotesCalendar,
  gallery: () => window.KeepNotesGallery
};
const clusterMounted = { notes: true, calendar: false, gallery: false };
let currentSettings = null;
let poppedClusterIds = new Set(); // clusters currently popped into their own window
// If this window was opened as a popped-out cluster (see main.js
// createClusterWindow), ?pop=<id> says which one it's dedicated to.
const poppedClusterId = new URLSearchParams(location.search).get('pop');

function maxClustersFor(widgetMode) {
  return widgetMode ? 3 : 5;
}

function clusterModeOf(s) {
  return s.widgetMode ? 'widget' : 'normal';
}

function effectiveClusterSize(s, mode, id) {
  const custom = s.clusterSizes && s.clusterSizes[mode] && s.clusterSizes[mode][id];
  if (typeof custom === 'number' && Number.isFinite(custom)) return custom;
  return CLUSTER_SIZES[mode][id] || 0;
}

// Tells main.js how tall the topbar/tagbar chrome above #clusterStack is
// actually rendering right now, so widget-mode window sizing can add it in
// instead of the cluster stack quietly losing that much space and the
// bottom of the last panel ending up cut off. Only the main window's chrome
// matters here - a popped-out window sizes its one panel to fill whatever
// space it's given instead (see applyPoppedLayout).
function reportChromeHeight() {
  if (poppedClusterId) return;
  api.reportChromeHeight(Math.round($('clusterStack').getBoundingClientRect().top));
}

function applyClusterLayout(s) {
  const stack = $('clusterStack');
  stack.dataset.axis = s.widgetMode ? 'column' : 'row';
  const mode = clusterModeOf(s);
  const enabled = new Set(s.clusters);
  stack.querySelectorAll('.cluster-divider').forEach((d) => d.remove());
  for (const id of s.clusters) {
    const panel = stack.querySelector(`.cluster-panel[data-cluster="${id}"]`);
    if (panel) stack.appendChild(panel); // reorders to match settings.clusters
  }
  const visible = [];
  for (const panel of stack.querySelectorAll('.cluster-panel')) {
    const id = panel.dataset.cluster;
    const on = enabled.has(id);
    panel.hidden = !on;
    if (!on) continue;
    panel.style.flexBasis = effectiveClusterSize(s, mode, id) + 'px';
    if (!clusterMounted[id] && CLUSTER_MODULES[id]) {
      clusterMounted[id] = true;
      CLUSTER_MODULES[id]().mount();
    }
    visible.push(panel);
  }
  // One draggable divider between each pair of adjacent visible panels, so
  // the user can trade size between two neighbors without touching settings.
  for (let i = 1; i < visible.length; i++) {
    stack.insertBefore(makeClusterDivider(visible[i - 1].dataset.cluster, visible[i].dataset.cluster), visible[i]);
  }
  // Panel flex-basis sizes only ever add up to the window size main.js
  // computed them from. Growing the OS window past that - dragging an edge,
  // or maximizing - left the extra space unclaimed and the last panel's
  // content clipped instead of using it, since every panel had flex-grow: 0.
  // Handing that leftover space to the last panel (instead of splitting it,
  // which would require re-deriving every panel's on-screen size) keeps the
  // others exactly as sized while stopping the last one from being cut off.
  visible.forEach((panel, i) => {
    panel.style.flexGrow = i === visible.length - 1 ? '1' : '0';
  });
}

// ---------- popped-out cluster windows ----------
// This window is dedicated to exactly one cluster (see main.js
// createClusterWindow) - it shows only that panel, full-size, with a small
// header instead of the normal multi-cluster topbar/drawer.
function applyPoppedLayout(id) {
  const stack = $('clusterStack');
  stack.dataset.axis = 'column';
  for (const panel of stack.querySelectorAll('.cluster-panel')) {
    const on = panel.dataset.cluster === id;
    panel.hidden = !on;
    if (!on) continue;
    panel.style.flex = '1 1 auto'; // fill the whole popped window, not just its content height
    if (!clusterMounted[id] && CLUSTER_MODULES[id]) {
      clusterMounted[id] = true;
      CLUSTER_MODULES[id]().mount();
    }
  }
}

function setupPoppedHeader(id) {
  const panel = document.querySelector(`.cluster-panel[data-cluster="${id}"]`);
  if (!panel) return;
  const header = document.createElement('div');
  header.className = 'cluster-header popped-header';
  const title = document.createElement('span');
  title.className = 'cluster-header-title';
  title.appendChild(icon(CLUSTER_ICONS[id]));
  title.append(CLUSTER_LABELS[id]);
  header.appendChild(title);
  // Notes has no add affordance of its own (calendar/gallery each have one
  // in their own cluster-header) - the popped window has no topbar Add menu
  // to reach it otherwise, so give it a small one here.
  if (id === 'notes') {
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'btn btn-ghost icon-btn';
    addBtn.title = 'New note';
    addBtn.setAttribute('aria-label', 'New note');
    addBtn.appendChild(icon('plus'));
    addBtn.addEventListener('click', addNewNote);
    header.appendChild(addBtn);
  }
  panel.prepend(header);
}

function makeClusterDivider(beforeId, afterId) {
  const div = document.createElement('div');
  div.className = 'cluster-divider';
  div.setAttribute('role', 'separator');
  div.tabIndex = -1;
  div.addEventListener('pointerdown', (e) => startClusterResize(e, beforeId, afterId));
  return div;
}

function startClusterResize(e, beforeId, afterId) {
  if (e.button !== undefined && e.button !== 0) return;
  e.preventDefault();
  const stack = $('clusterStack');
  const vertical = currentSettings.widgetMode; // column axis stacks top-to-bottom
  const mode = clusterModeOf(currentSettings);
  const min = CLUSTER_MIN_SIZE[mode];
  const beforePanel = stack.querySelector(`.cluster-panel[data-cluster="${beforeId}"]`);
  const afterPanel = stack.querySelector(`.cluster-panel[data-cluster="${afterId}"]`);
  if (!beforePanel || !afterPanel) return;
  const dim = vertical ? 'height' : 'width';
  const startPos = vertical ? e.clientY : e.clientX;
  const startBefore = beforePanel.getBoundingClientRect()[dim];
  const startAfter = afterPanel.getBoundingClientRect()[dim];
  const total = startBefore + startAfter;
  if (total < min * 2) return; // not enough room to split further

  document.body.style.cursor = vertical ? 'row-resize' : 'col-resize';
  document.body.style.userSelect = 'none';

  const onMove = (ev) => {
    const pos = vertical ? ev.clientY : ev.clientX;
    const delta = pos - startPos;
    const newBefore = Math.max(min, Math.min(total - min, startBefore + delta));
    beforePanel.style.flexBasis = Math.round(newBefore) + 'px';
    afterPanel.style.flexBasis = Math.round(total - newBefore) + 'px';
  };
  const onUp = async () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    const beforeSize = Math.round(beforePanel.getBoundingClientRect()[dim]);
    const afterSize = Math.round(afterPanel.getBoundingClientRect()[dim]);
    const clusterSizes = {
      widget: { ...currentSettings.clusterSizes?.widget },
      normal: { ...currentSettings.clusterSizes?.normal }
    };
    clusterSizes[mode][beforeId] = beforeSize;
    clusterSizes[mode][afterId] = afterSize;
    currentSettings = await api.setSettings({ clusterSizes });
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}

function renderClusterSettings(s) {
  const wrap = $('clusterToggleList');
  wrap.textContent = '';
  const max = maxClustersFor(s.widgetMode);
  $('clusterCapNote').textContent = `${s.clusters.length} of ${max} enabled`;
  for (const id of Object.keys(CLUSTER_LABELS)) {
    const row = document.createElement('label');
    const popped = poppedClusterIds.has(id);
    row.className = 'cluster-toggle-row' + (popped ? ' popped' : '');
    const checked = s.clusters.includes(id);
    const span = document.createElement('span');
    span.appendChild(icon(CLUSTER_ICONS[id]));
    span.append(CLUSTER_LABELS[id]);
    row.appendChild(span);

    const popBtn = document.createElement('button');
    popBtn.type = 'button';
    popBtn.className = 'btn btn-ghost cluster-pop-btn';
    popBtn.textContent = popped ? 'Pop back in' : 'Pop out';
    // A disabled cluster has nothing to pop out - grey the button out until
    // the switch below turns it back on (popped clusters are always allowed
    // back in, even though their own switch shows unchecked+disabled).
    popBtn.disabled = !popped && !checked;
    popBtn.title = popped
      ? 'Bring this cluster back into the main window'
      : (checked ? 'Open this cluster in its own window' : 'Enable this cluster first');
    popBtn.addEventListener('click', async (e) => {
      // Nested inside the row's own <label> - stop it from also toggling
      // the checkbox below via the label's native click-bubbling behavior.
      e.preventDefault();
      e.stopPropagation();
      if (popped) {
        await api.popInCluster(id);
        return;
      }
      const ok = await api.popOutCluster(id);
      if (!ok) alert('Enable another cluster first - the window needs at least one to show.');
    });
    row.appendChild(popBtn);

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'switch';
    cb.checked = checked;
    cb.disabled = popped || (!checked && s.clusters.length >= max);
    cb.addEventListener('change', () => setClusterEnabled(id, cb.checked));
    row.appendChild(cb);
    wrap.appendChild(row);
  }
}

async function setClusterEnabled(id, on) {
  let clusters = currentSettings.clusters.filter((c) => c !== id);
  if (on) clusters = [id, ...clusters];
  currentSettings = await api.setSettings({ clusters });
  renderClusterSettings(currentSettings);
  applyClusterLayout(currentSettings);
}

// Used by the Add menu so adding an event/file always works even if that
// cluster's panel is currently switched off, instead of silently no-oping.
async function ensureClusterEnabled(id) {
  if (currentSettings.clusters.includes(id)) return;
  await setClusterEnabled(id, true);
}

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

// ---------- note icon ----------
function openIconPicker(note) {
  iconPickerNote = note;
  renderIconPickerGrid();
  $('iconPickerOverlay').hidden = false;
}

function closeIconPicker() {
  $('iconPickerOverlay').hidden = true;
  iconPickerNote = null;
}

function renderIconPickerGrid() {
  const wrap = $('iconPickerGrid');
  wrap.textContent = '';
  const active = (iconPickerNote && iconPickerNote.meta.icon) || DEFAULT_NOTE_ICON;
  for (const name of NOTE_ICON_CHOICES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'icon-choice' + (name === active ? ' active' : '');
    b.title = name.replace(/-/g, ' ');
    b.setAttribute('aria-label', name.replace(/-/g, ' '));
    b.appendChild(icon(name));
    b.addEventListener('click', () => selectNoteIcon(name));
    wrap.appendChild(b);
  }
}

async function selectNoteIcon(name) {
  const note = iconPickerNote;
  if (!note) return;
  note.meta = await api.setNoteMeta(note.file, { icon: name });
  if (current && current.file === note.file) {
    current.meta = note.meta;
    updateNoteIconBtn();
  }
  closeIconPicker();
  renderGrid();
}

function updateNoteIconBtn() {
  const btn = $('noteIconBtn');
  btn.innerHTML = '';
  btn.appendChild(icon(current.meta.icon || DEFAULT_NOTE_ICON));
}

$('closeIconPickerBtn').addEventListener('click', closeIconPicker);
$('iconPickerOverlay').addEventListener('click', (e) => {
  if (e.target === $('iconPickerOverlay')) closeIconPicker();
});
$('noteIconBtn').addEventListener('click', () => {
  if (current) openIconPicker(current);
});

// ---------- theme ----------
function setTheme(themeId, persist) {
  currentTheme = themeId;
  document.documentElement.dataset.theme = themeId;
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

// ---------- nav drawer ----------
function openDrawer() {
  $('drawerBackdrop').classList.add('open');
  $('navDrawer').classList.add('open');
}

function closeDrawer() {
  $('drawerBackdrop').classList.remove('open');
  $('navDrawer').classList.remove('open');
}

function setView(view) {
  currentView = view;
  activeTag = null;
  $('navNotesBtn').classList.toggle('active', view === 'notes');
  $('navArchiveBtn').classList.toggle('active', view === 'archive');
  $('navPinnedBtn').classList.toggle('active', view === 'pinned');
  const isPinned = view === 'pinned';
  $('grid').hidden = isPinned;
  $('pinnedGrid').hidden = !isPinned;
  if (isPinned) {
    $('empty').hidden = true;
    $('tagBar').hidden = true;
    renderPinnedGrid();
    return;
  }
  $('pinnedEmpty').hidden = true;
  if (view === 'archive') {
    $('emptyTitle').textContent = 'No archived notes';
    $('emptyBody').textContent = 'Notes you archive will show up here.';
  } else {
    $('emptyTitle').textContent = 'No notes yet';
    $('emptyBody').textContent = 'Create your first note, or drop .txt files into your notes folder and they will show up here.';
  }
  renderTagBar();
  renderGrid();
}

async function renderPinnedGrid() {
  const shown = await window.KeepNotesGallery.renderPinnedInto($('pinnedGrid'), $('search').value);
  $('pinnedEmpty').hidden = shown !== 0;
}

// Small hook gallery.js calls into when a pin/delete happens from its own
// viewer, so this page stays live if it's the one currently on screen.
window.KeepNotesApp = {
  onPinnedImagesChanged() {
    if (currentView === 'pinned') renderPinnedGrid();
  }
};

$('menuBtn').addEventListener('click', () => {
  if ($('drawerBackdrop').classList.contains('open')) closeDrawer(); else openDrawer();
});
$('drawerBackdrop').addEventListener('click', closeDrawer);
$('navNotesBtn').addEventListener('click', () => { setView('notes'); closeDrawer(); });
$('navArchiveBtn').addEventListener('click', () => { setView('archive'); closeDrawer(); });
$('navPinnedBtn').addEventListener('click', () => { setView('pinned'); closeDrawer(); });

// ---------- rendering ----------
function titleOf(file) {
  return file.replace(/\.txt$/i, '');
}

// ---------- reminders ----------
const REPEAT_LABELS = { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly', yearly: 'Yearly' };

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

function inCurrentView(note) {
  return currentView === 'archive' ? !!note.meta.archived : !note.meta.archived;
}

function computeTagCounts() {
  const counts = new Map();
  for (const n of notes) {
    if (!inCurrentView(n)) continue;
    for (const t of window.KeepNotesMarkdown.extractTags(n.content)) {
      counts.set(t, (counts.get(t) || 0) + 1);
    }
  }
  return counts;
}

async function toggleArchive(note) {
  note.meta = await api.setNoteMeta(note.file, { archived: !note.meta.archived });
  renderTagBar();
  renderGrid();
}

function renderTagBar() {
  const bar = $('tagBar');
  const counts = computeTagCounts();
  bar.textContent = '';
  if (counts.size === 0) {
    bar.hidden = true;
    activeTag = null;
    reportChromeHeight();
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
  reportChromeHeight();
}

function renderGrid() {
  const q = $('search').value.trim().toLowerCase();
  grid.textContent = '';
  let shown = 0;

  for (const n of notes) {
    if (!inCurrentView(n)) continue;
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
    const iconBtn = document.createElement('button');
    iconBtn.type = 'button';
    iconBtn.className = 'note-icon-btn';
    iconBtn.title = 'Change icon';
    iconBtn.setAttribute('aria-label', 'Change note icon');
    iconBtn.appendChild(icon(n.meta.icon || DEFAULT_NOTE_ICON));
    iconBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openIconPicker(n);
    });
    head.appendChild(iconBtn);
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
    const archiveBtn = document.createElement('button');
    archiveBtn.type = 'button';
    archiveBtn.className = 'note-icon-btn';
    archiveBtn.title = n.meta.archived ? 'Unarchive' : 'Archive';
    archiveBtn.setAttribute('aria-label', archiveBtn.title);
    archiveBtn.appendChild(icon(n.meta.archived ? 'archive-restore' : 'archive'));
    archiveBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleArchive(n);
    });
    head.appendChild(archiveBtn);
    card.appendChild(head);

    if (typeof n.meta.reminderAt === 'number') {
      const rem = document.createElement('div');
      const isDue = n.meta.reminderAt <= Date.now() && !n.meta.reminderNotified;
      rem.className = 'note-reminder' + (isDue ? ' due' : '');
      rem.appendChild(icon('bell'));
      const span = document.createElement('span');
      span.textContent = formatReminder(n.meta.reminderAt);
      rem.appendChild(span);
      if (REPEAT_LABELS[n.meta.reminderRepeat]) {
        rem.appendChild(icon('repeat', 'note-reminder-repeat'));
        rem.title = `Repeats ${REPEAT_LABELS[n.meta.reminderRepeat].toLowerCase()}`;
      }
      card.appendChild(rem);
    }

    const body = document.createElement('div');
    body.className = 'note-body md-preview';
    const preview = n.content.split('\n').slice(0, 40).join('\n');
    window.KeepNotesMarkdown.renderInto(body, preview, {
      onToggleLine: (line) => toggleLine(n, line)
    });
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

function updateArchiveBtn() {
  const archived = !!current.meta.archived;
  const btn = $('archiveBtn');
  btn.classList.toggle('is-archived', archived);
  btn.innerHTML = '';
  btn.appendChild(icon(archived ? 'archive-restore' : 'archive'));
  btn.title = archived ? 'Unarchive' : 'Archive';
}

function updateReminderBtn() {
  const has = typeof current.meta.reminderAt === 'number';
  $('reminderBtn').classList.toggle('has-reminder', has);
  if (!has) {
    $('reminderBtn').title = 'Set reminder';
    return;
  }
  const repeat = REPEAT_LABELS[current.meta.reminderRepeat];
  $('reminderBtn').title = `Reminder: ${formatReminder(current.meta.reminderAt)}` + (repeat ? ` (repeats ${repeat.toLowerCase()})` : '');
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
  updateArchiveBtn();
  updateNoteIconBtn();
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
  currentSettings = s;
  $('optStartup').checked = s.launchAtStartup;
  $('optOnTop').checked = s.alwaysOnTop;
  $('optWidget').checked = s.widgetMode;
  $('optBorderless').checked = s.borderless;
  $('optMinimizeTray').checked = s.minimizeToTray;
  $('optCloseAction').value = s.closeAction;
  $('folderPath').textContent = s.notesDir;
  $('galleryFolderPath').textContent = s.galleryDir || 'Pictures + Videos (default)';
  renderThemeSwatches();
  renderClusterSettings(s);
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

// ---------- calendar reminder notification click ----------
api.onCalendarReminderOpen((_e, id) => {
  window.KeepNotesCalendar.openEvent(id);
});

// ---------- cross-window sync ----------
// Other windows (the main window, or another popped-out cluster) can change
// data or settings this window needs to reflect too.
api.onDataChanged((_e, scope) => {
  if (scope === 'notes') refresh();
  if (scope === 'gallery' && currentView === 'pinned') renderPinnedGrid();
});

api.onSettingsChanged((_e, s) => {
  currentSettings = s;
  if (poppedClusterId) return; // this window only ever shows its one cluster
  applyClusterLayout(s);
  if (!$('settingsOverlay').hidden) renderClusterSettings(s);
});

api.onPoppedClustersChanged((_e, ids) => {
  poppedClusterIds = new Set(ids);
  if (!poppedClusterId && !$('settingsOverlay').hidden) renderClusterSettings(currentSettings);
});

// ---------- update banner ----------
api.onUpdateReady((_e, version) => {
  $('updateBannerText').textContent = `KeepNotes ${version} is ready to install.`;
  $('updateBanner').hidden = false;
  reportChromeHeight();
});
$('updateRestartBtn').addEventListener('click', () => api.installUpdate());
$('updateDismissBtn').addEventListener('click', () => {
  $('updateBanner').hidden = true;
  reportChromeHeight();
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
  { id: 'new-note', label: 'New note', icon: 'plus', run: () => addNewNote() },
  { id: 'new-event', label: 'New event', icon: 'calendar', run: async () => { await ensureClusterEnabled('calendar'); await window.KeepNotesCalendar.newEvent(); } },
  { id: 'add-file', label: 'Add file', icon: 'file-plus', run: () => openAddFiles() },
  { id: 'settings', label: 'Open settings', icon: 'settings', run: () => openSettings() },
  { id: 'open-archive', label: 'Open archive', icon: 'archive', run: () => setView('archive') },
  { id: 'open-notes', label: 'Back to notes', icon: 'sticky-note', run: () => setView('notes') },
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
async function addNewNote() {
  const file = await api.createNote('Note');
  if (currentView !== 'notes') setView('notes');
  await refresh();
  const n = notes.find((x) => x.file === file);
  if (n) openEditor(n);
}

// ---------- add menu ----------
function openAddMenu() {
  $('addMenu').hidden = false;
  $('addBtn').setAttribute('aria-expanded', 'true');
}

function closeAddMenu() {
  $('addMenu').hidden = true;
  $('addBtn').setAttribute('aria-expanded', 'false');
}

function isAddMenuOpen() {
  return !$('addMenu').hidden;
}

$('addBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  if (isAddMenuOpen()) closeAddMenu(); else openAddMenu();
});
document.addEventListener('click', (e) => {
  if (!isAddMenuOpen()) return;
  if (e.target === $('addBtn') || $('addMenu').contains(e.target)) return;
  closeAddMenu();
});

$('addNoteOption').addEventListener('click', () => {
  closeAddMenu();
  addNewNote();
});

$('addEventOption').addEventListener('click', async () => {
  closeAddMenu();
  await ensureClusterEnabled('calendar');
  await window.KeepNotesCalendar.newEvent();
});

$('addFileOption').addEventListener('click', () => {
  closeAddMenu();
  openAddFiles();
});

// ---------- add files (gallery import) ----------
function openAddFiles() {
  $('addFilesOverlay').hidden = false;
}

function closeAddFiles() {
  $('addFilesOverlay').hidden = true;
  $('addFilesDropzone').classList.remove('drag-over');
}

async function importFinished(result) {
  if (!result || !result.imported) return;
  await ensureClusterEnabled('gallery');
  if (clusterMounted.gallery) window.KeepNotesGallery.refresh();
}

$('addFilesDropzone').addEventListener('click', async () => {
  const result = await api.pickAndImportGallery();
  await importFinished(result);
  closeAddFiles();
});
$('addFilesDropzone').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('addFilesDropzone').click(); }
});
$('addFilesDropzone').addEventListener('dragover', (e) => {
  e.preventDefault();
  $('addFilesDropzone').classList.add('drag-over');
});
$('addFilesDropzone').addEventListener('dragleave', () => {
  $('addFilesDropzone').classList.remove('drag-over');
});
$('addFilesDropzone').addEventListener('drop', async (e) => {
  e.preventDefault();
  $('addFilesDropzone').classList.remove('drag-over');
  const files = e.dataTransfer && e.dataTransfer.files;
  if (!files || !files.length) return;
  const paths = [...files].map((f) => api.getPathForFile(f)).filter(Boolean);
  if (!paths.length) return;
  const result = await api.importGalleryFromPaths(paths);
  await importFinished(result);
  closeAddFiles();
});
$('closeAddFilesBtn').addEventListener('click', closeAddFiles);
$('addFilesOverlay').addEventListener('click', (e) => {
  if (e.target === $('addFilesOverlay')) closeAddFiles();
});

$('search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    if (currentView === 'pinned') renderPinnedGrid();
    else renderGrid();
  }, 120);
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

$('archiveBtn').addEventListener('click', async () => {
  current.meta = await api.setNoteMeta(current.file, { archived: !current.meta.archived });
  closeEditor();
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
  $('reminderRepeatInput').value = current.meta.reminderRepeat || 'none';
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
  const repeat = $('reminderRepeatInput').value;
  current.meta = await api.setNoteMeta(current.file, { reminderAt: ms, reminderRepeat: repeat });
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
$('optWidget').addEventListener('change', async (e) => {
  currentSettings = await api.setSettings({ widgetMode: e.target.checked });
  $('optWidget').checked = currentSettings.widgetMode;
  renderClusterSettings(currentSettings);
  applyClusterLayout(currentSettings);
});
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

$('changeGalleryFolderBtn').addEventListener('click', async () => {
  const dir = await api.chooseGalleryFolder();
  if (!dir) return;
  currentSettings = await api.setSettings({ galleryDir: dir });
  $('galleryFolderPath').textContent = dir;
  if (clusterMounted.gallery) window.KeepNotesGallery.refresh();
});

$('resetGalleryFolderBtn').addEventListener('click', async () => {
  currentSettings = await api.setSettings({ galleryDir: null });
  $('galleryFolderPath').textContent = 'Pictures + Videos (default)';
  if (clusterMounted.gallery) window.KeepNotesGallery.refresh();
});

$('galFolderBtn').addEventListener('click', openSettings);

// reload notes when the window regains focus so external .txt edits show up
window.addEventListener('focus', refresh);

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    if ($('paletteOverlay').hidden) openPalette(); else closePalette();
    return;
  }
  if (e.key === 'Escape') {
    if (isAddMenuOpen()) closeAddMenu();
    else if ($('drawerBackdrop').classList.contains('open')) closeDrawer();
    else if (!$('iconPickerOverlay').hidden) closeIconPicker();
    else if (!$('reminderOverlay').hidden) closeReminderOverlay();
    else if (!$('paletteOverlay').hidden) closePalette();
    else if (!$('addFilesOverlay').hidden) closeAddFiles();
    else if (!$('editorOverlay').hidden) closeEditor();
    else if (clusterMounted.calendar && window.KeepNotesCalendar.isOverlayOpen()) window.KeepNotesCalendar.closeOverlay();
    else if (clusterMounted.gallery && window.KeepNotesGallery.isOverlayOpen()) window.KeepNotesGallery.closeOverlay();
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
  currentSettings = s;
  setTheme(s.theme, false);
  $('customTitlebar').hidden = !s.borderless;
  api.getVersion().then((v) => { $('appVersion').textContent = `v${v}`; });

  if (poppedClusterId && CLUSTER_LABELS[poppedClusterId]) {
    document.body.classList.add('popped-mode');
    document.title = `${CLUSTER_LABELS[poppedClusterId]} — KeepNotes`;
    $('customTitlebarTitle').textContent = CLUSTER_LABELS[poppedClusterId];
    setupPoppedHeader(poppedClusterId);
    applyPoppedLayout(poppedClusterId);
  } else {
    applyClusterLayout(s);
    poppedClusterIds = new Set(await api.getPoppedClusters());
    reportChromeHeight();
  }
  await refresh();
}

// The topbar can wrap onto a second line at very narrow widths, changing
// how much room it takes - re-measure after any resize settles.
let chromeResizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(chromeResizeTimer);
  chromeResizeTimer = setTimeout(reportChromeHeight, 150);
});

init();
