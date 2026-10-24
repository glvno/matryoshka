// SPDX-License-Identifier: GPL-3.0-only
// @vitest-environment jsdom
// Library > Patches (#218): the two columns against a stand-in FM-1
import { beforeEach, expect, it, vi } from 'vitest';
import { FACTORY, loadLibrary, removeAssembly, renameAssembly, storeAssembly } from './assemblies';
import { buildPatchesSection } from './bank';
import type { DeviceLink } from './device';
import type { Patch } from './patch';
import { encodePatch } from './patchbin';
import { FM1_PRESETS } from './presets';
import { SLOTS, slotLabel, type SlotInfo } from './protocol';
import { addedTitles, loadCommunity } from './community';
import { savePatch } from './saved';

// jsdom's streams cannot inflate a share code: the community entries decode to a factory patch here (community.test.ts
// decodes the real ones)
vi.mock('./share', async (real) => ({ ...(await real<typeof import('./share')>()), decodeShare: async () => FM1_PRESETS.Init() }));

const names = Object.keys(FM1_PRESETS).slice(0, 2);
const empty = (): SlotInfo[] => Array.from({ length: SLOTS }, (_, slot) => ({ slot, used: false, length: 0, name: '' }));

/** an FM-1 that keeps its slots in memory */
function fakeDevice(connected: boolean): DeviceLink & { slots: SlotInfo[] } {
  const slots = empty();
  return {
    slots,
    get connected() { return connected; },
    readBank: async () => slots.map((s) => ({ ...s })),
    readSlot: async (i: number) => ({ ...slots[i] }),
    uploadSlot: async (i: number, name: string, p: Patch) => void (slots[i] = { slot: i, used: true, name: name.slice(0, 20), length: encodePatch(p).length }),
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
  savePatch({ ...FM1_PRESETS[names[0]](), name: 'Mine' });
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

it('a patch over the FM-1 budget is marked SANDBOX and cannot go to the FM-1; the old over-budget list folds into Your patches', () => {
  const huge = FM1_PRESETS[names[0]]();
  huge.modules = [...huge.modules, ...Array.from({ length: 400 }, (_, i) => ({ ...huge.modules.find((m) => m.type === 'output')!, id: 1000 + i }))];
  localStorage.setItem('matryoshka.bank-over', JSON.stringify([{ name: 'Huge', patch: huge }]));
  const root = document.createElement('div');
  buildPatchesSection(root, fakeDevice(false), { remove: () => {} });
  const row = [...cols(root)[0].querySelectorAll('.bank-row')].find((r) => r.querySelector('.grow')!.textContent === 'Huge')!;
  expect(row.querySelector('.fit-chip.sandbox')!.textContent).toBe('SANDBOX');
  expect(button(row, '→').disabled).toBe(true);
  expect(localStorage.getItem('matryoshka.bank-over')).toBeNull();
});

it('with an FM-1 the column shows its slots: named when they hold the bank, else Unsaved bank with Save as bank…', async () => {
  const dev = fakeDevice(true);
  for (const [i, n] of names.entries()) await dev.uploadSlot(i, n.toUpperCase(), FM1_PRESETS[n]());
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
  sel.value = Object.keys(FM1_PRESETS)[2];
  sel.dispatchEvent(new Event('change'));
  await flush();
  expect(dev.slots[2].used).toBe(true);
  expect(fm1.querySelector('.lib-state')!.textContent).toBe('On the FM-1 · Unsaved bank');
  // Save as bank… makes the offline copy what the FM-1 holds (after a confirm)
  vi.stubGlobal('confirm', () => true);
  fm1.querySelector<HTMLButtonElement>('.lib-saveas')!.click();
  expect(JSON.parse(localStorage.getItem('matryoshka.bank')!)).toEqual(Object.keys(FM1_PRESETS).slice(0, 3).map((name) => ({ name })));
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

it('→ onto a name the offline copy holds replaces that entry at once, with Undo; every → says what it did', () => {
  savePatch({ ...FM1_PRESETS[names[1]](), name: names[1], notes: 'mine' });
  const root = document.createElement('div');
  buildPatchesSection(root, fakeDevice(false), { remove: () => {} });
  const [browser, fm1] = cols(root);
  const factoryTag = (): boolean => !!fm1.querySelectorAll('.bank-row')[1].querySelector('.muted');
  expect(factoryTag()).toBe(true);
  button(browser.querySelector('.bank-row')!, '→').click();
  expect(rows(fm1)).toEqual(names);
  expect(factoryTag()).toBe(false);
  expect(JSON.parse(localStorage.getItem('matryoshka.bank')!)[1].patch.notes).toBe('mine');
  const toast = document.querySelector('.toast')!;
  expect(toast.textContent).toContain(`"${names[1]}" replaced in slot 02`);
  button(toast, 'Undo').click();
  expect(factoryTag()).toBe(true);
  expect(JSON.parse(localStorage.getItem('matryoshka.bank')!)[1]).toEqual({ name: names[1] });
  // a new name goes to the next slot, and says so
  savePatch({ ...FM1_PRESETS[names[0]](), name: 'Other' });
  const other = [...browser.querySelectorAll('.bank-row')].find((r) => r.querySelector('.grow')!.textContent === 'Other')!;
  button(other, '→').click();
  expect(rows(fm1)).toEqual([...names, 'Other']);
  expect(document.querySelector('.toast')!.textContent).toContain('"Other" added to the bank, slot 03');
});

it('with an FM-1, → onto a used slot of that name asks first and says what it did', async () => {
  const dev = fakeDevice(true);
  await dev.uploadSlot(0, 'MINE', FM1_PRESETS[names[0]]());
  savePatch({ ...FM1_PRESETS[names[1]](), name: 'Mine' });
  const root = document.createElement('div');
  const pane = buildPatchesSection(root, dev, { remove: () => {} });
  pane.enter();
  await flush();
  const asked: string[] = [];
  vi.stubGlobal('confirm', (q: string) => (asked.push(q), true));
  button(cols(root)[0].querySelector('.bank-row')!, '→').click();
  await flush();
  await flush();
  expect(asked[0]).toContain('slot 01');
  expect(document.querySelector('.toast')!.textContent).toContain('"Mine" replaced FM-1 slot 01');
  vi.unstubAllGlobals();
});

it('slots show as 01..64: the first is 01, the last 64, and erasing the row shown as 01 erases slot 0', async () => {
  expect([slotLabel(0), slotLabel(SLOTS - 1)]).toEqual(['01', '64']);
  const dev = fakeDevice(true);
  await dev.uploadSlot(0, 'FIRST', FM1_PRESETS[names[0]]());
  await dev.uploadSlot(SLOTS - 1, 'LAST', FM1_PRESETS[names[1]]());
  const root = document.createElement('div');
  const pane = buildPatchesSection(root, dev, { remove: () => {} });
  pane.enter();
  await flush();
  const fm1 = cols(root)[1];
  const shown = [...fm1.querySelectorAll('.bank-row')].map((r) => [r.querySelector('.slot')!.textContent, r.querySelector('.grow')!.textContent]);
  expect(shown).toEqual([['01', 'FIRST'], ['64', 'LAST']]);
  const asked: string[] = [];
  vi.stubGlobal('confirm', (q: string) => (asked.push(q), true));
  button(fm1.querySelector('.bank-row')!, '×').click();
  await flush();
  await flush();
  expect(asked[0]).toContain('slot 01');
  expect(dev.slots[0].used).toBe(false);
  expect(dev.slots[SLOTS - 1].used).toBe(true);
  vi.unstubAllGlobals();
});

it('lists the community patches added to Your patches with their authors; Remove un-adds one, with Undo', async () => {
  const [c] = await loadCommunity();
  localStorage.setItem('matryoshka.community-added', JSON.stringify([c.entry.title]));
  const root = document.createElement('div');
  buildPatchesSection(root, fakeDevice(false), { remove: () => {} });
  const browser = cols(root)[0];
  const row = [...browser.querySelectorAll('.bank-row')].find((r) => r.querySelector('.grow')!.textContent === `${c.entry.title} · ${c.entry.author}`)!;
  expect(row).toBeDefined();
  button(row, 'Remove').click();
  expect(addedTitles()).toEqual([]);
  expect(rows(browser)).not.toContain(`${c.entry.title} · ${c.entry.author}`);
  // saved under its name, it is the user's own: listed once, as a saved patch
  localStorage.setItem('matryoshka.community-added', JSON.stringify([c.entry.title]));
  savePatch({ ...c.patch!, name: c.entry.title });
  expect(rows(cols(root)[0]).filter((r) => r.startsWith(c.entry.title))).toEqual([c.entry.title]);
});
