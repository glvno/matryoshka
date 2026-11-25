// SPDX-License-Identifier: GPL-3.0-only
// The factory content's images (#915, D-1020), in the layout firmware/src/factory.c reads: the factory patches, the
// factory engines' presets, the factory drum patterns, the released factory sets, the released copies and the preset
// migrations. export-defs.ts writes two: the firmware tier (firmware/src/factory_tier.h FC_TIER, compiled
// in: the patches of FIRMWARE_TIER in
// web/src/factory-bank.ts and the preset migrations) and the factory region's image (web/public/firmware/matryoshka-factory.bin,
// which the editor's Flash tab and tools/fm1_install.py install into the FM-1's 18 sectors at 0xEA000: the other factory
// patches, every factory engine preset, the drum patterns, and any firmware-tier patch fixed since, which replaces the
// built-in copy when its revision is newer). Layout 4 is for firmware whose kit cards hold their DRUMS track (#1202 K2,
// D-1062) and that has no demo sets (#1202 G8): header bytes 60..61 are spare (0). A firmware that reads only layout 2
// (1.25) or 1 (1.24.x) keeps its image in web/public/firmware/factory/ (D-1020); layouts 2 and 3 end the body with the
// demo sets (header bytes 60..61: their length), which layout 4's firmware ignores.
import { lzPack, lzUnpack } from './factory-lz';

export const REGION_SIZE = 18 * 0x1000;
export const HEADER = 64;
export const MAGIC = 0x3143464d;            // "MFC1"
export const LAYOUT = 4;
export const TIER_SET = 0xffffff;           // the factory set of a bank written from the firmware tier alone (factory.c FC_TIER_SET)
export const UNPACK_CAP = 3840;             // the buffer the FM-1 unpacks a patch into in place (proto.c M1_PATCH_MAX)
export const PATCH_REC = 36;                // a patch record's bytes
export const KIND_REGION = 0, KIND_TIER = 1; // header byte 57: what the image is for (factory.c FC_KIND_*)
export const STRUCT_PRESETS = 32;           // presets of one structure at most (factory.c FC_STRUCT_PRESETS, pages_ui.c pr_list)
export const PATTERN_NOTES = 32;            // a pattern's note words at most (factory.c FC_NOTES)
export const PATCHES = 64;                  // patches at most (the bank's masks)
const NAME = 20, PNAME = 16;

/** `revision`: the content version of the copy (default the image's): a region record named as a firmware-tier patch
 *  replaces the built-in copy when its revision is higher */
export interface RegionPatch { name: string; binary: Uint8Array; slot: number; revision?: number }
/** a factory patch as a release wrote it (web/scripts/released-factory.json, legacy-factory.ts): its name, length, FNV-1a
 *  and CRC-32 (8 hex digits each) */
export interface ReleasedCopy { name: string; len: number; fnv: string; crc: string }
/** an image's released copy: one of its patches (`patch`, the image's index) as a release wrote it, unlike today's */
export interface ImageCopy { patch: number; len: number; fnv: number; crc: number }
export interface RegionPreset { structure: string; name: string; values: number[] }   // values in Q16
export interface RegionPattern { identity: number; structure: string; name: string; notes: number[]; len: number; rate: number; swing: number; dir: number; gate: number }
export interface RegionInput {
  kind: number;
  set: number;
  version: number;
  patches: RegionPatch[];
  presets: RegionPreset[];
  patterns: RegionPattern[];
  released: { set: number; has: bigint }[];
  copies: ImageCopy[];
  migrations: Uint8Array;
}

/** CRC-16/CCITT-FALSE, from `c` (proto.c m1_crc16 starts at 0xFFFF) */
export function crc16(data: ArrayLike<number>, c = 0xffff): number {
  for (let i = 0; i < data.length; i++) {
    c ^= data[i] << 8;
    for (let k = 0; k < 8; k++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff;
  }
  return c;
}

/** CRC-32 (IEEE, as zlib's) */
export function crc32(data: ArrayLike<number>): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    c ^= data[i];
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}

