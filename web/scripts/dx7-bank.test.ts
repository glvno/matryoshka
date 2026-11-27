// SPDX-License-Identifier: GPL-3.0-only
// The editor's own DX7 content (#1338): the shipped bank is what dx7-bank.ts writes, every voice in it round-trips and
// plays (audible, not clipping, falling silent after the key), the loop voices use their loop, and the "DX7 Piano"
// example loads, plays, takes the mod wheel, is format 71, fits the FM-1 and is no FM-1 factory patch.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { dx7Pack, dx7Unpack } from '../src/dx7';
import { parseDx7Sysex, singleSysex } from '../src/dx7-sysex';
import { canonicalVoice, DX7_INIT_VOICE, voiceBytes, voiceHex, voiceName } from '../src/dx7-voice';
import { Engine } from '../src/engine';
import EXAMPLES from '../factory/examples.json';
import { DEFS } from '../src/modules';
import { addModule, connect, emptyPatch, validatePatch, type Patch } from '../src/patch';
import { deviceBudget, encodePatch, FORMAT_1_30 } from '../src/patchbin';
import { EXAMPLE_PRESETS, FM1_PRESETS } from '../src/presets';
import { DX7_BANK_PATH, DX7_EXAMPLE, DX7_VOICES, dx7BankFile, dx7Example, packVoice } from './dx7-bank';

const SR = 48000;
const shipped = new Uint8Array(readFileSync(new URL(`../${DX7_BANK_PATH}`, import.meta.url)));

/** `hold` seconds of the left channel with keys held, then `tail` seconds after they let go (`before`: on the engine
 *  once loaded, before the keys) */
function play(p: Patch, keys: number[], vel: number, hold: number, tail: number, before?: (e: Engine) => void): { held: Float32Array; after: Float32Array } {
  const e = new Engine(SR);
  e.load(p);
  before?.(e);
  keys.forEach((k) => e.noteOn(k, vel));
  const held = new Float32Array(Math.round(hold * SR)), after = new Float32Array(Math.round(tail * SR));
  e.render(held, new Float32Array(held.length));
  keys.forEach((k) => e.noteOff(k));
  e.render(after, new Float32Array(after.length));
  return { held, after };
}
/** a DX7 played by Main's keys straight into an Output at level 1 */
function solo(voice: Uint8Array): Patch {
  const p = emptyPatch('dx7');
  const kb = addModule(p, DEFS.fm1, 0, 0), out = addModule(p, DEFS.output, 0, 0), dx = addModule(p, DEFS.dx7, 0, 0);
  out.params.level = 1;
  dx.voice = voiceHex(voice);
  for (const port of ['pitch', 'gate', 'vel']) connect(p, DEFS, { module: kb.id, port }, { module: dx.id, port });
  connect(p, DEFS, { module: dx.id, port: 'out' }, { module: out.id, port: 'l' });
  return p;
}
const peak = (x: Float32Array): number => x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
const rms = (x: Float32Array): number => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);
/** the loudest 100 ms */
const loudest = (x: Float32Array): number => {
  let m = 0;
  for (let i = 0; i + SR / 10 <= x.length; i += SR / 20) m = Math.max(m, rms(x.subarray(i, i + SR / 10)));
  return m;
};

