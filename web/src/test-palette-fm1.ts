// SPDX-License-Identifier: GPL-3.0-only
// A stand-in FM-1 that keeps a palette (#1196) as build/palette/spec.md §5 says the firmware does, for the editor's
// tests: HELLO (INFO with feature bit 31, the presets' bits 7 and 17, and byte 25's SLOT_GET), the bank (SLOT_INFO, CHUNK,
// SLOT, SLOT_ERASE, SLOT_GET of the bytes stored), the user preset store (PRESETS, PRESET_GET, PRESET_PUT, PRESET_DEL; a
// room of `presetRoom` presets, then the store is full), and PALETTE's six ops with their ACKs, PALETTE_NOW (unasked only
// after a GET) and PALETTE_ENTRY; and the panel's hold-save (`holdSave`). It answers on a fake Web MIDI input, a
// millisecond later.
import { CMD, crc16, decodePaletteEntry, encodePaletteEntry, FEATURE25_SLOT_GET, FEATURE_LONG_PRESETS, frame, NAME_BYTES, PALETTE, PALETTE_SIZE, parse, PRESET_NAME_BYTES, type PaletteEntry, type SlotInfo } from './protocol';

/** a user preset as the stand-in keeps it: its structure (8 hex digits), its name as sent, its values in Q16 */
export interface StoredPreset { structure: string; name: string; q16: number[] }

/** the PRESET_PUT status of a full store, and of a refused PALETTE PUT (protocol.ts STATUS_TEXT) */
const S_FULL = 7, S_MISSING = 8;

/** the default features: the palette, the presets and their 176 values */
export const PALETTE_FM1_FEATURES = (1 << 31) | 0x80 | FEATURE_LONG_PRESETS;

export interface PalettePort {
  id: string; name: string; manufacturer: string; state: string;
  onmidimessage: ((ev: { data: Uint8Array }) => void) | null;
  sent: Uint8Array[];
  send(d: ArrayLike<number>): void;
}

const nameOf = (b: ArrayLike<number>, at: number): string => {
  let s = '';
  for (let i = 0; i < NAME_BYTES && b[at + i]; i++) s += String.fromCharCode(b[at + i]);
  return s;
};
const name20 = (s: string): number[] => Array.from({ length: NAME_BYTES }, (_, i) => s.charCodeAt(i) || 0);
/** a preset's key in a frame: u32 LE structure, PRESET_NAME_BYTES name bytes */
const pkey = (p: { structure: string; name: string }): number[] => {
  const h = parseInt(p.structure, 16) >>> 0;
  return [h & 0xff, (h >>> 8) & 0xff, (h >>> 16) & 0xff, h >>> 24, ...Array.from({ length: PRESET_NAME_BYTES }, (_, i) => p.name.charCodeAt(i) || 0)];
};

export class PaletteFm1 {
  readonly i: PalettePort;
  readonly o: PalettePort;
  slots: SlotInfo[];
  /** each slot's binary as stored (a used slot a test set without one reads back as zeros) */
  bins: (Uint8Array | null)[];
  /** the user preset store */
  presets: StoredPreset[] = [];
  /** how many user presets the store holds at most */
  presetRoom: number;
  /** PALETTE PUT is refused (as a slot gone MISSING) */
  refusePut = false;
  entries: (PaletteEntry | null)[] = Array<PaletteEntry | null>(PALETTE_SIZE).fill(null);
  cur: number | null = null;
  next: number | null = null;
  seq = 0;
  /** the transport runs: GO waits for the bar line (next), until `bar()` */
  running = false;
  /** the editor sent GET since HELLO: PALETTE_NOW goes out unasked */
  asked = false;
  /** the last NAME */
  liveName = '';
  /** every PALETTE op the editor sent, in order */
  ops: number[] = [];
  private chunkTotal = 0;
  private chunk: number[] = [];
  /** answers sent but not yet arrived */
  private pending = 0;

