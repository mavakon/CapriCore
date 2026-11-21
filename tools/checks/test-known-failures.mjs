// SPDX-License-Identifier: GPL-3.0-only
// Runs the unit suite (tools/checks/test.mjs) on a host where some tests are
// known to fail, and fails only on failures that are not listed for this
// platform in tools/checks/known-failures.json. Listed tests that pass are
// reported so the list can shrink. Upstream CI runs the suite on Windows, where
// none of these exceptions apply; this exists for the macOS port.
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempDisposableSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const platform = process.platform;
const listFile = path.join(root, 'tools/checks/known-failures.json');
const known = JSON.parse(readFileSync(listFile, 'utf8'))[platform] ?? [];
const key = (entry) => entry.file + ' :: ' + entry.test;

for (const entry of known)
  if (!entry.file || !entry.test || !entry.reason)
    throw new Error(`Each ${platform} entry in known-failures.json needs file, test and reason.`);

using scratch = mkdtempDisposableSync(
  path.join(realpathSync.native(tmpdir()), 'capri-known-failures-'),
);
const resultsFile = path.join(scratch.path, 'results.jsonl');
const reporter = pathToFileURL(path.join(root, 'tools/checks/failure-reporter.mjs')).href;
const run = spawnSync(
  process.execPath,
  [
    path.join(root, 'tools/checks/test.mjs'),
    '--test-reporter=spec',
    '--test-reporter-destination=stdout',
    '--test-reporter=' + reporter,
    '--test-reporter-destination=stdout',
    // A hung test fails by name instead of stalling the job until it times out.
    '--test-timeout=300000',
    ...process.argv.slice(2),
  ],
  {
    cwd: root,
    env: { ...process.env, CAPRI_TEST_RESULTS_FILE: resultsFile },
    stdio: 'inherit',
  },
);
if (run.error) throw run.error;

let records = [];
try {
  records = readFileSync(resultsFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const summaries = records.filter((record) => record.type === 'summary');
const failures = records.filter((record) => record.type === 'fail');
const totals = summaries.reduce(
  (sum, { counts }) => {
    for (const name of ['tests', 'passed', 'failed', 'skipped', 'cancelled'])
      sum[name] += counts[name] ?? 0;
    return sum;
  },
  { tests: 0, passed: 0, failed: 0, skipped: 0, cancelled: 0 },
);

const problems = [];
if (!summaries.length || totals.passed === 0)
  problems.push(`The test runner exited with status ${run.status} before reporting results.`);
if (run.status !== 0 && !failures.length && !problems.length)
  problems.push(`The test runner exited with status ${run.status} without a failed test.`);

const listed = new Map(known.map((entry) => [key(entry), entry]));
const failed = new Map(failures.map((failure) => [key(failure), failure]));
const unexpected = [...failed.values()].filter((failure) => !listed.has(key(failure)));
const nowPassing = known.filter((entry) => !failed.has(key(entry)));

const lines = [
  `## Unit tests on ${platform}-${process.arch}`,
  '',
  `${totals.tests} tests: ${totals.passed} passed, ${totals.failed} failed ` +
    `(${failures.length - unexpected.length} of them known), ${totals.skipped} skipped.`,
];
if (problems.length) lines.push('', ...problems.map((problem) => `- ${problem}`));
if (unexpected.length) {
  lines.push('', '### New failures', '');
  for (const failure of unexpected) {
    lines.push(
      `- \`${failure.file}:${failure.line}\` ${failure.test}: ${failure.error.split('\n')[0]}`,
    );
    console.log(
      `::error file=${failure.file},line=${failure.line}::${failure.test}: ${failure.error}`.replace(
        /\r?\n/g,
        ' ',
      ),
    );
  }
}
if (nowPassing.length) {
  lines.push('', '### Listed as known failures but passed (remove them from the list)', '');
  for (const entry of nowPassing) {
    lines.push(`- \`${entry.file}\` ${entry.test}`);
    console.log(
      `::warning file=tools/checks/known-failures.json::${entry.test} now passes on ${platform}; remove it from the list.`,
    );
  }
}
if (known.length) {
  lines.push('', `<details><summary>${known.length} known ${platform} failures</summary>`, '');
  for (const entry of known) lines.push(`- \`${entry.file}\` ${entry.test}: ${entry.reason}`);
  lines.push('', '</details>');
}
const report = lines.join('\n') + '\n';
console.log('\n' + report);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
process.exitCode = problems.length || unexpected.length ? 1 : 0;
