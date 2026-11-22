// SPDX-License-Identifier: GPL-3.0-only
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { crc32, inflateSync } from 'node:zlib';
import { Preferences } from '../apps/desktop/preferences.mjs';
import {
  MENU_BAR_DEFAULTS,
  MOODS,
  MacMenuBar,
  MenuBarPanel,
  PANEL_WIDTH,
  encodePng,
  macosAppMenuTemplate,
  menuBarIconLayers,
  menuBarMood,
  nextTimerRemaining,
  panelBounds,
  panelRequest,
  panelUrl,
  rasterizeMenuBarIcon,
  shortModelName,
  timerTitle,
  validateMenuBarSettings,
} from '../apps/desktop/main/macos-menu-bar.mjs';

const source = JSON.parse(
  readFileSync(new URL('../apps/desktop/locales/en.json', import.meta.url), 'utf8'),
).messages;
const alphaAt = ({ width, rgba }, x, y) => rgba[(y * width + x) * 4 + 3];

test('menu bar settings default to the Dock, the glitch bolt and her mood', () => {
  assert.deepEqual(validateMenuBarSettings({}), {
    showInDock: true,
    iconStyle: 'glitch',
    showMood: true,
  });
  assert.deepEqual(validateMenuBarSettings({ showInDock: false, iconStyle: 'color' }), {
    ...MENU_BAR_DEFAULTS,
    showInDock: false,
    iconStyle: 'color',
  });
  for (const bad of [
    null,
    [],
    { iconStyle: 'neon' },
    { showMood: 'yes' },
    { showInDock: 1 },
    { openAtLogin: true },
    { extra: true },
  ])
    assert.throws(() => validateMenuBarSettings(bad), /Invalid menu bar settings/);
});

test('the template icon is her bolt in one color at 1x and 2x for every mood', () => {
  for (const style of ['glitch', 'plain'])
    for (const mood of MOODS) {
      const one = rasterizeMenuBarIcon({ style, mood }, 1);
      const two = rasterizeMenuBarIcon({ style, mood }, 2);
      assert.equal(one.height, 18);
      assert.equal(two.height, 36);
      assert.equal(two.width, one.width * 2);
      for (let i = 0; i < two.rgba.length; i += 4)
        assert.deepEqual([...two.rgba.subarray(i, i + 3)], [0, 0, 0], 'template images are black');
    }
  const idle = rasterizeMenuBarIcon({ style: 'glitch', mood: 'idle' }, 2);
  assert.equal(idle.width, 34, 'idle stays compact');
  // The bolt's body (viewBox 20, 22) is solid and its top-left corner is empty.
  assert.equal(alphaAt(idle, 15, 15), 255);
  assert.equal(alphaAt(idle, 1, 1), 0);
  // Only the glitch style has the offset copy behind the bolt, as a lighter layer.
  const plain = rasterizeMenuBarIcon({ style: 'plain', mood: 'idle' }, 2);
  const ghost = [20, 22];
  assert.ok(alphaAt(idle, ...ghost) > 60 && alphaAt(idle, ...ghost) < 200);
  assert.equal(alphaAt(plain, ...ghost), 0);
  const asleep = rasterizeMenuBarIcon({ style: 'glitch', mood: 'asleep' }, 2);
  assert.ok(alphaAt(asleep, 15, 15) < 120, 'asleep dims the bolt');
  assert.ok(asleep.width > idle.width, 'asleep adds the small z');
  for (const mood of ['listening', 'thinking'])
    assert.ok(rasterizeMenuBarIcon({ mood }, 2).width > idle.width + 16, mood + ' adds a glyph');
  const flicker = [0, 1].map((frame) => rasterizeMenuBarIcon({ mood: 'speaking', frame }, 2));
  assert.equal(flicker[0].width, idle.width, 'speaking keeps the icon width');
  assert.notDeepEqual(flicker[0].rgba, flicker[1].rgba, 'speaking flickers between frames');
  assert.throws(() => menuBarIconLayers({ style: 'color' }), /template icon style/);
  assert.throws(() => menuBarIconLayers({ mood: 'angry' }), /mood/);
});

