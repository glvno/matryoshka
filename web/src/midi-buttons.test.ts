// SPDX-License-Identifier: GPL-3.0-only
// @vitest-environment jsdom
// #1041: an FM-1 the window does not follow (the owner's second one, or any FM-1 in a newly opened window) sends its ARP
// press and release as MIDI CC 86. The engine took them as a held button and switched the Arpeggiator on, while the patch
// and the dock's ARP button still had it off. A patch button over MIDI now presses the editor's button.
import { describe, expect, it, vi } from 'vitest';
import { Editor, type EditorEvents } from './editor';
import { Engine } from './engine';
import { editorCc } from './input';
import { PANEL_BUTTONS } from './modules';
import type { Patch } from './patch';
import { PRESETS } from './presets';

vi.hoisted(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  g.ResizeObserver ??= class { observe(): void {} unobserve(): void {} disconnect(): void {} };
  if (!(document as unknown as { fonts?: unknown }).fonts) Object.defineProperty(document, 'fonts', { value: { addEventListener() {}, ready: Promise.resolve() } });
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.checkVisibility ??= () => true;
  proto.scrollTo ??= () => {};
});

/** the editor on Monolith D with its dock, and the browser engine fed what the editor sends it (main.ts onButton) */
function setup(): { editor: Editor; engine: Engine; arpBtn: () => HTMLElement } {
  document.body.innerHTML = '<div id="canvas"><div id="canvas-space"><div id="patch-world"><svg id="cables"></svg><div id="modules"></div><svg id="cable-glow"></svg><svg id="patch-preview"></svg></div></div></div><div id="dock"></div>';
  const engine = new Engine(44118);
  const ev: EditorEvents = {
    onStructure() {}, onParam() {}, onAtt() {}, onBypass() {}, onRange() {}, onTrack() {}, onTransport() {}, onLayout() {}, onError() {}, onSaveAssembly() {},
    onButton: (i, on) => engine.setButton(i, on),
  };
  const editor = new Editor(document.getElementById('canvas')!, PRESETS['Monolith D'](), ev, document.getElementById('dock'));
  editor.rebuild();
  engine.load(editor.patch);
  return { editor, engine, arpBtn: () => document.querySelector<HTMLElement>('.panel-btn[data-button="arp"]')! };
}

/** a second of C3 and G3 held */
function held(e: Engine): Float32Array {
  e.noteOn(48);
  e.noteOn(55);
  const l = new Float32Array(44118), r = new Float32Array(l.length);
  e.render(l, r);
  return l;
}

/** the engine plays as one that loaded the patch as it is now (the first sample that differs: none) */
function playsAsSaved(e: Engine, p: Patch): void {
  const fresh = new Engine(44118);
  fresh.load(JSON.parse(JSON.stringify(p)) as Patch);
  const want = held(fresh);
  expect(held(e).findIndex((v, i) => v !== want[i])).toBe(-1);
}

const arpOf = (p: Patch) => p.modules.find((m) => m.type === 'arp')!;
const ARP_CC = 80 + PANEL_BUTTONS.indexOf('arp');

describe('a patch button pressed over MIDI (#1041)', () => {
  it('ARP pressed and let go as CC 86 switches the Arpeggiator in the patch, on the dock and in the engine alike', () => {
    const { editor, engine, arpBtn } = setup();
    expect(arpOf(editor.patch).bypass).toBe(true);           // (ARP engaged: the arpeggiator off, the button dark)
    expect(arpBtn().getAttribute('aria-pressed')).toBe('false');
    expect(editorCc({ n: ARP_CC, v: 127 }, editor)).toBe(true);
    expect(editorCc({ n: ARP_CC, v: 0 }, editor)).toBe(true);
    expect(arpOf(editor.patch).bypass).toBeFalsy();          // one press: it plays, and the button lights
    expect(arpBtn().getAttribute('aria-pressed')).toBe('true');
    playsAsSaved(engine, editor.patch);
  });

  it('pressed again, it goes off everywhere; the engine never sees the CC itself', () => {
    const { editor, engine, arpBtn } = setup();
    for (let k = 0; k < 2; k++) {
      editorCc({ n: ARP_CC, v: 127 }, editor);
      editorCc({ n: ARP_CC, v: 0 }, editor);
    }
    expect(arpOf(editor.patch).bypass).toBe(true);
    expect(arpBtn().getAttribute('aria-pressed')).toBe('false');
    playsAsSaved(engine, editor.patch);
    expect(editorCc({ n: 1, v: 64 }, editor)).toBe(false);   // (the mod wheel goes on to the engines)
  });
});
