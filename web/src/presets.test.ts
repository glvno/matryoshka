// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { Engine } from './engine';
import { DEFS, DRUM_MAP_DEFAULT, drumRowName } from './modules';
import { devicesOf, homeDevice } from './pages';
import { deviceBudget } from './patchbin';
import { kindOf, switches, toggleTargets } from './buttons';
import { CPU_WARN } from './cpu';
import { FM1_PRESETS } from './presets';
import type { Patch } from './patch';

const SR = 48000;
const KIT_NOTES = [53, 55, 57, 59, 60, 62, 64, 65]; // the white keys from F3, the FM-1's lowest key at octave 0
const WHITE = new Set([0, 2, 4, 5, 7, 9, 11]);

/** a kit's Drum map, DRUMS track and Main, and the rows (1..8) with a gate cable */
function kit(name: string): { p: Patch; rows: number[] } {
  const p = FM1_PRESETS[name]();
  const map = p.modules.find((m) => m.type === 'drummap')!;
  const rows = [...new Set(p.cables.filter((c) => c.from.module === map.id && /^g\d$/.test(c.from.port)).map((c) => +c.from.port.slice(1)))].sort();
  return { p, rows };
}

/** the peak of `n` samples rendered */
function peak(e: Engine, n: number): number {
  const l = new Float32Array(n), r = new Float32Array(n);
  e.render(l, r);
  let m = 0;
  for (let i = 0; i < n; i++) m = Math.max(m, Math.abs(l[i]), Math.abs(r[i]));
  return m;
}

describe('factory drum kits: the keys play the drums out of the box (#141)', () => {
  for (const [name, wired] of [['808 Kit', [1, 2, 3, 4, 5, 6, 7, 8]], ['909 Kit', [1, 2, 3, 4, 5, 6, 7, 8]]] as const) {
    it(`${name}: Main's keys into DRUMS, the rows on the white keys from F3, the steps on the rows, octave -1`, () => {
      const { p, rows } = kit(name);
      const main = p.modules.find((m) => m.type === 'fm1')!;
      const st = p.modules.find((m) => m.type === 'steps' && m.name === 'DRUMS')!;
      const map = p.modules.find((m) => m.type === 'drummap')!;
      expect(p.cables.some((c) => c.from.module === main.id && c.from.port === 'keys' && c.to.module === st.id && c.to.port === 'keys')).toBe(true);
      expect(KIT_NOTES.map((_, r) => map.params[`n${r + 1}`])).toEqual(KIT_NOTES);
      expect(rows).toEqual(wired);
      for (const r of rows) {
        const n = map.params[`n${r}`];
        expect(n >= 53 && n <= 79 && WHITE.has(n % 12), `row ${r}`).toBe(true);
      }
      const hit = new Set(rows.map((r) => map.params[`n${r}`]));
      expect(st.notes!.length).toBeGreaterThan(0);
      for (const n of st.notes!) expect(hit.has(n.note), `step note ${n.note}`).toBe(true);
      expect(p.octave).toBe(-1);
    });

    it(`${name}: transport stopped, nothing armed, each wired row's key sounds; armed, the key still plays through DRUMS`, () => {
      const { p, rows } = kit(name);
      const map = p.modules.find((m) => m.type === 'drummap')!;
      for (const r of rows) {
        const e = new Engine(SR);
        e.load(p);
        expect(peak(e, 4096), `row ${r} before`).toBe(0);
        e.noteOn(map.params[`n${r}`], 1);
        expect(peak(e, 8192), `row ${r}`).toBeGreaterThan(0.01);
      }
      const e = new Engine(SR);
      e.load(p);
      e.arm(p.modules.find((m) => m.type === 'steps')!.id);
      expect(peak(e, 4096)).toBe(0);
      e.noteOn(53, 1);
      expect(peak(e, 8192)).toBeGreaterThan(0.01);
    });
  }

  it('row names: both kits\' rows are the defaults (the 909 Kit\'s hat on row 4, CL HAT, as the 808\'s)', () => {
    const names = (n: string): string[] => {
      const m = FM1_PRESETS[n]().modules.find((x) => x.type === 'drummap')!;
      return [0, 1, 2].map((r) => drumRowName(m.names, r));
    };
    for (const k of ['808 Kit', '909 Kit']) {
      expect(FM1_PRESETS[k]().modules.find((x) => x.type === 'drummap')!.names, k).toBeUndefined();
      expect(names(k), k).toEqual(DRUM_MAP_DEFAULT.slice(0, 3).map((d) => d.name));
    }
  });

  it('a Drum map\'s own defaults stay General MIDI', () => {
    expect(DRUM_MAP_DEFAULT.map((d) => d.note)).toEqual([36, 38, 39, 42, 46, 45, 37, 56]);
  });
});

