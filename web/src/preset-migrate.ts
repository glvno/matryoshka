// SPDX-License-Identifier: GPL-3.0-only
// User presets move when a factory engine's structure changes (#627, docs/ledger/patches-and-presets.md D-865). A preset
// is matched to its engine by the structure fingerprint (structure.ts), so a factory engine rebuilt with another structure
// no longer lists the presets stored for its earlier one. preset-migrations.json (written by scripts/preset-lineage.ts
// from preset-lineage.json and preset-maps.ts) says, for each earlier structure of a factory engine, how its values
// become the values of today's structure: one entry for each of today's rows, in canonical row order. The editor (here,
// device-presets.ts) and the FM-1 (firmware/src/presetmig.c, from the same table in presets.h) do the same.
import MIGRATIONS from './preset-migrations.json';

/** how one of today's rows gets its value: a number is the earlier preset's row of that index (kept as it was); -1 the
 * engine's Init value (a new row, or one the earlier preset lacks); a table reads one or two earlier rows as whole numbers
 * (rounded, then held inside lo .. lo + n - 1) and gives the value at that place (a Selector's position, say) */
export type MigrationOp = number | MigrationTable | MigrationLine;
export interface MigrationTable {
  /** the earlier rows read (one or two) */
  rows: number[];
  /** each row's lowest whole number */
  lo: number[];
  /** how many whole numbers each row has in the table */
  n: number[];
  /** the values, the first row's place times the second's count plus the second's place */
  v: number[];
}
/** a line: one earlier row x times mul plus add, held inside min .. max, in Q16 (65536 is 1) and computed in Q16, as the
 * FM-1 does (presetmig.c), so both give the same value. `key`: an earlier row read as a whole number picks the line
 * (place key - lo, held inside the lines) */
export interface MigrationLine {
  x: number;
  key?: number;
  lo?: number;
  mul: number[];
  add: number[];
  min: number;
  max: number;
}
export interface Migration {
  /** the factory engine */
  engine: string;
  /** today's structure */
  to: string;
  /** how many rows the earlier structure has */
  n: number;
  /** today's rows */
  rows: MigrationOp[];
}

/** every earlier structure that moves, by fingerprint, oldest first within each engine */
export const PRESET_MIGRATIONS = MIGRATIONS as unknown as Record<string, Migration>;

/** the values of today's rows from an earlier preset's values (a shorter preset: its missing rows count as new) */
export function migrateValues(m: Migration, values: number[], init: number[]): number[] {
  const at = (i: number): number | undefined => (i >= 0 && i < values.length ? values[i] : undefined);
  return m.rows.map((op, k) => {
    if (typeof op === 'number') return at(op) ?? init[k];
    if ('x' in op) {
      const x = at(op.x);
      const key = op.key === undefined ? 0 : at(op.key);
      if (x === undefined || key === undefined) return init[k];
      const i = op.key === undefined ? 0 : Math.min(op.mul.length - 1, Math.max(0, Math.round(key) - (op.lo ?? 0)));
      const q = Math.floor((Math.round(x * 65536) * op.mul[i]) / 65536) + op.add[i];
      return Math.min(op.max, Math.max(op.min, q)) / 65536;
    }
    let idx = 0;
    for (let j = 0; j < op.rows.length; j++) {
      const v = at(op.rows[j]);
      if (v === undefined) return init[k];
      idx = idx * op.n[j] + Math.min(op.n[j] - 1, Math.max(0, Math.round(v) - op.lo[j]));
    }
    return op.v[idx];
  });
}

/** an earlier preset moved to today's structure; null when its structure does not move (or it has more values than that
 * structure has rows: not one of its presets) */
export function movePreset(structure: string, values: number[], initOf: (structure: string) => number[] | undefined): { structure: string; values: number[] } | null {
  const m = PRESET_MIGRATIONS[structure];
  if (!m || values.length > m.n) return null;
  const init = initOf(m.to);
  if (!init || init.length !== m.rows.length) return null;
  return { structure: m.to, values: migrateValues(m, values, init) };
}

/** the order presets are moved in: the older structure first, so of two presets that land on the same name, the one
 * stored for the newer structure wins (it is written last) */
export const migrationRank = (structure: string): number => Object.keys(PRESET_MIGRATIONS).indexOf(structure);
