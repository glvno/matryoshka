// SPDX-License-Identifier: GPL-3.0-only
// @vitest-environment jsdom
// Semantic zoom in the editor (D-1448, D-1449): below 40 % the canvas draws the sliders level (a class on the canvas, with
// ±8 % hysteresis); each title is 12 px on screen and shows the card's tag when the name does not fit; a zoom across the
// boundary keeps the card under the pointer under it (over empty canvas, the nearest card); the zoom goes down to 2 %.
// (The names and blocks levels draw on a canvas, which jsdom lacks: far-view.test.ts covers them.)
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Editor, type EditorEvents } from './editor';
import { zoomCamera } from './canvas-nav';
import { PRESETS } from './presets';

vi.hoisted(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  g.ResizeObserver ??= class { observe(): void {} unobserve(): void {} disconnect(): void {} };
  if (!(document as unknown as { fonts?: unknown }).fonts) Object.defineProperty(document, 'fonts', { value: { addEventListener() {}, ready: Promise.resolve() } });
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.checkVisibility ??= () => true;
  proto.scrollTo ??= () => {};
});

let frames: FrameRequestCallback[] = [];
beforeEach(() => {
  frames = [];
  vi.stubGlobal('requestAnimationFrame', (f: FrameRequestCallback) => frames.push(f));
});
const flush = (): void => { for (const f of frames.splice(0)) f(0); };

function open(): { editor: Editor; canvas: HTMLElement } {
  document.body.innerHTML = '<div id="canvas"><div id="canvas-space"><div id="patch-world"><svg id="cables"></svg><div id="modules"></div><svg id="cable-glow"></svg><svg id="patch-preview"></svg></div></div></div><div><svg class="dock-cables"></svg><div id="dock"></div></div>';
  const ev: EditorEvents = { onStructure() {}, onParam() {}, onAtt() {}, onBypass() {}, onRange() {}, onTrack() {}, onTransport() {}, onLayout() {}, onError() {}, onSaveAssembly() {} };
  const editor = new Editor(document.getElementById('canvas')!, PRESETS['Monolith D'](), ev, document.getElementById('dock'));
  editor.rebuild();
  flush();
  return { editor, canvas: document.getElementById('canvas')! };
}

const cards = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('#modules > .module')];
const titleOf = (card: HTMLElement): HTMLElement => card.querySelector<HTMLElement>(':scope > .mhead > .lod-title')!;

describe('the sliders level (D-1448)', () => {
  it('switches below 40 %, 8 % past the boundary each way', () => {
    const { editor, canvas } = open();
    expect(canvas.classList.contains('lod-sliders')).toBe(false);
    editor.setZoom(0.38);
    expect(canvas.classList.contains('lod-sliders')).toBe(false);
    editor.setZoom(0.37);
    expect(canvas.classList.contains('lod-sliders')).toBe(true);
    editor.setZoom(0.43);
    expect(canvas.classList.contains('lod-sliders')).toBe(true);
    editor.setZoom(0.44);
    expect(canvas.classList.contains('lod-sliders')).toBe(false);
  });

  it('a modulated zoom (the zoom slider\'s source) follows the same levels', () => {
    const { editor, canvas } = open();
    editor.setZoom(0.2, true);
    expect(canvas.classList.contains('lod-sliders')).toBe(true);
  });

  it('keeps each title 12 px on screen and shows the tag when the name does not fit on the card', () => {
    const { editor } = open();
    // (jsdom lays nothing out: every card 236 px wide)
    const width = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(236);
    editor.setZoom(0.3);
    const all = cards().filter((c) => titleOf(c));
    expect(all.length).toBeGreaterThan(2);
    for (const c of all) expect(Number(titleOf(c).style.getPropertyValue('--lod-k'))).toBeCloseTo(0.8 / 0.3, 3);
    // 56.8 px for the title at 30 %: a short name stays, a long one gives way to the tag (the test DOM estimates 8.5 px a letter)
    const fits = (c: HTMLElement): boolean => (titleOf(c).dataset.name ?? '').length * 8.5 * 0.8 <= 236 * 0.3 - 14;
    expect(all.some(fits) && all.some((c) => !fits(c))).toBe(true);
    for (const c of all) expect(c.classList.contains('lod-tag')).toBe(!fits(c));
    // closer in, more names fit
    editor.setZoom(0.36);
    const at36 = all.filter((c) => !c.classList.contains('lod-tag')).length;
    expect(at36).toBeGreaterThanOrEqual(all.filter(fits).length);
    width.mockRestore();
  });

  it('a rebuilt canvas at the sliders level gets its titles fitted', () => {
    const { editor } = open();
    editor.setZoom(0.3);
    editor.rebuild();
    flush();
    for (const c of cards()) if (titleOf(c)) expect(titleOf(c).style.getPropertyValue('--lod-k')).not.toBe('');
  });
});

