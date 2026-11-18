// SPDX-License-Identifier: GPL-3.0-only
// @vitest-environment jsdom
// Quick patch (#1091) in the editor, driven through its field as the keyboard drives it: the reference sequence with
// defaults, following a port with several cables and the trail, a pasted chain, a blueprint kept and stamped, and every
// chain one undo step.
import { describe, expect, it, vi } from 'vitest';
import { FACTORY } from './assemblies';
import { addableModules } from './catalog';
import { Editor, type EditorEvents } from './editor';
import { moduleKeywords } from './labels';
import { DEFS } from './modules';
import { addModule, connect, newPatch, type Patch } from './patch';
import { BLUEPRINT_KEY, loadBlueprints, type Catalog } from './quick-patch';
import { QuickPatch } from './quick-patch-view';

// (jsdom lacks these; selector.ts makes its ResizeObserver when it loads, so before the imports)
vi.hoisted(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  g.ResizeObserver ??= class { observe(): void {} unobserve(): void {} disconnect(): void {} };
  if (!(document as unknown as { fonts?: unknown }).fonts) Object.defineProperty(document, 'fonts', { value: { addEventListener() {}, ready: Promise.resolve() } });
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.checkVisibility ??= () => true;
  proto.scrollTo ??= () => {};
  proto.scrollIntoView ??= () => {};
});

const catalog = (): Catalog => ({
  modules: addableModules(DEFS).map((m) => ({ type: m.type, name: m.name, keywords: moduleKeywords(m.type, m.def.label) })),
  assemblies: FACTORY.map((def) => ({ def, shelf: 'factory', keywords: def.blurb ?? '' })),
  blueprints: loadBlueprints(),
});

function setup(p: Patch = newPatch(DEFS)): { editor: Editor; quick: QuickPatch; said: string[] } {
  document.body.innerHTML = '<div id="canvas"><div id="canvas-space"><div id="patch-world"><svg id="cables"></svg><div id="modules"></div><svg id="cable-glow"></svg><svg id="patch-preview"></svg></div></div></div>';
  const ev: EditorEvents = {
    onStructure() {}, onParam() {}, onAtt() {}, onBypass() {}, onRange() {}, onTrack() {}, onTransport() {},
    onLayout() {}, onError() {}, onSaveAssembly() {},
  };
  const editor = new Editor(document.getElementById('canvas')!, p, ev);
  const said: string[] = [];
  const quick = new QuickPatch({ editor, say: (t) => said.push(t), catalog });
  return { editor, quick, said };
}

const field = (): HTMLInputElement => document.querySelector<HTMLInputElement>('.qp-field')!;
/** the keys of a sequence: a word is typed into the field, ⏎ ⇧⏎ [ ] Esc are keys */
function play(seq: string): void {
  for (const step of seq.split(/\s+/).filter(Boolean)) {
    const key = { '⏎': 'Enter', '⇧⏎': 'Enter', Esc: 'Escape', '[': '[', ']': ']' }[step];
    if (key && (step !== '[' && step !== ']' || !field().value)) {
      field().dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey: step === '⇧⏎', bubbles: true, cancelable: true }));
      continue;
    }
    field().value = step;
    field().dispatchEvent(new Event('input'));
  }
}
const cables = (p: Patch): string[] => p.cables.map((c) => {
  const t = (id: number): string => p.modules.find((m) => m.id === id)!.type;
  return `${t(c.from.module)}.${c.from.port}>${t(c.to.module)}.${c.to.port}`;
}).sort();
const history = (e: Editor): number => (e as unknown as { history: unknown[] }).history.length;

