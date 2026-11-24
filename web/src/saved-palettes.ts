// SPDX-License-Identifier: GPL-3.0-only
// The palettes saved in this browser (#1236): each a name and 8 positions, each empty or a sound kept whole (the patch as
// heard, the user presets its devices name, the name it shows), never a reference to a Library patch. Every palette in
// memory, loaded once from IndexedDB (database matryoshka-palettes) and written through to it; Recently deleted for the
// session; the chips a saved palette shows; the palette file (export / import).

import { assemblyById } from './assembly';
import { fixPreset, sameName, type Preset } from './device-presets';
import { drawerScope } from './fx-preset';
import { entryPresets, type Chip } from './palette';
import { paletteDevices, patchPattern } from './preset-fit';
import type { Patch } from './patch';
import { layout } from './patchbin';
import { devicePresetName, PALETTE_SIZE } from './protocol';
import { newSetId } from './snapshots';
import { structureAndRows } from './structure';

/** the positions of a palette, as the FM-1's */
export const PALETTE_SLOTS = PALETTE_SIZE;
/** the most palettes Recently deleted keeps (the oldest goes) */
export const DELETED_LIMIT = 32;

/** a sound in a saved palette, kept whole */
export interface PaletteSound {
  /** the chip's name: the name it was added under */
  name: string;
  /** the sound as heard: card values, each card's preset name, the selected pattern, no song */
  patch: Patch;
  /** the user presets its devices name, with values (a factory one is named only) */
  presets: Preset[];
}

export interface SavedPalette {
  id: string;
  /** "Palette 3": trimmed, never empty */
  name: string;
  /** always PALETTE_SLOTS long */
  sounds: (PaletteSound | null)[];
  made: number;
  changed: number;
}

/** a preset as a sound keeps it: no factory mark, its own arrays */
const kept = ({ structure, name, values, fx }: Preset): Preset =>
  structuredClone(fx ? { structure, name, values, fx } : { structure, name, values });

/** `patch` as a sound named `name`: a copy, with the user presets its devices name from this browser (entryPresets), then
 *  each of `extra` a device of it names (its structure or its drawer's, the name as the FM-1 compares it) that this
 *  browser did not give */
export function soundOf(name: string, patch: Patch, extra: readonly Preset[] = []): PaletteSound {
  const presets: Preset[] = [];
  const has = (p: Preset): boolean => presets.some((x) => x.structure === p.structure && sameName(x.name, p.name));
  for (const { preset } of entryPresets(patch)) if (!has(preset)) presets.push(kept(preset));
  if (extra.length) {
    const devs = layout(patch).devs;
    for (const d of paletteDevices(patch)) {
      const asm = devs[d.dev]?.asm, a = asm === undefined ? undefined : assemblyById(patch, asm);
      if (!a) continue;
      const mine = [structureAndRows(patch, a).structure, drawerScope(patch, a)?.structure];
      for (const p of extra) {
        if (!p.factory && mine.includes(p.structure) && sameName(devicePresetName(p.name), d.name) && !has(p)) presets.push(kept(p));
      }
    }
  }
  return { name, patch: structuredClone(patch), presets };
}

/** a saved palette's chip at `pos` (palette-view.ts): the sound's name as given, its devices' preset names, its pattern */
export function soundChip(s: PaletteSound | null, pos: number): Chip {
  return {
    pos, state: s ? 'ok' : 'empty', name: s?.name ?? '',
    presets: s ? paletteDevices(s.patch).map((d) => d.name) : [],
    pattern: s ? patchPattern(s.patch) : 0,
    cur: false, next: false, copy: true,
  };
}

/** "Palette N", N the lowest whole number from 1 no name takes (trimmed, case aside) */
export function nextPaletteName(names: readonly string[]): string {
  const taken = new Set(names.map((n) => n.trim().toLowerCase()));
  let n = 1;
  while (taken.has(`palette ${n}`)) n++;
  return `Palette ${n}`;
}

/** `list` as PALETTE_SLOTS positions: cut, or padded with empty ones */
const slots = <T>(list: readonly (T | null)[]): (T | null)[] =>
  Array.from({ length: PALETTE_SLOTS }, (_, i) => list[i] ?? null);

/** a sound as read (the store, a file): its patch as `validate` has it (format bumps migrated), its well-formed presets;
 *  null when it is no sound or its patch fails */
function readSound(raw: unknown, validate: (p: unknown) => Patch): PaletteSound | null {
  const r = raw as Partial<Record<keyof PaletteSound, unknown>> | null;
  if (!r || typeof r !== 'object') return null;
  let patch: Patch;
  try {
    patch = validate(r.patch);
  } catch {
    return null;
  }
  const presets = Array.isArray(r.presets) ? r.presets.map(fixPreset).filter((p): p is Preset => !!p) : [];
  return { name: typeof r.name === 'string' ? r.name : patch.name, patch, presets };
}

