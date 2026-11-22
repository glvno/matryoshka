// SPDX-License-Identifier: GPL-3.0-only
// @vitest-environment jsdom
// A row a cable's macro range sets (#1202 K1, D-944): setBy finds the source, and the editor marks the row's slider and
// names the source in its tooltip.
import { describe, expect, it, vi } from 'vitest';
import { Editor, type EditorEvents } from './editor';
import { DEFS } from './modules';
import { defaultParams, setBy, type ModuleInst, type Patch } from './patch';

// (jsdom lacks these; selector.ts makes its ResizeObserver when it loads, so before the imports)
vi.hoisted(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  g.ResizeObserver ??= class { observe(): void {} unobserve(): void {} disconnect(): void {} };
  if (!(document as unknown as { fonts?: unknown }).fonts) Object.defineProperty(document, 'fonts', { value: { addEventListener() {}, ready: Promise.resolve() } });
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.checkVisibility ??= () => true;
  proto.scrollTo ??= () => {};
});

const mod = (id: number, type: string, x: number): ModuleInst =>
  ({ id, type, x, y: 40, params: defaultParams(DEFS[type]), ...(DEFS[type].paramInputs ? { att: [1, 1], map: { p1: [], p2: [] } } : {}) }) as ModuleInst;

/** an LFO named "wobble" into the filter's p1, which controls its cutoff; `ranged`: with a macro range on it */
function patch(ranged: boolean): Patch {
  const lfo = { ...mod(1, 'lfo', 40), name: 'wobble' };
  const filter = mod(2, 'filter', 260);
  filter.map = { p1: ['cutoff'], p2: [] };
  if (ranged) filter.range = { p1: { cutoff: [0.2, 0.8] } };
  return { version: 2, name: 't', modules: [lfo, filter, mod(3, 'output', 480)], cables: [{ from: { module: 1, port: 'out' }, to: { module: 2, port: 'p1' } }] } as Patch;
}

function editorOf(p: Patch): Editor {
  document.body.innerHTML = '<div id="canvas"><div id="canvas-space"><div id="patch-world"><svg id="cables"></svg><div id="modules"></div><svg id="cable-glow"></svg><svg id="patch-preview"></svg></div></div></div>';
  const ev: EditorEvents = {
    onStructure() {}, onParam() {}, onAtt() {}, onBypass() {}, onRange() {}, onTransport() {}, onLayout() {}, onError() {}, onSaveAssembly() {},
  };
  return new Editor(document.getElementById('canvas')!, p, ev);
}

const row = (param: string): HTMLElement => document.querySelector<HTMLElement>(`.param[data-mod="2"][data-param="${param}"]`)!;

describe('setBy', () => {
  it('names the module whose ranged pin sets a parameter, and nothing without the range, the cable or the matrix', () => {
    const p = patch(true);
    expect(setBy(p, p.modules[1], 'cutoff')?.id).toBe(1);
    expect(setBy(p, p.modules[1], 'res')).toBeUndefined();
    const plain = patch(false);
    expect(setBy(plain, plain.modules[1], 'cutoff')).toBeUndefined();   // (no range: the pin adds to the row)
    const loose = { ...p, cables: [] };
    expect(setBy(loose, p.modules[1], 'cutoff')).toBeUndefined();
    const unmapped = structuredClone(p);
    unmapped.modules[1].map = { p1: [], p2: [] };
    expect(setBy(unmapped, unmapped.modules[1], 'cutoff')).toBeUndefined();
  });
});

describe('a row a cable sets in the editor', () => {
  it('marks its slider and names the source in its tooltip', () => {
    editorOf(patch(true));
    expect(row('cutoff').classList.contains('set-by')).toBe(true);
    expect(row('cutoff').title).toMatch(/^Set by wobble:/);
    expect(row('res').classList.contains('set-by')).toBe(false);
  });

  it('leaves a row a pin only adds to unmarked', () => {
    editorOf(patch(false));
    expect(row('cutoff').classList.contains('set-by')).toBe(false);
    expect(row('cutoff').title).toBe('');
  });
});
