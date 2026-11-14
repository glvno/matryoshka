// SPDX-License-Identifier: GPL-3.0-only
// The Delay's rate row (#659, docs/ledger/modules.md): 44k keeps every sample, as every Delay did before the row; 22k and
// 11k low-pass the input and keep every 2nd or 4th sample, so the same line (the same memory) holds two or four times its
// length. The screen shows the rate and the length row the time it holds; a new rate keeps the echoes, pitched as a tape
// changing speed.
import { describe, expect, it } from 'vitest';
import { DEFS, delayRateK, delayReach, DELAY_LENGTH_MAX, DELAY_RATES, DELAY_REACH_MAX, DEVICE_SR, rowRange } from './modules';
import { addModule, connect, emptyPatch, topOf, type Patch } from './patch';
import { deviceBudget, encodePatch, formatOf, FORMAT_1_11 } from './patchbin';
import { Engine } from './engine';

const SR = 44100;
const ratePd = DEFS.delay.params.find((q) => q.name === 'rate')!;
const lengthPd = DEFS.delay.params.find((q) => q.name === 'length')!;
const timePd = DEFS.delay.params.find((q) => q.name === 'time')!;

/** a constant (or an 8.4 kHz sine) into a Delay (mix 1, no feedback) into the Output */
function delayPatch(params: Record<string, number>, input: 'const' | 'sine' = 'const'): Patch {
  const p = emptyPatch('Rate');
  addModule(p, DEFS.fm1, 0, 0);
  const src = input === 'const' ? addModule(p, DEFS.const, 0, 0) : addModule(p, DEFS.osc, 0, 0);
  if (input === 'const') src.params.value = 1;
  else {
    Object.assign(src.params, { wave: 0, level: 0.5, coarse: 48 });
    const oct = addModule(p, DEFS.const, 0, 0);
    oct.params.value = 1;
    connect(p, DEFS, { module: oct.id, port: 'out' }, { module: src.id, port: 'pitch' });
  }
  const dly = addModule(p, DEFS.delay, 0, 0);
  Object.assign(dly.params, { fb: 0, mix: 1, ...params });
  const out = addModule(p, DEFS.output, 0, 0);
  out.params.level = 0.7;
  connect(p, DEFS, { module: src.id, port: 'out' }, { module: dly.id, port: 'in' });
  connect(p, DEFS, { module: dly.id, port: 'out' }, { module: out.id, port: 'l' });
  connect(p, DEFS, { module: dly.id, port: 'r' }, { module: out.id, port: 'r' });
  return p;
}

function render(p: Patch, secs: number): { l: Float32Array; r: Float32Array; e: Engine } {
  const e = new Engine(SR);
  e.load(p);
  const l = new Float32Array(Math.round(SR * secs));
  const r = new Float32Array(l.length);
  e.render(l, r);
  return { l, r, e };
}

