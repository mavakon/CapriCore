// SPDX-License-Identifier: GPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { root } from '../packages/runtime/src/host/paths.mjs';
import {
  compareFailures,
  knownFailures,
  readResults,
} from '../tools/checks/test-known-failures.mjs';
import { ownerPatterns } from '../tools/release/source-export.mjs';

test('the failure reporter records failed tests and run totals', (t) => {
  const folder = mkdtempSync(path.join(tmpdir(), 'capri-reporter-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const fixture = path.join(folder, 'fixture.test.mjs');
  const results = path.join(folder, 'results.jsonl');
  writeFileSync(
    fixture,
    "import test from 'node:test';\n" +
      "test('passes', () => {});\n" +
      "test('fails', () => { throw new Error('expected failure'); });\n" +
      "test('is skipped', { skip: true }, () => {});\n",
  );
  const reporter = pathToFileURL(path.join(root, 'tools/checks/failure-reporter.mjs')).href;
  // A nested node --test that inherits this context would skip its files.
  const env = { ...process.env, CAPRI_TEST_RESULTS_FILE: results };
  delete env.NODE_TEST_CONTEXT;
  const run = spawnSync(
    process.execPath,
    ['--test', '--test-reporter=' + reporter, '--test-reporter-destination=stdout', fixture],
    { cwd: folder, env, encoding: 'utf8' },
  );
  assert.equal(run.status, 1, run.stderr);
  assert.equal(run.stdout, '', 'the reporter prints nothing');
  const { summaries, totals, failures } = readResults(results);
  assert.equal(summaries, 1);
  assert.deepEqual(totals, { tests: 3, passed: 1, failed: 1, skipped: 1, cancelled: 0 });
  assert.equal(failures.length, 1);
  assert.equal(failures[0].test, 'fails');
  assert.equal(failures[0].line, 3);
  assert.match(failures[0].error, /expected failure/);
  assert.equal(path.resolve(root, failures[0].file), fixture);
});

test('missing results read as an empty run, not a pass', () => {
  const { summaries, totals, failures } = readResults(path.join(tmpdir(), 'capri-no-such-file'));
  assert.equal(summaries, 0);
  assert.equal(totals.passed, 0);
  assert.deepEqual(failures, []);
});

test('only unlisted failures are new; listed tests that pass are reported', () => {
  const known = [
    { file: 'tests/a.test.mjs', test: 'windows only', reason: 'Windows installer' },
    { file: 'tests/a.test.mjs', test: 'fixed since', reason: 'Windows updater' },
  ];
  const failures = [
    { file: 'tests/a.test.mjs', test: 'windows only', line: 4 },
    { file: 'tests/a.test.mjs', test: 'a regression', line: 9 },
    { file: 'tests/b.test.mjs', test: 'windows only', line: 2 },
  ];
  const { unexpected, nowPassing } = compareFailures(known, failures);
  assert.deepEqual(
    unexpected.map(({ file, test }) => file + ' ' + test),
    ['tests/a.test.mjs a regression', 'tests/b.test.mjs windows only'],
  );
  assert.deepEqual(
    nowPassing.map(({ test }) => test),
    ['fixed since'],
  );
});

test('every known failure names an existing test and gives a reason', () => {
  const list = JSON.parse(
    readFileSync(path.join(root, 'tools/checks/known-failures.json'), 'utf8'),
  );
  for (const platform of Object.keys(list).filter((key) => key !== 'description')) {
    const entries = knownFailures(platform);
    const keys = entries.map(({ file, test }) => file + ' :: ' + test);
    assert.equal(new Set(keys).size, keys.length, `duplicate ${platform} entries`);
    for (const entry of entries) {
      assert.ok(entry.reason.length >= 20, `${entry.test}: give a real reason`);
      const file = path.join(root, entry.file);
      assert.ok(existsSync(file), `${entry.file} does not exist`);
      assert.ok(
        readFileSync(file, 'utf8').includes(entry.test),
        `${entry.file} has no test named "${entry.test}"`,
      );
    }
  }
});

test('source release flags the owner name as a word and home folders on every platform', () => {
  // Synthetic account names, so this file never names a real account itself.
  const owner = ownerPatterns('qa-owner');
  assert.equal(owner.name.test('const qa-ownerLog = files.get(name);'), false);
  assert.equal(owner.name.test('the qa-owner account'), true);
  assert.equal(owner.home.test("filePath: 'C:\\\\Users\\\\Alice\\\\private-document.txt'"), false);
  for (const home of ['C:\\Users\\', '"C:\\\\Users\\\\', '/Users/', '/home/'])
    assert.equal(owner.home.test(home + 'qa-owner' + '/Capri'), true, home);
  assert.equal(owner.home.test('/Users/' + 'qa-owners/work'), false);
  const dotted = ownerPatterns('qa.owner');
  assert.equal(dotted.home.test('cd /Users/' + 'qa.owner/CapriMac'), true);
  assert.equal(dotted.home.test('/Users/' + 'qa.ownerx/CapriMac'), false);
  assert.equal(dotted.name.test('qaXowner'), false, 'the dot is literal');
  assert.equal(dotted.name.test('Owner: qa.owner.'), true);
});
