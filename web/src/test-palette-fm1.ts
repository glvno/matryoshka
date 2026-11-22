// SPDX-License-Identifier: GPL-3.0-only
// A stand-in FM-1 that keeps a palette (#1196) as build/palette/spec.md §5 says the firmware does, for the editor's
// tests: HELLO (INFO with feature bit 31), the bank (SLOT_INFO, CHUNK, SLOT), and PALETTE's six ops with their ACKs,
// PALETTE_NOW (unasked only after a GET) and PALETTE_ENTRY. It answers on a fake Web MIDI input, a millisecond later.
import { CMD, crc16, decodePaletteEntry, encodePaletteEntry, frame, NAME_BYTES, PALETTE, PALETTE_SIZE, parse, type PaletteEntry, type SlotInfo } from './protocol';

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

export class PaletteFm1 {
  readonly i: PalettePort;
  readonly o: PalettePort;
  slots: SlotInfo[];
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

  constructor(o: { features?: number; slots?: SlotInfo[] } = {}) {
    const port = (id: string): PalettePort => {
      const p: PalettePort = { id, name: 'Matryoshka', manufacturer: '', state: 'connected', onmidimessage: null, sent: [], send: (d) => void p.sent.push(Uint8Array.from(d)) };
      return p;
    };
    this.i = port('m');
    this.o = port('M');
    this.slots = o.slots ?? Array.from({ length: 64 }, (_, slot) => ({ slot, used: false, length: 0, name: '' }));
    const features = o.features ?? 1 << 31;
    this.o.send = (d) => {
      const bytes = Uint8Array.from(d);
      this.o.sent.push(bytes);
      const p = parse(bytes);
      if (!p) return;
      if (p.cmd === CMD.hello) {
        this.asked = false;
        this.reply(frame(CMD.info, [1, 64, 255, 3, 1, features & 0xff, (features >> 8) & 0xff, 48, 65, 1, 26, 0, (features >> 16) & 0xff, 1, (features >>> 24) & 0xff]));
      } else if (p.cmd === CMD.slotInfo) {
        const s = this.slots[p.payload[0]];
        this.reply(frame(CMD.slotReply, [s.slot, s.used ? 1 : 0, s.length & 0xff, s.length >> 8, ...name20(s.name)]));
      } else if (p.cmd === CMD.chunk) {
        this.chunkTotal = p.payload[3] | (p.payload[4] << 8);
        this.ack(CMD.chunk, p.payload[0], 0);
      } else if (p.cmd === CMD.slot) {
        const slot = p.payload[0];
        this.slots[slot] = { slot, used: true, length: this.chunkTotal, name: nameOf(p.payload, 1) };
        this.ack(CMD.slot, slot, 0);
        this.report();
      } else if (p.cmd === PALETTE.cmd && (features >>> 31) & 1) this.palette(p.payload);
    };
  }

  private reply(f: Uint8Array): void {
    setTimeout(() => this.i.onmidimessage?.({ data: f }), 1);
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
      if (e && !(this.slots[e.slot]?.used && this.slots[e.slot].name === e.name)) return this.ack(PALETTE.cmd, pos, 8);
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
