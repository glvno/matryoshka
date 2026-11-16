// SPDX-License-Identifier: GPL-3.0-only
// Mutate and Randomize (#944): ranges, steps, octaves, macro ranges, locks, ties, level rows and the modules left alone.
import { describe, expect, it } from 'vitest';
import type { AssemblyInst } from './assembly';
import { DEFS } from './modules';
import { isLocked, mutatePatch, setParamLock } from './mutate';
import { defaultParams, paramUnit, type ModuleInst, type Patch } from './patch';

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
    const up = mutatePatch(p, { modules: [1], assemblies: [] }, 'mutate', 0.1, DEFS, seq(1)).patch;
    const pd = DEFS.filter.params.find((q) => q.name === 'cutoff')!;
    expect(paramUnit(pd, params(up, 1).cutoff) - paramUnit(pd, 1000)).toBeCloseTo(0.1, 2);
    expect(params(up, 1).res).toBeCloseTo(0.6, 6);
    const down = mutatePatch(p, { modules: [1], assemblies: [] }, 'mutate', 0.1, DEFS, seq(0)).patch;
    expect(params(down, 1).res).toBeCloseTo(0.4, 6);
    // a small amount does not move a choice or a switch off its value
    expect(params(up, 1).track).toBe(p.modules[0].params.track);
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

  it('measures a Selector\'s move over the positions in use', () => {
    const p = patch([mod(1, 'select', { pos: 3, count: 3 })]);
    setParamLock(p.modules[0], 'count', true);
    const out = mutatePatch(p, { modules: [1], assemblies: [] }, 'mutate', 0.3, DEFS, seq(0)).patch;
    expect(params(out, 1).pos).toBe(2);   // (30 % of 1..3 down from 3, not 30 % of 1..8)
  });
});
