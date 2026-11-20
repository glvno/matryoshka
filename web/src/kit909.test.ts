// SPDX-License-Identifier: GPL-3.0-only
// The 909 Kit (factory/bank.json: the whole TR-909 since D-1055) against the archived 909 Kit XL (scripts/xl/909-kit.ts):
// the FM-1 version plays what the XL plays, with every voice, TOTAL ACCENT, FLAM, SHUFFLE and SCALE, on one DRUMS track.
import { describe, expect, it } from 'vitest';
import { Engine } from './engine';
import { readFileSync } from 'node:fs';
import { deviceBudget, encodePatch } from './patchbin';
import { cpuEstimate, CPU_VOICE_TOP } from './cpu';
import { factoryPresets } from './factory-presets';
import { PRESET_MIGRATIONS, migrateValues } from './preset-migrate';
import { rowOrder, structureOf } from './structure';
import { readLineage } from '../scripts/lineage-lib';
import { presetsHPatches } from '../scripts/factory-lz';
import { FM1_PRESETS } from './presets';
import { relocatedPatches } from './community-factory';
import { assembliesOf, fixAssemblies, rowTargets, type AssemblyInst } from './assembly';
import { applyPreset, currentValues } from './device-presets';
import { DEFS } from './modules';
import { devicesOf } from './pages';
import { validatePatch, type Patch } from './patch';

/** the patch as the editor opens it */
const fixed = (p: Patch): Patch => {
  const q = validatePatch(structuredClone(p), DEFS);
  fixAssemblies(q, DEFS);
  return q;
};

const SR = 48000;
/** the Drum maps' keys: KICK .. HI TOM (F3..F4), MID TOM CRASH RIDE ACCENT (G4 A4 B4 C5), the FLAM rows (black keys) */
const BD = 53, SD = 55, CP = 57, CH = 59, OH = 60, LT = 62, RS = 64, HT = 65, MT = 67, CR = 69, RD = 71, AC = 72;
const FLAMS = [54, 56, 63, 68, 66];
const VOICES = [BD, SD, CP, CH, OH, LT, RS, HT, MT, CR, RD];

