#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""Select CI checks by changed domain under D-102 and D-144.

A path no rule names never fails planning: a firmware path runs the full host
suite, a web path runs its companion test if it has one. Rules marked `manual`
add a review note for the pull request; they are not an automated pass.
This selector records scope, not release qualification or artifact provenance.
"""
import argparse
import fnmatch
import json
import os
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
CONFIG = ROOT / 'tools/ci_checks.json'
# web tests a release-candidate run keeps out of coverage (D-147): renders too slow to pass their limits instrumented
SLOW_RENDERS = ('src/levels-*.test.ts', 'src/headroom-*.test.ts', 'src/kit909.test.ts', 'src/shared-levels.test.ts',
                'scripts/audition-render.test.ts', 'scripts/quiet-load.test.ts')
# Their seconds on a 4-vCPU runner, uninstrumented (web run 43906880954, release candidate 1.18.0; the loudness parts as
# dealt by measured cost since, `levelsPart` in web/src/levels.ts: about a sixth of their 1,700 s each). Only the deal
# over the RC run's parallel jobs uses them (`slow_part`): a file not listed counts as the median of those listed.
SLOW_RENDER_SECONDS = {
    'src/levels-1.test.ts': 285, 'src/levels-2.test.ts': 285, 'src/levels-3.test.ts': 285, 'src/levels-4.test.ts': 285,
    'src/levels-5.test.ts': 285, 'src/levels-6.test.ts': 285, 'src/headroom-1.test.ts': 421, 'src/headroom-2.test.ts': 246,
    'src/headroom-3.test.ts': 152, 'src/headroom-4.test.ts': 52, 'src/kit909.test.ts': 13, 'src/shared-levels.test.ts': 546,
    'scripts/audition-render.test.ts': 578,
    # (estimated: 64 s on an M-series Mac, about twice that on the runner, until a release candidate's run measures it)
    'scripts/quiet-load.test.ts': 130,
}


def slow_renders(root):
    return sorted(p.relative_to(root / 'web').as_posix() for g in SLOW_RENDERS for p in (root / 'web').glob(g))


def slow_part(files, part, parts, seconds=SLOW_RENDER_SECONDS):
    """The files of part `part` (1..parts) of the slow renders: the longest first, each onto the part with the least
    time so far, so the RC run's parallel jobs end close together. Each file is in exactly one part."""
    if not 1 <= part <= parts:
        raise ValueError(f'part {part} of {parts}: parts count from 1')
    known = sorted(seconds[f] for f in files if f in seconds)
    median = known[len(known) // 2] if known else 1
    loads = [[0, []] for _ in range(parts)]
    for f in sorted(files, key=lambda f: (-seconds.get(f, median), f)):
        least = min(loads, key=lambda load: load[0])
        least[0] += seconds.get(f, median)
        least[1].append(f)
    return sorted(loads[part - 1][1])


def git(*args, root=ROOT):
    return subprocess.check_output(['git', *args], cwd=root).decode().strip()


def changed_paths(base, head='HEAD', merge_base=False, root=ROOT):
    """Keep both sides of renames and deleted paths for domain selection."""
    base = git('rev-parse', '--verify', '--end-of-options', base + '^{commit}', root=root)
    if merge_base:
        base = git('merge-base', base, head, root=root)
    raw = subprocess.check_output(
        ['git', 'diff', '--name-status', '-z', '--find-renames', base, head, '--'], cwd=root
    ).decode().split('\0')
    paths = set()
    i = 0
    while i < len(raw) and raw[i]:
        status = raw[i]
        count = 2 if status[0] in 'RC' else 1
        paths.update(raw[i + 1:i + 1 + count])
        i += 1 + count
    return sorted(paths)


def matches(path, patterns):
    return any(fnmatch.fnmatchcase(path, pattern) for pattern in patterns)


def applicable_host(checks, config, root):
    # This branch can precede the USB-return feature. Once its source exists,
    # its regression is mandatory; a missing runner then fails normally.
    return {name for name in checks if name not in config.get('optional_host', {})
            or (root / config['optional_host'][name]).is_file()}


def select(paths, config, area, root=ROOT):
    host, web, explanations = set(), set(), {}
    firmware = any(matches(p, config['firmware_paths']) for p in paths)
    for path in paths:
        relevant = (matches(path, config['firmware_paths']) if area == 'firmware'
                    else path.startswith(('web/', 'firmware/', 'release/coverage/'))
                    or path.startswith(('tools/ci_checks', 'tools/coverage_record'))
                    or path.startswith('.github/workflows/'))
        if not relevant:
            explanations[path] = ['outside this CI area']
            continue
        rules = [r for r in config['rules'] if matches(path, r['paths'])]
        reasons = [r['name'] for r in rules]
        for rule in rules:
            if rule.get('manual'):
                reasons.append('MANUAL REVIEW (not an automated pass): ' + rule['manual'])
            host.update(rule['host'])
            web.update(rule['web'])
        # Companion tests are an explicit local domain, including changed test files.
        if path.startswith('web/'):
            source = Path(path)
            tests = [source] if '.test.' in source.name else [
                source.with_name(source.stem + '.test' + source.suffix)]
            for test in tests:
                if (root / test).is_file() and '.test.' in test.name:
                    web.add(test.as_posix())
                    reasons.append('companion test: ' + test.as_posix())
        if matches(path, config['non_runtime']):
            reasons.append('non-runtime documentation or asset; build checks still apply')
        if not reasons:
            # No rule names this path: run more rather than fail planning.
            if area == 'firmware':
                host.update(config['full_host'])
                reasons.append('no rule: the full host suite')
            else:
                reasons.append('no rule and no companion test: build checks only')
        explanations[path] = reasons
    host = applicable_host(host, config, root)
    missing_tests = sorted(p for p in web if not (root / p).is_file())
    if missing_tests:
        raise ValueError('test-plan rule names missing tests: ' + ', '.join(missing_tests))
    return {'firmware': firmware, 'host': sorted(host), 'web': sorted(web), 'reasons': explanations}


def event_scope(event_name, event, head, root=ROOT):
    inputs = event.get('inputs') or {}
    mode = inputs.get('mode', 'targeted') if event_name == 'workflow_dispatch' else 'targeted'
    if mode == 'rc':
        frozen = inputs.get('rc_sha', '')
        if not re.fullmatch(r'[0-9a-f]{40}', frozen) or frozen != head:
            raise ValueError('RC mode requires rc_sha to be the exact checked-out 40-character commit.')
        return mode, []
    if mode == 'package':
        return mode, []
    if mode != 'targeted':
        raise ValueError('unknown check mode: ' + mode)
    if event_name == 'pull_request':
        return mode, changed_paths(event['pull_request']['base']['sha'], merge_base=True, root=root)
    if event_name == 'push':
        base = event.get('before', '')
        if not base or set(base) == {'0'}:
            raise ValueError('TEST PLAN REQUIRED: push has no comparison commit; dispatch targeted mode with base.')
        return mode, changed_paths(base, root=root)
    if event_name == 'workflow_dispatch':
        base = inputs.get('base', '')
        if not base:
            raise ValueError('Targeted dispatch requires an explicit base commit or ref.')
        return mode, changed_paths(base, merge_base=True, root=root)
    raise ValueError('unsupported event: ' + event_name)


def plan(area, allow_package=False, root=ROOT):
    config = json.loads((root / 'tools/ci_checks.json').read_text())
    event = json.loads(Path(os.environ['GITHUB_EVENT_PATH']).read_text())
    head = git('rev-parse', 'HEAD', root=root)
    mode, paths = event_scope(os.environ['GITHUB_EVENT_NAME'], event, head, root=root)
    if mode == 'package' and not allow_package:
        raise ValueError('Package-only mode belongs to the release packaging workflow.')
    selected = select(paths, config, area, root=root) if mode == 'targeted' else {
        'firmware': True, 'host': sorted(applicable_host(config['full_host'], config, root)) if mode == 'rc' else [],
        'web': [], 'reasons': {}}
    return dict(selected, mode=mode, commit=head, changed=paths, area=area)


def execute(plan_path, area, group=None, part=None):
    """Run the plan. A release candidate's web tests are two disjoint groups (D-147): `group` 'coverage' runs every web
    test but the slow renders, with coverage, then the display stats; 'slow' runs the slow renders uninstrumented, only
    part `part` = (k, n) of them when given (`slow_part`). The RC workflow runs the groups as parallel jobs and seals
    the coverage record only after all of them pass. Without `group` both run here, one after the other, and the stats
    come only after both pass."""
    chosen = json.loads(plan_path.read_text())
    if chosen['commit'] != git('rev-parse', 'HEAD'):
        raise ValueError('Check plan belongs to a different commit; regenerate it.')
    if (group or part) and (area != 'web' or chosen['mode'] != 'rc'):
        raise ValueError('--group and --part are for a release candidate\'s web tests.')
    if part and group != 'slow':
        raise ValueError('--part goes with --group slow.')
    config = json.loads(CONFIG.read_text())
    if area == 'firmware':
        for check in chosen['host']:
            print('host check:', check, flush=True)
            subprocess.run(config['host_commands'][check], cwd=ROOT, check=True)
    elif chosen['mode'] == 'rc':
        # Disjoint groups: coverage does not instrument the slow renders (loudness, headroom, the XL comparison),
        # which pass their time limits only uninstrumented. Every web test runs once.
        slow = slow_renders(ROOT)
        if not any(p.startswith('src/levels-') for p in slow):
            raise ValueError('Expected the uninstrumented loudness test group; no coverage bundle will be produced.')
        if group in (None, 'coverage'):
            subprocess.run(['npx', '--no-install', 'vitest', 'run', '--testTimeout=60000', '--coverage',
                            '--coverage.reporter=json-summary', '--coverage.reporter=text-summary',
                            '--coverage.include=src/**', *[a for g in SLOW_RENDERS for a in ('--exclude', g)]],
                           cwd=ROOT / 'web', check=True)
        if group in (None, 'slow'):
            files = slow_part(slow, *part) if part else slow
            print('slow renders' + (f', part {part[0]} of {part[1]}' if part else '') + ':', ' '.join(files) or 'none', flush=True)
            if files:
                subprocess.run(['npx', '--no-install', 'vitest', 'run', *files], cwd=ROOT / 'web', check=True)
        if group in (None, 'coverage'):
            subprocess.run(['npx', '--no-install', 'vite-node', 'scripts/coverage-stats.ts'], cwd=ROOT / 'web', check=True)
    elif chosen['web']:
        subprocess.run(['npx', '--no-install', 'vitest', 'run',
                        *[str(Path(p).relative_to('web')) for p in chosen['web']]], cwd=ROOT / 'web', check=True)
    else:
        print('No automatic runtime tests selected for this area; review the path reasons and any manual plans.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['plan', 'run'])
    parser.add_argument('--area', choices=['firmware', 'web'], required=True)
    parser.add_argument('--file', type=Path, default=ROOT / 'build/ci-plan.json')
    parser.add_argument('--allow-package', action='store_true')
    parser.add_argument('--group', choices=['coverage', 'slow'], help="a release candidate's web group (D-147)")
    parser.add_argument('--part', help='K/N: part K of N of the slow renders (with --group slow)')
    args = parser.parse_args()
    try:
        if args.action == 'run':
            m = re.fullmatch(r'(\d+)/(\d+)', args.part or '')
            if args.part and not m:
                raise ValueError(f'--part {args.part}: K/N')
            execute(args.file, args.area, args.group, (int(m[1]), int(m[2])) if m else None)
            return
        chosen = plan(args.area, args.allow_package)
        args.file.parent.mkdir(parents=True, exist_ok=True)
        args.file.write_text(json.dumps(chosen, indent=2) + '\n')
        print(args.file.read_text())
        if os.environ.get('GITHUB_OUTPUT'):
            with open(os.environ['GITHUB_OUTPUT'], 'a') as out:
                out.write('firmware=' + str(chosen['firmware']).lower() + '\n')
                out.write('coverage_record=' + str('coverage-record' in chosen['host']).lower() + '\n')
        if os.environ.get('GITHUB_STEP_SUMMARY'):
            with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as out:
                out.write('### Check scope: ' + chosen['mode'] + '\n\nCommit: `' + chosen['commit']
                          + '`\n\n```json\n' + json.dumps(chosen, indent=2) + '\n```\n')
                if chosen['mode'] == 'package':
                    out.write('Package build only: this run establishes no test qualification or inherited evidence.\n')
    except (ValueError, KeyError, subprocess.CalledProcessError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
