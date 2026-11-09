const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

function loadMain(t, borderless = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memoo-widget-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const workArea = { x: 100, y: 50, width: 1280, height: 720 };
  const windows = [];
  class Window extends EventEmitter {
    constructor(options) {
      super();
      this.frame = options.frame === false ? { x: 0, y: 0, width: 0, height: 0 } : { x: 8, y: 31, width: 16, height: 39 };
      this.webContents = { on() {}, send() {}, setWindowOpenHandler() {} };
      this.bounds = { x: 200, y: 100, width: 996, height: 739 };
      this.setContentBounds({ x: options.x ?? 208, y: options.y ?? 131, width: options.width, height: options.height });
      windows.push(this);
    }
    getBounds() { return { ...this.bounds }; }
    getContentBounds() {
      const b = this.bounds;
      return { x: b.x + this.frame.x, y: b.y + this.frame.y, width: b.width - this.frame.width, height: b.height - this.frame.height };
    }
    setContentBounds(b) {
      this.setBounds({ x: b.x - this.frame.x, y: b.y - this.frame.y, width: b.width + this.frame.width, height: b.height + this.frame.height });
    }
    setBounds(b) { this.bounds = { ...b }; this.emit('resize'); this.emit('moved'); }
    isDestroyed() { return false; }
    isMaximized() { return false; }
    setSkipTaskbar() {}
    setAlwaysOnTop() {}
    loadFile() {}
  }
  const electron = {
    app: { requestSingleInstanceLock: () => false, quit() {}, on() {}, getPath: () => dir },
    protocol: { registerSchemesAsPrivileged() {} },
    screen: { getPrimaryDisplay: () => ({ workArea }), getDisplayMatching: () => ({ workArea }) },
    BrowserWindow: Window
  };
  const context = vm.createContext({
    require: (name) => name === 'electron' ? electron : require(name),
    __dirname: path.join(__dirname, '..'), process, console, URL, Buffer, setTimeout, setInterval, clearInterval
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8'), context);
  context.testBorderless = borderless;
  vm.runInContext("settings = {...defaultSettings(), widgetMode: true, borderless: testBorderless, clusters: ['notes', 'calendar', 'countdown'], clusterSizes: {widget: {notes: 4000, calendar: 4000, countdown: 4000}}}; chromeHeight = 100; createWindow();", context);
  return { context, windows, workArea };
}

function assertFits(window, area) {
  const b = window.getBounds();
  assert.ok(b.y >= area.y + 16, `window top ${b.y} must stay below ${area.y + 16}`);
  assert.ok(b.y + b.height <= area.y + area.height - 16, 'window bottom must stay above taskbar margin');
  assert.ok(b.height <= area.height - 32, 'outer height includes frame and both margins');
}

for (const borderless of [false, true]) {
  test(`oversized ${borderless ? 'borderless' : 'framed'} widget fits the usable screen`, (t) => {
    const { windows, workArea } = loadMain(t, borderless);
    assertFits(windows[0], workArea);
  });
}

test('manual resize and move cannot push a widget above or below the screen', (t) => {
  const { windows, workArea } = loadMain(t);
  windows[0].setBounds({ x: 500, y: -200, width: 336, height: 1600 });
  assertFits(windows[0], workArea);
  windows[0].setBounds({ x: 500, y: 700, width: 336, height: 300 });
  assertFits(windows[0], workArea);
});

test('popped-out widgets also include their frame when limiting height', (t) => {
  const { context, windows, workArea } = loadMain(t);
  vm.runInContext("createClusterWindow('countdown')", context);
  assertFits(windows[1], workArea);
  windows[1].setBounds({ x: 500, y: -200, width: 336, height: 2000 });
  assertFits(windows[1], workArea);
});

test('normal windows remain freely resizable', (t) => {
  const { context, windows } = loadMain(t);
  vm.runInContext('settings.widgetMode = false; applyLayout()', context);
  windows[0].setBounds({ x: 200, y: -200, width: 980, height: 1600 });
  assert.equal(windows[0].getBounds().height, 1600);
});
