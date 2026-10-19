// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { parseValue } from './value-input';
import { DEFS } from './modules';
import type { ParamDef } from './patch';

const p = (type: string, name: string): ParamDef => DEFS[type].params.find((x) => x.name === name)!;

describe('parseValue', () => {
  it('reads plain numbers and the unit the bar shows', () => {
    expect(parseValue('440', p('filter', 'cutoff'))).toBe(440);
    expect(parseValue('440 Hz', p('filter', 'cutoff'))).toBe(440);
    expect(parseValue('2k', p('filter', 'cutoff'))).toBe(2000);
    expect(parseValue('2.5 kHz', p('filter', 'cutoff'))).toBe(2500);
    expect(parseValue('2,5khz', p('filter', 'cutoff'))).toBe(2500);
  });

  it('converts between seconds and milliseconds', () => {
    expect(parseValue('120ms', p('adsr', 'a'))).toBeCloseTo(0.12);
    expect(parseValue('0.5 s', p('adsr', 'a'))).toBe(0.5);
    expect(parseValue('0.25 s', p('delay', 'time'))).toBe(250);
  });

  it('takes percent for a parameter without a unit', () => {
    expect(parseValue('50%', p('filter', 'res'))).toBe(0.5);
  });

  it('clamps to the range and rounds to the steps', () => {
    const cutoff = p('filter', 'cutoff');
    expect(parseValue('99k', cutoff)).toBe(cutoff.max);
    expect(parseValue('-5', cutoff)).toBe(cutoff.min);
    const unison = p('osc', 'unison');
    expect(parseValue('3.4', unison)).toBe(3);
  });

  it('reads choices by name, start of a name or position, and switches by on / off', () => {
    const wave = p('osc', 'wave');
    const names = wave.choices!;
    expect(parseValue(names[2], wave, names)).toBe(2);
    expect(parseValue(names[1].slice(0, 2).toUpperCase(), wave, names)).toBe(1);
    expect(parseValue('1', wave, names)).toBe(0);
    expect(parseValue('nope', wave, names)).toBeNull();
    expect(parseValue('on', p('filter', 'track'))).toBe(1);
    expect(parseValue('off', p('filter', 'track'))).toBe(0);
  });

  it('refuses what it cannot read', () => {
    expect(parseValue('', p('filter', 'cutoff'))).toBeNull();
    expect(parseValue('abc', p('filter', 'cutoff'))).toBeNull();
    expect(parseValue('3 ms', p('filter', 'cutoff'))).toBeNull();
  });
});
