// SPDX-License-Identifier: GPL-3.0-only
import { expect, it } from 'vitest';
import '../src/factory-presets';
import { buildSelectedFactoryBank } from '../src/factory-bank';
import { applyPreset, presetsOf } from '../src/device-presets';
import { renderAudition } from './audition-render';
import { HEADROOM, peakOfPlay, plays, type Play } from '../src/headroom';
import { DEVICE_SR } from '../src/modules';

it.each([
  ['Expander S', 'Highpass Pluck', 'standard'],
  ['Monolith D', 'Pocket Pulse', 'performance'],
  ['Sallen 20', 'Acid Scream', 'performance'],
  ['Wanderer', 'Keyed Color', 'performance'],
] as const)('%s / %s retains transient headroom in the selected voice configuration', (instrument, name, gesture) => {
  const p = buildSelectedFactoryBank().find(entry => entry.name === instrument)!.patch;
  const a = p.assemblies!.find(a => presetsOf(p, a).some(preset => preset.name === name))!;
  const preset = presetsOf(p, a).find(preset => preset.name === name)!;
  expect(applyPreset(p, a, preset)).toBe(true);
  const channels = renderAudition(p, 'melodic', gesture);
  let peak = 0, finite = true;
  for (const channel of channels) for (const sample of channel) {
    finite &&= Number.isFinite(sample);
    peak = Math.max(peak, Math.abs(sample));
  }
  expect(finite).toBe(true);
  expect(peak).toBeGreaterThan(0.01);
  expect(peak).toBeLessThanOrEqual(0.88);
});

it.each([DEVICE_SR, 48000])('keeps held Hera Bass and the untrimmed 909 Kit within headroom at %s Hz', sr => {
  for (const instrument of ['Hera 3', '909 Kit']) {
    const p = buildSelectedFactoryBank().find(entry => entry.name === instrument)!.patch;
    let variants: Play[];
    if (instrument === 'Hera 3') {
      const a = p.assemblies!.find(a => presetsOf(p, a).some(preset => preset.name === 'Bass'))!;
      expect(applyPreset(p, a, presetsOf(p, a).find(preset => preset.name === 'Bass')!)).toBe(true);
      variants = [{ label: 'held three-note Bass', patch: p, notes: [60, 64, 67], run: false }];
    } else variants = plays(p);
    let peak = 0;
    for (const play of variants) {
      const diagnostic = structuredClone(play.patch);
      diagnostic.modules.find(module => module.type === 'output')!.params.level /= 16;
      peak = Math.max(peak, peakOfPlay({ ...play, patch: diagnostic }, 3, sr) * 16);
    }
    expect(peak, instrument).toBeGreaterThan(0.01);
    expect(peak, instrument).toBeLessThanOrEqual(HEADROOM);
  }
});
