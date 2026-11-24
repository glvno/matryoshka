// SPDX-License-Identifier: GPL-3.0-only
// The candidate sets per patch (candidate-store.ts, D-972 as amended): which set holds a patch, which sets are worth
// keeping, the 8 most recently opened, the writes in order and without Recently deleted, the check on load, the backends,
// and today's localStorage record of the open patch's candidates as a set.
import { describe, expect, it } from 'vitest';
import { CandidateStore, idbBackend, legacySet, memoryBackend, SET_LIMIT, worthKeeping, type SetBackend } from './candidate-store';
import { relocatedPatches } from './community-factory';
import { DEFS } from './modules';
import { validatePatch, type Patch } from './patch';
import type { CandidateSet, Snapshot } from './snapshots';

const patch = (name: string, x = 0, extra: Record<string, unknown> = {}): Patch =>
  ({ version: 2, name, modules: [{ id: 1, type: 'osc', x, y: 0, params: {} }], cables: [], ...extra }) as unknown as Patch;
/** a stand-in for validatePatch: a patch marked bad fails */
const validate = (p: unknown): Patch => {
  if (!p || (p as { bad?: boolean }).bad) throw new Error('bad patch');
  return p as Patch;
};
const cand = (letter: string, p: Patch, original: Patch = p): Snapshot => ({ letter, patch: JSON.stringify(p), original: JSON.stringify(original) });
const set = (id: string, name: string, list: Snapshot[], opened = 0): CandidateSet =>
  ({ id, name, list, current: list[0]?.letter ?? 'A', given: list.length, opened });
/** a set worth keeping: two candidates */
const two = (id: string, name = id, opened = 0): CandidateSet => set(id, name, [cand('A', patch(name)), cand('B', patch(name, 0, { tag: id }))], opened);

/** a backend recording each call; each write lands after `delay` ms (the first one slowest, so an unserialized second write
 *  would land first) */
function recorder(seed: CandidateSet[] = []) {
  const landed: string[] = [];
  const written: CandidateSet[] = [];
  let n = 0;
  const backend: SetBackend = {
    load: async () => structuredClone(seed),
    put: (s) => new Promise((r) => setTimeout(() => { landed.push(`put ${s.id} ${s.list.length}`); written.push(s); r(); }, n++ === 0 ? 30 : 1)),
    delete: (id) => new Promise((r) => setTimeout(() => { landed.push(`delete ${id}`); r(); }, n++ === 0 ? 30 : 1)),
  };
  return { backend, landed, written };
}

const settle = () => new Promise((r) => setTimeout(r, 60));

