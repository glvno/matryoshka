// SPDX-License-Identifier: GPL-3.0-only
// @vitest-environment jsdom
// Library > Patches (#218): the two columns against a stand-in FM-1
import { beforeEach, expect, it, vi } from 'vitest';
import { FACTORY, loadLibrary, removeAssembly, renameAssembly, storeAssembly } from './assemblies';
import { buildPatchesSection } from './bank';
import type { DeviceLink } from './device';
import { encodePatch } from './patchbin';
import { PRESETS } from './presets';
import { SLOTS, type SlotInfo } from './protocol';
import { savePatch } from './saved';

const names = Object.keys(PRESETS).slice(0, 2);
const empty = (): SlotInfo[] => Array.from({ length: SLOTS }, (_, slot) => ({ slot, used: false, length: 0, name: '' }));

/** an FM-1 that keeps its slots in memory */
function fakeDevice(connected: boolean): DeviceLink & { slots: SlotInfo[] } {
  const slots = empty();
  return {
    slots,
    get connected() { return connected; },
    readBank: async () => slots.map((s) => ({ ...s })),
    readSlot: async (i: number) => ({ ...slots[i] }),
    uploadSlot: async (i: number, name: string, p) => void (slots[i] = { slot: i, used: true, name: name.slice(0, 20), length: encodePatch(p).length }),
    eraseSlot: async (i: number) => void (slots[i] = { slot: i, used: false, length: 0, name: '' }),
  } as unknown as DeviceLink & { slots: SlotInfo[] };
}
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const cols = (root: HTMLElement): HTMLElement[] => [...root.querySelectorAll<HTMLElement>('.lib-col')];
const rows = (col: HTMLElement): string[] => [...col.querySelectorAll('.bank-row')].map((r) => r.querySelector('.grow')!.textContent!);
const button = (row: Element, text: string): HTMLButtonElement => [...row.querySelectorAll('button')].find((b) => b.textContent === text)!;

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('matryoshka.bank', JSON.stringify(names.map((name) => ({ name }))));
  document.body.replaceChildren();
});

it('without an FM-1 the FM-1 column is the offline copy: → adds to it, ← copies into Your patches, Delete is the host’s', () => {
  savePatch({ ...PRESETS[names[0]](), name: 'Mine' });
  const removed: string[] = [];
  const root = document.createElement('div');
  buildPatchesSection(root, fakeDevice(false), { remove: (n) => removed.push(n) });
  const [browser, fm1] = cols(root);
  expect(fm1.querySelector('.lib-state')!.textContent).toBe('Not connected · offline copy');
  expect(rows(fm1)).toEqual(names);
  const mine = browser.querySelector('.bank-row')!;
  button(mine, '→').click();
  expect(rows(fm1)).toEqual([...names, 'Mine']);
  button(mine, 'Delete').click();
  expect(removed).toEqual(['Mine']);
  button(fm1.querySelectorAll('.bank-row')[0], '←').click();
  expect(rows(browser)).toContain(names[0]);
  expect(button(fm1, 'Send bank to FM-1').disabled).toBe(true);
});

it('a patch over the FM-1 budget is marked browser only and cannot go to the FM-1; the old over-budget list folds into Your patches', () => {
  const huge = PRESETS[names[0]]();
  huge.modules = [...huge.modules, ...Array.from({ length: 400 }, (_, i) => ({ ...huge.modules[huge.modules.length - 1], id: 1000 + i }))];
  localStorage.setItem('matryoshka.bank-over', JSON.stringify([{ name: 'Huge', patch: huge }]));
  const root = document.createElement('div');
  buildPatchesSection(root, fakeDevice(false), { remove: () => {} });
  const row = [...cols(root)[0].querySelectorAll('.bank-row')].find((r) => r.querySelector('.grow')!.textContent === 'Huge')!;
  expect(row.querySelector('.lib-badge')!.getAttribute('title')).toBe('Too big for the FM-1');
  expect(button(row, '→').disabled).toBe(true);
  expect(localStorage.getItem('matryoshka.bank-over')).toBeNull();
});

it('with an FM-1 the column shows its slots: named when they hold the bank, else Unsaved bank with Save as bank…', async () => {
  const dev = fakeDevice(true);
  for (const [i, n] of names.entries()) await dev.uploadSlot(i, n.toUpperCase(), PRESETS[n]());
  const root = document.createElement('div');
  const pane = buildPatchesSection(root, dev, { remove: () => {} });
  pane.enter();
  await flush();
  const fm1 = cols(root)[1];
  expect(fm1.querySelector('.lib-state')!.textContent).toBe('On the FM-1 · Bank');
  expect(rows(fm1)).toEqual(names.map((n) => n.toUpperCase()));
  expect(fm1.querySelector<HTMLButtonElement>('.lib-saveas')!.hidden).toBe(true);
  // a factory patch added on the FM-1 goes to its first empty slot, and the bank no longer matches
  const sel = cols(root)[0].querySelector<HTMLSelectElement>('.lib-factory')!;
  sel.value = Object.keys(PRESETS)[2];
  sel.dispatchEvent(new Event('change'));
  await flush();
  expect(dev.slots[2].used).toBe(true);
  expect(fm1.querySelector('.lib-state')!.textContent).toBe('On the FM-1 · Unsaved bank');
  // Save as bank… makes the offline copy what the FM-1 holds (after a confirm)
  vi.stubGlobal('confirm', () => true);
  fm1.querySelector<HTMLButtonElement>('.lib-saveas')!.click();
  expect(JSON.parse(localStorage.getItem('matryoshka.bank')!)).toEqual(Object.keys(PRESETS).slice(0, 3).map((name) => ({ name })));
  expect(fm1.querySelector('.lib-state')!.textContent).toBe('On the FM-1 · Bank');
  vi.unstubAllGlobals();
});

it('your assemblies: a delete and a replace act at once, each with an undo; a rename never takes a used name', () => {
  const [a, b] = FACTORY;
  expect(storeAssembly({ ...a, name: 'One' }).result).toBe('saved');
  storeAssembly({ ...b, name: 'Two' });
  const { result, undo } = storeAssembly({ ...b, name: 'One' });
  expect(result).toBe('replaced');
  undo();
  expect(loadLibrary().find((d) => d.name === 'One')!.modules.length).toBe(a.modules.length);
  const back = removeAssembly('One')!;
  expect(loadLibrary().map((d) => d.name)).toEqual(['Two']);
  expect(back()).toBe(true);
  expect(loadLibrary().map((d) => d.name)).toEqual(['One', 'Two']);
  expect(renameAssembly('One', 'Two')).toBe(false);
  expect(renameAssembly('One', 'Three')).toBe(true);
  expect(loadLibrary().map((d) => d.name)).toEqual(['Three', 'Two']);
});
