// SPDX-License-Identifier: GPL-3.0-only
// A candidate's Save… (owner 2026-11-24, D-1426): what Add to palette decides (preset-fit.ts presetFit) decides here too.
// A candidate that differs from the patch it is a version of only in values device presets carry is saved as device
// presets, reusing one with the same values; one the same as that patch saves nothing; anything else takes a new patch
// in Your patches, with the reason a preset could not hold it.
import { assemblyById } from './assembly';
import { addPresetOf, type Preset } from './device-presets';
import type { Patch } from './patch';
import { NO_SAME_STRUCTURE, presetFit } from './preset-fit';

/** what Save… did: presets saved (`made`: the new ones, for a linked FM-1), nothing (the same as its patch), or a patch is
 *  needed (`why`: one line) */
export type CandidateSave =
  | { kind: 'presets'; line: string; made: Preset[] }
  | { kind: 'same'; line: string }
  | { kind: 'patch'; why: string };

/** the tempo and pattern note of a result line: "tempo", "patterns", "tempo and patterns" changes are in no preset */
const playsNote = (plays: string): string => `${plays[0].toUpperCase()}${plays.slice(1)} changes aren't in a preset`;

/**
 * Save `sound` (candidate `name`: its name, else "<Patch> <letter>") against `base`, the patch it is a version of (its
 * set's patch as opened): each device whose values differ takes a preset of them (presetFit: one this browser has, one of
 * `onFm1`, else a new user preset named `name`), kept in this browser. `encode`: the binary the comparison uses.
 */
export function saveCandidate(sound: Patch, base: Patch, name: string, encode: (p: Patch) => Uint8Array, onFm1: readonly Preset[] = []): CandidateSave {
  const fit = presetFit(sound, base, name, encode, onFm1);
  const patch = base.name.trim() || 'Untitled';
  // (Add to palette's reason speaks of the FM-1's slots: here it is the patch the candidate is a version of)
  if ('why' in fit) return { kind: 'patch', why: fit.why === NO_SAME_STRUCTURE ? `its modules, cables or name differ from ${patch}` : fit.why };
  if (!fit.picks.length) {
    return { kind: 'same', line: fit.plays
      ? `${name} has the sound of ${patch}, nothing saved. ${playsNote(fit.plays)}`
      : `${name} is the same as ${patch}: nothing saved` };
  }
  const made: Preset[] = [];
  const said = fit.picks.map((pick) => {
    const a = assemblyById(sound, pick.asm)!;
    const on = a.label || a.name;
    if (pick.from === 'factory') return `${on} is factory preset ${pick.preset.name}`;
    if (pick.from === 'browser') return `${on} is preset ${pick.preset.name}, already saved`;
    const { put } = addPresetOf(sound, a, pick.preset);
    if (pick.from === 'fm1') return `${on} is preset ${put.name} of the FM-1, now kept in this browser too`;
    made.push(put);
    return `Saved preset ${put.name} on ${on}`;
  });
  return { kind: 'presets', line: `${said.join('; ')}${fit.plays ? `. ${playsNote(fit.plays)}` : ''}`, made };
}
