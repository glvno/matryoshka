// SPDX-License-Identifier: GPL-3.0-only
// Mutate and Randomize (#944, #1006): ranges, steps, octaves, macro ranges, locks, ties, level rows, the modules left alone,
// pitch held or moved by musical steps, the share of rows, switches by chance, preset values, and breeding from keeps.
import { describe, expect, it } from 'vitest';
import type { AssemblyInst } from './assembly';
import { DEFS, RATIOS } from './modules';
import { breedPatch, cardScope, isLocked, isSwitch, mutatePatch, pitchRows, setParamLock, type MutateScope } from './mutate';
import { defaultParams, paramUnit, type ModuleInst, type Patch } from './patch';
import { FM1_PRESETS } from './presets';

const mod = (id: number, type: string, params: Record<string, number> = {}): ModuleInst =>
  ({ id, type, x: 0, y: 0, params: { ...defaultParams(DEFS[type]), ...params }, ...(DEFS[type].paramInputs ? { att: [1, 1], map: { p1: [], p2: [] } } : {}) }) as ModuleInst;
const patch = (modules: ModuleInst[], assemblies: AssemblyInst[] = []): Patch => ({ version: 2, name: 't', modules, cables: [], assemblies }) as Patch;
const asm = (id: number, modules: number[], params: AssemblyInst['params'], extra: Partial<AssemblyInst> = {}): AssemblyInst =>
  ({ v: 1, id, name: 'a', label: 'a', x: 0, y: 0, open: false, modules, inputs: [], outputs: [], params, ...extra }) as AssemblyInst;
/** a fixed sequence of "random" numbers, round and round */
const seq = (...xs: number[]): (() => number) => { let i = 0; return () => xs[i++ % xs.length]; };
const params = (p: Patch, id: number): Record<string, number> => p.modules.find((m) => m.id === id)!.params;

