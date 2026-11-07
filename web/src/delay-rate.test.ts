// SPDX-License-Identifier: GPL-3.0-only
// The Delay's rate row (#659, docs/ledger/modules.md): 44k keeps every sample, as every Delay did before the row; 22k and
// 11k low-pass the input and keep every 2nd or 4th sample, so the same line (the same memory) holds two or four times its
// length. The screen shows the rate and the length row the time it holds; a new rate empties the line.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFS, delayRateK, delayReach, DELAY_LENGTH_MAX, DELAY_RATES, DELAY_REACH_MAX, DELAY_TAIL, DEVICE_SR, rowRange } from './modules';
import { addModule, connect, emptyPatch, topOf, type Patch } from './patch';
import { deviceBudget, encodePatch, formatOf, FORMAT_1_11 } from './patchbin';
import { Engine } from './engine';

const SR = 44100;
const ratePd = DEFS.delay.params.find((q) => q.name === 'rate')!;
const lengthPd = DEFS.delay.params.find((q) => q.name === 'length')!;
const timePd = DEFS.delay.params.find((q) => q.name === 'time')!;
const defsH = readFileSync(new URL('../../firmware/src/defs.h', import.meta.url), 'utf8');

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
    // the FM-1 shows it by name, and has the same filter and tail
    expect(defsH).toMatch(/DELAY_CH8\[\] = \{"44K", "22K", "11K", 0\}/);
    expect(defsH).toMatch(new RegExp(`#define DELAY_TAIL ${DELAY_TAIL}\\b`));
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

  it('a new rate empties the line: the echo of what came before is gone', () => {
    const p = delayPatch({ time: 200, length: 700, rate: 0 });
    const e = new Engine(SR);
    e.load(p);
    const l = new Float32Array(Math.round(SR * 0.3));
    const r = new Float32Array(l.length);
    e.render(l, r);   // the line holds 0.3 s of the constant
    const dly = p.modules.find((m) => m.type === 'delay')!;
    e.setParam(dly.id, 'rate', 1);
    const l2 = new Float32Array(Math.round(SR * 0.1));
    e.render(l2, new Float32Array(l2.length));
    expect(Math.max(...l2.slice(256))).toBe(0);   // (a block or two at most of the old line)
    expect(DEVICE_SR).toBe(44118);
  });
});
