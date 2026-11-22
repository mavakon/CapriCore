// SPDX-License-Identifier: GPL-3.0-only
// Measures the first local chat reply after the llama.cpp runner starts (a
// Capri start, or a reload after the idle unload) against a later reply, with
// the processed chat state persisted between runner restarts ("on") and
// without it ("off", the previous behaviour). It drives the real runner code
// (LlamaWorkers, the bridge request body) against the installed model, with a
// prompt the size of Capri's desktop prompt: about 13,600 system characters
// and 13 tool schemas (about 20,000 characters), which is about 8,000 tokens.
//
//   node tools/benchmarks/benchmark-first-reply.mjs [--root <Capri folder>]
//     [--llama <llama-server>] [--model capri-qwen3.5:4b] [--modes off,on]
//     [--trace] [--out <file.json>]
//
// Nothing is spoken and no Capri session or memory is touched. The runner is
// started on a random loopback port; the saved state goes to a temporary folder.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { llamaChatBody } from '../../packages/runtime/src/providers/llama-bridge.mjs';
import { LlamaModelStore } from '../../packages/runtime/src/providers/llama-model-store.mjs';
import { LlamaWorkers } from '../../packages/runtime/src/providers/llama-workers.mjs';

const repo = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const { values: argv } = parseArgs({
  options: {
    root: { type: 'string' },
    llama: { type: 'string' },
    model: { type: 'string', default: 'capri-qwen3.5:4b' },
    context: { type: 'string', default: '32768' },
    threads: { type: 'string', default: '4' },
    modes: { type: 'string', default: 'off,on' },
    'extra-args': { type: 'string', default: '' },
    trace: { type: 'boolean', default: false },
    out: { type: 'string' },
  },
});
const installed = path.join(homedir(), 'Library/Application Support/Capri');
const capriRoot = path.resolve(
  argv.root ?? (existsSync(path.join(installed, 'data/models')) ? installed : repo),
);
const config = JSON.parse(readFileSync(path.join(repo, 'config/core.json'), 'utf8'));
const llama =
  argv.llama ??
  [capriRoot, repo]
    .map((folder) => path.join(folder, `.runtime/llama-${config.llamaVersion}/llama-server`))
    .find((file) => existsSync(file));
assert.ok(llama && existsSync(llama), 'llama-server not found; pass --llama <path>.');
const model = new LlamaModelStore(capriRoot).get(argv.model);
const context = Number(argv.context);
const threads = Number(argv.threads);
const work = mkdtempSync(path.join(tmpdir(), 'capri-first-reply-'));
const extraArgs = argv['extra-args'].split(' ').filter(Boolean);