const setRow = (p: Patch, head: string, label: string, v: number): void => {
  const card = assembliesOf(p).find((a) => a.name === '909 kit' || a.label === head)!;
  const i = card.params.findIndex((r) => r.head === head);
  const r = card.params.slice(Math.max(0, i)).find((x) => x.label === label)!;
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

describe('909 Kit (the FM-1 version: the whole TR-909, D-1055)', () => {
  const kit = (): Patch => FM1_PRESETS['909 Kit']();
  const xl = (): Patch => relocatedPatches['909 Kit XL']();

  it('fits the FM-1 within every limit and the CPU top', () => {
    const p = kit();
    expect(deviceBudget(p).fits).toBe(true);
    expect(cpuEstimate(p).use).toBeLessThanOrEqual(CPU_VOICE_TOP);
  });

  it('ships in presets.h as the patch encodes', () => {
    const bin = encodePatch(kit());
    const h = readFileSync(new URL('../../firmware/src/presets.h', import.meta.url), 'utf8');
    const shipped = presetsHPatches(h).map((x) => x.bytes);
    expect(shipped.some((b) => b.length === bin.length && b.every((x, i) => x === bin[i]))).toBe(true);
  });

  it('has one DRUMS track into all three Drum maps, SHUFFLE and SCALE on its swing and rate, and no Arpeggiator', () => {
    const p = kit();
    const tracks = p.modules.filter((m) => m.type === 'steps');
    expect(tracks.map((m) => m.name)).toEqual(['DRUMS']);
    const maps = p.modules.filter((m) => m.type === 'drummap');
    expect(maps.map((m) => m.names?.[0])).toEqual(['KICK', 'MID TOM', 'BD FLAM']);
    for (const m of maps) expect(p.cables.some((c) => c.from.module === tracks[0].id && c.from.port === 'keys' && c.to.module === m.id)).toBe(true);
    const card = assembliesOf(p).find((a) => a.name === '909 kit')!;
    for (const [label, pin, param] of [['shuffle', 'p1', 'swing'], ['scale', 'p2', 'rate']] as const) {
      const row = card.params.find((r) => r.label === label)!;
      expect(row.names?.length, label).toBeGreaterThan(1);
      expect(p.cables.some((c) => c.from.module === row.module && c.to.module === tracks[0].id && c.to.port === pin), label).toBe(true);
      expect(tracks[0].map![pin]).toEqual([param]);
    }
    expect(p.modules.some((m) => m.type === 'arp')).toBe(false);
  });

  it('plays all eleven voices', () => {
    for (const key of VOICES) expect(peak(play(kit(), [[0, key, 0.79]], 0.4)), `key ${key}`).toBeGreaterThan(0.01);
  });

  it('plays what 909 Kit XL plays: every key plain and with ACCENT, every FLAM row, each FLAM and TOTAL ACCENT setting', () => {
    const cases: [number, number, number][][] = [
      ...VOICES.flatMap((k) => [[[0, k, 0.79]], [[0, k, 1]], [[0, k, 0.79], [0, AC, 0.79]]] as [number, number, number][][]),
      ...FLAMS.map((k) => [[0, k, 0.79]] as [number, number, number][]),
      [[0, BD, 1], [0.25, 54, 0.79]],
    ];
    for (const ev of cases) expect(differ(play(xl(), ev, 0.5), play(kit(), ev, 0.5)), JSON.stringify(ev)).toBeLessThan(1e-6);
    for (const [label, v] of [['flam', 8], ['flam', 1], ['total accent', 1]] as const) {
      const a = xl(), b = kit();
      for (const q of [a, b]) setRow(q, 'accent flam', label, v);
      const ev: [number, number, number][] = [[0, 56, 0.79], [0, AC, 0.79]];
      expect(differ(play(a, ev, 0.5), play(b, ev, 0.5)), `${label} ${v}`).toBeLessThan(1e-6);
    }
  });

  it('a FLAM row plays its drum twice', () => {
    const one = play(kit(), [[0, SD, 0.79]], 0.3), flam = play(kit(), [[0, 56, 0.79]], 0.3);
    expect(peak(flam)).toBeGreaterThan(0.01);
    expect(differ(one, flam)).toBeGreaterThan(0.05);
  });

  it('the closed hat cuts the open one', () => {
    const open = play(kit(), [[0, OH, 0.79]], 0.8);
    const cut = play(kit(), [[0, OH, 0.79], [0.1, CH, 0.79]], 0.8);
    expect(rms(open, 0.25, 0.5)).toBeGreaterThan(1e-4);
    expect(rms(cut, 0.25, 0.5)).toBeLessThan(rms(open, 0.25, 0.5) / 20);
  });

  it('moves a preset of the lean card onto the TR-909 knobs it shared; the rest at Init (D-1055)', () => {
    const p = kit();
    const a = assembliesOf(p).find((x) => x.name === '909 kit')!;
    const init = factoryPresets().find((x) => x.structure === structureOf(p, a) && x.name === 'Init')!;
    const migration = PRESET_MIGRATIONS['141e7773'];
    expect(migration.to).toBe(init.structure);
    const lineage = readLineage().engines['909 kit'];
    const before = lineage.find((x) => x.structure === '141e7773')!, now = lineage.at(-1)!;
    const old = before.rows.map((_, i) => (i + 1) / 100);
    const values = migrateValues(migration, old, init.values);
    const was = (target: string): number => old[before.rows.findIndex((r) => r[0] === target)];
    const at = (target: string): number => values[now.rows.findIndex((r) => r[0] === target)];
    const atInit = (target: string): number => init.values[now.rows.findIndex((r) => r[0] === target)];
    for (const [to, from] of [['osc#46.coarse', 'osc#2.coarse'], ['mixer#55.l2', 'mixer#11.l2'], ['env#49.r3', 'env#5.r3'],
      ['osc#61.coarse', 'osc#17.coarse'], ['mixer#64.l1', 'mixer#20.l1'], ['env#102.r3', 'env#25.r3']]) expect(at(to), to).toBe(was(from));
    for (const t of ['filter#58.cutoff', 'vca#56.gain', 'env#107.r3']) expect(at(t), t).toBe(atInit(t));
    expect(migration.rows.filter((r) => typeof r === 'number' && r >= 0)).toHaveLength(6);
  });

  it('one hi-hat LEVEL sets the closed and the open hat, on the card, the FM-1 page and in a preset (#1124)', () => {
    const p = fixed(kit());
    const card = assembliesOf(p).find((a) => a.name === '909 kit')!;
    const hihat = assembliesOf(p).find((a) => a.label === 'hihat')!, open = assembliesOf(p).find((a) => a.label === 'open hat')!;
    const vcaOut = (a: AssemblyInst): number => a.outputs.find((r) => r.port === 'out' && p.modules.find((m) => m.id === r.module)?.type === 'vca')!.module;
    const both = [{ module: vcaOut(hihat), param: 'gain' }, { module: vcaOut(open), param: 'gain' }];
    for (const a of [hihat, card]) expect(rowTargets(a.params.find((r) => r.label === 'level' && (a === hihat || r.head === 'hihat'))!), a.label).toEqual(both);
    expect(open.params.map((r) => r.label)).toEqual(['oh decay']);
    const page = devicesOf(p, DEFS).find((d) => d.asm === card.id)!.pages.flatMap((pg) => pg.rows).find((r) => r.module === both[0].module)!;
    expect(page.also).toEqual([both[1]]);
    const rows = rowOrder(p, card), values = currentValues(p, card);
    values[rows.findIndex((r) => r.module === both[0].module && r.param === 'gain')] = 0.5;
    expect(applyPreset(p, card, { structure: structureOf(p, card), name: 'half', values })).toBe(true);
    for (const t of both) expect(p.modules.find((m) => m.id === t.module)!.params.gain).toBe(0.5);
    // the open hat at half its level: half as loud
    expect(rms(play(p, [[0, OH, 0.79]], 0.4), 0, 0.4) / rms(play(kit(), [[0, OH, 0.79]], 0.4), 0, 0.4)).toBeCloseTo(0.5, 3);
  });

  it('moves a preset of the card before the shared hi-hat LEVEL with every value, the closed hat\'s level on the shared row (#1124)', () => {
    const migration = PRESET_MIGRATIONS['c8210529'];
    const lineage = readLineage().engines['909 kit'];
    const before = lineage.find((x) => x.structure === 'c8210529')!, now = lineage.at(-1)!;
    expect(migration.to).toBe(now.structure);
    const old = before.rows.map((_, i) => (i + 1) / 100);
    const values = migrateValues(migration, old, now.rows.map(() => 0));
    for (const [k, [target]] of now.rows.entries()) {
      const from = target === 'vca#103.gain+vca#111.gain' ? 'vca#103.gain' : target;
      expect(values[k], target).toBe(old[before.rows.findIndex((r) => r[0] === from)]);
    }
  });
});
