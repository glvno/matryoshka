// SPDX-License-Identifier: GPL-3.0-only
// Save preset's engines (D-1426): the candidate heard is stored as a preset of one of its engines, an instrument with its FX
// drawer (D-1403) as Store preset captures one; the Output drawer belongs to the patch and is never one.
import { assembliesOf, parentOf, type AssemblyInst } from './assembly';
import { presetsOf } from './device-presets';
import type { Patch } from './patch';

/** the assemblies of `p` Save preset offers: the top-level ones with presets (those with a preset chip), never a drawer (an
 *  instrument's FX drawer goes with its instrument; the Output drawer belongs to the patch) */
export const presetEngines = (p: Patch): AssemblyInst[] => assembliesOf(p).filter((a) => !a.drawer && !parentOf(p, a.id) && presetsOf(p, a).length > 0);
