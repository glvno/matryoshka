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


def execute(plan_path, area):
    chosen = json.loads(plan_path.read_text())
    if chosen['commit'] != git('rev-parse', 'HEAD'):
        raise ValueError('Check plan belongs to a different commit; regenerate it.')
    config = json.loads(CONFIG.read_text())
    if area == 'firmware':
        for check in chosen['host']:
            print('host check:', check, flush=True)
            subprocess.run(config['host_commands'][check], cwd=ROOT, check=True)
    elif chosen['mode'] == 'rc':
        # Disjoint groups: coverage does not instrument the slow loudness renders.
        # Every web test runs once, and stats are produced only if both groups pass.
        subprocess.run(['npx', '--no-install', 'vitest', 'run', '--testTimeout=60000', '--coverage',
                        '--coverage.reporter=json-summary', '--coverage.reporter=text-summary',
                        '--coverage.include=src/**', '--exclude', 'src/levels-*.test.ts'],
                       cwd=ROOT / 'web', check=True)
        levels = sorted((ROOT / 'web/src').glob('levels-*.test.ts'))
        if not levels:
            raise ValueError('Expected the uninstrumented loudness test group; no coverage bundle will be produced.')
        subprocess.run(['npx', '--no-install', 'vitest', 'run',
                        *[str(p.relative_to(ROOT / 'web')) for p in levels]], cwd=ROOT / 'web', check=True)
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
    args = parser.parse_args()
    try:
        if args.action == 'run':
            execute(args.file, args.area)
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
