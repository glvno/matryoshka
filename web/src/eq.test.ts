// SPDX-License-Identifier: GPL-3.0-only
// #1107: the EQ, one band of a parametric equalizer whose curve is matched to the analog one up to the top of the band,
// in the format after 1.21's (64). The FM-1's engine is compared with this one on the golden kits eq-* (tools/golden.sh).
import { describe, expect, it } from 'vitest';
import { FACTORY } from './assemblies';
import { DEFS, EQ_LIM, EQ_SHAPES, EQ_SHELF_Q, eqDesign, IMPLS } from './modules';
import { addModule, connect, defaultMap, emptyPatch } from './patch';
import { encodePatch, FORMAT_1_22, formatOf, TYPE_ORDER, WRITE_FLOOR } from './patchbin';

const SR = 44118;
const RATES = [44100, SR, 48000];
const [LS, BELL, HS, LP, HP, NOTCH] = [0, 1, 2, 3, 4, 5];

/** |H|^2 of the Audio EQ Cookbook's analog curve at f (Hz): what the EQ is matched to */
function analog2(shape: number, f0: number, gain: number, q: number, f: number): number {
  const a = 10 ** (gain / 40), sa = Math.sqrt(a), W = f / f0;
  // numerator and denominator as (b2, b1, b0) in s / (2 pi f0)
  const [n, d] = ({
    [LS]: [[a, (a * sa) / q, a * a], [a, sa / q, 1]],
    [BELL]: [[1, a / q, 1], [1, 1 / (a * q), 1]],
    [HS]: [[a * a, (a * sa) / q, a], [1, sa / q, a]],
    [LP]: [[0, 0, 1], [1, 1 / q, 1]],
    [HP]: [[1, 0, 0], [1, 1 / q, 1]],
    [NOTCH]: [[1, 0, 1], [1, 1 / q, 1]],
  } as Record<number, number[][]>)[shape];
  const m = (c: number[]): number => (c[2] - c[0] * W * W) ** 2 + (c[1] * W) ** 2;
  return m(n) / m(d);
}

/** |H|^2 at f of a state variable filter [g, k, mh, mb, ml] (eqDesign's form) */
function digital2([g, k, mh, mb, ml]: number[], f: number, sr: number): number {
  const x = Math.tan((Math.PI * f) / sr) / g, x2 = x * x;
  return ((ml - mh * x2) ** 2 + (mb * x) ** 2) / ((1 - x2) ** 2 + (k * x) ** 2);
}

/** the same curve as a plain bilinear filter (the cookbook's, prewarped at f0): the cramping the matching removes */
function bilinear(shape: number, f0: number, gain: number, q: number, sr: number): number[] {
  const a = 10 ** (gain / 40), sa = Math.sqrt(a), t = Math.tan((Math.PI * f0) / sr);
  switch (shape) {
    case LS: return [t / sa, 1 / q, 1, a / q, a * a];
    case HS: return [t * sa, 1 / q, a * a, a / q, 1];
    case BELL: return [t, 1 / (a * q), 1, a / q, 1];
    case LP: return [t, 1 / q, 0, 0, 1];
    case HP: return [t, 1 / q, 1, 0, 0];
    default: return [t, 1 / q, 1, 0, 1];
  }
}

const dB = (p: number): number => 10 * Math.log10(p);
/** the worst gap in dB between a filter and the analog curve on f1..f2, where the analog curve is above -30 dB */
function worst(c: number[], shape: number, f0: number, gain: number, q: number, sr: number, f1: number, f2: number): number {
  let w = 0;
  for (let i = 0; i <= 400; i++) {
    const f = f1 * (f2 / f1) ** (i / 400), r = analog2(shape, f0, gain, q, f);
    if (dB(r) > -30) w = Math.max(w, Math.abs(dB(digital2(c, f, sr)) - dB(r)));
  }
  return w;
}

