// SPDX-License-Identifier: GPL-3.0-only
// User presets move when a factory engine's structure changes (#627, D-865): the lineage is up to date, every structure
// change has a map or a decision, the FM-1 gets the same table and test cases, and earlier presets show and play on
// today's factory patches with the values they had.
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { entryOf, lineageText, migrationsOf, migrationsText, readLineage, todaysEngines, LINEAGE_FILE, MIGRATIONS_FILE, type LineageEntry } from '../scripts/lineage-lib';
import { CASE_PICKS, casesHeader, migrationCases, migrationTables } from '../scripts/preset-migration-c';
import { addUserPreset, applyPreset, importPresets, migrateUserPresets, presetsFor, presetsOf, PRESETS_FORMAT, userPresets, currentValues } from './device-presets';
import { factoryPresets } from './factory-presets';
import { renderPlay, ways } from './headroom';
import { migrateValues, PRESET_MIGRATIONS } from './preset-migrate';
import { PRESETS } from './presets';
import { relocatedPatches } from './community-factory';
import { structureOf } from './structure';
import type { AssemblyInst } from './assembly';
import type { Patch } from './patch';

const mem = new Map<string, string>();
beforeEach(() => {
  mem.clear();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
  };
});

const lineage = readLineage();
const initOf = (s: string): number[] | undefined => factoryPresets().find((p) => p.structure === s && p.name === 'Init')?.values;
const entry = (structure: string): LineageEntry => Object.values(lineage.engines).flat().find((e) => e.structure === structure)!;

describe('the lineage (#627)', () => {
  it('has every factory engine\'s structure today as its newest (else: npx vite-node scripts/preset-lineage.ts)', () => {
    for (const [name, def] of todaysEngines()) {
      const list = lineage.engines[name];
      expect(list, name).toBeDefined();
      const { structure, rows } = list[list.length - 1];
      expect({ structure, rows }, name).toEqual(entryOf(def));
    }
  });

  it('is written as preset-lineage.ts writes it, and so are the migrations', () => {
    expect(readFileSync(LINEAGE_FILE, 'utf8')).toBe(lineageText(lineage));
    expect(readFileSync(MIGRATIONS_FILE, 'utf8')).toBe(migrationsText(migrationsOf(lineage).migrations));
  });

  it('has a map, or a decision of none, for every structure change that leaves a row out (preset-maps.ts)', () => {
    expect(migrationsOf(lineage).problems.map((p) => p.message)).toEqual([]);
  });

  it('a structure change with no decision fails', () => {
    const l = { ...lineage, engines: { x: [entry('d34140e9'), entry('15c37cee')] } };
    expect(migrationsOf(l, []).problems).toHaveLength(1);
  });

  it('moves every migrated preset to its engine\'s structure today', () => {
    for (const [from, m] of Object.entries(PRESET_MIGRATIONS)) {
      const today = lineage.engines[m.engine];
      expect(m.to, from).toBe(today[today.length - 1].structure);
      expect(m.rows.length, from).toBe(today[today.length - 1].rows.length);
    }
  });
});

describe('the FM-1\'s copy (presets.h, test/pmig_cases.h)', () => {
  const presetsH = readFileSync(new URL('../../firmware/src/presets.h', import.meta.url), 'utf8');
  it('presets.h has the migrations', () => {
    expect(presetsH).toContain(migrationTables(PRESET_MIGRATIONS).lines.join('\n'));
  });
  it('the test cases are today\'s (npm run export-defs)', () => {
    const want = casesHeader(migrationCases(lineage, PRESET_MIGRATIONS, initOf, CASE_PICKS));
    expect(readFileSync(new URL('../../firmware/test/pmig_cases.h', import.meta.url), 'utf8')).toBe(want);
  });
  it('the tables stay small', () => {
    expect(migrationTables(PRESET_MIGRATIONS).bytes).toBeLessThan(3072);   // (2,240 with the #658 engines: each earlier Cassia 1 structure moves onto its 153 rows)
  });
});

/** a preset of an earlier structure with real values: each row the value of today's Init on the row it becomes, moved a
 * little (a continuous one by 10 %, so it differs from Init) */
function earlierPreset(from: string): number[] {
  const m = PRESET_MIGRATIONS[from];
  const init = initOf(m.to)!;
  const old = entry(from).rows.map(() => 0);
  m.rows.forEach((op, k) => {
    if (typeof op === 'number' && op >= 0) old[op] = Number.isInteger(init[k]) || Math.abs(init[k]) < 0.05 ? init[k] : Math.round(init[k] * 0.9 * 1e4) / 1e4;
  });
  return old;
}

