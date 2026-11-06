// SPDX-License-Identifier: GPL-3.0-only
// The test patches of the device check as scenarios (scripts/check-fixtures.mjs, scripts/device-check.mjs): each is what
// the check's page describes, the editor reads it, and it fits the FM-1.
import { describe, expect, it } from 'vitest';
import { FIXTURES, NOTE, oldPatch } from '../scripts/check-fixtures.mjs';
import { armable, noKeysReach } from './arm';
import { Engine } from './engine';
import { DEFS } from './modules';
import { devicesOf } from './pages';
import { deviceBudget, encodePatch, lineBudget } from './patchbin';
import { validatePatch, type Patch } from './patch';
import { isDrone } from './track';

const fixture = (name: string): Patch => validatePatch((FIXTURES as Record<string, () => unknown>)[name](), DEFS);
const notesOf = (p: Patch, name = 'PATTERN') => p.modules.find((m) => m.type === 'steps' && m.name === name)?.notes ?? [];

/** 0.5 s of the patch with `note` held: the left and right channels */
function play(p: Patch, note = 60): { l: Float32Array; r: Float32Array } {
  const e = new Engine(48000);
  e.load(p);
  e.render(new Float32Array(4800), new Float32Array(4800));
  e.noteOn(note);
  const l = new Float32Array(24000), r = new Float32Array(24000);
  e.render(l, r);
  return { l, r };
}
const crossings = (x: Float32Array): number => { let n = 0; for (let i = 1; i < x.length; i++) if ((x[i] >= 0) !== (x[i - 1] >= 0)) n++; return n; };
const rms = (x: Float32Array): number => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);

describe('the device check\'s test patches', () => {
  it('every one is read by the editor and fits the FM-1', () => {
    for (const name of Object.keys(FIXTURES)) {
      const p = fixture(name);
      expect(deviceBudget(p).fits, `${name}: ${deviceBudget(p).over.map((i) => i.label).join(', ')}`).toBe(true);
      expect(() => encodePatch(p), name).not.toThrow();
    }
  });

  it('T110 MONO L R: the saw on the left, the sine an octave up on the right', () => {
    const { l, r } = play(fixture('monoLR'));
    expect(rms(l)).toBeGreaterThan(0.02);
    expect(rms(r)).toBeGreaterThan(0.02);
    // (a sine an octave up crosses zero twice as often as the saw under it)
    expect(crossings(r) / crossings(l)).toBeGreaterThan(1.7);
    expect(crossings(r) / crossings(l)).toBeLessThan(2.3);
  });

  it('T110 DRONE and T110 DRONE STORED hold the notes the page lists; only STORED has a drone (format 50)', () => {
    const d = fixture('drone');
    expect(notesOf(d).map((n) => [n.at, n.note, n.len])).toEqual([[0, NOTE.C3, 16], [4, NOTE.E3, 1], [8, NOTE.G3, 1], [10, NOTE.E3, 1], [12, NOTE.D3, 1]]);
    expect(notesOf(d).some(isDrone)).toBe(false);
    const s = fixture('droneStored');
    expect(notesOf(s).filter(isDrone).map((n) => n.note)).toEqual([NOTE.C3]);
    expect(encodePatch(s)[1]).toBe(50);
    expect(encodePatch(d)[1]).toBeLessThan(50);
  });

  it('T111 TWO DELAYS: LONG at 1200 ms, SHORT at 300 ms, 129 of 190 KB of effect memory', () => {
    const p = fixture('twoDelays');
    const d = (n: string) => p.modules.find((m) => m.type === 'delay' && m.name === n)!.params;
    expect([d('LONG').time, d('LONG').length, d('SHORT').time, d('SHORT').length]).toEqual([1200, 1200, 300, 300]);
    const lb = lineBudget(p);
    expect([Math.round(lb.used / 1024), Math.round(lb.max / 1024), lb.fits]).toEqual([129, 190, true]);
  });

  it('T111 NO KEYS: no keys cable reaches the engine, a Steps track drives its cutoff (#633)', () => {
    const p = fixture('noKeys');
    const key = `a${p.assemblies![0]!.id}` as const;
    expect(noKeysReach(p, key)).toBe(true);
    expect(armable(p, key)).toBe(false);
    expect(notesOf(p, 'CUTOFF').length).toBeGreaterThan(0);
    // (the device extras name CUTOFF as the track that drives it, so the FM-1 gets the #633 mark, KEYS_UNREACHED_TRACK)
    const cutoff = p.modules.find((m) => m.name === 'CUTOFF')!.id;
    expect(devicesOf(p, DEFS).find((d) => d.asm === p.assemblies![0]!.id)?.track).toBe(cutoff);
  });

  it('the 1.9 patch: Silver Box\'s bytes as v1.9.1 wrote them, format 48 with patterns', () => {
    const o = oldPatch() as { bytes: number[]; format: number };
    expect([o.bytes[0], o.bytes[1], o.format]).toEqual([0xa1, 48, 48]);
    expect(o.bytes[7] & 4).toBe(4);   // (flag bit 10: the patterns and songs section)
  });
});