test('the icon PNG encoder writes valid chunks and the exact pixels', () => {
  const image = rasterizeMenuBarIcon({ mood: 'thinking' }, 2);
  const png = encodePng(image);
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const chunks = [];
  for (let offset = 8; offset < png.length; ) {
    const length = png.readUInt32BE(offset);
    const body = png.subarray(offset + 4, offset + 8 + length);
    assert.equal(png.readUInt32BE(offset + 8 + length), crc32(body), 'chunk CRC');
    chunks.push({ type: body.subarray(0, 4).toString('ascii'), data: body.subarray(4) });
    offset += 12 + length;
  }
  assert.deepEqual(
    chunks.map(({ type }) => type),
    ['IHDR', 'IDAT', 'IEND'],
  );
  assert.equal(chunks[0].data.readUInt32BE(0), image.width);
  assert.equal(chunks[0].data.readUInt32BE(4), image.height);
  assert.deepEqual([...chunks[0].data.subarray(8)], [8, 6, 0, 0, 0]);
  const rows = inflateSync(chunks[1].data);
  const stride = image.width * 4 + 1;
  for (let y = 0; y < image.height; y++) {
    assert.equal(rows[y * stride], 0, 'no row filter');
    assert.deepEqual(
      rows.subarray(y * stride + 1, (y + 1) * stride),
      image.rgba.subarray(y * image.width * 4, (y + 1) * image.width * 4),
    );
  }
});

test('mood, timer text and model names for the menu bar', () => {
  assert.equal(menuBarMood({}), 'idle');
  assert.equal(menuBarMood({ listening: true }), 'listening');
  assert.equal(menuBarMood({ listening: true, thinking: true }), 'thinking');
  assert.equal(menuBarMood({ thinking: true, speaking: true }), 'speaking');
  assert.equal(menuBarMood({ asleep: true, speaking: true, listening: true }), 'asleep');
  assert.equal(timerTitle(299_000), '04:59');
  assert.equal(timerTitle(298_200), '04:59', 'rounds up to whole seconds');
  assert.equal(timerTitle(0), '00:00');
  assert.equal(timerTitle(3_723_000), '1:02:03');
  assert.equal(timerTitle(null), '');
  assert.equal(timerTitle(-1), '');
  assert.equal(
    nextTimerRemaining([
      { kind: 'stopwatch', state: 'running', remainingMs: null },
      { kind: 'timer', state: 'paused', remainingMs: 1000 },
      { kind: 'timer', state: 'running', remainingMs: 90_000 },
      { kind: 'timer', state: 'running', remainingMs: 30_000 },
      { kind: 'reminder', state: 'running', remainingMs: 5_000 },
    ]),
    30_000,
  );
  assert.equal(nextTimerRemaining([]), null);
  assert.equal(nextTimerRemaining(undefined), null);
  assert.equal(shortModelName('unsloth/Qwen3.5-4B-GGUF'), 'Qwen3.5 4B');
  assert.equal(shortModelName('capri-qwen3.5:4b'), 'qwen3.5 4b');
  assert.equal(shortModelName('gpt-4.1-mini'), 'gpt 4.1 mini');
  assert.equal(shortModelName(''), '');
  assert.equal(shortModelName(undefined), '');
});

function menuFixture(state = {}) {
  const calls = [];
  const action = (name) => (value) => calls.push(value === undefined ? [name] : [name, value]);
  const used = new Set();
  const template = macosAppMenuTemplate({
    text: (key) => {
      used.add(key);
      return `<${key}>`;
    },
    state: {
      focusMode: false,
      canTeleport: true,
      canReturn: false,
      asleep: false,
      loginSupported: true,
      openAtLogin: false,
      showInDock: true,
      ...state,
    },
    actions: Object.fromEntries(
      [
        'settings',
        'show',
        'teleport',
        'returnToFrame',
        'focus',
        'openAtLogin',
        'showInDock',
        'hide',
        'sleep',
        'quit',
      ].map((name) => [name, action(name)]),
    ),
  });
  const items = template.flatMap((menu) => menu.submenu);
  return { template, items, calls, used, byId: (id) => items.find((item) => item.id === id) };
}

