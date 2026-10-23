// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { firmwareKind, runsFelucca } from './felucca-store';

describe('installing over Felucca (#73)', () => {
  it('recognises a running Felucca build, not loaders, stock or Matryoshka dev builds', () => {
    expect(runsFelucca('FM-1_900')).toBe(true);
    expect(runsFelucca('FM-1_916')).toBe(true);
    expect(runsFelucca('ota-FM-1_900')).toBe(false);
    expect(runsFelucca('FM-1_015')).toBe(false);
    expect(runsFelucca('FM-1_800')).toBe(false);
    expect(runsFelucca('FM-1_700')).toBe(false);
    expect(runsFelucca('FM-1_711')).toBe(false);
    expect(runsFelucca('FM-1_8000013')).toBe(false);
  });
});

describe('the firmware an FM-1 runs (#161)', () => {
  it('tells stock, Matryoshka, Felucca and anything else apart', () => {
    expect(firmwareKind('FM-1_015')).toBe('stock');
    expect(firmwareKind('FM-1_700')).toBe('matryoshka');
    expect(firmwareKind('FM-1_710')).toBe('matryoshka');
    expect(firmwareKind('FM-1_800')).toBe('other'); // M-VAVE (#217)
    expect(firmwareKind('FM-1_901')).toBe('felucca');
    expect(firmwareKind('FM-1_8123456')).toBe('other'); // M-VAVE Open
    expect(firmwareKind('FM1C_0123456789abcdef')).toBe('other');
    expect(firmwareKind('ota-FM-1_700')).toBe('other'); // a loader is not asked about
  });
});
