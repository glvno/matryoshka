// SPDX-License-Identifier: GPL-3.0-only
// What a cable is drawn as: the role of the input it lands on, not the kind of the output it leaves (any output patches
// anywhere, and audio into a phase modulation input modulates). A signal input (in, in1, l ...) carries the sound: the
// accent, bold. A control input, a parameter's pin or thumb, and the modulation inputs pm / side modulate: the secondary
// colour. A gate, trigger or clock input: a hollow rail in the gate colour. Keys: a three-wire ribbon. Hand-wired cables
// are never dashed: dashes are for links the app draws (style.css, #156).
import type { ModuleDef } from './patch';

export type CableRole = 'signal' | 'mod' | 'gate' | 'keys';

/** audio inputs that take a modulator, not the sound */
const MOD_INPUTS = new Set(['pm', 'side']);

export function cableRole(def: ModuleDef | undefined, input: string): CableRole {
  const kind = def?.inputs.find((p) => p.name === input)?.kind ?? 'control';
  if (kind === 'keys') return 'keys';
  if (kind === 'gate') return 'gate';
  if (kind === 'audio' && !MOD_INPUTS.has(input)) return 'signal';
  return 'mod';
}
