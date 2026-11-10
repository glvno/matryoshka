#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""Prepare durable coverage display records under D-147; never qualify firmware.

produce: seal successful RC web coverage for upload.
prepare: deliberately retain a bundle under release/coverage/<version> before tagging.
install: validate that version's committed record and copy it into the web build.
"""
import argparse
import datetime
import hashlib
import json
import math
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
RECORDS = 'release/coverage/'


def git(repo, *args):
    return subprocess.check_output(['git', '-C', str(repo), *args])


def source_path(path):
    # Conservative on purpose: version stamping, dependencies, tests and CI config
    # count. Only documentation and the durable display records are excluded.
    return not (path.startswith(('docs/', RECORDS, '.agents/', '.claude/', '.codex/'))
                or ('/' not in path and path.endswith('.md')))


def fingerprint(repo, ref):
    entries = git(repo, 'ls-tree', '-rz', '--full-tree', ref).split(b'\0')
    source = [entry for entry in entries if entry and source_path(entry.split(b'\t', 1)[1].decode())]
    return hashlib.sha256(b'\0'.join(source)).hexdigest()


def sha(data):
    return hashlib.sha256(data).hexdigest()


def version(value):
    if not re.fullmatch(r'v\d+\.\d+\.\d+', value):
        raise ValueError('Use an exact release version such as v1.12.0.')
    return value


def validate_stats(stats):
    datetime.date.fromisoformat(stats['asOf'])
    for key in ('core', 'interface'):
        group = stats[key]
        pct, lines = group['pct'], group['lines']
        if (isinstance(pct, bool) or not isinstance(pct, (int, float)) or not math.isfinite(pct)
                or not 0 <= pct <= 100 or isinstance(lines, bool) or not isinstance(lines, int) or lines < 0):
            raise ValueError('Invalid coverage figures for ' + key)


def read_bundle(directory):
    try:
        data = (directory / 'coverage.json').read_bytes()
        manifest = json.loads((directory / 'manifest.json').read_text())
    except FileNotFoundError as error:
        raise ValueError('Coverage record missing. Prepare and commit release/coverage/<version>/ '
                         'with tools/coverage_record.py prepare; deployment does not run tests.') from error
    stats = json.loads(data)
    validate_stats(stats)
    if manifest.get('schema') != 1 or manifest.get('reportSha256') != sha(data):
        raise ValueError('Coverage report hash/schema does not match its manifest.')
    if manifest.get('measuredAt') != stats['asOf'] or manifest.get('qualification') != 'display-only':
        raise ValueError('Coverage date or display-only scope is inconsistent.')
    if not re.fullmatch(r'https://[^\s]+', manifest.get('sourceUrl', '')):
        raise ValueError('Coverage record needs its measurement source URL.')
    if not isinstance(manifest.get('measurementLabel'), str) or not manifest['measurementLabel'].strip():
        raise ValueError('Coverage record needs an explicit measurement label.')
    if manifest.get('display') not in ('current', 'historical'):
        raise ValueError('Coverage display must be current or explicitly historical.')
    legacy = manifest.get('legacySnapshot') is True
    if legacy:
        if manifest['display'] != 'historical' or manifest.get('sourceFingerprint') is not None:
            raise ValueError('Legacy snapshots are historical only; original test provenance is unknown.')
    elif (not re.fullmatch(r'[0-9a-f]{40}', manifest.get('measuredCommit', ''))
          or not re.fullmatch(r'[0-9a-f]{64}', manifest.get('sourceFingerprint', ''))):
        raise ValueError('Measured coverage needs an exact commit and source fingerprint.')
    return data, stats, manifest


def write_bundle(directory, data, manifest):
    directory.mkdir(parents=True, exist_ok=True)
    (directory / 'coverage.json').write_bytes(data)
    (directory / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')


def produce(repo, stats_path, output, run_url):
    changed = git(repo, 'diff', '--name-only', '-z', 'HEAD').decode().split('\0')
    if any(source_path(path) for path in changed if path):
        raise ValueError('Tracked source changed during qualification; cannot label coverage as the frozen source.')
    data = stats_path.read_bytes()
    stats = json.loads(data)
    validate_stats(stats)
    commit = git(repo, 'rev-parse', 'HEAD').decode().strip()
    manifest = dict(schema=1, reportSha256=sha(data), measuredAt=stats['asOf'], measuredCommit=commit,
                    sourceFingerprint=fingerprint(repo, commit), sourceUrl=run_url,
                    measurementLabel='candidate ' + commit[:8], targetRelease=None, display='current',
                    qualification='display-only',
                    instrumentation='All web tests except levels-1..4; those four pass separately without coverage.')
    write_bundle(output, data, manifest)
    read_bundle(output)


def prepare(repo, bundle, release, ref, historical=False):
    version(release)
    data, _, manifest = read_bundle(bundle)
    if historical:
        manifest['display'] = 'historical'
    else:
        if manifest['display'] != 'current' or manifest['sourceFingerprint'] != fingerprint(repo, ref):
            raise ValueError('Coverage is not current for this source. Supply the matching RC measurement '
                             'or deliberately prepare an identified historical record with --historical.')
        manifest['measurementLabel'] = release
    manifest['targetRelease'] = release
    output = repo / RECORDS / release
    write_bundle(output, data, manifest)
    print('Prepared', output, '(' + manifest['display'] + '; display only). Commit it before release.')


def install(repo, records, release, output):
    version(release)
    _, stats, manifest = read_bundle(records / release)
    if manifest.get('targetRelease') != release:
        raise ValueError('Coverage record targets another release; prepare this version explicitly.')
    if manifest['display'] == 'current' and manifest['sourceFingerprint'] != fingerprint(repo, 'HEAD'):
        raise ValueError('Coverage source differs from the deployed release. Prepare a matching or explicit historical record.')
    stats['measurement'] = {'label': manifest['measurementLabel'], 'historical': manifest['display'] == 'historical'}
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(stats, indent=2) + '\n')
    print('Coverage display:', manifest['measurementLabel'], '(' + manifest['display'] + '); no tests run.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', type=Path, default=ROOT)
    sub = parser.add_subparsers(dest='command', required=True)
    p = sub.add_parser('produce')
    p.add_argument('--stats', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--run-url', required=True)
    p = sub.add_parser('prepare')
    p.add_argument('--bundle', type=Path, required=True)
    p.add_argument('--release', required=True)
    p.add_argument('--ref', default='HEAD')
    p.add_argument('--historical', action='store_true')
    p = sub.add_parser('install')
    p.add_argument('--records', type=Path, required=True)
    p.add_argument('--release', required=True)
    p.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    try:
        if args.command == 'produce':
            produce(args.repo, args.stats, args.output, args.run_url)
        elif args.command == 'prepare':
            prepare(args.repo, args.bundle, args.release, args.ref, args.historical)
        else:
            install(args.repo, args.records, args.release, args.output)
    except (ValueError, KeyError, TypeError, OSError, subprocess.CalledProcessError) as error:
        parser.exit(1, 'Coverage preparation failed: ' + str(error) + '\n')


if __name__ == '__main__':
    main()
