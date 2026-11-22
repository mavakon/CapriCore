// SPDX-License-Identifier: GPL-3.0-only
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

/**
 * Capri on the macOS menu bar: the app menu in her wording, a one-color
 * double-bolt status icon that can show her mood, and her own small panel.
 * Pure helpers are exported for tests; MacMenuBar owns the Electron objects.
 */

export const MENU_BAR_DEFAULTS = Object.freeze({
  showInDock: true,
  iconStyle: 'glitch',
  showMood: true,
});
export const ICON_STYLES = Object.freeze(['glitch', 'plain', 'color']);
export const MOODS = Object.freeze(['idle', 'listening', 'thinking', 'speaking', 'asleep']);
export const panelUrl = 'capri://desktop/menu-bar-panel.html';

export function validateMenuBarSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid menu bar settings.');
  for (const key of Object.keys(value))
    if (!Object.hasOwn(MENU_BAR_DEFAULTS, key)) throw new Error('Invalid menu bar settings.');
  const settings = { ...MENU_BAR_DEFAULTS, ...value };
  if (
    typeof settings.showInDock !== 'boolean' ||
    typeof settings.showMood !== 'boolean' ||
    !ICON_STYLES.includes(settings.iconStyle)
  )
    throw new Error('Invalid menu bar settings.');
  return settings;
}

// ---------------------------------------------------------------------------
// Status icon
// ---------------------------------------------------------------------------

/** Capri's bolt, in the 44 x 52 units of her brand mark. */
export const BOLT = Object.freeze([
  [27, 1],
  [3, 26],
  [18, 26],
  [12, 47],
  [38, 17],
  [23, 17],
]);
export const ICON_HEIGHT = 18;
const UNIT = ICON_HEIGHT / 52;
// Room for the glitch copies on both sides keeps the icon from shifting.
const BOLT_SHIFT = 2;
const BOLT_WIDTH = Math.ceil(48 * UNIT);

const bolt = (dx, dy, alpha) => ({
  kind: 'polygon',
  alpha,
  points: BOLT.map(([x, y]) => [(x + dx + BOLT_SHIFT) * UNIT, (y + dy) * UNIT]),
});
const bar = (x, half, start) => ({
  kind: 'segment',
  alpha: 1,
  from: [start + x, ICON_HEIGHT / 2 - half],
  to: [start + x, ICON_HEIGHT / 2 + half],
  radius: 0.75,
});

/** Layers in points (1/18 of the icon height); one color, varying opacity. */
export function menuBarIconLayers({ style = 'glitch', mood = 'idle', frame = 0 } = {}) {
  if (!['glitch', 'plain'].includes(style)) throw new Error('Unsupported template icon style.');
  if (!MOODS.includes(mood)) throw new Error('Unsupported menu bar mood.');
  const glyph = BOLT_WIDTH + 1.5;
  let layers;
  if (mood === 'asleep') layers = [bolt(0, 0, 0.4)];
  else if (mood === 'speaking')
    layers =
      frame % 2
        ? [bolt(-2, 4, 0.35), bolt(7, 1, 0.35), bolt(0, 0, 1)]
        : [bolt(8, 2, 0.35), bolt(-2, 3, 0.35), bolt(0, 0, 1)];
  else layers = style === 'glitch' ? [bolt(5, 4, 0.45), bolt(0, 0, 1)] : [bolt(0, 0, 1)];
  let width = BOLT_WIDTH;
  if (mood === 'listening') {
    layers.push(bar(1, 1.5, glyph), bar(3.5, 3.5, glyph), bar(6, 2, glyph), bar(8.5, 3, glyph));
    width = glyph + 10;
  } else if (mood === 'thinking') {
    for (const [index, alpha] of [1, 0.7, 0.4].entries())
      layers.push({ kind: 'circle', alpha, center: [glyph + 1.5 + index * 4, 11], radius: 1.3 });
    width = glyph + 11;
  } else if (mood === 'asleep') {
    const left = BOLT_WIDTH - 2;
    for (const [from, to] of [
      [
        [left, 2.5],
        [left + 5, 2.5],
      ],
      [
        [left + 5, 2.5],
        [left, 7.5],
      ],
      [
        [left, 7.5],
        [left + 5, 7.5],
      ],
    ])
      layers.push({ kind: 'segment', alpha: 0.9, from, to, radius: 0.65 });
    width = left + 6;
  }
  return { width: Math.ceil(width), height: ICON_HEIGHT, layers };
}

