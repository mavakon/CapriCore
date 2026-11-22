// SPDX-License-Identifier: GPL-3.0-only
// End-to-end check of the persisted chat state through Capri's real local
// inference service (packages/runtime/bin/llama-host.mjs and its bridge), with
// the installed model. It asks one desktop-sized question, lets the runner
// unload after its keep-alive, asks again, stops the whole service the way
// Capri does at quit, starts it again and asks once more. Each first reply
// after a stop must reuse the saved prompt instead of evaluating it again.
//
//   node tools/verify/verify-first-reply-cache.mjs [--root <Capri folder>]
//     [--llama <llama-server>] [--model capri-qwen3.5:4b]
//
// The service runs from this checkout on a random loopback port, so an
// installed Capri is not touched. Models are linked from --root (hard links, no
// copies) when this checkout has none. Nothing is spoken.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { bundledLlamaServer } from '../../packages/runtime/src/host/platform.mjs';
import { LlamaModelStore } from '../../packages/runtime/src/providers/llama-model-store.mjs';
import { desktop, questions } from '../benchmarks/first-reply-prompts.mjs';

const repo = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const { values: argv } = parseArgs({
  options: {
    root: { type: 'string', default: path.join(homedir(), 'Library/Application Support/Capri') },
    llama: { type: 'string' },
    model: { type: 'string', default: 'capri-qwen3.5:4b' },
  },
});
const config = JSON.parse(readFileSync(path.join(repo, 'config/core.json'), 'utf8'));
const llama =
  argv.llama ??
  [repo, argv.root]
    .map((folder) => bundledLlamaServer(path.join(folder, '.runtime'), config.llamaVersion))
    .find((file) => existsSync(file));
assert.ok(llama && existsSync(llama), 'llama-server not found; pass --llama <path>.');

// The service reads models from this checkout. Link the needed blobs if absent.
const blobs = path.join(repo, 'data/models/blobs');
const linked = [];
let model;
try {
  model = new LlamaModelStore(repo).get(argv.model);
} catch {
  const source = new LlamaModelStore(argv.root).get(argv.model);
  mkdirSync(blobs, { recursive: true });
  for (const { file } of source.files) {
    const target = path.join(blobs, path.basename(file));
    if (!existsSync(target)) {
      linkSync(file, target);
      linked.push(target);
    }
  }
  model = new LlamaModelStore(repo).get(argv.model);
}
const slots = path.join(repo, 'data/run/llama-slots');
const stopFile = path.join(repo, 'data/run/llama.stop');
rmSync(slots, { recursive: true, force: true });

const freePort = () =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

async function startService() {
  const port = await freePort();
  rmSync(stopFile, { force: true });
  const child = spawn(process.execPath, [path.join(repo, 'packages/runtime/bin/llama-host.mjs')], {
    cwd: repo,
    env: { ...process.env, CAPRI_OLLAMA_PORT: String(port), CAPRI_LLAMA_PATH: llama },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30000;
  for (;;) {
    if (child.exitCode !== null)
      throw new Error(`The inference service exited (${child.exitCode}).`);
    const response = await fetch(url + '/api/version').catch(() => null);
    if (response?.ok) break;
    assert.ok(Date.now() < deadline, 'The inference service did not start in 30 s.');
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  // Capri's own stop request: llama-host saves the chat state and exits.
  const stop = async () => {
    writeFileSync(stopFile, 'stop\n');
    const timer = setTimeout(() => child.kill('SIGKILL'), 60000);
    await exited;
    clearTimeout(timer);
    rmSync(stopFile, { force: true });
  };
  return { url, stop };
}

const history = [];
const rows = [];
async function ask(service, label, keepAlive = -1) {
  const question = questions[rows.length];
  const started = performance.now();
  const response = await fetch(service.url + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(300000),
    body: JSON.stringify({
      model: model.name,
      messages: [
        { role: 'system', content: desktop.system },
        ...history,
        { role: 'user', content: question },
      ],
      tools: desktop.tools,
      stream: false,
      keep_alive: keepAlive,
      max_tokens: 24,
      temperature: 0,
      seed: 7,
      options: { num_ctx: config.contextTokens, num_thread: 4 },
    }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  const packet = await response.json();
  const reply = String(packet.choices?.[0]?.message?.content ?? '').trim();
  history.push({ role: 'user', content: question }, { role: 'assistant', content: reply });
  const row = {
    label,
    wallMs: Math.round(performance.now() - started),
    promptTokens: packet.usage?.prompt_tokens,
    evaluatedTokens: packet.timings?.prompt_n,
    cachedTokens: packet.timings?.cache_n,
  };
  rows.push(row);
  console.log(label.padEnd(36), JSON.stringify(row));
  return row;
}

let service;
try {
  service = await startService();
  const cold = await ask(service, 'first reply, nothing saved yet');
  await ask(service, 'later reply (idle unload after 3 s)', 3);
  // The runner saves its state, then stops; /api/ps is empty only after both.
  const deadline = Date.now() + 30000;
  while ((await (await fetch(service.url + '/api/ps')).json()).models.length) {
    assert.ok(Date.now() < deadline, 'The runner did not unload after its keep-alive.');
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.equal(
    readdirSync(slots).filter((name) => name.endsWith('.bin')).length,
    1,
    'the idle unload saved the chat state',
  );
  const idle = await ask(service, 'first reply after the idle unload');
  await service.stop();
  service = undefined;
  assert.equal(readdirSync(slots).length, 1, 'quitting saved the chat state');
  service = await startService();
  const restart = await ask(service, 'first reply after a restart');
  for (const row of [idle, restart])
    assert.ok(
      row.cachedTokens > 0.9 * row.promptTokens,
      `${row.label} evaluated the prompt again: ${JSON.stringify(row)}`,
    );
  console.log(
    JSON.stringify({
      passed: true,
      model: model.name,
      coldMs: cold.wallMs,
      afterIdleUnloadMs: idle.wallMs,
      afterRestartMs: restart.wallMs,
      rows,
    }),
  );
} finally {
  await service?.stop();
  rmSync(slots, { recursive: true, force: true });
  for (const file of linked) rmSync(file, { force: true });
}
