// SPDX-License-Identifier: GPL-3.0-only
// The 808 Kit (factory/bank.json: the whole TR-808 since D-1053) and the archived 808 Kit XL (scripts/xl/808-kit.ts) against
// the Roland TR-808's owner's manual: the card's rows are the TR-808's knobs and switches, named as its panel names them;
// the closed hihat cuts the open one; the switches, ACCENT row and every voice play. The FM-1 version plays what the XL
// plays, with one voice per tom / conga pair.
import { describe, expect, it } from 'vitest';
import { Engine } from './engine';
import { readFileSync } from 'node:fs';
import { deviceBudget, encodePatch, rangeList } from './patchbin';
import { cpuEstimate, CPU_VOICE_TOP } from './cpu';
import { levelRows } from './levels';
import { factoryPresets } from './factory-presets';
import { PRESET_MIGRATIONS, migrateValues } from './preset-migrate';
import { structureOf } from './structure';
import { readLineage } from '../scripts/lineage-lib';
import { FM1_PRESETS } from './presets';
import { relocatedPatches } from './community-factory';
import { assembliesOf } from './assembly';
import type { Patch } from './patch';
import { presetsHPatches } from '../scripts/factory-lz';

const SR = 48000;
/** the Drum map rows' keys: BD .. CB (F3..F4) and MT/MC HT/HC CY AC (G4 A4 B4 C5) */
const BD = 53, SD = 55, CP = 57, CH = 59, OH = 60, LT = 62, RS = 64, MT = 67, HT = 69, CY = 71, AC = 72;

const setRow = (p: Patch, head: string, label: string, v: number): void => {
  const card = assembliesOf(p).find((a) => a.name === '808 kit')!;
  const i = card.params.findIndex((r) => r.head === head);
  const r = card.params.slice(i).find((x) => x.label === label)!;
  p.modules.find((m) => m.id === r.module)!.params[r.param] = v;
};

/** render `secs` after these key events ([seconds, note, velocity 0..1]), the left channel */
function play(p: Patch, events: [number, number, number][], secs: number): Float32Array {
  const e = new Engine(SR);
  e.load(p);
  const out = new Float32Array(Math.round(SR * secs));
  const BLOCK = 128;
  const r = new Float32Array(BLOCK);
  for (let at = 0; at < out.length; at += BLOCK) {
    for (const [t, n, v] of events) {
      const s = Math.round(t * SR);
      if (s >= at && s < at + BLOCK) e.noteOn(n, v);
      if (s + 480 >= at && s + 480 < at + BLOCK) e.noteOff(n);
    }
    const l = new Float32Array(Math.min(BLOCK, out.length - at));
    e.render(l, r.subarray(0, l.length));
    out.set(l, at);
  }
  return out;
}
const rms = (x: Float32Array, from: number, to: number): number => {
  let s = 0;
  const a = Math.round(from * SR), b = Math.round(to * SR);
  for (let i = a; i < b; i++) s += x[i] * x[i];
  return Math.sqrt(s / (b - a));
};
const peak = (x: Float32Array): number => x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
const differ = (a: Float32Array, b: Float32Array): number => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2;
  return Math.sqrt(s / a.length) / Math.max(rms(a, 0, a.length / SR), 1e-9);
};

