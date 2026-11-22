// SPDX-License-Identifier: GPL-3.0-only
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { root } from '../host/paths.mjs';
import { macosHelperEnvironment, macosHelperExecutable } from '../host/macos-helper.mjs';

const vendors = ['apple', 'amd', 'intel'];
const percent = (value) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;

/**
 * GPU load from the macOS helper's IOAccelerator reading. Apple silicon GPUs use
 * unified system memory, which is not VRAM, so memory stays unknown here (the
 * RAM meter already covers it), as for a shared Windows adapter.
 */
export function parseMacosGpuSample(value) {
  if (!Array.isArray(value?.adapters) || value.adapters.length > 16)
    throw Error('macOS GPU inventory unavailable');
  const seen = new Set();
  return value.adapters.flatMap((adapter) => {
    const id =
      typeof adapter?.id === 'string' && /^ioreg-\d{1,20}$/.test(adapter.id) ? adapter.id : null;
    if (
      !id ||
      seen.has(id) ||
      typeof adapter.name !== 'string' ||
      !adapter.name.trim() ||
      adapter.name.length > 256 ||
      /[\x00-\x1f\x7f]/.test(adapter.name)
    )
      return [];
    seen.add(id);
    return [
      {
        id,
        name: adapter.name.trim(),
        vendor: vendors.includes(adapter.vendor) ? adapter.vendor : 'unknown',
        memoryKind: adapter.memoryKind === 'shared' ? 'shared' : 'unknown',
        totalBytes: null,
        usedBytes: null,
        freeBytes: null,
        percent: null,
        utilization: percent(adapter.utilization) ? adapter.utilization : null,
        temperatureCelsius: null,
      },
    ];
  });
}

/** One short read-only helper run per sample, bounded in time and output. */
export class MacosGpuSampler {
  constructor({
    directory = root,
    runImpl = promisify(execFile),
    executable = macosHelperExecutable,
    timeoutMs = 3000,
  } = {}) {
    Object.assign(this, { directory, runImpl, executable, timeoutMs });
  }
  async sample() {
    const helper = this.executable(this.directory, { platform: 'darwin' });
    const { stdout } = await this.runImpl(helper, ['gpu'], {
      env: macosHelperEnvironment(this.directory),
      timeout: this.timeoutMs,
      maxBuffer: 65536,
    });
    return parseMacosGpuSample(JSON.parse(stdout));
  }
}

export const macosGpuSampler = new MacosGpuSampler();
