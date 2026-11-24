// SPDX-License-Identifier: GPL-3.0-only
// The candidate sets kept per patch in this browser (D-972 as amended, 1.26.4): every set in memory, loaded once from
// IndexedDB and written through to it, the 8 most recently opened sets worth keeping, the set holding a patch when it is
// opened, and today's localStorage record of the open patch's candidates as a set (the migration from before 1.26.4).

import type { Patch } from './patch';
import { body, letterAt, letterIndex, newSetId, type CandidateSet, type Snapshot } from './snapshots';

/** the most sets kept worth keeping (the least recently opened one goes when one more is stored) */
export const SET_LIMIT = 8;
/** localStorage: the open set's id */
export const SET_STORE = 'matryoshka.candidateSet';
/** localStorage: the open patch's candidates as kept before 1.26.4 (D-972) */
export const LEGACY_STORE = 'matryoshka.snapshots';

/** where the sets are written: IndexedDB, or memory (tests, and when IndexedDB is missing or blocked) */
export interface SetBackend {
  load(): Promise<CandidateSet[]>;
  put(s: CandidateSet): Promise<void>;
  delete(id: string): Promise<void>;
}

/** the sets in memory only: they last until the page closes */
export function memoryBackend(seed: CandidateSet[] = []): SetBackend {
  const sets = new Map(seed.map((s) => [s.id, structuredClone(s)]));
  return {
    load: async () => [...sets.values()].map((s) => structuredClone(s)),
    put: async (s) => void sets.set(s.id, structuredClone(s)),
    delete: async (id) => void sets.delete(id),
  };
}

const DB_NAME = 'matryoshka-candidates';
const DB_STORE = 'sets';

/** the sets in IndexedDB (database matryoshka-candidates, store sets); null when the browser has no IndexedDB. When the
 *  database does not open (blocked, private mode) the sets are kept in memory instead */
