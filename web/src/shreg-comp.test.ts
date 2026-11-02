// SPDX-License-Identifier: GPL-3.0-only
// #438: the Shift register (Turing Machine / Rungler style) and the Comparator, both in the 1.9 format (49).
import { describe, expect, it } from 'vitest';
import { DEFS, IMPLS, instSeed, SHREG_STAGES, shregDac } from './modules';
import { addModule, connect, emptyPatch } from './patch';
import { encodePatch, FORMAT_1_9, formatOf, TYPE_ORDER, WRITE_FLOOR } from './patchbin';
import { lockOf } from './relevance';
import { outputRange } from './ranges';

const SR = 44118;

/** run a module sample by sample in blocks of `n`: `inp` gives each input's value at a sample, returns every output */
function run(type: string, len: number, inp: Record<string, (i: number) => number>, p: Record<string, number> = {}, seed = instSeed(0, 0), n = 128) {
  const impl = IMPLS[type], def = DEFS[type];
  const st = impl.init(SR);
  impl.seed?.(st, seed);
  const params = { ...Object.fromEntries(def.params.map((q) => [q.name, q.default])), ...p };
  const outs = Object.fromEntries(def.outputs.map((o) => [o.name, new Float32Array(len)]));
  for (let at = 0; at < len; at += n) {
    const m = Math.min(n, len - at);
    const ins = Object.fromEntries(def.inputs.map((d) => [d.name, Float32Array.from({ length: m }, (_, i) => inp[d.name]?.(at + i) ?? 0)]));
    const out = Object.fromEntries(def.outputs.map((o) => [o.name, new Float32Array(m)]));
    const connected = Object.fromEntries(def.inputs.map((d) => [d.name, d.name in inp]));
    impl.process({ sr: SR, n: m, inp: ins, out, connected, p: params, voice: {} as never }, st);
    for (const o of def.outputs) outs[o.name].set(out[o.name], at);
  }
  return outs;
}

/** a clock with a rising edge every `period` samples, high for half of it */
const clock = (period: number) => (i: number): number => (i % period < period / 2 ? 1 : 0);
/** the stages after each clock (sampled just before the next edge) as 8-bit numbers, s1 the highest bit */
function states(o: Record<string, Float32Array>, period: number, count: number): number[] {
  const r: number[] = [];
  for (let k = 0; k < count; k++) {
    const i = k * period + period - 1;
    let v = 0;
    for (let j = 0; j < SHREG_STAGES; j++) v = (v << 1) | (o[`s${j + 1}`][i] ? 1 : 0);
    r.push(v);
  }
  return r;
}

