// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { runsFelucca } from './felucca-store';

describe('installing over Felucca (#73)', () => {
  it('recognises a running Felucca build, not loaders, stock or Matryoshka dev builds', () => {
    expect(runsFelucca('FM-1_900')).toBe(true);
    expect(runsFelucca('FM-1_916')).toBe(true);
    expect(runsFelucca('ota-FM-1_900')).toBe(false);
    expect(runsFelucca('FM-1_015')).toBe(false);
    expect(runsFelucca('FM-1_800')).toBe(false);
    expect(runsFelucca('FM-1_8000013')).toBe(false);
  });
});
