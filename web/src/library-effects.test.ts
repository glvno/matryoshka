// SPDX-License-Identifier: GPL-3.0-only
// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { FACTORY } from './assemblies';
import { insertAssembly } from './assembly';
import { capturePreset } from './device-presets';
import { catalogEffectDef, drawerOf, EFFECT_CATALOG, effectsOf, outputDrawer } from './fx-drawer';
import { addToDrawer, currentInstrument, drawerTargets, effectCpu, effectGroups, effectPresets, entryOf, entryStructures, instrumentsOf, MODES, presetSource } from './library-effects';
import { DEFS } from './modules';
import { newPatch } from './patch';
import { defStructure } from './structure';

const def = (name: string) => FACTORY.find((d) => d.name === name)!;
const withHera = () => {
  const p = newPatch(DEFS);
  const hera = insertAssembly(p, DEFS, def('Hera 4'), 40, 40);
  return { p, hera };
};
const byType = (type: string) => EFFECT_CATALOG.find((e) => 'type' in e.source && e.source.type === type)!;

beforeEach(() => localStorage.clear());

describe('the Library’s effects', () => {
  it('groups every catalog effect once, by how it sits in the stereo chain, in the Library’s order', () => {
    const groups = effectGroups();
    expect(groups.map((g) => g.mode)).toEqual(MODES.map((m) => m.mode).filter((m) => EFFECT_CATALOG.some((e) => e.mode === m)));
    expect(groups.flatMap((g) => g.entries)).toHaveLength(EFFECT_CATALOG.length);
    for (const g of groups) expect(g.entries.every((e) => e.mode === g.mode)).toBe(true);
    expect(groups.find((g) => g.mode === 'pair')!.title).toBe('In line, as an L/R pair');
  });

  it('finds the effect a module type or a factory assembly is, and none for a modulator or an instrument', () => {
    expect(entryOf({ type: 'reverb' })?.mode).toBe('wet');
    expect(entryOf({ type: 'lfo' })).toBeUndefined();
    expect(entryOf({ def: def('echo') })?.name).toBe('Echo');
    expect(entryOf({ def: def('Hera 4') })).toBeUndefined();
    expect(EFFECT_CATALOG.some((e) => e.name.toLowerCase() === 'master fx')).toBe(false);
  });

  it('counts an L/R pair’s two copies in its CPU share', () => {
    const pair = EFFECT_CATALOG.find((e) => e.mode === 'pair' && 'type' in e.source)!;
    const p = newPatch(DEFS);
    const one = insertAssembly(p, DEFS, catalogEffectDef(pair), 0, 0);
    expect(one.modules.length).toBeGreaterThanOrEqual(2);
    expect(effectCpu(pair)).toBeGreaterThan(0);
  });
});

describe('adding to an FX drawer', () => {
  it('offers each instrument’s drawer and the Output’s, making the drawer on first use and opening it', () => {
    const { p, hera } = withHera();
    expect(instrumentsOf(p).map((a) => a.id)).toEqual([hera.id]);
    expect(drawerTargets(p)).toEqual([
      { to: hera.id, label: `${hera.label}’s FX`, detail: 'new drawer' },
      { to: 'output', label: 'Output FX', detail: 'new drawer' },
    ]);
    const effect = addToDrawer(p, { type: 'reverb' }, hera.id);
    const drawer = drawerOf(p, hera.id)!;
    expect(drawer.open).toBe(true);
    expect(effectsOf(p, drawer).map((a) => a.id)).toEqual([effect.id]);
    expect(drawerTargets(p)[0].detail).toBe('at the end');
    addToDrawer(p, { type: 'shape' }, hera.id, 0);
    expect(effectsOf(p, drawer).map((a) => a.id)[1]).toBe(effect.id);
    addToDrawer(p, { def: def('echo') }, 'output');
    expect(effectsOf(p, outputDrawer(p)!)).toHaveLength(1);
    // an instrument with a drawer stays an instrument; drawers and effects never are
    expect(instrumentsOf(p).map((a) => a.id)).toEqual([hera.id]);
  });

  it('⇧⏎ goes to the selected instrument, the owner of a selected effect, the focused or armed one, else the only one', () => {
    const { p, hera } = withHera();
    const other = insertAssembly(p, DEFS, def('Monolith D'), 400, 40);
    const effect = addToDrawer(p, { type: 'reverb' }, other.id);
    expect(currentInstrument(p)).toBeUndefined();
    expect(currentInstrument(p, { assemblies: [hera.id] })?.id).toBe(hera.id);
    expect(currentInstrument(p, { assemblies: [effect.id] })?.id).toBe(other.id);
    expect(currentInstrument(p, { focus: `a${other.id}` })?.id).toBe(other.id);
    expect(currentInstrument(p, { armed: [`a${hera.id}`] })?.id).toBe(hera.id);
    const solo = withHera();
    expect(currentInstrument(solo.p)?.id).toBe(solo.hera.id);
  });
});

describe('effect presets', () => {
  it('lists the user’s presets of an effect and adds one set to its values', () => {
    const delay = byType('delay');
    const p = newPatch(DEFS);
    const a = insertAssembly(p, DEFS, catalogEffectDef(delay), 0, 0);
    expect(entryStructures(delay)[0]).toBe(defStructure(catalogEffectDef(delay)));
    const row = a.params[0];
    p.modules.find((x) => x.id === row.module)!.params[row.param] = 333;
    const preset = capturePreset(p, a, 'Slapback');
    expect(preset.values).toContain(333);
    const listed = effectPresets([preset]);
    expect(listed).toEqual([{ preset, entry: delay, wrapped: true }]);
    const { def: made } = presetSource(listed[0]);
    const q = newPatch(DEFS);
    const b = insertAssembly(q, DEFS, made, 0, 0);
    expect(capturePreset(q, b, 'again').values).toEqual(preset.values);
    expect(b.chain).toBeTruthy();
  });
});
