// SPDX-License-Identifier: GPL-3.0-only
// The palette (#1196): up to 8 sounds collected for a project, kept on the FM-1 (HOME + black key 1..8 switches to one,
// held 1 s saves the current sound there). An entry is a bank slot checked by the patch's name (MISSING when the slot no
// longer holds it), every device's preset as it was saved, and the selected pattern. The FM-1 holds the palette; the
// editor shows it as 8 chips (palette-view.ts), collects into it, reorders and removes, and opens an entry from this
// browser's copy of its patch: the editor's own version or a saved patch its slot holds byte for byte (SLOT_GET), the copy
// this browser kept of each sound it put into the palette (PALETTE_COPIES), else a saved patch of the slot's name and
// binary length (D-605). Adding a sound first saves on the FM-1 what it needs to play it as the editor shows it: each
// user preset the entry names (PRESET_PUT) and the patch in a slot that holds it byte for byte (SLOT_GET), else stored
// into a free one. The link: protocol.ts PALETTE / PALETTE_NOW / PALETTE_ENTRY (feature bit 31). With no FM-1 the chips
// show the last palette read, read-only (kept in this browser).
import { assemblyById } from './assembly';
import { binLength, deviceName, knownCopy, type Candidate, type KnownCopy } from './bank';
import { applyPreset, presetsOf, rememberedPreset, sameName, userPresets, type Preset } from './device-presets';
import type { Patch } from './patch';
import { layout } from './patchbin';
import { devicePresetName, NAME_BYTES, PAL_EMPTY, PAL_GO_CANCELLED, PAL_GO_WAITING, PAL_MISSING, PAL_REFUSED, PALETTE_DEVS, PALETTE_SIZE, paletteHash, STATUS_PRESETS_FULL, type Ack, type DevicePresetEntry, type PaletteDevice, type PaletteEntry, type PaletteNow, type PalettePos, type SlotInfo } from './protocol';
import { structureAndRows } from './structure';
import { fixSeq } from './track';

/** where this browser keeps the last palette read (the chips show it, greyed, with no FM-1) */
export const PALETTE_STORE = 'matryoshka.palette';
/** where it keeps its copies of the sounds it put into the palette (PaletteCopy), apart: a patch is tens of kB, and a
 *  store too full for them still keeps the palette */
export const PALETTE_COPIES = 'matryoshka.palette-copies';
/** the characters of a preset name the patch binary keeps (the FM-1 compares this many) */
const BIN_PRESET_CHARS = 12;

/** a preset name as an entry's: the same, case aside, over the characters the FM-1 compares when one side is longer */
const samePreset = (a: string | undefined, b: string): boolean =>
  !!a && (sameName(a, b) || ((a.length > BIN_PRESET_CHARS || b.length > BIN_PRESET_CHARS) && sameName(a.slice(0, BIN_PRESET_CHARS), b.slice(0, BIN_PRESET_CHARS))));

/** the devices of `patch` that hold a preset, as an entry keeps them: the device's index in the binary's device extras,
 *  its structure, the preset's namespace (the structure the preset belongs to: the device's own, or that of its instrument
 *  with its FX drawer, FXD1; 0 when not known, and the FM-1 looks the name up), the preset's name. A device with no preset
 *  name plays the slot's own values and is left out; the first PALETTE_DEVS are kept */
export function paletteDevices(patch: Patch): PaletteDevice[] {
  const out: PaletteDevice[] = [];
  layout(patch).devs.forEach((d, dev) => {
    const a = d.asm === undefined ? undefined : assemblyById(patch, d.asm);
    const name = devicePresetName(a?.preset ?? '');
    if (!a || !name) return;
    const structure = parseInt(structureAndRows(patch, a).structure, 16) >>> 0;
    if (!structure) return;
    const known = rememberedPreset(patch, a);
    out.push({ dev, structure, pstructure: known ? parseInt(known.structure, 16) >>> 0 : 0, name });
  });
  return out.slice(0, PALETTE_DEVS);
}

/** the user presets the entry of `patch` names, as this browser keeps them, each under the name the entry gives it: the
 *  ones the FM-1 needs to be sent (a factory preset is on it already; a name this browser has no preset of has nothing
 *  to send, and the device plays the slot's own values on the FM-1) */
