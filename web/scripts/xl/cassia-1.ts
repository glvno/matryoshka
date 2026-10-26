// SPDX-License-Identifier: GPL-3.0-only
// Cassia 1 XL: the Casio CZ-1 in full, after its operation manual and the CZ-101's (waveforms, line select, DCO / DCW /
// DCA envelopes, key follow, vibrato, ring and noise modulation, velocity and aftertouch). The FM-1 version
// (gen-assemblies.ts, Cassia 1) plays three voices, line 1 as two of the phase distortion waveforms and line 2 as
// resonance I only, with one DCA envelope.
//
// Four voices, as the CZ-1 with two lines; with one line (`line` 0 or 1) the CZ-1 plays eight, and so may this (`voices`;
// both lines still run, so eight cost twice four: about 80 % of real time on a recent Mac, four about 40 %). Each voice
// has both lines; in the 1 + 1' mode line 2 takes line 1's settings and envelopes (line 1' at line 2's pitch). A line is
// one cycle of the note at a time:
//  - the phase ramp: a triangle and a sine an octave down, both locked to the note. The sine's sign says which of two
//    cycles is playing; the triangle, flipped on the odd cycle, is a clean ramp from 0 to 1 per cycle (a saw's corrected
//    edge would put a click into the bend).
//  - phase distortion: the CZ reads a sine with its phase bent. Each of the five bends is written as the bent phase
//    minus the ramp, a sum of hinges of the ramp (Math max / min), at the CZ's full DCW: saw (half the sine in 7/8 of the
//    cycle, the rest in 1/8), square (the sine held at its peak and trough), pulse (the whole sine in the first 1/8, then
//    held), double sine (each half of the cycle bent as the saw) and saw-pulse (the saw's bend in the first half, then
//    held). The DCW envelope scales the bend: at 0 a sine, at 1 the full shape. The bend goes into a sine's phase input
//    at 2 pi, so it is in cycles.
//  - resonance: a sine restarted each cycle, its pitch raised by the DCW envelope (up to `res range` octaves), faded by
//    a window: falling ramp (resonance I, `window` 0), triangle (II, 1) or trapezoid (III, 2).
//  - the two waveforms: `type` is the first one's kind (0 phase distortion, 1 resonance), `wave` its bend (0 saw,
//    1 square, 2 pulse, 3 double sine, 4 saw-pulse). With `2nd` on, every other cycle plays the second one (`2nd type`,
//    `wave 2`; a resonance second uses the line's `window`), as on the CZ, which halves the period. The CZ cannot pair
//    two resonance waveforms, so the line has one window.
// The envelopes (DCO, and each line's DCW and DCA): six steps, three up to the sustain (an Env L/R held at `sustain`)
// and three after the key is let go (a second Env L/R, started by the release; its levels are fractions of the level
// the first one had at the release, which a sample and hold keeps). The CZ has eight steps and moves the sustain and the
// end to any of them: that needs an eight-step envelope module, in both engines.
// Line select (`line`): 0 line 1, 0.5 both, 1 line 2; `1+1'` swaps line 2 for line 1' (line 2's pitch offset still
// applies: `line 2 pitch`, octaves, 0.01 about 12 cents). Line 2's ring (times line 1) and noise modulation; the DCO
// envelope by `depth` octaves; vibrato's wave (the CZ's saw down is a negative `vib depth`), rate, depth and delay; key
// follow lowers the DCW and DCA levels from C4; velocity opens the DCA (and the DCW by `vel dcw`); aftertouch reaches
// DCW, DCA and vibrato depth.
import { DEFS } from '../../src/modules';
import { connect, type Patch } from '../../src/patch';
import { players } from '../factory-build';
import { around, define, matchLevel, type Def } from './def';
import type { Xl } from './xl';

const NOTES = 'After the Casio CZ-1 manual: 4 voices (8 with one line), two lines (1, 1 + 2, 2, 1 + 1\'), all eight waveforms (saw, ' +
  'square, pulse, double sine, saw-pulse; resonance I, II, III) and a second one on every other cycle, DCO, DCW and DCA ' +
  'envelopes of six steps (three to the sustain, three after it), key follow, velocity, aftertouch, vibrato with delay, ' +
  'ring and noise modulation. Waveforms: type 0 phase distortion (wave 0 saw .. 4 saw-pulse) or 1 resonance (window 0 I .. 2 III). ' +
  'The CZ\'s envelopes have eight steps.';

