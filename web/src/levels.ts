// SPDX-License-Identifier: GPL-3.0-only
// Factory levels (#448): every factory patch and every factory preset of its engines plays at about the same loudness.
// Loudness is measured as BS.1770 integrated loudness (loudness.ts), each sound played the same way: one key held, a
// 4-key chord held, or (a patch that plays its pattern 1 on the transport: the drum kits and drum engines) its pattern
// running. The rule (LOUDNESS, CHORD_LOUDNESS, HEADROOM): one key at about -18 LUFS, a chord at most 3 LU over that, and
// no way of playing it (headroom.ts) over the 0.88 peak cap, whichever is quietest. A sound with high peaks and little
// body (a bell, a pluck) reaches only what the cap allows. Each engine's level rows (LEVEL_ROWS, after any drive) carry
// its presets' levels; the patch's Output carries its Init's. scripts/factory-build.ts `loudness` sets both;
// levels-*.test.ts keeps them so.
import { allModules, toDef, type AssemblyInst } from './assembly';
import { applyPreset, currentValues, presetsOf } from './device-presets';
import { instIsEngine } from './engines';
import { HEADROOM, patterns, peakOfPlay, renderPlay, voicesIn, ways, type Play } from './headroom';
import { integratedLoudness } from './loudness';
import { DEVICE_SR } from './modules';
import type { Patch } from './patch';
import { cardRows } from './preset-cards';

/** one key held: its integrated loudness, in LUFS */
export const LOUDNESS = -18;
/** a 4-key chord held: at most this loud (3 LU over one key: a pad held as a chord stays near a lead) */
export const CHORD_LOUDNESS = LOUDNESS + 3;
/** how far from the target a factory sound may land and still count as on it (the test's tolerance), in LU */
export const LOUDNESS_TOLERANCE = 1.5;
/** the key held, and the chord (C3, the C major triad and the octave over it) */
export const KEY = 48;
export const CHORD4 = [48, 55, 60, 64];
/** how long a key or chord is held, and a pattern runs, for its loudness (seconds) */
export const HOLD_SECS = 3;
export const PATTERN_SECS = 4;
/** the peak cap is checked over this long (as headroom() does) */
export const PEAK_SECS = 3;

/** each factory engine's level rows, by their card key (preset-cards.ts cardRows), after any drive or resonance: the
 * rows that set its whole output's level. Two rows (two output channels, or the two halves of an output mixer) move
 * together, by the same factor. A row in dB (a compressor's makeup gain) moves by the same number of dB. */
export const LEVEL_ROWS: Record<string, string[]> = {
  '8 Lire': ['distortion / vol'],
  'Algo Four': ['voice / volume'],
  'basic poly': ['level'],
  'Briefcase 3': ['reverb / level'],
  Canvas: ['output / chan a', 'output / chan b'],
  'Cassia 1': ['voice / vol'],
  'drift poly': ['level'],
  'drum kit': ['drums / level'],
  'Elvira 2': ['ouch / vol'],
  'Expander S': ['output / level'],
  'Hera 4': ['vca / level'],
  'Io 4': ['vca / level'],
  'Meridian 8': ['out / main'],
  'mono lead': ['level'],
  'Monolith D': ['output / volume'],
  'Oracle V': ['mixer / volume'],
  'Perun 4': ['master / master'],
  'Sallen 20': ['output / volume'],
  Scrounge: ['out / vol a', 'out / vol b'],
  'Silver Box': ['tone / volume'],
  'Spokes 6': ['master / master'],
  'supersaw stack': ['level'],
  'Vernon 100': ['output mixer / amp shaper', 'output mixer / osc 3/ext'],
  'Verona Drum 1': ['master / master'],
  Wanderer: ['filters · vca / vca level', 'filters · vca / gain'],
};

export interface LevelRow { module: number; param: string; key: string; db: boolean; min: number; max: number; step: number }