describe('a zoom across a level keeps the card under the pointer (D-1449)', () => {
  it('moves the view so the same point of the card is back under the pointer', () => {
    const { editor } = open();
    editor.setZoom(0.5);
    const card = cards()[0];
    const at = { x: 150, y: 200 };
    // the card was at (100, 100, 200 × 400) before the zoom and is drawn at (110, 50, 240 × 440) after it
    let after = false;
    vi.spyOn(card, 'getBoundingClientRect').mockImplementation(() => (after
      ? { left: 110, top: 50, width: 240, height: 440, right: 350, bottom: 490, x: 110, y: 50, toJSON() {} }
      : { left: 100, top: 100, width: 200, height: 400, right: 300, bottom: 500, x: 100, y: 100, toJSON() {} }) as DOMRect);
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => card.querySelector('.mbody') ?? card });
    const ed = editor as unknown as { cam: { x: number; y: number }; setZoom: (z: number, live?: boolean) => void };
    const cam0 = { ...ed.cam };
    const setZoom = ed.setZoom.bind(editor);
    ed.setZoom = (z: number, live?: boolean): void => { setZoom(z, live); after = true; };
    editor.zoomAround(0.3, false, at);
    // where a plain zoom round the pointer puts the camera, then 20 px right and 40 px up on screen, at 30 %
    const plain = zoomCamera(cam0, at, 0.5, 0.3);
    expect(ed.cam.x).toBeCloseTo(plain.x + 20 / 0.3, 6);
    expect(ed.cam.y).toBeCloseTo(plain.y - 40 / 0.3, 6);
  });

  it('within a level the zoom only holds the point under the pointer, as before', () => {
    const { editor } = open();
    editor.setZoom(0.8);
    const lookup = vi.fn(() => null);
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: lookup });
    const ed = editor as unknown as { cam: { x: number; y: number } };
    const cam0 = { ...ed.cam };
    editor.zoomAround(0.6, false, { x: 150, y: 200 });
    expect(lookup).not.toHaveBeenCalled();
    const plain = zoomCamera(cam0, { x: 150, y: 200 }, 0.8, 0.6);
    expect(ed.cam.x).toBeCloseTo(plain.x, 6);
    expect(ed.cam.y).toBeCloseTo(plain.y, 6);
  });

  it('over empty canvas, the nearest card within a screen keeps its offset from the pointer', () => {
    const { editor, canvas } = open();
    // (a 1000 × 600 canvas: "within a screen" is within 1000 px)
    Object.defineProperty(canvas, 'clientWidth', { configurable: true, value: 1000 });
    Object.defineProperty(canvas, 'clientHeight', { configurable: true, value: 600 });
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => null });
    const card = cards()[0];
    const key = card.dataset.id ? `m${card.dataset.id}` : `a${card.dataset.asm}`;
    let left = 100;
    vi.spyOn(card, 'getBoundingClientRect').mockImplementation(() => ({ left, top: 100, width: 200, height: 400, right: left + 200, bottom: 500, x: left, y: 100, toJSON() {} }) as DOMRect);
    const anchorAt = (pt: { x: number; y: number }): unknown => (editor as unknown as { anchorAt: (pt: { x: number; y: number }) => unknown }).anchorAt(pt);
    // 50 px left of the card: a quarter of its width outside it, a quarter down (zoomAround then moves the view so that
    // point of the card is back under the pointer, as over the card itself)
    expect(anchorAt({ x: 50, y: 200 })).toEqual({ key, at: { fx: -0.25, fy: 0.25 } });
    // 2,000 px away the card is not near: the zoom holds the point under the pointer
    left = 2050;
    expect(anchorAt({ x: 50, y: 200 })).toBeNull();
  });
});

describe('the far levels (D-1448)', () => {
  it('zooms out to 2 % and no further', () => {
    const { editor } = open();
    editor.setZoom(0.01);
    expect(editor.zoom).toBe(0.02);
  });
});
