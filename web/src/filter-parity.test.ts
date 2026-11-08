// SPDX-License-Identifier: GPL-3.0-only
// The 1.11 filter parity features (format 51, off by default): the Multimode filter's `drive` (#670, a soft clip inside its
// resonance loop), the Ladder's `diode` mode (#671, the TB-303 / VCS3 diode ladder) and its `stsat` switch (#672, the
// saturator at every stage). Off, each plays exactly as before.
import { describe, expect, it } from 'vitest';
import { DEFS, IMPLS } from './modules';

const SR = 44118, N = 128;
const FOUT = ['lp24', 'lp12', 'bp', 'hp', 'mix', 'notch', 'peak', 'ap', 'hp6'];

/** module `type` alone, fed `fill(block, i)` on its input, for `blocks` blocks: its `port` output, all of it */
function run(type: string, params: Record<string, number>, fill: (b: number, i: number) => number, blocks: number, port: string): Float32Array {
  const impl = IMPLS[type];
  const st = impl.init(SR);
  const inp: Record<string, Float32Array> = {};
  for (const k of ['in', 'cv', 'fm', 'morph']) inp[k] = new Float32Array(N);
  const out: Record<string, Float32Array> = {};
  for (const k of type === 'filter' ? FOUT : ['lp24', 'lp12']) out[k] = new Float32Array(N);
  const c = { sr: SR, n: N, inp, out, connected: { in: true }, p: params, voice: { pitch: 0, gate: 1, velocity: 1 } };
  const y = new Float32Array(blocks * N);
  for (let b = 0; b < blocks; b++) {
    for (let i = 0; i < N; i++) inp.in[i] = fill(b, i);
    impl.process(c as never, st);
    y.set(out[port], b * N);
  }
  return y;
}
const saw = (amp: number, hz = 110) => (b: number, i: number): number => amp * ((((b * N + i) * hz) / SR) % 1 * 2 - 1);
const sine = (amp: number, hz: number) => (b: number, i: number): number => amp * Math.sin((2 * Math.PI * hz * (b * N + i)) / SR);
const rms = (a: Float32Array, from = 0): number => Math.sqrt(a.subarray(from).reduce((s, v) => s + v * v, 0) / (a.length - from));
const peak = (a: Float32Array, from = 0): number => a.subarray(from).reduce((m, v) => Math.max(m, Math.abs(v)), 0);
const same = (a: Float32Array, b: Float32Array): boolean => a.every((v, i) => v === b[i]);

describe('the new parameters', () => {
  it('are appended with format 51 and default to off', () => {
    const drive = DEFS.filter.params.at(-1)!;
    expect([drive.name, drive.default, drive.since]).toEqual(['drive', 0, 51]);
    expect(DEFS.ladder.params.slice(-2).map((p) => [p.name, p.default, p.since])).toEqual([['diode', 0, 51], ['stsat', 0, 51]]);
  });
});

describe('Multimode filter drive (#670)', () => {
  const base = { cutoff: 600, res: 0.82, cvamt: 1, track: 0, morph: 0.3, osc: 0 };
  it('off (0) and without resonance it plays exactly as without the parameter', () => {
    for (const port of FOUT) {
      expect(same(run('filter', { ...base, drive: 0 }, saw(0.8), 60, port), run('filter', base, saw(0.8), 60, port)), port).toBe(true);
      expect(same(run('filter', { ...base, res: 0, drive: 8 }, saw(0.8), 60, port), run('filter', { ...base, res: 0 }, saw(0.8), 60, port)), port).toBe(true);
    }
  });
  it('leaves a quiet signal nearly as it was and squashes a loud one\'s resonance', () => {
    const at = (amp: number, drive: number): number => rms(run('filter', { ...base, drive }, saw(amp), 200, 'lp12'), 100 * N) / amp;
    expect(Math.abs(at(0.02, 3) / at(0.02, 0) - 1)).toBeLessThan(0.03);
    expect(at(0.8, 3) / at(0.8, 0)).toBeLessThan(0.9);
    expect(at(0.8, 8)).toBeLessThan(at(0.8, 3));
  });
  it('keeps the outputs bounded at full drive and resonance with osc on', () => {
    const y = run('filter', { ...base, res: 1, osc: 1, drive: 8 }, saw(1), 400, 'lp12');
    expect(peak(y)).toBeLessThan(2);
    expect(rms(y, 200 * N)).toBeGreaterThan(0.01);
  });
});

describe('Ladder diode mode (#671)', () => {
  const base = { cutoff: 1000, res: 0, drive: 1, cvamt: 1, track: 0 };
  const gain = (hz: number, res: number): number => rms(run('ladder', { ...base, res, diode: 1 }, sine(0.01, hz), 300, 'lp24'), 150 * N) / (0.01 / Math.SQRT2);
  const db = (x: number): number => 20 * Math.log10(x);
  it('off plays exactly as the Moog ladder', () => {
    for (const port of ['lp24', 'lp12']) expect(same(run('ladder', { ...base, res: 0.6, diode: 0 }, saw(0.8), 60, port), run('ladder', { ...base, res: 0.6 }, saw(0.8), 60, port))).toBe(true);
  });
  it('rolls off about 18 dB an octave above the cutoff and passes the bass where the Moog mode does', () => {
    expect(db(gain(2000, 0)) - db(gain(4000, 0))).toBeGreaterThan(17);
    expect(db(gain(2000, 0)) - db(gain(4000, 0))).toBeLessThan(21);
    for (const res of [0, 0.5, 0.9]) expect(Math.abs(db(gain(40, res)) + db(1 + 4 * res)), `res ${res}`).toBeLessThan(1);
  });
  it('peaks at the cutoff with resonance', () => {
    const g = [700, 1000, 1400].map((hz) => gain(hz, 0.9));
    expect(g[1]).toBeGreaterThan(g[0]);
    expect(g[1]).toBeGreaterThan(g[2]);
    expect(db(g[1]) - db(gain(40, 0.9))).toBeGreaterThan(15);
  });
  it('rings at full resonance after a click, at the cutoff, longer than at 0.9', () => {
    const ring = (res: number): Float32Array => run('ladder', { ...base, cutoff: 500, res, diode: 1 }, (b, i) => (b === 0 && i === 0 ? 0.5 : 0), 200, 'lp24');
    expect(rms(ring(1), 100 * N)).toBeGreaterThan(20 * rms(ring(0.9), 100 * N));
    const y = ring(1).subarray(100 * N);
    let z = 0;
    for (let i = 1; i < y.length; i++) if (y[i - 1] < 0 && y[i] >= 0) z++;
    expect(Math.abs((z * SR) / y.length / 500 - 1)).toBeLessThan(0.03);
  });
});

describe('Ladder per-stage saturation (#672)', () => {
  const base = { cutoff: 600, res: 0.55, drive: 3.5, cvamt: 1, track: 0 };
  it('off plays exactly as before', () => {
    expect(same(run('ladder', { ...base, stsat: 0 }, saw(0.8), 60, 'lp24'), run('ladder', base, saw(0.8), 60, 'lp24'))).toBe(true);
  });
  it('changes a driven signal and leaves a quiet one nearly as it was', () => {
    const diff = (amp: number, drive: number): number => {
      const a = run('ladder', { ...base, drive }, saw(amp), 100, 'lp24'), b = run('ladder', { ...base, drive, stsat: 1 }, saw(amp), 100, 'lp24');
      return rms(a.map((v, i) => v - b[i])) / rms(a);
    };
    expect(diff(0.8, 3.5)).toBeGreaterThan(0.05);
    expect(diff(0.02, 1)).toBeLessThan(0.002);
  });
});
