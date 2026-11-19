// SPDX-License-Identifier: GPL-3.0-only
// The editor's factory content (#915, factory-content.ts): the set it offers a firmware, what it offers on connect, and
// its install over the link against a fake FM-1 that keeps the region as NOR (factory.c's rules for FACT_WRITE and
// FACT_COMMIT).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { factoryOffer, installFactory, pickSet, sectorPages, sectorSum, type Ask, type FactorySet } from './factory-content';
import { crc16, FACT, FACT_HEADER, FACT_SIZE, parse, type FactoryInfo, type Parsed } from './protocol';
import { crc32 } from '../scripts/factory-region';

const image = new Uint8Array(readFileSync(new URL('../public/firmware/matryoshka-factory.bin', import.meta.url)));
const manifest = JSON.parse(readFileSync(new URL('../public/firmware/factory-sets.json', import.meta.url), 'utf8')) as { sets: FactorySet[] };

const info = (o: Partial<FactoryInfo>): FactoryInfo => ({
  state: 1, reads: 1, layout: 1, format: 55, version: 11, set: 0x123456, len: 0, patches: 10, writing: false, tierOnly: false,
  size: FACT_SIZE, plays: 60, tierVersion: 11, tierPatches: 10, merged: 20, ...o,
});
const set = (o: Partial<FactorySet>): FactorySet => ({ file: 'matryoshka-factory.bin', version: 11, set: '123456', layout: 1, format: 55, bytes: 1, ...o });

/** an FM-1's factory region over the link: erase, program (bits only clear), the header checked at the commit */
function fakeFm1(): { flash: Uint8Array; ask: Ask; writes: number[] } {
  const flash = new Uint8Array(FACT_SIZE).fill(0xff);
  const writes: number[] = [];
  let writing = false;
  const reply = (cmd: number, payload: number[]): Parsed => ({ cmd, payload });
  const ack = (cmd: number, st: number): Parsed => reply(0x40, [cmd, 0, st, 0]);
  const ask: Ask = async (frame, match) => {
    const p = parse(frame)!;
    const d = p.payload;
    let r: Parsed;
    if (p.cmd === FACT.begin) {
      flash.fill(0xff, 0, 0x1000);
      writing = true;
      r = ack(FACT.begin, 0);
    } else if (p.cmd === FACT.sum) {
      const c = crc16(flash.subarray(d[0] * 0x1000, d[0] * 0x1000 + 0x1000));
      r = reply(FACT.sumReply, [d[0], 1, c & 0xff, c >> 8]);
    } else if (p.cmd === FACT.write) {
      const s = d[0], off = d[1] | d[2] << 8, bytes = d.slice(3);
      if (!writing || (off & 0xff) + bytes.length > 256 || (!s && off < FACT_HEADER)) r = ack(FACT.write, 1);
      else {
        if (!off && s) flash.fill(0xff, s * 0x1000, s * 0x1000 + 0x1000);
        bytes.forEach((b, i) => (flash[s * 0x1000 + off + i] &= b));
        writes.push(s);
        r = ack(FACT.write, 0);
      }
    } else if (p.cmd === FACT.commit) {
      const len = new DataView(Uint8Array.from(d).buffer).getUint32(12, true), crc = new DataView(Uint8Array.from(d).buffer).getUint32(16, true);
      if (!writing) r = ack(FACT.commit, 1);
      else if (crc32(flash.subarray(FACT_HEADER, FACT_HEADER + len)) !== crc) r = ack(FACT.commit, 2);
      else {
        flash.set(d, 0);
        writing = false;
        r = ack(FACT.commit, 0);
      }
    } else throw new Error(`unexpected command ${p.cmd}`);
    if (!match(r)) throw new Error('the answer does not match');
    return r;
  };
  return { flash, ask, writes };
}

