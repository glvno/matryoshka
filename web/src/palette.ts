// SPDX-License-Identifier: GPL-3.0-only
// The palette (#1196): up to 8 sounds collected for a project, kept on the FM-1 (HOME + black key 1..8 switches to one,
// held 1 s saves the current sound there). An entry is a bank slot checked by the patch's name (MISSING when the slot no
// longer holds it), every device's preset as it was saved, and the selected pattern. The FM-1 holds the palette; the
// editor shows it as 8 chips (palette-view.ts), collects into it, reorders and removes, and opens an entry from this
// browser's copy of its patch: the editor's own version or a saved patch its slot holds byte for byte (SLOT_GET), the copy
// this browser kept of each sound it put into the palette (PALETTE_COPIES), else a saved patch of the slot's name and
// binary length (D-605); with none, from the FM-1 itself (firmware 1.26 or later: the slot's binary and the stored
// patterns it links, rebuilt by patch-reader.ts with the assemblies this browser knows, bank.ts readFm1Slot). Adding a
// sound first saves on the FM-1 what it needs to play it as the editor shows it: a sound
// it reaches from a slot it has with device presets (D-1240: the same patch, other card values, tempo or patterns)
// points at that slot with them, each preset it lacks sent (PRESET_PUT); any other sound is stored into a free slot, with
// the user presets its entry names. A saved palette (saved-palettes.ts) is sent whole by the same rules (send: its sounds
// carry their own presets, sent by their names; `from` says which one the FM-1's palette still is), and the FM-1's palette
// is captured as sounds (capture: each position's copy with its entry applied, the presets only the FM-1 has read back).
// The link: protocol.ts PALETTE / PALETTE_NOW / PALETTE_ENTRY (feature bit 31). With no FM-1 the chips show the last
// palette read, read-only (kept in this browser).
import { assemblyById } from './assembly';
import { binLength, deviceName, knownCopy, readFm1Bin, readFm1Slot, type Candidate, type KnownCopy } from './bank';
import { readLabel } from './patch-reader';
import { deletePreset as dropUserPreset, rememberedPreset, replaceUserPresets, sameName, userPresets, type Preset } from './device-presets';
import type { Patch } from './patch';
import { layout } from './patchbin';
import { devicePresetName, NAME_BYTES, PAL_EMPTY, PAL_GO_CANCELLED, PAL_GO_WAITING, PAL_MISSING, PAL_REFUSED, PALETTE_SIZE, paletteHash, STATUS_PRESETS_FULL, type Ack, type DevicePresetEntry, type PaletteEntry, type PaletteNow, type PalettePos, type SlotInfo } from './protocol';
import { applyEntry, asSlot, entryOf, fm1Presets, NO_SAME_STRUCTURE, paletteDevices, presetFit, q16, sameBytes, samePatch, samePreset, sameWiring, slotPlays, takeTempoAndPatterns, type PresetFit } from './preset-fit';
import { drawerScope } from './fx-preset';
import { soundOf, type PaletteSound } from './saved-palettes';
import { structureAndRows } from './structure';

/** where this browser keeps the last palette read (the chips show it, greyed, with no FM-1) */
export const PALETTE_STORE = 'matryoshka.palette';
/** where it keeps its copies of the sounds it put into the palette (PaletteCopy), apart: a patch is tens of kB, and a
 *  store too full for them still keeps the palette */
export const PALETTE_COPIES = 'matryoshka.palette-copies';
/** where it keeps what Send to FM-1 left there: the saved palette's id and name, and each position's hash as it left
 *  them (0 empty) */
export const PALETTE_FROM = 'matryoshka.palette-from';
/** the user presets the entry of `patch` names, as this browser keeps them, each under the name the entry gives it: the
 *  ones the FM-1 needs to be sent (a factory preset is on it already; a name this browser has no preset of has nothing
 *  to send, and the device plays the slot's own values on the FM-1). `extra`: a saved sound's own presets, looked up
 *  after this browser's (a sound from another browser sends its presets by their names) */
export function entryPresets(patch: Patch, extra: readonly Preset[] = []): { name: string; preset: Preset }[] {
  const devs = layout(patch).devs;
  return paletteDevices(patch).flatMap((d) => {
    const asm = devs[d.dev].asm, a = asm === undefined ? undefined : assemblyById(patch, asm);
    if (!a) return [];
    const known = rememberedPreset(patch, a);
    if (known?.factory) return [];
    const own = known && userPresets().find((x) => x.structure === known.structure && sameName(x.name, known.name));
    if (own) return [{ name: d.name, preset: own }];
    const mine = [structureAndRows(patch, a).structure, drawerScope(patch, a)?.structure];
    const theirs = extra.find((x) => mine.includes(x.structure) && samePreset(x.name, d.name) && (!d.pstructure || parseInt(x.structure, 16) >>> 0 === d.pstructure));
    return theirs ? [{ name: d.name, preset: theirs }] : [];
  });
}

/** this browser's copy of a sound it put into the palette: the patch FM-1 slot `slot` holds under its name `name`, as
 *  Add to palette stored it there (or found it there byte for byte), or as a hold-save on the FM-1 stored the patch the
 *  editor played. It opens that sound whatever the editor shows by then (owner 2026-11-24: a switch to a sound of
 *  another instrument left the editor behind once its candidates were gone) */
export interface PaletteCopy { slot: number; name: string; patch: Patch }

/** a slot name `label` numbered k, as Add to palette names a slot whose name another patch has (the preset rule, "Bright
 *  2"), within the NAME_BYTES characters the FM-1 keeps: "MY PAD 2" */
const numberedName = (label: string, k: number): string => `${label.slice(0, NAME_BYTES - 1 - String(k).length)} ${k}`;

/** slot name `name` is `label` numbered */
function isNumbered(name: string, label: string): boolean {
  const m = / ([1-9]\d*)$/.exec(name);
  return !!m && numberedName(label, Number(m[1])) === name;
}

/** "preset A" or "presets A, B" */
const presetWord = (names: string[]): string => `preset${names.length > 1 ? 's' : ''} ${names.join(', ')}`;

/** this browser's copy of a position's patch by the slot's name and binary length now: the copy it kept of the sound it
 *  put there (`kept`), else a saved patch (D-605), or null */
export function positionCopy(p: PalettePos, candidates: Candidate[], length: (p: Patch) => number = binLength, kept: readonly PaletteCopy[] = []): KnownCopy | null {
  if (p.state !== 1) return null;
  const mine = kept.find((x) => x.slot === p.slot && x.name === p.name && length(x.patch) === p.len);
  return mine ? { name: '', patch: mine.patch, factory: false } : knownCopy({ slot: p.slot, used: true, length: p.len, name: p.name }, candidates, length);
}

