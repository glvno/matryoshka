// SPDX-License-Identifier: GPL-3.0-only
// The FM-1's copy of the preset migrations (src/preset-migrations.json, #627, D-865) as C tables for presets.h
// (firmware/src/presetmig.c reads them), and the test cases the firmware's host test (firmware/test/preset_test.c) and the
// emulator's smoke test (tools/emu/src/smoke.rs) check the FM-1 against: earlier presets and what the editor makes of them.
import { DEFS } from '../src/modules';
import { toQ16 } from '../src/patchbin';
import { migrateValues, type Migration } from '../src/preset-migrate';
import type { Lineage } from './lineage-lib';

/** an op byte: 0..PM_LAST copies that earlier row */
const PM_TABLE = 0xfe;
const PM_INIT = 0xff;

/** the presets.h lines, and how many bytes of ROM the tables take */
export function migrationTables(migrations: Record<string, Migration>): { lines: string[]; bytes: number } {
  const ops: number[] = [];
  const tabs: { rows: number[]; lo: number[]; n: number[]; v: number }[] = [];
  const tv: number[] = [];
  const list: string[] = [];
  for (const [from, m] of Object.entries(migrations)) {
    if (m.n > 0xfd || m.rows.length > 0xff) throw new Error(`a migration of ${m.engine} with ${m.n} -> ${m.rows.length} rows`);
    list.push(`    {0x${from}u, 0x${m.to}u, ${ops.length}, ${tabs.length}, ${m.n}, ${m.rows.length}},   /* ${m.engine} */`);
    for (const op of m.rows) {
      if (typeof op === 'number') ops.push(op < 0 ? PM_INIT : op);
      else {
        if (op.v.some((x) => !Number.isInteger(x) || x < -128 || x > 127)) throw new Error(`a table value of ${m.engine} is not a small whole number`);
        ops.push(PM_TABLE);
        tabs.push({ rows: op.rows, lo: op.lo, n: op.n, v: tv.length });
        tv.push(...op.v);
      }
    }
  }
  const lines = [
    '/* user presets of earlier structures of the factory engines move to today\'s at the first boot after an update (web/src/',
    '   preset-migrations.json, D-865, presetmig.c). PMIG_LIST: the earlier structure, today\'s, its first op and table, the earlier',
    '   row count, today\'s; PMIG_OPS: one byte for each of today\'s rows, an earlier row to copy (0..0xFD), 0xFE the next table,',
    '   0xFF the Init value; PMIG_TAB: one or two earlier rows (b 0xFF: one) read as whole numbers, held inside lo .. lo + n - 1,',
    '   the value at that place in PMIG_TV (a * nb + b) */',
    `#define N_PMIG ${list.length}`,
    `#define N_PMIG_TAB ${tabs.length}`,
    `static const uint8_t PMIG_OPS[${Math.max(1, ops.length)}] = {${ops.length ? ops.join(',') : '0'}};`,
    `static const int8_t PMIG_TV[${Math.max(1, tv.length)}] = {${tv.length ? tv.join(',') : '0'}};`,
    'static const struct { uint8_t a, b, na, nb; int8_t la, lb; uint16_t v; } PMIG_TAB[N_PMIG_TAB ? N_PMIG_TAB : 1] = {',
    ...(tabs.length ? tabs.map((t) => `    {${t.rows[0]}, ${t.rows[1] ?? 0xff}, ${t.n[0]}, ${t.n[1] ?? 1}, ${t.lo[0]}, ${t.lo[1] ?? 0}, ${t.v}},`) : ['    {0, 0, 0, 0, 0, 0, 0},']),
    '};',
    'static const struct { uint32_t from, to; uint16_t ops, tab; uint8_t nold, nnew; } PMIG_LIST[N_PMIG ? N_PMIG : 1] = {',
    ...(list.length ? list : ['    {0, 0, 0, 0, 0, 0},']),
    '};',
    '',
  ];
  return { lines, bytes: ops.length + tv.length + 8 * tabs.length + 16 * list.length };
}

