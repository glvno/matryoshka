// SPDX-License-Identifier: GPL-3.0-only
// @vitest-environment jsdom
// Presets from snapshots (#1031, D-993): a snapshot's values for an engine become a preset of the current patch's engine
// without a switch, its FX drawer's effects with them as Store preset keeps them; every snapshot marked keep at once; a
// snapshot whose engine is built differently is skipped and named; one undo step takes them out again.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FACTORY } from './assemblies';
import { insertAssembly, promote, type AssemblyInst } from './assembly';
import { addUserPreset, applyPreset, capturePreset, currentValues, presetsOf, setFactoryPresets, userPresets } from './device-presets';
import { buildSelectedFactoryBank } from './factory-bank';
import { drawerScope, setEffectEnabled } from './fx-preset';
import { drawerPresetInfo } from './fx-preset-format';
import { Editor, type EditorEvents } from './editor';
import { DEFS } from './modules';
import { newPatch, validatePatch, type Patch } from './patch';
import { presetEngines, snapshotPreset } from './snapshot-presets';
import { rowOrder, structureOf } from './structure';

vi.hoisted(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  g.ResizeObserver ??= class { observe(): void {} unobserve(): void {} disconnect(): void {} };
  if (!(document as unknown as { fonts?: unknown }).fonts) Object.defineProperty(document, 'fonts', { value: { addEventListener() {}, ready: Promise.resolve() } });
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.checkVisibility ??= () => true;
  proto.scrollTo ??= () => {};
});

const copy = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/** a patch on an editor: one Oracle V that has an Init preset, or `start` and its engine `engine`; `structures` counts the
 *  uploads */
function rig(start?: { patch: Patch; engine: number }): { editor: Editor; a: AssemblyInst; structures: () => number } {
  const p = start?.patch ?? newPatch(DEFS);
  const a = start ? p.assemblies!.find((x) => x.id === start.engine)! : insertAssembly(p, DEFS, FACTORY.find((d) => d.name === 'Oracle V')!, 0, 0);
  if (!start) setFactoryPresets([{ structure: structureOf(p, a), name: 'Init', values: currentValues(p, a), factory: true }]);
  document.body.innerHTML = '<div id="canvas"><div id="canvas-space"><div id="patch-world"><svg id="cables"></svg><div id="modules"></div><svg id="cable-glow"></svg><svg id="patch-preview"></svg></div></div></div>';
  let structures = 0;
  const ev: EditorEvents = {
    onStructure() { structures++; }, onParam() {}, onAtt() {}, onBypass() {}, onRange() {}, onTrack() {}, onTransport() {},
    onLayout() {}, onError() {}, onSaveAssembly() {},
  };
  const editor = new Editor(document.getElementById('canvas')!, copy(p), ev);
  return { editor, a: editor.patch.assemblies!.find((x) => x.id === a.id)!, structures: () => structures };
}

/** a version of the editor's patch with the engine's card rows moved by `by` (each within its range) */
function version(editor: Editor, a: AssemblyInst, by: number): Patch {
  const v = copy(editor.patch);
  for (const r of a.params) {
    const m = v.modules.find((x) => x.id === r.module)!;
    const pd = DEFS[m.type].params.find((d) => d.name === r.param);
    if (pd) m.params[r.param] = Math.min(pd.max, Math.max(pd.min, (m.params[r.param] ?? 0) + by * (pd.max - pd.min)));
  }
  return v;
}

/** the same version with one more card row on the engine: another structure */
function rebuilt(editor: Editor, a: AssemblyInst): Patch {
  const v = copy(editor.patch);
  const there = v.assemblies!.find((x) => x.id === a.id)!;
  const m = v.modules.find((x) => there.modules.includes(x.id) && Object.keys(x.params).some((k) => !there.params.some((r) => r.module === x.id && r.param === k)))!;
  promote(there, m.id, Object.keys(m.params).find((k) => !there.params.some((r) => r.module === m.id && r.param === k))!);
  return v;
}

const valuesOf = (p: Patch, id: number): number[] => currentValues(p, p.assemblies!.find((x) => x.id === id)!);

beforeEach(() => localStorage.clear());

