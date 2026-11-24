// SPDX-License-Identifier: GPL-3.0-only
// @vitest-environment jsdom
// The FX drawer on the canvas (spec "The drawer (editor)"): the plug on the instrument's card, the open drawer with each
// effect as a live card, the chain wired by the drawer and refused to cables, drops into it, removing from it, and a child
// shown whole on its parent's card (spec Model 6).
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { exposePort, makeAssembly, promote, type AssemblyInst } from './assembly';
import { drawerHeight, Editor, type EditorEvents } from './editor';
import { addDrawer, drawers, effectsOf, insertEffect } from './fx-drawer';
import { DEFS } from './modules';
import { addModule, connect, newPatch, validatePatch, type Patch } from './patch';

vi.hoisted(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  g.ResizeObserver ??= class { observe(): void {} unobserve(): void {} disconnect(): void {} };
  if (!document.fonts) Object.defineProperty(document, 'fonts', { value: { addEventListener() {}, ready: Promise.resolve() } });
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.checkVisibility ??= () => true;
  proto.scrollTo ??= () => {};
});

/** a stereo instrument (two oscillators, out L / out R into the Output) with an FX drawer holding `effects` */
function rig(effects: string[] = ['shape', 'delay']): { p: Patch; inst: AssemblyInst; drawer: AssemblyInst } {
  const p = newPatch(DEFS, 'Drawer');
  const out = p.modules.find((m) => m.type === 'output')!;
  const a = addModule(p, DEFS.osc, 20, 20), b = addModule(p, DEFS.osc, 340, 20), lfo = addModule(p, DEFS.lfo, 20, 400);
  const inst = makeAssembly(p, [a.id, b.id, lfo.id], 'Hera 4');
  promote(inst, a.id, DEFS.osc.params[0].name, p);
  for (const [m, port] of [[a, 'out'], [b, 'out'], [lfo, 'out']] as const) exposePort(inst, 'out', m.id, port, undefined, p);
  expect(connect(p, DEFS, { module: a.id, port: 'out' }, { module: out.id, port: 'l' })).toBe(true);
  expect(connect(p, DEFS, { module: b.id, port: 'out' }, { module: out.id, port: 'r' })).toBe(true);
  inst.open = false;
  const drawer = addDrawer(p, inst.id);
  for (const t of effects) insertEffect(p, drawer, { type: t });
  return { p, inst, drawer };
}

function editorOn(p: Patch, log: string[] = [], ev: Partial<EditorEvents> = {}): Editor {
  document.body.innerHTML = '<div id="canvas"><div id="canvas-space"><div id="patch-world"><svg id="cables"></svg><div id="modules"></div><svg id="cable-glow"></svg><svg id="patch-preview"></svg></div></div></div>';
  const events: EditorEvents = {
    onStructure() {}, onParam() {}, onAtt() {}, onBypass() {}, onRange() {}, onTrack() {}, onTransport() {},
    onLayout() {}, onError: (msg) => log.push(msg), onSaveAssembly() {}, ...ev,
  };
  return new Editor(document.getElementById('canvas')!, p, events);
}

const plug = () => document.querySelector<HTMLElement>('.fx-plug');
const drawerEl = () => document.querySelector<HTMLElement>('.fx-drawer');
const drawerOf = (e: Editor) => drawers(e.patch)[0];

beforeEach(() => localStorage.clear());
/** the editor's undo steps */
const steps = (e: Editor): number => (e as unknown as { history: unknown[] }).history.length;

describe('the closed FX plug', () => {
  it('sits just before the instrument’s card, over the jacks its chain takes, with the effect count', () => {
    const { p, inst } = rig();
    editorOn(p);
    const card = document.querySelector<HTMLElement>(`#modules > .module.assembly[data-asm="${inst.id}"]`)!;
    expect(plug()!.nextElementSibling).toBe(card);
    expect(plug()!.querySelector('small')!.textContent).toBe('2');
    // the taps (out L, out R) are plugged; lfo stays an ordinary jack
    expect(card.querySelectorAll('.dot.plugged')).toHaveLength(2);
    expect([...card.querySelectorAll<HTMLElement>('.dot[data-dir="out"]')].filter((d) => !d.classList.contains('plugged'))).toHaveLength(1);
    // its own jacks: the instrument's sound after the effects
    expect(plug()!.querySelectorAll('.fx-jack > .dot.fx-end[data-dir="out"]')).toHaveLength(2);
    expect(drawerEl()).toBeNull();
    expect(document.querySelector('.fx-stages')).toBeNull();
  });

  it('an empty drawer stays as a thin “FX +” plug', () => {
    const { p } = rig([]);
    editorOn(p);
    expect(plug()!.classList.contains('empty')).toBe(true);
    expect(plug()!.querySelector('.fx-pl')!.textContent).toBe('FX +');
  });
});

