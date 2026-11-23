// SPDX-License-Identifier: GPL-3.0-only
// The 808 and 909 Kits' Drum maps sit inside their kit cards (D-1059), and so does their DRUMS track (#1202 K2): the card
// shows its own jacks only (one keys jack, into DRUMS), the FM-1 shows the card alone as DRUMS' device, with no Drum map
// pages and no RATE or SWING row anywhere, and the kits play exactly as with the track, or the track and the maps, outside,
// in both engines. The card's PRE-SCALE (808), SHUFFLE and SCALE (909) drive the track through every position, each timed
// as its name says.
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
import { factoryWithPatterns, FM1_PRESETS } from './presets';
import { connect, type Patch } from './patch';
import { STEPS_RATE_HT, STEPS_RATES } from './track';

const SR = 48000;
const BLOCK = 128;
/** a whole song in both engines takes over 120 s under the release candidate's coverage run (web.yml mode rc) */
const SONG_MS = 600_000;
let wasm: WebAssembly.Module;
beforeAll(() => {
  wasm = new WebAssembly.Module(readFileSync(buildFm1EngineWasm(join(tmpdir(), `kit-maps-${process.pid}.wasm`))));
}, 120_000);

const cardOf = (p: Patch) => assembliesOf(p).find((a) => !parentOf(p, a.id) && a.modules.some((id) => p.modules.find((m) => m.id === id)?.type === 'drummap'))!;
const drumsOf = (p: Patch) => p.modules.find((m) => m.type === 'steps')!;
/** the kit as it was before #1202 K2: its DRUMS track a top-level module again, the Drum maps inside the card */
function unfolded(p: Patch): Patch {
  const q = structuredClone(p);
  removeMember(q, cardOf(q), drumsOf(q).id);
  return q;
}
/** the kit as it was before D-1059: DRUMS and every Drum map top-level modules again */
function outside(p: Patch): Patch {
  const q = unfolded(p);
  const card = cardOf(q);
  for (const m of q.modules.filter((x) => x.type === 'drummap')) removeMember(q, card, m.id);
  return q;
}
type Render = (l: Float32Array, r: Float32Array) => void;
function render(run: Render, secs: number): Float32Array {
  const out = new Float32Array(Math.round(SR * secs));
  const r = new Float32Array(BLOCK);
  for (let at = 0; at < out.length; at += BLOCK) run(out.subarray(at, Math.min(at + BLOCK, out.length)), r.subarray(0, Math.min(BLOCK, out.length - at)));
  return out;
}
/** the left channel of `secs` seconds from the top, the transport running: song `song` (every pattern of the kit in
 * turn), or with none the track's own notes */
function ts(p: Patch, secs: number, song?: number): Float32Array {
  const e = new Engine(SR);
  e.load(p);
  if (song !== undefined) e.setSong(song);
  e.transport(true);
  return render((l, r) => e.render(l, r), secs);
}
function fm1(p: Patch, secs: number, song?: number): Float32Array {
  const e = new Fm1Engine(wasm, SR);
  expect(e.apply(new Fm1Bridge().load(p))).toBe(0);
  if (song !== undefined) e.hear({ t: 'song', n: song });
  e.hear({ t: 'transport', on: true });
  return render((l, r) => e.render(l, r), secs);
}
const identical = (a: Float32Array, b: Float32Array): boolean => a.length === b.length && a.every((v, i) => v === b[i]);
const loud = (x: Float32Array): boolean => x.some((v) => Math.abs(v) > 0.01);

