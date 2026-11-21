#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only
/**
 * Builds Capri.app and its disk image on a Mac with Apple silicon:
 *
 *   npm run release:macos
 *
 * The app is the pinned Electron for macOS, renamed and re-identified as
 * Capri, with the launcher in Contents/Resources/app and a payload in
 * Contents/Resources/capri: the release source files, production npm
 * dependencies installed with the bundled Node.js, and the pinned Node.js and
 * llama.cpp (Metal) runtimes. Every download is checked against the SHA-256 in
 * config/macos-runtime.json. The app is signed ad hoc (no Apple Developer ID),
 * which is enough to run it on the Mac that built it.
 *
 * Output: release/macos/Capri-<version>-macos-arm64.dmg, a .sha256 file next
 * to it, and release/macos/work/Capri.app.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceFiles, validateSource } from './source-export.mjs';
import {
  BUILD_FILE,
  LAUNCHER_FILES,
  MANIFEST_FILE,
  SETUP_ARTWORK,
  buildSummary,
  bundleVersions,
  helperPlan,
  iconsetEntries,
  infoPlistChanges,
  payloadManifest,
  shippedDependency,
  shippedSourceFile,
} from './macos-bundle.mjs';
import { download, materializeLlama, sha256 } from '../setup/setup-macos.mjs';
import { PAYLOAD_FOLDER } from '../../apps/macos-launcher/install-root.mjs';
import { releaseAssetName } from '../../packages/updater/src/releases.mjs';
import {
  bundledLlamaServer,
  bundledNode,
  llamaBundleDirectory,
} from '../../packages/runtime/src/host/platform.mjs';
import { llamaBundleReady } from '../../packages/runtime/src/host/llama-bundle.mjs';
import { buildHelpers } from './macos-helpers.mjs';

const root = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const read = (file) => JSON.parse(readFileSync(path.join(root, file), 'utf8'));
const runtimes = read('config/macos-runtime.json');
const core = read('config/core.json');
const release = read('config/release.json');
const log = (message) => console.log('Capri build: ' + message);

function run(file, args, options = {}) {
  const result = spawnSync(file, args, { stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${path.basename(file)} ${args[0] ?? ''} failed (exit ${result.status}).`);
}
const output = (file, args, options = {}) =>
  execFileSync(file, args, { encoding: 'utf8', ...options }).trim();

function checkHost() {
  if (process.platform !== 'darwin' || process.arch !== 'arm64')
    throw new Error('Build Capri.app on a Mac with Apple silicon.');
  if (runtimes.node.version !== core.nodeVersion || runtimes.llama.version !== core.llamaVersion)
    throw new Error('config/macos-runtime.json and config/core.json pin different runtimes.');
  const electron = read('package.json').devDependencies?.electron;
  if (electron !== runtimes.electron.version)
    throw new Error(
      `package.json pins Electron ${electron}, config/macos-runtime.json ${runtimes.electron.version}.`,
    );
}

function sourceCommit() {
  if (!existsSync(path.join(root, '.git'))) return { commit: null, dirty: null };
  const commit = output('/usr/bin/git', ['-C', root, 'rev-parse', 'HEAD']);
  const dirty = output('/usr/bin/git', ['-C', root, 'status', '--porcelain']).length > 0;
  return { commit, dirty };
}

/** Release source files, with the same privacy and completeness checks as the source export. */
function copySource(payload) {
  const files = sourceFiles(root);
  validateSource(files);
  const shipped = files.filter(shippedSourceFile);
  // validateSource looks for Windows profile paths; also refuse this Mac's own.
  const home = `/Users/${os.userInfo().username}/`;
  for (const name of files)
    if (/\.(?:mjs|js|cjs|py|json|md|toml|ya?ml|txt|sh|html|css)$/.test(name))
      if (readFileSync(path.join(root, name), 'utf8').includes(home))
        throw new Error(`${name} contains a path in this Mac's home folder.`);
  for (const name of shipped) {
    const target = path.join(payload, name);
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(path.join(root, name), target);
    chmodSync(target, lstatSync(path.join(root, name)).mode & 0o111 ? 0o755 : 0o644);
  }
  log(
    `copied ${shipped.length} source files (${files.length - shipped.length} Windows-only left out).`,
  );
}

async function installNode(cache, payload) {
  const spec = runtimes.node;
  const archive = await download(spec.url, path.join(cache, path.basename(spec.url)), spec.sha256);
  const scratch = path.join(cache, 'node-extract');
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(scratch, { recursive: true });
  run('/usr/bin/tar', ['-xzf', archive, '-C', scratch]);
  const extracted = path.join(scratch, spec.archiveRoot);
  const executable = bundledNode(path.join(payload, '.runtime'), spec.version, 'darwin', 'arm64');
  mkdirSync(path.dirname(executable), { recursive: true });
  copyFileSync(path.join(extracted, 'bin/node'), executable);
  chmodSync(executable, 0o755);
  copyFileSync(
    path.join(extracted, 'LICENSE'),
    path.join(path.dirname(executable), '..', 'LICENSE'),
  );
  const version = output(executable, ['--version']);
  if (version !== 'v' + spec.version) throw new Error(`Bundled Node.js reports ${version}.`);
  log(`bundled Node.js ${version}.`);
  // npm stays outside the app: it only installs the dependencies below.
  return { node: executable, npm: path.join(extracted, 'lib/node_modules/npm/bin/npm-cli.js') };
}

