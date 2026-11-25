// SPDX-License-Identifier: GPL-3.0-only
// @vitest-environment jsdom
// The user's own assemblies as FX drawer effects (1.26.7): the chain mode from their jacks (two audio ins and outs: stereo
// as they are; one in and one out: an L/R pair, or wet chosen in the drop's menu; no audio in or out: refused, saying
// why), Use as an effect… saved with the assembly and listed in Library › Effects, and instrument presets holding one.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadLibrary, storeAssembly } from './assemblies';
import { allModules, assemblyById, childrenOf, exposePort, makeAssembly, promote, toDef, type AssemblyInst } from './assembly';
import { applyPreset, capturePreset, storePreset, userPresets } from './device-presets';
import { Editor, type EditorEvents } from './editor';
import { addDrawer, chainIns, chainOuts, effectModes, effectsOf, insertEffect, removeEffect } from './fx-drawer';
import { drawerScope } from './fx-preset';
import { effectGroups, entryOf, userEffects } from './library-effects';
import { DEFS } from './modules';
import { addModule, connect, newPatch, sameEnd, validatePatch, type Patch } from './patch';
import { baseFormat, encodePatch, FORMAT_RACK } from './patchbin';

vi.hoisted(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  g.ResizeObserver ??= class { observe(): void {} unobserve(): void {} disconnect(): void {} };
  if (!document.fonts) Object.defineProperty(document, 'fonts', { value: { addEventListener() {}, ready: Promise.resolve() } });
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.checkVisibility ??= () => true;
  proto.scrollTo ??= () => {};
});

const copy = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/** a stereo instrument (two oscillators, out L / out R into the Output) with an empty FX drawer */
function rig(): { p: Patch; inst: AssemblyInst; drawer: AssemblyInst } {
  const p = newPatch(DEFS, 'Custom FX');
  const out = p.modules.find((m) => m.type === 'output')!;
  const a = addModule(p, DEFS.osc, 20, 20), b = addModule(p, DEFS.osc, 340, 20);
  const inst = makeAssembly(p, [a.id, b.id], 'Hera 4');
  promote(inst, a.id, DEFS.osc.params[0].name, p);
  for (const m of [a, b]) exposePort(inst, 'out', m.id, 'out', undefined, p);
  connect(p, DEFS, { module: a.id, port: 'out' }, { module: out.id, port: 'l' });
  connect(p, DEFS, { module: b.id, port: 'out' }, { module: out.id, port: 'r' });
  inst.open = false;
  return { p, inst, drawer: addDrawer(p, inst.id) };
}

/** an OTT-like assembly: a Dynamics per side, in L / in R, out L / out R, two card rows */
function ott(p: Patch): AssemblyInst {
  const l = addModule(p, DEFS.dyn, 900, 400), r = addModule(p, DEFS.dyn, 1200, 400);
  const a = makeAssembly(p, [l.id, r.id], 'OTT');
  for (const m of [l, r]) exposePort(a, 'in', m.id, 'in', undefined, p);
  for (const m of [l, r]) exposePort(a, 'out', m.id, 'out', undefined, p);
  a.inputs.forEach((x, i) => (x.label = i ? 'in R' : 'in L'));
  a.outputs.forEach((x, i) => (x.label = i ? 'out R' : 'out L'));
  promote(a, l.id, DEFS.dyn.params[0].name, p);
  a.params[0].also = [{ module: r.id, param: DEFS.dyn.params[0].name }];
  promote(a, l.id, DEFS.dyn.params[1].name, p);
  a.open = false;
  return a;
}

/** a mono assembly: one filter, its audio in and lp24 out */
function mono(p: Patch): AssemblyInst {
  const f = addModule(p, DEFS.filter, 900, 900);
  const a = makeAssembly(p, [f.id], 'Smear');
  exposePort(a, 'in', f.id, 'in', undefined, p);
  exposePort(a, 'out', f.id, 'lp24', undefined, p);
  promote(a, f.id, DEFS.filter.params[0].name, p);
  a.open = false;
  return a;
}

/** an LFO assembly: no audio input */
function lfo(p: Patch): AssemblyInst {
  const m = addModule(p, DEFS.lfo, 900, 1300);
  const a = makeAssembly(p, [m.id], 'Wobble');
  exposePort(a, 'out', m.id, 'out', undefined, p);
  a.open = false;
  return a;
}

function editorOn(p: Patch, log: string[] = [], ev: Partial<EditorEvents> = {}): Editor {
  document.body.innerHTML = '<div id="canvas"><div id="canvas-space"><div id="patch-world"><svg id="cables"></svg><div id="modules"></div><svg id="cable-glow"></svg><svg id="patch-preview"></svg></div></div></div>';
  const events: EditorEvents = {
    onStructure() {}, onParam() {}, onAtt() {}, onBypass() {}, onRange() {}, onTrack() {}, onTransport() {},
    onLayout() {}, onError: (msg) => log.push(msg), onSaveAssembly() {}, ...ev,
  };
  return new Editor(document.getElementById('canvas')!, p, events);
}
const menuItems = (): string[] => [...document.querySelectorAll<HTMLButtonElement>('.ctx button')].map((b) => b.textContent!);
const pick = (text: string): void => [...document.querySelectorAll<HTMLButtonElement>('.ctx button')].find((b) => b.textContent!.startsWith(text))!.click();