function insidePolygon(points, x, y) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function insideSegment({ from, to, radius }, x, y) {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const t = Math.max(
    0,
    Math.min(1, ((x - from[0]) * dx + (y - from[1]) * dy) / (dx * dx + dy * dy)),
  );
  return Math.hypot(x - from[0] - t * dx, y - from[1] - t * dy) <= radius;
}
function inside(layer, x, y) {
  if (layer.kind === 'polygon') return insidePolygon(layer.points, x, y);
  if (layer.kind === 'segment') return insideSegment(layer, x, y);
  return Math.hypot(x - layer.center[0], y - layer.center[1]) <= layer.radius;
}

/** Black RGBA pixels with 4 x 4 supersampled coverage, as macOS template images expect. */
export function rasterizeMenuBarIcon(options = {}, scale = 1) {
  const { width: points, height: tall, layers } = menuBarIconLayers(options);
  const width = Math.round(points * scale);
  const height = Math.round(tall * scale);
  const rgba = Buffer.alloc(width * height * 4);
  const samples = 4;
  for (let py = 0; py < height; py++)
    for (let px = 0; px < width; px++) {
      let alpha = 0;
      for (const layer of layers) {
        let hits = 0;
        for (let sy = 0; sy < samples; sy++)
          for (let sx = 0; sx < samples; sx++)
            if (
              inside(
                layer,
                (px + (sx + 0.5) / samples) / scale,
                (py + (sy + 0.5) / samples) / scale,
              )
            )
              hits++;
        const cover = (hits / (samples * samples)) * layer.alpha;
        alpha = cover + alpha * (1 - cover);
      }
      rgba[(py * width + px) * 4 + 3] = Math.round(alpha * 255);
    }
  return { width, height, rgba };
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}
export function encodePng({ width, height, rgba }) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++)
    rgba.copy(rows, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(rows)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Pick the icon state. Asleep wins; then what she's doing out loud. */
export function menuBarMood({ asleep, speaking, listening, thinking } = {}) {
  if (asleep) return 'asleep';
  if (speaking) return 'speaking';
  if (thinking) return 'thinking';
  if (listening) return 'listening';
  return 'idle';
}

/** The text beside the icon while a timer runs, such as 04:59 or 1:02:03. */
export function timerTitle(remainingMs) {
  if (!Number.isFinite(remainingMs) || remainingMs < 0) return '';
  const total = Math.ceil(remainingMs / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total / 60) % 60;
  const seconds = String(total % 60).padStart(2, '0');
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
    : `${String(minutes).padStart(2, '0')}:${seconds}`;
}

/** The soonest running countdown timer, from the time skill's rows. */
export function nextTimerRemaining(rows) {
  let next = null;
  for (const row of Array.isArray(rows) ? rows : [])
    if (row?.kind === 'timer' && row.state === 'running' && Number.isFinite(row.remainingMs))
      next = next === null ? row.remainingMs : Math.min(next, row.remainingMs);
  return next;
}

/** A short model name for the panel, such as "Qwen3.5 4B". */
export function shortModelName(model) {
  if (typeof model !== 'string' || !model.trim()) return '';
  return model
    .trim()
    .split('/')
    .pop()
    .replace(/[-_.]gguf$/i, '')
    .replace(/^capri-/i, '')
    .replace(/[-_:]+/g, ' ')
    .trim()
    .slice(0, 32);
}

// ---------------------------------------------------------------------------
// App menu
// ---------------------------------------------------------------------------

/**
 * The menu macOS shows at the far left when Capri is the active app. macOS
 * draws it natively, so her style lives in the wording only.
 */
export function macosAppMenuTemplate({ text, state, actions }) {
  const checkbox = (id, label, checked, change) => ({
    id,
    label: text(label),
    type: 'checkbox',
    checked: Boolean(checked),
    click: (item) => change(item.checked),
  });
  return [
    {
      label: 'Capri',
      submenu: [
        { id: 'about', role: 'about', label: text('About Capri') },
        { type: 'separator' },
        {
          id: 'settings',
          label: text('Settings') + '…',
          accelerator: 'Command+,',
          click: actions.settings,
        },
        { type: 'separator' },
        {
          id: 'show',
          label: text('Show Capri'),
          // The global shortcut already owns it; the menu only names it.
          accelerator: 'Shift+Command+Space',
          registerAccelerator: false,
          click: actions.show,
        },
        {
          id: 'teleport',
          label: text('Teleport Capri'),
          enabled: Boolean(state.canTeleport),
          click: actions.teleport,
        },
        {
          id: 'return',
          label: text('Return to frame'),
          enabled: Boolean(state.canReturn),
          click: actions.returnToFrame,
        },
        checkbox('focus', 'Focus mode', state.focusMode, actions.focus),
        { type: 'separator' },
        ...(state.loginSupported
          ? [checkbox('open-at-login', 'Start with my Mac', state.openAtLogin, actions.openAtLogin)]
          : []),
        checkbox('show-in-dock', 'Live in the Dock', state.showInDock, actions.showInDock),
        { type: 'separator' },
        { id: 'hide', label: text('Hide Capri'), accelerator: 'Command+H', click: actions.hide },
        { type: 'separator' },
        { id: 'sleep', label: text('Let her sleep'), enabled: !state.asleep, click: actions.sleep },
        {
          id: 'quit',
          label: text('Quit and unload models'),
          accelerator: 'Command+Q',
          click: actions.quit,
        },
      ],
    },
    {
      id: 'edit',
      label: text('Edit'),
      submenu: [
        { role: 'undo', label: text('Undo') },
        { role: 'redo', label: text('Redo') },
        { type: 'separator' },
        { role: 'cut', label: text('Cut') },
        { role: 'copy', label: text('Copy') },
        { role: 'paste', label: text('Paste') },
        { role: 'selectAll', label: text('Select all') },
      ],
    },
    {
      id: 'window',
      role: 'window',
      label: text('Window'),
      // Capri's own windows hide instead of closing, so Close is safe everywhere.
      submenu: [{ role: 'close', label: text('Close') }],
    },
  ];
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

const PANEL_ACTIONS = new Set([
  'ask',
  'microphone',
  'voice',
  'focus',
  'show',
  'teleport',
  'return',
  'settings',
  'sleep',
  'quit',
]);
export const PANEL_WIDTH = 368;
const PANEL_MIN_HEIGHT = 120;
const PANEL_MAX_HEIGHT = 640;

/** Validate one request from the panel renderer. */
export function panelRequest(value) {
  if (!value || typeof value !== 'object' || typeof value.action !== 'string')
    throw new Error('Invalid panel request.');
  const { action } = value;
  if (action === 'state' || action === 'close') return { action };
  if (action === 'size') {
    if (!Number.isFinite(value.value)) throw new Error('Invalid panel size.');
    return {
      action,
      value: Math.round(Math.min(PANEL_MAX_HEIGHT, Math.max(PANEL_MIN_HEIGHT, value.value))),
    };
  }
  if (!PANEL_ACTIONS.has(action)) throw new Error('Unsupported panel action.');
  if (action !== 'ask') return { action };
  const text = typeof value.value === 'string' ? value.value.trim() : '';
  if (!text || text.length > 4000) throw new Error('Invalid message.');
  return { action, value: text };
}

/** Where the panel opens: centered under the icon, inside the work area. */
export function panelBounds(anchor, area, height, width = PANEL_WIDTH) {
  const center = anchor.x + anchor.width / 2;
  const x = Math.round(
    Math.min(Math.max(center - width / 2, area.x), area.x + Math.max(0, area.width - width)),
  );
  const top = Math.max(anchor.y + anchor.height, area.y);
  const y = Math.round(Math.min(top, area.y + Math.max(0, area.height - height)));
  return { x, y, width, height };
}

/** Capri's own little window under the menu bar icon. */
export class MenuBarPanel {
  constructor({
    BrowserWindow,
    screen,
    ipcMain,
    getState,
    act,
    url = panelUrl,
    preload = fileURLToPath(new URL('../menu-bar-panel-preload.cjs', import.meta.url)),
    now = () => Date.now(),
  }) {
    Object.assign(this, { BrowserWindow, screen, getState, act, url, preload, now });
    this.height = 420;
    this.hiddenAt = 0;
    ipcMain.handle('capri:menu-bar-panel', async (event, value) => {
      this.requireOwner(event);
      const request = panelRequest(value);
      if (request.action === 'state') return this.getState();
      if (request.action === 'close') {
        this.hide();
        return true;
      }
      if (request.action === 'size') {
        this.height = request.value;
        this.place();
        return true;
      }
      const result = await this.act(request.action, request.value, this);
      this.push();
      return result;
    });
  }
  requireOwner(event) {
    const contents = this.window && !this.window.isDestroyed() && this.window.webContents;
    if (
      !contents ||
      event.sender !== contents ||
      event.senderFrame !== contents.mainFrame ||
      contents.getURL() !== this.url
    )
      throw new Error('Invalid menu bar panel owner.');
  }
  get visible() {
    return Boolean(this.window && !this.window.isDestroyed() && this.window.isVisible());
  }
  /** A click on the icon while the panel is open closes it, and blur already did. */
  toggle(anchor) {
    if (this.visible) return this.hide();
    if (this.now() - this.hiddenAt < 300) return;
    return this.show(anchor);
  }
  create() {
    const view = (this.window = new this.BrowserWindow({
      width: PANEL_WIDTH,
      height: this.height,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
      autoHideMenuBar: true,
      webPreferences: {
        preload: this.preload,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: true,
      },
    }));
    // Above ordinary floating windows, like a native menu.
    view.setAlwaysOnTop(true, 'pop-up-menu');
    view.setMenu?.(null);
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    view.webContents.on('will-navigate', (event) => event.preventDefault());
    view.webContents.on('render-process-gone', () => view.destroy());
    view.on('blur', () => {
      if (this.window === view) this.hide();
    });
    view.on('closed', () => {
      if (this.window === view) this.window = null;
    });
    this.ready = view.loadURL(this.url);
  }
  place() {
    if (!this.window || this.window.isDestroyed()) return;
    const anchor = this.anchor ?? { ...this.screen.getCursorScreenPoint(), width: 0, height: 0 };
    const area = (
      this.screen.getDisplayNearestPoint?.({ x: anchor.x, y: anchor.y }) ??
      this.screen.getPrimaryDisplay()
    ).workArea;
    this.window.setBounds(panelBounds(anchor, area, this.height), false);
  }
  async show(anchor) {
    const generation = (this.generation = (this.generation ?? 0) + 1);
    this.anchor =
      anchor && anchor.width > 0 && anchor.height > 0
        ? anchor
        : { ...this.screen.getCursorScreenPoint(), width: 0, height: 0 };
    if (!this.window || this.window.isDestroyed()) this.create();
    try {
      await this.ready;
      if (generation !== this.generation || !this.window || this.window.isDestroyed()) return;
      this.lastPush = undefined;
      this.push(true);
      this.place();
      this.window.show();
      this.window.focus();
      this.window.webContents.send('capri:menu-bar-panel-shown');
    } catch {
      this.hide();
    }
  }
  /** Send fresh state while open; unchanged state is not resent. */
  push(force = false) {
    if (!this.window || this.window.isDestroyed() || (!force && !this.visible)) return;
    const state = this.getState();
    const encoded = JSON.stringify(state);
    if (!force && encoded === this.lastPush) return;
    this.lastPush = encoded;
    this.window.webContents.send('capri:menu-bar-panel-state', state);
  }
  hide() {
    this.generation = (this.generation ?? 0) + 1;
    if (this.visible) {
      this.hiddenAt = this.now();
      this.window.hide();
    }
  }
  destroy() {
    this.hide();
    this.window?.destroy();
    this.window = null;
  }
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

/** Owns the status item, the app menu, the Dock and the login item on macOS. */
export class MacMenuBar {
  constructor({
    electron,
    preferences,
    colorIcon,
    text,
    menuState,
    actions,
    mood,
    timer,
    panelState,
    panelAction,
    loginSupported = false,
    now = () => Date.now(),
  }) {
    Object.assign(this, {
      electron,
      preferences,
      colorIcon,
      text,
      menuState,
      actions,
      mood,
      timer,
      loginSupported,
      now,
    });
    this.images = new Map();
    this.frame = 0;
    this.panel = new MenuBarPanel({
      BrowserWindow: electron.BrowserWindow,
      screen: electron.screen,
      ipcMain: electron.ipcMain,
      getState: panelState,
      act: panelAction,
    });
  }
  get settings() {
    return this.preferences.value;
  }
  /** Apply the Dock choice before any window shows, then create the icon and menu. */
  start() {
    this.applyDock();
    const tray = (this.tray = new this.electron.Tray(this.icon('idle')));
    tray.on('click', () => void this.panel.toggle(tray.getBounds()));
    tray.on('right-click', () => this.actions.contextMenu());
    this.shownIcon = this.iconKey('idle');
    this.refresh(true);
    return tray;
  }
  iconKey(mood) {
    const style = this.settings.iconStyle;
    if (style === 'color') return 'color';
    const shown = this.settings.showMood ? mood : 'idle';
    return `${style}:${shown}:${shown === 'speaking' ? this.frame % 2 : 0}`;
  }
  icon(mood) {
    const key = this.iconKey(mood);
    if (key === 'color') return this.colorIcon();
    let image = this.images.get(key);
    if (image) return image;
    const [style, shown, frame] = key.split(':');
    const options = { style, mood: shown, frame: Number(frame) };
    const { nativeImage } = this.electron;
    image = nativeImage.createFromBuffer(encodePng(rasterizeMenuBarIcon(options, 1)), {
      scaleFactor: 1,
    });
    image.addRepresentation({
      scaleFactor: 2,
      buffer: encodePng(rasterizeMenuBarIcon(options, 2)),
    });
    image.setTemplateImage(true);
    this.images.set(key, image);
    return image;
  }
  /** Capri's 400 ms control tick. A failure here must never break the tick. */
  tick() {
    try {
      this.refresh();
    } catch (error) {
      if (!this.tickFailed) console.warn('Could not refresh the menu bar:', error.message);
      this.tickFailed = true;
    }
  }
  /** Mood, timer text, app menu and open panel; each changes only when needed. */
  refresh(force = false) {
    if (!this.tray || this.tray.isDestroyed?.()) return;
    const mood = this.settings.showMood ? this.mood() : 'idle';
    if (mood === 'speaking') this.frame++;
    const key = this.iconKey(mood);
    if (force || key !== this.shownIcon) {
      this.tray.setImage(this.icon(mood));
      this.shownIcon = key;
    }
    this.refreshTimer(force);
    this.refreshMenu(force);
    this.panel.push();
  }
  refreshTimer(force) {
    const now = this.now();
    if (!this.settings.showMood) this.deadline = null;
    else if (force || !this.timerCheckedAt || now - this.timerCheckedAt >= 2000) {
      this.timerCheckedAt = now;
      let remaining = null;
      try {
        remaining = this.timer();
      } catch {
        remaining = null;
      }
      this.deadline = Number.isFinite(remaining) ? now + remaining : null;
    }
    const title = this.deadline === null ? '' : timerTitle(Math.max(0, this.deadline - now));
    if (force || title !== this.title) {
      this.tray.setTitle(title, { fontType: 'monospacedDigit' });
      this.title = title;
    }
  }
  menuSnapshot() {
    return {
      ...this.menuState(),
      loginSupported: this.loginSupported,
      openAtLogin: this.openAtLogin(),
      showInDock: this.settings.showInDock,
    };
  }
  refreshMenu(force) {
    const state = this.menuSnapshot();
    const signature = JSON.stringify(state);
    if (!force && signature === this.menuSignature) return;
    this.menuSignature = signature;
    const { Menu } = this.electron;
    const actions = {
      ...this.actions,
      openAtLogin: (value) => this.update({ openAtLogin: value }, 'menu'),
      showInDock: (value) => this.update({ showInDock: value }, 'menu'),
    };
    Menu.setApplicationMenu(
      Menu.buildFromTemplate(macosAppMenuTemplate({ text: this.text, state, actions })),
    );
  }
  openAtLogin() {
    if (!this.loginSupported) return false;
    try {
      return this.electron.app.getLoginItemSettings().openAtLogin === true;
    } catch {
      return false;
    }
  }
  applyDock() {
    const dock = this.electron.app.dock;
    if (!dock) return;
    if (this.settings.showInDock) void Promise.resolve(dock.show()).catch(() => {});
    else dock.hide();
  }
  settingsSnapshot() {
    return {
      supported: true,
      loginSupported: this.loginSupported,
      openAtLogin: this.openAtLogin(),
      ...this.preferences.snapshot(),
    };
  }
  /** Change any of the switches; returns the new Settings snapshot. */
  update(patch, source = 'settings') {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch))
      throw new Error('Invalid menu bar settings.');
    const { openAtLogin, ...rest } = patch;
    if (openAtLogin !== undefined && typeof openAtLogin !== 'boolean')
      throw new Error('Invalid menu bar settings.');
    const previous = this.preferences.snapshot();
    const next = this.preferences.set({ ...previous, ...rest });
    if (next.showInDock !== previous.showInDock) this.applyDock();
    if (openAtLogin !== undefined && this.loginSupported && openAtLogin !== this.openAtLogin())
      this.electron.app.setLoginItemSettings({ openAtLogin });
    this.refresh(true);
    const snapshot = this.settingsSnapshot();
    this.actions.changed?.(snapshot, source);
    return snapshot;
  }
  destroy() {
    this.panel.destroy();
  }
}
