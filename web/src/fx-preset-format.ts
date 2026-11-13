// SPDX-License-Identifier: GPL-3.0-only
// FXP1 uses the existing Q16 preset transport/store. A distinct structure prevents
// older firmware or a different rack from interpreting FX values as synth rows.
export const FX_PRESET_CONTROLS = {
  drive: ['drive', 'mode', 'level', 'sym'],
  chorus: ['rate', 'depth', 'mix'],
  delay: ['time', 'fb', 'mix', 'sync', 'pingpong', 'note'],
  reverb: ['size', 'damp', 'mix', 'pre', 'mod', 'freeze'],
} as const;
export const FX_PRESET_KINDS = ['drive', 'chorus', 'delay', 'reverb'] as const;
const MAGIC = 23118;
const word = (n: number): number => (n << 16) >> 16;
const validMask = (mask: number): boolean => Number.isInteger(mask) && mask > 0 && mask < 16;

/** Stable wire identity; keep firmware pages_ui.c in step. */
export function fxPresetStructure(base: string, mask: number): string {
  let hash = 2166136261;
  const structure = parseInt(base, 16);
  for (const byte of [70, 88, 80, 49, structure & 255, (structure >>> 8) & 255, (structure >>> 16) & 255, structure >>> 24, mask])
    hash = Math.imul(hash ^ byte, 16777619) >>> 0;
  return hash.toString(16).padStart(8, '0');
}

export const fxPresetPayloadSize = (mask: number): number => FX_PRESET_KINDS.reduce((n, kind, i) => n + (mask & (1 << i) ? 1 + FX_PRESET_CONTROLS[kind].length : 0), 0);

export function fxPresetValues(base: string, mask: number, synth: readonly number[], effects: readonly number[]): number[] {
  if (!validMask(mask) || effects.length !== fxPresetPayloadSize(mask)) throw new Error('Incomplete FX preset');
  const structure = parseInt(base, 16);
  return [...synth, ...effects, word(structure), word(structure >>> 16), mask, MAGIC];
}

/** The self-describing footer survives browser export and an FM-1 round trip. */
export function fxPresetInfo(preset: { structure: string; values: readonly number[] }): { baseStructure: string; mask: number; rows: number } | null {
  const values = preset.values, n = values.length;
  if (n < 4 || values[n - 1] !== MAGIC) return null;
  const [lo, hi, mask] = values.slice(n - 4, n - 1);
  if (![lo, hi].every(v => Number.isInteger(v) && v >= -32768 && v <= 32767) || !validMask(mask)) return null;
  const baseStructure = (((hi & 65535) << 16 | lo & 65535) >>> 0).toString(16).padStart(8, '0');
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