beforeEach(() => localStorage.clear());
afterEach(() => document.querySelectorAll('.ctx').forEach((m) => m.remove()));

describe('the user’s own assembly in an FX drawer', () => {
  it('two audio ins and outs: stereo as it is, its jacks the chain’s, nothing copied (what format 66 plays)', () => {
    const { p, inst, drawer } = rig();
    const a = ott(p);
    const modules = p.modules.length;
    expect(effectModes(p, a)).toEqual(['stereo']);
    const e = insertEffect(p, drawer, { assembly: a.id });
    expect(e.id).toBe(a.id);
    expect(p.modules).toHaveLength(modules);
    expect(e.chain).toEqual({ ins: [0, 1], outs: [0, 1] });
    expect(effectsOf(p, drawer).map((x) => x.id)).toEqual([a.id]);
    // the instrument's L feeds in L, its R in R; out L / out R go to the Output's l / r
    const out = p.modules.find((m) => m.type === 'output')!.id;
    const [oscL, oscR] = inst.modules;
    for (const [ch, osc, port] of [[0, oscL, 'l'], [1, oscR, 'r']] as const) {
      for (const t of chainIns(e, ch)) expect(p.cables.some((c) => c.from.module === osc && sameEnd(c.to, t))).toBe(true);
      for (const s of chainOuts(e, ch)) expect(p.cables.some((c) => sameEnd(c.from, s) && c.to.module === out && c.to.port === port)).toBe(true);
    }
    expect(baseFormat(p)).toBeLessThanOrEqual(FORMAT_RACK);
    expect(() => encodePatch(p, true)).not.toThrow();
  });

  it('a pair labelled R before L is put in L / R order', () => {
    const { p, drawer } = rig();
    const a = ott(p);
    a.inputs.reverse();
    a.inputs.forEach((x, i) => (x.label = i ? 'in L' : 'in R'));
    const e = insertEffect(p, drawer, { assembly: a.id });
    expect(e.inputs[e.chain!.ins[0]].label).toBe('in L');
    expect(e.inputs[e.chain!.ins[1]].label).toBe('in R');
  });

  it('one in and one out: an L/R pair (two copies, one set of controls), or wet when asked', () => {
    const { p, drawer } = rig();
    expect(effectModes(p, mono(p))).toEqual(['pair', 'wet']);
    const pair = insertEffect(p, drawer, { assembly: mono(p).id });
    expect(childrenOf(p, pair)).toHaveLength(2);
    expect(pair.params[0].also).toHaveLength(1);
    const wet = insertEffect(p, drawer, { assembly: mono(p).id }, undefined, 'wet');
    expect(childrenOf(p, wet)).toHaveLength(1);
    expect(wet.chain!.helpers!.length).toBeGreaterThan(0);
    expect(effectsOf(p, drawer).map((x) => x.id)).toEqual([pair.id, wet.id]);
    expect(baseFormat(p)).toBeLessThanOrEqual(FORMAT_RACK);
  });

  it('no audio input: refused with the reason, nothing changed', () => {
    const { p, drawer } = rig();
    const a = lfo(p);
    expect(effectModes(p, a)).toBe('"Wobble" has no audio input, so it cannot go into an FX drawer.');
    expect(() => insertEffect(p, drawer, { assembly: a.id })).toThrow(/no audio input/);
  });
});