describe('candidate sets per patch (D-972 as amended)', () => {
  it('a set is worth keeping with 2 or more candidates, or one tweaked; layout and name are not tweaks', () => {
    const p = patch('Pad');
    expect(worthKeeping(set('s', 'Pad', [cand('A', p)]))).toBe(false);
    expect(worthKeeping(set('s', 'Pad', [cand('A', patch('Moved', 40), p)]))).toBe(false);
    expect(worthKeeping(set('s', 'Pad', [cand('A', patch('Pad', 0, { tag: 1 }), p)]))).toBe(true);
    expect(worthKeeping(set('s', 'Pad', [cand('A', p), cand('B', p)]))).toBe(true);
  });

  it('find: a candidate holding the patch beats a set with its name; most recently opened first; `except` skipped', async () => {
    const store = new CandidateStore(memoryBackend(), validate);
    await store.ready;
    const p = patch('Bass', 0, { tag: 'deep' });
    store.save(set('old', 'Bass', [cand('A', patch('Bass')), cand('B', p)], 1));
    store.save(set('new', 'Other', [cand('A', patch('Other')), cand('C', patch('Bass', 30, { tag: 'deep' }))], 2));
    store.save(set('named', ' bass ', [cand('A', patch('x')), cand('B', patch('y'))], 3));
    // the same version (layout aside) in the newer set; the set named BASS, newer still, only has the name
    expect(store.find(p)).toMatchObject({ set: { id: 'new' }, letter: 'C' });
    expect(store.find(p, 'new')).toMatchObject({ set: { id: 'old' }, letter: 'B' });
    // another name: not the same version; the name matches trimmed and case-insensitive
    expect(store.find(patch('BASS', 0, { tag: 'deep' }))).toMatchObject({ set: { id: 'named' }, letter: null });
    expect(store.find(patch('BASS', 0, { tag: 'deep' }), 'named')).toMatchObject({ set: { id: 'old' }, letter: null });
    expect(store.find(patch('Nobody'))).toBeNull();
    expect(store.find(patch('  '))).toBeNull();
    expect(store.all().map((s) => s.id)).toEqual(['named', 'new', 'old']);
  });

  it('save stores a copy; a set not worth keeping is removed instead; opened is later than every stored set', async () => {
    const store = new CandidateStore(memoryBackend(), validate);
    await store.ready;
    const s = two('a', 'A', Date.now() + 1000);
    expect(store.save(s)).toBeNull();
    s.name = 'changed';
    expect(store.get('a')!.name).toBe('A');
    const b = two('b');
    store.save(b, { opened: true });
    expect(b.opened).toBeGreaterThan(store.get('a')!.opened);
    expect(store.get('b')!.opened).toBe(b.opened);
    expect(store.all()[0].id).toBe('b');
    store.save(set('a', 'A', [cand('A', patch('A'))]));
    expect(store.get('a')).toBeUndefined();
  });

  it('beyond 8 sets the least recently opened other than the one stored is put away and returned; Undo puts it back just older than the newest', async () => {
    const store = new CandidateStore(memoryBackend(), validate);
    await store.ready;
    for (let i = 0; i < SET_LIMIT; i++) expect(store.save(two(`s${i}`, `S${i}`, 10 + i))).toBeNull();
    // a 9th stored with an old opened is not taken itself: the oldest other one is
    const ninth = two('s8', 'S8', 1);
    const out = store.save(ninth);
    expect(out!.id).toBe('s0');
    expect(store.get('s0')).toBeUndefined();
    expect(store.all()).toHaveLength(SET_LIMIT);
    store.restore(out!);
    expect(store.get('s0')!.opened).toBeLessThan(store.all()[0].opened);
    expect(store.all()[1].id).toBe('s0');
    // the next one put away is another (the oldest: the 9th, opened at 1)
    expect(store.save(two('s9', 'S9'), { opened: true })!.id).toBe('s8');
    expect(store.get('s0')).toBeDefined();
  });

  it('the writes of a set land in order, and Recently deleted is never written but stays in memory', async () => {
    const { backend, landed, written } = recorder();
    const store = new CandidateStore(backend, validate);
    await store.ready;
    const s = two('a');
    s.deleted = [{ s: cand('C', patch('a')), at: 1 }];
    store.save(s);                    // slow
    store.save({ ...two('a'), list: [...two('a').list, cand('D', patch('a'))] });
    store.remove('a');
    store.save(two('b'));
    await settle();
    expect(landed).toEqual(['put b 2', 'put a 2', 'put a 3', 'delete a']);
    expect(written.every((w) => !('deleted' in w))).toBe(true);
    const c = two('c');
    c.deleted = [{ s: cand('C', patch('c')), at: 2 }];
    store.save(c);
    expect(store.get('c')!.deleted).toBe(c.deleted);
    await settle();
    expect(written.at(-1)!.id).toBe('c');
    expect('deleted' in written.at(-1)!).toBe(false);
  });

  it('on load each patch is checked: a failing candidate is dropped, a set left empty or not worth keeping is dropped, current fixed', async () => {
    const good = two('good');
    const mixed = set('mixed', 'M', [cand('A', patch('M')), cand('B', patch('M', 0, { bad: true })), cand('C', patch('M'), patch('M', 0, { tag: 1 }))]);
    mixed.current = 'B';
    const empty = set('empty', 'E', [cand('A', patch('E', 0, { bad: true })), cand('B', patch('E'), patch('E', 0, { bad: true }))]);
    const junk = { id: 'junk', name: 'J', list: [{ letter: 'A', patch: 'not json', original: 'not json' }] } as unknown as CandidateSet;
    const store = new CandidateStore(memoryBackend([good, mixed, empty, junk]), validate);
    await store.ready;
    expect(store.all().map((s) => s.id).sort()).toEqual(['good', 'mixed']);
    expect(store.get('mixed')!.list.map((c) => c.letter)).toEqual(['A', 'C']);
    expect(store.get('mixed')!.current).toBe('A');
  });

  it('a backend that fails to load leaves the store empty and working; sets saved before the load landed win', async () => {
    const broken: SetBackend = { load: () => Promise.reject(new Error('blocked')), put: async () => {}, delete: async () => {} };
    const store = new CandidateStore(broken, validate);
    await expect(store.ready).resolves.toBeUndefined();
    expect(store.all()).toEqual([]);
    const throwing: SetBackend = { ...broken, load: () => { throw new Error('sync'); } };
    await expect(new CandidateStore(throwing, validate).ready).resolves.toBeUndefined();
    const early = new CandidateStore(memoryBackend([two('a', 'loaded'), two('b')]), validate);
    early.save(two('a', 'mine'));
    early.remove('b');
    await early.ready;
    expect(early.get('a')!.name).toBe('mine');
    expect(early.get('b')).toBeUndefined();
    expect(new CandidateStore(null, validate).all()).toEqual([]);
  });
});

