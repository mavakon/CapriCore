// SPDX-License-Identifier: GPL-3.0-only
/**
 * First-run setup for the macOS app. Capri.app has already copied its code,
 * dependencies and private runtimes into the installation folder, so unlike
 * the Windows wizard there is nothing to bootstrap: setup chooses the model,
 * saves settings, downloads the selected models and verifies the result. It
 * reuses the Windows installer's request validation and model selection, and
 * runs the same `capri.mjs setup|models|doctor` commands with the bundled Node.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { runCommand } from './commands.mjs';
import { findFreePort } from './ports.mjs';
import { installationLock } from './lock.mjs';
import { applyInstallerModelSelection } from './model-selection.mjs';
import { readJson, validateRequest, noLinks, diskFree, assertDiskSpace } from './policy.mjs';
import { writeJsonAtomic } from '../../runtime/src/atomic-json.mjs';
import { probeHardware } from '../../runtime/src/hardware/probe.mjs';
import { recommendProfile } from '../../runtime/src/hardware/profiles.mjs';
import { MODEL_CHOICES, selectModelChoice } from '../../runtime/src/hardware/model-catalog.mjs';
import { bundledNode } from '../../runtime/src/host/platform.mjs';
import { managedProcess } from '../../runtime/src/host/processes.mjs';
import {
  INTERFACE_LOCALES,
  LANGUAGE_DEFAULTS,
  LANGUAGE_PACKS,
  validateLanguages,
} from '../../../apps/desktop/renderer/language-settings.mjs';
import { apiSettings } from '../../../apps/desktop/inference-api.mjs';
import { requireCapriAvatar } from '../../../apps/desktop/avatar-catalog.mjs';
import installerManifest from '../../../config/installer.json' with { type: 'json' };
import modelSizes from '../../../config/qwen-download-sizes.json' with { type: 'json' };

export const MACOS_SETUP_STAGES = Object.freeze(['configuration', 'models', 'verify', 'finalize']);
const STAGE_WEIGHTS = Object.freeze({
  configuration: 0.04,
  models: 0.86,
  components: 0.04,
  verify: 0.03,
  finalize: 0.03,
});
export const SETUP_RECEIPT = '.runtime/macos/setup.json';
/**
 * The app keeps its own local service ports, 100 above the defaults, so it can
 * run next to a source checkout that uses the defaults.
 */
export const MACOS_PORT_OFFSET = 100;
const GiB = 2 ** 30;
const EMBEDDING_MODEL = 'bge-m3:latest';

/**
 * Optional components offered by first-run setup (for example speech
 * recognition or a voice once they run on macOS). Each entry:
 *   { id, label, description, downloadBytes,
 *     available({ hardware, root }) -> true | 'reason it is unavailable',
 *     install({ root, env, node, command, emit, signal }) -> Promise }
 * Components install after the models and before verification. The list is
 * empty until a macOS implementation exists.
 */
export const MACOS_SETUP_COMPONENTS = [];

function availability(component, context) {
  try {
    const result = component.available?.(context) ?? true;
    return result === true ? { available: true } : { available: false, reason: String(result) };
  } catch (error) {
    return { available: false, reason: error.message };
  }
}

/** Best-effort match of the Mac's preferred language to a supported one. */
export function matchLanguage(preferred, supported, fallback = 'en') {
  const ids = new Set(supported);
  for (const tag of preferred ?? []) {
    if (typeof tag !== 'string') continue;
    const normalized = tag.replace('_', '-');
    if (ids.has(normalized)) return normalized;
    const [language, region] = normalized.split('-');
    if (region && ids.has(`${language}-${region.toUpperCase()}`))
      return `${language}-${region.toUpperCase()}`;
    if (ids.has(language)) return language;
  }
  return fallback;
}