describe('the open drawer', () => {
  it('opens and closes without an undo step, each effect a live card in signal order with its ⏻ and jacks', () => {
    const { p } = rig(['shape', 'chorus', 'delay']);
    const e = editorOn(p);
    const d = drawerOf(e);
    e.setDrawerOpen(d.id, true);
    expect(e.patch.assemblies!.find((a) => a.id === d.id)!.open).toBe(true);
    expect(steps(e)).toBe(0);
    expect(drawerEl()!.querySelector('.fx-dh .grow')!.textContent).toBe('FX · Hera 4');
    const cards = [...drawerEl()!.querySelectorAll<HTMLElement>('.fx-row > .fx-card')];
    expect(cards.map((c) => Number(c.dataset.asm))).toEqual(effectsOf(e.patch, d).map((x) => x.id));
    for (const c of cards) expect(c.querySelector(':scope > .mhead button.pw')).not.toBeNull();
    // no ▸: an effect is not expanded inside the drawer
    expect(drawerEl()!.querySelector('.fx-card .mhead button.chev')).toBeNull();
    // Quick patch finds the cards and their jacks in the drawer
    const first = effectsOf(e.patch, d)[0];
    expect(e.cardElement({ kind: 'assembly', id: first.id })).toBe(cards[0]);
    const ref = first.inputs[first.chain!.ins[0]];
    expect(e.jackElement(ref, 'in')!.closest('.fx-drawer')).toBe(drawerEl());
    expect(e.drawerElement(d.id)).toBe(drawerEl());
    e.setDrawerOpen(d.id, false);
    expect(plug()).not.toBeNull();
    expect(steps(e)).toBe(0);
  });

  it('draws its chain as dashed wires in the drawer, never grabbed; the drawer’s ⏻ keeps each effect’s own switch', () => {
    const { p } = rig(['shape', 'delay']);
    const e = editorOn(p);
    const d = drawerOf(e);
    e.setDrawerOpen(d.id, true);
    e.drawCables();
    const chain = [...drawerEl()!.querySelectorAll('.fx-layer path.cable.chain')];
    expect(chain.length).toBeGreaterThanOrEqual(4);   // taps → first effect, first → second, both sides
    expect(chain.every((c) => c.classList.contains('fixed') && !c.hasAttribute('role'))).toBe(true);
    const [, second] = effectsOf(e.patch, d);
    e.setBypass([], true, second);
    e.setBypass([], true, d);
    expect(drawerEl()!.querySelector('.fx-dh button.pw')!.getAttribute('aria-pressed')).toBe('false');
    e.setBypass([], false, d);
    expect(drawerEl()!.querySelector('.fx-dh button.pw')!.getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector(`.fx-card[data-asm="${second.id}"]`)!.classList.contains('off')).toBe(true);
  });

  it('refuses a cable onto a chain jack with the reason, and leaves the patch as it was', () => {
    const log: string[] = [];
    const { p } = rig(['shape', 'delay']);
    const lfo = addModule(p, DEFS.lfo, 900, 400);
    const e = editorOn(p, log);
    const d = drawerOf(e);
    e.setDrawerOpen(d.id, true);
    const before = JSON.stringify(e.patch.cables);
    const [, second] = effectsOf(e.patch, d);
    const target = e.jackElement(second.inputs[second.chain!.ins[0]], 'in')!;
    const from = e.jackElement({ module: lfo.id, port: 'out' }, 'out')!;
    (e as unknown as { connectJacks(a: HTMLElement, b: HTMLElement): void }).connectJacks(from, target);
    expect(log.at(-1)).toMatch(/FX chain/);
    expect(JSON.stringify(e.patch.cables)).toBe(before);
  });
});

