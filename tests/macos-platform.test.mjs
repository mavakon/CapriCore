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

test('macOS process start times become digits-only marker identities', async () => {
  const { parseDarwinStartTime } = await import('../packages/runtime/src/host/processes.mjs');
  const value = parseDarwinStartTime('Sat Nov 21 23:27:59 2026\n');
  assert.equal(value, String(Date.UTC(2026, 10, 21, 23, 27, 59) / 1000));
  // readMarker only admits digit identities; a raw ps date would be rejected.
  assert.match(value, /^\d+$/);
  assert.equal(
    parseDarwinStartTime('Sun Nov  1 03:07:09 2026'),
    String(Date.UTC(2026, 10, 1, 3, 7, 9) / 1000),
  );
  assert.equal(parseDarwinStartTime(''), null);
  assert.equal(parseDarwinStartTime('not a date'), null);
});

test('macOS available memory counts reclaimable inactive pages', async () => {
  const { parseVmStat, availableMemoryBytes } = await import(
    '../packages/runtime/src/hardware/available-memory.mjs'
  );
  const sample = [
    'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
    'Pages free:                               10000.',
    'Pages active:                            500000.',
    'Pages inactive:                          300000.',
    'Pages speculative:                         2000.',
    'Pages purgeable:                          50000.',
  ].join('\n');
  assert.equal(parseVmStat(sample), (10000 + 300000 + 2000) * 16384);
  assert.equal(parseVmStat('garbage'), null);
  assert.equal(
    availableMemoryBytes({ platform: 'darwin', run: () => sample }),
    parseVmStat(sample),
  );
  assert.ok(
    availableMemoryBytes({
      platform: 'darwin',
      run: () => {
        throw new Error('x');
      },
    }) > 0,
  );
});

test('the RAM meter uses reclaimable memory on macOS', async () => {
  const { readAvailableMemoryBytes } = await import(
    '../packages/runtime/src/hardware/available-memory.mjs'
  );
  const { MemorySampler } = await import('../packages/runtime/src/hardware/memory.mjs');
  const sample =
    'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 1000.\nPages inactive: 3000.\n';
  assert.equal(
    await readAvailableMemoryBytes({ platform: 'darwin', run: async () => sample }),
    4000 * 16384,
  );
  const sampler = new MemorySampler({
    readGpu: async () => [],
    ram: async () => ({ percent: 50 }),
  });
  assert.equal((await sampler.sample()).ram.percent, 50);
});
