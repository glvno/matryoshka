// SPDX-License-Identifier: GPL-3.0-only
import { emptyPatch, type Patch } from './patch';
import { PRESETS } from './presets';

/** the factory patch a first run opens (#126) */
export const STARTER = 'Vernon 100';

/**
 * The first-run patch: the factory Vernon 100 (presets/14-vernon-100.json), the duophonic EML ElectroComp 100 after its
 * voices were mixed at a fixed level (#125). A fresh copy; an empty patch if the factory set ever lacks it.
 */
export function starterPatch(): Patch {
  return PRESETS[STARTER]?.() ?? emptyPatch('Init');
}
