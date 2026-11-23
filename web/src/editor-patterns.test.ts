// SPDX-License-Identifier: GPL-3.0-only
// @vitest-environment jsdom
// The pattern commands (#1177, #1178) run on the FM-1's SEQ page (the firmware UI as WebAssembly): the editor runs each on
// its patch too, as one undo step, and ends where the FM-1 does. The bytes both write are compared in
// firmware/test/patlink_test.c (scripts/pattern-vectors.ts). PATTERN_OP's retired op 3 does nothing.
import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { buildFm1Wasm } from '../scripts/fm1-wasm.mjs';
import { Editor, type EditorEvents } from './editor';
import { BUTTONS, Fm1Ui } from './fm1-ui';
import { FM1_PRESETS } from './presets';
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

it('the double (D-838): SEQ held + OCT+ on the FM-1 and the Steps card’s ×2 leave the same patch, each one undo step', async () => {
  const bytes = new Uint8Array(readFileSync(buildFm1Wasm()));
  const patch = FM1_PRESETS['Meridian 8']();
  const shown = (p: Patch) => ({ ...sequence(p), len: p.modules.filter((m) => m.type === 'steps').map((m) => m.params.len) });
  const fm1 = editorOn(structuredClone(patch));
  const ops: number[][] = [];
  const ui = await Fm1Ui.create(bytes, { patternOp: (op, from, to) => { ops.push([op, from, to]); fm1.editor.patternOpFromDevice(op, from, to); fm1.editor.endGesture(); } });
  expect(ui.load(encodePatch(patch), 'MERIDIAN 8')).toBe(0);
  let t = 1000;
  const tap = (id: number): void => { ui.tick(t += 50); ui.button(id, true); ui.tick(t += 50); ui.button(id, false); ui.tick(t += 50); };
  tap(BUTTONS.seq);
  ui.button(BUTTONS.seq, true);
  tap(BUTTONS.octUp);
  ui.button(BUTTONS.seq, false);
  ui.tick(t += 50);
  expect(ops).toEqual([[PATTERN_OP.double, 0, 0]]);
  expect(ui.page).toBe(8);                      // (SEQ's release: the SEQ page stays)
  const fromFm1 = shown(fm1.editor.patch), fm1Bin = encodePatch(fm1.editor.patch);
  expect(fromFm1.len).toEqual([32]);
  expect(fm1.said).toEqual(['DOUBLED: 32 STEPS']);
  fm1.editor.undo();
  expect(shown(fm1.editor.patch)).toEqual(shown(patch));
  const card = editorOn(structuredClone(patch));
  const x2 = [...document.querySelectorAll<HTMLButtonElement>('.pattern-strip .pat-act')].find((b) => b.textContent === '×2')!;
  x2.click();
  card.editor.endGesture();
  expect(shown(card.editor.patch)).toEqual(fromFm1);
  expect(encodePatch(card.editor.patch)).toEqual(fm1Bin);
  card.editor.undo();
  expect(shown(card.editor.patch)).toEqual(shown(patch));
  expect(parsePatternOp([4, 3, 0, 0, 0, 0, 0])).toEqual({ op: 4, from: 3, to: 0, hash: 0 });
}, 150_000);

/** an editor on `patch`, with the status line's messages */
function editorOn(patch: Patch): { editor: Editor; said: string[] } {
  document.body.innerHTML = '<div id="canvas"><div id="canvas-space"><div id="patch-world"><svg id="cables"></svg><div id="modules"></div><svg id="cable-glow"></svg><svg id="patch-preview"></svg></div></div></div>';
  const said: string[] = [];
  const ev: EditorEvents = { onStructure() {}, onParam() {}, onAtt() {}, onBypass() {}, onRange() {}, onTrack() {}, onTransport() {}, onLayout() {}, onError: (m) => said.push(m), onSaveAssembly() {} };
  return { editor: new Editor(document.getElementById('canvas')!, patch, ev), said };
}
const sequence = (p: Patch) => ({ tracks: p.modules.filter((m) => m.type === 'steps').map(({ notes, patterns, locks, factoryPatterns }) => ({ notes, patterns, locks, factoryPatterns })), seq: p.modules.find((m) => m.type === 'fm1')?.seq });

it('PATTERN_OP op 3 (retired) changes nothing, says nothing and makes no undo step', () => {
  const { editor, said } = editorOn(FM1_PRESETS['909 Kit']());
  const shipped = sequence(editor.patch);
  editor.patternOpFromDevice(3, 0, 0);
  editor.endGesture();
  expect(sequence(editor.patch)).toEqual(shipped);
  expect(patternsEmpty(editor.patch)).toBe(true);
  editor.undo();
  expect(said).toEqual(['nothing to undo']);
  expect(parsePatternOp([3, 0, 0, 0, 0, 0, 0])).toEqual({ op: 3, from: 0, to: 0, hash: 0 });
  expect(Object.values(PATTERN_OP)).not.toContain(3);
});
