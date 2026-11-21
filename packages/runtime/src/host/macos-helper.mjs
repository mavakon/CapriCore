// SPDX-License-Identifier: GPL-3.0-only
/**
 * Capri's macOS helper: one Swift binary (packages/macos-helpers) that replaces
 * the Windows C# and PowerShell helpers, one subcommand each. It is built from
 * source with the Xcode command line tools into .runtime/macos-helpers, with a
 * receipt that ties the executable to the exact sources (as the Windows helpers'
 * build.json does). Callers use only a receipt-verified executable.
 */
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { chmod, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

export const MACOS_HELPER_SOURCES = 'packages/macos-helpers/Sources';
export const MACOS_HELPER_DIRECTORY = '.runtime/macos-helpers';
export const MACOS_HELPER_NAME = 'capri-macos-helper';
export const MACOS_HELPER_MINIMUM_SYSTEM = '14.0';
export const MACOS_HELPER_IDENTIFIER = 'com.capri.macos-helper';
const artifactPattern = /^[a-f0-9]{16}\/capri-macos-helper$/;
const sha256Pattern = /^[a-f0-9]{64}$/;
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

export const MACOS_HELPER_MISSING =
  'Capri’s macOS helper is not built yet. Run npm run setup:macos-helpers (needs the Xcode command line tools: xcode-select --install).';
export const MACOS_HELPER_STALE =
  'Capri’s macOS helper is out of date. Run npm run setup:macos-helpers to rebuild it.';

function unavailable(message) {
  return Object.assign(new Error(message), { code: 'CAPRI_MACOS_HELPER_UNAVAILABLE' });
}

/** The Swift sources in a fixed order. */
export function macosHelperSources(root) {
  const folder = path.join(root, MACOS_HELPER_SOURCES);
  const files = readdirSync(folder)
    .filter((name) => /^[A-Za-z][A-Za-z0-9]*\.swift$/.test(name))
    .sort();
  if (!files.length) throw new Error('The macOS helper sources are missing.');
  return files.map((name) => path.join(folder, name));
}

/** One digest over every source file name and content. */
export function macosHelperSourceHash(root) {
  const hash = createHash('sha256');
  for (const file of macosHelperSources(root)) {
    const bytes = readFileSync(file);
    hash.update(path.basename(file) + '\0' + bytes.length + '\0');
    hash.update(bytes);
  }
  return hash.digest('hex');
}

/**
 * The verified helper executable. A source checkout must match the receipt's
 * source digest; the executable must always match its own digest.
 */
export function macosHelperExecutable(root, { platform = process.platform } = {}) {
  if (platform !== 'darwin') throw new Error('The Capri macOS helper runs only on macOS.');
  const directory = path.join(root, MACOS_HELPER_DIRECTORY);
  let build;
  try {
    const bytes = readFileSync(path.join(directory, 'build.json'));
    if (bytes.length > 4096) throw new Error();
    build = JSON.parse(bytes);
  } catch {
    throw unavailable(MACOS_HELPER_MISSING);
  }
  if (
    build?.schemaVersion !== 1 ||
    !artifactPattern.test(build.artifact ?? '') ||
    !sha256Pattern.test(build.sourceSha256 ?? '') ||
    !sha256Pattern.test(build.executableSha256 ?? '')
  )
    throw unavailable(MACOS_HELPER_STALE);
  if (
    existsSync(path.join(root, MACOS_HELPER_SOURCES)) &&
    build.sourceSha256 !== macosHelperSourceHash(root)
  )
    throw unavailable(MACOS_HELPER_STALE);
  const executable = path.join(directory, build.artifact);
  let bytes;
  try {
    bytes = readFileSync(executable);
  } catch {
    throw unavailable(MACOS_HELPER_MISSING);
  }
  if (sha256(bytes) !== build.executableSha256)
    throw new Error('Capri macOS helper integrity check failed');
  return executable;
}

/** True when a verified helper is present (never throws). */
export function macosHelperReady(root, options) {
  try {
    macosHelperExecutable(root, options);
    return true;
  } catch {
    return false;
  }
}

/**
 * The fixed, minimal environment every helper runs with. Nothing from Capri's
 * own environment (keys, tokens, proxies) reaches a helper.
 */
export function macosHelperEnvironment(root, { home = os.homedir() } = {}) {
  return {
    HOME: home,
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    TMPDIR: path.join(root, '.runtime/tmp') + '/',
    LANG: 'en_US.UTF-8',
  };
}

export function macosHelperTarget(arch = process.arch) {
  if (!['arm64', 'x64'].includes(arch)) throw new Error('Unsupported Mac processor: ' + arch);
  return `${arch === 'x64' ? 'x86_64' : 'arm64'}-apple-macos${MACOS_HELPER_MINIMUM_SYSTEM}`;
}

/** Compiles the helper and writes its receipt last, so a partial build is never used. */
export async function buildMacosHelper(
  root,
  {
    run = promisify(execFile),
    arch = process.arch,
    log = () => {},
    force = false,
    platform = process.platform,
  } = {},
) {
  if (platform !== 'darwin') throw new Error('The Capri macOS helper builds only on macOS.');
  if (!force && macosHelperReady(root, { platform }))
    return macosHelperExecutable(root, { platform });
  const sourceSha256 = macosHelperSourceHash(root);
  const files = macosHelperSources(root);
  let swiftc;
  try {
    ({ stdout: swiftc } = await run('/usr/bin/xcrun', ['--find', 'swiftc'], {
      timeout: 60000,
      maxBuffer: 65536,
    }));
    swiftc = swiftc.trim();
    if (!path.isAbsolute(swiftc)) throw new Error();
  } catch {
    throw unavailable(
      'The Swift compiler was not found. Install the Xcode command line tools (xcode-select --install), then run npm run setup:macos-helpers again.',
    );
  }
  const directory = path.join(root, MACOS_HELPER_DIRECTORY);
  const folder = sourceSha256.slice(0, 16);
  const final = path.join(directory, folder, MACOS_HELPER_NAME);
  const temporary = path.join(directory, folder, `.${randomUUID()}.partial`);
  await mkdir(path.dirname(final), { recursive: true });
  try {
    log(`compiling ${files.length} Swift files for ${macosHelperTarget(arch)}.`);
    await run(
      swiftc,
      [
        '-O',
        '-swift-version',
        '5',
        '-module-name',
        'Capri',
        '-target',
        macosHelperTarget(arch),
        '-o',
        temporary,
        ...files,
      ],
      { cwd: root, timeout: 900000, maxBuffer: 8 * 1024 * 1024 },
    );
    // An explicit ad-hoc signature with a stable identifier (Apple silicon runs
    // only signed code; the linker's signature has a generated identifier).
    await run(
      '/usr/bin/codesign',
      ['--force', '--sign', '-', '--identifier', MACOS_HELPER_IDENTIFIER, temporary],
      { timeout: 60000, maxBuffer: 65536 },
    );
    await chmod(temporary, 0o755);
    await rename(temporary, final);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  const executableSha256 = sha256(readFileSync(final));
  const receipt = path.join(directory, `.build-${randomUUID()}.json`);
  await writeFile(
    receipt,
    JSON.stringify({
      schemaVersion: 1,
      sourceSha256,
      artifact: `${folder}/${MACOS_HELPER_NAME}`,
      executableSha256,
      target: macosHelperTarget(arch),
    }) + '\n',
  );
  await rename(receipt, path.join(directory, 'build.json'));
  // Earlier builds are unused once the receipt names this one.
  for (const entry of await readdir(directory, { withFileTypes: true }))
    if (entry.isDirectory() && /^[a-f0-9]{16}$/.test(entry.name) && entry.name !== folder)
      await rm(path.join(directory, entry.name), { recursive: true, force: true });
  return final;
}

let building = null;
/** Builds a missing or stale helper once per process, in the background. */
export function ensureMacosHelper(root, options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== 'darwin') return Promise.resolve(null);
  if (macosHelperReady(root, { platform }))
    return Promise.resolve(macosHelperExecutable(root, { platform }));
  if (!existsSync(path.join(root, MACOS_HELPER_SOURCES)))
    return Promise.reject(unavailable(MACOS_HELPER_MISSING));
  building ??= buildMacosHelper(root, { ...options, platform }).finally(() => {
    building = null;
  });
  return building;
}
