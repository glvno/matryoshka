// SPDX-License-Identifier: GPL-3.0-only
import { expect, it } from 'vitest';
import { around, plugIn, seedFactoryPatterns, wire } from '../scripts/factory-build';
import { factoryPresets } from './factory-presets';
import { factoryWithPatterns } from './presets';
import { cases, measure } from './levels';
import { addModule } from './patch';
import { DEFS } from './modules';
import { fixNotes, patternNotes } from './track';
import { applyPreset, presetsOf } from './device-presets';
factoryPresets();

// (the 909 Kit's card was shared with <7PH's until the 909 Kit became the whole TR-909, D-1055: <7PH keeps its lean card,
// which ships no presets)
it('the 909 Kit and each of its card\'s presets land on the loudness rule', () => {
  // (with its 1.24.1 patterns: pattern 1 plays, and each preset swaps it for its own)
  const standalone = seedFactoryPatterns(factoryWithPatterns('909 Kit'));
  for (const c of cases(standalone)) {
    const m = measure(c.patch);
    expect(m.chord).toBeNull();
    expect(m.single, c.preset).toBeLessThanOrEqual(-16.5);
    expect(m.single >= -19.5 || m.peak >= 0.88 * 10 ** (-1.5 / 20), c.preset).toBe(true);
    expect(m.peak, c.preset).toBeLessThanOrEqual(0.88);
  }
}, 1_200_000);

it('calibrates Tight Techno with its authored 11 hits instead of Init\'s 19', () => {
  const x = around('drum kit', 'drum kit');
  x.p.cables = x.p.cables.filter((c) => c.from.module !== x.main.id);
  const track = addModule(x.p, DEFS.steps, 20, 300);
  wire(x.p, x.main.id, 'keys', track.id, 'keys');
  plugIn(x.p, track.id, 'keys', x.a, 'keys');
  const map = x.p.modules.find((m) => m.type === 'drummap')!;
  const rows = { 1: 'X...x...x.x.....', 2: '....X.......X..x', 3: '............X...', 4: 'x.X.x.X.x.X.x.X.', 6: '......x.......x.', 8: '..........x.....' };
  track.notes = fixNotes(Object.entries(rows).flatMap(([r, text]) => (patternNotes(text) ?? []).map((n) => ({ ...n, note: map.params[`n${r}`] }))));
  seedFactoryPatterns(x.p);
  expect(track.notes).toHaveLength(19);
  const preset = presetsOf(x.p, x.a).find((p) => p.name === 'Tight Techno')!;
  expect(applyPreset(x.p, x.a, preset)).toBe(true);
  expect(track.notes).toHaveLength(11);
});
