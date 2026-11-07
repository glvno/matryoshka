// SPDX-License-Identifier: GPL-3.0-only
// Connect FM-1 among several FM-1s (#698): the list's lines and which one is offered or taken without asking.
import { describe, expect, it } from 'vitest';
import { firmwareText, fm1Text, offeredFm1, playNote, rememberedFm1 } from './choose-fm1';
import type { Info } from './protocol';

const info = (firmware?: Info['firmware']): Info => ({ version: 1, maxModules: 64, maxCables: 255, flashOk: true, patchLoaded: true, delays: 1, features: 0, midiOut: null, firmware });
const fm1 = (id: string, rig = false, firmware: Info['firmware'] = { major: 1, minor: 10, patch: 0 }) => ({ inp: { id, name: 'Matryoshka' }, info: info(firmware), rig });

describe('choose-fm1', () => {
  it('names each FM-1 by its firmware and port, and the test rig as such', () => {
    expect(fm1Text(fm1('a'), 0)).toBe('1  Matryoshka 1.10.0 · port Matryoshka');
    expect(fm1Text(fm1('b', true, { major: 0, minor: 0, patch: 0 }), 1)).toBe('2  Matryoshka, a dev build · port Matryoshka · test rig');
    expect(firmwareText(info())).toBe('Matryoshka before 1.8');
  });
  it('takes the remembered FM-1 when it answered, else none', () => {
    const found = [fm1('a'), fm1('b')];
    expect(rememberedFm1(found, 'b')).toBe(found[1]);
    expect(rememberedFm1(found, 'gone')).toBeNull();
    expect(rememberedFm1(found, null)).toBeNull();
  });
  it('offers the remembered one, else the first that is not the test rig', () => {
    const found = [fm1('rig', true), fm1('mine')];
    expect(offeredFm1(found, null)).toBe(1);
    expect(offeredFm1(found, 'rig')).toBe(0);
    expect(offeredFm1([fm1('x', true)], null)).toBe(0);
  });
  it('plays its note now and releases it by the page\'s timer, with no Web MIDI timestamp on either (#698)', () => {
    const sent: unknown[][] = [];
    const timers: [() => void, number][] = [];
    playNote({ send: (...a: unknown[]) => void sent.push(a) } as never, (f, ms) => timers.push([f, ms]));
    expect(sent).toEqual([[[0x90, 60, 100]]]);
    expect(timers.map(([, ms]) => ms)).toEqual([400]);
    timers[0][0]();
    expect(sent).toEqual([[[0x90, 60, 100]], [[0x80, 60, 0]]]);
  });
});