describe('mutatePatch', () => {
  it('keeps every parameter in its range and on its steps, and leaves the input alone', () => {
    const p = patch([mod(1, 'osc'), mod(2, 'filter'), mod(3, 'delay')]);
    const before = structuredClone(p);
    for (const r of [0, 0.37, 0.999]) {
      const { patch: out } = mutatePatch(p, { modules: [1, 2, 3], assemblies: [] }, 'randomize', 0, DEFS, seq(r));
      for (const m of out.modules) for (const pd of DEFS[m.type].params) {
        const v = m.params[pd.name];
        expect(v, `${m.type}.${pd.name}`).toBeGreaterThanOrEqual(pd.min);
        expect(v, `${m.type}.${pd.name}`).toBeLessThanOrEqual(pd.max);
        if (pd.choices || pd.toggle) expect(Number.isInteger(v), `${m.type}.${pd.name}`).toBe(true);
      }
    }
    expect(p).toEqual(before);
  });

  it('moves a parameter by at most the amount of its range, in octaves for a logarithmic one', () => {
    const p = patch([mod(1, 'filter', { cutoff: 1000, res: 0.5 })]);
    for (const q of DEFS.filter.params) if (q.name !== 'cutoff' && q.name !== 'res') setParamLock(p.modules[0], q.name, true);
    const up = mutatePatch(p, { modules: [1], assemblies: [] }, 'mutate', 0.1, DEFS, seq(1)).patch;
    const pd = DEFS.filter.params.find((q) => q.name === 'cutoff')!;
    expect(paramUnit(pd, params(up, 1).cutoff) - paramUnit(pd, 1000)).toBeCloseTo(0.1, 2);
    expect(params(up, 1).res).toBeCloseTo(0.6, 6);
    const down = mutatePatch(p, { modules: [1], assemblies: [] }, 'mutate', 0.1, DEFS, seq(0)).patch;
    expect(params(down, 1).res).toBeCloseTo(0.4, 6);
  });

  it('stays between the ends of a macro range in use', () => {
    const f = mod(1, 'filter', { res: 0.5 });
    f.map!.p1 = ['res'];
    f.range = { p1: { res: [0.4, 0.6] } };
    const p = patch([f]);
    for (const r of [0, 1]) {
      const v = params(mutatePatch(p, { modules: [1], assemblies: [] }, 'randomize', 0, DEFS, seq(r)).patch, 1).res;
      expect(v).toBeCloseTo(r ? 0.6 : 0.4, 6);
    }
  });

  it('leaves locked parameters, locked cards and cards inside a locked assembly alone', () => {
    const a = mod(1, 'filter', { res: 0.5 });
    setParamLock(a, 'res', true);
    const b = mod(2, 'filter', { res: 0.5 });
    b.mutateLockAll = true;
    const c = mod(3, 'filter', { res: 0.5 });
    const p = patch([a, b, c], [asm(10, [3], [], { mutateLockAll: true })]);
    const out = mutatePatch(p, { modules: [1, 2, 3], assemblies: [] }, 'randomize', 0, DEFS, seq(0.9)).patch;
    expect(params(out, 1).res).toBe(0.5);
    expect(params(out, 1).cutoff).not.toBe(a.params.cutoff);   // (only the locked one stays)
    expect(params(out, 2)).toEqual(b.params);
    expect(params(out, 3)).toEqual(c.params);
    expect(isLocked(p, c, 'cutoff')).toBe(true);
  });

  it('never raises a level row above the larger of its value and its default', () => {
    const p = patch([mod(1, 'osc', { level: 0.3 }), mod(2, 'vca', { gain: 1.5 }), mod(3, 'mixer', { l1: 0.2 })]);
    const out = mutatePatch(p, { modules: [1, 2, 3], assemblies: [] }, 'randomize', 0, DEFS, seq(0.999)).patch;
    expect(params(out, 1).level).toBeCloseTo(0.8, 6);   // (its default)
    expect(params(out, 2).gain).toBeCloseTo(1.5, 6);    // (above its default of 1 already: no higher)
    expect(params(out, 3).l1).toBeCloseTo(0.7, 6);
    const low = mutatePatch(p, { modules: [1], assemblies: [] }, 'randomize', 0, DEFS, seq(0)).patch;
    expect(params(low, 1).level).toBe(0);   // (lower is always allowed)
  });

  it('never moves the modules that play rather than sound, nor what the patch sets when it loads', () => {
    const p = patch([mod(1, 'fm1'), mod(2, 'output'), mod(3, 'alloc'), mod(4, 'steps'), mod(5, 'delay', { length: 500 })]);
    const out = mutatePatch(p, { modules: [1, 2, 3, 4, 5], assemblies: [] }, 'randomize', 0, DEFS, seq(0.9));
    for (const id of [1, 2, 3, 4]) expect(params(out.patch, id)).toEqual(params(p, id));
    expect(params(out.patch, 5).length).toBe(500);
    expect(out.moved).toBeGreaterThan(0);
  });

  it('moves an assembly card\'s rows, tied rows as one, and only those', () => {
    const o1 = mod(1, 'osc'), o2 = mod(2, 'osc'), f = mod(3, 'filter', { res: 0.5 });
    const row = { module: 1, param: 'detune', label: 'detune', also: [{ module: 2, param: 'detune' }] };
    const p = patch([o1, o2, f], [asm(10, [1, 2, 3], [row])]);
    const out = mutatePatch(p, { modules: [], assemblies: [10] }, 'randomize', 0, DEFS, seq(0.75)).patch;
    expect(params(out, 1).detune).toBeCloseTo(75, 6);
    expect(params(out, 2).detune).toBe(params(out, 1).detune);
    expect(params(out, 3)).toEqual(f.params);   // (not on the card)
    // a lock on any parameter of the row keeps the whole row
    setParamLock(o2, 'detune', true);
    const kept = mutatePatch(p, { modules: [], assemblies: [10] }, 'randomize', 0, DEFS, seq(0.75));
    expect(kept.moved).toBe(0);
  });

  it('keeps a Selector\'s position within its new count', () => {
    const p = patch([mod(1, 'select', { pos: 2, count: 8 })]);
    const out = mutatePatch(p, { modules: [1], assemblies: [] }, 'randomize', 0, DEFS, seq(0.99, 0)).patch;
    expect(params(out, 1).count).toBe(2);
    expect(params(out, 1).pos).toBe(2);
  });

  it('changes a Selector\'s position to another position in use', () => {
    const p = patch([mod(1, 'select', { pos: 3, count: 3 })]);
    for (const q of DEFS.select.params) if (q.name !== 'pos') setParamLock(p.modules[0], q.name, true);
    const out = mutatePatch(p, { modules: [1], assemblies: [] }, 'mutate', 0.3, DEFS, seq(0.99)).patch;
    expect(params(out, 1).pos).toBe(2);   // (the last of 1 and 2, not of 1, 2, 4 … 8)
  });
});

