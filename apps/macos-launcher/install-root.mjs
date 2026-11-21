// SPDX-License-Identifier: GPL-3.0-only
/**
 * Capri.app carries Capri's code, locked npm dependencies and private runtimes
 * (Node.js and the Metal llama.cpp build) as a read-only payload inside the
 * bundle. Capri keeps settings, models and state relative to its installation
 * folder and its in-app tools update files there, so the app runs that payload
 * from a private installation in ~/Library/Application Support/Capri, next to
 * the user's data, instead of from the signed bundle.
 *
 * This module installs and upgrades that folder from the payload. It only uses
 * Node built-ins because it runs before any installed code exists. Personal
 * data (data/, logs/, *.local.json and the settings listed in PRESERVED_FILES)
 * is never in the payload and is never overwritten or removed here.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { chmod, copyFile, lstat, mkdir, rename, rmdir, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const PRODUCT = 'capri.desktop';
export const PLATFORM = 'darwin-arm64';
/** Small summary of the payload, read on every launch. */
export const BUILD_FILE = 'capri-build.json';
/** Complete list of payload files with sizes, SHA-256 and modes. */
export const MANIFEST_FILE = 'capri-payload.json';
/** Folder inside Contents/Resources that holds the installation template. */
export const PAYLOAD_FOLDER = 'capri';
export const IDENTITY = '.capri-install.json';
export const STATE = '.runtime/macos';
export const RECEIPT = STATE + '/installed.json';
export const INSTALLED_FILES = STATE + '/installed-files.json';
export const PENDING = STATE + '/sync-pending.json';
export const SETUP_RECEIPT = STATE + '/setup.json';
export const LOCK = STATE + '/sync.lock';
/**
 * Shipped settings that setup and the app rewrite in place (service ports, the
 * selected voice profile, the request classifier switch). Like the Windows
 * installer, an upgrade keeps the installed copy once it exists.
 */
export const PRESERVED_FILES = Object.freeze([
  'config/companion-voice.json',
  'config/companion-asr.json',
  'config/voice-training.json',
  'config/request-router.json',
]);
/** Top-level names a payload may never contain: they hold the user's data or app state. */
const RESERVED =
  /^(?:data|logs|\.capri-install\.json|\.runtime\/(?:macos|tmp|updates|installer)|\.git)(?:\/|$)/;
const SHA256 = /^[a-f0-9]{64}$/;

export function macosLocations({ home = os.homedir(), bundleIdentifier } = {}) {
  // macOS paths, whichever system runs the build or the tests.
  const { isAbsolute, join } = path.posix;
  if (!isAbsolute(home)) throw new Error('The home folder must be an absolute path.');
  return Object.freeze({
    root: join(home, 'Library', 'Application Support', 'Capri'),
    logs: join(home, 'Library', 'Logs', 'Capri'),
    ...(bundleIdentifier && {
      launcherProfile: join(home, 'Library', 'Caches', bundleIdentifier, 'Launcher'),
    }),
  });
}

const fail = (message, code) => Object.assign(new Error(message), code ? { code } : {});

export function readJsonFile(file, maximum = 1024 * 1024) {
  const descriptor = openSync(file, 'r');
  try {
    const bytes = readFileSync(descriptor);
    if (bytes.length > maximum) throw fail('Capri metadata exceeds its size limit.');
    return JSON.parse(bytes.toString('utf8').replace(/^﻿/, ''));
  } finally {
    closeSync(descriptor);
  }
}