describe('808 Kit (the FM-1 version: the whole TR-808, D-1053)', () => {
  const kit = (): Patch => FM1_PRESETS['808 Kit']();
  const xl = (): Patch => relocatedPatches['808 Kit XL']();

  it('fits the FM-1 within every limit and the CPU top', () => {
    const p = kit();
    expect(deviceBudget(p).fits).toBe(true);
    expect(cpuEstimate(p).use).toBeLessThanOrEqual(CPU_VOICE_TOP);
  });

  it('its macro ranges reach the FM-1: in the patch and in presets.h (#367)', () => {
    const p = kit();
    expect(rangeList(p).length).toBeGreaterThan(0);
    const bin = encodePatch(p);
    expect(bin[6] & 2).toBe(2);   // (the macro ranges section's flag)
    const h = readFileSync(new URL('../../firmware/src/presets.h', import.meta.url), 'utf8');
    const shipped = presetsHPatches(h).map((p) => p.bytes);
    expect(shipped.some((b) => b.length === bin.length && b.every((x, i) => x === bin[i]))).toBe(true);
  });

  it('has one DRUMS track into both Drum maps, its rate on pre-scale, and no Arpeggiator', () => {
    const p = kit();
    const tracks = p.modules.filter((m) => m.type === 'steps');
    expect(tracks.map((m) => m.name)).toEqual(['DRUMS']);
    const maps = p.modules.filter((m) => m.type === 'drummap');
    expect(maps.map((m) => m.names?.[0])).toEqual(['BD', 'MT/MC']);
    for (const m of maps) expect(p.cables.some((c) => c.from.module === tracks[0].id && c.from.port === 'keys' && c.to.module === m.id)).toBe(true);
    const card = assembliesOf(p).find((a) => a.name === '808 kit')!;
    const sel = card.params.find((r) => r.label === 'pre-scale')!.module;
    expect(p.cables.some((c) => c.from.module === sel && c.to.module === tracks[0].id && c.to.port === 'p1')).toBe(true);
    expect(p.modules.some((m) => m.type === 'arp')).toBe(false);
  });

  it('plays all eleven voices', () => {
    for (const key of [BD, SD, CP, CH, OH, LT, RS, 65, MT, HT, CY]) expect(peak(play(kit(), [[0, key, 0.79]], 0.4)), `key ${key}`).toBeGreaterThan(0.01);
  });

  it('each switch plays its second sound at position 2', () => {
    for (const [head, sw, key] of [['low tom', 'tom/conga', LT], ['mid tom', 'tom/conga', MT], ['hi tom', 'tom/conga', HT], ['rim shot', 'rim/claves', RS], ['hand clap', 'clap/maraca', CP]] as const) {
      const a = kit(), b = kit();
      setRow(b, head, sw, 2);
      const one = play(a, [[0, key, 0.79]], 0.3), two = play(b, [[0, key, 0.79]], 0.3);
      expect(peak(two), head).toBeGreaterThan(0.01);
      expect(differ(one, two), head).toBeGreaterThan(0.3);
    }
  });

  it('plays what 808 Kit XL plays, every key, each switch either way, at the XL\'s levels (one voice per tom / conga)', () => {
    /** the kit at the XL's level rows and Output (the factory loudness rule moved them) */
    const atXlLevels = (p: Patch): Patch => {
      const x = xl();
      const [ax, ap] = [x, p].map((q) => assembliesOf(q).find((a) => a.name === '808 kit')!);
      const from = levelRows(x, ax);
      levelRows(p, ap).forEach((r, i) => (p.modules.find((m) => m.id === r.module)!.params[r.param] = x.modules.find((m) => m.id === from[i].module)!.params[from[i].param]));
      p.modules.find((m) => m.type === 'output')!.params.level = x.modules.find((m) => m.type === 'output')!.params.level;
      return p;
    };
    for (const pos of [1, 2]) for (const key of [BD, SD, CP, CH, OH, LT, RS, 65, MT, HT, CY]) {
      const a = atXlLevels(kit()), b = xl();
      for (const q of [a, b]) for (const [head, sw] of [['low tom', 'tom/conga'], ['mid tom', 'tom/conga'], ['hi tom', 'tom/conga'], ['rim shot', 'rim/claves'], ['hand clap', 'clap/maraca']]) setRow(q, head, sw, pos);
      // (switched to a conga: the mid and hi congas within -130 dB; the low conga strikes through the low tom's strike stage,
      // 0.3 % louder than the XL's own, -52 dB)
      expect(differ(play(b, [[0, key, 0.79]], 0.4), play(a, [[0, key, 0.79]], 0.4)), `key ${key} at ${pos}`).toBeLessThan(pos === 1 ? 1e-6 : 0.005);
    }
  });

  it('only the AC row accents, by ACCENT LEVEL (1 + level); with VELOCITY at 0, as shipped, a row\'s velocity does not', () => {
    const plain = peak(play(kit(), [[0, BD, 100 / 127]], 0.3));
    expect(peak(play(kit(), [[0, BD, 1]], 0.3)) / plain).toBeCloseTo(1, 2);
    expect(peak(play(kit(), [[0, BD, 100 / 127], [0, AC, 100 / 127]], 0.3)) / plain).toBeCloseTo(1.5, 1);
  });

  it('the closed hihat cuts the open one, and an open hit after it sounds again', () => {
    const open = play(kit(), [[0, OH, 0.79]], 0.8);
    const cut = play(kit(), [[0, OH, 0.79], [0.1, CH, 0.79]], 0.8);
    expect(rms(open, 0.25, 0.5)).toBeGreaterThan(1e-4);
    expect(rms(cut, 0.25, 0.5)).toBeLessThan(rms(open, 0.25, 0.5) / 20);
    const again = play(kit(), [[0, OH, 0.79], [0.1, CH, 0.79], [0.2, OH, 0.79]], 0.8);
    expect(rms(again, 0.4, 0.6)).toBeGreaterThan(rms(open, 0.2, 0.4) / 3);
  });

  it('bass drum TONE and snare drum TONE change the sound', () => {
    for (const [head, key, lo, hi] of [['bass drum', BD, 150, 8000], ['snare drum', SD, 0, 1]] as const) {
      const a = kit(), b = kit();
      setRow(a, head, 'tone', lo);
      setRow(b, head, 'tone', hi);
      expect(differ(play(a, [[0, key, 0.79]], 0.3), play(b, [[0, key, 0.79]], 0.3)), head).toBeGreaterThan(0.05);
    }
  });

  it('moves a preset of the eight-voice card onto the same rows, the low tom\'s tuning onto its knob (D-1053)', () => {
    const p = kit();
    const a = assembliesOf(p).find((x) => x.name === '808 kit')!;
    const init = factoryPresets().find((x) => x.structure === structureOf(p, a) && x.name === 'Init')!;
    const migration = PRESET_MIGRATIONS.b3d5b969;
    expect(migration.to).toBe(init.structure);
    const lineage = readLineage().engines['808 kit'];
    const before = lineage.find((x) => x.structure === 'b3d5b969')!, now = lineage.at(-1)!;
    const old = before.rows.map((_, i) => (i + 1) / 100);
    old[before.rows.findIndex((r) => r[0] === 'modal#42.coarse')] = -7;   // (5 semitones over the body's -12)
    const values = migrateValues(migration, old, init.values);
    const was = (label: string, target: string): number => old[before.rows.findIndex((r) => r[0] === target && r[1] === label)];
    const at = (target: string): number => values[now.rows.findIndex((r) => r[0] === target)];
    expect(at('macro#13.value')).toBeCloseTo(0.5 + 5 / 14, 3);   // low tom / tuning
    expect(at('env#61.r3')).toBe(was('decay', 'env#35.r3'));      // open hihat / decay
    expect(at('env#109.r3')).toBe(init.values[now.rows.findIndex((r) => r[0] === 'env#109.r3')]);   // cymbal / decay: Init
    expect(migration.rows.filter((r) => typeof r === 'number' && r >= 0)).toHaveLength(old.length - 1);
  });
});

