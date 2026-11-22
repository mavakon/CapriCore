// SPDX-License-Identifier: GPL-3.0-only
import path from 'node:path';

/**
 * Host platforms that can run the Capri desktop. Everything platform-specific
 * about bundled runtimes (file names, folders, Electron layout) is described
 * here so the rest of the runtime stays platform-neutral.
 */
export const DESKTOP_PLATFORMS = Object.freeze({
  'win32-x64': Object.freeze({ id: 'win32-x64', label: 'Windows x64' }),
  'darwin-arm64': Object.freeze({ id: 'darwin-arm64', label: 'macOS on Apple silicon' }),
});

export function hostKey(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`;
}

export function desktopPlatform(platform = process.platform, arch = process.arch) {
  return DESKTOP_PLATFORMS[hostKey(platform, arch)] ?? null;
}

export const isMac = (platform = process.platform) => platform === 'darwin';

export function executableName(name, platform = process.platform) {
  return platform === 'win32' ? name + '.exe' : name;
}

/** Private folder under .runtime holding the pinned llama.cpp build for this host. */
export function llamaBundleDirectory(version, platform = process.platform) {
  return isMac(platform) ? `llama-${version}-macos-arm64` : `llama-${version}-vulkan`;
}

export function llamaServerName(platform = process.platform) {
  return executableName('llama-server', platform);
}

export function bundledLlamaServer(cache, version, platform = process.platform) {
  return path.join(cache, llamaBundleDirectory(version, platform), llamaServerName(platform));
}

/** Private Node.js copy used by installed builds; development uses the PATH. */
export function bundledNode(cache, version, platform = process.platform, arch = process.arch) {
  return isMac(platform)
    ? path.join(cache, `node-v${version}-darwin-${arch}`, 'bin', 'node')
    : path.join(cache, `node-v${version}-win-x64`, 'node.exe');
}

/** Executable inside the electron npm package's dist folder. */
export function electronExecutable(packageDirectory, platform = process.platform) {
  return isMac(platform)
    ? path.join(packageDirectory, 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')
    : path.join(packageDirectory, 'dist', 'electron.exe');
}
