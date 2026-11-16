// SPDX-License-Identifier: GPL-3.0-only
// @vitest-environment jsdom
// Listening to one signal through the editor (#939): an audio output toggles between itself and the Output, a control
// output is refused with a reason, and the listening ends when its module goes or another patch opens. The Output card
// carries the loudness readout (#940).
import { describe, expect, it, vi } from 'vitest';
import { Editor, type EditorEvents } from './editor';
import type { ListenSource } from './listen';
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

/** Main -> osc -> Output */
function patch(): { p: Patch; osc: number; kb: number } {
  const p = emptyPatch('listen');
  const kb = addModule(p, DEFS.fm1, 0, 0);
  const osc = addModule(p, DEFS.osc, 0, 0);
  const out = addModule(p, DEFS.output, 0, 0);
  connect(p, DEFS, { module: kb.id, port: 'pitch' }, { module: osc.id, port: 'pitch' });
  connect(p, DEFS, { module: osc.id, port: 'out' }, { module: out.id, port: 'l' });
  return { p, osc: osc.id, kb: kb.id };
}

function rig(start: Patch): { editor: Editor; heard: (ListenSource[] | null)[]; errors: string[] } {
  document.body.innerHTML = '<div id="canvas"><div id="canvas-space"><div id="patch-world"><svg id="cables"></svg><div id="modules"></div><svg id="cable-glow"></svg><svg id="patch-preview"></svg></div></div></div>';
  const heard: (ListenSource[] | null)[] = [];
  const errors: string[] = [];
  const ev: EditorEvents = {
    onStructure() {}, onParam() {}, onAtt() {}, onBypass() {}, onRange() {}, onTrack() {}, onTransport() {}, onLayout() {}, onSaveAssembly() {},
    onError(msg) { errors.push(msg); },
    onListen(srcs) { heard.push(srcs); },
    outputReadout() {
      const el = document.createElement('div');
      el.className = 'loud-readout';
      return el;
    },
  };
  return { editor: new Editor(document.getElementById('canvas')!, start, ev), heard, errors };
}

describe('listening to one signal', () => {
  it('toggles between an audio output and the Output', () => {
    const { p, osc } = patch();
    const { editor, heard } = rig(p);
    expect(editor.toggleListen({ module: osc, port: 'out' })).toBe(true);
    expect(heard).toEqual([[{ id: osc, port: 'out' }]]);
    expect(editor.listenLabel).toMatch(/out$/);
    expect(editor.toggleListen({ module: osc, port: 'out' })).toBe(false);
    expect(heard.at(-1)).toBeNull();
    expect(editor.listenLabel).toBeNull();
    expect(editor.stopListening()).toBe(false);   // (nothing to stop: Esc goes on to nothing)
  });

  it('refuses a control output, saying why', () => {
    const { p, kb } = patch();
    const { editor, heard, errors } = rig(p);
    expect(editor.toggleListen({ module: kb, port: 'gate' })).toBe(false);
    expect(heard).toEqual([]);
    expect(errors.at(-1)).toMatch(/only audio can be heard on its own/);
  });

  it('goes back to the Output when its module goes or another patch opens', () => {
    const { p, osc } = patch();
    const { editor, heard } = rig(p);
    editor.toggleListen({ module: osc, port: 'out' });
    editor.selectAll();
    editor.removeSelected();
    expect(editor.patch.modules.some((m) => m.id === osc)).toBe(false);
    expect(heard.at(-1)).toBeNull();
    const next = patch();
    editor.setPatch(next.p);
    editor.toggleListen({ module: next.osc, port: 'out' });
    expect(editor.listenLabel).not.toBeNull();
    editor.setPatch(patch().p);
    expect(editor.listenLabel).toBeNull();
    expect(heard.at(-1)).toBeNull();
  });

  it('puts the loudness readout on the Output card', () => {
    const { p } = patch();
    rig(p);
    const cards = [...document.querySelectorAll('.module')].filter((c) => c.querySelector('.loud-readout'));
    expect(cards).toHaveLength(1);
    expect(cards[0].textContent).toMatch(/Output/i);
  });
});
