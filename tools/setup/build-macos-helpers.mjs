#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only
/**
 * Builds Capri's macOS helper (computer control, screen capture, window events,
 * Spotify, audio devices, GPU load and the tool sandbox) from
 * packages/macos-helpers with the Xcode command line tools. Safe to re-run: a
 * helper that matches its sources is kept. Pass --force to rebuild anyway.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildMacosHelper,
  MACOS_HELPER_DIRECTORY,
} from '../../packages/runtime/src/host/macos-helper.mjs';

const root = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const log = (message) => console.log('Capri setup: ' + message);

export async function buildMacosHelpers({ force = false } = {}) {
  const executable = await buildMacosHelper(root, { force, log });
  log(
    `macOS helper ready in ${path.join(MACOS_HELPER_DIRECTORY, path.basename(path.dirname(executable)))}.`,
  );
  return executable;
}

if (import.meta.main)
  await buildMacosHelpers({ force: process.argv.includes('--force') }).catch((error) => {
    console.error('Capri setup: ' + (error.stderr?.trim() || error.message));
    process.exitCode = 1;
  });
