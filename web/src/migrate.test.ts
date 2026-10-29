import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  acceptKeys, backupFile, backupKeys, BACKUP_FORMAT, collectKeys, importSummary, MIGRATE_DATA, MIGRATE_DONE, MIGRATE_FROM, MIGRATE_READY, MOVE_OFFER,
  planImport, receiveMigration, sendMigration, withoutMigrate,
} from './migrate';

const store = (o: Record<string, string>) => (k: string): string | null => (k in o ? o[k] : null);
const patch = (name: string, extra = 0) => ({ name, modules: [{ id: extra }] });
const saved = (name: string, extra = 0, at = 1) => ({ name, patch: patch(name, extra), saved: at });

describe('acceptKeys', () => {
  it('takes only matryoshka.* and modular-1.* keys with string values', () => {
    expect(acceptKeys({ 'matryoshka.patch': '{}', 'matryoshka.theme': 'dark', other: 'x', 'matryoshka.n': 3, 'matryoshkaX.y': 'z', '__proto__.x': 'a' }))
      .toEqual({ 'matryoshka.patch': '{}', 'matryoshka.theme': 'dark' });
    expect(acceptKeys(null)).toEqual({});
    expect(acceptKeys(['matryoshka.patch'])).toEqual({});
    expect(acceptKeys('matryoshka.patch')).toEqual({});
  });
  it('reads a legacy modular-1.* key as matryoshka.*, unless the new name is there too', () => {
    expect(acceptKeys({ 'modular-1.bank': 'old', 'modular-1.patch': 'legacy', 'matryoshka.patch': 'new' }))
      .toEqual({ 'matryoshka.bank': 'old', 'matryoshka.patch': 'new' });
  });
});

describe('backupKeys', () => {
  it('reads the forwarder backup file, and nothing else', () => {
    expect(backupKeys({ format: BACKUP_FORMAT, version: 1, keys: { 'matryoshka.theme': 'light', evil: 'x' } })).toEqual({ 'matryoshka.theme': 'light' });
    expect(backupKeys({ name: 'a patch', modules: [] })).toBeNull();
    expect(backupKeys(null)).toBeNull();
  });
});

