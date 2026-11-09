/* Shared countdown rules for note cards and the Count Down cluster. */
(function () {
  function format(reminderAt, now = Date.now()) {
    const total = Math.max(0, Math.ceil((reminderAt - now) / 1000));
    const days = Math.floor(total / 86400);
    const pad = (n) => String(n).padStart(2, '0');
    const clock = `${pad(Math.floor(total / 3600) % 24)}:${pad(Math.floor(total / 60) % 60)}:${pad(total % 60)}`;
    return (days ? `${days}d ` : '') + clock;
  }

  function selectNotes(notes) {
    return notes.filter((note) => note.meta.reminderCountdown === true &&
      Number.isFinite(note.meta.reminderAt))
      .sort((a, b) => a.meta.reminderAt - b.meta.reminderAt || a.file.localeCompare(b.file));
  }

  window.KeepNotesCountdown = { format, selectNotes };
})();
