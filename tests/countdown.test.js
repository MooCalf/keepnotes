const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadCountdown() {
  const context = vm.createContext({ window: {} });
  const source = path.join(__dirname, '../renderer/countdown.js');
  if (fs.existsSync(source)) vm.runInContext(fs.readFileSync(source, 'utf8'), context);
  return context.window.KeepNotesCountdown || {};
}

test('countdown shows days, hours, minutes and seconds without rounding down early', () => {
  const { format } = loadCountdown();
  assert.equal(typeof format, 'function', 'countdown formatter is available');
  assert.equal(format(90061000, 0), '1d 01:01:01');
  assert.equal(format(3661000, 0), '01:01:01');
  assert.equal(format(1, 0), '00:00:01');
});

test('countdown reaches zero and never becomes negative', () => {
  const { format } = loadCountdown();
  assert.equal(typeof format, 'function', 'countdown formatter is available');
  assert.equal(format(1000, 1000), '00:00:00');
  assert.equal(format(1000, 2000), '00:00:00');
  assert.equal(format(5000, 1000), '00:00:04');
  assert.equal(format(5000, 4000), '00:00:01');
});

test('countdown cluster includes every opted-in reminder, ordered soonest first', () => {
  const { selectNotes } = loadCountdown();
  assert.equal(typeof selectNotes, 'function', 'countdown selection is available');
  const notes = [
    { file: 'Later.txt', meta: { reminderCountdown: true, reminderAt: 9000 } },
    { file: 'Ordinary.txt', meta: { reminderAt: 1000 } },
    { file: 'Soon.txt', meta: { reminderCountdown: true, reminderAt: 2000, archived: true } },
    { file: 'Cleared.txt', meta: { reminderCountdown: true } },
    { file: 'Invalid.txt', meta: { reminderCountdown: true, reminderAt: NaN } },
    { file: 'Done.txt', meta: { reminderCountdown: true, reminderAt: 500, reminderNotified: true } }
  ];
  assert.deepEqual(Array.from(selectNotes(notes), (n) => n.file), ['Done.txt', 'Soon.txt', 'Later.txt']);
  assert.equal(notes[0].file, 'Later.txt', 'selection does not reorder the notes grid');
});
