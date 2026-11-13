// SPDX-License-Identifier: GPL-3.0-only
// Preserved former factory instruments. Community owns their catalogue entries; assembly presets can
// still be discovered synchronously by structure when opening old shares or saved patches.
import { DEFS } from './modules';
import { validatePatch, type Patch } from './patch';

const files = import.meta.glob<unknown>('../community/factory/*.json', { eager: true, import: 'default' });
export const relocatedPatches: Record<string, () => Patch> = Object.fromEntries(
  Object.values(files).map(raw => {
    const name = (raw as Patch).name;
    let checked: Patch | undefined;
    return [name, () => structuredClone(checked ??= validatePatch(structuredClone(raw), DEFS))];
  }),
);
