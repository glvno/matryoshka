#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""#824 offline allocation proof. Never writes production engine code or touches hardware.

The separate-buffer reference alone gets an extra 64 KiB of arena (-DENG_ARENA_EXTRA, a
build flag), so newly admitted patches have an independent non-sharing audio oracle.
Production memory constants and files are never changed by this runner.
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
    # The accounting variants build without the two-core schedule (-DENG_SCHED=0): their buffers are the one-core
    # allocation the editor counts. The *-sched variants are the default build (#802): a schedule takes more buffers only
    # while they and the lines fit, so they load whatever the editor admits and play the same audio.
    variants = {
        'baseline': ['-DENG_BUF_ACCOUNTING=0', '-DENG_SCHED=0'],
        'separate': ['-DENG_BUF_REUSE=0', '-DENG_SCHED=0'],
        'poison': ['-DENG_BUF_ACCOUNTING=0', '-DENG_POISON', '-DENG_SCHED=0'],
        'recovered': ['-DENG_SCHED=0'],
        'recovered-poison': ['-DENG_POISON', '-DENG_SCHED=0'],
        'recovered-sched': [],
        'recovered-sched-poison': ['-DENG_POISON'],
        'compiled': ['-DENG_AOT=1'],
        'reference': ['-DENG_ARENA_EXTRA=65536u', '-DENG_BUF_REUSE=0', '-DENG_SCHED=0'],
    }
    for name, flags in variants.items():
        run(['cc', '-O1', '-w', *flags, '-Ifirmware/src', 'firmware/test/buffer_budget.c',
             '-lm', '-lpthread', '-o', str(OUT / ('check-' + name))])
    for name, flags in [('default', []), ('legacy', ['-DENG_BUF_ACCOUNTING=0']), ('separate', ['-DENG_BUF_REUSE=0']), ('compiled', ['-DENG_AOT=1'])]:
        executable = OUT / ('info-' + name)
        run(['cc', '-O1', '-w', *flags, 'firmware/test/proto_test.c', '-lm', '-o', str(executable)])
        run([str(executable), '--allocation'])
    fixtures = json.loads((OUT / 'expected.json').read_text())
    report = []
    for fixture in fixtures:
        runs = {}
        for variant in variants:
            for cores in ([0, 1, 2] if variant in ('baseline', 'recovered', 'recovered-poison', 'recovered-sched', 'recovered-sched-poison', 'compiled') else [0]):
                name = f'{variant}-{cores}'
                env = dict(os.environ, HOST_CORES=str(cores), HOST_CHAOS='15')
                got = subprocess.run([str(OUT / ('check-' + variant)), str(OUT / fixture['file'])],
                                     env=env, capture_output=True, text=True)
                if fixture['name'] == 'recovered-lines' and not variant.startswith('recovered') and variant != 'reference':
                    assert got.returncode == 1 and 'failed: -4' in got.stderr, (name, got.stdout, got.stderr)
                    runs[name] = {'loadError': -4}
                    continue
                assert got.returncode == 0, (fixture['name'], name, got.stderr)
                result = json.loads(got.stdout)
                expected_physical = fixture['values'] if variant in ('separate', 'reference') or result['compiledGuard'] else fixture['physical']
                assert result['values'] == fixture['values'], (fixture['name'], name, 'values')
                free = fixture['sharedArenaBeforeLines'] if variant.startswith('recovered') else fixture['arenaBeforeLines']
                if variant == 'reference':
                    free += 65536
                if 'sched' in variant:
                    assert result['physical'] >= expected_physical, (fixture['name'], name, 'physical', result, fixture)
                    assert result['arenaBeforeLines'] == free - (result['physical'] - expected_physical) * 512, (fixture['name'], name, 'arena', result, free)
                else:
                    assert result['physical'] == expected_physical, (fixture['name'], name, 'physical', result, fixture)
                    assert result['arenaBeforeLines'] == free, (fixture['name'], name, 'arena', result, free)
                if variant == 'compiled':
                    assert result['lineArenaBytes'] == fixture['lineArenaBytes'], (fixture['name'], name, 'lines')
                    assert result['compiledScratchOffset'] + result['compiledScratchBytes'] <= free, (fixture['name'], name, 'compiled scratch')
                    if result['compiledScratchBytes']:
                        assert result['compiledScratchOffset'] == result['lineArenaBytes'] + result['compiledAlignmentBytes'], (fixture['name'], name, 'compiled placement')
                assert result['allocationRule'] == (1 if variant.startswith('recovered') else 0), (fixture['name'], name, 'rule')
                runs[name] = result
        if fixture['name'] == 'compiled-fallback':
            assert runs['compiled-0']['compiledGuard'] == 1 and runs['compiled-0']['compiledInstances'] == 0, runs
        comparisons = [r['audioHash'] for k, r in runs.items() if 'audioHash' in r]
        assert len(set(comparisons)) == 1, (fixture['name'], 'audio mismatch', runs)
        if fixture['name'] == 'recovered-lines':
            assert fixture['sharedLinesFit'] and fixture['over'] == ['memory'], fixture
            assert runs['recovered-0']['peak'] > 0, 'Recovered fixture must sound'
            # (its lines fit only beside the one-core allocation: the schedule gives way to it, #802)
            assert runs['recovered-sched-0']['physical'] == fixture['physical'], runs['recovered-sched-0']
        report.append(dict(fixture, runs=runs))
        print(f"{fixture['name']}: {fixture['values']} values / {fixture['physical']} physical; "
              f"{fixture['recoverableBytes']} B potentially recoverable", flush=True)
    (OUT / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
    assert any(x['runs']['compiled-0'].get('compiledGuard') for x in report), 'No compiled candidate covered'
    assert any(x['runs']['compiled-2'].get('compiledRendered') and x['runs']['compiled-2'].get('laneJobs') for x in report), 'No concurrent compiled execution covered'
    assert any(x['runs']['recovered-sched-2'].get('laneJobs', 0) for x in report), 'No concurrent-core work covered'
    assert any(x['runs']['recovered-sched-0']['physical'] > x['physical'] for x in report), 'No two-core schedule covered'
    print(f'{len(report)} fixtures: allocation parity and exact audio across separate/shared/recovered/poisoned buffers, '
          'the two-core schedule and host lanes.')
    print('CPU is an editor estimate only. No emulator, device timing, owner listening, or capacity approval.')


if __name__ == '__main__':
    main()
