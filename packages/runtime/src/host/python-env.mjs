// SPDX-License-Identifier: GPL-3.0-only
import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { isMac } from './platform.mjs';

/**
 * Locations of Capri's private Python runtime. Windows venvs keep their
 * interpreter in Scripts/python.exe; macOS venvs use bin/python, which uv
 * creates as a symbolic link to the managed interpreter under .runtime/python.
 * Only macOS uses the POSIX layout; other hosts keep the Windows layout that
 * Capri has always used, so their behaviour does not change.
 */
export const PYTHON_VERSION = '3.11.17';
const venvName = /^[a-z0-9][a-z0-9-]{0,63}$/;

function checkedName(name) {
  if (typeof name !== 'string' || !venvName.test(name))
    throw new Error('Invalid owned Python environment name.');
  return name;
}

export function venvDirectory(root, name) {
  return path.join(root, '.runtime', checkedName(name));
}

export function venvPython(root, name, platform = process.platform) {
  const directory = venvDirectory(root, name);
  return isMac(platform)
    ? path.join(directory, 'bin', 'python')
    : path.join(directory, 'Scripts', 'python.exe');
}

/** Relative form used by status files and diagnostics, always with forward slashes. */
export function venvPythonRelative(name, platform = process.platform) {
  checkedName(name);
  return isMac(platform) ? `.runtime/${name}/bin/python` : `.runtime/${name}/Scripts/python.exe`;
}

export function venvSitePackages(
  root,
  name,
  { platform = process.platform, series = '3.11' } = {},
) {
  if (!/^3\.\d{1,2}$/.test(series)) throw new Error('Invalid Python series.');
  const directory = venvDirectory(root, name);
  return isMac(platform)
    ? path.join(directory, 'lib', 'python' + series, 'site-packages')
    : path.join(directory, 'Lib', 'site-packages');
}

export function uvExecutable(root, platform = process.platform) {
  return path.join(root, '.runtime', 'uv', isMac(platform) ? 'uv' : 'uv.exe');
}

/** uv's install key for the pinned interpreter on this host. */
export function managedPythonKey(
  version = PYTHON_VERSION,
  platform = process.platform,
  arch = process.arch,
) {
  if (!/^3\.\d{1,2}\.\d{1,2}$/.test(version)) throw new Error('Invalid pinned Python version.');
  if (platform === 'win32' && arch === 'x64') return `cpython-${version}-windows-x86_64-none`;
  if (isMac(platform) && arch === 'arm64') return `cpython-${version}-macos-aarch64-none`;
  throw new Error('Capri speech runtimes support Windows x64 and macOS on Apple silicon.');
}

export function managedPython(
  root,
  version = PYTHON_VERSION,
  platform = process.platform,
  arch = process.arch,
) {
  const folder = path.join(root, '.runtime', 'python', managedPythonKey(version, platform, arch));
  return platform === 'win32'
    ? path.join(folder, 'python.exe')
    : path.join(folder, 'bin', 'python' + version.split('.').slice(0, 2).join('.'));
}

/**
 * A venv interpreter is acceptable when it is a regular file, or (macOS) a
 * link chain that ends at a regular file inside this installation's managed
 * Python folder. Nothing outside .runtime/python can be selected this way.
 */
export function ownedInterpreter(root, file) {
  try {
    const info = lstatSync(file);
    if (info.isFile()) return info.nlink === 1;
    if (!info.isSymbolicLink()) return false;
    const managed = realpathSync.native(path.join(root, '.runtime', 'python'));
    const target = realpathSync.native(file);
    return target.startsWith(managed + path.sep) && lstatSync(target).isFile();
  } catch {
    return false;
  }
}