test('the app menu uses her wording, real shortcuts and only catalog strings', () => {
  const { template, items, calls, used, byId } = menuFixture();
  assert.equal(template[0].label, 'Capri');
  assert.deepEqual(
    template.slice(1).map(({ id }) => id),
    ['edit', 'window'],
  );
  assert.equal(template[2].role, 'window');
  for (const key of used) assert.equal(source[key], key, 'catalog key: ' + key);
  assert.equal(byId('about').role, 'about');
  assert.equal(byId('settings').label, '<Settings>…');
  assert.equal(byId('settings').accelerator, 'Command+,');
  assert.equal(byId('quit').label, '<Quit and unload models>');
  assert.equal(byId('quit').accelerator, 'Command+Q');
  assert.equal(byId('hide').accelerator, 'Command+H');
  assert.equal(byId('show').accelerator, 'Shift+Command+Space');
  assert.equal(byId('show').registerAccelerator, false, 'the global shortcut owns it');
  assert.equal(byId('teleport').enabled, true);
  assert.equal(byId('return').enabled, false);
  assert.equal(byId('sleep').label, '<Let her sleep>');
  assert.deepEqual(
    items.filter(({ role }) => role).map(({ role }) => role),
    ['about', 'undo', 'redo', 'cut', 'copy', 'paste', 'selectAll', 'close'],
  );
  for (const item of items)
    if (item.type !== 'separator') assert.match(item.label, /^<.+>/, 'every item is localized');
  byId('focus').click({ checked: true });
  byId('open-at-login').click({ checked: true });
  byId('show-in-dock').click({ checked: false });
  byId('quit').click();
  assert.deepEqual(calls, [
    ['focus', true],
    ['openAtLogin', true],
    ['showInDock', false],
    ['quit'],
  ]);
  const plain = menuFixture({ loginSupported: false, asleep: true, focusMode: true });
  assert.equal(plain.byId('open-at-login'), undefined, 'source runs cannot add a login item');
  assert.equal(plain.byId('sleep').enabled, false);
  assert.equal(plain.byId('focus').checked, true);
});

test('panel requests are validated and the panel opens under the icon', () => {
  assert.deepEqual(panelRequest({ action: 'state' }), { action: 'state' });
  assert.deepEqual(panelRequest({ action: 'voice', value: 'ignored' }), { action: 'voice' });
  assert.deepEqual(panelRequest({ action: 'ask', value: '  hi there ' }), {
    action: 'ask',
    value: 'hi there',
  });
  assert.deepEqual(panelRequest({ action: 'size', value: 10 }), { action: 'size', value: 120 });
  assert.deepEqual(panelRequest({ action: 'size', value: 412.4 }), { action: 'size', value: 412 });
  assert.deepEqual(panelRequest({ action: 'size', value: 9000 }), { action: 'size', value: 640 });
  for (const bad of [
    null,
    { action: 'delete-everything' },
    { action: 'ask', value: '   ' },
    { action: 'ask', value: 'x'.repeat(4001) },
    { action: 'ask', value: 5 },
    { action: 'size', value: 'tall' },
  ])
    assert.throws(() => panelRequest(bad));
  const area = { x: 0, y: 25, width: 1440, height: 875 };
  assert.deepEqual(panelBounds({ x: 1100, y: 0, width: 30, height: 24 }, area, 400), {
    x: 1115 - PANEL_WIDTH / 2,
    y: 25,
    width: PANEL_WIDTH,
    height: 400,
  });
  // Near the right edge it stays on screen.
  assert.equal(
    panelBounds({ x: 1420, y: 0, width: 20, height: 24 }, area, 400).x,
    1440 - PANEL_WIDTH,
  );
  // On a second display to the left, it follows that display's work area.
  assert.deepEqual(
    panelBounds(
      { x: -300, y: -200, width: 30, height: 24 },
      { x: -1280, y: -176, width: 1280, height: 776 },
      300,
    ),
    { x: -285 - PANEL_WIDTH / 2, y: -176, width: PANEL_WIDTH, height: 300 },
  );
});

