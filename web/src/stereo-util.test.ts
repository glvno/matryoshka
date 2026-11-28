// SPDX-License-Identifier: GPL-3.0-only
// #1324: the Stereo utility, in patch format 72. Its jacks and how cables reach them (feeds.ts), its arithmetic (the same
// Q16 integer steps as engine.c m_stutil: the golden kits stereo-util-* compare the two engines, tools/golden.sh), the
// format rule and its memory.
import { describe, expect, it } from 'vitest';
import { DEFS, IMPLS, STU_DELAY_MAX, stuLineLen, stutilSize, stutilThru } from './modules';
import { addModule, connect, emptyPatch, type Patch } from './patch';
import { encodePatch, FORMAT_1_30, FORMAT_1_31, formatOf, stutilBytes, TYPE_ORDER } from './patchbin';
import { cableFeeds, feedModel, outputRead } from './feeds';

const SR = 44118;
const base = Object.fromEntries(DEFS.stutil.params.map((q) => [q.name, q.default]));

/** run a Stereo utility on these inlets (one value per sample on the Q16 grid), in blocks of 128 */
function run(inp: { in?: number[]; l?: number[]; r?: number[] }, p: Record<string, number>, sr = SR): { l: number[]; r: number[]; out: number[] } {
  const len = Math.max(...Object.values(inp).map((x) => x.length));
  const impl = IMPLS.stutil, st = impl.init(sr), res = { l: [] as number[], r: [] as number[], out: [] as number[] };
  stutilSize(st, { ...base, ...p }, sr);   // (its lines for these delays, as engine.ts sizes them at load)
  const at = (x: number[] | undefined, from: number, n: number): Float32Array => Float32Array.from({ length: n }, (_, i) => x?.[from + i] ?? 0);
  for (let from = 0; from < len; from += 128) {
    const n = Math.min(128, len - from), out = { out: new Float32Array(n), l: new Float32Array(n), r: new Float32Array(n) };
    impl.process({ sr, n, inp: { in: at(inp.in, from, n), l: at(inp.l, from, n), r: at(inp.r, from, n), p1: new Float32Array(n), p2: new Float32Array(n) }, out, connected: {}, p: { ...base, ...p }, voice: {} as never }, st);
    res.l.push(...out.l);
    res.r.push(...out.r);
    res.out.push(...out.out);
  }
  return res;
}
/** a test signal on the Q16 grid (what the FM-1's signals are) */
const wave = (len: number, f: number, a: number): number[] => Array.from({ length: len }, (_, i) => Math.round(a * Math.sin(i * f) * 65536) / 65536);

