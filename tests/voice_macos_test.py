"""macOS voice compute selection: Apple GPU (MPS) with CPU fallback.

Most cases use a small PyTorch stand-in, so they run on any CI host. The last
class runs the real Metal checks when PyTorch is installed on a Mac.
"""
# SPDX-License-Identifier: GPL-3.0-only
import importlib.util
import sys
from types import SimpleNamespace as NS
import unittest
from unittest.mock import Mock, patch

from integrations.voice_runtime import accelerator
from integrations.voice_runtime.accelerator import (
    MPS, apple_gpu, empty_cache, gpu_device, is_cuda, is_mps, memory_bytes, mps_preflight,
    out_of_memory, synchronize,
)
from integrations.voice_runtime.compatibility import qwen_compute
from integrations.voice_training.provision import pinned_source


class FakeTensor:
    def __init__(self, value):
        self.value = value

    def __add__(self, other):
        return FakeTensor(self.value + other * 16)

    def __mul__(self, other):
        return FakeTensor(self.value * other)

    def __matmul__(self, other):
        return FakeTensor(self.value)

    def sum(self):
        return self

    def item(self):
        return self.value


def fake_torch(*, built=True, available=True, budget=16 * 1024 ** 3, used=0, broken=False):
    def arange(count, device, dtype):
        if broken:
            raise RuntimeError('Metal command buffer failed')
        assert device == MPS
        return FakeTensor(sum(range(count)))

    mps = NS(
        synchronize=Mock(), empty_cache=Mock(),
        current_allocated_memory=Mock(return_value=123),
        driver_allocated_memory=Mock(return_value=used),
        recommended_max_memory=Mock(return_value=budget),
    )
    return NS(
        __version__='2.6.0', float32='float32',
        backends=NS(mps=NS(is_built=lambda: built, is_available=lambda: available)),
        mps=mps,
        cuda=NS(synchronize=Mock(), empty_cache=Mock(), memory_allocated=Mock(return_value=1),
                memory_reserved=Mock(return_value=2), device_count=Mock(return_value=0)),
        arange=arange,
        eye=lambda size, device, dtype: FakeTensor(size),
        version=NS(cuda=None, hip=None),
    )