describe('the factory set offered (#915)', () => {
  it('the manifest lists today\'s image with its header\'s version, set and format', () => {
    const today = manifest.sets.find((s) => s.file === 'matryoshka-factory.bin')!;
    expect(today.bytes).toBe(image.length);
    expect(today.version).toBe(new DataView(image.buffer, image.byteOffset).getUint16(6, true));
    expect(today.format).toBe(image[5]);
  });
  it('the newest set the firmware reads: its layout, a patch format it plays', () => {
    const sets = [set({ version: 9, format: 50 }), set({ version: 12, format: 61 }), set({ version: 11, format: 55 }), set({ version: 13, layout: 2 })];
    expect(pickSet(sets, info({ plays: 60 }))!.version).toBe(11);
    expect(pickSet(sets, info({ plays: 61 }))!.version).toBe(12);
    expect(pickSet(sets, info({ plays: 49 }))).toBeNull();
  });
  it('offers an install when the region holds nothing valid or an install was cut off; an update for a newer set; else nothing', () => {
    expect(factoryOffer(info({ state: 0 }), set({}))!.action).toBe('Install');
    expect(factoryOffer(info({ state: 2 }), set({}))!.action).toBe('Install');
    expect(factoryOffer(info({ state: 3 }), set({}))!.action).toBe('Install');
    expect(factoryOffer(info({ writing: true }), set({}))!.action).toBe('Install');
    expect(factoryOffer(info({ version: 10, set: 0x111111 }), set({ version: 11 }))!.action).toBe('Update');
    expect(factoryOffer(info({}), set({}))).toBeNull();
    expect(factoryOffer(info({ version: 12, set: 0x111111 }), set({ version: 11 }))).toBeNull();
    expect(factoryOffer(info({ state: 0 }), null)).toBeNull();
  });
  it('1.20.3 (release/1.20, D-1162): an FM-1 on 1.20.0 holding 1.20.2\'s region is offered nothing; one holding 1.20.1\'s is offered this set', () => {
    // FACT_INFO as the test rig read it on 1.20.0 firmware (release/qualification/v1.20.1.json, v1.20.2.json): the region
    // image differs from 1.20.2's file only in its released-sets section, so its set and version are 1.20.2's
    const fm1 = (version: number, s: number): FactoryInfo => info({ version, set: s, plays: 63, tierVersion: 13, tierPatches: 11, merged: 21 });
    const with1202 = fm1(15, 0x0971a5), with1201 = fm1(14, 0x55ce34);
    expect(pickSet(manifest.sets, with1202)).toMatchObject({ set: '0971a5', version: 15 });
    expect(factoryOffer(with1202, pickSet(manifest.sets, with1202))).toBeNull();
    expect(factoryOffer(with1201, pickSet(manifest.sets, with1201))).toMatchObject({ action: 'Update', set: { set: '0971a5', version: 15 } });
  });
});

describe('the install over the link (#915)', () => {
  it('pages stay inside one 256-byte page, sector 0 after the header, a short record page written whole', () => {
    for (let s = 0; s * 0x1000 < image.length; s++)
      for (const [off, page] of sectorPages(image, s)) {
        expect((off & 0xff) + page.length).toBeLessThanOrEqual(256);
        if (!s) expect(off).toBeGreaterThanOrEqual(FACT_HEADER);
        if ((off & 0xf00) === 0xf00) expect(page.length).toBeGreaterThanOrEqual(80);
      }
  });
  it('a blank region gets the image byte for byte, with progress to the end', async () => {
    const fm1 = fakeFm1();
    const seen: number[] = [];
    await installFactory(fm1.ask, image, (done, total) => seen.push(done / total));
    expect(Array.from(fm1.flash.subarray(0, image.length))).toEqual(Array.from(image));
    expect(seen.at(-1)).toBe(1);
  });
  it('run again over the same content, only sector 0 is written again (the others\' FACT_SUM matches)', async () => {
    const fm1 = fakeFm1();
    await installFactory(fm1.ask, image);
    fm1.writes.length = 0;
    await installFactory(fm1.ask, image);
    expect(new Set(fm1.writes)).toEqual(new Set([0]));
    for (let s = 1; s * 0x1000 < image.length; s++) expect(sectorSum(image, s)).toBe(crc16(fm1.flash.subarray(s * 0x1000, s * 0x1000 + 0x1000)));
  });
  it('a refused commit is an error', async () => {
    const fm1 = fakeFm1();
    const bad = image.slice();
    bad[16] ^= 1;   // (the body's CRC-32 in the header no longer matches)
    await expect(installFactory(fm1.ask, bad)).rejects.toThrow(/FACT_COMMIT/);
  });
});
