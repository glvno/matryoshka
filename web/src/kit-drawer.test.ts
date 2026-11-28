// SPDX-License-Identifier: GPL-3.0-only
// The 909 Kit's FX drawer (D-1055 amended 2026-11-25): a stereo Drive and a crossfading Reverb on its card, the 1.27 forms
// (fx-drawer.ts insertEffect), both off. Off, the kit plays sample for sample as without the drawer, its song and every
// factory preset of its card, in the browser engine and the FM-1 engine (engine.c as wasm); its presets keep matching its
// card (the drawer is outside the structure); it fits the FM-1.
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildFm1EngineWasm } from '../scripts/fm1-wasm.mjs';
import { assembliesOf, bypassAssembly, drawerOf, effectsOf, parentOf } from './assembly';
import { cpuEstimate, CPU_VOICE_TOP } from './cpu';
import { applyPreset } from './device-presets';
import { Engine } from './engine';
import { buildFactoryBank, shippedFactoryBank } from './factory-bank';
import { applyFactoryLayout } from './factory-layout';
import { FACTORY_KITS } from './factory-kit-patterns';
import { factoryPresets } from './factory-presets';
import { Fm1Engine } from './fm1-engine';
import { Fm1Bridge } from './fm1-engine-host';
import { classicMix, EFFECT_CATALOG } from './fx-drawer';
import type { Patch } from './patch';
import { DEVICE, deviceBudget, encodePatch } from './patchbin';
import { factoryWithPatterns, FM1_PRESETS } from './presets';
import { structureOf } from './structure';

const SR = 48000;
const BLOCK = 128;
const NAME = '909 Kit';
/** a whole song in both engines takes over 120 s under the release candidate's coverage run (web.yml mode rc) */
const SONG_MS = 600_000;
const KIT = FACTORY_KITS.find((k) => k.patch === NAME)!;
const KEYS = [...Object.values(KIT.keys), ...Object.values(KIT.flams ?? {})];

let wasm: WebAssembly.Module;
beforeAll(() => {
  wasm = new WebAssembly.Module(readFileSync(buildFm1EngineWasm(join(tmpdir(), `kit-drawer-${process.pid}.wasm`))));
}, 120_000);

/** the 909 Kit without its drawer (the protected kit as bank.json has it, with its 1.24.1 patterns): full, or as it ships */
const plainFull = (): Patch => structuredClone(buildFactoryBank().find((c) => c.name === NAME)!.patch);
/** the kit as it ships without the drawer, its cards where the shipped kit's are (factory-layout.ts) */
const plainShipped = (): Patch => {
  const p = structuredClone(shippedFactoryBank(buildFactoryBank()).find((c) => c.name === NAME)!.patch);
  applyFactoryLayout(p, NAME);
  return p;
};
const cardOf = (p: Patch) => assembliesOf(p).find((a) => a.name === '909 kit' && !parentOf(p, a.id))!;
const effects = (p: Patch) => effectsOf(p, drawerOf(p, cardOf(p).id)!);

/** either engine with the patch loaded */
interface Player { on(note: number): void; song(): void; run(): void; render(l: Float32Array, r: Float32Array): void }
function player(p: Patch, fm1: boolean): Player {
  if (fm1) {
    const e = new Fm1Engine(wasm, SR);
    expect(e.apply(new Fm1Bridge().load(p))).toBe(0);
    return {
      on: (note) => e.hear({ t: 'on', note, vel: 100 }),
      song: () => e.hear({ t: 'song', n: 1 }),
      run: () => e.hear({ t: 'transport', on: true }),
      render: (l, r) => e.render(l, r),
    };
  }
  const e = new Engine(SR);
  e.load(p);
  return { on: (note) => e.noteOn(note, 100 / 127), song: () => e.setSong(1), run: () => e.transport(true), render: (l, r) => e.render(l, r) };
}
/** `secs` of both channels, interleaved: song 1 from the top, or the running pattern with every drum key struck at the top */
function render(p: Patch, secs: number, fm1: boolean, song: boolean): Float32Array {
  const e = player(p, fm1);
  if (song) e.song();
  else for (const k of KEYS) e.on(k);
  e.run();
  const n = Math.ceil((SR * secs) / BLOCK) * BLOCK, out = new Float32Array(n * 2), l = new Float32Array(BLOCK), r = new Float32Array(BLOCK);
  for (let at = 0; at < n; at += BLOCK) {
    e.render(l, r);
    for (let i = 0; i < BLOCK; i++) {
      out[2 * (at + i)] = l[i];
      out[2 * (at + i) + 1] = r[i];
    }
  }
  return out;
}
const peakOf = (x: Float32Array): number => x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
const same = (a: Float32Array, b: Float32Array): boolean => a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