describe('808 Kit XL', () => {
  const xl = (): Patch => relocatedPatches['808 Kit XL']();

  it('pre-scale drives both tracks\' rate, its positions in rising order', () => {
    const p = xl();
    const card = assembliesOf(p).find((a) => a.name === '808 kit')!;
    const sel = p.modules.find((m) => m.id === card.params.find((r) => r.label === 'pre-scale')!.module)!;
    const tracks = p.modules.filter((m) => m.type === 'steps' && (m.name === 'DRUMS' || m.name === 'DRUMS 2'));
    expect(tracks.length).toBe(2);
    for (const t of tracks) {
      expect(p.cables.some((c) => c.from.module === sel.id && c.to.module === t.id && c.to.port === 'p1')).toBe(true);
      expect(t.range!.p1!.rate).toEqual([0, 1]);
    }
    const v = [1, 2, 3, 4].map((k) => sel.params[`v${k}`]);
    v.slice(1).forEach((x, i) => expect(x).toBeGreaterThan(v[i]));
  });

  it('plays all eleven voices', () => {
    for (const key of [BD, SD, CP, CH, OH, LT, RS, 65, MT, HT, CY]) expect(peak(play(xl(), [[0, key, 0.79]], 0.4)), `key ${key}`).toBeGreaterThan(0.01);
  });

  it('each switch plays its second sound at position 2', () => {
    for (const [head, sw, key] of [['low tom', 'tom/conga', LT], ['mid tom', 'tom/conga', MT], ['hi tom', 'tom/conga', HT], ['rim shot', 'rim/claves', RS], ['hand clap', 'clap/maraca', CP]] as const) {
      const a = xl(), b = xl();
      setRow(b, head, sw, 2);
      const one = play(a, [[0, key, 0.79]], 0.3), two = play(b, [[0, key, 0.79]], 0.3);
      expect(peak(two), head).toBeGreaterThan(0.01);
      expect(differ(one, two), head).toBeGreaterThan(0.3);
    }
  });

  it('only the AC row accents, by ACCENT LEVEL (1 + level); a row\'s velocity does not', () => {
    const plain = peak(play(xl(), [[0, BD, 100 / 127]], 0.3));
    expect(peak(play(xl(), [[0, BD, 1]], 0.3)) / plain).toBeCloseTo(1, 2);
    expect(peak(play(xl(), [[0, BD, 100 / 127], [0, AC, 100 / 127]], 0.3)) / plain).toBeCloseTo(1.5, 1);
    const p = xl();
    setRow(p, 'accent', 'level', 1);
    expect(peak(play(p, [[0, BD, 100 / 127], [0, AC, 100 / 127]], 0.3)) / plain).toBeCloseTo(2, 1);
  });

  it('the closed hihat cuts the open one', () => {
    const open = play(xl(), [[0, OH, 0.79]], 0.8);
    const cut = play(xl(), [[0, OH, 0.79], [0.1, CH, 0.79]], 0.8);
    expect(rms(cut, 0.25, 0.5)).toBeLessThan(rms(open, 0.25, 0.5) / 20);
  });
});
