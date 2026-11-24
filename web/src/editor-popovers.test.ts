// SPDX-License-Identifier: GPL-3.0-only
// @vitest-environment jsdom
// The owner, 2026-11-23: the Main dock's patch-button menus "have z index issues and they also are impossible to dismiss";
// the effect cards in an open FX drawer show no name; the Toggle's BYPASSES list offers "many many modules" inside
// assemblies. The editor as the owner used it, on Monolith D.
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { allModules, assembliesOf, drawerOf, effectsOf, parentOf } from './assembly';
import { keptTarget, toggleChoices } from './button-editor';
import { setKind, setTarget, toggleTargets } from './buttons';
import { Editor, type EditorEvents } from './editor';
import { closeFloat } from './popover';
import { addModule, connect, emptyPatch, type Patch } from './patch';
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

function open(p: Patch): Editor {
  document.body.innerHTML = '<div id="canvas"><div id="canvas-space"><div id="patch-world"><svg id="cables"></svg><div id="modules"></div><svg id="cable-glow"></svg><svg id="patch-preview"></svg></div></div></div><div id="dock"></div>';
  const ev: EditorEvents = { onStructure() {}, onParam() {}, onAtt() {}, onBypass() {}, onRange() {}, onTrack() {}, onTransport() {}, onLayout() {}, onError() {}, onSaveAssembly() {} };
  const editor = new Editor(document.getElementById('canvas')!, p, ev, document.getElementById('dock'));
  editor.rebuild();
  return editor;
}
const press = (t: EventTarget, init: MouseEventInit = {}): void => { t.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, ...init })); };
const more = (b: string): HTMLElement => document.querySelector<HTMLElement>(`.panel-btn[data-button="${b}"] .pb-more`)!;
const editors = (): string[] => [...document.querySelectorAll('.button-editor strong')].map((s) => s.textContent!);
const escape = (): void => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); };
const monolith = (): Patch => PRESETS['Monolith D']();

afterEach(() => closeFloat());

describe('the patch buttons’ editors (one at a time, and every way out)', () => {
  it('SEL, EDIT, ARP one after another: only the last stays open, alone', () => {
    open(monolith());
    for (const b of ['scl', 'edit', 'arp']) {
      press(more(b));
      expect(editors()).toHaveLength(1);
    }
    expect(editors()).toEqual(['ARP button']);
  });

  it('closes on Escape, on a press outside, on its ⋯ again, on its ×, and a right-click on another button moves it there', () => {
    open(monolith());
    press(more('edit'));
    expect(editors()).toEqual(['EDIT button']);
    escape();
    expect(editors()).toEqual([]);
    press(more('edit'));
    press(document.getElementById('modules')!);
    expect(editors()).toEqual([]);
    press(more('edit'));
    press(more('edit'));
    expect(editors()).toEqual([]);
    press(more('edit'));
    document.querySelector<HTMLButtonElement>('.button-editor .float-close')!.click();
    expect(editors()).toEqual([]);
    press(more('edit'));
    const lfo = document.querySelector<HTMLElement>('.panel-btn[data-button="lfo"]')!;
    press(lfo, { button: 2 });
    lfo.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    expect(editors()).toEqual(['LFO button']);
  });

  it('a card’s ⋯ menu and a button editor never stack: each closes the one open; the ⋯ again closes its menu', () => {
    open(monolith());
    press(more('edit'));
    const cardMore = document.querySelector<HTMLButtonElement>('.module[data-asm]:not(.embedded) > .mhead button.more')!;
    press(cardMore);
    cardMore.click();
    expect(editors()).toEqual([]);
    expect(document.querySelectorAll('.ctx')).toHaveLength(1);
    cardMore.click();                        // its ⋯ again
    expect(document.querySelectorAll('.ctx')).toHaveLength(0);
    cardMore.click();
    press(more('scl'));
    expect(document.querySelectorAll('.ctx')).toHaveLength(0);
    expect(editors()).toEqual(['SEL button']);
  });

  it('the ARP menu (+ ARP with several ways): its button again, Escape, or another popover closes it', () => {
    const p = emptyPatch('t');
    const main = addModule(p, DEFS.fm1, 0, 0);
    setKind(p, 'arp', 'nothing');
    for (const y of [0, 200]) connect(p, DEFS, { module: main.id, port: 'keys' }, { module: addModule(p, DEFS.alloc, 600, y).id, port: 'keys' });
    open(p);
    const arp = (): HTMLButtonElement => document.querySelector<HTMLButtonElement>('.panel-btn.arp-free')!;
    const menus = (): number => document.querySelectorAll('.arp-menu').length;
    arp().click();
    expect(menus()).toBe(1);
    press(arp());
    arp().click();
    expect(menus()).toBe(0);
    arp().click();
    escape();
    expect(menus()).toBe(0);
    arp().click();
    press(more('edit'));
    expect(menus()).toBe(0);
    expect(editors()).toEqual(['EDIT button']);
  });
});

