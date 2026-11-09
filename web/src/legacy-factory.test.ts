import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PRESET_MIGRATIONS } from './preset-migrate';

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
  it.skipIf(!old)('every factory patch release 1.1.0 wrote is known, as today\'s patch of the same name (Hera 6 as Hera 4, which took its slot)', () => {
    for (const p of parse(old)) {
      const hit = table.find((t) => t.fnv === fnv32(p.bytes) && t.len === p.bytes.length);
      expect(hit && names[hit.now], p.name).toBe(p.name === 'HERA 6' ? 'HERA 4' : p.name);
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
  it('the factory set id is the fingerprint of today\'s factory patches and preset migrations (D-865)', () => {
    const id = parseInt(now.match(/#define FACTORY_SET_ID 0x([0-9a-f]{6})u/)?.[1] ?? '0', 16);
    let h = parse(now).reduce((h, p) => [...new TextEncoder().encode(p.name), 0, ...p.bytes].reduce((h, x) => Math.imul(h ^ x, 0x01000193) >>> 0, h), 0x811c9dc5);
    if (Object.keys(PRESET_MIGRATIONS).length) h = [...new TextEncoder().encode(JSON.stringify(PRESET_MIGRATIONS))].reduce((h, x) => Math.imul(h ^ x, 0x01000193) >>> 0, h);
    expect(id).toBe(h & 0xffffff || 1);
  });
  it('an untouched HERA 6 slot is rewritten as Hera 4, under its name (FACTORY_RENAMED: Hera 4 took its slot)', () => {
    const renamed = [...now.matchAll(/\{"([^"]*)", (\d+)\},/g)].map((m) => ({ was: m[1], now: names[Number(m[2])] }));
    expect(renamed).toEqual([{ was: 'HERA 6', now: 'HERA 4' }, { was: 'HERA 5', now: 'HERA 4' }]);
    expect(names.indexOf('HERA 4')).toBe(6);   // (Hera 6's slot)
  });
  it('an edited copy is not', () => {
    const p = parse(now)[0].bytes.slice();
    p[1] = 33;
    p[20] ^= 1;
    expect(table.some((t) => t.fnv === fnv32(p) && t.len === p.length)).toBe(false);
  });
});

// presets.h's RELEASED_SETS (scripts/legacy-factory.ts, export-defs): main.c bank_add places a factory patch the bank's
// released set did not have by name (#630).
describe('released factory sets (a new factory patch after an update)', () => {
  const rows = [...now.matchAll(/\{0x([0-9a-f]{6})u, 0x([0-9a-f]+)ull\}/g)].map((m) => ({ set: parseInt(m[1], 16), has: BigInt('0x' + m[2]) }));
  const tags = (() => {
    try {
      return execFileSync('git', ['tag', '-l', 'v*'], { encoding: 'utf8' }).split('\n').filter(Boolean);
    } catch {
      return [];
    }
  })();
  it.skipIf(!tags.includes('v1.9.1'))('every release tag\'s factory set is listed with the names it had', () => {
    for (const t of tags) {
      const src = show(t);
      if (!src) continue;
      const set = parseInt(src.match(/#define FACTORY_SET_ID 0x([0-9a-f]+)u/)?.[1] ?? '0', 16);
      const row = rows.find((r) => r.set === set);
      expect(row, t).toBeDefined();
      const had = new Set(parse(src).map((p) => p.name));
      names.forEach((n, i) => { if (had.has(n)) expect((row!.has >> BigInt(i)) & 1n, `${t} ${n}`).toBe(1n); });
    }
  });
  it('1.9.1\'s bank gets Verona Drum 1 and nothing else (it had Hera 6, so it has Hera 4, which took its slot)', () => {
    const row = rows.find((r) => r.set === 0xb9a4a8)!;
    const missing = names.filter((_, i) => !((row.has >> BigInt(i)) & 1n));
    expect(missing).toEqual(['VERONA DRUM 1']);
  });
});
