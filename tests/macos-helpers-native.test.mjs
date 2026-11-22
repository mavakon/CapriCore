// SPDX-License-Identifier: GPL-3.0-only
// Runs the real Swift helper on macOS (skipped elsewhere). Builds it first when
// it is missing or stale. Nothing here sends input, talks to Spotify, records
// audio or asks macOS for a permission: checks that need Accessibility or
// Screen Recording run only when the permission is already granted.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { root } from '../packages/runtime/src/index.mjs';
import {
  ensureMacosHelper,
  macosHelperEnvironment,
} from '../packages/runtime/src/host/macos-helper.mjs';
import { parseMacosGpuSample } from '../packages/runtime/src/hardware/macos-gpu.mjs';

const skip = process.platform === 'darwin' ? false : 'the macOS helper runs only on macOS';
let helper, permissions;

/** Runs one helper command, writing `input` to stdin; resolves on exit. */
function run(args, { input = '', end = true, timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(helper, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: macosHelperEnvironment(root),
    });
    const stdout = [],
      stderr = [];
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`capri-macos-helper ${args.join(' ')} timed out`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        code,
        signal,
        stdout: Buffer.concat(stdout),
        text: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
    child.stdin.on('error', () => {});
    if (input) child.stdin.write(input);
    if (end) child.stdin.end();
  });
}

const json = async (args, options) => {
  const result = await run(args, options);
  return { ...result, value: JSON.parse(result.text) };
};

before(async () => {
  if (skip) return;
  mkdirSync(path.join(root, '.runtime/tmp'), { recursive: true });
  helper = await ensureMacosHelper(root, { log: (line) => console.log('[macos-helper]', line) });
  ({ value: permissions } = await json(['permissions']));
});

test('the helper reports its version and refuses unknown commands', { skip }, async () => {
  const { value, code } = await json(['version']);
  assert.equal(code, 0);
  assert.deepEqual(value, { ok: true, helper: 'capri-macos', version: 1 });
  assert.equal((await run(['format-disk'])).code, 2);
  assert.equal((await run(['permissions', 'request', 'camera'])).code, 2);
});

test('permission status is read without prompting', { skip }, () => {
  assert.equal(permissions.ok, true);
  for (const key of ['accessibility', 'screenRecording', 'inputMonitoring'])
    assert.equal(typeof permissions[key], 'boolean', key);
});

test('desktop actions answer in the Windows bridge format', { skip }, async () => {
  const unavailable = await json([], { input: '{"action":"open_application","name":"Notes"}\n' });
  assert.equal(unavailable.code, 1);
  assert.equal(unavailable.value.ok, false);
  assert.equal(unavailable.value.errorCode, 'MACOS_ACTION_UNAVAILABLE');
  const invalid = await json([], { input: 'not json\n' });
  assert.equal(invalid.value.ok, false);
  const status = await json(['desktop-actions'], { input: '{"action":"macos_permissions"}\n' });
  assert.deepEqual(status.value, permissions);
  const passThrough = await json([], {
    input: '{"action":"computer_release","passThroughWindowIds":["not-a-window"]}\n',
  });
  assert.equal(passThrough.value.ok, false, 'malformed pass-through windows are refused');
  const state = await json([], { input: '{"action":"computer_state"}\n' });
  if (!permissions.accessibility) {
    assert.equal(state.value.ok, false);
    assert.equal(state.value.errorCode, 'COMPUTER_ACCESSIBILITY_REQUIRED');
    assert.equal(state.value.inputPerformed, false);
  } else if (state.value.ok) {
    for (const key of ['windowId', 'processId', 'startedAtTicks', 'untrustedControls'])
      assert.ok(key in state.value, key);
  } else {
    assert.match(state.value.errorCode ?? '', /^COMPUTER_/);
  }
});

