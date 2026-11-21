// SPDX-License-Identifier: GPL-3.0-only
// macOS smoke check for CI, run after `npm ci` and `npm run setup:macos`.
// Confirms that the host is a supported desktop platform, that `capri doctor`
// finds the pinned runtimes and reports Apple unified memory, and that the
// bundled llama.cpp loads a tiny GGUF model and answers an OpenAI-style chat
// request on the CPU. The only download is a pinned test model of about 1 MB.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { desktopPlatform } from '../../packages/runtime/src/host/platform.mjs';

const root = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
// The tiny story model llama.cpp uses in its own CI. It has no chat template.
const TINY_MODEL = {
  url: 'https://huggingface.co/ggml-org/models/resolve/main/tinyllamas/stories260K.gguf',
  sha256: 'TO_BE_PINNED',
};
const checks = [];
const pass = (name, detail) => {
  checks.push({ name, ...(detail === undefined ? {} : { detail }) });
  console.log(`PASS ${name}${detail === undefined ? '' : ': ' + JSON.stringify(detail)}`);
};

assert.equal(
  desktopPlatform()?.id,
  'darwin-arm64',
  `This check is for macOS on Apple silicon, not ${process.platform}-${process.arch}.`,
);
pass('host is a supported desktop platform', `${process.platform}-${process.arch}`);

const doctor = JSON.parse(
  execFileSync(process.execPath, [path.join(root, 'packages/runtime/bin/capri.mjs'), 'doctor'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 60000,
  }),
);
assert.equal(doctor.hardware.platform, 'darwin');
assert.equal(doctor.hardware.arch, 'arm64');
assert.deepEqual(doctor.software, { node: true, llama: true, openclaw: true });
const gpu = doctor.hardware.gpus[0];
assert.equal(gpu?.vendor, 'apple', 'doctor reports the Apple GPU');
assert.equal(gpu.memoryKind, 'unified');
assert.ok(gpu.vramMiB > 0 && gpu.vramMiB < doctor.hardware.ramBytes / 1024 ** 2);
assert.ok(doctor.hardware.availableRamBytes > 0, 'available memory is read from vm_stat');
assert.ok(doctor.hardware.availableRamBytes <= doctor.hardware.ramBytes);
assert.ok(doctor.recommendation, 'doctor recommends a profile');
pass('capri doctor finds Node, llama.cpp and OpenClaw', {
  gpu: gpu.name,
  ramGiB: Math.round(doctor.hardware.ramBytes / 1024 ** 3),
  profile: doctor.recommendation.profile?.id ?? null,
  supported: doctor.recommendation.supported,
});

const { llamaPath } = await import('../../packages/runtime/src/index.mjs');
assert.ok(llamaPath.startsWith(path.join(root, '.runtime') + path.sep), llamaPath);
const version = execFileSync(llamaPath, ['--version'], {
  encoding: 'utf8',
  timeout: 30000,
  stdio: ['ignore', 'pipe', 'pipe'],
}).trim();
pass('bundled llama-server runs', version.split('\n').at(-1) || '(no version line)');

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

async function tinyModel() {
  const file = path.join(root, '.downloads/ci', path.basename(new URL(TINY_MODEL.url).pathname));
  if (existsSync(file) && sha256(file) === TINY_MODEL.sha256) return file;
  mkdirSync(path.dirname(file), { recursive: true });
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(TINY_MODEL.url, { signal: AbortSignal.timeout(120000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      writeFileSync(file + '.partial', Buffer.from(await response.arrayBuffer()));
      const actual = sha256(file + '.partial');
      if (actual !== TINY_MODEL.sha256) {
        rmSync(file + '.partial', { force: true });
        throw new Error(`test model SHA-256 is ${actual}, expected ${TINY_MODEL.sha256}`);
      }
      renameSync(file + '.partial', file);
      return file;
    } catch (error) {
      lastError = error;
      if (/SHA-256/.test(error.message)) break;
      await new Promise((resolve) => setTimeout(resolve, attempt * 3000));
    }
  }
  throw new Error(`Could not download the test model: ${lastError.message}`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const model = await tinyModel();
const port = await freePort();
const url = `http://127.0.0.1:${port}`;
// Same CPU-only flags the runtime uses when a model must not touch the GPU.
const server = spawn(
  llamaPath,
  [
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    '--model',
    model,
    '--alias',
    'ci-tiny',
    '--ctx-size',
    '256',
    '--parallel',
    '1',
    '--no-webui',
    '--jinja',
    '--chat-template',
    'chatml',
    '--device',
    'none',
    '--n-gpu-layers',
    '0',
    '--fit',
    'off',
  ],
  { stdio: ['ignore', 'pipe', 'pipe'] },
);
let output = '';
server.stdout.on('data', (chunk) => (output += chunk));
server.stderr.on('data', (chunk) => (output += chunk));
const exited = new Promise((resolve) => server.once('exit', resolve));
try {
  const deadline = Date.now() + 60000;
  for (;;) {
    if (server.exitCode !== null) throw new Error(`llama-server exited (${server.exitCode}).`);
    const health = await fetch(url + '/health').catch(() => null);
    if (health?.ok) break;
    if (Date.now() > deadline) throw new Error('llama-server did not become healthy in 60 s.');
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const response = await fetch(url + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'ci-tiny',
      messages: [{ role: 'user', content: 'Once upon a time' }],
      max_tokens: 16,
      temperature: 0,
    }),
    signal: AbortSignal.timeout(60000),
  });
  assert.equal(response.status, 200, await response.clone().text());
  const reply = await response.json();
  const text = reply.choices?.[0]?.message?.content ?? '';
  assert.ok(reply.usage?.completion_tokens > 0, JSON.stringify(reply));
  pass('llama-server answers a chat completion on the CPU', {
    tokens: reply.usage.completion_tokens,
    text: text.slice(0, 60),
  });
} catch (error) {
  console.error(output.slice(-4000));
  throw error;
} finally {
  server.kill('SIGTERM');
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
  if (server.exitCode === null && server.signalCode === null) server.kill('SIGKILL');
}
console.log(JSON.stringify({ checks: checks.length, passed: true }));
