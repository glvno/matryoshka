// SPDX-License-Identifier: GPL-3.0-only
// Which factory patches the firmware carries (#915, D-179 amended 2026-11-15). The firmware tier is compiled into every
// Matryoshka firmware and always plays: the patches unlikely to change (full parity and the full FX rack). Every other
// factory patch, all the factory engine presets and the drum patterns live in the factory region, which the editor and
// tools/fm1_install.py install and can update without a firmware release. Moving a patch between the tiers is a change to
// this list alone (web/scripts/export-defs.ts builds both images from it).

/** the factory patches compiled into the firmware, by bank name. Algo Four and Cassia 1 left it in 1.29: every factory
 *  region image since 1.20.2 carries them, so the firmware frees their bytes (D-1020) */
export const FIRMWARE_TIER: readonly string[] = [
  'Monolith D', 'Silver Box', 'Expander S', 'Io 4', 'Canvas', 'Shush 101', '808 Kit', '909 Kit', 'Verona Drum 1',
];

/** firmware-tier patches fixed since a released firmware shipped: the region carries a copy with a newer revision, which
 *  replaces the built-in one on an FM-1 with that region (factory.c fc_merge). The copy's revision is the image's content
 *  version, so on a firmware whose tier already has that content it is not higher and the built-in copy plays. A firmware
 *  release that compiles the fix into the tier empties the list (D-1020) */
export const FIRMWARE_TIER_OVERRIDES: readonly string[] = [];
