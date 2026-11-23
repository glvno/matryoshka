// SPDX-License-Identifier: GPL-3.0-only
// The palette (#1196): up to 8 sounds collected for a project, kept on the FM-1 (HOME + black key 1..8 switches to one,
// held 1 s saves the current sound there). An entry is a bank slot checked by the patch's name (MISSING when the slot no
// longer holds it), every device's preset as it was saved, and the selected pattern. The FM-1 holds the palette; the
// editor shows it as 8 chips (palette-view.ts), collects into it, reorders and removes, and opens an entry from this
// browser's copy of its patch (D-605: the same name and binary length). The link: protocol.ts PALETTE / PALETTE_NOW /
// PALETTE_ENTRY (feature bit 31). With no FM-1 the chips show the last palette read, read-only (kept in this browser).
import { assemblyById } from './assembly';
import { binLength, deviceName, knownCopy, type Candidate, type KnownCopy } from './bank';
import { applyPreset, presetsOf, rememberedPreset, sameName } from './device-presets';
import type { Patch } from './patch';
import { layout } from './patchbin';
import { devicePresetName, PAL_EMPTY, PAL_GO_CANCELLED, PAL_GO_WAITING, PAL_MISSING, PAL_REFUSED, PALETTE_DEVS, PALETTE_SIZE, paletteHash, type Ack, type PaletteDevice, type PaletteEntry, type PaletteNow, type PalettePos, type SlotInfo } from './protocol';
import { structureAndRows } from './structure';
import { fixSeq } from './track';

/** where this browser keeps the last palette read (the chips show it, greyed, with no FM-1) */
export const PALETTE_STORE = 'matryoshka.palette';
/** the characters of a preset name the patch binary keeps (the FM-1 compares this many) */
const BIN_PRESET_CHARS = 12;

/** a preset name as an entry's: the same, case aside, over the characters the FM-1 compares when one side is longer */
const samePreset = (a: string | undefined, b: string): boolean =>
  !!a && (sameName(a, b) || ((a.length > BIN_PRESET_CHARS || b.length > BIN_PRESET_CHARS) && sameName(a.slice(0, BIN_PRESET_CHARS), b.slice(0, BIN_PRESET_CHARS))));

/** the devices of `patch` that hold a preset, as an entry keeps them: the device's index in the binary's device extras,
 *  its structure, the preset's namespace (the structure the preset belongs to: the device's own, or its FX-scoped one; 0
 *  when not known, and the FM-1 looks the name up), the preset's name. A device with no preset name plays the slot's own
 *  values and is left out; the first PALETTE_DEVS are kept */
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

/** the selected pattern of `patch` (0-based) */
export const patchPattern = (patch: Patch): number => patch.modules.find((m) => m.type === 'fm1')?.seq?.pattern ?? 0;

/** the entry of `patch` in slot `slot` under `name`, the slot's own name (default: the patch's, as the editor names the
 *  slots it stores) */
export const entryOf = (patch: Patch, slot: number, name = deviceName(patch.name.trim() || 'PATCH')): PaletteEntry =>
  ({ slot, pattern: patchPattern(patch), name, devices: paletteDevices(patch) });

/**
 * The entry applied to `patch` (a copy of its slot's patch) as the FM-1 applies it before its load: each device whose
 * preset name differs from the entry's takes the entry's preset (factory first, then the user's, by name), values only,
 * as the FM-1 brings no preset pattern; then the entry's pattern is selected and no song plays. Returns the preset names
 * this browser has not got (those devices keep the slot's values, as on an FM-1 without them).
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

/** this browser's copy of a position's patch (D-605: the slot's name and binary length now), or null */
export const positionCopy = (p: PalettePos, candidates: Candidate[], length?: (p: Patch) => number): KnownCopy | null =>
  p.state === 1 ? knownCopy({ slot: p.slot, used: true, length: p.len, name: p.name }, candidates, length) : null;

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
  };
  /** this browser's patches that can be an entry's copy (bank.ts bankCandidates) */
  candidates(): Candidate[];
  /** Live sync is on and the FM-1 plays the editor's patch */
  live(): boolean;
  /** open `patch` in the editor; `adopt`: the FM-1 plays it already (a switch under Live): no upload */
  open(patch: Patch, o: { adopt: boolean; from: string }): void;
  /** turn Live sync off and say why */
  liveOff(why: string): void;
  say(text: string): void;
  /** a sound was stored into an FM-1 slot on its way into the palette: the Library's FM-1 column reads the bank again */
  banked?(): void;
  /** the chips changed: draw them again */
  changed(): void;
}