function electronFixture() {
  const handlers = new Map();
  const ipcMain = {
    handle(channel, handler) {
      assert(!handlers.has(channel), 'IPC channel must have only one owner');
      handlers.set(channel, handler);
    },
  };
  const screen = {
    getCursorScreenPoint: () => ({ x: 500, y: 10 }),
    getPrimaryDisplay: () => ({ workArea: { x: 0, y: 25, width: 1440, height: 875 } }),
    getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 25, width: 1440, height: 875 } }),
  };
  const windows = [];
  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.visible = false;
      this.sent = [];
      this.webContents = new EventEmitter();
      this.webContents.mainFrame = {};
      this.webContents.getURL = () => this.url;
      this.webContents.setWindowOpenHandler = () => {};
      this.webContents.send = (channel, value) => this.sent.push([channel, value]);
      windows.push(this);
    }
    setAlwaysOnTop(value, level) {
      this.top = [value, level];
    }
    setMenu() {}
    loadURL(url) {
      this.url = url;
      return Promise.resolve();
    }
    setBounds(bounds) {
      this.bounds = bounds;
    }
    isDestroyed() {
      return this.destroyed === true;
    }
    isVisible() {
      return this.visible;
    }
    show() {
      this.visible = true;
    }
    focus() {
      this.focused = true;
    }
    hide() {
      this.visible = false;
      this.emit('hide');
    }
    destroy() {
      this.destroyed = true;
    }
  }
  return { handlers, ipcMain, screen, windows, BrowserWindow };
}

test('the panel only answers its own window and closes when it loses focus', async () => {
  const electron = electronFixture();
  let clock = 1000;
  const acted = [];
  const panel = new MenuBarPanel({
    ...electron,
    getState: () => ({ mood: 'idle', clock }),
    act: async (action, value) => {
      acted.push([action, value]);
      return true;
    },
    preload: '/preload.cjs',
    now: () => clock,
  });
  const invoke = electron.handlers.get('capri:menu-bar-panel');
  await panel.show({ x: 1100, y: 0, width: 30, height: 24 });
  const [view] = electron.windows;
  assert.equal(view.url, panelUrl);
  assert.equal(view.options.webPreferences.sandbox, true);
  assert.equal(view.options.webPreferences.contextIsolation, true);
  assert.deepEqual(view.top, [true, 'pop-up-menu']);
  assert.equal(view.visible, true);
  assert.equal(view.focused, true);
  assert.equal(view.bounds.y, 25);
  assert.deepEqual(
    view.sent.map(([channel]) => channel),
    ['capri:menu-bar-panel-state', 'capri:menu-bar-panel-shown'],
  );
  const own = { sender: view.webContents, senderFrame: view.webContents.mainFrame };
  await assert.rejects(() => invoke({ sender: {}, senderFrame: {} }, { action: 'state' }), /owner/);
  assert.deepEqual(await invoke(own, { action: 'state' }), { mood: 'idle', clock: 1000 });
  assert.equal(await invoke(own, { action: 'ask', value: ' hello ' }), true);
  assert.deepEqual(acted, [['ask', 'hello']]);
  await assert.rejects(() => invoke(own, { action: 'run-shell' }), /Unsupported/);
  await invoke(own, { action: 'size', value: 300 });
  assert.equal(view.bounds.height, 300);
  // Unchanged state is not resent while open; a change is.
  const sent = view.sent.length;
  panel.push();
  assert.equal(view.sent.length, sent);
  clock = 1001;
  panel.push();
  assert.equal(view.sent.length, sent + 1);
  // Clicking the icon while open: blur hides it first, so the click must not reopen it.
  view.emit('blur');
  assert.equal(view.visible, false);
  clock += 100;
  await panel.toggle({ x: 1100, y: 0, width: 30, height: 24 });
  assert.equal(view.visible, false);
  clock += 1000;
  await panel.toggle({ x: 1100, y: 0, width: 30, height: 24 });
  assert.equal(view.visible, true);
  await panel.toggle();
  assert.equal(view.visible, false);
  await invoke(own, { action: 'close' });
  panel.destroy();
  assert.equal(view.destroyed, true);
});

