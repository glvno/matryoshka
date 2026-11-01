// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Leo Kuroshita (@kurogedelic), Hügelton Instruments
//
// FM-1 .fwsc packages in the browser: the package identity and the image the
// device reads during an update.

const BLOCKS = 20, BLK = 0x30, KEEP = 0x2F;
export const STOCK_V15_SHA256 = "db1642b2b6fa5c2cccb11ffd13878068bb28601678d3644049f99dc40e7edb8a";
export const STOCK_APP_SIZE = 0x8DFBC;
export const STOCK_V15_SIZE = 699956;

const T = new Uint16Array(256);
for (let i = 0; i < 256; i++) {
  let c = i << 8;
  for (let k = 0; k < 8; k++) c = c & 0x8000 ? (c << 1) ^ 0x1021 : c << 1;
  T[i] = c & 0xFFFF;
}

export function crc16(d, crc = 0) {
  for (let i = 0; i < d.length; i++) crc = ((crc << 8) & 0xFFFF) ^ T[((crc >> 8) ^ d[i]) & 0xFF];
  return crc;
}

function enc(buf, off, size, key = 0xFFFF) {
  for (let i = 0; i < size; i++) {
    buf[off + i] ^= key & 0xFF;
    key = ((key * 2) ^ (key & 0x8000 ? 0x1021 : 0)) & 0xFFFF;
  }
}

function sfc(buf, off, size, base, key) {
  for (let i = 0; i < size; i += 32) enc(buf, off + i, Math.min(size - i, 32), key ^ ((off + i - base) >> 2));
}

function chipkeyDecode(d) {
  let sum = 0;
  for (let i = 0; i < 16; i++) sum += d[i];
  sum &= 0xFF;
  sum = sum >= 0xE0 ? 0xAA : sum <= 0x10 ? 0x55 : sum;
  let k = 0;
  for (let i = 0; i < 16; i++) if ((d[16 + i] ^ d[15 - i]) < sum) k |= 1 << i;
  return k;
}

const align32 = (v) => (v + 31) & ~31;
const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
function w16(b, o, v) { b[o] = v & 0xFF; b[o + 1] = (v >> 8) & 0xFF; }
function w32(b, o, v) { w16(b, o, v & 0xFFFF); w16(b, o + 2, (v >>> 16) & 0xFFFF); }

class Entry {                                   // JLFS head, 32 bytes
  constructor(raw, off) {
    this.hdrOff = off;
    this.hcrc = u16(raw, off);
    this.dcrc = u16(raw, off + 2);
    this.offset = u32(raw, off + 4);
    this.size = u32(raw, off + 8);
    this.flags = raw[off + 12];
    this.resvd = raw[off + 13];
    this.index = u16(raw, off + 14);
    this.rawName = raw.slice(off + 16, off + 32);
    const z = this.rawName.indexOf(0);
    this.name = String.fromCharCode(...this.rawName.slice(0, z < 0 ? 16 : z));
    if (crc16(raw.subarray(off + 2, off + 32)) !== this.hcrc) throw new Error(`JLFS header CRC mismatch @${off.toString(16)}`);
  }
  packInto(buf) {
    const o = this.hdrOff;
    w16(buf, o + 2, this.dcrc); w32(buf, o + 4, this.offset); w32(buf, o + 8, this.size);
    buf[o + 12] = this.flags; buf[o + 13] = this.resvd; w16(buf, o + 14, this.index);
    buf.set(this.rawName, o + 16);
    this.hcrc = crc16(buf.subarray(o + 2, o + 32));
    w16(buf, o, this.hcrc);
  }
}

export class Package {
  constructor(bytes) {
    this.raw = new Uint8Array(bytes);
    this.parseUfw();
    this.flash = this.raw.slice(this.flashFileOff, this.flashFileOff + this.flashSize);
    this.parseFlash();
  }

  get product() { return productOf(this.raw); }

