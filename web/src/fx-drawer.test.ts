// SPDX-License-Identifier: GPL-3.0-only
import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import {
  allModules, assembliesOf, assemblyById, childrenOf, findRef, fixAssemblies, insertAssembly, makeAssembly, parentOf, reconcileAll, targetsOf,
  toDef, validateAssemblyDef, bypassAssembly, hiddenAssemblies, hiddenModules, type AssemblyInst,
} from './assembly';
import {
  addDrawer, catalogEffectDef, chainCableProblem, chainHelpers, chainIns, chainJackProblem, chainOuts, classicMix, deviceModules, drawerOf, drawerOutput,
  drawers, EFFECT_CATALOG, effectKind, effectsOf, insertEffect, legacyEffectDef, moveEffect, outputDrawer, ownerOf, rackOf, removeEffect, rewire,
  takeOut, WET_DRAWER_FORM, wrapEffect, type Channel,
} from './fx-drawer';
import { convertLegacyBus, fxBusOf } from './fx-legacy';
import { DEFS } from './modules';
import { devicesOf } from './pages';
import { addModule, connect, newPatch, sameEnd, validatePatch, type Endpoint, type Patch } from './patch';
import { encodePatch, FLAG_CABLES3 } from './patchbin';
import { clearAllPatterns } from './pattern-ops';
import { copiesOf, setPoly } from './poly';
import { factoryWithPatterns, PRESETS } from './presets';
import { drawerPresetStructure, fnv, structureOf } from './structure';

const survey = JSON.parse(readFileSync(new URL('./cpu-survey-factory-1.14.json', import.meta.url), 'utf8')) as { patches: Record<string, Patch> };

/** Main, an Output, and an instrument card (an oscillator into a filter; with `stereo`, into a Pan) cabled to the Output */
function synth(stereo = false): { p: Patch; inst: AssemblyInst; out: number } {
  const p = newPatch(DEFS);
  const out = p.modules.find((m) => m.type === 'output')!.id;
  const osc = addModule(p, DEFS.osc, 300, 300);
  const filter = addModule(p, DEFS.filter, 600, 300);
  connect(p, DEFS, { module: osc.id, port: 'out' }, { module: filter.id, port: 'in' });
  const members = [osc.id, filter.id];
  if (stereo) {
    const pan = addModule(p, DEFS.pan, 900, 300);
    connect(p, DEFS, { module: filter.id, port: 'lp24' }, { module: pan.id, port: 'in' });
    connect(p, DEFS, { module: pan.id, port: 'l' }, { module: out, port: 'l' });
    connect(p, DEFS, { module: pan.id, port: 'r' }, { module: out, port: 'r' });
    members.push(pan.id);
  } else {
    connect(p, DEFS, { module: filter.id, port: 'lp24' }, { module: out, port: 'l' });
    connect(p, DEFS, { module: filter.id, port: 'lp24' }, { module: out, port: 'r' });
  }
  return { p, inst: makeAssembly(p, members, 'Synth'), out };
}

const cable = (p: Patch, from: Endpoint, to: Endpoint): boolean => p.cables.some((c) => sameEnd(c.from, from) && sameEnd(c.to, to));

/** the rewire invariant of contracts §2 for an instrument drawer whose sound went to the Output, or the Output drawer; one
 *  mono source set for both sides leaves the `r` of a jack pair free (an effect's, the Output's: the left jack plays both) */
function expectChain(p: Patch, d: AssemblyInst, out: number): void {
  const owner = ownerOf(p, d);
  const fx = effectsOf(p, d);
  const prevs = ([0, 1] as Channel[]).map((ch): Endpoint[] => {
    if (owner !== 'output') {
      const t = d.drawer!.taps![ch];
      return targetsOf(findRef(owner, 'out', t.module, t.port)!);
    }
    return p.cables.filter((c) => fx.length ? chainIns(fx[0], ch).some((t) => sameEnd(t, c.to)) : c.to.module === out && c.to.port === (ch ? 'r' : 'l')).map((c) => c.from);
  });
  if (!prevs[1].length) prevs[1] = prevs[0];
  const same = (a: Endpoint[], b: Endpoint[]): boolean => a.length === b.length && a.every((x) => b.some((y) => sameEnd(x, y)));
  const rightJack = (t: Endpoint): boolean => t.port === 'r' && ['reverb', 'delay', 'chorus'].includes(p.modules.find((m) => m.id === t.module)!.type);
  // (a stereo source splits into a pair instead: side cables, L into the left jack, R into `r`)
  const mono = (): boolean => same(prevs[0], prevs[1]) && !prevs[0].every((s) => !!p.modules.find((m) => m.id === s.module)!.stereo);
  expect(prevs[0].length).toBeGreaterThan(0);
  for (const e of fx) {
    const free = mono() && chainIns(e, 1).every(rightJack) && !same(chainIns(e, 0), chainIns(e, 1));
    const inside = new Set(allModules(p, e));
    for (const ch of [0, 1] as Channel[]) {
      const into = p.cables.filter((c) => chainIns(e, ch).some((t) => sameEnd(t, c.to)) && !inside.has(c.from.module) && (!c.side || c.side === (ch ? 'r' : 'l')));
      if (ch && free) {
        expect(into).toEqual([]);
        continue;
      }
      for (const s of prevs[ch]) for (const t of chainIns(e, ch)) expect(cable(p, s, t)).toBe(true);
      // nothing else feeds the effect's chain input from outside it (a side cable counts on its own side only, #1141)
      expect(into.length).toBe(prevs[ch].length * chainIns(e, ch).length);
    }
    for (const ch of [0, 1] as Channel[]) prevs[ch] = chainOuts(e, ch);
  }
  const freeR = mono();
  for (const ch of [0, 1] as Channel[]) for (const s of prevs[ch]) expect(cable(p, s, { module: out, port: ch ? 'r' : 'l' })).toBe(!(ch && freeR));
}