describe('the Stereo utility (#1324)', () => {
  it('is appended after the DX7, in format 72: in, l, r -> out, l, r; its pairs are in/r and out/r', () => {
    expect(TYPE_ORDER.slice(-2)).toEqual(['dx7', 'stutil']);
    expect(DEFS.stutil.since).toBe(FORMAT_1_31);
    expect(DEFS.stutil.inputs.map((i) => i.name)).toEqual(['in', 'l', 'r', 'p1', 'p2']);
    expect(DEFS.stutil.outputs.map((o) => o.name)).toEqual(['out', 'l', 'r']);
    expect(DEFS.stutil.params.map((q) => q.name)).toEqual(['mode', 'bal', 'width', 'swap', 'dl', 'dr', 'invert', 'unit']);
  });

  it('writes format 72 only for a patch with one', () => {
    const p = emptyPatch();
    const kb = addModule(p, DEFS.fm1, 0, 0), out = addModule(p, DEFS.output, 0, 0);
    connect(p, DEFS, { module: kb.id, port: 'pitch' }, { module: out.id, port: 'l' });
    expect(formatOf(p)).toBeLessThan(FORMAT_1_30);
    const u = addModule(p, DEFS.stutil, 0, 0);
    connect(p, DEFS, { module: u.id, port: 'out' }, { module: out.id, port: 'r' });
    expect(formatOf(p)).toBe(FORMAT_1_31);
    expect(encodePatch(p)[1]).toBe(FORMAT_1_31);
  });

  it('takes memory only for its saved delays: none at 0, at most 16 KB (45 ms) on the FM-1', () => {
    expect(stutilBytes({ dl: 0, dr: 0 })).toBe(0);
    expect(stutilBytes({ dl: 1, dr: 0 })).toBe(8 * 64);   // (44 samples and the one read past it: 64 per side)
    expect(stutilBytes({ dl: 3, dr: 10 })).toBe(8 * 512);   // (10 ms: 441 samples)
    expect(stutilBytes({ dl: STU_DELAY_MAX, dr: 0 })).toBe(8 * 2048);
    expect(stuLineLen(0, 0.01, SR)).toBe(2);
  });

  it('holds a delay to its line: a delay raised past what the saved one sized waits for the patch to load again', () => {
    const x = Array.from({ length: 200 }, (_, i) => (i === 10 ? 1 : 0));
    const impl = IMPLS.stutil, st = impl.init(SR);
    stutilSize(st, { dl: 1, dr: 0 }, SR);   // (64 samples per side)
    const out = { out: new Float32Array(200), l: new Float32Array(200), r: new Float32Array(200) }, z = new Float32Array(200);
    impl.process({ sr: SR, n: 200, inp: { in: Float32Array.from(x), l: z, r: z, p1: z, p2: z }, out, connected: {}, p: { ...base, dl: 40 }, voice: {} as never }, st);
    expect(out.l.indexOf(1)).toBe(-1);
    expect(out.l[10 + 63]).toBeGreaterThan(0.99);   // (held to just under 63 samples)
  });

  it('in L/R with its rows as made, passes both sides through exactly', () => {
    const l = wave(600, 0.05, 0.6), r = wave(600, 0.13, 0.4);
    const o = run({ l, r }, {});
    expect(o.l).toEqual(l);
    expect(o.out).toEqual(l);
    expect(o.r).toEqual(r);
  });

  it('M/S encode is M = (L + R) / 2, S = (L - R) / 2; decode then gives back R exactly and L within one Q16 step', () => {
    const l = wave(700, 0.07, 0.7), r = wave(700, 0.011, 0.5);
    const e = run({ l, r }, { mode: 1 });
    e.l.forEach((m, i) => expect(Math.abs(m - (l[i] + r[i]) / 2)).toBeLessThanOrEqual(1 / 65536));
    const d = run({ l: e.l, r: e.r }, { mode: 2 });
    expect(d.r).toEqual(r);
    d.l.forEach((v, i) => expect(l[i] - v === 0 || l[i] - v === 1 / 65536).toBe(true));
  });

  it('balance: the far side falls linearly, the near side stays at full level; in M/S it sets mid against side', () => {
    const one = Array(10).fill(0.5);
    for (const [b, gl, gr] of [[0, 1, 1], [0.5, 0.5, 1], [-0.25, 1, 0.75], [1, 0, 1], [-1, 1, 0]]) {
      const o = run({ l: one, r: one }, { bal: b });
      expect(o.l[5]).toBeCloseTo(0.5 * gl, 4);
      expect(o.r[5]).toBeCloseTo(0.5 * gr, 4);
    }
    const ms = run({ l: Array(10).fill(0.5), r: Array(10).fill(0.25) }, { mode: 2, bal: -1 });   // (side gone: mid on both)
    expect([ms.l[5], ms.r[5]]).toEqual([0.5, 0.5]);
  });

  it('width scales the side part (0 mono, 2 twice as wide), swap exchanges the sides, invert flips a side', () => {
    const l = Array(10).fill(0.5), r = Array(10).fill(0.125);
    expect(run({ l, r }, { width: 0 }).l[3]).toBe(0.3125);
    expect(run({ l, r }, { width: 0 }).r[3]).toBe(0.3125);
    expect(run({ l, r }, { width: 2 }).l[3]).toBe(0.6875);
    expect(run({ l, r }, { width: 2 }).r[3]).toBe(-0.0625);
    const s = run({ l, r }, { swap: 1, invert: 2 });
    expect([s.l[3], s.r[3]]).toEqual([0.125, -0.5]);
  });

  it('each side delays by its row (ms, on the Q16 grid), gliding between samples', () => {
    const x = Array.from({ length: 400 }, (_, i) => (i === 10 ? 1 : 0));
    const ms = (n: number): number => (n * 1000) / SR;
    const o = run({ l: x, r: x }, { dl: ms(100), dr: ms(250.5) });
    expect(o.l[109]).toBeCloseTo(0, 3);
    expect(o.l[110]).toBeCloseTo(1, 3);
    expect(o.r[260]).toBeCloseTo(0.5, 3);
    expect(o.r[261]).toBeCloseTo(0.5, 3);
  });

  it('bypassed, passes its sides through', () => {
    const n = 4, out = { out: new Float32Array(n), l: new Float32Array(n), r: new Float32Array(n) };
    stutilThru({ in: Float32Array.of(0.25, 0, 0, 0), l: Float32Array.of(0.5, 0.5, 0, 0), r: Float32Array.of(0, 0, 0.75, 0) }, out, n);
    expect([...out.l]).toEqual([0.75, 0.5, 0, 0]);
    expect([...out.out]).toEqual([0.75, 0.5, 0, 0]);
    expect([...out.r]).toEqual([0, 0, 0.75, 0]);
  });
});

