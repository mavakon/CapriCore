// SPDX-License-Identifier: GPL-3.0-only
/**
 * Layout rules for Capri.app, kept free of macOS tools so they are testable on
 * any platform. tools/release/build-macos-app.mjs applies them on a Mac.
 */
import { createHash } from 'node:crypto';
import { createReadStream, lstatSync, readdirSync } from 'node:fs';
import path from 'node:path';
import {
  BUILD_FILE,
  MANIFEST_FILE,
  PLATFORM,
  PRODUCT,
  payloadFingerprint,
  validPayloadPath,
  validateManifest,
} from '../../apps/macos-launcher/install-root.mjs';

export { BUILD_FILE, MANIFEST_FILE };

/** Launcher files copied to Contents/Resources/app. */
export const LAUNCHER_FILES = Object.freeze([
  'launcher.mjs',
  'install-root.mjs',
  'log.mjs',
  'setup/index.html',
  'setup/setup.css',
  'setup/setup.js',
  'setup/preload.cjs',
]);
/** Artwork the setup window shows, copied from the source tree. */
export const SETUP_ARTWORK = Object.freeze({
  'setup/mark.svg': 'assets/default/brand/capricore.svg',
  'setup/avatar.png': 'assets/default/avatar.png',
});

/** Electron's helper apps in Contents/Frameworks, renamed like electron-packager does. */
export const HELPER_SUFFIXES = Object.freeze(['', ' (GPU)', ' (Renderer)', ' (Plugin)']);
export function helperPlan(name, bundleIdentifier) {
  return HELPER_SUFFIXES.map((suffix) => ({
    from: `Electron Helper${suffix}.app`,
    to: `${name} Helper${suffix}.app`,
    executableFrom: `Electron Helper${suffix}`,
    executableTo: `${name} Helper${suffix}`,
    bundleIdentifier:
      `${bundleIdentifier}.helper` + (suffix ? '.' + suffix.replace(/[^A-Za-z]/g, '') : ''),
    bundleName: `${name} Helper${suffix}`,
  }));
}

/** Short (numeric) bundle version: CFBundleShortVersionString allows no pre-release text. */
export function bundleVersions(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version);
  if (!match) throw new Error('Invalid Capri version: ' + version);
  const short = match.slice(1, 4).join('.');
  return { short, full: match[4] ? `${short}-${match[4]}` : short };
}

/**
 * Info.plist changes for the main bundle, as `plutil` operations:
 * [key, type, value] sets a key, [key, null] removes it.
 */
export function infoPlistChanges({
  name,
  bundleIdentifier,
  version,
  category,
  commit = null,
  icon = `${name}.icns`,
}) {
  const { short, full } = bundleVersions(version);
  return [
    ['CFBundleName', 'string', name],
    ['CFBundleDisplayName', 'string', name],
    ['CFBundleExecutable', 'string', name],
    ['CFBundleIdentifier', 'string', bundleIdentifier],
    ['CFBundleShortVersionString', 'string', short],
    ['CFBundleVersion', 'string', short],
    ['CFBundleIconFile', 'string', icon],
    ['CFBundleIconName', null],
    ['LSApplicationCategoryType', 'string', category],
    ['NSHumanReadableCopyright', 'string', 'Capri is free software under the GNU GPL v3.'],
    ['CapriVersion', 'string', full],
    ...(commit ? [['CapriCommit', 'string', commit]] : []),
    // Capri loads its code from a folder, never from an asar archive.
    ['ElectronAsarIntegrity', null],
    [
      'NSMicrophoneUsageDescription',
      'string',
      'Capri listens when you talk to it, use the wake phrase or start a call.',
    ],
    [
      'NSCameraUsageDescription',
      'string',
      'Capri uses the camera only during a video call you start.',
    ],
    [
      'NSAudioCaptureUsageDescription',
      'string',
      'Capri listens to music or system audio only when you turn that on.',
    ],
    [
      'NSAppleEventsUsageDescription',
      'string',
      'Capri controls other apps only for actions you ask it to do.',
    ],
    [
      'NSLocalNetworkUsageDescription',
      'string',
      'Capri uses your local network only for connections you turn on, such as remote access.',
    ],
  ];
}

/** Every icon size macOS asks an .icns for, as iconset file names and pixel sizes. */
export function iconsetEntries() {
  return [16, 32, 128, 256, 512].flatMap((size) => [
    [`icon_${size}x${size}.png`, size],
    [`icon_${size}x${size}@2x.png`, size * 2],
  ]);
}

/**
 * node_modules entries the app does not ship: Electron's own download (the app
 * is Electron) and symbolic links (`.bin` shims and npm workspace links, which
 * Capri never resolves at runtime).
 */
export function shippedDependency(name) {
  return !/^node_modules\/electron\/dist(?:\/|$)/.test(name);
}

/**
 * Source files the Mac payload leaves out: the Windows .cmd launchers in the
 * folder root and the GitHub repository settings. Nothing on macOS runs them.
 */
export function shippedSourceFile(name) {
  return !/^[^/]+\.cmd$/i.test(name) && !/^\.github\//.test(name);
}

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file, { highWaterMark: 1024 * 1024 }))
    hash.update(chunk);
  return hash.digest('hex');
}

/** Lists a payload folder. Links and special files are refused: the app copies files only. */
export function payloadFiles(folder) {
  const result = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      const name = path.relative(folder, file).split(path.sep).join('/');
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) {
        const info = lstatSync(file);
        if (info.nlink !== 1) throw new Error('Hard-linked payload file: ' + name);
        if (!validPayloadPath(name))
          throw new Error('Payload file outside the app layout: ' + name);
        result.push({ name, file, size: info.size, mode: info.mode & 0o111 ? 0o755 : 0o644 });
      } else throw new Error('Payload must contain only files and folders: ' + name);
    }
  };
  walk(folder);
  return result.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export async function payloadManifest(folder, { version, commit = null, concurrency = 16 }) {
  const files = payloadFiles(folder);
  const hashes = new Array(files.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, files.length) }, async () => {
      while (next < files.length) {
        const index = next++;
        hashes[index] = await sha256(files[index].file);
      }
    }),
  );
  const entries = files.map(({ name, size, mode }, index) => [name, size, hashes[index], mode]);
  const manifest = validateManifest({
    schemaVersion: 1,
    product: PRODUCT,
    platform: PLATFORM,
    version: bundleVersions(version).full,
    commit,
    fingerprint: payloadFingerprint(entries),
    files: entries,
  });
  return manifest;
}

export function buildSummary(manifest, { bundleIdentifier, runtimes, builtAt }) {
  return {
    schemaVersion: 1,
    product: manifest.product,
    platform: manifest.platform,
    version: manifest.version,
    commit: manifest.commit,
    fingerprint: manifest.fingerprint,
    files: manifest.files.length,
    bytes: manifest.files.reduce((sum, entry) => sum + entry[1], 0),
    bundleIdentifier,
    runtimes,
    builtAt,
  };
}
