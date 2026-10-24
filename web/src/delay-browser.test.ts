// SPDX-License-Identifier: GPL-3.0-only
// The browser's long Delay (docs/ledger/modules.md D-426): its time reaches 1.6 s here, the FM-1's 520 ms. Within 520 ms the
// browser plays as before (and as the FM-1); past it the patch is browser only, so over the FM-1 budget and never sent.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFS, DELAY_TIME_BROWSER, DELAY_TIME_MAX, DEVICE_SR } from './modules';
import { addModule, connect, emptyPatch, modulate, morphValue, topOf, type Patch } from './patch';
import { browserOnly, deviceBudget, encodePatch, toQ16 } from './patchbin';
import { Engine } from './engine';

const SR = 44100;
const delayPd = DEFS.delay.params.find((q) => q.name === 'time')!;

/** a constant 1 into a Delay (mix 1, no feedback) into the Output: silent until the echo arrives */
function delayPatch(params: Record<string, number>): Patch {
  const p = emptyPatch('Long');
  addModule(p, DEFS.fm1, 0, 0);
  const one = addModule(p, DEFS.const, 0, 0);
  one.params.value = 1;
  const dly = addModule(p, DEFS.delay, 0, 0);
  Object.assign(dly.params, { fb: 0, mix: 1, ...params });
  const out = addModule(p, DEFS.output, 0, 0);
  out.params.level = 0.7;
  connect(p, DEFS, { module: one.id, port: 'out' }, { module: dly.id, port: 'in' });
  connect(p, DEFS, { module: dly.id, port: 'out' }, { module: out.id, port: 'l' });
  connect(p, DEFS, { module: dly.id, port: 'r' }, { module: out.id, port: 'r' });
  return p;
}

/** the first sample the echo is heard on, left and right */
function echoAt(params: Record<string, number>, secs = 2.5): { l: number; r: number } {
  const e = new Engine(SR);
  e.load(delayPatch(params));
  const l = new Float32Array(Math.round(SR * secs));
  const r = new Float32Array(l.length);
  e.render(l, r);
  return { l: l.findIndex((v) => v > 0.3), r: r.findIndex((v) => v > 0.3) };
}

/** the FM-1's line in samples at SR (engine.c DELAY_LEN) */
const FM1_LINE = Math.round((SR * 23000) / DEVICE_SR);

describe('the browser-only long Delay', () => {
  it('keeps the FM-1 range for everything the FM-1 shares, and stretches only in the browser', () => {
    expect(delayPd.max).toBe(DELAY_TIME_MAX);
    expect(DELAY_TIME_MAX).toBe(520);
    expect(topOf(delayPd)).toBe(DELAY_TIME_BROWSER);
    expect(DELAY_TIME_BROWSER).toBe(1600);
    // defs.h (export-defs) keeps 520 ms: the firmware is unchanged
    const defs = readFileSync(new URL('../../firmware/src/defs.h', import.meta.url), 'utf8');
    expect(defs).toMatch(new RegExp(`DELAY_MAX\\[\\] = \\{${toQ16(520)},`));
  });

  it('plays a time within 520 ms as before: free, and synced (a note length longer than the FM-1 line is cut to it)', () => {
    expect(echoAt({ time: 500 }).l).toBe(Math.round(0.5 * SR));
    expect(echoAt({ time: 250 }).l).toBe(Math.round(0.25 * SR));
    // synced, no clock (120 bpm): the top of the range is 1/1, two seconds, cut to the FM-1's line
    expect(echoAt({ time: DELAY_TIME_MAX, sync: 1 }).l).toBe(FM1_LINE - 1);
    // ping-pong: half the FM-1's line
    const pp = echoAt({ time: DELAY_TIME_MAX, pingpong: 1 });
    expect(pp.l).toBe(Math.floor(FM1_LINE / 2) - 1);
  });

  it('reaches 1.6 s past the FM-1 range', () => {
    expect(echoAt({ time: 1200 }).l).toBe(Math.round(1.2 * SR));
    expect(echoAt({ time: 1600 }).l).toBe(Math.round(1.6 * SR));
    // synced past 520 ms: still the longest note length (1/1), now on the longer line
    expect(echoAt({ time: 1200, sync: 1 }, 3).l).toBeGreaterThan(Math.round(1.6 * SR) - 1);
    // ping-pong: half the longer line
    expect(echoAt({ time: 1600, pingpong: 1 }).l).toBeGreaterThan(Math.round(0.8 * SR) - 1);
  });

  it('modulation and morph past 520 ms stay in the stretch; within the range they are as before', () => {
    expect(modulate(delayPd, 300, 1)).toBe(DELAY_TIME_MAX);
    expect(modulate(delayPd, 300, -1)).toBe(1);
    expect(modulate(delayPd, 1200, 0)).toBe(1200);
    expect(modulate(delayPd, 1200, 1)).toBe(DELAY_TIME_BROWSER);
    expect(morphValue(delayPd, 300, 1200, 0.5)).toBe(750);
    expect(morphValue(delayPd, 100, 500, 0.5)).toBeCloseTo(300, 9);
  });

  it('a 1.2 s Delay is browser only: over the FM-1 budget with its reason, and never encoded', () => {
    const p = delayPatch({ time: 1200 });
    expect(browserOnly(p)).toEqual(['Delay over 520 ms: browser only']);
    const b = deviceBudget(p);
    expect(b.fits).toBe(false);
    expect(b.over).toContainEqual({ key: 'browser', label: 'Delay over 520 ms: browser only', used: 1, max: 0 });
    expect(() => encodePatch(p)).toThrow(/over the FM-1 budget: Delay over 520 ms: browser only/);
    // the morph's B side counts too
    const q = delayPatch({ time: 400 });
    q.modules.find((m) => m.type === 'delay')!.paramsB = { time: 900 };
    expect(deviceBudget(q).fits).toBe(false);
  });

  it('a Delay within 520 ms fits as before', () => {
    for (const time of [1, 250, 520]) {
      const p = delayPatch({ time });
      expect(browserOnly(p)).toEqual([]);
      expect(deviceBudget(p).fits).toBe(true);
      expect(() => encodePatch(p)).not.toThrow();
    }
  });
});