export function writeJsonAtomicSync(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = path.join(
    path.dirname(file),
    '.' + path.basename(file) + '.' + randomUUID() + '.tmp',
  );
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  try {
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function readJsonOrNull(file, maximum) {
  try {
    return readJsonFile(file, maximum);
  } catch {
    return null;
  }
}

/** Rejects symbolic links (and hard-linked files) on every component of a path. */
export function assertNoLinks(file) {
  for (let cursor = path.resolve(file); ; cursor = path.dirname(cursor)) {
    let info = null;
    try {
      info = lstatSync(cursor);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (info && (info.isSymbolicLink() || (info.isFile() && info.nlink !== 1)))
      throw fail(`Capri does not follow filesystem links (${cursor}).`, 'CAPRI_LINKED_PATH');
    if (cursor === path.dirname(cursor)) return;
  }
}

function parseVersion(value) {
  const match =
    typeof value === 'string' &&
    /^v?(\d{1,9})\.(\d{1,9})\.(\d{1,9})(?:-([0-9A-Za-z.-]{1,64}))?$/.exec(value);
  if (!match) throw fail('Invalid Capri version: ' + value);
  return { numbers: match.slice(1, 4).map(Number), pre: match[4] ?? '' };
}
/** Semantic version order, enough to refuse downgrades of the installed data. */
export function compareVersions(a, b) {
  const left = parseVersion(a),
    right = parseVersion(b);
  for (let index = 0; index < 3; index++)
    if (left.numbers[index] !== right.numbers[index])
      return Math.sign(left.numbers[index] - right.numbers[index]);
  if (left.pre === right.pre) return 0;
  if (!left.pre) return 1;
  if (!right.pre) return -1;
  return left.pre < right.pre ? -1 : 1;
}

export function validPayloadPath(name) {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name.length <= 400 &&
    !name.startsWith('/') &&
    !name.includes('\\') &&
    !/[\x00-\x1f]/.test(name) &&
    name.split('/').every((part) => part && part !== '.' && part !== '..') &&
    !RESERVED.test(name) &&
    !/\.local\.json$/i.test(name)
  );
}

/** The fingerprint names one exact payload: same files, contents and modes. */
export function payloadFingerprint(files) {
  const hash = createHash('sha256');
  for (const [name, size, sha256, mode] of files)
    hash.update(`${name}\0${size}\0${sha256}\0${mode.toString(8)}\n`);
  return hash.digest('hex');
}

export function validateManifest(manifest) {
  if (
    !manifest ||
    manifest.schemaVersion !== 1 ||
    manifest.product !== PRODUCT ||
    manifest.platform !== PLATFORM ||
    !Array.isArray(manifest.files) ||
    !manifest.files.length ||
    !SHA256.test(manifest.fingerprint ?? '')
  )
    throw fail('The Capri app is incomplete. Download or build it again.', 'CAPRI_PAYLOAD_INVALID');
  parseVersion(manifest.version);
  const seen = new Set();
  for (const entry of manifest.files) {
    const [name, size, sha256, mode] = Array.isArray(entry) ? entry : [];
    if (
      entry.length !== 4 ||
      !validPayloadPath(name) ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      !SHA256.test(sha256 ?? '') ||
      (mode !== 0o644 && mode !== 0o755) ||
      seen.has(name.toLowerCase())
    )
      throw fail('The Capri app lists an invalid file: ' + String(name), 'CAPRI_PAYLOAD_INVALID');
    seen.add(name.toLowerCase());
  }
  // A file and a folder can never share a name; APFS is usually case-insensitive.
  for (const name of seen) {
    const parts = name.split('/');
    for (let index = 1; index < parts.length; index++)
      if (seen.has(parts.slice(0, index).join('/')))
        throw fail('The Capri app lists a file inside a file: ' + name, 'CAPRI_PAYLOAD_INVALID');
  }
  if (payloadFingerprint(manifest.files) !== manifest.fingerprint)
    throw fail('The Capri app is damaged. Download or build it again.', 'CAPRI_PAYLOAD_INVALID');
  return manifest;
}

export function readBuild(resources) {
  const build = readJsonFile(path.join(resources, BUILD_FILE), 65536);
  if (
    build?.schemaVersion !== 1 ||
    build.product !== PRODUCT ||
    build.platform !== PLATFORM ||
    !SHA256.test(build.fingerprint ?? '')
  )
    throw fail('The Capri app is incomplete. Download or build it again.', 'CAPRI_PAYLOAD_INVALID');
  parseVersion(build.version);
  return build;
}

export function readManifest(resources, build) {
  const manifest = validateManifest(
    readJsonFile(path.join(resources, MANIFEST_FILE), 64 * 1024 * 1024),
  );
  if (build && (manifest.fingerprint !== build.fingerprint || manifest.version !== build.version))
    throw fail('The Capri app is damaged. Download or build it again.', 'CAPRI_PAYLOAD_INVALID');
  return manifest;
}

export function validIdentity(identity, root) {
  return (
    identity?.schemaVersion === 1 &&
    identity.productId === PRODUCT &&
    typeof identity.root === 'string' &&
    path.resolve(identity.root) === path.resolve(root) &&
    /^[a-f0-9-]{36}$/.test(identity.installId ?? '') &&
    (() => {
      try {
        parseVersion(identity.version);
        return true;
      } catch {
        return false;
      }
    })()
  );
}

/** Names macOS or Finder may create in an otherwise empty folder. */
const HARMLESS = new Set(['.DS_Store', '.localized']);

/**
 * Accepts only a missing or empty folder, or a Capri installation of the same
 * or an older version. Never adopts or overwrites a folder Capri did not create.
 */
export function inspectRoot(root, version) {
  if (!path.isAbsolute(root)) throw fail('The installation folder must be absolute.');
  assertNoLinks(root);
  if (!existsSync(root)) return { fresh: true, identity: null };
  if (!lstatSync(root).isDirectory())
    throw fail(root + ' is not a folder. Move it away, then open Capri again.', 'CAPRI_UNRELATED');
  const identityFile = path.join(root, IDENTITY);
  if (!existsSync(identityFile)) {
    const unrelated = readdirSync(root).filter((name) => !HARMLESS.has(name));
    if (unrelated.length)
      throw fail(
        `${root} contains files that Capri did not create. Move that folder to the Trash or rename it, then open Capri again.`,
        'CAPRI_UNRELATED',
      );
    return { fresh: true, identity: null };
  }
  assertNoLinks(identityFile);
  const identity = readJsonOrNull(identityFile, 65536);
  if (!validIdentity(identity, root))
    throw fail(
      `${root} holds an installation that does not match this Mac. Rename that folder, then open Capri again.`,
      'CAPRI_IDENTITY',
    );
  if (compareVersions(identity.version, version) > 0)
    throw fail(
      `Your Capri data was last used by Capri ${identity.version}, which is newer than this app (${version}). Install Capri ${identity.version} or newer.`,
      'CAPRI_NEWER_INSTALLED',
    );
  return { fresh: false, identity };
}

/** Cheap check used on every launch: does the installation run exactly this payload? */
export function installationState(root, build) {
  const receipt = readJsonOrNull(path.join(root, RECEIPT), 65536);
  const setup = readJsonOrNull(path.join(root, SETUP_RECEIPT), 65536);
  const identity = readJsonOrNull(path.join(root, IDENTITY), 65536);
  const pending = existsSync(path.join(root, PENDING));
  const installed =
    !pending &&
    validIdentity(identity, root) &&
    identity.version === build.version &&
    receipt?.schemaVersion === 1 &&
    receipt.fingerprint === build.fingerprint;
  return {
    installed,
    pending,
    identity: validIdentity(identity, root) ? identity : null,
    setupComplete:
      setup?.schemaVersion === 1 &&
      setup.status === 'complete' &&
      existsSync(path.join(root, 'config/core.local.json')),
    receipt,
  };
}

export async function hashFile(file, signal) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file, { highWaterMark: 1024 * 1024 })) {
    signal?.throwIfAborted();
    hash.update(chunk);
  }
  return hash.digest('hex');
}