  setProduct(name) {
    if (name.length > BLOCKS) throw new Error("product name too long");
    for (let i = 0; i < BLOCKS; i++) {
      const m = i < name.length ? (name.charCodeAt(i) + i + 1) & 0xFF : 0x7D;
      if (i < name.length && m === 0x7D) throw new Error("product name encodes to the unused marker");
      this.raw[i * BLK + KEEP] = m;
    }
  }

  headerBytes() {
    const h = new Uint8Array(BLOCKS * KEEP);
    for (let i = 0; i < BLOCKS; i++) h.set(this.raw.subarray(i * BLK, i * BLK + KEEP), i * KEEP);
    return h;
  }

  hdrFileOff(i) { return Math.floor(i / KEEP) * BLK + (i % KEEP); }

  parseUfw() {
    const h = this.headerBytes();
    enc(h, 0, 0x40);
    const hcrc = u16(h, 0), lcrc = u16(h, 2), nent = u16(h, 8);
    if (crc16(h.subarray(2, 0x40)) !== hcrc) throw new Error("not an FM-1 .fwsc (UFW header CRC mismatch)");
    this.skew = BLOCKS * BLK - h.length;
    this.ufw = h;
    this.nent = nent;
    const hsize = 0x40 + nent * 0x50;
    if (crc16(h.subarray(0x40, hsize)) !== lcrc) throw new Error("UFW entry list CRC mismatch");
    this.entries = [];
    for (let off = 0x40; off < hsize; off += 0x50) {
      const e = h.slice(off, off + 0x50);
      enc(e, 0, 0x50);
      const z = e.subarray(0x40, 0x50).indexOf(0);
      this.entries.push({ off, type: u16(e, 0), dcrc: u16(e, 4), dataOff: u32(e, 8), size: u32(e, 12),
        name: String.fromCharCode(...e.subarray(0x40, z < 0 ? 0x50 : 0x40 + z)), plain: e });
    }
    const fl = this.entries.find((e) => e.type === 0);
    if (!fl) throw new Error("no flash.bin in the package");
    this.flashEntry = fl;
    this.flashFileOff = fl.dataOff + this.skew;
    this.flashSize = fl.size;
    if (crc16(this.raw.subarray(this.flashFileOff, this.flashFileOff + fl.size)) !== fl.dcrc) throw new Error("flash.bin CRC mismatch");
  }

  parseFlash() {
    const dec = this.flash.slice();
    const h = dec.slice(0, 32);
    enc(h, 0, 32);
    if (crc16(h.subarray(2, 32)) !== u16(h, 0)) throw new Error("flash header CRC mismatch");
    this.chipKey = null; this.appBase = null;
    for (let off = 32; ; off += 32) {
      enc(dec, off, 32);
      const e = new Entry(dec, off);
      if (e.name === "isd_config.ini") {
        const blob = dec.subarray(e.offset, e.offset + 34);
        if (crc16(blob.subarray(0, 32)) === u16(blob, 32)) this.chipKey = chipkeyDecode(blob.subarray(0, 32));
      }
      if (e.flags === 0x81 && e.name === "app_dir_head" && this.appBase === null) this.appBase = e.offset;
      if (e.index) break;
    }
    if (this.chipKey === null || this.appBase === null) throw new Error("chip key or app_dir_head not found");
    const b = this.appBase, k = this.chipKey, end = align32(b + 32);
    sfc(dec, b, end - b, b, k);
    const head = new Entry(dec, b);
    const blkEnd = b + head.size;
    if (blkEnd > end) sfc(dec, end, blkEnd - end, b, k);
    this.sfcEnd = Math.max(end, blkEnd);
    this.cfgLen = 0;
    const probe = this.flash.slice(b, align32(blkEnd) + 32);
    sfc(probe, 0, probe.length, 0, k);
    try {
      const cfg = new Entry(probe, blkEnd - b);
      if (cfg.name === "cfg" && blkEnd + cfg.size <= this.flash.length) this.cfgLen = cfg.size;
    } catch (_) { /* no cfg block */ }
    if (this.cfgLen) {
      const region = this.flash.slice(b, blkEnd + this.cfgLen);
      sfc(region, 0, region.length, 0, k);
      dec.set(region, b);
      this.sfcEnd = blkEnd + this.cfgLen;
    }
    this.head = head;
    this.app = null;
    for (let off = b + 32; ; off += 32) {
      const e = new Entry(dec, off);
      if (e.flags === 0x82 && e.name === "app.bin") this.app = e;
      if (e.index) break;
    }
    if (!this.app) throw new Error("app.bin not found in app area");
    this.appOff = b + this.app.offset;
    this.dec = dec;
  }