// The drawer hugs its effect cards (D-1342, amended 2026-11-24). jsdom has no layout, so the stub lays the drawer out as
// style.css does: its top and bottom padding (read from the stylesheet) round its row, as tall as its tallest child (each
// effect card at the height measured in Chromium, the + slot at its stylesheet height), at least its min-height.
const css = readFileSync('src/style.css', 'utf8');   // (vitest runs in web/; jsdom's import.meta.url is no file URL)
const [, padTop, padBottom] = /\n\.fx-drawer \{ padding: (\d+)px var\([^)]*\) (\d+)px/.exec(css)!.map(Number);
const slotH = Number(/\n\.fx-slot \{[^}]*; height: (\d+)px/.exec(css)![1]);
const emptySlotH = Number(/\n\.fx-slot\.empty \{[^}]*min-height: (\d+)px/.exec(css)![1]);

/** open the patch's first drawer with its card `cardH` tall and its effect cards `cards` tall; the drawer laid out */
function openLaidOut(p: Patch, cardH: number, cards: number[]): HTMLElement {
  const e = editorOn(p);
  e.setDrawerOpen(drawers(e.patch)[0].id, true);
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains('fx-card')) return cards[[...this.parentElement!.children].indexOf(this)];
    if (this.classList.contains('fx-slot')) return this.classList.contains('empty') ? emptySlotH : slotH;
    if (this.classList.contains('fx-row')) return Math.max(...[...this.children].map((c) => (c as HTMLElement).offsetHeight));
    if (this.classList.contains('fx-drawer')) return Math.max(parseFloat(this.style.minHeight) || 0, padTop + this.querySelector<HTMLElement>(':scope > .fx-row')!.offsetHeight + padBottom);
    return this.matches('#modules > .module.assembly') ? cardH : 0;
  });
  (e as unknown as { layoutDrawers(): void }).layoutDrawers();
  return drawerEl()!;
}
const factory = (f: string): Patch => validatePatch(JSON.parse(readFileSync(`presets/${f}`, 'utf8')), DEFS);
const outline = (el: HTMLElement): string => el.querySelector('.fx-shape .edge')!.getAttribute('d')!;

describe('the open drawer’s height', () => {
  afterEach(() => vi.restoreAllMocks());

  it('Monolith D: as tall as its tallest effect card and padding, its bottom edge beside the card', () => {
    const el = openLaidOut(factory('00-monolith-d.json'), 617, [146, 112, 199, 189]);
    expect(padTop + 199 + padBottom).toBe(253);
    expect(el.offsetHeight).toBe(253);
    expect(el.style.top).toBe(`${10}px`);   // 10 px below the card's top, its corner under the card
    // shorter than the card: the far corners rounded, the bottom edge running straight under the card's edge
    expect(outline(el)).toBe(`M0 0 H${el.offsetWidth - 10} A10 10 0 0 1 ${el.offsetWidth} 10 V243 A10 10 0 0 1 ${el.offsetWidth - 10} 253 H0 Z`);
    // the + slot right after the last card
    const row = el.querySelector('.fx-row')!;
    expect(row.lastElementChild!.classList.contains('fx-slot')).toBe(true);
    expect(row.lastElementChild!.previousElementSibling!.classList.contains('fx-card')).toBe(true);
  });

  it('Oracle V: as tall as its tallest effect card and padding', () => {
    const el = openLaidOut(factory('01-oracle-v.json'), 709, [112, 199, 189]);
    expect(el.offsetHeight).toBe(padTop + 199 + padBottom);
    expect(outline(el)).toMatch(/ H0 Z$/);
  });

  it('an empty drawer is as tall as its drop target and padding', () => {
    const el = openLaidOut(rig([]).p, 617, []);
    expect(el.querySelector('.fx-slot.empty')).not.toBeNull();
    expect(el.offsetHeight).toBe(padTop + emptySlotH + padBottom);
  });

  it('a drawer taller than its card goes on below it, shown there as a rounded corner the card sits on', () => {
    const el = openLaidOut(rig(['delay']).p, 74, [199]);
    expect(el.offsetHeight).toBe(253);
    expect(outline(el)).toMatch(/ H10 A10 10 0 0 1 0 243 Z$/);
  });

  it('the + slot sits level with the cards’ tops, not at the drawer’s bottom', () => {
    expect(/\n\.fx-slot \{[^}]*align-self: flex-start;/.test(css)).toBe(true);
  });
});