describe('the 909 Kit\'s FX drawer (D-1055 amended 2026-11-25)', () => {
  it('holds a stereo Drive and a crossfading Reverb, named as the Library names them, both off; nothing else of the kit changes', () => {
    const p = FM1_PRESETS[NAME](), plain = plainShipped();
    const fx = effects(p);
    const library = (type: string) => EFFECT_CATALOG.find((e) => 'type' in e.source && e.source.type === type)!.name;
    expect(fx.map((e) => e.label)).toEqual([library('shape'), library('reverb')]);
    for (const e of fx) expect(e).toMatchObject({ bypass: true, kept: [] });
    const [drive, reverb] = fx.map((e) => e.modules.map((id) => p.modules.find((m) => m.id === id)!));
    expect(drive.map((m) => [m.type, m.stereo, m.bypass])).toEqual([['shape', true, true]]);
    expect(reverb.map((m) => [m.type, m.bypass])).toEqual([['reverb', true]]);
    expect(classicMix(p, fx[1])).toBe(false);
    // (every module of the kit as it was; of its cables only those into the Output now go through the drawer)
    const out = plain.modules.find((m) => m.type === 'output')!.id;
    for (const m of plain.modules) expect(p.modules.find((x) => x.id === m.id), `${m.type}#${m.id}`).toEqual(m);
    for (const c of plain.cables.filter((x) => x.to.module !== out)) expect(p.cables, JSON.stringify(c)).toContainEqual(c);
    expect(encodePatch(p, true)[1]).toBe(67);   // (a stereo module and a Reverb's r: format 67, D-281)
  });

  it.each([false, true])('off, plays its whole song sample for sample as without the drawer (FM-1 engine: %s)', (fm1) => {
    const secs = KIT.patterns.length * 2 + 1;
    const a = render(factoryWithPatterns(NAME), secs, fm1, true), b = render(plainFull(), secs, fm1, true);
    expect(peakOf(a)).toBeGreaterThan(0.1);
    expect(same(a, b)).toBe(true);
  }, SONG_MS);

  it('keeps its card\'s structure: every factory preset of the card loads onto the kit with its drawer', () => {
    const p = FM1_PRESETS[NAME](), plain = plainShipped();
    const structure = structureOf(p, cardOf(p));
    expect(structure).toBe(structureOf(plain, cardOf(plain)));
    const presets = factoryPresets().filter((x) => x.structure === structure);
    expect(presets.length).toBeGreaterThan(1);
    for (const x of presets) expect(applyPreset(p, cardOf(p), x), x.name).toBe(true);
  });

  it.each([false, true])('off, plays every factory preset of its card sample for sample as without the drawer (FM-1 engine: %s)', (fm1) => {
    const presets = factoryPresets().filter((x) => x.structure === structureOf(plainShipped(), cardOf(plainShipped())));
    for (const x of presets) {
      const a = FM1_PRESETS[NAME](), b = plainShipped();
      expect(applyPreset(a, cardOf(a), x) && applyPreset(b, cardOf(b), x), x.name).toBe(true);
      const ra = render(a, 3, fm1, false), rb = render(b, 3, fm1, false);
      expect(peakOf(ra), x.name).toBeGreaterThan(0.05);
      expect(same(ra, rb), x.name).toBe(true);
    }
  }, SONG_MS);

  it('fits the FM-1 off and on: bytes, modules, cables, memory, and the CPU estimate under the factory top', () => {
    const off = FM1_PRESETS[NAME](), on = FM1_PRESETS[NAME]();
    for (const e of effects(on)) bypassAssembly(on, e, false);
    for (const p of [off, on]) {
      const b = deviceBudget(p);
      expect(b.over).toEqual([]);
      expect(b.lines.fits).toBe(true);
      expect(encodePatch(p, true).length).toBeLessThanOrEqual(DEVICE.bytes);
      expect(p.modules.length).toBeLessThanOrEqual(DEVICE.modules);
      expect(p.cables.length).toBeLessThanOrEqual(DEVICE.cables);
      expect(cpuEstimate(p).use).toBeLessThanOrEqual(CPU_VOICE_TOP);
    }
    // (on: about 5 points of the estimate over off; the test rig measured 74.1 % without the drawer, 73.0 % off, 81.4 % on)
    expect(cpuEstimate(on).use - cpuEstimate(off).use).toBeGreaterThan(0.02);
  });
});