/** just enough of IndexedDB for idbBackend: one database, its object stores by keyPath id, callbacks a tick later */
function fakeIndexedDb(): IDBFactory {
  const data = new Map<string, unknown>();
  const stores = new Set<string>();
  const later = (f: () => void) => setTimeout(f, 0);
  const db = {
    objectStoreNames: { contains: (n: string) => stores.has(n) },
    createObjectStore: (n: string) => void stores.add(n),
    transaction: () => {
      const tx: Record<string, unknown> = {};
      tx.objectStore = () => ({
        put: (v: { id: string }) => void data.set(v.id, structuredClone(v)),
        delete: (id: string) => void data.delete(id),
        getAll: () => {
          const req: Record<string, unknown> = {};
          later(() => { req.result = [...data.values()].map((v) => structuredClone(v)); (req.onsuccess as () => void)(); });
          return req;
        },
      });
      later(() => (tx.oncomplete as () => void)?.());
      return tx;
    },
  };
  return {
    open: () => {
      const req: Record<string, unknown> = {};
      later(() => {
        req.result = db;
        if (!stores.size) (req.onupgradeneeded as () => void)();
        (req.onsuccess as () => void)();
      });
      return req;
    },
  } as unknown as IDBFactory;
}

describe('backends', () => {
  it('IndexedDB: a put, a delete and a load round trip; none without IndexedDB; memory when it does not open', async () => {
    const b = idbBackend(fakeIndexedDb())!;
    await b.put(two('a'));
    await b.put(two('b'));
    await b.delete('a');
    expect((await b.load()).map((s) => s.id)).toEqual(['b']);
    expect(idbBackend(undefined)).toBeNull();
    const failing = idbBackend({ open: () => { throw new Error('SecurityError'); } } as unknown as IDBFactory)!;
    await failing.put(two('c'));
    expect((await failing.load()).map((s) => s.id)).toEqual(['c']);
  });

  it('memory: copies in and out', async () => {
    const seed = two('a');
    const b = memoryBackend([seed]);
    seed.name = 'changed';
    const [loaded] = await b.load();
    expect(loaded.name).toBe('a');
    loaded.name = 'again';
    expect((await b.load())[0].name).toBe('a');
  });
});

