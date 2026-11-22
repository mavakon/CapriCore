// SPDX-License-Identifier: GPL-3.0-only
// The macOS helper's JavaScript side, with the platform injected so it runs on
// every host. tests/macos-helpers-native.test.mjs runs the real binary on macOS.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import {
  buildMacosHelper,
  ensureMacosHelper,
  macosHelperEnvironment,
  macosHelperExecutable,
  macosHelperReady,
  macosHelperSourceHash,
  macosHelperTarget,
  MACOS_HELPER_DIRECTORY,
} from '../packages/runtime/src/host/macos-helper.mjs';
import { ScreenFrameWorker } from '../apps/desktop/screen-frame-worker.mjs';
import { captureActiveDisplay } from '../apps/desktop/native-screenshot.mjs';
import { WindowsObserver } from '../apps/desktop/windows-observer.mjs';
import { SpotifyWorker } from '../integrations/spotify/service.mjs';
import { spotifyBridgeReady } from '../integrations/spotify/configuration.mjs';
import { WindowsAudioEndpoints } from '../apps/desktop/windows-audio-endpoints.mjs';
import { NativeEscapeStop } from '../apps/desktop/native-escape-stop.mjs';
import { applicationBridgeExecutable } from '../integrations/desktop-actions/service.mjs';
import {
  MacosGpuSampler,
  parseMacosGpuSample,
} from '../packages/runtime/src/hardware/macos-gpu.mjs';
import { FullComputerAccess } from '../apps/desktop/full-computer-access.mjs';
import {
  ACCESSIBILITY_REQUIRED,
  MacosComputerPermissions,
} from '../apps/desktop/main/macos-permissions.mjs';
import { installScreenPoints } from '../apps/desktop/main/screen-points.mjs';
import { ControlOverlay } from '../apps/desktop/main/control-overlay.mjs';

const parent = path.resolve('.runtime/test-data');
mkdirSync(parent, { recursive: true });
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const darwin = { platform: 'darwin' };

/** A checkout with helper sources and, optionally, a receipt-verified build. */
function checkout({ built = true } = {}) {
  const root = mkdtempSync(path.join(parent, 'macos-helper-'));
  const sources = path.join(root, 'packages/macos-helpers/Sources');
  mkdirSync(sources, { recursive: true });
  writeFileSync(path.join(sources, 'main.swift'), 'print("fixture")\n');
  writeFileSync(path.join(sources, 'Common.swift'), '// fixture\n');
  if (built) install(root, 'compiled fixture');
  return root;
}

function install(root, bytes) {
  const sourceSha256 = macosHelperSourceHash(root);
  const folder = sourceSha256.slice(0, 16);
  const directory = path.join(root, MACOS_HELPER_DIRECTORY);
  mkdirSync(path.join(directory, folder), { recursive: true });
  writeFileSync(path.join(directory, folder, 'capri-macos-helper'), bytes);
  writeFileSync(
    path.join(directory, 'build.json'),
    JSON.stringify({
      schemaVersion: 1,
      sourceSha256,
      artifact: `${folder}/capri-macos-helper`,
      executableSha256: sha256(bytes),
      target: 'arm64-apple-macos14.0',
    }),
  );
  return path.join(directory, folder, 'capri-macos-helper');
}

function fakeChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.written = '';
  child.stdin.on('data', (chunk) => (child.written += chunk));
  child.kill = () => true;
  child.exitCode = null;
  child.signalCode = null;
  return child;
}

test('the helper receipt ties one executable to the exact Swift sources', () => {
  const root = checkout();
  const executable = macosHelperExecutable(root, darwin);
  assert.equal(path.basename(executable), 'capri-macos-helper');
  assert.equal(macosHelperReady(root, darwin), true);
  assert.throws(() => macosHelperExecutable(root, { platform: 'win32' }), /only on macOS/);

  const before = macosHelperSourceHash(root);
  writeFileSync(path.join(root, 'packages/macos-helpers/Sources/Common.swift'), '// changed\n');
  assert.notEqual(macosHelperSourceHash(root), before);
  assert.throws(
    () => macosHelperExecutable(root, darwin),
    (error) => error.code === 'CAPRI_MACOS_HELPER_UNAVAILABLE' && /out of date/.test(error.message),
  );

  const tampered = install(root, 'compiled fixture');
  writeFileSync(tampered, 'modified executable');
  assert.throws(() => macosHelperExecutable(root, darwin), /integrity check failed/);
  assert.equal(macosHelperReady(root, darwin), false);

  const missing = checkout({ built: false });
  assert.throws(
    () => macosHelperExecutable(missing, darwin),
    (error) =>
      error.code === 'CAPRI_MACOS_HELPER_UNAVAILABLE' && /setup:macos-helpers/.test(error.message),
  );
  mkdirSync(path.join(missing, MACOS_HELPER_DIRECTORY), { recursive: true });
  writeFileSync(path.join(missing, MACOS_HELPER_DIRECTORY, 'build.json'), '{"schemaVersion":2}');
  assert.throws(() => macosHelperExecutable(missing, darwin), /out of date/);
});

