// SPDX-License-Identifier: GPL-3.0-only
// Runs the unit suite (tools/checks/test.mjs) on a host where some tests are
// known to fail, and fails only on failures that are not listed for this
// platform in tools/checks/known-failures.json. Listed tests that pass are
// reported so the list can shrink. The listed tests still run and must pass in
// the Windows job; this exists for the macOS port.
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempDisposableSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const listFile = path.join(root, 'tools/checks/known-failures.json');
const key = (entry) => entry.file + ' :: ' + entry.test;

/** Known failures for one platform, checked for the fields every entry needs. */
export function knownFailures(platform = process.platform, file = listFile) {
  const known = JSON.parse(readFileSync(file, 'utf8'))[platform] ?? [];
  for (const entry of known)
    if (!entry.file || !entry.test || !entry.reason)
      throw new Error(`Each ${platform} entry in known-failures.json needs file, test and reason.`);
  return known;
}

/** Splits recorded failures into new ones and listed tests that did not fail. */
export function compareFailures(known, failures) {
  const listed = new Set(known.map(key));
  const failed = new Set(failures.map(key));
  return {
    unexpected: failures.filter((failure) => !listed.has(key(failure))),
    nowPassing: known.filter((entry) => !failed.has(key(entry))),
  };
}

/** Reads the JSON lines written by tools/checks/failure-reporter.mjs. */
export function readResults(file) {
  let records = [];
  try {
    records = readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const totals = { tests: 0, passed: 0, failed: 0, skipped: 0, cancelled: 0 };
  const summaries = records.filter((record) => record.type === 'summary');
  for (const { counts } of summaries)
    for (const name of Object.keys(totals)) totals[name] += counts[name] ?? 0;
  return {
    summaries: summaries.length,
    totals,
    failures: records.filter((record) => record.type === 'fail'),
  };
}

function main() {
  const platform = process.platform;
  const known = knownFailures(platform);
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
    { cwd: root, env: { ...process.env, CAPRI_TEST_RESULTS_FILE: resultsFile }, stdio: 'inherit' },
  );
  if (run.error) throw run.error;

  const { summaries, totals, failures } = readResults(resultsFile);
  const problems = [];
  if (!summaries || totals.passed === 0)
    problems.push(`The test runner exited with status ${run.status} before reporting results.`);
  if (run.status !== 0 && !failures.length && !problems.length)
    problems.push(`The test runner exited with status ${run.status} without a failed test.`);
  const { unexpected, nowPassing } = compareFailures(known, failures);

  const firstLine = (text) => String(text).split('\n')[0];
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
        `- \`${failure.file}:${failure.line}\` ${failure.test}: ${firstLine(failure.error)}`,
      );
      console.log(
        `::error file=${failure.file},line=${failure.line}::${failure.test}: ${firstLine(failure.error)}`,
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
  return problems.length || unexpected.length ? 1 : 0;
}

if (import.meta.main) process.exitCode = main();
