// SPDX-License-Identifier: GPL-3.0-only
// Cassia 1's wave rows (#430): named Selectors that reach all eight PD Osc waves, Init and every preset included.
import { describe, expect, it } from 'vitest';
import { applyPreset, presetsOf } from './device-presets';
import { Engine } from './engine';
import { instIsEngine } from './engines';
import './factory-presets';
import { PD_WAVES } from './modules';
import type { Patch } from './patch';
import { FM1_PRESETS } from './presets';

type Nodes = Map<number, { inst: { eff: Record<string, number> }[] }>;
const cassia = (): Patch => FM1_PRESETS['Cassia 1']();
const card = (p: Patch) => p.assemblies!.find((a) => instIsEngine(p, a) && a.params.some((r) => r.label === 'wave 2'))!;
/** the row's target module of the n-th row with this label */
const rowOf = (p: Patch, label: string, n = 0) => card(p).params.filter((r) => r.label === label)[n];
const set = (p: Patch, label: string, n: number, v: number): void => {
  const r = rowOf(p, label, n);
  p.modules.find((m) => m.id === r.module)!.params[r.param] = v;
};
/** the two lines' PD Osc waves as the engine plays them, after a block: [wave, wave2] per line (wave2 0 = off) */
function waves(p: Patch): [number, number][] {
  const e = new Engine(48000);
  e.load(p);
  e.noteOn(60);
  e.render(new Float32Array(256), new Float32Array(256));
  const nodes = (e as unknown as { nodes: Nodes }).nodes;
  const pd2 = rowOf(p, 'fine').module;
  const pds = p.modules.filter((m) => m.type === 'pd').map((m) => m.id);   // (Cassia 1's two, in its voice)
  const pd1 = pds.find((id) => id !== pd2)!;
  return [pd1, pd2].map((id) => {
    const eff = nodes.get(id)!.inst[0].eff;
    return [Math.round(eff.wave), Math.round(eff.wave2)];
  });
}

describe('Cassia 1 wave rows (#430)', () => {
  it('each position of wave plays that wave and of wave 2 off or that wave, on both lines; the rows carry the names', () => {
    for (let k = 1; k <= 8; k++) {
      const p = cassia();
      set(p, 'wave', 0, k);
      set(p, 'wave 2', 0, 9 - k);
      set(p, 'wave', 1, 9 - k);
      set(p, 'wave 2', 1, k);
      // wave2 as the PD Osc reads it: 0 off, k the k-th wave (position k + 1)
      expect(waves(p)).toEqual([[k - 1, 8 - k], [8 - k, k - 1]]);
    }
    for (const n of [0, 1]) {
      expect(rowOf(cassia(), 'wave', n).names).toEqual(PD_WAVES);
      expect(rowOf(cassia(), 'wave 2', n).names).toEqual(['off', ...PD_WAVES.slice(0, 7)]);
    }
  });

  it('line 3 (1+1\') hands line 1\'s waves to line 2; 4 (1+2\') keeps line 2\'s own', () => {
    const p = cassia();
    set(p, 'wave', 0, 2);
    set(p, 'wave 2', 0, 3);
    set(p, 'line', 0, 3);
    expect(waves(p)).toEqual([[1, 2], [1, 2]]);
    set(p, 'line', 0, 4);
    expect(waves(p)).toEqual([[1, 2], [5, 0]]);
  });

  it('Init plays line 2 on reso 1 as made, Reso Pad on a resonance wave; the other presets keep their waves', () => {
    const want: Record<string, [string, string, string, string]> = {
      Init: ['saw', 'off', 'reso 1', 'off'],
      'PD Bass': ['saw', 'square', 'reso 1', 'off'],
      'PD Brass': ['saw', 'off', 'saw', 'off'],   // line 3: line 2 plays line 1's
      'Glass Bell': ['dbl sine', 'off', 'square', 'off'],
      'Reso Pad': ['saw-pulse', 'off', 'reso 1', 'off'],
      'Tine Piano': ['square', 'off', 'dbl sine', 'off'],
    };
    const base = cassia();
    const list = presetsOf(base, card(base));
    expect(list.map((x) => x.name)).toEqual(Object.keys(want));
    for (const pr of list) {
      const p = cassia();
      expect(applyPreset(p, card(p), pr)).toBe(true);
      const [w1, w2] = waves(p);
      const ix = want[pr.name].map((w) => PD_WAVES.indexOf(w));   // (off: -1, so wave2 0)
      expect([w1, w2], pr.name).toEqual([[ix[0], ix[1] + 1], [ix[2], ix[3] + 1]]);
    }
  });
});