/** an engine's level rows in a patch (module ids are the patch's); throws when the engine has none listed or a row is gone */
export function levelRows(p: Patch, a: AssemblyInst): LevelRow[] {
  const name = a.name ?? '';
  const keys = LEVEL_ROWS[name];
  if (!keys) throw new Error(`${name}: no level row listed (levels.ts LEVEL_ROWS)`);
  const rows = cardRows(toDef(p, a));
  return keys.map((k) => {
    const r = rows.find((x) => x.key === k);
    if (!r?.pd) throw new Error(`${name}: no level row "${k}" on its card`);
    const at = a.params[r.i];
    return { module: at.module, param: at.param, key: k, db: r.pd.unit === 'dB', min: r.pd.min, max: r.pd.max, step: r.pd.step ?? 0.001 };
  });
}

/** a level row's value moved by a gain factor (in dB for a row in dB), rounded to its step (down, with `down`: the
 * peak cap binds) and kept in its range */
export function scaledRow(r: LevelRow, v: number, k: number, down = false): number {
  const raw = r.db ? v + 20 * Math.log10(k) : v * k;
  const stepped = (down ? Math.floor(raw / r.step + 1e-6) : Math.round(raw / r.step)) * r.step;
  return +Math.min(r.max, Math.max(r.min, stepped)).toFixed(4);
}

/** how a patch is played for its loudness: its pattern 1 on the transport (it has notes there and its keys play no
 * melodic voice: a drum kit, a drum engine on its PATTERN track), else keys */
export function playsPattern(p: Patch): boolean {
  if (!patterns(p).includes(0)) return false;
  return p.modules.some((m) => m.type === 'steps' && m.notes?.length);
}

/** the keys a patch is played with: a Drum map's first rows for an engine whose keys reach one and no Voicing (8 Lire,
 * Elvira 2: one plate, four plates), else KEY and CHORD4 */
export function keysOf(p: Patch): { key: number[]; chord: number[] } {
  const voiced = p.modules.some((m) => m.type === 'alloc');
  const map = p.modules.find((m) => m.type === 'drummap');
  if (!voiced && map) {
    const rows = [...new Set(Array.from({ length: 8 }, (_, r) => Math.round(map.params[`n${r + 1}`] as number)))];
    return { key: rows.slice(0, 1), chord: rows.slice(0, 4) };
  }
  return { key: [KEY], chord: CHORD4 };
}

export interface Loudness {
  /** one key held (or the pattern running), LUFS */
  single: number;
  /** the 4-key chord held, LUFS; null for a pattern */
  chord: number | null;
  /** the loudest peak of every way headroom.ts plays it (at the FM-1's rate and at 48 kHz) */
  peak: number;
}

const lufs = (w: Play, secs: number): number => {
  const [l, r] = renderPlay(w, secs, DEVICE_SR);
  return integratedLoudness(l, r, DEVICE_SR);
};

/** a patch's loudness and peak, played the ways above, at its Output level (rendered at an Output of 0.1 and scaled:
 * the engine clamps its output at 1, which would hide a peak over it) */
export function measure(p: Patch): Loudness {
  const out = p.modules.find((m) => m.type === 'output');
  const lv = out?.params.level ?? 1;
  if (out && lv !== MEASURE_AT) {
    const q = structuredClone(p);
    q.modules.find((m) => m.type === 'output')!.params.level = MEASURE_AT;
    const m = measureAsIs(q);
    const k = lv / MEASURE_AT;
    return { single: m.single + 20 * Math.log10(k), chord: m.chord === null ? null : m.chord + 20 * Math.log10(k), peak: m.peak * k };
  }
  return measureAsIs(p);
}
/** the engines whose every preset must also hold eight keys at eight voices under the peak cap, whatever its own voices
 * (drift-poly-headroom.test.ts, #413) */
export const EIGHT_VOICES = new Set(['drift poly']);
/** the Output's level a sound is measured at */
const MEASURE_AT = 0.1;

