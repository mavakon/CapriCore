// SPDX-License-Identifier: GPL-3.0-only
/**
 * Native macOS helpers that tools/release/build-macos-app.mjs compiles into
 * the app's payload (for example Swift replacements for the Windows screen
 * capture and computer-control helpers). Each entry:
 *
 *   {
 *     name: 'screen-capture',
 *     // Payload-relative output paths, for the build log and checks.
 *     outputs: ['apps/desktop/native/macos/bin/capri-screen-capture'],
 *     // Builds into `payload` (Contents/Resources/capri). `run(file, args, options)`
 *     // runs a command and throws on failure. Use only tools that ship with
 *     // Xcode or the Command Line Tools (swift, swiftc, xcrun).
 *     build({ root, payload, run }) {},
 *   }
 *
 * Helpers run from the installed copy in ~/Library/Application Support/Capri.
 * Capri.app starts them, so macOS attributes their privacy prompts (Screen
 * Recording, Accessibility, Microphone) to Capri. The list is empty until a
 * macOS helper exists.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';

export const MACOS_HELPERS = [];

export async function buildHelpers({
  root,
  payload,
  run,
  helpers = MACOS_HELPERS,
  log = () => {},
}) {
  for (const helper of helpers) {
    await helper.build({ root, payload, run });
    for (const output of helper.outputs ?? [])
      if (!existsSync(path.join(payload, output)))
        throw new Error(`The ${helper.name} helper did not produce ${output}.`);
    log(`built the ${helper.name} helper.`);
  }
  return helpers.length;
}