describe('drawerHeight', () => {
  it('the content, at least down past the lowest jack it takes; never ending in the card’s bottom corner', () => {
    expect(drawerHeight(253, 617, 40)).toBe(253);
    expect(drawerHeight(174, 617, 300)).toBe(305);   // the jack at 300 px: 15 px below it, in the drawer's coordinates
    expect(drawerHeight(253, 74, 40)).toBe(253);
    expect(drawerHeight(253, 273, 40)).toBe(253);    // ends 10 px above the card's bottom
    expect(drawerHeight(253, 260, 40)).toBe(260);    // would end in the card's corner: on below it, 10 px past its bottom
  });
});

describe('adding and removing', () => {
  it('a drop on the closed plug appends the effect, one undo step', () => {
    const { p } = rig(['shape']);
    const e = editorOn(p);
    const d = drawerOf(e);
    const r = plug()!.getBoundingClientRect();
    expect(e.dropEffect({ type: 'delay' }, r.left + 1, r.top + 1)).toBe(true);
    expect(effectsOf(e.patch, drawerOf(e)).map((x) => x.label)).toEqual([effectsOf(p, d)[0].label, expect.stringMatching(/Delay/)]);
    expect(steps(e)).toBe(1);
    expect(plug()!.querySelector('small')!.textContent).toBe('2');
  });

  it('⋯ → Remove deletes the effect and the chain closes; Take out makes it an ordinary card', () => {
    const { p } = rig(['shape', 'delay']);
    const e = editorOn(p);
    const d = drawerOf(e);
    e.setDrawerOpen(d.id, true);
    const [first, second] = effectsOf(e.patch, d);
    const menu = (id: number, text: string): void => {
      document.querySelector<HTMLButtonElement>(`.fx-card[data-asm="${id}"] .mhead button.more`)!.click();
      [...document.querySelectorAll<HTMLButtonElement>('.ctx button')].find((b) => b.textContent!.startsWith(text))!.click();
    };
    menu(first.id, 'Take out onto the canvas');
    expect(effectsOf(e.patch, drawerOf(e)).map((x) => x.id)).toEqual([second.id]);
    expect(document.querySelector(`#modules > .module.assembly[data-asm="${first.id}"]`)).not.toBeNull();
    menu(second.id, 'Remove');
    expect(effectsOf(e.patch, drawerOf(e))).toEqual([]);
    expect(e.patch.assemblies!.some((a) => a.id === second.id)).toBe(false);
    // the drawer stays, empty
    expect(drawers(e.patch)).toHaveLength(1);
  });

  it('the + slot asks the host for the add list of this drawer, at the end', () => {
    const asked: [number, number][] = [];
    const { p } = rig(['shape']);
    const e = editorOn(p, [], { onAddEffect: (id, at) => asked.push([id, at]) });
    const d = drawerOf(e);
    e.setDrawerOpen(d.id, true);
    drawerEl()!.querySelector<HTMLButtonElement>('.fx-slot')!.click();
    expect(asked).toEqual([[d.id, 1]]);
  });
});

describe('a child shown whole on its parent’s card (spec Model 6)', () => {
  it('Arrange mode marks it; the collapsed card shows it as a live card with its own jacks', () => {
    const p = newPatch(DEFS, 'Embed');
    const a = addModule(p, DEFS.osc, 20, 20), f = addModule(p, DEFS.filter, 340, 20);
    const child = makeAssembly(p, [f.id], 'Tone');
    exposePort(child, 'in', f.id, 'in', undefined, p);
    const parent = makeAssembly(p, [a.id], 'Voice', [child.id]);
    parent.open = false;
    const e = editorOn(p);
    expect(document.querySelector('.embed-cards')).toBeNull();
    // Arrange the card: the child's switch
    document.querySelector<HTMLButtonElement>(`.module.assembly[data-asm="${parent.id}"] .mhead button.more`)!.click();
    [...document.querySelectorAll<HTMLButtonElement>('.ctx button')].find((b) => b.textContent!.startsWith('Arrange the card'))!.click();
    document.querySelector<HTMLButtonElement>('.embed-pick button.embed-toggle')!.click();
    expect(e.patch.assemblies!.find((x) => x.id === parent.id)!.cards).toEqual([child.id]);
    (e as unknown as { endPick(): void }).endPick();
    const shown = document.querySelector<HTMLElement>(`.module.assembly[data-asm="${parent.id}"] .embed-cards > .module.embedded[data-asm="${child.id}"]`);
    expect(shown).not.toBeNull();
    expect(e.jackElement({ module: f.id, port: 'in' }, 'in')!.closest('.embedded')).toBe(shown);
  });
});