describe('factory <7PH (a groove box): the 909 Kit\'s drums and a Silver Box on PATTERN, PLAY starts both', () => {
  const parts = (): { p: Patch; mix: number; drums: number; pattern: number } => {
    const p = FM1_PRESETS['<7PH']();
    const out = p.modules.find((m) => m.type === 'output')!.id;
    const mix = p.cables.find((c) => c.to.module === out && p.modules.find((m) => m.id === c.from.module)!.type === 'mixer')!.from.module;
    const drums = p.modules.find((m) => m.type === 'steps' && m.name === 'DRUMS')!.id;
    const pattern = p.modules.find((m) => m.type === 'steps' && m.name === 'PATTERN')!.id;
    return { p, mix, drums, pattern };
  };

  it('keeps its slot (23rd: new factory patches come after it, D-334) and fits the FM-1', () => {
    expect(Object.keys(FM1_PRESETS).indexOf('<7PH')).toBe(22);
    const b = deviceBudget(FM1_PRESETS['<7PH']());
    expect(b.fits, JSON.stringify(b.over)).toBe(true);
  });

  it("Main's keys go into PATTERN (the bass), not DRUMS; one tempo; 16 steps with accents, a slide and a tie; its devices", () => {
    const { p, drums, pattern } = parts();
    const main = p.modules.find((m) => m.type === 'fm1')!;
    expect(main.params.tempo).toBe(124);
    const keysInto = (id: number): boolean => p.cables.some((c) => c.from.module === main.id && c.from.port === 'keys' && c.to.module === id);
    expect(keysInto(pattern)).toBe(true);
    expect(keysInto(drums)).toBe(false);
    const st = p.modules.find((m) => m.id === pattern)!;
    expect(st.params.len).toBe(16);
    const notes = st.notes!;
    expect(notes.some((n) => n.vel === 127)).toBe(true);
    const long = notes.filter((n) => n.len > 1);
    expect(long.some((n) => notes.some((m) => m.at === n.at + 1))).toBe(true); // a slide: the next step starts a note
    expect(long.some((n) => !notes.some((m) => m.at === n.at + 1))).toBe(true); // a tie: the next step rests
    expect(devicesOf(p, DEFS).map((d) => d.name).slice(0, 5)).toEqual(['Main', 'DRUMS', 'Drum map', 'PATTERN', 'Silver Box']);
  });

  it('PLAY: the drums and the bass each sound; unarmed a key plays the bass, DRUMS armed it plays the kit', () => {
    const { p, mix, drums } = parts();
    const only = (levels: Record<string, number>): Patch => {
      const q = structuredClone(p);
      Object.assign(q.modules.find((m) => m.id === mix)!.params, levels);
      return q;
    };
    const render = (q: Patch, run: boolean, key?: number, arm?: number): number => {
      const e = new Engine(SR);
      e.load(q);
      if (arm !== undefined) e.arm(arm);
      e.transport(run);
      if (key !== undefined) e.noteOn(key, 1);
      return peak(e, SR);
    };
    const drumsOnly = only({ l4: 0 }), bassOnly = only({ l1: 0, l2: 0, l3: 0 });
    expect(render(drumsOnly, true)).toBeGreaterThan(0.05);
    expect(render(bassOnly, true)).toBeGreaterThan(0.02);
    expect(render(bassOnly, false, 58)).toBeGreaterThan(0.01);
    expect(render(drumsOnly, false, 53)).toBe(0);
    expect(render(drumsOnly, false, 53, drums)).toBeGreaterThan(0.01);
    expect(render(bassOnly, false, 53, drums)).toBe(0);
  });
});

