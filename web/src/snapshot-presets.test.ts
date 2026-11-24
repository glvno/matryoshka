// SPDX-License-Identifier: GPL-3.0-only
// @vitest-environment jsdom
// Save preset on the candidate heard (D-1426, owner 2026-11-24, D9): one item per engine of the patch heard (presetEngines),
// an instrument with its FX drawer and never the Output drawer; the Store dialog stores the values heard, edits included,
// as one undo step of that candidate. No other candidate gives presets (D-993 is superseded).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FACTORY } from './assemblies';
import { assembliesOf, insertAssembly, parentOf, type AssemblyInst } from './assembly';
import { capturePreset, currentValues, setFactoryPresets, userPresets } from './device-presets';
import { buildSelectedFactoryBank } from './factory-bank';
import { drawerScope } from './fx-preset';
import { drawerPresetInfo } from './fx-preset-format';
import { Editor, type EditorEvents } from './editor';
import { DEFS } from './modules';
import { newPatch, validatePatch, type Patch } from './patch';
import { presetEngines } from './snapshot-presets';
import { rowOrder, structureOf } from './structure';

vi.hoisted(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  g.ResizeObserver ??= class { observe(): void {} unobserve(): void {} disconnect(): void {} };
  if (!(document as unknown as { fonts?: unknown }).fonts) Object.defineProperty(document, 'fonts', { value: { addEventListener() {}, ready: Promise.resolve() } });
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.checkVisibility ??= () => true;
  proto.scrollTo ??= () => {};
  const dialog = (globalThis as unknown as { HTMLDialogElement?: { prototype: Record<string, unknown> } }).HTMLDialogElement?.prototype;
  if (dialog) dialog.showModal ??= function (this: HTMLElement) { this.setAttribute('open', ''); };
});

const copy = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/** a patch on an editor: one Oracle V that has an Init preset, or `start` and its engine `engine` */
function rig(start?: { patch: Patch; engine: number }): { editor: Editor; a: AssemblyInst } {
  const p = start?.patch ?? newPatch(DEFS);
  const a = start ? p.assemblies!.find((x) => x.id === start.engine)! : insertAssembly(p, DEFS, FACTORY.find((d) => d.name === 'Oracle V')!, 0, 0);
  if (!start) setFactoryPresets([{ structure: structureOf(p, a), name: 'Init', values: currentValues(p, a), factory: true }]);
  document.body.innerHTML = '<div id="canvas"><div id="canvas-space"><div id="patch-world"><svg id="cables"></svg><div id="modules"></div><svg id="cable-glow"></svg><svg id="patch-preview"></svg></div></div></div>';
  const ev: EditorEvents = {
    onStructure() {}, onParam() {}, onAtt() {}, onBypass() {}, onRange() {}, onTrack() {}, onTransport() {},
    onLayout() {}, onError() {}, onSaveAssembly() {},
  };
  const editor = new Editor(document.getElementById('canvas')!, copy(p), ev);
  return { editor, a: editor.patch.assemblies!.find((x) => x.id === a.id)! };
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

const valuesOf = (p: Patch, id: number): number[] => currentValues(p, p.assemblies!.find((x) => x.id === id)!);

/** Save preset on engine `id` of the patch heard, the Store dialog answered with `name` */
function savePreset(editor: Editor, id: number, name: string): void {
  editor.savePreset(id);
  const dlg = document.querySelector<HTMLDialogElement>('dialog.preset-store')!;
  dlg.querySelector('input')!.value = name;
  dlg.returnValue = 'store';
  dlg.dispatchEvent(new Event('close'));
}

beforeEach(() => localStorage.clear());

describe('Save preset on the candidate heard (D-1426)', () => {
  it('offers one item per top-level engine with presets', () => {
    const { editor, a } = rig();
    expect(presetEngines(editor.patch).map((x) => x.id)).toEqual([a.id]);
  });

  it('never offers a drawer: the Output drawer belongs to the patch, an FX drawer goes with its instrument', () => {
    const patch = validatePatch(copy(buildSelectedFactoryBank().find((e) => e.name === 'Monolith D')!.patch), DEFS);
    const tops = assembliesOf(patch).filter((a) => !parentOf(patch, a.id));
    setFactoryPresets(tops.map((a) => ({ structure: structureOf(patch, a), name: 'Init', values: currentValues(patch, a), factory: true })));
    const engine = patch.assemblies!.find((x) => drawerScope(patch, x))!;
    expect(presetEngines(patch).map((x) => x.id)).toContain(engine.id);
    expect(presetEngines(patch).filter((x) => x.drawer)).toEqual([]);
  });

  it('stores the values of the candidate heard, its edits included, as one undo step of that candidate', () => {
    const { editor, a } = rig();
    const b = editor.snaps.take(version(editor, a, 0.1));
    editor.showSnapshot(b.letter);
    const heard = version(editor, a, 0.05);
    for (const r of editor.patch.assemblies!.find((x) => x.id === a.id)!.params) editor.setParam(r.module, r.param, heard.modules.find((m) => m.id === r.module)!.params[r.param]);
    savePreset(editor, a.id, 'Heard');
    expect(userPresets().find((x) => x.name === 'Heard')!.values).toEqual(valuesOf(editor.patch, a.id));
    expect(valuesOf(editor.patch, a.id)).not.toEqual(valuesOf(JSON.parse(b.original) as Patch, a.id));
    // (the store is a step of B: A's undo knows nothing of it)
    editor.showSnapshot('A');
    editor.undo();
    expect(userPresets().some((x) => x.name === 'Heard')).toBe(true);
  });

  it('an instrument goes with its FX drawer', () => {
    const patch = validatePatch(copy(buildSelectedFactoryBank().find((e) => e.name === 'Monolith D')!.patch), DEFS);
    const engine = patch.assemblies!.find((x) => drawerScope(patch, x))!.id;
    const { editor, a } = rig({ patch, engine });
    savePreset(editor, a.id, 'Wet');
    const preset = userPresets().find((x) => x.name === 'Wet')!;
    expect(drawerPresetInfo(preset)).toBeTruthy();
    expect(preset.values).toEqual(capturePreset(editor.patch, a, 'Wet').values);
  });

  it('a patch without an FX drawer stores card values only', () => {
    const { editor, a } = rig();
    expect(drawerScope(editor.patch, a)).toBeNull();
    savePreset(editor, a.id, 'Dry');
    const preset = userPresets().find((x) => x.name === 'Dry')!;
    expect(drawerPresetInfo(preset)).toBeFalsy();
    expect(preset.values).toHaveLength(rowOrder(editor.patch, a).length);
  });
});
