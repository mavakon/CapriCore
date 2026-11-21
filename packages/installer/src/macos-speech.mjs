// SPDX-License-Identifier: GPL-3.0-only
/**
 * macOS equivalents of the owned PowerShell speech scripts under tools/setup:
 * setup-streaming-asr, setup-multilingual-asr, setup-fast-multilingual-asr,
 * setup-voice-training, setup-multilingual-voice and setup-qwen-tts. They use
 * the same locks, provisioning scripts and model pins, with macOS wheels from
 * PyPI. The Apple GPU is used through PyTorch MPS; CPU remains the fallback.
 */
import path from 'node:path';
import { noLinks } from './policy.mjs';
import { runCommand } from './commands.mjs';
import { fetchArtifact } from './download.mjs';
import { writeJsonAtomic } from '../../runtime/src/atomic-json.mjs';
import {
  ensureMacPython,
  ensureMacUv,
  ensureMacVenv,
  macPythonEnvironment,
  macRuntimeSpec,
  syncMacLock,
} from './macos-python.mjs';

export const MAC_SPEECH_COMPONENTS = Object.freeze([
  'recognition-en',
  'recognition-multi',
  'recognition-fast-multi',
  'voice',
  'multilingual',
  'qwen',
]);

const ASR_LOCK = 'config/asr-requirements.lock.txt';

/** Same failure text as the PowerShell scripts, so diagnostics classify both alike. */
function failure(signal) {
  return (message, task) =>
    task().catch((error) => {
      if (signal?.aborted) throw error;
      throw Object.assign(new Error(message), {
        cause: error,
        exitCode: error?.exitCode,
        outputTail: error?.outputTail ?? error?.message,
      });
    });
}

function validLanguage(value) {
  return value === 'all' || value === 'pt-BR' || /^[a-z]{2,3}$/.test(value ?? '');
}

/** Parses the trailing JSON line of `voice_training doctor --runtime-only`. */
export function parseRuntimeReport(lines) {
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index].trim();
    if (!line.startsWith('{')) continue;
    try {
      const value = JSON.parse(line);
      if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    } catch {}
  }
  return null;
}

