// SPDX-License-Identifier: GPL-3.0-only
// @vitest-environment jsdom
// Library > Palettes (#1236, library-palettes.ts): the list of saved palettes (newest change first, Open / Send to FM-1 /
// Export / ✕, Recently deleted with "put back") and a palette open (its name, its 8 chips taking dropped patches under the
// name the user gives, moves, ×, a click opening the sound; the open patch's candidates to drag in). A real store on the
// memory backend, wired as main.ts wires it (onChange → refresh); main's events recorded.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildPalettesSection, type PalettesEvents, type PalettesSection } from './library-palettes';
import { DEFS } from './modules';
import { newPatch, type Patch } from './patch';
import type { PatchDragItem } from './patch-drag';
import { memoryBackend, PALETTE_SLOTS, SavedPaletteStore, type PaletteSound, type SavedPalette } from './saved-palettes';

// (jsdom lacks these; selector.ts makes its ResizeObserver when it loads, so before the imports)
vi.hoisted(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  g.ResizeObserver ??= class { observe(): void {} unobserve(): void {} disconnect(): void {} };
  if (!(document as unknown as { fonts?: unknown }).fonts) Object.defineProperty(document, 'fonts', { value: { addEventListener() {}, ready: Promise.resolve() } });
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.checkVisibility ??= () => true;
  proto.scrollTo ??= () => {};
});

beforeEach(() => localStorage.clear());

const patch = (name: string): Patch => { const p = newPatch(DEFS); p.name = name; return p; };
const sound = (name: string): PaletteSound => ({ name, patch: patch(name), presets: [] });
/** a stored palette: `names` its positions (null empty), padded to 8 */
const pal = (id: string, name: string, changed: number, names: (string | null)[] = []): SavedPalette => ({
  id, name, made: changed, changed,
  sounds: Array.from({ length: PALETTE_SLOTS }, (_, i) => (names[i] ? sound(names[i]!) : null)),
});
const item = (name: string, p: Patch | null = patch(name)): PatchDragItem => ({ name, patch: () => p });

async function rig(seed: SavedPalette[] = []) {
  await new Promise((r) => setTimeout(r));   // (a drag's release swallows the click it makes until a timeout: the last test's)
  document.body.innerHTML = '<div id="lib-palettes" class="lib-section"><h2 class="lib-title">Palettes</h2></div>';
  const root = document.getElementById('lib-palettes')!;
  const store = new SavedPaletteStore(memoryBackend(seed), (p) => p as Patch);
  await store.ready;
  const s = {
    linked: false,
    answer: (initial: string): string | null => initial,
    cands: { patchName: 'NIGHT BUS', rows: [] as { letter: string; name?: string; item: PatchDragItem }[] },
    heard: [] as { s: PaletteSound; p: SavedPalette; pos: number }[],
    sent: [] as string[], saved: 0, exported: [] as string[], imported: 0, deleted: [] as string[],
    asked: [] as { initial: string; anchor: HTMLElement }[], opened: [] as (string | null)[], said: [] as string[],
  };
  const ev: PalettesEvents = {
    store,
    linked: () => s.linked,
    hear: (x, p, pos) => void s.heard.push({ s: x, p, pos }),
    send: (p) => void s.sent.push(p.id),
    saveFromFm1: () => void s.saved++,
    exportFile: (p) => void s.exported.push(p.id),
    importFile: () => void s.imported++,
    deleted: (p) => void s.deleted.push(p.id),
    askName: async (initial, anchor) => { s.asked.push({ initial, anchor }); return s.answer(initial); },
    candidates: () => s.cands,
    opened: (id) => void s.opened.push(id),
    say: (t) => void s.said.push(t),
  };
  const section: PalettesSection = buildPalettesSection(root, ev);
  store.onChange = () => section.refresh();   // (as main.ts)
  /** `it` dragged from a candidate row onto chip `pos`, the name asked and answered */
  const drop = async (pos: number, it: PatchDragItem): Promise<void> => {
    s.cands = { patchName: 'NIGHT BUS', rows: [{ letter: 'B', item: it }] };
    section.refresh();
    drag(document.querySelector<HTMLElement>('.lpal-cand')!, chip(pos));
    await settle();
  };
  return { root, store, section, s, drop };
}

