// SPDX-License-Identifier: GPL-3.0-only
import { expect, it } from 'vitest';
import { DEFS, IMPLS, type Ctx } from './modules';

function envelope(params: Record<string, number> = {}, pitch = 0, sr = 48000) {
  const impl = IMPLS.rateenv;
  const state = impl.init(sr) as { stage: number; v: number };
  const p = { ar: 31, d1r: 31, d1l: 10, d2r: 0, rr: 15, krs: 0, ...params };
  const run = (seconds: number, gate = 1, hold = 0) => {
    const n = Math.round(sr * seconds), out = new Float32Array(n);
    impl.process({ n, sr, p, inp: { gate: new Float32Array(n).fill(gate), hold: new Float32Array(n).fill(hold), pitch: new Float32Array(n).fill(pitch) }, out: { env: out }, connected: { gate: true, pitch: true, hold: true } } as unknown as Ctx, state);
    return out;
  };
  return { p, state, run };
}

it('exposes the original five envelope controls and four rate-scaling settings', () => {
  expect(DEFS.rateenv.params.map(p => [p.name, p.min, p.max])).toEqual([['ar', 0, 31], ['d1r', 0, 31], ['d1l', 0, 15], ['d2r', 0, 31], ['rr', 0, 15], ['krs', 0, 3]]);
});
it('zero attack and decay rates stop their stages, even at maximum key scaling', () => {
  const a = envelope({ ar: 0, krs: 3 }, 4);
  expect([...a.run(0.2)].every(v => v === 0)).toBe(true);
  a.p.ar = 31; a.p.d1r = 0;
  expect(a.run(0.2).at(-1)).toBe(1);
  a.p.d1r = 31; a.run(0.1);
  const held = a.state.v;
  expect(held).toBeGreaterThan(0); expect(held).toBeLessThan(0.3);
  expect(a.run(0.5).at(-1)).toBe(held);
  a.p.d2r = 31;
  expect(a.run(0.1).at(-1)).toBe(0);
});
it('release zero is slow, not frozen, and key-up interrupts attack or decay', () => {
  const e = envelope({ d1r: 0, rr: 0 }); e.run(0.01);
  expect(e.state.v).toBe(1); e.run(1, 0);
  expect(e.state.v).toBeLessThan(1); expect(e.state.v).toBeGreaterThan(0.5);
  const releasing = e.state.v; e.run(1, 0, 1); expect(e.state.v).toBeLessThan(releasing);
  const a = envelope({ ar: 12 }); a.run(0.03);
  expect(a.state.stage).toBe(1); expect(a.run(0.1, 0).at(-1)).toBe(0);
});
it('holds D1L only while pedal is down and preserves attacks on reused keys', () => {
  const e = envelope();
  expect(e.run(0.1, 0, 1).at(-1)).toBe(0); e.run(0.1);
  const held = e.state.v;
  expect(e.run(0.1, 0, 1).at(-1)).toBe(held);
  expect(Math.max(...e.run(0.01, 1, 1))).toBeGreaterThan(0.9);
  e.run(0.1, 1, 0); expect(e.state.v).toBe(held);
  expect(e.run(0.1, 0, 0).at(-1)).toBe(0);
  expect(e.run(0.1, 0, 1).at(-1)).toBe(0);
});
it('higher keys accelerate nonzero rates and scaling 3 has the strongest effect', () => {
  const low = envelope({ ar: 12, krs: 3 }, -2), high = envelope({ ar: 12, krs: 3 }, 2), off = envelope({ ar: 12, krs: 0 }, 2);
  low.run(0.02); high.run(0.02); off.run(0.02);
  expect(high.state.v).toBeGreaterThan(low.state.v); expect(high.state.v).toBeGreaterThan(off.state.v);
});
it.each([44118, 48000, 96000])('uses the same envelope clock at %i Hz', sr => {
  const e = envelope({ ar: 31, d1r: 0, rr: 15 }, 0, sr); e.run(0.01);
  const silentAt = e.run(0.02, 0).findIndex(v => v === 0) / sr;
  expect(silentAt).toBeGreaterThan(0.006); expect(silentAt).toBeLessThan(0.008);
});