test('a packaged helper without sources is verified by its own digest', () => {
  const root = checkout();
  const executable = macosHelperExecutable(root, darwin);
  for (const name of readdirSync(path.join(root, 'packages/macos-helpers/Sources')))
    writeFileSync(path.join(root, 'packages/macos-helpers/Sources', name), 'later edit');
  assert.throws(() => macosHelperExecutable(root, darwin), /out of date/);
  // Without a Sources folder only the executable digest applies.
  const packaged = mkdtempSync(path.join(parent, 'macos-helper-packaged-'));
  mkdirSync(path.join(packaged, MACOS_HELPER_DIRECTORY), { recursive: true });
  const receipt = JSON.parse(readFileSync(path.join(root, MACOS_HELPER_DIRECTORY, 'build.json')));
  mkdirSync(path.join(packaged, MACOS_HELPER_DIRECTORY, path.dirname(receipt.artifact)));
  writeFileSync(
    path.join(packaged, MACOS_HELPER_DIRECTORY, receipt.artifact),
    readFileSync(executable),
  );
  writeFileSync(path.join(packaged, MACOS_HELPER_DIRECTORY, 'build.json'), JSON.stringify(receipt));
  assert.equal(macosHelperReady(packaged, darwin), true);
});

test('helpers get a fixed environment without Capri secrets', () => {
  process.env.CAPRI_SYNTHETIC_HELPER_SECRET = 'must-not-reach-a-helper';
  try {
    const env = macosHelperEnvironment('/fixture/root', { home: '/Users/fixture' });
    assert.deepEqual(Object.keys(env).sort(), ['HOME', 'LANG', 'PATH', 'TMPDIR']);
    assert.equal(env.PATH, '/usr/bin:/bin:/usr/sbin:/sbin');
    assert.equal(env.TMPDIR, path.join('/fixture/root', '.runtime', 'tmp') + '/');
    assert.ok(!Object.values(env).includes('must-not-reach-a-helper'));
  } finally {
    delete process.env.CAPRI_SYNTHETIC_HELPER_SECRET;
  }
  assert.equal(macosHelperTarget('arm64'), 'arm64-apple-macos14.0');
  assert.equal(macosHelperTarget('x64'), 'x86_64-apple-macos14.0');
  assert.throws(() => macosHelperTarget('ia32'), /Unsupported/);
});

/** xcrun as the Command Line Tools answer it. */
const xcrun = (args) => ({
  stdout: args.includes('--show-sdk-path')
    ? '/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk\n'
    : '/Toolchain/usr/bin/swiftc\n',
});