async function installLlama(cache, payload) {
  const spec = runtimes.llama;
  const archive = await download(spec.url, path.join(cache, path.basename(spec.url)), spec.sha256);
  const scratch = path.join(cache, 'llama-extract');
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(scratch, { recursive: true });
  run('/usr/bin/tar', ['-xzf', archive, '-C', scratch]);
  const executable = bundledLlamaServer(path.join(payload, '.runtime'), spec.version, 'darwin');
  materializeLlama(path.join(scratch, spec.archiveRoot), path.dirname(executable));
  if (!llamaBundleReady(executable, 'darwin'))
    throw new Error('The llama.cpp runtime is incomplete.');
  const devices = output(executable, ['--list-devices'], { timeout: 30000 });
  log(
    `bundled llama.cpp ${spec.version}: ${
      devices
        .split('\n')
        .find((line) => /MTL\d/.test(line))
        ?.trim() ?? 'no Metal device listed'
    }.`,
  );
  if (path.basename(path.dirname(executable)) !== llamaBundleDirectory(spec.version, 'darwin'))
    throw new Error('Unexpected llama.cpp folder.');
}

function installDependencies(payload, { node, npm }) {
  const env = {
    HOME: os.homedir(),
    TMPDIR: os.tmpdir(),
    PATH: [path.dirname(node), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
    LANG: 'en_US.UTF-8',
    npm_config_update_notifier: 'false',
  };
  run(node, [npm, 'ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: payload, env });
  // Symbolic links are npm workspace and .bin shims; the app copies regular
  // files only. Hard links come from install scripts (esbuild links its
  // platform binary into place): give each name its own copy.
  let links = 0;
  let hardLinks = 0;
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        unlinkSync(file);
        links++;
      } else if (entry.isFile() && lstatSync(file).nlink > 1) {
        const copy = file + '.capri-copy';
        copyFileSync(file, copy);
        chmodSync(copy, lstatSync(file).mode & 0o777);
        renameSync(copy, file);
        hardLinks++;
      } else if (entry.isDirectory()) {
        const name = path.relative(payload, file).split(path.sep).join('/');
        if (!shippedDependency(name)) rmSync(file, { recursive: true, force: true });
        else walk(file);
      }
    }
  };
  walk(path.join(payload, 'node_modules'));
  for (const name of readdirSync(payload, { recursive: true, withFileTypes: true }))
    if (name.name === '.DS_Store') rmSync(path.join(name.parentPath, name.name), { force: true });
  log(
    `installed production dependencies (${links} links left out, ${hardLinks} hard links copied).`,
  );
}

function plutil(plist, changes) {
  for (const [key, type, value] of changes)
    if (type === null) spawnSync('/usr/bin/plutil', ['-remove', key, plist], { stdio: 'ignore' });
    else run('/usr/bin/plutil', ['-replace', key, '-' + type, value, plist]);
}

async function assembleApp(cache, work, version, commit) {
  const spec = runtimes.electron;
  const app = runtimes.app;
  const archive = await download(spec.url, path.join(cache, path.basename(spec.url)), spec.sha256);
  const extracted = path.join(work, 'electron');
  run('/usr/bin/ditto', ['-x', '-k', archive, extracted]);
  const bundle = path.join(work, `${app.name}.app`);
  renameSync(path.join(extracted, 'Electron.app'), bundle);
  rmSync(extracted, { recursive: true, force: true });
  const contents = path.join(bundle, 'Contents');
  renameSync(path.join(contents, 'MacOS/Electron'), path.join(contents, 'MacOS', app.name));
  for (const helper of helperPlan(app.name, app.bundleIdentifier)) {
    const from = path.join(contents, 'Frameworks', helper.from);
    if (!existsSync(from)) throw new Error('Electron is missing ' + helper.from);
    const to = path.join(contents, 'Frameworks', helper.to);
    renameSync(from, to);
    renameSync(
      path.join(to, 'Contents/MacOS', helper.executableFrom),
      path.join(to, 'Contents/MacOS', helper.executableTo),
    );
    plutil(path.join(to, 'Contents/Info.plist'), [
      ['CFBundleExecutable', 'string', helper.executableTo],
      ['CFBundleName', 'string', helper.bundleName],
      ['CFBundleDisplayName', 'string', helper.bundleName],
      ['CFBundleIdentifier', 'string', helper.bundleIdentifier],
    ]);
  }
  plutil(path.join(contents, 'Info.plist'), infoPlistChanges({ ...app, version, commit }));
  const resources = path.join(contents, 'Resources');
  rmSync(path.join(resources, 'default_app.asar'), { force: true });
  rmSync(path.join(resources, 'electron.icns'), { force: true });
  // Icon: the checked-in 1024 px PNG, scaled by sips into an iconset.
  const iconset = path.join(work, `${app.name}.iconset`);
  mkdirSync(iconset);
  for (const [name, pixels] of iconsetEntries())
    run(
      '/usr/bin/sips',
      [
        '-z',
        String(pixels),
        String(pixels),
        path.join(root, 'assets/default/macos/AppIcon-1024.png'),
        '--out',
        path.join(iconset, name),
      ],
      { stdio: 'ignore' },
    );
  run('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', path.join(resources, `${app.name}.icns`)]);
  rmSync(iconset, { recursive: true, force: true });
  // Launcher.
  const launcher = path.join(resources, 'app');
  for (const name of LAUNCHER_FILES) {
    const target = path.join(launcher, name);
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(path.join(root, 'apps/macos-launcher', name), target);
  }
  for (const [name, source] of Object.entries(SETUP_ARTWORK))
    copyFileSync(path.join(root, source), path.join(launcher, name));
  copyFileSync(path.join(root, 'LICENSE'), path.join(launcher, 'LICENSE'));
  writeFileSync(
    path.join(launcher, 'package.json'),
    JSON.stringify(
      {
        name: 'capri',
        productName: app.name,
        version: bundleVersions(version).full,
        description: 'Capri desktop companion',
        license: 'GPL-3.0-only',
        private: true,
        type: 'module',
        main: 'launcher.mjs',
      },
      null,
      2,
    ) + '\n',
  );
  return { bundle, resources };
}

