// SPDX-License-Identifier: GPL-3.0-only
// #1018: the Euclid (ported from KITTEN RACK's euclid, with an accent and the engine's clock), in the 1.20 format (63).
import { describe, expect, it } from 'vitest';
import { DEFS, euclidStep, IMPLS } from './modules';
import { addModule, connect, emptyPatch } from './patch';
import { encodePatch, FORMAT_1_20, formatOf, TYPE_ORDER, WRITE_FLOOR } from './patchbin';
import { lockOf } from './relevance';
import { moduleKeywords } from './labels';

const SR = 44118;
const OUTS = ['trig', 'off', 'accent'] as const;
type Outs = Record<(typeof OUTS)[number], Float32Array>;
/** the engine's clock as engine.ts gives it a block: the sample its tick falls on (-1 none), how many, samples per tick */
interface Clock { run: boolean; tick: number; ticks: number; tickLen: number }

/** run the Euclid in blocks of 128: `inp` gives each patched input's value at a sample, `clock` each block's engine clock */
function run(len: number, inp: Record<string, (i: number) => number>, p: Record<string, number> = {}, clock: (block: number) => Clock = () => ({ run: false, tick: -1, ticks: 0, tickLen: 919 })): Outs {
  const impl = IMPLS.euclid, def = DEFS.euclid;
  const st = impl.init(SR);
  const params = { ...Object.fromEntries(def.params.map((q) => [q.name, q.default])), ...p };
  const res = Object.fromEntries(OUTS.map((o) => [o, new Float32Array(len)])) as Outs;
  for (let at = 0; at < len; at += 128) {
    const m = Math.min(128, len - at);
    const ins = Object.fromEntries(def.inputs.map((d) => [d.name, Float32Array.from({ length: m }, (_, i) => inp[d.name]?.(at + i) ?? 0)]));
    const out = Object.fromEntries(OUTS.map((o) => [o, new Float32Array(m)]));
    const connected = Object.fromEntries(def.inputs.map((d) => [d.name, d.name in inp]));
    impl.process({ sr: SR, n: m, inp: ins, out, connected, p: params, voice: clock(at / 128) as never }, st);
    for (const o of OUTS) res[o].set(out[o], at);
  }
  return res;
}

/** a clock of `period` samples, up for the first half */
const pulses = (period: number) => (i: number): number => (i % period < period / 2 ? 1 : 0);
/** what an output plays on each of `n` clock periods: 1 where it is up in the period's first sample */
const steps = (o: Float32Array, period: number, n: number): string => Array.from({ length: n }, (_, k) => (o[k * period] ? 'x' : '.')).join('');