function menuBarFixture({
  settings = {},
  loginSupported = true,
  mood = 'idle',
  timer = null,
} = {}) {
  const electron = electronFixture();
  const folder = mkdtempSync(path.join(tmpdir(), 'capri-menu-bar-'));
  const preferences = new Preferences(
    path.join(folder, 'menu-bar.json'),
    MENU_BAR_DEFAULTS,
    validateMenuBarSettings,
  );
  if (Object.keys(settings).length) preferences.set({ ...preferences.value, ...settings });
  const log = [];
  const images = [];
  class Tray extends EventEmitter {
    constructor(image) {
      super();
      this.images = [image];
      this.titles = [];
    }
    setImage(image) {
      this.images.push(image);
    }
    setTitle(title, options) {
      this.titles.push([title, options]);
    }
    getBounds() {
      return { x: 1100, y: 0, width: 30, height: 24 };
    }
  }
  const nativeImage = {
    createFromBuffer(buffer, options) {
      const image = {
        reps: [[options.scaleFactor, buffer]],
        addRepresentation: ({ scaleFactor, buffer }) => image.reps.push([scaleFactor, buffer]),
        setTemplateImage: (value) => (image.template = value),
      };
      images.push(image);
      return image;
    },
  };
  let loginItem = false;
  const app = {
    dock: {
      show: () => log.push('dock-show') && Promise.resolve(),
      hide: () => log.push('dock-hide'),
    },
    getLoginItemSettings: () => ({ openAtLogin: loginItem }),
    setLoginItemSettings: ({ openAtLogin }) => {
      loginItem = openAtLogin;
      log.push('login-' + openAtLogin);
    },
  };
  const Menu = {
    buildFromTemplate: (template) => ({ template }),
    setApplicationMenu: (menu) => log.push(['menu', menu.template]),
  };
  const state = { mood, timer, menu: { focusMode: false, canTeleport: false, canReturn: false } };
  const changed = [];
  const menuBar = new MacMenuBar({
    electron: { ...electron, app, Menu, Tray, nativeImage },
    preferences,
    colorIcon: () => 'color-icon',
    text: (key) => key,
    menuState: () => state.menu,
    mood: () => state.mood,
    timer: () => (typeof state.timer === 'function' ? state.timer() : state.timer),
    panelState: () => ({}),
    panelAction: async () => true,
    loginSupported,
    now: () => state.clock ?? 0,
    actions: {
      contextMenu: () => log.push('context-menu'),
      changed: (snapshot, from) => changed.push([snapshot, from]),
    },
  });
  return {
    menuBar,
    log,
    images,
    state,
    changed,
    preferences,
    menus: () => log.filter((entry) => Array.isArray(entry) && entry[0] === 'menu'),
    cleanup: () => rmSync(folder, { recursive: true, force: true }),
  };
}