describe('Quick patch in the editor', () => {
  it('builds the reference sequence with defaults (lfo ⏎ ⏎ multi ⏎ cv ⏎ ⏎ vca ⏎ ⏎ ⏎ output ⏎ ⏎) as one undo step', () => {
    const { editor, quick } = setup();
    const steps = history(editor);
    quick.show();
    play('lfo ⏎ ⏎ multi ⏎ cv ⏎ ⏎ vca ⏎ ⏎ ⏎ output ⏎ ⏎');
    expect(cables(editor.patch)).toEqual(['filter.lp24>vca.in', 'lfo.out>filter.cv', 'vca.out>output.l']);
    // (jsdom lays nothing out, so where the cards go is checked by quick-patch.test.ts and the browser check)
    play('Esc');
    expect(quick.open).toBe(false);
    expect(history(editor)).toBe(steps + 1);
    expect(quick.lastChain).toBe('+lfo.out > +filter.cv > +vca.in > output.l');
    editor.undo();
    expect(editor.patch.modules.map((m) => m.type).sort()).toEqual(['fm1', 'output']);
    expect(editor.patch.cables).toEqual([]);
  });

  it('sets the parameter a cable reached by a typed value, inside the same step', () => {
    const { editor, quick } = setup();
    const steps = history(editor);
    quick.show();
    play('lfo ⏎ ⏎ multi ⏎ cv ⏎ 800hz ⏎');
    expect(editor.patch.modules.find((m) => m.type === 'filter')!.params.cutoff).toBe(800);
    play('Esc');
    expect(history(editor)).toBe(steps + 1);
  });

  it('a cable into an input that has one adds to it', () => {
    const { editor, quick } = setup();
    quick.show();
    play('osc ⏎ ⏎ output ⏎ ⏎ Esc');
    quick.show();
    play('+osc ⏎ ⏎ output ⏎ ⏎ Esc');
    expect(cables(editor.patch)).toEqual(['osc.out>output.l', 'osc.out>output.l']);
  });

  it('follows a port with several cables: the far ends to choose from, then back along the trail', () => {
    const p = newPatch(DEFS);
    const l = addModule(p, DEFS.lfo, 0, 600).id, f = addModule(p, DEFS.filter, 400, 600).id, v = addModule(p, DEFS.vca, 800, 600).id;
    connect(p, DEFS, { module: l, port: 'out' }, { module: f, port: 'cv' });
    connect(p, DEFS, { module: l, port: 'out' }, { module: v, port: 'cv' });
    const { quick } = setup(p);
    quick.show({ kind: 'module', id: l });
    play('⇧⏎');
    const ends = [...document.querySelectorAll('.qp-list li .qp-label')].map((e) => e.textContent);
    expect(ends).toEqual(['⤳ Multimode filter', '⤳ VCA']);
    play('⏎');
    const crumbs = (): string[] => [...document.querySelectorAll('.qp-crumb')].map((e) => e.textContent!);
    expect(crumbs()).toEqual(['LFO', 'Multimode filter']);
    expect(document.querySelector('.qp-crumb.on')!.textContent).toBe('Multimode filter');
    play('[');
    expect(document.querySelector('.qp-crumb.on')!.textContent).toBe('LFO');
    play(']');
    expect(document.querySelector('.qp-crumb.on')!.textContent).toBe('Multimode filter');
  });

  it('builds a pasted chain in one step and names what is wrong', () => {
    const { editor, quick } = setup();
    const steps = history(editor);
    quick.show();
    field().value = 'lfo.out > multimode.cv; multimode.lp > vca.in > output.in';
    field().dispatchEvent(new Event('input'));
    play('⏎');
    expect(cables(editor.patch)).toEqual(['filter.lp24>vca.in', 'lfo.out>filter.cv', 'vca.out>output.l']);
    expect(history(editor)).toBe(steps + 1);
    field().value = 'lfo.nope > vca';
    field().dispatchEvent(new Event('input'));
    play('⏎');
    expect(document.querySelector('.qp-hint')!.textContent).toBe('LFO has no output "nope". Its outputs: out, pulse');
    expect(history(editor)).toBe(steps + 1);
  });

  it('keeps the last chain as a blueprint and stamps it into another patch, one step', () => {
    localStorage.removeItem(BLUEPRINT_KEY);
    const { editor, quick } = setup();
    quick.show();
    play('lfo ⏎ ⏎ multi ⏎ cv ⏎ ⏎ vca ⏎ ⏎ ⏎ output ⏎ ⏎ Esc');
    quick.show();
    field().value = 'bp save lfo-filter-vca';
    field().dispatchEvent(new Event('input'));
    play('⏎ Esc');
    expect(loadBlueprints().map((b) => b.name)).toEqual(['lfo-filter-vca']);
    editor.setPatch(newPatch(DEFS));
    const steps = history(editor);
    quick.show();
    field().value = 'bp lfo-filter-vca';
    field().dispatchEvent(new Event('input'));
    play('⏎ Esc');
    expect(cables(editor.patch)).toEqual(['filter.lp24>vca.in', 'lfo.out>filter.cv', 'vca.out>output.l']);
    expect(history(editor)).toBe(steps + 1);
  });

  it('C copies the card under the pointer beside it and opens its ring', () => {
    const p = newPatch(DEFS);
    const f = addModule(p, DEFS.filter, 0, 600);
    f.params.cutoff = 321;
    const { editor, quick } = setup(p);
    const card = document.querySelector<HTMLElement>(`#modules .module[data-id="${f.id}"]`)!;
    (editor as unknown as { hover: { x: number; y: number } }).hover = { x: 1, y: 1 };
    document.elementFromPoint = () => card;
    expect(quick.copyHovered()).toBe(true);
    const copies = editor.patch.modules.filter((m) => m.type === 'filter');
    expect(copies).toHaveLength(2);
    expect(copies[1].params.cutoff).toBe(321);
    expect(quick.open).toBe(true);
    expect(field().placeholder).toBe('a port of Multimode filter, or another module');
  });
});
