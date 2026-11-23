// SPDX-License-Identifier: GPL-3.0-only
// @vitest-environment jsdom
// Library > Patterns (#901): the selected pattern beside the FM-1's pattern store, against a stand-in FM-1
import { beforeEach, expect, it, vi } from 'vitest';
import type { DeviceLink } from './device';
import { DEFS } from './modules';
import { addModule, connect, emptyPatch, type Patch } from './patch';
import { buildPatternsSection, LOCKS_LEFT_OUT } from './pattern-library';
import { applyPayload, encodePayload, entryName, factoryEntries, fnv, FNV0 } from './pattern-store';
import type { StoredPatternEntry } from './protocol';
import type { PatternLink } from './track';

function patch(): Patch {
  const p = emptyPatch('Groove');
  addModule(p, DEFS.fm1, 0, 0);
  const out = addModule(p, DEFS.output, 0, 0);
  const st = addModule(p, DEFS.steps, 0, 0);
  connect(p, DEFS, { module: st.id, port: 'pitch' }, { module: out.id, port: 'l' });
  st.patterns = [null, { notes: [{ at: 0, len: 1, note: 40, vel: 100 }] }];
  return p;
}

/** an FM-1 with a pattern store in memory; `every`: one that stores every pattern 2..64 (1.26) */
function fakeDevice(connected: boolean, every = false) {
  const store = new Map<number, { name: string; payload: Uint8Array; kept?: boolean }>();
  let next = 1, used = 0;
  const list = (): StoredPatternEntry[] => [...store].map(([id, e]) => ({ id, name: e.name, len: e.payload.length, hash: fnv(FNV0, e.payload), layout: 0, tracks: 1, readOnly: false }));
  const dev = {
    get connected() { return connected; },
    hasPatternStore: connected,
    patternsStored: connected && every,
    info: { store: { free: 9000, total: 12000 } },
    listPatterns: async () => [...list(), ...factoryEntries().slice(0, 2)],
    getPattern: async (id: number) => store.get(id)?.payload ?? null,
    putPattern: async (id: number, name: string, payload: Uint8Array, kept = false) => { const at = id || next++; store.set(at, { name, payload, kept }); return at; },
    deletePattern: async (id: number, force: boolean) => (used && !force ? { deleted: false, used } : (store.delete(id), { deleted: true, used: 0 })),
  };
  return { dev: dev as unknown as DeviceLink, store, setUsed: (n: number) => { used = n; } };
}
const flush = async (): Promise<void> => { for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0)); };
const rows = (root: HTMLElement, col: number): HTMLElement[] => [...root.querySelectorAll<HTMLElement>('.lib-col')[col].querySelectorAll<HTMLElement>('.bank-row')];
const button = (el: Element, text: string): HTMLButtonElement => [...el.querySelectorAll('button')].find((b) => b.textContent === text)!;
/** the buttons the This patch column's foot shows */
const foot = (root: HTMLElement): string[] => [...root.querySelectorAll<HTMLButtonElement>('.lib-foot button')].filter((b) => !b.hidden).map((b) => b.textContent!);

function section(connected: boolean, pattern = 2, every = false) {
  const p = patch();
  const loads: [number, PatternLink | null][] = [];
  const links: [number, PatternLink | null][] = [];
  const fake = fakeDevice(connected, every);
  const root = document.createElement('div');
  document.body.append(root);
  const pane = buildPatternsSection(root, fake.dev, {
    patch: () => p,
    pattern: () => pattern,
    load: (at, payload, link) => { loads.push([at, link]); return applyPayload(p, at, payload); },
    link: (at, link) => {
      links.push([at, link]);
      const main = p.modules.find((m) => m.type === 'fm1')!;
      main.seq = { links: { ...main.seq?.links, ...(link ? { [at]: link } : {}) } };
    },
  });
  return { p, root, pane, loads, links, ...fake };
}

beforeEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