test('the build compiles every source, signs it and writes the receipt last', async () => {
  const root = checkout({ built: false });
  const stale = path.join(root, MACOS_HELPER_DIRECTORY, '0123456789abcdef');
  mkdirSync(stale, { recursive: true });
  const calls = [];
  const run = async (file, args, options) => {
    calls.push({ file, args, options });
    if (file === '/usr/bin/xcrun') return xcrun(args);
    if (file === '/Toolchain/usr/bin/swiftc') {
      assert.equal(existsSync(path.join(root, MACOS_HELPER_DIRECTORY, 'build.json')), false);
      writeFileSync(args[args.indexOf('-o') + 1], 'compiled by fixture');
    }
    return { stdout: '' };
  };
  const executable = await buildMacosHelper(root, { run, arch: 'arm64', ...darwin });
  assert.deepEqual(
    calls.map(({ file }) => file),
    ['/usr/bin/xcrun', '/usr/bin/xcrun', '/Toolchain/usr/bin/swiftc', '/usr/bin/codesign'],
  );
  assert.deepEqual(calls[0].args, ['--sdk', 'macosx', '--find', 'swiftc']);
  assert.deepEqual(calls[1].args, ['--sdk', 'macosx', '--show-sdk-path']);
  const compile = calls[2].args;
  for (const flag of ['-O', '-module-name', 'Capri', '-target', 'arm64-apple-macos14.0'])
    assert.ok(compile.includes(flag), flag);
  // swiftc started by path does not find the SDK on its own.
  assert.equal(
    compile[compile.indexOf('-sdk') + 1],
    '/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk',
  );
  assert.deepEqual(
    compile.filter((value) => value.endsWith('.swift')).map((file) => path.basename(file)),
    ['Common.swift', 'main.swift'],
  );
  assert.deepEqual(calls[3].args.slice(0, 5), [
    '--force',
    '--sign',
    '-',
    '--identifier',
    'com.capri.macos-helper',
  ]);
  assert.equal(macosHelperExecutable(root, darwin), executable);
  assert.equal(existsSync(stale), false, 'earlier builds are removed');
  // A ready helper is reused, not rebuilt.
  calls.length = 0;
  assert.equal(await buildMacosHelper(root, { run, ...darwin }), executable);
  assert.equal(calls.length, 0);
  assert.equal(await ensureMacosHelper(root, { platform: 'linux' }), null);
});

test('a failed compile leaves no helper and no receipt', async () => {
  const root = checkout({ built: false });
  const run = async (file, args) => {
    if (file === '/usr/bin/xcrun') return xcrun(args);
    writeFileSync(args[args.indexOf('-o') + 1], 'partial');
    throw Object.assign(new Error('swiftc failed'), { stderr: 'error: fixture' });
  };
  await assert.rejects(buildMacosHelper(root, { run, ...darwin }), /swiftc failed/);
  assert.equal(macosHelperReady(root, darwin), false);
  const folder = path.join(root, MACOS_HELPER_DIRECTORY, macosHelperSourceHash(root).slice(0, 16));
  assert.deepEqual(readdirSync(folder), []);
  const missing = async () => {
    throw new Error('xcrun: error: unable to find utility');
  };
  await assert.rejects(
    buildMacosHelper(root, { run: missing, ...darwin }),
    /xcode-select --install/,
  );
  const noSdk = async (file, args) =>
    args.includes('--show-sdk-path') ? { stdout: '' } : xcrun(args);
  await assert.rejects(buildMacosHelper(root, { run: noSdk, ...darwin }), /xcode-select --install/);
});

