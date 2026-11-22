// SPDX-License-Identifier: GPL-3.0-only
/**
 * Native macOS helpers that tools/release/build-macos-app.mjs compiles into
 * the app's payload. Each entry:
 *
 *   {
 *     name: 'screen-capture',
 *     // Builds into `payload` (Contents/Resources/capri) and returns the
 *     // payload-relative paths it produced, which the build checks. `run(file,
 *     // args, options)` runs a command and throws on failure. Use only tools
 *     // that ship with Xcode or the Command Line Tools (swift, swiftc, xcrun).
 *     async build({ root, payload, run, log }) { return ['bin/helper']; },
 *     // Optional. Runs after Capri.app is signed and throws if the signed app
 *     // would refuse the helper.
 *     verify({ payload }) {},
 *   }
 *
 * Helpers run from the installed copy in ~/Library/Application Support/Capri.
 * Capri.app starts them, so macOS attributes their privacy prompts (Screen
 * Recording, Accessibility, Microphone) to Capri.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  buildMacosHelper,
  MACOS_HELPER_DIRECTORY,
  macosHelperExecutable,
} from '../../packages/runtime/src/host/macos-helper.mjs';

const posix = (file) => file.split(path.sep).join('/');

/**
 * The Swift helper in packages/macos-helpers (computer control, screen capture,
 * window awareness, Spotify, audio devices and the GPU meter). It is built
 * from the payload's own sources, so its receipt (build.json) matches the
 * sources the app installs.
 */
export function macosHelper({
  buildHelper = buildMacosHelper,
  verifyHelper = macosHelperExecutable,
} = {}) {
  return Object.freeze({
    name: 'Capri macOS',
    async build({ payload, log = () => {} }) {
      const executable = await buildHelper(payload, {
        force: true,
        arch: 'arm64',
        platform: 'darwin',
        log,
      });
      return [posix(path.relative(payload, executable)), `${MACOS_HELPER_DIRECTORY}/build.json`];
    },
    verify({ payload }) {
      // Throws when signing the bundle changed the executable its receipt names.
      verifyHelper(payload, { platform: 'darwin' });
    },
  });
}

export const MACOS_HELPERS = Object.freeze([macosHelper()]);

export async function buildHelpers({
  root,
  payload,
  run,
  helpers = MACOS_HELPERS,
  log = () => {},
}) {
  for (const helper of helpers) {
    const outputs = (await helper.build({ root, payload, run, log })) ?? [];
    if (!outputs.length) throw new Error(`The ${helper.name} helper named no output.`);
    for (const output of outputs)
      if (path.isAbsolute(output) || !existsSync(path.join(payload, output)))
        throw new Error(`The ${helper.name} helper did not produce ${output}.`);
    log(`built the ${helper.name} helper: ${outputs.join(', ')}.`);
  }
  return helpers.length;
}

/** Runs after signing, so a signature change can never ship a helper Capri refuses. */
export function verifyHelpers({ payload, helpers = MACOS_HELPERS }) {
  for (const helper of helpers) helper.verify?.({ payload });
}
