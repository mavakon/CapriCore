// SPDX-License-Identifier: GPL-3.0-only
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import {
  macosHelperEnvironment,
  macosHelperExecutable,
} from '../../../packages/runtime/src/host/macos-helper.mjs';

const mediaWindow = /^window:([1-9]\d{0,9}):\d+$/;

/**
 * macOS counterpart of DesktopTeleportMenu's window and release watchers: the
 * Swift helper's `window-follow` reports a perched window's bounds as it moves
 * and the mouse release of a drag that began on the avatar overlay. Started on
 * the first watch; it reads only window geometry and the mouse button state.
 */
export class MacosWindowFollower {
  constructor(root, { spawnImpl = spawn, executable = macosHelperExecutable } = {}) {
    Object.assign(this, { root, spawnImpl, executable });
    this.watchSequence = 0;
    this.session = undefined;
  }

  get ready() {
    return Boolean(this.session?.ready);
  }

  start() {
    if (this.session) return this.session;
    const session = { ready: false };
    this.session = session;
    const lost = () => {
      if (this.session !== session) return;
      this.session = undefined;
      session.lines?.close();
      // A follower that stops cannot report the perch any more; the caller's
      // periodic identity check takes over.
    };
    try {
      session.process = this.spawnImpl(this.executable(this.root), ['window-follow'], {
        stdio: ['pipe', 'pipe', 'ignore'],
        env: macosHelperEnvironment(this.root),
      });
    } catch {
      lost();
      return undefined;
    }
    session.process.once('error', lost);
    session.process.once('close', lost);
    session.process.stdin.on('error', lost);
    session.lines = createInterface({ input: session.process.stdout });
    session.lines.on('line', (line) => this.receive(session, line));
    return session;
  }

  receive(session, line) {
    if (this.session !== session) return;
    if (!session.ready) {
      if (line !== 'ready') return;
      session.ready = true;
      this.sendReleaseWatch();
      this.sendWindowWatch();
      return;
    }
    const release = /^release (\d+) (-?\d{1,10}) (-?\d{1,10})$/.exec(line);
    const watch = this.releaseWatch;
    if (release && watch?.id === Number(release[1]))
      watch.callback({ x: Number(release[2]), y: Number(release[3]) });
    const position =
      /^anchor (\d+) (hidden|closed|unavailable|visible)(?: (-?\d{1,10}) (-?\d{1,10}) (\d{1,10}) (\d{1,10}))?$/.exec(
        line,
      );
    const anchor = this.windowWatch;
    if (!position || anchor?.id !== Number(position[1])) return;
    const [, , state, x, y, width, height] = position;
    if (state !== 'visible') anchor.callback({ state });
    else if (Number(width) > 0 && Number(height) > 0)
      anchor.callback({
        state,
        x: Number(x),
        y: Number(y),
        width: Number(width),
        height: Number(height),
      });
  }

  write(line) {
    if (!this.session?.ready) return;
    try {
      this.session.process.stdin.write(line + '\n');
    } catch {}
  }

  /** Same contract as DesktopTeleportMenu.watchWindow; returns a stop function. */
  watchWindow(record, callback) {
    if (
      !/^[1-9]\d{0,9}$/.test(record?.windowId) ||
      !/^[1-9]\d{0,9}$/.test(record.processId) ||
      !/^\d{1,20}$/.test(record.startedAtTicks)
    )
      return () => {};
    const watch = { id: ++this.watchSequence, record, callback };
    this.windowWatch = watch;
    this.start();
    this.sendWindowWatch();
    return () => {
      if (this.windowWatch !== watch) return;
      this.windowWatch = undefined;
      this.sendWindowWatch();
    };
  }

  sendWindowWatch() {
    const watch = this.windowWatch;
    this.write(
      watch
        ? `follow ${watch.id} ${watch.record.windowId} ${watch.record.processId} ${watch.record.startedAtTicks}`
        : 'follow 0 0 0 0',
    );
  }

  /** Reports where a press that began on `overlay` (a BrowserWindow) is released. */
  watchRelease(overlay, callback) {
    const windowId = mediaWindow.exec(overlay?.getMediaSourceId?.() ?? '')?.[1];
    if (!windowId) return () => {};
    const watch = { id: ++this.watchSequence, windowId, callback };
    this.releaseWatch = watch;
    this.start();
    this.sendReleaseWatch();
    return () => {
      if (this.releaseWatch !== watch) return;
      this.releaseWatch = undefined;
      this.sendReleaseWatch();
    };
  }

  sendReleaseWatch() {
    const watch = this.releaseWatch;
    this.write(watch ? `${watch.windowId} ${watch.id}` : '0 0');
  }

  close() {
    const session = this.session;
    this.session = undefined;
    this.windowWatch = this.releaseWatch = undefined;
    if (!session) return;
    session.lines?.close();
    try {
      session.process.stdin.end();
    } catch {}
  }
}
