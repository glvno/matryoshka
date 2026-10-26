// SPDX-License-Identifier: GPL-3.0-only
// The phase distortion oscillator (modules.ts pd), run directly.
import { describe, expect, it } from 'vitest';
import { DEFS, DEVICE_SR, IMPLS, PD_FMAX, PD_SEGS, PD_STEEP } from './modules';
import { defaultParams } from './patch';

const SR = DEVICE_SR;
const C4 = 261.6255653;

/** n samples of a pd at a fixed pitch (octaves from C4) and dcw input, with these parameters */
function run(params: Record<string, number>, n: number, opt: { pitch?: number; dcw?: number; sync?: (i: number) => number; connected?: string[] } = {}): Float32Array {
  const impl = IMPLS.pd;
  const st = impl.init(SR);
  const out = new Float32Array(n);
  const B = 128;
  for (let at = 0; at < n; at += B) {
    const k = Math.min(B, n - at);
    const sync = new Float32Array(k);
    if (opt.sync) for (let i = 0; i < k; i++) sync[i] = opt.sync(at + i);
    const o = new Float32Array(k);
    impl.process(
      {
        sr: SR,
        n: k,
        inp: { pitch: new Float32Array(k).fill(opt.pitch ?? 0), dcw: new Float32Array(k).fill(opt.dcw ?? 0), pm: new Float32Array(k), sync },
        out: { out: o },
        connected: Object.fromEntries((opt.connected ?? []).map((c) => [c, true])),
        p: { ...defaultParams(DEFS.pd), level: 1, ...params },
        voice: {} as never,
      },
      st,
    );
    out.set(o, at);
  }
  return out;
}

/** the bend of wave w at u, full DCW */
const bend = (w: number, u: number): number => {
  const seg = PD_SEGS[w];
  let j = seg.length - 1;
  while (u < seg[j][0]) j--;
  return seg[j][1] + seg[j][2] * (u - seg[j][0]);
};

describe('phase distortion oscillator', () => {
  it('the bends are continuous and close the cycle', () => {
    for (const seg of PD_SEGS) {
      for (let j = 1; j < seg.length; j++) expect(seg[j - 1][1] + seg[j - 1][2] * (seg[j][0] - seg[j - 1][0])).toBeCloseTo(seg[j][1], 12);
      const last = seg[seg.length - 1];
      expect(last[1] + last[2] * (1 - last[0])).toBeCloseTo(0, 12);
      // the steepest bent phase is 1 + PD_STEEP
      expect(Math.max(...seg.map((s) => s[2]))).toBeCloseTo(PD_STEEP[PD_SEGS.indexOf(seg)], 12);
    }
  });

  it('dcw 0 is a sine; dcw 1 reads the sine at the bent phase', () => {
    const dt = C4 / SR;
    const sine = run({ wave: 0, dcw: 0 }, 400);
    for (let i = 0; i < 400; i++) expect(sine[i]).toBeCloseTo(Math.sin(2 * Math.PI * ((i + 1) * dt)), 5);
    for (const w of [0, 1, 2, 3, 4]) {
      const y = run({ wave: w, dcw: 1 }, 400);
      for (let i = 0; i < 400; i++) {
        const u = ((i + 1) * dt) % 1;
        expect(y[i]).toBeCloseTo(Math.sin(2 * Math.PI * (u + bend(w, u))), 4);
      }
    }
  });

  it('the dcw input adds to the parameter', () => {
    const a = run({ wave: 2, dcw: 0.2 }, 300, { dcw: 0.5 });
    const b = run({ wave: 2, dcw: 0.7 }, 300);
    for (let i = 0; i < 300; i++) expect(a[i]).toBeCloseTo(b[i], 6);
  });

  it('holds the dcw back as the note rises (the band limit)', () => {
    const pitch = 3; // C7
    const room = PD_FMAX / ((C4 * 8) / SR);
    const cap = (room - 1) / PD_STEEP[2];
    expect(cap).toBeGreaterThan(0);
    expect(cap).toBeLessThan(1);
    const full = run({ wave: 2, dcw: 1 }, 500, { pitch });
    const held = run({ wave: 2, dcw: cap }, 500, { pitch });
    for (let i = 0; i < 500; i++) expect(full[i]).toBeCloseTo(held[i], 6);
    // at middle C the full bend stays
    expect(run({ wave: 2, dcw: 1 }, 300)).not.toEqual(run({ wave: 2, dcw: cap }, 300));
  });

  it('plays the second waveform on every other cycle', () => {
    const period = SR / C4;
    const one = run({ wave: 0, dcw: 1 }, 2000);
    const same = run({ wave: 0, wave2: 1, dcw: 1 }, 2000);
    expect(same).toEqual(one); // wave2 = saw, the same as the first
    const two = run({ wave: 0, wave2: 2, dcw: 1 }, 2000); // saw, then square
    const sq = run({ wave: 1, dcw: 1 }, 2000);
    const i0 = Math.ceil(period * 0.3), i1 = Math.ceil(period * 1.3);
    expect(two[i0]).toBeCloseTo(one[i0], 6); // cycle 0: the saw
    expect(two[i1]).toBeCloseTo(sq[i1], 6); // cycle 1: the square
    expect(Math.abs(two[i1] - one[i1])).toBeGreaterThan(0.05);
  });

  it('resonance: a windowed sine that rises with dcw, restarted every cycle', () => {
    const period = SR / C4;
    const flat = run({ wave: 5, dcw: 0 }, 1000); // dcw 0: the window times the note's own sine
    const dt = C4 / SR;
    for (let i = 0; i < 1000; i++) {
      const u = ((i + 1) * dt) % 1;
      expect(flat[i]).toBeCloseTo((1 - u) * Math.sin(2 * Math.PI * u), 2);
    }
    // dcw 1, range 2: four times the note under the window; zero crossings count it
    const hi = run({ wave: 6, dcw: 1, range: 2 }, Math.round(period * 20));
    let z = 0;
    for (let i = 1; i < hi.length; i++) if (hi[i - 1] < 0 && hi[i] >= 0) z++;
    expect(z).toBeGreaterThanOrEqual(20 * 3 - 2);
    expect(z).toBeLessThanOrEqual(20 * 4 + 2);
  });

  it('sync restarts the cycle and the first waveform', () => {
    const y = run({ wave: 0, wave2: 2, dcw: 1 }, 1000, { sync: (i) => (i >= 250 && i < 260 ? 1 : 0) });
    const fresh = run({ wave: 0, wave2: 2, dcw: 1 }, 750);
    for (let i = 250; i < 1000; i++) expect(y[i]).toBeCloseTo(fresh[i - 250], 6);
  });
});
