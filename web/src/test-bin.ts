// SPDX-License-Identifier: GPL-3.0-only
// Test helper: a patch's binary without its device pages section, which is the only part of the binary an assembly's
// layout reaches (pages.ts): what the engine plays is the rest.
import { buttonRecord, deviceBytes, drumMaps, encodePatch, FLAG_DEVICES, rangeList } from './patchbin';
import { DRUM_ROWS } from './modules';
import { TRACK_NAME_MAX } from './patch';
import { deviceView } from './poly';
import type { Patch } from './patch';

export function engineBytes(p: Patch): number[] {
  const b = Array.from(encodePatch(p));
  const dev = deviceView(p, true).patch;
  const n = rangeList(dev).length, maps = drumMaps(dev).length;
  // the macro ranges are last; before them the Drum maps' row names, the button kinds, then the device pages
  const end = b.length - (n ? 1 + 5 * n : 0) - (maps ? 1 + maps * (1 + DRUM_ROWS * TRACK_NAME_MAX) : 0) - buttonRecord(p, dev).length;
  b.splice(end - deviceBytes(p), deviceBytes(p));
  b[6] &= ~FLAG_DEVICES;
  return b;
}
