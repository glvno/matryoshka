// SPDX-License-Identifier: GPL-3.0-only
import { expect, it } from 'vitest';
import { applyLevels, around, loudness, plugIn, seedFactoryPatterns, sharedPresetLevels, wire } from '../scripts/factory-build';
import { factoryPresets } from './factory-presets';
import { FM1_PRESETS, PRESETS } from './presets';
import { cases, measure, LOUDNESS_TOLERANCE } from './levels';
import { addModule } from './patch';
import { DEFS } from './modules';
import { fixNotes, patternNotes } from './track';
import { applyPreset, presetsOf } from './device-presets';
factoryPresets();

it('calibrates one shared 909 card for standalone and hybrid playback', () => {
  const standalone = seedFactoryPatterns(FM1_PRESETS['909 Kit']());
  const hybrid = seedFactoryPatterns(PRESETS['<7PH']());
  const notes = structuredClone(hybrid.modules.filter((m) => m.type === 'steps'));
  const settled = structuredClone(factoryPresets());
  const output = hybrid.modules.find((m) => m.type === 'output')!.params.level;
  const plan = loudness(standalone, { output: 1, hold: LOUDNESS_TOLERANCE });
  applyLevels(plan);
  sharedPresetLevels(hybrid, plan, standalone);
  for (const p of [standalone, hybrid]) for (const c of cases(p)) {
    const m = measure(c.patch);
    expect(m.chord).toBeNull();
    expect(m.single, `${p.name} / ${c.preset}`).toBeLessThanOrEqual(-16.5);
    expect(m.single >= -19.5 || m.peak >= 0.88 * 10 ** (-1.5 / 20), `${p.name} / ${c.preset}`).toBe(true);
    expect(m.peak, `${p.name} / ${c.preset}`).toBeLessThanOrEqual(0.88);
  }
  expect(hybrid.modules.filter((m) => m.type === 'steps')).toEqual(notes);
  expect(factoryPresets()).toEqual(settled);
  expect(hybrid.modules.find((m) => m.type === 'output')!.params.level).toBe(output);
}, 240_000);

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
