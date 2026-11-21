// SPDX-License-Identifier: GPL-3.0-only
import { execFileSync } from 'node:child_process';
import { freemem } from 'node:os';

/**
 * Parses `vm_stat`. macOS keeps most idle memory as inactive or speculative
 * pages that it reclaims on demand, so os.freemem() alone reads as pressure.
 */
export function parseVmStat(text) {
  const page = /page size of (\d+) bytes/.exec(text);
  if (!page) return null;
  const pages = (label) => {
    const match = new RegExp(`^Pages ${label}:\\s+(\\d+)\\.?$`, 'm').exec(text);
    return match ? Number(match[1]) : 0;
  };
  const available = pages('free') + pages('inactive') + pages('speculative');
  return available > 0 ? available * Number(page[1]) : null;
}

/** Memory available to start new work without paging, in bytes. */
export function availableMemoryBytes({
  platform = process.platform,
  run = (command) =>
    execFileSync(command, [], {
      encoding: 'utf8',
      timeout: 3000,
      env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
      stdio: ['ignore', 'pipe', 'ignore'],
    }),
} = {}) {
  if (platform === 'darwin')
    try {
      return parseVmStat(run('/usr/bin/vm_stat')) ?? freemem();
    } catch {
      return freemem();
    }
  return freemem();
}