export function entryPresets(patch: Patch): { name: string; preset: Preset }[] {
  const devs = layout(patch).devs;
  return paletteDevices(patch).flatMap((d) => {
    const asm = devs[d.dev].asm, a = asm === undefined ? undefined : assemblyById(patch, asm);
    const known = a && rememberedPreset(patch, a);
    if (!known || known.factory) return [];
    const own = userPresets().find((x) => x.structure === known.structure && sameName(x.name, known.name));
    return own ? [{ name: d.name, preset: own }] : [];
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

/** two binaries are the same, byte for byte */
const sameBytes = (a: ArrayLike<number>, b: ArrayLike<number>): boolean => a.length === b.length && Array.prototype.every.call(a, (x: number, i: number) => x === b[i]);

/** the selected pattern of `patch` (0-based) */
export const patchPattern = (patch: Patch): number => patch.modules.find((m) => m.type === 'fm1')?.seq?.pattern ?? 0;

/** the entry of `patch` in slot `slot` under `name`, the slot's own name (default: the patch's, as the editor names the
 *  slots it stores) */
export const entryOf = (patch: Patch, slot: number, name = deviceName(patch.name.trim() || 'PATCH')): PaletteEntry =>
  ({ slot, pattern: patchPattern(patch), name, devices: paletteDevices(patch) });

/**
 * The entry applied to `patch` (a copy of its slot's patch) as the FM-1 applies it before its load: each device whose
 * preset name differs from the entry's takes the entry's preset (factory first, then the user's, by name), values only,
 * as the FM-1 brings no preset pattern; an FX drawer preset only where the drawer holds its effects already (the FM-1
 * never rebuilds a drawer). Then the entry's pattern is selected and no song plays. Returns the preset names this
 * browser has not got (those devices keep the slot's values, as on an FM-1 without them).
 */
export function applyEntry(patch: Patch, entry: PaletteEntry): string[] {
  const gone: string[] = [];
  const devs = layout(patch).devs;
  const structureOf = (asm: number | undefined): number => {
    const a = asm === undefined ? undefined : assemblyById(patch, asm);
    return a ? parseInt(structureAndRows(patch, a).structure, 16) >>> 0 : 0;
  };
  for (const e of entry.devices) {
    const d = structureOf(devs[e.dev]?.asm) === e.structure ? devs[e.dev] : devs.find((x) => structureOf(x.asm) === e.structure);
    const a = d?.asm === undefined ? undefined : assemblyById(patch, d.asm);
    if (!a) { gone.push(e.name); continue; }
    if (samePreset(a.preset, e.name)) continue;
    const list = presetsOf(patch, a);
    const preset = list.find((p) => samePreset(p.name, e.name) && (!e.pstructure || parseInt(p.structure, 16) >>> 0 === e.pstructure)) ?? list.find((p) => samePreset(p.name, e.name));
    if (!preset || !applyPreset(patch, a, { ...preset, factory: undefined })) gone.push(e.name);
  }
  const main = patch.modules.find((m) => m.type === 'fm1');
  if (main) {
    const seq = fixSeq({ ...main.seq, pattern: entry.pattern, song: 0 });
    if (seq) main.seq = seq;
    else delete main.seq;
  }
  return gone;
}

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
  /** this browser has a copy of its patch (false: a click cannot open it here) */
  copy: boolean;
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

  constructor(private ports: PalettePorts, private storage: Pick<Storage, 'getItem' | 'setItem'> | null = globalThis.localStorage ?? null) {
    const kept = loadKept(storage);
    this.now = kept?.now ?? null;
    this.entries = kept?.entries ?? Array<PaletteEntry | null>(PALETTE_SIZE).fill(null);
    this.entries.forEach((e) => { if (e) this.byHash.set(paletteHash(e), e); });
    this.copies = loadCopies(storage);
    this.findCopies();
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

  /** take a palette read: fetch the entries whose hash is new, keep it, and under Live follow a switch */
  private async take(now: PaletteNow, follow: boolean): Promise<void> {
    this.now = now;
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
   * 2026-11-23). Each user preset the entry names goes to the FM-1's preset store when it has none of that name and
   * structure or one with other values (a factory preset is there already). The patch is pointed at in a slot that holds
   * it byte for byte (SLOT_GET; a slot of its name or its name numbered), under that slot's own name, which the FM-1
   * checks case and all (a factory slot is `808 Kit`); otherwise it is stored into the first free slot, named after it,
   * or numbered ("MY PAD 2") when another patch has that name. A preset the FM-1 cannot take (its store full, firmware
   * without presets or too old for that preset) is left out of the entry: the slot's patch carries its values. `slot`:
   * an FM-1 slot dragged from the FM-1 column, pointed at as it is; `patch` null: one this browser has no copy of (its
   * entry keeps no presets, pattern 1). A failure takes back what was stored for it and says so. False when nothing was
   * added.
   */
  async add(name: string, patch: Patch | null, o: { pos?: number; slot?: { slot: number; name: string } } = {}): Promise<boolean> {
    const why = this.blocked();
    if (why) return this.ports.say(why), false;
    const pos = o.pos ?? this.firstEmpty();
    if (pos === null) return this.ports.full(PALETTE_FULL, (at) => void this.add(name, patch, { ...o, pos: at })), false;
    if (!patch && !o.slot) return false;
    const d = this.ports.device;
    /** what was written to the FM-1 for this sound, to take back on a failure */
    const undo: (() => Promise<unknown>)[] = [];
    let erased = false;
    try {
      const place = o.slot ? { slot: o.slot.slot, label: o.slot.name, store: false } : await this.placeFor(patch!, deviceName(name.trim() || 'PATCH'));
      if (!place) return this.ports.say(`The FM-1's bank is full: "${name}" was not added to the palette`), false;
      const presets = patch ? await this.sendPresets(patch, undo) : { sent: [], updated: [], lost: [] };
      if (place.store) {
        this.ports.say(`Storing "${name}" into FM-1 slot ${place.slot + 1}…`);
        await d.uploadSlot(place.slot, place.label, patch!);
        undo.push(() => d.eraseSlot(place.slot).then(() => { erased = true; }));
        this.ports.banked?.();
      }
      const lost = new Set(presets.lost.map((x) => x.name));
      const entry: PaletteEntry = patch ? entryOf(patch, place.slot, place.label) : { slot: place.slot, pattern: 0, name: place.label, devices: [] };
      entry.devices = entry.devices.filter((x) => !lost.has(x.name));
      this.byHash.set(paletteHash(entry), entry);
      await d.putPaletteEntry(pos, entry);
      // (the sound as this browser put it there: a switch to it opens it whatever the editor shows by then; a slot dragged
      // from the FM-1 column holds what it holds, its copy found by name and length)
      if (patch && !o.slot) this.keepCopy(place.slot, place.label, patch);
      const notes = [
        ...(presets.sent.length ? [`${presetWord(presets.sent)} sent to the FM-1`] : []),
        ...(presets.updated.length ? [`${presetWord(presets.updated)} updated on the FM-1`] : []),
        ...(place.store && place.clash !== undefined ? [`slot ${place.clash + 1} holds another "${deviceName(name.trim() || 'PATCH')}", so it is stored as "${place.label}" in slot ${place.slot + 1}`] : []),
      ];
      const fallback = presets.lost.length
        ? `. The FM-1 could not take ${presets.lost.map((x) => `preset ${x.name} (${x.why})`).join(', ')}: palette ${pos + 1} plays the values stored with the patch in slot ${place.slot + 1}`
        : '';
      this.ports.say(`"${name}" is palette ${pos + 1}${notes.length ? ` (${notes.join('; ')})` : ''}${fallback}`);
      return true;
    } catch (e) {
      const failed = `Adding "${name}" to the palette failed: ${(e as Error).message}`;
      if (!undo.length) return this.ports.say(failed), false;
      try {
        for (const back of undo.reverse()) await back();
        this.ports.say(`${failed}. Nothing was added: what it stored on the FM-1 for it is taken back`);
      } catch (e2) {
        this.ports.say(`${failed}. Taking back what it stored on the FM-1 failed too (${(e2 as Error).message}): check Library > Presets and the FM-1 column`);
      }
      if (erased) this.ports.banked?.();
      return false;
    }
  }

  /** where `patch` goes in the FM-1's bank under `label` (its device name): a slot that holds it byte for byte, of that
   *  name or of the patch's own name (a candidate's label adds its letter or name to it, D-1319), either numbered;
   *  firmware that cannot send a slot back has none. Else the first free slot under `label`, numbered when a used slot
   *  has that name (`clash`: that slot); null when the bank is full. Nothing is written */
  private async placeFor(patch: Patch, label: string): Promise<{ slot: number; label: string; store: boolean; clash?: number } | null> {
    const d = this.ports.device;
    const bank = await d.readBank();
    const bin = d.encodeFor(patch);
    if (d.readsSlots) {
      const names = [label, deviceName(patch.name.trim() || 'PATCH')];
      for (const s of bank) {
        const n = deviceName(s.name);
        if (!s.used || s.length !== bin.length || !names.some((x) => n === x || isNumbered(n, x))) continue;
        const held = await d.readSlotBin(s.slot);
        if (held && sameBytes(held, bin)) return { slot: s.slot, label: s.name, store: false };
      }
    }
    const free = bank.find((s) => !s.used);
    if (!free) return null;
    const taken = new Set(bank.filter((s) => s.used).map((s) => deviceName(s.name)));
    let as = label;
    for (let k = 2; taken.has(as); k++) as = numberedName(label, k);
    const clash = bank.find((s) => s.used && deviceName(s.name) === label)?.slot;
    return { slot: free.slot, label: as, store: true, ...(clash === undefined ? {} : { clash }) };
  }

  /** send the FM-1 the user presets the entry of `patch` names that it has not got, or has with other values (compared
   *  in Q16, as it keeps them); each write's undo goes onto `undo`. A preset it cannot take (its store full, firmware
   *  without presets or too old for it) is `lost`, with why; any other failure throws */
  private async sendPresets(patch: Patch, undo: (() => Promise<unknown>)[]): Promise<{ sent: string[]; updated: string[]; lost: { name: string; why: string }[] }> {
    const d = this.ports.device;
    const out = { sent: [] as string[], updated: [] as string[], lost: [] as { name: string; why: string }[] };
    const want = entryPresets(patch);
    if (!want.length) return out;
    if (!d.hasPresets) return { ...out, lost: want.map((w) => ({ name: w.name, why: 'update the FM-1 to store presets on it' })) };
    const on = await d.listPresets();
    const done = new Set<string>();
    const q16 = (v: number): number => Math.round(v * 65536);
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
   * copy. With no FM-1 it opens the entry only.
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

  /** open position `pos` from this browser's copy, its presets and pattern applied; false without a copy (true, nothing
   *  opened, when `stale` says a newer palette came meanwhile). A copy its slot holds byte for byte comes first
   *  (exactCopy), kept for the switches after (keepCopy); then a saved patch of the slot's name and length, or with
   *  firmware that cannot send a slot back, first the copy this browser kept of the sound it put there */
  private async open(pos: number, adopt: boolean, stale = (): boolean => false): Promise<boolean> {
    const p = this.now?.positions[pos];
    if (!p) return false;
    const exact = await this.exactCopy(p);
    if (stale()) return true;   // (a newer palette came meanwhile: it follows on its own)
    if (exact) this.keepCopy(p.slot, p.name, exact.patch);
    const copy = exact ?? positionCopy(p, this.ports.candidates(), undefined, this.ports.device.readsSlots ? [] : this.copies);
    if (!copy) return false;
    const patch = structuredClone(copy.patch);
    const e = this.entries[pos];
    const gone = e ? applyEntry(patch, e) : [];
    this.ports.open(patch, { adopt, from: copy.factory ? '' : copy.name });
    if (gone.length) this.ports.say(`Palette ${pos + 1} · ${p.name}: this browser has not got the preset${gone.length > 1 ? 's' : ''} ${gone.join(', ')}`);
    return true;
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
   * The FM-1 plays position `pos` under Live (`now` the read that said so): a switch opens its copy without sending it
   * back, or turns Live off without one. A position that holds the editor's patch (`at`: as it was when the FM-1 said it
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
    if (await this.open(pos, true, () => this.taken !== now)) return;
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