test('the menu bar shows a template bolt, her panel and a right-click menu', () => {
  const fixture = menuBarFixture();
  try {
    const tray = fixture.menuBar.start();
    assert.deepEqual(fixture.log.slice(0, 1), ['dock-show']);
    const [first] = fixture.images;
    assert.equal(first.template, true);
    assert.deepEqual(
      first.reps.map(([scale]) => scale),
      [1, 2],
    );
    assert.equal(tray.images[0], first);
    assert.equal(fixture.menus().length, 1, 'app menu installed once');
    fixture.menuBar.refresh();
    fixture.menuBar.refresh();
    assert.equal(fixture.menus().length, 1, 'an unchanged menu is not rebuilt');
    fixture.state.menu = { ...fixture.state.menu, canReturn: true };
    fixture.menuBar.refresh();
    assert.equal(fixture.menus().length, 2, 'a changed menu is rebuilt');
    tray.emit('right-click');
    assert.ok(fixture.log.includes('context-menu'));
    tray.emit('click');
    assert.ok(fixture.menuBar.panel.window, 'a click opens the panel');
  } finally {
    fixture.menuBar.destroy();
    fixture.cleanup();
  }
});

test('her mood and timers change the icon only when the state changes', () => {
  const fixture = menuBarFixture();
  try {
    const tray = fixture.menuBar.start();
    const count = () => tray.images.length;
    const start = count();
    fixture.menuBar.refresh();
    assert.equal(count(), start, 'idle does not redraw');
    fixture.state.mood = 'thinking';
    fixture.menuBar.refresh();
    fixture.menuBar.refresh();
    assert.equal(count(), start + 1);
    fixture.state.mood = 'speaking';
    fixture.menuBar.refresh();
    fixture.menuBar.refresh();
    assert.equal(count(), start + 3, 'speaking flickers each tick');
    assert.notEqual(tray.images.at(-1), tray.images.at(-2));
    fixture.state.mood = 'idle';
    fixture.menuBar.refresh();
    const cached = fixture.images.length;
    fixture.state.mood = 'thinking';
    fixture.menuBar.refresh();
    assert.equal(fixture.images.length, cached, 'icons are cached by state');
    // Timer text follows the soonest timer and counts down between checks.
    fixture.state.timer = 299_000;
    fixture.state.clock = 5000;
    fixture.menuBar.refresh();
    assert.deepEqual(tray.titles.at(-1), ['04:59', { fontType: 'monospacedDigit' }]);
    fixture.state.timer = null;
    fixture.state.clock = 6000;
    fixture.menuBar.refresh();
    assert.equal(tray.titles.at(-1)[0], '04:58', 'one second later, before the next check');
    fixture.state.clock = 7100;
    fixture.menuBar.refresh();
    assert.equal(tray.titles.at(-1)[0], '', 'cleared once the timer is gone');
    fixture.state.timer = 60_000;
    fixture.state.clock = 9500;
    fixture.menuBar.refresh();
    assert.equal(tray.titles.at(-1)[0], '01:00');
    fixture.state.timer = () => {
      throw new Error('The time skill is off.');
    };
    fixture.state.clock = 11_600;
    fixture.menuBar.refresh();
    assert.equal(tray.titles.at(-1)[0], '', 'a failing timer lookup only clears the text');
  } finally {
    fixture.menuBar.destroy();
    fixture.cleanup();
  }
});

test('turning her mood off keeps a still bolt; full color keeps today’s icon', () => {
  const fixture = menuBarFixture({
    settings: { showMood: false },
    mood: 'listening',
    timer: 60_000,
  });
  try {
    const tray = fixture.menuBar.start();
    const shown = tray.images.length;
    fixture.menuBar.refresh();
    assert.equal(tray.images.length, shown, 'listening does not change a still bolt');
    assert.equal(fixture.images.length, 1);
    assert.equal(tray.titles.at(-1)[0], '', 'no timer text without mood');
    fixture.menuBar.update({ iconStyle: 'color', showMood: true });
    assert.equal(tray.images.at(-1), 'color-icon');
    assert.equal(tray.titles.at(-1)[0], '01:00', 'full color still counts down timers');
  } finally {
    fixture.menuBar.destroy();
    fixture.cleanup();
  }
});

