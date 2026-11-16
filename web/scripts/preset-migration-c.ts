// SPDX-License-Identifier: GPL-3.0-only
// The FM-1's copy of the preset migrations (src/preset-migrations.json, #627, D-865) as the migrations section of the
// factory region's image (scripts/factory-region.ts; firmware/src/presetmig.c reads it, #915), and the test cases the
// firmware's host test (firmware/test/preset_test.c) and the emulator's smoke test (tools/emu/src/smoke.rs) check the FM-1
// against: earlier presets and what the editor makes of them.
import { DEFS } from '../src/modules';
import { toQ16 } from '../src/patchbin';
import { migrateValues, type Migration } from '../src/preset-migrate';
import type { Lineage } from './lineage-lib';

/** an op byte: 0..0xFC copies that earlier row */
const PM_LINE = 0xfd;
const PM_TABLE = 0xfe;
const PM_INIT = 0xff;

/** where `run` starts in `into`: an earlier identical run of values is shared (a line or table points at its first value),
 * else it is appended. Values never change at run time, so two lines or tables may read the same ones. */
function shared(into: number[], run: number[]): number {
  for (let i = 0; i + run.length <= into.length; i++) if (run.every((x, k) => into[i + k] === x)) return i;
  into.push(...run);
  return into.length - run.length;
}

/** the migrations section (firmware/src/factory.c describes it): u16 counts of the list, tables, lines, ops, table values
 *  and line values, then the list (16 bytes each), the tables (8), the lines (6), the line values (i32), the table values
 *  (i8) and the ops (u8), all little endian */
export function migrationSection(migrations: Record<string, Migration>): Uint8Array {
  const ops: number[] = [];
  const tabs: { rows: number[]; lo: number[]; n: number[]; v: number }[] = [];
  const tv: number[] = [];
  const lines: { x: number; key: number; n: number; lo: number; v: number }[] = [];
  const lv: number[] = [];
  const list: { from: string; to: string; ops: number; tab: number; line: number; nold: number; nnew: number }[] = [];
  for (const [from, m] of Object.entries(migrations)) {
    if (m.n > 0xfd || m.rows.length > 0xff) throw new Error(`a migration of ${m.engine} with ${m.n} -> ${m.rows.length} rows`);
    list.push({ from, to: m.to, ops: ops.length, tab: tabs.length, line: lines.length, nold: m.n, nnew: m.rows.length });
    for (const op of m.rows) {
      if (typeof op === 'number') {
        if (op > 0xfc) throw new Error(`a migration of ${m.engine} copies row ${op}`);
        ops.push(op < 0 ? PM_INIT : op);
      } else if ('x' in op) {
        if ((op.lo ?? 0) < -128 || (op.lo ?? 0) > 127 || op.mul.length > 0xff) throw new Error(`a line of ${m.engine}`);
        ops.push(PM_LINE);
        lines.push({ x: op.x, key: op.key ?? 0xff, n: op.mul.length, lo: op.lo ?? 0, v: shared(lv, [op.min, op.max, ...op.mul.flatMap((k, i) => [k, op.add[i]])]) });
      } else {
        if (op.v.some((x) => !Number.isInteger(x) || x < -128 || x > 127)) throw new Error(`a table value of ${m.engine} is not a small whole number`);
        ops.push(PM_TABLE);
        tabs.push({ rows: op.rows, lo: op.lo, n: op.n, v: shared(tv, op.v) });
      }
    }
  }
  if ([ops.length, tv.length, lv.length].some((n) => n > 0xffff)) throw new Error('the preset migrations outgrow their 16-bit offsets');
  const out = new Uint8Array(12 + 16 * list.length + 8 * tabs.length + 6 * lines.length + 4 * lv.length + tv.length + ops.length);
  const v = new DataView(out.buffer);
  [list.length, tabs.length, lines.length, ops.length, tv.length, lv.length].forEach((n, i) => v.setUint16(2 * i, n, true));
  let at = 12;
  for (const e of list) {
    v.setUint32(at, parseInt(e.from, 16), true);
    v.setUint32(at + 4, parseInt(e.to, 16), true);
    v.setUint16(at + 8, e.ops, true);
    v.setUint16(at + 10, e.tab, true);
    v.setUint16(at + 12, e.line, true);
    out[at + 14] = e.nold;
    out[at + 15] = e.nnew;
    at += 16;
  }
  for (const t of tabs) {
    out.set([t.rows[0], t.rows[1] ?? 0xff, t.n[0], t.n[1] ?? 1, t.lo[0] & 0xff, (t.lo[1] ?? 0) & 0xff], at);
    v.setUint16(at + 6, t.v, true);
    at += 8;
  }
  for (const l of lines) {
    out.set([l.x, l.key, l.n, l.lo & 0xff], at);
    v.setUint16(at + 4, l.v, true);
    at += 6;
  }
  for (const x of lv) { v.setInt32(at, x, true); at += 4; }
  for (const x of tv) out[at++] = x & 0xff;
  out.set(ops, at);
  return out;
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
 * 1.8.2 (Cassia 1, 88 values), and the hand-written maps (Cassia 1 before #430, 8 Lire before D-852, Io 4 before #681,
 * Algo Four before #658, Canvas before D-348 with its lines) */
export const CASE_PICKS = [
  { name: 'MY CASSIA', from: '2b89b424' },
  { name: 'MY POLY', from: '77fdb539' },
  { name: 'MY ORACLE', from: 'ca47b1a9' },
  { name: 'SHORT CZ', from: '2b89b424', short: 88 },
  { name: 'OLD CZ', from: '62d178d5' },
  { name: 'OLD LIRE', from: 'd34140e9' },
  { name: 'MY IO 4', from: 'bcfb20df' },
  { name: 'MY ALGO', from: '666a5214' },
  { name: 'MY CANVAS', from: '5ae3f8ec' },
];
