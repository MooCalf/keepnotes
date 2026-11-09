const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

async function loadMain(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'memoo-reminder-test-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const handlers = new Map();
  const messages = [];
  const electron = {
    app: { requestSingleInstanceLock: () => false, quit() {}, on() {} },
    protocol: { registerSchemesAsPrivileged() {} },
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    BrowserWindow: { getAllWindows: () => [{ webContents: { send: (...args) => messages.push(args) }, isDestroyed: () => false }] },
    Notification: { isSupported: () => false }
  };
  const context = vm.createContext({
    require: (name) => name === 'electron' ? electron : require(name),
    __dirname: path.join(__dirname, '..'), console, process, URL, Buffer, setInterval, clearInterval, setTimeout
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8'), context);
  context.testNotesDir = dir;
  vm.runInContext('settings = { notesDir: testNotesDir }; registerIpc();', context);
  return { dir, context, messages, setMeta: (patch) => handlers.get('notes:setMeta')(null, 'Trip.txt', patch) };
}

test('countdown preference survives metadata storage and can be disabled', async (t) => {
  const { dir, setMeta } = await loadMain(t);
  const result = await setMeta({ reminderAt: 2000000000000, reminderCountdown: true });
  assert.equal(result.reminderCountdown, true);
  const saved = JSON.parse(await fsp.readFile(path.join(dir, '.keepnotes-meta.json'), 'utf8'));
  assert.equal(saved['Trip.txt'].reminderCountdown, true);
  assert.equal((await setMeta({ reminderCountdown: false })).reminderCountdown, false);
  assert.equal((await setMeta({ reminderCountdown: 'true' })).reminderCountdown, false);
});

test('clearing a reminder also removes its countdown preference', async (t) => {
  const { dir, setMeta } = await loadMain(t);
  await fsp.writeFile(path.join(dir, '.keepnotes-meta.json'), JSON.stringify({
    'Trip.txt': { reminderAt: 2000000000000, reminderCountdown: true, reminderRepeat: 'daily' }
  }));
  const result = await setMeta({ reminderAt: null });
  assert.equal('reminderCountdown' in result, false);
  assert.equal('reminderAt' in result, false);
  assert.equal('reminderRepeat' in result, false);
});

test('countdown is accepted as a cluster with saved custom sizes', async (t) => {
  const { context } = await loadMain(t);
  const result = vm.runInContext("sanitizeSettings({clusters: ['notes', 'countdown'], clusterSizes: {widget: {countdown: 250}, normal: {countdown: 360}}})", context);
  assert.deepEqual(Array.from(result.clusters), ['notes', 'countdown']);
  assert.equal(result.clusterSizes.widget.countdown, 250);
  assert.equal(result.clusterSizes.normal.countdown, 360);
});

test('repeating reminders advance countdown and broadcast to other windows', async (t) => {
  const { dir, context, messages } = await loadMain(t);
  await fsp.writeFile(path.join(dir, 'Trip.txt'), 'Pack bags');
  await fsp.writeFile(path.join(dir, '.keepnotes-meta.json'), JSON.stringify({
    'Trip.txt': { reminderAt: Date.now() - 1000, reminderCountdown: true, reminderRepeat: 'daily' }
  }));
  await vm.runInContext('checkReminders()', context);
  const saved = JSON.parse(await fsp.readFile(path.join(dir, '.keepnotes-meta.json'), 'utf8'))['Trip.txt'];
  assert.ok(saved.reminderAt > Date.now());
  assert.equal(saved.reminderCountdown, true);
  assert.ok(messages.some(([channel, scope]) => channel === 'data:changed' && scope === 'notes'));
});
