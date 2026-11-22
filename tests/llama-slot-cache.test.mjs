// SPDX-License-Identifier: GPL-3.0-only
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LlamaWorkers } from '../packages/runtime/src/providers/llama-workers.mjs';

// A llama-server stand-in: /health, plus the slot save/restore actions that
// --slot-save-path enables. The slot "state" is the list of prompts it served.
function fakeLlama(log) {
  return async (role, args, extra) => {
    const port = Number(args[args.indexOf('--port') + 1]);
    const saveIndex = args.indexOf('--slot-save-path');
    const directory = saveIndex >= 0 ? args[saveIndex + 1] : undefined;
    const runner = { role, args, prompts: [] };
    log.push(runner);
    const server = createServer(async (req, res) => {
      if (req.headers.authorization !== `Bearer ${extra.LLAMA_API_KEY}`)
        return res.writeHead(401).end();
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname === '/health') return res.end('{}');
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      if (url.pathname === '/slots/0' && directory) {
        const file = path.join(directory, body.filename);
        runner.actions = [...(runner.actions ?? []), url.searchParams.get('action')];
        if (url.searchParams.get('action') === 'save') {
          try {
            writeFileSync(file, JSON.stringify(runner.prompts));
          } catch {
            return res.writeHead(500).end('{"error":"Unable to save slot"}');
          }
          return res.end(JSON.stringify({ n_saved: runner.prompts.length, n_written: 1 }));
        }
        if (url.searchParams.get('action') === 'restore') {
          let saved;
          try {
            saved = JSON.parse(readFileSync(file, 'utf8'));
          } catch {
            return res.writeHead(400).end('{"error":"invalid slot save file"}');
          }
          runner.prompts = saved;
          runner.restored = [...saved];
          return res.end(JSON.stringify({ n_restored: saved.length, n_read: 1 }));
        }
      }
      res.writeHead(404).end();
    });
    server.listen(port, '127.0.0.1');
    await once(server, 'listening');
    let alive = true;
    return {
      alive: () => alive,
      stop: async () => {
        alive = false;
        server.close();
        server.closeAllConnections();
      },
      runner,
    };
  };
}

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'capri-slot-cache-'));
  const instances = [];
  t.after(async () => {
    for (const instance of instances) await instance.close();
    rmSync(root, { recursive: true, force: true });
  });
  const weights = path.join(root, 'model.gguf');
  writeFileSync(weights, 'gguf');
  const log = [];
  const events = [];
  const directory = path.join(root, 'data/run/llama-slots');
  const workers = (options = {}) => {
    const instance = new LlamaWorkers({
      root,
      config: { contextTokens: 4096, keepAlive: -1, cpuThreads: 1, acceleration: 'cpu' },
      start: fakeLlama(log),
      slotCache: { directory, version: 'b-test', report: (event) => events.push(event) },
      ...options,
    });
    instances.push(instance);
    return instance;
  };
  const model = { name: 'local:latest', files: [{ file: weights, size: 4 }] };
  // A chat request: the "prompt" is recorded in the runner's slot state.
  const chat = (instance, prompt, options = {}) =>
    instance.use(model, 'chat', { options }, AbortSignal.timeout(5000), (worker) => {
      log.at(-1).prompts.push(prompt);
      return { state: [...log.at(-1).prompts], url: worker.url };
    });
  return { root, directory, log, events, workers, model, chat, weights };
}

