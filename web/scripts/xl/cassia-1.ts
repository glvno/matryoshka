// SPDX-License-Identifier: GPL-3.0-only
// Cassia 1 XL: the Casio CZ-1 closer to whole, after its operation manual. The FM-1 version (gen-assemblies.ts, Cassia 1)
// plays three voices, line 1 as phase distortion and line 2 as resonance only, with one DCA envelope, no pitch envelope,
// no ring or noise modulation and no vibrato delay.
//
// Here, eight voices (the CZ-1's eight in its single-line modes). Each line is either kind (`type`: 0 phase distortion,
// 1 resonance): phase distortion bends a sine's phase with a phase-locked saw (`wave` 0: the CZ saw, 12: the CZ square),
// resonance restarts a sine every cycle, raises its pitch by the DCW envelope and fades it by a window (`window` 0: the
// falling ramp of resonance waveform I, 1: the triangle of II). Each line has its DCW and DCA envelopes (Env L/R: three
// rate / level steps, the third held, and a release; the CZ has eight steps). Line 2 has its pitch offset (`line 2 pitch`,
// octaves: 1 = an octave, 0.01 about 12 cents of detune), ring modulation by line 1 and noise modulation. The DCO envelope
// moves both lines' pitch by `depth` octaves. Vibrato: its wave, rate, depth and a delay before it starts (an ADSR's
// attack per voice). Key follow lowers the DCWs (`dcw kf`) and the DCA levels (`dca kf`) on higher keys, from C4; the
// velocity opens the DCAs. Not here: the eight-step envelopes' sustain and end points, the 1 + 1' line mode, the CZ-1's
// aftertouch and its other waveforms (pulse, double sine, saw-pulse, resonance III).
import { type Patch } from '../../src/patch';
import { players } from '../factory-build';
import { around, define, matchLevel, type Def } from './def';
import type { Xl } from './xl';

const NOTES = 'After the Casio CZ-1 manual: two lines per voice, each phase distortion (saw, square) or resonance (ramp or ' +
  'triangle window), with its own DCW and DCA envelopes; a pitch envelope, line 2 detune, ring and noise modulation, vibrato ' +
  'with delay, key follow on DCW and DCA, velocity. Eight voices. The CZ\'s envelopes have eight steps, these three and a release.';

