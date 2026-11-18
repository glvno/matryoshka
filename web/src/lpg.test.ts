// SPDX-License-Identifier: GPL-3.0-only
// #1018: the Low pass gate (ported from KITTEN RACK's lpg, with a resonance row), in the 1.19 format (62).
import { describe, expect, it } from 'vitest';
import { DEFS, IMPLS } from './modules';
import { addModule, connect, emptyPatch } from './patch';
import { encodePatch, FORMAT_1_19, formatOf, TYPE_ORDER, WRITE_FLOOR } from './patchbin';
import { lockOf } from './relevance';

const SR = 44118;

/** run the Low pass gate in blocks of 128: `inp` gives each patched input's value at a sample; returns its out */
function run(len: number, inp: Record<string, (i: number) => number>, p: Record<string, number> = {}): Float32Array {
  const impl = IMPLS.lpg, def = DEFS.lpg;
  const st = impl.init(SR);
  const params = { ...Object.fromEntries(def.params.map((q) => [q.name, q.default])), ...p };
  const res = new Float32Array(len);
  for (let at = 0; at < len; at += 128) {
    const m = Math.min(128, len - at);
    const ins = Object.fromEntries(def.inputs.map((d) => [d.name, Float32Array.from({ length: m }, (_, i) => inp[d.name]?.(at + i) ?? 0)]));
    const out = { out: new Float32Array(m) };
    const connected = Object.fromEntries(def.inputs.map((d) => [d.name, d.name in inp]));
    impl.process({ sr: SR, n: m, inp: ins, out, connected, p: params, voice: {} as never }, st);
    res.set(out.out, at);
  }
  return res;
}

const peak = (x: Float32Array, from: number, to: number): number => x.subarray(from, to).reduce((a, v) => Math.max(a, Math.abs(v)), 0);
/** a sine of `hz` at amplitude 0.5 */
const sine = (hz: number) => (i: number): number => 0.5 * Math.sin((2 * Math.PI * hz * i) / SR);

describe('Low pass gate (#1018)', () => {
  it('is appended after the Harmonizer, with in, cv and strike, and a resonance row last', () => {
    expect(TYPE_ORDER.slice(TYPE_ORDER.indexOf('harm'), TYPE_ORDER.indexOf('harm') + 2)).toEqual(['harm', 'lpg']);
    expect(DEFS.lpg.inputs.map((i) => i.name)).toEqual(['in', 'cv', 'strike', 'p1', 'p2']);
    expect(DEFS.lpg.outputs.map((o) => o.name)).toEqual(['out']);
    expect(DEFS.lpg.params.map((q) => [q.name, q.default])).toEqual([['mode', 0], ['decay', 0.4], ['offset', 0], ['level', 1], ['res', 0]]);
  });

  it('is closed with nothing in cv, and a strike opens it then lets it close in about the decay', () => {
    const len = SR;
    const o = run(len, { in: sine(200), strike: (i) => (i >= 1000 && i < 1100 ? 1 : 0) }, { decay: 0.3 });
    expect(peak(o, 0, 1000)).toBeLessThan(1e-6);
    const open = peak(o, 1100, 2000);
    expect(open).toBeGreaterThan(0.3);
    expect(peak(o, 1000 + 0.6 * SR, len)).toBeLessThan(open * 0.05);
  });

  it('closes more slowly as it nears closed (the vactrol)', () => {
    const o = run(SR, { in: () => 1, strike: (i) => (i >= 0 && i < 10 ? 1 : 0) }, { mode: 2, decay: 0.3 });
    const t = (lvl: number): number => o.findIndex((v, i) => i > 10 && v < lvl);
    // the same fall in level takes longer from 0.2 to 0.1 than from 0.9 to 0.8
    expect(t(0.1) - t(0.2)).toBeGreaterThan(t(0.8) - t(0.9));
  });

  it('in combo darkens as it closes: a high tone fades faster than a low one', () => {
    const strike = (i: number): number => (i < 10 ? 1 : 0);
    const lo = run(SR / 2, { in: sine(100), strike }, { decay: 0.5 }), hi = run(SR / 2, { in: sine(4000), strike }, { decay: 0.5 });
    const at = Math.round(0.25 * SR);
    expect(peak(hi, at, at + 2000) / peak(hi, 200, 2000)).toBeLessThan(peak(lo, at, at + 2000) / peak(lo, 200, 2000));
  });

  it('vca mode only scales the input; lp mode only filters at full level', () => {
    const v = run(4000, { in: () => 0.5, cv: () => 0.5 }, { mode: 2 });
    expect(v[3999]).toBeCloseTo(0.25, 3);
    const l = run(20000, { in: () => 0.5, cv: () => 0.5 }, { mode: 1 });
    expect(l[19999]).toBeCloseTo(0.5, 3);
  });

  it('resonance lifts a tone near the cutoff while the gate is nearly closed, keeps the level of a low one, and stays finite', () => {
    const cv = (): number => 0.3;
    const near = (r: number): number => peak(run(SR / 2, { in: sine(1500), cv }, { mode: 1, res: r }), SR / 4, SR / 2);
    expect(near(1)).toBeGreaterThan(near(0) * 1.5);
    const dc = run(SR / 2, { in: () => 0.5, cv }, { mode: 1, res: 1 });
    expect(dc[SR / 2 - 1]).toBeCloseTo(0.5, 3);
    for (const c of [0, 0.2, 0.5, 0.8, 1]) {
      const o = run(SR / 4, { in: (i) => (i % 50 < 25 ? 1 : -1), cv: () => c }, { mode: 0, res: 1 });
      expect(o.every(Number.isFinite)).toBe(true);
      expect(peak(o, 0, o.length)).toBeLessThan(4);
    }
  });

  it('res is dimmed in vca mode', () => {
    const p = emptyPatch();
    const m = addModule(p, DEFS.lpg, 0, 0);
    m.params.mode = 2;
    expect(lockOf(p, m, DEFS.lpg.params, 'res')).not.toBeNull();
    m.params.mode = 0;
    expect(lockOf(p, m, DEFS.lpg.params, 'res')).toBeNull();
  });
});

describe('format 62 (#1018)', () => {
  it('a patch with a Low pass gate that reaches the output is written in the 1.19 format', () => {
    const p = emptyPatch();
    const o = addModule(p, DEFS.osc, 0, 0), out = addModule(p, DEFS.output, 300, 0);
    connect(p, DEFS, { module: o.id, port: 'out' }, { module: out.id, port: 'l' });
    expect(formatOf(p)).toBe(WRITE_FLOOR);
    const m = addModule(p, DEFS.lpg, 600, 0);
    expect(formatOf(p)).toBe(WRITE_FLOOR);   // (one that reaches nothing is left out of the FM-1's patch)
    connect(p, DEFS, { module: o.id, port: 'out' }, { module: m.id, port: 'in' });
    connect(p, DEFS, { module: m.id, port: 'out' }, { module: out.id, port: 'r' });
    expect(formatOf(p)).toBe(FORMAT_1_19);
    expect(encodePatch(p)[1]).toBe(FORMAT_1_19);
    expect(DEFS.lpg.since).toBe(FORMAT_1_19);
  });
});
