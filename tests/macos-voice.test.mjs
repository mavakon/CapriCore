// SPDX-License-Identifier: GPL-3.0-only
// macOS speech paths. Every case pins its platform, so it runs on any CI host.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import zlib, { deflateRawSync } from 'node:zlib';
import { temporaryFolders } from './temporary-folders.mjs';
import catalog from '../config/tts-catalog.json' with { type: 'json' };
import { crc32, extractZip, zipEntries } from '../packages/installer/src/zip-archive.mjs';
import {
  managedPython,
  managedPythonKey,
  ownedInterpreter,
  uvExecutable,
  venvPython,
  venvPythonRelative,
  venvSitePackages,
} from '../packages/runtime/src/host/python-env.mjs';
import { ASR_ENVIRONMENT, nativeStartupCode } from '../apps/desktop/asr-worker.mjs';
import {
  voiceAppleSupported,
  voiceGpuSupported,
} from '../packages/runtime/src/hardware/voice-gpu.mjs';
import {
  MAC_SPEECH_COMPONENTS,
  macSpeechOptions,
  parseRuntimeReport,
  runMacSpeechComponent,
} from '../packages/installer/src/macos-speech.mjs';
import { macPythonEnvironment } from '../packages/installer/src/macos-python.mjs';
import { installSpeechComponents } from '../packages/installer/src/speech-components.mjs';
import {
  VoiceCatalogService,
  platformVoiceDevices,
  voiceRuntime,
  voiceRuntimes,
} from '../apps/desktop/voice-catalog-service.mjs';
import {
  MAC_TRAINING_UNAVAILABLE,
  VoiceTrainingService,
} from '../apps/desktop/voice-training-service.mjs';
import { requestMicrophoneAccess } from '../apps/desktop/macos-media-access.mjs';
import {
  MAC_MICROPHONE_DENIED,
  macHost,
  microphoneDeniedMessage,
} from '../apps/desktop/renderer/host-platform.mjs';
import { MAC_VOICE_INSTALL_HELP } from '../apps/desktop/renderer/language-panel.mjs';
import { voicePlatformEnvironment } from '../integrations/voice_runtime/environment.mjs';
import { speechSetupSelection } from '../tools/setup/setup-speech-macos.mjs';
import { uiText } from '../apps/desktop/interface-translations.mjs';

const repository = path.resolve(import.meta.dirname, '..');
const folder = temporaryFolders('capri-macos-voice-');
const links = process.platform !== 'win32';
const hash = (value) => createHash('sha256').update(value).digest('hex');

function write(root, name, value = '') {
  const file = path.join(root, name);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value),
  );
  return file;
}

