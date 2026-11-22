// SPDX-License-Identifier: GPL-3.0-only
/**
 * macOS: Capri's app menu, menu bar icon, panel and the "On your Mac" settings,
 * in the real Electron app against fixture servers. Nothing here plays sound.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { _electron } from 'playwright-core';
import { root } from '../../packages/runtime/src/host/paths.mjs';
import { settingsView, saveSettings } from './settings-view.mjs';

if (process.platform !== 'darwin') {
  console.log(JSON.stringify({ skipped: 'The menu bar verification runs on macOS.' }));
  process.exit(0);
}
const parent = path.join(root, '.runtime/desktop-verification');
mkdirSync(parent, { recursive: true });
const folder = mkdtempSync(path.join(parent, 'macos-menu-bar-'));
mkdirSync(path.join(folder, 'desktop'));
const report = { folder, checks: [], errors: [] };
const record = (name) => {
  report.checks.push(name);
  console.log('PASS ' + name);
};
const chats = [];
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    if (req.url.endsWith('/chat/completions')) chats.push(body);
    res.setHeader('content-type', 'application/json');
    res.end('{"data":[]}');
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const env = {
  ...process.env,
  TEMP: folder,
  TMP: folder,
  CAPRI_DESKTOP_VERIFICATION_DIR: folder,
  CAPRI_DESKTOP_VERIFICATION_PORT: String(server.address().port),
  CAPRI_DESKTOP_VERIFICATION_SKIP_START: '1',
};
delete env.ELECTRON_RUN_AS_NODE;
const until = async (check, message, timeout = 15000) => {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};
let application;
try {
  application = await _electron.launch({
    executablePath: createRequire(import.meta.url)('electron'),
    args: [path.join(root, 'apps/desktop/main.mjs'), '--verification'],
    env,
    timeout: 60000,
  });
  application.on('window', (page) => page.on('pageerror', (e) => report.errors.push(e.message)));
  const owner = await application.firstWindow();
  await owner.waitForFunction(() => document.body.dataset.phase === 'ready');
  await until(
    () => application.evaluate(() => Boolean(globalThis.capriMenuBarVerification)),
    'The menu bar controller did not start',
  );

  // App menu: her wording, real shortcuts, and an Edit menu so copy and paste work.
  const menu = await application.evaluate(({ Menu }) =>
    Menu.getApplicationMenu().items.map((item) => ({
      label: item.label,
      role: item.role,
      items: item.submenu.items.map(({ id, label, role, accelerator, type, checked }) => ({
        id,
        label,
        role,
        accelerator,
        type,
        checked,
      })),
    })),
  );
  const capri = Object.fromEntries(menu[0].items.filter(({ id }) => id).map((i) => [i.id, i]));
  assert.equal(capri.settings.label, 'Settings…');
  assert.equal(capri.settings.accelerator, 'Command+,');
  assert.equal(capri.quit.label, 'Quit and unload models');
  assert.equal(capri.quit.accelerator, 'Command+Q');
  assert.equal(capri.sleep.label, 'Let her sleep');
  assert.equal(capri['show-in-dock'].checked, true);
  assert.equal(capri['open-at-login'], undefined, 'Verification runs never add a login item');
  assert.deepEqual(
    menu[1].items.filter(({ role }) => role).map(({ role }) => role.toLowerCase()),
    ['undo', 'redo', 'cut', 'copy', 'paste', 'selectall'],
  );
  assert.equal(menu[2].label, 'Window');
  assert.equal(
    menu.some(({ items }) => items.some(({ role }) => /reload|toggledevtools/i.test(role ?? ''))),
    false,
    'Reload and developer tools are gone',
  );
  record('The app menu uses her wording, real shortcuts and an Edit menu');

  // Menu bar icon: a one-color template bolt that follows her mood.
  const icon = await application.evaluate(() => ({
    shown: globalThis.capriMenuBarVerification.shownIcon,
    title: globalThis.capriMenuBarVerification.tray.getTitle(),
    template: [...globalThis.capriMenuBarVerification.images.values()].every((image) =>
      image.isTemplateImage(),
    ),
    sizes: [...globalThis.capriMenuBarVerification.images.values()].map((image) => image.getSize()),
  }));
  assert.equal(icon.shown, 'glitch:idle:0');
  assert.equal(icon.title, '');
  assert.equal(icon.template, true);
  assert.ok(icon.sizes.every(({ height }) => height === 18));
  record('The menu bar shows the glitch bolt as a template image');

  // The panel: open it as a click would, under the icon.
  await application.evaluate(() =>
    globalThis.capriMenuBarVerification.panel.show({ x: 900, y: 0, width: 30, height: 24 }),
  );
  const panel = await until(
    () =>
      application.windows().find((page) => page.url() === 'capri://desktop/menu-bar-panel.html'),
    'The panel did not open',
  );
  await panel.waitForFunction(
    () =>
      document.querySelectorAll('#tiles button').length === 3 &&
      document.getElementById('panel-status').textContent.length > 0,
  );
  const shape = await panel.evaluate(() => ({
    status: document.getElementById('panel-status').textContent,
    tiles: [...document.querySelectorAll('#tiles button')].map((b) => b.dataset.id),
    actions: [...document.querySelectorAll('#actions button')].map((b) => b.dataset.id),
    focused: document.activeElement?.id,
    font: getComputedStyle(document.body).fontFamily,
  }));
  assert.deepEqual(shape.tiles, ['microphone', 'voice', 'focus']);
  assert.deepEqual(shape.actions, ['show', 'teleport', 'return', 'settings', 'sleep', 'quit']);
  assert.equal(shape.focused, 'ask-text', 'The message box is ready to type into');
  assert.match(shape.font, /Exo 2/);
  const bounds = await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((w) => w.webContents.getURL() === 'capri://desktop/menu-bar-panel.html')
      .getBounds(),
  );
  assert.equal(bounds.width, 368);
  assert.ok(bounds.height >= 300 && bounds.height <= 640, 'The panel fits its content');
  await panel.screenshot({ path: path.join(folder, 'menu-bar-panel.png') });
  record('Clicking the bolt opens her panel with the message box focused');

  // A quick ask goes to her conversation and leaves any draft in her main box alone.
  await owner.locator('#message').fill('draft in the main box');
  await panel.locator('#ask-text').fill('hello from the menu bar');
  await panel.locator('#ask-send').click();
  await until(
    () => chats.some((body) => body.includes('hello from the menu bar')),
    'The quick ask did not reach her conversation',
  );
  await until(
    () => application.evaluate(() => !globalThis.capriMenuBarVerification.panel.visible),
    'The panel stayed open after sending',
  );
  assert.equal(await panel.locator('#ask-text').inputValue(), '');
  assert.equal(await owner.locator('#message').inputValue(), 'draft in the main box');
  await owner.locator('#message').fill('');
  record('A quick ask reaches her conversation and keeps your draft');

  // Focus mode from the panel hides her; again brings her back.
  const ownerVisible = () =>
    application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((w) => w.webContents.getURL() === 'capri://desktop/index.html')
        .isVisible(),
    );
  const openPanel = async () => {
    await application.evaluate(() =>
      globalThis.capriMenuBarVerification.panel.show({ x: 900, y: 0, width: 30, height: 24 }),
    );
    await until(
      () => application.evaluate(() => globalThis.capriMenuBarVerification.panel.visible),
      'The panel did not reopen',
    );
  };
  await openPanel();
  await panel.locator('#tiles button[data-id="focus"]').click();
  await until(async () => !(await ownerVisible()), 'Focus mode did not hide Capri');
  await panel.waitForFunction(
    () =>
      document.querySelector('#tiles button[data-id="focus"]')?.getAttribute('aria-pressed') ===
      'true',
  );
  await openPanel();
  await panel.locator('#tiles button[data-id="focus"]').click();
  await until(ownerVisible, 'Focus mode did not end');
  record('The Focus tile hides and restores her');

  // Escape closes the panel.
  await openPanel();
  await panel.keyboard.press('Escape');
  await until(
    () => application.evaluate(() => !globalThis.capriMenuBarVerification.panel.visible),
    'Escape did not close the panel',
  );
  record('Escape closes the panel');

  // Settings: the "On your Mac" card applies through the normal draft flow.
  const settings = await settingsView(application, 'general');
  const card = settings.locator('#general-macos');
  assert.equal(await card.isVisible(), true);
  assert.equal(await settings.locator('#general-open-at-login-row').isVisible(), false);
  await settings.locator('#general-show-in-dock').click();
  await settings.locator('#general-menu-bar-icon').selectOption('plain');
  await card.screenshot({ path: path.join(folder, 'on-your-mac.png') });
  await saveSettings(settings);
  const saved = await application.evaluate(({ app }) => ({
    snapshot: globalThis.capriMenuBarVerification.settingsSnapshot(),
    shown: globalThis.capriMenuBarVerification.shownIcon,
    dock: app.dock?.isVisible(),
  }));
  assert.equal(saved.snapshot.showInDock, false);
  assert.equal(saved.snapshot.iconStyle, 'plain');
  assert.equal(saved.shown, 'plain:idle:0');
  assert.equal(saved.dock, false);
  assert.deepEqual(
    JSON.parse(readFileSync(path.join(folder, 'desktop/menu-bar.json'), 'utf8')).settings,
    { showInDock: false, iconStyle: 'plain', showMood: true },
  );
  record('Settings hides the Dock icon and switches to the plain bolt');

  // The app menu checkbox changes the same setting and Settings follows.
  await application.evaluate(({ Menu }) =>
    Menu.getApplicationMenu().getMenuItemById('show-in-dock').click(),
  );
  await settings.waitForFunction(
    () => document.getElementById('general-show-in-dock').getAttribute('aria-pressed') === 'true',
  );
  assert.equal(
    await application.evaluate(() => globalThis.capriMenuBarVerification.settings.showInDock),
    true,
  );
  record('The app menu Dock switch updates Settings');
  assert.deepEqual(report.errors, []);
} finally {
  await application?.close();
  await new Promise((resolve) => server.close(resolve));
  writeFileSync(path.join(folder, 'report.json'), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report));
