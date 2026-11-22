// SPDX-License-Identifier: GPL-3.0-only
// The 808 and 909 Kits' VELOCITY row (D-1053, D-1055 amended): 0 to 1, how far each voice's level follows its Drum map row's velocity
// (MIDI notes, the FM-1's keys and Steps' per-step velocity all arrive there). A voice plays at 1 - VELOCITY + VELOCITY x
// velocity / 127 of a hit at 127; an AC accent still adds its own level on top. At 0, as shipped, the kit plays sample for
// sample as without the row, in the browser engine and the FM-1 engine.
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildFm1EngineWasm } from '../scripts/fm1-wasm.mjs';
import { assembliesOf, parentOf } from './assembly';
import { Engine } from './engine';
import { FACTORY_KITS } from './factory-kit-patterns';
import { factoryPresets } from './factory-presets';
import { Fm1Engine } from './fm1-engine';
import { Fm1Bridge } from './fm1-engine-host';
import { removeModule, type Patch } from './patch';
import { factoryWithDemoSet } from './presets';
import { rowOrder, structureOf } from './structure';

const SR = 48000;
const BLOCK = 128;
/** each kit, its card and three rows' keys that take no velocity of their own, and its accent row's key */
const KITS = [
  { patch: '808 Kit', card: '808 kit', keys: [53, 65, 71], ac: 72 },   // (BD, CB, CY; AC)
  { patch: '909 Kit', card: '909 kit', keys: [57, 64, 69], ac: 72 },   // (CLAP, RIM, CRASH; ACCENT)
];
/** a whole song in both engines takes over 120 s under the release candidate's coverage run (web.yml mode rc) */
const SONG_MS = 600_000;
let wasm: WebAssembly.Module;
beforeAll(() => {
  wasm = new WebAssembly.Module(readFileSync(buildFm1EngineWasm(join(tmpdir(), `kit-velocity-${process.pid}.wasm`))));
}, 120_000);

let kitName = '808 Kit', cardName = '808 kit';
const kit = (): Patch => factoryWithDemoSet(kitName);   // (with its demo set: its song, #1179)
const cardOf = (p: Patch) => assembliesOf(p).find((a) => a.name === cardName && !parentOf(p, a.id))!;
const velocityRow = (p: Patch) => cardOf(p).params.find((r) => r.label === 'velocity')!;
function withVelocity(p: Patch, v: number): Patch {
  const r = velocityRow(p);
  p.modules.find((m) => m.id === r.module)!.params[r.param] = v;
  return p;
}
/** the kit without its VELOCITY row: the row's Macro and the Matrices it drives gone, the 808's accent Math's `kb` back at 0 */
function without(p: Patch): Patch {
  const q = structuredClone(p);
  const macro = velocityRow(q).module;
  for (const c of q.cables.filter((x) => x.from.module === macro)) {
    const m = q.modules.find((x) => x.id === c.to.module);
    if (!m) continue;   // (the 909's last Matrix takes the Macro twice: on p1 and on its fourth input)
    if (m.type === 'math') m.params.kb = 0;
    else removeModule(q, m.id);
  }
  removeModule(q, macro);
  const card = cardOf(q);
  card.params = card.params.filter((r) => r.module !== macro);
  card.modules = card.modules.filter((id) => q.modules.some((m) => m.id === id));
  return q;
}