type Ref = [number, string];

/** the bends at full DCW: bent phase minus the ramp u, as a start slope and its changes at points of u (cycles) */
const BENDS: { s0: number; at: [number, number][] }[] = [
  { s0: -3 / 7, at: [[0.875, 24 / 7]] }, // saw
  { s0: 1, at: [[0.125, -2], [0.375, 2], [0.625, -2], [0.875, 2]] }, // square
  { s0: 7, at: [[0.125, -8]] }, // pulse
  { s0: -3 / 7, at: [[0.4375, 24 / 7], [0.5, -24 / 7], [0.9375, 24 / 7]] }, // double sine
  { s0: 1 / 7, at: [[0.4375, 48 / 7], [0.5, -8]] }, // saw-pulse
];

const built = define('Cassia 1 XL', (b: Def) => {
  const part = b.add('alloc', 0, 4, { voices: 4 }); // the CZ-1: 4 voices with two lines, 8 with one
  const lfo = b.add('lfo', 0, 0, { wave: 1, rate: 5.5, depth: 1 });
  const nz = b.add('noise', 0, 1, { level: 1, color: 0 });
  const scope = b.add('scope', 12, 0, { time: 16 });
  const at = b.add('scale', 0, 2, { gain: 1, offset: 0 }); // Main's aftertouch comes in here (build)
  const members: number[] = [];
  const add = (type: string, col: number, row: number, p: Record<string, number> = {}): number => {
    const id = b.add(type, col, row, p);
    members.push(id);
    return id;
  };
  const sum = (to: number, port: string, ...from: Ref[]): void => {
    for (const [m, p] of from) b.wire(m, p, to, port);
  };

  // ---- the settings of a line, once for all voices (a choice is an Offset; the crossfaders' positions from it)
  type Ctl = { type: number; type2: number; alt: number; wave: number; wave2: number; window: number; range: number; selA: number[]; selB: number[]; selW: number[]; dType: number; dPort?: string };
  const ctl = (col: number, kind: number): Ctl => {
    const c = (v: number, row: number): number => b.add('const', col, row, { value: v });
    const type = c(kind, 0), type2 = c(0, 0.3), alt = c(0, 0.6), wave = c(0, 0.9), wave2 = c(1, 1.2), window = c(0, 1.5), range = c(3, 1.8);
    const steps = (from: number, n: number, row: number): number[] =>
      Array.from({ length: n }, (_, k) => {
        const s = b.add('scale', col, row + k * 0.2, { gain: 1, offset: -k });
        b.wire(from, 'out', s, 'in');
        return s;
      });
    const dType = b.add('math', col, 4, { ka: 1, kb: 1, off: 0 }); // type 2 - type
    b.wire(type2, 'out', dType, 'a');
    b.wire(type, 'out', dType, 'b');
    return { type, type2, alt, wave, wave2, window, range, selA: steps(wave, 4, 2), selB: steps(wave2, 4, 2.8), selW: steps(window, 2, 3.6), dType };
  };
  const c1 = ctl(1, 0), c2 = ctl(2, 1);
  // 1 + 1': line 2 plays with line 1's settings (here) and envelopes (per voice, below)
  const mode = b.add('const', 2.5, 0, { value: 0 });
  const pick = (x: number, y: number, row: number): number => {
    const xf = b.add('xfade', 2.5, row, { mix: 0 });
    b.wire(x, 'out', xf, 'a');
    b.wire(y, 'out', xf, 'b');
    b.wire(mode, 'out', xf, 'pos');
    return xf;
  };
  const cx: Ctl = {
    ...c2,
    type: pick(c2.type, c1.type, 0.2), alt: pick(c2.alt, c1.alt, 0.4), range: pick(c2.range, c1.range, 0.6),
    selA: c2.selA.map((s, k) => pick(s, c1.selA[k], 1 + k * 0.2)), selB: c2.selB.map((s, k) => pick(s, c1.selB[k], 2 + k * 0.2)),
    selW: c2.selW.map((s, k) => pick(s, c1.selW[k], 3 + k * 0.2)), dType: 0,
  };
  const dx = b.add('xfade', 2.5, 3.5, { mix: 0 });
  b.wire(c2.dType, 'sub', dx, 'a');
  b.wire(c1.dType, 'sub', dx, 'b');
  b.wire(mode, 'out', dx, 'pos');
  cx.dType = dx;
  cx.dPort = 'out';

  // ---- an envelope of six steps: e1 to its sustain while the key is down; at the release a one-shot e2 (its levels
  // fractions of the level e1 had then, which a sample and hold keeps) takes over, e1 falling away fast beneath it
  type Env6 = { e1: number; e2: number; out: Ref };
  const env6 = (col: number, row: number, gate: Ref, p1: Record<string, number>, p2: Record<string, number>): Env6 => {
    const e1 = add('env', col, row, { ...p1, l4: 0, r4: 0.01 });
    const not = add('logic', col, row + 0.1, {});
    const hold = add('sh', col, row + 0.2, {});
    const e2 = add('env', col, row + 0.3, { l1: 1, r1: 0.001, ...p2, shot: 1 });
    const rel = add('math', col, row + 0.4, { ka: 1, kb: 1, off: 0 });
    const out = add('math', col, row + 0.5, { ka: 1, kb: 1, off: 0 });
    b.wire(gate[0], gate[1], e1, 'gate');
    b.wire(gate[0], gate[1], not, 'a');
    b.wire(e1, 'env', hold, 'in');
    b.wire(not, 'not', hold, 'clock');
    b.wire(not, 'not', e2, 'gate');
    b.wire(hold, 'out', rel, 'a');
    b.wire(e2, 'env', rel, 'b');
    b.wire(e1, 'env', out, 'a');
    b.wire(rel, 'mul', out, 'b');
    return { e1, e2, out: [out, 'max'] };
  };

  // ---- per voice: pitch (DCO envelope, vibrato after its delay), key follow, velocity
  const gate: Ref = [part, 'gate'];
  const pitch = add('scale', 1, 5, { gain: 1, offset: 0 });
  const dco = env6(1, 5.5, gate, { l1: 0, r1: 0.05, l2: 0, r2: 0.3, l3: 0, r3: 0.5 }, { l2: 1, r2: 0.1, l3: 1, r3: 0.1, l4: 0, r4: 0.1 });
  const pdepth = add('scale', 1, 6.5, { gain: 1, offset: 0 });
  const vdel = add('adsr', 1, 7, { a: 0.6, d: 0.001, s: 1, r: 0.3 });
  const vgate = add('vca', 1, 7.5, { gain: 1 });
  const vib = add('scale', 1, 8, { gain: 0, offset: 0 });
  const atVib = b.add('scale', 0, 2.5, { gain: 0, offset: 0 });
  const kfw = add('scale', 1, 8.5, { gain: -0.15, offset: 0 });
  const kfa = add('scale', 1, 9, { gain: -0.1, offset: 0 });
  const velW = add('scale', 1, 9.5, { gain: 0, offset: 0 });
  b.wire(part, 'pitch', pitch, 'in');
  sum(pdepth, 'in', dco.out);
  b.wire(pdepth, 'out', pitch, 'in');
  b.wire(part, 'gate', vdel, 'gate');
  b.wire(lfo, 'out', vgate, 'in');
  b.wire(vdel, 'env', vgate, 'cv');
  b.wire(at, 'out', atVib, 'in');
  b.wire(atVib, 'out', vgate, 'cv');
  b.wire(vgate, 'out', vib, 'in');
  b.wire(vib, 'out', pitch, 'in');
  b.wire(part, 'pitch', kfw, 'in');
  b.wire(part, 'pitch', kfa, 'in');
  b.wire(part, 'vel', velW, 'in');
  const atW = b.add('scale', 0, 3, { gain: 0, offset: 0 });
  const atA = b.add('scale', 0, 3.5, { gain: 0, offset: 0 });
  b.wire(at, 'out', atW, 'in');
  b.wire(at, 'out', atA, 'in');

  // ---- one line: the ramp, the bends, the resonance, the two waveforms; `dcw` feeds the bend depth
  const line = (col: number, from: number, c: Ctl, dcw: Ref[]): Ref => {
    let r = 0;
    const m = (type: string, p: Record<string, number> = {}): number => add(type, col, (r += 0.1), p);
    const math = (ka = 1, kb = 1, off = 0): number => m('math', { ka, kb, off });
    // the ramp u (0..1 per cycle) and g, the even cycle
    const tri = m('osc', { wave: 1, coarse: -12, level: 1 });
    const sn = m('osc', { wave: 0, coarse: -12, level: 1 });
    const g = math();
    const flip = math(1, 1, -0.5);
    const u = m('scale', { gain: 1, offset: 0.5 });
    b.wire(from, 'out', tri, 'pitch');
    b.wire(from, 'out', sn, 'pitch');
    b.wire(sn, 'out', g, 'a');
    b.wire(g, 'cmp', flip, 'a');
    b.wire(tri, 'out', flip, 'b');
    b.wire(flip, 'mul', u, 'in');
    const U: Ref = [u, 'out'];
    // the five bends: weighted sums of u and of hinges max(u - x, 0), each hinge made once; a weight past the Math's
    // range of 4 takes the same input twice
    const hinge = new Map<number, Ref>();
    const H = (x: number): Ref => {
      if (x === 0) return U;
      if (!hinge.has(x)) {
        const h = math(1, 1, -x);
        b.wire(u, 'out', h, 'a');
        hinge.set(x, [h, 'max']);
      }
      return hinge.get(x)!;
    };
    const bends = BENDS.map(({ s0, at: pts }): Ref => {
      const terms: [Ref, number][] = [];
      for (const [x, w] of [[0, s0] as [number, number], ...pts]) {
        for (let left = w; Math.abs(left) > 1e-9; ) {
          const k = Math.abs(left) > 4 ? Math.sign(left) * 4 : left;
          terms.push([H(x), k]);
          left -= k;
        }
      }
      let acc: Ref | null = null;
      for (let i = 0; i < terms.length; ) {
        const [ra, ka] = acc ? [acc, 1] : terms[i++];
        const [rb, kb] = terms[i++];
        const s = math(ka, kb);
        b.wire(ra[0], ra[1], s, 'a');
        b.wire(rb[0], rb[1], s, 'b');
        acc = [s, 'add'];
      }
      return acc!;
    });
    const select = (ins: Ref[], pos: number[]): Ref => {
      let acc = ins[0];
      ins.slice(1).forEach((x, k) => {
        const xf = m('xfade', { mix: 0 });
        b.wire(acc[0], acc[1], xf, 'a');
        b.wire(x[0], x[1], xf, 'b');
        b.wire(pos[k], 'out', xf, 'pos');
        acc = [xf, 'out'];
      });
      return acc;
    };
    const mA = select(bends, c.selA), mB = select(bends, c.selB);
    // g2: the odd cycle when `2nd` is on
    const g2 = math(-1, 1, 1);
    const g2on = math();
    b.wire(g, 'cmp', g2, 'a');
    b.wire(g2, 'add', g2on, 'a');
    b.wire(c.alt, 'out', g2on, 'b');
    const G2: Ref = [g2on, 'mul'];
    // the bend: mA, or mB on the odd cycles, times the DCW
    const dm = math(), dm2 = math(), bend = math(), dcwSum = m('scale', { gain: 1, offset: 0 }), depth = math();
    b.wire(mB[0], mB[1], dm, 'a');
    b.wire(mA[0], mA[1], dm, 'b');
    b.wire(dm, 'sub', dm2, 'a');
    b.wire(...G2, dm2, 'b');
    b.wire(mA[0], mA[1], bend, 'a');
    b.wire(dm2, 'mul', bend, 'b');
    sum(dcwSum, 'in', ...dcw);
    b.wire(dcwSum, 'out', depth, 'a');
    b.wire(bend, 'add', depth, 'b');
    const car = m('osc', { wave: 0, pm: 2 * Math.PI, level: 1 });
    b.wire(from, 'out', car, 'pitch');
    b.wire(depth, 'mul', car, 'pm');
    // resonance: the three windows of u, the restarted sine raised by the DCW
    const w1 = m('scale', { gain: -1, offset: 1 });
    b.wire(u, 'out', w1, 'in');
    const w2a = math(2, 1, -1), w2 = m('scale', { gain: -1, offset: 1 });
    b.wire(u, 'out', w2a, 'a');
    b.wire(w2a, 'abs', w2, 'in');
    const fall = m('scale', { gain: -2, offset: 2 }), w3a = math(4), w3b = math(-1, 1, 1), w3 = m('scale', { gain: -1, offset: 1 });
    b.wire(u, 'out', fall, 'in');
    b.wire(u, 'out', w3a, 'a');
    b.wire(fall, 'out', w3a, 'b');
    b.wire(w3a, 'min', w3b, 'a');
    b.wire(w3b, 'max', w3, 'in');
    const win = select([[w1, 'out'], [w2, 'out'], [w3, 'out']], c.selW);
    const rise = math();
    b.wire(dcwSum, 'out', rise, 'a');
    b.wire(c.range, 'out', rise, 'b');
    const rs = m('osc', { wave: 0, level: 1 });
    b.wire(from, 'out', rs, 'pitch');
    b.wire(rise, 'mul', rs, 'pitch');
    b.wire(w1, 'out', rs, 'sync');
    const wvca = m('vca', { gain: 1 });
    b.wire(rs, 'out', wvca, 'in');
    b.wire(win[0], win[1], wvca, 'cv');
    // which kind sounds this cycle: type, or type 2 on the odd cycles; out = pd + pos (reso - pd)
    const pdiff = math(), pos = math(), dr = math(), mix = math(), out = math();
    b.wire(c.dType, c.dPort ?? 'sub', pdiff, 'a');
    b.wire(...G2, pdiff, 'b');
    b.wire(c.type, 'out', pos, 'a');
    b.wire(pdiff, 'mul', pos, 'b');
    b.wire(wvca, 'out', dr, 'a');
    b.wire(car, 'out', dr, 'b');
    b.wire(dr, 'sub', mix, 'a');
    b.wire(pos, 'add', mix, 'b');
    b.wire(car, 'out', out, 'a');
    b.wire(mix, 'mul', out, 'b');
    return [out, 'add'];
  };

  type Amp = { dcw: Env6; dca: Env6; vca: number };
  const amp = (col: number, dcwP: Record<string, number>): Amp => {
    const rel = { l2: 0.5, r2: 0.15, l3: 0.15, r3: 0.3, l4: 0, r4: 0.4 };
    const dcw = env6(col, 0, gate, dcwP, rel);
    const dca = env6(col, 1, gate, { l1: 1, r1: 0.01, l2: 0.8, r2: 0.4, l3: 0.6, r3: 2 }, rel);
    const vca = add('vca', col, 2, { gain: 0.15 });
    b.pin(vca, 'p1', 'gain');
    b.module(vca).att = [0.45, 1]; // velocity 1 reaches 0.6, as on the FM-1 version
    b.wire(part, 'vel', vca, 'p1');
    b.wire(kfa, 'out', vca, 'p1');
    b.wire(atA, 'out', vca, 'p1');
    return { dcw, dca, vca };
  };
  const touch: Ref[] = [[kfw, 'out'], [velW, 'out'], [atW, 'out']];
  const a1 = amp(3, { l1: 0.9, r1: 0.05, l2: 0.6, r2: 0.6, l3: 0.4, r3: 1.5 });
  const a2 = amp(4, { l1: 0.7, r1: 0.1, l2: 0.4, r2: 0.8, l3: 0.25, r3: 2 });
  b.wire(a1.dca.out[0], a1.dca.out[1], a1.vca, 'cv');
  // line 2's pitch: line 1's plus its offset
  const det = add('scale', 5, 0, { gain: 1, offset: 0 });
  b.wire(pitch, 'out', det, 'in');
  const dcw2 = add('xfade', 5, 0.5, { mix: 0 });
  b.wire(a2.dcw.out[0], a2.dcw.out[1], dcw2, 'a');
  b.wire(a1.dcw.out[0], a1.dcw.out[1], dcw2, 'b');
  b.wire(mode, 'out', dcw2, 'pos');
  const dca2 = add('xfade', 5, 1, { mix: 0 });
  b.wire(a2.dca.out[0], a2.dca.out[1], dca2, 'a');
  b.wire(a1.dca.out[0], a1.dca.out[1], dca2, 'b');
  b.wire(mode, 'out', dca2, 'pos');
  const l1 = line(6, pitch, c1, [a1.dcw.out, ...touch]);
  const l2 = line(7, det, cx, [[dcw2, 'out'], ...touch]);
  // line 2's modulation before its DCA: ring (times line 1) and noise
  const ring = add('math', 9, 0, { ka: 1, kb: 1, off: 0 });
  const ringX = add('xfade', 9, 0.5, { mix: 0 });
  const nmul = add('math', 9, 1, { ka: 1, kb: 1, off: 0 });
  const noiseX = add('xfade', 9, 1.5, { mix: 0 });
  b.wire(l1[0], l1[1], ring, 'a');
  b.wire(l2[0], l2[1], ring, 'b');
  b.wire(l2[0], l2[1], ringX, 'a');
  b.wire(ring, 'mul', ringX, 'b');
  b.wire(nz, 'out', nmul, 'a');
  b.wire(ringX, 'out', nmul, 'b');
  b.wire(ringX, 'out', noiseX, 'a');
  b.wire(nmul, 'mul', noiseX, 'b');
  b.wire(l1[0], l1[1], a1.vca, 'in');
  b.wire(noiseX, 'out', a2.vca, 'in');
  b.wire(dca2, 'out', a2.vca, 'cv');
  // the line select: 0 line 1, 0.5 both, 1 line 2
  const sel = add('xfade', 10, 0.5, { mix: 0.5 });
  b.wire(a1.vca, 'out', sel, 'a');
  b.wire(a2.vca, 'out', sel, 'b');
  b.wire(sel, 'out', scope, 'a');
  b.nest('voice', 3, 6, members, { poly: {} });
  b.input('keys', part, 'keys');
  b.input('at', at, 'in');
  b.output('out', sel, 'out');

  b.param('voices', part, 'voices', { head: 'voice' });
  b.param('line', sel, 'mix');
  b.param("1+1'", mode, 'value');
  b.param('line 2 pitch', det, 'offset');
  b.param('vib wave', lfo, 'wave', { head: 'vibrato' });
  b.param('vib rate', lfo, 'rate');
  b.param('vib depth', vib, 'gain');
  b.param('vib delay', vdel, 'a');
  const envRows = (e: Env6, head: string, col: boolean): void => {
    b.param(head, e.e1, 'view', { head, ...(col ? { col: true } : {}) });
    for (const [lbl, q] of [['rate 1', 'r1'], ['level 1', 'l1'], ['rate 2', 'r2'], ['level 2', 'l2'], ['rate 3', 'r3'], ['sustain', 'l3']]) b.param(lbl, e.e1, q);
    for (const [lbl, q] of [['rate 4', 'r2'], ['level 4', 'l2'], ['rate 5', 'r3'], ['level 5', 'l3'], ['rate 6', 'r4'], ['end', 'l4']]) b.param(lbl, e.e2, q);
  };
  b.param('depth', pdepth, 'gain', { head: 'dco env' });
  envRows(dco, 'dco env', false);
  b.param('dcw kf', kfw, 'gain', { head: 'touch' });
  b.param('dca kf', kfa, 'gain');
  b.param('vel dcw', velW, 'gain');
  b.param('at dcw', atW, 'gain');
  b.param('at dca', atA, 'gain');
  b.param('at vib', atVib, 'gain');
  for (const [n, c, a] of [[1, c1, a1], [2, c2, a2]] as const) {
    b.param('type', c.type, 'value', { head: `line ${n}`, col: true });
    b.param('wave', c.wave, 'value');
    b.param('window', c.window, 'value');
    b.param('2nd', c.alt, 'value');
    b.param('2nd type', c.type2, 'value');
    b.param('wave 2', c.wave2, 'value');
    b.param('res range', c.range, 'value');
    if (n === 2) {
      b.param('ring', ringX, 'mix');
      b.param('noise', noiseX, 'mix');
    }
    envRows(a.dcw, `dcw ${n}`, true);
    envRows(a.dca, `dca ${n}`, true);
  }
  b.param('out', scope, 'view', { col: true });
});

export const xl: Xl = {
  base: 'Cassia 1',
  build: (fm1: Patch): Patch => {
    const x = around('Cassia 1', built);
    x.p.notes = NOTES;
    const a = x.a.inputs.find((i) => i.label === 'at')!;
    if (!connect(x.p, DEFS, { module: x.main.id, port: 'at' }, { module: a.module, port: a.port })) throw new Error('Cassia 1 XL: aftertouch');
    const q = players(x.p, true);
    matchLevel(q, fm1, [48, 55, 60, 64]);
    return q;
  },
};