  constructor(o: { features?: number; features25?: number; slots?: SlotInfo[]; presetRoom?: number } = {}) {
    const port = (id: string): PalettePort => {
      const p: PalettePort = { id, name: 'Matryoshka', manufacturer: '', state: 'connected', onmidimessage: null, sent: [], send: (d) => void p.sent.push(Uint8Array.from(d)) };
      return p;
    };
    this.i = port('m');
    this.o = port('M');
    this.slots = o.slots ?? Array.from({ length: 64 }, (_, slot) => ({ slot, used: false, length: 0, name: '' }));
    this.bins = this.slots.map(() => null);
    this.presetRoom = o.presetRoom ?? 32;
    const features = o.features ?? PALETTE_FM1_FEATURES, features25 = o.features25 ?? FEATURE25_SLOT_GET;
    this.o.send = (d) => {
      const bytes = Uint8Array.from(d);
      this.o.sent.push(bytes);
      const p = parse(bytes);
      if (!p) return;
      if (p.cmd === CMD.hello) {
        this.asked = false;
        this.reply(frame(CMD.info, [1, 64, 255, 3, 1, features & 0xff, (features >> 8) & 0xff, 48, 65, 1, 26, 0, (features >> 16) & 0xff, 1, (features >>> 24) & 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, features25]));
      } else if (p.cmd === CMD.slotInfo) {
        const s = this.slots[p.payload[0]];
        this.reply(frame(CMD.slotReply, [s.slot, s.used ? 1 : 0, s.length & 0xff, s.length >> 8, ...name20(s.name)]));
      } else if (p.cmd === CMD.chunk) {
        const off = p.payload[1] | (p.payload[2] << 8);
        this.chunkTotal = p.payload[3] | (p.payload[4] << 8);
        if (!off) this.chunk = [];
        this.chunk.splice(off, p.payload.length - 5, ...p.payload.slice(5));
        this.ack(CMD.chunk, p.payload[0], 0);
      } else if (p.cmd === CMD.slot) {
        const slot = p.payload[0];
        this.slots[slot] = { slot, used: true, length: this.chunkTotal, name: nameOf(p.payload, 1) };
        this.bins[slot] = Uint8Array.from(this.chunk.slice(0, this.chunkTotal));
        this.ack(CMD.slot, slot, 0);
        this.report();
      } else if (p.cmd === CMD.slotErase) {
        const slot = p.payload[0];
        this.slots[slot] = { slot, used: false, length: 0, name: '' };
        this.bins[slot] = null;
        this.ack(CMD.slotErase, slot, 0);
        this.report();
      } else if (p.cmd === CMD.slotGet && features25 & FEATURE25_SLOT_GET) {
        const slot = p.payload[0], off = p.payload[1] | (p.payload[2] << 8), s = this.slots[slot];
        const bin = s?.used ? this.bins[slot] ?? new Uint8Array(s.length) : null;
        const total = bin ? bin.length : 0xffff;
        this.reply(frame(CMD.slotData, [slot, total & 0xff, total >> 8, p.payload[1], p.payload[2], ...(bin ? bin.subarray(off, off + 256) : [])]));
      } else if (features & 0x80 && p.cmd >= CMD.presets && p.cmd <= CMD.presetDel) this.preset(p.cmd, p.payload);
      else if (p.cmd === PALETTE.cmd && (features >>> 31) & 1) this.palette(p.payload);
    };
  }

  /** the stored preset of this structure and name (in any case, as the firmware's ps_name_cmp) */
  findPreset(structure: string, name: string): StoredPreset | undefined {
    return this.presets.find((x) => x.structure === structure && x.name.toUpperCase() === name.toUpperCase());
  }

  private preset(cmd: number, b: number[]): void {
    if (cmd === CMD.presets) {
      const n = this.presets.length;
      if (!n) return this.reply(frame(CMD.preset, [0, 0, ...Array<number>(21).fill(0)]));
      this.presets.forEach((x, k) => this.reply(frame(CMD.preset, [k, n, ...pkey(x), x.q16.length])));
      return;
    }
    const key = {
      structure: ((b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0).toString(16).padStart(8, '0'),
      name: String.fromCharCode(...b.slice(4, 4 + PRESET_NAME_BYTES).filter((c) => c)),
    };
    const have = this.findPreset(key.structure, key.name);
    if (cmd === CMD.presetGet) {
      const values = have ? have.q16.flatMap((v) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff]) : [];
      this.reply(frame(CMD.presetData, have ? [...pkey(key), have.q16.length, ...values] : [...pkey(key), 0xff]));
    } else if (cmd === CMD.presetPut) {
      const at = 5 + PRESET_NAME_BYTES, q16 = Array.from({ length: b[at - 1] }, (_, i) => b[at + 4 * i] | (b[at + 4 * i + 1] << 8) | (b[at + 4 * i + 2] << 16) | (b[at + 4 * i + 3] << 24));
      if (have) have.q16 = q16;
      else if (this.presets.length >= this.presetRoom) return this.ack(CMD.presetPut, 0, S_FULL);
      else this.presets.push({ ...key, q16 });
      this.ack(CMD.presetPut, 0, 0);
    } else {
      this.presets = this.presets.filter((x) => x !== have);
      this.ack(CMD.presetDel, 0, have ? 0 : S_MISSING);
    }
  }

  private reply(f: Uint8Array): void {
    this.pending++;
    setTimeout(() => {
      this.pending--;
      this.i.onmidimessage?.({ data: f });
    }, 1);
  }