describe('the effect cards in an open FX drawer', () => {
  it('each card’s header names its effect, and the name gives way last (the preset chip shrinks first)', () => {
    const e = open(monolith());
    const inst = assembliesOf(e.patch).find((a) => a.label === 'Monolith D')!;
    const d = drawerOf(e.patch, inst.id)!;
    e.setDrawerOpen(d.id, true);
    const names = [...document.querySelectorAll('.fx-drawer .fx-card > .mhead .asm-name')].map((n) => n.textContent);
    expect(names).toEqual(effectsOf(e.patch, d).map((x) => x.label));
    expect(names).toEqual(['Drive', 'Chorus', 'Delay', 'Reverb']);
    // the header's rules (jsdom lays nothing out), and that they reach these elements: the title is sized by its name, at
    // least its shortest form; the chip shrinks a thousand times faster, down to 56 px
    const style = document.createElement('style');
    style.textContent = readFileSync('src/style.css', 'utf8').replace(/@import[^;]+;/g, '');   // (vitest runs in web/)
    document.head.append(style);
    const rule = (sel: string): CSSStyleDeclaration => ([...style.sheet!.cssRules] as CSSStyleRule[]).find((r) => r.selectorText === sel)!.style;
    const head = document.querySelector<HTMLElement>('.fx-card > .mhead')!;
    expect(head.querySelector('.asm-title')!.matches('.mhead > span.asm-title')).toBe(true);
    const title = rule('.mhead > span.asm-title');
    expect([title.getPropertyValue('flex'), title.getPropertyValue('min-width'), title.getPropertyValue('contain')]).toEqual(['1 1 auto', 'min-content', 'none']);
    expect(head.querySelector('.preset-chip')!.matches(':is(.mhead, .fhead) span.preset-chip')).toBe(true);
    const chip = rule(':is(.mhead, .fhead) span.preset-chip');
    expect([chip.getPropertyValue('flex'), chip.getPropertyValue('min-width')]).toEqual(['0 1000 124px', '56px']);
    style.remove();
  });
});

