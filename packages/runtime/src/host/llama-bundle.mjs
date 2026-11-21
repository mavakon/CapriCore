// SPDX-License-Identifier: GPL-3.0-only
import path from 'node:path';
import {
  copyFileSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempDisposableSync,
  readdirSync,
} from 'node:fs';
import { noLinks } from '../huggingface/artifacts.mjs';
import { isMac } from './platform.mjs';

export const LLAMA_VULKAN_FILES = Object.freeze([
  'llama-server.exe',
  'llama-server-impl.dll',
  'llama-common.dll',
  'llama.dll',
  'mtmd.dll',
  'ggml.dll',
  'ggml-base.dll',
  'ggml-cpu-x64.dll',
  'ggml-vulkan.dll',
  'libomp.dll',
]);

/**
 * The macOS arm64 release links its libraries through @rpath (the executable
 * folder), so Metal and Accelerate support ship as ordinary dylibs. The archive
 * stores the versioned names behind symbolic links; setup materializes each
 * install name as a regular file because Capri refuses linked runtime files.
 */
export const LLAMA_MACOS_FILES = Object.freeze([
  'llama-server',
  'libllama-server-impl.dylib',
  'libllama-common.0.dylib',
  'libllama.0.dylib',
  'libmtmd.0.dylib',
  'libggml.0.dylib',
  'libggml-base.0.dylib',
  'libggml-cpu.0.dylib',
  'libggml-blas.0.dylib',
  'libggml-metal.0.dylib',
  'libggml-rpc.0.dylib',
]);

export const llamaBundleFiles = (platform = process.platform) =>
  isMac(platform) ? LLAMA_MACOS_FILES : LLAMA_VULKAN_FILES;

export function llamaBundleReady(executable, platform = process.platform) {
  return llamaBundleFiles(platform).every((name) => {
    try {
      const info = lstatSync(noLinks(path.join(path.dirname(executable), name)));
      return info.isFile() && info.size > 0;
    } catch {
      return false;
    }
  });
}

/** llama.cpp scans its executable directory and working directory for plugins. */
export function createLlamaRuntimeView(executable, scratch, { allowGpu, baseline }) {
  const source = path.dirname(executable);
  const files = LLAMA_VULKAN_FILES.filter((name) => allowGpu || name !== 'ggml-vulkan.dll');
  if (!baseline)
    files.push(
      ...readdirSync(source).filter((name) =>
        /^ggml-cpu-(?!x64\.dll$)[a-z0-9-]+\.dll$/i.test(name),
      ),
    );
  noLinks(scratch);
  mkdirSync(scratch, { recursive: true });
  const view = mkdtempDisposableSync(path.join(scratch, 'worker-'));
  try {
    for (const name of files) {
      const file = noLinks(path.join(source, name));
      if (!lstatSync(file).isFile()) throw new Error('Local engine library is missing.');
      const target = path.join(view.path, name);
      try {
        linkSync(file, target);
      } catch (error) {
        if (!['EXDEV', 'EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error;
        copyFileSync(file, target);
      }
    }
    return { executable: path.join(view.path, 'llama-server.exe'), remove: view.remove };
  } catch (error) {
    view.remove();
    throw error;
  }
}