// the owner, 2026-10-23 (docs/ledger/patches-and-presets.md D-336): every melodic factory patch that can afford them has an
// Arpeggiator on ARP, bypassed, and a 16-step PATTERN track feeding it: Main's keys -> PATTERN -> the arpeggiator -> the
// voice. The drum patches get neither. Oracle V and Algo Four ran past the CPU estimate's warning with them (accepted);
// since the engine's overhead cut (#289) they estimate under it (about 78 % and 80 %). Cassia 1 uses two voices.
// Io 4 (the Jupiter-4's panel) and Vernon
// 100 (the ElectroComp 100's) get the arpeggiator alone: with PATTERN, Io 4 passes the CPU estimate's 100 % (it is about
// 97 % without it) and Vernon 100 the patch bytes
const NO_PLAYERS = ['808 Kit', '909 Kit', '<7PH', 'Spokes 6'];
const PAST_WARNING: string[] = ['Briefcase 3', 'Io 4'];
/** the most a patch past the warning estimates */
const PAST_MAX: Record<string, number> = { 'Io 4': 1, 'Briefcase 3': 0.9 };
const ARP_ONLY = ['Io 4', 'Vernon 100', 'Wanderer', 'Briefcase 3'];
const PLAYED = Object.keys(FM1_PRESETS).filter((n) => !NO_PLAYERS.includes(n));
/** the Arpeggiator alone, no PATTERN (D-336's fallback): Wanderer's switch names (#358) fill the patch bytes PATTERN needs */

/** patterns that were there before (their notes stay); the others' PATTERN is empty */
const OWN_PATTERN = ['Scrounge', 'Meridian 8', 'Perun 4'];
/** the patches whose keys play voices on the white keys from F3 (Drum maps) */
const KEYED = [...OWN_PATTERN, '8 Lire', 'Elvira 2'];

/** the patch without its players: the arpeggiator gone, an empty PATTERN too, what they fed fed by Main's keys (or the
 * PATTERN that has notes) again, ARP free */
function withoutPlayers(src: Patch): Patch {
  const p = structuredClone(src);
  const arp = p.modules.find((m) => m.type === 'arp')!;
  const main = p.modules.find((m) => m.type === 'fm1')!;
  const track = p.modules.find((m) => m.type === 'steps' && m.name === 'PATTERN');
  const empty = !!track && !track.notes?.length;
  const from = empty || !track ? main : track;
  const to = p.cables.filter((c) => c.from.module === arp.id && c.from.port === 'keys').map((c) => c.to);
  const gone = new Set([arp.id, ...(empty ? [track!.id] : [])]);
  p.modules = p.modules.filter((m) => !gone.has(m.id));
  p.cables = p.cables.filter((c) => !gone.has(c.from.module) && !gone.has(c.to.module));
  for (const t of to) p.cables.push({ from: { module: from.id, port: 'keys' }, to: t });
  delete p.modules.find((m) => m.type === 'fm1')!.panel;
  return p;
}

/** n samples of the left channel: `notes` held from sample `at` (block-aligned); ARP pressed at `arpAt` when given (its
 * Toggle is engaged while the arpeggiator is bypassed: pressing it lets go) */
function play(p: Patch, notes: number[], opts: { at?: number; arpAt?: number; run?: boolean; n?: number } = {}): Float32Array {
  const e = new Engine(SR);
  e.load(p);
  e.transport(!!opts.run);
  const n = opts.n ?? SR;
  const out = new Float32Array(n);
  let pos = 0;
  const to = (k: number): void => {
    if (k <= pos) return;
    const l = new Float32Array(k - pos), r = new Float32Array(k - pos);
    e.render(l, r);
    out.set(l, pos);
    pos = k;
  };
  const evs: [number, () => void][] = [[opts.at ?? 0, () => notes.forEach((k) => e.noteOn(k, 1))]];
  if (opts.arpAt !== undefined) evs.push([opts.arpAt, () => e.setButton(6, false)]);
  for (const [at, f] of evs.sort((a, b) => a[0] - b[0])) {
    to(at);
    f();
  }
  to(n);
  return out;
}
const loudest = (x: Float32Array): number => x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);

