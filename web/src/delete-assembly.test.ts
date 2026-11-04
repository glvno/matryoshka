// SPDX-License-Identifier: GPL-3.0-only
// @vitest-environment jsdom
// "Delete with its modules" (#560): an assembly goes with everything inside it, nested assemblies two levels deep and
// their modules included, the cables to the rest of the patch go too, and the editor's Undo brings all of it back.
import { describe, expect, it, vi } from 'vitest';
import { addChild, allModules, assemblyById, deleteAssembly, makeAssembly, parentOf } from './assembly';
import { Editor, type EditorEvents } from './editor';
import { DEFS } from './modules';
import { addModule, connect, emptyPatch, type Patch } from './patch';

// (jsdom lacks these; selector.ts makes its ResizeObserver when it loads, so before the imports)
vi.hoisted(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  g.ResizeObserver ??= class { observe(): void {} unobserve(): void {} disconnect(): void {} };
  if (!(document as unknown as { fonts?: unknown }).fonts) Object.defineProperty(document, 'fonts', { value: { addEventListener() {}, ready: Promise.resolve() } });
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.checkVisibility ??= () => true;
  proto.scrollTo ??= () => {};
});

const copy = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/**
 * Main and Output outside; voice (osc) holds amp (vca), which holds envs (two envelopes): three levels.
 * Cables run from Main into every level and from the vca out to the Output.
 */
function nested(): { p: Patch; ids: Record<string, number>; voice: number; amp: number; envs: number } {
  const p = emptyPatch('nested');
  const kb = addModule(p, DEFS.fm1, 0, 0).id;
  const osc = addModule(p, DEFS.osc, 300, 0).id;
  const vca = addModule(p, DEFS.vca, 600, 0).id;
  const e1 = addModule(p, DEFS.adsr, 300, 300).id;
  const e2 = addModule(p, DEFS.adsr, 600, 300).id;
  const out = addModule(p, DEFS.output, 900, 0).id;
  const c = (a: number, ap: string, b: number, bp: string): void => {
    expect(connect(p, DEFS, { module: a, port: ap }, { module: b, port: bp })).toBe(true);
  };
  c(kb, 'pitch', osc, 'pitch');
  c(kb, 'gate', e1, 'gate');
  c(kb, 'gate', e2, 'gate');
  c(osc, 'out', vca, 'in');
  c(e1, 'env', vca, 'cv');
  c(e2, 'env', vca, 'p1');
  c(vca, 'out', out, 'l');
  const envs = makeAssembly(p, [e1, e2], 'envs');
  const amp = makeAssembly(p, [vca], 'amp');
  addChild(p, amp, envs.id);
  const voice = makeAssembly(p, [osc], 'voice');
  addChild(p, voice, amp.id);
  expect(parentOf(p, envs.id)?.id).toBe(amp.id);
  expect(parentOf(p, amp.id)?.id).toBe(voice.id);
  return { p, ids: { kb, osc, vca, e1, e2, out }, voice: voice.id, amp: amp.id, envs: envs.id };
}

describe('Delete with its modules (#560)', () => {
  it('removes the nested assemblies two levels down, all their modules and the cables to outside', () => {
    const { p, ids } = nested();
    const voice = p.assemblies!.find((a) => a.label === 'voice')!;
    expect(allModules(p, voice).sort()).toEqual([ids.osc, ids.vca, ids.e1, ids.e2].sort());
    deleteAssembly(p, voice.id);
    expect(p.assemblies).toBeUndefined();
    expect(p.modules.map((m) => m.id)).toEqual([ids.kb, ids.out]);
    expect(p.cables).toEqual([]);
  });

  it('deleting a middle level takes its child with it and leaves the parent consistent', () => {
    const { p, ids, voice, amp, envs } = nested();
    deleteAssembly(p, amp);
    expect(assemblyById(p, amp)).toBeUndefined();
    expect(assemblyById(p, envs)).toBeUndefined();
    const v = assemblyById(p, voice)!;
    expect(v.children).toBeUndefined();
    expect(v.modules).toEqual([ids.osc]);
    expect(p.modules.map((m) => m.id).sort()).toEqual([ids.kb, ids.osc, ids.out].sort());
    // only the Main -> osc cable is left, and the voice exposes nothing that is gone
    expect(p.cables).toEqual([{ from: { module: ids.kb, port: 'pitch' }, to: { module: ids.osc, port: 'pitch' } }]);
    const live = new Set(p.modules.map((m) => m.id));
    for (const r of [...v.inputs, ...v.outputs]) expect(live.has(r.module)).toBe(true);
  });

  it('is one undo step in the editor, and Undo restores every level, module and cable', () => {
    document.body.innerHTML = '<div id="canvas"><div id="canvas-space"><div id="patch-world"><svg id="cables"></svg><div id="modules"></div><svg id="cable-glow"></svg><svg id="patch-preview"></svg></div></div></div>';
    const { p, voice } = nested();
    const ev: EditorEvents = {
      onStructure() {}, onParam() {}, onAtt() {}, onBypass() {}, onRange() {}, onTrack() {}, onTransport() {},
      onLayout() {}, onError() {}, onSaveAssembly() {},
    };
    const editor = new Editor(document.getElementById('canvas')!, copy(p), ev);
    const before = copy(editor.patch);
    const a = assemblyById(editor.patch, voice)!;
    (editor as unknown as { assemblyMenu(a: unknown, at: { x: number; y: number }): void }).assemblyMenu(a, { x: 0, y: 0 });
    const item = [...document.querySelectorAll<HTMLButtonElement>('.ctx button')].find((b) => b.textContent === 'Delete with its modules')!;
    expect(item).toBeTruthy();
    item.click();
    expect(editor.patch.assemblies).toBeUndefined();
    expect(editor.patch.modules.map((m) => m.type).sort()).toEqual(['fm1', 'output']);
    expect(editor.patch.cables).toEqual([]);
    editor.undo();
    expect(editor.patch.modules).toEqual(before.modules);
    expect(editor.patch.cables).toEqual(before.cables);
    expect(editor.patch.assemblies).toEqual(before.assemblies);
  });
});
