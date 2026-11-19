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
    expect(document.querySelector('.qp-hint')!.textContent).toBe('LFO has no port "nope" that fits here. It has: out, pulse');
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

  it('marks direction with icons only: the ring and the list name ports, never "in" or "out" as a direction', () => {
    const { quick } = setup();
    quick.show();
    play('lfo ⏎ ⏎ multi ⏎');
    // what the overlay and the list say besides port names (and the icons' spoken labels)
    const words = (root: Element): string => {
      const copy = root.cloneNode(true) as Element;
      for (const e of copy.querySelectorAll('.qp-name, title, [aria-label]')) e.remove();
      return copy.textContent ?? '';
    };
    const radial = document.querySelector('.qp-radial')!, list = document.querySelector('.qp-list')!;
    expect(radial.querySelectorAll('.qp-sec').length).toBeGreaterThan(8);
    for (const root of [radial, list]) expect(words(root)).not.toMatch(/\b(in|out|inputs?|outputs?)\b/i);
    // the two halves' icons say it to a screen reader instead
    expect([...radial.querySelectorAll('.qp-io')].map((e) => e.getAttribute('aria-label'))).toEqual(['input', 'output']);
    expect(list.querySelector('li .qp-io')!.getAttribute('aria-label')).toBe('input');
  });

  it('typing "out" offers the port named out, not every port that sends', () => {
    const { quick } = setup();
    quick.show();
    play('lfo ⏎ out');
    const ports = [...document.querySelectorAll('.qp-list li')].filter((li) => li.querySelector('.qp-io')).map((li) => li.querySelector('.qp-name')!.textContent);
    expect(ports).toEqual(['out']);
    expect([...document.querySelectorAll('.qp-radial .qp-sec .qp-name')].map((e) => e.textContent)).toEqual(['out']);
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

  describe('a cable held (owner 2026-11-19: the ring folds into the plug)', () => {
    const press = (key: string): void => { field().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })); };
    const sectors = (): number => document.querySelectorAll('.qp-radial svg.qp-rings:not(.qp-collapse) .qp-sec').length;
    const hint = (): string => document.querySelector('.qp-hint')!.textContent!;
    const centre = (): string => document.querySelector('.qp-core-name')!.textContent!;
    const lfoAndFilter = (): { p: Patch; l: number; f: number } => {
      const p = newPatch(DEFS);
      return { p, l: addModule(p, DEFS.lfo, 0, 600).id, f: addModule(p, DEFS.filter, 400, 600).id };
    };

    it('hides the source card\'s ring: the centre is a socket with the plug, and the jack it came from flashes as it folds', () => {
      const { p, l } = lfoAndFilter();
      const { quick } = setup(p);
      quick.show({ kind: 'module', id: l });
      expect(sectors()).toBeGreaterThan(0);
      play('⏎');
      expect(sectors()).toBe(0);
      expect(document.querySelector('.qp-socket-rim')).not.toBeNull();
      expect(document.querySelector('.qp-plug')).not.toBeNull();
      expect(centre()).toBe('LFO out');
      expect(field().placeholder).toBe('where to?');
      // the ring folding away, its held jack flashing (an output: the flash is not only for inputs)
      expect([...document.querySelectorAll('.qp-collapse .qp-sec.flash')].map((g) => g.getAttribute('data-port'))).toEqual(['out:jack:out']);
      // the held jack glows on its card on the canvas
      expect(document.querySelector(`#modules .module[data-id="${l}"] .qp-glow-jack`)).not.toBeNull();
    });

    it('shows no ring for a card typed or chosen until it is picked, then its ring with the plug', () => {
      const { p, l, f } = lfoAndFilter();
      const { editor, quick } = setup(p);
      quick.show({ kind: 'module', id: l });
      play('⏎ multi');
      const labels = [...document.querySelectorAll('.qp-list li .qp-label')].map((e) => e.textContent);
      expect(labels.slice(0, 2)).toEqual(['Multimode filter', 'New Multimode filter']);
      expect(sectors()).toBe(0);
      // the card the list names is outlined on the canvas instead
      expect(document.querySelector(`#modules .module[data-id="${f}"]`)!.classList.contains('qp-candidate')).toBe(true);
      play('⏎');
      expect(sectors()).toBeGreaterThan(8);
      expect(document.querySelector('.qp-radial svg.qp-rings')!.classList.contains('qp-grow')).toBe(true);
      expect(document.querySelector('.qp-plug')).not.toBeNull();
      expect(document.querySelector('.qp-socket-rim')).toBeNull();
      expect(document.querySelector(`#modules .module[data-id="${f}"]`)!.classList.contains('qp-glow')).toBe(true);
      // landing: the cable is made, the plug goes, the jack it went into flashes in the ring
      play('⏎');
      expect(cables(editor.patch)).toEqual(['lfo.out>filter.cv']);
      expect(document.querySelector('.qp-plug')).toBeNull();
      expect([...document.querySelectorAll('.qp-sec.flash')].map((g) => g.getAttribute('data-port'))).toEqual(['in:jack:cv']);
    });

    it('refuses the source card\'s own name', () => {
      const { p, l } = lfoAndFilter();
      const { editor, quick } = setup(p);
      quick.show({ kind: 'module', id: l });
      play('⏎ lfo');
      expect(document.querySelector('.qp-list li .qp-detail')!.textContent).toBe('where this cable starts');
      play('⏎');
      expect(hint()).toBe('that is the card this cable starts from: pick another card');
      expect(sectors()).toBe(0);
      expect(editor.patch.cables).toEqual([]);
    });

    it('lists the cards it could go to, but a quick ⏎ with nothing typed or chosen names none; ↓ chooses one', () => {
      const { p, l } = lfoAndFilter();
      const { quick } = setup(p);
      quick.show({ kind: 'module', id: l });
      play('⏎');
      expect([...document.querySelectorAll('.qp-list li .qp-label')].map((e) => e.textContent)).toContain('Multimode filter');
      expect(document.querySelector('.qp-list li.sel')).toBeNull();
      play('⏎');
      expect(hint()).toBe('type the card it goes to, or ↓ to choose one');
      expect(centre()).toBe('LFO out');
      while (document.querySelector('.qp-list li.sel .qp-label')?.textContent !== 'Multimode filter') press('ArrowDown');
      play('⏎');
      expect(centre()).toMatch(/Multimode filter$/);
      expect(sectors()).toBeGreaterThan(8);
    });

    it('Backspace lets it go: the source ring comes back', () => {
      const { p, l } = lfoAndFilter();
      const { quick } = setup(p);
      quick.show({ kind: 'module', id: l });
      play('⏎');
      expect(sectors()).toBe(0);
      press('Backspace');
      expect(sectors()).toBeGreaterThan(0);
      expect(document.querySelector('.qp-plug')).toBeNull();
      expect(document.querySelector('.qp-glow-jack')).toBeNull();
      expect(field().placeholder).toBe('a port of LFO, or another module');
    });

    it('says a cable that is already there, changes nothing and keeps it held', () => {
      const { p, l, f } = lfoAndFilter();
      connect(p, DEFS, { module: l, port: 'out' }, { module: f, port: 'cv' });
      const { editor, quick } = setup(p);
      const steps = history(editor);
      quick.show({ kind: 'module', id: f });
      play('cv ⏎ lfo ⏎ out ⏎');
      expect(hint()).toBe('that cable is already there: pick another jack, or Backspace lets it go');
      expect(cables(editor.patch)).toEqual(['lfo.out>filter.cv']);
      expect(document.querySelector('.qp-plug')).not.toBeNull();
      play('Esc');
      expect(history(editor)).toBe(steps);
    });
  });
});
