// SPDX-License-Identifier: GPL-3.0-only
// Test helper: Oracle V with a morph B side, made as the editor makes one (patch.ts setMorphTarget: every module but Main
// gets a B side, the B patch's values), where only its filter and its two envelopes differ (D-1004): the golden kit
// `oracle-morph` and the format 51 byte counts use it.
import { DEFS } from './modules';
import { setMorphTarget, type Patch } from './patch';
import { FM1_PRESETS } from './presets';

/** the B values that differ from Oracle V's own: the ladder filter's cutoff, resonance and envelope amount, the filter
 * envelope's attack, decay and sustain, the amp envelope's attack and release */
export const ORACLE_B: [type: string, nth: number, values: Record<string, number>][] = [
  ['ladder', 0, { cutoff: 2400, res: 0.5, cvamt: 2 }],
  ['adsr', 0, { a: 0.3, d: 1.2, s: 0.6 }],
  ['adsr', 1, { a: 0.2, r: 1.5 }],
];

export function oracleMorph(): Patch {
  const p = FM1_PRESETS['Oracle V'](), b = FM1_PRESETS['Oracle V']();
  for (const [type, nth, values] of ORACLE_B) Object.assign(b.modules.filter((m) => m.type === type)[nth].params, values);
  setMorphTarget(p, b, DEFS);
  p.modules.find((m) => m.type === 'fm1')!.params.morph = 0.5;
  return p;
}
