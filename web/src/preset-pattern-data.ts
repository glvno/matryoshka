// SPDX-License-Identifier: GPL-3.0-only
import { fnv } from './structure';
import catalog from './preset-patterns.json';
export interface PresetPattern {
  id: string;
  structure: string;
  name: string;
  notes: number[];
  len: number;
  rate: number;
  swing: number;
  gate: number;
  dir: number;
}
export let PRESET_PATTERNS: readonly PresetPattern[] = catalog;
/** Generators use fresh structures while rebuilding factory content. */
export const setPresetPatterns = (patterns: readonly PresetPattern[]): void => { PRESET_PATTERNS = patterns; };
export const presetPattern = (structure: string, name: string): PresetPattern | undefined =>
  PRESET_PATTERNS.find((p) => p.structure === structure && p.name.toLowerCase() === name.toLowerCase());
export const presetPatternById = (id: string | undefined): PresetPattern | undefined =>
  id ? PRESET_PATTERNS.find((p) => p.id === id) : undefined;
/** An identity binds one immutable pattern revision; display-name collisions grant no ownership. */
export const patternRevision = (p: Omit<PresetPattern, 'id'>): string =>
  fnv(JSON.stringify({ structure: p.structure, name: p.name, notes: p.notes, len: p.len, rate: p.rate, swing: p.swing, gate: p.gate, dir: p.dir }));