describe('the Delay\'s rate row', () => {
  it('is a row of format 51 with three steps, 44k by default', () => {
    expect(DEFS.delay.params.indexOf(ratePd)).toBe(8);
    expect(ratePd).toMatchObject({ min: 0, max: 2, default: 0, since: FORMAT_1_11, choices: ['44k', '22k', '11k'] });
    expect(DELAY_RATES.map((_, r) => delayRateK(r))).toEqual([1, 2, 4]);
    expect(DELAY_REACH_MAX).toBe(DELAY_LENGTH_MAX * 4);
    expect(topOf(timePd)).toBe(DELAY_REACH_MAX);
    // a Delay at 44k is written as before; a lower rate is format 51
    expect(formatOf(delayPatch({ time: 500 }))).toBeLessThan(FORMAT_1_11);
    expect(formatOf(delayPatch({ time: 500, rate: 1 }))).toBe(FORMAT_1_11);
  });

  it('44k plays exactly as a Delay without the row', () => {
    const a = render(delayPatch({ time: 300, fb: 0.5 }, 'sine'), 1);
    const b = render(delayPatch({ time: 300, fb: 0.5, rate: 0 }, 'sine'), 1);
    expect(b.l).toEqual(a.l);
  });

  it('each step doubles the time the same line holds: the echo arrives at the time, past the length', () => {
    for (const [rate, time, length] of [[1, 1300, 700], [2, 2700, 700], [2, 7500, 1900]]) {
      const { l } = render(delayPatch({ time, length, rate }), time / 1000 + 0.3);
      const at = l.findIndex((v) => v > 0.3);
      expect(Math.abs(at - Math.round((time / 1000) * SR))).toBeLessThanOrEqual(4);
    }
    // the same memory whatever the rate
    for (const rate of [0, 1, 2]) expect(deviceBudget(delayPatch({ time: 300, length: 700, rate })).memory).toBe(deviceBudget(delayPatch({ time: 300, length: 700 })).memory);
  });

  it('the time reaches the length times k (half with ping-pong), the length row shows that time', () => {
    expect(delayReach({ length: 700, rate: 1 })).toBe(1400);
    expect(delayReach({ length: 700, rate: 2 })).toBe(2800);
    expect(delayReach({ length: 1900, rate: 2, pingpong: 1 })).toBe(3800);
    expect(topOf(rowRange('delay', { length: 1900, rate: 2 }, timePd))).toBe(7600);
    expect(lengthPd.altText?.when).toBe('rate');
    expect(lengthPd.altText?.text(700, { rate: 2 })).toBe('2800 ms');
    // a time past the line is cut to it: 2000 ms at 22k with a 700 ms length plays 1.4 s
    const { l } = render(delayPatch({ time: 2000, length: 700, rate: 1 }), 2);
    const at = l.findIndex((v) => v > 0.3);
    expect(at).toBeGreaterThan(1.39 * SR);
    expect(at).toBeLessThan(1.41 * SR);
    expect(() => encodePatch(delayPatch({ time: 2000, length: 700, rate: 1 }))).not.toThrow();
  });

  it('keeps fewer high frequencies: an 8.4 kHz sine comes back a little quieter at 22k, far quieter at 11k', () => {
    const rms = (rate: number): number => {
      const { l } = render(delayPatch({ time: 100, rate }, 'sine'), 0.5);
      let s = 0;
      for (let i = Math.round(0.2 * SR); i < l.length; i++) s += l[i] * l[i];
      return Math.sqrt(s / (l.length - 0.2 * SR));
    };
    expect(rms(2)).toBeLessThan(rms(0) * 0.15);
    expect(rms(1)).toBeGreaterThan(rms(0) * 0.5);
    expect(rms(1)).toBeLessThan(rms(0));
  });

  /** zero crossings upward per second of x between two times (s) */
  const freq = (x: Float32Array, t0: number, t1: number): number => {
    let n = 0;
    for (let i = Math.round(t0 * SR); i < Math.round(t1 * SR); i++) if (x[i - 1] < 0 && x[i] >= 0) n++;
    return n / (t1 - t0);
  };

  it('a new rate keeps the echoes: they play on pitched, as a tape changing speed, with no jump, then the echo glides back to the time', () => {
    // a 1046.5 Hz sine (C6) into a 200 ms Delay at 44k; at the switch the sine stops and the rate drops to 22k
    const p = emptyPatch('Rate');
    addModule(p, DEFS.fm1, 0, 0);
    const osc = addModule(p, DEFS.osc, 0, 0);
    Object.assign(osc.params, { wave: 0, level: 0.5, coarse: 0 });
    const oct = addModule(p, DEFS.const, 0, 0);
    oct.params.value = 2;
    connect(p, DEFS, { module: oct.id, port: 'out' }, { module: osc.id, port: 'pitch' });
    const dly = addModule(p, DEFS.delay, 0, 0);
    Object.assign(dly.params, { fb: 0, mix: 1, time: 200, length: 700, rate: 0 });
    const out = addModule(p, DEFS.output, 0, 0);
    out.params.level = 0.7;
    connect(p, DEFS, { module: osc.id, port: 'out' }, { module: dly.id, port: 'in' });
    connect(p, DEFS, { module: dly.id, port: 'out' }, { module: out.id, port: 'l' });
    const e = new Engine(SR);
    e.load(p);
    const n0 = Math.round(SR * 0.5);
    const l0 = new Float32Array(n0);
    e.render(l0, new Float32Array(n0));
    const f0 = freq(l0, 0.3, 0.5);
    expect(f0).toBeGreaterThan(1030);
    expect(f0).toBeLessThan(1060);
    e.setParam(osc.id, 'level', 0);
    e.setParam(dly.id, 'rate', 1);
    const l = new Float32Array(Math.round(SR * 1));
    e.render(l, new Float32Array(l.length));
    // no jump: the first samples after the switch go on from the last before it, at the sine's own slope or less
    const slope = Math.max(...l0.slice(n0 - 2000).map((v, i, a) => (i ? Math.abs(v - a[i - 1]) : 0)));
    expect(Math.abs(l[0] - l0[n0 - 1])).toBeLessThanOrEqual(slope * 1.05);
    expect(Math.max(...l.slice(0, 4000).map((v, i, a) => (i ? Math.abs(v - a[i - 1]) : 0)))).toBeLessThanOrEqual(slope * 1.05);
    // the old echoes play on an octave down (the line moves at half the speed), for twice the time: the 200 ms the line
    // held of them; then what came after the change, silence here, while the read point glides back to 200 ms
    expect(freq(l, 0.02, 0.38) / f0).toBeCloseTo(0.5, 2);
    expect(Math.min(...[0.05, 0.15, 0.25, 0.35].map((t) => Math.max(...l.slice(Math.round(t * SR), Math.round((t + 0.02) * SR)).map(Math.abs))))).toBeGreaterThan(0.3);
    expect(Math.max(...l.slice(Math.round(0.42 * SR)).map(Math.abs))).toBeLessThan(1e-3);
    // and back up to 44k: the 22k echoes in the line play an octave up, for half the time
    const n1 = l.length;
    e.setParam(osc.id, 'level', 0.5);
    const l1 = new Float32Array(Math.round(SR * 1));
    e.render(l1, new Float32Array(l1.length));
    e.setParam(osc.id, 'level', 0);
    e.setParam(dly.id, 'rate', 0);
    const l2 = new Float32Array(Math.round(SR * 0.5));
    e.render(l2, new Float32Array(l2.length));
    expect(Math.abs(l2[0] - l1[l1.length - 1])).toBeLessThanOrEqual(slope * 1.05);
    let up = 0;
    for (let i = Math.round(0.005 * SR); i < Math.round(0.095 * SR); i++) if (l2[i - 1] < 0 && l2[i] >= 0) up++;
    expect(up / 0.09 / f0).toBeCloseTo(2, 1);
    expect(n1).toBe(SR);
  });

  it('the line keeps its level across a new rate: the low pass starts settled on the input, the ring keeps its place', () => {
    for (const [from, to, pp] of [[0, 2, 0], [0, 1, 1], [2, 0, 0], [1, 2, 1]]) {
      const p = delayPatch({ time: 200, length: 700, rate: from, pingpong: pp, fb: pp ? 0.5 : 0 });
      const e = new Engine(SR);
      e.load(p);
      const l0 = new Float32Array(Math.round(SR * 4));   // (ping-pong with feedback settles)
      e.render(l0, new Float32Array(l0.length));
      const before = l0[l0.length - 1];
      e.setParam(p.modules.find((m) => m.type === 'delay')!.id, 'rate', to);
      const l = new Float32Array(Math.round(SR * 1));
      e.render(l, new Float32Array(l.length));
      for (const v of l) expect(Math.abs(v - before)).toBeLessThan(2e-3);
    }
  });
});
