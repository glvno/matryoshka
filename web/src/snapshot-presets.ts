// SPDX-License-Identifier: GPL-3.0-only
// Presets from snapshots (#1031): a snapshot's values for an engine, stored as a preset of the current patch's engine. The
// preset is captured from the snapshot's patch as Store preset captures one (capturePreset): its card values and, for an
// instrument with an FX drawer, the drawer's effects (FXD1). A preset holds one structure's values (device-presets.ts), so
// a snapshot whose engine or drawer chain has another structure than the current patch's has no values that preset could hold.
import { assembliesOf, assemblyById, parentOf, type AssemblyInst } from './assembly';
import { capturePreset, presetsOf, type Preset } from './device-presets';
import type { Patch } from './patch';

/** the assemblies of the current patch a snapshot can store presets of: the top-level ones with presets (those with a
 *  preset chip) */
export const presetEngines = (cur: Patch): AssemblyInst[] => assembliesOf(cur).filter((a) => !parentOf(cur, a.id) && presetsOf(cur, a).length > 0);

/** the snapshot `snap`'s values for the engine `a` of the current patch `cur` (its FX drawer's with them, capturePreset),
 *  as a preset named `name`; null when the snapshot has no such assembly, or its structure (its drawer's chain too)
 *  differs from the current patch's */
export function snapshotPreset(cur: Patch, a: AssemblyInst, snap: Patch, name: string): Preset | null {
  const there = assemblyById(snap, a.id);
  if (!there) return null;
  const preset = capturePreset(snap, there, name);
  return preset.structure === capturePreset(cur, a, name).structure ? preset : null;
}
