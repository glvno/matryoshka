// SPDX-License-Identifier: GPL-3.0-only
// The binary patch read back into its sections (patchbin.ts writes it; the layout is described at the top of that file):
// the inverse of encodePatch's byte work, nothing more. It names nothing and decides nothing: patch-reader.ts turns the
// sections into a patch. Every format the encoder writes (WRITE_FLOOR .. VERSION) reads; an older or newer one, a wrong
// magic or a binary that ends early is refused (null).
import { DEFS, DRUM_ROWS, PANEL_BUTTONS } from './modules';
import { MAX_PARTS, PANEL_LABEL_KEYS, PANEL_LABEL_MAX, TRACK_NAME_MAX } from './patch';
import {
  BYPASS_BIT, COUNTED, FLAG_CABLES3, FLAG_DEVICES, FLAG_EXTRAS, FLAG_INPUT_MAP, FLAG_INPUTS, FLAG_LINKS, FLAG_LOCKS, FLAG_MORPH,
  FLAG_MORPH_MODULES, FLAG_NAMES, FLAG_NOTES, FLAG_PATTERN_ORIGINS, FLAG_PATTERNS, FLAG_RACK, FLAG_RANGE, FLAG_BUTTONS, FORMAT_1_23,
  FORMAT_1_27, FORMAT_RACK, MEMBER_RUN, MEMBER_WIDE, NAMED_MODULE, OLD_MASKS, POLY_ROW, PRES_ATT1, PRES_ATT2, PRES_P1, PRES_P2,
  REC_STEREO, REC_TEMPLATE, ROW_MORE, SLIM, TYPE_ORDER, VERSION, WRITE_FLOOR, maskBytes, paramsAt,
} from './patchbin';
import { COUNT_ESC } from './track';

/** a poly group's record (patchbin.ts GROUP_REC) */
export interface BinGroup {
  parts: number; unisonParts: number; assign: number; legato: number; unison: boolean; unisonShare: boolean; priority: number;
  steal: boolean; flaws: { detune: number; drift: number; bright: number; env: number; level: number }[];
  /** the module index of the Arpeggiator, Steps module or Harmonizer whose notes it plays, -1: the keys */
  src: number;
  channel: number; low: number; high: number;
}
/** a module record: raw Q16.16 values as written */
export interface BinModule {
  type: string;
  bypass: boolean;
  stereo: boolean;
  /** the parameters the record holds, Q16.16 */
  params: number[];
  /** the attenuverters (Q16.16) and the p1 / p2 masks; undefined: the type has no parameter inputs */
  att?: [number, number];
  p1?: number;
  p2?: number;
  /** the record's data bytes (a Steps module's name, a Drum map's keys source) */
  data: number[];
  /** its poly group, 0 none */
  group: number;
  /** its morph B values (Q16.16) by parameter index into `params`; undefined: no B side */
  b?: number[];
}
export interface BinCable { from: number; fromPort: number; to: number; toPort: number; side?: 'l' | 'r' }
export interface BinRow { module: number; par: number; label: string; also: [number, number][]; names: string[]; top: number }
export interface BinPage { name: string; part: number; parts: number; display: number; rows: BinRow[] }
export interface BinDevice {
  kind: 0 | 1 | 2;
  /** kinds 0 and 2: its module index */
  module: number;
  name: string;
  pages: BinPage[];
}
export interface BinExtra { track: number; structure: number; preset: string; rows: [number, number][]; members: number[] }
export interface BinPatternSet {
  pattern: number;
  song: number;
  tracks: { module: number; patterns: ({ words: number[]; short: boolean; len: number; rate: number } | null)[] }[];
  songs: { pat: number; shift: number }[][];
}
export interface BinLocks { module: number; rows: [number, number][][]; pats: { p: number; locks: { at: number; row: number; value: number }[] }[] }
export interface BinPatch {
  version: number;
  flags: number;
  groups: BinGroup[];
  modules: BinModule[];
  panel: { switches: number; on: number; labels: string[] };
  cables: BinCable[];
  /** the binary lists the cables grouped by the module they go into, or in 3 bytes */
  cableForm: 'grouped' | 'short' | 'wide';
  routes: { module: number; input: number; mask: number }[];
  notes: Map<number, number[]>;
  patterns?: BinPatternSet;
  locks: BinLocks[];
  links: [number, number][];
  devices: BinDevice[];
  extras: BinExtra[];
  /** button kinds (KIND_CODE) in PANEL_BUTTONS order, the Toggles' targets and the Page buttons' lists by button; undefined: every button a Gate */
  buttons?: { kinds: number[]; toggles: Map<string, number[]>; pages: Map<string, [number, number][]> };
  drumNames: Map<number, (string | undefined)[]>;
  origins: { module: number; pattern: number; id: number }[];
  /** format 66's FX rack; `bus`: formats 55..65's master FX bus was there (the editor no longer writes one) */
  rack?: { effects: { device: number; targets: number[] }[]; drawers: { owner: number; first: number; count: number }[] };
  bus: boolean;
  ranges: { module: number; pin: number; bi: boolean; par: number; lo: number; hi: number }[];
  maps: { src: number; module: number; par: number; lo: number; hi: number }[];
}

