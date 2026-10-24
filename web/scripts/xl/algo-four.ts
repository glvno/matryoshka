// SPDX-License-Identifier: GPL-3.0-only
// Algo Four XL: the Yamaha DX100 in full (Yamaha DX100 Owner's Manual: "up to 8 notes" in POLY mode, four operators,
// "8 algorithm choices", feedback 0..7 on operator 4 in every algorithm, an envelope per operator of AR, D1R, D1L, D2R
// and RR, one LFO with SAW UP / SQUARE / TRIANGLE / S/HOLD waves, a pitch depth (PMD) and an amplitude depth (AMD), the
// modulation wheel adding to them). The FM-1 version (gen-assemblies.ts, Algo Four) plays three voices, gives the two
// modulators ADSRs, keeps operator 4's feedback at 0 and wires one algorithm (5: 2 into 1, 4 into 3).
//
// The algorithms: an oscillator has one phase input, so each operator that can be modulated gets a Mixer 4 in front of
// it, and every path one of the eight algorithms uses is a row of the card (its mixer level): 2→1, 3→1, 4→1, 3→2, 4→2,
// 4→3. Which operators are heard is a second Mixer 4, one row per operator (out 1 .. out 4). An algorithm is a set of
// those rows at 1 (or 0); the module set has no selector that switches several levels with one control, so the eight
// algorithms are the table below, set by hand (the notes say the same). An operator's `level` row is its output level, as
// on the DX100: how loud a carrier is and how deep a modulator modulates.
//
//   algorithm  paths at 1          heard
//   1          4→3, 3→2, 2→1       1
//   2          3→2, 4→2, 2→1       1
//   3          3→2, 2→1, 4→1       1
//   4          4→3, 3→1, 2→1       1
//   5          2→1, 4→3            1, 3
//   6          4→1, 4→2, 4→3       1, 2, 3
//   7          4→3                 1, 2, 3
//   8          (none)              1, 2, 3, 4
//
// The envelope: the Env L/R module, its first level at the top (the DX100's attack always reaches the maximum): r1 = AR
// (the attack time), r2 = D1R and l2 = D1L, r3 = D2R towards l3 (0: the note decays while held, as a D2R above 0; l3 = l2
// holds it at D1L, as D2R 0), r4 = RR. The DX100's rates are speeds 0..31; here they are times.
// The LFO, once for all voices (as on the DX100): its pitch depth into every operator's fine tune, its amplitude depth into
// every operator's level (all four AM switches on), the wheel adding to the pitch depth.
import type { Patch } from '../../src/patch';
import { players, wire } from '../factory-build';
import { around, define, matchLevel } from './def';
import type { Xl } from './xl';

const NOTES = 'After the Yamaha DX100 Owner\'s Manual: 8 voices, 4 operators with their own envelope (r1 attack, r2 decay 1 ' +
  'to l2, r3 decay 2 to l3, r4 release), op 4 feedback, all 8 algorithms, an LFO (pmd, amd, wheel). Algorithm = rows at 1: ' +
  '1 4→3 3→2 2→1 out 1 / 2 3→2 4→2 2→1 out 1 / 3 3→2 2→1 4→1 out 1 / 4 4→3 3→1 2→1 out 1 / 5 2→1 4→3 out 1 3 / ' +
  '6 4→1 4→2 4→3 out 1 2 3 / 7 4→3 out 1 2 3 / 8 out 1 2 3 4.';