/** a palette as read from the backend: each sound checked (a failing one is empty); null when it is no palette */
function loaded(raw: unknown, validate: (p: unknown) => Patch): SavedPalette | null {
  const r = raw as Partial<Record<keyof SavedPalette, unknown>> | null;
  if (!r || typeof r.id !== 'string' || typeof r.name !== 'string' || !r.name.trim() || !Array.isArray(r.sounds)) return null;
  return {
    id: r.id, name: r.name.trim(),
    sounds: slots(r.sounds.map((s: unknown) => (s ? readSound(s, validate) : null))),
    made: typeof r.made === 'number' ? r.made : 0,
    changed: typeof r.changed === 'number' ? r.changed : 0,
  };
}

/** where the palettes are written: IndexedDB, or memory (tests, and when IndexedDB is missing or blocked) */
export interface PaletteBackend {
  load(): Promise<SavedPalette[]>;
  put(p: SavedPalette): Promise<void>;
  delete(id: string): Promise<void>;
}

/** the palettes in memory only: they last until the page closes */
export function memoryBackend(seed: SavedPalette[] = []): PaletteBackend {
  const kept = new Map(seed.map((p) => [p.id, structuredClone(p)]));
  return {
    load: async () => [...kept.values()].map((p) => structuredClone(p)),
    put: async (p) => void kept.set(p.id, structuredClone(p)),
    delete: async (id) => void kept.delete(id),
  };
}

const DB_NAME = 'matryoshka-palettes';
const DB_STORE = 'palettes';

/** the palettes in IndexedDB (database matryoshka-palettes, store palettes); null when the browser has no IndexedDB. When
 *  the database does not open (blocked, private mode) the palettes are kept in memory instead */
export function idbBackend(factory: IDBFactory | undefined = globalThis.indexedDB): PaletteBackend | null {
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
        req.onsuccess = () => resolve(req.result as SavedPalette[]);
        req.onerror = () => reject(req.error);
      });
    },
    put: async (p) => {
      const d = await db;
      return d ? write(d, (o) => o.put(p)) : memory.put(p);
    },
    delete: async (id) => {
      const d = await db;
      return d ? write(d, (o) => o.delete(id)) : memory.delete(id);
    },
  };
}

/** the saved palettes, in memory, written through to the backend. No limit. `get`, `all` and `deleted` give the stored
 *  palettes themselves: read them, never change them (every change goes through the store, which copies what it is given) */
export class SavedPaletteStore {
  /** the backend's palettes are in memory (checked) */
  readonly ready: Promise<void>;
  /** after every change, and once when the load lands */
  onChange?: () => void;
  private readonly palettes = new Map<string, SavedPalette>();
  /** Recently deleted, newest first: this session only, never written */
  private readonly bin: { palette: SavedPalette; at: number }[] = [];
  /** removed before the load landed: not brought back by it */
  private readonly gone = new Set<string>();
  /** the last write of each palette: the next one waits for it, so the writes of a palette land in order */
  private readonly writes = new Map<string, Promise<void>>();
  private loading = true;

  constructor(private readonly backend: PaletteBackend | null, validate: (p: unknown) => Patch) {
    this.ready = Promise.resolve()
      .then(() => backend?.load() ?? [])
      .catch(() => [] as SavedPalette[])
      .then((raw) => {
        for (const r of raw) {
          const p = loaded(r, validate);
          if (p && !this.palettes.has(p.id) && !this.gone.has(p.id)) this.palettes.set(p.id, p);
        }
      })
      .catch(() => undefined)
      .finally(() => {
        this.loading = false;
        this.gone.clear();
        this.onChange?.();
      });
  }

  /** most recently changed first */
  all(): readonly SavedPalette[] {
    return [...this.palettes.values()].sort((a, b) => b.changed - a.changed);
  }

  get(id: string): SavedPalette | undefined {
    return this.palettes.get(id);
  }

  /** a new palette named `name` (trimmed; none or empty: the next free "Palette N") holding copies of `sounds` (cut or
   *  padded to PALETTE_SLOTS) */
  create(name?: string, sounds: readonly (PaletteSound | null)[] = []): SavedPalette {
    const now = Date.now();
    const p: SavedPalette = {
      id: newSetId(), name: name?.trim() || nextPaletteName(this.all().map((x) => x.name)),
      sounds: slots(structuredClone(sounds.slice(0, PALETTE_SLOTS))), made: now, changed: now,
    };
    this.palettes.set(p.id, p);
    this.changed(p, false);
    return p;
  }

  /** rename (trimmed); false when there is no such palette or the name is empty (it keeps its name) */
  rename(id: string, name: string): boolean {
    const p = this.palettes.get(id), n = name.trim();
    if (!p || !n) return false;
    p.name = n;
    this.changed(p);
    return true;
  }

