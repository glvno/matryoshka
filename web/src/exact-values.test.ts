// SPDX-License-Identifier: GPL-3.0-only
// @vitest-environment jsdom
// #538: a value typed into a card's bar is kept as typed (fractions too), the field opens with the full value, and the
// bar's controls move it by steps from where it is (a tenth of one with Shift) without putting it back on the grid.
import { describe, expect, it, vi } from 'vitest';
import { Editor, type EditorEvents } from './editor';
import { DEFS } from './modules';
import { addModule, newPatch, type ModuleInst } from './patch';

vi.hoisted(() => {
  // the page's clock as it is just after the page opens (#577): the double-click's "put back what the gesture moved"
  // must not take a time near 0 for a recent slider input. A steady clock also keeps the cases off the worker's load.
  let now = 0;
  performance.now = () => (now += 1);
  const g = globalThis as unknown as Record<string, unknown>;
  g.ResizeObserver ??= class { observe(): void {} unobserve(): void {} disconnect(): void {} };
  if (!(document as unknown as { fonts?: unknown }).fonts) Object.defineProperty(document, 'fonts', { value: { addEventListener() {}, ready: Promise.resolve() } });
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.checkVisibility ??= () => true;
  proto.scrollTo ??= () => {};
});

/** an editor on a patch with one Scale (gain and offset: -4..4 in steps of 0.01), and the values the editor sends */
function rig(): { editor: Editor; scale: () => ModuleInst; sent: number[]; bar: (param: string) => HTMLElement } {
  document.body.innerHTML = '<div id="canvas"><div id="canvas-space"><div id="patch-world"><svg id="cables"></svg><div id="modules"></div><svg id="cable-glow"></svg><svg id="patch-preview"></svg></div></div></div>';
  const p = newPatch(DEFS);
  const id = addModule(p, DEFS.scale, 300, 20).id;
  const sent: number[] = [];
  const ev: EditorEvents = {
    onStructure() {}, onParam(_id, _name, v) { sent.push(v); }, onAtt() {}, onBypass() {}, onRange() {}, onTrack() {}, onTransport() {}, onLayout() {}, onError() {}, onSaveAssembly() {},
  };
  const editor = new Editor(document.getElementById('canvas')!, p, ev);
  const scale = (): ModuleInst => editor.patch.modules.find((m) => m.id === id)!;
  const bar = (param: string): HTMLElement => document.querySelector<HTMLElement>(`.param.bar[data-mod="${id}"][data-param="${param}"]`)!;
  return { editor, scale, sent, bar };
}

/** double-click a bar and type `text`, then Enter; the field's text when it opened */
function type(bar: HTMLElement, text: string): string {
  bar.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  const field = bar.querySelector<HTMLInputElement>('.val-edit')!;
  const opened = field.value;
  field.value = text;
  field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  return opened;
}

const slider = (bar: HTMLElement): HTMLInputElement => bar.querySelector<HTMLInputElement>('input[type=range]')!;

/** move the bar's slider to `to` as a drag does (slider-jack.ts sets the value, then sends input); `fine`: Shift held */
function drag(bar: HTMLElement, to: number, fine = false): void {
  const input = slider(bar);
  if (fine) input.dataset.fine = '1';
  input.value = String(to);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  delete input.dataset.fine;
}

const key = (bar: HTMLElement, k: string, shiftKey = false): void => {
  slider(bar).dispatchEvent(new KeyboardEvent('keydown', { key: k, shiftKey, bubbles: true, cancelable: true }));
};

describe('typed values (#538)', () => {
  it('keeps a typed value off the step grid, and a fraction', () => {
    const { scale, bar, sent } = rig();
    type(bar('gain'), '0.125');
    expect(scale().params.gain).toBe(0.125);
    expect(sent.at(-1)).toBe(0.125);
    type(bar('offset'), '-1/3');
    expect(scale().params.offset).toBeCloseTo(-1 / 3, 11);
  });

  it('shows three significant figures, and the field opens with the full value', () => {
    const { bar } = rig();
    type(bar('gain'), '1/3');
    expect(bar('gain').querySelector('output')!.textContent).toBe('+0.333');
    const opened = type(bar('gain'), '');   // (an empty entry is refused: the field stays)
    expect(opened).toBe('+0.3333333333');
  });

  it('Enter on the field as it opened leaves the value whole', () => {
    const { scale, bar, sent } = rig();
    type(bar('gain'), '1/3');
    const n = sent.length, was = scale().params.gain;
    bar('gain').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    const field = bar('gain').querySelector<HTMLInputElement>('.val-edit')!;
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(scale().params.gain).toBe(was);
    expect(sent.length).toBe(n);
  });

  it('refuses what it cannot read: the field stays, marked', () => {
    const { scale, bar } = rig();
    const before = scale().params.gain;
    type(bar('gain'), '1/0');
    expect(scale().params.gain).toBe(before);
    expect(bar('gain').querySelector('.val-edit.bad')).not.toBeNull();
  });
});

describe('the bar\'s controls move an exact value by steps (#538)', () => {
  it('a drag moves by steps from the exact value, not back onto the grid', () => {
    const { scale, bar } = rig();
    type(bar('gain'), '1/8');
    drag(bar('gain'), 0.2);
    expect(scale().params.gain).toBe(0.205);
    drag(bar('gain'), 0.5);
    expect(scale().params.gain).toBe(0.505);
  });

  it('a Shift-drag moves a tenth of a step', () => {
    const { scale, bar } = rig();
    type(bar('gain'), '1/8');
    drag(bar('gain'), 0.1283, true);
    expect(scale().params.gain).toBe(0.128);
  });

  it('a drag to the end reaches it', () => {
    const { scale, bar } = rig();
    type(bar('gain'), '1/8');
    drag(bar('gain'), 4);
    expect(scale().params.gain).toBe(4);
  });

  it('arrow keys move a step from the exact value, Shift-arrow a tenth of one', () => {
    const { scale, bar } = rig();
    type(bar('gain'), '1/8');
    key(bar('gain'), 'ArrowRight');
    expect(scale().params.gain).toBe(0.135);
    key(bar('gain'), 'ArrowLeft', true);
    expect(scale().params.gain).toBe(0.134);
    key(bar('gain'), 'ArrowUp', true);
    key(bar('gain'), 'ArrowUp', true);
    expect(scale().params.gain).toBe(0.136);
    key(bar('gain'), 'End');
    expect(scale().params.gain).toBe(4);
  });

  it('the slider has no grid of its own on such a row, so the browser cannot snap the value', () => {
    const { bar } = rig();
    expect(slider(bar('gain')).step).toBe('any');
    type(bar('gain'), '1/8');
    expect(Number(slider(bar('gain')).value)).toBe(0.125);
  });
});