describe('a row’s name over its thumb (1.26.3 device check 4.5)', () => {
  // #1251 drew a row's name over its thumb so it reads whole; the name then took the presses, and a drag on the Delay
  // card's length row (at its centre, under the name) never reached the slider. jsdom cannot hit-test: the cascade it
  // computes from style.css says what takes the pointer (the device check's 4.5 hit-tests the rows in a real browser)
  it('takes no pointer on a slider row, on the canvas cards, the FX drawer’s cards and the sidebar; a renamable name, a switch’s and a selector’s still do', () => {
    const e = open(monolith());
    const inst = assembliesOf(e.patch).find((a) => a.label === 'Monolith D')!;
    e.setDrawerOpen(drawerOf(e.patch, inst.id)!.id, true);
    document.body.insertAdjacentHTML('beforeend', `<aside class="sidebar">${readFileSync('index.html', 'utf8').match(/<div id="slack-bar"[^\n]*<\/div>/)![0]}</aside>`);
    const style = document.createElement('style');
    style.textContent = readFileSync('src/style.css', 'utf8').replace(/@import[^;]+;/g, '');   // (vitest runs in web/)
    document.head.append(style);
    const takes = (el: Element): string => getComputedStyle(el).pointerEvents;
    const names = (sel: string): Element[] => [...document.querySelectorAll(`${sel} > span:first-child`)];
    const sliders = names('.module .param.bar:has(> .slider-jack)');
    const drawer = names('.fx-drawer .fx-card .param.bar:has(> .slider-jack)');
    expect(sliders.length).toBeGreaterThan(20);
    expect(drawer.length).toBeGreaterThan(5);
    for (const n of sliders) expect(`${n.textContent}: ${takes(n)}`).toBe(`${n.textContent}: none`);
    // the slider under it takes the press, and the name still draws over the thumb
    const row = drawer[0].parentElement!;
    expect(takes(row.querySelector('input.jack-range')!)).toBe('auto');
    expect(Number(getComputedStyle(drawer[0]).zIndex)).toBeGreaterThan(Number(getComputedStyle(row.querySelector('.slider-port, .slider-thumb')!).zIndex));
    const slack = document.querySelector('#slack-bar > span:first-child')!;
    expect(slack.textContent).toBe('Cable slack');
    expect(takes(slack)).toBe('none');
    // a selector's or a switch's name has no slider under it: it keeps its tooltip (the status line reads its title)
    const others = names('.module .param.bar:is(.sel, .toggle)');
    expect(others.length).toBeGreaterThan(0);
    for (const n of others) expect(`${n.textContent}: ${takes(n)}`).toBe(`${n.textContent}: auto`);
    // a renamable name keeps its click (the rule's exception)
    const rename = document.querySelector('.module .param.bar:has(> .slider-jack) > span:first-child')!;
    rename.classList.add('rename');
    expect(takes(rename)).toBe('auto');
    style.remove();
  });
});

describe('the Toggle’s BYPASSES list (owner device check S3)', () => {
  it('offers the devices: top-level assemblies and modules, the FX drawer and each effect, never a member inside', () => {
    const p = monolith();
    const inst = assembliesOf(p).find((a) => a.label === 'Monolith D')!;
    const d = drawerOf(p, inst.id)!;
    const choices = toggleChoices(p);
    const inside = new Set(assembliesOf(p).flatMap((a) => allModules(p, a)));
    for (const c of choices) {
      const id = Number(c.value.slice(1));
      if (c.value[0] === 'm') expect(inside.has(id), c.text).toBe(false);
      else {
        const a = assembliesOf(p).find((x) => x.id === id)!;
        expect(!parentOf(p, id) || a.drawer || parentOf(p, id)!.drawer, c.text).toBeTruthy();
      }
    }
    expect(choices.filter((c) => c.group === 'Monolith D › FX').map((c) => c.text)).toEqual([
      'Monolith D › FX', 'Monolith D › FX › Drive', 'Monolith D › FX › Chorus', 'Monolith D › FX › Delay', 'Monolith D › FX › Reverb',
    ]);
    expect(choices.find((c) => c.text === 'Monolith D › FX')!.value).toBe(`a${d.id}`);
    expect(choices.some((c) => c.group === 'Assemblies' && c.text === 'Monolith D')).toBe(true);
    expect(choices.length).toBeLessThan(inside.size);
  });

  it('an older patch’s Toggle on a member inside keeps it, shown as the device it is in, with a note', () => {
    const p = monolith();
    const inst = assembliesOf(p).find((a) => a.label === 'Monolith D')!;
    const member = p.modules.find((m) => inst.modules.includes(m.id) && m.type !== 'fm1')!;
    setKind(p, 'edit', 'bypass');
    setTarget(p, 'edit', { module: member.id });
    const kept = keptTarget(p, { module: member.id })!;
    expect(kept.value).toBe(`m${member.id}`);
    expect(kept.text).toMatch(/^Monolith D › /);
    open(p);
    press(more('edit'));
    const sel = document.querySelector<HTMLSelectElement>('.button-editor select')!;
    expect(sel.value).toBe(`m${member.id}`);
    expect(sel.selectedOptions[0].textContent).toBe(kept.text);
    expect(document.querySelector('.button-editor .be-kept')!.textContent).toContain(kept.text);
    expect(toggleTargets(p, 'edit')).toEqual([member.id]);   // (it still bypasses it)
  });
});
