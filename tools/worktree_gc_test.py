#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""tools/worktree_gc.py on throwaway repositories: a bare origin, a main checkout and its worktrees. No network: the pull
request lookup is a stub and origin is a local directory."""
import contextlib
import io
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock

import worktree_gc as gc


class WorktreeGc(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.tmp = Path(os.path.realpath(temp.name))
        env = mock.patch.dict(os.environ, {
            'GIT_CONFIG_GLOBAL': os.devnull, 'GIT_CONFIG_NOSYSTEM': '1',
            'GIT_AUTHOR_NAME': 'Test', 'GIT_AUTHOR_EMAIL': 'test@example.invalid',
            'GIT_COMMITTER_NAME': 'Test', 'GIT_COMMITTER_EMAIL': 'test@example.invalid'})
        env.start()
        self.addCleanup(env.stop)
        self.origin = self.tmp / 'origin.git'
        self.main = self.tmp / 'main'
        subprocess.run(['git', 'init', '--quiet', '--bare', '-b', 'main', str(self.origin)], check=True)
        subprocess.run(['git', 'init', '--quiet', '-b', 'main', str(self.main)], check=True)
        self.git('remote', 'add', 'origin', str(self.origin))
        (self.main / '.gitignore').write_text('build/\ntools/emu/target/\nnode_modules\n')
        (self.main / 'engine.c').write_text('int x;\n')
        self.git('add', '.')
        self.git('commit', '--quiet', '-m', 'base')
        self.git('push', '--quiet', '-u', 'origin', 'main')
        (self.main / 'web' / 'node_modules').mkdir(parents=True)
        (self.main / 'web' / 'node_modules' / 'dep.js').write_text('shared\n')
        self.pulls = {}

    def git(self, *args, cwd=None):
        return subprocess.run(['git', *args], cwd=cwd or self.main, check=True, capture_output=True,
                              text=True).stdout.strip()

    def worktree(self, name, commits=0, base='origin/main'):
        path = self.tmp / 'wt' / name
        self.git('worktree', 'add', '--quiet', '-b', name, str(path), base)
        for i in range(commits):
            (path / f'{name}{i}.txt').write_text(f'{name} {i}\n')
            self.git('add', '.', cwd=path)
            self.git('commit', '--quiet', '-m', f'{name} {i}', cwd=path)
        return path

    def head(self, path):
        return self.git('rev-parse', 'HEAD', cwd=path)

    def run_gc(self, *args, min_age='0'):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = gc.main(['--repo', str(self.main), '--no-fetch', '--min-age', min_age, *args],
                           pr_lookup=lambda branch, cwd: self.pulls.get(branch, []))
        return code, out.getvalue(), err.getvalue()

    def row(self, out, name):
        return next(line for line in out.splitlines() if line.startswith(f'wt/{name} '))

    def branches(self):
        return self.git('branch', '--format=%(refname:short)').split()

    def test_dry_run_lists_every_worktree_and_changes_nothing(self):
        merged = self.worktree('merged')
        code, out, _ = self.run_gc()
        self.assertEqual(code, 0)
        self.assertIn('main checkout', out.splitlines()[1])
        self.assertIn('remove', self.row(out, 'merged'))
        self.assertIn('Dry run: nothing changed.', out)
        self.assertTrue(merged.is_dir())
        self.assertIn('merged', self.branches())

    def test_apply_removes_a_merged_worktree_and_its_branch_but_not_what_its_links_point_to(self):
        merged = self.worktree('merged', commits=1)
        self.git('push', '--quiet', 'origin', 'merged:main')
        self.git('fetch', '--quiet', 'origin')
        (merged / 'web').mkdir()
        os.symlink(self.main / 'web' / 'node_modules', merged / 'web' / 'node_modules')
        (merged / 'build' / 'exact').mkdir(parents=True)
        (merged / 'build' / 'exact' / 'out.bin').write_bytes(b'\0' * 4096)
        code, out, _ = self.run_gc('--apply')
        self.assertEqual(code, 0, out)
        self.assertFalse(merged.exists())
        self.assertNotIn('merged', self.branches())
        self.assertTrue((self.main / 'web' / 'node_modules' / 'dep.js').is_file())
        self.assertTrue(self.main.is_dir())
        self.assertEqual(len(self.git('worktree', 'list').splitlines()), 1)

    def test_a_dirty_worktree_is_removed_only_with_archive_and_its_changes_are_saved(self):
        dirty = self.worktree('dirty')
        (dirty / 'engine.c').write_text('int y;\n')
        (dirty / 'notes.txt').write_text('untracked work\n')
        code, out, _ = self.run_gc('--apply')
        self.assertEqual(code, 0)
        self.assertIn('2 uncommitted file(s)', self.row(out, 'dirty'))
        self.assertTrue(dirty.is_dir())
        code, out, _ = self.run_gc('--apply', '--archive')
        self.assertEqual(code, 0, out)
        self.assertFalse(dirty.exists())
        self.assertNotIn('dirty', self.branches())
        patch = self.main / 'build' / 'worktree-archive' / 'dirty.patch'
        text = patch.read_text()
        self.assertIn('+int y;', text)
        self.assertIn('+untracked work', text)
        self.git('apply', '--check', str(patch))  # the main checkout is at the same commit

    def test_unpreserved_commits_get_a_pushed_archive_tag_before_removal(self):
        local = self.worktree('local-work', commits=2)
        head = self.head(local)
        code, out, _ = self.run_gc('--apply')
        self.assertIn('commits not preserved', self.row(out, 'local-work'))
        self.assertTrue(local.is_dir())
        code, out, _ = self.run_gc('--apply', '--archive')
        self.assertEqual(code, 0, out)
        self.assertFalse(local.exists())
        self.assertNotIn('local-work', self.branches())
        remote = self.git('ls-remote', '--tags', str(self.origin), 'refs/tags/archive/wt-local-work^{}')
        self.assertEqual(remote.split()[0], head)

    def test_pull_requests_and_remote_branches(self):
        squashed = self.worktree('squashed', commits=1)
        later = self.worktree('later', commits=1)
        self.pulls['squashed'] = [{'number': 7, 'state': 'MERGED', 'headRefOid': self.head(squashed)}]
        self.pulls['later'] = [{'number': 8, 'state': 'CLOSED', 'headRefOid': self.head(later)}]
        (later / 'more.txt').write_text('more\n')
        self.git('add', '.', cwd=later)
        self.git('commit', '--quiet', '-m', 'after the pull request', cwd=later)
        opened = self.worktree('opened', commits=1)
        self.git('push', '--quiet', 'origin', 'opened')
        self.pulls['opened'] = [{'number': 9, 'state': 'OPEN', 'headRefOid': self.head(opened)}]
        pushed = self.worktree('pushed', commits=1)
        self.git('push', '--quiet', 'origin', 'pushed')
        code, out, _ = self.run_gc('--apply')
        self.assertEqual(code, 0, out)
        self.assertIn('PR #7 merged', out)
        self.assertFalse(squashed.exists())
        self.assertNotIn('squashed', self.branches())
        self.assertIn('commits after PR #8', self.row(out, 'later'))
        self.assertTrue(later.is_dir())
        self.assertIn('PR #9 open', self.row(out, 'opened'))
        self.assertTrue(opened.is_dir())
        self.assertIn('in origin/pushed', out)
        self.assertFalse(pushed.exists())

    def test_protected_worktrees_are_never_touched(self):
        listed = self.worktree('listed')
        flagged = self.worktree('flagged')
        (self.main / 'build').mkdir()
        (self.main / gc.KEEP_FILE).write_text('# served by a dev server\n../wt/listed\n')
        code, out, _ = self.run_gc('--apply', '--archive', '--keep', str(flagged))
        self.assertEqual(code, 0, out)
        self.assertIn('keep', self.row(out, 'listed'))
        self.assertIn('keep', self.row(out, 'flagged'))
        self.assertTrue(listed.is_dir() and flagged.is_dir() and self.main.is_dir())

    def test_a_recently_used_worktree_stays_unless_its_pull_request_is_done(self):
        fresh = self.worktree('fresh')
        done = self.worktree('done', commits=1)
        self.pulls['done'] = [{'number': 3, 'state': 'MERGED', 'headRefOid': self.head(done)}]
        code, out, _ = self.run_gc('--apply', min_age='24')
        self.assertEqual(code, 0, out)
        self.assertIn('used 0 h ago', self.row(out, 'fresh'))
        self.assertIn('then remove', self.row(out, 'fresh'))
        self.assertTrue(fresh.is_dir())
        self.assertFalse(done.exists())

    def test_clean_build_deletes_only_reproducible_outputs_of_worktrees_that_stay(self):
        staying = self.worktree('staying', commits=1)
        kept = self.worktree('kept', commits=1)
        for tree in (staying, kept):
            for d in gc.BUILD_OUTPUTS + ['build/listen']:
                (tree / d).mkdir(parents=True)
                (tree / d / 'f').write_bytes(b'\0' * 4096)
        code, out, _ = self.run_gc('--clean-build', '--keep', str(kept))
        self.assertTrue((staying / 'build' / 'exact').is_dir(), 'the dry run deleted something')
        code, out, _ = self.run_gc('--apply', '--clean-build', '--keep', str(kept))
        self.assertEqual(code, 0, out)
        self.assertTrue(staying.is_dir())
        for d in gc.BUILD_OUTPUTS:
            self.assertFalse((staying / d).exists(), d)
            self.assertTrue((kept / d).is_dir(), d)
        self.assertTrue((staying / 'build' / 'listen' / 'f').is_file())

    def test_without_gh_the_rest_still_works(self):
        merged = self.worktree('merged')
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = gc.main(['--repo', str(self.main), '--no-fetch', '--min-age', '0', '--apply'],
                           pr_lookup=lambda branch, cwd: None)
        self.assertEqual(code, 0)
        self.assertIn('gh could not list pull requests', err.getvalue())
        self.assertFalse(merged.exists())

    def test_a_missing_directory_is_pruned(self):
        gone = self.worktree('gone')
        subprocess.run(['rm', '-rf', str(gone)], check=True)
        code, out, _ = self.run_gc('--apply')
        self.assertEqual(code, 0, out)
        self.assertIn('directory missing', out)
        self.assertEqual(len(self.git('worktree', 'list').splitlines()), 1)
        self.assertNotIn('gone', self.branches())


if __name__ == '__main__':
    unittest.main()