/** ORDER's `from` that moves position `from` onto `to`: onto an empty position it moves, onto a full one the two swap */
export function moveOrder(from: number, to: number): number[] {
  const order = Array.from({ length: PALETTE_SIZE }, (_, i) => i);
  [order[from], order[to]] = [order[to], order[from]];
  return order;
}

/** the PUTs Send bank needs (#1196): an entry whose patch moved to another slot points at the new one. `moves`: old slot
 *  → new slot of each patch that stayed in the bank (bank.ts slotMoves); an entry whose patch left is not touched (the
 *  FM-1 reports it MISSING by its name rule) */
export function repointed(now: PaletteNow, entries: readonly (PaletteEntry | null)[], moves: ReadonlyMap<number, number>): { pos: number; entry: PaletteEntry }[] {
  const out: { pos: number; entry: PaletteEntry }[] = [];
  now.positions.forEach((p, pos) => {
    const e = entries[pos];
    const to = p.state && e ? moves.get(e.slot) : undefined;
    if (e && to !== undefined && to !== e.slot) out.push({ pos, entry: { ...e, slot: to } });
  });
  return out;
}

/** what the last palette read leaves in this browser */
interface Kept { now: PaletteNow; entries: (PaletteEntry | null)[] }
function loadKept(storage: Pick<Storage, 'getItem'> | null): Kept | null {
  try {
    const k = JSON.parse(storage?.getItem(PALETTE_STORE) ?? 'null') as Kept | null;
    return k && Array.isArray(k.now?.positions) && k.now.positions.length === PALETTE_SIZE && Array.isArray(k.entries) ? k : null;
  } catch {
    return null;
  }
}

/** the copies this browser kept of the sounds it put into the palette, as stored (as the candidates are kept, D-972: a
 *  patch put through validatePatch can encode to other bytes than the slot holds) */
function loadCopies(storage: Pick<Storage, 'getItem'> | null): PaletteCopy[] {
  try {
    const raw: unknown = JSON.parse(storage?.getItem(PALETTE_COPIES) ?? '[]');
    return Array.isArray(raw) ? raw.filter((x: Partial<PaletteCopy>) => typeof x?.slot === 'number' && typeof x.name === 'string' && Array.isArray(x.patch?.modules)) : [];
  } catch {
    return [];
  }
}

/** what Send to FM-1 left on the FM-1 (PALETTE_FROM): the saved palette, each position's hash then (0 empty), and the
 *  record's sequence number then (PALETTE_NOW seq) */
interface SentFrom { id: string; name: string; hashes: number[]; seq?: number }
function loadFrom(storage: Pick<Storage, 'getItem'> | null): SentFrom | null {
  try {
    const f = JSON.parse(storage?.getItem(PALETTE_FROM) ?? 'null') as Partial<SentFrom> | null;
    return f && typeof f.id === 'string' && typeof f.name === 'string' && Array.isArray(f.hashes) && f.hashes.length === PALETTE_SIZE ? (f as SentFrom) : null;
  } catch {
    return null;
  }
}

