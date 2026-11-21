// SPDX-License-Identifier: GPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  bundledLlamaServer,
  bundledNode,
  desktopPlatform,
  electronExecutable,
} from '../packages/runtime/src/host/platform.mjs';
import {
  llamaBundleFiles,
  LLAMA_VULKAN_FILES,
} from '../packages/runtime/src/host/llama-bundle.mjs';
import {
  electronRuntimeFiles,
  ELECTRON_RUNTIME_FILES,
} from '../packages/runtime/src/host/electron-bundle.mjs';
import { appleMetalWorkingSetMiB, probeHardware } from '../packages/runtime/src/hardware/probe.mjs';
import { recommendProfile } from '../packages/runtime/src/hardware/profiles.mjs';

const GiB = 1024 ** 3;

test('desktop hosts are Windows x64 and macOS arm64 only', () => {
  assert.equal(desktopPlatform('win32', 'x64')?.id, 'win32-x64');
  assert.equal(desktopPlatform('darwin', 'arm64')?.id, 'darwin-arm64');
  assert.equal(desktopPlatform('darwin', 'x64'), null);
  assert.equal(desktopPlatform('linux', 'x64'), null);
});

test('bundled runtimes resolve to platform-specific private folders', () => {
  const cache = path.join('install', '.runtime');
  assert.equal(
    bundledLlamaServer(cache, 'b12317', 'darwin'),
    path.join(cache, 'llama-b12317-macos-arm64', 'llama-server'),
  );
  assert.equal(
    bundledLlamaServer(cache, 'b12317', 'win32'),
    path.join(cache, 'llama-b12317-vulkan', 'llama-server.exe'),
  );
  assert.equal(
    bundledNode(cache, '24.22.1', 'darwin', 'arm64'),
    path.join(cache, 'node-v24.22.1-darwin-arm64', 'bin', 'node'),
  );
  assert.equal(
    electronExecutable('electron', 'darwin'),
    path.join('electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron'),
  );
  assert.equal(
    electronExecutable('electron', 'win32'),
    path.join('electron', 'dist', 'electron.exe'),
  );
});

test('bundle checks keep the Windows file sets and add macOS ones', () => {
  assert.equal(llamaBundleFiles('win32'), LLAMA_VULKAN_FILES);
  assert.ok(llamaBundleFiles('darwin').includes('libggml-metal.0.dylib'));
  assert.ok(!llamaBundleFiles('darwin').some((name) => name.endsWith('.dll')));
  assert.equal(electronRuntimeFiles('win32'), ELECTRON_RUNTIME_FILES);
  assert.ok(electronRuntimeFiles('darwin').includes('Electron.app/Contents/MacOS/Electron'));
});

test('Apple silicon reports unified memory with a Metal working set', async () => {
  assert.equal(appleMetalWorkingSetMiB(16 * GiB), Math.floor((16 * 1024 * 2) / 3));
  assert.equal(appleMetalWorkingSetMiB(64 * GiB), 48 * 1024);
  const calls = [];
  const report = await probeHardware({
    platform: 'darwin',
    arch: 'arm64',
    env: {},
    locateExecutable: () => null,
    runCommand: async (command, args) => {
      calls.push([command, ...args]);
      return { stdout: 'Apple M3 Pro\n' };
    },
  });
  assert.deepEqual(calls, [['/usr/sbin/sysctl', '-n', 'machdep.cpu.brand_string']]);
  assert.equal(report.gpus.length, 1);
  assert.equal(report.gpus[0].name, 'Apple M3 Pro GPU');
  assert.equal(report.gpus[0].memoryKind, 'unified');
  assert.ok(!report.warnings.some((warning) => /qualified/.test(warning)));
});

test('unified memory profiles follow installed RAM, not double-counted VRAM', () => {
  const mac = (ramGiB) => ({
    ramBytes: ramGiB * GiB,
    cpuThreads: 12,
    gpus: [
      {
        name: 'Apple M3 GPU',
        vendor: 'apple',
        memoryKind: 'unified',
        vramMiB: appleMetalWorkingSetMiB(ramGiB * GiB),
      },
    ],
  });
  assert.equal(recommendProfile(mac(8)).profile.id, 'minimal');
  assert.equal(recommendProfile(mac(16)).profile.id, 'balanced');
  assert.equal(recommendProfile(mac(24)).profile.id, 'desktop');
  assert.equal(recommendProfile(mac(36)).profile.id, 'quality');
  assert.match(recommendProfile(mac(16)).reasons.join(' '), /Metal/);
});
