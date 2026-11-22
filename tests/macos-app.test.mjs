// SPDX-License-Identifier: GPL-3.0-only
// Capri.app for macOS: payload installation, first-run setup, bundle layout and
// app updates. Everything here runs without macOS tools; the build and the app
// itself are checked on a Mac (docs/macos.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  INSTALLED_FILES,
  PENDING,
  RECEIPT,
  acquireLock,
  inspectRoot,
  installationState,
  macosLocations,
  payloadFingerprint,
  readBuild,
  readManifest,
  syncInstallation,
  validPayloadPath,
  validateManifest,
} from '../apps/macos-launcher/install-root.mjs';
import {
  MACOS_PORT_OFFSET,
  macosRequest,
  macosSetupOptions,
  macosStorageEstimate,
  matchLanguage,
  modelProgress,
  progressTracker,
  readSetupReceipt,
  runMacosSetup,
} from '../packages/installer/src/macos-setup.mjs';
import {
  bundleVersions,
  buildSummary,
  helperPlan,
  iconsetEntries,
  infoPlistChanges,
  payloadFiles,
  payloadManifest,
  shippedDependency,
  shippedSourceFile,
} from '../tools/release/macos-bundle.mjs';
import {
  MACOS_REPOSITORY,
  REPOSITORY,
  releaseAsset,
  releaseAssetName,
  selectRelease,
} from '../packages/updater/src/releases.mjs';
import { approvedUrl } from '../packages/updater/src/github.mjs';
import {
  LEFTOVER,
  SWAP_SCRIPT,
  expectedVersion,
  launchMacosSwap,
  mountPoints,
  stageMacosUpdate,
} from '../packages/updater/src/macos.mjs';
import { UpdateService } from '../apps/desktop/update-service.mjs';
import {
  MACOS_HELPERS,
  buildHelpers,
  macosHelper,
  verifyHelpers,
} from '../tools/release/macos-helpers.mjs';
import { macosHelperSourceHash } from '../packages/runtime/src/host/macos-helper.mjs';
import { installedByMacApp } from '../packages/runtime/src/desktop-launcher.mjs';

const repository = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const GiB = 2 ** 30;
const sha = (value) => createHash('sha256').update(value).digest('hex');
const temporary = (t, name = 'capri-mac-') => {
  const folder = realpathSync(mkdtempSync(path.join(os.tmpdir(), name)));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  return folder;
};
const WINDOWS = process.platform === 'win32';
/** Windows has no execute permission bit, so payload manifests record 0o644 there. */
const EXECUTABLE = WINDOWS ? 0o644 : 0o755;

const M4_PRO = Object.freeze({
  platform: 'darwin',
  arch: 'arm64',
  cpu: 'Apple M4 Pro',
  cpuThreads: 14,
  ramBytes: 24 * GiB,
  availableRamBytes: 16 * GiB,
  gpus: [{ name: 'Apple M4 Pro', memoryKind: 'unified', vramMiB: 18 * 1024 }],
  warnings: [],
});