function readText(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

export function modelDownloadBytes(model) {
  if (model === EMBEDDING_MODEL) return installerManifest.storage.embeddingBytes;
  return modelSizes.models[model] ?? null;
}

/**
 * Only the model downloads remain on macOS; the app already holds every
 * runtime. A model imported from Hugging Face earlier is already on disk.
 */
export function macosStorageEstimate({ downloadModels, installedModel, profile, components = [] }) {
  let downloadBytes = installerManifest.storage.embeddingBytes;
  if (downloadModels && !installedModel) {
    const choice = MODEL_CHOICES.find((item) => item.id === profile);
    if (!choice) throw new Error('Unknown language model.');
    downloadBytes += modelDownloadBytes(choice.model) ?? 0;
  }
  for (const component of components) downloadBytes += component.downloadBytes ?? 0;
  return { downloadBytes, requiredBytes: downloadBytes + GiB };
}

export async function macosSetupOptions({
  root,
  version,
  preferredLanguages = [],
  hardware,
  free = diskFree,
} = {}) {
  hardware ??= await probeHardware();
  const recommendation = recommendProfile(hardware);
  const gpu = hardware.gpus?.find((item) => item.memoryKind === 'unified') ?? hardware.gpus?.[0];
  const interfaceIds = INTERFACE_LOCALES.map((item) => item.id);
  const conversationIds = LANGUAGE_PACKS.map((item) => item.id);
  return {
    schemaVersion: 1,
    version,
    dataFolder: root,
    freeBytes: free(root),
    hardware: {
      chip: typeof hardware.cpu === 'string' ? hardware.cpu : null,
      ramBytes: hardware.ramBytes,
      gpu: gpu?.name ?? null,
      gpuMemoryBytes: Number.isFinite(gpu?.vramMiB) ? gpu.vramMiB * 2 ** 20 : null,
      unifiedMemory: gpu?.memoryKind === 'unified',
      warnings: hardware.warnings ?? [],
    },
    supported: recommendation.supported,
    reasons: recommendation.reasons ?? [],
    recommended: recommendation.profile?.id ?? null,
    embeddingBytes: installerManifest.storage.embeddingBytes,
    models: MODEL_CHOICES.map((choice) => {
      let reason = null;
      try {
        selectModelChoice(choice.id, hardware);
      } catch (error) {
        reason = error.message;
      }
      return {
        id: choice.id,
        family: choice.family,
        model: choice.model,
        ramGiB: choice.ramGiB,
        experimental: Boolean(choice.experimental),
        description: choice.description ?? '',
        downloadBytes: modelDownloadBytes(choice.model),
        recommended: choice.id === recommendation.profile?.id,
        available: !reason,
        reason,
      };
    }),
    components: MACOS_SETUP_COMPONENTS.map((component) => ({
      id: component.id,
      label: component.label,
      description: component.description ?? '',
      downloadBytes: component.downloadBytes ?? 0,
      ...availability(component, { hardware, root }),
    })),
    interfaceLanguages: INTERFACE_LOCALES.map(({ id, name, nativeName }) => ({
      id,
      name: nativeName || name || id,
    })),
    conversationLanguages: LANGUAGE_PACKS.map(({ id, name, label }) => ({
      id,
      name: label || name || id,
    })),
    defaults: {
      interface: matchLanguage(preferredLanguages, interfaceIds),
      conversation: matchLanguage(preferredLanguages, conversationIds),
    },
    license: readText(path.join(root, 'LICENSE')),
  };
}

/** Turns the wizard's answers into the Windows installer's validated request shape. */
export function macosRequest(input, root) {
  if (!input || typeof input !== 'object' || input.schemaVersion !== 1)
    throw new Error('Invalid setup request.');
  const inferenceMode = input.inferenceMode === 'api' ? 'api' : 'local';
  if (input.inferenceMode !== inferenceMode) throw new Error('Invalid language model source.');
  const modelSource = input.modelSource ?? 'catalog';
  if (!['catalog', 'huggingface'].includes(modelSource))
    throw new Error('Invalid language model catalog.');
  const components = input.components ?? [];
  if (
    !Array.isArray(components) ||
    components.some((id) => !MACOS_SETUP_COMPONENTS.some((item) => item.id === id)) ||
    new Set(components).size !== components.length
  )
    throw new Error('Invalid optional component.');
  return {
    schemaVersion: 1,
    target: root,
    acceptLicense: input.acceptLicense === true,
    acceptDownloads: input.acceptDownloads === true,
    inferenceMode,
    modelSource,
    profile: typeof input.profile === 'string' ? input.profile : undefined,
    interfaceLanguage: input.interfaceLanguage,
    conversationLanguage: input.conversationLanguage,
    recognition: false,
    downloadModels: true,
    desktopShortcut: false,
    startMenuShortcut: false,
    voiceMode: 'off',
    voicePack: '',
    components,
  };
}

const INHERITED = [
  'OPENCLAW_STATE_DIR',
  'OPENCLAW_CONFIG_PATH',
  'OPENCLAW_HOME',
  'OPENCLAW_GATEWAY_TOKEN',
  'OPENCLAW_WORKSPACE_DIR',
  'CAPRI_PROJECT_ROOT',
  'CAPRI_LLAMA_PATH',
  'CAPRI_DESKTOP_VERIFICATION_DIR',
  'ELECTRON_RUN_AS_NODE',
  'NODE_OPTIONS',
  'NODE_PATH',
  'PYTHONPATH',
];

/** Progress across the selected stages; it never moves backwards. */
export function progressTracker(stages, emit) {
  const weights = stages.map((id) =>
    id.startsWith('component:') ? STAGE_WEIGHTS.components : (STAGE_WEIGHTS[id] ?? 0.03),
  );
  const total = weights.reduce((sum, value) => sum + value, 0);
  let reported = 0;
  return (stage, fraction) => {
    const index = stages.indexOf(stage);
    if (index < 0) return;
    const before = weights.slice(0, index).reduce((sum, value) => sum + value, 0);
    const value = Math.min(
      1,
      (before + weights[index] * Math.max(0, Math.min(1, fraction))) / total,
    );
    if (value <= reported) return;
    reported = value;
    emit({ type: 'progress', fraction: value });
  };
}

/** Byte-weighted progress of `capri.mjs models`, which prints one line per model. */
export function modelProgress(models, update) {
  const sizes = models.map((name) => modelDownloadBytes(name) ?? GiB);
  const total = sizes.reduce((sum, value) => sum + value, 0);
  let current = -1;
  return (line) => {
    const preparing = /^Preparing (\S+)\.\.\.$/.exec(line);
    if (preparing) {
      const index = models.indexOf(preparing[1]);
      if (index >= 0) current = index;
      update(current < 0 ? 0 : sizes.slice(0, current).reduce((a, b) => a + b, 0) / total);
      return null;
    }
    if (!line.startsWith('{"capriFileTransfer"')) return null;
    let transfer;
    try {
      transfer = JSON.parse(line);
    } catch {
      return null;
    }
    const { capriFileTransfer: file, received, total: bytes, stageFraction } = transfer;
    if (
      typeof file !== 'string' ||
      !/^[\w.+-]{1,160}$/.test(file) ||
      !Number.isSafeInteger(received) ||
      !Number.isSafeInteger(bytes) ||
      bytes <= 0 ||
      received < 0 ||
      received > bytes
    )
      return null;
    if (current >= 0 && Number.isFinite(stageFraction))
      update(
        (sizes.slice(0, current).reduce((a, b) => a + b, 0) +
          sizes[current] * Math.max(0, Math.min(1, stageFraction))) /
          total,
      );
    return { file, received, total: bytes };
  };
}

export function saveFirstLaunchChoice(root, preloadModels) {
  const file = path.join(root, 'data/desktop/first-start.json');
  noLinks(file);
  writeJsonAtomic(file, { schemaVersion: 1, preloadModels: Boolean(preloadModels) });
}

export function readSetupReceipt(root) {
  try {
    const receipt = readJson(path.join(root, SETUP_RECEIPT));
    return receipt?.schemaVersion === 1 ? receipt : null;
  } catch {
    return null;
  }
}

export async function runMacosSetup(
  input,
  {
    root,
    sourceRoot,
    version,
    emit = () => {},
    signal,
    hardware,
    execute = runCommand,
    free = diskFree,
    nodeExecutable,
    isRunning = (name) => Boolean(managedProcess(name)),
    findPort = findFreePort,
    checkArtwork = requireCapriAvatar,
    now = () => new Date(),
  },
) {
  hardware ??= await probeHardware();
  const request = macosRequest(input, root);
  const plan = validateRequest(request, { sourceRoot, version, hardware });
  const components = request.components.map((id) =>
    MACOS_SETUP_COMPONENTS.find((item) => item.id === id),
  );
  for (const component of components) {
    const state = availability(component, { hardware, root });
    if (!state.available) throw new Error(`${component.label}: ${state.reason}`);
  }
  const estimate = macosStorageEstimate({ ...plan, components });
  assertDiskSpace(root, free(root), estimate.requiredBytes);
  if (isRunning('desktop'))
    throw Object.assign(new Error('Quit Capri before running setup again.'), {
      code: 'CAPRI_INSTALL_RUNNING',
    });
  const core = JSON.parse(readFileSync(path.join(root, 'config/core.json'), 'utf8'));
  const node = nodeExecutable ?? bundledNode(path.join(root, '.runtime'), core.nodeVersion);
  if (!existsSync(node))
    throw new Error('The bundled Node.js runtime is missing. Reinstall Capri.');
  for (const name of [
    'config',
    'data/desktop',
    'data/openclaw',
    'data/models',
    '.runtime/installer',
  ])
    noLinks(path.join(root, name));
  const env = {
    ...process.env,
    CAPRI_NODE_PATH: node,
    CAPRI_INSTALL_FILE_PROGRESS: '1',
    PATH: [path.dirname(node), process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin'].join(':'),
  };
  for (const name of INHERITED) delete env[name];
  const stages = [
    ...MACOS_SETUP_STAGES.slice(0, 2),
    ...components.map((component) => 'component:' + component.id),
    ...MACOS_SETUP_STAGES.slice(2),
  ];
  const progress = progressTracker(stages, emit);
  let currentStage = '';
  const command = (file, args, { output, timeoutMs = 60 * 60 * 1000 } = {}) =>
    execute(file, args, {
      cwd: root,
      env,
      signal,
      timeoutMs,
      output: (line) => {
        if (output?.(line) === false) return;
        emit({ type: 'log', step: currentStage, message: line });
      },
    });
  const runNode = (file, args = [], options) =>
    command(node, [path.join(root, file), ...args], options);
  const cli = 'packages/runtime/bin/capri.mjs';
  async function step(id, task) {
    signal?.throwIfAborted();
    currentStage = id;
    emit({ type: 'stage', step: id });
    progress(id, 0);
    await task();
    signal?.throwIfAborted();
    progress(id, 1);
    emit({ type: 'stage-complete', step: id });
  }
  mkdirSync(path.join(root, '.runtime/installer'), { recursive: true });
  const releaseLock = installationLock(path.join(root, '.runtime/installer'));
  let restoreModelSelection = null;
  emit({ type: 'stage-plan', stages, downloadBytes: estimate.downloadBytes });
  try {
    // Services left by an interrupted earlier attempt hold ports and model files.
    await runNode('packages/runtime/bin/core.mjs', ['stop'], { timeoutMs: 120000 }).catch(() => {});
    await step('configuration', async () => {
      const local = path.join(root, 'config/core.local.json');
      if (!existsSync(local)) {
        const reserved = new Set();
        writeJsonAtomic(local, {
          gatewayPort: await findPort(core.gatewayPort + MACOS_PORT_OFFSET, reserved),
          ollamaPort: await findPort(core.ollamaPort + MACOS_PORT_OFFSET, reserved),
        });
        await runNode(cli, ['setup', '--profile=' + plan.profile, '--yes', '--replace']);
        const voiceFile = path.join(root, 'config/companion-voice.json');
        const voice = readJson(voiceFile);
        voice.port = await findPort(voice.port + MACOS_PORT_OFFSET, reserved);
        writeJsonAtomic(voiceFile, voice);
      }
      if (plan.inferenceMode === 'local' && !plan.modelSetupRequired)
        restoreModelSelection = applyInstallerModelSelection({ root, plan, hardware });
    });
    await step('models', async () => {
      // Memory retrieval always needs its small embedding model, even when the
      // user defers the text model or chooses an external provider.
      const args = [
        'models',
        ...(!plan.downloadModels || plan.installedModel ? ['--embedding-only'] : []),
        ...(plan.installedModel && plan.inferenceMode !== 'api' ? ['--repair-selected'] : []),
      ];
      let preview = null;
      await runNode(cli, [...args, '--plan'], {
        timeoutMs: 120000,
        output: (line) => {
          if (!line.startsWith('{')) return;
          try {
            preview = JSON.parse(line);
          } catch {
            return;
          }
          return false;
        },
      });
      if (!Array.isArray(preview?.models)) throw new Error('Capri could not plan the downloads.');
      emit({ type: 'models', models: preview.models });
      const track = modelProgress(preview.models, (fraction) => progress('models', fraction));
      await runNode(cli, args, {
        timeoutMs: 8 * 60 * 60 * 1000,
        output: (line) => {
          const transfer = track(line);
          if (!transfer) return;
          emit({ type: 'download', step: 'models', ...transfer });
          return false;
        },
      });
    });
    for (const component of components)
      await step('component:' + component.id, () =>
        component.install({ root, env, node, command, emit, signal, hardware }),
      );
    await step('verify', async () => {
      checkArtwork(root);
      await runNode(cli, ['doctor'], { timeoutMs: 120000 });
      const inventory = readJson(path.join(root, 'data/model-inventory.json'), 2 * 1024 ** 2);
      const models = inventory.models ?? [];
      const local = readJson(path.join(root, 'config/core.local.json'));
      for (const model of [
        ...(plan.downloadModels ? [local.model ?? core.model] : []),
        local.embeddingModel ?? core.embeddingModel,
      ])
        if (!models.some((item) => item.name === model))
          throw new Error('A required model is not ready: ' + model);
    });
    await step('finalize', async () => {
      const languageFile = path.join(root, 'data/desktop/languages.json');
      noLinks(languageFile);
      const saved = existsSync(languageFile) ? readJson(languageFile) : null;
      const previous = saved?.schemaVersion === 1 ? saved.settings : null;
      const languages = validateLanguages({
        ...LANGUAGE_DEFAULTS,
        ...(previous ?? plan.languages),
        interface: plan.languages.interface,
        conversation: plan.languages.conversation,
        customConversation: plan.languages.customConversation,
      });
      writeJsonAtomic(languageFile, { schemaVersion: 1, settings: languages });
      const inferenceFile = path.join(root, 'data/desktop/inference-api.json');
      noLinks(inferenceFile);
      let savedInference;
      if (existsSync(inferenceFile))
        try {
          savedInference = apiSettings(readJson(inferenceFile, 8192));
        } catch {
          if (plan.inferenceMode === 'api')
            throw new Error(
              'Existing API settings are unreadable. Repair them in Capri before selecting API mode.',
            );
        }
      // API mode only asks for the provider on first launch; no key is collected here.
      if (plan.inferenceMode === 'api' && !savedInference?.enabled)
        writeJsonAtomic(inferenceFile, { ...savedInference, setupRequired: true });
      else if (
        plan.inferenceMode === 'local' &&
        (savedInference?.enabled || savedInference?.setupRequired)
      )
        writeJsonAtomic(inferenceFile, { ...savedInference, enabled: false, setupRequired: false });
      const localFile = path.join(root, 'config/core.local.json');
      writeJsonAtomic(localFile, {
        ...readJson(localFile),
        modelSetupRequired: plan.modelSetupRequired,
      });
      saveFirstLaunchChoice(root, plan.inferenceMode === 'local' && !plan.modelSetupRequired);
      writeJsonAtomic(path.join(root, SETUP_RECEIPT), {
        schemaVersion: 1,
        status: 'complete',
        version,
        profile: plan.profile,
        inferenceMode: plan.inferenceMode,
        modelSource: plan.modelSource,
        components: request.components,
        completedAt: now().toISOString(),
      });
    });
    emit({
      type: 'complete',
      inferenceMode: plan.inferenceMode,
      modelSetupRequired: plan.modelSetupRequired,
      modelsReady: plan.downloadModels,
    });
    return { plan, stages };
  } catch (error) {
    // A failed or cancelled download must leave a previously working model selected.
    restoreModelSelection?.();
    emit({
      type: signal?.aborted ? 'cancelled' : 'failed',
      step: currentStage,
      message: String(error.message).slice(0, 2500),
    });
    throw error;
  } finally {
    await runNode('packages/runtime/bin/core.mjs', ['stop'], { timeoutMs: 120000 }).catch(() => {});
    releaseLock();
  }
}