test('the chat state saved at shutdown is restored by the next runner and then consumed', async (t) => {
  const { directory, log, events, workers, chat } = fixture(t);
  const first = workers();
  assert.deepEqual((await chat(first, 'system+tools+hello')).state, ['system+tools+hello']);
  const chatArgs = log[0].args;
  assert.equal(chatArgs[chatArgs.indexOf('--slot-save-path') + 1], directory);
  await first.close();
  const saved = readdirSync(directory);
  assert.equal(saved.length, 1);
  assert.match(saved[0], /^chat-[0-9a-f]{16}\.bin$/);
  assert.deepEqual(log[0].actions, ['save']);

  // A new Capri start: the state is loaded before the first request is served.
  const second = workers();
  const { state } = await chat(second, 'system+tools+hello+reply+next');
  assert.deepEqual(log[1].restored, ['system+tools+hello']);
  assert.deepEqual(state, ['system+tools+hello', 'system+tools+hello+reply+next']);
  assert.deepEqual(log[1].actions, ['restore']);
  assert.deepEqual(readdirSync(directory), [], 'the running slot now owns the state');
  assert.deepEqual(
    events.map(({ action, tokens }) => [action, tokens]),
    [
      ['save', 1],
      ['restore', 1],
    ],
  );
});

test('the idle unload saves the state and the reload restores it', async (t) => {
  const { directory, log, workers, chat } = fixture(t);
  const instance = workers({
    config: { contextTokens: 4096, keepAlive: 1, cpuThreads: 1, acceleration: 'cpu' },
  });
  await chat(instance, 'turn one');
  const deadline = Date.now() + 4000;
  while (instance.list().length && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(instance.list().length, 0, 'the runner unloads after its keep-alive');
  assert.equal(readdirSync(directory).length, 1);
  const { state } = await chat(instance, 'turn two');
  assert.equal(log.length, 2);
  assert.deepEqual(state, ['turn one', 'turn two']);
});

test('a state is only restored into the same model and context, and only the newest is kept', async (t) => {
  const { directory, log, workers, chat, weights } = fixture(t);
  const instance = workers();
  await chat(instance, 'small context', { num_ctx: 4096 });
  // A larger context needs a new runner: the old state is saved under its own name.
  const { state } = await chat(instance, 'large context', { num_ctx: 8192 });
  assert.deepEqual(state, ['large context'], 'a different layout never loads the old state');
  assert.equal(log[1].restored, undefined);
  const [small] = readdirSync(directory);
  await instance.close();
  const files = readdirSync(directory);
  assert.equal(files.length, 1, 'the older state is removed after a newer save');
  assert.notEqual(files[0], small);

  // The embedding runner never gets a save path.
  const embedding = workers();
  await embedding.use(
    { name: 'embed:latest', files: [{ file: weights, size: 4 }] },
    'embedding',
    {},
    AbortSignal.timeout(5000),
    () => {},
  );
  assert.ok(!log.at(-1).args.includes('--slot-save-path'));
});

test('an unreadable saved state costs only the normal first evaluation', async (t) => {
  const { directory, log, workers, chat, model } = fixture(t);
  const instance = workers();
  await chat(instance, 'hello');
  await instance.close();
  const [name] = readdirSync(directory);
  writeFileSync(path.join(directory, name), 'partial');
  const next = workers();
  const { state } = await chat(next, 'hello again');
  assert.deepEqual(state, ['hello again']);
  assert.deepEqual(log[1].actions, ['restore']);
  assert.ok(!existsSync(path.join(directory, name)), 'the unreadable file is removed');

  // Without a cache directory nothing changes: no flag, no files.
  const plain = workers({ slotCache: undefined });
  await plain.use(model, 'chat', {}, AbortSignal.timeout(5000), () => {});
  assert.ok(!log.at(-1).args.includes('--slot-save-path'));
  await plain.close();
  assert.equal(log.at(-1).actions, undefined);
});

test('no state is written when the disk is nearly full', async (t) => {
  const { directory, log, workers, chat } = fixture(t);
  const instance = workers({
    slotCache: { directory, version: 'b-test', minimumFreeBytes: Number.MAX_SAFE_INTEGER },
  });
  await chat(instance, 'hello');
  await instance.close();
  assert.equal(log[0].actions, undefined, 'the runner was never asked to save');
  assert.deepEqual(readdirSync(directory), []);
});