describe('the record from before 1.26.4 as a set', () => {
  const fnv = (s: string): string => {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
    return (h >>> 0).toString(36);
  };
  const check = (p: unknown): Patch => validatePatch(p, DEFS);

  it('kept beside the remembered patch, the candidates come back for that patch only, A the patch itself (D-972)', () => {
    const p = relocatedPatches['Oracle V']();
    const text = JSON.stringify(p);
    const b = JSON.stringify(check(p));
    const bright = JSON.stringify(check({ ...p, name: 'bright' }));
    const list = [
      { letter: 'B', patch: b, mark: 'keep' },
      { letter: 'C', patch: bright, name: 'bright', from: 'B', aim: { kind: 'pad', fits: false } },
      { letter: 'D', patch: JSON.stringify({ broken: true }), from: 'B' },
    ];
    const record = JSON.stringify({ patch: fnv(text), v: 2, list });
    const s = legacySet(record, text, check)!;
    expect(s.current).toBe('A');
    expect(s.name).toBe(p.name);
    expect(s.given).toBe(3);
    expect(s.opened).toBeGreaterThan(0);
    expect(typeof s.id).toBe('string');
    // (the candidate that fails the check is dropped; rank and cut's keep mark is dropped too)
    expect(s.list).toEqual([
      { letter: 'A', name: p.name, patch: b, original: b, from: 'opened' },
      { letter: 'B', patch: b, original: b },
      { letter: 'C', name: 'bright', patch: bright, original: bright, from: 'B', aim: { kind: 'pad', fits: false } },
    ]);
    expect(legacySet(record, JSON.stringify({ ...p, name: 'another' }), check)).toBeNull();
    expect(legacySet(record, null, check)).toBeNull();
    expect(legacySet(null, text, check)).toBeNull();
    expect(legacySet('not json', text, check)).toBeNull();
    expect(legacySet(JSON.stringify({ patch: fnv(text), v: 2, list: [] }), text, check)).toBeNull();
    expect(legacySet(JSON.stringify({ patch: fnv(text), v: 2, list: [list[2]] }), text, check)).toBeNull();
  });

  it('candidates stored before A was the current patch are lettered once more, each moving on by one, so A is the remembered patch alone (#1048)', () => {
    const p = relocatedPatches['Oracle V']();
    const text = JSON.stringify(p);
    const patch = JSON.stringify(check(p));
    // a record as 1.18.3's editor wrote it: no lettering, the first candidate lettered A, `current` for the current patch
    const before = [
      { letter: 'A', patch, name: 'before mutate' },
      { letter: 'B', patch, from: 'current', mark: 'keep' },
      { letter: 'C', patch, from: 'A' },
      { letter: 'Z', patch, from: 'A+B' },
    ];
    const once = legacySet(JSON.stringify({ patch: fnv(text), list: before }), text, check)!;
    expect(once.list.map((s) => [s.letter, s.from, s.name])).toEqual([
      ['A', 'opened', p.name],
      ['B', 'mutate', 'before mutate'],
      ['C', 'A', undefined],
      ['D', 'B', undefined],
      ['AA', 'B+C', undefined],
    ]);
    expect(once.given).toBe(27);
    // with the new lettering it reads as it is; one that says so but holds an A (hand-edited, damaged) is lettered once more
    const v2 = before.map((s, i) => ({ ...s, letter: ['B', 'C', 'D', 'E'][i] }));
    expect(legacySet(JSON.stringify({ patch: fnv(text), v: 2, list: v2 }), text, check)!.list.map((s) => s.letter)).toEqual(['A', 'B', 'C', 'D', 'E']);
    const odd = legacySet(JSON.stringify({ patch: fnv(text), v: 2, list: [...v2, { letter: 'A', patch }] }), text, check)!;
    expect(odd.list.filter((s) => s.letter === 'A')).toHaveLength(1);
  });
});
