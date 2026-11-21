// SPDX-License-Identifier: GPL-3.0-only
// The 808 and 909 Kits' Drum maps sit inside their kit cards, their DRUMS track outside (D-1059): the card shows its own
// jacks only, the FM-1 shows no Drum map pages, and the kits play exactly as with the maps outside, in both engines.
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildFm1EngineWasm } from '../scripts/fm1-wasm.mjs';
import { allModules, assembliesOf, assemblyOf, outsideCables, parentOf, removeMember } from './assembly';
import { Engine } from './engine';
import { instIsEngine } from './engines';
import { FACTORY_KITS } from './factory-kit-patterns';
import { Fm1Engine } from './fm1-engine';
import { Fm1Bridge } from './fm1-engine-host';
import { DEFS } from './modules';
import { devicesOf } from './pages';
import { layout } from './patchbin';
import { encodePayload } from './pattern-store';
import { FM1_PRESETS } from './presets';
import type { Patch } from './patch';

const SR = 48000;
const BLOCK = 128;
/** a whole song in both engines takes over 120 s under the release candidate's coverage run (web.yml mode rc) */
const SONG_MS = 600_000;
let wasm: WebAssembly.Module;
beforeAll(() => {
  wasm = new WebAssembly.Module(readFileSync(buildFm1EngineWasm(join(tmpdir(), `kit-maps-${process.pid}.wasm`))));
}, 120_000);

const cardOf = (p: Patch) => assembliesOf(p).find((a) => !parentOf(p, a.id) && a.modules.some((id) => p.modules.find((m) => m.id === id)?.type === 'drummap'))!;
/** the kit as it was before D-1059: every Drum map a top-level module again */
function outside(p: Patch): Patch {
  const q = structuredClone(p);
  const card = cardOf(q);
  for (const m of q.modules.filter((x) => x.type === 'drummap')) removeMember(q, card, m.id);
  return q;
}
/** the left channel of `secs` seconds of song 1 (every pattern of the kit in turn), the transport running from the top */
function songTs(p: Patch, secs: number): Float32Array {
  const e = new Engine(SR);
  e.load(p);
  e.setSong(1);
  e.transport(true);
  const out = new Float32Array(Math.round(SR * secs));
  const r = new Float32Array(BLOCK);
  for (let at = 0; at < out.length; at += BLOCK) e.render(out.subarray(at, Math.min(at + BLOCK, out.length)), r.subarray(0, Math.min(BLOCK, out.length - at)));
  return out;
}
function songFm1(p: Patch, secs: number): Float32Array {
  const e = new Fm1Engine(wasm, SR);
  expect(e.apply(new Fm1Bridge().load(p))).toBe(0);
  e.hear({ t: 'song', n: 1 });
  e.hear({ t: 'transport', on: true });
  const out = new Float32Array(Math.round(SR * secs));
  const r = new Float32Array(BLOCK);
  for (let at = 0; at < out.length; at += BLOCK) e.render(out.subarray(at, Math.min(at + BLOCK, out.length)), r.subarray(0, Math.min(BLOCK, out.length - at)));
  return out;
}
const identical = (a: Float32Array, b: Float32Array): boolean => a.length === b.length && a.every((v, i) => v === b[i]);
const loud = (x: Float32Array): boolean => x.some((v) => Math.abs(v) > 0.01);

describe.each(FACTORY_KITS.map((k) => k.patch))('%s: its Drum maps inside its card (D-1059)', (name) => {
  const kit = (): Patch => FM1_PRESETS[name]();
  const kitDef = FACTORY_KITS.find((k) => k.patch === name)!;
  const secs = kitDef.patterns.length * 2 + 1;

  it('holds every Drum map in the kit card, the track outside, and shows only the card’s own jacks', () => {
    const p = kit();
    const card = cardOf(p);
    expect(p.modules.filter((m) => m.type === 'drummap').every((m) => assemblyOf(p, m.id) === card)).toBe(true);
    expect(p.modules.filter((m) => m.type === 'steps').every((m) => !assemblyOf(p, m.id))).toBe(true);
    const inside = new Set(allModules(p, card));
    // (no cable from a member to a member crosses the edge; the cables in are Main's keys through DRUMS, out the audio and
    // the track's own settings)
    for (const c of outsideCables(p, card)) expect(inside.has(c.to.module) ? p.modules.find((m) => m.id === c.from.module)?.type : 'out').toMatch(/^(steps|out)$/);
    const keys = card.inputs.filter((r) => r.port === 'keys');
    expect(keys).toHaveLength(1);
    expect(instIsEngine(p, card)).toBe(true);
  });

  it('shows no Drum map on the FM-1: Main, DRUMS, then the kit, which DRUMS drives', () => {
    const p = kit();
    const devices = devicesOf(p, DEFS);
    expect(devices.some((d) => d.module !== undefined && p.modules.find((m) => m.id === d.module)?.type === 'drummap')).toBe(false);
    const drums = devices.findIndex((d) => d.kind === 'steps');
    expect(devices[drums + 1].asm).toBe(cardOf(p).id);
    expect(devices[drums + 1].track).toBe(devices[drums].module);
  });

  it('takes fewer patch bytes than with its Drum maps outside, and links the same pattern store entries', () => {
    const p = kit(), q = outside(p);
    expect(layout(p).counted).toBeLessThan(layout(q).counted);
    expect(p.modules.find((m) => m.type === 'fm1')!.seq).toEqual(q.modules.find((m) => m.type === 'fm1')!.seq);
    for (let k = 1; k <= kitDef.patterns.length; k++) expect(encodePayload(p, k)).toEqual(encodePayload(q, k));
  });

  it('plays every pattern of its song sample for sample as with its Drum maps outside, in the browser engine', () => {
    const p = kit();
    const a = songTs(p, secs), b = songTs(outside(p), secs);
    expect(loud(a)).toBe(true);
    expect(identical(a, b)).toBe(true);
  }, SONG_MS);

  it('plays every pattern of its song sample for sample as with its Drum maps outside, in the FM-1 engine', () => {
    const p = kit(), q = outside(p);
    const a = songFm1(p, secs), b = songFm1(q, secs);
    expect(loud(a)).toBe(true);
    expect(identical(a, b)).toBe(true);
  }, SONG_MS);
});
