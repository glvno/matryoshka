// SPDX-License-Identifier: GPL-3.0-only
// The factory region's link frames (#915, D-490), the shipped region image (web/public/firmware/matryoshka-factory.bin) and
// the firmware tier (firmware/src/factory_tier.h FC_TIER): together every factory patch once, the tier exactly
// web/src/factory-tiers.ts FIRMWARE_TIER, every factory preset and drum pattern in the region.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FACT, FACT_SIZE, factCommitFrame, factReadFrame, factWriteFrame, parse, parseFactoryInfo, frame } from './protocol';
import { buildRegion, contentVersion, crc32, KIND_REGION, KIND_TIER, looksLikeRecord, readHeader, readPatches, REGION_SIZE, STRUCT_PRESETS } from '../scripts/factory-region';
import { FIRMWARE_TIER, FIRMWARE_TIER_OVERRIDES } from './factory-tiers';
import { FM1_PRESETS } from './presets';
import { factoryPresets, factoryRackPresets } from './factory-presets';
import patterns from './preset-patterns.json';

const image = new Uint8Array(readFileSync(new URL('../public/firmware/matryoshka-factory.bin', import.meta.url)));
const tierH = readFileSync(new URL('../../firmware/src/factory_tier.h', import.meta.url), 'utf8');
const tierBody = tierH.slice(tierH.indexOf('FC_TIER['));
const tier = Uint8Array.from(tierBody.slice(tierBody.indexOf('{') + 1, tierBody.indexOf('}')).split(',').map(Number));
const up = (s: string): string => s.toUpperCase();

describe('factory region link frames (#915)', () => {
  it('FACT_WRITE carries the sector, the offset and the page', () => {
    const p = parse(factWriteFrame(7, 0x300, [1, 2, 3]))!;
    expect(p.cmd).toBe(FACT.write);
    expect(p.payload).toEqual([7, 0x00, 0x03, 1, 2, 3]);
  });
  it('FACT_READ carries a 32-bit offset and a count', () => {
    expect(parse(factReadFrame(0x12345, 100))!.payload).toEqual([0x45, 0x23, 0x01, 0x00, 100]);
  });
  it('FACT_COMMIT carries the image header', () => {
    expect(parse(factCommitFrame(image))!.payload).toEqual(Array.from(image.subarray(0, 64)));
  });
  it('FACT_INFO is read as the firmware writes it', () => {
    const b = [1, 1, 1, 59, 2, 0, 0x13, 0x02, 0xed, 0, 0x10, 0x27, 0, 0, 10, 0, 2, 0, 0x20, 1, 0, 60, 11, 0, 10, 20];
    expect(parseFactoryInfo(parse(frame(FACT.infoReply, b))!)).toEqual({
      state: 1, reads: 1, layout: 1, format: 59, version: 2, set: 0xed0213, len: 10000, patches: 10, writing: false, tierOnly: true,
      size: FACT_SIZE, plays: 60, tierVersion: 11, tierPatches: 10, merged: 20,
    });
  });
  it('FACT_INFO from a firmware without the tier fields is not read', () => {
    expect(parseFactoryInfo(parse(frame(FACT.infoReply, new Array(21).fill(0)))!)).toBeNull();
  });
});

describe('the factory region image and the firmware tier', () => {
  it('the region image fits the region, its header and CRC-32 check, no sector looks like an update record', () => {
    const h = readHeader(image)!;
    expect(h.layout).toBe(1);
    expect(h.kind).toBe(KIND_REGION);
    expect(image.length).toBeLessThanOrEqual(REGION_SIZE);
    expect(h.len + 64).toBe(image.length);
    expect(crc32(image.subarray(64))).toBe(h.crc);
    for (let s = 0xf00; s + 80 <= image.length; s += 0x1000) expect(looksLikeRecord(image.subarray(s, s + 80))).toBe(false);
  });
  it('the firmware tier is an image of the same layout, of the same factory set and version', () => {
    const t = readHeader(tier)!, r = readHeader(image)!;
    expect(t.kind).toBe(KIND_TIER);
    expect(crc32(tier.subarray(64))).toBe(t.crc);
    expect([t.layout, t.set, t.version]).toEqual([r.layout, r.set, r.version]);
  });
  it('the tier holds FIRMWARE_TIER, the region every other factory patch: each factory patch once, in its own slot', () => {
    const bank = Object.keys(FM1_PRESETS).map(up);
    const inTier = readPatches(tier), inRegion = readPatches(image);
    expect(inTier.map((p) => p.name).sort()).toEqual(FIRMWARE_TIER.map(up).sort());
    expect([...inTier, ...inRegion].map((p) => p.name).sort()).toEqual([...bank, ...FIRMWARE_TIER_OVERRIDES.map(up)].sort());
    for (const p of [...inTier, ...inRegion]) expect(bank[p.slot]).toBe(p.name);
  });
  it('each firmware-tier override outranks the built-in copy of the newest released firmware (its revision is higher)', () => {
    const sets = (JSON.parse(readFileSync(new URL('../scripts/released-factory.json', import.meta.url), 'utf8')) as { sets: { set: string; tags: string[] }[] }).sets;
    const released = Math.max(...sets.map((s) => contentVersion(parseInt(s.set, 16), sets)));   // (the newest firmware's tier version)
    const inRegion = readPatches(image);
    for (const name of FIRMWARE_TIER_OVERRIDES) expect(inRegion.find((p) => p.name === up(name))?.revision).toBeGreaterThan(released);
  });
  it('every factory preset and drum pattern is in the region, none in the tier; the migrations in the tier alone', () => {
    const t = readHeader(tier)!, r = readHeader(image)!;
    expect(r.presets).toBe(factoryPresets().length + factoryRackPresets().length);
    expect(r.patterns).toBe(patterns.length);
    expect([t.presets, t.patterns]).toEqual([0, 0]);
    expect(new DataView(tier.buffer).getUint16(30, true)).toBeGreaterThan(0);
    expect(new DataView(image.buffer, image.byteOffset).getUint16(30, true)).toBe(0);
  });
  it('refuses content over the region', () => {
    let x = 0x2545f491;
    const noise = (): number => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return x & 0xff; };
    const big = Array.from({ length: 30 }, (_, i) => ({ name: `P${i}`, binary: Uint8Array.from({ length: 3800 }, noise), slot: i }));
    expect(() => buildRegion({ kind: KIND_REGION, set: 1, version: 1, patches: big, presets: [], patterns: [], released: [], migrations: new Uint8Array(0) })).toThrow();
  });
  it('one structure has at most the factory presets the firmware lists (factory.c FC_STRUCT_PRESETS, pages_ui.c pr_list)', () => {
    const c = readFileSync(new URL('../../firmware/src/factory.c', import.meta.url), 'utf8');
    expect(Number(/#define FC_STRUCT_PRESETS (\d+)u/.exec(c)?.[1])).toBe(STRUCT_PRESETS);
    const per = new Map<string, number>();
    for (const p of [...factoryPresets(), ...factoryRackPresets()]) per.set(p.structure, (per.get(p.structure) ?? 0) + 1);
    expect(Math.max(...per.values())).toBeLessThanOrEqual(STRUCT_PRESETS);
    const over = Array.from({ length: STRUCT_PRESETS + 1 }, (_, i) => ({ structure: '0000abcd', name: `P${i}`, values: [i] }));
    expect(() => buildRegion({ kind: KIND_REGION, set: 1, version: 1, patches: [], presets: over, patterns: [], released: [], migrations: new Uint8Array(0) })).toThrow();
  });
});