test('avatar window lookup and following read geometry only', { skip }, async () => {
  const invalid = await json([], {
    input: '{"action":"avatar_window","nearX":"1","nearY":"1","nearRadius":"9999"}\n',
  });
  assert.equal(invalid.value.ok, false);
  const found = await json([], {
    input: JSON.stringify({ action: 'avatar_window', ignoreProcessId: String(process.pid) }) + '\n',
  });
  assert.equal(found.code, 0, found.text);
  assert.equal(found.value.ok, true);
  const child = spawn(helper, ['window-follow'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: macosHelperEnvironment(root),
  });
  const exited = new Promise((resolve) => child.on('close', resolve));
  const lines = [];
  let pending = '';
  const waiters = [];
  child.stdout.on('data', (chunk) => {
    pending += chunk;
    const parts = pending.split('\n');
    pending = parts.pop();
    lines.push(...parts);
    for (const waiter of waiters.splice(0)) waiter();
  });
  const next = async (pattern) => {
    const deadline = Date.now() + 5000;
    for (;;) {
      const index = lines.findIndex((line) => pattern.test(line));
      if (index >= 0) return lines.splice(index, 1)[0];
      if (Date.now() > deadline) throw new Error('window-follow did not answer ' + pattern);
      await new Promise((resolve) => {
        waiters.push(resolve);
        setTimeout(resolve, 200);
      });
    }
  };
  assert.equal(await next(/^ready$/), 'ready');
  child.stdin.write('follow 2 4000000000 1 1\n');
  assert.equal(await next(/^anchor 2 /), 'anchor 2 closed');
  if (found.value.windowId) {
    const { windowId, processId, startedAtTicks, width, height } = found.value;
    assert.match(windowId, /^[1-9]\d*$/);
    assert.notEqual(processId, String(process.pid));
    assert.ok(width >= 160 && height >= 100);
    child.stdin.write(`follow 3 ${windowId} ${processId} ${startedAtTicks}\n`);
    // The window can move or close between the two reads; its identity holds.
    assert.match(
      await next(/^anchor 3 /),
      /^anchor 3 (visible -?\d+ -?\d+ [1-9]\d* [1-9]\d*|hidden|closed)$/,
    );
    const exact = await json([], {
      input:
        JSON.stringify({ action: 'avatar_window', windowId, processId, startedAtTicks }) + '\n',
    });
    assert.ok([windowId, null].includes(exact.value.windowId));
    const stale = await json([], {
      input:
        JSON.stringify({ action: 'avatar_window', windowId, processId, startedAtTicks: '1' }) +
        '\n',
    });
    assert.equal(stale.value.windowId, null, 'a reused window number is not followed');
  }
  child.stdin.write('follow 0 0 0 0\n77 9\n0 0\n');
  child.stdin.end();
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  assert.equal(await exited, 0);
  clearTimeout(timer);
});

test('window events start, report readiness and stop when stdin closes', { skip }, async () => {
  const child = spawn(helper, ['window-events'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: macosHelperEnvironment(root),
  });
  let text = '';
  const exited = new Promise((resolve) => child.on('close', resolve));
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('window events did not start')), 10000);
    child.stdout.on('data', (chunk) => {
      text += chunk;
      if (text.includes('\n')) {
        clearTimeout(timer);
        resolve(JSON.parse(text.split('\n')[0]));
      }
    });
  });
  child.stdin.write(
    JSON.stringify({ ignoredProcessIds: [process.pid], filterProcessId: 0 }) + '\n',
  );
  assert.deepEqual(await ready, {
    type: 'ready',
    source: 'windows-events',
    capturesImages: false,
    capturesTitles: false,
  });
  child.stdin.end();
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  assert.equal(await exited, 0);
  clearTimeout(timer);
  for (const line of text.trim().split('\n').slice(1)) {
    const event = JSON.parse(line);
    assert.equal(event.source, 'windows-events');
    assert.ok(!('title' in event), 'window titles are never reported');
  }
  const refused = await run(['window-events'], { input: '{"filterProcessId":-1}\n' });
  assert.equal(refused.code, 1);
});

