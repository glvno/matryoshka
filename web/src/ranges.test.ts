// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { DEFS } from './modules';
import { defaultParams } from './patch';
import { OUTPUT_RANGES, outputRange } from './ranges';

describe('output ranges (#518)', () => {
  it('every output of every module type says its range', () => {
    const missing: string[] = [];
    for (const def of Object.values(DEFS))
      for (const o of def.outputs) {
        if (OUTPUT_RANGES[def.type]?.[o.name] === undefined) missing.push(`${def.type}.${o.name}`);
        else expect(outputRange(def.type, o.name, defaultParams(def)).length, `${def.type}.${o.name}`).toBeGreaterThan(3);
      }
    expect(missing).toEqual([]);
  });

  it('names no output a module does not have', () => {
    const extra: string[] = [];
    for (const [type, outs] of Object.entries(OUTPUT_RANGES))
      for (const port of Object.keys(outs)) if (!DEFS[type]?.outputs.some((o) => o.name === port)) extra.push(`${type}.${port}`);
    expect(extra).toEqual([]);
  });

  it('says the fixed ranges in plain numbers', () => {
    expect(outputRange('lfo', 'out', { depth: 1 })).toMatch(/^−1\.\.1/);
    expect(outputRange('adsr', 'env')).toBe('0..1');
    expect(outputRange('fm1', 'pitch')).toMatch(/1 per octave, 0 = middle C/);
    expect(outputRange('osc', 'out', { level: 1 })).toMatch(/^audio −1\.\.1/);
    expect(outputRange('fm1', 'gate')).toMatch(/^0 or 1/);
  });

  it('works out the ranges that follow the parameters from their values now', () => {
    expect(outputRange('lfo', 'out', { depth: 0.5 })).toMatch(/^−0\.5\.\.0\.5/);
    expect(outputRange('const', 'out', { value: -2 })).toMatch(/^−2, constant/);
    expect(outputRange('scale', 'out', { gain: 2, offset: 1 })).toContain('−1..3');
    expect(outputRange('math', 'add', { ka: 1, kb: 1, off: 0 })).toMatch(/^−2\.\.2/);
    expect(outputRange('math', 'mul', { ka: 2, kb: 1, off: 1 })).toMatch(/^−3\.\.3/);
    expect(outputRange('math', 'abs', { ka: 1, kb: 1, off: 2 })).toMatch(/^1\.\.3/);
    expect(outputRange('mixer', 'out', { l1: 1, l2: 1, l3: 0.5, l4: 0 })).toContain('−2.5..2.5');
    expect(outputRange('ratio', 'pitch', { ratio: 8, detune: 3 })).toMatch(/: 1 now, ×2\.00/);
  });

  it('is empty for an unknown output', () => {
    expect(outputRange('osc', 'nope')).toBe('');
    expect(outputRange('nope', 'out')).toBe('');
  });
});