export async function runMacSpeechComponent(
  component,
  options = {},
  {
    root,
    signal,
    output = () => {},
    execute = runCommand,
    download = fetchArtifact,
    baseEnv = process.env,
    platform = process.platform,
    arch = process.arch,
  } = {},
) {
  if (platform !== 'darwin' || arch !== 'arm64')
    throw new Error('These speech installers are for macOS on Apple silicon.');
  if (!MAC_SPEECH_COMPONENTS.includes(component))
    throw new Error('Unsupported speech installer component.');
  if (!path.isAbsolute(root))
    throw new Error('Speech installation requires an absolute Capri folder.');
  root = path.resolve(root);
  signal?.throwIfAborted();
  const env = macPythonEnvironment(root, baseEnv);
  const step = failure(signal);
  const run = (executable, args, extra = {}) =>
    execute(executable, args, { cwd: root, env, signal, output, ...extra });
  const uv = await ensureMacUv({ root, signal, download, execute });
  const runtime = await step('Could not install the pinned Python runtime.', () =>
    ensureMacPython({ root, uv, env, signal, execute, output }),
  );
  const venv = (name) =>
    step('Could not create the owned Python environment: ' + name, () =>
      ensureMacVenv({ root, name, runtime, env, signal, execute, output }),
    );
  const sync = (python, lock, message, requireHashes = false) =>
    step(message, () =>
      syncMacLock({ root, runtime, python, lock, requireHashes, env, signal, execute, output }),
    );
  const script = (name) => {
    const file = path.join(root, 'tools/setup', name);
    noLinks(file);
    return file;
  };

  async function recognition() {
    const python = await venv('asr-venv');
    await sync(python, ASR_LOCK, 'Could not install speech recognition dependencies');
    await step('Could not provision Parakeet and the speech detector', () =>
      run(python, [script('provision-streaming-asr.py')]),
    );
    return python;
  }

  if (component === 'recognition-en') return void (await recognition());
  if (component === 'recognition-multi' || component === 'recognition-fast-multi') {
    const python = await recognition();
    await step('Could not install multilingual Parakeet.', () =>
      run(python, [script('provision-multilingual-candidates.py'), '--component', 'asr']),
    );
    if (component === 'recognition-multi')
      await step('Could not install multilingual Whisper.', () =>
        run(python, [script('provision-multilingual.py'), '--component', 'whisper']),
      );
    return;
  }
  if (component === 'multilingual') {
    const language = options.language ?? 'all';
    if (!validLanguage(language)) throw new Error('Invalid speech installer argument.');
    const python = await venv('voice-training-venv');
    await step('Could not install multilingual speech.', () =>
      run(python, [
        script('provision-multilingual.py'),
        '--component',
        'tts',
        '--language',
        language,
      ]),
    );
    return;
  }
  if (component === 'voice') {
    const spec = macRuntimeSpec(root, 'voice');
    if (!spec || !/^config\/requirements-voice-macos\.lock$/.test(spec.requirements))
      throw new Error('Invalid macOS voice runtime manifest.');
    const python = await venv('voice-training-venv');
    output(`Voice runtime: macos / PyTorch ${spec.torch} / Apple GPU (MPS) with CPU fallback`);
    await sync(python, spec.requirements, 'Voice dependencies could not be installed', true);
    const lines = [];
    await step('The voice runtime could not be inspected. Check the output above.', () =>
      run(python, ['-m', 'integrations.voice_training', 'doctor', '--runtime-only'], {
        output: (line) => {
          lines.push(line);
          output(line);
        },
      }),
    );
    const report = parseRuntimeReport(lines);
    if (!report)
      throw new Error('The voice runtime could not be inspected. Check the output above.');
    const mps = report.mpsCompute?.kernelReady === true;
    // Unlike CUDA on Windows, a Mac without a working Metal device still speaks on the CPU.
    if (!mps)
      output(
        'The Apple GPU is unavailable to PyTorch' +
          (report.mpsCompute?.error ? ` (${report.mpsCompute.error})` : '') +
          '. Voice will run on the CPU.',
      );
    if (!options.dependenciesOnly) {
      await step('Voice folders could not be created', () =>
        run(python, ['-m', 'integrations.voice_training', 'init']),
      );
      await step('The pinned voice model could not be downloaded', () =>
        run(python, ['-m', 'integrations.voice_training', 'download']),
      );
    }
    writeJsonAtomic(path.join(root, '.runtime/voice-runtime.json'), {
      profile: 'macos',
      torch: spec.torch,
      torchaudio: spec.torchaudio,
      backend: mps ? 'mps' : 'cpu',
      requirements: spec.requirements,
      devices: [],
      warning: null,
    });
    return;
  }
  // Qwen3-TTS: JSON stage lines match setup-qwen-tts.ps1 for the catalog progress parser.
  if (options.cuda || options.rocm)
    throw new Error('NVIDIA and AMD acceleration packages are not available on macOS.');
  const spec = macRuntimeSpec(root, 'qwen');
  if (!spec || spec.requirements !== 'config/requirements-qwen-tts-macos.lock')
    throw new Error('Invalid macOS Qwen runtime manifest.');
  output(JSON.stringify({ stage: 'python' }));
  const python = await venv('qwen-tts-venv');
  output(JSON.stringify({ stage: 'dependencies' }));
  await sync(python, spec.requirements, 'Qwen speech dependencies could not be installed.', true);
  output(JSON.stringify({ stage: 'verify' }));
  await step('Qwen speech runtime verification failed.', () =>
    run(python, [
      '-c',
      'from qwen_tts import Qwen3TTSModel; from ruaccent import RUAccent; import torch; assert not torch.version.cuda',
    ]),
  );
  if (options.dependenciesOnly) return;
  output(JSON.stringify({ stage: 'models' }));
  await step(
    'Qwen speech model download could not finish. Partial downloads are retained for retry.',
    () =>
      run(python, [
        '-m',
        'integrations.voice_runtime.qwen_provision',
        ...(options.russian ? ['--russian'] : []),
      ]),
  );
}

/** Translates the PowerShell argument list used by the Windows callers. */
export function macSpeechOptions(component, args = []) {
  const allowed = {
    voice: ['DependenciesOnly'],
    multilingual: ['Language'],
    qwen: ['Russian', 'Cuda', 'Rocm'],
    'recognition-en': [],
    'recognition-multi': [],
    'recognition-fast-multi': [],
  }[component];
  if (!allowed) throw new Error('Unsupported speech installer component.');
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (typeof flag !== 'string' || !flag.startsWith('-'))
      throw new Error('Invalid speech installer parameter.');
    const name = flag.slice(1);
    if (!allowed.includes(name)) throw new Error('Unsupported speech installer parameter.');
    const key = name[0].toLowerCase() + name.slice(1);
    if (Object.hasOwn(options, key)) throw new Error('Unsupported speech installer parameter.');
    if (name === 'Language') {
      const value = args[++index];
      if (typeof value !== 'string') throw new Error('Missing speech installer parameter value.');
      options.language = value;
    } else options[key] = true;
  }
  return options;
}
