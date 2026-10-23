import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// presets.h's LEGACY_FACTORY (scripts/legacy-factory.ts, export-defs): main.c bank_upgrade rewrites a slot that is byte
// for byte an earlier factory patch with today's of the same name. Checked against the factory bank of release 1.1.0.
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
let old = '';
try {
  old = execFileSync('git', ['show', 'v1.1.0:firmware/src/presets.h'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
} catch {
  // (a shallow checkout without the tag)
}

describe('earlier factory patches (the bank after an update)', () => {
  it.skipIf(!old)('every factory patch release 1.1.0 wrote is known, as today\'s patch of the same name', () => {
    for (const p of parse(old)) {
      const hit = table.find((t) => t.fnv === fnv32(p.bytes) && t.len === p.bytes.length);
      expect(hit && names[hit.now], p.name).toBe(p.name);
    }
  });
  it('an edited copy is not', () => {
    const p = parse(now)[0].bytes.slice();
    p[1] = 33;
    p[20] ^= 1;
    expect(table.some((t) => t.fnv === fnv32(p) && t.len === p.length)).toBe(false);
  });
});