test(
  'Spotify control refuses unsupported and invalid requests without scripting Spotify',
  { skip },
  async () => {
    const requests = [
      { request: 1, action: 'search', query: 'fixture' },
      { request: 2, action: 'queue_add', uri: 'spotify:track:0000000000000000000000' },
      { request: 3, action: 'repeat', mode: 'sideways' },
      { request: 4, action: 'shuffle' },
      { request: 5, action: 'play' },
      { request: 6, action: 'eject' },
    ];
    const { text, code } = await run(['spotify'], {
      input: requests.map((request) => JSON.stringify(request)).join('\n') + '\n',
    });
    assert.equal(code, 0);
    const lines = text
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.deepEqual(lines[0], { type: 'ready', protocol: 1 });
    assert.deepEqual(
      lines.slice(1).map(({ request, ok, error }) => [request, ok, error.code]),
      [
        [1, false, 'unsupported'],
        [2, false, 'unsupported'],
        [3, false, 'invalid_request'],
        [4, false, 'invalid_request'],
        [5, false, 'unsupported'],
        [6, false, 'invalid_request'],
      ],
    );
  },
);

test('audio devices are listed by stable ids without recording', { skip }, async () => {
  const { value, code } = await json(['audio-endpoints', 'list']);
  assert.equal(code, 0);
  assert.ok(Array.isArray(value));
  for (const device of value) {
    assert.match(device.id, /^(in|out):./);
    assert.equal(device.kind, device.id.startsWith('in:') ? 'input' : 'output');
    assert.equal(typeof device.label, 'string');
    assert.doesNotMatch(device.id, /com\.capri\.system-audio\./, 'private tap devices are hidden');
  }
  assert.equal(new Set(value.map(({ id }) => id)).size, value.length);
  assert.equal((await run(['audio-endpoints', 'capture'])).code, 2);
  assert.equal((await run(['audio-endpoints', 'capture', 'out:no-such-device'])).code, 1);
});

test('GPU load comes from IOKit and parses as shared memory', { skip }, async () => {
  const { value, code } = await json(['gpu']);
  assert.equal(code, 0);
  const adapters = parseMacosGpuSample(value);
  if (process.arch === 'arm64') {
    const apple = adapters.find(({ vendor }) => vendor === 'apple');
    assert.ok(apple, 'an Apple GPU is listed');
    assert.equal(apple.memoryKind, 'shared');
    assert.equal(apple.totalBytes, null);
    if (apple.utilization !== null) assert.ok(apple.utilization >= 0 && apple.utilization <= 100);
  }
});

test('screen frames keep the Windows binary protocol', { skip }, async () => {
  const invalid = await run(['screen-worker'], { input: 'region||0|0|0|0|0|0|bgra\nbogus\n' });
  assert.equal(invalid.code, 0);
  assert.equal(invalid.stdout.length, 64);
  for (const offset of [0, 32]) {
    assert.equal(invalid.stdout.readInt32LE(offset), 1);
    assert.equal(invalid.stdout.readInt32LE(offset + 28), 0);
  }
  assert.equal((await run(['screen-capture', '--owned-window', 'x'])).code, 2);
  // Capturing without Screen Recording would show a macOS prompt; only read when granted.
  if (!permissions.screenRecording) return;
  const frame = await run(['screen-worker'], { input: 'region||0|0|64|48|32|32|bgra\n' });
  const header = frame.stdout.subarray(0, 32);
  assert.equal(header.readInt32LE(0), 0);
  assert.deepEqual(
    [4, 8, 12, 16].map((offset) => header.readInt32LE(offset)),
    [0, 0, 64, 48],
  );
  const width = header.readInt32LE(20),
    height = header.readInt32LE(24);
  assert.ok(width <= 32 && height <= 32 && width > 0 && height > 0);
  assert.equal(header.readInt32LE(28), width * height * 4);
  assert.equal(frame.stdout.length, 32 + width * height * 4);
  const probe = await json(['screen-capture', '--probe']);
  for (const key of ['x', 'y', 'width', 'height']) assert.ok(Number.isInteger(probe.value[key]));
});

