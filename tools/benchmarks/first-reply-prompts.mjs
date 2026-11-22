// SPDX-License-Identifier: GPL-3.0-only
// Synthetic prompts the size of Capri's real ones, for the first-reply
// benchmark and verification. The desktop prompt matches a logged turn: about
// 13,600 system characters and 13 tool schemas (about 20,000 characters),
// roughly 7,700 Qwen3.5 tokens. No personal data: the text is the repository's
// own documentation.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
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
export const desktop = { system: text(0, 13600), tools: tools(13, 20400, 40000) };
// The Gateway warmup: a different, smaller prompt (about 2,200 tokens).
export const warmup = { system: text(90000, 5800), tools: tools(2, 2500, 120000) };
export const questions = [
  'Hey Capri, how is your evening going so far?',
  'What should we do for a quiet evening at home?',
  'Can you remind me what we talked about just now?',
  'Thanks. Give me one more short idea for tonight.',
  'Good night, Capri.',
];
