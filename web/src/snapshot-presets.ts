// SPDX-License-Identifier: GPL-3.0-only
// Presets from snapshots (#1031): a snapshot's values for an engine, stored as a preset of the current patch's engine. A
// preset is the card values of one structure (device-presets.ts), so a snapshot whose engine has another structure than
// the current patch's has no values that preset could hold.
import { assembliesOf, assemblyById, parentOf, type AssemblyInst } from './assembly';
import { capturePreset, presetsOf, type Preset } from './device-presets';
import type { Patch } from './patch';

/** the assemblies of the current patch a snapshot can store presets of: the top-level ones with presets (those with a
 *  preset chip) */
export const presetEngines = (cur: Patch): AssemblyInst[] => assembliesOf(cur).filter((a) => !parentOf(cur, a.id) && presetsOf(cur, a).length > 0);

/** the snapshot `snap`'s values for the engine `a` of the current patch `cur`, as a preset named `name`; null when the
 *  snapshot has no such assembly, or its structure (its FX scope too) differs from the current patch's */
export function snapshotPreset(cur: Patch, a: AssemblyInst, snap: Patch, name: string): Preset | null {
  const there = assemblyById(snap, a.id);
  if (!there) return null;
  const preset = capturePreset(snap, there, name);
  return preset.structure === capturePreset(cur, a, name).structure ? preset : null;
}