class AppleGpuSelectionTests(unittest.TestCase):
    def test_apple_gpu_requires_macos_and_a_built_available_metal_backend(self):
        self.assertTrue(apple_gpu(fake_torch(), 'darwin'))
        self.assertFalse(apple_gpu(fake_torch(), 'win32'))
        self.assertFalse(apple_gpu(fake_torch(built=False), 'darwin'))
        self.assertFalse(apple_gpu(fake_torch(available=False), 'darwin'))
        self.assertFalse(apple_gpu(NS(), 'darwin'))
        raising = fake_torch()
        raising.backends.mps.is_available = Mock(side_effect=RuntimeError('no device'))
        self.assertFalse(apple_gpu(raising, 'darwin'))
        self.assertEqual(gpu_device(fake_torch(), 'darwin'), MPS)
        self.assertIsNone(gpu_device(fake_torch(available=False), 'darwin'))
        self.assertEqual(gpu_device(fake_torch(), 'win32'), 'cuda:0')

    def test_device_names_and_synchronisation_follow_the_selected_backend(self):
        self.assertTrue(is_mps('mps') and is_mps('mps:0') and not is_mps('cpu'))
        self.assertTrue(is_cuda('cuda:0') and not is_cuda('mps'))
        torch = fake_torch()
        synchronize(torch, 'cpu')
        torch.mps.synchronize.assert_not_called()
        torch.cuda.synchronize.assert_not_called()
        synchronize(torch, MPS)
        torch.mps.synchronize.assert_called_once_with()
        synchronize(torch, 'cuda:0')
        torch.cuda.synchronize.assert_called_once_with()

    def test_cache_release_and_memory_reports_never_touch_cuda_on_a_mac(self):
        torch = fake_torch(used=456)
        empty_cache(torch, 'darwin')
        torch.mps.empty_cache.assert_called_once_with()
        torch.cuda.empty_cache.assert_not_called()
        self.assertEqual(memory_bytes(torch, 'darwin'), (123, 456))
        cpu_only = fake_torch(available=False)
        empty_cache(cpu_only, 'darwin')
        cpu_only.mps.empty_cache.assert_not_called()
        self.assertEqual(memory_bytes(cpu_only, 'darwin'), (0, 0))
        windows = fake_torch()
        empty_cache(windows, 'win32')
        windows.cuda.empty_cache.assert_called_once_with()
        self.assertEqual(memory_bytes(windows, 'win32'), (1, 2))

    def test_only_real_allocation_failures_count_as_out_of_memory(self):
        class OutOfMemoryError(RuntimeError):
            pass

        torch = NS(OutOfMemoryError=OutOfMemoryError, cuda=NS())
        self.assertTrue(out_of_memory(torch, OutOfMemoryError('CUDA out of memory')))
        self.assertTrue(out_of_memory(torch, RuntimeError(
            'MPS backend out of memory (MPS allocated: 17.00 GB, other allocations: 1.00 GB)')))
        self.assertFalse(out_of_memory(torch, RuntimeError('shape mismatch')))
        self.assertFalse(out_of_memory(torch, ValueError('MPS backend out of memory')))
        self.assertFalse(out_of_memory(NS(), RuntimeError('out of memory')))

    def test_metal_preflight_runs_real_kernels_and_reports_failures(self):
        report = mps_preflight(fake_torch(), 'darwin')
        self.assertEqual(report['backend'], 'mps')
        self.assertEqual(report['runtime'], 'metal')
        self.assertTrue(report['kernelReady'])
        self.assertEqual(report['recommendedMaxMemoryBytes'], 16 * 1024 ** 3)
        failed = mps_preflight(fake_torch(broken=True), 'darwin')
        self.assertFalse(failed['kernelReady'])
        self.assertIn('Metal command buffer failed', failed['error'])
        missing = mps_preflight(fake_torch(available=False), 'darwin')
        self.assertFalse(missing['available'] or missing['kernelReady'])
        self.assertIn('Apple GPU', missing['error'])
        self.assertIn('only used on macOS', mps_preflight(fake_torch(), 'win32')['error'])

    def test_qwen_uses_the_apple_gpu_when_its_memory_budget_fits(self):
        self.assertEqual(qwen_compute(fake_torch(), 'auto', True, 6, 'darwin'), (MPS, 'Apple GPU (Metal)'))
        self.assertEqual(qwen_compute(fake_torch(), 'cpu', True, 6, 'darwin'),
                         ('cpu', 'configured voice device'))
        device, reason = qwen_compute(fake_torch(available=False), 'auto', True, 6, 'darwin')
        self.assertEqual((device, reason), ('cpu', 'Apple GPU unavailable'))
        busy = fake_torch(budget=8 * 1024 ** 3, used=4 * 1024 ** 3)
        self.assertEqual(qwen_compute(busy, 'auto', True, 6, 'darwin')[0], 'cpu')
        with self.assertRaisesRegex(RuntimeError, 'Apple GPU is unavailable'):
            qwen_compute(busy, MPS, False, 6, 'darwin')
        with self.assertRaisesRegex(RuntimeError, 'Apple GPU is unavailable to PyTorch'):
            qwen_compute(fake_torch(available=False), MPS, False, 6, 'darwin')
        self.assertEqual(qwen_compute(fake_torch(broken=True), 'auto', True, 6, 'darwin')[0], 'cpu')

    def test_qwen_keeps_its_cuda_search_off_macos(self):
        torch = fake_torch()
        self.assertEqual(qwen_compute(torch, 'auto', True, 6, 'win32'),
                         ('cpu', 'GPU unavailable or less than 6 GiB of free VRAM'))
        torch.cuda.device_count.assert_called_once_with()


