import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// presets.h's LEGACY_FACTORY (scripts/legacy-factory.ts, export-defs): main.c bank_upgrade rewrites a slot that is byte
// for byte an earlier factory patch with today's of the same name. Checked against the factory bank of release 1.1.0
// and Drift Poly from before #437 (a change within one format, #441).
/** FNV-1a, 32 bits, as main.c fnv32 and scripts/legacy-factory.ts */
const fnv32 = (b: number[]): number => b.reduce((h, x) => Math.imul(h ^ x, 0x01000193) >>> 0, 0x811c9dc5);
const parse = (src: string): { name: string; bytes: number[] }[] => {
  const data = new Map<string, number[]>();
  for (const m of src.matchAll(/static const uint8_t (PRESET_\d+)\[\d+\] = \{([^}]*)\}/g)) data.set(m[1], m[2].split(',').map(Number));
  return [...src.matchAll(/\{"([^"]*)", (PRESET_\d+),/g)].map((m) => ({ name: m[1], bytes: data.get(m[2])! }));
};
const now = readFileSync(new URL('../../firmware/src/presets.h', import.meta.url), 'utf8');
const names = parse(now).map((p) => p.name);
const table = [...now.matchAll(/\{0x([0-9a-f]{8})u, (\d+), (\d+)\}/g)].map((m) => ({ fnv: parseInt(m[1], 16), len: Number(m[2]), now: Number(m[3]) }));
const show = (rev: string): string => {
  try {
    return execFileSync('git', ['show', `${rev}:firmware/src/presets.h`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 << 20 });
  } catch {
    return ''; // (a shallow checkout without that commit)
  }
};
const old = show('v1.1.0');
const beforeHeadroom = show('c503791'); // (main just before #437 lowered Drift Poly's mixer; the format did not change)

describe('earlier factory patches (the bank after an update)', () => {
  it.skipIf(!old)('every factory patch release 1.1.0 wrote is known, as today\'s patch of the same name', () => {
    for (const p of parse(old)) {
      const hit = table.find((t) => t.fnv === fnv32(p.bytes) && t.len === p.bytes.length);
      expect(hit && names[hit.now], p.name).toBe(p.name);
    }
  });
  it.skipIf(!beforeHeadroom)('a factory patch changed within one format is known, as today\'s of the same name', () => {
    const p = parse(beforeHeadroom).find((x) => x.name === 'DRIFT POLY')!;
    const hit = table.find((t) => t.fnv === fnv32(p.bytes) && t.len === p.bytes.length);
    expect(hit && names[hit.now]).toBe('DRIFT POLY');
  });
  it('a slot holding one of today\'s patches is never rewritten', () => {
    for (const p of parse(now)) expect(table.some((t) => t.fnv === fnv32(p.bytes) && t.len === p.bytes.length), p.name).toBe(false);
  });
  it('the factory set id is the fingerprint of today\'s factory patches', () => {
    const id = parseInt(now.match(/#define FACTORY_SET_ID 0x([0-9a-f]{6})u/)?.[1] ?? '0', 16);
    const h = parse(now).reduce((h, p) => [...new TextEncoder().encode(p.name), 0, ...p.bytes].reduce((h, x) => Math.imul(h ^ x, 0x01000193) >>> 0, h), 0x811c9dc5);
    expect(id).toBe(h & 0xffffff || 1);
  });
  it('an edited copy is not', () => {
    const p = parse(now)[0].bytes.slice();
    p[1] = 33;
    p[20] ^= 1;
    expect(table.some((t) => t.fnv === fnv32(p) && t.len === p.length)).toBe(false);
  });
});