/** either engine with the patch loaded: keys, song 1 from the top, blocks */
interface Player { on(note: number, vel: number): void; off(note: number): void; song(): void; render(l: Float32Array, r: Float32Array): void }
function player(p: Patch, fm1: boolean): Player {
  if (fm1) {
    const e = new Fm1Engine(wasm, SR);
    expect(e.apply(new Fm1Bridge().load(p))).toBe(0);
    return {
      on: (note, vel) => e.hear({ t: 'on', note, vel }),
      off: (note) => e.hear({ t: 'off', note }),
      song: () => {
        e.hear({ t: 'song', n: 1 });
        e.hear({ t: 'transport', on: true });
      },
      render: (l, r) => e.render(l, r),
    };
  }
  const e = new Engine(SR);
  e.load(p);
  return {
    on: (note, vel) => e.noteOn(note, vel),
    off: (note) => e.noteOff(note),
    song: () => {
      e.setSong(1);
      e.transport(true);
    },
    render: (l, r) => e.render(l, r),
  };
}
/** the left channel of `secs` seconds of song 1 (every pattern of the kit in turn) */
function song(p: Patch, secs: number, fm1: boolean): Float32Array {
  const e = player(p, fm1);
  e.song();
  const out = new Float32Array(Math.round(SR * secs)), r = new Float32Array(BLOCK);
  for (let at = 0; at < out.length; at += BLOCK) e.render(out.subarray(at, Math.min(at + BLOCK, out.length)), r.subarray(0, Math.min(BLOCK, out.length - at)));
  return out;
}
/** the peak of 0.4 s after these keys, struck together at the top with velocity `vel` (0..1) */
function hit(p: Patch, keys: number[], vel: number, fm1: boolean): number {
  const e = player(p, fm1);
  for (const k of keys) e.on(k, vel);
  const l = new Float32Array(BLOCK), r = new Float32Array(BLOCK);
  let peak = 0;
  for (let at = 0; at < SR * 0.4; at += BLOCK) {
    if (at === BLOCK * 4) for (const k of keys) e.off(k);
    e.render(l, r);
    for (const v of l) peak = Math.max(peak, Math.abs(v));
  }
  return peak;
}
const peakOf = (x: Float32Array): number => x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);

describe.each(KITS)('$patch: the VELOCITY row (D-1053, D-1055 amended)', ({ patch, card: cardLabel, keys, ac: AC }) => {
  const secs = FACTORY_KITS.find((k) => k.patch === patch)!.patterns.length * 2 + 1;
  beforeAll(() => {
    kitName = patch;
    cardName = cardLabel;
  });

  it('is the card\'s last row, 0 in the patch and in every factory preset of the card', () => {
    const p = kit(), card = cardOf(p), row = velocityRow(p);
    expect(card.params.at(-1)).toBe(row);
    expect(p.modules.find((m) => m.id === row.module)!).toMatchObject({ type: 'macro', params: { value: 0 } });
    const at = rowOrder(p, card).findIndex((r) => r.module === row.module && r.param === row.param);
    const presets = factoryPresets().filter((x) => x.structure === structureOf(p, card));
    expect(presets.length).toBeGreaterThan(1);
    for (const x of presets) expect(x.values[at] ?? 0, x.name).toBe(0);
  });

  it.each([false, true])('at 0 plays every pattern of its song sample for sample as without the row (FM-1 engine: %s)', (fm1) => {
    const p = kit();
    const a = song(p, secs, fm1), b = song(without(p), secs, fm1);
    expect(peakOf(a)).toBeGreaterThan(0.1);
    expect(a.every((v, i) => v === b[i])).toBe(true);
  }, SONG_MS);

  it.each([false, true])('turns a hit down to 1 - VELOCITY + VELOCITY x velocity of one at 127, an accent on top (FM-1 engine: %s)', (fm1) => {
    for (const key of keys) for (const d of [0, 0.5, 1]) {
      const loud = hit(withVelocity(kit(), d), [key], 1, fm1);
      for (const v of [100 / 127, 0.4]) expect(hit(withVelocity(kit(), d), [key], v, fm1) / loud, `key ${key} at ${d}, velocity ${v}`).toBeCloseTo(1 - d + d * v, 2);
      // (an accent adds half a plain hit at ACCENT LEVEL's or TOTAL ACCENT's Init, whatever the velocity)
      expect(hit(withVelocity(kit(), d), [key, AC], 0.4, fm1) / loud, `key ${key} at ${d}, accented`).toBeCloseTo(1.5 - d * 0.6, 2);
    }
  }, SONG_MS);

  it.each([false, true])('only ever turns the song down: no clipping at 1 (D-854) (FM-1 engine: %s)', (fm1) => {
    const at0 = peakOf(song(kit(), secs, fm1)), half = peakOf(song(withVelocity(kit(), 0.5), secs, fm1));
    const full = peakOf(song(withVelocity(kit(), 1), secs, fm1));
    expect(half).toBeLessThan(at0);
    expect(full).toBeLessThan(half);
  }, SONG_MS);
});