describe('the DX7 bank (factory/dx7)', () => {
  const bank = parseDx7Sysex(shipped)!;

  it('is what scripts/dx7-bank.ts writes: our voices first, the init voice in the other slots', () => {
    expect([...shipped]).toEqual([...dx7BankFile()]);
    expect(bank.bank).toBe(true);
    expect(bank.checksumOk).toBe(true);
    expect(bank.voices.map(voiceName)).toEqual([...DX7_VOICES.map((v) => v.name), ...Array(32 - DX7_VOICES.length).fill('INIT VOICE')]);
    for (const v of bank.voices.slice(DX7_VOICES.length)) expect([...v]).toEqual([...DX7_INIT_VOICE]);
    expect(new Set(DX7_VOICES.map((v) => v.name)).size).toBe(DX7_VOICES.length);
  });

  it('holds a voice on algorithm 4 and one on algorithm 6, each with its loop\'s feedback up', () => {
    for (const alg of [4, 6]) expect(DX7_VOICES.some((v) => v.alg === alg && v.fb > 0), `algorithm ${alg}`).toBe(true);
  });

  for (const [i, v] of DX7_VOICES.entries()) {
    it(`${v.name}: round-trips as its packed voice and as a single voice dump`, () => {
      const b = bank.voices[i];
      expect([...b]).toEqual([...packVoice(v)]);
      expect([...canonicalVoice(b)]).toEqual([...b]);
      expect([...dx7Pack(dx7Unpack(b))]).toEqual([...b]);
      expect([...voiceBytes(voiceHex(b))]).toEqual([...b]);
      const single = parseDx7Sysex(singleSysex(b))!;
      expect(single.bank).toBe(false);
      expect(single.checksumOk).toBe(true);
      expect([...single.voices[0]]).toEqual([...b]);
    });

    it(`${v.name}: sounds at every key and velocity, never clips, and falls silent after the key`, () => {
      for (const [key, vel] of [[36, 0.8], [60, 0.8], [84, 1], [60, 0.3]]) {
        const { held, after } = play(solo(bank.voices[i]), [key], vel, 2, 4);
        const at = `key ${key} velocity ${vel}`;
        expect(loudest(held), at).toBeGreaterThan(0.03);
        expect(peak(held), at).toBeLessThan(0.9);
        expect(peak(after), at).toBeLessThan(0.9);
        expect(rms(after.subarray(after.length - SR / 10)), at).toBeLessThan(0.1 * loudest(held));
      }
    });
  }

  it('the loop voices use their loop: at feedback 0 they sound otherwise', () => {
    for (const v of DX7_VOICES.filter((x) => x.alg === 4 || x.alg === 6)) {
      const loop = play(solo(packVoice(v)), [48], 0.8, 0.5, 0).held, none = play(solo(packVoice({ ...v, fb: 0 })), [48], 0.8, 0.5, 0).held;
      expect(rms(loop.map((x, k) => x - none[k])), v.name).toBeGreaterThan(0.1 * rms(loop));
    }
  });
});

describe('the DX7 Piano example', () => {
  const entry = EXAMPLES.find((e) => e.name === DX7_EXAMPLE)!;

  it('is what scripts/dx7-bank.ts writes, and loads as stored', () => {
    expect(entry.patch).toEqual(dx7Example());
    expect(validatePatch(structuredClone(entry.patch) as unknown as Patch, DEFS)).toEqual(entry.patch);
  });

  it('is a Voicing of 8 voices, a DX7 playing the bank\'s electric piano, an Output, and Main\'s mod wheel on the DX7\'s p1 to mod', () => {
    const p = EXAMPLE_PRESETS[DX7_EXAMPLE]();
    const of = (type: string) => p.modules.filter((m) => m.type === type);
    expect(of('alloc').map((m) => m.params.voices)).toEqual([8]);
    expect(of('output')).toHaveLength(1);
    const [dx] = of('dx7');
    expect(voiceBytes(dx.voice)).toEqual(packVoice(DX7_VOICES[0]));
    expect(voiceName(voiceBytes(dx.voice))).toBe('TINE PIANO');
    expect(dx.map?.p1).toEqual(['mod']);
    const main = of('fm1')[0];
    expect(p.cables).toContainEqual({ from: { module: main.id, port: 'mod' }, to: { module: dx.id, port: 'p1' } });
    expect(p.assemblies?.find((a) => a.modules.includes(dx.id))?.poly).toBeDefined();
  });

  it('is an editor example only: no FM-1 factory patch', () => {
    expect(FM1_PRESETS[DX7_EXAMPLE]).toBeUndefined();
  });

  it('is format 71 and fits the FM-1', () => {
    const p = EXAMPLE_PRESETS[DX7_EXAMPLE]();
    const budget = deviceBudget(p);
    expect(budget.over).toEqual([]);
    expect(budget.fits).toBe(true);
    expect(encodePatch(p)[1]).toBe(FORMAT_1_30);
  });
  it('plays a chord of eight without clipping, and the mod wheel brings in the tremolo', () => {
    const chord = [48, 52, 55, 59, 60, 64, 67, 71];
    const still = play(EXAMPLE_PRESETS[DX7_EXAMPLE](), chord, 0.8, 1.5, 0).held;
    expect(loudest(still)).toBeGreaterThan(0.05);
    expect(peak(still)).toBeLessThan(0.95);
    const wheel = play(EXAMPLE_PRESETS[DX7_EXAMPLE](), chord, 0.8, 1.5, 0, (e) => e.cc(1, 127)).held;
    expect(rms(wheel.map((x, k) => x - still[k]))).toBeGreaterThan(0.05 * rms(still));
  });
});