/** today's patch that has an engine of the structure, and that engine */
function factoryWith(structure: string): { name: string; p: Patch; a: AssemblyInst } {
  for (const [name, make] of Object.entries({ ...relocatedPatches, ...PRESETS })) {
    const p = make();
    const a = (p.assemblies ?? []).find((x) => structureOf(p, x) === structure);
    if (a) return { name, p, a };
  }
  throw new Error(`no patch has ${structure}`);
}

describe('a 1.9.0 preset on today\'s factory patch (#627 done-when)', () => {
  for (const [engine, from] of [['Cassia 1', '2b89b424'], ['basic poly', '77fdb539'], ['Oracle V', 'ca47b1a9']] as const) {
    it(`${engine}: it shows, with the same values on its old rows and Init's on the new one, and plays`, () => {
      const old = earlierPreset(from);
      mem.set('matryoshka.presets', JSON.stringify([{ structure: from, name: 'My Sound', values: old }]));
      expect(migrateUserPresets()).toBe(1);
      const m = PRESET_MIGRATIONS[from];
      const { name, p, a } = factoryWith(m.to);
      const mine = presetsOf(p, a).find((x) => x.name === 'My Sound');
      expect(mine, `${engine} on the factory patch ${name}`).toBeDefined();
      expect(userPresets().filter((x) => x.name === 'My Sound')).toHaveLength(1);   // (its old copy is gone)
      // each old row's value is on the row of the same module and parameter today; the new row has Init's value
      const before = entry(from).rows, now = entry(m.to).rows;
      const init = initOf(m.to)!;
      if (engine === 'Oracle V') {
        // (rebuilt in 1.11 with the Prophet-5's cut functions, #658: a hand map moves its rows, preset-maps.ts)
        expect(mine!.values).toEqual(migrateValues(m, old, init));
      } else {
        now.forEach((r, k) => {
          const j = before.findIndex((x) => x[0] === r[0]);
          expect(mine!.values[k], `${engine} ${r[0]} "${r[1]}"`).toBe(j >= 0 ? old[j] : init[k]);
        });
      }
      expect(applyPreset(p, a, mine!)).toBe(true);
      expect(currentValues(p, a)).toEqual(mine!.values);
      const [l, rr] = renderPlay(ways(p, engine, 4)[0], 0.5);
      let peak = 0;
      for (let i = 0; i < l.length; i++) peak = Math.max(peak, Math.abs(l[i]), Math.abs(rr[i]));
      expect(Number.isFinite(peak) && peak > 1e-3, `${engine} plays (peak ${peak})`).toBe(true);
    });
  }
});