class PinnedSourceTests(unittest.TestCase):
    SOURCE = {'repository': 'https://github.com/resemble-ai/chatterbox.git',
              'revision': '5de7a54aa4e5e2baadb0182dde554908b48b85c2'}
    ARCHIVE = 'https://github.com/resemble-ai/chatterbox/archive/5de7a54aa4e5e2baadb0182dde554908b48b85c2.tar.gz'

    def test_git_commit_is_accepted_everywhere(self):
        installed = {'url': 'https://github.com/resemble-ai/chatterbox.git',
                     'vcs_info': {'vcs': 'git', 'commit_id': self.SOURCE['revision']}}
        self.assertTrue(pinned_source(installed, self.SOURCE, 'win32'))
        self.assertTrue(pinned_source(installed, self.SOURCE, 'darwin'))

    def test_macos_accepts_only_the_same_commit_as_a_hash_locked_archive(self):
        installed = {'url': self.ARCHIVE, 'archive_info': {'hash': 'sha256=' + 'a' * 64,
                                                           'hashes': {'sha256': 'a' * 64}}}
        self.assertTrue(pinned_source(installed, self.SOURCE, 'darwin'))
        self.assertTrue(pinned_source({'url': self.ARCHIVE, 'archive_info': {'hashes': {'sha256': 'a' * 64}}},
                                      self.SOURCE, 'darwin'))
        self.assertFalse(pinned_source(installed, self.SOURCE, 'win32'))
        self.assertFalse(pinned_source({'url': self.ARCHIVE, 'archive_info': {}}, self.SOURCE, 'darwin'))
        self.assertFalse(pinned_source({'url': self.ARCHIVE}, self.SOURCE, 'darwin'))
        other = self.ARCHIVE.replace('5de7a54a', '00000000')
        self.assertFalse(pinned_source({'url': other, 'archive_info': {'hash': 'sha256=x'}},
                                       self.SOURCE, 'darwin'))
        fork = self.ARCHIVE.replace('resemble-ai', 'someone-else')
        self.assertFalse(pinned_source({'url': fork, 'archive_info': {'hash': 'sha256=x'}},
                                       self.SOURCE, 'darwin'))
        self.assertFalse(pinned_source({}, self.SOURCE, 'darwin'))


TORCH = importlib.util.find_spec('torch') is not None


@unittest.skipUnless(sys.platform == 'darwin' and TORCH, 'needs PyTorch on a Mac')
class RealMetalTests(unittest.TestCase):
    def test_metal_preflight_runs_on_this_mac(self):
        import torch

        report = mps_preflight(torch)
        if not torch.backends.mps.is_available():
            self.assertFalse(report['kernelReady'])
            return
        self.assertTrue(report['kernelReady'], report)
        self.assertGreater(report['recommendedMaxMemoryBytes'], 0)
        allocated, reserved = memory_bytes(torch)
        self.assertGreaterEqual(reserved, 0)
        self.assertGreaterEqual(allocated, 0)
        empty_cache(torch)

    def test_voice_settings_choose_the_apple_gpu_or_the_configured_cpu(self):
        import torch
        from integrations.voice_runtime import model

        expected = MPS if torch.backends.mps.is_available() else 'cpu'
        with patch.dict('os.environ', {'CAPRI_VOICE_COMPUTE_DEVICE': 'auto'}):
            self.assertEqual(model.settings()['computeDevice'], expected)
        with patch.dict('os.environ', {'CAPRI_VOICE_COMPUTE_DEVICE': 'cpu'}):
            self.assertEqual(model.settings()['computeDevice'], 'cpu')
        with patch.dict('os.environ', {'CAPRI_VOICE_COMPUTE_DEVICE': 'cuda:0'}):
            with self.assertRaisesRegex(ValueError, 'Invalid voice compute device'):
                model.settings()


if __name__ == '__main__':
    unittest.main()