const built = define('Algo Four XL', (b) => {
  const lfo = b.add('lfo', 0, 0, { wave: 2, rate: 5.5, depth: 1 });
  const pmd = b.add('scale', 0, 1, { gain: 0, offset: 0 });
  const wheel = b.add('vca', 0, 1.25, { gain: 0.3 });
  const amd = b.add('scale', 0, 1.5, { gain: 0, offset: 0 });
  const part = b.add('alloc', 0, 2, { voices: 8 });
  // the FM-1 version's sound (algorithm 5), its modulators' envelopes as they were before they became ADSRs
  const setup: [Record<string, number>, Record<string, number>, number][] = [
    [{ wave: 0, level: 1, pm: 2.2 }, { l1: 1, r1: 0.002, l2: 0.6, r2: 1.2, l3: 0.35, r3: 1, l4: 0, r4: 0.5 }, 0.5],
    [{ wave: 0, level: 1, coarse: 12, pm: 1.5 }, { l1: 1, r1: 0.002, l2: 0.4, r2: 0.6, l3: 0.2, r3: 2, l4: 0, r4: 0.4 }, 0.8],
    [{ wave: 0, level: 1, pm: 1.5 }, { l1: 1, r1: 0.002, l2: 0.5, r2: 0.25, l3: 0, r3: 0.6, l4: 0, r4: 0.3 }, 0.35],
    [{ wave: 0, level: 1, coarse: 45, fine: 70, fb: 0.2 }, { l1: 1, r1: 0.001, l2: 0.2, r2: 0.12, l3: 0, r3: 0.3, l4: 0, r4: 0.2 }, 0.6],
  ];
  const op: number[] = [];
  const env: number[] = [];
  const vca: number[] = [];
  setup.forEach(([o, e, g], i) => {
    op.push(b.add('osc', 1 + i, 0, o));
    env.push(b.add('env', 1 + i, 1, e));
    vca.push(b.add('vca', 1 + i, 2, { gain: g }));
    b.pin(op[i], 'p1', 'fine');
    b.pin(vca[i], 'p1', 'gain');
  });
  // the paths: into operator 1 (from 2, 3, 4), into 2 (from 3, 4), into 3 (from 4); then who is heard
  const into1 = b.add('mixer', 1, 3, { l1: 1, l2: 0, l3: 0, l4: 0 });
  const into2 = b.add('mixer', 2, 3, { l1: 0, l2: 0, l3: 0, l4: 0 });
  const into3 = b.add('mixer', 3, 3, { l1: 1, l2: 0, l3: 0, l4: 0 });
  const out = b.add('mixer', 5, 0, { l1: 0.7, l2: 0, l3: 0.7, l4: 0 });
  const scope = b.add('scope', 6, 0, { time: 16 });
  b.nest('voice', 1, 4, [...op, ...env, ...vca, into1, into2, into3, out], {
    inputs: [['pitch', op[0], 'pitch'], ['gate', env[0], 'gate']],
    poly: { flaws: Array.from({ length: 8 }, () => ({ detune: 0, drift: 0, bright: 0, env: 0, level: 100 })) },
  });
  for (let i = 0; i < 4; i++) {
    b.wire(part, 'pitch', op[i], 'pitch');
    b.wire(part, 'gate', env[i], 'gate');
    b.wire(op[i], 'out', vca[i], 'in');
    b.wire(env[i], 'env', vca[i], 'cv');
    b.wire(pmd, 'out', op[i], 'p1');
    b.wire(amd, 'out', vca[i], 'p1');
    b.wire(vca[i], 'out', out, `in${i + 1}`);
  }
  b.wire(vca[1], 'out', into1, 'in1');
  b.wire(vca[2], 'out', into1, 'in2');
  b.wire(vca[3], 'out', into1, 'in3');
  b.wire(vca[2], 'out', into2, 'in1');
  b.wire(vca[3], 'out', into2, 'in2');
  b.wire(vca[3], 'out', into3, 'in1');
  b.wire(into1, 'out', op[0], 'pm');
  b.wire(into2, 'out', op[1], 'pm');
  b.wire(into3, 'out', op[2], 'pm');
  b.wire(lfo, 'out', pmd, 'in');
  b.wire(lfo, 'out', wheel, 'in');
  for (const o of op) b.wire(wheel, 'out', o, 'p1');
  b.wire(lfo, 'out', amd, 'in');
  b.wire(out, 'out', scope, 'a');
  b.input('keys', part, 'keys');
  b.input('wheel', wheel, 'cv');
  b.output('out', out, 'out');
  // the FM-1 version's rows first, in its order (the carrier mixes of algorithm 5 are out 1 and out 3)
  b.param('voices', part, 'voices', { head: 'voice' });
  b.param('feedback', op[3], 'fb');
  b.param('out 1', out, 'l1');
  b.param('out 3', out, 'l3');
  for (let i = 0; i < 4; i++) {
    const n = i + 1;
    b.param(`ratio ${n}`, op[i], 'coarse', { col: true, head: `operator ${n}` });
    b.param(`detune ${n}`, op[i], 'fine');
    b.param(`level ${n}`, vca[i], 'gain');
    if (i < 3) b.param(`index ${n}`, op[i], 'pm');
    b.param(`env ${n}`, env[i], 'view');
    for (const q of ['r1', 'l2', 'r2', 'r3', 'l3', 'r4']) b.param(`${q} ${n}`, env[i], q);
  }
  b.param('2→1', into1, 'l1', { col: true, head: 'algorithm' });
  b.param('3→1', into1, 'l2');
  b.param('4→1', into1, 'l3');
  b.param('3→2', into2, 'l1');
  b.param('4→2', into2, 'l2');
  b.param('4→3', into3, 'l1');
  b.param('out 2', out, 'l2');
  b.param('out 4', out, 'l4');
  b.param('lfo wave', lfo, 'wave', { col: true, head: 'lfo' });
  b.param('lfo speed', lfo, 'rate');
  b.param('pmd', pmd, 'gain');
  b.param('amd', amd, 'gain');
  b.param('wheel → pitch', wheel, 'gain');
  b.param('out', scope, 'view', { col: true });
});

export const xl: Xl = {
  base: 'Algo Four',
  build: (fm1: Patch): Patch => {
    const x = around('Algo Four', built);
    x.p.notes = NOTES;
    const wheel = x.a.inputs.find((r) => r.label === 'wheel')!;
    wire(x.p, x.main.id, 'mod', wheel.module, wheel.port);
    const p = players(x.p, true);
    matchLevel(p, fm1, [48, 55, 60, 64]);
    return p;
  },
};
