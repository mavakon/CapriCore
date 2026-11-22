// SPDX-License-Identifier: GPL-3.0-only
/**
 * Entry point of Capri.app (Contents/Resources/app/launcher.mjs).
 *
 * On a normal launch the installation in ~/Library/Application Support/Capri
 * already runs this app's payload, so this process becomes the Capri desktop:
 * it imports the installed apps/desktop/main.mjs before Electron is ready, the
 * same file `npm run desktop` starts from a checkout. Running in this process
 * keeps a single Dock icon with the app's own name and bundle identifier, and
 * macOS privacy prompts name Capri.
 *
 * On the first launch, after the app was replaced by a newer build, or when a
 * copy was interrupted, it opens the setup window instead. That window copies
 * the payload into the installation folder and, the first time, runs first-run
 * setup (model choice and downloads). The app then restarts itself.
 */
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } from 'electron';
import { execFile } from 'node:child_process';
import { accessSync, constants, existsSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import {
  PAYLOAD_FOLDER,
  installationState,
  inspectRoot,
  macosLocations,
  readBuild,
  readJsonFile,
  readManifest,
  syncInstallation,
} from './install-root.mjs';
import { createLauncherLog, errorDetails } from './log.mjs';

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE_IDENTIFIER = 'com.capri-core.desktop';
const SYSTEM_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
const resources = process.resourcesPath;
const appPath = path.resolve(process.execPath, '..', '..', '..');
const locations = macosLocations({ home: os.homedir(), bundleIdentifier: BUNDLE_IDENTIFIER });
const { root } = locations;
const log = createLauncherLog(locations.logs);
const installed = (file) => pathToFileURL(path.join(root, ...file.split('/'))).href;

/** True for a copy inside a mounted disk image or one macOS runs from a randomized path. */
export function runsFromTemporaryLocation(location = appPath) {
  if (location.includes('/AppTranslocation/')) return true;
  if (!location.startsWith('/Volumes/')) return false;
  try {
    accessSync(path.dirname(location), constants.W_OK);
    return false;
  } catch {
    return true;
  }
}

/** Environment for Capri's own command-line tools, without Electron's or a shell's overrides. */
function commandEnvironment() {
  const env = { ...process.env, PATH: SYSTEM_PATH };
  for (const name of Object.keys(env))
    if (/^(?:ELECTRON_|NODE_|OPENCLAW_|CAPRI_|npm_)/i.test(name)) delete env[name];
  return env;
}

function bundledNodeFor(folder) {
  try {
    const core = readJsonFile(path.join(folder, 'config/core.json'), 65536);
    const node = path.join(
      folder,
      '.runtime',
      `node-v${core.nodeVersion}-darwin-arm64`,
      'bin/node',
    );
    return existsSync(node) ? node : null;
  } catch {
    return null;
  }
}

let build;
let mode = 'setup';
let startupError = null;
try {
  build = readBuild(resources);
  const state = installationState(root, build);
  if (state.installed && state.setupComplete && !runsFromTemporaryLocation()) mode = 'desktop';
  log('launch', { mode, version: build.version, app: appPath, pending: state.pending });
} catch (error) {
  startupError = error;
  log('launch-failed', errorDetails(error));
}

async function fatal(title, error) {
  log('fatal', { title, ...errorDetails(error) });
  await app.whenReady();
  const { response } = await dialog.showMessageBox({
    type: 'error',
    title: 'Capri',
    message: title,
    detail: String(error?.message ?? error).slice(0, 1500),
    buttons: ['Quit', 'Show Logs'],
    defaultId: 0,
  });
  if (response === 1) await shell.openPath(locations.logs);
  app.exit(1);
}

/**
 * Starts the desktop in this process, like `capri.mjs desktop` starts it in an
 * Electron child: the same environment, folders and process marker.
 */
async function startDesktop() {
  process.chdir(root);
  const { updateBlocksStartup } = await import(
    installed('packages/runtime/src/host/update-state.mjs')
  );
  if (updateBlocksStartup(root))
    throw new Error(
      'An update is in progress or was interrupted. Open Capri again after it finishes, or install the app again.',
    );
  const { runtime, initialize } = await import(installed('packages/runtime/src/context.mjs'));
  const { environment } = await import(installed('packages/runtime/src/host/environment.mjs'));
  const { managedProcess, markerPath, processStartedAt, PRIVATE_SERVICE_LOG_SCHEMA } = await import(
    installed('packages/runtime/src/host/processes.mjs')
  );
  const { writeJsonAtomic } = await import(installed('packages/runtime/src/atomic-json.mjs'));
  const running = managedProcess('desktop');
  if (running && running.pid !== process.pid) {
    // Another copy of the app owns this installation: bring it forward instead.
    writeFileSync(
      path.join(root, 'data/run/desktop.show'),
      JSON.stringify({ show: true, launchNonce: null }),
    );
    log('desktop-already-running', { pid: running.pid });
    app.exit(0);
    return;
  }
  const rt = runtime();
  initialize(rt);
  Object.assign(process.env, environment(rt), {
    CAPRI_MACOS_APP: appPath,
    CAPRI_MACOS_LOGS: locations.logs,
  });
  // Electron reads an empty value as run-as-node for every helper it starts.
  delete process.env.ELECTRON_RUN_AS_NODE;
  for (const action of ['stop', 'show'])
    try {
      unlinkSync(path.join(root, 'data/run', `desktop.${action}`));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  const main = path.join(root, 'apps/desktop/main.mjs');
  await import(pathToFileURL(main).href);
  // A second launch only notifies the running desktop and exits; it must not
  // replace the owner's marker.
  if (!app.hasSingleInstanceLock()) return;
  const startedAt = processStartedAt(process.pid);
  if (startedAt)
    writeJsonAtomic(markerPath('desktop'), {
      pid: process.pid,
      startedAt,
      executable: process.execPath,
      args: [main],
      projectRoot: root,
      privateLogSchema: PRIVATE_SERVICE_LOG_SCHEMA,
    });
  log('desktop-started', { version: build.version });
}

// ---------------------------------------------------------------------------
// Setup window
// ---------------------------------------------------------------------------

let window = null;
let snapshot = { phase: 'starting' };
let setupController = null;
let setupTask = null;
let options = null;

function publish(patch) {
  snapshot = { ...snapshot, ...patch };
  if (window && !window.isDestroyed()) window.webContents.send('setup:state', snapshot);
}
function forward(event) {
  if (window && !window.isDestroyed()) window.webContents.send('setup:event', event);
}

function setupWindow() {
  window = new BrowserWindow({
    width: 760,
    height: 680,
    minWidth: 640,
    minHeight: 520,
    show: false,
    title: 'Capri Setup',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1b22' : '#f7f5fb',
    webPreferences: {
      preload: path.join(here, 'setup/preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.once('ready-to-show', () => window.show());
  window.on('close', (event) => {
    if (!setupTask) return;
    event.preventDefault();
    const choice = dialog.showMessageBoxSync(window, {
      type: 'question',
      message: 'Stop setting up Capri?',
      detail: 'Downloads stop now. Open Capri again to continue later.',
      buttons: ['Continue Setup', 'Stop and Quit'],
      defaultId: 0,
      cancelId: 0,
    });
    if (choice !== 1) return;
    setupController?.abort(new Error('Setup cancelled'));
    void setupTask.finally(() => app.exit(0));
  });
  void window.loadFile(path.join(here, 'setup/index.html'));
}

function fromSetupWindow(event) {
  return (
    window &&
    !window.isDestroyed() &&
    event.sender === window.webContents &&
    event.senderFrame === window.webContents.mainFrame &&
    event.senderFrame.url === pathToFileURL(path.join(here, 'setup/index.html')).href
  );
}
function handle(channel, task) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!fromSetupWindow(event)) throw new Error('Unexpected sender.');
    return task(...args);
  });
}

async function relaunch() {
  log('relaunch', { reason: snapshot.phase });
  app.relaunch({ args: [] });
  app.exit(0);
}

/** Quits services an earlier version left running before their files change. */
async function stopInstalledServices() {
  const node = bundledNodeFor(root);
  const core = path.join(root, 'packages/runtime/bin/core.mjs');
  if (!node || !existsSync(core)) return;
  publish({ phase: 'stopping' });
  try {
    await run(node, [core, 'stop'], {
      cwd: root,
      env: commandEnvironment(),
      timeout: 6 * 60 * 1000,
      maxBuffer: 1024 * 1024,
    });
    log('services-stopped');
  } catch (error) {
    // Replacing files is still safe for processes that keep running: they keep
    // the files they opened, and the new desktop restarts outdated services.
    log('services-stop-failed', errorDetails(error));
  }
}

async function clearQuarantine(manifest) {
  try {
    await run('/usr/bin/xattr', ['-p', 'com.apple.quarantine', appPath], {
      env: commandEnvironment(),
    });
  } catch {
    return; // The app was not downloaded by a browser: nothing to clear.
  }
  // macOS already let this app open. Its copied runtimes inherit that approval.
  const tops = [...new Set(manifest.files.map(([name]) => name.split('/')[0]))];
  for (const name of tops)
    await run('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', path.join(root, name)], {
      env: commandEnvironment(),
      timeout: 120000,
    }).catch((error) => log('quarantine-clear-failed', { name, ...errorDetails(error) }));
}

async function install() {
  publish({ phase: 'checking', error: null });
  const manifest = readManifest(resources, build);
  const { fresh } = inspectRoot(root, manifest.version);
  if (!fresh) await stopInstalledServices();
  publish({ phase: 'installing', fresh, progress: null });
  const started = Date.now();
  const result = await syncInstallation({
    payload: path.join(resources, PAYLOAD_FOLDER),
    manifest,
    root,
    appPath,
    onProgress: (progress) => publish({ phase: 'installing', progress }),
  });
  await clearQuarantine(manifest);
  log('synced', {
    version: manifest.version,
    files: result.files,
    copied: result.copied,
    removed: result.removed,
    fresh: result.fresh,
    seconds: Math.round((Date.now() - started) / 1000),
  });
}

async function loadOptions() {
  const setup = await import(installed('packages/installer/src/macos-setup.mjs'));
  options = await setup.macosSetupOptions({
    root,
    version: build.version,
    preferredLanguages: app.getPreferredSystemLanguages(),
  });
  return setup;
}

async function prepare() {
  try {
    if (runsFromTemporaryLocation()) {
      publish({ phase: 'move', appPath, canMove: applicationsFolder() !== null });
      return;
    }
    const state = installationState(root, build);
    if (!state.installed) await install();
    if (installationState(root, build).setupComplete) {
      publish({ phase: 'updated' });
      await relaunch();
      return;
    }
    await loadOptions();
    publish({ phase: 'wizard', options });
  } catch (error) {
    log('prepare-failed', errorDetails(error));
    publish({ phase: 'failed', error: error.message, code: error.code ?? null, retry: 'prepare' });
  }
}

function applicationsFolder() {
  for (const folder of ['/Applications', path.join(os.homedir(), 'Applications')])
    try {
      accessSync(folder, constants.W_OK);
      return folder;
    } catch {
      /* Try the next folder. */
    }
  return null;
}

async function moveToApplications() {
  const folder = applicationsFolder();
  if (!folder) throw new Error('Drag Capri into your Applications folder, then open it there.');
  const target = path.join(folder, 'Capri.app');
  if (existsSync(target)) {
    const choice = await dialog.showMessageBox(window, {
      type: 'question',
      message: 'Replace the Capri app in Applications?',
      detail: 'Your conversations, memory and models are kept. The old app goes to the Trash.',
      buttons: ['Replace', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
    });
    if (choice.response !== 0) return false;
    await shell.trashItem(target);
  }
  publish({ phase: 'moving' });
  await run('/usr/bin/ditto', [appPath, target], { env: commandEnvironment(), timeout: 600000 });
  log('moved', { target });
  await run('/usr/bin/open', ['-n', target], { env: commandEnvironment() });
  app.exit(0);
  return true;
}

async function runSetup(request) {
  if (setupTask) throw new Error('Setup is already running.');
  const setup = await import(installed('packages/installer/src/macos-setup.mjs'));
  setupController = new AbortController();
  publish({ phase: 'running', error: null });
  log('setup-started', {
    inferenceMode: request?.inferenceMode,
    modelSource: request?.modelSource,
    profile: request?.profile,
  });
  setupTask = setup
    .runMacosSetup(request, {
      root,
      sourceRoot: path.join(resources, PAYLOAD_FOLDER),
      version: build.version,
      signal: setupController.signal,
      emit: forward,
    })
    .then(() => {
      log('setup-complete');
      publish({ phase: 'complete' });
    })
    .catch((error) => {
      const cancelled = setupController.signal.aborted;
      log(cancelled ? 'setup-cancelled' : 'setup-failed', errorDetails(error));
      publish({
        phase: cancelled ? 'wizard' : 'failed',
        error: cancelled ? null : error.message,
        retry: 'wizard',
      });
    })
    .finally(() => {
      setupTask = null;
      setupController = null;
    });
  return true;
}

async function startSetup() {
  if (!app.requestSingleInstanceLock()) {
    app.exit(0);
    return;
  }
  app.on('second-instance', () => {
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });
  app.on('window-all-closed', () => app.quit());
  handle('setup:state', () => snapshot);
  handle('setup:retry', async (step) => {
    if (setupTask) return snapshot;
    if (step === 'wizard' && options) publish({ phase: 'wizard', error: null, options });
    else await prepare();
    return snapshot;
  });
  handle('setup:refresh', async () => {
    if (setupTask) return snapshot;
    await loadOptions();
    publish({ options });
    return snapshot;
  });
  handle('setup:run', (request) => runSetup(request));
  handle('setup:cancel', () => {
    setupController?.abort(new Error('Setup cancelled'));
    return true;
  });
  handle('setup:move', () => moveToApplications());
  handle('setup:open-logs', () => shell.openPath(locations.logs));
  handle('setup:show-data', () => shell.openPath(existsSync(root) ? root : path.dirname(root)));
  handle('setup:finish', () => relaunch());
  handle('setup:quit', () => app.quit());
  await app.whenReady();
  setupWindow();
  await prepare();
}

// Electron emits `ready` only after this module, including its top-level
// awaits, has finished. Code that waits for `ready` must therefore not be
// awaited here; the desktop import must be, so it runs before `ready`.
if (startupError) void fatal('Capri could not read this app.', startupError);
else if (mode === 'desktop') {
  try {
    await startDesktop();
  } catch (error) {
    void fatal('Capri could not start.', error);
  }
} else {
  app.setName('Capri');
  app.setPath('userData', locations.launcherProfile);
  app.setPath('sessionData', locations.launcherProfile);
  app.setPath('crashDumps', path.join(locations.launcherProfile, 'Crashes'));
  void startSetup().catch((error) => fatal('Capri Setup could not start.', error));
}