/** the reason the palette cannot be changed now, or null */
const SWITCH_WAITS = 'The FM-1 is waiting to switch at the bar line: try again after it switched';

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
  private copies: boolean[] = [];
  /** an FM-1 linked that keeps a palette: the chips are live (otherwise read-only, the last read) */
  linked = false;

  constructor(private ports: PalettePorts, private storage: Pick<Storage, 'getItem' | 'setItem'> | null = globalThis.localStorage ?? null) {
    const kept = loadKept(storage);
    this.now = kept?.now ?? null;
    this.entries = kept?.entries ?? Array<PaletteEntry | null>(PALETTE_SIZE).fill(null);
    this.entries.forEach((e) => { if (e) this.byHash.set(paletteHash(e), e); });
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

  /** a PALETTE_NOW the FM-1 sent unasked (a switch, a hold-save, a write, a slot gone MISSING) */
  received(now: PaletteNow): void {
    if (this.linked) void this.take(now, true);
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
    const was = this.taken;
    this.taken = now;
    if (follow && was && now.cur !== null && now.cur !== was.cur && this.ports.live()) this.follow(now.cur);
  }

  private keep(): void {
    try {
      this.storage?.setItem(PALETTE_STORE, JSON.stringify({ now: this.now, entries: this.entries }));
    } catch {
      /* storage blocked: the chips show the palette while connected only */
    }
  }

  /** work out which positions this browser has a copy of (after the palette or the browser's patches changed) */
  findCopies(): void {
    const known = this.ports.candidates();
    this.copies = (this.now?.positions ?? []).map((p) => !!positionCopy(p, known));
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
        copy: !!this.copies[pos],
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
   * (Add to palette). A sound already in one of the FM-1's slots (`slot`, or one with its name, case aside, and binary
   * length) is pointed at under that slot's own name, which the FM-1 checks case and all (a factory slot is `808 Kit`);
   * another is stored into the first free slot first, named after it. `patch` null: an FM-1 slot this browser has no copy
   * of (its entry keeps no presets, pattern 1). False when nothing was added.
   */
  async add(name: string, patch: Patch | null, o: { pos?: number; slot?: { slot: number; name: string } } = {}): Promise<boolean> {
    const why = this.blocked();
    if (why) return this.ports.say(why), false;
    const pos = o.pos ?? this.firstEmpty();
    if (pos === null) return this.ports.say('Palette full: drag onto a chip to replace'), false;
    const d = this.ports.device;
    let label = deviceName(name.trim() || 'PATCH');
    try {
      let slot: number;
      if (o.slot) ({ slot, name: label } = o.slot);
      else {
        if (!patch) return false;
        const bank = await d.readBank();
        const length = binLength(patch);
        const on = bank.find((s) => s.used && deviceName(s.name) === label && s.length === length);
        if (on) {
          slot = on.slot;
          label = on.name;
        } else {
          const free = bank.find((s) => !s.used);
          if (!free) return this.ports.say(`The FM-1's bank is full: "${name}" was not added to the palette`), false;
          this.ports.say(`Storing "${name}" into FM-1 slot ${free.slot + 1}…`);
          await d.uploadSlot(free.slot, label, patch);
          slot = free.slot;
          this.ports.banked?.();
        }
      }
      const entry = patch ? entryOf(patch, slot, label) : { slot, pattern: 0, name: label, devices: [] };
      this.byHash.set(paletteHash(entry), entry);
      await d.putPaletteEntry(pos, entry);
      this.ports.say(`"${name}" is palette ${pos + 1}`);
      return true;
    } catch (e) {
      this.ports.say(`Adding "${name}" to the palette failed: ${(e as Error).message}`);
      return false;
    }
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

  /** after Send bank moved patches to other slots: each entry follows its patch (bank.ts slotMoves) */
  async repoint(moves: ReadonlyMap<number, number>): Promise<void> {
    if (!this.linked || !this.now) return;
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
    if (!this.open(pos, false)) this.ports.say(`Palette ${pos + 1} · ${p.name}: no copy of this patch in this browser`);
  }

  /** open position `pos` from this browser's copy, its presets and pattern applied; false without a copy */
  private open(pos: number, adopt: boolean): boolean {
    const p = this.now?.positions[pos];
    const copy = p && positionCopy(p, this.ports.candidates());
    if (!p || !copy) return false;
    const patch = structuredClone(copy.patch);
    const e = this.entries[pos];
    const gone = e ? applyEntry(patch, e) : [];
    this.ports.open(patch, { adopt, from: copy.factory ? '' : copy.name });
    if (gone.length) this.ports.say(`Palette ${pos + 1} · ${p.name}: this browser has not got the preset${gone.length > 1 ? 's' : ''} ${gone.join(', ')}`);
    return true;
  }

  /** the FM-1 switched to position `pos` under Live: open its copy without sending it back, or turn Live off */
  private follow(pos: number): void {
    const p = this.now!.positions[pos];
    if (this.open(pos, true)) return;
    this.ports.liveOff(`FM-1 switched to palette ${pos + 1} · ${p.name}: no copy in this browser, so Live sync is off`);
  }
}
