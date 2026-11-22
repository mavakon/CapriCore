import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { root, paths } from './host/paths.mjs';
import { initialize } from './context.mjs';
import { launch, managedProcess } from './host/processes.mjs';
import { ensureDesktopIdentity } from './host/desktop-identity.mjs';
import { runtime } from './context.mjs';
import { electronBundleReady } from './host/electron-bundle.mjs';
import { updateBlocksStartup } from './host/update-state.mjs';
import { desktopPlatform, electronExecutable } from './host/platform.mjs';

const run = promisify(execFile);
const STARTUP_CHECK_MS = 3000;

export const MACOS_BUNDLE_IDENTIFIER = 'com.capri-core.desktop';
/** True for a folder that Capri.app installed and runs (macOS only). */
export function installedByMacApp(folder, platform = process.platform) {
  if (platform !== 'darwin') return false;
  try {
    const receipt = JSON.parse(
      readFileSync(path.join(folder, '.runtime/macos/installed.json'), 'utf8'),
    );
    return receipt?.schemaVersion === 1 && /^[a-f0-9]{64}$/.test(receipt.fingerprint ?? '');
  } catch {
    return false;
  }
}

export async function superviseDesktopExit(start, reportCrash) {
  const { promise: exit, resolve: exited } = Promise.withResolvers();
  let marker;
  try {
    marker = await start((code, signal) => exited({ code, signal }));
  } catch (error) {
    if (error.code !== 'CAPRI_SERVICE_EXITED' || error.exitCode === 0) throw error;
  }
  const { code, signal } = await exit;
  const interrupted = signal === 'SIGINT' || code >>> 0 === 0xc000013a;
  if (!interrupted && ((Number.isInteger(code) && code !== 0) || signal)) {
    if (await reportCrash(code)) return { ...marker, crashReported: true };
  }
  return marker;
}

export async function startDesktop({ wait = false } = {}) {
  if (updateBlocksStartup(root))
    throw new Error(
      'An update is in progress or was interrupted. Wait for it to finish, or repair this folder with the full installer.',
    );
  if (!desktopPlatform())
    throw new Error(
      'The Capri desktop runs on Windows x64 and macOS on Apple silicon. Runtime unit tests also run on Linux.',
    );
  if (!existsSync(path.join(root, 'config/core.local.json')))
    throw new Error('Run npm run setup first to choose a hardware profile.');
  const existing = managedProcess('desktop');
  if (existing) {
    writeFileSync(
      path.join(paths.data, 'run/desktop.show'),
      JSON.stringify({ show: true, launchNonce: process.env.CAPRI_LAUNCH_NONCE ?? null }),
    );
    return { ...existing, alreadyRunning: true };
  }
  if (installedByMacApp(root)) {
    // Capri.app owns this installation and runs the desktop in its own process.
    await run('/usr/bin/open', ['-b', MACOS_BUNDLE_IDENTIFIER]);
    return { opened: MACOS_BUNDLE_IDENTIFIER };
  }
  const electronPackage = path.join(root, 'node_modules/electron');
  if (!electronBundleReady(electronPackage))
    throw new Error(
      'The Capri desktop download is incomplete. Open Capri Setup again, select this installation folder and choose Retry or Repair. Keep Setup open until it finishes; microphone and voice are optional.',
    );
  const rt = runtime();
  initialize(rt);
  let executable = electronExecutable(electronPackage);
  executable = await ensureDesktopIdentity(executable);
  for (const action of ['stop', 'show'])
    try {
      unlinkSync(path.join(paths.data, 'run', `desktop.${action}`));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  // Electron interprets even an empty value as RUN_AS_NODE.
  const previous = process.env.ELECTRON_RUN_AS_NODE;
  delete process.env.ELECTRON_RUN_AS_NODE;
  try {
    // Desktop output is private by default. CAPRI_DESKTOP_DEBUG=1 shows it in
    // this terminal for diagnosing a startup failure from source.
    const stdio = process.env.CAPRI_DESKTOP_DEBUG === '1' ? 'inherit' : 'ignore';
    const start = (onExit) =>
      launch('desktop', executable, [path.join(root, 'apps/desktop/main.mjs')], rt, {
        onExit,
        stdio,
      });
    if (!wait) {
      const marker = await start();
      if (process.platform === 'darwin') {
        // Without a Capri.exe-style launcher, an Electron crash in its first
        // seconds would otherwise be reported as a successful start.
        await delay(STARTUP_CHECK_MS);
        if (!managedProcess('desktop'))
          throw Object.assign(
            new Error(
              'The Capri desktop closed during startup. Run CAPRI_DESKTOP_DEBUG=1 npm run desktop to see why.',
            ),
            { code: 'CAPRI_DESKTOP_STARTUP_EXITED' },
          );
      }
      return marker;
    }
    return await superviseDesktopExit(start, async (code) => {
      if (updateBlocksStartup(root)) return false;
      await run(
        executable,
        [
          path.join(root, 'apps/desktop/crash-reporter.mjs'),
          ...(Number.isInteger(code) ? [`--capri-desktop-exit-code=${code}`] : []),
        ],
        { cwd: root, windowsHide: true },
      );
      return true;
    });
  } finally {
    if (previous !== undefined) process.env.ELECTRON_RUN_AS_NODE = previous;
  }
}
