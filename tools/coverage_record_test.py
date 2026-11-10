#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""Offline coverage-record checks: no broad tests, downloads, deployment or firmware."""
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

import coverage_record as coverage


class CoverageRecords(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.git('init', '-b', 'main')
        self.git('config', 'user.email', 'test@example.invalid')
        self.git('config', 'user.name', 'Test')
        (self.root / 'source.ts').write_text('source under test')
        self.commit('base')
        self.stats = self.root / 'stats.json'
        self.stats.write_text(json.dumps({'asOf': '2026-11-09', 'core': {'pct': 80.0, 'lines': 20},
                                         'interface': {'pct': 25.0, 'lines': 100}}))
        self.bundle = self.root / 'bundle'
        coverage.produce(self.root, self.stats, self.bundle, 'https://github.com/example/repo/actions/runs/123')

    def git(self, *args):
        return subprocess.check_output(['git', *args], cwd=self.root, stderr=subprocess.DEVNULL).decode().strip()

    def commit(self, message):
        # Only tracked source inputs; temporary output is deliberately not committed.
        self.git('add', 'source.ts')
        self.git('commit', '-m', message)

    def test_every_durable_record_is_valid_and_names_its_directory(self):
        records = coverage.ROOT / coverage.RECORDS
        for record in sorted(records.iterdir()):
            if not record.is_dir():
                continue
            with self.subTest(record=record.name):
                coverage.version(record.name)
                _, _, manifest = coverage.read_bundle(record)
                self.assertEqual(manifest['targetRelease'], record.name)


    def test_current_record_installs_and_is_durable(self):
        coverage.prepare(self.root, self.bundle, 'v1.13.0', 'HEAD')
        before = coverage.fingerprint(self.root, 'HEAD')
        self.git('add', 'release/coverage')
        self.git('commit', '-m', 'retain display record')
        self.assertEqual(coverage.fingerprint(self.root, 'HEAD'), before)
        out = self.root / 'out.json'
        coverage.install(self.root, self.root / 'release/coverage', 'v1.13.0', out)
        stats = json.loads(out.read_text())
        self.assertEqual(stats['measurement'], {'label': 'v1.13.0', 'historical': False})
        self.assertEqual(stats['core']['pct'], 80)

    def test_source_change_blocks_current_but_explicit_history_retains_label_date(self):
        coverage.prepare(self.root, self.bundle, 'v1.13.0', 'HEAD')
        record = self.root / 'release/coverage/v1.13.0'
        (self.root / 'source.ts').write_text('different source')
        self.commit('change code')
        with self.assertRaisesRegex(ValueError, 'source differs'):
            coverage.install(self.root, record.parent, 'v1.13.0', self.root / 'out.json')
        with self.assertRaisesRegex(ValueError, 'not current'):
            coverage.prepare(self.root, record, 'v1.14.0', 'HEAD')
        coverage.prepare(self.root, record, 'v1.14.0', 'HEAD', historical=True)
        coverage.install(self.root, record.parent, 'v1.14.0', self.root / 'out.json')
        stats = json.loads((self.root / 'out.json').read_text())
        self.assertEqual(stats['measurement'], {'label': 'v1.13.0', 'historical': True})
        self.assertEqual(stats['asOf'], '2026-11-09')

    def test_missing_tampered_wrong_release_and_invalid_figures_are_refused(self):
        with self.assertRaisesRegex(ValueError, 'record missing'):
            coverage.install(self.root, self.root / 'absent', 'v1.13.0', self.root / 'out.json')
        coverage.prepare(self.root, self.bundle, 'v1.13.0', 'HEAD')
        record = self.root / 'release/coverage/v1.13.0'
        (record / 'coverage.json').write_text(self.stats.read_text() + '\n')
        with self.assertRaisesRegex(ValueError, 'hash/schema'):
            coverage.read_bundle(record)
        manifest = json.loads((self.bundle / 'manifest.json').read_text())
        manifest['targetRelease'] = 'v1.14.0'
        coverage.write_bundle(record, self.stats.read_bytes(), manifest)
        with self.assertRaisesRegex(ValueError, 'another release'):
            coverage.install(self.root, record.parent, 'v1.13.0', self.root / 'out.json')
        bad = json.loads(self.stats.read_text())
        bad['core']['pct'] = float('inf')
        with self.assertRaisesRegex(ValueError, 'Invalid coverage'):
            coverage.validate_stats(bad)

    def test_legacy_seed_is_historical_only_with_pinned_public_bytes(self):
        legacy = coverage.ROOT / 'release/coverage/v1.12.0'
        data, stats, manifest = coverage.read_bundle(legacy)
        self.assertEqual(coverage.sha(data), 'd4a85fc5d10ffb33c11b55594b99d81b7444a309a66070841a662f0915ef8044')
        self.assertEqual(stats['asOf'], '2026-11-09')
        self.assertIsNone(manifest['sourceFingerprint'])
        with self.assertRaisesRegex(ValueError, 'not current'):
            coverage.prepare(self.root, legacy, 'v1.13.0', 'HEAD')
        manifest['display'] = 'current'
        coverage.write_bundle(self.root / 'bad-legacy', data, manifest)
        with self.assertRaisesRegex(ValueError, 'historical only'):
            coverage.read_bundle(self.root / 'bad-legacy')

    def test_guidance_is_excluded_but_test_dependency_and_workflow_changes_count(self):
        before = coverage.fingerprint(self.root, 'HEAD')
        for path in ['README.md', 'AGENTS.md', 'CLAUDE.md', 'docs/policy.md']:
            f = self.root / path
            f.parent.mkdir(parents=True, exist_ok=True)
            f.write_text('guidance')
            self.git('add', path)
        self.git('commit', '-m', 'guidance only')
        self.assertEqual(coverage.fingerprint(self.root, 'HEAD'), before)
        for path in ['web/src/source.test.ts', 'web/package-lock.json', '.github/workflows/web.yml']:
            f = self.root / path
            f.parent.mkdir(parents=True, exist_ok=True)
            f.write_text('affects measurement')
            self.git('add', path)
            self.git('commit', '-m', path)
            after = coverage.fingerprint(self.root, 'HEAD')
            self.assertNotEqual(after, before)
            before = after

    def test_producer_refuses_dirty_source(self):
        (self.root / 'source.ts').write_text('uncommitted source')
        with self.assertRaisesRegex(ValueError, 'Tracked source changed'):
            coverage.produce(self.root, self.stats, self.bundle, 'https://example.com/run')


if __name__ == '__main__':
    unittest.main()
