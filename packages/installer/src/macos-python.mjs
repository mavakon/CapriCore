// SPDX-License-Identifier: GPL-3.0-only
/**
 * macOS counterpart of tools/setup/python-runtime.ps1: the pinned uv binary,
 * uv's managed CPython and the owned virtual environments under .runtime.
 * Every path stays inside the installation; nothing is installed system-wide.
 */
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
} from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { noLinks, readJson } from './policy.mjs';
import { fetchArtifact, fileHash } from './download.mjs';
import { runCommand } from './commands.mjs';
import { writeJsonAtomic } from '../../runtime/src/atomic-json.mjs';
import {
  PYTHON_VERSION,
  managedPython,
  managedPythonKey,
  ownedInterpreter,
  uvExecutable,
  venvDirectory,
  venvPython,
} from '../../runtime/src/host/python-env.mjs';

export const MAC_VENVS = Object.freeze([
  'asr-venv',
  'router-venv',
  'voice-training-venv',
  'qwen-tts-venv',
]);

/** Package-index settings a user may have exported that must not redirect pinned installs. */
const INDEX_OVERRIDES = [
  'UV_INDEX',
  'UV_EXTRA_INDEX_URL',
  'UV_INDEX_URL',
  'UV_DEFAULT_INDEX',
  'UV_FIND_LINKS',
  'UV_NO_INDEX',
  'UV_INDEX_STRATEGY',
  'UV_TORCH_BACKEND',
  'UV_OVERRIDE',
  'UV_CONSTRAINT',
  'UV_BUILD_CONSTRAINT',
  'PIP_INDEX_URL',
  'PIP_EXTRA_INDEX_URL',
  'PYTHONPATH',
  'PYTHONHOME',
  'PYTHONSTARTUP',
  'NODE_OPTIONS',
  'NODE_PATH',
  'VIRTUAL_ENV',
  'CONDA_PREFIX',
];

function owned(root, relative) {
  const file = path.resolve(root, relative);
  if (!file.startsWith(root + path.sep)) throw new Error('Speech runtimes must stay inside Capri.');
  noLinks(file);
  return file;
}

export function macRuntimeSpec(root, name) {
  const spec = readJson(owned(root, 'config/macos-runtime.json'));
  if (spec.schemaVersion !== 1 || spec.platform !== 'darwin-arm64')
    throw new Error('Invalid macOS runtime manifest.');
  return spec[name];
}

function validUvSpec(spec) {
  return (
    spec &&
    /^\d+\.\d+\.\d+$/.test(spec.version) &&
    spec.url ===
      `https://github.com/astral-sh/uv/releases/download/${spec.version}/uv-aarch64-apple-darwin.tar.gz` &&
    spec.archiveRoot === 'uv-aarch64-apple-darwin' &&
    /^[a-f0-9]{64}$/.test(spec.sha256) &&
    Number.isSafeInteger(spec.bytes) &&
    spec.bytes > 0 &&
    spec.bytes <= 64 * 1024 ** 2
  );
}

/** Environment for every uv and Python child: owned caches, no inherited index or path hooks. */
export function macPythonEnvironment(root, base = process.env) {
  const env = { ...base };
  for (const name of INDEX_OVERRIDES) delete env[name];
  for (const name of Object.keys(env)) if (/^UV_PYTHON/.test(name)) delete env[name];
  const temporary = path.join(root, '.runtime/tmp');
  Object.assign(env, {
    PATH: ['/usr/bin', '/bin', '/usr/sbin', '/sbin', base.PATH ?? ''].filter(Boolean).join(':'),
    UV_PYTHON_INSTALL_DIR: path.join(root, '.runtime/python'),
    UV_PYTHON_BIN_DIR: path.join(root, '.runtime/python-bin'),
    UV_PYTHON_INSTALL_BIN: '0',
    UV_PYTHON_PREFERENCE: 'only-managed',
    UV_NO_CONFIG: '1',
    UV_CACHE_DIR: path.join(root, '.runtime/uv-cache'),
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
    PYTHONNOUSERSITE: '1',
    HF_HUB_DISABLE_TELEMETRY: '1',
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
  });
  return env;
}