async function main() {
  checkHost();
  const { short, full: version } = bundleVersions(release.tag);
  const { commit, dirty } = sourceCommit();
  if (dirty) log('warning: the source tree has uncommitted changes; they are included.');
  const out = path.join(root, 'release/macos');
  const work = path.join(out, 'work');
  const cache = path.join(root, '.downloads/macos');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  mkdirSync(cache, { recursive: true });
  log(`building Capri ${version} (${commit?.slice(0, 12) ?? 'no git commit'}).`);

  const { bundle, resources } = await assembleApp(cache, work, version, commit);
  const payload = path.join(resources, PAYLOAD_FOLDER);
  mkdirSync(payload);
  copySource(payload);
  const tools = await installNode(cache, payload);
  await installLlama(cache, payload);
  installDependencies(payload, tools);
  await buildHelpers({ root, payload, run, log });

  log('hashing the payload.');
  const manifest = await payloadManifest(payload, { version, commit });
  writeFileSync(path.join(resources, MANIFEST_FILE), JSON.stringify(manifest) + '\n');
  const summary = buildSummary(manifest, {
    bundleIdentifier: runtimes.app.bundleIdentifier,
    runtimes: {
      electron: runtimes.electron.version,
      node: runtimes.node.version,
      llama: runtimes.llama.version,
    },
    builtAt: new Date().toISOString(),
  });
  writeFileSync(path.join(resources, BUILD_FILE), JSON.stringify(summary, null, 2) + '\n');
  log(`payload: ${summary.files} files, ${(summary.bytes / 1e9).toFixed(2)} GB.`);

  // Signing refuses extended attributes such as quarantine or Finder info.
  run('/usr/bin/xattr', ['-cr', bundle]);
  run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', '--timestamp=none', bundle]);
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
  log('signed Capri.app ad hoc.');

  const staging = path.join(work, 'dmg');
  mkdirSync(staging);
  run('/usr/bin/ditto', [bundle, path.join(staging, path.basename(bundle))]);
  symlinkSync('/Applications', path.join(staging, 'Applications'));
  const image = path.join(out, releaseAssetName(release.tag, 'macos'));
  rmSync(image, { force: true });
  // hdiutil's own size estimate can fall short for tens of thousands of files.
  const kilobytes = Number(output('/usr/bin/du', ['-sk', staging]).split(/\s+/)[0]);
  run('/usr/bin/hdiutil', [
    'create',
    '-volname',
    runtimes.app.name,
    '-srcfolder',
    staging,
    '-size',
    `${Math.ceil((kilobytes * 1.25) / 1024) + 200}m`,
    '-fs',
    'HFS+',
    '-format',
    'ULFO',
    '-ov',
    image,
  ]);
  rmSync(staging, { recursive: true, force: true });
  run('/usr/bin/hdiutil', ['verify', image], { stdio: 'ignore' });
  const digest = await sha256(image);
  writeFileSync(image + '.sha256', `${digest}  ${path.basename(image)}\n`);
  log(`Capri ${version} (bundle version ${short}) is ready:`);
  console.log(`  ${path.relative(root, image)}`);
  console.log(`  sha256 ${digest}`);
  console.log(`  ${path.relative(root, bundle)}`);
}

if (import.meta.main)
  await main().catch((error) => {
    console.error('Capri build failed: ' + error.message);
    process.exitCode = 1;
  });
