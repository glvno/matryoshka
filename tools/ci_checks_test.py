#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""Offline regressions for check scope; never builds firmware or runs a full suite."""
import json
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
        self.assertTrue({'usb', 'audio', 'peak'} <= set(selected['host']))
        self.assertTrue(set(selected['host']) <= {'usb', 'audio', 'peak', 'usb_return'})
        self.assertTrue(selected['firmware'])
        self.assertNotIn('golden', selected['host'])

    def test_every_rule_names_host_checks_that_exist(self):
        # a misspelt name ('pal_preset' for 'pal-preset') ran every check of the scope, then failed the job on a KeyError
        known = set(self.config['host_commands'])
        for rule in self.config['rules']:
            with self.subTest(rule=rule['name']):
                self.assertEqual([h for h in rule['host'] if h not in known], [])

    def test_changed_web_test_and_companion_are_targeted(self):
        selected = ci.select(['web/src/roll.ts', 'web/src/piano.test.ts'], self.config, 'web')
        self.assertEqual(set(selected['web']), {'web/src/roll.test.ts', 'web/src/piano.test.ts'})

    def test_unmapped_path_runs_more_and_never_fails_planning(self):
        chosen = ci.select(['firmware/src/new_transport.c'], self.config, 'firmware')
        self.assertEqual(set(chosen['host']), ci.applicable_host(self.config['full_host'], self.config, ci.ROOT))
        for path in ['web/src/new_view.ts', 'web/src/removed.test.ts']:
            with self.subTest(path=path):
                chosen = ci.select([path], self.config, 'web')
                self.assertEqual(chosen['web'], [])
                self.assertIn('build checks only', chosen['reasons'][path][0])
        bad = dict(self.config, rules=[{'name': 'stale rule', 'paths': ['web/src/roll.ts'],
                                       'host': [], 'web': ['web/src/does-not-exist.test.ts']}])
        with self.assertRaisesRegex(ValueError, 'missing tests'):
            ci.select(['web/src/roll.ts'], bad, 'web')

    def test_ci_edits_exercise_selector_and_docs_do_not_select_runtime_tests(self):
        for path in ['tools/ci_checks.py', 'tools/ci_checks.json', '.github/workflows/firmware.yml',
                     '.github/workflows/web.yml', '.github/workflows/release.yml']:
            with self.subTest(path=path):
                chosen = ci.select([path], self.config, 'firmware')
                self.assertEqual(chosen['host'], ['release-build', 'selector']
                                 if path == '.github/workflows/release.yml' else ['selector'])
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

    def test_a_merge_to_main_runs_the_full_web_suite_beside_its_targeted_scope(self):
        sha = 'a' * 40
        push = {'ref': 'refs/heads/main', 'before': 'b' * 40}
        with patch.object(ci, 'changed_paths', return_value=['web/src/roll.ts']):
            self.assertEqual(ci.event_scope('push', push, sha, area='web'), ('main', ['web/src/roll.ts']))
            self.assertEqual(ci.event_scope('push', push, sha, area='firmware'), ('targeted', ['web/src/roll.ts']))
            self.assertEqual(ci.event_scope('push', dict(push, ref='refs/heads/other'), sha, area='web')[0], 'targeted')
            self.assertEqual(ci.event_scope('pull_request', {'pull_request': {'base': {'sha': 'b' * 40}}}, sha, area='web')[0], 'targeted')
        self.assertEqual(ci.event_scope('workflow_dispatch', {'inputs': {'mode': 'main'}}, sha, area='web'), ('main', []))
        with tempfile.TemporaryDirectory() as temp:
            event = Path(temp) / 'event.json'
            event.write_text(json.dumps({'inputs': {'mode': 'main'}}))
            with patch.dict(os.environ, {'GITHUB_EVENT_NAME': 'workflow_dispatch', 'GITHUB_EVENT_PATH': str(event)}), patch.object(ci, 'git', return_value=sha):
                self.assertEqual(ci.plan('web')['mode'], 'main')
                with self.assertRaisesRegex(ValueError, 'full suite after a merge'):
                    ci.plan('firmware')

    def test_release_candidate_includes_preset_pattern_checks(self):
        sha = 'a' * 40
        with tempfile.TemporaryDirectory() as temp:
            event = Path(temp) / 'event.json'
            event.write_text(json.dumps({'inputs': {'mode': 'rc', 'rc_sha': sha}}))
            with patch.dict(os.environ, {'GITHUB_EVENT_NAME': 'workflow_dispatch', 'GITHUB_EVENT_PATH': str(event)}), patch.object(ci, 'git', return_value=sha):
                chosen = ci.plan('firmware')
        self.assertIn('preset-pattern', chosen['host'])

    def test_manual_rule_is_a_visible_review_note_not_a_pass(self):
        config = dict(self.config, rules=[r for r in self.config['rules'] if r.get('manual')])
        selected = ci.select(['tools/fm1_rec.swift'], config, 'firmware')
        self.assertEqual(selected['host'], [])
        self.assertTrue(any(r.startswith('MANUAL REVIEW') for r in selected['reasons']['tools/fm1_rec.swift']))

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

    def test_display_only_changes_reach_validator_without_firmware_builds(self):
        for path in ['release/coverage/v1.13.0/manifest.json', '.github/workflows/pages.yml',
                     'web/src/about.ts', 'web/src/coverage.ts']:
            with self.subTest(path=path):
                chosen = ci.select([path], self.config, 'web')
                self.assertIn('coverage-record', chosen['host'])
                self.assertIn('web/src/coverage.test.ts', chosen['web'])
                self.assertFalse(chosen['firmware'])


    def test_rc_web_groups_are_disjoint_and_stats_follow_both_successes(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / 'web/src').mkdir(parents=True)
            (root / 'web/scripts').mkdir(parents=True)
            for number in range(1, 5):
                (root / f'web/src/levels-{number}.test.ts').touch()
            (root / 'web/src/headroom-1.test.ts').touch()
            (root / 'web/src/kit909.test.ts').touch()
            (root / 'web/scripts/audition-render.test.ts').touch()
            (root / 'web/src/other.test.ts').touch()
            plan = root / 'plan.json'
            plan.write_text(json.dumps({'commit': 'a'*40, 'mode': 'rc', 'web': []}))
            with patch.object(ci, 'ROOT', root), patch.object(ci, 'git', return_value='a'*40), patch.object(ci.subprocess, 'run') as run:
                ci.execute(plan, 'web')
                commands = [call.args[0] for call in run.call_args_list]
                self.assertIn('--coverage', commands[0])
                self.assertEqual(commands[0][-2 * len(ci.SLOW_RENDERS):], [a for g in ci.SLOW_RENDERS for a in ('--exclude', g)])
                self.assertNotIn('--coverage', commands[1])
                self.assertEqual(commands[1][4:], ['scripts/audition-render.test.ts', 'src/headroom-1.test.ts', 'src/kit909.test.ts',
                                                   *[f'src/levels-{n}.test.ts' for n in range(1, 5)]])
                self.assertEqual(commands[2][-1], 'scripts/coverage-stats.ts')
            with patch.object(ci, 'ROOT', root), patch.object(ci, 'git', return_value='a'*40), patch.object(ci.subprocess, 'run', side_effect=[None, subprocess.CalledProcessError(1, 'levels')]) as run:
                with self.assertRaises(subprocess.CalledProcessError):
                    ci.execute(plan, 'web')
                self.assertEqual(run.call_count, 2)  # No display result after a partial/failed suite.

    def test_rc_web_groups_run_as_parallel_jobs_and_every_slow_render_once(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / 'web/src').mkdir(parents=True)
            (root / 'web/scripts').mkdir(parents=True)
            for number in range(1, 7):
                (root / f'web/src/levels-{number}.test.ts').touch()
            (root / 'web/src/headroom-1.test.ts').touch()
            (root / 'web/scripts/audition-render.test.ts').touch()
            plan = root / 'plan.json'
            plan.write_text(json.dumps({'commit': 'a'*40, 'mode': 'rc', 'web': []}))
            with patch.object(ci, 'ROOT', root), patch.object(ci, 'git', return_value='a'*40), patch.object(ci.subprocess, 'run') as run:
                ci.execute(plan, 'web', 'coverage')
                commands = [call.args[0] for call in run.call_args_list]
                self.assertEqual(len(commands), 2)
                self.assertIn('--coverage', commands[0])
                self.assertEqual(commands[1][-1], 'scripts/coverage-stats.ts')
                run.reset_mock()
                seen = []
                for k in range(1, 4):
                    ci.execute(plan, 'web', 'slow', (k, 3))
                for call in run.call_args_list:
                    self.assertNotIn('--coverage', call.args[0])
                    seen += call.args[0][4:]
                self.assertEqual(sorted(seen), ci.slow_renders(root))
            plan.write_text(json.dumps({'commit': 'a'*40, 'mode': 'targeted', 'web': []}))
            with patch.object(ci, 'ROOT', root), patch.object(ci, 'git', return_value='a'*40), patch.object(ci.subprocess, 'run'):
                with self.assertRaises(ValueError):
                    ci.execute(plan, 'web', 'slow', (1, 3))

    def test_main_mode_runs_the_coverage_group_with_a_report_then_only_the_slow_renders_the_merge_selects(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / 'web/src').mkdir(parents=True)
            for number in range(1, 3):
                (root / f'web/src/levels-{number}.test.ts').touch()
            plan = root / 'plan.json'
            report = ['--reporter=default', '--reporter=json', '--outputFile.json=' + str(ci.MAIN_REPORT)]
            plan.write_text(json.dumps({'commit': 'a'*40, 'mode': 'main', 'web': ['web/src/levels-2.test.ts', 'web/src/roll.test.ts']}))
            with patch.object(ci, 'ROOT', root), patch.object(ci, 'git', return_value='a'*40), patch.object(ci.subprocess, 'run') as run:
                ci.execute(plan, 'web')
                commands = [call.args[0] for call in run.call_args_list]
                self.assertEqual(len(commands), 2)   # (no coverage stats)
                self.assertIn('--coverage', commands[0])
                self.assertIn('--testTimeout=60000', commands[0])
                self.assertEqual(commands[0][-len(report) - 2 * len(ci.SLOW_RENDERS):-len(report)], [a for g in ci.SLOW_RENDERS for a in ('--exclude', g)])
                self.assertEqual(commands[0][-len(report):], report)
                self.assertEqual(commands[1], ['npx', '--no-install', 'vitest', 'run', 'src/levels-2.test.ts', *report])
                run.reset_mock()
                plan.write_text(json.dumps({'commit': 'a'*40, 'mode': 'main', 'web': ['web/src/roll.test.ts']}))
                ci.execute(plan, 'web')
                self.assertEqual(run.call_count, 1)
                with self.assertRaises(ValueError):
                    ci.execute(plan, 'web', 'coverage')

    def test_slow_parts_deal_the_longest_first_and_count_an_unlisted_file_as_the_median(self):
        files = sorted(ci.SLOW_RENDER_SECONDS)
        parts = [ci.slow_part(files, k, 6) for k in range(1, 7)]
        self.assertEqual(sorted(f for p in parts for f in p), files)
        self.assertIn(['scripts/audition-render.test.ts'], parts)   # (the longest file alone)
        loads = [sum(ci.SLOW_RENDER_SECONDS[f] for f in p) for p in parts]
        self.assertLessEqual(max(loads), 2 * max(ci.SLOW_RENDER_SECONDS.values()))
        self.assertEqual(ci.slow_part(['a', 'b', 'c'], 1, 2, {'a': 10, 'b': 30}), ['a', 'b'])
        self.assertEqual(ci.slow_part(['a', 'b', 'c'], 2, 2, {'a': 10, 'b': 30}), ['c'])   # (c counts as 30, the median)
        with self.assertRaises(ValueError):
            ci.slow_part(files, 0, 6)


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