describe('presets from snapshots (#1031)', () => {
  it('offers the top-level engines with presets', () => {
    const { editor, a } = rig();
    expect(presetEngines(editor.patch).map((x) => x.id)).toEqual([a.id]);
  });

  it('a snapshot’s values become a preset of the current patch’s engine, without a switch or a change to the patch', () => {
    const { editor, a, structures } = rig();
    const before = JSON.stringify(editor.patch);
    const b = editor.snaps.take(version(editor, a, 0.1));
    const loads = structures();
    const r = editor.storeSnapshotPresets(a.id, [{ letter: b.letter, name: 'Brighter' }], false);
    expect(r).toEqual({ stored: [{ letter: b.letter, name: 'Brighter' }], skipped: [] });
    const stored = presetsOf(editor.patch, a).find((x) => x.name === 'Brighter')!;
    expect(stored.values).toEqual(valuesOf(JSON.parse(b.patch) as Patch, a.id));
    expect(stored.values).not.toEqual(currentValues(editor.patch, a));
    expect(editor.snaps.shown).toBeNull();
    expect(JSON.stringify(editor.patch)).toBe(before);
    expect(structures()).toBe(loads);   // (nothing was sent again: the current patch did not change)
  });

  it('the snapshot on screen gives the values heard, changes made to it included', () => {
    const { editor, a } = rig();
    const b = editor.snaps.take(version(editor, a, 0.1));
    editor.showSnapshot(b.letter);
    const heard = version(editor, a, 0.05);
    const asm = editor.patch.assemblies!.find((x) => x.id === a.id)!;
    for (const r of asm.params) editor.setParam(r.module, r.param, heard.modules.find((m) => m.id === r.module)!.params[r.param]);
    editor.storeSnapshotPresets(a.id, [{ letter: b.letter, name: 'Heard' }], false);
    expect(userPresets().find((x) => x.name === 'Heard')!.values).toEqual(valuesOf(editor.patch, a.id));
    expect(valuesOf(editor.patch, a.id)).not.toEqual(valuesOf(JSON.parse(b.patch) as Patch, a.id));
  });

  it('stores every kept candidate, each under its name or letter, a taken name numbered', () => {
    const { editor, a } = rig();
    addUserPreset(structureOf(editor.patch, a), 'C', currentValues(editor.patch, a));   // (a user preset C already: candidate C becomes "C 2")
    const k1 = editor.snaps.take(version(editor, a, 0.1), 'Warm');
    editor.snaps.take(version(editor, a, 0.2));
    const k2 = editor.snaps.take(version(editor, a, 0.3));
    expect(k2.letter).toBe('D');   // (A is the current patch: candidates start at B)
    for (const s of [k1, k2]) editor.setKeep(s.letter, true);
    const keeps = editor.snaps.list.filter((s) => s.mark === 'keep');
    const r = editor.storeSnapshotPresets(a.id, keeps.map((s) => ({ letter: s.letter, name: s.name ?? s.letter })), true);
    expect(r.stored).toEqual([{ letter: 'B', name: 'Warm' }, { letter: 'D', name: 'D' }]);
    expect(r.skipped).toEqual([]);
    expect(userPresets().find((x) => x.name === 'Warm')!.values).toEqual(valuesOf(JSON.parse(k1.patch) as Patch, a.id));
    expect(userPresets().find((x) => x.name === 'D')!.values).toEqual(valuesOf(JSON.parse(k2.patch) as Patch, a.id));
    const named = editor.storeSnapshotPresets(a.id, [{ letter: 'C', name: 'C' }], true);
    expect(named.stored).toEqual([{ letter: 'C', name: 'C 2' }]);
  });

  it('a snapshot whose engine is built differently is skipped and named; the others are stored', () => {
    const { editor, a } = rig();
    const good = editor.snaps.take(version(editor, a, 0.1));
    const other = editor.snaps.take(rebuilt(editor, a));
    expect(snapshotPreset(editor.patch, a, JSON.parse(other.patch) as Patch, 'x')).toBeNull();
    const r = editor.storeSnapshotPresets(a.id, [good, other].map((s) => ({ letter: s.letter, name: s.letter })), true);
    expect(r.stored.map((x) => x.letter)).toEqual([good.letter]);
    expect(r.skipped).toEqual([other.letter]);
    expect(userPresets().map((x) => x.name)).toEqual([good.letter]);
    const none = editor.storeSnapshotPresets(a.id, [{ letter: other.letter, name: 'Other' }], false);
    expect(none).toEqual({ stored: [], skipped: [other.letter] });
    expect(userPresets().map((x) => x.name)).toEqual([good.letter]);
  });

  it('one undo step takes the stored presets out and puts back one it stored over; redo stores them again', () => {
    const { editor, a, structures } = rig();
    addUserPreset(structureOf(editor.patch, a), 'Mine', currentValues(editor.patch, a));
    const mine = userPresets()[0];
    const [s1, s2] = [editor.snaps.take(version(editor, a, 0.1)), editor.snaps.take(version(editor, a, 0.2))];
    editor.storeSnapshotPresets(a.id, [{ letter: s1.letter, name: 'Mine' }], false);   // (over the user preset Mine)
    editor.storeSnapshotPresets(a.id, [s1, s2].map((s) => ({ letter: s.letter, name: s.letter })), true);
    expect(userPresets().map((x) => x.name).sort()).toEqual(['B', 'C', 'Mine']);
    expect(userPresets().find((x) => x.name === 'Mine')!.values).not.toEqual(mine.values);
    const loads = structures();
    editor.undo();
    expect(userPresets().map((x) => x.name)).toEqual(['Mine']);
    editor.undo();
    expect(userPresets()).toEqual([mine]);
    expect(structures()).toBe(loads);   // (the patch stayed as it was: nothing was loaded again)
    editor.redo();
    editor.redo();
    expect(userPresets().map((x) => x.name).sort()).toEqual(['B', 'C', 'Mine']);
    expect(userPresets().find((x) => x.name === 'B')!.values).toEqual(valuesOf(JSON.parse(s1.patch) as Patch, a.id));
  });

  it('a snapshot’s FX drawer goes into the preset: applied to the current patch, it brings back the snapshot’s effects', () => {
    const patch = validatePatch(copy(buildSelectedFactoryBank().find((e) => e.name === 'Monolith D')!.patch), DEFS);
    const engine = patch.assemblies!.find((x) => drawerScope(patch, x))!.id;
    const { editor, a } = rig({ patch, engine });
    const snap = copy(editor.patch);
    const snapEngine = snap.assemblies!.find((x) => x.id === a.id)!;
    const effects = drawerScope(snap, snapEngine)!.effects;
    setEffectEnabled(snap, effects[0], false);   // (an effect off)
    const reverb = effects.find((e) => e.label === 'Reverb')!;
    const kernel = snap.modules.find((m) => reverb.modules.includes(m.id) && m.type === 'reverb')!;
    const pd = DEFS.reverb.params.find((d) => d.name === 'size')!;
    kernel.params.size = kernel.params.size === pd.max ? pd.min : pd.max;
    const fx = (p: Patch, x: AssemblyInst): number[] => capturePreset(p, x, 'x').values.slice(rowOrder(p, x).length);
    expect(fx(snap, snapEngine)).not.toEqual(fx(editor.patch, a));
    const s = editor.snaps.take(snap);
    expect(editor.storeSnapshotPresets(a.id, [{ letter: s.letter, name: 'Wet' }], false).stored).toHaveLength(1);
    const preset = userPresets().find((x) => x.name === 'Wet')!;
    expect(drawerPresetInfo(preset)).toBeTruthy();
    const applied = copy(editor.patch);
    const there = applied.assemblies!.find((x) => x.id === a.id)!;
    expect(applyPreset(applied, there, preset)).toBe(true);
    expect(fx(applied, there)).toEqual(fx(snap, snapEngine));
    expect(currentValues(applied, there)).toEqual(currentValues(snap, snapEngine));
  });

  it('a patch without an FX drawer stores card values only', () => {
    const { editor, a } = rig();
    expect(drawerScope(editor.patch, a)).toBeNull();
    const s = editor.snaps.take(version(editor, a, 0.1));
    editor.storeSnapshotPresets(a.id, [{ letter: s.letter, name: 'Dry' }], false);
    const preset = userPresets().find((x) => x.name === 'Dry')!;
    expect(drawerPresetInfo(preset)).toBeFalsy();
    expect(preset.structure).toBe(structureOf(editor.patch, a));
    expect(preset.values).toHaveLength(rowOrder(editor.patch, a).length);
  });
});