describe('moving presets (D-865)', () => {
  it('Oracle V before #658: the waves land on the Prophet-5\'s wave switches, the levels on the mixer', () => {
    const m = PRESET_MIGRATIONS['7a7a26f6'];
    const old = entry('7a7a26f6').rows, now = entry(m.to).rows;
    const at = (rows: typeof old, id: string): number => rows.findIndex((r) => r[0] === id);
    const vals = old.map(() => 0.3);
    vals[at(old, 'osc#8.wave')] = 3;      // A: square
    vals[at(old, 'osc#7.wave')] = 0;      // B: sine
    vals[at(old, 'lfo#1.wave')] = 3;      // LFO: square
    vals[at(old, 'osc#8.level')] = 0.61;
    vals[at(old, 'ladder#12.cvamt')] = 2.5;
    const out = migrateValues(m, vals, initOf(m.to)!);
    const get = (id: string): number => out[at(now, id)];
    expect([get('select#24.pos'), get('select#25.pos')]).toEqual([1, 2]);                       // A: saw OFF, pulse ON
    expect([get('select#28.pos'), get('select#29.pos'), get('select#30.pos')]).toEqual([1, 2, 1]); // B: tri ON
    expect([get('select#47.pos'), get('select#48.pos'), get('select#49.pos')]).toEqual([1, 1, 2]); // LFO: square ON
    expect(get('mixer#31.l1')).toBe(0.61);    // A level
    expect(get('scale#40.gain')).toBe(2.5);   // env amt
  });

  it('a preset with fewer values than its rows (Cassia 1 stored on an FM-1 before 1.8.2): the rest take Init', () => {
    const old = earlierPreset('2b89b424').slice(0, 88);
    const m = PRESET_MIGRATIONS['2b89b424'];
    const out = migrateValues(m, old, initOf(m.to)!);
    expect(out).toHaveLength(m.rows.length);
    m.rows.forEach((op, k) => typeof op === 'number' && expect(out[k]).toBe(op >= 0 && op < 88 ? old[op] : initOf(m.to)![k]));
  });

  it('Cassia 1 before #430: the waves, line and modulation land on their Selector positions', () => {
    const from = '62d178d5';
    const rows = entry(from).rows;
    const old = rows.map(() => 0);
    const set = (t: string, v: number): void => void (old[rows.findIndex((r) => r[0] === t)] = v);
    set('const#10.value', 3);     // line 1: dbl sine
    set('const#13.value', 5);     // line 2: reso 1
    set('const#11.value', 0);     // line 1's wave 2: off
    set('const#14.value', 8);     // line 2's wave 2: reso 3, which has no place: reso 2
    set('select#43.pos', 3);      // 1+2'
    set('const#9.value', 1);      // .. with 1+1' on: 1+1'
    set('select#40.pos', 2);      // ring on
    set('select#42.pos', 1);      // noise off: ring
    const m = PRESET_MIGRATIONS[from];
    const out = migrateValues(m, old, initOf(m.to)!);
    const now = entry(m.to).rows;
    const at = (t: string): number => out[now.findIndex((r) => r[0] === t)];
    expect([at('select#10.pos'), at('select#13.pos'), at('select#11.pos'), at('select#14.pos')]).toEqual([4, 6, 1, 8]);
    expect(at('select#9.pos')).toBe(3);
    expect(at('select#37.pos')).toBe(2);
  });

  it('8 Lire before D-852: the hold Consts\' values are the Macros\'', () => {
    const from = 'd34140e9';
    const rows = entry(from).rows;
    const old = rows.map((_, i) => i / 100);
    const m = PRESET_MIGRATIONS[from];
    const out = migrateValues(m, old, initOf(m.to)!);
    const holdsBefore = rows.map((r, i) => (r[0].startsWith('const#') ? old[i] : null)).filter((x) => x !== null).sort();
    const holdsNow = entry(m.to).rows.map((r, k) => (r[0].startsWith('macro#') && r[1] === 'hold' ? out[k] : null)).filter((x) => x !== null).sort();
    expect(holdsNow).toEqual(holdsBefore);
  });

  it('the newer structure\'s preset wins a name; one named as a factory preset of today stays as it is', () => {
    const lire = earlierPreset('15c37cee');
    mem.set('matryoshka.presets', JSON.stringify([
      { structure: '15c37cee', name: 'Drone', values: lire },
      { structure: 'd34140e9', name: 'drone', values: lire.map(() => 0) },
      { structure: '77fdb539', name: 'Fat Bass', values: earlierPreset('77fdb539') },
    ]));
    migrateUserPresets();
    const to = PRESET_MIGRATIONS['15c37cee'].to;
    const drone = userPresets().filter((x) => x.structure === to);
    expect(drone).toHaveLength(1);
    expect(drone[0].values).toEqual(migrateValues(PRESET_MIGRATIONS['15c37cee'], lire, initOf(to)!));
    expect(presetsFor(PRESET_MIGRATIONS['77fdb539'].to).some((x) => x.name === 'Fat Bass' && x.factory)).toBe(true);
    expect(userPresets().find((x) => x.name === 'Fat Bass')?.structure).toBe('77fdb539');
    expect(migrateUserPresets()).toBe(0);
  });

  it('a preset from an FM-1 that has not moved them, and a library file, move as they come in', () => {
    const v = earlierPreset('ca47b1a9');
    const to = PRESET_MIGRATIONS['ca47b1a9'].to;
    expect(addUserPreset('ca47b1a9', 'FROM FM1', v)).toBe('From Fm1');
    expect(userPresets().find((x) => x.name === 'From Fm1')?.structure).toBe(to);
    expect(importPresets({ format: PRESETS_FORMAT, presets: [{ structure: '77fdb539', name: 'Filed', values: earlierPreset('77fdb539') }] })).toBe(1);
    expect(userPresets().find((x) => x.name === 'Filed')?.structure).toBe(PRESET_MIGRATIONS['77fdb539'].to);
  });

  it('a preset of a structure that does not move, or too long for its structure, stays', () => {
    mem.set('matryoshka.presets', JSON.stringify([
      { structure: '0badf00d', name: 'Other', values: [1, 2, 3] },
      { structure: '77fdb539', name: 'Long', values: Array(20).fill(0) },
      { structure: '06ea3383', name: 'Rebuilt', values: Array(22).fill(0) },
    ]));
    expect(migrateUserPresets()).toBe(0);
    expect(userPresets().map((x) => x.structure)).toEqual(['0badf00d', '77fdb539', '06ea3383']);
  });
});
