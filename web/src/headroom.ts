// SPDX-License-Identifier: GPL-3.0-only
// Headroom (#440): no factory patch clips, nor any factory preset of its engines. The ways a patch is played for that:
// its own values and each of its engines at each factory preset, with as many keys held as the engine has voices (at most
// 8: 60 64 67 71 72 76 79 83, the voices' count read after the preset), its Drum maps' keys all held (a kit, 8 Lire), and
// its transport running each pattern that has notes. gen-presets and gen-xl set every factory patch's Output so the
// loudest of these peaks at HEADROOM at most (scripts/factory-build.ts headroom); headroom.test.ts keeps it so.
import { applyPreset, currentValues, presetsOf } from './device-presets';
import { Engine } from './engine';
import { instIsEngine } from './engines';
import { allModules } from './assembly';
import { DEVICE_SR } from './modules';
import type { Patch } from './patch';

/** the most a factory patch's Output peaks, played every way `plays` lists (under 1 by a margin: the FM-1's fixed point
 * engine and other keys can run a little hotter) */
export const HEADROOM = 0.88;
/** the keys held, the first min(voices, 8) of them */
export const CHORD = [60, 64, 67, 71, 72, 76, 79, 83];

export interface Play {
  /** what is played: "patch" or the engine and preset, then how ("8 keys", "kit", "run") */
  label: string;
  patch: Patch;
  notes: number[];
  run: boolean;
  /** the pattern selected (0 = pattern 1) while it runs */
  pattern?: number;
}

const voicesIn = (p: Patch, ids: number[]): number => {
  const set = new Set(ids);
  return Math.max(1, ...p.modules.filter((m) => m.type === 'alloc' && set.has(m.id)).map((m) => Math.round(m.params.voices as number)));
};
/** the patterns that play something when the transport runs (0 = pattern 1; a Sequencer module runs in all of them) */
function patterns(p: Patch): number[] {
  const out = new Set<number>();
  for (const m of p.modules) {
    if (m.type === 'seq') out.add(0);
    if (m.type !== 'steps') continue;
    if (m.notes?.length) out.add(0);
    (m.patterns ?? []).forEach((q, i) => q?.notes.length && out.add(i + 1));
  }
  return [...out].sort((a, b) => a - b);
}

function ways(p: Patch, what: string, voices: number): Play[] {
  const n = Math.min(8, voices);
  const out: Play[] = [{ label: `${what}, ${n} keys`, patch: p, notes: CHORD.slice(0, n), run: false }];
  for (const dm of p.modules.filter((m) => m.type === 'drummap')) {
    const keys = [...new Set(Array.from({ length: 8 }, (_, r) => Math.round(dm.params[`n${r + 1}`] as number)))];
    out.push({ label: `${what}, its Drum map's keys`, patch: p, notes: keys, run: false });
  }
  for (const k of patterns(p)) out.push({ label: `${what}, running pattern ${k + 1}`, patch: p, notes: [], run: true, pattern: k });
  return out;
}

/** every way a factory patch is played for its headroom: as it is, then each engine at each of its factory presets (but
 * one it is at already) */
export function plays(p: Patch): Play[] {
  const out = ways(p, 'patch', voicesIn(p, p.modules.map((m) => m.id)));
  const engines = (p.assemblies ?? []).filter((a) => instIsEngine(p, a));
  engines.forEach((a0, ei) => {
    for (const preset of presetsOf(p, a0)) {
      const now = currentValues(p, a0);
      if (now.length === preset.values.length && now.every((v, i) => Math.abs(v - preset.values[i]) < 1e-6)) continue; // (the patch as it is)
      const q = structuredClone(p);
      const a = (q.assemblies ?? []).filter((x) => instIsEngine(q, x))[ei];
      if (!applyPreset(q, a, preset)) continue;
      out.push(...ways(q, `${a.name ?? 'engine'} ${preset.name}`, voicesIn(q, allModules(q, a))));
    }
  });
  return out;
}

/** a play's peak over `secs` (at the FM-1's rate), both channels, at the patch's Output level (the engine clamps at 1: lower the Output first
 * to see past it) */
export function peakOfPlay(w: Play, secs: number, sr = DEVICE_SR): number {
  const e = new Engine(sr);
  e.load(w.patch);
  if (w.pattern) e.setPattern(w.pattern);
  e.transport(w.run);
  for (const k of w.notes) e.noteOn(k, 1);
  const l = new Float32Array(Math.round(sr * secs));
  const r = new Float32Array(l.length);
  e.render(l, r);
  let peak = 0;
  for (let i = 0; i < l.length; i++) peak = Math.max(peak, Math.abs(l[i]), Math.abs(r[i]));
  return peak;
}

/** the ways of playing these patches that peak at `limit` or more over `secs`, as "name: how peaks x" */
export function overHeadroom(patches: [string, () => Patch][], secs: number, limit: number): string[] {
  const over: string[] = [];
  for (const [name, make] of patches)
    for (const w of plays(make())) {
      const peak = peakOfPlay(w, secs);
      if (peak >= limit) over.push(`${name}: ${w.label} peaks ${peak.toFixed(3)}`);
    }
  return over;
}