describe('planImport', () => {
  it('takes everything into an empty storage', () => {
    const incoming = {
      'matryoshka.patch': JSON.stringify(patch('Acid')),
      'matryoshka.patches': JSON.stringify([saved('Acid'), saved('Pad')]),
      'matryoshka.theme': 'light',
      'matryoshka.tutorial': '{"done":[1]}',
    };
    const plan = planImport(incoming, store({}), () => false);
    expect(plan.writes).toEqual(incoming);
    expect(plan.kept).toEqual([]);
    expect(importSummary(plan, 'glvno.github.io')).toBe('Brought over from glvno.github.io: the open patch, the tutorial progress, 2 of Your patches, 1 setting.');
  });

  it('takes a value the app wrote after the page started (the starter patch), keeps one that was there', () => {
    const incoming = { 'matryoshka.patch': JSON.stringify(patch('Old')), 'matryoshka.theme': 'light' };
    const here = { 'matryoshka.patch': JSON.stringify(patch('Starter')), 'matryoshka.theme': 'dark' };
    const plan = planImport(incoming, store(here), (k) => k === 'matryoshka.theme');
    expect(plan.writes).toEqual({ 'matryoshka.patch': incoming['matryoshka.patch'] });
    expect(plan.kept).toEqual(['1 setting']);
  });

  it('keeps an open patch the user had here, and puts the old one into Your patches', () => {
    const incoming = { 'matryoshka.patch': JSON.stringify(patch('Old')) };
    const here = { 'matryoshka.patch': JSON.stringify(patch('Mine')), 'matryoshka.patches': JSON.stringify([saved('Mine')]) };
    const plan = planImport(incoming, store(here), () => true);
    expect(plan.writes['matryoshka.patch']).toBeUndefined();
    const list = JSON.parse(plan.writes['matryoshka.patches']) as { name: string }[];
    expect(list.map((e) => e.name)).toEqual(['Mine', 'Old']);
    expect(plan.kept).toEqual(['the open patch (the old one is in Your patches)']);
  });

  it('merges Your patches by name: new ones added, identical ones skipped, a different one under the same name kept as a copy', () => {
    const here = { 'matryoshka.patches': JSON.stringify([saved('A', 0, 5), saved('B', 0), saved('B (old site)', 9)]) };
    const incoming = { 'matryoshka.patches': JSON.stringify([saved('A', 0, 1), saved('B', 1), saved('C')]) };
    const plan = planImport(incoming, store(here), () => true);
    const list = JSON.parse(plan.writes['matryoshka.patches']) as { name: string; patch: { name: string }; saved: number }[];
    expect(list.map((e) => e.name)).toEqual(['A', 'B', 'B (old site)', 'B (old site 2)', 'C']);
    expect(list[3].patch.name).toBe('B (old site 2)');
    expect(list[0].saved).toBe(5);   // the identical one (only its date differs) is not added again
    expect(plan.brought).toEqual(['2 of Your patches']);
  });

  it('merges the library by name the same way', () => {
    const here = { 'matryoshka.assemblies': JSON.stringify([{ name: 'Kit', v: 1 }]) };
    const incoming = { 'matryoshka.assemblies': JSON.stringify([{ name: 'Kit', v: 2 }, { name: 'Pad', v: 1 }]) };
    const list = JSON.parse(planImport(incoming, store(here), () => true).writes['matryoshka.assemblies']) as { name: string }[];
    expect(list.map((e) => e.name)).toEqual(['Kit', 'Kit (old site)', 'Pad']);
  });

  it('adds to the FM-1 bank without replacing a slot of the same name, up to the 64 slots', () => {
    const here = { 'matryoshka.bank': JSON.stringify(Array.from({ length: 63 }, (_, i) => ({ name: `P${i}` }))) };
    const incoming = { 'matryoshka.bank': JSON.stringify([{ name: 'P0', patch: patch('P0', 7) }, { name: 'New' }, { name: 'Late' }]) };
    const plan = planImport(incoming, store(here), () => true);
    const list = JSON.parse(plan.writes['matryoshka.bank']) as { name: string }[];
    expect(list).toHaveLength(64);
    expect(list[0]).toEqual({ name: 'P0' });
    expect(list[63].name).toBe('New');
    expect(plan.brought).toEqual(['1 FM-1 bank entry']);
    expect(plan.kept).toEqual(['2 FM-1 bank entries (the one here or no room)']);
  });

  it('takes the bank as it was when there is none here', () => {
    const bank = JSON.stringify([{ name: 'X' }]);
    expect(planImport({ 'matryoshka.bank': bank }, store({}), () => false).writes).toEqual({ 'matryoshka.bank': bank });
  });

  it('writes nothing for what is already here', () => {
    const here = { 'matryoshka.theme': 'dark', 'matryoshka.patches': JSON.stringify([saved('A')]) };
    const plan = planImport({ ...here }, store(here), () => true);
    expect(plan.writes).toEqual({});
    expect(importSummary(plan, 'x')).toBe('Nothing new to bring over from x: it is all here already.');
  });

  it('treats a list it cannot read as a value', () => {
    const plan = planImport({ 'matryoshka.patches': 'not json' }, store({}), () => false);
    expect(plan.writes).toEqual({ 'matryoshka.patches': 'not json' });
  });
});

describe('the hand-off', () => {
  it('trusts only the earlier addresses by default', () => {
    expect(MIGRATE_FROM).toEqual(['https://glvno.github.io', 'https://matry0shka.pages.dev']);
  });
  it('strips migrate=1 and keeps the rest of the address', () => {
    expect(withoutMigrate('https://matryoshka.lol/?migrate=1&x=2#p=abc')).toBe('/?x=2#p=abc');
    expect(withoutMigrate('https://matryoshka.lol/brand/?migrate=1')).toBe('/brand/');
  });
});

describe('collecting and backing up', () => {
  const storage = (o: Record<string, string>) => ({ length: Object.keys(o).length, key: (i: number) => Object.keys(o)[i] ?? null, getItem: (k: string) => o[k] ?? null });
  it("collects the app's keys, never the move offer's memory", () => {
    const keys = collectKeys(storage({ 'matryoshka.patch': '{}', [MOVE_OFFER]: 'later', other: 'x', 'modular-1.theme': 'dark' }));
    expect(keys).toEqual({ 'matryoshka.patch': '{}', 'matryoshka.theme': 'dark' });
    expect(acceptKeys({ [MOVE_OFFER]: 'moved' })).toEqual({});
  });
  it('collects nothing when storage is blocked', () => {
    expect(collectKeys({ get length(): number { throw new Error('blocked'); }, key: () => null, getItem: () => null })).toEqual({});
  });
  it('writes a backup file that Load .json reads back', () => {
    const file = backupFile({ 'matryoshka.patch': '{}' }, 'https://matry0shka.pages.dev', new Date('2026-10-26T00:00:00Z'));
    expect(file).toMatchObject({ format: BACKUP_FORMAT, version: 1, from: 'https://matry0shka.pages.dev', saved: '2026-10-26T00:00:00.000Z' });
    expect(backupKeys(JSON.parse(JSON.stringify(file)))).toEqual({ 'matryoshka.patch': '{}' });
  });
});

