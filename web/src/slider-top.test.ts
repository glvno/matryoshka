// SPDX-License-Identifier: GPL-3.0-only
// @vitest-environment jsdom
// A slider row past 90 % of its range has its thumb where the value is drawn: the row is marked `top` (style.css moves the
// value left of the thumb); below that, and on choices and switches, the row is drawn as before.
import { describe, expect, it, vi } from 'vitest';
import { Editor, type EditorEvents } from './editor';
import { DEFS } from './modules';
import { addModule, newPatch } from './patch';

vi.hoisted(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  g.ResizeObserver ??= class { observe(): void {} unobserve(): void {} disconnect(): void {} };
  if (!(document as unknown as { fonts?: unknown }).fonts) Object.defineProperty(document, 'fonts', { value: { addEventListener() {}, ready: Promise.resolve() } });
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.checkVisibility ??= () => true;
  proto.scrollTo ??= () => {};
});

/** an editor on a patch with one Scale (gain: -4..4) and one Output; the bar of a row, read after a rebuild */
function rig(gain: number): (type: string, param: string) => HTMLElement {
  document.body.innerHTML = '<div id="canvas"><div id="canvas-space"><div id="patch-world"><svg id="cables"></svg><div id="modules"></div><svg id="cable-glow"></svg><svg id="patch-preview"></svg></div></div></div>';
  const p = newPatch(DEFS);
  addModule(p, DEFS.scale, 300, 20).params.gain = gain;
  const ev: EditorEvents = { onStructure() {}, onParam() {}, onAtt() {}, onBypass() {}, onRange() {}, onTrack() {}, onTransport() {}, onLayout() {}, onError() {}, onSaveAssembly() {} };
  const editor = new Editor(document.getElementById('canvas')!, p, ev);
  editor.rebuild();
  return (type, param) => {
    const id = editor.patch.modules.find((m) => m.type === type)!.id;
    return document.querySelector<HTMLElement>(`.param.bar[data-mod="${id}"][data-param="${param}"]`)!;
  };
}

describe('a slider row near its top keeps its value clear of the thumb', () => {
  it('marks a row past 90 % of its range, and only that row', () => {
    expect(rig(4)('scale', 'gain').classList.contains('top')).toBe(true);
    const high = rig(3.4)('scale', 'gain');   // (92.5 %: the value stands left of the thumb, which is that far along)
    expect(high.classList.contains('top')).toBe(true);
    expect(Number(high.style.getPropertyValue('--at-top'))).toBeCloseTo(0.925);
    expect(rig(3)('scale', 'gain').classList.contains('top')).toBe(false);     // (87.5 %: as before)
    const bar = rig(0);
    expect(bar('scale', 'gain').classList.contains('top')).toBe(false);
    expect(bar('scale', 'offset').classList.contains('top')).toBe(false);
  });
});
