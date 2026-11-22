import { execFile } from 'node:child_process';
import path from 'node:path';
import { screenshotDimensions } from './screenshot-files.mjs';
import {
  macosHelperEnvironment,
  macosHelperExecutable,
} from '../../packages/runtime/src/host/macos-helper.mjs';

/** Windows: capture-display.ps1. macOS: the Swift helper's ScreenCaptureKit capture. */
function captureCommand(root, { ownedWindow, displayWindow, withGeometry, platform }) {
  if (platform === 'darwin') {
    const args = ['screen-capture'];
    if (ownedWindow) args.push('--owned-window', ownedWindow);
    if (displayWindow) args.push('--display-window', displayWindow);
    if (withGeometry) args.push('--with-geometry');
    return [macosHelperExecutable(root, { platform }), args, { env: macosHelperEnvironment(root) }];
  }
  const args = [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    path.join(root, 'integrations/perception/native/capture-display.ps1'),
  ];
  if (ownedWindow) args.push('-OwnedWindow', ownedWindow);
  if (displayWindow) args.push('-DisplayWindow', displayWindow);
  if (withGeometry) args.push('-WithGeometry');
  return ['powershell.exe', args, {}];
}

export function captureActiveDisplay(
  root,
  {
    signal,
    ownedWindow,
    displayWindow,
    withGeometry = false,
    platform = process.platform,
    execFileImpl = execFile,
  } = {},
) {
  if (ownedWindow !== undefined && !/^\d{1,20}$/.test(ownedWindow))
    throw new Error('Invalid owned verification window');
  if (displayWindow !== undefined && (ownedWindow || !/^[1-9]\d{0,18}$/.test(displayWindow)))
    throw new Error('Invalid display window');
  const system = platform === 'darwin' ? 'macOS' : 'Windows';
  return new Promise((resolve, reject) => {
    let command;
    try {
      command = captureCommand(root, { ownedWindow, displayWindow, withGeometry, platform });
    } catch {
      reject(new Error(`${system} could not capture the active display`));
      return;
    }
    const [file, args, options] = command;
    execFileImpl(
      file,
      args,
      { ...options, windowsHide: true, signal, timeout: 15000, maxBuffer: 96 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          reject(new Error(`${system} could not capture the active display`));
          return;
        }
        try {
          let text = stdout.trim(),
            bounds;
          if (withGeometry) {
            const value = JSON.parse(text);
            if (!['x', 'y', 'width', 'height'].every((key) => Number.isInteger(value[key])))
              throw new Error('Invalid capture bounds');
            bounds = { x: value.x, y: value.y, width: value.width, height: value.height };
            text = value.png;
          }
          if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text)) throw new Error('Invalid capture response');
          const png = Buffer.from(text, 'base64');
          const dimensions = screenshotDimensions(png);
          if (
            withGeometry &&
            (bounds.width !== dimensions.width || bounds.height !== dimensions.height)
          )
            throw new Error('Capture geometry differs from its image');
          resolve(withGeometry ? { png, bounds } : png);
        } catch {
          reject(new Error(`${system} returned an invalid screenshot`));
        }
      },
    );
  });
}
