#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""Lists every git worktree of this repository and removes the ones whose work is kept elsewhere.

A worktree's commits are "preserved" when its HEAD is in origin/main, in a remote branch, in an archive/* tag, or in the
head of its branch's merged or closed pull request (GitHub keeps every pull request's head as refs/pull/N/head).

Never removed: the main checkout, a locked worktree, the paths listed in <main checkout>/build/worktree-keep.txt (one
path per line, absolute or relative to the main checkout; # starts a comment) or given with --keep PATH, a worktree whose
pull request is open, and a worktree used in the last --min-age hours (default 24) unless its pull request is merged or
closed. A worktree with uncommitted changes or untracked files is removed only with --archive.

Nothing changes without --apply:
  python3 tools/worktree_gc.py                    the table and the space each step would free (dry run)
  python3 tools/worktree_gc.py --apply            remove clean, preserved worktrees and their local branches, then prune
  ... --archive        also archive the rest first: an unpreserved branch gets an archive/wt-<branch> tag, pushed to
                       origin; a dirty worktree's changes (git diff HEAD, untracked files included) are written to
                       <main checkout>/build/worktree-archive/<name>.patch; with --apply they are then removed
  ... --clean-build    delete the reproducible outputs (build/exact, build/lanes, build/golden, tools/emu/target) of the
                       worktrees that stay, except protected and recently used ones
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
import datetime
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parent.parent
KEEP_FILE = 'build/worktree-keep.txt'
ARCHIVE_DIR = 'build/worktree-archive'
BUILD_OUTPUTS = ['build/exact', 'build/lanes', 'build/golden', 'tools/emu/target']
MAIN_REF = 'refs/remotes/origin/main'


@dataclass
class Tree:
    path: str
    head: str = ''
    branch: str = ''            # short branch name; empty when detached
    locked: bool = False
    missing: bool = False       # the directory is gone (git calls it prunable)
    main: bool = False
    size: int = 0               # bytes on disk
    build: int = 0              # bytes in BUILD_OUTPUTS
    dirty: list = field(default_factory=list)
    active: float = 0.0         # newest modification time seen (seconds since the epoch)
    preserved: str = ''         # where the commits are kept, empty when nowhere
    pr_done: bool = False       # preserved by a merged or closed pull request
    verdict: str = ''           # keep, remove or archive
    reason: str = ''
    protected: bool = False     # main checkout, keep list, --keep or locked: never touched
    recent: bool = False        # used within --min-age hours: may belong to an agent at work


def git(*args, cwd, env=None, check=True):
    r = subprocess.run(['git', *args], cwd=cwd, env=env, capture_output=True, text=True)
    if check and r.returncode:
        raise RuntimeError(f"git {' '.join(args)}: {r.stderr.strip()}")
    return r.stdout


def git_ok(*args, cwd):
    return subprocess.run(['git', *args], cwd=cwd, capture_output=True).returncode == 0


def gh_pulls(branch, cwd):
    """The branch's pull requests ({number, state, headRefOid}), or None when gh cannot answer."""
    try:
        r = subprocess.run(['gh', 'pr', 'list', '--head', branch, '--state', 'all', '--limit', '50',
                            '--json', 'number,state,headRefOid'], cwd=cwd, capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return json.loads(r.stdout) if r.returncode == 0 else None


def same_path(a, b):
    try:
        return os.path.samefile(a, b)
    except OSError:
        return os.path.normcase(os.path.realpath(a)) == os.path.normcase(os.path.realpath(b))


def disk_usage(path):
    """Bytes under path (du, which counts symlinks themselves and not what they point to)."""
    if not os.path.lexists(path):
        return 0
    r = subprocess.run(['du', '-sk', path], capture_output=True, text=True)
    try:
        return int(r.stdout.split()[0]) * 1024
    except (IndexError, ValueError):
        return 0


def human(n):
    return f'{n / 1e9:.1f} GB' if n >= 1e9 else f'{n / 1e6:.0f} MB'


def list_trees(repo):
    trees, cur = [], None
    for line in git('worktree', 'list', '--porcelain', cwd=repo).splitlines():
        key, _, value = line.partition(' ')
        if key == 'worktree':
            cur = Tree(path=value)
            trees.append(cur)
        elif cur is None:
            continue
        elif key == 'HEAD':
            cur.head = value
        elif key == 'branch':
            cur.branch = value.removeprefix('refs/heads/')
        elif key == 'locked':
            cur.locked = True
        elif key == 'prunable':
            cur.missing = True
    if trees:
        trees[0].main = True
    return trees


def keep_list(main, extra):
    paths = list(extra)
    f = Path(main) / KEEP_FILE
    if f.is_file():
        for line in f.read_text().splitlines():
            line = line.split('#', 1)[0].strip()
            if line:
                paths.append(line)
    return [os.path.join(main, os.path.expanduser(p)) for p in paths]


def admin_dirs(repo):
    """Worktree path -> its directory under .git/worktrees (HEAD, index and logs live there)."""
    common = Path(git('rev-parse', '--path-format=absolute', '--git-common-dir', cwd=repo).strip())
    out = {}
    for d in (common / 'worktrees').glob('*'):
        try:
            out[os.path.dirname((d / 'gitdir').read_text().strip())] = d
        except OSError:
            pass
    return out


def contains(repo, commit, ref):
    return git_ok('merge-base', '--is-ancestor', commit, ref, cwd=repo)


def preserving_refs(repo, commit):
    out = git('for-each-ref', '--contains', commit, '--format=%(refname)', 'refs/remotes', 'refs/tags/archive',
              cwd=repo, check=False).split()
    return [r for r in out if not r.endswith('/HEAD')]


def changed_files(path):
    """Tracked files with changes and untracked files that are not ignored."""
    # --no-optional-locks: a plain status rewrites the index, which would make every worktree look just used.
    entries = iter(git('--no-optional-locks', 'status', '--porcelain', '-z', '--untracked-files=all',
                       cwd=path).split('\0'))
    files = []
    for e in entries:
        if len(e) > 3:
            files.append(e[3:])
            if e[0] in 'RC':
                next(entries, None)  # a rename or copy is followed by its source path
    return files


def survey(repo, keep, min_age, pr_lookup, warn):
    trees = list_trees(repo)
    main = trees[0].path
    admin = admin_dirs(repo)
    keep_paths = keep_list(main, keep)
    have_main = git_ok('rev-parse', '--verify', '--quiet', MAIN_REF, cwd=repo)
    if not have_main:
        warn(f'{MAIN_REF} not found: no worktree counts as merged into main')
    now = time.time()
    gh_failed = False

    def measure(t):
        if not t.missing:
            t.size = disk_usage(t.path)
            t.build = sum(disk_usage(os.path.join(t.path, d)) for d in BUILD_OUTPUTS)
    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(measure, trees))

    for t in trees:
        if t.main:
            t.verdict, t.reason, t.protected = 'keep', 'main checkout', True
            continue
        if t.locked:
            t.verdict, t.reason, t.protected = 'keep', 'locked (git worktree unlock to release it)', True
            continue
        if any(same_path(t.path, k) for k in keep_paths):
            t.verdict, t.reason, t.protected = 'keep', f'listed in {KEEP_FILE} or --keep', True
            continue
        times = []
        d = admin.get(t.path)
        if d:
            # HEAD and its log change on checkout, commit and reset; the index also changes on any git status elsewhere.
            times += [os.path.getmtime(d / f) for f in ('HEAD', 'logs/HEAD') if (d / f).exists()]
        if not t.missing:
            t.dirty = changed_files(t.path)
            for f in t.dirty + ['build']:
                p = os.path.join(t.path, f)
                if os.path.lexists(p):
                    times.append(os.lstat(p).st_mtime)
        t.active = max(times, default=0.0)

        notes = []
        pulls = pr_lookup(t.branch, repo) if t.branch else []
        if pulls is None:
            pulls = []
            if not gh_failed:
                warn('gh could not list pull requests: open, merged and closed pull requests are not checked')
                gh_failed = True
        if t.head:
            if have_main and contains(repo, t.head, MAIN_REF):
                t.preserved = 'in origin/main'
            else:
                refs = preserving_refs(repo, t.head)
                if refs:
                    t.preserved = 'in ' + refs[0].removeprefix('refs/remotes/').removeprefix('refs/tags/')
            for p in sorted((p for p in pulls if p['state'] in ('MERGED', 'CLOSED')), key=lambda p: -p['number']):
                oid = p.get('headRefOid') or ''
                if oid == t.head or (git_ok('cat-file', '-e', oid + '^{commit}', cwd=repo) and contains(repo, t.head, oid)):
                    t.preserved, t.pr_done = f"PR #{p['number']} {p['state'].lower()}", True
                    break
                notes.append(f"commits after PR #{p['number']}")
                break
        open_pr = next((p for p in pulls if p['state'] == 'OPEN'), None)
        if t.preserved and not t.dirty:
            t.verdict, t.reason = 'remove', t.preserved
        else:
            t.verdict = 'archive'
            if t.preserved:
                notes.append(t.preserved)
            else:
                notes.insert(0, 'commits not preserved')
            if t.dirty:
                notes.insert(0, f'{len(t.dirty)} uncommitted file(s)')
            t.reason = '; '.join(notes)
        age = now - t.active
        if open_pr:
            t.verdict, t.reason = 'keep', f"PR #{open_pr['number']} open"
        elif not t.pr_done and age < min_age * 3600:
            t.reason = f'used {max(age, 0) / 3600:.0f} h ago (--min-age {min_age:g}), then {t.verdict}: {t.reason}'
            t.verdict, t.recent = 'keep', True
        if t.missing:
            t.reason += ' (directory missing)'
    return trees


def show(trees, main):
    base = os.path.dirname(main)
    rows = [('worktree', 'branch', 'size', 'build', 'state', 'verdict', 'reason')]
    for t in trees:
        name = os.path.relpath(t.path, base) if t.path.startswith(base + os.sep) else t.path
        state = 'missing' if t.missing else 'dirty' if t.dirty else 'clean'
        rows.append((name, t.branch or f'(detached {t.head[:8]})', human(t.size), human(t.build), state, t.verdict, t.reason))
    widths = [max(len(r[i]) for r in rows) for i in range(6)]
    for r in rows:
        print('  '.join(c.ljust(w) for c, w in zip(r, widths)) + '  ' + r[6])


def archive(t, repo, log):
    """Saves what only this worktree holds. Returns False when something could not be saved."""
    if not t.preserved:
        name = 'archive/wt-' + (t.branch or os.path.basename(t.path))
        if git_ok('rev-parse', '--verify', '--quiet', f'refs/tags/{name}', cwd=repo) or \
                not git_ok('check-ref-format', f'refs/tags/{name}', cwd=repo):
            name = f"archive/wt-{os.path.basename(t.path)}-{t.head[:8]}"
        msg = (f'Worktree {t.path} (branch {t.branch or "detached"}), archived by tools/worktree_gc.py '
               f'on {datetime.date.today().isoformat()}')
        try:
            git('tag', '-a', '-m', msg, name, t.head, cwd=repo)
        except RuntimeError as e:
            log(f'  could not archive {t.path}: {e}')
            return False
        try:
            git('push', '--quiet', 'origin', f'refs/tags/{name}:refs/tags/{name}', cwd=repo)
        except RuntimeError as e:
            git('tag', '-d', name, cwd=repo, check=False)  # an unpushed tag would count as preserved next time
            log(f'  could not archive {t.path}: {e}')
            return False
        t.preserved = f'in {name}'
        log(f'  tagged {t.head[:8]} as {name} and pushed it')
    if t.dirty and not t.missing:
        out = Path(repo) / ARCHIVE_DIR / (os.path.basename(t.path) + '.patch')
        if out.exists():
            out = out.with_name(f'{os.path.basename(t.path)}-{t.head[:8]}.patch')
        out.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory() as tmp:
            # A copy of the index so untracked files can be added without touching the worktree's own index.
            index = os.path.join(tmp, 'index')
            shutil.copyfile(git('rev-parse', '--path-format=absolute', '--git-path', 'index', cwd=t.path).strip(), index)
            env = {**os.environ, 'GIT_INDEX_FILE': index}
            try:
                git('add', '-A', cwd=t.path, env=env)
                diff = subprocess.run(['git', 'diff', '--cached', '--binary', 'HEAD'], cwd=t.path, env=env,
                                      capture_output=True, check=True).stdout
            except (RuntimeError, subprocess.CalledProcessError) as e:
                log(f'  could not save the changes of {t.path}: {e}')
                return False
        header = (f'Uncommitted changes of worktree {t.path} (branch {t.branch or "detached"}) on top of '
                  f'{t.head}, saved by tools/worktree_gc.py on {datetime.date.today().isoformat()}.\n'
                  f'Restore: git checkout {t.head} && git apply {out}\n\n')
        out.write_bytes(header.encode() + diff)
        log(f'  wrote its {len(t.dirty)} uncommitted file(s) to {out}')
    return True


def remove(t, repo, log):
    try:
        if t.missing:
            git('worktree', 'prune', cwd=repo)  # until then the branch counts as checked out
        else:
            git('worktree', 'remove', '--force', t.path, cwd=repo)
    except RuntimeError as e:
        log(f'  could not remove {t.path}: {e}')
        return False
    log(f'removed {t.path} ({human(t.size)})')
    if t.branch and t.preserved:
        if git_ok('branch', '-D', t.branch, cwd=repo):
            log(f'  deleted local branch {t.branch} ({t.preserved})')
    return True


def main(argv=None, pr_lookup=gh_pulls):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0], epilog=__doc__.split('\n', 2)[2],
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--apply', action='store_true', help='make the changes (default: dry run)')
    ap.add_argument('--archive', action='store_true', help='also archive and remove unpreserved or dirty worktrees')
    ap.add_argument('--clean-build', action='store_true', help='delete reproducible outputs in the worktrees that stay')
    ap.add_argument('--keep', action='append', default=[], metavar='PATH', help='never touch this worktree (repeatable)')
    ap.add_argument('--min-age', type=float, default=24, metavar='HOURS',
                    help='keep worktrees used more recently than this, unless their pull request is done (default 24)')
    ap.add_argument('--no-fetch', action='store_true', help='skip git fetch --prune origin')
    ap.add_argument('--repo', default=str(ROOT), help=argparse.SUPPRESS)
    args = ap.parse_args(argv)
    # Work from the main checkout: the worktree this script runs from may be one of those removed.
    repo = list_trees(args.repo)[0].path

    def warn(msg):
        print('warning: ' + msg, file=sys.stderr)

    if not args.no_fetch:
        r = subprocess.run(['git', 'fetch', '--prune', '--quiet', 'origin'], cwd=repo, capture_output=True, text=True)
        if r.returncode:
            if args.apply:
                print(f'git fetch failed, so remote branches may be stale; not changing anything '
                      f'(--no-fetch to use them anyway): {r.stderr.strip()}', file=sys.stderr)
                return 1
            warn('git fetch failed: remote branches may be stale')
    trees = survey(repo, args.keep, args.min_age, pr_lookup, warn)
    show(trees, repo)

    removable = [t for t in trees if t.verdict == 'remove']
    archivable = [t for t in trees if t.verdict == 'archive']
    gone = removable + (archivable if args.archive else [])
    cleanable = [t for t in trees if t not in gone and not t.protected and not t.recent and t.build]
    print()
    print(f'Removable now (--apply): {human(sum(t.size for t in removable))} in {len(removable)} worktree(s)')
    print(f'Removable after archiving (--apply --archive): {human(sum(t.size for t in archivable))} '
          f'in {len(archivable)} more worktree(s)')
    print(f'Reproducible outputs in worktrees that stay (--clean-build): {human(sum(t.build for t in cleanable))} '
          f'in {len(cleanable)} worktree(s)')
    if not args.apply:
        print('Dry run: nothing changed.')
        return 0

    failed = False
    for t in gone:
        if t.verdict == 'archive':
            print(f'archiving {t.path}')
            if not archive(t, repo, print):
                failed = True
                continue
        failed |= not remove(t, repo, print)
    git('worktree', 'prune', cwd=repo)
    if args.clean_build:
        for t in cleanable:
            for d in BUILD_OUTPUTS:
                p = os.path.join(t.path, d)
                if os.path.isdir(p) and not os.path.islink(p):
                    shutil.rmtree(p)
            print(f'deleted the reproducible outputs of {t.path} ({human(t.build)})')
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