describe.each(FACTORY_KITS.map((k) => k.patch))('%s: its Drum maps (D-1059) and its DRUMS track (#1202 K2) inside its card', (name) => {
  const kit = (): Patch => factoryWithPatterns(name);   // (with its 1.24.1 patterns and song)
  const kitDef = FACTORY_KITS.find((k) => k.patch === name)!;
  const secs = kitDef.patterns.length * 2 + 1;

  it('holds DRUMS and every Drum map in the kit card, and shows only the card’s own jacks: one keys jack, into DRUMS', () => {
    const p = kit();
    const card = cardOf(p);
    expect(p.modules.filter((m) => m.type === 'drummap' || m.type === 'steps').every((m) => assemblyOf(p, m.id) === card)).toBe(true);
    const inside = new Set(allModules(p, card));
    // (no cable from a member to a member crosses the edge; the cables in are Main's into DRUMS, out the audio)
    for (const c of outsideCables(p, card)) if (inside.has(c.to.module)) expect(c.to.module).toBe(drumsOf(p).id);
    const keys = card.inputs.filter((r) => r.port === 'keys');
    expect(keys).toHaveLength(1);
    expect(keys[0].module).toBe(drumsOf(p).id);
    expect(instIsEngine(p, card)).toBe(true);
  });

  it('shows the card alone on the FM-1, DRUMS’ device driven by its own track: no Drum map, no track device, no RATE or SWING row', () => {
    const p = kit();
    const devices = devicesOf(p, DEFS);
    expect(devices.some((d) => d.module !== undefined && ['drummap', 'steps'].includes(p.modules.find((m) => m.id === d.module)?.type ?? ''))).toBe(false);
    const dev = devices.find((d) => d.asm === cardOf(p).id)!;
    expect(dev.track).toBe(drumsOf(p).id);
    const rows = dev.pages.flatMap((pg) => pg.rows);
    expect(rows.filter((r) => r.module === drumsOf(p).id && ['rate', 'swing'].includes(r.param))).toEqual([]);
    expect(rows.some((r) => r.module === drumsOf(p).id && r.param === 'len')).toBe(true);
  });

  it('takes fewer patch bytes than with its Drum maps and DRUMS outside, and links the same pattern store entries', () => {
    const p = kit(), q = unfolded(p), o = outside(p);
    expect(layout(p).counted).toBeLessThan(layout(o).counted);
    for (const x of [q, o]) {
      expect(p.modules.find((m) => m.type === 'fm1')!.seq).toEqual(x.modules.find((m) => m.type === 'fm1')!.seq);
      for (let k = 1; k <= kitDef.patterns.length; k++) expect(encodePayload(p, k)).toEqual(encodePayload(x, k));
    }
  });

  it('plays every pattern of its song sample for sample as with DRUMS, and with DRUMS and the Drum maps, outside, in the browser engine', () => {
    const p = kit();
    const a = ts(p, secs, 1);
    expect(loud(a)).toBe(true);
    expect(identical(a, ts(unfolded(p), secs, 1))).toBe(true);
    expect(identical(a, ts(outside(p), secs, 1))).toBe(true);
  }, SONG_MS);

  it('plays every pattern of its song sample for sample as with DRUMS, and with DRUMS and the Drum maps, outside, in the FM-1 engine', () => {
    const p = kit();
    const a = fm1(p, secs, 1);
    expect(loud(a)).toBe(true);
    expect(identical(a, fm1(unfolded(p), secs, 1))).toBe(true);
    expect(identical(a, fm1(outside(p), secs, 1))).toBe(true);
  }, SONG_MS);

  // the card's timing rows: PRE-SCALE (808), SCALE and SHUFFLE (909), every position, DRUMS' trigger heard alone
  const timing = (): Patch => {
    const p = FM1_PRESETS[name]();
    const st = drumsOf(p), out = p.modules.find((m) => m.type === 'output')!;
    p.cables = p.cables.filter((c) => c.to.module !== out.id);
    out.params.level = 1;
    connect(p, DEFS, { module: st.id, port: 'trig' }, { module: out.id, port: 'l' });
    st.notes = Array.from({ length: 16 }, (_, at) => ({ at, len: 1, note: 36, vel: 100 }));
    return p;
  };
  /** samples between the triggers from the third step on (the transport's start left out), an on-beat step's first */
  const gaps = (x: Float32Array): number[] => {
    const edges = [...x.keys()].filter((i) => x[i] > 0.5 && (i === 0 || x[i - 1] <= 0.5));
    return edges.slice(3, 11).map((e, i) => e - edges[i + 2]);
  };
  const rows = (p: Patch) => cardOf(p).params.filter((r) => ['pre-scale', 'scale', 'shuffle'].includes(r.label ?? ''));

  it('has its timing rows on the card, each a named Selector into DRUMS', () => {
    const p = timing();
    expect(rows(p).map((r) => r.label)).toEqual(name === '808 Kit' ? ['pre-scale'] : ['shuffle', 'scale']);
    for (const r of rows(p)) {
      const sel = p.modules.find((m) => m.id === r.module)!;
      expect(sel.type).toBe('select');
      expect(r.names?.length).toBe(sel.params.count);
      expect(p.cables.some((c) => c.from.module === sel.id && c.to.module === drumsOf(p).id)).toBe(true);
    }
  });

  it.each(['browser', 'FM-1'] as const)('steps DRUMS as each timing row’s position says, in the %s engine', (engine) => {
    const base = timing();
    const tempo = base.modules.find((m) => m.type === 'fm1')!.params.tempo;
    const halfTick = SR * 60 / tempo / 48;
    for (const r of rows(base)) {
      const seen = new Set<string>();
      for (let k = 1; k <= r.names!.length; k++) {
        const p = structuredClone(base);
        p.modules.find((m) => m.id === r.module)!.params.pos = k;
        const g = gaps(engine === 'browser' ? ts(p, 3) : fm1(p, 3));
        const at = `${r.label} ${r.names![k - 1]}`;
        expect(g.length, at).toBe(8);
        seen.add(g.join(' '));
        if (r.label === 'shuffle') {
          // (SHUFFLE 1..7: the off-beat step later by a sixth of the way to 75 % each; the pair keeps its length)
          const pair = 2 * STEPS_RATE_HT[STEPS_RATES.indexOf('1/16')] * halfTick, swing = 50 + (k - 1) * 25 / 6;
          for (let i = 0; i < 8; i += 2) {
            expect(Math.abs(g[i] - pair * swing / 100), at).toBeLessThanOrEqual(2);
            expect(Math.abs(g[i] + g[i + 1] - pair), at).toBeLessThanOrEqual(1);
          }
        } else {
          const step = STEPS_RATE_HT[STEPS_RATES.indexOf(r.names![k - 1])] * halfTick;
          expect(step, at).toBeGreaterThan(0);
          for (const x of g) expect(Math.abs(x - step), at).toBeLessThanOrEqual(1);
        }
      }
      expect(seen.size, r.label).toBe(r.names!.length);
    }
  }, SONG_MS);
});
