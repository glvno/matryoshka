// SPDX-License-Identifier: GPL-3.0-only
// @vitest-environment jsdom
// The pattern commands (#1177, #1178) run on the FM-1's SEQ page (the firmware UI as WebAssembly): the editor runs each on
// its patch too, as one undo step, and ends where the FM-1 does. The bytes both write are compared in
// firmware/test/patlink_test.c (scripts/pattern-vectors.ts). The demo set (#1179) from the Steps card and from PATTERN_OP.
import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { buildFm1Wasm } from '../scripts/fm1-wasm.mjs';
import { DEMO_SET_OUTDATED, Editor, type EditorEvents } from './editor';
import { BUTTONS, Fm1Ui } from './fm1-ui';
import { demoSetFor, factoryWithDemoSet, FM1_PRESETS } from './presets';
import { encodePatch } from './patchbin';
import { patternsEmpty } from './pattern-ops';
import { parsePatternOp, PATTERN_OP } from './protocol';
import type { Patch } from './patch';
import './factory-presets';

vi.hoisted(() => {
  globalThis.ResizeObserver ??= class { observe(): void {} unobserve(): void {} disconnect(): void {} };
  Object.defineProperty(document, 'fonts', { value: { addEventListener() {}, ready: Promise.resolve() } });
  HTMLElement.prototype.checkVisibility ??= () => true;
  HTMLElement.prototype.scrollTo ??= () => {};
});

it('PATTERN_OP from the FM-1: the copy and clear all in the editor, each one undo step', async () => {
  const bytes = new Uint8Array(readFileSync(buildFm1Wasm()));
  document.body.innerHTML = '<div id="canvas"><div id="canvas-space"><div id="patch-world"><svg id="cables"></svg><div id="modules"></div><svg id="cable-glow"></svg><svg id="patch-preview"></svg></div></div></div>';
  const ev: EditorEvents = { onStructure() {}, onParam() {}, onAtt() {}, onBypass() {}, onRange() {}, onTrack() {}, onTransport() {}, onLayout() {}, onError() {}, onSaveAssembly() {} };
  const patch = FM1_PRESETS['Meridian 8']();
  const editor = new Editor(document.getElementById('canvas')!, structuredClone(patch), ev);
  const ui = await Fm1Ui.create(bytes, { patternOp: (op, from, to) => { editor.patternOpFromDevice(op, from, to); editor.endGesture(); } });
  expect(ui.load(encodePatch(patch), 'MERIDIAN 8')).toBe(0);
  let t = 1000;
  const tap = (id: number): void => { ui.tick(t += 50); ui.button(id, true); ui.tick(t += 50); ui.button(id, false); ui.tick(t += 50); };
  const track = () => editor.patch.modules.find((m) => m.type === 'steps')!;
  const p1 = structuredClone(track().notes);
  tap(BUTTONS.seq);
  ui.button(BUTTONS.seq, true);
  tap(BUTTONS.save);
  expect(track().patterns?.[0]?.notes).toEqual(p1);
  expect(editor.pattern).toBe(1);
  tap(BUTTONS.home);
  tap(BUTTONS.home);
  ui.button(BUTTONS.seq, false);
  expect(track().notes).toBeUndefined();
  expect(track().patterns).toBeUndefined();
  expect(editor.pattern).toBe(0);
  editor.undo();
  expect(track().patterns?.[0]?.notes).toEqual(p1);
  expect(track().notes).toEqual(p1);
  editor.undo();
  expect(track().patterns).toBeUndefined();
  expect(track().notes).toEqual(p1);
  expect(parsePatternOp([1, 0, 1, 0, 0, 0, 0])).toEqual({ op: 1, from: 0, to: 1, hash: 0 });
  expect(parsePatternOp([2, 0, 0])).toBeNull();
}, 150_000);

