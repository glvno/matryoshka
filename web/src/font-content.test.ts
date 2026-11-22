// SPDX-License-Identifier: GPL-3.0-only
// The editor's screen font install (#602, font-content.ts): what it offers on connect, and its install over the link
// against a fake FM-1 that keeps the font area as NOR (font_area.c's rules for WRITE and COMMIT).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fontId, fontOffer, installFont } from './font-content';
import { type Ask } from './factory-content';
import { crc16, FACT_HEADER, FONT, parse, parseInfo, type Info, type Parsed } from './protocol';
import { crc32 } from '../scripts/factory-region';

const image = new Uint8Array(readFileSync(new URL('../public/firmware/matryoshka-font.bin', import.meta.url)));
const FA_ID = Number.parseInt(/#define FA_ID 0x([0-9A-F]+)u/.exec(readFileSync(new URL('../../firmware/src/font_bc.h', import.meta.url), 'utf8'))![1], 16);

/** an FM-1's font area over the link: erase, program (bits only clear), the header checked at the commit; `need` the id
 *  of the font its firmware takes */
function fakeFm1(need = FA_ID): { flash: Uint8Array; ask: Ask; writes: number[]; valid: () => boolean } {
  const flash = new Uint8Array(10 * 0x1000).fill(0xff);
  const writes: number[] = [];
  let writing = false, valid = false;
  const ack = (op: number, st: number, s = 0): Parsed => ({ cmd: 0x40, payload: [FONT.cmd, op, st, s] });
  const ask: Ask = async (frame, match) => {
    const p = parse(frame)!;
    const [op, ...d] = p.payload;
    let r: Parsed;
    if (p.cmd !== FONT.cmd) throw new Error(`unexpected command ${p.cmd}`);
    if (op === FONT.begin) {
      flash.fill(0xff, 0, 0x1000);
      writing = true;
      valid = false;
      r = ack(op, 0);
    } else if (op === FONT.sum) {
      const c = crc16(flash.subarray(d[0] * 0x1000, d[0] * 0x1000 + 0x1000));
      r = { cmd: FONT.sumReply, payload: [d[0], 1, c & 0xff, c >> 8] };
    } else if (op === FONT.write) {
      const s = d[0], off = d[1] | d[2] << 8, bytes = d.slice(3);
      if (!writing) r = ack(op, 6, s);
      else if ((off & 0xff) + bytes.length > 256 || (!s && off < FACT_HEADER) || s >= 10) r = ack(op, 1, s);
      else {
        if (!off && s) flash.fill(0xff, s * 0x1000, s * 0x1000 + 0x1000);
        bytes.forEach((b, i) => (flash[s * 0x1000 + off + i] &= b));
        writes.push(s);
        r = ack(op, 0, s);
      }
    } else if (op === FONT.commit) {
      const h = Uint8Array.from(d), v = new DataView(h.buffer), len = v.getUint32(8, true), id = v.getUint32(12, true);
      if (!writing) r = ack(op, 6);
      else if (id !== need) r = ack(op, 3);
      else {
        flash.set(h.subarray(4), 4);
        if (crc32(flash.subarray(16, len)) !== id) r = ack(op, 2);
        else {
          flash.set(h.subarray(0, 4), 0);
          writing = false;
          valid = true;
          r = ack(op, 0);
        }
      }
    } else r = ack(op, 1);
    if (!match(r)) throw new Error('the answer does not match');
    return r;
  };
  return { flash, ask, writes, valid: () => valid };
}

describe('the screen font image (#602)', () => {
  it("is the font this checkout's firmware needs, its id the CRC-32 of its bytes 16 ..", () => {
    expect(fontId(image)).toBe(FA_ID);
    expect(crc32(image.subarray(16))).toBe(FA_ID);
    expect(fontId(image.subarray(0, 63))).toBeNull();
    expect(fontId(new Uint8Array(64))).toBeNull();
  });
});

describe('INFO bytes 20..24: the font area', () => {
  const info = (extra: number[]): Info | null =>
    parseInfo({ cmd: 0x41, payload: [1, 64, 128, 1, 255, 246, 255, 31, 65, 1, 26, 0, 255, 1, 125, 60, 0, 1, 0, 2, ...extra] });
  it('a firmware with its type compiled in says nothing; one with the area names its font and whether it is there', () => {
    expect(info([])?.font).toBeUndefined();
    expect(info([0, 0, 0, 0, 0])?.font).toBeUndefined();
    expect(info([1, 0x53, 0x8a, 0x11, 0xe6])?.font).toEqual({ valid: false, writing: false, id: 0xe6118a53 });
    expect(info([7, 1, 0, 0, 0])?.font).toEqual({ valid: true, writing: true, id: 1 });
  });
});

describe('what the editor offers on connect', () => {
  it('nothing for a firmware without the area or with its font; an install when it lacks the font this site has', () => {
    expect(fontOffer(undefined, image)).toBeNull();
    expect(fontOffer({ valid: true, writing: false, id: FA_ID }, image)).toBeNull();
    expect(fontOffer({ valid: false, writing: false, id: FA_ID }, image)).toMatchObject({ install: true, text: expect.stringMatching(/no screen font/) });
    expect(fontOffer({ valid: false, writing: true, id: FA_ID }, image)).toMatchObject({ install: true, text: expect.stringMatching(/cut off/) });
    expect(fontOffer({ valid: false, writing: false, id: FA_ID ^ 1 }, image)).toMatchObject({ install: false });
    expect(fontOffer({ valid: false, writing: false, id: FA_ID }, null)).toMatchObject({ install: false });
  });
});

describe('the install over the link', () => {
  it('writes every sector, commits, and the area holds the image; run again it skips what is there', async () => {
    const fm1 = fakeFm1();
    const steps: number[] = [];
    await installFont(fm1.ask, image, (done) => steps.push(done));
    expect(fm1.valid()).toBe(true);
    expect(Array.from(fm1.flash.subarray(0, image.length))).toEqual(Array.from(image));
    expect(steps.at(-1)).toBeGreaterThan(150);
    fm1.writes.length = 0;
    await installFont(fm1.ask, image);
    expect(fm1.writes).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);   // (only sector 0's pages: BEGIN erased it)
    expect(fm1.valid()).toBe(true);
  });
  it("another firmware's font is refused at the commit, and the FM-1 keeps none", async () => {
    const fm1 = fakeFm1(FA_ID ^ 1);
    await expect(installFont(fm1.ask, image)).rejects.toThrow(/FONT COMMIT/);
    expect(fm1.valid()).toBe(false);
  });
});
