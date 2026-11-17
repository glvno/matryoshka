// SPDX-License-Identifier: GPL-3.0-only
// @vitest-environment jsdom
// A card row is renamed from its ⋮ menu, never by a press on its name: the name is part of the slider (#1025).
import { describe, expect, it, vi } from 'vitest';
import { makeAssembly, promote } from './assembly';
import { Editor, type EditorEvents } from './editor';
import { DEFS } from './modules';
import { addModule, newPatch, type Patch } from './patch';

vi.hoisted(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  g.ResizeObserver ??= class { observe(): void {} unobserve(): void {} disconnect(): void {} };
  if (!document.fonts) Object.defineProperty(document, 'fonts', { value: { addEventListener() {}, ready: Promise.resolve() } });
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.checkVisibility ??= () => true;
  proto.scrollTo ??= () => {};
  proto.showPopover ??= () => {};
  proto.hidePopover ??= () => {};
});

function cardPatch(): Patch {
  const p = newPatch(DEFS, 'Rename');
  const f = addModule(p, DEFS.filter, 20, 20);
  promote(makeAssembly(p, [f.id], 'Synth'), f.id, 'res', p);
  return p;
}

function editorOn(p: Patch): Editor {
  document.body.innerHTML = '<div id="canvas"><div id="canvas-space"><div id="patch-world"><svg id="cables"></svg><div id="modules"></div><svg id="cable-glow"></svg><svg id="patch-preview"></svg></div></div></div>';
  const ev: EditorEvents = {
    onStructure() {}, onParam() {}, onAtt() {}, onBypass() {}, onRange() {}, onTrack() {}, onTransport() {},
    onLayout() {}, onError() {}, onSaveAssembly() {},
  };
  return new Editor(document.getElementById('canvas')!, p, ev);
}

describe('renaming a card row (#1025)', () => {
  it('a press on the name renames nothing; Rename… in the ⋮ menu renames the row', () => {
    const p = cardPatch();
    editorOn(p);
    const row = [...document.querySelectorAll<HTMLElement>('.module.assembly .param.bar')].find((r) => r.dataset.param === 'res')!;
    const name = row.firstElementChild as HTMLElement;
    const prompt = vi.spyOn(window, 'prompt').mockReturnValue('bite');
    name.click();
    expect(prompt).not.toHaveBeenCalled();
    expect(name.classList.contains('rename')).toBe(false);
    const rename = [...row.querySelectorAll<HTMLButtonElement>('.parameter-routing .routing-controls button')].find((b) => b.textContent === 'Rename…')!;
    rename.click();
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(p.assemblies![0].params.find((r) => r.param === 'res')!.label).toBe('bite');
  });
});
