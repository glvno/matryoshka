// SPDX-License-Identifier: GPL-3.0-only
// @vitest-environment jsdom
// The computer keyboard's octave on a patch load (D-1456): every open starts it at the opened patch's own octave
// (Patch.octave: -1 for the drum kits, else 0), never the octave the last patch was left at. A switch between candidates of
// the open set is no open and keeps it. main.ts wires the editor's onLoad to noteKeys.set as below, and does the same on a
// palette switch, which lands on a candidate of the open set without onLoad.
import { describe, expect, it, vi } from 'vitest';
import { Editor, type EditorEvents } from './editor';
import { attachKeyboard } from './input';
import type { Patch } from './patch';
import { relocatedPatches } from './community-factory';
import { CandidateStore, memoryBackend } from './candidate-store';

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

/** an editor whose loads set the keys to the patch's own octave, as main.ts's onLoad does */
function rig(start: Patch) {
  document.body.innerHTML = '<div id="canvas"><div id="canvas-space"><div id="patch-world"><svg id="cables"></svg><div id="modules"></div><svg id="cable-glow"></svg><svg id="patch-preview"></svg></div></div></div>';
  const keys = attachKeyboard({ send() {} }, () => true);
  const store = new CandidateStore(memoryBackend(), (p) => p as Patch);
  const ev: EditorEvents = {
    onStructure() {}, onParam() {}, onAtt() {}, onBypass() {}, onRange() {}, onTrack() {}, onSilence() {},
    onPutAway(set) { store.save(set); },
    onLoad(p) { keys.set(p.octave ?? 0); },
    onTransport() {}, onLayout() {}, onError() {}, onSaveAssembly() {},
  };
  const editor = new Editor(document.getElementById('canvas')!, copy(start), ev);
  return { editor, keys, find: (p: Patch, except: string) => store.find(p, except) };
}

describe("the computer keyboard's octave on a load (D-1456)", () => {
  it("every open starts at the patch's own octave, not the last patch's; a candidate switch keeps it", () => {
    const kit: Patch = { ...relocatedPatches['Oracle V'](), name: 'A kit', octave: -1 };
    const { editor, keys, find } = rig(relocatedPatches['Oracle V']());
    editor.makeCandidates(2);   // B, C; on B
    keys.shift(2);
    editor.showSnapshot('C');   // (a candidate switch: no load)
    expect(keys.octave()).toBe(2);
    editor.setPatch(copy(kit));
    expect(keys.octave()).toBe(-1);
    keys.shift(3);
    expect(editor.patch.octave).toBe(-1);   // (moving the keys leaves the patch's octave alone)
    editor.setPatch(relocatedPatches['Oracle V']());
    expect(keys.octave()).toBe(0);   // (not the 2 the kit was left at)
    editor.makeCandidates(1);
    keys.shift(1);
    const a = copy(JSON.parse(editor.snaps.get('A')!.patch) as Patch);
    expect(editor.openPatch(a, find)).toEqual({ how: 'switched', letter: 'A' });   // (a candidate of the set, opened: a load)
    expect(keys.octave()).toBe(0);
    keys.shift(1);
    // a palette switch onto a candidate (follow) is no editor load: main.ts's loadNamed sets the octave itself
    expect(editor.openPatch(copy(JSON.parse(editor.snaps.get('B')!.patch) as Patch), find, true)).toEqual({ how: 'switched', letter: 'B' });
    expect(keys.octave()).toBe(1);
  });
});