/** a value inside a parameter's range for a test preset: distinct from row to row, exact in Q16, never half way between
 * two whole numbers (the FM-1 and the editor round those alike only away from .5) */
function sample(type: string, param: string, k: number): number {
  const pd = DEFS[type]?.params.find((p) => p.name === param);
  const lo = pd?.min ?? 0, hi = pd?.top ?? pd?.max ?? 1;
  const f = 0.15 + 0.7 * ((k * 0.618034) % 1);
  if (pd?.step && pd.step >= 1) return Math.round(lo + (hi - lo) * f);
  return Math.round((lo + (hi - lo) * f) * 256 + 0.3) / 256;
}

export interface MigrationCase { name: string; from: string; to: string; old: number[]; want: number[] }

/** the test cases: for each earlier structure named, a preset of made-up values (`short`: only that many of them, as the
 * FM-1 stored Cassia 1 presets before 1.8.2) and what it becomes, in Q16 */
export function migrationCases(lineage: Lineage, migrations: Record<string, Migration>, initOf: (structure: string) => number[] | undefined,
  picks: { name: string; from: string; short?: number }[]): MigrationCase[] {
  return picks.map(({ name, from, short }) => {
    const m = migrations[from];
    if (!m) throw new Error(`no migration from ${from}`);
    const entry = Object.values(lineage.engines).flat().find((e) => e.structure === from)!;
    const old = entry.rows.slice(0, short ?? entry.rows.length).map((r, k) => {
      const t = /^([^#]+)#\d+\.([^+]+)/.exec(r[0])!;
      return sample(t[1], t[2], k + 1);
    });
    const init = initOf(m.to)!;
    return { name, from, to: m.to, old: old.map(toQ16), want: migrateValues(m, old, init).map(toQ16) };
  });
}

/** the cases as a C header for the host test and the smoke test */
export function casesHeader(cases: MigrationCase[]): string {
  const L = ['/* SPDX-License-Identifier: GPL-3.0-only */', '/* Generated by web/scripts/export-defs.ts (preset-migration-c.ts). Do not edit. Earlier presets of factory engines', '   and what the editor makes of them (D-865): the FM-1 must make the same (preset_test.c, tools/emu/src/smoke.rs). */', '#pragma once', '#include <stdint.h>', ''];
  cases.forEach((c, i) => {
    L.push(`static const int32_t PMC_OLD_${i}[${c.old.length}] = {${c.old.join(',')}};`);
    L.push(`static const int32_t PMC_WANT_${i}[${c.want.length}] = {${c.want.join(',')}};`);
  });
  L.push(`#define N_PMC ${cases.length}`);
  L.push('static const struct { const char *name; uint32_t from, to; uint32_t nold, nnew; const int32_t *old, *want; } PMC_LIST[N_PMC] = {');
  cases.forEach((c, i) => L.push(`    {"${c.name}", 0x${c.from}u, 0x${c.to}u, ${c.old.length}, ${c.want.length}, PMC_OLD_${i}, PMC_WANT_${i}},`));
  L.push('};', '');
  return L.join('\n');
}

/** the cases every check uses: a 1.9.0 preset of Cassia 1, basic poly and Oracle V (#627's done-when), one stored before
 * 1.8.2 (Cassia 1, 88 values), and the hand-written maps (Cassia 1 before #430, 8 Lire before D-852, Io 4 before #681) */
export const CASE_PICKS = [
  { name: 'MY CASSIA', from: '2b89b424' },
  { name: 'MY POLY', from: '77fdb539' },
  { name: 'MY ORACLE', from: 'ca47b1a9' },
  { name: 'SHORT CZ', from: '2b89b424', short: 88 },
  { name: 'OLD CZ', from: '62d178d5' },
  { name: 'OLD LIRE', from: 'd34140e9' },
  { name: 'MY IO 4', from: 'bcfb20df' },
];
