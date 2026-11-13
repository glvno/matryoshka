// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { buildFactoryBank, buildSelectedFactoryBank } from './factory-bank';
import { DEVICE, encodePatch, layout } from './patchbin';


describe('Canvas factory slot fitting', () => {
  it('fits the actual Harmony/Steps/Arp candidate without new FX in an existing FM-1 slot', () => {
    const p = buildFactoryBank({ Canvas: { omit: ['drive', 'chorus', 'delay', 'reverb'] } }).find(entry => entry.name === 'Canvas')!.patch;
    expect(encodePatch(p, true).length).toBeLessThanOrEqual(DEVICE.bytes);
    expect(layout(p).need).toBeLessThanOrEqual(DEVICE.bytes);
  });

  it('fits the selected native Drive/Reverb plus added Delay candidate without a byte-blocked patch format', () => {
    const p = buildSelectedFactoryBank().find(entry => entry.name === 'Canvas')!.patch;
    const binary = encodePatch(p, true, false, 1);
    expect(binary.length).toBeLessThanOrEqual(DEVICE.bytes);
    expect(layout(p).need).toBeLessThanOrEqual(DEVICE.bytes);
  });
});