/** the modules whose sound reaches the Output's input `port` through cables */
function heard(p: Patch, out: number, port: string): Set<number> {
  const seen = new Set<number>();
  const todo = p.cables.filter((c) => c.to.module === out && c.to.port === port).map((c) => c.from.module);
  while (todo.length) {
    const m = todo.pop()!;
    if (seen.has(m)) continue;
    seen.add(m);
    for (const c of p.cables) if (c.to.module === m) todo.push(c.from.module);
  }
  return seen;
}

const catalog = (name: string) => EFFECT_CATALOG.find((e) => e.name === name)!;
const roundTrip = (p: Patch): Patch => { const q = validatePatch(JSON.parse(JSON.stringify(p)), DEFS); fixAssemblies(q, DEFS); return q; };

describe('effect catalog', () => {
  it('lists audio effects only, each with a mode and a blurb; every entry wraps into a stereo effect', () => {
    const names = EFFECT_CATALOG.map((e) => e.name);
    for (const not of ['VCA', 'Crossfader', 'Low pass gate', 'Oscillator', 'master FX', 'Rain', 'Reverse pad']) expect(names).not.toContain(not);
    for (const want of ['Drive', 'Chorus', 'Delay', 'Reverb', 'Shimmer', 'Echo', 'Auto pan', 'Overdrive']) expect(names).toContain(want);
    for (const e of EFFECT_CATALOG) {
      expect(e.blurb.length).toBeGreaterThan(5);
      const def = catalogEffectDef(e);
      expect(def.chain, e.name).toBeDefined();
      expect(def.name).toBe(e.name);
      const helpers = def.chain!.helpers?.length ?? 0;
      if (e.mode === 'pair') expect(helpers).toBe(0);
      if (e.mode === 'stereo') expect(helpers).toBe(1);
      // (a Reverb: one stereo-dry Reverb, C7b; Granular and the wet assemblies keep the helpers)
      if (e.mode === 'wet') expect(helpers).toBe('type' in e.source ? (e.source.type === 'reverb' ? 0 : 5) : 4);
      expect(validateAssemblyDef(structuredClone(def), DEFS).chain).toEqual(def.chain);
    }
    expect(effectKind('shape')).toBe('pair');
    expect(effectKind('chorus')).toBe('stereo');
    expect(effectKind('reverb')).toBe('wet');
    expect(effectKind('Shimmer')).toBe('wet');
    expect(effectKind('vca')).toBeNull();
  });

  it('wraps a module in the legacy form as a pair with every row tied to its twin, modulation copied onto the twin', () => {
    const p = newPatch(DEFS);
    const crush = addModule(p, DEFS.crush, 0, 0);
    const lfo = addModule(p, DEFS.lfo, 0, 300);
    connect(p, DEFS, { module: lfo.id, port: 'out' }, { module: crush.id, port: 'p1' });
    const e = wrapEffect(p, { module: crush.id }, undefined, undefined, { legacy: true });
    const twin = e.modules.find((id) => id !== crush.id)!;
    expect(e.chain).toEqual({ ins: [0, 1], outs: [0, 1] });
    expect(chainIns(e, 0)).toEqual([{ module: crush.id, port: 'in' }]);
    expect(chainIns(e, 1)).toEqual([{ module: twin, port: 'in' }]);
    expect(e.params.every((r) => r.also?.length === 1 && r.also[0].module === twin && r.also[0].param === r.param)).toBe(true);
    expect(cable(p, { module: lfo.id, port: 'out' }, { module: twin, port: 'p1' })).toBe(true);
    expect(e.label).toBe('Bitcrusher');
  });

  it('wraps a stereo module with the correction Math as its helper, and a legacy wet module with the D-1010 reverb mix', () => {
    const p = newPatch(DEFS);
    const ch = addModule(p, DEFS.chorus, 0, 0);
    const e = wrapEffect(p, { module: ch.id });
    const helper = e.chain!.helpers![0];
    expect(p.modules.find((m) => m.id === helper)!.params).toMatchObject({ ka: 0.25, kb: 0.25, off: 0 });
    expect(chainOuts(e, 0)).toEqual([{ module: ch.id, port: 'l' }, { module: helper, port: 'sub' }]);
    const rv = addModule(p, DEFS.reverb, 0, 600);
    rv.params.mix = 0.3;
    const w = wrapEffect(p, { module: rv.id }, undefined, undefined, { legacy: true });
    expect(rv.params.mix).toBe(1);
    const mix = w.params.find((r) => r.label === 'mix')!;
    expect(p.modules.find((m) => m.id === mix.module)!).toMatchObject({ type: 'macro', params: { value: 0.3 } });
    expect(w.chain!.helpers).toHaveLength(5);
    expect(w.chain!.helpers).not.toContain(rv.id);
  });

  it('wraps a mono assembly in the legacy form as two copies (toDef / insertAssembly) with every row tied, and a wet assembly around one copy', () => {
    const p = newPatch(DEFS);
    const od = insertAssembly(p, DEFS, structuredClone((catalog('Overdrive').source as { def: never }).def), 0, 0);
    const n = allModules(p, od).length;
    const e = wrapEffect(p, { assembly: od.id }, undefined, undefined, { legacy: true });
    expect(childrenOf(p, e)).toHaveLength(2);
    expect(allModules(p, e)).toHaveLength(2 * n);
    const [a, b] = childrenOf(p, e);
    expect(e.params).toHaveLength(a.params.length);
    for (const r of e.params) expect(r.also!.some((t) => allModules(p, b).includes(t.module))).toBe(true);
    const echo = insertAssembly(p, DEFS, structuredClone((catalog('Echo').source as { def: never }).def), 0, 900);
    const w = wrapEffect(p, { assembly: echo.id });
    expect(childrenOf(p, w).map((c) => c.id)).toEqual([echo.id]);
    expect(w.chain!.helpers).toHaveLength(4);
    expect(w.params).toHaveLength(echo.params.length);
  });

  it('Drive, Chorus, Delay and Reverb are the D-1010 stages: the same structure as what conversion makes of them', () => {
    const converted = new Map<string, string>();
    for (const raw of Object.values(survey.patches)) {
      const p = roundTrip(raw);
      for (const d of drawers(p)) for (const e of effectsOf(p, d)) converted.set(e.name, structureOf(p, e));
    }
    expect([...converted.keys()].sort()).toEqual(['Chorus', 'Delay', 'Drive', 'Reverb']);
    const kinds = { Drive: 'drive', Chorus: 'chorus', Delay: 'delay', Reverb: 'reverb' } as const;
    for (const [name, kind] of Object.entries(kinds)) {
      const def = legacyEffectDef(kind);
      const p = newPatch(DEFS);
      const e = insertAssembly(p, DEFS, def, 0, 0);
      expect(structureOf(p, e), name).toBe(converted.get(name));
    }
  });
});