/** a seeded generator (mulberry32), so a run is the same every time */
const seeded = (seed: number): (() => number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
/** every module and every assembly card of a patch: wider than Make candidates' scope */
const everything = (p: Patch): MutateScope => ({ modules: p.modules.map((m) => m.id), assemblies: (p.assemblies ?? []).map((a) => a.id) });
/** the pitch rows that differ between `a` and `b` (pitch rows as `a` has them), with their kind and both values */
function pitchMoves(a: Patch, b: Patch): { kind: string; type: string; param: string; from: number; to: number }[] {
  const kind = pitchRows(a, DEFS);
  const out: { kind: string; type: string; param: string; from: number; to: number }[] = [];
  for (const m of a.modules) for (const pd of DEFS[m.type].params) {
    const k = kind(m, pd.name);
    const from = m.params[pd.name] ?? pd.default, to = b.modules.find((x) => x.id === m.id)!.params[pd.name] ?? pd.default;
    if (k && from !== to) out.push({ kind: k, type: m.type, param: pd.name, from, to });
  }
  return out;
}
/** how many parameters differ between `a` and `b`, those `only` keeps */
const changed = (a: Patch, b: Patch, only: (pd: { name: string }) => boolean = () => true): number =>
  a.modules.reduce((n, m) => n + DEFS[m.type].params.filter((pd) => only(pd) && m.params[pd.name] !== b.modules.find((x) => x.id === m.id)!.params[pd.name]).length, 0);

describe('pitch (#1006)', () => {
  it('finds the value rows that reach a pitch input, through other modules and mapped parameter inputs', () => {
    const p = patch([mod(1, 'const'), mod(2, 'scale'), mod(3, 'osc'), mod(4, 'const'), mod(5, 'filter'), mod(6, 'const'), mod(7, 'lfo')]);
    p.cables = [{ from: { module: 1, port: 'out' }, to: { module: 2, port: 'in' } }, { from: { module: 2, port: 'out' }, to: { module: 3, port: 'pitch' } },
      { from: { module: 4, port: 'out' }, to: { module: 5, port: 'cv' } }, { from: { module: 6, port: 'out' }, to: { module: 3, port: 'p1' } }];
    p.modules[2].map = { p1: ['coarse'], p2: [] };
    const kind = pitchRows(p, DEFS);
    expect(kind(p.modules[0], 'value')).toBe('offset');
    expect([kind(p.modules[1], 'offset'), kind(p.modules[1], 'gain')]).toEqual(['offset', 'held']);
    expect([kind(p.modules[2], 'coarse'), kind(p.modules[2], 'fine'), kind(p.modules[2], 'pw')]).toEqual(['semitones', 'cents', undefined]);
    expect(kind(p.modules[3], 'value')).toBeUndefined();   // (a cutoff's cv is no pitch)
    expect(kind(p.modules[5], 'value')).toBe('offset');    // (through osc's p1, mapped to its coarse tune)
    expect(kind(p.modules[6], 'rate')).toBeUndefined();
  });

  it('Mutate, Randomize and Make candidates leave pitch alone on every factory patch', () => {
    const names = Object.keys(FM1_PRESETS);
    expect(names.length).toBe(21);
    for (const name of names) {
      const p = FM1_PRESETS[name]();
      const rnd = seeded(name.length);
      for (const [mode, amount] of [['mutate', 0.5], ['randomize', 0]] as const)
        expect(pitchMoves(p, mutatePatch(p, everything(p), mode, amount, DEFS, rnd).patch), `${name} ${mode}`).toEqual([]);
      for (let i = 0; i < 8; i++) expect(pitchMoves(p, mutatePatch(p, cardScope(p), 'mutate', 0.25, DEFS, rnd).patch), `${name} candidate`).toEqual([]);
      const keeps = [0, 1].map(() => mutatePatch(p, cardScope(p), 'mutate', 0.5, DEFS, rnd).patch);
      expect(pitchMoves(p, breedPatch(p, keeps, cardScope(p), 0.5, DEFS, rnd).patch), `${name} bred`).toEqual([]);
    }
  });

  it('with "Mutate pitch" on, moves pitch only by an octave, a fifth up, a fourth down, a whole-number ratio or a few cents', () => {
    const seen = new Set<string>();
    for (const name of Object.keys(FM1_PRESETS)) {
      const p = FM1_PRESETS[name]();
      const rnd = seeded(7 + name.length);
      for (const [mode, amount] of [['mutate', 0.5], ['randomize', 0], ['mutate', 0.1]] as const) {
        for (const mv of pitchMoves(p, mutatePatch(p, everything(p), mode, amount, DEFS, rnd, { pitch: true }).patch)) {
          const what = `${name} ${mode} ${mv.type}.${mv.param} ${mv.from} → ${mv.to}`;
          seen.add(mv.kind);
          if (mv.kind === 'semitones') expect([12, -12, 7, -5], what).toContain(mv.to - mv.from);
          else if (mv.kind === 'offset') expect([12, -12, 7, -5], what).toContain(Math.round((mv.to - mv.from) * 12 * 1e6) / 1e6);
          else if (mv.kind === 'ratio') expect(RATIOS[mv.to] === 0.5 || Number.isInteger(RATIOS[mv.to]), what).toBe(true);
          else if (mv.kind === 'cents') expect(Math.abs(mv.to - mv.from), what).toBeLessThanOrEqual((mode === 'randomize' ? 1 : amount) * 10);
          else throw new Error(`${what}: a held row moved`);
        }
      }
    }
    expect([...seen].sort()).toEqual(['cents', 'offset', 'ratio', 'semitones']);
  });
});

describe('how much Mutate moves (#1006)', () => {
  it('moves about one row in four, at least two', () => {
    const p = patch([1, 2, 3, 4, 5, 6].map((id) => mod(id, 'filter', { cutoff: 1000, res: 0.5 })));
    const knob = (pd: { name: string }): boolean => !isSwitch(DEFS.filter.params.find((q) => q.name === pd.name)!);
    const rows = p.modules.length * DEFS.filter.params.filter(knob).length;
    const rnd = seeded(1);
    let total = 0, least = Infinity;
    for (let i = 0; i < 400; i++) {
      const out = mutatePatch(p, everything(p), 'mutate', 0.5, DEFS, rnd).patch;
      total += changed(p, out, knob);
      least = Math.min(least, changed(p, out));
    }
    expect(total / 400 / rows).toBeGreaterThan(0.17);   // (a chosen row at an end of its range may stay)
    expect(total / 400 / rows).toBeLessThan(0.3);
    expect(least).toBeGreaterThanOrEqual(2);
    // a card of two rows moves both
    const two = patch([mod(1, 'filter', { cutoff: 1000, res: 0.5 })]);
    for (const pd of DEFS.filter.params) if (pd.name !== 'cutoff' && pd.name !== 'res') setParamLock(two.modules[0], pd.name, true);
    for (let i = 0; i < 20; i++) expect(changed(two, mutatePatch(two, everything(two), 'mutate', 0.5, DEFS, rnd).patch)).toBe(2);
  });

  it('changes a switch or a choice with a chance equal to the amount, to another of its values', () => {
    const p = patch([mod(1, 'osc')]);
    const switches = DEFS.osc.params.filter((pd) => isSwitch(pd) && !pd.pitch);
    expect(switches.length).toBeGreaterThan(1);
    const rnd = seeded(2);
    for (const amount of [0.1, 0.5]) {
      let flips = 0;
      const runs = 2000;
      for (let i = 0; i < runs; i++) {
        const out = mutatePatch(p, everything(p), 'mutate', amount, DEFS, rnd).patch;
        flips += switches.filter((pd) => out.modules[0].params[pd.name] !== p.modules[0].params[pd.name]).length;
      }
      expect(flips / runs / switches.length).toBeCloseTo(amount, 1);
    }
  });

  it('a row of an engine with presets sometimes takes a preset\'s value, never a pitch row', () => {
    const p = patch([mod(1, 'filter', { cutoff: 1000 }), mod(2, 'osc')]);
    const pools = new Map([['1:cutoff', [333]], ['2:coarse', [5]]]);
    const rnd = seeded(3);
    let drawn = 0;
    for (let i = 0; i < 200; i++) {
      const out = mutatePatch(p, everything(p), 'mutate', 0.1, DEFS, rnd, { pitch: true, share: 1, pools }).patch;
      if (out.modules[0].params.cutoff === 333) drawn++;
      expect(out.modules[1].params.coarse).not.toBe(5);
    }
    expect(drawn).toBeGreaterThan(60);
    expect(drawn).toBeLessThan(140);
  });
});

describe('cards and breeding (#1006)', () => {
  it('with none selected, moves the module cards outside assemblies and the top-level assembly cards', () => {
    const p = patch([mod(1, 'filter'), mod(2, 'filter'), mod(3, 'filter')], [asm(10, [2], [{ module: 2, param: 'res', label: 'res' }], { children: [11] }), asm(11, [3], [])]);
    expect(cardScope(p)).toEqual({ modules: [1], assemblies: [10] });
    const rnd = seeded(4);
    for (let i = 0; i < 50; i++) {
      const out = mutatePatch(p, cardScope(p), 'randomize', 0, DEFS, rnd).patch;
      expect(params(out, 3)).toEqual(params(p, 3));
      expect(Object.keys(params(out, 2)).filter((q) => params(out, 2)[q] !== params(p, 2)[q])).not.toContain('cutoff');
    }
  });

  it('breeds each card from one keep, chosen per card, and the rows not in every keep from the patch on screen', () => {
    const screen = patch([1, 2, 3, 4].map((id) => mod(id, 'filter', { cutoff: 1000, res: 0.5 })));
    const a = structuredClone(screen), b = structuredClone(screen);
    for (const m of a.modules) Object.assign(m.params, { cutoff: 200, res: 0.1 });
    for (const m of b.modules) Object.assign(m.params, { cutoff: 5000, res: 0.9 });
    b.modules = b.modules.filter((m) => m.id !== 4);   // (not in every keep)
    const rnd = seeded(5);
    const from = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const out = breedPatch(screen, [a, b], everything(screen), 0, DEFS, rnd).patch;
      for (const id of [1, 2, 3]) {
        const { cutoff, res } = params(out, id);
        const parent = cutoff === 200 && res === 0.1 ? 'a' : cutoff === 5000 && res === 0.9 ? 'b' : 'mixed';
        expect(parent, `card ${id}`).not.toBe('mixed');
        from.add(parent);
      }
      expect([params(out, 4).cutoff, params(out, 4).res]).toEqual([1000, 0.5]);
    }
    expect([...from].sort()).toEqual(['a', 'b']);
  });
});
