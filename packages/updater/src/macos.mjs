// SPDX-License-Identifier: GPL-3.0-only
/**
 * Replaces Capri.app with the verified build from a downloaded disk image.
 *
 * The running app mounts the image, checks the new bundle's identity, version
 * and code signature, and copies it next to itself. A small shell script then
 * waits for this process to exit, swaps the two bundles with renames on the
 * same volume (restoring the old one if that fails) and opens the result. On
 * its first launch the new app's launcher updates the installation folder in
 * ~/Library/Application Support/Capri from its own payload.
 */
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { accessSync, constants, lstatSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { rmdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { parseVersion } from './releases.mjs';

export const MACOS_BUNDLE_IDENTIFIER = 'com.capri-core.desktop';
const ENV = Object.freeze({ PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C' });
/** Copies an earlier, interrupted update may have left next to the app. */
export const LEFTOVER = /^\.Capri-(?:update|previous)-[a-f0-9-]{36}\.app$/;
const execute = promisify(execFile);

const fail = (message, code) => Object.assign(new Error(message), { code });

/** Mount points from `hdiutil attach -plist` output. */
export function mountPoints(plist) {
  const decode = (value) =>
    value
      .replaceAll('&lt;', '<')
      .replaceAll('&gt;', '>')
      .replaceAll('&quot;', '"')
      .replaceAll('&apos;', "'")
      .replaceAll('&amp;', '&');
  return [...String(plist).matchAll(/<key>mount-point<\/key>\s*<string>([^<]+)<\/string>/g)].map(
    (match) => decode(match[1]),
  );
}

/** The version a Capri.app bundle declares in its Info.plist. */
export function bundleVersion(info) {
  return typeof info?.CapriVersion === 'string' ? info.CapriVersion : null;
}

export function expectedVersion(tag) {
  const { version, pre } = parseVersion(tag);
  return pre.length ? `${version}-${pre.join('.')}` : version;
}

/**
 * Copies the disk image's Capri.app next to `appPath` after verifying it.
 * Throws CAPRI_APP_FOLDER_READ_ONLY when the app's folder cannot be changed
 * (for example /Applications for a standard account): open the image instead.
 */
export async function stageMacosUpdate({
  image,
  appPath,
  tag,
  run = execute,
  temporary = os.tmpdir(),
  id = randomUUID(),
}) {
  const version = expectedVersion(tag);
  if (!path.isAbsolute(appPath) || !appPath.endsWith('.app'))
    throw fail('Capri.app could not be located.', 'CAPRI_APP_UNKNOWN');
  const folder = path.dirname(appPath);
  try {
    accessSync(folder, constants.W_OK);
  } catch {
    throw fail(`Capri cannot replace itself in ${folder}.`, 'CAPRI_APP_FOLDER_READ_ONLY');
  }
  for (const name of readdirSync(folder))
    if (LEFTOVER.test(name)) rmSync(path.join(folder, name), { recursive: true, force: true });
  const options = { env: ENV, timeout: 15 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 };
  const mountRoot = mkdtempSync(path.join(temporary, 'capri-update-'));
  let mount = null;
  try {
    const { stdout } = await run(
      '/usr/bin/hdiutil',
      [
        'attach',
        '-nobrowse',
        '-readonly',
        '-noautoopen',
        '-plist',
        '-mountrandom',
        mountRoot,
        image,
      ],
      options,
    );
    [mount] = mountPoints(stdout).filter((value) => value.startsWith(mountRoot + path.sep));
    if (!mount) throw fail('The downloaded disk image did not open.', 'CAPRI_UPDATE_INVALID');
    const source = path.join(mount, 'Capri.app');
    const info = lstatSync(source, { throwIfNoEntry: false });
    if (!info?.isDirectory() || info.isSymbolicLink())
      throw fail('The downloaded disk image has no Capri app.', 'CAPRI_UPDATE_INVALID');
    const { stdout: plist } = await run(
      '/usr/bin/plutil',
      ['-convert', 'json', '-o', '-', path.join(source, 'Contents/Info.plist')],
      options,
    );
    const bundle = JSON.parse(plist);
    if (bundle.CFBundleIdentifier !== MACOS_BUNDLE_IDENTIFIER || bundleVersion(bundle) !== version)
      throw fail(`The downloaded app is not Capri ${version} for macOS.`, 'CAPRI_UPDATE_INVALID');
    // Ad-hoc signatures carry no identity, but they still seal every file.
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', source], options);
    const staged = path.join(folder, `.Capri-update-${id}.app`);
    await run('/usr/bin/ditto', [source, staged], options);
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', staged], options).catch(
      (error) => {
        rmSync(staged, { recursive: true, force: true });
        throw error;
      },
    );
    return { staged, backup: path.join(folder, `.Capri-previous-${id}.app`) };
  } finally {
    if (mount)
      await run('/usr/bin/hdiutil', ['detach', mount], options).catch(() =>
        run('/usr/bin/hdiutil', ['detach', '-force', mount], options).catch(() => {}),
      );
    // Never recurse here: a mount that failed to detach must not be emptied.
    await rmdir(mountRoot).catch(() => {});
  }
}

/** Waits for Capri to exit, swaps the bundles and opens the result. */
export const SWAP_SCRIPT = `pid="$1"; app="$2"; staged="$3"; backup="$4"
tries=0
while kill -0 "$pid" 2>/dev/null; do
  tries=$((tries + 1))
  if [ "$tries" -gt 3000 ]; then rm -rf "$staged"; exit 1; fi
  sleep 0.2
done
if mv "$app" "$backup"; then
  if mv "$staged" "$app"; then
    rm -rf "$backup"
  else
    mv "$backup" "$app"
    rm -rf "$staged"
  fi
else
  rm -rf "$staged"
fi
exec /usr/bin/open "$app"
`;

export function launchMacosSwap({ pid, appPath, staged, backup, spawnImpl = spawn }) {
  if (!Number.isInteger(pid) || pid < 1) throw new Error('Invalid process id.');
  for (const value of [appPath, staged, backup])
    if (!path.isAbsolute(value)) throw new Error('Update paths must be absolute.');
  const child = spawnImpl(
    '/bin/sh',
    ['-c', SWAP_SCRIPT, 'capri-update', String(pid), appPath, staged, backup],
    { detached: true, stdio: 'ignore', env: ENV },
  );
  child.unref?.();
  return child;
}

/** Opens a disk image in Finder, for a copy the user drags to Applications. */
export async function openDiskImage(image, run = execute) {
  await run('/usr/bin/open', [image], { env: ENV, timeout: 60000 });
}