test('Settings and the app menu change the Dock, login item and icon together', () => {
  const fixture = menuBarFixture({ settings: { showInDock: false } });
  try {
    fixture.menuBar.start();
    assert.deepEqual(fixture.log.slice(0, 1), ['dock-hide'], 'hidden before windows show');
    assert.deepEqual(fixture.menuBar.settingsSnapshot(), {
      supported: true,
      loginSupported: true,
      openAtLogin: false,
      showInDock: false,
      iconStyle: 'glitch',
      showMood: true,
    });
    const snapshot = fixture.menuBar.update({
      openAtLogin: true,
      showInDock: true,
      iconStyle: 'plain',
    });
    assert.equal(snapshot.openAtLogin, true);
    assert.equal(snapshot.showInDock, true);
    assert.ok(fixture.log.includes('login-true'));
    assert.ok(fixture.log.includes('dock-show'));
    assert.deepEqual(fixture.changed.at(-1), [snapshot, 'settings']);
    assert.deepEqual(
      JSON.parse(readFileSync(fixture.preferences.file, 'utf8')).settings,
      { showInDock: true, iconStyle: 'plain', showMood: true },
      'the login item lives in macOS, not in the file',
    );
    // The app menu's checkboxes go through the same path.
    const menu = fixture.menus().at(-1)[1][0].submenu;
    menu.find(({ id }) => id === 'show-in-dock').click({ checked: false });
    assert.equal(fixture.preferences.value.showInDock, false);
    assert.equal(fixture.changed.at(-1)[1], 'menu');
    assert.throws(() => fixture.menuBar.update({ iconStyle: 'rainbow' }), /Invalid/);
    assert.throws(() => fixture.menuBar.update({ openAtLogin: 'yes' }), /Invalid/);
    assert.equal(fixture.preferences.value.iconStyle, 'plain', 'a rejected change saves nothing');
  } finally {
    fixture.menuBar.destroy();
    fixture.cleanup();
  }
});

test('a run from source never registers a login item', () => {
  const fixture = menuBarFixture({ loginSupported: false });
  try {
    fixture.menuBar.start();
    const snapshot = fixture.menuBar.update({ openAtLogin: true });
    assert.equal(snapshot.loginSupported, false);
    assert.equal(snapshot.openAtLogin, false);
    assert.equal(fixture.log.filter((entry) => String(entry).startsWith('login')).length, 0);
    assert.equal(
      fixture
        .menus()
        .at(-1)[1][0]
        .submenu.some(({ id }) => id === 'open-at-login'),
      false,
    );
  } finally {
    fixture.menuBar.destroy();
    fixture.cleanup();
  }
});

test('the panel and Settings card only use strings from the catalog', () => {
  const html = readFileSync(
    new URL('../apps/desktop/renderer/settings-app.mjs', import.meta.url),
    'utf8',
  );
  const card = html.slice(
    html.indexOf('id="general-macos"'),
    html.indexOf('</section>', html.indexOf('id="general-macos"')),
  );
  const texts = [...card.matchAll(/>([^<>]+)</g)].map(([, text]) => text.trim()).filter(Boolean);
  assert.ok(texts.length >= 9);
  for (const text of texts) assert.equal(source[text], text, 'catalog key: ' + text);
  const main = readFileSync(new URL('../apps/desktop/main.mjs', import.meta.url), 'utf8');
  const panel = main.slice(
    main.indexOf('function menuBarPanelState()'),
    main.indexOf('async function menuBarPanelAction('),
  );
  const keys = [...panel.matchAll(/text\('([^']+)'\)/g)].map(([, key]) => key);
  assert.ok(keys.length >= 12);
  for (const key of keys) assert.equal(source[key], key, 'catalog key: ' + key);
  for (const status of [
    'Ready',
    'OFFLINE',
    'Connecting',
    'Listening',
    'Thinking',
    'Speaking',
    'Sleeping',
  ])
    assert.equal(source[status], status);
});