describe('Shift register (#438)', () => {
  it('is appended after the Follower, with eight stages, a dac and a gate', () => {
    expect(TYPE_ORDER.slice(-3)).toEqual(['esp', 'shreg', 'comp']);
    expect(DEFS.shreg.inputs.map((i) => i.name)).toEqual(['clock', 'in', 'reset', 'p1', 'p2']);
    expect(DEFS.shreg.outputs.map((o) => o.name)).toEqual(['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 'dac', 'gate']);
    expect(DEFS.shreg.params.map((q) => [q.name, q.default])).toEqual([['len', 8], ['flip', 0], ['bits', 8]]);
  });

  it('shifts each stage into the next on a rising clock', () => {
    const o = run('shreg', 64 * 20, { clock: clock(64) });
    const s = states(o, 64, 20);
    for (let k = 1; k < s.length; k++) expect(s[k] & 0x7f).toBe(s[k - 1] >> 1);
  });

  it('starts from a pattern of its seed, never all zeros, different per instance', () => {
    const pats = Array.from({ length: 64 }, (_, m) => run('shreg', 1, {}, {}, instSeed(m, 0)));
    const first = pats.map((o) => states(o, 1, 1)[0]);
    expect(first.every((v) => v !== 0)).toBe(true);
    expect(new Set(first).size).toBeGreaterThan(20);
  });

  it('with flip 0 loops every len clocks', () => {
    for (const len of [1, 3, 5, 8]) {
      const s = states(run('shreg', 64 * 40, { clock: clock(64) }, { len }), 64, 40);
      for (let k = 10; k + len < s.length; k++) expect(s[k + len]).toBe(s[k]);
    }
  });

  it('with flip 1 inverts the bit that comes round: a loop of twice len', () => {
    const len = 5;
    const s = states(run('shreg', 64 * 40, { clock: clock(64) }, { len, flip: 1 }), 64, 40);
    for (let k = 10; k + 2 * len < s.length; k++) {
      expect(s[k + 2 * len]).toBe(s[k]);
      expect((s[k + len] >> 7) ^ (s[k] >> 7)).toBe(1);
    }
  });

  it('with flip 0.5 changes about half of the bits that come round', () => {
    const s = states(run('shreg', 64 * 2000, { clock: clock(64) }, { len: 8, flip: 0.5 }), 64, 2000);
    let flips = 0;
    for (let k = 8; k < s.length; k++) flips += (s[k] >> 7) ^ (s[k - 8] >> 7);
    expect(flips / (s.length - 8)).toBeGreaterThan(0.4);
    expect(flips / (s.length - 8)).toBeLessThan(0.6);
  });

  it('takes its new bits from in when it is patched (high at 0.5), and len has no effect', () => {
    const bit = (k: number): number => (k * 7 + (k >> 2)) % 3 === 0 ? 1 : 0;
    const data = (i: number): number => (bit(Math.floor(i / 64)) ? 0.5 : 0.49);
    for (const len of [2, 8]) {
      const s = states(run('shreg', 64 * 30, { clock: clock(64), in: data }, { len }), 64, 30);
      for (let k = 0; k < s.length; k++) expect(s[k] >> 7).toBe(bit(k));
    }
    const p = emptyPatch();
    const sr = addModule(p, DEFS.shreg, 0, 0), lfo = addModule(p, DEFS.lfo, 0, 0);
    expect(lockOf(p, sr, DEFS.shreg.params, 'len')).toBeNull();
    connect(p, DEFS, { module: lfo.id, port: 'out' }, { module: sr.id, port: 'in' });
    expect(lockOf(p, sr, DEFS.shreg.params, 'len')).toMatch(/in patched/);
  });

  it('a reset brings back the starting pattern and the same flips follow', () => {
    const rst = (i: number): number => (i >= 64 * 50 && i < 64 * 50 + 10 ? 1 : 0);
    const s = states(run('shreg', 64 * 100, { clock: (i) => clock(64)(i + 32), reset: rst }, { flip: 0.5 }), 64, 100);
    const fresh = states(run('shreg', 64 * 100, { clock: (i) => clock(64)(i + 32) }, { flip: 0.5 }), 64, 100);
    expect(s.slice(0, 50)).toEqual(fresh.slice(0, 50));
    // the reset at sample 3200 restores the pattern; the clock edge at 3200 + 32 then shifts it as the first edge did
    expect(s.slice(50, 90)).toEqual(fresh.slice(0, 40));
  });

  it('the dac reads the first bits stages as a binary number, 0..1', () => {
    expect(shregDac(0xff, 8)).toBe(65536);
    expect(shregDac(0, 8)).toBe(0);
    expect(shregDac(0b10100000, 3)).toBe(Math.floor((5 * 65536 + 3) / 7));
    const o = run('shreg', 64 * 20, { clock: clock(64) }, { bits: 3 });
    const s = states(o, 64, 20);
    for (let k = 0; k < s.length; k++) expect(o.dac[k * 64 + 63]).toBeCloseTo(shregDac(s[k], 3) / 65536, 6);
    expect(outputRange('shreg', 'dac', { bits: 3 })).toMatch(/1\.\.3/);
  });

  it('gate is high while the clock is and s1 holds a 1', () => {
    const o = run('shreg', 64 * 20, { clock: clock(64) });
    for (let i = 0; i < 64 * 20; i++) expect(o.gate[i]).toBe(clock(64)(i) && o.s1[i] ? 1 : 0);
  });
});

describe('Comparator (#438)', () => {
  it('is appended after the Shift register', () => {
    expect(DEFS.comp.inputs.map((i) => i.name)).toEqual(['a', 'b', 'p1', 'p2']);
    expect(DEFS.comp.outputs.map((o) => o.name)).toEqual(['gt', 'lt', 'trig']);
    expect(DEFS.comp.params.map((q) => [q.name, q.default])).toEqual([['thresh', 0], ['hyst', 0]]);
  });

  it('gt while a is above b + thresh, lt the inverse', () => {
    const a = (i: number): number => Math.sin(i / 50);
    const b = (i: number): number => 0.3 * Math.cos(i / 170);
    const o = run('comp', 4000, { a, b }, { thresh: 0.2 });
    for (let i = 0; i < 4000; i++) {
      const d = Math.fround(a(i)) - Math.fround(b(i)) - 0.2;
      if (d > 0) expect(o.gt[i]).toBe(1);
      if (d < 0) expect(o.gt[i]).toBe(0);
      expect(o.lt[i]).toBe(1 - o.gt[i]);
    }
  });

  it('thresh alone sets the level with nothing on b', () => {
    const o = run('comp', 1000, { a: (i) => i / 1000 }, { thresh: 0.5 });
    expect(o.gt.findIndex((x) => x === 1)).toBe(501);
  });

  it('hysteresis: one switch per crossing of a noisy signal', () => {
    let seed = 1;
    const noise = (): number => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32 - 0.5) * 0.1;
    const vals = Array.from({ length: 20000 }, (_, i) => Math.sin((2 * Math.PI * i) / 2000) + noise());
    const a = (i: number): number => vals[i];
    const rises = (h: number): number => run('comp', 20000, { a }, { hyst: h }).trig.reduce((s, x) => s + x, 0);
    expect(rises(0)).toBeGreaterThan(10);
    expect(rises(0.1)).toBe(10);
  });

  it('trig is high for the one sample gt rises on', () => {
    const o = run('comp', 4000, { a: (i) => Math.sin(i / 40) });
    for (let i = 1; i < 4000; i++) expect(o.trig[i]).toBe(o.gt[i] && !o.gt[i - 1] ? 1 : 0);
  });
});

describe('format 49 (#438)', () => {
  it.each(['shreg', 'comp'])('a patch with a %s is written in the 1.9 format', (type) => {
    const p = emptyPatch();
    const o = addModule(p, DEFS.osc, 0, 0), out = addModule(p, DEFS.output, 300, 0);
    connect(p, DEFS, { module: o.id, port: 'out' }, { module: out.id, port: 'l' });
    expect(formatOf(p)).toBe(WRITE_FLOOR);
    const m = addModule(p, DEFS[type], 600, 0);
    expect(formatOf(p)).toBe(WRITE_FLOOR);   // (one that reaches nothing is left out of the FM-1's patch)
    connect(p, DEFS, { module: m.id, port: DEFS[type].outputs[0].name }, { module: out.id, port: 'r' });
    expect(formatOf(p)).toBe(FORMAT_1_9);
    expect(encodePatch(p)[1]).toBe(FORMAT_1_9);
    expect(DEFS[type].since).toBe(FORMAT_1_9);
  });
});
