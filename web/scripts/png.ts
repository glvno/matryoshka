// SPDX-License-Identifier: GPL-3.0-only
// A minimal PNG reader / writer on node:zlib for build scripts (8-bit, non-interlaced; read: grey, grey+alpha, RGB, RGBA,
// palette is not supported).
import { deflateSync, inflateSync } from 'node:zlib';

export interface Rgba {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel, rows top down */
  data: Uint8Array;
}

const SIG = [137, 80, 78, 71, 13, 10, 26, 10];
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 };

export function readPng(buf: Uint8Array): Rgba {
  if (!SIG.every((b, i) => buf[i] === b)) throw new Error('not a PNG');
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let width = 0, height = 0, type = 0;
  const idat: Uint8Array[] = [];
  for (let p = 8; p < buf.length; ) {
    const len = view.getUint32(p);
    const kind = String.fromCharCode(...buf.subarray(p + 4, p + 8));
    const body = buf.subarray(p + 8, p + 8 + len);
    if (kind === 'IHDR') {
      width = view.getUint32(p + 8);
      height = view.getUint32(p + 12);
      type = body[9];
      if (body[8] !== 8 || body[12] !== 0 || !(type in CHANNELS)) throw new Error('only 8-bit, non-interlaced grey / RGB(A) PNGs');
    } else if (kind === 'IDAT') idat.push(body);
    else if (kind === 'IEND') break;
    p += 12 + len;
  }
  const ch = CHANNELS[type];
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * ch;
  const px = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? px[y * stride + x - ch] : 0;
      const b = y ? px[(y - 1) * stride + x] : 0;
      const c = x >= ch && y ? px[(y - 1) * stride + x - ch] : 0;
      let v = src[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const q = a + b - c, pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      px[y * stride + x] = v & 0xff;
    }
  }
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const s = px.subarray(i * ch, i * ch + ch);
    const [r, g, b] = ch >= 3 ? [s[0], s[1], s[2]] : [s[0], s[0], s[0]];
    data.set([r, g, b, ch === 4 ? s[3] : ch === 2 ? s[1] : 255], i * 4);
  }
  return { width, height, data };
}

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
const crc32 = (b: Uint8Array): number => {
  let c = -1;
  for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
function chunk(kind: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  out.set(Buffer.from(kind, 'latin1'), 4);
  out.set(body, 8);
  view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
  return out;
}

/** an RGBA PNG (filter 0 rows, deflated at level 9) */
export function writePng(img: Rgba): Uint8Array {
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, img.width);
  v.setUint32(4, img.height);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const stride = img.width * 4;
  const raw = new Uint8Array((stride + 1) * img.height);
  for (let y = 0; y < img.height; y++) raw.set(img.data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  return Buffer.concat([Buffer.from(SIG), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', new Uint8Array(0))]);
}