const listView = (): HTMLElement => document.querySelector<HTMLElement>('.lpal-list')!;
const openView = (): HTMLElement => document.querySelector<HTMLElement>('.lpal-open')!;
const rows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('.lpal-rows [role="listitem"]')];
const binRows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('.lpal-deleted [role="listitem"]')];
const btn = (scope: HTMLElement, text: string): HTMLButtonElement =>
  [...scope.querySelectorAll('button')].find((b) => b.textContent === text)!;
const chip = (pos: number): HTMLElement => document.querySelector<HTMLElement>(`.lpal-chips .pal-chip[data-pos="${pos}"]`)!;
const nameInput = (): HTMLInputElement => document.querySelector<HTMLInputElement>('input[aria-label="Palette name"]')!;
const key = (el: HTMLElement, k: string): void => void el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
const names = (p: SavedPalette | undefined): (string | null)[] => p!.sounds.map((x) => x?.name ?? null);
/** the drop runs (on the timeout that ends the release's click swallow, patch-drag.ts), then its microtasks (askName's
 *  answer, then the store) */
const settle = async (): Promise<void> => { await new Promise((r) => setTimeout(r)); for (let i = 0; i < 10; i++) await Promise.resolve(); };

/** a pointer drag: `press` pressed, moved, released over `target` */
function drag(press: HTMLElement, target: HTMLElement): void {
  document.elementFromPoint = () => target;
  press.dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientX: 0, clientY: 0, bubbles: true }));
  window.dispatchEvent(new MouseEvent('pointermove', { clientX: 30, clientY: 30, bubbles: true }));
  window.dispatchEvent(new MouseEvent('pointerup', { clientX: 30, clientY: 30, bubbles: true }));
}

describe('the list', () => {
  it('shows a row per palette, newest change first, with its count and its sounds’ names', async () => {
    await rig([pal('a', 'Palette 1', 1000, ['NIGHT BUS B']), pal('b', 'Palette 2', 3000, ['WARM', null, 'COLD']), pal('c', 'Live', 2000)]);
    expect(rows().map((r) => r.querySelector('.lpal-pname')!.textContent)).toEqual(['Palette 2', 'Live', 'Palette 1']);
    expect(rows().map((r) => r.querySelector('.lpal-count')!.textContent)).toEqual(['2 sounds', '0 sounds', '1 sound']);
    expect(rows()[0].querySelector('.lpal-sounds')!.textContent).toBe('WARM · COLD');
    expect(document.querySelector('.lpal-rows')!.getAttribute('role')).toBe('list');
    expect(btn(rows()[0], '✕').title).toBe('Delete Palette 2');
    expect(document.querySelector<HTMLElement>('.lpal-empty')!.hidden).toBe(true);
    expect(document.querySelector<HTMLElement>('.lpal-deleted')!.hidden).toBe(true);
  });

  it('says so when there is none', async () => {
    await rig();
    expect(rows()).toHaveLength(0);
    expect(document.querySelector<HTMLElement>('.lpal-empty')!.hidden).toBe(false);
  });

  it('New palette makes Palette 1 and opens it', async () => {
    const { store, section, s } = await rig();
    btn(listView(), 'New palette').click();
    const [p] = store.all();
    expect(p.name).toBe('Palette 1');
    expect(section.openId()).toBe(p.id);
    expect(s.opened).toEqual([p.id]);
    expect(listView().hidden).toBe(true);
    expect(openView().hidden).toBe(false);
    expect(nameInput().value).toBe('Palette 1');
    expect(document.querySelectorAll('.lpal-chips .pal-chip')).toHaveLength(PALETTE_SLOTS);
  });

  it('a click on a row opens it; ← All palettes goes back (opened follows)', async () => {
    const { section, s } = await rig([pal('a', 'Palette 1', 1000, ['WARM'])]);
    rows()[0].querySelector<HTMLElement>('.lpal-sounds')!.click();
    expect(section.openId()).toBe('a');
    btn(openView(), '← All palettes').click();
    expect(section.openId()).toBeNull();
    expect(listView().hidden).toBe(false);
    btn(rows()[0], 'Open').click();
    expect(s.opened).toEqual(['a', null, 'a']);
  });

  it('opening an unknown palette shows the list', async () => {
    const { section, s } = await rig([pal('a', 'Palette 1', 1000)]);
    section.open('nope');
    expect(section.openId()).toBeNull();
    expect(listView().hidden).toBe(false);
    expect(s.opened).toEqual([]);
  });

  it('Send to FM-1 and Save from FM-1 need a linked FM-1', async () => {
    const { section, s } = await rig([pal('a', 'Palette 1', 1000, ['WARM'])]);
    const save = (): HTMLButtonElement => btn(listView(), 'Save from FM-1');
    expect(btn(rows()[0], 'Send to FM-1').disabled).toBe(true);
    expect(btn(rows()[0], 'Send to FM-1').title).toBe('Connect an FM-1 with firmware 1.26');
    expect(save().disabled).toBe(true);
    expect(save().title).toBe('Connect an FM-1 with firmware 1.26');
    s.linked = true;
    section.deviceChanged(true);
    expect(save().disabled).toBe(false);
    btn(rows()[0], 'Send to FM-1').click();
    save().click();
    expect(s.sent).toEqual(['a']);
    expect(s.saved).toBe(1);
    expect(section.openId()).toBeNull();   // (a row's buttons do not open it)
    section.open('a');
    btn(openView(), 'Send to FM-1').click();
    expect(s.sent).toEqual(['a', 'a']);
  });

  it('Send in the open view is off without an FM-1', async () => {
    const { section } = await rig([pal('a', 'Palette 1', 1000)]);
    section.open('a');
    expect(btn(openView(), 'Send to FM-1').disabled).toBe(true);
  });

  it('Export and Import… call main', async () => {
    const { section, s } = await rig([pal('a', 'Palette 1', 1000)]);
    btn(rows()[0], 'Export').click();
    btn(listView(), 'Import…').click();
    section.open('a');
    btn(openView(), 'Export').click();
    expect(s.exported).toEqual(['a', 'a']);
    expect(s.imported).toBe(1);
  });

  it('✕ deletes a row; Recently deleted lists it and put back restores it', async () => {
    const { store, s } = await rig([pal('a', 'Palette 1', 1000), pal('b', 'Palette 2', 2000)]);
    btn(rows()[1], '✕').click();
    expect(store.get('a')).toBeUndefined();
    expect(s.deleted).toEqual(['a']);
    expect(rows()).toHaveLength(1);
    expect(binRows().map((r) => r.querySelector('.lpal-pname')!.textContent)).toEqual(['Palette 1']);
    btn(binRows()[0], 'put back').click();
    expect(store.get('a')).toBeDefined();
    expect(rows()).toHaveLength(2);
    expect(document.querySelector<HTMLElement>('.lpal-deleted')!.hidden).toBe(true);
  });
});

