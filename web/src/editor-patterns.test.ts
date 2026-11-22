// SPDX-License-Identifier: GPL-3.0-only
// @vitest-environment jsdom
// The pattern commands (#1177, #1178) run on the FM-1's SEQ page (the firmware UI as WebAssembly): the editor runs each on
// its patch too, as one undo step, and ends where the FM-1 does. The bytes both write are compared in
// firmware/test/patlink_test.c (scripts/pattern-vectors.ts).
import { readFileSync } from 'node:fs';
import { beforeAll, expect, it, vi } from 'vitest';
import { buildFm1Wasm } from '../scripts/fm1-wasm.mjs';
import { Editor, type EditorEvents } from './editor';
import { BUTTONS, Fm1Ui } from './fm1-ui';
import { FM1_PRESETS } from './presets';
import { encodePatch } from './patchbin';
import { parsePatternOp } from './protocol';
import './factory-presets';

vi.hoisted(() => {
  globalThis.ResizeObserver ??= class { observe(): void {} unobserve(): void {} disconnect(): void {} };
  Object.defineProperty(document, 'fonts', { value: { addEventListener() {}, ready: Promise.resolve() } });
  HTMLElement.prototype.checkVisibility ??= () => true;
  HTMLElement.prototype.scrollTo ??= () => {};
});

let bytes: Uint8Array<ArrayBuffer>;
beforeAll(() => {
  bytes = new Uint8Array(readFileSync(buildFm1Wasm()));
}, 120_000);

it('PATTERN_OP from the FM-1: the copy and clear all in the editor, each one undo step', async () => {
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
}, 30_000);