/** Writes a payload folder and its manifest; `files` maps names to [content, mode]. */
function payload(folder, files, version = '1.2.2') {
  const entries = [];
  for (const [name, [content, mode = 0o644]] of Object.entries(files)) {
    const file = path.join(folder, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
    chmodSync(file, mode);
    entries.push([name, Buffer.byteLength(content), sha(content), mode]);
  }
  entries.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return {
    schemaVersion: 1,
    product: 'capri.desktop',
    platform: 'darwin-arm64',
    version,
    commit: 'abc',
    fingerprint: payloadFingerprint(entries),
    files: entries,
  };
}

test('macOS locations keep code and data in Application Support, logs in Logs', () => {
  const places = macosLocations({
    home: '/Users/someone',
    bundleIdentifier: 'com.capri-core.desktop',
  });
  assert.equal(places.root, '/Users/someone/Library/Application Support/Capri');
  assert.equal(places.logs, '/Users/someone/Library/Logs/Capri');
  assert.equal(
    places.launcherProfile,
    '/Users/someone/Library/Caches/com.capri-core.desktop/Launcher',
  );
  assert.throws(() => macosLocations({ home: 'relative' }));
});

test('payload paths never reach personal data or app state', () => {
  for (const name of ['apps/desktop/main.mjs', '.runtime/node-v24.22.1-darwin-arm64/bin/node'])
    assert.equal(validPayloadPath(name), true, name);
  for (const name of [
    'data/memory.json',
    'logs/x.log',
    '.capri-install.json',
    '.runtime/macos/installed.json',
    '.runtime/updates/x',
    '.git/config',
    'config/core.local.json',
    '../escape',
    'a/../b',
    '/absolute',
    'back\\slash',
    'control\u0001',
    '',
  ])
    assert.equal(validPayloadPath(name), false, JSON.stringify(name));
});

test('manifest validation rejects tampering, duplicates and file/folder clashes', (t) => {
  const folder = temporary(t);
  const manifest = payload(folder, { 'a/b.txt': ['b'], 'c.txt': ['c'] });
  assert.equal(validateManifest(structuredClone(manifest)).version, '1.2.2');
  const tampered = structuredClone(manifest);
  tampered.files[0][1] = 99;
  assert.throws(() => validateManifest(tampered), { code: 'CAPRI_PAYLOAD_INVALID' });
  const duplicate = structuredClone(manifest);
  duplicate.files.push(['A/B.txt', 1, sha('b'), 0o644]);
  duplicate.fingerprint = payloadFingerprint(duplicate.files);
  assert.throws(() => validateManifest(duplicate), /invalid file/);
  const nested = structuredClone(manifest);
  nested.files.push(['c.txt/d', 1, sha('d'), 0o644]);
  nested.fingerprint = payloadFingerprint(nested.files);
  assert.throws(() => validateManifest(nested), /file inside a file/);
  const reserved = structuredClone(manifest);
  reserved.files.push(['data/x', 1, sha('x'), 0o644]);
  reserved.fingerprint = payloadFingerprint(reserved.files);
  assert.throws(() => validateManifest(reserved), /invalid file/);
  const mode = structuredClone(manifest);
  mode.files[0][3] = 0o777;
  mode.fingerprint = payloadFingerprint(mode.files);
  assert.throws(() => validateManifest(mode), /invalid file/);
});

test('the build summary and manifest must describe the same payload', (t) => {
  const resources = temporary(t);
  const manifest = payload(path.join(resources, 'capri'), { 'x.txt': ['x'] });
  writeFileSync(path.join(resources, 'capri-payload.json'), JSON.stringify(manifest));
  const summary = buildSummary(manifest, {
    bundleIdentifier: 'com.capri-core.desktop',
    runtimes: {},
    builtAt: 'now',
  });
  writeFileSync(path.join(resources, 'capri-build.json'), JSON.stringify(summary));
  const build = readBuild(resources);
  assert.equal(readManifest(resources, build).fingerprint, manifest.fingerprint);
  assert.throws(
    () => readManifest(resources, { ...build, fingerprint: 'f'.repeat(64) }),
    /damaged/,
  );
});

test('first launch installs the payload and claims the folder', async (t) => {
  const base = temporary(t);
  const source = path.join(base, 'Capri.app/Contents/Resources/capri');
  const root = path.join(base, 'Application Support/Capri');
  const manifest = payload(source, {
    'apps/desktop/main.mjs': ['main'],
    '.runtime/node-v24.22.1-darwin-arm64/bin/node': ['#!node', 0o755],
    'config/companion-voice.json': ['{"port":8101}'],
  });
  const progress = [];
  const result = await syncInstallation({
    payload: source,
    manifest,
    root,
    appPath: path.join(base, 'Capri.app'),
    onProgress: (value) => progress.push(value),
    now: () => new Date('2026-11-21T00:00:00Z'),
  });
  assert.equal(result.fresh, true);
  assert.equal(result.copied, 3);
  assert.equal(readFileSync(path.join(root, 'apps/desktop/main.mjs'), 'utf8'), 'main');
  const node = statSync(path.join(root, '.runtime/node-v24.22.1-darwin-arm64/bin/node')).mode;
  if (!WINDOWS) assert.equal(node & 0o777, 0o755);
  const identity = JSON.parse(readFileSync(path.join(root, '.capri-install.json'), 'utf8'));
  assert.equal(identity.productId, 'capri.desktop');
  assert.equal(identity.root, root);
  assert.match(identity.installId, /^[a-f0-9-]{36}$/);
  assert.equal(existsSync(path.join(root, PENDING)), false);
  assert.equal(JSON.parse(readFileSync(path.join(root, RECEIPT), 'utf8')).files, 3);
  const state = installationState(root, manifest);
  assert.equal(state.installed, true);
  assert.equal(state.setupComplete, false);
  assert.equal(progress.at(-1).done, 3);

  // The same payload again copies nothing. (Windows reports 0o666 for every
  // file, so there the recorded modes never match and files are copied again.)
  const again = await syncInstallation({ payload: source, manifest, root });
  if (!WINDOWS) {
    assert.equal(again.copied, 0);
    assert.equal(again.kept, 3);
  }
  assert.equal(again.identity.installId, identity.installId);
});

test('an upgrade replaces code, removes stale files and keeps personal data', async (t) => {
  const base = temporary(t);
  const root = path.join(base, 'Capri');
  const first = payload(path.join(base, 'v1'), {
    'apps/a.mjs': ['one'],
    'apps/old.mjs': ['old'],
    'apps/edited.mjs': ['shipped'],
    'gone/deep/file.txt': ['x'],
    'config/companion-voice.json': ['{"port":8101}'],
  });
  await syncInstallation({ payload: path.join(base, 'v1'), manifest: first, root });
  // Personal data and settings the user or setup changed.
  mkdirSync(path.join(root, 'data'), { recursive: true });
  writeFileSync(path.join(root, 'data/memory.json'), 'mine');
  writeFileSync(path.join(root, 'config/core.local.json'), '{"model":"x"}');
  writeFileSync(path.join(root, 'config/companion-voice.json'), '{"port":8201}');
  writeFileSync(path.join(root, 'apps/edited.mjs'), 'patched by the user');
  const second = payload(
    path.join(base, 'v2'),
    {
      'apps/a.mjs': ['two'],
      'apps/new.mjs': ['new'],
      'config/companion-voice.json': ['{"port":8101,"new":true}'],
    },
    '1.3.0',
  );
  const result = await syncInstallation({
    payload: path.join(base, 'v2'),
    manifest: second,
    root,
    now: () => new Date('2026-11-21T01:02:03Z'),
  });
  assert.equal(result.fresh, false);
  assert.equal(readFileSync(path.join(root, 'apps/a.mjs'), 'utf8'), 'two');
  assert.equal(readFileSync(path.join(root, 'apps/new.mjs'), 'utf8'), 'new');
  assert.equal(existsSync(path.join(root, 'apps/old.mjs')), false);
  assert.equal(existsSync(path.join(root, 'gone')), false, 'empty folders are pruned');
  assert.equal(existsSync(path.join(root, 'apps/edited.mjs')), false);
  assert.equal(
    readFileSync(
      path.join(root, '.runtime/macos/replaced/2026-11-21T01-02-03-000Z/apps/edited.mjs'),
      'utf8',
    ),
    'patched by the user',
  );
  assert.equal(readFileSync(path.join(root, 'data/memory.json'), 'utf8'), 'mine');
  assert.equal(readFileSync(path.join(root, 'config/core.local.json'), 'utf8'), '{"model":"x"}');
  assert.equal(
    readFileSync(path.join(root, 'config/companion-voice.json'), 'utf8'),
    '{"port":8201}',
    'settings that setup rewrites keep the installed copy',
  );
  assert.equal(JSON.parse(readFileSync(path.join(root, '.capri-install.json'))).version, '1.3.0');
  assert.deepEqual(
    JSON.parse(readFileSync(path.join(root, INSTALLED_FILES), 'utf8')).files.map(([name]) => name),
    second.files.map(([name]) => name),
  );
});

test('a damaged payload stops the copy and leaves the folder marked incomplete', async (t) => {
  const base = temporary(t);
  const root = path.join(base, 'Capri');
  const manifest = payload(path.join(base, 'p'), { 'a.txt': ['a'], 'b.txt': ['b'] });
  writeFileSync(path.join(base, 'p/b.txt'), 'B');
  await assert.rejects(
    syncInstallation({ payload: path.join(base, 'p'), manifest, root, concurrency: 1 }),
    { code: 'CAPRI_PAYLOAD_INVALID' },
  );
  assert.equal(existsSync(path.join(root, PENDING)), true);
  assert.equal(installationState(root, manifest).installed, false);
  assert.equal(existsSync(path.join(root, '.runtime/macos/sync.lock')), false);
});

test('Capri never adopts unrelated folders or downgrades its data', async (t) => {
  const base = temporary(t);
  const unrelated = path.join(base, 'unrelated');
  mkdirSync(unrelated);
  writeFileSync(path.join(unrelated, 'notes.txt'), 'x');
  assert.throws(() => inspectRoot(unrelated, '1.0.0'), { code: 'CAPRI_UNRELATED' });
  const finder = path.join(base, 'finder');
  mkdirSync(finder);
  writeFileSync(path.join(finder, '.DS_Store'), '');
  assert.equal(inspectRoot(finder, '1.0.0').fresh, true);
  const root = path.join(base, 'Capri');
  const newer = payload(path.join(base, 'p'), { 'a.txt': ['a'] }, '2.0.0');
  await syncInstallation({ payload: path.join(base, 'p'), manifest: newer, root });
  assert.throws(() => inspectRoot(root, '1.9.9'), { code: 'CAPRI_NEWER_INSTALLED' });
  const moved = path.join(base, 'Moved');
  cpSync(root, moved, { recursive: true });
  assert.throws(() => inspectRoot(moved, '2.0.0'), { code: 'CAPRI_IDENTITY' });
  const link = path.join(base, 'link');
  symlinkSync(root, link);
  assert.throws(() => inspectRoot(link, '2.0.0'), { code: 'CAPRI_LINKED_PATH' });
});

test('one writer at a time; a lock left by an ended process is reclaimed', (t) => {
  const root = temporary(t);
  mkdirSync(path.join(root, '.runtime/macos'), { recursive: true });
  writeFileSync(path.join(root, '.runtime/macos/sync.lock'), JSON.stringify({ pid: process.ppid }));
  assert.throws(() => acquireLock(root), { code: 'CAPRI_SYNC_BUSY' });
  const ended = spawnSync(process.execPath, ['-e', '0']).pid;
  writeFileSync(path.join(root, '.runtime/macos/sync.lock'), JSON.stringify({ pid: ended }));
  const release = acquireLock(root);
  release();
  assert.equal(existsSync(path.join(root, '.runtime/macos/sync.lock')), false);
});

test('Capri.app identity, helpers and versions follow macOS rules', () => {
  assert.deepEqual(bundleVersions('v1.2.2'), { short: '1.2.2', full: '1.2.2' });
  assert.deepEqual(bundleVersions('1.3.0-beta.2'), { short: '1.3.0', full: '1.3.0-beta.2' });
  assert.throws(() => bundleVersions('1.2'));
  const changes = Object.fromEntries(
    infoPlistChanges({
      name: 'Capri',
      bundleIdentifier: 'com.capri-core.desktop',
      version: 'v1.3.0-beta.2',
      category: 'public.app-category.productivity',
      commit: 'abc',
    }).map(([key, type, value]) => [key, type === null ? null : value]),
  );
  assert.equal(changes.CFBundleExecutable, 'Capri');
  assert.equal(changes.CFBundleIdentifier, 'com.capri-core.desktop');
  assert.equal(changes.CFBundleShortVersionString, '1.3.0');
  assert.equal(changes.CapriVersion, '1.3.0-beta.2');
  assert.equal(changes.ElectronAsarIntegrity, null);
  for (const key of [
    'NSMicrophoneUsageDescription',
    'NSCameraUsageDescription',
    'NSAudioCaptureUsageDescription',
    'NSAppleEventsUsageDescription',
    'NSLocalNetworkUsageDescription',
  ])
    assert.match(changes[key], /Capri/, key);
  const helpers = helperPlan('Capri', 'com.capri-core.desktop');
  assert.deepEqual(
    helpers.map((item) => item.to),
    [
      'Capri Helper.app',
      'Capri Helper (GPU).app',
      'Capri Helper (Renderer).app',
      'Capri Helper (Plugin).app',
    ],
  );
  assert.equal(helpers[1].bundleIdentifier, 'com.capri-core.desktop.helper.GPU');
  assert.deepEqual(
    iconsetEntries().map(([, size]) => size),
    [16, 32, 32, 64, 128, 256, 256, 512, 512, 1024],
  );
  assert.equal(shippedDependency('node_modules/electron/dist/Electron.app'), false);
  assert.equal(shippedDependency('node_modules/openclaw/openclaw.mjs'), true);
  assert.equal(shippedSourceFile('Install Capri.cmd'), false);
  assert.equal(shippedSourceFile('start.cmd'), false);
  assert.equal(shippedSourceFile('.github/workflows/ci.yml'), false);
  assert.equal(shippedSourceFile('scripts/windows/helper.cmd'), true);
  assert.equal(shippedSourceFile('.python-version'), true);
  assert.equal(shippedSourceFile('apps/desktop/main.mjs'), true);
});

test('the build lists regular files only, with their modes, in a stable order', async (t) => {
  const folder = temporary(t);
  payload(folder, { 'b.txt': ['b'], 'a/run.sh': ['#!/bin/sh', 0o755] });
  const manifest = await payloadManifest(folder, { version: 'v1.2.2', commit: 'abc' });
  assert.deepEqual(
    manifest.files.map(([name, size, , mode]) => [name, size, mode]),
    [
      ['a/run.sh', 9, EXECUTABLE],
      ['b.txt', 1, 0o644],
    ],
  );
  assert.equal(manifest.version, '1.2.2');
  symlinkSync('b.txt', path.join(folder, 'link'));
  assert.throws(() => payloadFiles(folder), /only files and folders/);
  rmSync(path.join(folder, 'link'));
  mkdirSync(path.join(folder, 'data'));
  writeFileSync(path.join(folder, 'data/private.json'), '{}');
  assert.throws(() => payloadFiles(folder), /outside the app layout/);
});

test('macOS updates use the disk image from the macOS port releases', () => {
  const release = {
    tag_name: 'v1.3.0',
    assets: [
      {
        id: 7,
        name: 'Capri-1.3.0-macos-arm64.dmg',
        state: 'uploaded',
        size: 900 * 1024 ** 2,
        digest: 'sha256:' + 'a'.repeat(64),
      },
    ],
  };
  assert.equal(releaseAssetName('v1.3.0-beta.1', 'macos'), 'Capri-1.3.0-beta.1-macos-arm64.dmg');
  assert.equal(releaseAssetName('v1.3.0', 'installer'), 'CapriSetup-1.3.0.exe');
  assert.throws(() => releaseAssetName('v1.3.0', 'linux'));
  assert.equal(releaseAsset(release, 'macos').bytes, 900 * 1024 ** 2);
  assert.equal(releaseAsset(release, 'installer'), null, 'Windows never takes a disk image');
  assert.equal(
    releaseAsset({ ...release, assets: [{ ...release.assets[0], size: 3 * GiB }] }, 'macos'),
    null,
  );
  assert.equal(selectRelease([release], { current: 'v1.2.2', kind: 'macos' }).tag_name, 'v1.3.0');
  assert.equal(selectRelease([release], { current: 'v1.3.0', kind: 'macos' }), null);
  assert.equal(
    approvedUrl(
      `https://api.github.com/repos/${MACOS_REPOSITORY}/releases/assets/7`,
      MACOS_REPOSITORY,
    ).hostname,
    'api.github.com',
  );
  assert.throws(() =>
    approvedUrl('https://api.github.com/repos/other/repo/releases', 'other/repo'),
  );
  assert.notEqual(MACOS_REPOSITORY, REPOSITORY);
});

function updateFixture(t, options = {}) {
  const root = temporary(t);
  mkdirSync(path.join(root, 'config'));
  writeFileSync(
    path.join(root, 'config/release.json'),
    JSON.stringify({ schemaVersion: 1, tag: 'v1.2.2' }),
  );
  const image = Buffer.from('disk image');
  const release = {
    tag_name: 'v1.3.0',
    assets: [
      {
        id: 7,
        name: 'Capri-1.3.0-macos-arm64.dmg',
        state: 'uploaded',
        size: image.length,
        digest: 'sha256:' + sha(image),
      },
    ],
  };
  const calls = [];
  const service = new UpdateService({
    root,
    state: path.join(root, 'state'),
    node: process.execPath,
    platform: 'darwin',
    macApp: '/Applications/Capri.app',
    credential: async () => 'private-token',
    releases: async (request) => {
      calls.push(['releases', request.repository, request.token]);
      return [release];
    },
    download: async (asset, folder, request) => {
      calls.push(['download', asset.name, request.repository, request.token]);
      mkdirSync(folder, { recursive: true });
      writeFileSync(path.join(folder, 'artifact'), image);
      return path.join(folder, 'artifact');
    },
    stageMacApp: async (request) => {
      calls.push(['stage', request]);
      return {
        staged: '/Applications/.Capri-update-x.app',
        backup: '/Applications/.Capri-previous-x.app',
      };
    },
    swapMacApp: (request) => calls.push(['swap', request]),
    openImage: async (file) => calls.push(['open', file]),
    ...options,
  });
  return { service, calls, root };
}

test('Capri.app updates replace the app after a verified download', async (t) => {
  const { service, calls } = updateFixture(t);
  assert.equal(service.mode, 'macos');
  assert.equal((await service.check()).phase, 'available');
  assert.deepEqual(calls[0], ['releases', MACOS_REPOSITORY, null]);
  assert.equal((await service.prepare()).phase, 'ready');
  assert.deepEqual(calls[1], ['download', 'Capri-1.3.0-macos-arm64.dmg', MACOS_REPOSITORY, null]);
  assert.match(service.prepared.image, /\.dmg$/);
  let shutdowns = 0;
  assert.equal(
    await service.install({
      parentPid: process.pid,
      language: 'en',
      shutdown: async () => shutdowns++,
    }),
    true,
  );
  const stage = calls.find(([name]) => name === 'stage')[1];
  assert.equal(stage.appPath, '/Applications/Capri.app');
  assert.equal(stage.tag, 'v1.3.0');
  assert.equal(shutdowns, 1);
  const swap = calls.find(([name]) => name === 'swap')[1];
  assert.equal(swap.pid, process.pid);
  assert.equal(swap.staged, '/Applications/.Capri-update-x.app');
  assert.equal(service.handoff, true);
});

test('without write access to its folder, Capri opens the disk image instead', async (t) => {
  const { service, calls } = updateFixture(t, {
    stageMacApp: async () => {
      throw Object.assign(new Error('read-only'), { code: 'CAPRI_APP_FOLDER_READ_ONLY' });
    },
  });
  await service.check();
  await service.prepare();
  let shutdowns = 0;
  assert.equal(await service.install({ shutdown: async () => shutdowns++ }), true);
  assert.equal(calls.filter(([name]) => name === 'open').length, 1);
  assert.equal(
    calls.some(([name]) => name === 'swap'),
    false,
  );
  assert.equal(shutdowns, 1);
});

test('a macOS checkout only opens the disk image and keeps running', async (t) => {
  const { service, calls } = updateFixture(t, { macApp: undefined });
  assert.equal(service.mode, 'installer');
  await service.check();
  await service.prepare();
  let shutdowns = 0;
  assert.equal(await service.install({ shutdown: async () => shutdowns++ }), true);
  assert.equal(calls.filter(([name]) => name === 'open').length, 1);
  assert.equal(shutdowns, 0);
});

test('disk image staging verifies the bundle before copying it next to the app', async (t) => {
  const base = temporary(t);
  const applications = path.join(base, 'Applications');
  mkdirSync(path.join(applications, '.Capri-update-00000000-0000-0000-0000-000000000000.app'), {
    recursive: true,
  });
  let mounted;
  const plist = { CFBundleIdentifier: 'com.capri-core.desktop', CapriVersion: '1.3.0' };
  const run = async (file, args) => {
    if (file.endsWith('hdiutil') && args[0] === 'attach') {
      mounted = path.join(args[args.indexOf('-mountrandom') + 1], 'dmg.1');
      mkdirSync(path.join(mounted, 'Capri.app/Contents'), { recursive: true });
      writeFileSync(path.join(mounted, 'Capri.app/Contents/Info.plist'), 'plist');
      return {
        stdout: `<plist><dict><key>system-entities</key><array><dict><key>mount-point</key><string>${mounted}</string></dict></array></dict></plist>`,
      };
    }
    if (file.endsWith('plutil')) return { stdout: JSON.stringify(plist) };
    if (file.endsWith('ditto')) cpSync(args[0], args[1], { recursive: true });
    if (file.endsWith('hdiutil') && args[0] === 'detach') rmSync(args[1], { recursive: true });
    return { stdout: '' };
  };
  const result = await stageMacosUpdate({
    image: path.join(base, 'update.dmg'),
    appPath: path.join(applications, 'Capri.app'),
    tag: 'v1.3.0',
    run,
    temporary: base,
    id: '11111111-1111-1111-1111-111111111111',
  });
  assert.equal(
    result.staged,
    path.join(applications, '.Capri-update-11111111-1111-1111-1111-111111111111.app'),
  );
  assert.equal(existsSync(path.join(result.staged, 'Contents/Info.plist')), true);
  assert.equal(
    existsSync(path.join(applications, '.Capri-update-00000000-0000-0000-0000-000000000000.app')),
    false,
    'leftovers of an earlier attempt are removed',
  );
  plist.CapriVersion = '1.2.9';
  await assert.rejects(
    stageMacosUpdate({
      image: 'x.dmg',
      appPath: path.join(applications, 'Capri.app'),
      tag: 'v1.3.0',
      run,
      temporary: base,
    }),
    { code: 'CAPRI_UPDATE_INVALID' },
  );
  assert.equal(expectedVersion('v1.3.0-beta.1'), '1.3.0-beta.1');
  assert.deepEqual(mountPoints('<key>mount-point</key>\n<string>/tmp/a &amp; b</string>'), [
    '/tmp/a & b',
  ]);
  assert.equal(LEFTOVER.test('.Capri-previous-11111111-1111-1111-1111-111111111111.app'), true);
  assert.equal(LEFTOVER.test('Capri.app'), false);
});

test(
  'the swap script replaces the app after Capri exits and restores it on failure',
  { skip: WINDOWS && 'the swap runs in /bin/sh, which Windows does not have' },
  (t) => {
    const base = temporary(t);
    const app = path.join(base, 'Capri.app');
    const staged = path.join(base, '.Capri-update-1.app');
    const backup = path.join(base, '.Capri-previous-1.app');
    mkdirSync(app);
    writeFileSync(path.join(app, 'version'), 'old');
    mkdirSync(staged);
    writeFileSync(path.join(staged, 'version'), 'new');
    const ended = spawnSync(process.execPath, ['-e', '0']).pid;
    // Stop before the script opens the result, so a Mac running the tests opens nothing.
    const opening = 'exec /usr/bin/open "$app"';
    assert.equal(SWAP_SCRIPT.trimEnd().endsWith(opening), true);
    const swap = SWAP_SCRIPT.replace(opening, 'exit 0');
    spawnSync('/bin/sh', ['-c', swap, 'capri-update', String(ended), app, staged, backup]);
    assert.equal(readFileSync(path.join(app, 'version'), 'utf8'), 'new');
    assert.equal(existsSync(staged), false);
    assert.equal(existsSync(backup), false);
    // A staged copy that cannot move into place leaves the old app where it was.
    spawnSync('/bin/sh', ['-c', swap, 'capri-update', String(ended), app, staged, backup]);
    assert.equal(readFileSync(path.join(app, 'version'), 'utf8'), 'new');
    assert.equal(existsSync(backup), false);
  },
);

test('the swap starts detached with absolute paths and a real process id', (t) => {
  const base = temporary(t);
  const app = path.join(base, 'Capri.app');
  const staged = path.join(base, '.Capri-update-1.app');
  const backup = path.join(base, '.Capri-previous-1.app');
  const spawned = [];
  launchMacosSwap({
    pid: 42,
    appPath: app,
    staged,
    backup,
    spawnImpl: (...args) => (spawned.push(args), { unref() {} }),
  });
  assert.equal(spawned[0][0], '/bin/sh');
  assert.deepEqual(spawned[0][1].slice(3), ['42', app, staged, backup]);
  assert.equal(spawned[0][2].detached, true);
  assert.throws(() => launchMacosSwap({ pid: 0, appPath: app, staged, backup }));
  assert.throws(() => launchMacosSwap({ pid: 42, appPath: 'Capri.app', staged, backup }));
});

test('setup requests accept only the choices the window offers', () => {
  const base = {
    schemaVersion: 1,
    acceptLicense: true,
    acceptDownloads: true,
    inferenceMode: 'local',
    profile: 'desktop',
    interfaceLanguage: 'en',
    conversationLanguage: 'en',
  };
  const request = macosRequest(base, '/root');
  assert.equal(request.target, '/root');
  assert.equal(request.modelSource, 'catalog');
  assert.equal(request.voiceMode, 'off');
  assert.equal(request.downloadModels, true);
  assert.equal(request.desktopShortcut, false);
  assert.deepEqual(request.components, []);
  assert.throws(() => macosRequest({ ...base, schemaVersion: 2 }, '/root'));
  assert.throws(() => macosRequest({ ...base, inferenceMode: 'cloud' }, '/root'));
  assert.throws(() => macosRequest({ ...base, modelSource: 'web' }, '/root'));
  assert.throws(() => macosRequest({ ...base, components: ['voice'] }, '/root'), /component/);
});

test('setup sizes, languages and progress', () => {
  const local = macosStorageEstimate({ downloadModels: true, profile: 'desktop' });
  assert.equal(local.downloadBytes, 1157672831 + 3324173679);
  assert.equal(local.requiredBytes, local.downloadBytes + GiB);
  assert.equal(
    macosStorageEstimate({ downloadModels: false, profile: 'minimal' }).downloadBytes,
    1157672831,
  );
  assert.equal(
    macosStorageEstimate({ downloadModels: true, installedModel: 'x', profile: 'hf-1' })
      .downloadBytes,
    1157672831,
  );
  assert.equal(matchLanguage(['ru-RU', 'en-US'], ['en', 'ru']), 'ru');
  assert.equal(matchLanguage(['pt_BR'], ['en', 'pt-BR']), 'pt-BR');
  assert.equal(matchLanguage(['xx'], ['en']), 'en');
  const events = [];
  const report = progressTracker(['configuration', 'models', 'verify', 'finalize'], (event) =>
    events.push(event.fraction),
  );
  report('configuration', 1);
  report('models', 0.5);
  report('models', 0.25);
  report('finalize', 1);
  assert.deepEqual(
    events.map((value) => Math.round(value * 1000) / 1000),
    [0.042, 0.49, 1],
  );
  const fractions = [];
  const parse = modelProgress(['qwen3.5:4b', 'bge-m3:latest'], (value) => fractions.push(value));
  assert.equal(parse('Preparing qwen3.5:4b...'), null);
  assert.deepEqual(
    parse('{"capriFileTransfer":"model.gguf","received":5,"total":10,"stageFraction":0.5}'),
    { model: 'qwen3.5:4b', file: 'model.gguf', received: 5, total: 10 },
  );
  assert.equal(parse('{"capriFileTransfer":"../x","received":5,"total":10}'), null);
  assert.equal(parse('{"capriFileTransfer":"a","received":11,"total":10}'), null);
  parse('Preparing bge-m3:latest...');
  assert.ok(fractions.at(-1) > 0.7 && fractions.at(-1) < 0.8, String(fractions.at(-1)));
});

test('setup options describe this Mac and recommend a model that fits', async () => {
  const options = await macosSetupOptions({
    root: repository,
    version: '1.2.2',
    preferredLanguages: ['de-DE'],
    hardware: M4_PRO,
    free: () => 100 * GiB,
  });
  assert.equal(options.recommended, 'desktop');
  assert.equal(options.embeddingModel, 'bge-m3:latest');
  assert.equal(options.hardware.unifiedMemory, true);
  assert.equal(options.hardware.gpuMemoryBytes, 18 * GiB);
  assert.equal(options.models.find((item) => item.id === 'quality').available, false);
  assert.equal(options.models.find((item) => item.id === 'desktop').downloadBytes, 3324173679);
  assert.equal(options.defaults.interface, 'de');
  assert.match(options.license, /GNU GENERAL PUBLIC LICENSE/);
});

/** A Capri folder with real configuration and a fake command runner. */
function setupFixture(t) {
  const base = temporary(t);
  const root = path.join(base, 'Capri');
  mkdirSync(root);
  cpSync(path.join(repository, 'config'), path.join(root, 'config'), {
    recursive: true,
    filter: (file) => !file.endsWith('.local.json'),
  });
  writeFileSync(
    path.join(root, '.capri-install.json'),
    JSON.stringify({
      schemaVersion: 1,
      productId: 'capri.desktop',
      installId: '11111111-2222-3333-4444-555555555555',
      root,
      version: '1.2.2',
    }),
  );
  const commands = [];
  const execute = async (file, args, { output }) => {
    const [script, ...rest] = args;
    const name = path.relative(root, script).split(path.sep).join('/') + ' ' + rest.join(' ');
    commands.push(name.trim());
    if (rest[0] === 'setup') {
      const local = JSON.parse(readFileSync(path.join(root, 'config/core.local.json'), 'utf8'));
      writeFileSync(
        path.join(root, 'config/core.local.json'),
        JSON.stringify({ ...local, model: 'capri-qwen3.5:4b', upstreamModel: 'qwen3.5:4b' }),
      );
    } else if (rest[0] === 'models' && rest.includes('--plan'))
      output(JSON.stringify({ models: ['qwen3.5:4b', 'bge-m3:latest'], preview: true }));
    else if (rest[0] === 'models') {
      output('Preparing qwen3.5:4b...');
      output('{"capriFileTransfer":"Qwen.gguf","received":10,"total":10,"stageFraction":1}');
      output('Preparing bge-m3:latest...');
      mkdirSync(path.join(root, 'data'), { recursive: true });
      writeFileSync(
        path.join(root, 'data/model-inventory.json'),
        JSON.stringify({
          models: [{ name: 'capri-qwen3.5:4b' }, { name: 'capri-embed:latest' }],
        }),
      );
    }
    return { stdout: '', stderr: '' };
  };
  const options = {
    root,
    sourceRoot: path.join(base, 'Capri.app/Contents/Resources/capri'),
    version: '1.2.2',
    hardware: M4_PRO,
    execute,
    free: () => 100 * GiB,
    nodeExecutable: process.execPath,
    isRunning: () => false,
    findPort: async (port) => port,
    checkArtwork: () => {},
    now: () => new Date('2026-11-21T12:00:00Z'),
  };
  return { root, commands, options };
}

test('first-run setup saves choices, downloads models and records completion', async (t) => {
  const { root, commands, options } = setupFixture(t);
  const events = [];
  await runMacosSetup(
    {
      schemaVersion: 1,
      acceptLicense: true,
      acceptDownloads: true,
      inferenceMode: 'local',
      profile: 'desktop',
      interfaceLanguage: 'de',
      conversationLanguage: 'en',
    },
    { ...options, emit: (event) => events.push(event) },
  );
  const local = JSON.parse(readFileSync(path.join(root, 'config/core.local.json'), 'utf8'));
  const core = JSON.parse(readFileSync(path.join(root, 'config/core.json'), 'utf8'));
  assert.equal(local.gatewayPort, core.gatewayPort + MACOS_PORT_OFFSET);
  assert.equal(local.ollamaPort, core.ollamaPort + MACOS_PORT_OFFSET);
  assert.equal(local.modelSetupRequired, false);
  assert.equal(
    JSON.parse(readFileSync(path.join(root, 'config/companion-voice.json'), 'utf8')).port,
    8101 + MACOS_PORT_OFFSET,
  );
  assert.deepEqual(commands, [
    'packages/runtime/bin/core.mjs stop',
    'packages/runtime/bin/capri.mjs setup --profile=desktop --yes --replace',
    'packages/runtime/bin/capri.mjs models --plan',
    'packages/runtime/bin/capri.mjs models',
    'packages/runtime/bin/capri.mjs doctor',
    'packages/runtime/bin/core.mjs stop',
  ]);
  const languages = JSON.parse(
    readFileSync(path.join(root, 'data/desktop/languages.json'), 'utf8'),
  );
  assert.equal(languages.settings.interface, 'de');
  assert.deepEqual(
    JSON.parse(readFileSync(path.join(root, 'data/desktop/first-start.json'), 'utf8')),
    { schemaVersion: 1, preloadModels: true },
  );
  const receipt = readSetupReceipt(root);
  assert.equal(receipt.status, 'complete');
  assert.equal(receipt.profile, 'desktop');
  assert.equal(installationState(root, { version: '1.2.2', fingerprint: 'x' }).setupComplete, true);
  assert.deepEqual(events.find((event) => event.type === 'stage-plan').stages, [
    'configuration',
    'models',
    'verify',
    'finalize',
  ]);
  assert.ok(events.some((event) => event.type === 'download' && event.file === 'Qwen.gguf'));
  assert.equal(events.at(-1).type, 'complete');
  const progress = events.filter((event) => event.type === 'progress').map((e) => e.fraction);
  assert.deepEqual(
    progress,
    [...progress].sort((a, b) => a - b),
  );
  assert.equal(progress.at(-1), 1);
});

test('API setup downloads only the memory model and asks for the provider in Capri', async (t) => {
  const { root, commands, options } = setupFixture(t);
  await runMacosSetup(
    {
      schemaVersion: 1,
      acceptLicense: true,
      acceptDownloads: true,
      inferenceMode: 'api',
      interfaceLanguage: 'en',
      conversationLanguage: 'en',
    },
    options,
  );
  assert.ok(commands.includes('packages/runtime/bin/capri.mjs models --embedding-only'));
  assert.deepEqual(
    JSON.parse(readFileSync(path.join(root, 'data/desktop/inference-api.json'), 'utf8')),
    { setupRequired: true },
  );
  assert.equal(
    JSON.parse(readFileSync(path.join(root, 'data/desktop/first-start.json'), 'utf8'))
      .preloadModels,
    false,
  );
});

test('setup refuses without consent, while Capri runs, or without disk space', async (t) => {
  const { root, options } = setupFixture(t);
  const request = {
    schemaVersion: 1,
    acceptLicense: true,
    acceptDownloads: false,
    inferenceMode: 'local',
    profile: 'desktop',
    interfaceLanguage: 'en',
    conversationLanguage: 'en',
  };
  await assert.rejects(runMacosSetup(request, options), /consent/);
  request.acceptDownloads = true;
  await assert.rejects(runMacosSetup(request, { ...options, isRunning: () => true }), {
    code: 'CAPRI_INSTALL_RUNNING',
  });
  await assert.rejects(runMacosSetup(request, { ...options, free: () => GiB }), /space/i);
  await assert.rejects(
    runMacosSetup({ ...request, profile: 'quality' }, options),
    /requires at least 32 GiB/,
  );
  assert.equal(readSetupReceipt(root), null);
});

test('a failed download keeps setup incomplete and reports the failing stage', async (t) => {
  const { root, options } = setupFixture(t);
  const events = [];
  const execute = async (file, args, context) => {
    if (args.includes('models') && !args.includes('--plan')) throw new Error('network down');
    return options.execute(file, args, context);
  };
  await assert.rejects(
    runMacosSetup(
      {
        schemaVersion: 1,
        acceptLicense: true,
        acceptDownloads: true,
        inferenceMode: 'local',
        profile: 'desktop',
        interfaceLanguage: 'en',
        conversationLanguage: 'en',
      },
      { ...options, execute, emit: (event) => events.push(event) },
    ),
    /network down/,
  );
  assert.deepEqual(
    { type: events.at(-1).type, step: events.at(-1).step },
    { type: 'failed', step: 'models' },
  );
  assert.equal(readSetupReceipt(root), null);
  assert.equal(existsSync(path.join(root, '.runtime/installer/install.lock.json')), false);
});

test('the command line opens Capri.app for folders the app installed', (t) => {
  const root = temporary(t);
  assert.equal(installedByMacApp(root, 'darwin'), false);
  mkdirSync(path.join(root, '.runtime/macos'), { recursive: true });
  writeFileSync(
    path.join(root, RECEIPT),
    JSON.stringify({ schemaVersion: 1, fingerprint: 'a'.repeat(64) }),
  );
  assert.equal(installedByMacApp(root, 'darwin'), true);
  assert.equal(installedByMacApp(root, 'win32'), false);
});

test('the app build compiles the Swift helper into the payload and checks its outputs', async (t) => {
  const payload = temporary(t);
  const artifact = path.join(payload, '.runtime/macos-helpers/0123456789abcdef/capri-macos-helper');
  const calls = [];
  const helper = macosHelper({
    async buildHelper(root, options) {
      calls.push({ root, ...options, log: typeof options.log });
      mkdirSync(path.dirname(artifact), { recursive: true });
      writeFileSync(artifact, 'helper');
      writeFileSync(path.join(payload, '.runtime/macos-helpers/build.json'), '{}');
      return artifact;
    },
  });
  const logged = [];
  assert.equal(
    await buildHelpers({
      root: repository,
      payload,
      helpers: [helper],
      log: (m) => logged.push(m),
    }),
    1,
  );
  // Built from the payload's own sources, always fresh, for the app's processor.
  assert.deepEqual(calls, [
    { root: payload, force: true, arch: 'arm64', platform: 'darwin', log: 'function' },
  ]);
  assert.deepEqual(logged, [
    'built the Capri macOS helper: .runtime/macos-helpers/0123456789abcdef/capri-macos-helper, ' +
      '.runtime/macos-helpers/build.json.',
  ]);
  assert.deepEqual(
    MACOS_HELPERS.map((entry) => entry.name),
    ['Capri macOS'],
  );
  // The sources ship too, so the installed helper is checked against them.
  assert.equal(shippedSourceFile('packages/macos-helpers/Sources/main.swift'), true);

  const fake = (outputs) => ({ name: 'fake', build: async () => outputs });
  for (const outputs of [undefined, [], ['missing'], [artifact]])
    await assert.rejects(buildHelpers({ root: repository, payload, helpers: [fake(outputs)] }), {
      message: /The fake helper (named no output|did not produce)/,
    });
});

test('a helper whose executable changed after its receipt was written fails the build', (t) => {
  const payload = temporary(t);
  const sources = path.join(payload, 'packages/macos-helpers/Sources');
  mkdirSync(sources, { recursive: true });
  writeFileSync(path.join(sources, 'main.swift'), 'print("Capri")\n');
  const folder = path.join(payload, '.runtime/macos-helpers');
  const artifact = '0123456789abcdef/capri-macos-helper';
  mkdirSync(path.join(folder, path.dirname(artifact)), { recursive: true });
  writeFileSync(path.join(folder, artifact), 'signed helper');
  writeFileSync(
    path.join(folder, 'build.json'),
    JSON.stringify({
      schemaVersion: 1,
      sourceSha256: macosHelperSourceHash(payload),
      artifact,
      executableSha256: sha('signed helper'),
      target: 'arm64-apple-macos14.0',
    }),
  );
  const helpers = [macosHelper()];
  verifyHelpers({ payload, helpers });
  // As if signing the whole bundle had re-signed the helper.
  writeFileSync(path.join(folder, artifact), 'signed again');
  assert.throws(() => verifyHelpers({ payload, helpers }), /integrity check failed/);
  // Sources that no longer match the receipt are refused as well.
  writeFileSync(path.join(folder, artifact), 'signed helper');
  writeFileSync(path.join(sources, 'main.swift'), 'print("changed")\n');
  assert.throws(() => verifyHelpers({ payload, helpers }), /out of date/);
  // Entries without a check are skipped.
  verifyHelpers({ payload, helpers: [{ name: 'plain', build: async () => [] }] });
});