// Realistic English filler from the repository's own documentation.
const corpus = ['README.md', 'docs/macos.md', 'docs/context-management.md', 'ROADMAP.md']
  .map((file) => path.join(repo, file))
  .filter((file) => existsSync(file))
  .map((file) => readFileSync(file, 'utf8'))
  .join('\n')
  .replace(/[`#*>|[\]()_-]+/g, ' ')
  .replace(/https?:\/\/\S+/g, '')
  .replace(/[ \t]+/g, ' ')
  .replace(/\n\s*\n+/g, '\n');
const text = (offset, length) => {
  let result = '';
  for (let at = offset; result.length < length; at += length)
    result += corpus.slice(at % corpus.length, (at % corpus.length) + length - result.length);
  return result;
};
const tools = (count, characters, offset) =>
  Array.from({ length: count }, (_, index) => ({
    type: 'function',
    function: {
      name: `capri_tool_${index + 1}`,
      description: text(offset + index * 997, Math.round(characters / count) - 220),
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['status', 'run', 'stop'] },
          query: { type: 'string', description: 'What the owner asked for.' },
        },
        required: ['action'],
      },
    },
  }));
// The desktop turn: the same system prompt and tools on every turn.
const desktop = { system: text(0, 13600), tools: tools(13, 20400, 40000) };
// The Gateway warmup: a different, smaller prompt (about 2,200 tokens).
const warmup = { system: text(90000, 5800), tools: tools(2, 2500, 120000) };
const questions = [
  'Hey Capri, how is your evening going so far?',
  'What should we do for a quiet evening at home?',
  'Can you remind me what we talked about just now?',
  'Thanks. Give me one more short idea for tonight.',
  'Good night, Capri.',
];

const memory = () => {
  try {
    const pid = execFileSync('pgrep', ['-f', `--slot-save-path|${model.files[0].file}`], {
      encoding: 'utf8',
    })
      .trim()
      .split('\n')
      .at(-1);
    const rssKiB = Number(execFileSync('ps', ['-o', 'rss=', '-p', pid], { encoding: 'utf8' }));
    let footprint;
    try {
      footprint = execFileSync('footprint', ['-p', pid], { encoding: 'utf8', timeout: 10000 })
        .split('\n')
        .find((line) => /phys_footprint|Footprint/i.test(line))
        ?.trim();
    } catch {}
    return { rssMiB: Math.round(rssKiB / 1024), ...(footprint ? { footprint } : {}) };
  } catch {
    return {};
  }
};

function starter(label, log) {
  return async (_role, args, extra) => {
    const child = spawn(
      llama,
      [...args, ...extraArgs, ...(argv.trace ? ['--verbosity', '4'] : [])],
      {
        cwd: path.dirname(llama),
        env: {
          HOME: process.env.HOME,
          TMPDIR: process.env.TMPDIR ?? tmpdir(),
          PATH: process.env.PATH,
          ...extra,
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    );
    child.stderr.on('data', (chunk) => log.push(chunk));
    let ended = false;
    const exit = new Promise((resolve) =>
      child.once('exit', (code) => {
        ended = true;
        resolve(code);
      }),
    );
    return {
      alive: () => !ended,
      exitCode: () => Promise.race([exit, new Promise((resolve) => setTimeout(resolve, 200))]),
      stop: async () => {
        if (ended) return;
        child.kill('SIGTERM');
        const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
        await exit;
        clearTimeout(timer);
      },
      label,
    };
  };
}

function runner(mode, log, events) {
  return new LlamaWorkers({
    root: capriRoot,
    config: { contextTokens: context, cpuThreads: threads, keepAlive: -1 },
    start: starter(mode, log),
    ...(mode === 'on' && {
      slotCache: {
        directory: path.join(work, 'slots'),
        version: config.llamaVersion,
        report: (event) => events.push(event),
      },
    }),
  });
}

async function ask(workers, prompt, history, question) {
  const messages = [
    { role: 'system', content: prompt.system },
    ...history,
    { role: 'user', content: question },
  ];
  const body = llamaChatBody(
    {
      messages,
      tools: prompt.tools,
      stream: false,
      think: false,
      options: { num_ctx: context, num_thread: threads, num_predict: 24, temperature: 0, seed: 7 },
    },
    { legacy: false, config: { generation: {} }, model },
  );
  const started = performance.now();
  const packet = await workers.use(
    model,
    'chat',
    { options: { num_ctx: context, num_thread: threads }, keep_alive: -1 },
    AbortSignal.timeout(600000),
    async (worker, signal) => {
      const response = await fetch(worker.url + '/v1/chat/completions', {
        method: 'POST',
        signal,
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer ' + worker.token,
        },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 200, await response.clone().text());
      return response.json();
    },
  );
  const reply = String(packet.choices?.[0]?.message?.content ?? '').trim();
  const { timings = {}, usage = {} } = packet;
  return {
    reply,
    result: {
      wallMs: Math.round(performance.now() - started),
      promptTokens: usage.prompt_tokens,
      evaluatedTokens: timings.prompt_n,
      cachedTokens: timings.cache_n,
      promptMs: Math.round(timings.prompt_ms ?? 0),
      outputTokens: timings.predicted_n,
    },
  };
}

const stopRunner = (workers) => workers.enqueue('chat', (slot) => workers.stopSlot(slot));
const results = {};
for (const mode of argv.modes.split(',')) {
  const log = [];
  const events = [];
  const rows = [];
  const history = [];
  let workers = runner(mode, log, events);
  const turn = async (label, prompt = desktop) => {
    const question = questions[rows.filter((row) => row.prompt === 'desktop').length];
    const { reply, result } = await ask(
      workers,
      prompt,
      prompt === desktop ? history : [],
      prompt === desktop ? question : 'Reply only with the word Ready.',
    );
    if (prompt === desktop)
      history.push({ role: 'user', content: question }, { role: 'assistant', content: reply });
    const row = { label, prompt: prompt === desktop ? 'desktop' : 'warmup', ...result };
    rows.push(row);
    console.log(mode.padEnd(4), label.padEnd(34), JSON.stringify(result));
    return row;
  };
  try {
    await turn('first reply after Capri starts');
    await turn('later reply');
    const resident = memory();
    await stopRunner(workers);
    await turn('first reply after the idle unload');
    await turn('later reply');
    await workers.close();
    workers = runner(mode, log, events);
    await turn('Gateway warmup after a restart', warmup);
    await turn('first reply after restart + warmup');
    results[mode] = { rows, events, resident, afterRestart: memory() };
  } finally {
    await workers.close();
    const output = Buffer.concat(log).toString('utf8');
    writeFileSync(path.join(work, `llama-${mode}.log`), output);
    results[mode] ??= { rows, events, failed: true };
    results[mode].trace = argv.trace
      ? Object.fromEntries(
          [
            'created context checkpoint',
            'restored context checkpoint',
            'forcing full prompt re-processing',
            'found better prompt',
            'restored',
          ].map((needle) => [needle, output.split(needle).length - 1]),
        )
      : undefined;
  }
}
const summary = {
  llama,
  model: model.name,
  modelBytes: model.size,
  context,
  threads,
  extraArgs,
  work,
  results,
};
if (argv.out) writeFileSync(argv.out, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
rmSync(path.join(work, 'slots'), { recursive: true, force: true });