/** FNV-1a, 32 bits (factory.c fc_fnv32) */
export function fnv32(data: ArrayLike<number>): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < data.length; i++) h = Math.imul(h ^ data[i], 0x01000193) >>> 0;
  return h;
}

/** a patch's fingerprint as released-factory.json keeps it: its length, FNV-1a and CRC-32 */
export function copyFingerprint(b: Uint8Array): { len: number; fnv: string; crc: string } {
  return { len: b.length, fnv: fnv32(b).toString(16).padStart(8, '0'), crc: crc32(b).toString(16).padStart(8, '0') };
}

/** an image's released copies (firmware/src/bank_upgrade.h, D-887): for each of its patches, every copy of that name a
 *  release wrote whose bytes differ from today's, in patch order. An FM-1 gives a slot that still holds one, under that
 *  name, today's patch */
export function imageCopies(patches: readonly RegionPatch[], released: readonly ReleasedCopy[]): ImageCopy[] {
  const out: ImageCopy[] = [];
  patches.forEach((p, patch) => {
    const now = copyFingerprint(p.binary), name = ascii(p.name, NAME);
    for (const c of released) {
      if (c.name !== name || (c.len === now.len && c.fnv === now.fnv && c.crc === now.crc)) continue;
      const e = { patch, len: c.len, fnv: parseInt(c.fnv, 16), crc: parseInt(c.crc, 16) };
      if (!out.some((x) => x.patch === e.patch && x.len === e.len && x.fnv === e.fnv && x.crc === e.crc)) out.push(e);
    }
  });
  return out;
}

/** the content's version, which the editor compares with the FM-1's (an update is offered when the FM-1's is lower): a
 *  released factory set's place among the released sets in release order, from 1, else one past the last released one */
export function contentVersion(set: number, sets: readonly { set: string; tags: readonly string[] }[]): number {
  const key = (tag: string): number => tag.replace(/^v/, '').split(/[.-]/).slice(0, 3).reduce((a, x) => a * 1000 + (parseInt(x, 10) || 0), 0);
  const order = [...sets].sort((a, b) => key(a.tags[0]) - key(b.tags[0]));
  const at = order.findIndex((s) => parseInt(s.set, 16) === set);
  return at >= 0 ? at + 1 : order.length + 1;
}

/** the update loader's test for an update record (firmware/loader/ldr_record.h ldr_is_record): the 80 bytes at a sector's
 *  offset 0xF00 */