  /** the link went quiet: no answer on its way and nothing new from the editor for 20 ms, however long the editor's
   *  exchanges take on a busy machine */
  async quiet(): Promise<void> {
    for (let sent = -1; this.pending || sent !== this.o.sent.length; ) {
      sent = this.o.sent.length;
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  private ack(cmd: number, seq: number, status: number, aux = 0): void {
    this.reply(frame(CMD.ack, [cmd, seq, status, aux]));
  }

  /** a position's state: 0 empty, 1 ok, 2 missing (its slot no longer holds its name) */
  state(pos: number): 0 | 1 | 2 {
    const e = this.entries[pos];
    if (!e) return 0;
    const s = this.slots[e.slot];
    return s?.used && s.name === e.name ? 1 : 2;
  }

  /** PALETTE_NOW's payload */
  nowPayload(): number[] {
    const out = [1, this.cur ?? 0xff, this.next ?? 0xff, 0, this.seq & 0xff, this.seq >> 8];
    for (let pos = 0; pos < PALETTE_SIZE; pos++) {
      const e = this.entries[pos], st = this.state(pos);
      const hash = e ? crc16(encodePaletteEntry(e)) : 0;
      const len = st === 1 ? this.slots[e!.slot].length : 0;
      out.push(st, e?.slot ?? 0, e?.pattern ?? 0, hash & 0xff, hash >> 8, len & 0xff, len >> 8, ...name20(e?.name ?? ''));
    }
    return out;
  }

  /** PALETTE_NOW unasked, once the editor sent GET */
  report(): void {
    if (this.asked) this.reply(frame(PALETTE.now, this.nowPayload()));
  }

  /** the bar line came: a waiting switch happens */
  bar(): void {
    if (this.next === null) return;
    this.switchTo(this.next);
  }

  /** HOME held + a black key held (palette.c pal_save): the patch it plays from the editor (`bin`, as uploaded, under the
   *  name the editor sent) into the first free slot, then position `pos` points at it with the presets and pattern it plays
   *  (`entry`, slot and name filled in here), and the FM-1 plays that position (SLOT_NOW, PALETTE_NOW) */
  holdSave(pos: number, bin: Uint8Array, name: string, entry: PaletteEntry): void {
    const slot = this.slots.findIndex((s) => !s.used);
    this.slots[slot] = { slot, used: true, length: bin.length, name };
    this.bins[slot] = bin.slice();
    this.entries[pos] = { ...entry, slot, name };
    this.switchTo(pos);
  }

  private switchTo(pos: number): void {
    const e = this.entries[pos]!;
    this.cur = pos;
    this.next = null;
    this.reply(frame(CMD.slotNow, [e.slot, ...name20(e.name)]));
    this.report();
  }

  private palette(p: number[]): void {
    const op = p[0];
    this.ops.push(op);
    if (op === PALETTE.get) {
      this.asked = true;
      this.reply(frame(PALETTE.now, this.nowPayload()));
    } else if (op === PALETTE.entryGet) {
      const e = this.entries[p[1]];
      this.reply(frame(PALETTE.entry, [p[1], ...(e ? encodePaletteEntry(e) : [])]));
    } else if (op === PALETTE.put) {
      const pos = p[1];
      if (pos >= PALETTE_SIZE) return this.ack(PALETTE.cmd, pos, 1);
      const e = p.length > 2 ? decodePaletteEntry(p.slice(2)) : null;
      if (p.length > 2 && !e) return this.ack(PALETTE.cmd, pos, 1);
      if (this.refusePut || (e && !(this.slots[e.slot]?.used && this.slots[e.slot].name === e.name))) return this.ack(PALETTE.cmd, pos, S_MISSING);
      this.entries[pos] = e;
      this.seq++;
      this.ack(PALETTE.cmd, pos, 0);
      this.report();
    } else if (op === PALETTE.order) {
      const from = p.slice(1, 1 + PALETTE_SIZE);
      const was = [...this.entries];
      this.entries = from.map((f) => (f === 0xff ? null : was[f] ?? null));
      this.seq++;
      this.ack(PALETTE.cmd, 0, 0);
      this.report();
    } else if (op === PALETTE.go) {
      const pos = p[1];
      if (pos === 0xff || pos === this.next) {
        this.next = null;
        this.ack(PALETTE.cmd, pos, 0, 2);
        return this.report();
      }
      const st = this.state(pos);
      if (!st) return this.ack(PALETTE.cmd, pos, 6);
      if (st === 2) return this.ack(PALETTE.cmd, pos, 8);
      if (this.running) {
        this.next = pos;
        this.ack(PALETTE.cmd, pos, 0, 1);
        return this.report();
      }
      this.ack(PALETTE.cmd, pos, 0, 0);
      this.switchTo(pos);
    } else if (op === PALETTE.name) this.liveName = nameOf(p, 1);
  }
}