/** an editor on `patch`, with the status line's messages */
function editorOn(patch: Patch): { editor: Editor; said: string[] } {
  document.body.innerHTML = '<div id="canvas"><div id="canvas-space"><div id="patch-world"><svg id="cables"></svg><div id="modules"></div><svg id="cable-glow"></svg><svg id="patch-preview"></svg></div></div></div>';
  const said: string[] = [];
  const ev: EditorEvents = { onStructure() {}, onParam() {}, onAtt() {}, onBypass() {}, onRange() {}, onTrack() {}, onTransport() {}, onLayout() {}, onError: (m) => said.push(m), onSaveAssembly() {} };
  return { editor: new Editor(document.getElementById('canvas')!, patch, ev), said };
}
const sequence = (p: Patch) => ({ tracks: p.modules.filter((m) => m.type === 'steps').map(({ notes, patterns, locks, factoryPatterns }) => ({ notes, patterns, locks, factoryPatterns })), seq: p.modules.find((m) => m.type === 'fm1')?.seq });
const demoButtons = (): HTMLButtonElement[] => [...document.querySelectorAll<HTMLButtonElement>('.pattern-strip .pat-act')].filter((b) => b.textContent === 'demo set');

it('the Steps card’s demo set: only on a patch with one, asks only when it would replace something, one undo step', () => {
  expect(editorOn(FM1_PRESETS['Meridian 8']()).editor.patch.name).toBe('Meridian 8');
  expect(demoButtons().every((b) => b.hidden)).toBe(true);
  const { editor } = editorOn(FM1_PRESETS['808 Kit']());
  const buttons = demoButtons();
  expect(buttons.length).toBeGreaterThan(0);
  expect(buttons.every((b) => !b.hidden)).toBe(true);
  const shipped = sequence(editor.patch);
  const was = window.confirm;
  let asked = 0, answer = false;
  window.confirm = () => (asked++, answer);
  try {
    buttons[0].click();               // (the kit as it ships: nothing to replace, no question)
    editor.endGesture();
    expect(asked).toBe(0);
    expect(sequence(editor.patch)).toEqual(sequence(factoryWithDemoSet('808 Kit')));
    expect(editor.pattern).toBe(0);
    const loaded = sequence(editor.patch);
    editor.patch.modules.find((m) => m.type === 'steps')!.notes = [{ at: 0, len: 1, note: 60, vel: 100 }];
    const edited = sequence(editor.patch);
    demoButtons()[0].click();         // (patterns there: asked, and No keeps them)
    expect(asked).toBe(1);
    expect(sequence(editor.patch)).toEqual(edited);
    answer = true;
    demoButtons()[0].click();
    editor.endGesture();
    expect(asked).toBe(2);
    expect(sequence(editor.patch)).toEqual(loaded);
    editor.undo();
    expect(sequence(editor.patch)).toEqual(edited);
    editor.undo();
    expect(sequence(editor.patch)).toEqual(shipped);
    expect(patternsEmpty(editor.patch)).toBe(true);
  } finally { window.confirm = was; }
});

it('PATTERN_OP op 3 (the FM-1 loaded the demo set): the right hash loads it once as one undo step; another one only says so', () => {
  const { editor, said } = editorOn(FM1_PRESETS['909 Kit']());
  const set = demoSetFor(editor.patch)!;
  const shipped = sequence(editor.patch);
  editor.patternOpFromDevice(PATTERN_OP.demoSet, 0, 0, (set.hash + 1) >>> 0);
  editor.endGesture();
  expect(said).toEqual([DEMO_SET_OUTDATED]);
  expect(sequence(editor.patch)).toEqual(shipped);
  editor.patternOpFromDevice(PATTERN_OP.demoSet, 0, 0, set.hash);
  editor.endGesture();
  expect(sequence(editor.patch)).toEqual(sequence(factoryWithDemoSet('909 Kit')));
  expect(said).toEqual([DEMO_SET_OUTDATED]);
  editor.undo();
  expect(sequence(editor.patch)).toEqual(shipped);
  editor.undo();                      // (the wrong hash made no undo step)
  expect(said.at(-1)).toBe('nothing to undo');
  const other = editorOn(FM1_PRESETS['Meridian 8']());
  const before = sequence(other.editor.patch);
  other.editor.patternOpFromDevice(PATTERN_OP.demoSet, 0, 0, set.hash);
  expect(other.said).toEqual([DEMO_SET_OUTDATED]);
  expect(sequence(other.editor.patch)).toEqual(before);
  expect(parsePatternOp([3, 0, 0, set.hash & 0xff, (set.hash >>> 8) & 0xff, (set.hash >>> 16) & 0xff, set.hash >>> 24])).toEqual({ op: 3, from: 0, to: 0, hash: set.hash });
});
