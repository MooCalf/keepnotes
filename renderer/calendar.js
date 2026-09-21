/* KeepNotes Calendar cluster. Self-contained module (own $ and icon()
   helpers, like markdown.js) exposing window.KeepNotesCalendar so app.js
   can mount/refresh it and route reminder clicks into it without either
   file needing to know the other's internals. */
(function () {
  const api = window.keepnotes;
  const $ = (id) => document.getElementById(id);

  let events = [];
  let viewYear = 0;
  let viewMonth = 0; // 0-based
  let editingId = null; // null while creating a new event
  let editingColor = null; // color picked in the currently-open event editor
  let mounted = false;
  let searchQuery = ''; // driven by the shared #search topbar input
  let searchTimer = null;

  // Same swatch palette as notes (see COLORS in app.js) - kept as its own
  // copy since each cluster module is self-contained and loads before app.js.
  const EVENT_COLORS = ['paper', 'sun', 'mint', 'sky', 'blush', 'lilac'];

  function icon(name) {
    const span = document.createElement('span');
    span.className = 'icon';
    span.innerHTML = (window.KEEPNOTES_ICONS && window.KEEPNOTES_ICONS[name]) || '';
    return span;
  }

  const pad = (n) => String(n).padStart(2, '0');
  const dateKey = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;

  function eventsByDate() {
    const map = new Map();
    for (const ev of events) {
      if (!map.has(ev.date)) map.set(ev.date, []);
      map.get(ev.date).push(ev);
    }
    return map;
  }

  function matchesSearch(ev) {
    if (!searchQuery) return true;
    const hay = (ev.title + ' ' + (ev.notes || '')).toLowerCase();
    return hay.includes(searchQuery);
  }

  function formatEventWhen(ev) {
    const d = new Date(`${ev.date}T00:00:00`);
    let s = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    if (ev.time) {
      const [h, m] = ev.time.split(':').map(Number);
      const t = new Date();
      t.setHours(h, m, 0, 0);
      s += ' · ' + t.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    }
    return s;
  }

  function renderMonthLabel() {
    const d = new Date(viewYear, viewMonth, 1);
    $('calMonthLabel').textContent = d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  }

  function renderGrid() {
    const grid = $('calGrid');
    grid.textContent = '';
    const byDate = eventsByDate();
    const startOffset = new Date(viewYear, viewMonth, 1).getDay(); // 0 = Sun
    const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
    const daysInPrevMonth = new Date(viewYear, viewMonth, 0).getDate();
    const today = new Date();
    const todayKey = dateKey(today.getFullYear(), today.getMonth(), today.getDate());

    const cells = [];
    for (let i = 0; i < startOffset; i++) {
      cells.push({ day: daysInPrevMonth - startOffset + 1 + i, outside: true });
    }
    for (let d = 1; d <= daysInMonth; d++) cells.push({ day: d, outside: false });
    let trailing = 1;
    while (cells.length < 42) cells.push({ day: trailing++, outside: true });

    for (const cell of cells) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'cal-day' + (cell.outside ? ' outside' : '');
      let key = null;
      if (!cell.outside) {
        key = dateKey(viewYear, viewMonth, cell.day);
        if (key === todayKey) btn.classList.add('today');
        const dayEvents = byDate.get(key);
        if (dayEvents && dayEvents.length) {
          // The whole day box is tinted by an event's color instead of just
          // a small dot - if several events land on the same day, the first
          // one with an explicit color wins; otherwise a neutral accent tint
          // still marks the day as having something on it.
          const colored = dayEvents.find((e) => e.color);
          btn.classList.add(colored ? `color-${colored.color}` : 'color-default');
        }
        if (searchQuery && dayEvents && dayEvents.some(matchesSearch)) btn.classList.add('search-match');
      }
      btn.textContent = cell.day;
      btn.addEventListener('click', () => { if (!cell.outside) openEditor(null, key); });
      grid.appendChild(btn);
    }
  }

  function renderUpcomingList() {
    const list = $('calEventList');
    list.textContent = '';
    const now = Date.now();
    const upcoming = events
      .filter(matchesSearch)
      .map((ev) => ({ ev, ts: new Date(`${ev.date}T${ev.time || '00:00'}:00`).getTime() }))
      .filter((x) => !Number.isNaN(x.ts) && x.ts >= now - 24 * 60 * 60 * 1000)
      .sort((a, b) => a.ts - b.ts)
      .slice(0, 20);

    if (upcoming.length === 0) {
      const e = document.createElement('div');
      e.className = 'cal-event-empty';
      e.textContent = searchQuery ? 'No matching events' : 'No upcoming events';
      list.appendChild(e);
      return;
    }
    for (const { ev } of upcoming) {
      const item = document.createElement('div');
      item.className = 'cal-event-item';
      const dot = document.createElement('span');
      dot.className = 'cal-event-dot';
      const info = document.createElement('div');
      info.className = 'cal-event-info';
      const title = document.createElement('div');
      title.className = 'cal-event-title';
      title.textContent = ev.title;
      const when = document.createElement('div');
      when.className = 'cal-event-when';
      when.textContent = formatEventWhen(ev);
      info.append(title, when);
      item.append(dot, info);
      item.addEventListener('click', () => openEditor(ev.id));
      list.appendChild(item);
    }
  }

  function render() {
    renderMonthLabel();
    renderGrid();
    renderUpcomingList();
  }

  async function refresh() {
    events = await api.listEvents();
    render();
  }

  function toDatetimeLocalValue(ms) {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function renderEventSwatches() {
    const wrap = $('calEventSwatches');
    wrap.textContent = '';
    const defaultBtn = document.createElement('button');
    defaultBtn.type = 'button';
    defaultBtn.className = 'swatch swatch-default' + (editingColor ? '' : ' active');
    defaultBtn.title = 'Default';
    defaultBtn.addEventListener('click', () => { editingColor = null; renderEventSwatches(); });
    wrap.appendChild(defaultBtn);
    for (const c of EVENT_COLORS) {
      const b = document.createElement('button');
      b.className = 'swatch' + (c === editingColor ? ' active' : '');
      b.title = c;
      b.style.background = getComputedStyle(document.documentElement).getPropertyValue(`--card-${c}`);
      b.addEventListener('click', () => { editingColor = c; renderEventSwatches(); });
      wrap.appendChild(b);
    }
  }

  function openEditor(id, presetDate) {
    editingId = id;
    const ev = id ? events.find((e) => e.id === id) : null;
    $('calEventHeading').textContent = ev ? 'Edit event' : 'New event';
    $('calEventTitle').value = ev ? ev.title : '';
    $('calEventDate').value = ev ? ev.date : (presetDate || dateKey(viewYear, viewMonth, new Date().getDate()));
    $('calEventTime').value = (ev && ev.time) || '';
    $('calEventNotes').value = (ev && ev.notes) || '';
    editingColor = (ev && ev.color) || null;
    renderEventSwatches();
    $('calEventReminder').value = ev && typeof ev.reminderAt === 'number' ? toDatetimeLocalValue(ev.reminderAt) : '';
    $('calEventRepeat').value = (ev && ev.reminderRepeat) || 'none';
    $('calEventDeleteBtn').hidden = !ev;
    $('calEventOverlay').hidden = false;
    $('calEventTitle').focus();
  }

  function closeEditor() {
    $('calEventOverlay').hidden = true;
    editingId = null;
  }

  async function saveEditor() {
    const date = $('calEventDate').value;
    if (!date) { $('calEventDate').focus(); return; }
    const patch = {
      date,
      time: $('calEventTime').value || null,
      title: $('calEventTitle').value.trim() || 'Event',
      notes: $('calEventNotes').value,
      color: editingColor
    };
    const reminderVal = $('calEventReminder').value;
    if (reminderVal) {
      const ms = new Date(reminderVal).getTime();
      if (!Number.isNaN(ms)) {
        patch.reminderAt = ms;
        patch.reminderRepeat = $('calEventRepeat').value;
      }
    } else {
      patch.reminderAt = null;
      patch.reminderRepeat = 'none';
    }

    if (editingId) await api.updateEvent(editingId, patch);
    else await api.createEvent(patch);
    closeEditor();
    await refresh();
  }

  async function deleteEditingEvent() {
    if (!editingId) return;
    if (!confirm('Delete this event?')) return;
    await api.deleteEvent(editingId);
    closeEditor();
    await refresh();
  }

  function wire() {
    $('calAddEventBtn').addEventListener('click', () => openEditor(null));
    // The topbar search bar is shared across clusters; each cluster module
    // listens for itself so app.js doesn't need to know calendar internals.
    $('search').addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        searchQuery = $('search').value.trim().toLowerCase();
        render();
      }, 120);
    });
    $('calPrevBtn').addEventListener('click', () => {
      viewMonth -= 1;
      if (viewMonth < 0) { viewMonth = 11; viewYear -= 1; }
      render();
    });
    $('calNextBtn').addEventListener('click', () => {
      viewMonth += 1;
      if (viewMonth > 11) { viewMonth = 0; viewYear += 1; }
      render();
    });
    $('calEventCancelBtn').addEventListener('click', closeEditor);
    $('calEventSaveBtn').addEventListener('click', saveEditor);
    $('calEventDeleteBtn').addEventListener('click', deleteEditingEvent);
    $('calEventOverlay').addEventListener('click', (e) => {
      if (e.target === $('calEventOverlay')) closeEditor();
    });
  }

  // Cross-window sync: if this cluster is mounted here (main window or its
  // own popped-out window), pick up calendar changes made anywhere else -
  // another window, or the background reminder scheduler in main.js.
  api.onDataChanged((_e, scope) => {
    if (scope === 'calendar' && mounted) refresh();
  });

  window.KeepNotesCalendar = {
    async mount() {
      if (mounted) { await refresh(); return; }
      mounted = true;
      const now = new Date();
      viewYear = now.getFullYear();
      viewMonth = now.getMonth();
      searchQuery = ($('search').value || '').trim().toLowerCase();
      wire();
      await refresh();
    },
    async refresh() {
      if (!mounted) return;
      await refresh();
    },
    isOverlayOpen() {
      return !$('calEventOverlay').hidden;
    },
    closeOverlay: closeEditor,
    async openEvent(id) {
      if (!mounted) await window.KeepNotesCalendar.mount();
      else if (!events.some((e) => e.id === id)) await refresh();
      openEditor(id);
    },
    // Entry point for the topbar Add menu / command palette, independent of
    // whether the user got here by clicking the panel's own + button.
    async newEvent() {
      if (!mounted) await window.KeepNotesCalendar.mount();
      openEditor(null);
    }
  };
})();
