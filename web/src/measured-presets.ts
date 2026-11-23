// SPDX-License-Identifier: GPL-3.0-only
// The patches the factory measurements play (levels-*.test.ts, headroom-*.test.ts): every preset as it opens, but the
// factory patches of factory-bank.ts UNSHIPPED_PATTERNS with the patterns they shipped with up to 1.24.1, so their
// patterns are measured as the owner heard them (the shipped patches have no notes, and a measurement of them would
// measure keys or silence).
import { UNSHIPPED_PATTERNS } from './factory-bank';
import type { Patch } from './patch';
import { factoryWithPatterns, PRESETS } from './presets';

export const MEASURED_PRESETS: [string, () => Patch][] = Object.entries(PRESETS)
  .map(([name, make]): [string, () => Patch] => (UNSHIPPED_PATTERNS.includes(name) ? [name, () => factoryWithPatterns(name)] : [name, make]));
