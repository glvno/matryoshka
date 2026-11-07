// SPDX-License-Identifier: GPL-3.0-only
// Tape on the Delay (#660, docs/ledger/modules.md): darker, softer repeats (a low pass and a high pass in the feedback loop),
// saturation in the loop, wow and flutter, and up to three playback heads at 1x, 2x and 3x the time, from the same line.
// Tape off plays exactly as the Delay without it.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFS, DELAY_HEADS, DELAY_HEAD_MASK, delayLine, DEVICE_SR } from './modules';
import { addModule, connect, emptyPatch, type Patch } from './patch';
import { deviceBudget, formatOf, FORMAT_1_11 } from './patchbin';
import { Engine } from './engine';

const SR = 44100;
const defsH = readFileSync(new URL('../../firmware/src/defs.h', import.meta.url), 'utf8');

/** a Const into a Delay (mix 1) into the Output; `pulse` frames of 1, then 0 (an impulse of one block) */
function setup(params: Record<string, number>, input: 'pulse' | 'sine' = 'pulse'): { e: Engine; p: Patch; src: number } {
  const p = emptyPatch('Tape');
  addModule(p, DEFS.fm1, 0, 0);
  const src = input === 'pulse' ? addModule(p, DEFS.const, 0, 0) : addModule(p, DEFS.osc, 0, 0);
  if (input === 'pulse') src.params.value = 0.5;
  else Object.assign(src.params, { wave: 0, level: 0.5, coarse: 12 });
  const dly = addModule(p, DEFS.delay, 0, 0);
  Object.assign(dly.params, { fb: 0, mix: 1, ...params });
  const out = addModule(p, DEFS.output, 0, 0);
  out.params.level = 1;
  connect(p, DEFS, { module: src.id, port: 'out' }, { module: dly.id, port: 'in' });
  connect(p, DEFS, { module: dly.id, port: 'out' }, { module: out.id, port: 'l' });
  connect(p, DEFS, { module: dly.id, port: 'r' }, { module: out.id, port: 'r' });
  const e = new Engine(SR);
  e.load(p);
  return { e, p, src: src.id };
}

/** the left output over `secs`, the input a 128-frame pulse at the start (or the sine throughout) */
function run(params: Record<string, number>, secs: number, input: 'pulse' | 'sine' = 'pulse'): Float32Array {
  const { e, src } = setup(params, input);
  const l = new Float32Array(Math.round(SR * secs));
  const r = new Float32Array(l.length);
  if (input === 'pulse') {
    e.render(l.subarray(0, 128), r.subarray(0, 128));
    e.setParam(src, 'value', 0);
    e.render(l.subarray(128), r.subarray(128));
  } else e.render(l, r);
  return l;
}
/** where the output rises past half the pulse's echo level after `from` */
const rise = (l: Float32Array, from: number, th = 0.05): number => {
  for (let i = from; i < l.length; i++) if (Math.abs(l[i]) > th) return i;
  return -1;
};

describe('Tape on the Delay', () => {
  it('appends tape, wow and heads in format 51; Tape off is written as before', () => {
    const names = DEFS.delay.params.map((q) => q.name);
    expect(names.slice(-4)).toEqual(['rate', 'tape', 'wow', 'heads']);
    for (const n of ['tape', 'wow', 'heads']) expect(DEFS.delay.params.find((q) => q.name === n)!.since).toBe(FORMAT_1_11);
    expect(DEFS.delay.params.find((q) => q.name === 'heads')!.choices).toEqual(['1', '2', '3', '1+2', '1+3', '2+3', '1+2+3']);
    expect(DELAY_HEADS.length).toBe(DELAY_HEAD_MASK.length);
    expect(defsH).toMatch(/DELAY_CH11\[\] = \{"1", "2", "3", "1\+2", "1\+3", "2\+3", "1\+2\+3", 0\}/);
    expect(formatOf(setup({ time: 300 }).p)).toBeLessThan(FORMAT_1_11);
    expect(formatOf(setup({ time: 300, tape: 1 }).p)).toBe(FORMAT_1_11);
    // no memory of its own: the same line
    expect(deviceBudget(setup({ time: 300, tape: 1, heads: 6 }).p).memory).toBe(deviceBudget(setup({ time: 300 }).p).memory);
  });

  it('Tape off plays exactly as a Delay without the rows, whatever wow and heads say', () => {
    const a = run({ time: 120, fb: 0.6 }, 0.6, 'sine');
    const b = run({ time: 120, fb: 0.6, tape: 0, wow: 1, heads: 6 }, 0.6, 'sine');
    expect(b).toEqual(a);
  });

  it('each head echoes at its multiple of the time; HEADS picks them; together each is 1 / n', () => {
    const T = Math.round(0.1 * SR);
    for (const [h, mask] of DELAY_HEAD_MASK.entries()) {
      const l = run({ time: 100, tape: 1, wow: 0, heads: h }, 0.45);
      const firsts = [1, 2, 3].filter((j) => mask & (1 << (j - 1)));
      const n = firsts.length;
      for (const j of [1, 2, 3]) {
        const at = j * T + 64;   // the middle of the pulse's echo
        if (firsts.includes(j)) expect(Math.abs(l[at])).toBeGreaterThan(0.35 / n);
        else expect(Math.abs(l[at])).toBeLessThan(0.01);
      }
    }
  });

  it('a head past the line plays at the line\'s end', () => {
    // a 300 ms line, time 200 ms: head 2 (400 ms) and head 3 (600 ms) both at the line's end, about 300 ms
    const l = run({ time: 200, tape: 1, wow: 0, heads: 1, length: 300 }, 0.5);
    const at = rise(l, 1000);
    const line = Math.round((SR * delayLine(300)) / DEVICE_SR) - 48;
    expect(Math.abs(at - (line - 1))).toBeLessThanOrEqual(3);
  });

  it('repeats lose highs and lows: an echo of a held level dies away in the loop, and the loop never runs away', () => {
    // a held 0.5 into a 50 ms Delay with feedback 0.9: without Tape its echoes pile up (DC through the loop); with Tape the
    // high pass lets the steady level fade
    const held = (tape: number): number => {
      const { e } = setup({ time: 50, fb: 0.9, tape, wow: 0, mix: 1 });
      const l = new Float32Array(SR * 3), r = new Float32Array(l.length);
      e.render(l, r);
      return l[l.length - 1];
    };
    expect(held(0)).toBeGreaterThan(0.99);              // 0.5 / (1 - 0.9), held to 1 by the Output
    expect(Math.abs(held(1) - 0.5)).toBeLessThan(0.05);  // only the input itself (softly clipped): the loop lets the level go
    // swell at its most with three heads: the saturation holds it near full level
    const s = run({ time: 40, fb: 0.95, swell: 1, tape: 1, heads: 6 }, 2, 'sine');
    let peak = 0;
    for (const v of s) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeLessThan(1.5);
  });

  it('wow and flutter move the echo: none keeps it still, the most bends it', () => {
    const still = run({ time: 300, tape: 1, wow: 0 }, 1.5, 'sine');
    const moved = run({ time: 300, tape: 1, wow: 1 }, 1.5, 'sine');
    let diff = 0;
    for (let i = Math.round(0.4 * SR); i < still.length; i++) diff = Math.max(diff, Math.abs(still[i] - moved[i]));
    expect(diff).toBeGreaterThan(0.05);
  });
});