/** each position's hash in a palette read, 0 empty */
const hashesOf = (now: PaletteNow): number[] => now.positions.map((p) => (p.state ? p.hash : 0));
const sameHashes = (a: readonly number[], b: readonly number[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/** a chip as palette-view.ts draws it */
export interface Chip {
  pos: number;
  state: 'empty' | 'ok' | 'missing';
  name: string;
  /** its devices' preset names */
  presets: string[];
  pattern: number;
  /** playing on the FM-1 / waiting for the bar line there */
  cur: boolean;
  next: boolean;
  /** this browser has a copy of its patch (false: a click cannot open it here, unless `fromFm1`) */
  copy: boolean;
  /** the FM-1 linked can send the slot back (firmware 1.26 or later): a position with no copy opens from the FM-1 */
  fromFm1?: boolean;
}

/** what the palette needs from the editor */
export interface PalettePorts {
  device: {
    readonly connected: boolean;
    readonly hasPalette: boolean;
    readPalette(): Promise<PaletteNow>;
    readPaletteEntry(pos: number): Promise<PaletteEntry | null>;
    putPaletteEntry(pos: number, e: PaletteEntry | null): Promise<void>;
    orderPalette(from: readonly (number | null)[]): Promise<void>;
    goPalette(pos: number | null): Promise<Ack>;
    readBank(): Promise<SlotInfo[]>;
    uploadSlot(slot: number, name: string, patch: Patch): Promise<unknown>;
    eraseSlot(slot: number): Promise<void>;
    /** the binary a patch takes in a slot of this FM-1 (DeviceLink.encodeFor) */
    encodeFor(patch: Patch): Uint8Array;
    /** SLOT_GET: a slot's binary as stored (firmware that readsSlots), null when empty */
    readonly readsSlots: boolean;
    readSlotBin(slot: number): Promise<Uint8Array | null>;
    /** PAT_GET: a stored pattern's payload, null when the FM-1 has no such id */
    getPattern(id: number): Promise<Uint8Array | null>;
    /** the user preset store (INFO feature bit 7) */
    readonly hasPresets: boolean;
    presetFits(n: number, preset?: { structure: string; values: number[] }): boolean;
    listPresets(): Promise<DevicePresetEntry[]>;
    getPreset(structure: string, name: string): Promise<number[] | null>;
    putPreset(structure: string, name: string, values: number[]): Promise<void>;
    deletePreset(structure: string, name: string): Promise<void>;
  };
  /** this browser's patches that can be an entry's copy (bank.ts bankCandidates) */
  candidates(): Candidate[];
  /** the editor's own versions of its patch: the patch on screen, the current patch and the candidates (a sound added
   *  from one has no other copy: its slot is matched byte for byte, ownCopy) */
  versions(): Patch[];
  /** Live sync is on and the FM-1 plays the editor's patch */
  live(): boolean;
  /** the patch the editor plays as it is now: the candidate on screen (A, the current patch, or another), which Live sends
   *  to the FM-1 */
  current(): Patch;
  /** open `patch` in the editor as the current patch, keeping its candidates (the patch it replaces joins them);
   *  `adopt`: the FM-1 plays it already (a switch under Live): no upload */
  open(patch: Patch, o: { adopt: boolean; from: string }): void;
  /** under Live the FM-1 plays a palette position that holds the editor's patch as it is (it saved it there: HOME + a
   *  black key held): the editor keeps its patch, and Live edits go on to the FM-1's */
  kept(): void;
  /** turn Live sync off and say why */
  liveOff(why: string): void;
  say(text: string): void;
  /** Add to palette found no empty position: say `text` where the chips are, offering `replace` (the same sound into
   *  the position picked) (#1258) */
  full(text: string, replace: (pos: number) => void): void;
  /** a sound was stored into an FM-1 slot on its way into the palette: the Library's FM-1 column reads the bank again */
  banked?(): void;
  /** the chips changed: draw them again */
  changed(): void;
}

/** the reason the palette cannot be changed now, or null */
const SWITCH_WAITS = 'The FM-1 is waiting to switch at the bar line: try again after it switched';
/** what Add to palette says with no empty position */
export const PALETTE_FULL = 'Palette full: drag onto a chip to replace';

export class Palette {
  /** the palette as last read (from the FM-1, or kept in this browser); null never read */
  now: PaletteNow | null;
  /** each position's entry with its presets, as far as read */
  entries: (PaletteEntry | null)[];
  /** entries by their hash: a position whose hash is known needs no ENTRY_GET */
  private byHash = new Map<number, PaletteEntry>();
  /** the last palette taken whole (its entries read): a switch is a change of `cur` from it, so a newer report that
   *  overtakes the switch's own while that one reads an entry still follows it */
  private taken: PaletteNow | null = null;
  /** each position's copy in this browser (worked out when the palette changes: a binary length costs an encode) */
  private hasCopy: boolean[] = [];
  /** the copies this browser kept of the sounds it put into the palette, one per slot */
  private copies: PaletteCopy[];
  /** an FM-1 linked that keeps a palette: the chips are live (otherwise read-only, the last read) */
  linked = false;
  /** the editor's patch when the FM-1 last said it plays a slot (slotNow), until a switch is followed */
  private atSlot: Patch | null = null;
  /** what Send to FM-1 left (PALETTE_FROM), until a palette read whose hashes differ */
  private sentFrom: SentFrom | null;

  constructor(private ports: PalettePorts, private storage: Pick<Storage, 'getItem' | 'setItem'> | null = globalThis.localStorage ?? null) {
    const kept = loadKept(storage);
    this.now = kept?.now ?? null;
    this.entries = kept?.entries ?? Array<PaletteEntry | null>(PALETTE_SIZE).fill(null);
    this.entries.forEach((e) => { if (e) this.byHash.set(paletteHash(e), e); });
    this.copies = loadCopies(storage);
    this.sentFrom = loadFrom(storage);
    this.findCopies();
  }

  /** the saved palette Send to FM-1 put there, while the FM-1's palette still is what it left; null otherwise */
  get from(): { id: string; name: string } | null {
    const f = this.sentFrom;
    return f && this.now && sameHashes(hashesOf(this.now), f.hashes) ? { id: f.id, name: f.name } : null;
  }

  private storeFrom(f: SentFrom | null): void {
    this.sentFrom = f;
    try {
      this.storage?.setItem(PALETTE_FROM, JSON.stringify(f));
    } catch {
      /* storage blocked: `from` lasts until the page closes */
    }
  }

  /** an FM-1 connected (or went away): read its palette when it keeps one */
  async connected(): Promise<void> {
    const d = this.ports.device;
    this.linked = d.connected && d.hasPalette;
    this.ports.changed();
    if (!this.linked) return;
    try {
      await this.take(await d.readPalette(), false);
    } catch (e) {
      this.ports.say(`Reading the FM-1's palette failed: ${(e as Error).message}`);
    }
  }

  /** an INFO the editor did not ask for, as the FM-1 answers another program's HELLO (a second editor window, a tool on
   *  the computer): after any HELLO it sends PALETTE_NOW unasked only once asked again (proto.c m1_pal_asked), so the
   *  chips would stop following it (its writes, switches and hold-saves). The palette is read again, which asks */
  async infoHeard(): Promise<void> {
    if (this.linked) await this.connected();
  }

  /** a PALETTE_NOW the FM-1 sent unasked (a switch, a hold-save, a write, a slot gone MISSING) */
  received(now: PaletteNow): void {
    if (this.linked) void this.take(now, true);
  }

  /** the FM-1 says it plays a slot (SLOT_NOW), before the editor takes it in (the editor drops its pattern origins then):
   *  the editor's patch as it is now, which a hold-save stored as it was (follow), is kept for the PALETTE_NOW after it */
  slotNow(): void {
    this.atSlot = this.linked ? structuredClone(this.ports.current()) : null;
  }

  /** take a palette read: fetch the entries whose hash is new, keep it, and under Live follow a switch. A palette other
   *  than Send to FM-1 left drops `from` */
  private async take(now: PaletteNow, follow: boolean): Promise<void> {
    this.now = now;
    // (only a newer record than Send left drops it: a report of a write during the Send can arrive after it; the getter
    // compares the hashes in any case)
    const f = this.sentFrom, newer = !f || f.seq === undefined || (((now.seq - f.seq) & 0xffff) > 0 && ((now.seq - f.seq) & 0xffff) < 0x8000);
    if (f && newer && !sameHashes(hashesOf(now), f.hashes)) this.storeFrom(null);
    this.entries = now.positions.map((p) => (p.state ? this.byHash.get(p.hash) ?? null : null));
    this.findCopies();
    this.ports.changed();
    for (let pos = 0; pos < PALETTE_SIZE; pos++) {
      const p = now.positions[pos];
      if (!p.state || this.entries[pos]) continue;
      const e = await this.ports.device.readPaletteEntry(pos).catch(() => null);
      if (this.now !== now) return;   // (a newer palette came meanwhile: it fetches its own)
      if (e) this.byHash.set(p.hash, e);
      this.entries[pos] = e;
    }
    this.keep();
    this.ports.changed();
    const was = this.taken, at = this.atSlot;
    this.taken = now;
    this.atSlot = null;   // (one read after the SLOT_NOW: an FM-1 SAVE outside the palette leaves none behind)
    if (follow && was && now.cur !== null && now.cur !== was.cur && this.ports.live()) await this.follow(now, now.cur, at ?? this.ports.current());
  }

  private keep(): void {
    try {
      this.storage?.setItem(PALETTE_STORE, JSON.stringify({ now: this.now, entries: this.entries }));
    } catch {
      /* storage blocked: the chips show the palette while connected only */
    }
  }

  /** keep this browser's copy of the sound slot `slot` holds under `name` (it put it there, or a hold-save stored the
   *  editor's patch there): it replaces the slot's earlier one, and copies of slots no position points at go */
  private keepCopy(slot: number, name: string, patch: Patch): void {
    const used = new Set((this.now?.positions ?? []).filter((p) => p.state).map((p) => p.slot));
    this.copies = [{ slot, name, patch: structuredClone(patch) }, ...this.copies.filter((x) => x.slot !== slot && used.has(x.slot))];
    this.storeCopies();
    this.findCopies();
    this.ports.changed();
  }

  private storeCopies(): void {
    try {
      this.storage?.setItem(PALETTE_COPIES, JSON.stringify(this.copies));
    } catch {
      /* storage full or blocked: the copies open the sounds until the page closes */
    }
  }

  /** work out which positions this browser has a copy of (after the palette, the browser's patches or the candidates
   *  changed): the editor's own versions count, and the copies it kept */
  findCopies(): void {
    const known = [...this.ports.versions().map((v) => ({ name: v.name, patch: () => v })), ...this.ports.candidates()];
    this.hasCopy = (this.now?.positions ?? []).map((p) => !!positionCopy(p, known, undefined, this.copies));
  }

  /** the chips to draw */
  chips(): Chip[] {
    return Array.from({ length: PALETTE_SIZE }, (_, pos) => {
      const p = this.now?.positions[pos];
      const e = this.entries[pos];
      return {
        pos,
        state: !p || !p.state ? 'empty' : p.state === 2 ? 'missing' : 'ok',
        name: p?.state ? p.name : '',
        presets: e?.devices.map((d) => d.name) ?? [],
        pattern: p?.pattern ?? 0,
        cur: this.linked && this.now?.cur === pos,
        next: this.linked && this.now?.next === pos,
        copy: !!this.hasCopy[pos],
        fromFm1: this.linked && this.ports.device.readsSlots,
      };
    });
  }

  /** why the palette cannot be changed now, or null (no FM-1, firmware without it, a switch waiting) */
  private blocked(): string | null {
    if (!this.ports.device.connected) return 'Connect the FM-1 to collect sounds into its palette';
    if (!this.linked) return 'The palette needs FM-1 firmware 1.26: update the FM-1';
    if (this.now?.next !== null && this.now?.next !== undefined) return SWITCH_WAITS;
    return null;
  }

  /** the first empty position, or null */
  firstEmpty(): number | null {
    const i = this.now?.positions.findIndex((p) => !p.state) ?? 0;
    return i < 0 ? null : i;
  }

  /**
   * Put a sound into the palette: at `pos` (a drop on a chip: it replaces what is there), or the first empty position
   * (Add to palette), saving first on the FM-1 what it needs to play the sound as the editor shows it (owner
   * 2026-11-23). A sound the FM-1 can reach from a slot it has with device presets is pointed at that slot (owner
   * 2026-11-24: "it should first determine if it's a preset of the instrument the fm1 has already. if so, send the
   * preset to the fm1 and add it to the palette"; presetPlace): each preset it names that the FM-1 lacks is sent, one it
   * makes is kept in this browser too, and no slot is written; the entry plays that slot's tempo and patterns, and says
   * so when they differ from the sound's. Otherwise the patch is stored into the first free slot, named after it, or
   * numbered ("MY PAD 2") when another patch has that name, and the line says why it took a patch; each user preset its
   * entry names goes to the FM-1's preset store when it has none of that name and structure or one with other values (a
   * factory preset is there already). A preset the FM-1 cannot take (its store full, firmware without presets or too old
   * for that preset) is left out of that entry: the slot's patch carries its values. `slot`: an FM-1 slot dragged from
   * the FM-1 column, pointed at as it is; `patch` null: one this browser has no copy of (its entry keeps no presets,
   * pattern 1). A failure takes back what was stored for it and says so. False when nothing was added. `presets`: a
   * saved sound's own presets, looked up after this browser's; one the entry uses joins this browser's presets.
   */
  async add(name: string, patch: Patch | null, o: { pos?: number; slot?: { slot: number; name: string }; presets?: Preset[] } = {}): Promise<boolean> {
    const why = this.blocked();
    if (why) return this.ports.say(why), false;
    const pos = o.pos ?? this.firstEmpty();
    if (pos === null) return this.ports.full(PALETTE_FULL, (at) => void this.add(name, patch, { ...o, pos: at })), false;
    if (!patch && !o.slot) return false;
    const r = await this.place(name, patch, { ...o, pos });
    this.ports.say(r.line);
    return r.ok;
  }

  /** add's work at position `pos` (not blocked, a patch or a slot given): the line it says, whether it was added, whether
   *  it stored a patch, and how many presets it sent or updated on the FM-1. Progress goes to ports.say */
  private async place(name: string, patch: Patch | null, o: { pos: number; slot?: { slot: number; name: string }; presets?: Preset[] }): Promise<{ ok: boolean; line: string; stored: boolean; sent: number }> {
    const pos = o.pos, d = this.ports.device;
    /** what was written to the FM-1 for this sound (and to this browser's presets), to take back on a failure */
    const undo: (() => Promise<unknown>)[] = [];
    let erased = false;
    try {
      /** why the sound takes a patch of its own */
      let patchWhy = '';
      const bank = o.slot ? null : await d.readBank();
      if (patch && bank) {
        const fit = await this.presetPlace(patch, name, bank, o.presets);
        const done = 'why' in fit ? fit.why : await this.addOnSlot(pos, name, fit, undo);
        if (typeof done !== 'string') return { ok: true, stored: false, ...done };
        patchWhy = done;
      }
      const where = o.slot ? { slot: o.slot.slot, label: o.slot.name, store: false } : this.placeFor(deviceName(name.trim() || 'PATCH'), bank!);
      if (!where) return { ok: false, line: `The FM-1's bank is full: "${name}" was not added to the palette`, stored: false, sent: 0 };
      const want = patch ? entryPresets(patch, o.presets) : [];
      const presets = await this.sendPresets(want, undo);
      const lost = new Set(presets.lost.map((x) => x.name));
      // (a saved sound's own preset the entry names joins this browser's presets, as a made one does)
      const join = [...new Set(want.filter((w) => o.presets?.includes(w.preset) && !lost.has(w.name)).map((w) => w.preset))];
      if (join.length) {
        replaceUserPresets(join, join);
        undo.push(async () => join.forEach((p) => dropUserPreset(p.structure, p.name)));
      }
      if (where.store) {
        this.ports.say(`Storing "${name}" into FM-1 slot ${where.slot + 1}…`);
        await d.uploadSlot(where.slot, where.label, patch!);
        undo.push(() => d.eraseSlot(where.slot).then(() => { erased = true; }));
        this.ports.banked?.();
      }
      const entry: PaletteEntry = patch ? entryOf(patch, where.slot, where.label) : { slot: where.slot, pattern: 0, name: where.label, devices: [] };
      entry.devices = entry.devices.filter((x) => !lost.has(x.name));
      this.byHash.set(paletteHash(entry), entry);
      await d.putPaletteEntry(pos, entry);
      // (the sound as this browser put it there: a switch to it opens it whatever the editor shows by then; a slot dragged
      // from the FM-1 column holds what it holds, its copy found by name and length)
      if (patch && !o.slot) this.keepCopy(where.slot, where.label, patch);
      const notes = [
        ...(where.store && patchWhy ? [`stored as a new patch in slot ${where.slot + 1}, as ${patchWhy}`] : []),
        ...(presets.sent.length ? [`${presetWord(presets.sent)} sent to the FM-1`] : []),
        ...(presets.updated.length ? [`${presetWord(presets.updated)} updated on the FM-1`] : []),
        ...(where.store && where.clash !== undefined ? [`slot ${where.clash + 1} holds another "${deviceName(name.trim() || 'PATCH')}", so it is stored as "${where.label}"`] : []),
      ];
      const fallback = presets.lost.length
        ? `. The FM-1 could not take ${presets.lost.map((x) => `preset ${x.name} (${x.why})`).join(', ')}: palette ${pos + 1} plays the values stored with the patch in slot ${where.slot + 1}`
        : '';
      const line = `"${name}" is palette ${pos + 1}${notes.length ? ` (${notes.join('; ')})` : ''}${fallback}`;
      return { ok: true, line, stored: where.store, sent: presets.sent.length + presets.updated.length };
    } catch (e) {
      const failed = `Adding "${name}" to the palette failed: ${(e as Error).message}`;
      let line = failed;
      if (undo.length) {
        try {
          for (const back of undo.reverse()) await back();
          line = `${failed}. Nothing was added: what it stored on the FM-1 for it is taken back`;
        } catch (e2) {
          line = `${failed}. Taking back what it stored on the FM-1 failed too (${(e2 as Error).message}): check Library > Presets and the FM-1 column`;
        }
      }
      if (erased) this.ports.banked?.();
      return { ok: false, line, stored: false, sent: 0 };
    }
  }

  /**
   * The FM-1 slot from which device presets reach `sound` (presetFit), or why none does. The slot must hold, byte for byte
   * (SLOT_GET: firmware that cannot send a slot back has none), a patch of the sound's name and structure: one this browser
   * knows (the sound itself, the editor's candidates, the copies it kept, a saved or factory patch of a slot's name), else
   * a slot of the sound's own name (or the name it is added under) read back from the FM-1 and taken as the sound with
   * that slot's card values, tempo and patterns (asSlot: a slot stored by an earlier add, an FM-1 hold-save of its own
   * edits, another browser; owner 2026-11-27). A slot of the sound's own patch (its name, or its name numbered) comes
   * first, then any slot that holds that patch. Nothing is written. `extra`: a saved sound's own presets (presetFit)
   */
  private async presetPlace(sound: Patch, name: string, bank: SlotInfo[], extra: readonly Preset[] = []): Promise<PresetFit & { slot: number; label: string; held: Patch } | { why: string }> {
    const d = this.ports.device;
    if (!d.readsSlots) return { why: 'this FM-1 cannot send its slots back to compare' };
    const used = bank.filter((s) => s.used);
    const named = (s: SlotInfo, x: string): boolean => deviceName(s.name) === x || isNumbered(deviceName(s.name), x);
    const own = [deviceName(sound.name.trim() || 'PATCH'), deviceName(name.trim() || 'PATCH')];
    const known = [
      sound,
      ...this.ports.versions(),
      ...this.copies.map((x) => x.patch),
      ...this.ports.candidates().filter((c) => used.some((s) => named(s, deviceName(c.name)))).map((c) => c.patch()),
    ];
    const pairs: { s: SlotInfo; held: Patch; bin: Uint8Array }[] = [];
    const seen = new Set<string>();
    for (const held of known) {
      if (!samePatch(sound, held)) continue;
      let bin: Uint8Array;
      try {
        bin = d.encodeFor(held);
      } catch {
        continue;   // (over the FM-1's budget: not a patch it holds)
      }
      const key = bin.join();
      if (seen.has(key)) continue;
      seen.add(key);
      for (const s of used) if (s.length === bin.length) pairs.push({ s, held, bin });
    }
    const mine = (s: SlotInfo): number => (own.some((x) => named(s, x)) ? 0 : 1);
    pairs.sort((a, b) => mine(a.s) - mine(b.s));
    const bins = new Map<number, Uint8Array | null>();
    let onFm1: Preset[] | undefined;
    let why = '';
    for (const { s, held, bin } of pairs) {
      if (!bins.has(s.slot)) bins.set(s.slot, await d.readSlotBin(s.slot).catch(() => null));
      const there = bins.get(s.slot);
      if (!there || !sameBytes(there, bin)) continue;
      onFm1 ??= await fm1Presets(sound, d);
      const fit = presetFit(sound, held, name, (p) => d.encodeFor(p), onFm1, extra);
      if (!('why' in fit)) return { ...fit, slot: s.slot, label: s.name, held };
      why ||= fit.why;
    }
    // (a slot of the sound's name that no patch this browser knows matches: what it holds, read back)
    for (const s of used.filter((x) => own.some((n) => named(x, n)))) {
      if (!bins.has(s.slot)) bins.set(s.slot, await d.readSlotBin(s.slot).catch(() => null));
      const there = bins.get(s.slot);
      if (!there || pairs.some((p) => p.s.slot === s.slot && sameBytes(there, p.bin))) continue;   // (compared above)
      const read = await readFm1Bin(d, there, s.name);
      const held = read && asSlot(sound, read.patch);
      if (!held) continue;
      let bin: Uint8Array;
      try {
        bin = d.encodeFor(held);
      } catch {
        continue;
      }
      if (!sameBytes(bin, there)) {
        if (sameWiring(bin, there)) why ||= `slot ${s.slot + 1} · ${s.name} differs from it in settings no device preset holds`;
        continue;
      }
      onFm1 ??= await fm1Presets(sound, d);
      const fit = presetFit(sound, held, name, (p) => d.encodeFor(p), onFm1, extra);
      if (!('why' in fit)) return { ...fit, slot: s.slot, label: s.name, held };
      why ||= fit.why;
    }
    return { why: why || NO_SAME_STRUCTURE };
  }

  /** point position `pos` at the slot `fit` found, with the presets it names: the ones the FM-1 lacks are sent first, a
   *  new one, one only the saved sound brought and one only the FM-1 had join this browser's presets (Library > Presets,
   *  Mine: the entry opens here as the FM-1 plays it). Its line and how many presets it sent or updated when added; a
   *  preset the FM-1 cannot take makes it take back what it sent and return why the sound needs a patch; any other
   *  failure throws (each write's undo is on `undo`) */
  private async addOnSlot(pos: number, name: string, fit: PresetFit & { slot: number; label: string; held: Patch }, undo: (() => Promise<unknown>)[]): Promise<{ line: string; sent: number } | string> {
    const send = fit.picks.filter((p) => p.from === 'browser' || p.from === 'sound' || p.from === 'new').map((p) => ({ name: p.preset.name, preset: p.preset }));
    const mark = undo.length;
    const presets = await this.sendPresets(send, undo);
    if (presets.lost.length) {
      for (const back of undo.splice(mark).reverse()) await back();
      return `the FM-1 could not take ${presets.lost.map((x) => `preset ${x.name} (${x.why})`).join(', ')}`;
    }
    const keep = fit.picks.filter((p) => p.from === 'new' || p.from === 'sound' || p.from === 'fm1').map((p) => p.preset);
    if (keep.length) {
      replaceUserPresets(keep, keep);
      undo.push(async () => keep.forEach((p) => dropUserPreset(p.structure, p.name)));
    }
    const entry = entryOf(fit.named, fit.slot, fit.label);
    this.byHash.set(paletteHash(entry), entry);
    await this.ports.device.putPaletteEntry(pos, entry);
    this.keepCopy(fit.slot, fit.label, fit.held);
    const names = fit.picks.map((p) => p.preset.name);
    const notes = [
      ...(presets.sent.length ? [`${presetWord(presets.sent)} sent to the FM-1`] : []),
      ...(presets.updated.length ? [`${presetWord(presets.updated)} updated on the FM-1`] : []),
    ];
    const line = `"${name}" is palette ${pos + 1}${names.length ? `: slot ${fit.slot + 1} · ${fit.label} with ${presetWord(names)}` : ''}${notes.length ? ` (${notes.join('; ')})` : ''}${fit.plays ? `. It plays the ${fit.plays} of slot ${fit.slot + 1}` : ''}`;
    return { line, sent: presets.sent.length + presets.updated.length };
  }

  /** a free slot for a patch named `label` (its device name) in `bank`, numbered when a used slot has that name
   *  (`clash`: that slot); null when the bank is full. Nothing is written */
  private placeFor(label: string, bank: SlotInfo[]): { slot: number; label: string; store: boolean; clash?: number } | null {
    const free = bank.find((s) => !s.used);
    if (!free) return null;
    const taken = new Set(bank.filter((s) => s.used).map((s) => deviceName(s.name)));
    let as = label;
    for (let k = 2; taken.has(as); k++) as = numberedName(label, k);
    const clash = bank.find((s) => s.used && deviceName(s.name) === label)?.slot;
    return { slot: free.slot, label: as, store: true, ...(clash === undefined ? {} : { clash }) };
  }

  /** send the FM-1 the user presets `want` (each under the name the entry gives it) that it has not got, or has with
   *  other values (compared in Q16, as it keeps them); each write's undo goes onto `undo`. A preset it cannot take (its
   *  store full, firmware without presets or too old for it) is `lost`, with why; any other failure throws */
  private async sendPresets(want: { name: string; preset: Preset }[], undo: (() => Promise<unknown>)[]): Promise<{ sent: string[]; updated: string[]; lost: { name: string; why: string }[] }> {
    const d = this.ports.device;
    const out = { sent: [] as string[], updated: [] as string[], lost: [] as { name: string; why: string }[] };
    if (!want.length) return out;
    if (!d.hasPresets) return { ...out, lost: want.map((w) => ({ name: w.name, why: 'update the FM-1 to store presets on it' })) };
    const on = await d.listPresets();
    const done = new Set<string>();
    for (const { name, preset } of want) {
      const key = `${preset.structure}/${devicePresetName(preset.name).toLowerCase()}`;
      if (done.has(key)) continue;
      done.add(key);
      if (!d.presetFits(preset.values.length, preset)) {
        out.lost.push({ name, why: 'update the FM-1 to store this preset on it' });
        continue;
      }
      const there = on.some((e) => e.structure === preset.structure && devicePresetName(e.name).toLowerCase() === devicePresetName(preset.name).toLowerCase());
      const old = there ? await d.getPreset(preset.structure, preset.name) : null;
      if (old && old.length === preset.values.length && old.every((v, i) => q16(v) === q16(preset.values[i]))) continue;
      try {
        await d.putPreset(preset.structure, preset.name, preset.values);
      } catch (e) {
        if (!(e instanceof Error && 'status' in e && e.status === STATUS_PRESETS_FULL)) throw e;
        out.lost.push({ name, why: 'its preset store is full' });
        continue;
      }
      undo.push(old ? () => d.putPreset(preset.structure, preset.name, old) : () => d.deletePreset(preset.structure, preset.name));
      (old ? out.updated : out.sent).push(name);
    }
    return out;
  }

  /** empty position `pos` (its ×) */
  async remove(pos: number): Promise<void> {
    const why = this.blocked();
    if (why) return this.ports.say(why);
    try {
      await this.ports.device.putPaletteEntry(pos, null);
    } catch (e) {
      this.ports.say(`Removing palette ${pos + 1} failed: ${(e as Error).message}`);
    }
  }

  /** move position `from` onto `to` (a chip dragged onto another): one ORDER */
  async move(from: number, to: number): Promise<void> {
    if (from === to) return;
    const why = this.blocked();
    if (why) return this.ports.say(why);
    try {
      await this.ports.device.orderPalette(moveOrder(from, to));
    } catch (e) {
      this.ports.say(`Moving palette ${from + 1} failed: ${(e as Error).message}`);
    }
  }

  /** after Send bank moved patches to other slots: each entry follows its patch (bank.ts slotMoves), and so does each
   *  copy this browser kept (one whose patch left the bank goes) */
  async repoint(moves: ReadonlyMap<number, number>): Promise<void> {
    if (!this.linked || !this.now) return;
    this.copies = this.copies.flatMap((x) => { const to = moves.get(x.slot); return to === undefined ? [] : [{ ...x, slot: to }]; });
    this.storeCopies();
    const now = await this.ports.device.readPalette().catch(() => this.now!);
    for (const { pos, entry } of repointed(now, this.entries, moves)) {
      try {
        this.byHash.set(paletteHash(entry), entry);
        await this.ports.device.putPaletteEntry(pos, entry);
      } catch (e) {
        this.ports.say(`Palette ${pos + 1} could not follow "${entry.name}" to slot ${entry.slot + 1}: ${(e as Error).message}`);
      }
    }
  }

  /**
   * A click on a chip: a linked FM-1 switches to it (stopped at once, playing at the bar line). Under Live the editor
   * follows when the FM-1 says it switched (received); otherwise the editor opens the entry now, from this browser's
   * copy, or read from the FM-1 without one. With no FM-1 it opens the entry only.
   */
  async click(pos: number): Promise<void> {
    const p = this.now?.positions[pos];
    if (!p?.state) return this.ports.say(`Palette ${pos + 1} is empty: drag a patch onto it, or use Add to palette`);
    if (this.linked) {
      let ack: Ack;
      try {
        ack = await this.ports.device.goPalette(pos);
      } catch (e) {
        return this.ports.say(`Switching the FM-1 failed: ${(e as Error).message}`);
      }
      if (ack.status === PAL_EMPTY) return this.ports.say(`Palette ${pos + 1} is empty on the FM-1`);
      if (ack.status === PAL_MISSING) return this.ports.say(`Palette ${pos + 1} is MISSING: slot ${p.slot + 1} no longer holds "${p.name}"`);
      if (ack.status === PAL_REFUSED) return this.ports.say('The FM-1 is in sandbox mode: it keeps the patch');
      if (ack.status) return this.ports.say(`The FM-1 refused palette ${pos + 1} (error ${ack.status})`);
      if (ack.aux === PAL_GO_CANCELLED) return this.ports.say(`Switch to palette ${pos + 1} cancelled`);
      if (ack.aux === PAL_GO_WAITING) this.ports.say(`The FM-1 switches to palette ${pos + 1} · ${p.name} at the next bar line`);
      if (this.ports.live()) return;   // (it follows the switch when the FM-1 reports it)
    } else if (p.state === 2) return this.ports.say(`Palette ${pos + 1} was MISSING when last read: slot ${p.slot + 1} no longer held "${p.name}"`);
    if (!(await this.open(pos, false))) this.ports.say(`Palette ${pos + 1} · ${p.name}: no copy of this patch in this browser`);
  }

  /** open position `pos` from this browser's copy, its presets and pattern applied; false without a copy and without a
   *  patch the FM-1 sent back (true, nothing opened, when `stale` says a newer palette came meanwhile). A copy its slot
   *  holds byte for byte comes first (exactCopy), kept for the switches after (keepCopy); then a saved patch of the slot's
   *  name and length, or with firmware that cannot send a slot back, first the copy this browser kept of the sound it put
   *  there; with none, the slot read from the FM-1 (readFm1Slot), said with `lead` before the position's name */
  private async open(pos: number, adopt: boolean, stale = (): boolean => false, lead = `Palette ${pos + 1}`): Promise<boolean> {
    const p = this.now?.positions[pos];
    if (!p) return false;
    const copy = await this.copyAt(p);
    if (stale()) return true;   // (a newer palette came meanwhile: it follows on its own)
    const read = copy || p.state !== 1 ? null : await readFm1Slot(this.ports.device, p.slot, p.name);
    if (stale()) return true;
    const from = copy?.patch ?? read?.patch;
    if (!from) return false;
    const patch = structuredClone(from);
    const e = this.entries[pos];
    const gone = e ? applyEntry(patch, e) : [];
    const own = this.ownVersion(patch);
    this.ports.open(own ?? patch, { adopt, from: !copy || copy.factory ? '' : copy.name });
    // (the candidate heard keeps its own tempo and patterns, the FM-1 plays the slot's, D-1240: said, nothing sent back)
    const plays = own ? slotPlays(own, patch) : '';
    const lacks = gone.length ? `this browser has not got the preset${gone.length > 1 ? 's' : ''} ${gone.join(', ')}` : '';
    if (read) this.ports.say(`${lead} · ${p.name}: ${readLabel(read)}${lacks ? `; ${lacks}` : plays ? `; it plays the ${plays} of slot ${p.slot + 1}` : ''}`);
    else if (lacks) this.ports.say(`Palette ${pos + 1} · ${p.name}: ${lacks}`);
    else if (plays) this.ports.say(`Palette ${pos + 1} · ${p.name} plays the ${plays} of slot ${p.slot + 1}`);
    return true;
  }

  /** this browser's copy of position `p`'s patch, as a switch opens it: one its slot holds byte for byte first
   *  (exactCopy), kept for the switches after (keepCopy); then a saved patch of the slot's name and length, or with
   *  firmware that cannot send a slot back, first the copy this browser kept of the sound it put there. Null without one */
  private async copyAt(p: PalettePos): Promise<KnownCopy | null> {
    const exact = await this.exactCopy(p);
    if (exact) this.keepCopy(p.slot, p.name, exact.patch);
    return exact ?? positionCopy(p, this.ports.candidates(), undefined, this.ports.device.readsSlots ? [] : this.copies);
  }

  /**
   * Send to FM-1 (a saved palette's `sounds`, PALETTE_SIZE long): it replaces the FM-1's whole palette. Each sound goes
   * to its position by add's rules (place: device presets on a slot the FM-1 has where it fits, tempo and patterns never
   * forcing a patch; a patch otherwise, with its reason), its own presets looked up after this browser's; a position the
   * saved palette leaves empty is emptied, and so is one whose sound fails. Then the palette is read again and `from`
   * kept. Says one line: the count, then each position's line. False when blocked or nothing was written.
   */
  async send(sounds: readonly (PaletteSound | null)[], from: { id: string; name: string }): Promise<boolean> {
    const why = this.blocked();
    if (why) return this.ports.say(why), false;
    const d = this.ports.device;
    let wrote = false, added = 0, stored = 0, sent = 0;
    const lines: string[] = [];
    for (let pos = 0; pos < PALETTE_SIZE; pos++) {
      const s = sounds[pos] ?? null;
      if (s) {
        const r = await this.place(s.name, s.patch, { pos, presets: s.presets });
        if (r.ok) {
          wrote = true;
          added++;
          if (r.stored) stored++;
          sent += r.sent;
          lines.push(r.line);
          continue;
        }
        lines.push(`${pos + 1} failed: ${r.line}`);
      } else if (!this.now?.positions[pos]?.state) continue;
      try {
        await d.putPaletteEntry(pos, null);
        wrote = true;
      } catch (e) {
        if (!s) lines.push(`${pos + 1} could not be emptied: ${(e as Error).message}`);
      }
    }
    try {
      await this.take(await d.readPalette(), false);
      if (this.now) this.storeFrom({ id: from.id, name: from.name, hashes: hashesOf(this.now), seq: this.now.seq });
    } catch {
      /* the FM-1's own reports keep the chips; `from` is not kept */
    }
    const counts = [
      ...(stored ? [`${stored} stored as new patch${stored > 1 ? 'es' : ''}`] : []),
      ...(sent ? [`${sent} preset${sent > 1 ? 's' : ''} sent`] : []),
    ];
    this.ports.say(`${from.name} is on the FM-1: ${added} sound${added === 1 ? '' : 's'}${counts.length ? ` (${counts.join(', ')})` : ''}${lines.length ? ` · ${lines.join(' · ')}` : ''}`);
    return wrote;
  }

  /**
   * The FM-1's palette as sounds (Save from FM-1), each named as its slot. Linked: the palette is read again, each
   * position's copy is the one a switch opens (copyAt, else the slot read from the FM-1), and the entry's presets this
   * browser has not got are read from
   * the FM-1 (PRESETS + PRESET_GET: its name, in any case, of the entry's structure or namespace, any structure when the
   * entry does not know the namespace) and applied with it; they join the sound's presets. Offline: the last palette
   * read, each position's copy from the copies this browser kept first, then the editor's versions, the candidates and
   * saved patches by the slot's name and length; presets from this browser only. `missed`: each position it could not
   * include. Null (said) when the palette was never read.
   */
  async capture(): Promise<{ sounds: (PaletteSound | null)[]; missed: string[] } | null> {
    if (!this.now) return this.ports.say("The FM-1's palette was never read in this browser"), null;
    const d = this.ports.device, linked = this.linked && d.connected;
    if (linked) await this.take(await d.readPalette(), false);
    const now = this.now;
    const known = [...this.ports.versions().map((v) => ({ name: v.name, patch: () => v })), ...this.ports.candidates()];
    let onFm1: DevicePresetEntry[] | undefined;
    const sounds: (PaletteSound | null)[] = [], missed: string[] = [];
    for (let pos = 0; pos < PALETTE_SIZE; pos++) {
      const p = now.positions[pos], e = this.entries[pos];
      const copy = p.state !== 1 ? null : linked ? (await this.copyAt(p)) ?? (await readFm1Slot(d, p.slot, p.name)) : positionCopy(p, known, undefined, this.copies);
      if (!copy) {
        if (p.state) missed.push(`${pos + 1} · ${p.name} (${p.state === 2 ? 'MISSING' : 'no copy in this browser'})`);
        sounds.push(null);
        continue;
      }
      const patch = structuredClone(copy.patch);
      const extra: Preset[] = [];
      if (e && linked && d.hasPresets) {
        const gone = applyEntry(structuredClone(patch), e);
        for (const x of e.devices.filter((x) => gone.includes(x.name))) {
          onFm1 ??= await d.listPresets();
          const spaces = [x.structure, x.pstructure].map((n) => (n >>> 0).toString(16).padStart(8, '0'));
          for (const f of onFm1) {
            if (devicePresetName(f.name).toLowerCase() !== devicePresetName(x.name).toLowerCase() || (x.pstructure && !spaces.includes(f.structure))) continue;
            const values = await d.getPreset(f.structure, f.name);
            if (values) extra.push({ structure: f.structure, name: f.name, values });
          }
        }
      }
      if (e) applyEntry(patch, e, extra);
      sounds.push(soundOf(p.name, patch, extra));
    }
    return { sounds, missed };
  }

  /** the editor's own version that sounds as `patch` (a slot's patch with its entry applied) plays: the same patch
   *  (samePatch) and binary but for the preset names its cards show, its pattern origins, and its tempo and patterns,
   *  which a palette entry takes from the slot (presetFit: they make no other sound in the palette, owner 2026-11-24),
   *  so a switch to it opens that candidate. A copy, or null */
  private ownVersion(patch: Patch): Patch | null {
    const d = this.ports.device;
    let bin: Uint8Array;
    try {
      bin = d.encodeFor(patch);
    } catch {
      return null;
    }
    for (const v of this.ports.versions()) {
      if (!samePatch(v, patch)) continue;
      const q = structuredClone(v);
      q.name = patch.name;   // (the same as the FM-1 keeps names)
      for (const a of q.assemblies ?? []) {
        const n = assemblyById(patch, a.id)?.preset;
        if (n) a.preset = n;
        else delete a.preset;
      }
      takeTempoAndPatterns(q, patch);
      try {
        if (sameBytes(d.encodeFor(q), bin)) return structuredClone(v);
      } catch {
        /* over the FM-1's budget: not what it plays */
      }
    }
    return null;
  }

  /** the copy of `p`'s patch that its slot holds byte for byte (SLOT_GET; firmware that cannot send a slot back: none):
   *  the editor's own version first (versions: the patch on screen, the current patch, the candidates: a sound added from
   *  a candidate has no other copy), then a saved patch of the slot's name or the name before its number, then the copy
   *  this browser kept of the sound it put there (a candidate gone since, another patch opened since) */
  private async exactCopy(p: PalettePos): Promise<KnownCopy | null> {
    const d = this.ports.device;
    if (p.state !== 1 || !d.readsSlots) return null;
    const known: KnownCopy[] = [
      ...this.ports.versions().map((v) => ({ name: '', patch: v, factory: false })),
      ...this.ports.candidates().filter((c) => deviceName(c.name) === p.name || isNumbered(p.name, deviceName(c.name))).map((c) => ({ name: c.name, patch: c.patch(), factory: !!c.factory })),
      ...this.copies.filter((x) => x.slot === p.slot && x.name === p.name).map((x) => ({ name: '', patch: x.patch, factory: false })),
    ];
    const fits: { c: KnownCopy; bin: Uint8Array }[] = [];
    for (const c of known) {
      try {
        const bin = d.encodeFor(c.patch);
        if (bin.length === p.len) fits.push({ c, bin });
      } catch {
        /* over the FM-1's budget: not a patch it plays */
      }
    }
    if (!fits.length) return null;
    const held = await d.readSlotBin(p.slot).catch(() => null);
    return (held && fits.find((x) => sameBytes(held, x.bin))?.c) ?? null;
  }

  /**
   * The FM-1 plays position `pos` under Live (`now` the read that said so): a switch opens its copy, or the slot read
   * from the FM-1 without one, without sending it back (Live goes on), or turns Live off with neither. A position that
   * holds the editor's patch (`at`: as it was when the FM-1 said it
   * plays the slot) is no switch: the FM-1 saved the patch it played from the editor there (HOME + a black key held,
   * #1244), so the editor keeps its patch and Live rather than open a copy of that name and length, which can be an older
   * one, or turn Live off for want of one. A position that holds anything else is a switch, whatever made it.
   */
  private async follow(now: PaletteNow, pos: number, at: Patch): Promise<void> {
    const p = now.positions[pos];
    const mine = await this.holds(pos, at);
    if (this.taken !== now) return;   // (a newer palette came meanwhile: it follows on its own)
    if (mine) {
      this.keepCopy(p.slot, p.name, at);   // (the FM-1 stored the editor's patch there: a switch back opens it)
      return this.ports.kept();
    }
    if (await this.open(pos, true, () => this.taken !== now, `FM-1 switched to palette ${pos + 1}`)) return;
    this.ports.liveOff(`FM-1 switched to palette ${pos + 1} · ${p.name}: no copy in this browser, so Live sync is off`);
  }

  /** position `pos` plays `patch` as it is: its entry sets nothing on it, and its slot holds it byte for byte (SLOT_GET;
   *  firmware that cannot send a slot back: never) */
  private async holds(pos: number, patch: Patch): Promise<boolean> {
    const d = this.ports.device, p = this.now?.positions[pos], e = this.entries[pos];
    if (!p || p.state !== 1 || !e || !d.readsSlots) return false;
    let bin: Uint8Array;
    try {
      const applied = structuredClone(patch);
      applyEntry(applied, e);
      bin = d.encodeFor(patch);
      if (bin.length !== p.len || !sameBytes(d.encodeFor(applied), bin)) return false;
    } catch {
      return false;   // (over the FM-1's budget: not the patch it plays)
    }
    const held = await d.readSlotBin(p.slot).catch(() => null);
    return !!held && sameBytes(held, bin);
  }
}