/** Minimal ZIP writer for fixtures: stored or deflated entries, Unix modes, optional bad CRC. */
function zip(entries) {
  const locals = [],
    centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.from(entry.data ?? '');
    const method = entry.method ?? (data.length ? 8 : 0);
    const body = method === 8 ? deflateRawSync(data) : data;
    const crc = entry.crc ?? crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x031e, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(entry.flags ?? 0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((entry.mode ?? 0) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

test('the portable ZIP reader extracts verified files into an empty folder', () => {
  const root = folder();
  assert.equal(crc32(Buffer.from('Capri voice')), zlib.crc32(Buffer.from('Capri voice')));
  const archive = write(
    root,
    'pack.zip',
    zip([
      { name: 'references/', mode: 0o040755 },
      { name: 'references/neutral.wav', data: 'RIFF fixture', mode: 0o100644 },
      { name: 'voice-profile.json', data: '{"id":"capri"}'.repeat(40) },
      { name: 'empty.txt', method: 0 },
      { name: 'adapter.json', data: '{}', method: 0 },
    ]),
  );
  assert.deepEqual(
    zipEntries(archive).map((entry) => [entry.name, entry.folder]),
    [
      ['references', true],
      ['references/neutral.wav', false],
      ['voice-profile.json', false],
      ['empty.txt', false],
      ['adapter.json', false],
    ],
  );
  const destination = path.join(root, 'out');
  mkdirSync(destination);
  assert.deepEqual(extractZip(archive, destination).sort(), [
    'adapter.json',
    'empty.txt',
    'references/neutral.wav',
    'voice-profile.json',
  ]);
  assert.equal(
    readFileSync(path.join(destination, 'references/neutral.wav'), 'utf8'),
    'RIFF fixture',
  );
  assert.equal(
    readFileSync(path.join(destination, 'voice-profile.json'), 'utf8'),
    '{"id":"capri"}'.repeat(40),
  );
  assert.equal(statSync(path.join(destination, 'empty.txt')).size, 0);
  if (links) assert.equal(statSync(path.join(destination, 'adapter.json')).mode & 0o777, 0o644);
});

test('the portable ZIP reader rejects unsafe archives before writing anything', () => {
  const root = folder();
  const cases = [
    [[{ name: '../escape.txt', data: 'x' }], /Unsafe archive entry/],
    [[{ name: '/absolute.txt', data: 'x' }], /Unsafe archive entry/],
    [[{ name: 'folder\\file.txt', data: 'x' }], /Unsafe archive entry/],
    [[{ name: 'C:drive.txt', data: 'x' }], /Unsafe archive entry/],
    [[{ name: 'a//b.txt', data: 'x' }], /Unsafe archive entry/],
    [[{ name: './a.txt', data: 'x' }], /Unsafe archive entry/],
    [[{ name: 'bell\u0007.txt', data: 'x' }], /Unsafe archive entry/],
    [[{ name: 'link', data: '/etc/passwd', mode: 0o120777, method: 0 }], /Unsafe archive entry/],
    [[{ name: 'fifo', mode: 0o010644 }], /Unsafe archive entry/],
    [
      [
        { name: 'Voice.json', data: 'a' },
        { name: 'voice.json', data: 'b' },
      ],
      /duplicates/,
    ],
    [
      [
        { name: 'models', data: 'file' },
        { name: 'models/weights.bin', data: 'nested' },
      ],
      /duplicates/,
    ],
    [[{ name: 'secret.txt', data: 'x', flags: 1 }], /Encrypted/],
    [[{ name: 'bzip.txt', data: 'x', method: 12 }], /Unsupported archive compression/],
    [[{ name: 'big.bin', data: Buffer.alloc(2048) }], /expansion budget/, { maximumBytes: 1024 }],
  ];
  for (const [entries, error, options] of cases) {
    const archive = write(root, 'unsafe.zip', zip(entries));
    const destination = path.join(root, 'out-' + hash(JSON.stringify(entries)).slice(0, 8));
    mkdirSync(destination);
    assert.throws(() => extractZip(archive, destination, options), error, entries[0].name);
    assert.deepEqual(readdirSync(destination), [], entries[0].name);
  }
  const corrupt = write(root, 'corrupt.zip', zip([{ name: 'a.txt', data: 'abc', crc: 1 }]));
  mkdirSync(path.join(root, 'corrupt'));
  assert.throws(() => extractZip(corrupt, path.join(root, 'corrupt')), /integrity check/);
  write(root, 'not-zip.zip', 'this is not an archive at all, only text');
  mkdirSync(path.join(root, 'plain'));
  assert.throws(
    () => extractZip(path.join(root, 'not-zip.zip'), path.join(root, 'plain')),
    /not a ZIP/,
  );
  const good = write(root, 'good.zip', zip([{ name: 'a.txt', data: 'a' }]));
  write(root, 'busy/existing.txt', 'keep');
  assert.throws(() => extractZip(good, path.join(root, 'busy')), /empty folder/);
  assert.throws(() => extractZip(good, 'relative/folder'), /absolute folder/);
  assert.equal(readFileSync(path.join(root, 'busy/existing.txt'), 'utf8'), 'keep');
});

test('Python environments use the POSIX layout on macOS and keep the Windows layout elsewhere', () => {
  const root = path.resolve('/capri');
  assert.equal(
    venvPython(root, 'asr-venv', 'darwin'),
    path.join(root, '.runtime/asr-venv/bin/python'),
  );
  assert.equal(
    venvPython(root, 'asr-venv', 'win32'),
    path.join(root, '.runtime/asr-venv/Scripts/python.exe'),
  );
  assert.equal(
    venvPython(root, 'asr-venv', 'linux'),
    path.join(root, '.runtime/asr-venv/Scripts/python.exe'),
  );
  assert.equal(venvPythonRelative('qwen-tts-venv', 'darwin'), '.runtime/qwen-tts-venv/bin/python');
  assert.equal(
    venvPythonRelative('qwen-tts-venv', 'win32'),
    '.runtime/qwen-tts-venv/Scripts/python.exe',
  );
  assert.equal(
    venvSitePackages(root, 'asr-venv', { platform: 'darwin' }),
    path.join(root, '.runtime/asr-venv/lib/python3.11/site-packages'),
  );
  assert.equal(
    venvSitePackages(root, 'asr-venv', { platform: 'win32' }),
    path.join(root, '.runtime/asr-venv/Lib/site-packages'),
  );
  assert.equal(uvExecutable(root, 'darwin'), path.join(root, '.runtime/uv/uv'));
  assert.equal(uvExecutable(root, 'win32'), path.join(root, '.runtime/uv/uv.exe'));
  assert.equal(
    managedPythonKey('3.11.17', 'darwin', 'arm64'),
    'cpython-3.11.17-macos-aarch64-none',
  );
  assert.equal(
    managedPython(root, '3.11.17', 'darwin', 'arm64'),
    path.join(root, '.runtime/python/cpython-3.11.17-macos-aarch64-none/bin/python3.11'),
  );
  assert.throws(() => managedPythonKey('3.11.17', 'darwin', 'x64'), /Apple silicon/);
  for (const name of ['../asr-venv', 'ASR', '', 'a/b'])
    assert.throws(() => venvPython(root, name, 'darwin'), /Invalid owned Python/);
  assert.throws(() => venvSitePackages(root, 'asr-venv', { series: '3.11/../..' }), /series/);
});

test(
  'a macOS venv interpreter must resolve into the managed Python folder',
  { skip: !links && 'symbolic links need extra rights on Windows' },
  () => {
    const root = folder();
    const managed = write(
      root,
      '.runtime/python/cpython-3.11.17-macos-aarch64-none/bin/python3.11',
    );
    const venv = path.join(root, '.runtime/asr-venv/bin/python');
    mkdirSync(path.dirname(venv), { recursive: true });
    symlinkSync(managed, venv);
    assert.equal(ownedInterpreter(root, venv), true);
    const outside = write(root, 'elsewhere/python3.11');
    const foreign = path.join(root, '.runtime/qwen-tts-venv/bin/python');
    mkdirSync(path.dirname(foreign), { recursive: true });
    symlinkSync(outside, foreign);
    assert.equal(ownedInterpreter(root, foreign), false);
    const plain = write(root, '.runtime/router-venv/bin/python');
    assert.equal(ownedInterpreter(root, plain), true);
    linkSync(plain, path.join(root, 'hard-link'));
    assert.equal(ownedInterpreter(root, plain), false);
    assert.equal(ownedInterpreter(root, path.join(root, 'missing/python')), false);
  },
);

test('the recognizer maps POSIX crash signals and passes only a small macOS environment', () => {
  assert.equal(nativeStartupCode(null, 'SIGSEGV'), 'ASR_START_NATIVE_CRASH');
  assert.equal(nativeStartupCode(null, 'SIGBUS'), 'ASR_START_NATIVE_CRASH');
  assert.equal(nativeStartupCode(null, 'SIGILL'), 'ASR_START_NATIVE_INSTRUCTION');
  assert.equal(nativeStartupCode(null, 'SIGTERM'), 'ASR_START_EXIT');
  assert.equal(nativeStartupCode(0xc0000005, null), 'ASR_START_NATIVE_CRASH');
  assert.equal(nativeStartupCode(1, null), 'ASR_START_EXIT');
  assert.deepEqual(ASR_ENVIRONMENT.darwin, ['PATH', 'HOME', 'TMPDIR', 'USER', 'LANG']);
  assert.ok(ASR_ENVIRONMENT.win32.includes('SystemRoot'));
});

test('every Apple silicon Mac can speak, without NVIDIA or AMD hardware', () => {
  assert.equal(voiceAppleSupported({ platform: 'darwin', arch: 'arm64' }), true);
  assert.equal(voiceAppleSupported({ platform: 'darwin', arch: 'x64' }), false);
  assert.equal(voiceAppleSupported({ platform: 'win32', arch: 'arm64' }), false);
  assert.equal(voiceGpuSupported({ platform: 'darwin', arch: 'arm64', gpus: [] }), true);
  assert.equal(voiceGpuSupported({ platform: 'win32', arch: 'x64', gpus: [] }), false);
  assert.equal(
    voiceGpuSupported({ platform: 'win32', arch: 'x64', gpus: [{ vendor: 'NVIDIA' }] }),
    true,
  );
  assert.deepEqual(voicePlatformEnvironment('darwin'), { PYTORCH_ENABLE_MPS_FALLBACK: '1' });
  assert.deepEqual(voicePlatformEnvironment('win32'), {});
});

test('Windows installer arguments translate to fixed macOS component options', () => {
  assert.deepEqual(macSpeechOptions('voice', []), {});
  assert.deepEqual(macSpeechOptions('voice', ['-DependenciesOnly']), { dependenciesOnly: true });
  assert.deepEqual(macSpeechOptions('multilingual', ['-Language', 'pt-BR']), { language: 'pt-BR' });
  assert.deepEqual(macSpeechOptions('qwen', ['-Russian']), { russian: true });
  assert.deepEqual(macSpeechOptions('recognition-en'), {});
  assert.throws(() => macSpeechOptions('voice', ['-Language', 'fr']), /Unsupported/);
  assert.throws(() => macSpeechOptions('voice', ['DependenciesOnly']), /Invalid/);
  assert.throws(() => macSpeechOptions('qwen', ['-Russian', '-Russian']), /Unsupported/);
  assert.throws(() => macSpeechOptions('multilingual', ['-Language']), /Missing/);
  assert.throws(() => macSpeechOptions('archive', []), /Unsupported/);
  assert.deepEqual(MAC_SPEECH_COMPONENTS, [
    'recognition-en',
    'recognition-multi',
    'recognition-fast-multi',
    'voice',
    'multilingual',
    'qwen',
  ]);
  assert.deepEqual(
    parseRuntimeReport(['Voice runtime: macos', '{"a":1}', 'noise', '{"b":2}', '']),
    {
      b: 2,
    },
  );
  assert.equal(parseRuntimeReport(['{broken', '[1]', 'text']), null);
});

test('Python children get owned caches and no inherited package-index or path hooks', () => {
  const root = path.resolve('/capri');
  const env = macPythonEnvironment(root, {
    PATH: '/opt/homebrew/bin',
    HOME: '/Users/example',
    UV_INDEX_URL: 'https://mirror.invalid/simple',
    PIP_EXTRA_INDEX_URL: 'https://mirror.invalid/simple',
    PYTHONPATH: '/tmp/hooks',
    UV_PYTHON: '/usr/bin/python3',
    VIRTUAL_ENV: '/tmp/venv',
  });
  for (const name of [
    'UV_INDEX_URL',
    'PIP_EXTRA_INDEX_URL',
    'PYTHONPATH',
    'UV_PYTHON',
    'VIRTUAL_ENV',
  ])
    assert.equal(env[name], undefined, name);
  assert.equal(env.HOME, '/Users/example');
  assert.equal(env.PATH, '/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin');
  assert.equal(env.UV_PYTHON_INSTALL_DIR, path.join(root, '.runtime/python'));
  assert.equal(env.UV_PYTHON_PREFERENCE, 'only-managed');
  assert.equal(env.UV_CACHE_DIR, path.join(root, '.runtime/uv-cache'));
  assert.equal(env.TMPDIR, path.join(root, '.runtime/tmp'));
  assert.equal(env.PYTHONNOUSERSITE, '1');
});

/** Fake uv, tar and Python: each call creates only what the real tool would. */
function macTools(root, { mps = true, failDoctor = false } = {}) {
  const managed = managedPython(root, '3.11.17', 'darwin', 'arm64');
  const calls = [];
  const relative = (value) =>
    typeof value === 'string' && value.startsWith(root + path.sep)
      ? path.relative(root, value).split(path.sep).join('/')
      : value;
  const execute = async (executable, args, options = {}) => {
    calls.push({ command: [relative(executable), ...args.map(relative)], env: options.env });
    if (executable === '/usr/bin/tar') {
      const extracted = path.join(args[3], 'uv-aarch64-apple-darwin');
      write(extracted, 'uv', 'uv fixture');
      write(extracted, 'uvx', 'uvx fixture');
    } else if (args[0] === 'python' && args[1] === 'install')
      write(path.dirname(managed), path.basename(managed));
    else if (args[0] === '--version') options.output?.('Python 3.11.17');
    else if (args[0] === 'venv') {
      mkdirSync(path.join(args[1], 'bin'), { recursive: true });
      symlinkSync(managed, path.join(args[1], 'bin/python'));
    } else if (args.includes('doctor')) {
      if (failDoctor) throw new Error('doctor failed');
      options.output?.('Voice runtime check');
      options.output?.(
        JSON.stringify({
          cuda: false,
          mpsCompute: mps
            ? { kernelReady: true, device: 'Apple GPU (Metal)' }
            : {
                kernelReady: false,
                error: 'PyTorch cannot use the Apple GPU (Metal) on this Mac.',
              },
        }),
      );
    }
  };
  const download = async (spec, destination) => {
    assert.equal(spec.url.startsWith('https://github.com/astral-sh/uv/releases/download/'), true);
    return write(destination, path.basename(spec.url), 'uv archive fixture');
  };
  return { calls, execute, download, managed };
}

function macRoot() {
  const root = folder();
  for (const name of ['macos-runtime.json', 'requirements-qwen-tts-macos.lock'])
    write(root, 'config/' + name, readFileSync(path.join(repository, 'config', name)));
  write(root, 'config/requirements-voice-macos.lock', '# fixture lock\n');
  write(root, 'config/asr-requirements.lock.txt', '# fixture lock\n');
  for (const name of [
    'uv-retry.py',
    'provision-streaming-asr.py',
    'provision-multilingual-candidates.py',
    'provision-multilingual.py',
  ])
    write(root, 'tools/setup/' + name, '# fixture');
  return root;
}

test(
  'the macOS voice installer runs the pinned uv, Python and hash-locked voice lock in order',
  { skip: !links && 'uv creates venv links on macOS' },
  async () => {
    const root = macRoot();
    const tools = macTools(root);
    const lines = [];
    await runMacSpeechComponent(
      'voice',
      {},
      {
        root,
        execute: tools.execute,
        download: tools.download,
        output: (line) => lines.push(line),
        baseEnv: { PATH: '/usr/bin', HOME: '/Users/example', PYTHONPATH: '/tmp/hooks' },
        platform: 'darwin',
        arch: 'arm64',
      },
    );
    const commands = tools.calls.map(({ command }) => command);
    const venv = '.runtime/voice-training-venv/bin/python';
    const python = '.runtime/python/cpython-3.11.17-macos-aarch64-none/bin/python3.11';
    assert.deepEqual(commands[0].slice(0, 2), ['/usr/bin/tar', '-xzf']);
    assert.deepEqual(commands.slice(1), [
      [
        '.runtime/uv/uv',
        'python',
        'install',
        'cpython-3.11.17-macos-aarch64-none',
        '--no-bin',
        '--no-config',
      ],
      [python, '--version'],
      ['.runtime/uv/uv', 'venv', '.runtime/voice-training-venv', '--python', python, '--no-config'],
      [
        python,
        'tools/setup/uv-retry.py',
        '--uv',
        '.runtime/uv/uv',
        '--',
        'pip',
        'sync',
        '--python',
        venv,
        'config/requirements-voice-macos.lock',
        '--require-hashes',
        '--default-index',
        'https://pypi.org/simple',
        '--index-strategy',
        'first-index',
        '--no-config',
      ],
      [venv, '-m', 'integrations.voice_training', 'doctor', '--runtime-only'],
      [venv, '-m', 'integrations.voice_training', 'init'],
      [venv, '-m', 'integrations.voice_training', 'download'],
    ]);
    for (const { env } of tools.calls.slice(1)) {
      assert.equal(env.PYTHONPATH, undefined);
      assert.equal(env.UV_CACHE_DIR, path.join(root, '.runtime/uv-cache'));
    }
    assert.deepEqual(
      JSON.parse(readFileSync(path.join(root, '.runtime/voice-runtime.json'), 'utf8')),
      {
        profile: 'macos',
        torch: '2.6.0',
        torchaudio: '2.6.0',
        backend: 'mps',
        requirements: 'config/requirements-voice-macos.lock',
        devices: [],
        warning: null,
      },
    );
    assert.ok(lines.some((line) => /Apple GPU \(MPS\) with CPU fallback/.test(line)));
    const receipt = JSON.parse(readFileSync(path.join(root, '.runtime/installer/uv.json'), 'utf8'));
    assert.equal(receipt.platform, 'darwin-arm64');
    assert.equal(receipt.executableSha256, hash('uv fixture'));
    assert.equal(lstatSync(path.join(root, venv)).isSymbolicLink(), true);

    // A second run reuses the verified uv, interpreter and venv; only the lock and checks run.
    tools.calls.length = 0;
    await runMacSpeechComponent(
      'voice',
      { dependenciesOnly: true },
      { root, execute: tools.execute, download: tools.download, platform: 'darwin', arch: 'arm64' },
    );
    assert.deepEqual(
      tools.calls.map(({ command }) => command[1]),
      ['--version', '--version', 'tools/setup/uv-retry.py', '-m'],
    );
  },
);

test(
  'a Mac without a working Metal device still installs voice for the CPU',
  { skip: !links && 'uv creates venv links on macOS' },
  async () => {
    const root = macRoot();
    const tools = macTools(root, { mps: false });
    const lines = [];
    await runMacSpeechComponent(
      'voice',
      { dependenciesOnly: true },
      {
        root,
        execute: tools.execute,
        download: tools.download,
        output: (line) => lines.push(line),
        platform: 'darwin',
        arch: 'arm64',
      },
    );
    assert.equal(
      JSON.parse(readFileSync(path.join(root, '.runtime/voice-runtime.json'), 'utf8')).backend,
      'cpu',
    );
    assert.ok(lines.some((line) => /Voice will run on the CPU/.test(line)));
    assert.equal(
      tools.calls.some(({ command }) => command.includes('download')),
      false,
    );
  },
);

test(
  'macOS Qwen installs report catalog stages and refuse CUDA or ROCm',
  { skip: !links && 'uv creates venv links on macOS' },
  async () => {
    const root = macRoot();
    const tools = macTools(root);
    const lines = [];
    const context = {
      root,
      execute: tools.execute,
      download: tools.download,
      output: (line) => lines.push(line),
      platform: 'darwin',
      arch: 'arm64',
    };
    await assert.rejects(
      runMacSpeechComponent('qwen', { cuda: true }, context),
      /not available on macOS/,
    );
    await runMacSpeechComponent('qwen', { russian: true }, context);
    assert.deepEqual(
      lines.filter((line) => line.startsWith('{')).map((line) => JSON.parse(line).stage),
      ['python', 'dependencies', 'verify', 'models'],
    );
    const commands = tools.calls.map(({ command }) => command);
    assert.ok(
      commands.some(
        (command) =>
          command.includes('config/requirements-qwen-tts-macos.lock') &&
          command.includes('--require-hashes'),
      ),
    );
    assert.deepEqual(commands.at(-1), [
      '.runtime/qwen-tts-venv/bin/python',
      '-m',
      'integrations.voice_runtime.qwen_provision',
      '--russian',
    ]);
  },
);

test('macOS speech installers refuse other hosts, unknown components and relative roots', async () => {
  const root = macRoot();
  const context = { root, platform: 'darwin', arch: 'arm64', execute: async () => assert.fail() };
  await assert.rejects(
    runMacSpeechComponent('voice', {}, { ...context, platform: 'win32' }),
    /macOS on Apple silicon/,
  );
  await assert.rejects(
    runMacSpeechComponent('voice', {}, { ...context, arch: 'x64' }),
    /macOS on Apple silicon/,
  );
  await assert.rejects(runMacSpeechComponent('archive', {}, context), /Unsupported/);
  await assert.rejects(
    runMacSpeechComponent('voice', {}, { ...context, root: 'relative' }),
    /absolute Capri folder/,
  );
  await assert.rejects(
    runMacSpeechComponent(
      'multilingual',
      { language: '../x' },
      {
        ...context,
        ...macTools(root),
      },
    ),
    /Invalid speech installer argument/,
  );
});

function speechRoot() {
  const root = macRoot();
  for (const name of [
    'companion-asr.json',
    'installer.json',
    'companion-voice.json',
    'voice-upstream.json',
    'release.json',
  ])
    write(root, 'config/' + name, readFileSync(path.join(repository, 'config', name)));
  return root;
}

function voicePackZip(root) {
  const model = JSON.parse(
    readFileSync(path.join(root, 'config/voice-upstream.json'), 'utf8'),
  ).model;
  return zip([
    { name: 'references/', mode: 0o040755 },
    { name: 'references/neutral.wav', data: 'reference fixture' },
    { name: 'adapter.json', data: '{}' },
    { name: 'adapter.safetensors', data: 'adapter fixture' },
    {
      name: 'voice-profile.json',
      data: JSON.stringify({
        schemaVersion: 1,
        id: 'capri-en-v1',
        language: 'en',
        engine: 'chatterbox-turbo',
        baseModel: model,
        adapter: 'adapter.safetensors',
        adapterConfig: 'adapter.json',
        adapterSha256: hash('adapter fixture'),
        references: {
          neutral: { file: 'references/neutral.wav', sha256: hash('reference fixture') },
        },
      }),
    },
  ]);
}

function speechOptions(root, { calls, components }) {
  const tools = macTools(root);
  let ready = false;
  const tag = JSON.parse(readFileSync(path.join(root, 'config/release.json'), 'utf8')).tag;
  const pack = voicePackZip(root);
  return {
    tools,
    options: {
      root,
      node: process.execPath,
      platform: 'darwin',
      free: () => 40 * 1024 ** 3,
      ownerStamp: () => assert.fail('macOS does not use the PowerShell owner stamp'),
      hardware: async () => ({ platform: 'darwin', arch: 'arm64', gpus: [] }),
      voiceReady: () => ready,
      recognitionReady: () => components.some(([name]) => name.startsWith('recognition')),
      credential: async () => null,
      releases: async () => [
        {
          tag_name: tag,
          draft: false,
          prerelease: false,
          assets: [
            {
              id: 42,
              name: 'capri-en-v1.zip',
              state: 'uploaded',
              size: pack.length,
              digest: 'sha256:' + hash(pack),
            },
          ],
        },
      ],
      downloadPack: async (asset, destination) => {
        assert.equal(asset.id, 42);
        return write(destination, 'capri-en-v1.zip', pack);
      },
      download: tools.download,
      execute: async (executable, args, options) => {
        calls.push(executable);
        assert.notEqual(executable, 'powershell.exe');
        return tools.execute(executable, args, options);
      },
      macComponent: async (component, options, context) => {
        assert.equal(context.root, root);
        assert.equal(context.baseEnv.UV_CACHE_DIR, path.join(root, '.runtime/uv-cache'));
        components.push([component, options]);
        if (component === 'voice') ready = true;
      },
    },
  };
}

test('macOS speech setup installs the voice pack and components without PowerShell', async () => {
  const root = speechRoot();
  const calls = [],
    components = [],
    events = [];
  const { options } = speechOptions(root, { calls, components });
  await installSpeechComponents(
    { speech: 'en', recognition: 'en' },
    { ...options, emit: (event) => events.push(event.stage) },
  );
  assert.deepEqual(components, [
    ['recognition-en', {}],
    ['voice', {}],
  ]);
  assert.deepEqual(calls, ['/usr/bin/tar']);
  assert.deepEqual(
    [...new Set(events)],
    ['python', 'recognition', 'voice-pack', 'voice-runtime', 'verify'],
  );
  const settings = JSON.parse(readFileSync(path.join(root, 'config/companion-voice.json'), 'utf8'));
  const profile = path.join(root, settings.profileDir);
  assert.ok(profile.startsWith(root + path.sep));
  assert.equal(readFileSync(path.join(profile, 'adapter.safetensors'), 'utf8'), 'adapter fixture');
  assert.equal(existsSync(path.join(root, '.runtime/git')), false);
});

test('non-English macOS voices install dependencies first, then the language model', async () => {
  const root = speechRoot();
  const calls = [],
    components = [];
  const { options } = speechOptions(root, { calls, components });
  await installSpeechComponents({ speech: 'fr', recognition: 'auto-europe' }, options);
  assert.deepEqual(components, [
    ['recognition-fast-multi', {}],
    ['voice', { dependenciesOnly: true }],
    ['multilingual', { language: 'fr' }],
  ]);
  components.length = 0;
  await installSpeechComponents(
    { speech: 'off', recognition: 'de' },
    {
      ...options,
      recognitionReady: () => components.length > 0,
    },
  );
  assert.deepEqual(components, [['recognition-multi', {}]]);
});

function catalogRoot() {
  const root = folder();
  write(root, 'config/tts-catalog.json', catalog);
  write(root, 'config/companion-voice.json', {
    schemaVersion: 1,
    profileDir: 'data/voices/capri/en/exports/original',
  });
  write(root, 'config/voice-training.json', {
    engine: 'chatterbox-turbo',
    language: 'en',
    modelDir: 'data/speech/turbo',
    datasetDir: 'data/voices/capri/en',
    training: { minimumFreeVramGiB: 5 },
  });
  write(root, 'config/qwen-tts-upstream.json', {
    directory: 'data/speech/qwen',
    files: [{ file: 'model.safetensors', bytes: 3 }],
  });
  write(root, 'data/voices/capri/en/exports/original/voice-profile.json', { id: 'original' });
  write(root, '.runtime/voice-training-venv/bin/python', 'fixture');
  write(root, 'data/speech/turbo/model-receipt.json', {});
  return root;
}

test('the Mac voice catalog offers the Apple GPU and no NVIDIA, AMD or Breeze installers', async () => {
  const root = catalogRoot();
  const service = new VoiceCatalogService({
    root,
    platform: 'darwin',
    arch: 'arm64',
    hardware: async () => assert.fail('AMD detection does not run on macOS'),
  });
  const value = await service.refresh();
  assert.equal(value.qwenAccelerationSupported, false);
  assert.equal(value.appleGpu, true);
  assert.equal(value.qwenRocmSupported, false);
  assert.equal(value.russianQwenCudaReady, false);
  assert.equal(value.breezeSupported, false);
  const devices = Object.fromEntries(value.models.map((model) => [model.id, model.devices]));
  assert.deepEqual(devices['chatterbox-turbo'], ['cpu', 'mps']);
  assert.deepEqual(devices['qwen3-tts-1.7b-capri-ru'], ['cpu', 'mps']);
  assert.deepEqual(devices['breeze-tts-2-q4-k'], ['vulkan', 'cpu']);
  assert.equal(value.models.find((model) => model.id === 'chatterbox-turbo').installed, true);
  assert.deepEqual(
    platformVoiceDevices({ backend: 'qwen3-tts', devices: ['cpu', 'cuda', 'rocm'] }, 'win32'),
    ['cpu', 'cuda', 'rocm'],
  );
  assert.throws(
    () => service.install({ modelId: 'qwen3-tts-0.6b-base', language: 'ru', cuda: true }),
    /not available on macOS/,
  );
  assert.throws(
    () => service.install({ modelId: 'breeze-tts-2-q4-k', language: 'zh', acceptLicense: true }),
    /Windows x64/,
  );
});

test('a Mac Qwen download uses the macOS installer with a minimal environment', async () => {
  const root = catalogRoot();
  const previous = process.env.HF_TOKEN;
  process.env.HF_TOKEN = 'secret-token-fixture';
  try {
    const installs = [];
    let prepared;
    const service = new VoiceCatalogService({
      root,
      platform: 'darwin',
      arch: 'arm64',
      free: () => 40 * 1024 ** 3,
      beforeChange: async () => {},
      prepare: async (options) => {
        prepared = options;
      },
      run: async () => assert.fail('PowerShell is not used on macOS'),
      macInstall: async (component, options, context) => {
        installs.push([component, options]);
        assert.equal(context.root, root);
        assert.ok(context.signal instanceof AbortSignal);
        for (const key of Object.keys(context.baseEnv))
          assert.ok(['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG'].includes(key), key);
        write(root, '.runtime/qwen-tts-venv/bin/python', 'fixture');
        write(root, 'data/speech/qwen/model.safetensors', 'abc');
        context.output('{"stage":"models","progress":50}');
      },
    });
    assert.equal(
      service.install({ modelId: 'qwen3-tts-0.6b-base', language: 'ru' }).phase,
      'installing',
    );
    await service.task;
    assert.equal(prepared.platform, 'darwin');
    assert.deepEqual(installs, [['qwen', { russian: false }]]);
    assert.equal(service.snapshot().phase, 'ready');
    const qwen = catalog.models.find((model) => model.id === 'qwen3-tts-0.6b-base');
    assert.equal(service.snapshot().models.find((model) => model.id === qwen.id).installed, true);
    assert.deepEqual(voiceRuntime(root, qwen, 'cpu', 'darwin'), {
      backend: 'cpu',
      python: path.join(root, '.runtime/qwen-tts-venv/bin/python'),
      env: { PYTORCH_ENABLE_MPS_FALLBACK: '1' },
    });
    assert.throws(() => voiceRuntime(root, qwen, 'cuda:0', 'darwin'), /GPU runtime is missing/);
    const turbo = catalog.models.find((model) => model.id === 'chatterbox-turbo');
    const [chatterbox] = voiceRuntimes(root, turbo, 'darwin');
    assert.equal(chatterbox.python, path.join(root, '.runtime/voice-training-venv/bin/python'));
    assert.equal(chatterbox.env.PYTORCH_ENABLE_MPS_FALLBACK, '1');
  } finally {
    if (previous === undefined) delete process.env.HF_TOKEN;
    else process.env.HF_TOKEN = previous;
  }
});

test('voice training is clearly unavailable on macOS', async () => {
  const root = catalogRoot();
  const service = new VoiceTrainingService({ root, platform: 'darwin' });
  assert.deepEqual(service.availability(), { available: false, reason: MAC_TRAINING_UNAVAILABLE });
  assert.equal(service.snapshot().reason, MAC_TRAINING_UNAVAILABLE);
  assert.throws(() => service.start(), new RegExp(MAC_TRAINING_UNAVAILABLE.slice(0, 40)));
  assert.throws(() => service.chooseDataset(root), /not available on macOS/);
  await assert.rejects(service.importDataset({}), /not available on macOS/);
});

test('macOS asks for microphone access once and respects a denial', async () => {
  const preferences = (status, answer = true) => {
    const asked = [];
    return {
      asked,
      getMediaAccessStatus: (type) => {
        assert.equal(type, 'microphone');
        return status;
      },
      askForMediaAccess: async (type) => {
        asked.push(type);
        return answer;
      },
    };
  };
  for (const [status, answer, expected, prompts] of [
    ['granted', true, true, 0],
    ['denied', true, false, 0],
    ['restricted', true, false, 0],
    ['not-determined', true, true, 1],
    ['not-determined', false, false, 1],
    ['unknown', true, true, 1],
  ]) {
    const value = preferences(status, answer);
    assert.equal(
      await requestMicrophoneAccess({ platform: 'darwin', preferences: value }),
      expected,
    );
    assert.equal(value.asked.length, prompts, status);
  }
  const failing = {
    getMediaAccessStatus: () => 'not-determined',
    askForMediaAccess: async () => {
      throw new Error('TCC unavailable');
    },
  };
  assert.equal(await requestMicrophoneAccess({ platform: 'darwin', preferences: failing }), false);
  assert.equal(await requestMicrophoneAccess({ platform: 'darwin' }), false);
  assert.equal(
    await requestMicrophoneAccess({
      platform: 'win32',
      preferences: { getMediaAccessStatus: () => assert.fail() },
    }),
    true,
  );
});

test('Mac users get macOS settings guidance in their interface language', () => {
  assert.equal(macHost({ userAgentData: { platform: 'macOS' } }), true);
  assert.equal(macHost({ platform: 'MacIntel' }), true);
  assert.equal(macHost({ platform: 'Win32' }), false);
  assert.equal(macHost(undefined), false);
  assert.equal(microphoneDeniedMessage({ platform: 'MacIntel' }), MAC_MICROPHONE_DENIED);
  assert.match(microphoneDeniedMessage({ platform: 'Win32' }), /Windows microphone access/);
  for (const key of [MAC_MICROPHONE_DENIED, MAC_TRAINING_UNAVAILABLE, MAC_VOICE_INSTALL_HELP]) {
    assert.equal(uiText(key, 'en'), key);
    for (const language of ['de', 'ja', 'ru', 'ar'])
      assert.notEqual(uiText(key, language), key, `${language}: ${key}`);
  }
  assert.match(uiText(MAC_MICROPHONE_DENIED, 'de'), /Systemeinstellungen/);
});

test('the macOS speech setup command accepts only supported selections', () => {
  assert.deepEqual(speechSetupSelection([]), { speech: 'en', recognition: 'en' });
  assert.deepEqual(speechSetupSelection(['--speech', 'off', '--recognition', 'auto-europe']), {
    speech: 'off',
    recognition: 'auto-europe',
  });
  assert.throws(() => speechSetupSelection(['--speech', 'xx']), /supported voice/);
  assert.throws(
    () => speechSetupSelection(['--speech', 'off', '--recognition', 'off']),
    /supported/,
  );
  assert.throws(() => speechSetupSelection(['--unknown', 'x']), /Unknown option/);
});
