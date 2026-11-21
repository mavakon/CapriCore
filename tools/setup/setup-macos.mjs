#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only
/**
 * Prepares a source checkout to run the Capri desktop on macOS (Apple silicon):
 * downloads the pinned llama.cpp Metal build, verifies it and installs the files
 * llama-server needs into .runtime. Safe to re-run; a verified bundle is kept.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempDisposableSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import {
  LLAMA_MACOS_FILES,
  llamaBundleReady,
} from '../../packages/runtime/src/host/llama-bundle.mjs';
import {
  bundledLlamaServer,
  llamaBundleDirectory,
} from '../../packages/runtime/src/host/platform.mjs';
import { electronBundleReady } from '../../packages/runtime/src/host/electron-bundle.mjs';

const root = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const spec = JSON.parse(readFileSync(path.join(root, 'config/macos-runtime.json'), 'utf8')).llama;
const core = JSON.parse(readFileSync(path.join(root, 'config/core.json'), 'utf8'));
const log = (message) => console.log('Capri setup: ' + message);

export function verifyHost({
  platform = process.platform,
  arch = process.arch,
  node = process.versions.node,
} = {}) {
  if (platform !== 'darwin' || arch !== 'arm64')
    throw new Error('This setup is for macOS on Apple silicon (arm64).');
  if (Number(node.split('.')[0]) !== 24)
    throw new Error(
      `Capri needs Node.js 24 (found ${node}). Install Node 24 and run npm ci again.`,
    );
}

async function sha256(file) {
  const hash = createHash('sha256');
  const { createReadStream } = await import('node:fs');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function download(url, target, expected) {
  if (existsSync(target) && (await sha256(target)) === expected) return target;
  mkdirSync(path.dirname(target), { recursive: true });
  const partial = target + '.partial';
  log(`downloading ${url}`);
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(600000) });
  if (!response.ok || !response.body) throw new Error(`Download failed (HTTP ${response.status}).`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
  const actual = await sha256(partial);
  if (actual !== expected) {
    rmSync(partial, { force: true });
    throw new Error(`Downloaded llama.cpp does not match its pinned SHA-256 (got ${actual}).`);
  }
  renameSync(partial, target);
  return target;
}

/** Copies each runtime file by its install name, resolving links inside the archive only. */
export function materializeLlama(extracted, destination, files = LLAMA_MACOS_FILES) {
  const source = realpathSync(extracted);
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  for (const name of files) {
    const real = realpathSync(path.join(source, name));
    if (path.dirname(real) !== source)
      throw new Error(`${name} points outside the llama.cpp archive.`);
    if (!lstatSync(real).isFile()) throw new Error(`${name} is not a file.`);
    copyFileSync(real, path.join(destination, name));
    chmodSync(path.join(destination, name), 0o755);
  }
}

export async function setupMacos() {
  verifyHost();
  if (core.llamaVersion !== spec.version)
    throw new Error(
      'config/macos-runtime.json and config/core.json pin different llama.cpp versions.',
    );
  const cache = path.join(root, '.runtime');
  const executable = bundledLlamaServer(cache, spec.version);
  if (llamaBundleReady(executable)) log('llama.cpp (Metal) is already installed.');
  else {
    const archive = await download(
      spec.url,
      path.join(root, '.downloads', path.basename(new URL(spec.url).pathname)),
      spec.sha256,
    );
    mkdirSync(cache, { recursive: true });
    using scratch = mkdtempDisposableSync(path.join(cache, 'llama-extract-'));
    execFileSync('/usr/bin/tar', ['-xzf', archive, '-C', scratch.path], { stdio: 'inherit' });
    const staged = path.join(cache, llamaBundleDirectory(spec.version) + '.staged');
    materializeLlama(path.join(scratch.path, spec.archiveRoot), staged);
    // Files fetched by Node carry no quarantine flag; clear one a browser copy may add.
    try {
      execFileSync('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', staged], { stdio: 'ignore' });
    } catch {
      /* Nothing to clear. */
    }
    const final = path.dirname(executable);
    rmSync(final, { recursive: true, force: true });
    renameSync(staged, final);
    if (!llamaBundleReady(executable)) throw new Error('The llama.cpp runtime is incomplete.');
    log(`installed llama.cpp ${spec.version} (Metal) in ${path.relative(root, final)}.`);
  }
  try {
    const devices = execFileSync(executable, ['--list-devices'], {
      encoding: 'utf8',
      timeout: 15000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const metal = devices
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^MTL\d/.test(line));
    log(
      metal.length
        ? `Metal device: ${metal.join('; ')}`
        : 'no Metal device reported; text runs on the CPU.',
    );
  } catch (error) {
    throw new Error(`llama-server could not start: ${error.stderr || error.message}`);
  }
  const electron = path.join(root, 'node_modules/electron');
  if (!existsSync(path.join(electron, 'install.js')))
    log('Electron is missing. Run npm ci in this folder before npm run desktop.');
  else if (!electronBundleReady(electron)) {
    // Electron 45 fetches its app bundle lazily instead of in postinstall.
    // Keep the download cache inside the installation, not ~/Library/Caches.
    log('downloading Electron for macOS.');
    execFileSync(process.execPath, [path.join(electron, 'install.js')], {
      cwd: root,
      stdio: 'inherit',
      env: { ...process.env, electron_config_cache: path.join(cache, 'electron-cache') },
    });
    if (!electronBundleReady(electron)) throw new Error('The Electron download is incomplete.');
    log('Electron is ready.');
  } else log('Electron is ready.');
  if (!existsSync(path.join(root, 'config/core.local.json')))
    log('next: npm run setup, then npm run models:pull, then npm run desktop.');
  else log('next: npm run models:pull (if not done), then npm run desktop.');
  return { executable, size: statSync(executable).size };
}

if (import.meta.main)
  await setupMacos().catch((error) => {
    console.error('Capri setup: ' + error.message);
    process.exitCode = 1;
  });