  /** position `pos` holds a copy of `s`, or is emptied (null); false when there is no such palette or position */
  setSound(id: string, pos: number, s: PaletteSound | null): boolean {
    const p = this.palettes.get(id);
    if (!p || !Number.isInteger(pos) || pos < 0 || pos >= PALETTE_SLOTS) return false;
    p.sounds[pos] = s && structuredClone(s);
    this.changed(p);
    return true;
  }

  /** a copy of `s` into the first empty position, returned; null when the palette is full or missing */
  addSound(id: string, s: PaletteSound): number | null {
    const p = this.palettes.get(id);
    const pos = p ? p.sounds.indexOf(null) : -1;
    if (!p || pos < 0) return null;
    p.sounds[pos] = structuredClone(s);
    this.changed(p);
    return pos;
  }

  /** the sound at `from` onto `to`, as the FM-1's chips: onto an empty position it moves, onto a full one the two swap.
   *  False when nothing changes */
  move(id: string, from: number, to: number): boolean {
    const p = this.palettes.get(id);
    const ok = (n: number): boolean => Number.isInteger(n) && n >= 0 && n < PALETTE_SLOTS;
    if (!p || !ok(from) || !ok(to) || from === to || !p.sounds[from] && !p.sounds[to]) return false;
    [p.sounds[from], p.sounds[to]] = [p.sounds[to], p.sounds[from]];
    this.changed(p);
    return true;
  }

  /** to Recently deleted (this session); false when there is no such palette */
  remove(id: string): boolean {
    if (this.loading) this.gone.add(id);
    const p = this.palettes.get(id);
    if (!p) return false;
    this.palettes.delete(id);
    this.bin.unshift({ palette: p, at: Date.now() });
    this.bin.splice(DELETED_LIMIT);
    this.write(id, (b) => b.delete(id));
    this.onChange?.();
    return true;
  }

  /** Recently deleted, newest first */
  deleted(): readonly { palette: SavedPalette; at: number }[] {
    return this.bin;
  }

  /** a deleted palette back in the list, written again, with its own `changed`; false when it is not in Recently deleted */
  putBack(id: string): boolean {
    const i = this.bin.findIndex((d) => d.palette.id === id);
    if (i < 0) return false;
    const [{ palette }] = this.bin.splice(i, 1);
    this.palettes.set(id, palette);
    this.changed(palette, false);
    return true;
  }

  /** `p` changed (`touch`: now), written, said */
  private changed(p: SavedPalette, touch = true): void {
    if (touch) p.changed = Math.max(Date.now(), p.changed);
    const written = structuredClone(p);
    this.write(p.id, (b) => b.put(written));
    this.onChange?.();
  }

  /** write in the background, after the palette's earlier writes; a failed write leaves memory as it is */
  private write(id: string, op: (b: PaletteBackend) => Promise<void>): void {
    const backend = this.backend;
    if (!backend) return;
    const done = (this.writes.get(id) ?? Promise.resolve()).then(() => op(backend)).catch(() => undefined);
    this.writes.set(id, done);
    void done.then(() => {
      if (this.writes.get(id) === done) this.writes.delete(id);
    });
  }
}

/** the palette file's format mark and version */
export const PALETTE_FORMAT = 'matryoshka-palette';
export const PALETTE_FILE_VERSION = 1;

/** a palette file (its format mark: any version) */
export const isPaletteFile = (raw: unknown): boolean =>
  !!raw && typeof raw === 'object' && 'format' in raw && raw.format === PALETTE_FORMAT;

/** the palette as a file (2-space JSON): its name and sounds */
export const paletteFile = (p: SavedPalette): string =>
  JSON.stringify({ format: PALETTE_FORMAT, version: PALETTE_FILE_VERSION, name: p.name, sounds: p.sounds }, null, 2);

/** the palette file's name: the palette's name with letters, digits, spaces, - and _ only, spaces as - */
export function paletteFileName(name: string): string {
  const stem = name.replace(/[^A-Za-z0-9 _-]/g, '').trim().replace(/\s+/g, '-') || 'palette';
  return `${stem}.palette.json`;
}

/** a palette file read: its name (trimmed; may be empty), its sounds (cut or padded to PALETTE_SLOTS; a sound whose patch
 *  fails `validate` is empty, and counts in `dropped`). Throws an Error saying why when it is no palette file or a newer
 *  editor made it */
export function readPaletteFile(raw: unknown, validate: (p: unknown) => Patch): { name: string; sounds: (PaletteSound | null)[]; dropped: number } {
  const r = raw as { version?: unknown; name?: unknown; sounds?: unknown };
  if (!isPaletteFile(raw) || !Array.isArray(r.sounds)) throw new Error('not a palette file');
  if (typeof r.version === 'number' && r.version > PALETTE_FILE_VERSION) throw new Error('made by a newer editor: update this page');
  let dropped = 0;
  const sounds = slots(r.sounds).map((s) => {
    if (!s) return null;
    const sound = readSound(s, validate);
    if (!sound) dropped++;
    return sound;
  });
  return { name: typeof r.name === 'string' ? r.name.trim() : '', sounds, dropped };
}