function measureAsIs(p: Patch): Loudness {
  const all = ways(p, '', voicesIn(p, p.modules.map((m) => m.id)));
  // (an engine listed in EIGHT_VOICES also with its Voicing at eight voices and eight keys held, as its test plays it)
  for (const a of (p.assemblies ?? []).filter((x) => EIGHT_VOICES.has(x.name ?? ''))) {
    const q = structuredClone(p);
    const ids = new Set(allModules(q, (q.assemblies ?? []).find((x) => x.id === a.id)!));
    for (const m of q.modules) if (m.type === 'alloc' && ids.has(m.id)) m.params.voices = 8;
    all.push(...ways(q, '', 8).slice(0, 1));
  }
  const peak = Math.max(...all.flatMap((w) => [DEVICE_SR, 48000].map((sr) => peakOfPlay(w, PEAK_SECS, sr))));
  if (playsPattern(p)) return { single: lufs({ label: '', patch: p, notes: [], run: true }, PATTERN_SECS), chord: null, peak };
  const { key, chord } = keysOf(p);
  return { single: lufs({ label: '', patch: p, notes: key, run: false }, HOLD_SECS), chord: lufs({ label: '', patch: p, notes: chord, run: false }, HOLD_SECS), peak };
}

/** the gain a sound needs to land on the rule: one key at LOUDNESS, the chord at most CHORD_LOUDNESS, the peak at most
 * HEADROOM (all scale with a level after any drive) */
export function gainFor(m: Loudness): number {
  const db = Math.min(LOUDNESS - m.single, m.chord === null ? Infinity : CHORD_LOUDNESS - m.chord);
  return Math.min(Math.pow(10, db / 20), HEADROOM / Math.max(m.peak, 1e-9));
}

/** whether the peak cap is what binds a sound's gain */
export const peakBound = (m: Loudness): boolean => HEADROOM / Math.max(m.peak, 1e-9) <= Math.pow(10, Math.min(LOUDNESS - m.single, m.chord === null ? Infinity : CHORD_LOUDNESS - m.chord) / 20);

/** the loudness a sound lands at under the rule, in LUFS: LOUDNESS, or quieter where the chord or the peak cap binds */
export const ruled = (m: Loudness): number => m.single + 20 * Math.log10(gainFor(m));

export interface Case {
  /** "Init" (the patch as it is) or the preset's name */
  preset: string;
  patch: Patch;
  /** the engine played (the patch's own), or null for a patch with none */
  engine: AssemblyInst | null;
}

/** a factory patch's sounds: the patch as it is, then its engine at each factory preset but the one it is at */
export function cases(p: Patch): Case[] {
  const engines = (p.assemblies ?? []).filter((a) => instIsEngine(p, a));
  const out: Case[] = [{ preset: engines[0]?.preset ?? 'Init', patch: p, engine: engines[0] ?? null }];
  engines.forEach((a0, ei) => {
    for (const preset of presetsOf(p, a0)) {
      const now = currentValues(p, a0);
      if (now.length === preset.values.length && now.every((v, i) => Math.abs(v - preset.values[i]) < 1e-6)) continue;
      const q = structuredClone(p);
      const a = (q.assemblies ?? []).filter((x) => instIsEngine(q, x))[ei];
      if (applyPreset(q, a, preset)) out.push({ preset: preset.name, patch: q, engine: a });
    }
  });
  return out;
}

/** the factory sounds that land under their rule because their level rows run out of range (a row at its top with the
 * Output at 1), as "patch / preset": how many dB short they land, measured (the owner, 2026-11-04: they stay under) */
export const SHORT: Record<string, number> = {
  'Briefcase 3 / Resonant Ping': 14.1,
  'Briefcase 3 / Sea Noise': 10.9,
  'Briefcase 3 / Space Drone': 6.0,
  'Drift Poly / Drift Bass': 5.6,
  'Vernon 100 / Metal Clang': 9.5,
};

/** the factory sounds of these patches that land off their rule by more than LOUDNESS_TOLERANCE (a SHORT one: off its
 * listed shortfall by more), as "patch / preset: n dB" (the gain it would need) */
export function offRule(patches: [string, () => Patch][]): string[] {
  const off: string[] = [];
  for (const [name, make] of patches)
    for (const c of cases(make())) {
      const db = 20 * Math.log10(gainFor(measure(c.patch)));
      const id = `${name} / ${c.preset}`;
      if (Math.abs(db - (SHORT[id] ?? 0)) > LOUDNESS_TOLERANCE) off.push(`${id}: ${db >= 0 ? '+' : ''}${db.toFixed(1)} dB`);
    }
  return off;
}