export function looksLikeRecord(r: ArrayLike<number>): boolean {
  let c = 0;
  for (let i = 2; i < 80; i++) {
    c ^= r[i] << 8;
    for (let k = 0; k < 8; k++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff;
  }
  const crc = r[0] | r[1] << 8;
  return (r[6] | r[7] << 8) === 0x5441 && crc !== 0 && crc === c;
}

/** lz_unpack.h run in place: the packed bytes at the end of a buffer of `cap` bytes, unpacked from its start. Throws when
 *  a write would reach a packed byte not read yet */
export function checkInPlace(z: Uint8Array, cap: number): void {
  const base = cap - z.length;
  let i = 0, o = 0;
  const put = (): void => { if (i < z.length && o >= base + i) throw new Error(`unpacking in place overruns at ${o}`); o++; };
  const more = (len: number): number => { for (let d = 255; d === 255; len += d) d = z[i++]; return len; };
  while (i < z.length) {
    const t = z[i++];
    let len = t >> 4;
    if (len === 15) len = more(len);
    for (; len; len--) { i++; put(); }
    if (i === z.length) break;
    i += 2;
    len = (t & 15) + 4;
    if (len === 19) len = more(len);
    for (; len; len--) put();
  }
}

class Writer {
  bytes: number[] = [];
  get at(): number { return this.bytes.length; }
  u8(v: number): void { this.bytes.push(v & 0xff); }
  u16(v: number): void { this.u8(v); this.u8(v >> 8); }
  u32(v: number): void { this.u16(v & 0xffff); this.u16(v >>> 16); }
  raw(b: ArrayLike<number>): void { for (let i = 0; i < b.length; i++) this.u8(b[i]); }
  text(s: string, n: number): void { for (let i = 0; i < n; i++) this.u8(i < s.length ? s.charCodeAt(i) : 0); }
  set16(at: number, v: number): void { this.bytes[at] = v & 0xff; this.bytes[at + 1] = v >> 8 & 0xff; }
  set32(at: number, v: number): void { this.set16(at, v & 0xffff); this.set16(at + 2, v >>> 16); }
}

const ascii = (s: string, n: number): string => s.toUpperCase().replace(/[^ -~]/g, '').replace(/"/g, '').slice(0, n);

/** the presets section: the structures' column, the entries, the values (dictionary indexes, `bits` each), changed rows and
 *  names; a preset whose values differ from the first of its structure and length in few rows keeps only those rows */
function presetSection(presets: RegionPreset[]): { bytes: number[]; dict: number[]; bits: number } {
  const dict = [...new Set(presets.flatMap((p) => p.values))];
  const index = new Map(dict.map((v, i) => [v, i]));
  const bits = Math.max(1, Math.ceil(Math.log2(Math.max(2, dict.length))));
  if (bits > 16) throw new Error('the factory preset values outgrow a 16-bit dictionary index');
  const pack = (v: number[]): number[] => {
    const out = new Uint8Array(Math.ceil(v.length * bits / 8) + 2);
    v.forEach((value, i) => {
      const at = i * bits, enc = index.get(value)! << (at & 7);
      for (let b = 0; b < Math.ceil((bits + (at & 7)) / 8); b++) out[(at >> 3) + b] |= enc >>> (8 * b) & 255;
    });
    return [...out];
  };
  const perStructure = new Map<string, number>();
  for (const p of presets) perStructure.set(p.structure, (perStructure.get(p.structure) ?? 0) + 1);
  for (const [s, n] of perStructure) if (n > STRUCT_PRESETS) throw new Error(`structure ${s} has ${n} factory presets, over ${STRUCT_PRESETS}`);
  const bases = new Map<string, number>();
  const recs = presets.map((p, i) => {
    if (p.values.length > 176) throw new Error(`${p.name}: ${p.values.length} values, a preset holds 176`);
    const key = `${p.structure}/${p.values.length}`;
    const base = bases.get(key);
    if (base === undefined || p.name.toUpperCase() === 'INIT') bases.set(key, i);
    const rows = base === undefined ? [] : p.values.flatMap((v, r) => v === presets[base].values[r] ? [] : [r]);
    const sparse = base !== undefined && p.name.toUpperCase() !== 'INIT' && rows.length * (bits + 8) + 64 < p.values.length * bits;
    const v = pack(sparse ? rows.map((r) => p.values[r]) : p.values);
    if (v.length > 256) throw new Error(`${p.name}: ${v.length} bytes of packed values, factory.c reads 256`);
    return { base: sparse ? base : 0xffff, rows: sparse ? rows : [], v };
  });
  const w = new Writer();
  for (const p of presets) w.u32(parseInt(p.structure, 16));
  const entries = w.at;
  w.raw(new Array(16 * presets.length).fill(0));
  recs.forEach((r, i) => {
    const e = entries + 16 * i, v = w.at;
    w.raw(r.v);
    const rows = r.rows.length ? w.at : 0;
    w.raw(r.rows);
    const name = w.at;
    w.text(ascii(presets[i].name, PNAME), ascii(presets[i].name, PNAME).length + 1);
    if (w.at > 0xffff) throw new Error('the factory presets outgrow their 16-bit offsets');
    w.set16(e, v);
    w.set16(e + 2, r.v.length);
    w.set16(e + 4, r.base);
    w.set16(e + 6, rows);
    w.set16(e + 8, name);
    w.bytes[e + 10] = presets[i].values.length;
    w.bytes[e + 11] = r.rows.length;
    w.set16(e + 12, crc16(r.rows, crc16(r.v)));
  });
  return { bytes: w.bytes, dict, bits };
}

function patternSection(patterns: RegionPattern[]): number[] {
  const w = new Writer();
  w.raw(new Array(24 * patterns.length).fill(0));
  patterns.forEach((p, i) => {
    if (p.notes.length > PATTERN_NOTES) throw new Error(`pattern ${p.name}: ${p.notes.length} notes, over ${PATTERN_NOTES}`);
    const e = 24 * i, notes = w.at;
    const nb: number[] = [];
    for (const n of p.notes) nb.push(n & 0xff, n >>> 8 & 0xff, n >>> 16 & 0xff, n >>> 24 & 0xff);
    w.raw(nb);
    const name = w.at;
    w.text(ascii(p.name, PNAME), ascii(p.name, PNAME).length + 1);
    if (w.at > 0xffff) throw new Error('the factory patterns outgrow their 16-bit offsets');
    w.set32(e, p.identity >>> 0);
    w.set32(e + 4, parseInt(p.structure, 16));
    w.set16(e + 8, notes);
    w.bytes[e + 10] = p.notes.length;
    w.bytes[e + 11] = p.len;
    w.bytes[e + 12] = p.rate;
    w.bytes[e + 13] = p.swing;
    w.bytes[e + 14] = p.dir;
    w.set32(e + 16, p.gate | 0);
    w.set16(e + 20, name);
    w.set16(e + 22, crc16(nb));
  });
  return w.bytes;
}

/** the image (header and body, its length a multiple of nothing in particular: the bytes to write from the region's start).
 *  `pad` bytes go before the patch data; build() raises it until no sector looks like an update record */
function layout(input: RegionInput, pad: number): Uint8Array {
  if (input.patches.length > PATCHES) throw new Error(`${input.patches.length} factory patches, over ${PATCHES}`);
  const w = new Writer();
  w.raw(new Array(HEADER).fill(0xff));
  const patchDir = w.at;
  w.raw(new Array(PATCH_REC * input.patches.length).fill(0));
  w.raw(new Array(pad).fill(0));
  let format = 0;
  input.patches.forEach((p, i) => {
    const z = lzPack(p.binary);
    if (lzUnpack(z, UNPACK_CAP).length !== p.binary.length) throw new Error(`${p.name}: packing does not round-trip`);
    checkInPlace(z, UNPACK_CAP);
    // (the region's format is its newest patch's, and firmware older than it refuses the whole region, factory.c FC_NEWER:
    // each binary keeps its lowest format, D-281, so the set stays at 66 unless a patch uses a 1.27 thing, uses127)
    format = Math.max(format, p.binary[1]);
    const e = patchDir + PATCH_REC * i, at = w.at;
    w.raw(z);
    for (let k = 0; k < NAME; k++) w.bytes[e + k] = k < ascii(p.name, NAME).length ? ascii(p.name, NAME).charCodeAt(k) : 0;
    w.set32(e + 20, at);
    w.set16(e + 24, z.length);
    w.set16(e + 26, p.binary.length);
    w.set16(e + 28, crc16(z));
    w.set16(e + 30, p.slot);
    w.set16(e + 32, p.revision ?? input.version);
  });
  const ps = presetSection(input.presets);
  const preset = w.at;
  w.raw(ps.bytes);
  const dict = w.at;
  for (const v of ps.dict) w.u32(v >>> 0);
  const pattern = w.at;
  w.raw(patternSection(input.patterns));
  const released = w.at;
  for (const r of input.released) { w.u32(r.set); w.u32(Number(r.has & 0xffffffffn)); w.u32(Number(r.has >> 32n)); }
  // the released copies right after the released sets (header bytes 58..59 count them; a firmware before them reads
  // neither): 12 bytes each
  for (const c of input.copies) {
    if (c.patch >= input.patches.length || c.len > UNPACK_CAP) throw new Error(`released copy of patch ${c.patch}: out of range`);
    w.u32(c.fnv >>> 0); w.u32(c.crc >>> 0); w.u16(c.len); w.u8(c.patch); w.u8(0);
  }
  const mig = w.at;
  w.raw(input.migrations);
  w.raw(new Array(PNAME).fill(0));          // (so a name read whole, 16 bytes, never runs past the image)
  const out = Uint8Array.from(w.bytes);
  const len = out.length - HEADER;
  const h = new DataView(out.buffer);
  h.setUint32(0, MAGIC, true);
  out[4] = LAYOUT;
  out[5] = format;
  h.setUint16(6, input.version, true);
  h.setUint32(8, input.set & 0xffffff, true);
  h.setUint32(12, len, true);
  h.setUint32(16, crc32(out.subarray(HEADER)), true);
  [input.patches.length, input.presets.length, input.patterns.length, input.released.length, ps.dict.length,
    input.migrations.length ? new DataView(input.migrations.buffer, input.migrations.byteOffset).getUint16(0, true) : 0]
    .forEach((n, i) => h.setUint16(20 + 2 * i, n, true));
  [patchDir, preset, dict, pattern, released, mig].forEach((o, i) => h.setUint32(32 + 4 * i, o, true));
  out[56] = ps.bits;
  out[57] = input.kind;
  h.setUint16(58, input.copies.length, true);
  h.setUint16(60, 0, true);
  h.setUint16(62, crc16(out.subarray(4, 62)), true);
  return out;
}

/** the image: header and body, at most the region's 73,728 bytes, no sector looking like an update record */
export function buildRegion(input: RegionInput): Uint8Array {
  for (let pad = 0; pad < 256; pad++) {
    const img = layout(input, pad);
    if (img.length > REGION_SIZE) throw new Error(`the factory content takes ${img.length} bytes, the region ${REGION_SIZE}`);
    let clear = true;
    for (let s = 0xf00; s + 80 <= img.length; s += 0x1000) if (looksLikeRecord(img.subarray(s, s + 80))) clear = false;
    if (clear) return img;
  }
  throw new Error('no padding keeps the factory region clear of update records');
}

/** the header's fields, for the tools and tests (undefined: not an image) */
export function readHeader(img: Uint8Array): { layout: number; format: number; version: number; set: number; len: number; crc: number; patches: number; presets: number; patterns: number; kind: number; copies: number } | undefined {
  if (img.length < HEADER) return undefined;
  const h = new DataView(img.buffer, img.byteOffset, HEADER);
  if (h.getUint32(0, true) !== MAGIC || h.getUint16(62, true) !== crc16(img.subarray(4, 62))) return undefined;
  return {
    layout: img[4], format: img[5], version: h.getUint16(6, true), set: h.getUint32(8, true), len: h.getUint32(12, true), crc: h.getUint32(16, true),
    patches: h.getUint16(20, true), presets: h.getUint16(22, true), patterns: h.getUint16(24, true), kind: img[57], copies: h.getUint16(58, true),
  };
}

/** the released copies (the image's patch, length, FNV-1a, CRC-32), for the tools and tests */
export function readCopies(img: Uint8Array): ImageCopy[] {
  const h = new DataView(img.buffer, img.byteOffset, img.length);
  const at = h.getUint32(48, true) + 12 * h.getUint16(26, true);
  return Array.from({ length: h.getUint16(58, true) }, (_, k) => {
    const e = at + 12 * k;
    return { patch: img[e + 10], len: h.getUint16(e + 8, true), fnv: h.getUint32(e, true), crc: h.getUint32(e + 4, true) };
  });
}

/** the patch records' names and revisions, for the tools and tests */
export function readPatches(img: Uint8Array): { name: string; slot: number; revision: number }[] {
  const h = new DataView(img.buffer, img.byteOffset, img.length);
  const at = h.getUint32(32, true);
  return Array.from({ length: h.getUint16(20, true) }, (_, i) => {
    const e = at + PATCH_REC * i;
    return { name: String.fromCharCode(...img.subarray(e, e + NAME)).replace(/\0+$/, ''), slot: h.getUint16(e + 30, true), revision: h.getUint16(e + 32, true) };
  });
}