  // the new app, padded to the stock size (Felucca never changes the layout)
  setApp(app) {
    if (app.length > this.app.size) throw new Error(`app is ${app.length} B, the slot is ${this.app.size} B`);
    const nw = new Uint8Array(this.app.size).fill(0xFF);
    nw.set(app);
    const a = this.app, h = this.head, b = this.appBase;
    this.dec.set(nw, this.appOff);
    a.dcrc = crc16(nw);
    a.packInto(this.dec);
    h.dcrc = crc16(this.dec.subarray(h.hdrOff + 32, h.hdrOff + h.size));
    h.packInto(this.dec);
    this.sfcEnd = Math.max(align32(b + 32), b + h.size + this.cfgLen);
    const region = this.dec.slice(b, this.sfcEnd);
    sfc(region, 0, region.length, 0, this.chipKey);
    this.flash.set(region, b);
  }

  serialize() {
    const out = this.raw.slice();
    out.set(this.flash, this.flashFileOff);
    const fl = this.flashEntry, e = fl.plain.slice();
    w16(e, 4, crc16(this.flash));
    enc(e, 0, 0x50);
    const h = this.ufw.slice();
    h.set(e, fl.off);
    const hsize = 0x40 + this.nent * 0x50;
    w16(h, 2, crc16(h.subarray(0x40, hsize)));
    w16(h, 0, crc16(h.subarray(2, 0x40)));
    enc(h, 0, 0x40);
    for (let i = 0; i < hsize; i++) out[this.hdrFileOff(i)] = h[i];
    return out;
  }
}

// the package identity ("FM-1_904"): one marker byte after each of the first 20 blocks
export function productOf(fwsc) {
  if (fwsc.length < BLOCKS * BLK) throw new Error("not an FM-1 package (too short)");
  let s = "";
  for (let i = 0; i < BLOCKS; i++) {
    const m = fwsc[i * BLK + KEEP];
    if (m !== 0x7D) s += String.fromCharCode((m - i - 1) & 0xFF);
  }
  return s;
}

// Matryoshka's identity (#216): FM-1_7MMmmpp, 7 then major, minor and patch as two digits each (1.8.0 = FM-1_7010800);
// FM-1_7XY before (1.0 .. 1.7 in the field: major and minor, one digit each). FM-1_7000000 and FM-1_700 are dev and CI
// builds. tools/fm1_install.py matryoshka_version reads them the same way.
export const MATRYOSHKA_PRODUCT_RE = /^FM-1_7(\d\d|\d{6})$/;
export const isMatryoshkaProduct = (p) => MATRYOSHKA_PRODUCT_RE.test(p ?? "");
/** -> { major, minor, patch } (patch null for the old three-digit form), "dev" for a dev or CI build, null for an
 *  identity that is not Matryoshka's */
export function matryoshkaVersion(p) {
  const m = MATRYOSHKA_PRODUCT_RE.exec(p ?? "");
  if (!m) return null;
  const d = m[1];
  const v = d.length === 2 ? { major: +d[0], minor: +d[1], patch: null }
    : { major: +d.slice(0, 2), minor: +d.slice(2, 4), patch: +d.slice(4, 6) };
  return !v.major && !v.minor && !v.patch ? "dev" : v;
}