describe('Euclid (#1018)', () => {
  it('is appended after the Limiter, with clock and reset in, trig, off and accent out', () => {
    expect(TYPE_ORDER.slice(TYPE_ORDER.indexOf('limit'), TYPE_ORDER.indexOf('limit') + 2)).toEqual(['limit', 'euclid']);
    expect(DEFS.euclid.inputs.map((i) => i.name)).toEqual(['clock', 'reset', 'p1', 'p2']);
    expect(DEFS.euclid.outputs.map((o) => o.name)).toEqual(['trig', 'off', 'accent']);
    expect(DEFS.euclid.params.map((q) => [q.name, q.default])).toEqual([['steps', 8], ['hits', 3], ['rotate', 0], ['accent', 0], ['rate', 4]]);
  });

  it('spreads the hits as evenly as they go: the Euclidean rhythms', () => {
    const pat = (s: number, h: number): string => Array.from({ length: s }, (_, x) => (euclidStep(x, s, h, 0) ? 'x' : '.')).join('');
    expect(pat(8, 3)).toBe('x..x..x.');   // tresillo
    expect(pat(8, 5)).toBe('x.x.xx.x');   // the cinquillo x.xx.xx., turned (rotate 2 plays it)
    expect(pat(16, 4)).toBe('x...x...x...x...');
    expect(pat(5, 0)).toBe('.....');
    expect(pat(5, 5)).toBe('xxxxx');
  });

  it('accents that many of the hits, spread over them, the first hit always', () => {
    const acc = (s: number, h: number, a: number): string => Array.from({ length: s }, (_, x) => '.xA'[euclidStep(x, s, h, a)]).join('');
    expect(acc(8, 4, 2)).toBe('A.x.A.x.');
    expect(acc(16, 6, 1)).toBe('A..x..x.x..x..x.');
  });

  it('on a clock: a step each rising edge, the outputs up while the clock is, rotate and reset', () => {
    const per = 200, n = 16, ck = pulses(per);
    const o = run(per * n, { clock: ck }, { steps: 8, hits: 3, accent: 1 });
    expect(steps(o.trig, per, n)).toBe('x..x..x.x..x..x.');
    expect(steps(o.off, per, n)).toBe('.xx.xx.x.xx.xx.x');
    expect(steps(o.accent, per, n)).toBe('x.......x.......');
    expect(o.trig[per / 2]).toBe(0);   // (down with the clock)
    expect(steps(run(per * 8, { clock: ck }, { steps: 8, hits: 3, rotate: 1 }).trig, per, 8)).toBe('..x..x.x');
    const r = run(per * n, { clock: ck, reset: (i) => (i >= 5 * per - 50 && i < 5 * per - 10 ? 1 : 0) }, { steps: 8, hits: 3 });
    expect(steps(r.trig, per, n)).toBe('x..x.x..x..x.x..');
  });

  it('with nothing in clock follows the engine clock while the transport runs: first step at PLAY, then one per rate', () => {
    // 1/16 = 6 ticks; a tick on sample 10 of every block; the transport starts at block 2
    const clock = (b: number): Clock => ({ run: b >= 2, tick: b >= 2 ? 10 : -1, ticks: 1, tickLen: 128 });
    const o = run(128 * 40, {}, { steps: 4, hits: 1 }, clock);
    const starts = Array.from(o.trig.keys()).filter((i) => o.trig[i] && !o.trig[i - 1]);
    const rests = Array.from(o.off.keys()).filter((i) => o.off[i] && !o.off[i - 1]);
    expect(starts[0]).toBe(256);   // (PLAY's first sample)
    expect(starts[1] - starts[0]).toBe(5 * 128 + 10 + 3 * 6 * 128);   // (4 steps on: the start block holds the second step's first tick)
    expect(rests[0]).toBe(256 + 5 * 128 + 10);   // (the 6th tick after the start)
    expect(o.trig.subarray(256, 256 + 6 * 128 / 2).every((v) => v === 1)).toBe(true);   // (up for half a step)
    expect(o.trig[256 + 6 * 128 / 2]).toBe(0);
    expect(run(128 * 20, {}, {}, () => ({ run: false, tick: -1, ticks: 0, tickLen: 128 })).trig.some((v) => v)).toBe(false);
  });

  it('dims rate with a cable in clock and accent with no hits', () => {
    const p = emptyPatch();
    const m = addModule(p, DEFS.euclid, 0, 0), l = addModule(p, DEFS.lfo, 0, 0);
    expect(lockOf(p, m, DEFS.euclid.params, 'rate')).toBeNull();
    connect(p, DEFS, { module: l.id, port: 'out' }, { module: m.id, port: 'clock' });
    expect(lockOf(p, m, DEFS.euclid.params, 'rate')).not.toBeNull();
    m.params.hits = 0;
    expect(lockOf(p, m, DEFS.euclid.params, 'accent')).not.toBeNull();
  });

  it('is found by euclidean and bjorklund', () => {
    const k = moduleKeywords('euclid', DEFS.euclid.label);
    for (const w of ['Euclid', 'euclidean', 'bjorklund']) expect(k).toContain(w);
  });
});

describe('format 63 (#1018)', () => {
  it('a patch with a Euclid that reaches the output is written in the 1.20 format', () => {
    const p = emptyPatch();
    const o = addModule(p, DEFS.osc, 0, 0), out = addModule(p, DEFS.output, 300, 0), v = addModule(p, DEFS.vca, 300, 0);
    connect(p, DEFS, { module: o.id, port: 'out' }, { module: v.id, port: 'in' });
    connect(p, DEFS, { module: v.id, port: 'out' }, { module: out.id, port: 'l' });
    expect(formatOf(p)).toBe(WRITE_FLOOR);
    const m = addModule(p, DEFS.euclid, 600, 0);
    expect(formatOf(p)).toBe(WRITE_FLOOR);   // (one that reaches nothing is left out of the FM-1's patch)
    connect(p, DEFS, { module: m.id, port: 'trig' }, { module: v.id, port: 'cv' });
    expect(formatOf(p)).toBe(FORMAT_1_20);
    expect(encodePatch(p)[1]).toBe(FORMAT_1_20);
    expect(DEFS.euclid.since).toBe(FORMAT_1_20);
  });
});
