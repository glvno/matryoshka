// SPDX-License-Identifier: GPL-3.0-only
import { emptyPatch, type Patch } from './patch';
import { PRESETS } from './presets';

/** the factory patch a first run opens (#126) */
export const STARTER = 'Monolith D';

/**
 * The first-run patch: the factory Monolith D (presets/00-monolith-d.json), the FM-1's first factory patch too (D-1203).
 * A fresh copy; an empty patch if the factory set ever lacks it.
 */
export function starterPatch(): Patch {
  return PRESETS[STARTER]?.() ?? emptyPatch('Init');
}
