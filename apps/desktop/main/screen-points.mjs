// SPDX-License-Identifier: GPL-3.0-only
/**
 * Electron converts between DIPs and physical screen pixels only on Windows and
 * Linux. On macOS both Electron and the native helpers (Accessibility, CGEvent,
 * ScreenCaptureKit) use the same global top-left points, so the conversions are
 * the identity. Installing them lets the shared code call one API everywhere.
 */
const identity = {
  dipToScreenRect: (_window, rect) => ({ ...rect }),
  screenToDipRect: (_window, rect) => ({ ...rect }),
  dipToScreenPoint: (point) => ({ ...point }),
  screenToDipPoint: (point) => ({ ...point }),
};

export function installScreenPoints(screen, platform = process.platform) {
  if (platform !== 'darwin' || !screen) return [];
  const installed = [];
  for (const [name, convert] of Object.entries(identity)) {
    if (typeof screen[name] === 'function') continue;
    Object.defineProperty(screen, name, { value: convert, configurable: true, writable: true });
    installed.push(name);
  }
  return installed;
}
