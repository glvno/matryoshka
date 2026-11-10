#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""Offline regressions for check scope; never builds firmware or runs a full suite."""
import json
import hashlib
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import ci_checks as ci


class SelectionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.config = json.loads(ci.CONFIG.read_text())

    def test_usb_change_selects_transport_domain_not_whole_host_suite(self):
        selected = ci.select(['firmware/src/usb.c'], self.config, 'firmware')
        self.assertEqual(set(selected['host']), {'usb', 'audio', 'peak'})
        self.assertTrue(selected['firmware'])
        self.assertNotIn('golden', selected['host'])

    def test_changed_web_test_and_companion_are_targeted(self):
        selected = ci.select(['web/src/roll.ts', 'web/src/piano.test.ts'], self.config, 'web')
        self.assertEqual(set(selected['web']), {'web/src/roll.test.ts', 'web/src/piano.test.ts'})

    def test_uncovered_executable_and_missing_test_require_a_plan(self):
        for area, path in [('firmware', 'firmware/src/new_transport.c'), ('web', 'web/src/new_view.ts')]:
            with self.subTest(path=path), self.assertRaisesRegex(ValueError, 'TEST PLAN REQUIRED'):
                ci.select([path], self.config, area)
        bad = dict(self.config, rules=[{'name': 'stale rule', 'paths': ['web/src/roll.ts'],
                                       'host': [], 'web': ['web/src/does-not-exist.test.ts']}])
        with self.assertRaisesRegex(ValueError, 'missing tests'):
            ci.select(['web/src/roll.ts'], bad, 'web')

    def test_removed_companion_cannot_silently_pass(self):
        with self.assertRaisesRegex(ValueError, 'TEST PLAN REQUIRED'):
            ci.select(['web/src/removed.test.ts'], self.config, 'web')

    def test_ci_edits_exercise_selector_and_docs_do_not_select_runtime_tests(self):
        for path in ['tools/ci_checks.py', 'tools/ci_checks.json', '.github/workflows/firmware.yml',
                     '.github/workflows/web.yml', '.github/workflows/release.yml']:
            with self.subTest(path=path):
                chosen = ci.select([path], self.config, 'firmware')
                self.assertEqual(chosen['host'], ['selector'])
        chosen = ci.select(['docs/EMULATOR.md', 'README.md'], self.config, 'firmware')
        self.assertFalse(chosen['firmware'])
        self.assertEqual(chosen['host'], [])

    def test_rc_requires_dispatch_and_exact_checked_out_sha(self):
        sha = 'a' * 40
        self.assertEqual(ci.event_scope('workflow_dispatch', {'inputs': {'mode': 'rc', 'rc_sha': sha}}, sha), ('rc', []))
        for value in ['main', sha[:7], 'b' * 40, '']:
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, 'exact checked-out'):
                ci.event_scope('workflow_dispatch', {'inputs': {'mode': 'rc', 'rc_sha': value}}, sha)
        with patch.object(ci, 'changed_paths', return_value=['web/src/roll.ts']) as paths:
            mode, _ = ci.event_scope('pull_request', {'inputs': {'mode': 'rc', 'rc_sha': sha},
                                    'pull_request': {'base': {'sha': 'b' * 40}}}, sha)
            self.assertEqual(mode, 'targeted')
            self.assertTrue(paths.call_args.kwargs['merge_base'])
        with self.assertRaisesRegex(ValueError, 'explicit base'):
            ci.event_scope('workflow_dispatch', {'inputs': {'mode': 'targeted'}}, sha)

    def test_manual_plan_is_bound_to_changed_bytes_and_visible_as_review(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / 'tools').mkdir()
            source = root / 'tools/fm1_rec.swift'
            source.write_text('capture implementation')
            config = dict(self.config, rules=[r for r in self.config['rules'] if r.get('manual')])
            with self.assertRaisesRegex(ValueError, 'TEST PLAN REQUIRED'):
                ci.select(['tools/fm1_rec.swift'], config, 'firmware', root=root)
            (root / 'tools/ci_test_plan.json').write_text(json.dumps({'tools/fm1_rec.swift': {
                'sha256': hashlib.sha256(source.read_bytes()).hexdigest(),
                'plan': 'Review channel selection and verify a bounded capture on the registered rig.'}}))
            selected = ci.select(['tools/fm1_rec.swift'], config, 'firmware', root=root)
            self.assertIn('MANUAL PLAN', selected['reasons']['tools/fm1_rec.swift'][1])
            source.write_text('changed capture implementation')
            with self.assertRaisesRegex(ValueError, 'TEST PLAN REQUIRED'):
                ci.select(['tools/fm1_rec.swift'], config, 'firmware', root=root)

    def test_usb_return_regression_becomes_mandatory_when_feature_exists(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            optional = self.config['optional_host']['usb_return']
            self.assertNotIn('usb_return', ci.applicable_host(self.config['full_host'], self.config, root))
            (root / optional).parent.mkdir(parents=True)
            (root / optional).write_text('USB return is part of this build')
            self.assertIn('usb_return', ci.applicable_host(self.config['full_host'], self.config, root))


    def test_package_mode_claims_no_tests_and_is_release_only(self):
        with tempfile.TemporaryDirectory() as temp:
            event = Path(temp) / 'event.json'
            event.write_text(json.dumps({'inputs': {'mode': 'package'}}))
            with patch.dict(os.environ, {'GITHUB_EVENT_NAME': 'workflow_dispatch', 'GITHUB_EVENT_PATH': str(event)}):
                with self.assertRaisesRegex(ValueError, 'release packaging'):
                    ci.plan('firmware')
                chosen = ci.plan('firmware', allow_package=True)
                self.assertEqual(chosen['host'], [])
                self.assertEqual(chosen['mode'], 'package')

    def test_new_usb_runner_need_not_have_executable_bit(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / 'tools').mkdir()
            runner = root / 'tools/usb_return_test.sh'
            runner.write_text('echo checked > checked.txt\n')
            runner.chmod(0o644)  # The integrated USB-return runner has this Git mode.
            plan = root / 'plan.json'
            plan.write_text(json.dumps({'commit': 'a'*40, 'mode': 'targeted', 'host': ['usb_return']}))
            with patch.object(ci, 'ROOT', root), patch.object(ci, 'git', return_value='a'*40):
                ci.execute(plan, 'firmware')
            self.assertEqual((root / 'checked.txt').read_text(), 'checked\n')


    def test_targeted_runner_passes_only_selected_files(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'plan.json'
            path.write_text(json.dumps({'commit': 'a'*40, 'mode': 'targeted', 'web': ['web/src/roll.test.ts']}))
            with patch.object(ci, 'git', return_value='a'*40), patch.object(ci.subprocess, 'run') as run:
                ci.execute(path, 'web')
                self.assertEqual(run.call_args.args[0], ['npx', '--no-install', 'vitest', 'run', 'src/roll.test.ts'])
            path.write_text(json.dumps({'commit': 'b'*40, 'mode': 'rc', 'web': []}))
            with patch.object(ci, 'git', return_value='a'*40), self.assertRaisesRegex(ValueError, 'different commit'):
                ci.execute(path, 'web')


class GitComparisonTests(unittest.TestCase):
    def test_merge_base_rename_and_deletion_keep_all_affected_paths(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            def git(*args):
                return subprocess.check_output(['git', *args], cwd=root, stderr=subprocess.DEVNULL).decode().strip()
            git('init', '-b', 'main')
            git('config', 'user.email', 'test@example.invalid')
            git('config', 'user.name', 'Test')
            for path in ['old name.ts', 'deleted.c']:
                (root / path).write_text('unchanged content\n')
            git('add', '.')
            git('commit', '-m', 'base')
            base = git('rev-parse', 'HEAD')
            git('checkout', '-b', 'feature')
            git('mv', 'old name.ts', 'new name.ts')
            git('rm', 'deleted.c')
            git('commit', '-m', 'feature')
            feature = git('rev-parse', 'HEAD')
            git('checkout', 'main')
            (root / 'upstream.ts').write_text('upstream only\n')
            git('add', '.')
            git('commit', '-m', 'upstream')
            upstream = git('rev-parse', 'HEAD')
            paths = ci.changed_paths(upstream, feature, merge_base=True, root=root)
            self.assertEqual(paths, ['deleted.c', 'new name.ts', 'old name.ts'])
            self.assertEqual(ci.changed_paths(base, feature, root=root), paths)


if __name__ == '__main__':
    unittest.main()
