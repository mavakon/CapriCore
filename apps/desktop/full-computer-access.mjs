// SPDX-License-Identifier: GPL-3.0-only
import { createHash } from 'node:crypto';
import { Preferences } from './preferences.mjs';

// Windows grants each fixed drive (C:\\). macOS has one file system root; other
// volumes are mounted inside it under /Volumes.
const driveRoot = (platform) => (platform === 'darwin' ? /^\/$/ : /^[A-Z]:\\$/);
const validator = (platform) => (value) => {
  if (
    !value ||
    typeof value.enabled !== 'boolean' ||
    !Array.isArray(value.drives) ||
    value.drives.length > 26 ||
    new Set(value.drives).size !== value.drives.length ||
    value.drives.some((drive) => typeof drive !== 'string' || !driveRoot(platform).test(drive))
  )
    throw new Error('Invalid full computer access settings.');
  return { enabled: value.enabled, drives: [...value.drives] };
};
const accessDetail = {
  win32:
    'Capri will be able to use supported file, application, keyboard and mouse actions on your local drives without repeated confirmation. Requested actions can change your files and applications. You can revoke this access here at any time. Windows permissions and separate remote-provider settings still apply.',
  darwin:
    'Capri will be able to use supported file, application, keyboard and mouse actions on this Mac without repeated confirmation. Requested actions can change your files and applications. You can revoke this access here at any time. macOS privacy permissions and separate remote-provider settings still apply.',
};

/** UI and chat may request access; only the current host confirmation can grant it. */
export class FullComputerAccess {
  constructor({ file, discover, confirm, onChange = () => {}, platform = process.platform }) {
    Object.assign(this, { discover, confirm, onChange, platform });
    this.valid = validator(platform);
    this.preferences = new Preferences(file, { enabled: false, drives: [] }, this.valid);
    this.epoch = 0;
    this.enabling = false;
  }
  get enabled() {
    return this.preferences.value.enabled;
  }
  snapshot() {
    return { ...this.preferences.snapshot(), enabling: this.enabling };
  }
  scopes() {
    if (!this.enabled) return [];
    return this.preferences.value.drives.map((root) => ({
      id: 'fa11acc0-0000-4000-8000-' + createHash('sha256').update(root).digest('hex').slice(0, 12),
      root,
      write: true,
      kind: 'computer',
      confirmationRequired: false,
    }));
  }
  async configure(enabled, { signal } = {}) {
    signal?.throwIfAborted();
    if (typeof enabled !== 'boolean') throw new Error('Invalid access choice.');
    if (!enabled) {
      ++this.epoch;
      this.preferences.set({ ...this.preferences.snapshot(), enabled: false });
      this.onChange(this.snapshot());
      return this.snapshot();
    }
    if (this.enabled || this.enabling) return this.snapshot();
    const epoch = ++this.epoch;
    this.enabling = true;
    this.onChange(this.snapshot());
    try {
      if (
        !(await this.confirm({
          title: 'Give access to the whole computer?',
          detail: accessDetail[this.platform] ?? accessDetail.win32,
          confirmLabel: 'Give full computer access',
          danger: true,
          delayMs: 3000,
          signal,
        })) ||
        epoch !== this.epoch
      )
        return this.snapshot();
      signal?.throwIfAborted();
      const drives = await this.discover();
      signal?.throwIfAborted();
      if (epoch !== this.epoch) return this.snapshot();
      if (!drives.length) throw new Error('No local drives were detected.');
      this.preferences.set(this.valid({ enabled: true, drives }));
    } finally {
      this.enabling = false;
      this.onChange(this.snapshot());
    }
    return this.snapshot();
  }
}