class Reader {
  at = 0;
  constructor(readonly b: ArrayLike<number>) {}
  u8(): number {
    if (this.at >= this.b.length) throw new RangeError('the binary ends early');
    return this.b[this.at++];
  }
  u16(): number { return this.u8() | (this.u8() << 8); }
  u32(): number { return (this.u16() | (this.u16() << 16)) >>> 0; }
  i32(): number { return this.u32() | 0; }
  mask(bytes: 2 | 4): number { return bytes === 4 ? this.u32() : this.u16(); }
  text(): string { const n = this.u8(); let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(this.u8()); return s; }
  fixed(n: number): string { let s = ''; for (let i = 0; i < n; i++) { const c = this.u8(); if (c) s += String.fromCharCode(c); } return s; }
  count(wide: boolean): number { const n = this.u8(); return wide && n === COUNT_ESC ? n + this.u8() : n; }
  get left(): number { return this.b.length - this.at; }
}

/** the binary's sections, or null when this editor does not read it (see the top of this file) */
export function parseBinary(bin: ArrayLike<number>): BinPatch | null {
  try {
    return parse(bin);
  } catch {
    return null;
  }
}

function parse(bin: ArrayLike<number>): BinPatch | null {
  const r = new Reader(bin);
  if (r.u8() !== 0xa1) return null;
  const v = r.u8();
  if (v < WRITE_FLOOR || v > VERSION) return null;
  const nmod = r.u8(), ng = r.u8(), ncab = r.u16(), flags = r.u16();
  const groups: BinGroup[] = [];
  for (let g = 0; g < ng; g++) {
    const parts = r.u8(), assign = r.u8(), legato = r.u8(), priority = r.u8();
    const flaws: BinGroup['flaws'] = [];
    const s8 = (x: number): number => (x << 24) >> 24;
    for (let k = 0; k < MAX_PARTS; k++) flaws.push({ detune: s8(r.u8()), drift: r.u8(), bright: s8(r.u8()), env: s8(r.u8()), level: r.u8() });
    const src = r.u8() - 1, channel = r.u8(), low = r.u8(), high = r.u8();
    groups.push({ parts: parts & 15, unisonParts: parts >> 4, assign, legato: legato & 0x3f, unison: !!(legato & 0x80), unisonShare: !!(legato & 0x40), priority: priority & 0x7f, steal: !(priority & 0x80), flaws, src, channel, low, high });
  }
  const groupOf: number[] = ng ? Array.from({ length: nmod }, () => r.u8()) : new Array(nmod).fill(0);
  const panel = { switches: r.u16(), on: r.u16(), labels: [] as string[] };
  if (v >= SLIM) {
    const held = r.u8();
    panel.labels = PANEL_LABEL_KEYS.map((_, i) => (held & (1 << i) ? r.text() : ''));
  } else panel.labels = PANEL_LABEL_KEYS.map(() => r.fixed(PANEL_LABEL_MAX));
  const modules: BinModule[] = [];
  for (let i = 0; i < nmod; i++) {
    const tb = r.u8();
    const type = TYPE_ORDER[tb & 0x7f];
    if (!type) return null;
    const def = DEFS[type];
    let n = paramsAt(type, v).length, template = false, stereo = false;
    if (v >= COUNTED) {
      const c = r.u8();
      n = c & 0x3f;
      template = !!(c & REC_TEMPLATE);
      stereo = !!(c & REC_STEREO);
      if (n > def.params.length) return null;
    }
    const m: BinModule = { type, bypass: !!(tb & BYPASS_BIT), stereo, params: Array.from({ length: n }, () => r.i32()), data: [], group: groupOf[i] };
    if (def.paramInputs) {
      const mb = maskBytes(type);
      if (v < COUNTED) {
        m.att = [r.i32(), r.i32()];
        const masks = Array.from({ length: OLD_MASKS }, () => r.mask(mb));
        m.p1 = masks[0];
        m.p2 = masks[1];
      } else if (!template) {
        const pres = r.u8();
        m.att = [pres & PRES_ATT1 ? r.i32() : 65536, pres & PRES_ATT2 ? r.i32() : 65536];
        if (pres & PRES_P1) m.p1 = r.mask(mb);
        if (pres & PRES_P2) m.p2 = r.mask(mb);
      }
      // (absent masks and attenuverters: the type's template, patch-reader.ts fills them in)
    }
    for (let k = 0; k < (def.data ?? 0); k++) m.data.push(r.u8());
    modules.push(m);
  }
  const cables: BinCable[] = [];
  const port4 = (from: number, to: number, ports: number): BinCable => ({ from, to, fromPort: ports >> 4, toPort: ports & 15 });
  let cableForm: BinPatch['cableForm'] = 'wide';
  if (flags & FLAG_CABLES3 && v >= SLIM) {
    cableForm = 'grouped';
    const counts: number[] = [];
    for (let k = 0; k < Math.ceil(nmod / 2); k++) { const b = r.u8(); counts.push(b & 15, b >> 4); }
    for (let to = 0; to < nmod; to++) for (let k = 0; k < counts[to]; k++) { const from = r.u8(); cables.push(port4(from, to, r.u8())); }
  } else if (flags & FLAG_CABLES3) {
    cableForm = 'short';
    for (let k = 0; k < ncab; k++) { const from = r.u8(), to = r.u8(); cables.push(port4(from, to, r.u8())); }
  } else for (let k = 0; k < ncab; k++) cables.push({ from: r.u8(), fromPort: r.u8(), to: r.u8(), toPort: r.u8() });
  if (cables.length !== ncab || cables.some((c) => c.from >= nmod || c.to >= nmod)) return null;
  if (v >= FORMAT_1_27) for (let k = r.u8(); k > 0; k--) {
    const at = r.u8(), side = r.u8();
    if (!cables[at]) return null;
    cables[at].side = side === 1 ? 'l' : 'r';
  }
  if (flags & FLAG_MORPH) {
    if (v < COUNTED) {
      const vals = modules.map((m) => m.params.map(() => r.i32()));
      const mask = flags & FLAG_MORPH_MODULES ? Array.from({ length: Math.ceil(nmod / 8) }, () => r.u8()) : null;
      modules.forEach((m, i) => { if (!mask || mask[i >> 3] & (1 << (i & 7))) m.b = vals[i]; });
    } else {
      const mask = Array.from({ length: Math.ceil(nmod / 8) }, () => r.u8());
      modules.forEach((m, i) => {
        if (!(mask[i >> 3] & (1 << (i & 7)))) return;
        const bits = Array.from({ length: Math.ceil(m.params.length / 8) }, () => r.u8());
        m.b = m.params.map((a, j) => (bits[j >> 3] & (1 << (j & 7)) ? NaN : a));
        m.b.forEach((x, j) => { if (Number.isNaN(x)) m.b![j] = r.i32(); });
      });
    }
  }
  if (flags & FLAG_INPUTS) r.at += nmod;
  const routes: BinPatch['routes'] = [];
  if (flags & FLAG_INPUT_MAP) for (let k = r.u8(); k > 0; k--) {
    const module = r.u8(), input = r.u8();
    if (!modules[module]) return null;
    routes.push({ module, input, mask: r.mask(maskBytes(modules[module].type)) });
  }
  const wide = v >= FORMAT_1_27;
  const notes = new Map<number, number[]>();
  if (flags & FLAG_NOTES) for (let k = r.u8(); k > 0; k--) {
    const module = r.u8(), n = r.count(wide);
    notes.set(module, Array.from({ length: n }, () => r.u32()));
  }
  let patterns: BinPatternSet | undefined;
  if (flags & FLAG_PATTERNS) {
    patterns = { pattern: r.u8(), song: r.u8(), tracks: [], songs: [] };
    for (let k = r.u8(); k > 0; k--) {
      const module = r.u8(), np = r.u8();
      const list: BinPatternSet['tracks'][number]['patterns'] = [];
      for (let p = 0; p < np; p++) {
        const n0 = r.u8();
        if (n0 === 0xff) { list.push(null); continue; }
        const n = wide && n0 === COUNT_ESC ? n0 + r.u8() : n0;
        const len = r.u8(), rate = r.u8(), short = !!(len & 0x80);
        list.push({ words: Array.from({ length: n }, () => (short ? r.u16() : r.u32())), short, len: len & 0x7f, rate });
      }
      patterns.tracks.push({ module, patterns: list });
    }
    for (let s = r.u8(); s > 0; s--) {
      const song: { pat: number; shift: number }[] = [];
      for (let e = r.u8(); e > 0; e--) song.push({ pat: r.u8(), shift: (r.u8() << 24) >> 24 });
      patterns.songs.push(song);
    }
  }
  const locks: BinLocks[] = [];
  if (flags & FLAG_LOCKS) for (let k = r.u8(); k > 0; k--) {
    const t: BinLocks = { module: r.u8(), rows: [], pats: [] };
    for (let n = r.u8(); n > 0; n--) {
      const row: [number, number][] = [];
      for (let q = r.u8(); q > 0; q--) row.push([r.u8(), r.u8()]);
      t.rows.push(row);
    }
    for (let n = r.u8(); n > 0; n--) {
      const p = r.u8(), list: { at: number; row: number; value: number }[] = [];
      for (let q = r.u8(); q > 0; q--) list.push({ at: r.u8(), row: r.u8(), value: r.i32() });
      t.pats.push({ p, locks: list });
    }
    locks.push(t);
  }
  const links: [number, number][] = [];
  if (flags & FLAG_LINKS) for (let k = r.u8(); k > 0; k--) links.push([r.u8(), r.u16()]);
  const devices: BinDevice[] = [];
  if (flags & FLAG_DEVICES) for (let k = r.u8(); k > 0; k--) {
    const kind = r.u8();
    if (kind === 0) { devices.push({ kind: 0, module: r.u8(), name: '', pages: [] }); continue; }
    if (kind === NAMED_MODULE) { const module = r.u8(); devices.push({ kind: 2, module, name: r.text(), pages: [] }); continue; }
    if (kind !== 1) return null;
    const d: BinDevice = { kind: 1, module: -1, name: r.text(), pages: [] };
    for (let np = r.u8(); np > 0; np--) {
      const pg: BinPage = { name: r.text(), part: r.u8(), parts: r.u8(), display: r.u8() - 1, rows: [] };
      for (let nr = r.u8(); nr > 0; nr--) {
        const module = r.u8(), pb = r.u8();
        const row: BinRow = { module, par: pb & ~ROW_MORE, label: r.text(), also: [], names: [], top: 0 };
        if (pb & ROW_MORE) {
          if (pb & POLY_ROW) row.top = r.u8();
          else {
            for (let q = r.u8(); q > 0; q--) row.also.push([r.u8(), r.u8()]);
            for (let q = r.u8(); q > 0; q--) row.names.push(r.text());
          }
        }
        pg.rows.push(row);
      }
      d.pages.push(pg);
    }
    devices.push(d);
  }
  const extras: BinExtra[] = [];
  if (flags & FLAG_EXTRAS) for (let k = r.u8(); k > 0; k--) {
    const e: BinExtra = { track: r.u8(), structure: r.u32(), preset: r.text(), rows: [], members: [] };
    for (let n = r.u8(); n > 0; n--) e.rows.push([r.u8(), r.u8()]);
    const c = r.u8();
    if (v >= FORMAT_1_27 && c === MEMBER_WIDE) {
      const n = r.u8(), form = r.u8();
      if (form === 1) { const first = r.u8(); e.members = Array.from({ length: n }, (_, i) => first + i); }
      else e.members = Array.from({ length: n }, () => r.u8());
    } else if (v >= COUNTED && c & MEMBER_RUN) {
      const first = r.u8();
      e.members = Array.from({ length: c & 0x7f }, (_, i) => first + i);
    } else e.members = Array.from({ length: c }, () => r.u8());
    extras.push(e);
  }
  let buttons: BinPatch['buttons'];
  if (flags & FLAG_BUTTONS) {
    buttons = { kinds: PANEL_BUTTONS.map(() => r.u8()), toggles: new Map(), pages: new Map() };
    PANEL_BUTTONS.forEach((b, i) => {
      if (buttons!.kinds[i] === 3) {
        const list: [number, number][] = [];
        for (let n = r.u8(); n > 0; n--) list.push([r.u8(), r.u8()]);
        buttons!.pages.set(b, list);
      } else if (buttons!.kinds[i] === 2) {
        const list: number[] = [];
        for (let n = r.u8(); n > 0; n--) list.push(r.u8());
        buttons!.toggles.set(b, list);
      }
    });
  }
  const drumNames = new Map<number, (string | undefined)[]>();
  if (flags & FLAG_NAMES) for (let k = r.u8(); k > 0; k--) {
    const module = r.u8();
    if (v >= SLIM) {
      const named = r.u8();
      drumNames.set(module, Array.from({ length: DRUM_ROWS }, (_, row) => (named & (1 << row) ? r.text() : undefined)));
    } else drumNames.set(module, Array.from({ length: DRUM_ROWS }, () => r.fixed(TRACK_NAME_MAX)));
  }
  const origins: BinPatch['origins'] = [];
  if (flags & FLAG_PATTERN_ORIGINS) for (let k = r.u16(); k > 0; k--) origins.push({ module: r.u8(), pattern: r.u8(), id: r.u32() });
  let rack: BinPatch['rack'];
  let bus = false;
  if (flags & FLAG_RACK) {
    if (v >= FORMAT_RACK) {
      rack = { effects: [], drawers: [] };
      for (let k = r.u8(); k > 0; k--) { const device = r.u8(); const targets: number[] = []; for (let n = r.u8(); n > 0; n--) targets.push(r.u8()); rack.effects.push({ device, targets }); }
      for (let k = r.u8(); k > 0; k--) rack.drawers.push({ owner: r.u8(), first: r.u8(), count: r.u8() });
    } else {   // (formats 55..65: the master FX bus, eng_skip_fx: u8 count, per stage four bytes, the last its target count, then the targets)
      bus = true;
      for (let k = r.u8(); k > 0; k--) { r.at += 3; r.at += r.u8(); }
    }
  }
  const ranges: BinPatch['ranges'] = [];
  if (flags & FLAG_RANGE) for (let k = r.u8(); k > 0; k--) {
    const module = r.u8(), pin = r.u8();
    ranges.push({ module, pin: pin & 0x7f, bi: !!(pin & 0x80), par: r.u8(), lo: r.u8(), hi: r.u8() });
  }
  const maps: BinPatch['maps'] = [];
  if (v >= FORMAT_1_23 && r.left > 0) for (let k = r.u8(); k > 0; k--) maps.push({ src: r.u8(), module: r.u8(), par: r.u8(), lo: r.u8(), hi: r.u8() });
  if (r.left !== 0) return null;
  return { version: v, flags, groups, modules, panel, cables, cableForm, routes, notes, patterns, locks, links, devices, extras, buttons, drumNames, origins, rack, bus, ranges, maps };
}

/** the stored pattern ids a binary links (its links section), [] none or not a binary this editor reads */
export function linkedIds(bin: ArrayLike<number>): number[] {
  return [...new Set(parseBinary(bin)?.links.map(([, id]) => id) ?? [])];
}