/** a window that records its posts and hands messages to its listeners */
function fakeWindow(origin: string) {
  const listeners: ((e: MessageEvent) => void)[] = [];
  const self = {
    origin,
    posts: [] as { data: unknown; target: string }[],
    addEventListener: (_: string, f: (e: MessageEvent) => void) => listeners.push(f),
    removeEventListener: (_: string, f: (e: MessageEvent) => void) => listeners.splice(listeners.indexOf(f), 1),
    /** deliver `data` from window `source` at `from` */
    hear: (data: unknown, from: string, source: unknown) => [...listeners].forEach((f) => f({ data, origin: from, source } as MessageEvent)),
    listeners,
  };
  return self;
}

describe('the hand-off between windows', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('the receiver asks every earlier address and takes the data from the one that answers', () => {
    const opener = { posts: [] as { data: unknown; target: string }[], postMessage(data: unknown, target: string) { this.posts.push({ data, target }); } };
    const win = Object.assign(fakeWindow('https://matryoshka.lol'), { opener, setTimeout: () => 0 });
    vi.stubGlobal('window', win);
    vi.stubGlobal('location', new URL('https://matryoshka.lol/?migrate=1#p=x'));
    vi.stubGlobal('history', { state: null, replaceState: vi.fn() });
    const got: [Record<string, string>, string][] = [];
    expect(receiveMigration((keys, origin) => got.push([keys, origin]), MIGRATE_FROM, 1000)).toBe(true);
    expect(opener.posts).toEqual(MIGRATE_FROM.map((target) => ({ data: { type: MIGRATE_READY }, target })));
    win.hear({ type: MIGRATE_DATA, keys: { 'matryoshka.patch': 'evil' } }, 'https://evil.example', opener);
    win.hear({ type: MIGRATE_DATA, keys: { 'matryoshka.patch': 'other window' } }, 'https://matry0shka.pages.dev', {});
    expect(got).toEqual([]);
    win.hear({ type: MIGRATE_DATA, keys: { 'matryoshka.patch': '{}' } }, 'https://matry0shka.pages.dev', opener);
    expect(got).toEqual([[{ 'matryoshka.patch': '{}' }, 'https://matry0shka.pages.dev']]);
    expect(opener.posts.at(-1)).toEqual({ data: { type: MIGRATE_DONE }, target: 'https://matry0shka.pages.dev' });
    expect(win.listeners).toHaveLength(0);
  });

  it('the sender opens the new address with migrate=1 and answers only that tab', () => {
    const tab = { posts: [] as { data: unknown; target: string }[], postMessage(data: unknown, target: string) { this.posts.push({ data, target }); } };
    const open = vi.fn(() => tab);
    const win = Object.assign(fakeWindow('https://matry0shka.pages.dev'), { open });
    vi.stubGlobal('window', win);
    const states: string[] = [];
    expect(sendMigration('https://matryoshka.lol/', () => ({ 'matryoshka.patch': '{}' }), (s) => states.push(s))).toBe(true);
    expect(open).toHaveBeenCalledWith('https://matryoshka.lol/?migrate=1', '_blank');
    win.hear({ type: MIGRATE_READY }, 'https://matryoshka.lol', {});
    win.hear({ type: MIGRATE_READY }, 'https://evil.example', tab);
    expect(tab.posts).toEqual([]);
    win.hear({ type: MIGRATE_READY }, 'https://matryoshka.lol', tab);
    expect(tab.posts).toEqual([{ data: { type: MIGRATE_DATA, keys: { 'matryoshka.patch': '{}' } }, target: 'https://matryoshka.lol' }]);
    win.hear({ type: MIGRATE_DONE }, 'https://matryoshka.lol', tab);
    expect(states).toEqual(['sending', 'done']);
    expect(win.listeners).toHaveLength(0);
  });

  it('the sender says so when the browser blocks the tab', () => {
    vi.stubGlobal('window', Object.assign(fakeWindow('https://matry0shka.pages.dev'), { open: () => null }));
    expect(sendMigration('https://matryoshka.lol/', () => ({}), () => {})).toBe(false);
  });
});
