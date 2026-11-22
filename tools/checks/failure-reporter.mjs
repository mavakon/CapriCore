// SPDX-License-Identifier: GPL-3.0-only
// node:test reporter that records failed tests and run totals as JSON lines in
// the file named by CAPRI_TEST_RESULTS_FILE. It prints nothing, so it runs next
// to a human-readable reporter. Used by tools/checks/test-known-failures.mjs.
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const relative = (file) =>
  file ? path.relative(root, file.startsWith('file:') ? fileURLToPath(file) : file) : null;

export default async function* failureReporter(source) {
  const target = process.env.CAPRI_TEST_RESULTS_FILE;
  const write = (record) => target && appendFileSync(target, JSON.stringify(record) + '\n');
  for await (const event of source) {
    if (event.type === 'test:fail' && event.data.details?.type !== 'suite') {
      const error = event.data.details?.error;
      write({
        type: 'fail',
        file: relative(event.data.file)?.split(path.sep).join('/') ?? null,
        line: event.data.line ?? null,
        test: event.data.name,
        error: String(error?.cause?.message ?? error?.message ?? error ?? '').slice(0, 300),
      });
    } else if (event.type === 'test:summary' && !event.data.file)
      write({ type: 'summary', counts: event.data.counts, success: event.data.success });
  }
  yield '';
}
