// Run with: node_modules/.bin/electron tests/electron-countdown.cjs
// Uses real Electron rendering and IPC with disposable notes and settings.
const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'memoo-countdown-ui-'));
app.setPath('userData', path.join(temp, 'profile'));
app.disableHardwareAcceleration();
let mainWindow;
const errors = [];

async function waitFor(window, expression) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await window.webContents.executeJavaScript(expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out: ${expression}`);
}

app.whenReady().then(async () => {
  const electron = require('electron');
  const context = vm.createContext({
    require: (name) => name === 'electron' ? {
      ...electron,
      protocol: { registerSchemesAsPrivileged() {} },
      app: {
        requestSingleInstanceLock: () => false, quit() {}, on() {},
        getPath: () => temp, getVersion: () => require('../package.json').version, isPackaged: false
      }
    } : require(name),
    __dirname: root, console, process, URL, Buffer, setInterval, clearInterval, setTimeout
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'main.js'), 'utf8'), context);
  context.testNotesDir = temp;
  vm.runInContext("settings = {...defaultSettings(), notesDir: testNotesDir, clusters: ['notes', 'countdown'], theme: 'dark-slate'}; registerIpc();", context);
  const at = Date.now() + 90061000;
  fs.writeFileSync(path.join(temp, 'Trip.txt'), 'Private note body must not appear in the countdown cluster.');
  fs.writeFileSync(path.join(temp, 'Ordinary.txt'), 'Regular reminder');
  fs.writeFileSync(path.join(temp, '.keepnotes-meta.json'), JSON.stringify({
    'Trip.txt': { reminderAt: at, reminderCountdown: true },
    'Ordinary.txt': { reminderAt: at }
  }));
  mainWindow = new BrowserWindow({
    show: false, width: 1000, height: 700, useContentSize: true,
    webPreferences: { preload: path.join(root, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false }
  });
  mainWindow.webContents.on('console-message', (_event, level, message) => {
    if (level === 3) errors.push(message);
  });
  const run = (code) => mainWindow.webContents.executeJavaScript(code);
  await mainWindow.loadFile(path.join(root, 'renderer/index.html'));
  await waitFor(mainWindow, "document.querySelectorAll('.countdown-item').length === 1");
  assert.deepEqual(await run("Array.from(document.querySelector('.countdown-item').children, el => el.className)"), ['countdown-title', 'countdown-timer']);
  assert.equal(await run("document.querySelector('.countdown-title').textContent"), 'Trip');
  assert.equal(await run("document.getElementById('countdownList').textContent.includes('Private note body')"), false);
  const before = await run("document.querySelector('.countdown-timer').textContent");
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.notEqual(await run("document.querySelector('.countdown-timer').textContent"), before, 'timer ticks live');
  await run("document.querySelector('.countdown-item').click(); document.getElementById('reminderBtn').click()");
  assert.equal(await run("document.getElementById('reminderCountdownBtn').getAttribute('aria-pressed')"), 'true');
  await run("document.getElementById('reminderCountdownBtn').click(); document.getElementById('reminderCancelBtn').click(); document.getElementById('reminderBtn').click()");
  assert.equal(await run("document.getElementById('reminderCountdownBtn').getAttribute('aria-pressed')"), 'true', 'Cancel discards the toggle change');

  // A narrow widget must keep every control inside the reminder card.
  mainWindow.setContentSize(320, 650);
  await run("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  assert.equal(await run(`(() => {
    const card = document.querySelector('#reminderOverlay .card').getBoundingClientRect();
    return Array.from(document.querySelectorAll('#reminderOverlay button')).every(button => {
      const rect = button.getBoundingClientRect();
      return rect.left >= card.left && rect.right <= card.right && rect.bottom <= card.bottom;
    });
  })()`), true, 'reminder controls fit a narrow widget');
  assert.equal(await run("document.getElementById('reminderCancelBtn').getBoundingClientRect().top === document.getElementById('reminderSaveBtn').getBoundingClientRect().top"), true, 'Cancel and Save stay together on narrow widgets');
  fs.writeFileSync(path.join(temp, 'reminder.png'), (await mainWindow.webContents.capturePage()).toPNG());

  await run("document.getElementById('reminderCountdownBtn').click(); document.getElementById('reminderSaveBtn').click()");
  await waitFor(mainWindow, "document.getElementById('reminderOverlay').hidden && document.querySelectorAll('.countdown-item').length === 0");
  assert.equal(JSON.parse(fs.readFileSync(path.join(temp, '.keepnotes-meta.json')))['Trip.txt'].reminderCountdown, false);
  await run("document.getElementById('reminderBtn').click(); document.getElementById('reminderCountdownBtn').click(); document.getElementById('reminderSaveBtn').click()");
  await waitFor(mainWindow, "document.getElementById('reminderOverlay').hidden && document.querySelectorAll('.countdown-item').length === 1");
  await run("document.getElementById('editorOverlay').hidden = true");
  await run("window.keepnotes.setSettings({widgetMode: true})");
  await run("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  fs.writeFileSync(path.join(temp, 'cluster.png'), (await mainWindow.webContents.capturePage()).toPNG());

  // Use the production pop-out handler and verify cross-window updates.
  assert.equal(await run("window.keepnotes.popOutCluster('countdown')"), true);
  const popped = BrowserWindow.getAllWindows().find((window) => window !== mainWindow);
  popped.hide();
  await waitFor(popped, "document.querySelectorAll('.countdown-item').length === 1");
  assert.equal(await popped.webContents.executeJavaScript("document.querySelectorAll('[data-cluster=countdown] .cluster-header').length"), 1);
  await run("Array.from(document.querySelectorAll('.note')).find(note => note.querySelector('.note-title').textContent === 'Trip').click(); document.getElementById('reminderBtn').click(); document.getElementById('reminderClearBtn').click()");
  await waitFor(popped, "document.querySelectorAll('.countdown-item').length === 0");
  assert.equal('reminderCountdown' in JSON.parse(fs.readFileSync(path.join(temp, '.keepnotes-meta.json')))['Trip.txt'], false);
  assert.deepEqual(errors, [], 'renderer has no console errors');

  // Exercise native frame measurements and resize events, not only fixtures.
  context.testWindow = mainWindow;
  vm.runInContext("win = testWindow; settings.widgetMode = true; settings.clusterSizes = {widget: {notes: 4000}}; guardWidgetBounds(win, () => settings.widgetMode); applyLayout();", context);
  const { workArea } = require('electron').screen.getDisplayMatching(mainWindow.getBounds());
  const fits = (window) => {
    const bounds = window.getBounds();
    assert.ok(bounds.y >= workArea.y + 16, 'native widget titlebar stays on screen');
    assert.ok(bounds.y + bounds.height <= workArea.y + workArea.height - 16, 'native widget bottom stays on screen');
  };
  fits(mainWindow);
  mainWindow.setBounds({ ...mainWindow.getBounds(), y: workArea.y - 300, height: workArea.height * 2 });
  await new Promise((resolve) => setTimeout(resolve, 150));
  fits(mainWindow);
  popped.setBounds({ ...popped.getBounds(), y: workArea.y - 300, height: workArea.height * 2 });
  await new Promise((resolve) => setTimeout(resolve, 150));
  fits(popped);
  console.log(`Electron countdown checks passed. Screenshots: ${temp}`);
  for (const window of BrowserWindow.getAllWindows()) window.destroy();
  app.exit(0);
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
