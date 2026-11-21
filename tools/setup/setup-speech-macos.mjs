#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only
/**
 * Installs Capri's speech components on macOS (Apple silicon) from a source
 * checkout: the private Python runtime, speech recognition and the voice for
 * one language. It runs the same component installer as Settings → Language,
 * so a checkout can be prepared and verified without opening the desktop.
 *
 *   npm run setup:macos-speech -- --speech en --recognition en
 *   npm run setup:macos-speech -- --speech off --recognition auto-europe
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  installSpeechComponents,
  speechComponentSelection,
} from '../../packages/installer/src/speech-components.mjs';
import { verifyHost } from './setup-macos.mjs';

const root = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));

export function speechSetupSelection(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      speech: { type: 'string', default: 'en' },
      recognition: { type: 'string', default: 'en' },
    },
    strict: true,
    allowPositionals: false,
  });
  return speechComponentSelection({ speech: values.speech, recognition: values.recognition });
}

export async function setupMacosSpeech(
  argv = process.argv.slice(2),
  { install = installSpeechComponents, log = console.log, host = {} } = {},
) {
  verifyHost(host);
  const selection = speechSetupSelection(argv);
  const controller = new AbortController();
  const stop = () => controller.abort(new Error('Speech setup was cancelled.'));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  let last = '';
  try {
    await install(selection, {
      root,
      node: process.execPath,
      signal: controller.signal,
      emit: ({ stage, message, progress }) => {
        const line = message
          ? `${stage}: ${message}`
          : progress?.total
            ? `${stage}: ${Math.floor((100 * progress.received) / progress.total)}%`
            : stage;
        if (line !== last) log('Capri speech: ' + line);
        last = line;
      },
    });
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
  log(`Capri speech: ready (voice ${selection.speech}, recognition ${selection.recognition}).`);
  return selection;
}

if (import.meta.main)
  await setupMacosSpeech().catch((error) => {
    console.error('Capri speech: ' + error.message);
    process.exitCode = 1;
  });