// the image the device addresses during an update: the .fwsc without the 20 marker bytes
export function logicalImage(fwsc) {
  const out = new Uint8Array(fwsc.length - BLOCKS);
  for (let i = 0; i < BLOCKS; i++) out.set(fwsc.subarray(i * BLK, i * BLK + KEEP), i * KEEP);
  out.set(fwsc.subarray(BLOCKS * BLK), BLOCKS * KEEP);
  return out;
}

export async function sha256hex(bytes) {
  const d = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

// Only the user's unmodified official V15 is accepted for a return to stock.
// The digest pins every file, loader and flash layout; filenames are not evidence.
export async function validateStockPackage(bytes) {
  if (bytes.length !== STOCK_V15_SIZE || await sha256hex(bytes) !== STOCK_V15_SHA256)
    throw new Error("Select the unmodified official FM-1 V15 file (FM-1.fwsc).");
  const pkg = new Package(bytes);
  if (pkg.product !== "FM-1_015" || pkg.flashFileOff !== 1044 || pkg.flashSize !== 602112 ||
      pkg.appBase !== 16384 || pkg.appOff !== 16672 || pkg.app.size !== STOCK_APP_SIZE ||
      !pkg.entries.some((e) => e.type === 100 && e.name === "ota.bin" && e.size === 19969))
    throw new Error("The official firmware has an unsupported FM-1 layout.");
  return { product: pkg.product, image: logicalImage(bytes), sha256: STOCK_V15_SHA256 };
}

// M-VAVE Official Open (#183): its identity, the update loader all M-VAVE packages carry, and the boot code (flash head,
// 0x0000-0x3FFF) every Open release writes (V12 and V14 alike; the same bytes fm1_open's Package.cs builds). V15's head
// is the other known one. Open is not bundled (its engine is proprietary): the user brings M-VAVE's own file.
export const OPEN_PRODUCT_RE = /^FM-1_8\d{6}$/;
export const MVAVE_LOADER_SHA256 = "ef1f2db89b011fa53e71df363f0122de0ea896618c53fb53e8da676322004541";
export const OPEN_HEAD_SHA256 = "2981ccf8d12a132c82d8b5e959c2d27d62f13bc51419225cacc87a6e82d58171";
export const V15_HEAD_SHA256 = "d9f43191777656de01c7bed4f9e9ba2e34e94832c5d2ed02c3fc7ab7a6d9bd67";
// #264: a JieLi tool may write the boot code's chip-key block again, other bytes for the same key. As ota.c ota_stage, a
// boot code is still V15's / Official Open's when it is apart from that block and its isd_config.ini entry's two CRCs,
// and the block holds the same key: SHA-256 with those bytes zeroed, and the key (0x980F in both)
export const HEADS = {
  v15: { sha: V15_HEAD_SHA256, core: "fc767f6fcc5dbd69adbc4a5bc7b8d56d68516bb7d5b1a3a84d615140b2c481a0", key: 0x980F },
  open: { sha: OPEN_HEAD_SHA256, core: "70f51774cbc1ed1b8b41c272c5b8eebee49bf620e45543a86336fd090cf3b30c", key: 0x980F },
};
/** { core: SHA-256 with the chip-key block and its entry's CRCs zeroed, key } or null (as ota.c ota_key_area) */
export async function headCore(head) {
  for (let off = 32; off < 0x400; off += 32) {
    const e = head.slice(off, off + 32);
    enc(e, 0, 32);
    if (crc16(e.subarray(2, 32)) !== u16(e, 0)) return null;
    if (String.fromCharCode(...e.subarray(16, 31)) === "isd_config.ini\0") {
      const blk = u32(e, 4);
      if (blk < 0x400 || blk + 34 > head.length) return null;
      const x = head.slice();
      x.fill(0, off, off + 4);
      x.fill(0, blk, blk + 34);
      const b = head.subarray(blk, blk + 34);
      return { core: await sha256hex(x), key: crc16(b.subarray(0, 32)) === u16(b, 32) ? chipkeyDecode(b) : null };
    }
    if (u16(e, 14)) return null;
  }
  return null;
}
/** "exact" / "rekeyed" (the same apart from the chip-key block, the same key) / null */
export async function headIs(head, which) {
  const h = HEADS[which];
  if (await sha256hex(head) === h.sha) return "exact";
  const c = await headCore(head);
  return c && c.core === h.core && c.key === h.key ? "rekeyed" : null;
}
export async function headWhich(head) {
  for (const w of Object.keys(HEADS)) if (await headIs(head, w)) return w;
  return null;
}

export const FL_LEN = 0x93000;                 // this board's flash.bin (ota.c OTA_FL_LEN); Open's is shorter
export const OPEN_RELEASES = "https://github.com/m-vave/fm1_open/releases";

// what is wrong with a package offered as Official Open, or null (the facts come from validateOpenPackage)
export function openPackageProblem({ product, flashSize, headSha, loaderSha }) {
  if (!OPEN_PRODUCT_RE.test(product)) return `its identity is ${product}, not M-VAVE Official Open's (FM-1_8xxxxxx)`;
  if (loaderSha !== MVAVE_LOADER_SHA256) return "it does not carry M-VAVE's update loader";
  if (!(flashSize > 0x4000 && flashSize <= FL_LEN && flashSize % 0x1000 === 0)) return `its firmware image (${flashSize} bytes) does not fit the FM-1`;
  if (headSha !== OPEN_HEAD_SHA256) return headSha === V15_HEAD_SHA256 ? "its boot code is V15's, not Official Open's" : "its boot code is not Official Open's";
  return null;
}

// M-VAVE publishes Official Open inside its Workbench page (FM1-Open-Vxx-Workbench.html), as base64: the packages in it
export function workbenchPackages(bytes) {
  const start = new TextDecoder("latin1").decode(bytes.subarray(0, Math.min(bytes.length, 64)));
  // a page is text: an encrypted .fwsc starts with "<" (0x3C) about once in 256 builds (tools/fm1_install.py is_page)
  if (!/^\s*<[\t\r\n\x20-\x7e]*$/.test(start)) return [bytes];
  const html = new TextDecoder("latin1").decode(bytes), out = [];
  for (const m of html.matchAll(/"data":"([A-Za-z0-9+/=]{100000,})"/g)) {
    try { out.push(Uint8Array.from(atob(m[1]), (c) => c.charCodeAt(0))); } catch (_) { /* not base64 */ }
  }
  return out;
}

// the user's Official Open: a .fwsc, or M-VAVE's Workbench page with Open inside. Every CRC on the way (Package), the
// identity, M-VAVE's loader, the image size and the boot code are checked before anything is sent.
export async function validateOpenPackage(bytes) {
  let why = "it is not an FM-1 package";
  for (const raw of workbenchPackages(new Uint8Array(bytes))) {
    let pkg;
    try { pkg = new Package(raw); } catch (e) { why = e.message; continue; }
    const loader = pkg.entries.find((e) => e.type === 100 && e.name === "ota.bin");
    const at = loader ? loader.dataOff + pkg.skew : 0;
    const problem = openPackageProblem({
      product: pkg.product, flashSize: pkg.flashSize,
      headSha: await sha256hex(pkg.flash.subarray(0, 0x4000)),
      loaderSha: loader ? await sha256hex(raw.subarray(at, at + loader.size)) : "",
    });
    if (!problem) return { product: pkg.product, image: logicalImage(raw), size: raw.length };
    why = problem;
  }
  throw new Error(`Select M-VAVE Official Open (its .fwsc, or the Workbench page from ${OPEN_RELEASES}): ${why}.`);
}

// official V15 + Felucca app -> installable package (Uint8Array)
export async function buildFeluccaPackage(stockBytes, appBytes, product) {
  const sha = await sha256hex(stockBytes);
  if (sha !== STOCK_V15_SHA256) throw new Error("this is not the official FM-1 V15 firmware file (FM-1.fwsc)");
  const pkg = new Package(stockBytes);
  pkg.setApp(appBytes);
  pkg.setProduct(product);
  return pkg.serialize();
}
