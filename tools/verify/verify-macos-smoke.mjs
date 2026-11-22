// SPDX-License-Identifier: GPL-3.0-only
// macOS smoke check for CI, run after `npm ci` and `npm run setup:macos`.
// Confirms that the host is a supported desktop platform, that `capri doctor`
// finds the pinned runtimes and reports Apple unified memory, and that the
// bundled llama.cpp loads a tiny GGUF model and answers an OpenAI-style chat
// request, first on the CPU and then offloaded to Metal. It also checks that the
// engine can save a processed prompt and that a fresh server restores it and
// reuses it, which Capri relies on for a fast first reply. The only download is
// a pinned test model of about 1 MB.
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { desktopPlatform } from '../../packages/runtime/src/host/platform.mjs';

const root = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
// The tiny story model llama.cpp uses in its own CI. It has no chat template.
const TINY_MODEL = {
  url: 'https://huggingface.co/ggml-org/models/resolve/main/tinyllamas/stories260K.gguf',
  sha256: '270cba1bd5109f42d03350f60406024560464db173c0e387d91f0426d3bd256d',
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
// llama-server prints its version and the devices it can use on stderr.
const probe = (args) => {
  const result = spawnSync(llamaPath, args, { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, `llama-server ${args.join(' ')}: ${result.stderr}`);
  return (result.stdout + result.stderr).trim();
};
const version = probe(['--version']).match(/^version: .+$/m)?.[0];
assert.ok(version, 'llama-server reports its version');
pass('bundled llama-server runs', version);
const metal = probe(['--list-devices'])
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => /^MTL\d/.test(line));
assert.ok(metal.length, 'llama-server lists a Metal device');
pass('llama.cpp sees a Metal device', metal);

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

async function startServer(model, args) {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const server = spawn(
    llamaPath,
    [
      ...['--host', '127.0.0.1', '--port', String(port), '--model', model],
      ...['--ctx-size', '256', '--parallel', '1', '--no-webui'],
      ...args,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '';
  server.stdout.on('data', (chunk) => (output += chunk));
  server.stderr.on('data', (chunk) => (output += chunk));
  const exited = new Promise((resolve) => server.once('exit', resolve));
  const stop = async () => {
    server.kill('SIGTERM');
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
    if (server.exitCode === null && server.signalCode === null) server.kill('SIGKILL');
  };
  const deadline = Date.now() + 60000;
  for (;;) {
    if (server.exitCode !== null) throw new Error(`llama-server exited:\n${output.slice(-4000)}`);
    const health = await fetch(url + '/health').catch(() => null);
    if (health?.ok) break;
    if (Date.now() > deadline) {
      await stop();
      throw new Error('llama-server did not become healthy in 60 s.');
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const post = async (route, body) => {
    const response = await fetch(url + route, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    });
    assert.equal(response.status, 200, `${route}: ${await response.clone().text()}`);
    return response.json();
  };
  return { post, stop, output: () => output };
}

// The runtime saves llama-server's slot when a runner stops and restores it in
// the next one (packages/runtime/src/providers/llama-workers.mjs).
async function slotRoundTrip(model) {
  const folder = mkdtempSync(path.join(tmpdir(), 'capri-ci-slots-'));
  const args = ['--device', 'none', '--n-gpu-layers', '0', '--fit', 'off'];
  const prompt = 'Once upon a time there was a little cat who lived in a big house';
  const complete = (server, text) =>
    server.post('/completion', { prompt: text, n_predict: 4, temperature: 0, cache_prompt: true });
  try {
    let server = await startServer(model, [...args, '--slot-save-path', folder]);
    let saved;
    try {
      await complete(server, prompt);
      saved = await server.post('/slots/0?action=save', { filename: 'chat-ci.bin' });
    } finally {
      await server.stop();
    }
    assert.ok(saved.n_saved > 0, JSON.stringify(saved));
    server = await startServer(model, [...args, '--slot-save-path', folder]);
    try {
      const restored = await server.post('/slots/0?action=restore', { filename: 'chat-ci.bin' });
      assert.equal(restored.n_restored, saved.n_saved, JSON.stringify(restored));
      const reply = await complete(server, prompt + ' by the sea');
      assert.ok(
        reply.timings?.cache_n > 0,
        `the restored prompt was not reused: ${JSON.stringify(reply.timings)}`,
      );
      pass('llama-server restores a saved prompt and reuses it', {
        saved: saved.n_saved,
        reused: reply.timings.cache_n,
        evaluated: reply.timings.prompt_n,
      });
    } finally {
      await server.stop();
    }
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

async function chat(model, label, deviceArgs) {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
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
      ...deviceArgs,
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
    assert.ok(reply.usage?.completion_tokens > 0, JSON.stringify(reply));
    const offloaded = output.match(/offloaded (\d+)\/(\d+) layers to GPU/);
    pass(`llama-server answers a chat completion (${label})`, {
      tokens: reply.usage.completion_tokens,
      text: String(reply.choices?.[0]?.message?.content ?? '').slice(0, 60),
      ...(offloaded ? { offloaded: offloaded[0] } : {}),
    });
    return { output, offloaded };
  } catch (error) {
    console.error(output.slice(-4000));
    throw error;
  } finally {
    server.kill('SIGTERM');
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
    if (server.exitCode === null && server.signalCode === null) server.kill('SIGKILL');
  }
}

const model = await tinyModel();
await slotRoundTrip(model);
// Same CPU-only flags the runtime uses when a model must not touch the GPU.
await chat(model, 'CPU', ['--device', 'none', '--n-gpu-layers', '0', '--fit', 'off']);
const metalRun = await chat(model, 'Metal', [
  '--device',
  'MTL0',
  '--n-gpu-layers',
  '99',
  '--fit',
  'off',
]);
assert.ok(
  !metalRun.offloaded || Number(metalRun.offloaded[1]) > 0,
  `no layers reached the GPU: ${metalRun.offloaded?.[0]}`,
);
console.log(JSON.stringify({ checks: checks.length, passed: true }));