describe('the editor', () => {
  it('a mono assembly asks how in a small menu; Wet puts it in wet, one undo step', () => {
    const { p, drawer } = rig();
    const id = mono(p).id;
    const e = editorOn(p);
    expect(e.addToDrawerFromCanvas(id, drawer.id, 0)).toBe(true);
    expect(menuItems()).toEqual(['As an L/R pairtwo copies, 2× CPU', 'Wet, added to both sidesreverbs, echoes']);
    pick('Wet');
    const [fx] = effectsOf(e.patch, assemblyById(e.patch, drawer.id)!);
    expect(childrenOf(e.patch, fx).map((c) => c.id)).toEqual([id]);
    expect(fx.chain!.helpers!.length).toBeGreaterThan(0);
  });

  it('a stereo assembly goes straight in; an LFO is refused with the reason in the status line', () => {
    const { p, drawer } = rig();
    const stereo = ott(p).id, wobble = lfo(p).id;
    const log: string[] = [];
    const e = editorOn(p, log);
    expect(e.addToDrawerFromCanvas(stereo, drawer.id, 0)).toBe(true);
    expect(document.querySelector('.ctx')).toBeNull();
    expect(effectsOf(e.patch, assemblyById(e.patch, drawer.id)!).map((x) => x.id)).toEqual([stereo]);
    expect(e.addToDrawerFromCanvas(wobble, drawer.id, 1)).toBe(false);
    expect(log).toEqual(['"Wobble" has no audio input, so it cannot go into an FX drawer.']);
    expect(effectsOf(e.patch, assemblyById(e.patch, drawer.id)!)).toHaveLength(1);
  });

  it('⋯ → Use as an effect… saves the mode with the assembly; it then goes in without asking', () => {
    const { p, drawer } = rig();
    const id = mono(p).id;
    const told: [string, string | null][] = [];
    const e = editorOn(p, [], { onEffectMode: (name, mode) => told.push([name, mode]) });
    document.querySelector<HTMLButtonElement>(`#modules > .module.assembly[data-asm="${id}"] .mhead button.more`)!.click();
    pick('Use as an effect…');
    expect(menuItems()).toEqual(['As an L/R pairtwo copies, 2× CPU', 'Wet, added to both sidesreverbs, echoes']);
    pick('Wet');
    expect(assemblyById(e.patch, id)!.fxMode).toBe('wet');
    expect(told).toEqual([['Smear', 'wet']]);
    // kept through a reload of the patch and in its saved definition
    expect(validatePatch(copy(e.patch), DEFS).assemblies!.find((a) => a.id === id)!.fxMode).toBe('wet');
    expect(toDef(e.patch, assemblyById(e.patch, id)!).fxMode).toBe('wet');
    expect(e.addToDrawerFromCanvas(id, drawer.id, 0)).toBe(true);
    expect(document.querySelector('.ctx')).toBeNull();
    expect(childrenOf(e.patch, effectsOf(e.patch, assemblyById(e.patch, drawer.id)!)[0])).toHaveLength(1);
  });
});

describe('Library › Effects', () => {
  it('lists the user’s saved assemblies marked Use as an effect beside the factory ones, and adds them in their mode', () => {
    const { p } = rig();
    const a = ott(p);
    storeAssembly(toDef(p, mono(p)));
    expect(userEffects()).toEqual([]);
    a.fxMode = 'stereo';
    storeAssembly(toDef(p, a));
    expect(userEffects().map((x) => [x.name, x.mode])).toEqual([['OTT', 'stereo']]);
    expect(loadLibrary().find((d) => d.name === 'OTT')!.fxMode).toBe('stereo');
    const stereo = effectGroups().find((g) => g.mode === 'stereo')!;
    expect(stereo.entries.at(-1)!.name).toBe('OTT');
    const entry = entryOf({ def: loadLibrary().find((d) => d.name === 'OTT')! })!;
    expect(entry.mode).toBe('stereo');
    // into a drawer from the Library: a new copy, stereo as it is
    const q = rig();
    const e = insertEffect(q.p, q.drawer, entry.source);
    expect(e.name).toBe('OTT');
    expect(e.chain).toEqual({ ins: [0, 1], outs: [0, 1] });
    expect(allModules(q.p, e)).toHaveLength(2);
  });
});

describe('an instrument preset with a custom effect in its drawer (FXD1)', () => {
  it('stores the effect like any drawer effect and loads it back, the drawer rebuilt when it is gone', () => {
    const { p, inst, drawer } = rig();
    const fx = insertEffect(p, drawer, { assembly: ott(p).id });
    const row = fx.params[1];
    p.modules.find((m) => m.id === row.module)!.params[row.param] = 8;
    storePreset(p, inst, 'Squashed');
    const stored = userPresets()[0];
    expect(stored.fx!.map((f) => f.name)).toEqual(['OTT']);
    const want = capturePreset(p, inst, 'Squashed').values;
    // a reopened patch whose drawer lost it: loading the preset brings it back from the preset's own copy
    const reopened = validatePatch(copy(p), DEFS);
    const other = reopened.assemblies!.find((a) => a.id === inst.id)!;
    removeEffect(reopened, drawerScope(reopened, other)!.effects[0].id);
    expect(drawerScope(reopened, other)!.effects).toHaveLength(0);
    expect(applyPreset(reopened, other, stored, true)).toBe(true);
    expect(drawerScope(reopened, other)!.effects.map((x) => x.name)).toEqual(['OTT']);
    expect(capturePreset(reopened, other, 'Squashed').values).toEqual(want);
    // from the FM-1 (values only): only a drawer that holds it takes it
    const fromDevice = { structure: stored.structure, name: stored.name, values: stored.values };
    const bare = validatePatch(copy(p), DEFS);
    const bareInst = bare.assemblies!.find((a) => a.id === inst.id)!;
    removeEffect(bare, drawerScope(bare, bareInst)!.effects[0].id);
    expect(applyPreset(bare, bareInst, fromDevice)).toBe(false);
    p.modules.find((m) => m.id === row.module)!.params[row.param] = 12;
    expect(applyPreset(p, inst, fromDevice)).toBe(true);
    expect(p.modules.find((m) => m.id === row.module)!.params[row.param]).toBe(8);
  });
});