it('without an FM-1 it lists the factory patterns, which load as copies; saving waits for an FM-1', () => {
  const { root, loads } = section(false);
  const listed = rows(root, 1);
  expect(listed).toHaveLength(factoryEntries().length);
  expect(listed[0].textContent).toContain('factory');
  expect(button(root, 'Save to FM-1').disabled).toBe(true);
  button(listed[0], 'Load').click();
  return flush().then(() => expect(loads).toEqual([[2, null]]));
});

it('Save as new stores the selected pattern under the name given and links it; Save then writes over that entry', async () => {
  const { root, pane, store, links, p } = section(true);
  pane.enter();
  await flush();
  vi.stubGlobal('prompt', () => 'my groove');
  vi.stubGlobal('confirm', () => true);
  button(root, 'Save as new').click();
  await flush();
  const payload = encodePayload(p, 2);
  expect([...store.values()].map((e) => e.name)).toEqual(['MY GROOVE']);
  expect(links).toEqual([[2, { id: 1, hash: fnv(FNV0, payload) }]]);
  expect(rows(root, 1)[0].textContent).toContain('linked as P03');
  p.modules.find((m) => m.type === 'steps')!.patterns![1]!.notes!.push({ at: 4, len: 1, note: 43, vel: 100 });
  pane.refresh();
  expect(rows(root, 0)[0].textContent).toContain('edited');
  button(root, 'Save to FM-1').click();
  await flush();
  expect(store.size).toBe(1);
  expect(Array.from(store.get(1)!.payload)).toEqual(Array.from(encodePayload(p, 2)));
});

it('Load links a user entry into pattern 2..64 when it comes out as stored, and says when locks were left out', async () => {
  const { root, pane, store, loads } = section(true);
  const other = patch();
  other.modules.find((m) => m.type === 'steps')!.patterns = [null, { notes: [{ at: 3, len: 2, note: 50, vel: 127 }] }];
  store.set(4, { name: 'BEAT', payload: encodePayload(other, 2) });
  pane.enter();
  await flush();
  button(rows(root, 1)[0], 'Load').click();
  await flush();
  expect(loads).toEqual([[2, { id: 4, hash: fnv(FNV0, store.get(4)!.payload) }]]);
  expect(LOCKS_LEFT_OUT).toMatch(/another patch layout/);
});

it('Delete asks, and asks again with how many slots use a pattern the bank links', async () => {
  const { root, pane, store, setUsed } = section(true);
  store.set(3, { name: 'SHARED', payload: encodePayload(patch(), 2) });
  setUsed(2);
  pane.enter();
  await flush();
  const asked: string[] = [];
  vi.stubGlobal('confirm', (q: string) => (asked.push(q), true));
  button(rows(root, 1)[0], 'Delete').click();
  await flush();
  expect(asked).toHaveLength(2);
  expect(asked[1]).toContain('used by 2 slots');
  expect(store.size).toBe(0);
});

it('an FM-1 before 1.26 keeps Save to FM-1, Save as new and Upload file', async () => {
  const { root, pane } = section(true);
  pane.enter();
  await flush();
  expect(foot(root)).toEqual(['Save to FM-1', 'Save as new', 'Upload file…']);
});

it('a 1.26 FM-1 offers Load, Keep a copy and Load file; Keep a copy stores a kept entry no pattern links (#1202 P1, P3)', async () => {
  const { root, pane, store, links, p } = section(true, 2, true);
  pane.enter();
  await flush();
  expect(foot(root)).toEqual(['Keep a copy', 'Load file…']);
  expect(button(rows(root, 1)[0], 'Load')).toBeTruthy();
  let offered = '';
  vi.stubGlobal('prompt', (_q: string, name: string) => ((offered = name), name));
  button(root, 'Keep a copy').click();
  await flush();
  expect(offered).toBe(entryName('Groove', 2));
  expect([...store.values()]).toEqual([{ name: 'GROOVE P03', payload: encodePayload(p, 2), kept: true }]);
  expect(links).toEqual([]);
  expect(rows(root, 1)[0].textContent).toContain('GROOVE P03');
});