describe('a palette open', () => {
  it('renames on Enter; Escape puts the name back', async () => {
    const { store, section } = await rig([pal('a', 'Palette 1', 1000)]);
    section.open('a');
    const input = nameInput();
    input.focus();
    input.value = '  Night bus run ';
    key(input, 'Enter');
    expect(store.get('a')!.name).toBe('Night bus run');
    expect(input.value).toBe('Night bus run');
    input.value = 'Junk';
    key(input, 'Escape');
    expect(input.value).toBe('Night bus run');
    input.blur();
    expect(store.get('a')!.name).toBe('Night bus run');
    btn(openView(), '← All palettes').click();
    expect(rows()[0].querySelector('.lpal-pname')!.textContent).toBe('Night bus run');
  });

  it('an empty name keeps the old one', async () => {
    const { store, section } = await rig([pal('a', 'Palette 1', 1000)]);
    section.open('a');
    nameInput().value = '   ';
    key(nameInput(), 'Enter');
    expect(store.get('a')!.name).toBe('Palette 1');
    expect(nameInput().value).toBe('Palette 1');
  });

  it('a patch dropped on chip 3 goes there under the name given', async () => {
    const { store, section, s, drop } = await rig([pal('a', 'Palette 1', 1000)]);
    section.open('a');
    s.answer = () => 'Warm pad';
    await drop(2, item('NIGHT BUS B'));
    expect(s.asked.map((a) => a.initial)).toEqual(['NIGHT BUS B']);
    expect(s.asked[0].anchor.dataset.pos).toBe('2');
    expect(names(store.get('a'))).toEqual([null, null, 'Warm pad', null, null, null, null, null]);
    expect(store.get('a')!.sounds[2]!.patch.name).toBe('NIGHT BUS B');
    expect(chip(2).querySelector('.pal-name')!.textContent).toBe('Warm pad');
  });

  it('a cancelled name stores nothing', async () => {
    const { store, section, s, drop } = await rig([pal('a', 'Palette 1', 1000)]);
    section.open('a');
    s.answer = () => null;
    await drop(2, item('NIGHT BUS B'));
    expect(s.asked).toHaveLength(1);
    expect(names(store.get('a')).every((n) => n === null)).toBe(true);
  });

  it('a patch with no copy in this browser says so and stores nothing', async () => {
    const { store, section, s, drop } = await rig([pal('a', 'Palette 1', 1000)]);
    section.open('a');
    await drop(2, item('FAR AWAY', null));
    expect(s.said).toEqual(['No copy of "FAR AWAY" in this browser: it cannot go into a saved palette']);
    expect(s.asked).toHaveLength(0);
    expect(names(store.get('a')).every((n) => n === null)).toBe(true);
  });

  it('× empties a chip', async () => {
    const { store, section } = await rig([pal('a', 'Palette 1', 1000, ['WARM', 'COLD'])]);
    section.open('a');
    chip(1).querySelector<HTMLButtonElement>('.pal-x')!.click();
    expect(names(store.get('a')).slice(0, 2)).toEqual(['WARM', null]);
    expect(chip(1).classList.contains('empty')).toBe(true);
  });

  it('a chip dragged onto a full one swaps the two', async () => {
    const { store, section } = await rig([pal('a', 'Palette 1', 1000, ['WARM', null, 'COLD'])]);
    section.open('a');
    drag(chip(0), chip(2));
    expect(names(store.get('a')).slice(0, 3)).toEqual(['COLD', null, 'WARM']);
  });

  it('a click on a full chip opens its sound', async () => {
    const { store, section, s } = await rig([pal('a', 'Palette 1', 1000, [null, 'WARM'])]);
    section.open('a');
    chip(1).click();
    expect(s.heard).toHaveLength(1);
    expect(s.heard[0].pos).toBe(1);
    expect(s.heard[0].p.id).toBe('a');
    expect(s.heard[0].s).toBe(store.get('a')!.sounds[1]);
  });

  it('Delete removes it, goes back to the list, and Recently deleted puts it back', async () => {
    const { store, section, s } = await rig([pal('a', 'Palette 1', 1000, ['WARM'])]);
    section.open('a');
    btn(openView(), 'Delete').click();
    expect(store.get('a')).toBeUndefined();
    expect(s.deleted).toEqual(['a']);
    expect(section.openId()).toBeNull();
    expect(s.opened).toEqual(['a', null]);
    expect(listView().hidden).toBe(false);
    expect(binRows().map((r) => r.querySelector('.lpal-pname')!.textContent)).toEqual(['Palette 1']);
    btn(binRows()[0], 'put back').click();
    expect(names(store.get('a'))[0]).toBe('WARM');
    expect(rows()).toHaveLength(1);
  });

  it('closes when the open palette is deleted elsewhere', async () => {
    const { store, section, s } = await rig([pal('a', 'Palette 1', 1000)]);
    section.open('a');
    store.remove('a');
    expect(section.openId()).toBeNull();
    expect(s.opened).toEqual(['a', null]);
    expect(listView().hidden).toBe(false);
  });

  it('lists the open patch’s candidates as drag sources, read again on refresh', async () => {
    const { store, section, s } = await rig([pal('a', 'Palette 1', 1000)]);
    s.cands = { patchName: 'NIGHT BUS', rows: [{ letter: 'A', item: item('NIGHT BUS A') }, { letter: 'B', name: 'warm', item: item('NIGHT BUS warm') }] };
    section.open('a');
    expect(document.querySelector('.lpal-cands h3')!.textContent).toBe('Drag in: candidates of NIGHT BUS');
    const cands = [...document.querySelectorAll<HTMLElement>('.lpal-cand')];
    expect(cands.map((c) => c.querySelector('.lpal-letter')!.textContent)).toEqual(['A', 'B']);
    expect(cands.map((c) => c.querySelector('.lpal-cand-name')!.textContent)).toEqual(['NIGHT BUS A', 'warm']);
    expect(cands.every((c) => c.classList.contains('patch-drag-source'))).toBe(true);
    drag(cands[1], chip(4));
    await settle();
    expect(names(store.get('a'))[4]).toBe('NIGHT BUS warm');
    s.cands = { patchName: 'DAWN', rows: [] };
    section.refresh();
    expect(document.querySelector('.lpal-cands h3')!.textContent).toBe('Drag in: candidates of DAWN');
    expect(document.querySelectorAll('.lpal-cand')).toHaveLength(0);
  });
});