test('user tools run under Seatbelt with only their own folders', { skip }, async (t) => {
  const scratch = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'capri-seatbelt-')));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const code = path.join(scratch, 'code'),
    output = path.join(scratch, 'output'),
    secrets = path.join(scratch, 'secrets');
  for (const folder of [code, output, secrets]) mkdirSync(folder);
  writeFileSync(path.join(secrets, 'token.txt'), 'synthetic-secret');
  writeFileSync(
    path.join(code, 'tool.mjs'),
    `import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
const [secret, port] = process.argv.slice(2);
const attempt = (action) => { try { action(); return 'allowed'; } catch (error) { return error.code ?? 'denied'; } };
let input = '';
for await (const chunk of process.stdin) input += chunk;
const result = {
  input: JSON.parse(input),
  home: process.env.HOME,
  secret: attempt(() => readFileSync(secret)),
  write: attempt(() => writeFileSync(path.join(process.env.HOME, 'result.txt'), 'written')),
  spawn: attempt(() => execFileSync('/bin/echo', ['escaped'])),
};
result.network = await new Promise((resolve) => {
  const socket = net.connect(Number(port), '127.0.0.1');
  const timer = setTimeout(() => { socket.destroy(); resolve('timeout'); }, 3000);
  socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve('allowed'); });
  socket.once('error', (error) => { clearTimeout(timer); resolve(error.code ?? 'denied'); });
});
process.stdout.write(JSON.stringify(result));
`,
  );
  const server = net.createServer((socket) => socket.destroy()).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const executable = realpathSync(process.execPath);
  const request = (network, extra = {}) =>
    JSON.stringify({
      code,
      output,
      runtime: path.dirname(executable),
      executable,
      arguments: [
        path.join(code, 'tool.mjs'),
        path.join(secrets, 'token.txt'),
        String(server.address().port),
      ],
      network,
      timeoutMs: 20000,
      input: '{"hello":"world"}\n',
      ...extra,
    }) + '\n';

  const blocked = await json(['tool-sandbox'], { input: request(false), end: false });
  assert.equal(blocked.value.ok, true, blocked.text);
  assert.equal(blocked.value.sandbox, 'macos-seatbelt');
  const result = JSON.parse(blocked.value.output);
  assert.deepEqual(result.input, { hello: 'world' });
  assert.equal(result.home, output);
  assert.notEqual(result.secret, 'allowed', 'files outside the tool folders are unreadable');
  assert.equal(result.write, 'allowed');
  assert.equal(readFileSync(path.join(output, 'result.txt'), 'utf8'), 'written');
  assert.notEqual(result.spawn, 'allowed', 'other programs cannot start');
  assert.notEqual(result.network, 'allowed', 'the network stays closed');

  const online = await json(['tool-sandbox'], { input: request(true), end: false });
  assert.equal(JSON.parse(online.value.output).network, 'allowed', online.text);

  writeFileSync(path.join(code, 'slow.mjs'), 'setTimeout(() => {}, 30000);\n');
  const slow = await json(['tool-sandbox'], {
    input: request(false, { arguments: [path.join(code, 'slow.mjs')], timeoutMs: 300 }),
    end: false,
  });
  assert.equal(slow.value.ok, false);
  assert.equal(slow.value.stage, 'run');

  const linked = await json(['tool-sandbox'], {
    // Not path.join: it would resolve the '..' before the helper sees it.
    input: request(false, { code: code + '/../code' }),
  });
  assert.equal(linked.value.ok, false);
  assert.equal(linked.value.stage, 'request');
  symlinkSync(code, path.join(scratch, 'link'));
  const symlinked = await json(['tool-sandbox'], {
    input: request(false, { code: path.join(scratch, 'link') }),
  });
  assert.equal(symlinked.value.stage, 'request', 'a linked tool folder is refused');
  assert.equal(
    (await run(['tool-sandbox', '--cleanup', 'Capri.Tool.0123456789abcdef01234567'])).code,
    0,
  );
});
