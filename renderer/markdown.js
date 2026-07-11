/* KeepNotes preview renderer.
   Builds DOM directly (createElement/textContent), never innerHTML of note
   text, so a note's content can never inject markup - same invariant as
   the rest of the renderer. Supports: checklists (existing [ ]/[x] syntax),
   #/##/### headers, - bullet lists, **bold**, *italic*, `code`,
   ![alt](.attachments/file.ext) images (local attachments only),
   [[Wikilinks]], and #tags. */

(function () {
  const CHECK_RE = /^\[( |x|X)\]\s?(.*)$/;
  const HEADER_RE = /^(#{1,3})\s+(.*)$/;
  const BULLET_RE = /^[-*]\s+(.*)$/;
  const IMAGE_SRC_RE = /^\.attachments\/([\w-]{1,90}\.(?:png|jpe?g|gif|webp))$/i;
  const WIKILINK_RE = /\[\[([^\]|]+)\]\]/g;
  const TAG_RE = /(?<=^|\s)#([A-Za-z0-9_-]{2,40})/g;
  const INLINE_RE = /!\[([^\]]*)\]\(([^)\s]+)\)|\[\[([^\]|]+)\]\]|\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`|(?<=^|\s)#([A-Za-z0-9_-]{2,40})/g;

  function extractWikilinks(text) {
    const out = new Set();
    let m;
    WIKILINK_RE.lastIndex = 0;
    while ((m = WIKILINK_RE.exec(text))) out.add(m[1].trim());
    return out;
  }

  function extractTags(text) {
    const out = new Set();
    let m;
    TAG_RE.lastIndex = 0;
    while ((m = TAG_RE.exec(text))) out.add(m[1].toLowerCase());
    return out;
  }

  function renderInline(text, parent, opts) {
    INLINE_RE.lastIndex = 0;
    let last = 0;
    let m;
    while ((m = INLINE_RE.exec(text))) {
      if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
      if (m[1] !== undefined) {
        // image: alt = m[1], src = m[2]
        const srcMatch = m[2].match(IMAGE_SRC_RE);
        if (srcMatch) {
          const img = document.createElement('img');
          img.className = 'md-image';
          img.src = `keepnotes-asset://${srcMatch[1]}`;
          img.alt = m[1] || '';
          parent.appendChild(img);
        } else {
          parent.appendChild(document.createTextNode(m[0]));
        }
      } else if (m[3] !== undefined) {
        const title = m[3].trim();
        const a = document.createElement('a');
        a.href = '#';
        a.className = 'wikilink' + (opts.isKnownTitle && !opts.isKnownTitle(title) ? ' unresolved' : '');
        a.textContent = title;
        a.addEventListener('click', (e) => {
          e.preventDefault();
          if (opts.onWikilinkClick) opts.onWikilinkClick(title);
        });
        parent.appendChild(a);
      } else if (m[4] !== undefined) {
        const b = document.createElement('strong');
        b.textContent = m[4];
        parent.appendChild(b);
      } else if (m[5] !== undefined) {
        const i = document.createElement('em');
        i.textContent = m[5];
        parent.appendChild(i);
      } else if (m[6] !== undefined) {
        const c = document.createElement('code');
        c.textContent = m[6];
        parent.appendChild(c);
      } else if (m[7] !== undefined) {
        const tag = m[7];
        const span = document.createElement('span');
        span.className = 'tag';
        span.textContent = `#${tag}`;
        span.addEventListener('click', (e) => {
          e.preventDefault();
          if (opts.onTagClick) opts.onTagClick(tag.toLowerCase());
        });
        parent.appendChild(span);
      }
      last = INLINE_RE.lastIndex;
    }
    if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
  }

  function renderInto(container, text, opts) {
    opts = opts || {};
    container.textContent = '';
    const lines = text.split('\n');
    let list = null;

    for (const line of lines) {
      const checkMatch = line.match(CHECK_RE);
      const bulletMatch = !checkMatch && line.match(BULLET_RE);
      if (!bulletMatch) list = null;

      if (checkMatch) {
        const done = checkMatch[1].toLowerCase() === 'x';
        const row = document.createElement('label');
        row.className = 'check' + (done ? ' done' : '');
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = done;
        cb.addEventListener('click', (e) => {
          e.stopPropagation();
          if (opts.onToggleLine) opts.onToggleLine(line);
        });
        const span = document.createElement('span');
        renderInline(checkMatch[2], span, opts);
        row.append(cb, span);
        container.appendChild(row);
        continue;
      }

      const headerMatch = line.match(HEADER_RE);
      if (headerMatch) {
        const h = document.createElement(`h${headerMatch[1].length}`);
        h.className = 'md-heading';
        renderInline(headerMatch[2], h, opts);
        container.appendChild(h);
        continue;
      }

      if (bulletMatch) {
        if (!list) {
          list = document.createElement('ul');
          list.className = 'md-list';
          container.appendChild(list);
        }
        const li = document.createElement('li');
        renderInline(bulletMatch[1], li, opts);
        list.appendChild(li);
        continue;
      }

      if (line.trim() === '') {
        const spacer = document.createElement('div');
        spacer.className = 'md-blank';
        container.appendChild(spacer);
        continue;
      }

      const p = document.createElement('div');
      p.className = 'md-p';
      renderInline(line, p, opts);
      container.appendChild(p);
    }
  }

  window.KeepNotesMarkdown = { renderInto, extractWikilinks, extractTags };
})();