const built = define('Cassia 1 XL', (b: Def) => {
  const part = b.add('alloc', 0, 4, { voices: 8 });
  const lfo = b.add('lfo', 0, 0, { wave: 1, rate: 5.5, depth: 1 });
  const nz = b.add('noise', 0, 1, { level: 1, color: 0 });
  const scope = b.add('scope', 9, 0, { time: 16 });
  const members: number[] = [];
  const add = (type: string, col: number, row: number, p: Record<string, number> = {}): number => {
    const id = b.add(type, col, row, p);
    members.push(id);
    return id;
  };
  // per voice: the pitch (the DCO envelope added), vibrato after its delay, key follow
  const pitch = add('scale', 1, 0, { gain: 1, offset: 0 });
  const penv = add('env', 1, 0.5, { l1: 0, r1: 0.05, l2: 0, r2: 0.3, l3: 0, r3: 0.5, l4: 0, r4: 0.3 });
  const pdepth = add('scale', 1, 1, { gain: 1, offset: 0 });
  const vdel = add('adsr', 1, 1.5, { a: 0.6, d: 0.001, s: 1, r: 0.3 });
  const vib = add('vca', 1, 2, { gain: 0 });
  const kfw = add('scale', 1, 2.5, { gain: -0.15, offset: 0 });
  const kfa = add('scale', 1, 3, { gain: -0.1, offset: 0 });
  b.wire(part, 'pitch', pitch, 'in');
  b.wire(part, 'gate', penv, 'gate');
  b.wire(penv, 'env', pdepth, 'in');
  b.wire(pdepth, 'out', pitch, 'in');
  b.wire(part, 'gate', vdel, 'gate');
  b.wire(lfo, 'out', vib, 'in');
  b.wire(vdel, 'env', vib, 'cv');
  b.wire(vib, 'out', pitch, 'in');
  b.wire(part, 'pitch', kfw, 'in');
  b.wire(part, 'pitch', kfa, 'in');

  type Line = { type: number; wave: number; dcwDepth: number; range: number; window: number; dcw: number; dca: number; vca: number; out: number };
  /** a line: both kinds, crossfaded by `type`, then its DCA; `from` is the pitch it plays */
  const line = (col: number, from: number, dcw: Record<string, number>, dca: Record<string, number>): Line => {
    const car = add('osc', col, 0, { wave: 0, pm: Math.PI / 2, level: 1 });
    const mod = add('osc', col, 0.3, { wave: 2, level: 1 });
    const bend = add('math', col, 0.6, { ka: -1, kb: 1, off: 0 });
    const ramp = add('osc', col, 1, { wave: 2, level: 1 });
    const fall = add('math', col, 1.3, { ka: -0.5, kb: 1, off: 0.5 });
    const tri = add('math', col, 1.6, { ka: 1, kb: 1, off: 0 }); // |saw|: 1 - |saw| is the triangle window
    const triw = add('scale', col, 1.9, { gain: -1, offset: 1 });
    const window = add('xfade', col, 2.2, { mix: 0 });
    const rs = add('osc', col, 2.5, { wave: 0, level: 1 });
    const rise = add('scale', col, 2.8, { gain: 3, offset: 0 });
    const wvca = add('vca', col, 3.1, { gain: 1 });
    const kind = add('xfade', col, 3.4, { mix: 0 });
    const dcwEnv = add('env', col, 3.7, dcw);
    const dcaEnv = add('env', col, 4, dca);
    const vca = add('vca', col, 4.3, { gain: 0.15 });
    b.pin(vca, 'p1', 'gain');
    b.module(vca).att = [0.45, 1]; // velocity 1 reaches 0.6, as on the FM-1 version
    for (const o of [car, mod, ramp, rs]) b.wire(from, 'out', o, 'pitch');
    b.wire(part, 'gate', dcwEnv, 'gate');
    b.wire(part, 'gate', dcaEnv, 'gate');
    b.wire(dcwEnv, 'env', bend, 'a');
    b.wire(kfw, 'out', bend, 'a');
    b.wire(mod, 'out', bend, 'b');
    b.wire(bend, 'mul', car, 'pm');
    b.wire(ramp, 'out', fall, 'a');
    b.wire(ramp, 'out', tri, 'a');
    b.wire(tri, 'abs', triw, 'in');
    b.wire(fall, 'add', window, 'a');
    b.wire(triw, 'out', window, 'b');
    b.wire(fall, 'add', rs, 'sync');
    b.wire(window, 'out', wvca, 'cv');
    b.wire(dcwEnv, 'env', rise, 'in');
    b.wire(kfw, 'out', rise, 'in');
    b.wire(rise, 'out', rs, 'pitch');
    b.wire(rs, 'out', wvca, 'in');
    b.wire(car, 'out', kind, 'a');
    b.wire(wvca, 'out', kind, 'b');
    b.wire(dcaEnv, 'env', vca, 'cv');
    b.wire(part, 'vel', vca, 'p1');
    b.wire(kfa, 'out', vca, 'p1');
    return { type: kind, wave: mod, dcwDepth: car, range: rise, window, dcw: dcwEnv, dca: dcaEnv, vca, out: kind };
  };
  const l1 = line(2, pitch, { l1: 0.9, r1: 0.05, l2: 0.6, r2: 0.6, l3: 0.4, r3: 1.5, l4: 0, r4: 0.3 }, { l1: 1, r1: 0.01, l2: 0.8, r2: 0.4, l3: 0.6, r3: 2, l4: 0, r4: 0.4 });
  // line 2's pitch: line 1's plus its offset
  const det = add('scale', 4, 0, { gain: 1, offset: 0 });
  b.wire(pitch, 'out', det, 'in');
  const l2 = line(5, det, { l1: 0.7, r1: 0.1, l2: 0.4, r2: 0.8, l3: 0.25, r3: 2, l4: 0, r4: 0.3 }, { l1: 1, r1: 0.01, l2: 0.8, r2: 0.4, l3: 0.6, r3: 2, l4: 0, r4: 0.4 });
  b.module(l2.type).params.mix = 1; // line 2 starts as resonance
  // line 2's modulation, before its DCA: ring (times line 1's wave) and noise (times noise)
  const ring = add('math', 6, 0, { ka: 1, kb: 1, off: 0 });
  const ringX = add('xfade', 6, 0.5, { mix: 0 });
  const nmul = add('math', 6, 1, { ka: 1, kb: 1, off: 0 });
  const noiseX = add('xfade', 6, 1.5, { mix: 0 });
  b.wire(l1.out, 'out', ring, 'a');
  b.wire(l2.out, 'out', ring, 'b');
  b.wire(l2.out, 'out', ringX, 'a');
  b.wire(ring, 'mul', ringX, 'b');
  b.wire(nz, 'out', nmul, 'a');
  b.wire(ringX, 'out', nmul, 'b');
  b.wire(ringX, 'out', noiseX, 'a');
  b.wire(nmul, 'mul', noiseX, 'b');
  b.wire(l1.out, 'out', l1.vca, 'in');
  b.wire(noiseX, 'out', l2.vca, 'in');
  // the line select: 0 line 1, 0.5 both, 1 line 2
  const sel = add('xfade', 7, 0, { mix: 0.5 });
  b.wire(l1.vca, 'out', sel, 'a');
  b.wire(l2.vca, 'out', sel, 'b');
  b.wire(sel, 'out', scope, 'a');
  b.nest('voice', 2, 5, members, { poly: {} });
  b.input('keys', part, 'keys');
  b.output('out', sel, 'out');

  b.param('voices', part, 'voices', { head: 'voice' });
  b.param('line', sel, 'mix');
  b.param('line 2 pitch', det, 'offset');
  b.param('vib wave', lfo, 'wave', { head: 'vibrato' });
  b.param('vib rate', lfo, 'rate');
  b.param('vib depth', vib, 'gain');
  b.param('vib delay', vdel, 'a');
  b.param('dco env', penv, 'view', { head: 'dco env' });
  b.param('depth', pdepth, 'gain');
  for (const [lbl, q] of [['rate 1', 'r1'], ['level 1', 'l1'], ['rate 2', 'r2'], ['level 2', 'l2'], ['rate 3', 'r3'], ['sustain', 'l3'], ['release', 'r4']]) b.param(lbl, penv, q);
  b.param('dcw kf', kfw, 'gain', { head: 'key follow' });
  b.param('dca kf', kfa, 'gain');
  const envRows = (e: number, head: string): void => {
    b.param(head, e, 'view', { head, col: true });
    for (const [lbl, q] of [['rate 1', 'r1'], ['level 1', 'l1'], ['rate 2', 'r2'], ['level 2', 'l2'], ['rate 3', 'r3'], ['sustain', 'l3'], ['release', 'r4']]) b.param(lbl, e, q);
  };
  for (const [n, l] of [[1, l1], [2, l2]] as const) {
    b.param('type', l.type, 'mix', { head: `line ${n}`, col: true });
    b.param('wave', l.wave, 'coarse');
    b.param('dcw', l.dcwDepth, 'pm');
    b.param('res range', l.range, 'gain');
    b.param('window', l.window, 'mix');
    if (n === 2) {
      b.param('ring', ringX, 'mix');
      b.param('noise', noiseX, 'mix');
    }
    envRows(l.dcw, `dcw ${n}`);
    envRows(l.dca, `dca ${n}`);
  }
  b.param('out', scope, 'view', { col: true });
});

export const xl: Xl = {
  base: 'Cassia 1',
  build: (fm1: Patch): Patch => {
    const x = around('Cassia 1', built);
    x.p.notes = NOTES;
    const q = players(x.p, true);
    matchLevel(q, fm1, [48, 55, 60, 64]);
    return q;
  },
};
