// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { cableRole } from './cable-role';
import { DEFS } from './modules';

describe('cable roles', () => {
  it('colour a cable by the input it lands on: audio into pm modulates, into in carries the sound', () => {
    expect(cableRole(DEFS.filter, 'in')).toBe('signal');
    expect(cableRole(DEFS.osc, 'pm')).toBe('mod');
    expect(cableRole(DEFS.filter, 'cv')).toBe('mod');
    expect(cableRole(DEFS.filter, 'p1')).toBe('mod');
    expect(cableRole(DEFS.adsr, 'gate')).toBe('gate');
    expect(cableRole(DEFS.alloc, 'keys')).toBe('keys');
    expect(cableRole(DEFS.output, 'l')).toBe('signal');
  });
});
