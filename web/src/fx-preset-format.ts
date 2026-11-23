// SPDX-License-Identifier: GPL-3.0-only
// The value layouts of presets that hold FX (docs/ledger/patches-and-presets.md). Both use the ordinary Q16 preset
// transport and store; a structure of their own keeps older firmware, or another drawer, from reading FX values as an
// instrument's rows.
//
// FXD1 (1.26.2): an instrument with its FX drawer. Values: the instrument's card rows (structure.ts rowOrder, drawer
// left out), then for each effect in chain order its on/off (0 or 1) and its card rows (rowOrder of the effect), then
// the footer lo16(base), hi16(base), n, 23119. Its structure is structure.ts drawerPresetStructure(base, effects).
// The FM-1 checks the same layout (pages_ui.c).
//
// FXP1 (D-1010, read only): an instrument with the master FX bus of 1.24-1.26. Values: the instrument's rows, then for
// each stage present in the mask (drive, chorus, delay, reverb) its on/off and FX_PRESET_CONTROLS, then the footer
// lo16(base), hi16(base), mask, 23118. The editor converts every one it reads to FXD1 (fx-preset.ts fxp1ToFxd1).
export const FX_PRESET_CONTROLS = {
  drive: ['drive', 'mode', 'level', 'sym'],
  chorus: ['rate', 'depth', 'mix'],
  delay: ['time', 'fb', 'mix', 'sync', 'pingpong', 'note'],
  reverb: ['size', 'damp', 'mix', 'pre', 'mod', 'freeze'],
} as const;
export const FX_PRESET_KINDS = ['drive', 'chorus', 'delay', 'reverb'] as const;
export type FxPresetKind = typeof FX_PRESET_KINDS[number];
const MAGIC = 23118;
const DRAWER_MAGIC = 23119;
/** at most this many effects in one FXD1 record (the rack section's effect limit) */
export const DRAWER_EFFECTS_MAX = 32;
const word = (n: number): number => (n << 16) >> 16;
const validMask = (mask: number): boolean => Number.isInteger(mask) && mask > 0 && mask < 16;
const footerBase = (lo: number, hi: number): string | null =>
  [lo, hi].every(v => Number.isInteger(v) && v >= -32768 && v <= 32767) ? (((hi & 65535) << 16 | lo & 65535) >>> 0).toString(16).padStart(8, '0') : null;

/** Stable wire identity of an FXP1 record; firmware pages_ui.c dp_fx_hash is its twin. */
export function fxPresetStructure(base: string, mask: number): string {
  let hash = 2166136261;
  const structure = parseInt(base, 16);
  for (const byte of [70, 88, 80, 49, structure & 255, (structure >>> 8) & 255, (structure >>> 16) & 255, structure >>> 24, mask])
    hash = Math.imul(hash ^ byte, 16777619) >>> 0;
  return hash.toString(16).padStart(8, '0');
}

export const fxPresetPayloadSize = (mask: number): number => FX_PRESET_KINDS.reduce((n, kind, i) => n + (mask & (1 << i) ? 1 + FX_PRESET_CONTROLS[kind].length : 0), 0);

/** An FXP1 record read: the instrument's structure, the stages' mask and how many instrument rows it holds; null when the
 *  values are not one (the footer re-hashes to its structure, every on value is 0 or 1). */
export function fxPresetInfo(preset: { structure: string; values: readonly number[] }): { baseStructure: string; mask: number; rows: number } | null {
  const values = preset.values, n = values.length;
  if (n < 4 || values[n - 1] !== MAGIC) return null;
  const [lo, hi, mask] = values.slice(n - 4, n - 1);
  const baseStructure = footerBase(lo, hi);
  if (!baseStructure || !validMask(mask)) return null;
  if (fxPresetStructure(baseStructure, mask) !== preset.structure) return null;
  const rows = n - 4 - fxPresetPayloadSize(mask);
  if (rows < 0 || values.some(v => !Number.isFinite(v))) return null;
  let at = rows;
  for (let i = 0; i < FX_PRESET_KINDS.length; i++) if (mask & (1 << i)) {
    if (values[at] !== 0 && values[at] !== 1) return null;
    at += 1 + FX_PRESET_CONTROLS[FX_PRESET_KINDS[i]].length;
  }
  return { baseStructure, mask, rows };
}

/** An FXD1 record's values: the instrument's rows, each effect's on/off and rows, the footer. */
export function drawerPresetValues(base: string, rows: readonly number[], effects: readonly { on: boolean; values: readonly number[] }[]): number[] {
  if (effects.length > DRAWER_EFFECTS_MAX) throw new Error(`An FX drawer preset holds ${DRAWER_EFFECTS_MAX} effects at most`);
  const structure = parseInt(base, 16);
  return [...rows, ...effects.flatMap(e => [Number(e.on), ...e.values]), word(structure), word(structure >>> 16), effects.length, DRAWER_MAGIC];
}

/** An FXD1 record's footer read: the instrument's structure and how many effects it holds; null when the values do not
 *  end in one. The structure itself is checked where the effects' structures are known (fx-preset.ts). */
export function drawerPresetInfo(preset: { values: readonly number[] }): { baseStructure: string; count: number } | null {
  const values = preset.values, n = values.length;
  if (n < 4 || values[n - 1] !== DRAWER_MAGIC) return null;
  const [lo, hi, count] = values.slice(n - 4, n - 1);
  const baseStructure = footerBase(lo, hi);
  if (!baseStructure || !Number.isInteger(count) || count < 0 || count > DRAWER_EFFECTS_MAX || n < 4 + count) return null;
  return { baseStructure, count };
}

/** an FXD1 record's values, split: the instrument's rows, then each effect's on/off and rows */
export interface DrawerValues { rows: number[]; effects: { on: boolean; values: number[] }[] }

/** An FXD1 record's values split by an instrument of `baseRows` rows and effects of `effectRows` rows each (in chain
 *  order); null unless the values are exactly that layout with every on value 0 or 1 and every value a number. */
export function splitDrawerValues(values: readonly number[], baseRows: number, effectRows: readonly number[]): DrawerValues | null {
  if (values.length !== baseRows + effectRows.reduce((n, r) => n + 1 + r, 0) + 4 || values.some(v => !Number.isFinite(v))) return null;
  if (values[values.length - 2] !== effectRows.length) return null;
  const effects: DrawerValues['effects'] = [];
  let at = baseRows;
  for (const r of effectRows) {
    const on = values[at];
    if (on !== 0 && on !== 1) return null;
    effects.push({ on: on === 1, values: values.slice(at + 1, at + 1 + r) });
    at += 1 + r;
  }
  return { rows: values.slice(0, baseRows), effects };
}
