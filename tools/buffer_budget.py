#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""#824 offline allocation proof. Never writes production engine code or touches hardware.

The recovered variant removes only the existing reservation for unused physical buffers
from a build-directory copy of engine.c. It is an experiment, not a firmware artifact.
"""
import json
import os
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'build/buffer-budget'


def run(args, **kwargs):
    return subprocess.run(args, cwd=kwargs.pop('cwd', ROOT), check=True, text=True, **kwargs)


def main():
    run(['npx', 'vite-node', 'scripts/buffer-budget.ts'], cwd=ROOT / 'web')
    source = (ROOT / 'firmware/src/engine.c').read_text()
    reservation = 'if (bs.values > bs.n && !arena_lo((bs.values - bs.n) * ENG_BUF_BYTES))'
    if source.count(reservation) != 1:
        raise RuntimeError('Allocator changed: review the recovered experiment before running it')
    recovered = OUT / 'recovered-src'
    recovered.mkdir(exist_ok=True)
    (recovered / 'engine.c').write_text(source.replace(reservation, 'if (0) /* #824 host experiment: charge physical buffers only */'))
    variants = {
        'baseline': [],
        'separate': ['-DENG_BUF_REUSE=0'],
        'poison': ['-DENG_POISON'],
        'recovered': ['-I' + str(recovered)],
        'recovered-poison': ['-I' + str(recovered), '-DENG_POISON'],
        'compiled': ['-DENG_AOT=1'],
    }
    for name, flags in variants.items():
        run(['cc', '-O1', '-w', *flags, '-Ifirmware/src', 'firmware/test/buffer_budget.c',
             '-lm', '-lpthread', '-o', str(OUT / ('check-' + name))])
    fixtures = json.loads((OUT / 'expected.json').read_text())
    report = []
    for fixture in fixtures:
        runs = {}
        for variant in variants:
            for cores in ([0, 1, 2] if variant in ('baseline', 'recovered', 'recovered-poison', 'compiled') else [0]):
                name = f'{variant}-{cores}'
                env = dict(os.environ, HOST_CORES=str(cores), HOST_CHAOS='15')
                got = subprocess.run([str(OUT / ('check-' + variant)), str(OUT / fixture['file'])],
                                     env=env, capture_output=True, text=True)
                if fixture['name'] == 'recovered-lines' and not variant.startswith('recovered'):
                    assert got.returncode == 1 and 'failed: -4' in got.stderr, (name, got.stdout, got.stderr)
                    runs[name] = {'loadError': -4}
                    continue
                assert got.returncode == 0, (fixture['name'], name, got.stderr)
                result = json.loads(got.stdout)
                expected_physical = fixture['values'] if variant == 'separate' or result['compiledGuard'] else fixture['physical']
                assert result['values'] == fixture['values'], (fixture['name'], name, 'values')
                assert result['physical'] == expected_physical, (fixture['name'], name, 'physical', result, fixture)
                if variant != 'compiled':  # compiled state is allocated after the lines
                    free = fixture['arenaBeforeLines'] + (fixture['recoverableBytes'] if variant.startswith('recovered') else 0)
                    assert result['arenaBeforeLines'] == free, (fixture['name'], name, 'arena', result, free)
                runs[name] = result
        if fixture['name'] == 'compiled-fallback':
            assert runs['compiled-0']['compiledGuard'] == 1 and runs['compiled-0']['compiledInstances'] == 0, runs
        comparisons = [r['audioHash'] for k, r in runs.items() if 'audioHash' in r]
        assert len(set(comparisons)) == 1, (fixture['name'], 'audio mismatch', runs)
        if fixture['name'] == 'recovered-lines':
            assert fixture['sharedLinesFit'] and fixture['over'] == ['memory'], fixture
            assert runs['recovered-0']['peak'] > 0, 'Recovered fixture must sound'
        report.append(dict(fixture, runs=runs))
        print(f"{fixture['name']}: {fixture['values']} values / {fixture['physical']} physical; "
              f"{fixture['recoverableBytes']} B potentially recoverable", flush=True)
    (OUT / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
    assert any(x['runs']['compiled-0'].get('compiledGuard') for x in report), 'No compiled candidate covered'
    assert any(x['runs']['compiled-2'].get('compiledRendered') and x['runs']['compiled-2'].get('laneJobs') for x in report), 'No concurrent compiled execution covered'
    assert any(x['runs']['baseline-2'].get('laneJobs', 0) for x in report), 'No concurrent-core work covered'
    print(f'{len(report)} fixtures: allocation parity and exact audio across separate/shared/recovered/poisoned buffers and host lanes.')
    print('CPU is an editor estimate only. No emulator, device timing, owner listening, or capacity approval.')


if __name__ == '__main__':
    main()