/** run the EQ in blocks of 128 on `x`; `p(block)` gives the settings of each block */
function run(x: Float32Array, p: (b: number) => Record<string, number>, sr = SR): Float32Array {
  const impl = IMPLS.eq, st = impl.init(sr), res = new Float32Array(x.length);
  const base = Object.fromEntries(DEFS.eq.params.map((q) => [q.name, q.default]));
  for (let at = 0; at < x.length; at += 128) {
    const n = Math.min(128, x.length - at), out = { out: new Float32Array(n) };
    impl.process({ sr, n, inp: { in: x.subarray(at, at + n), p1: new Float32Array(n), p2: new Float32Array(n) }, out, connected: { in: true }, p: { ...base, ...p(at / 128) }, voice: {} as never }, st);
    res.set(out.out, at);
  }
  return res;
}
const sine = (hz: number, len: number, sr = SR): Float32Array => Float32Array.from({ length: len }, (_, i) => 0.25 * Math.sin((2 * Math.PI * hz * i) / sr));
const rms = (x: Float32Array, from: number): number => Math.sqrt(x.subarray(from).reduce((s, v) => s + v * v, 0) / (x.length - from));
const peak = (x: Float32Array): number => x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);

describe('EQ (#1107)', () => {
  it('is appended after the Euclid: in -> out, freq, gain, q, shape; the parameter inputs move freq and gain', () => {
    expect(TYPE_ORDER.slice(-2)).toEqual(['euclid', 'eq']);
    expect(DEFS.eq.label).toBe('EQ');
    expect(DEFS.eq.inputs.map((i) => i.name)).toEqual(['in', 'p1', 'p2']);
    expect(DEFS.eq.outputs.map((o) => o.name)).toEqual(['out']);
    expect(DEFS.eq.params.map((q) => [q.name, q.min, q.max, q.default])).toEqual([['freq', 10, 22000, 1000], ['gain', -18, 18, 0], ['q', 0.1, 10, 0.707], ['shape', 0, 5, 1]]);
    expect(defaultMap(DEFS.eq)).toEqual({ p1: ['freq'], p2: ['gain'] });
    expect(EQ_SHAPES).toEqual(['low shelf', 'bell', 'high shelf', 'low pass', 'high pass', 'notch']);
  });

  it('follows the analog curves up to a quarter of the rate for bands up to 2 kHz: within 0.15 dB, 0.6 dB when very broad', () => {
    for (const sr of RATES)
      for (const shape of [LS, BELL, HS, LP, HP, NOTCH])
        for (const f0 of [10, 31, 100, 440, 2000])
          for (const gain of shape <= HS ? [-18, -6, 6, 18] : [0])
            for (const q of [0.1, 0.3, 0.5, 0.707, 2, 10]) {
              const qa = shape === LS || shape === HS ? Math.min(q, EQ_SHELF_Q) : q;   // (a shelf's q stops at 2)
              expect(worst(eqDesign(shape, f0, gain, q, sr), shape, f0, gain, qa, sr, 5, sr / 4), `${EQ_SHAPES[shape]} ${f0} Hz ${gain} dB q ${q} at ${sr}`).toBeLessThan(q < 0.5 ? 0.6 : 0.15);
            }
  });

  it('keeps its curve near the top of the band, where a plain bilinear filter cramps it', () => {
    const cases: [number, number, number, number, number, number][] = [   // shape, f0, gain, q, matched under, bilinear over (dB)
      [BELL, 15000, 12, 1, 1.5, 6], [BELL, 18000, -12, 2, 3, 7], [BELL, 8000, 9, 1, 0.7, 1.6], [HS, 10000, 12, 0.707, 0.3, 1.3],
      [HS, 16000, -9, 0.707, 0.4, 2.2], [LS, 12000, 9, 0.707, 0.4, 1.3], [LP, 15000, 0, 0.707, 2, 30], [LP, 18000, 0, 3, 2.5, 30],
      [HP, 16000, 0, 0.707, 0.6, 8],
    ];
    for (const sr of [SR, 48000])
      for (const [shape, f0, gain, q, under, over] of cases) {
        const top = 0.97 * sr / 2, what = `${EQ_SHAPES[shape]} ${f0} Hz ${gain} dB q ${q} at ${sr}`;
        expect(worst(eqDesign(shape, f0, gain, q, sr), shape, f0, gain, q, sr, 1000, top), what).toBeLessThan(under);
        expect(worst(bilinear(shape, f0, gain, q, sr), shape, f0, gain, q, sr, 1000, top), what).toBeGreaterThan(over);
      }
  });

  it('meets the analog level exactly where it is matched: 0 Hz, a bell\'s peak, a shelf\'s Nyquist, a notch\'s zero', () => {
    for (const sr of RATES)
      for (const f0 of [10, 1000, 12000, 20000]) {
        for (const gain of [-18, -7, 5, 18]) {
          const b = eqDesign(BELL, f0, gain, 2, sr);
          expect(dB(digital2(b, f0, sr))).toBeCloseTo(gain, 6);
          expect(dB(digital2(b, 1e-3, sr))).toBeCloseTo(0, 6);
          for (const shape of [LS, HS]) {
            const s = eqDesign(shape, f0, gain, 0.707, sr);
            expect(dB(digital2(s, 1e-3, sr))).toBeCloseTo(shape === LS ? gain : 0, 5);
            expect(dB(digital2(s, sr / 2 - 1e-6, sr))).toBeCloseTo(dB(analog2(shape, f0, gain, 0.707, sr / 2)), 3);
          }
        }
        expect(digital2(eqDesign(NOTCH, f0, 0, 1, sr), f0, sr)).toBeLessThan(1e-20);
        expect(dB(digital2(eqDesign(LP, f0, 0, 4, sr), f0, sr))).toBeCloseTo(dB(16), 6);
      }
  });

  it('plays what eqDesign says: sines through the module at the designed gain', () => {
    for (const [shape, f0, gain, q] of [[BELL, 1000, 9, 2], [LS, 200, -12, 0.707], [HS, 15000, 12, 0.707], [LP, 3000, 0, 4], [HP, 50, 0, 0.707], [NOTCH, 2500, 0, 0.5]])
      for (const f of [60, 440, 2000, 9000, 18000]) {
        const y = run(sine(f, 8192), () => ({ shape, freq: f0, gain, q }));
        expect(dB((rms(y, 4096) / (0.25 / Math.SQRT2)) ** 2), `${EQ_SHAPES[shape]} at ${f} Hz`).toBeCloseTo(dB(digital2(eqDesign(shape, f0, gain, q, SR), f, SR)), 1);
      }
  });

  it('is stable at every setting: from 10 Hz to just under Nyquist at 44.1 and 48 kHz', () => {
    const fs = Array.from({ length: 40 }, (_, i) => 10 * 2200 ** (i / 39));
    for (const sr of RATES)
      for (const shape of [LS, BELL, HS, LP, HP, NOTCH])
        for (const f0 of fs)
          for (const gain of shape <= HS ? [-18, -9, -0.1, 0, 0.1, 9, 18] : [0])
            for (const q of [0.1, 0.3, 0.5, 0.707, 1, 3, 10]) {
              const c = eqDesign(shape, f0, gain, q, sr);
              // g > 0 and k > 0: both poles of the trapezoidal state variable filter inside the unit circle
              expect(c.every(Number.isFinite) && c[0] > 0 && c[1] > 0.03 && c[2] >= 0 && c[3] >= 0 && c[4] >= 0, `${EQ_SHAPES[shape]} ${f0} ${gain} ${q} ${sr}: ${c}`).toBe(true);
            }
  });

  it('stays bounded when every setting jumps each block, and its impulse response dies away at the extremes', () => {
    let seed = 7;
    const rnd = (): number => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
    for (const sr of RATES) {
      const x = Float32Array.from({ length: sr * 2 }, () => rnd() * 2 - 1);
      const y = run(x, () => ({ shape: Math.floor(rnd() * 6), freq: 10 * 2200 ** rnd(), gain: rnd() * 36 - 18, q: 0.1 * 100 ** rnd() }), sr);
      expect(y.every((v) => Number.isFinite(v) && Math.abs(v) < 60)).toBe(true);
      for (const p of [{ shape: BELL, freq: 10, gain: 18, q: 10 }, { shape: LP, freq: 10, q: 10 }, { shape: HS, freq: 22000, gain: 18, q: 10 }, { shape: LS, freq: 22000, gain: -18, q: 10 }]) {
        const imp = new Float32Array(sr * 8);
        imp[0] = 1;
        const h = run(imp, () => p, sr);
        const head = peak(h.subarray(1, sr)), tail = peak(h.subarray(h.length - 1000));
        expect(tail, JSON.stringify(p)).toBeLessThan(1e-3 * head);
      }
    }
  });

  it('turns without a click: a gain step and a freq jump go over in straight lines, never as a jump', () => {
    const x = sine(1000, 128 * 40);
    const step = (b: number): Record<string, number> => (b < 20 ? { gain: 0 } : { gain: 18 });
    const y = run(x, step);
    const jumpAt = (v: Float32Array, i: number): number => Math.abs(v[i] - v[i - 1]);
    const steady = Math.max(...Array.from({ length: 1000 }, (_, i) => jumpAt(y, 128 * 30 + i + 1)));
    for (let i = 128 * 20 - 4; i < 128 * 21 + 4; i++) expect(jumpAt(y, i)).toBeLessThanOrEqual(steady * 1.01);
    const z = run(sine(3000, 128 * 40), (b) => ({ shape: LP, q: 8, freq: b < 20 ? 300 : 3000 }));
    expect(z.every((v) => Math.abs(v) <= EQ_LIM && Number.isFinite(v))).toBe(true);
    expect(Math.abs(z[128 * 20] - z[128 * 20 - 1])).toBeLessThan(0.05);
  });

  it('at 0 dB a bell and the shelves pass the input unchanged', () => {
    const x = sine(440, 4096);
    for (const shape of [LS, BELL, HS]) {
      const y = run(x, () => ({ shape, gain: 0 }));
      expect(Math.max(...y.map((v, i) => Math.abs(v - x[i])))).toBeLessThan(1e-6);
    }
  });

  it('the factory assembly EQ: a low shelf, a bell and a high shelf in a row, flat until a gain moves', () => {
    const d = FACTORY.find((a) => a.name === 'EQ')!;
    expect(d.category).toBe('Effects');
    expect(d.modules.map((m) => [m.type, m.params.shape, m.params.gain])).toEqual([['eq', LS, 0], ['eq', BELL, 0], ['eq', HS, 0]]);
    expect(d.cables.map((c) => [c.from.module, c.to.module])).toEqual([[1, 2], [2, 3]]);
    expect(d.params.map((r) => r.label)).toEqual(['gain', 'freq', 'gain', 'freq', 'q', 'gain', 'freq']);
  });
});

describe('format 64 (#1107)', () => {
  it('a patch with an EQ that reaches the output is written in the format after 1.21\'s; firmware before it refuses it', () => {
    const p = emptyPatch();
    const o = addModule(p, DEFS.osc, 0, 0), out = addModule(p, DEFS.output, 300, 0);
    connect(p, DEFS, { module: o.id, port: 'out' }, { module: out.id, port: 'l' });
    expect(formatOf(p)).toBe(WRITE_FLOOR);
    const m = addModule(p, DEFS.eq, 600, 0);
    expect(formatOf(p)).toBe(WRITE_FLOOR);   // (one that reaches nothing is left out of the FM-1's patch)
    connect(p, DEFS, { module: o.id, port: 'out' }, { module: m.id, port: 'in' });
    connect(p, DEFS, { module: m.id, port: 'out' }, { module: out.id, port: 'r' });
    expect(formatOf(p)).toBe(FORMAT_1_22);
    expect(encodePatch(p)[1]).toBe(FORMAT_1_22);
    expect(DEFS.eq.since).toBe(FORMAT_1_22);
  });
});
