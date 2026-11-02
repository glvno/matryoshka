// SPDX-License-Identifier: GPL-3.0-only
// @vitest-environment jsdom
// #518: a module's own name on its card (the type small underneath), set by a double-click on its title.
import { describe, expect, it, vi } from 'vitest';
import { Editor, type EditorEvents } from './editor';
import { DEFS } from './modules';
import { addModule, emptyPatch } from './patch';

vi.hoisted(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  g.ResizeObserver ??= class { observe(): void {} unobserve(): void {} disconnect(): void {} };
  if (!(document as unknown as { fonts?: unknown }).fonts) Object.defineProperty(document, 'fonts', { value: { addEventListener() {}, ready: Promise.resolve() } });
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.checkVisibility ??= () => true;
  proto.scrollTo ??= () => {};
});

function editorWith(): { editor: Editor; id: number; structures: () => number } {
  document.body.innerHTML = '<div id="canvas"><div id="canvas-space"><div id="patch-world"><svg id="cables"></svg><div id="modules"></div><svg id="cable-glow"></svg><svg id="patch-preview"></svg></div></div></div>';
  let n = 0;
  const ev: EditorEvents = {
    onStructure() { n++; }, onParam() {}, onAtt() {}, onBypass() {}, onRange() {}, onTrack() {}, onTransport() {}, onLayout() {}, onError() {}, onSaveAssembly() {},
  };
  const p = emptyPatch();
  const o = addModule(p, DEFS.osc, 200, 0);
  return { editor: new Editor(document.getElementById('canvas')!, p, ev), id: o.id, structures: () => n };
}
const head = (id: number): HTMLElement => document.querySelector<HTMLElement>(`.module[data-id="${id}"] .mhead > span:not(.tools)`)!;

describe('module names (#518)', () => {
  it('a double-click on the title names the module; the card shows the name over its type; an undo takes it back', () => {
    const { editor, id, structures } = editorWith();
    expect(head(id).textContent).toContain('Oscillator');
    const prompt = vi.spyOn(window, 'prompt').mockReturnValue('  saw   carrier ');
    const before = structures();
    head(id).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(prompt).toHaveBeenCalled();
    expect(editor.patch.modules.find((m) => m.id === id)!.name).toBe('saw carrier');
    expect(structures()).toBe(before + 1);   // (the name goes to the FM-1: a structure change)
    expect(head(id).querySelector('.mname')!.firstChild!.textContent).toBe('saw carrier');
    expect(head(id).querySelector('.mtype')!.textContent).toBe('Oscillator');
    editor.undo();
    expect(editor.patch.modules.find((m) => m.id === id)!.name).toBeUndefined();
    prompt.mockReturnValue('');
    editor.redo();
    head(id).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(editor.patch.modules.find((m) => m.id === id)!.name).toBeUndefined();   // (empty: the name goes)
    prompt.mockRestore();
  });
});
