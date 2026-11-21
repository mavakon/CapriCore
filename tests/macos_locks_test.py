"""The macOS Python locks keep Windows' reviewed versions and stay hash-locked.

macOS resolves the same voice stacks for Apple silicon wheels. These checks
stop a regenerated lock from drifting away from the Windows pins, losing a
hash, picking up CUDA packages or a different Chatterbox or Perth commit.
"""
# SPDX-License-Identifier: GPL-3.0-only
import json
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[1]
CONFIG = ROOT / 'config'
REQUIREMENT = re.compile(r'^([A-Za-z0-9._-]+)\s*(?:==\s*(\S+)|@\s*(\S+))$')


def name_of(value):
    return re.sub(r'[-_.]+', '-', value).lower()


def lock_entries(name):
    """Requirement name -> version or URL, environment marker and hashes."""
    entries, current = {}, None
    for raw in (CONFIG / name).read_text(encoding='utf-8').splitlines():
        line = raw.strip().removesuffix('\\').strip()
        if not line or line.startswith('#'):
            continue
        if line.startswith('--hash='):
            entries[current]['hashes'].append(line.removeprefix('--hash='))
            continue
        requirement, _, marker = line.partition(';')
        match = REQUIREMENT.match(requirement.strip())
        if not match:
            raise AssertionError(f'{name}: unexpected line {raw!r}')
        current = name_of(match.group(1))
        entries[current] = {
            'version': match.group(2), 'url': match.group(3),
            'marker': marker.strip() or None, 'hashes': [],
        }
    return entries


def public_version(version):
    return version.split('+', 1)[0] if version else version


def runtime():
    return json.loads((CONFIG / 'macos-runtime.json').read_text(encoding='utf-8'))


class MacLockShape:
    windows = mac = None

    def assert_hash_locked(self, entries):
        for name, entry in entries.items():
            with self.subTest(package=name):
                self.assertTrue(entry['hashes'], 'every macOS requirement needs a hash')
                for value in entry['hashes']:
                    self.assertRegex(value, r'^sha256:[0-9a-f]{64}$')

    def assert_no_cuda(self, entries):
        for name, entry in entries.items():
            with self.subTest(package=name):
                self.assertFalse(name.startswith('nvidia-') or name in {'triton', 'pytorch-triton'})
                self.assertNotIn('+', entry['version'] or '', 'macOS uses PyPI wheels, not +cuNNN builds')

    def differing_versions(self):
        shared = set(self.windows) & set(self.mac)
        return {
            name: (self.windows[name]['version'], self.mac[name]['version'])
            for name in shared
            if self.windows[name]['version'] != self.mac[name]['version']
        }


class QwenLockTests(MacLockShape, unittest.TestCase):
    def setUp(self):
        self.windows = lock_entries('requirements-qwen-tts.lock')
        self.mac = lock_entries('requirements-qwen-tts-macos.lock')

    def test_macos_qwen_lock_is_hash_locked_and_has_no_cuda(self):
        self.assert_hash_locked(self.mac)
        self.assert_no_cuda(self.mac)

    def test_macos_qwen_lock_keeps_every_windows_version_but_the_torch_build(self):
        self.assertEqual(self.differing_versions(), {
            'torch': ('2.7.1+cpu', '2.7.1'), 'torchaudio': ('2.7.1+cpu', '2.7.1'),
        })
        # colorama is Windows-only; setuptools only applies to Python 3.12+.
        self.assertEqual(set(self.windows) - set(self.mac), {'colorama', 'setuptools'})
        self.assertEqual(set(self.mac) - set(self.windows), set())

    def test_runtime_pins_match_the_qwen_lock(self):
        qwen = runtime()['qwen']
        self.assertEqual(qwen['requirements'], 'config/requirements-qwen-tts-macos.lock')
        self.assertEqual(self.mac['torch']['version'], qwen['torch'])
        self.assertEqual(self.mac['torchaudio']['version'], qwen['torchaudio'])
        for line in (CONFIG / 'requirements-qwen-tts.in').read_text(encoding='utf-8').split():
            name, version = line.split('==')
            with self.subTest(package=name):
                self.assertEqual(public_version(self.mac[name_of(name)]['version']), version)


if __name__ == '__main__':
    unittest.main()
