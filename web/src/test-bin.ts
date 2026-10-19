// SPDX-License-Identifier: GPL-3.0-only
// Test helper: a patch's binary without its device pages section, which is the only part of the binary an assembly's
// layout reaches (pages.ts): what the engine plays is the rest.
import { deviceBytes, encodePatch, FLAG_DEVICES, rangeList } from './patchbin';
import { deviceView } from './poly';
import type { Patch } from './patch';

export function engineBytes(p: Patch): number[] {
  const b = Array.from(encodePatch(p));
  const n = rangeList(deviceView(p, true).patch).length;
  const end = b.length - (n ? 1 + 5 * n : 0); // the macro ranges are last, the device pages right before them
  b.splice(end - deviceBytes(p), deviceBytes(p));
  b[6] &= ~FLAG_DEVICES;
  return b;
}
