// SPDX-License-Identifier: GPL-3.0-only
// @vitest-environment jsdom
// Panning Perun 4 XL expanded ran at 7 fps: every scroll measured and redrew every cable. A cable between two cards is drawn
// in world coordinates and moves with the world; only the cables at the docked Main's jacks follow a scroll or a zoom.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Editor, type EditorEvents } from './editor';
import { DEFS } from './modules';
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

function open(): Editor {
  document.body.innerHTML = '<div id="canvas"><div id="canvas-space"><div id="patch-world"><svg id="cables"></svg><div id="modules"></div><svg id="cable-glow"></svg><svg id="patch-preview"></svg></div></div></div><div><svg class="dock-cables"></svg><div id="dock"></div></div>';
  const ev: EditorEvents = { onStructure() {}, onParam() {}, onAtt() {}, onBypass() {}, onRange() {}, onTrack() {}, onTransport() {}, onLayout() {}, onError() {}, onSaveAssembly() {} };
  const editor = new Editor(document.getElementById('canvas')!, PRESETS['Monolith D'](), ev, document.getElementById('dock'));
  editor.rebuild();
  flush();
  return editor;
}

/** every cable path on the canvas, and which of them have their path set from now on */
function watch(): { paths: SVGPathElement[]; touched: Map<SVGPathElement, number> } {
  const paths = [...document.querySelectorAll<SVGPathElement>('#cables path.cable')];
  const touched = new Map<SVGPathElement, number>();
  for (const p of paths) {
    const set = p.setAttribute.bind(p);
    p.setAttribute = (k: string, v: string): void => {
      if (k === 'd') touched.set(p, (touched.get(p) ?? 0) + 1);
      set(k, v);
    };
  }
  return { paths, touched };
}

/** a cable from the docked Main (its label names Main's jack) */
const docked = (p: SVGPathElement): boolean => (p.getAttribute('aria-label') ?? '').startsWith(`${DEFS.fm1.label} `);

describe('a scroll or zoom moves only the cables at docked jacks', () => {
  it('scrolling the canvas re-sets only the docked cables, once a frame however many scroll events come', () => {
    open();
    const { paths, touched } = watch();
    expect(paths.filter(docked).length).toBeGreaterThan(0);
    expect(paths.filter((p) => !docked(p)).length).toBeGreaterThan(0);
    const canvas = document.getElementById('canvas')!;
    for (let i = 0; i < 3; i++) canvas.dispatchEvent(new Event('scroll'));
    expect(touched.size).toBe(0);
    flush();
    expect(new Set(touched.keys())).toEqual(new Set(paths.filter(docked)));
    expect([...touched.values()].every((n) => n === 1)).toBe(true);
  });

  it('scrolling the dock does the same', () => {
    open();
    const { paths, touched } = watch();
    document.getElementById('dock')!.dispatchEvent(new Event('scroll'));
    flush();
    expect(new Set(touched.keys())).toEqual(new Set(paths.filter(docked)));
  });

  it('a zoom keeps every cable (no redraw) and re-sets only the docked ones', () => {
    const editor = open();
    const { paths, touched } = watch();
    editor.setZoom(0.5);
    expect(paths.every((p) => p.isConnected)).toBe(true);
    expect(new Set(touched.keys())).toEqual(new Set(paths.filter(docked)));
  });
});
