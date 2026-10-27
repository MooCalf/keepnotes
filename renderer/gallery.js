/* MeMoo Gallery cluster. Self-contained module exposing
   window.KeepNotesGallery, same pattern as calendar.js. */
(function () {
  const api = window.keepnotes;
  const $ = (id) => document.getElementById(id);

  let items = [];
  let mounted = false;
  let viewerId = null;
  let searchQuery = ''; // driven by the shared #search topbar input
  let searchTimer = null;

  function icon(name) {
    const span = document.createElement('span');
    span.className = 'icon';
    span.innerHTML = (window.KEEPNOTES_ICONS && window.KEEPNOTES_ICONS[name]) || '';
    return span;
  }

  function formatDate(ms) {
    return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }
  function formatSize(bytes) {
    if (bytes > 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    return Math.round(bytes / 1024) + ' KB';
  }

  function matches(item, q) {
    if (!q) return true;
    const hay = (item.name + ' ' + formatDate(item.mtime) + ' ' + (item.meta.tags || []).join(' ')).toLowerCase();
    return hay.includes(q);
  }

  // ---------- grid ----------
  function renderGrid() {
    const grid = $('galGrid');
    grid.textContent = '';
    let shown = 0;
    for (const item of items) {
      if (!matches(item, searchQuery)) continue;
      shown++;
      grid.appendChild(renderThumb(item));
    }
    $('galEmpty').hidden = shown !== 0;
  }

  function renderThumb(item) {
    const tile = document.createElement('div');
    tile.className = 'gal-thumb';
    tile.title = item.name;
    if (item.kind === 'image') {
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.alt = item.name;
      img.src = `keepnotes-gallery://${item.id}?t=${item.mtime}`;
      tile.appendChild(img);
    } else {
      const canvas = document.createElement('canvas');
      tile.appendChild(canvas);
      captureVideoFrame(item.id, canvas, tile);
      const badge = document.createElement('span');
      badge.className = 'gal-thumb-video-badge';
      badge.appendChild(icon('video'));
      tile.appendChild(badge);
    }
    if (item.meta.pinned) {
      const pin = document.createElement('span');
      pin.className = 'gal-thumb-pin';
      pin.appendChild(icon('pin'));
      tile.appendChild(pin);
    }
    // Details (rename/tags/pin/delete) live one level down, behind a small
    // dedicated button - the tile itself just opens the real file, same as
    // double-clicking it in a normal file explorer would.
    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'gal-thumb-edit-btn';
    editBtn.title = 'Details';
    editBtn.setAttribute('aria-label', 'Edit details');
    editBtn.appendChild(icon('pencil'));
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openViewer(item.id);
    });
    tile.appendChild(editBtn);
    tile.addEventListener('click', () => openInDefaultAppById(item.id));
    return tile;
  }

  // Draws a thumbnail frame straight into the tile's own canvas - the canvas
  // is only ever painted to, never read back (toDataURL/getImageData), so a
  // cross-origin custom-protocol video source never taints anything here.
  function captureVideoFrame(id, canvas, tile) {
    const video = document.createElement('video');
    video.muted = true;
    video.preload = 'metadata';
    video.src = `keepnotes-gallery://${id}`;
    video.addEventListener('loadedmetadata', () => {
      try { video.currentTime = Math.min(1, (video.duration || 2) / 2); } catch { /* unseekable container */ }
    });
    video.addEventListener('seeked', () => {
      canvas.width = video.videoWidth || 160;
      canvas.height = video.videoHeight || 160;
      try { canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height); } catch { /* undecodable frame */ }
    });
    video.addEventListener('error', () => {
      const fallback = document.createElement('div');
      fallback.className = 'gal-thumb-fallback';
      fallback.appendChild(icon('video'));
      canvas.replaceWith(fallback);
    }, { once: true });
    tile._video = video; // keep a reference so it isn't GC'd mid-seek
  }

  async function refresh() {
    items = await api.listGallery();
    renderGrid();
  }

  // ---------- viewer ----------
  function currentItem() {
    return items.find((i) => i.id === viewerId);
  }

  // No inline image/video preview here anymore - actually viewing a file
  // means opening it in the user's own default app (see openInDefaultAppById).
  // This dialog is purely for the details a file browser wouldn't show:
  // rename, tags, pin, delete.
  function openViewer(id) {
    viewerId = id;
    const item = currentItem();
    if (!item) return;
    $('galViewerTitle').value = item.name.replace(/\.[^.]+$/, '');
    $('galViewerMeta').textContent = `${formatDate(item.mtime)} · ${formatSize(item.size)}`;
    $('galViewerTags').value = (item.meta.tags || []).join(', ');
    $('galViewerPinBtn').classList.toggle('is-pinned', !!item.meta.pinned);
    $('galViewerOverlay').hidden = false;
  }

  function closeViewer() {
    $('galViewerOverlay').hidden = true;
    viewerId = null;
  }

  async function saveTitleIfChanged() {
    const item = currentItem();
    if (!item) return;
    const newBase = $('galViewerTitle').value.trim();
    const curBase = item.name.replace(/\.[^.]+$/, '');
    if (!newBase || newBase === curBase) return;
    const res = await api.renameGalleryItem(item.id, newBase);
    viewerId = res.id;
    await refresh();
  }

  async function saveTagsIfChanged() {
    const item = currentItem();
    if (!item) return;
    const tags = $('galViewerTags').value.split(',').map((t) => t.trim()).filter(Boolean);
    const cur = item.meta.tags || [];
    if (tags.length === cur.length && tags.every((t, i) => t === cur[i])) return;
    item.meta = await api.setGalleryMeta(item.id, { tags });
  }

  // Lets app.js's "Pinned Images" nav page (outside this module) stay live
  // when a pin gets toggled or an item deleted from in here.
  function notifyPinnedChanged() {
    if (window.KeepNotesApp && window.KeepNotesApp.onPinnedImagesChanged) {
      window.KeepNotesApp.onPinnedImagesChanged();
    }
  }

  async function togglePin() {
    const item = currentItem();
    if (!item) return;
    item.meta = await api.setGalleryMeta(item.id, { pinned: !item.meta.pinned });
    $('galViewerPinBtn').classList.toggle('is-pinned', !!item.meta.pinned);
    renderGrid();
    notifyPinnedChanged();
  }

  async function deleteCurrent() {
    const item = currentItem();
    if (!item) return;
    if (!confirm(`Move "${item.name}" to the Recycle Bin?`)) return;
    await api.deleteGalleryItem(item.id);
    closeViewer();
    await refresh();
    notifyPinnedChanged();
  }

  // Actually viewing (and editing - crop, rotate, etc.) happens in whatever
  // app Windows already has associated with the file, not in MeMoo.
  async function openInDefaultAppById(id) {
    try {
      await api.openGalleryInDefaultApp(id);
    } catch (err) {
      console.error(err);
    }
  }

  function wire() {
    // The topbar search bar is shared across clusters; each cluster module
    // listens for itself so app.js doesn't need to know gallery internals.
    $('search').addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        searchQuery = $('search').value.trim().toLowerCase();
        renderGrid();
      }, 120);
    });
    $('galViewerCloseBtn').addEventListener('click', closeViewer);
    $('galViewerOverlay').addEventListener('click', (e) => {
      if (e.target === $('galViewerOverlay')) closeViewer();
    });
    $('galViewerTitle').addEventListener('change', saveTitleIfChanged);
    $('galViewerTags').addEventListener('change', saveTagsIfChanged);
    $('galViewerPinBtn').addEventListener('click', togglePin);
    $('galDeleteBtn').addEventListener('click', deleteCurrent);
    $('galOpenBtn').addEventListener('click', () => {
      const item = currentItem();
      if (item) openInDefaultAppById(item.id);
    });
  }

  // Cross-window sync: if this cluster is mounted here (main window or its
  // own popped-out window), pick up gallery changes made anywhere else.
  api.onDataChanged((_e, scope) => {
    if (scope === 'gallery' && mounted) refresh();
  });

  window.KeepNotesGallery = {
    async mount() {
      if (mounted) { await refresh(); return; }
      mounted = true;
      searchQuery = ($('search').value || '').trim().toLowerCase();
      wire();
      await refresh();
    },
    async refresh() {
      if (!mounted) return;
      await refresh();
    },
    isOverlayOpen() {
      return !$('galViewerOverlay').hidden;
    },
    closeOverlay: closeViewer,
    // Used by app.js's "Pinned Images" nav page - independent of whether the
    // Gallery cluster's own panel is enabled, so pinned images stay reachable
    // even with that cluster switched off. Reuses this module's own thumbnail
    // renderer and viewer, so clicking one opens the exact same editor.
    async renderPinnedInto(container, query) {
      const list = mounted ? items : (items = await api.listGallery());
      const q = (query || '').trim().toLowerCase();
      container.textContent = '';
      let shown = 0;
      for (const item of list) {
        if (!item.meta.pinned) continue;
        if (!matches(item, q)) continue;
        shown++;
        container.appendChild(renderThumb(item));
      }
      return shown;
    }
  };
})();
