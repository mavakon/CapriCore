// SPDX-License-Identifier: GPL-3.0-only
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { isMac } from './platform.mjs';

export const ELECTRON_RUNTIME_FILES = [
  'electron.exe',
  'icudtl.dat',
  'resources.pak',
  'v8_context_snapshot.bin',
  'locales/en-US.pak',
];

/** The macOS package ships a complete Electron.app bundle instead of loose files. */
export const ELECTRON_MACOS_RUNTIME_FILES = [
  'Electron.app/Contents/Info.plist',
  'Electron.app/Contents/MacOS/Electron',
  'Electron.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework',
  'Electron.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Resources/icudtl.dat',
  'Electron.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Resources/resources.pak',
];

export const electronRuntimeFiles = (platform = process.platform) =>
  isMac(platform) ? ELECTRON_MACOS_RUNTIME_FILES : ELECTRON_RUNTIME_FILES;

/** Inspect without requiring Electron: recent versions download lazily on require(). */
export function electronBundleReady(
  packageDirectory,
  expectedVersion,
  platform = process.platform,
) {
  try {
    const version = JSON.parse(
      readFileSync(path.join(packageDirectory, 'package.json'), 'utf8'),
    ).version;
    if (!version || (expectedVersion && version !== expectedVersion)) return false;
    if (
      readFileSync(path.join(packageDirectory, 'dist/version'), 'utf8').trim().replace(/^v/, '') !==
      version
    )
      return false;
    return electronRuntimeFiles(platform).every((name) => {
      const entry = statSync(path.join(packageDirectory, 'dist', name));
      return entry.isFile() && entry.size > 0;
    });
  } catch {
    return false;
  }
}