describe('drawers', () => {
  it('an instrument drawer taps the outputs cabled to the Output; an empty one keeps the sound (a mono one frees the Output\'s r) and survives every repair', () => {
    const { p, inst, out } = synth();
    const before = p.cables.filter((c) => !(c.to.module === out && c.to.port === 'r'));
    const d = addDrawer(p, inst.id);
    expect(drawerOf(p, inst.id)).toBe(d);
    expect(ownerOf(p, d)).toBe(inst);
    expect(d.drawer!.taps![0]).toEqual(d.drawer!.taps![1]);
    // (the mono instrument's cable into the Output's r went: r plays l, the same sound with one cable fewer)
    expect(JSON.stringify(p.cables)).toBe(JSON.stringify(before));
    expect(reconcileAll(p, DEFS)).toEqual([]);
    const q = roundTrip(p);
    expect(drawerOf(q, inst.id)?.drawer).toEqual(d.drawer);
    expect(drawerOutput(q, inst.id, 0)).toEqual([d.drawer!.taps![0]]);
    expectChain(q, drawerOf(q, inst.id)!, out);
  });

  for (const stereo of [false, true]) it(`insert, move, remove and take out keep the chain whole (${stereo ? 'stereo' : 'mono'} instrument)`, () => {
    const { p, inst, out } = synth(stereo);
    const d = addDrawer(p, inst.id);
    const drive = insertEffect(p, d, { type: 'shape' });
    expectChain(p, d, out);
    const chorus = insertEffect(p, d, { type: 'chorus' });
    const reverb = insertEffect(p, d, { def: catalogEffectDef(catalog('Reverb')) });
    const shimmer = insertEffect(p, d, { def: (catalog('Shimmer').source as { def: never }).def }, 1);
    expect(effectsOf(p, d).map((e) => e.id)).toEqual([drive.id, shimmer.id, chorus.id, reverb.id]);
    expectChain(p, d, out);
    expect(drawerOutput(p, inst.id, 1)).toEqual(chainOuts(reverb, 1));
    moveEffect(p, d, reverb.id, 0);
    expect(effectsOf(p, d)[0]).toBe(reverb);
    expectChain(p, d, out);
    // #1214: whichever effect goes, the Output still hears the instrument on both sides
    for (const e of effectsOf(p, d)) for (const how of ['remove', 'takeOut'] as const) {
      const q = structuredClone(p);
      const qd = drawerOf(q, inst.id)!;
      if (how === 'remove') removeEffect(q, e.id);
      else takeOut(q, e.id, 2000, 2000);
      expectChain(q, qd, out);
      for (const port of ['l', 'r']) expect(heard(q, out, port).has(d.drawer!.taps![port === 'l' ? 0 : 1].module)).toBe(true);
      if (how === 'takeOut') {
        const moved = assemblyById(q, e.id)!;
        expect(parentOf(q, moved.id)).toBeUndefined();
        expect(moved.chain).toBeDefined();
        expect([0, 1].flatMap((ch) => [...chainIns(moved, ch as Channel), ...chainOuts(moved, ch as Channel)])
          .some((t) => q.cables.some((c) => (sameEnd(c.to, t) || sameEnd(c.from, t)) && !allModules(q, moved).includes(sameEnd(c.to, t) ? c.from.module : c.to.module)))).toBe(false);
      } else expect(assemblyById(q, e.id)).toBeUndefined();
    }
    for (const e of [...effectsOf(p, d)]) removeEffect(p, e.id);
    expect(effectsOf(p, d)).toEqual([]);
    expect(assemblyById(p, d.id)).toBe(d);
    expectChain(p, d, out);
    expect(heard(p, out, 'l').size).toBeGreaterThan(0);
  });

  it('a canvas module or effect dropped in loses its audio cables, keeps its modulation, and leaves its old drawer whole', () => {
    const { p, inst, out } = synth();
    const d = addDrawer(p, inst.id);
    const ph = addModule(p, DEFS.phaser, 1200, 0);
    const lfo = addModule(p, DEFS.lfo, 1200, 300);
    connect(p, DEFS, { module: lfo.id, port: 'out' }, { module: ph.id, port: 'p1' });
    const vca = addModule(p, DEFS.vca, 1500, 0);
    connect(p, DEFS, { module: ph.id, port: 'out' }, { module: vca.id, port: 'in' });
    const e = insertEffect(p, d, { module: ph.id });
    expect(cable(p, { module: ph.id, port: 'out' }, { module: vca.id, port: 'in' })).toBe(false);
    expect(cable(p, { module: lfo.id, port: 'out' }, { module: ph.id, port: 'p1' })).toBe(true);
    expectChain(p, d, out);
    const od = addDrawer(p, 'output');
    expect(outputDrawer(p)).toBe(od);
    insertEffect(p, od, { assembly: e.id });
    expect(effectsOf(p, d)).toEqual([]);
    expect(effectsOf(p, od)).toEqual([e]);
    // (the empty instrument drawer's tap now feeds the Output drawer's chain)
    for (const ch of [0, 1] as Channel[]) expect(chainIns(e, ch).every((t) => cable(p, d.drawer!.taps![ch], t))).toBe(true);
    expectChain(p, od, out);
  });

  it('an effect that sat in line on the canvas keeps the sound going when it moves into a drawer', () => {
    const { p, inst, out } = synth();
    const d = addDrawer(p, inst.id);
    const tap = d.drawer!.taps![0];
    const ph = addModule(p, DEFS.phaser, 1200, 0);
    p.cables = p.cables.filter((c) => c.to.module !== out);
    connect(p, DEFS, tap, { module: ph.id, port: 'in' });
    connect(p, DEFS, { module: ph.id, port: 'out' }, { module: out, port: 'l' });
    connect(p, DEFS, { module: ph.id, port: 'out' }, { module: out, port: 'r' });
    insertEffect(p, d, { module: ph.id });
    expectChain(p, d, out);
    const rv = addModule(p, DEFS.reverb, 1200, 600);
    const end = drawerOutput(p, inst.id, 0);
    p.cables = p.cables.filter((c) => c.to.module !== out);
    for (const e of end) connect(p, DEFS, e, { module: rv.id, port: 'in' });
    connect(p, DEFS, { module: rv.id, port: 'out' }, { module: out, port: 'l' });
    insertEffect(p, addDrawer(p, 'output'), { module: rv.id });
    expectChain(p, outputDrawer(p)!, out);
    for (const port of ['l', 'r']) expect(heard(p, out, port).has(tap.module)).toBe(true);
  });

  it('the Output drawer runs every source of the Output through its chain; a new source joins on rewire', () => {
    const { p, out } = synth(true);
    const od = addDrawer(p, 'output');
    const e1 = insertEffect(p, od, { type: 'delay' });
    insertEffect(p, od, { type: 'reverb' });
    expectChain(p, od, out);
    const noise = addModule(p, DEFS.noise, 0, 900);
    connect(p, DEFS, { module: noise.id, port: 'out' }, { module: out, port: 'l' });
    expect(chainJackProblem(p, { module: out, port: 'l' }, 'in')).toBeNull();
    rewire(p, od);
    expect(chainIns(e1, 0).every((t) => cable(p, { module: noise.id, port: 'out' }, t))).toBe(true);
    expectChain(p, od, out);
    for (const e of [...effectsOf(p, od)]) {
      const q = structuredClone(p);
      removeEffect(q, e.id);
      expectChain(q, outputDrawer(q)!, out);
      expect(heard(q, out, 'r').has(noise.id)).toBe(true);
    }
  });

  it('refuses cables onto the chain\'s jacks, with the reason, and allows the drawer\'s output', () => {
    const { p, inst } = synth();
    const d = addDrawer(p, inst.id);
    const tap = d.drawer!.taps![0];
    expect(chainJackProblem(p, tap, 'out')).toBeNull();
    const a = insertEffect(p, d, { type: 'crush' });
    const b = insertEffect(p, d, { type: 'eq' });
    expect(chainJackProblem(p, tap, 'out')).toMatch(/Synth's FX drawer/);
    expect(chainJackProblem(p, chainIns(b, 0)[0], 'in')).toBe('This jack is part of Synth\'s FX chain: drag the effect out of the drawer, or cable the drawer\'s output instead.');
    expect(chainJackProblem(p, chainOuts(a, 1)[0], 'out')).toMatch(/FX chain/);
    expect(chainJackProblem(p, chainOuts(b, 1)[0], 'out')).toBeNull();
    const vca = addModule(p, DEFS.vca, 0, 900);
    expect(chainCableProblem(p, chainOuts(b, 0)[0], { module: vca.id, port: 'in' })).toBeNull();
    expect(chainCableProblem(p, chainOuts(b, 0)[0], { module: inst.modules[1], port: 'in' })).toMatch(/cannot go back/);
    expect(chainJackProblem(p, { module: a.modules[0], port: 'p1' }, 'in')).toBeNull();
  });

  it('a drawer\'s ⏻ keeps each effect\'s own state; no switch ever bypasses a helper; an instrument\'s ⏻ leaves its drawer alone', () => {
    const { p, inst } = synth();
    const d = addDrawer(p, inst.id);
    const rv = insertEffect(p, d, { type: 'reverb' });
    const dl = insertEffect(p, d, { type: 'delay' });
    bypassAssembly(p, dl, true);
    bypassAssembly(p, d, true);
    const helpers = chainHelpers(p);
    expect(helpers.size).toBe(1);   // (the Delay's correction; a new drawer Reverb has no helpers, C7b)
    for (const id of helpers) expect(p.modules.find((m) => m.id === id)!.bypass).toBeUndefined();
    bypassAssembly(p, d, false);
    expect(p.modules.find((m) => m.id === rv.modules[0])!.bypass).toBeUndefined();
    expect(dl.modules.filter((id) => !helpers.has(id)).every((id) => p.modules.find((m) => m.id === id)!.bypass)).toBe(true);
    expect(dl.bypass).toBe(true);
    bypassAssembly(p, inst, true);
    expect(p.modules.find((m) => m.id === rv.modules[0])!.bypass).toBeUndefined();
    expect(inst.modules.every((id) => p.modules.find((m) => m.id === id)!.bypass)).toBe(true);
  });

  it('a copy of an instrument (toDef / insertAssembly) carries its drawer and effects; the structure leaves the drawer out', () => {
    const { p, inst } = synth(true);
    const bare = structureOf(p, inst);
    const d = addDrawer(p, inst.id);
    insertEffect(p, d, { type: 'chorus' });
    insertEffect(p, d, { def: (catalog('Echo').source as { def: never }).def });
    expect(structureOf(p, inst)).toBe(bare);
    const def = validateAssemblyDef(JSON.parse(JSON.stringify(toDef(p, inst))), DEFS);
    const copy = insertAssembly(p, DEFS, def, 3000, 0);
    const cd = drawerOf(p, copy.id)!;
    expect(cd.drawer!.taps![0].module).not.toBe(d.drawer!.taps![0].module);
    expect(deviceModules(p, copy)).toContain(cd.drawer!.taps![0].module);
    expect(effectsOf(p, cd).map((e) => [e.name, e.chain!.helpers?.length])).toEqual(effectsOf(p, d).map((e) => [e.name, e.chain!.helpers?.length]));
    expect(structureOf(p, copy)).toBe(bare);
  });

  it('a factory instrument keeps its structure with any drawer (presets keep matching)', () => {
    // (a 1.14 factory patch with its master FX bus, before and after it opens as a drawer)
    const [p, q] = Object.values(survey.patches).map((raw) => {
      const p = structuredClone(raw);
      fixAssemblies(p, DEFS);
      return [p, roundTrip(raw)];
    }).find(([, q]) => drawers(q).some((d) => d.drawer!.taps))!;
    const qi = ownerOf(q, drawers(q).find((d) => d.drawer!.taps)!) as AssemblyInst;
    const inst = assemblyById(p, qi.id)!;
    expect(structureOf(q, qi)).toBe(structureOf(p, inst));
    insertEffect(q, drawerOf(q, qi.id)!, { type: 'phaser' }, 0);
    expect(structureOf(q, qi)).toBe(structureOf(p, inst));
  });

  it('drawerPresetStructure hashes FXD1, the base and each effect in order', () => {
    const bytes = [70, 88, 68, 49, 0x78, 0x56, 0x34, 0x12, 2, 1, 0, 0, 0, 0xff, 0, 0, 0];
    expect(drawerPresetStructure('12345678', ['00000001', '000000ff'])).toBe(fnv(String.fromCharCode(...bytes)));
    expect(drawerPresetStructure('12345678', ['000000ff', '00000001'])).not.toBe(drawerPresetStructure('12345678', ['00000001', '000000ff']));
    expect(drawerPresetStructure('12345678', [])).not.toBe('12345678');
  });

  it('a poly instrument\'s drawer runs once, after the voices', () => {
    const { p, inst } = synth();
    setPoly(p, DEFS, inst, true);
    const d = addDrawer(p, inst.id);
    const e = insertEffect(p, d, { type: 'crush' });
    const copies = copiesOf(p);
    expect(copies.get(inst.modules[0])).toBeGreaterThan(1);
    // (once: one copy, or a stereo module's two, #1141; never one per voice)
    for (const id of allModules(p, e)) expect(copies.get(id) ?? 1).toBe(p.modules.find((m) => m.id === id)!.stereo ? 2 : 1);
  });
});

describe('repairs', () => {
  const base = (): { p: Patch; inst: AssemblyInst; d: AssemblyInst } => {
    const { p, inst } = synth();
    const d = addDrawer(p, inst.id);
    insertEffect(p, d, { type: 'crush' });
    return { p, inst, d };
  };
  it('a drawer that does not fit is an ordinary assembly again; a bad chain stops being one and leaves its drawer', () => {
    const { p, inst, d } = base();
    const raw = JSON.parse(JSON.stringify(p)) as Patch;
    const rd = raw.assemblies!.find((a) => a.id === d.id)!;
    rd.drawer!.taps = [{ module: 999, port: 'out' }, { module: 999, port: 'out' }];
    const q = validatePatch(raw, DEFS);
    expect(fixAssemblies(q, DEFS).some((m) => /no FX drawer/.test(m))).toBe(true);
    expect(drawerOf(q, inst.id)).toBeUndefined();
    const raw2 = JSON.parse(JSON.stringify(p)) as Patch;
    const fx = raw2.assemblies!.find((a) => a.chain)!;
    fx.chain!.ins = [7, 9];
    const q2 = validatePatch(raw2, DEFS);
    expect(fixAssemblies(q2, DEFS).some((m) => /taken out of its FX drawer/.test(m))).toBe(true);
    expect(effectsOf(q2, drawerOf(q2, inst.id)!)).toEqual([]);
    expect(parentOf(q2, fx.id)).toBeUndefined();
  });
  it('one Output drawer per patch; drawers and their effects are never drawn as plain cards', () => {
    const { p, d } = base();
    const od = addDrawer(p, 'output');
    expect(addDrawer(p, 'output')).toBe(od);
    const raw = JSON.parse(JSON.stringify(p)) as Patch;
    raw.assemblies!.push({ ...structuredClone(raw.assemblies!.find((a) => a.id === od.id)!), id: 99, label: 'Output FX 2' });
    const q = validatePatch(raw, DEFS);
    fixAssemblies(q, DEFS);
    expect(drawers(q).filter((x) => !x.drawer!.taps)).toHaveLength(1);
    const hidden = hiddenAssemblies(p);
    d.open = true;
    expect(hiddenAssemblies(p)).toEqual(hidden);
    expect(hidden.has(d.id) && hidden.has(od.id)).toBe(true);
    for (const e of effectsOf(p, d)) for (const id of allModules(p, e)) expect(hiddenModules(p).has(id)).toBe(true);
  });
});

describe('devices', () => {
  it('effects follow their instrument in chain order, the Output drawer\'s come before the Output; drawers are no devices', () => {
    const { p, inst } = synth(true);
    inst.params = [{ module: inst.modules[1], param: 'cutoff', label: 'cutoff' }];
    const d = addDrawer(p, inst.id);
    const a = insertEffect(p, d, { type: 'shape' });
    const b = insertEffect(p, d, { type: 'chorus' });
    const od = addDrawer(p, 'output');
    const c = insertEffect(p, od, { type: 'reverb' });
    const keys = devicesOf(p, DEFS).map((x) => x.key);
    const at = keys.indexOf(`a${inst.id}`);
    expect(keys.slice(at, at + 3)).toEqual([`a${inst.id}`, `a${a.id}`, `a${b.id}`]);
    expect(keys.slice(-2)).toEqual([`a${c.id}`, `m${p.modules.find((m) => m.type === 'output')!.id}`]);
    expect(keys).not.toContain(`a${d.id}`);
    expect(keys).not.toContain(`a${od.id}`);
    expect(rackOf(p)).toEqual({
      effects: [a, b, c].map((e) => ({ asm: e.id, targets: allModules(p, e).filter((id) => !chainHelpers(p).has(id)) })),
      drawers: [{ drawer: d.id, owner: inst.id, effects: [a.id, b.id] }, { drawer: od.id, owner: 'output', effects: [c.id] }],
    });
  });

  it('embedded cards of an ordinary assembly are pages of their parent, never devices', () => {
    const p = newPatch(DEFS);
    const f = addModule(p, DEFS.filter, 0, 0);
    const v = addModule(p, DEFS.vca, 300, 0);
    const inner = makeAssembly(p, [v.id], 'amp');
    inner.params = [{ module: v.id, param: 'gain', label: 'gain' }];
    const outer = makeAssembly(p, [f.id], 'voice', [inner.id]);
    outer.params = [{ module: f.id, param: 'cutoff', label: 'cutoff' }];
    const pages = (): number => devicesOf(p, DEFS).find((x) => x.asm === outer.id)!.pages.length;
    const without = pages();
    outer.cards = [inner.id];
    expect(pages()).toBe(without + 1);
    expect(devicesOf(p, DEFS).some((x) => x.asm === inner.id)).toBe(false);
  });
});

describe('legacy bus conversion', () => {
  const sources = (): [string, Patch][] => [
    ...Object.entries(survey.patches).map(([n, raw]): [string, Patch] => [`1.14 ${n}`, structuredClone(raw)]),
    ...Object.entries(PRESETS).map(([n, make]): [string, Patch] => [n, make()]),
  ];
  /** a 1.14 factory patch that has its master FX bus */
  const withBus = (): Patch => {
    const p = structuredClone(Object.values(survey.patches).find((raw) => { const q = structuredClone(raw); fixAssemblies(q, DEFS); return fxBusOf(q, DEFS)?.stages.length === 4; })!);
    fixAssemblies(p, DEFS);
    return p;
  };

  it('every factory patch with a bus converts: same modules in the same order, cables, values and switches (helpers on)', () => {
    let converted = 0;
    for (const [name, raw] of sources()) {
      const before = structuredClone(raw);
      fixAssemblies(before, DEFS);
      const bus = fxBusOf(before, DEFS);
      const after = roundTrip(raw);
      if (!bus) {
        expect(drawers(after).length, name).toBe(drawers(before).length);
        continue;
      }
      if (name.startsWith('1.14 ')) converted++;
      expect(after.modules.map((m) => m.id), name).toEqual(before.modules.map((m) => m.id));
      const key = (c: Patch['cables'][number]): string => `${c.from.module}.${c.from.port}>${c.to.module}.${c.to.port}`;
      expect(new Set(after.cables.map(key)), name).toEqual(new Set(before.cables.map(key)));
      const helpers = chainHelpers(after);
      expect([...helpers].sort()).toEqual(bus.stages.flatMap((s) => s.helpers).sort());
      after.modules.forEach((m, i) => {
        expect(m.params, name).toMatchObject(before.modules[i].params);
        if (!helpers.has(m.id)) expect(!!m.bypass, `${name} ${m.type}`).toBe(!!before.modules[i].bypass);
        else expect(m.bypass).toBeUndefined();
      });
      // the stages are the effects, in order, with their rows; the root is gone
      const ds = drawers(after);
      expect(ds).toHaveLength(1);
      const fx = effectsOf(after, ds[0]);
      expect(fx.map((e) => e.id), name).toEqual(bus.stages.map((s) => s.assembly));
      for (const e of fx) expect(e.params, name).toEqual(assemblyById(before, e.id)!.params);
      expect(assemblyById(after, bus.assembly)).toBe(ds[0]);
      expect(fxBusOf(after, DEFS)).toBeNull();
      // idempotent
      expect(JSON.stringify(roundTrip(after))).toBe(JSON.stringify(after));
      expect(JSON.stringify(convertLegacyBus(structuredClone(after), DEFS))).toBe(JSON.stringify(after));
      // a sole instrument takes the bus as its drawer
      const owner = ownerOf(after, ds[0]);
      const instruments = assembliesOf(before).filter((a) => !parentOf(before, a.id) && a.id !== bus.assembly && !a.drawer);
      if (owner === 'output') expect(instruments.length, name).not.toBe(1);
      else expect(instruments.map((a) => a.id)).toContain(owner.id);
    }
    // (the 1.14 graphs keep their buses; today's factory build may already hand out drawers)
    expect(converted).toBeGreaterThan(10);
  });

  it('remaps the panel: a Toggle on the bus switches the drawer, Page lists move to the effects, the factory FX Page does nothing', () => {
    const p = withBus();
    const bus = fxBusOf(p, DEFS)!;
    const main = p.modules.find((m) => m.type === 'fm1')!;
    main.panel = {
      kinds: { fx: 'page', lfo: 'page', edit: 'bypass' },
      pages: { fx: [{ device: `a${bus.assembly}`, page: 0 }], lfo: [{ device: `a${bus.assembly}`, page: 3 }, { device: 'm1', page: 0 }] },
      targets: { edit: { asm: bus.assembly } },
    };
    const q = roundTrip(p);
    const panel = q.modules.find((m) => m.type === 'fm1')!.panel!;
    expect(panel.kinds!.fx).toBe('nothing');
    expect(panel.pages!.fx).toBeUndefined();
    // where the bus's page 3 was: the stage holding its rows, and that stage's own page among the bus's pages
    const pages = devicesOf(p, DEFS).find((x) => x.asm === bus.assembly)!.pages;
    const stageOf = (i: number): number => bus.stages.find((s) => assemblyById(p, s.assembly)!.params.some((r) => r.module === pages[i].rows[0].module))!.assembly;
    const want = { device: `a${stageOf(3)}`, page: [0, 1, 2].filter((i) => stageOf(i) === stageOf(3)).length };
    expect(panel.pages!.lfo).toEqual([want, { device: 'm1', page: 0 }]);
    expect(panel.targets!.edit).toEqual({ asm: drawers(q)[0].id });
  });
});

describe('stereo effects in drawers (#1141, release 1.27)', () => {
  const sideCables = (p: Patch, to: Endpoint): Patch['cables'] => p.cables.filter((c) => sameEnd(c.to, to));
  const def = (name: string) => (catalog(name).source as { def: never }).def;

  it('a drawer insert of Drive is one stereo Waveshaper (the legacy form: two), its rows untied; a new Reverb is one Reverb', () => {
    const { p, inst, out } = synth();
    const d = addDrawer(p, inst.id);
    const drive = insertEffect(p, d, { type: 'shape' });
    const shapes = allModules(p, drive).map((id) => p.modules.find((m) => m.id === id)!);
    expect(shapes.map((m) => m.type)).toEqual(['shape']);
    expect(shapes[0].stereo).toBe(true);
    expect(drive.chain).toEqual({ ins: [0, 0], outs: [0, 0] });
    expect(drive.params.every((r) => !r.also)).toBe(true);
    const legacy = legacyEffectDef('drive');
    expect(legacy.modules.map((m) => m.type)).toEqual(['shape', 'shape']);
    expect(legacy.modules.some((m) => m.stereo)).toBe(false);
    expect(WET_DRAWER_FORM).toBe('stereo-dry');
    const rv = insertEffect(p, d, { type: 'reverb' });
    expect(allModules(p, rv).map((id) => p.modules.find((m) => m.id === id)!.type)).toEqual(['reverb']);
    expect([chainIns(rv, 0), chainIns(rv, 1), chainOuts(rv, 0), chainOuts(rv, 1)].map((l) => l.map((t) => t.port))).toEqual([['in'], ['r'], ['out'], ['r']]);
    expect(rv.params.find((r) => r.label === 'mix')!.module).toBe(rv.modules[0]);
    expect(classicMix(p, rv)).toBe(false);
    expectChain(p, d, out);
  });

  it('both forms of WET_DRAWER_FORM: helpers keeps the six-module Reverb, stereo-dry is the Reverb alone', () => {
    const p = newPatch(DEFS);
    const a = wrapEffect(p, { module: addModule(p, DEFS.reverb, 0, 0).id }, undefined, undefined, { wet: 'helpers' });
    expect(allModules(p, a)).toHaveLength(6);
    expect(classicMix(p, a)).toBe(true);
    const b = wrapEffect(p, { module: addModule(p, DEFS.reverb, 0, 900).id }, undefined, undefined, { wet: 'stereo-dry' });
    expect(allModules(p, b)).toHaveLength(1);
    expect(b.chain!.helpers).toBeUndefined();
    expect(classicMix(p, b)).toBe(false);
  });

  it('side cables join and split where a stereo module meets L/R neighbours, so a mixed chain stays stereo through any reorder', () => {
    const { p, inst, out } = synth(true);   // (the tap: a Pan's l / r)
    const d = addDrawer(p, inst.id);
    const [pl, pr] = d.drawer!.taps!;
    const drive = insertEffect(p, d, { type: 'shape' });
    const chorus = insertEffect(p, d, { type: 'chorus' });
    const rv = insertEffect(p, d, { type: 'reverb' });
    const sh = { module: drive.modules[0], port: 'in' }, shOut = { module: drive.modules[0], port: 'out' };
    // the join: the Pan's l feeds the left copy, its r the right one
    expect(sideCables(p, sh).map((c) => [c.from.port, c.side])).toEqual([['l', 'l'], ['r', 'r']]);
    // the split: the Drive's left side into the chorus pair's first copy, its right side into the second
    for (const ch of [0, 1] as Channel[]) for (const t of chainIns(chorus, ch))
      expect(sideCables(p, t).filter((c) => sameEnd(c.from, shOut)).map((c) => c.side)).toEqual([ch ? 'r' : 'l']);
    expectChain(p, d, out);
    // Reverb first: the Pan's sides into its in / r (two mono jacks: whole cables), its out / r join into the Drive
    moveEffect(p, d, rv.id, 0);
    expectChain(p, d, out);
    expect(sideCables(p, sh).map((c) => [c.from.port, c.side])).toEqual([['out', 'l'], ['r', 'r']]);
    // Drive last: it splits into the Output's l and r
    moveEffect(p, d, drive.id, 2);
    expect(sideCables(p, { module: out, port: 'l' }).map((c) => c.side)).toEqual(['l']);
    expect(sideCables(p, { module: out, port: 'r' }).map((c) => c.side)).toEqual(['r']);
    expectChain(p, d, out);
    // a rewire changes nothing; a round trip keeps the sides; a copy of the instrument carries them
    const before = JSON.stringify(p.cables);
    rewire(p, d);
    expect(JSON.stringify(p.cables)).toBe(before);
    const q = roundTrip(p);
    expect(q.cables.filter((c) => c.side)).toEqual(p.cables.filter((c) => c.side));
    const copy = insertAssembly(q, DEFS, toDef(q, assemblyById(q, inst.id)!), 3000, 0);
    expect(q.cables.filter((c) => c.side && allModules(q, copy).includes(c.to.module)).length).toBe(p.cables.filter((c) => c.side && c.to.module !== out).length);
    // a mono tap into a stereo module: one whole cable
    const mono = synth();
    const md = addDrawer(mono.p, mono.inst.id);
    const e = insertEffect(mono.p, md, { type: 'filter' });
    expect(sideCables(mono.p, chainIns(e, 0)[0]).map((c) => c.side)).toEqual([undefined]);
  });

  it('a pair assembly gets stereo members when every member has a stereo mode, else stays an L/R pair', () => {
    const p = newPatch(DEFS);
    const od = insertAssembly(p, DEFS, structuredClone(def('Overdrive')), 0, 0);
    const n = allModules(p, od).length;
    const e = wrapEffect(p, { assembly: od.id });
    expect(childrenOf(p, e).map((c) => c.id)).toEqual([od.id]);
    expect(allModules(p, e)).toHaveLength(n);
    expect(allModules(p, e).every((id) => p.modules.find((m) => m.id === id)!.stereo)).toBe(true);
    expect(e.chain).toEqual({ ins: [0, 0], outs: [0, 0] });
    const mixed = EFFECT_CATALOG.find((x) => x.mode === 'pair' && 'def' in x.source && x.source.def.modules.some((m) => !DEFS[m.type].stereo))!;
    expect(mixed, 'a pair assembly with a member that has no stereo mode').toBeDefined();
    const m = insertAssembly(p, DEFS, structuredClone((mixed.source as { def: never }).def), 0, 900);
    const w = wrapEffect(p, { assembly: m.id });
    expect(childrenOf(p, w)).toHaveLength(2);
    expect(allModules(p, w).some((id) => p.modules.find((x) => x.id === id)!.stereo)).toBe(false);
  });

  it('an existing (1.26) drawer opens unchanged: its pairs and helper Reverb stay, rewire leaves every cable, the Reverb says classic mix', () => {
    const raw = Object.values(survey.patches).find((x) => { const q = structuredClone(x); fixAssemblies(q, DEFS); return fxBusOf(q, DEFS)?.stages.length === 4; })!;
    const p = roundTrip(raw);
    const before = JSON.stringify(p);
    const d = drawers(p)[0];
    rewire(p, d);
    expect(JSON.stringify(p)).toBe(before);
    expect(p.modules.some((m) => m.stereo) || p.cables.some((c) => c.side)).toBe(false);
    const byName = new Map(effectsOf(p, d).map((e) => [e.name, e]));
    expect(allModules(p, byName.get('Drive')!).length).toBe(2);
    expect(classicMix(p, byName.get('Reverb')!)).toBe(true);
    expect(['Drive', 'Chorus', 'Delay'].some((n) => classicMix(p, byName.get(n)!))).toBe(false);
    // a new stereo effect joins the end of the old chain (side cables from the old Reverb's dry stages, its wet return on
    // both sides a whole cable); the old effects' cables among themselves stay as they were
    const old = new Set(effectsOf(p, d).flatMap((e) => allModules(p, e)));
    const inner = (q: Patch): string[] => q.cables.filter((c) => old.has(c.from.module) && old.has(c.to.module)).map((c) => `${c.from.module}.${c.from.port}>${c.to.module}.${c.to.port}${c.side ?? ''}`).sort();
    const kept = inner(p);
    const crush = insertEffect(p, d, { type: 'crush' });
    expect(inner(p)).toEqual(kept);
    expect(p.cables.filter((c) => c.to.module === crush.modules[0] && c.to.port === 'in').map((c) => c.side).sort()).toEqual(['l', 'r', undefined]);
    expectChain(p, d, p.modules.find((m) => m.type === 'output')!.id);
  });
});

describe('the 909 Kit\'s drawer (#1141)', () => {
  const kit = (types: string[]): { p: Patch; rv?: AssemblyInst; bin: Uint8Array; plain: number } => {
    const p = factoryWithPatterns('909 Kit');
    clearAllPatterns(p);
    const plain = encodePatch(p, true).length;
    const d = addDrawer(p, assembliesOf(p).find((a) => a.name === '909 kit')!.id);
    const made = types.map((type) => insertEffect(p, d, { type }));
    return { p, rv: made[types.indexOf('reverb')], bin: encodePatch(p, true), plain };
  };
  const grouped = (bin: Uint8Array): boolean => ((bin[6] | bin[7] << 8) & FLAG_CABLES3) !== 0;

  it('an empty drawer leaves the Output\'s r free (it plays l): the cables stay grouped, the patch under the 3,840 B cap', () => {
    const { p, bin, plain } = kit([]);
    const out = p.modules.find((m) => m.type === 'output')!.id;
    expect(p.cables.filter((c) => c.to.module === out && c.to.port === 'r')).toEqual([]);
    expect(grouped(bin)).toBe(true);
    expect(bin.length).toBeLessThan(3840);
    expect(bin.length - plain).toBeLessThan(10);   // (5 B: the rack with its one empty drawer)
    expectChain(p, drawers(p)[0], out);
  });

  it('a Reverb alone hears the mono kit once, in its `in`: its `r` stays free, the cables stay grouped', () => {
    const { p, rv, bin, plain } = kit(['reverb']);
    const m = rv!.modules[0];
    expect(p.cables.filter((c) => c.to.module === m && c.to.port === 'r')).toEqual([]);
    expect(p.cables.filter((c) => c.to.module === m)).toHaveLength(11);   // (the kit's eleven voices, once)
    expect(grouped(bin)).toBe(true);
    expect(bin.length - plain).toBeLessThan(100);   // (98 B: the rack, the effect's device and the Reverb's record)
    expectChain(p, drawers(p)[0], p.modules.find((x) => x.type === 'output')!.id);
  });

  it('Drive then Reverb: the Drive splits into the Reverb\'s in / r; either order stays grouped', () => {
    const a = kit(['shape', 'reverb']);
    expect(a.p.cables.filter((c) => c.to.module === a.rv!.modules[0]).map((c) => `${c.to.port}/${c.side}`).sort()).toEqual(['in/l', 'r/r']);
    expect(grouped(a.bin)).toBe(true);
    expect(a.bin.length).toBeLessThanOrEqual(3781);
    const b = kit(['reverb', 'shape']);
    expect(b.p.cables.filter((c) => c.to.module === b.rv!.modules[0] && c.to.port === 'r')).toEqual([]);
    expect(grouped(b.bin)).toBe(true);
  });
});