async function lstatOrNull(file) {
  try {
    return await lstat(file);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function runPool(items, limit, worker) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        await worker(items[index], index);
      }
    }),
  );
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/** One writer per installation; a lock left by a process that ended is reclaimed. */
export function acquireLock(root) {
  const file = path.join(root, LOCK);
  mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(file, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: 'wx' });
      return () => {
        try {
          const owner = readJsonFile(file, 4096);
          if (owner.pid === process.pid) unlinkSync(file);
        } catch {
          /* Already released. */
        }
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const owner = readJsonOrNull(file, 4096);
      if (Number.isInteger(owner?.pid) && owner.pid !== process.pid && processAlive(owner.pid))
        throw fail('Another Capri window is updating this installation.', 'CAPRI_SYNC_BUSY');
      rmSync(file, { force: true });
    }
  }
  throw fail('Another Capri window is updating this installation.', 'CAPRI_SYNC_BUSY');
}

/**
 * Installs or upgrades the private installation from the app's payload.
 * Interrupted runs leave a pending marker, so the next launch repeats the
 * (idempotent) sync before anything starts from a mixed folder.
 */
export async function syncInstallation({
  payload,
  manifest,
  root,
  appPath = null,
  onProgress = () => {},
  signal,
  concurrency = 16,
  now = () => new Date(),
}) {
  validateManifest(manifest);
  const { identity: existing } = inspectRoot(root, manifest.version);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  assertNoLinks(root);
  const identity = existing ?? {
    schemaVersion: 1,
    productId: PRODUCT,
    installId: randomUUID(),
    root: path.resolve(root),
    version: manifest.version,
    platform: PLATFORM,
  };
  // Claim the folder first: a later failure still leaves a recognisable installation.
  if (!existing) writeJsonAtomicSync(path.join(root, IDENTITY), identity);
  const release = acquireLock(root);
  try {
    writeJsonAtomicSync(path.join(root, PENDING), {
      schemaVersion: 1,
      fingerprint: manifest.fingerprint,
      version: manifest.version,
      startedAt: now().toISOString(),
    });
    const previous = readJsonOrNull(path.join(root, INSTALLED_FILES), 64 * 1024 * 1024);
    const previousFiles = new Map(
      Array.isArray(previous?.files)
        ? previous.files.filter(([name, sha]) => validPayloadPath(name) && SHA256.test(sha ?? ''))
        : [],
    );
    const folders = new Map([[path.resolve(root), Promise.resolve()]]);
    const ensureFolder = (folder) => {
      folder = path.resolve(folder);
      if (!folders.has(folder))
        folders.set(
          folder,
          ensureFolder(path.dirname(folder)).then(async () => {
            const info = await lstatOrNull(folder);
            if (!info) {
              try {
                await mkdir(folder);
              } catch (error) {
                if (error.code !== 'EEXIST') throw error;
              }
            } else if (info.isSymbolicLink() || !info.isDirectory())
              throw fail(
                `${folder} must be a regular folder. Rename it, then open Capri again.`,
                'CAPRI_LINKED_PATH',
              );
            const created = await lstat(folder);
            if (created.isSymbolicLink() || !created.isDirectory())
              throw fail(`${folder} must be a regular folder.`, 'CAPRI_LINKED_PATH');
          }),
        );
      return folders.get(folder);
    };
    const totals = { files: manifest.files.length, done: 0, copied: 0, kept: 0, bytes: 0 };
    const totalBytes = manifest.files.reduce((sum, entry) => sum + entry[1], 0);
    let reported = 0;
    const report = (force = false) => {
      const time = Date.now();
      if (!force && time - reported < 150) return;
      reported = time;
      onProgress({ phase: 'files', ...totals, totalBytes });
    };
    report(true);
    await runPool(manifest.files, concurrency, async ([name, size, sha256, mode]) => {
      signal?.throwIfAborted();
      const target = path.join(root, ...name.split('/'));
      const source = path.join(payload, ...name.split('/'));
      await ensureFolder(path.dirname(target));
      const current = await lstatOrNull(target);
      if (current?.isDirectory())
        throw fail(`${target} is a folder where Capri expects a file.`, 'CAPRI_LAYOUT');
      if (PRESERVED_FILES.includes(name) && current?.isFile() && !current.isSymbolicLink()) {
        totals.kept++;
      } else if (
        current?.isFile() &&
        current.nlink === 1 &&
        current.size === size &&
        (current.mode & 0o777) === mode &&
        (await hashFile(target, signal)) === sha256
      ) {
        totals.kept++;
      } else {
        const info = await lstat(source).catch(() => null);
        if (!info?.isFile() || info.size !== size || (await hashFile(source, signal)) !== sha256)
          throw fail(
            'The Capri app is damaged (' + name + '). Download or build it again.',
            'CAPRI_PAYLOAD_INVALID',
          );
        const temporary = path.join(
          path.dirname(target),
          '.' + path.basename(target).slice(0, 80) + '.capri-' + randomUUID(),
        );
        try {
          // APFS clones the file instantly; other volumes fall back to a copy.
          await copyFile(source, temporary, constants.COPYFILE_FICLONE);
          await chmod(temporary, mode);
          await rename(temporary, target);
        } catch (error) {
          await unlink(temporary).catch(() => {});
          throw error;
        }
        totals.copied++;
        totals.bytes += size;
      }
      totals.done++;
      report();
    });
    const current = new Set(manifest.files.map(([name]) => name));
    const backup = path.join(root, STATE, 'replaced', now().toISOString().replace(/[:.]/g, '-'));
    let removed = 0;
    const emptied = new Set();
    for (const [name, sha256] of previousFiles) {
      signal?.throwIfAborted();
      if (current.has(name)) continue;
      const target = path.join(root, ...name.split('/'));
      const info = await lstatOrNull(target);
      if (!info || !info.isFile() || info.isSymbolicLink()) continue;
      if ((await hashFile(target, signal)) === sha256) await unlink(target);
      else {
        // Someone changed a file the new version no longer ships: keep a copy.
        const kept = path.join(backup, ...name.split('/'));
        mkdirSync(path.dirname(kept), { recursive: true });
        await rename(target, kept);
      }
      removed++;
      for (let folder = path.dirname(target); folder !== root; folder = path.dirname(folder))
        emptied.add(folder);
    }
    for (const folder of [...emptied].sort((a, b) => b.length - a.length))
      await rmdir(folder).catch(() => {});
    writeJsonAtomicSync(path.join(root, INSTALLED_FILES), {
      schemaVersion: 1,
      fingerprint: manifest.fingerprint,
      files: manifest.files.map(([name, , sha256]) => [name, sha256]),
    });
    writeJsonAtomicSync(path.join(root, IDENTITY), { ...identity, version: manifest.version });
    writeJsonAtomicSync(path.join(root, RECEIPT), {
      schemaVersion: 1,
      fingerprint: manifest.fingerprint,
      version: manifest.version,
      commit: typeof manifest.commit === 'string' ? manifest.commit : null,
      files: manifest.files.length,
      appPath,
      syncedAt: now().toISOString(),
    });
    unlinkSync(path.join(root, PENDING));
    report(true);
    return { ...totals, removed, fresh: !existing, identity };
  } finally {
    release();
  }
}
