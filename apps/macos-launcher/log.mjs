// SPDX-License-Identifier: GPL-3.0-only
import { appendFileSync, existsSync, lstatSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';

const LIMIT = 1024 * 1024;

/**
 * Launcher diagnostics in ~/Library/Logs/Capri/launcher.log (Console.app shows
 * that folder). Records lifecycle events and error messages only, never chat
 * text, and keeps one previous file.
 */
export function createLauncherLog(folder) {
  const file = path.join(folder, 'launcher.log');
  return (event, details = {}) => {
    try {
      mkdirSync(folder, { recursive: true, mode: 0o700 });
      if (existsSync(file)) {
        const info = lstatSync(file);
        if (!info.isFile() || info.nlink !== 1) return;
        if (info.size > LIMIT) {
          rmSync(file + '.1', { force: true });
          renameSync(file, file + '.1');
        }
      }
      appendFileSync(
        file,
        JSON.stringify({ time: new Date().toISOString(), pid: process.pid, event, ...details }) +
          '\n',
        { mode: 0o600 },
      );
    } catch {
      /* Diagnostics must never stop Capri from starting. */
    }
  };
}

export function errorDetails(error) {
  return {
    message: String(error?.message ?? error).slice(0, 2000),
    ...(typeof error?.code === 'string' ? { code: error.code } : {}),
    ...(typeof error?.stack === 'string' ? { stack: error.stack.slice(0, 4000) } : {}),
  };
}