describe('factory patches: an arpeggiator on ARP and a PATTERN track where they fit (D-336)', () => {
  it('every melodic patch has them, the drum patches do not; none passes the CPU warning', () => {
    expect(PLAYED).toHaveLength(21);
    for (const name of NO_PLAYERS) expect(FM1_PRESETS[name]().modules.some((m) => m.type === 'arp'), name).toBe(false);
    expect(PLAYED.filter((name) => deviceBudget(FM1_PRESETS[name]()).cpu.use > CPU_WARN)).toEqual(PAST_WARNING);
  });

  for (const name of PLAYED)
    it(`${name}: Main's keys -> ${ARP_ONLY.includes(name) ? '' : `PATTERN (16 steps${OWN_PATTERN.includes(name) ? ', its pattern' : ', empty'}) -> `}an Arpeggiator, bypassed, on ARP; it fits; ARP off it plays as before, on it arpeggiates`, () => {
      const p = FM1_PRESETS[name]();
      const main = p.modules.find((m) => m.type === 'fm1')!;
      const arps = p.modules.filter((m) => m.type === 'arp');
      expect(arps).toHaveLength(1);
      const [arp] = arps;
      expect(arp.bypass).toBe(true);
      expect(kindOf(main.panel, 'arp')).toBe('bypass');
      expect(switches(main.panel, 'arp')).toBe(true);
      expect(toggleTargets(p, 'arp')).toEqual([arp.id]);
      const tracks = p.modules.filter((m) => m.type === 'steps');
      expect(tracks.map((t) => t.name)).toEqual(ARP_ONLY.includes(name) ? [] : ['PATTERN']);
      const keys = (a: number, b: number): boolean => p.cables.some((c) => c.from.module === a && c.from.port === 'keys' && c.to.module === b && c.to.port === 'keys');
      const [track] = tracks;
      if (track) {
        expect(track.params.len).toBe(16);
        expect(!!track.notes?.length).toBe(OWN_PATTERN.includes(name));
        expect(keys(main.id, track.id)).toBe(true);
        expect(keys(track.id, arp.id)).toBe(true);
      } else expect(keys(main.id, arp.id)).toBe(true);
      // Main's keys and the track's go nowhere else: everything plays through the arpeggiator
      const firsts = track ? [main.id, track.id] : [main.id];
      expect(p.cables.filter((c) => firsts.includes(c.from.module) && c.from.port === 'keys').map((c) => c.to.module).sort()).toEqual((track ? [track.id, arp.id] : [arp.id]).sort());
      expect(p.cables.some((c) => c.from.module === arp.id && c.from.port === 'keys')).toBe(true);
      const b = deviceBudget(p);
      expect(b.fits, JSON.stringify(b.over)).toBe(true);
      expect(b.cpu.use).toBeLessThanOrEqual(PAST_MAX[name] ?? CPU_WARN);
      // the devices: Main first, then PATTERN, the Output last; the patch does not open on the arpeggiator
      const devs = devicesOf(p, DEFS);
      expect(devs[0].kind).toBe('main');
      if (track) expect(devs[1].module).toBe(track.id);
      expect(devs.at(-1)!.kind).toBe('output');
      expect(devs.find((d) => d.module === arp.id)?.kind).toBe('arp');
      expect(devs[homeDevice(devs)].module).not.toBe(arp.id);
      // ARP off: sample for sample the patch without them, a block later where the empty PATTERN passes the keys through
      const chord = KEYED.includes(name) ? [53, 57] : [48, 55, 60];
      const late = OWN_PATTERN.includes(name) || !track ? 0 : 128;
      const now = play(p, chord, { n: SR / 2 });
      expect(loudest(now)).toBeGreaterThan(0.01);
      expect(now).toEqual(play(withoutPlayers(p), chord, { at: late, n: SR / 2 }));
      // ARP on (a little later): something else, one note at a time
      const arped = play(p, chord, { arpAt: 128 * 4, n: SR / 2 });
      expect(loudest(arped)).toBeGreaterThan(0.01);
      expect(arped.some((x, i) => Math.abs(x - now[i]) > 1e-4)).toBe(true);
    });

  it('notes entered on PATTERN play the voice on PLAY, through the arpeggiator when ARP is on; empty, PLAY alone is silent', () => {
    const p = FM1_PRESETS['Monolith D']();
    expect(loudest(play(p, [], { run: true }))).toBe(0);
    p.modules.find((m) => m.type === 'steps' && m.name === 'PATTERN')!.notes = [{ at: 0, len: 8, note: 48, vel: 100 }, { at: 0, len: 8, note: 55, vel: 100 }];
    const straight = play(p, [], { run: true }), arped = play(p, [], { run: true, arpAt: 0 });
    expect(loudest(straight)).toBeGreaterThan(0.01);
    expect(loudest(arped)).toBeGreaterThan(0.01);
    expect(arped.some((x, i) => Math.abs(x - straight[i]) > 1e-4)).toBe(true);
  });
});