export function idbBackend(factory: IDBFactory | undefined = globalThis.indexedDB): SetBackend | null {
  if (!factory) return null;
  const memory = memoryBackend();
  const db = new Promise<IDBDatabase | null>((resolve) => {
    try {
      const req = factory.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(DB_STORE)) req.result.createObjectStore(DB_STORE, { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  const write = (d: IDBDatabase, op: (s: IDBObjectStore) => void): Promise<void> => new Promise((resolve, reject) => {
    const tx = d.transaction(DB_STORE, 'readwrite');
    op(tx.objectStore(DB_STORE));
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
  return {
    load: async () => {
      const d = await db;
      if (!d) return memory.load();
      return new Promise((resolve, reject) => {
        const req = d.transaction(DB_STORE, 'readonly').objectStore(DB_STORE).getAll();
        req.onsuccess = () => resolve(req.result as CandidateSet[]);
        req.onerror = () => reject(req.error);
      });
    },
    put: async (s) => {
      const d = await db;
      return d ? write(d, (o) => o.put(s)) : memory.put(s);
    },
    delete: async (id) => {
      const d = await db;
      return d ? write(d, (o) => o.delete(id)) : memory.delete(id);
    },
  };
}

/** a set worth keeping: 2 or more candidates, or one tweaked (a set that is just its untouched A is what opening the patch
 *  again gives, so it is not stored and browsing patches never puts real work away) */
export function worthKeeping(s: CandidateSet): boolean {
  if (s.list.length > 1) return true;
  const c = s.list[0];
  return !!c && body(JSON.parse(c.patch) as Patch) !== body(JSON.parse(c.original) as Patch);
}

/** a candidate's patch as `validate` has it (format bumps migrated), re-serialized; null when it fails */
function checked(text: unknown, validate: (p: unknown) => Patch): string | null {
  if (typeof text !== 'string') return null;
  try {
    return JSON.stringify(validate(JSON.parse(text)));
  } catch {
    return null;
  }
}

/** a set as read from the backend: each candidate's patch and original checked (a failing candidate is dropped); null when
 *  no candidate is left or it is no set */
function loaded(raw: unknown, validate: (p: unknown) => Patch): CandidateSet | null {
  const r = raw as Partial<CandidateSet> | null;
  if (!r || typeof r.id !== 'string' || !Array.isArray(r.list)) return null;
  const list: Snapshot[] = [];
  for (const c of r.list as Partial<Snapshot>[]) {
    if (typeof c?.letter !== 'string' || !/^[A-Z]+$/.test(c.letter)) continue;
    const patch = checked(c.patch, validate);
    const original = patch === null ? null : checked(c.original, validate);
    if (patch === null || original === null) continue;
    list.push({ ...c, letter: c.letter, patch, original });
  }
  if (!list.length) return null;
  const top = Math.max(...list.map((c) => letterIndex(c.letter) + 1));
  return {
    id: r.id, name: typeof r.name === 'string' ? r.name : '', list,
    current: list.some((c) => c.letter === r.current) ? r.current! : list[0].letter,
    given: typeof r.given === 'number' ? Math.max(r.given, top) : top,
    opened: typeof r.opened === 'number' ? r.opened : 0,
  };
}

/** where a patch is found: the set and the candidate holding it (null: the set has its name only) */
export type Found = { set: CandidateSet; letter: string | null };

/** the sets per patch, in memory, written through to the backend */
export class CandidateStore {
  /** the backend's sets are in memory (checked) */
  readonly ready: Promise<void>;
  private readonly sets = new Map<string, CandidateSet>();
  /** removed before the load landed: not brought back by it */
  private readonly gone = new Set<string>();
  /** each candidate patch's name and body, by its text: find compares up to 8 × 32 of them on each open */
  private readonly versions = new Map<string, { name: string; body: string }>();
  /** the last write of each set: the next one waits for it, so the writes of a set land in order */
  private readonly writes = new Map<string, Promise<void>>();
  private loading = true;

  constructor(private readonly backend: SetBackend | null, validate: (p: unknown) => Patch) {
    this.ready = Promise.resolve()
      .then(() => backend?.load() ?? [])
      .catch(() => [] as CandidateSet[])
      .then((raw) => {
        // (a set not worth keeping is never stored; one read anyway is left out, so the 8 kept are all real work)
        for (const r of raw) {
          const s = loaded(r, validate);
          if (s && worthKeeping(s) && !this.sets.has(s.id) && !this.gone.has(s.id)) this.sets.set(s.id, s);
        }
      })
      .catch(() => undefined)
      .finally(() => {
        this.loading = false;
        this.gone.clear();
      });
  }

  /** most recently opened first */
  all(): readonly CandidateSet[] {
    return [...this.sets.values()].sort((a, b) => b.opened - a.opened);
  }

  get(id: string): CandidateSet | undefined {
    return this.sets.get(id);
  }

  /** the set holding p: first a candidate that is the same version as p in any set but `except` (most recently opened
   *  first), with its letter; else a set but `except` with p's name (trimmed, case-insensitive), letter null; else null */
  find(p: Patch, except?: string): Found | null {
    const sets = this.all().filter((s) => s.id !== except);
    const b = body(p);
    for (const set of sets) {
      for (const c of set.list) {
        const v = this.version(c.patch);
        if (v.name === p.name && v.body === b) return { set, letter: c.letter };
      }
    }
    const name = p.name.trim().toLowerCase();
    const set = name ? sets.find((s) => s.name.trim().toLowerCase() === name) : undefined;
    return set ? { set, letter: null } : null;
  }

  /** store s (a copy); a set not worth keeping is removed instead. `opened`: s was opened now (later than every stored
   *  set). Beyond SET_LIMIT sets, the least recently opened one other than s is removed and returned (the toast offers it
   *  back); else null */
  save(s: CandidateSet, o: { opened?: boolean } = {}): CandidateSet | null {
    if (o.opened) s.opened = Math.max(Date.now(), ...[...this.sets.values()].map((x) => x.opened + 1));
    if (!worthKeeping(s)) {
      this.remove(s.id);
      return null;
    }
    this.put(s);
    if (this.sets.size <= SET_LIMIT) return null;
    const oldest = this.all().filter((x) => x.id !== s.id).at(-1)!;
    this.remove(oldest.id);
    return oldest;
  }

  /** a set save put away, back (the toast's Undo): just older than the newest stored set, so the next one put away is
   *  another */
  restore(s: CandidateSet): void {
    // (between the newest and the next newest: opened is a number to order by, so it need not be a whole one)
    const [newest, next] = this.all();
    this.put({ ...s, opened: !newest ? s.opened : next ? (newest.opened + next.opened) / 2 : newest.opened - 1 });
  }

  remove(id: string): void {
    if (this.loading) this.gone.add(id);
    if (!this.sets.delete(id)) return;
    this.write(id, (b) => b.delete(id));
  }

  /** a copy of s in memory (with the same Recently deleted: it lasts the session) and a copy without it written */
  private put(s: CandidateSet): void {
    const { deleted, ...rest } = s;
    const copy: CandidateSet = structuredClone(rest);
    if (deleted) copy.deleted = deleted;
    this.sets.set(s.id, copy);
    const written = structuredClone(rest);
    this.write(s.id, (b) => b.put(written));
  }

  /** write in the background, after the set's earlier writes; a failed write leaves memory as it is */
  private write(id: string, op: (b: SetBackend) => Promise<void>): void {
    const backend = this.backend;
    if (!backend) return;
    const done = (this.writes.get(id) ?? Promise.resolve()).then(() => op(backend)).catch(() => undefined);
    this.writes.set(id, done);
    void done.then(() => {
      if (this.writes.get(id) === done) this.writes.delete(id);
    });
  }

  private version(text: string): { name: string; body: string } {
    let v = this.versions.get(text);
    if (!v) {
      const p = JSON.parse(text) as Patch;
      v = { name: p.name, body: body(p) };
      this.versions.set(text, v);
    }
    return v;
  }
}

// From before 1.26.4: the open patch's candidates beside the remembered patch in localStorage (LEGACY_STORE), B, C… with
// A the current patch (or, before #1048, lettered from A), tied to the patch by a fingerprint of its text.

/** a candidate as the record kept it (`mark`, rank and cut's keep mark, is dropped) */
type LegacySnapshot = Omit<Snapshot, 'original'>;

/** a short fingerprint of the remembered patch's text (FNV-1a), which tied the stored candidates to that patch */
function fingerprint(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}

/** the record's lettering: 2 since A is the current patch (#1048); a record without it lettered its first candidate A */
const LETTERING = 2;

/** a candidate of a record from before A was the current patch, lettered once more (#1048): each letter moves on by one (A
 *  to B, Z to AA), its origin with it (the current patch's `current` becomes A), and the old "before mutate" copy gets its
 *  origin. So no stored candidate is A beside the remembered patch */
function reletter(s: LegacySnapshot): LegacySnapshot {
  const next = (l: string): string => letterAt(letterIndex(l) + 1);
  const from = s.from === 'current' ? 'A' : s.from?.split('+').map((l) => (/^[A-Z]+$/.test(l) ? next(l) : l)).join('+');
  const before = s.name === 'before mutate' && !s.from;
  return { ...s, letter: next(s.letter), ...(from ? { from } : {}), ...(before ? { from: 'mutate' } : {}) };
}

/** the candidates kept for the remembered patch `patchText`: none when the record belongs to another patch or is damaged.
 *  A record from before A was the current patch is lettered once more (reletter) */
function storedSnapshots(record: string, patchText: string): LegacySnapshot[] {
  try {
    const r = JSON.parse(record) as { patch?: unknown; v?: unknown; list?: unknown };
    if (r.patch !== fingerprint(patchText) || !Array.isArray(r.list)) return [];
    const list = (r.list as Partial<LegacySnapshot>[]).filter((s): s is LegacySnapshot => typeof s?.letter === 'string' && /^[A-Z]+$/.test(s.letter) && typeof s.patch === 'string' && (s.name === undefined || typeof s.name === 'string'))
      .map((s): LegacySnapshot => ({
        letter: s.letter, patch: s.patch, ...(s.name ? { name: s.name } : {}), ...(typeof s.from === 'string' ? { from: s.from } : {}),
        ...(typeof s.aim?.kind === 'string' && typeof s.aim.fits === 'boolean' ? { aim: { kind: s.aim.kind, fits: s.aim.fits } } : {}),
      }));
    return r.v === LETTERING && !list.some((s) => s.letter === 'A') ? list : list.map(reletter);
  } catch {
    return [];
  }
}

/** today's record (`record`, tied to the remembered patch's text `patchText`) as a set: A the remembered patch as opened,
 *  then the stored candidates with their letters, names, origins and aims, each made as it was stored; A current. Each
 *  patch passes `validate` (a failing candidate is dropped). Null when there is no record, it belongs to another patch, it
 *  is damaged, or no candidate is left. Touches no storage */
export function legacySet(record: string | null, patchText: string | null, validate: (p: unknown) => Patch): CandidateSet | null {
  if (!record || patchText === null) return null;
  const a = checked(patchText, validate);
  if (a === null) return null;
  const list: Snapshot[] = [];
  for (const s of storedSnapshots(record, patchText)) {
    const patch = checked(s.patch, validate);
    if (patch !== null) list.push({ ...s, patch, original: patch });
  }
  if (!list.length) return null;
  const name = (JSON.parse(a) as Patch).name;
  list.unshift({ letter: 'A', name, patch: a, original: a, from: 'opened' });
  return {
    id: newSetId(), name, list, current: 'A',
    given: Math.max(...list.map((s) => letterIndex(s.letter) + 1)), opened: Date.now(),
  };
}
