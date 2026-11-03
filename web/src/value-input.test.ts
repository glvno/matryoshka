// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { parseValue, stepToward, wholeSteps } from './value-input';
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

  it('clamps to the range; only a row of whole steps snaps to them', () => {
    const cutoff = p('filter', 'cutoff');
    expect(parseValue('99k', cutoff)).toBe(cutoff.max);
    expect(parseValue('-5', cutoff)).toBe(cutoff.min);
    const unison = p('osc', 'unison');
    expect(parseValue('3.4', unison)).toBe(3);
    expect(parseValue('-1/3', p('osc', 'coarse'))).toBe(0);
  });

  it('keeps a typed value exactly, off the row\'s steps (#538)', () => {
    const res = p('filter', 'res');
    expect(res.step).toBe(0.01);
    expect(parseValue('0.125', res)).toBe(0.125);
    expect(parseValue('0.12345', res)).toBe(0.12345);
    expect(parseValue('440.5', p('filter', 'cutoff'))).toBe(440.5);   // a logarithmic row too
    expect(parseValue('12.5%', res)).toBe(0.125);
  });

  it('reads fractions (#538)', () => {
    const res = p('filter', 'res');
    expect(parseValue('1/8', res)).toBe(0.125);
    expect(parseValue(' 7 / 12 ', res)).toBeCloseTo(7 / 12, 11);
    expect(parseValue('1/3', res)).toBeCloseTo(1 / 3, 11);
    const signed = p('scale', 'offset');
    expect(parseValue('-1/3', signed)).toBeCloseTo(-1 / 3, 11);
    expect(parseValue('+1/4', signed)).toBe(0.25);
    expect(parseValue('1/2k', p('filter', 'cutoff'))).toBe(500);
    expect(parseValue('1/4 s', p('adsr', 'a'))).toBe(0.25);
    expect(parseValue('.5/2', res)).toBe(0.25);
  });

  it('refuses a fraction it cannot read', () => {
    const res = p('filter', 'res');
    expect(parseValue('1/0', res)).toBeNull();
    expect(parseValue('1/', res)).toBeNull();
    expect(parseValue('/8', res)).toBeNull();
    expect(parseValue('1/-8', res)).toBeNull();
    expect(parseValue('1/2/3', res)).toBeNull();
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

describe('wholeSteps', () => {
  it('is a switch, a choice or a linear row of whole steps', () => {
    expect(wholeSteps(p('osc', 'unison'))).toBe(true);
    expect(wholeSteps(p('osc', 'coarse'))).toBe(true);
    expect(wholeSteps(p('osc', 'wave'))).toBe(true);
    expect(wholeSteps(p('filter', 'res'))).toBe(false);
    expect(wholeSteps(p('filter', 'cutoff'))).toBe(false);   // logarithmic, Hz steps: keeps 440.5
  });
});

describe('stepToward (#538: steps move a value, they do not rewrite it)', () => {
  const res = p('filter', 'res');
  it('moves by whole steps from a value off the grid', () => {
    expect(stepToward(res, 0.125, 0.2)).toBe(0.205);
    expect(stepToward(res, 0.125, 0.13)).toBe(0.135);   // half a step and more: one step
    expect(stepToward(res, 0.125, 0.128)).toBe(0.125);  // under half a step: stays
    expect(stepToward(res, 1 / 3, 0.5)).toBeCloseTo(1 / 3 + 0.17, 11);
  });
  it('moves a tenth of a step when fine (Shift)', () => {
    expect(stepToward(res, 0.125, 0.126, { fine: true })).toBe(0.126);
    expect(stepToward(res, 0.125, 0.1254, { fine: true })).toBe(0.125);
    expect(stepToward(res, 0.125, 0.1255, { fine: true, atLeastOne: true })).toBe(0.126);
    expect(stepToward(res, 0.125, 0.125 + 0.001, { fine: true, atLeastOne: true })).toBe(0.126);
    expect(stepToward(res, 0.125, 0.125 - 0.001, { fine: true, atLeastOne: true })).toBe(0.124);
  });
  it('a key or a notch moves at least one step', () => {
    expect(stepToward(res, 0.125, 0.126)).toBe(0.125);
    expect(stepToward(res, 0.125, 0.126, { atLeastOne: true })).toBe(0.135);
    expect(stepToward(res, 0.125, 0.124, { atLeastOne: true })).toBe(0.115);
  });
  it('reaches the ends exactly and stays in the range', () => {
    expect(stepToward(res, 0.125, 1)).toBe(1);
    expect(stepToward(res, 0.995, 2)).toBe(1);
    expect(stepToward(res, 0.125, 0)).toBe(0);
    expect(stepToward(res, 0.005, -1)).toBe(0);
    expect(stepToward(res, 0.995, 0.9999, { atLeastOne: true })).toBe(1);   // (a step past the top is the top)
  });
  it('a row of whole steps lands on its steps', () => {
    const unison = p('osc', 'unison');
    expect(stepToward(unison, 2, 3.4)).toBe(3);
    expect(stepToward(unison, 2, 2.2, { atLeastOne: true })).toBe(3);
    expect(stepToward(unison, 2, 2.2, { fine: true })).toBe(2);
  });
  it('a logarithmic row moves by its own steps (Hz) from where it is', () => {
    const cutoff = p('filter', 'cutoff');
    expect(stepToward(cutoff, 440.5, 452.2)).toBe(452.5);
    expect(stepToward(cutoff, 440.5, 440.6, { fine: true })).toBe(440.6);
  });
});
