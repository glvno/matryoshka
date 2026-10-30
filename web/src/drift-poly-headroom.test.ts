// SPDX-License-Identifier: GPL-3.0-only
import { expect, it } from 'vitest';
import { applyPreset, presetsOf } from './device-presets';
import { Engine } from './engine';
import { instIsEngine } from './engines';
import './factory-presets';
import { FM1_PRESETS } from './presets';

const SR = 48000;
const CHORD = [60, 64, 67, 71, 72, 76, 79, 83];

// #413: drift poly's chords broke up on the FM-1 because they clipped (Slow Pad at five notes, Analog Strings at four).
// Its mixer levels leave headroom, so every factory preset holds eight notes at eight voices (the FM-1's most) unclipped.
it('every drift poly factory preset holds an eight-note chord at eight voices without clipping', () => {
  const make = FM1_PRESETS['Drift Poly'];
  const base = make();
  const engine = (p: typeof base) => (p.assemblies ?? []).find((a) => instIsEngine(p, a) && a.name === 'drift poly')!;
  const presets = presetsOf(base, engine(base));
  expect(presets.length).toBeGreaterThanOrEqual(2);
  for (const preset of presets) {
    const p = make();
    const a = engine(p);
    expect(applyPreset(p, a, preset)).toBe(true);
    p.modules.find((m) => a.modules.includes(m.id) && m.type === 'alloc')!.params.voices = 8;
    const e = new Engine(SR);
    e.load(p);
    for (const k of CHORD) e.noteOn(k);
    const l = new Float32Array(SR * 3), r = new Float32Array(SR * 3);
    e.render(l, r);
    let peak = 0;
    for (let i = 0; i < l.length; i++) peak = Math.max(peak, Math.abs(l[i]), Math.abs(r[i]));
    expect(peak, preset.name).toBeLessThan(0.9);
  }
});
