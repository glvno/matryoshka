// SPDX-License-Identifier: GPL-3.0-only
// The patches the factory measurements play (levels-*.test.ts, headroom-*.test.ts, #1179): every preset as it opens, but
// the factory patches with a demo set with it loaded (demo-sets.ts), so their patterns are measured as the owner hears
// them after SEQ+SEL (the shipped patches have no notes, and a measurement of them would measure keys or silence).
import { DEMO_SET_PATCHES } from './demo-sets';
import type { Patch } from './patch';
import { factoryWithDemoSet, PRESETS } from './presets';

export const MEASURED_PRESETS: [string, () => Patch][] = Object.entries(PRESETS)
  .map(([name, make]): [string, () => Patch] => (DEMO_SET_PATCHES.includes(name) ? [name, () => factoryWithDemoSet(name)] : [name, make]));