/** Verified local uv for macOS. Mirrors ensureUv: receipt, pinned SHA-256, no links. */
export async function ensureMacUv({
  root,
  signal,
  download = fetchArtifact,
  execute = runCommand,
  emit = () => {},
} = {}) {
  if (!path.isAbsolute(root))
    throw new Error('Runtime preparation needs an absolute Capri folder.');
  root = path.resolve(root);
  signal?.throwIfAborted();
  const spec = macRuntimeSpec(root, 'uv');
  if (!validUvSpec(spec)) throw new Error('Invalid pinned uv runtime.');
  const executable = owned(root, path.relative(root, uvExecutable(root, 'darwin')));
  const receipt = owned(root, '.runtime/installer/uv.json');
  emit({ stage: 'dependencies', progress: 0, runtimePhase: 'receipt-check' });
  try {
    const installed = readJson(receipt);
    if (
      installed.sha256 === spec.sha256 &&
      installed.platform === 'darwin-arm64' &&
      lstatSync(executable).isFile() &&
      installed.executableSha256 === (await fileHash(executable, signal))
    )
      return executable;
  } catch {
    signal?.throwIfAborted();
  }
  const cache = owned(root, '.runtime/installer');
  mkdirSync(cache, { recursive: true });
  emit({ stage: 'dependencies', progress: 0, runtimePhase: 'archive-fetch' });
  const archive = await download(spec, path.join(cache, 'downloads'), { signal });
  signal?.throwIfAborted();
  const runtime = owned(root, '.runtime');
  const scratch = mkdtempSync(path.join(runtime, 'uv-extract-'));
  try {
    await execute('/usr/bin/tar', ['-xzf', archive, '-C', scratch], {
      cwd: root,
      env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
      signal,
      timeoutMs: 5 * 60 * 1000,
    });
    const folder = path.join(scratch, spec.archiveRoot);
    const names = readdirSync(folder).sort();
    if (names.join(',') !== 'uv,uvx') throw new Error('Unexpected uv archive contents.');
    for (const name of names) {
      const info = lstatSync(path.join(folder, name));
      if (!info.isFile() || info.size > 128 * 1024 ** 2)
        throw new Error('Unsafe uv archive entry.');
    }
    const destination = path.dirname(executable);
    noLinks(destination);
    const staged = destination + '.staged-' + randomUUID();
    mkdirSync(staged);
    for (const name of names) {
      copyFileSync(path.join(folder, name), path.join(staged, name));
      chmodSync(path.join(staged, name), 0o755);
    }
    if (existsSync(destination)) {
      const retired = destination + '.retired-' + randomUUID();
      renameSync(destination, retired);
      rmSync(retired, { recursive: true, force: true });
    }
    renameSync(staged, destination);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  noLinks(executable);
  if (!lstatSync(executable).isFile())
    throw new Error('The required uv runtime could not be installed.');
  writeJsonAtomic(receipt, {
    sha256: spec.sha256,
    version: spec.version,
    platform: 'darwin-arm64',
    executableSha256: await fileHash(executable, signal),
  });
  emit({ stage: 'dependencies', progress: 0, runtimePhase: 'ready' });
  return executable;
}

async function captured(execute, executable, args, options) {
  const lines = [];
  await execute(executable, args, { ...options, output: (line) => lines.push(line) });
  return lines.join('\n');
}

/** uv-managed CPython pinned in config/macos-runtime.json, installed under .runtime/python. */
export async function ensureMacPython({
  root,
  uv,
  env,
  signal,
  execute = runCommand,
  output = () => {},
} = {}) {
  const version = macRuntimeSpec(root, 'python')?.version ?? PYTHON_VERSION;
  if (version !== PYTHON_VERSION) throw new Error('The pinned macOS Python version is invalid.');
  const python = managedPython(root, version, 'darwin', 'arm64');
  for (const file of [uv, path.dirname(path.dirname(python)), env.UV_CACHE_DIR, env.TMPDIR])
    noLinks(file);
  mkdirSync(env.TMPDIR, { recursive: true });
  if (!existsSync(python))
    await execute(
      uv,
      [
        'python',
        'install',
        managedPythonKey(version, 'darwin', 'arm64'),
        '--no-bin',
        '--no-config',
      ],
      { cwd: root, env, signal, output, timeoutMs: 30 * 60 * 1000 },
    ).catch((error) => {
      signal?.throwIfAborted();
      throw Object.assign(new Error('Could not install the pinned Python runtime.'), {
        outputTail: error.outputTail,
      });
    });
  if (!lstatSync(python).isFile()) throw new Error(`Pinned Python ${version} is unavailable.`);
  const reported = await captured(execute, python, ['--version'], { cwd: root, env, signal });
  if (reported.trim() !== `Python ${version}`)
    throw new Error(`The local Python runtime does not match pinned Python ${version}.`);
  return { uv, python, version };
}

/** Same repair rule as Windows: keep a broken environment aside, never delete it. */
export async function ensureMacVenv({
  root,
  name,
  runtime,
  env,
  signal,
  execute = runCommand,
  output = () => {},
} = {}) {
  if (!MAC_VENVS.includes(name)) throw new Error('Invalid owned Python environment path.');
  const directory = venvDirectory(root, name);
  noLinks(directory);
  const python = venvPython(root, name, 'darwin');
  const series = runtime.version.split('.').slice(0, 2).join('.');
  if (ownedInterpreter(root, python)) {
    try {
      const reported = await captured(execute, python, ['--version'], { cwd: root, env, signal });
      if (new RegExp(`^Python ${series.replace('.', '\\.')}\\.\\d+$`).test(reported.trim()))
        return python;
    } catch {
      signal?.throwIfAborted();
    }
  }
  if (existsSync(directory)) {
    if (!lstatSync(directory).isDirectory())
      throw new Error('The owned Python environment path is not a directory.');
    const recovery = owned(
      root,
      `.runtime/venv-recovery/${name}-${randomUUID().replaceAll('-', '')}`,
    );
    mkdirSync(path.dirname(recovery), { recursive: true });
    renameSync(directory, recovery);
    output(`Repairing ${name}. Previous environment retained at ${recovery}`);
  }
  await execute(runtime.uv, ['venv', directory, '--python', runtime.python, '--no-config'], {
    cwd: root,
    env,
    signal,
    output,
    timeoutMs: 10 * 60 * 1000,
  });
  if (!ownedInterpreter(root, python))
    throw new Error('Could not create the owned Python environment: ' + name);
  return python;
}

/** Locked install through uv-retry.py, exactly as the Windows scripts do. */
export async function syncMacLock({
  root,
  runtime,
  python,
  lock,
  requireHashes = false,
  env,
  signal,
  execute = runCommand,
  output = () => {},
  timeoutMs = 2 * 60 * 60 * 1000,
} = {}) {
  const file = owned(root, lock);
  if (!/^config\/[a-z0-9.-]+\.(?:lock|txt)$/.test(lock) || !existsSync(file))
    throw new Error('Invalid pinned dependency lock.');
  await execute(
    runtime.python,
    [
      owned(root, 'tools/setup/uv-retry.py'),
      '--uv',
      runtime.uv,
      '--',
      'pip',
      'sync',
      '--python',
      python,
      file,
      ...(requireHashes ? ['--require-hashes'] : []),
      '--default-index',
      'https://pypi.org/simple',
      '--index-strategy',
      'first-index',
      '--no-config',
    ],
    { cwd: root, env, signal, output, timeoutMs },
  );
}