test('macOS screen frames use the helper worker and the shared binary protocol', async () => {
  const root = checkout();
  const child = fakeChild();
  let launch;
  const worker = new ScreenFrameWorker(root, {
    ...darwin,
    spawnImpl: (...args) => {
      launch = args;
      return child;
    },
  });
  const frame = worker.frame({
    region: { x: 0, y: 25, width: 4, height: 2 },
    limit: { width: 2, height: 2 },
    format: 'bgra',
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(launch[0], macosHelperExecutable(root, darwin));
  assert.deepEqual(launch[1], ['screen-worker']);
  assert.deepEqual(Object.keys(launch[2].env).sort(), ['HOME', 'LANG', 'PATH', 'TMPDIR']);
  assert.equal(child.written, 'region||0|25|4|2|2|2|bgra\n');
  const header = Buffer.alloc(32);
  [0, 0, 25, 4, 2, 2, 1, 8].forEach((value, index) => header.writeInt32LE(value, index * 4));
  child.stdout.write(Buffer.concat([header, Buffer.alloc(8, 7)]));
  const result = await frame;
  assert.deepEqual(result.bounds, { x: 0, y: 25, width: 4, height: 2 });
  assert.equal(result.width, 2);
  assert.equal(result.bgra.length, 8);

  const failed = worker.frame({ region: { x: 0, y: 0, width: 4, height: 4 }, format: 'bgra' });
  const failure = Buffer.alloc(32);
  failure.writeInt32LE(1, 0);
  await new Promise((resolve) => setImmediate(resolve));
  child.stdout.write(failure);
  await assert.rejects(failed, /macOS could not capture the selected screen/);
  worker.dispose();
});

test('one-shot macOS screenshots pass only fixed helper arguments', async () => {
  const root = checkout();
  const calls = [];
  const png = Buffer.from(
    '89504e470d0a1a0a0000000d4948445200000002000000010806000000f478d4fa0000000d49444154789c63f8cfc0f01f0005fe02fe0d0ba8b50000000049454e44ae426082',
    'hex',
  );
  const execFileImpl = (file, args, options, done) => {
    calls.push({ file, args, options });
    done(null, JSON.stringify({ x: 0, y: 0, width: 2, height: 1, png: png.toString('base64') }));
  };
  const result = await captureActiveDisplay(root, {
    ...darwin,
    execFileImpl,
    displayWindow: '42',
    withGeometry: true,
  });
  assert.deepEqual(result.bounds, { x: 0, y: 0, width: 2, height: 1 });
  assert.equal(calls[0].file, macosHelperExecutable(root, darwin));
  assert.deepEqual(calls[0].args, ['screen-capture', '--display-window', '42', '--with-geometry']);
  assert.ok(!('SystemRoot' in calls[0].options.env));
  await assert.rejects(
    captureActiveDisplay(checkout({ built: false }), { ...darwin, execFileImpl }),
    /macOS could not capture the active display/,
  );
});

test('macOS window events start the helper observer with the same protocol', async () => {
  const root = checkout();
  const child = fakeChild();
  let launch;
  const observer = new WindowsObserver({
    root,
    ...darwin,
    spawnImpl: (...args) => {
      launch = args;
      return child;
    },
  });
  const started = observer.start({ ignoredProcessIds: [process.pid] });
  assert.deepEqual(launch[1], ['window-events']);
  assert.deepEqual(JSON.parse(child.written), {
    ignoredProcessIds: [process.pid],
    filterProcessId: 0,
  });
  child.stdout.write(
    '{"type":"ready","source":"windows-events","capturesImages":false,"capturesTitles":false}\n',
  );
  assert.equal((await started).active, true);
  const events = [];
  observer.on('observation', (event) => events.push(event));
  child.stdout.write(
    JSON.stringify({
      schemaVersion: 1,
      source: 'windows-events',
      id: 'fixture',
      timestamp: Date.now(),
      confidence: 1,
      kind: 'app.foreground',
      processName: 'Safari',
      processId: 77,
      fullscreen: false,
      windowId: '12345',
    }) + '\n',
  );
  assert.equal(events[0].processName, 'safari');
  assert.equal(events[0].windowId, '12345');
  observer.stop();
  assert.throws(
    () => new WindowsObserver({ root: checkout({ built: false }), ...darwin }).start(),
    /setup:macos-helpers/,
  );
});

test('macOS Spotify control uses the helper and never inherits Gateway credentials', async () => {
  const root = checkout();
  assert.equal(spotifyBridgeReady(root, darwin), true);
  assert.equal(spotifyBridgeReady(checkout({ built: false }), darwin), false);
  const child = fakeChild();
  let launch;
  process.env.OPENCLAW_GATEWAY_TOKEN = 'synthetic-gateway-token';
  try {
    const worker = new SpotifyWorker({
      root,
      ...darwin,
      spawnImpl: (...args) => {
        launch = args;
        return child;
      },
    });
    const pending = worker.send({ action: 'status' });
    assert.deepEqual(launch[1], ['spotify']);
    assert.ok(!Object.values(launch[2].env).includes('synthetic-gateway-token'));
    child.stdout.write(
      '{"type":"ready","protocol":1}\n{"type":"result","request":1,"ok":true,"data":{"running":false,"provider":"macos-desktop"}}\n',
    );
    assert.equal((await pending).data.provider, 'macos-desktop');
    // The same verified helper keeps serving; a rebuilt one replaces it.
    worker.start();
    assert.equal(worker.child, child);
    const blocked = Object.assign(new Error('spawn EACCES'), { code: 'EACCES', syscall: 'spawn' });
    worker.close();
    worker.spawnImpl = () => {
      throw blocked;
    };
    assert.throws(
      () => worker.send({ action: 'status' }),
      (error) =>
        error.code === 'CAPRI_SPOTIFY_HELPER_LAUNCH_FAILED' &&
        /setup:macos-helpers/.test(error.message),
    );
  } finally {
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
  }
});

test('macOS audio devices list and capture through the helper with the shared packet format', async () => {
  const root = checkout();
  const runs = [];
  const endpoints = new WindowsAudioEndpoints({
    root,
    ...darwin,
    prepare: () => assert.fail('the Windows helper is never prepared on macOS'),
    run: async (file, args, options) => {
      runs.push({ file, args, options });
      return {
        stdout: JSON.stringify([
          { id: 'in:BuiltInMicrophoneDevice', kind: 'input', label: 'MacBook Pro Microphone' },
          { id: 'out:BuiltInSpeakerDevice', kind: 'output', label: 'MacBook Pro Speakers' },
        ]),
      };
    },
    spawnProcess: (file, args, options) => {
      runs.push({ file, args, options });
      const child = fakeChild();
      setImmediate(() => child.stdout.write(Buffer.from('CAPRI-AUDIO-1\n')));
      return child;
    },
  });
  assert.deepEqual(
    (await endpoints.list()).map(({ id }) => id),
    ['in:BuiltInMicrophoneDevice', 'out:BuiltInSpeakerDevice'],
  );
  assert.deepEqual(runs[0].args, ['audio-endpoints', 'list']);
  assert.equal(runs[0].file, macosHelperExecutable(root, darwin));
  const capture = await endpoints.capture('out:BuiltInSpeakerDevice', { onPacket: () => {} });
  assert.deepEqual(runs[1].args, ['audio-endpoints', 'capture', 'out:BuiltInSpeakerDevice']);
  assert.ok(!('SystemRoot' in runs[1].options.env));
  capture.stop();
  const linux = new WindowsAudioEndpoints({ root, platform: 'linux' });
  assert.deepEqual(await linux.list(), []);
  await assert.rejects(linux.capture('in:x', { onPacket: () => {} }), /could not start/);
});

test('the Escape watcher and computer bridge resolve the macOS helper with its environment', async () => {
  const root = checkout();
  assert.equal(applicationBridgeExecutable(root, darwin), macosHelperExecutable(root, darwin));
  const child = fakeChild();
  let launch;
  const watcher = new NativeEscapeStop({
    root,
    ...darwin,
    executable: (folder) => applicationBridgeExecutable(folder, darwin),
    parentPid: 42,
    armTimeoutMs: 50,
    env: { PRIVATE_FIXTURE_VALUE: 'must-not-be-in-child-environment' },
    spawnImpl: (...args) => {
      launch = args;
      return child;
    },
  });
  const armed = watcher.start();
  assert.deepEqual(launch[1], []);
  assert.deepEqual(Object.keys(launch[2].env).sort(), ['HOME', 'LANG', 'PATH', 'TMPDIR']);
  assert.deepEqual(JSON.parse(child.written), {
    action: 'computer_watch_escape',
    parentPid: 42,
    durationMs: 600000,
  });
  child.stdout.write('{"ok":true,"event":"armed"}\n');
  assert.equal(await armed, true);
  watcher.stop();
});

test('Apple GPU load is reported without treating unified memory as VRAM', async () => {
  const sample = {
    adapters: [
      {
        id: 'ioreg-4294968123',
        name: 'Apple M4 Pro',
        vendor: 'apple',
        memoryKind: 'shared',
        cores: 16,
        utilization: 37,
        inUseSystemMemoryBytes: 123456789,
      },
      { id: 'ioreg-4294968123', name: 'Duplicate', vendor: 'apple' },
      { id: 'bad id', name: 'Ignored' },
      { id: 'ioreg-1', name: 'Bad\u0000name' },
      { id: 'ioreg-2', name: 'Radeon Pro 5500M', vendor: 'amd', utilization: 140 },
    ],
  };
  assert.deepEqual(parseMacosGpuSample(sample), [
    {
      id: 'ioreg-4294968123',
      name: 'Apple M4 Pro',
      vendor: 'apple',
      memoryKind: 'shared',
      totalBytes: null,
      usedBytes: null,
      freeBytes: null,
      percent: null,
      utilization: 37,
      temperatureCelsius: null,
    },
    {
      id: 'ioreg-2',
      name: 'Radeon Pro 5500M',
      vendor: 'amd',
      memoryKind: 'unknown',
      totalBytes: null,
      usedBytes: null,
      freeBytes: null,
      percent: null,
      utilization: null,
      temperatureCelsius: null,
    },
  ]);
  assert.throws(() => parseMacosGpuSample({}), /unavailable/);
  const calls = [];
  const sampler = new MacosGpuSampler({
    directory: '/fixture/root',
    executable: () => '/fixture/helper',
    runImpl: async (file, args, options) => {
      calls.push({ file, args, options });
      return { stdout: JSON.stringify(sample) };
    },
  });
  assert.equal((await sampler.sample())[0].utilization, 37);
  assert.deepEqual(calls[0].args, ['gpu']);
  assert.equal(calls[0].options.maxBuffer, 65536);
});

test('full computer access on macOS covers the file system root, never Windows drives', async () => {
  const folder = mkdtempSync(path.join(parent, 'macos-access-'));
  let detail;
  const access = new FullComputerAccess({
    ...darwin,
    file: path.join(folder, 'access.json'),
    discover: async () => ['/'],
    confirm: async (options) => {
      detail = options.detail;
      return true;
    },
  });
  await access.configure(true);
  assert.equal(access.enabled, true);
  assert.deepEqual(
    access.scopes().map(({ root }) => root),
    ['/'],
  );
  assert.match(detail, /macOS privacy permissions/);
  assert.doesNotMatch(detail, /Windows/);
  const windowsDrive = new FullComputerAccess({
    ...darwin,
    file: path.join(folder, 'other.json'),
    discover: async () => ['C:\\'],
    confirm: async () => true,
  });
  await assert.rejects(windowsDrive.configure(true), /Invalid full computer access/);
  assert.equal(windowsDrive.enabled, false);
});

test('computer control asks macOS for Accessibility and Screen Recording without granting them', () => {
  const prompts = [];
  let trusted = false,
    screen = 'denied',
    screenRequests = 0;
  const permissions = new MacosComputerPermissions({
    ...darwin,
    systemPreferences: {
      isTrustedAccessibilityClient: (prompt) => {
        prompts.push(prompt);
        return trusted;
      },
      getMediaAccessStatus: (kind) => (kind === 'screen' ? screen : 'granted'),
    },
    requestScreenRecording: () => {
      screenRequests++;
    },
  });
  const missing = permissions.check();
  assert.equal(missing.code, 'COMPUTER_ACCESSIBILITY_REQUIRED');
  assert.equal(missing.inputPerformed, false);
  assert.equal(missing.message, ACCESSIBILITY_REQUIRED);
  assert.deepEqual(prompts, [false, true]);
  permissions.check();
  trusted = true;
  assert.equal(permissions.check(), null);
  return new Promise((resolve) => setImmediate(resolve)).then(() => {
    assert.equal(screenRequests, 1, 'Screen Recording is requested once per run');
    screen = 'granted';
    assert.deepEqual(permissions.status(), { accessibility: true, screenRecording: true });
    const windows = new MacosComputerPermissions({
      platform: 'win32',
      systemPreferences: { isTrustedAccessibilityClient: () => assert.fail() },
    });
    assert.equal(windows.check(), null);
  });
});

test('macOS DIP and screen coordinates are the same points; Windows keeps Electron conversions', () => {
  const screen = { dipToScreenPoint: (point) => ({ x: point.x * 2, y: point.y * 2 }) };
  assert.deepEqual(installScreenPoints(screen, 'darwin'), [
    'dipToScreenRect',
    'screenToDipRect',
    'screenToDipPoint',
  ]);
  const rect = { x: -1440, y: 25, width: 1440, height: 900 };
  assert.deepEqual(screen.dipToScreenRect(null, rect), rect);
  assert.notEqual(screen.dipToScreenRect(null, rect), rect);
  assert.deepEqual(screen.screenToDipPoint({ x: 3, y: 4 }), { x: 3, y: 4 });
  assert.deepEqual(screen.dipToScreenPoint({ x: 3, y: 4 }), { x: 6, y: 8 }, 'existing kept');
  const windows = {};
  assert.deepEqual(installScreenPoints(windows, 'win32'), []);
  assert.equal(windows.dipToScreenRect, undefined);
});

test('the control indicator names its own click-through windows for macOS hit testing', () => {
  const overlay = new ControlOverlay({
    BrowserWindow: class {},
    screen: new EventEmitter(),
    owner: null,
  });
  overlay.windows = [
    { isDestroyed: () => false, getMediaSourceId: () => 'window:4567:0' },
    { isDestroyed: () => true, getMediaSourceId: () => 'window:1:0' },
    { isDestroyed: () => false, getMediaSourceId: () => 'screen:1:0' },
    { isDestroyed: () => false },
  ];
  assert.deepEqual(overlay.passThroughWindowIds(), ['4567']);
});