describe('how cables reach the Stereo utility (#1324, feeds.ts)', () => {
  /** a patch with a stereo Filter `st`, a mono oscillator `mono`, a Pan, a Stereo utility `u`, a mono VCA and an Output */
  function patch(): { p: Patch; id: Record<string, number> } {
    const p = emptyPatch();
    const id = Object.fromEntries((['filter', 'osc', 'pan', 'stutil', 'vca', 'output'] as const).map((t) => [t, addModule(p, DEFS[t], 0, 0).id]));
    p.modules.find((m) => m.id === id.filter)!.stereo = true;
    return { p, id };
  }
  const feedsOf = (p: Patch, c: number, input: string, v = 0): string[] =>
    cableFeeds(feedModel(p, []), c, input, v).map((f) => `${p.modules[feedModel(p, []).cables[c].from].type}:${f.copy}:${f.port}${f.w === 1 ? '' : `*${f.w}`}`);

  it('a stereo cable into `in` gives L to the left side and R to the right, with a cable in `r` or not', () => {
    const { p, id } = patch();
    connect(p, DEFS, { module: id.filter, port: 'lp24' }, { module: id.stutil, port: 'in' });
    expect(feedsOf(p, 0, 'in')).toEqual(['filter:0:lp24']);
    expect(feedsOf(p, 0, 'r')).toEqual(['filter:1:lp24']);
    connect(p, DEFS, { module: id.osc, port: 'out' }, { module: id.stutil, port: 'r' });
    expect(feedsOf(p, 0, 'r')).toEqual(['filter:1:lp24']);
    expect(feedsOf(p, 1, 'r')).toEqual(['osc:0:out']);
  });

  it('a mono cable into `in` reaches both sides; a stereo cable into `l` averages (as into any mono jack)', () => {
    const { p, id } = patch();
    connect(p, DEFS, { module: id.osc, port: 'out' }, { module: id.stutil, port: 'in' });
    connect(p, DEFS, { module: id.filter, port: 'lp24' }, { module: id.stutil, port: 'l' });
    expect(feedsOf(p, 0, 'in')).toEqual(['osc:0:out']);
    expect(feedsOf(p, 0, 'r')).toEqual(['osc:0:out']);
    expect(feedsOf(p, 1, 'l')).toEqual(['filter:0:lp24*0.5', 'filter:1:lp24*0.5']);
  });

  it('a pair\'s left output (Pan l) into `in` carries the pair', () => {
    const { p, id } = patch();
    connect(p, DEFS, { module: id.pan, port: 'l' }, { module: id.stutil, port: 'in' });
    expect(feedsOf(p, 0, 'in')).toEqual(['pan:0:l']);
    expect(feedsOf(p, 0, 'r')).toEqual(['pan:0:r']);
    expect(outputRead(feedModel(p, []), p.modules.findIndex((m) => m.id === id.pan), 'r')).toBe(true);
  });

  it('the stereo outlet: both sides into the Output\'s l alone and into a stereo module, the left into a mono jack', () => {
    const { p, id } = patch();
    connect(p, DEFS, { module: id.stutil, port: 'out' }, { module: id.output, port: 'l' });
    connect(p, DEFS, { module: id.stutil, port: 'out' }, { module: id.filter, port: 'in' });
    connect(p, DEFS, { module: id.stutil, port: 'out' }, { module: id.vca, port: 'in' });
    expect(feedsOf(p, 0, 'l')).toEqual(['stutil:0:out']);
    expect(feedsOf(p, 0, 'r')).toEqual(['stutil:0:r']);
    expect(feedsOf(p, 1, 'in', 0)).toEqual(['stutil:0:out']);
    expect(feedsOf(p, 1, 'in', 1)).toEqual(['stutil:0:r']);
    expect(feedsOf(p, 2, 'in')).toEqual(['stutil:0:out']);
    // (a Pan's l into the Output's l stays its left, as before #1324)
    const q = patch();
    connect(q.p, DEFS, { module: q.id.pan, port: 'l' }, { module: q.id.output, port: 'l' });
    expect(feedsOf(q.p, 0, 'r')).toEqual([]);
  });
});
