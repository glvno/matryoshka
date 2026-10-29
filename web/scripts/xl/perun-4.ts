// SPDX-License-Identifier: GPL-3.0-only
// Perun 4 XL: the Erica Synths PERKONS HD-01 in full, after its user manual (PERKONS_manual_10_26.pdf, firmware 1.3, with
// the 1.1 and 1.3 changelogs: "The sound engines", "The tempo & main controls section", "The step sequencer section",
// "Per step play settings", "Modulation settings", "Configuration settings"; the panel drawing on its page 5) and Sound On
// Sound's review. The FM-1 version (gen-assemblies.ts, Perun 4) keeps one algorithm per voice, drops the phase modulation
// it tried for voices 2 and 4, turns the VCF switch into a low pass to high pass sweep and lets its only LFO reach the
// delay time.
//
// Each voice here has the original's eleven controls: TUNE, DECAY, the ALGO switch (three algorithms, row `algo`, 1..3),
// MODE, PARAM 1 and PARAM 2 (three rows per algorithm, named as the manual's table names them and numbered by the
// algorithm: `1 transient`, `1 fold`, `1 pitch env`, `2 wavetable`, ...), CUTOFF, the VCF switch (row `vcf`: 1 low pass,
// 2 band pass, 3 high pass), DRIVE (the overdrive's dry / wet), FX SEND and LEVEL. The VCF has no resonance control on the
// original either (the manual lists none; Sound On Sound: "No resonance control exists"), so neither has this one. A
// switch is a Selector (its row `pos`: 1, 2, 3, ...); it steps from one position to the next, as the original's switches
// do, and never blends two (a cable into its pos, such as the LFO on param 2, picks a position too). DECAY all the way up turns a voice into a drone that sounds with the sequencer stopped: here the row `drone`.
//   voice 1: FOLD DRUM 1 (transient none / noise / pulse; fold, pitch env), WAVETABLE DRUM (wavetable 1..3: the wavetable
//     oscillator's bank; surf = the position, pitch env), SIMPLE DRUM (waveform; pitch env decay, pitch env amount)
//   voice 2: FOLD DRUM 2, WAVETABLE DRUM, COMPLEX DRUM (waveform; the modulating oscillator's frequency into the carrier's
//     phase, pitch env): the phase modulation the FM-1 version left out
//   voice 3: RESONANT DRUMS (snare / bass drum / noise and tone: a struck resonator and a noise burst; noise tone, noise
//     decay), SLAP (an analogue-style clap: a noise band retriggered while a 30 ms window is open; its three modes are
//     three spaces between the repeats; reverb = its tail, crunch = drive), KARPLUS / CHORD (modes 1 and 2: a plucked
//     string with a noise or a pulse burst, edge = damping, twang = a pitch envelope; mode 3, firmware 1.3's CHORD: four
//     wavetable oscillators, param 1 morphs their waveform, param 2 picks the chord: major, minor, sus4, maj7, min7, 7,
//     from two Selectors' value tables)
//   voice 4: NOISE HAT (white / metallic / pulse stack noise; envelope amount = the envelope into its high pass, attack),
//     NOISE/TONE (mode 1, firmware 1.1's DIGITAL NOISE: noise sampled at a rate the tune sets, through a low pass that
//     follows the tune, its own row `2 timbre` for param 1, the attack row for param 2; modes 2 and 3: a phase-modulated
//     square tone and noise at two intervals, envelope amount = the envelope into the phase modulation index, noise / tone
//     mix), ACOUSTIC HATS (the original plays samples of a closed hat, an open hat and a ride; here three synthesized
//     stand-ins; sample rate = a sample-rate reducer, attack). Voice 4's "attack" parameters are its envelope's attack, one
//     row.
// The modulation LFO has the original's seven waves (row `mod wave`: 1 sine, 2 ramp, 3 triangle, 4 pulse, 5 double decay
// saw, 6 saw, 7 random, all made from one rising saw so they share its phase; the double decay saw is two falling squared
// ramps a cycle, our reading of the name), its rate (0.1..20 Hz on the original), SYNC (`mod sync`, then `mod div` is a
// note length on Main's clock and `mod mult` its x8 .. ÷8: at 1/4, the original's x8 .. ÷8 of a beat) and MOD LVL. As on the original it reaches all eight knobs of every voice, each with its own
// depth (`lfo → tune` .. `lfo → level`, the original's 10 .. 80 % of the knob's travel; tune in octaves). CONTROL ALL
// (SHIFT and a knob moves that knob on all four voices) is a row per knob (`all tune` .. `all level`, 0 = as set), added
// to the four voices' own. The realtime voice quantiser (firmware 1.3) is `quantise`: every voice's pitch to semitones.
//
// Each voice track exposes PLAY MODE: forward, backward, ping-pong or random.
// The sequencer: each voice plays its own Steps track (VOICE 1 .. VOICE 4, in front of the engine), so each has its own
// last step (len), time division or multiplication (rate: 1/2 .. 1/64 = ÷8 .. x4, the triplet rates are ÷4/3 and x3/2),
// shuffle (swing), mute, probability (a note's chance) and accent (its velocity). A note's pitch is a TUNE lock that lasts
// until the next trigger, as in firmware 1.3 (C4 = the knob as set). GROOVE (A, B, C, RND: a slight volume variation on
// some steps) is the voice's `groove` row, 1 off, 2 A, 3 B, 4 C, 5 RND; the original's tables are not published, so A, B
// and C are our own eight-step accents on Main's sixteenths and RND a new random level every sixteenth. The keys still play
// the voices (F3 G3 A3 B3) through the empty PATTERN track, the Arpeggiator and the Drum map; the next four rows (C4 D4 E4
// F4) are FILL: held, the voice repeats at its `fill` density (a note length on Main's clock) until let go.
// The master section: the BBD (TIME and its short / long range in one row up to 1.6 s, FEEDBACK, its own sine LFO's rate
// and MOD DEPTH on the time, the COLOUR switch `colour`, 0 bright / 1 dark, the VINTAGE BBD setting's noise `vintage`, BBD
// SYNC `sync` on Main's clock, with 1/32, 1/2T, 1/2D, 1/1T and 1/1D on `sync note`), MASTER SEND (the voices' summed sends into the BBD), VOLUME, and the compressor's COMP.
// THRSHLD (threshold and release on one knob) and COMP. AMT (ratio and make-up gain on one knob).
// Not here: per-step ratchets (x2 .. x5), ODDS (play a step every 2nd .. 8th pass, and inverse odds), per-step parameter locks and recorded automation for any control but TUNE, pattern
// chaining and the master pattern length: each needs a new ability in the Steps module (per-note ratchet, condition and
// parameter-lock fields and a chain), in both engines (issue #351, tiers 2 and 3). The ACOUSTIC HATS samples
// and the SAMPLER P2 CONFIG sample start need the original's samples. The trigger inputs, individual outputs, per-voice
// and master send / return jacks, clock in / out and MIDI CC map are hardware.
import { addModule, paramUnit, rowDef, type Patch } from '../../src/patch';
import { DEFS } from '../../src/modules';
import { fixNotes, STEP_NOTE, type StepNote } from '../../src/track';
import { players, plugIn, wire } from '../factory-build';
import { around, define, KIT_NOTES, matchLevel } from './def';
import type { Xl } from './xl';

const NOTES = 'After the PERKONS HD-01 manual (1.3): per voice 3 algorithms of 3 modes (CHORD, DIGITAL NOISE too), param 1 / 2, ' +
  'tune, decay, drone, cutoff, VCF LP / BP / HP, drive, send, level. The mod LFO (7 waves, sync) reaches all 8 knobs of each ' +
  'voice; control all; quantiser. Each voice has a track (VOICE 1..4: length, rate, play mode, swing, chance, accent, tune lock), ' +
  'rates ÷8..x4, groove, fills (C4..F4). Mod sync x8..÷8. BBD: colour, vintage, sync to 1/1D; compressor. Switches step, never ' +
  'blend. Not here: ratchets, odds, other locks, pattern chains (need Steps features); hat samples.';

type Pin = 'p1' | 'p2';
type Src = [number, string];
/** where a modulation lands: a parameter (through a pin of its module) or an input port (a crossfader's pos, a ranged pin) */
type Target = { m: number; param?: string; port?: string };
type Row = [string, number, string];
type Algo = { mode: Row; p1: Row; p2: Row; extra?: Row[]; t1: Target[]; t2: Target[] };
type Out = number | Src[];
type V = { col: number; ms: number[]; pb: number; penv: number; env: number; hit: number };

/** a parameter's position in its range (paramUnit): what a macro range takes */
const unit = (type: string, param: string, v: number): number => paramUnit(rowDef(DEFS[type], param)!, v);

/** the voices' eight knobs the modulation LFO and CONTROL ALL reach */
const KNOBS = ['tune', 'decay', 'param 1', 'param 2', 'cutoff', 'drive', 'send', 'level'] as const;

const built = define('Perun 4 XL', (d) => {
  const w = d.wire;
  const pins = new Map<number, Partial<Record<Pin, { param: string; ranged: boolean }>>>();
  const pin = (m: number, p: Pin, param: string, range?: [number, number]): void => {
    d.pin(m, p, param, range);
    const r = pins.get(m) ?? {};
    r[p] = { param, ranged: !!range };
    pins.set(m, r);
  };
  const add = (type: string, col: number, row: number, p: Record<string, number> = {}, o?: { p1?: string }): number => {
    const id = d.add(type, col, row, p);
    if (o?.p1) pin(id, 'p1', o.p1);
    return id;
  };
  /** the additive pin of `m` that turns `param`: one it has already, or a free one */
  const pinFor = (m: number, param: string): Pin => {
    const r = pins.get(m) ?? {};
    for (const p of ['p1', 'p2'] as const) if (r[p]?.param === param && !r[p]!.ranged) return p;
    for (const p of ['p1', 'p2'] as const) if (!r[p]) return (pin(m, p, param), p);
    throw new Error(`Perun 4 XL: no free pin on ${d.module(m).type} ${m} for ${param}`);
  };
  const to = (src: Src, t: Target): void => w(src[0], src[1], t.m, t.port ?? pinFor(t.m, t.param!));
  // the assembly's inputs that feed several ports
  const clockTo: Src[] = [];
  const runTo: Src[] = [];

  const map = add('drummap', 0, 0, Object.fromEntries(KIT_NOTES.map((n, r) => [`n${r + 1}`, n])));
  d.module(map).names = ['VOICE 1', 'VOICE 2', 'VOICE 3', 'VOICE 4', 'FILL 1', 'FILL 2', 'FILL 3', 'FILL 4'];
  const one = add('const', 0, 0.2, { value: 1 });
  /** an n-position switch: a Selector of n positions set to `at` (its row `pos`); its gates g1..gn tell which is on */
  const switchN = (col: number, row: number, n: number, at: number, ms: number[], p: Record<string, number> = {}): { sel: number; out: number; input: (k: number) => Src } => {
    const sel = add('select', col, row, { pos: at, count: n, ...p });
    ms.push(sel);
    return { sel, out: sel, input: (k) => [sel, `in${k}`] };
  };
  const feed = (from: Out, into: Src): void => {
    for (const [m, port] of typeof from === 'number' ? [[from, 'out'] as Src] : from) w(m, port, into[0], into[1]);
  };

  // ---- the modulation LFO: seven waves from one rising saw, MOD LVL after the wave switch
  const mlfo = add('lfo', 0, 1, { wave: 2, rate: 2, depth: 1, sync: 0, div: 6, bpm: 120 });
  clockTo.push([mlfo, 'clk']);
  const m1 = add('math', 0, 1.05); // |saw| and saw > 0
  const ramp = add('scale', 0, 1.1, { gain: -1, offset: 0 });
  const tri = add('scale', 0, 1.15, { gain: 2, offset: -1 });
  const pls = add('scale', 0, 1.2, { gain: 2, offset: -1 });
  const sq = add('math', 0, 1.25); // triangle²
  const sine = add('math', 0, 1.3, { ka: -0.5, off: 1.5 }); // 1.5 t - 0.5 t³: the triangle rounded into a sine
  const nz = add('noise', 0, 1.35, { level: 1, color: 0 });
  const rnd = add('sh', 0, 1.4); // a new random value every cycle
  const dsaw = add('math', 0, 1.45, { ka: 2 }); // a rising saw at twice the rate: 2 saw - pulse
  const fall = add('scale', 0, 1.5, { gain: -0.5, offset: 0.5 });
  const fall2 = add('math', 0, 1.55);
  const dds = add('scale', 0, 1.6, { gain: 2, offset: -1 });
  w(mlfo, 'out', m1, 'a');
  w(mlfo, 'out', ramp, 'in');
  w(m1, 'abs', tri, 'in');
  w(m1, 'cmp', pls, 'in');
  w(tri, 'out', sq, 'a');
  w(tri, 'out', sq, 'b');
  w(sq, 'mul', sine, 'a');
  w(tri, 'out', sine, 'b');
  w(nz, 'out', rnd, 'in');
  w(m1, 'cmp', rnd, 'clock');
  w(mlfo, 'out', dsaw, 'a');
  w(pls, 'out', dsaw, 'b');
  w(dsaw, 'sub', fall, 'in');
  w(fall, 'out', fall2, 'a');
  w(fall, 'out', fall2, 'b');
  w(fall2, 'mul', dds, 'in');
  const waves: Src[] = [[sine, 'mul'], [ramp, 'out'], [tri, 'out'], [pls, 'out'], [dds, 'out'], [mlfo, 'out'], [rnd, 'out']];
  const wsw = switchN(0, 1.7, 7, 3, []);
  waves.forEach((s, k) => feed([s], wsw.input(k + 1)));
  const modOut = add('scale', 0, 2.1, { gain: 0.5, offset: 0 }); // MOD LVL
  w(wsw.out, 'out', modOut, 'in');
  // CONTROL ALL: one Offset per knob, added to the four voices' own; the voice quantiser
  const all = Object.fromEntries(KNOBS.map((k, j) => [k, add('const', 0, 2.2 + j * 0.05, { value: 0 })])) as Record<(typeof KNOBS)[number], number>;
  const quantOn = add('const', 0, 2.7, { value: 0 });

  // ---- GROOVE: three eight-step accent tables and a random level, on Main's sixteenths
  const gclk = add('clkdiv', 6, 2, { div: 6 });
  clockTo.push([gclk, 'clock']);
  runTo.push([gclk, 'reset']);
  const tables = [
    [0.4, -0.3, 0, -0.3, 0.2, -0.3, 0, -0.4],
    [0, -0.3, 0.4, -0.2, 0, -0.3, 0.4, -0.1],
    [0.3, 0.1, -0.3, 0.2, -0.2, 0.3, -0.4, 0],
  ].map((t, k) => {
    const s = add('seq', 6, 2.1 + k * 0.1, { ...Object.fromEntries(t.map((v, j) => [`s${j + 1}`, v])), len: 8, dir: 0, glide: 0, gate: 0 });
    w(gclk, 'out', s, 'clock');
    runTo.push([s, 'reset']);
    return s;
  });
  const grnd = add('sh', 6, 2.4);
  w(nz, 'out', grnd, 'in');
  w(gclk, 'out', grnd, 'clock');
  const grooves: Src[] = [...tables.map((s): Src => [s, 'out']), [grnd, 'out']];

  // ---- the master section
  const mix = add('mixer', 6, 0, { l1: 1, l2: 1, l3: 1, l4: 1 });
  const send = add('mixer', 6, 1, { l1: 1, l2: 1, l3: 1, l4: 1 });
  const msend = add('vca', 6, 1.2, { gain: 1 }); // MASTER SEND
  const vintage = add('noise', 6, 1.3, { level: 0, color: 0.4 }); // the VINTAGE BBD's noise
  const dly = add('delay', 7, 1, { time: 300, fb: 0.35, mix: 1, sync: 0 }, { p1: 'time' });
  const lfo = add('lfo', 7, 1.2, { wave: 0, rate: 0.3, depth: 1 }); // the BBD's own LFO
  const toTime = add('scale', 7, 1.3, { gain: 0.02, offset: 0 }); // its MOD DEPTH
  const dark = add('filter', 7, 1.4, { cutoff: 2200, res: 0 });
  const colour = add('xfade', 7, 1.5, { mix: 0 }); // COLOUR: 0 bright, 1 dark
  const comp = add('dyn', 7, 0, { thresh: -14, ratio: 3, attack: 0.005, release: 0.15, gain: 3 });
  const thr = add('macro', 7, 0.2, { value: 0.35 }); // COMP. THRSHLD: the threshold (0 dB .. -40 dB) and the release
  const amt = add('macro', 7, 0.3, { value: 0.29 }); // COMP. AMT: the ratio (1 .. 8) and the make-up gain (0 .. 9 dB)
  const vol = add('vca', 7.5, 0, { gain: 1 }); // VOLUME
  const scope = add('scope', 8, 0, { time: 16 });
  clockTo.push([dly, 'clk']);
  w(send, 'out', msend, 'in');
  w(one, 'out', msend, 'cv');
  w(msend, 'out', dly, 'in');
  w(vintage, 'out', dly, 'in');
  w(lfo, 'out', toTime, 'in');
  w(toTime, 'out', dly, 'p1');
  w(dly, 'out', dark, 'in');
  w(dly, 'out', colour, 'a');
  w(dark, 'lp12', colour, 'b');
  w(mix, 'out', comp, 'in');
  w(colour, 'out', comp, 'in');
  pin(comp, 'p1', 'thresh', [1, 0]);
  pin(comp, 'p1', 'release', [unit('dyn', 'release', 0.08), unit('dyn', 'release', 0.4)]);
  d.module(comp).map!.p1 = ['thresh', 'release'];
  pin(comp, 'p2', 'ratio', [0, unit('dyn', 'ratio', 8)]);
  pin(comp, 'p2', 'gain', [0, unit('dyn', 'gain', 9)]);
  d.module(comp).map!.p2 = ['ratio', 'gain'];
  w(thr, 'out', comp, 'p1');
  w(amt, 'out', comp, 'p2');
  w(comp, 'out', vol, 'in');
  w(one, 'out', vol, 'cv');
  w(vol, 'out', scope, 'a');

  type Voice = { members: number[]; hit: number; out: number; rows: Row[]; algos: Algo[]; lfoRows: Row[]; ins: Record<'trig' | 'accent' | 'lock', Src[]> };

  const voice = (i: number, decay: number, cutoff: number, vcf: number, algo: number, level: number, sendLevel: number, make: (v: V) => [Algo, Out][]): Voice => {
    const col = 1 + i * 1.25;
    const ms: number[] = [];
    const vadd = (type: string, r: number, p: Record<string, number> = {}): number => {
      const id = add(type, col, r, p);
      ms.push(id);
      return id;
    };
    // the hits: the voice's track, its key and its FILL key's repeats; the velocity of the hit that came
    const hit = vadd('logic', 7, { thresh: 0.5 });
    const fill = vadd('lfo', 7.05, { wave: 3, rate: 8, depth: 1, sync: 1, div: 1, bpm: 120 });
    const fand = vadd('logic', 7.1, { thresh: 0.5 });
    const mv1 = vadd('math', 7.15);
    const mv2 = vadd('math', 7.2);
    const mv3 = vadd('math', 7.25);
    const vel = vadd('sh', 7.3);
    const drone = vadd('const', 7.35, { value: 0 });
    const vmax = vadd('math', 7.4);
    clockTo.push([fill, 'clk']);
    w(map, `g${i + 5}`, fill, 'reset');
    w(fill, 'out', fand, 'a');
    w(map, `g${i + 5}`, fand, 'b');
    w(map, `g${i + 1}`, hit, 'a');
    w(fand, 'and', hit, 'a');
    w(map, `v${i + 1}`, mv2, 'a');
    w(map, `g${i + 1}`, mv2, 'b');
    w(map, `v${i + 5}`, mv3, 'a');
    w(fand, 'and', mv3, 'b');
    for (const m of [mv1, mv2, mv3]) w(m, 'mul', vel, 'in');
    w(hit, 'or', vel, 'clock');
    w(vel, 'out', vmax, 'a');
    w(drone, 'out', vmax, 'b');
    // the pitch: tune and the LFO, the track's tune lock and CONTROL ALL, the quantiser
    const env = vadd('env', 0, { l1: 1, r1: 0.001, l2: 0, r2: decay, l3: 0, r3: 0.001, l4: 0, r4: 0.001 });
    const pb = vadd('scale', 0.2, { gain: 0, offset: 0 });
    const tsum = vadd('math', 0.25);
    const qz = vadd('quant', 0.3, { scale: 0, root: 0 });
    const bus = vadd('xfade', 0.35, { mix: 0 });
    const penv = vadd('env', 0.4, { l1: 1, r1: 0.001, l2: 0, r2: 0.05, l3: 0, r3: 0.001, l4: 0, r4: 0.001 });
    w(hit, 'or', env, 'gate');
    w(hit, 'or', penv, 'gate');
    w(modOut, 'out', pb, 'in');
    w(pb, 'out', tsum, 'a');
    w(all.tune, 'out', tsum, 'b');
    w(tsum, 'add', qz, 'in');
    w(tsum, 'add', bus, 'a');
    w(qz, 'out', bus, 'b');
    w(quantOn, 'out', bus, 'pos');
    const sw = switchN(col, 4, 3, algo, ms);
    const made = make({ col, ms, pb: bus, penv, env, hit });
    made.forEach(([, out], k) => feed(out, sw.input(k + 1)));
    const vca = vadd('vca', 5, { gain: 1 });
    const flt = vadd('filter', 5.2, { cutoff, res: 0 });
    const vsw = switchN(col, 5.4, 3, vcf, ms);
    const shp = vadd('shape', 6, { drive: 8, mode: 0, level: 0.5 });
    const drive = vadd('xfade', 6.2, { mix: 0.15 });
    const vv = vadd('vca', 6.4, { gain: 1 }); // the hit's velocity (or the drone)
    const lvl = vadd('vca', 6.5, { gain: level }); // LEVEL
    const snd = vadd('vca', 6.6, { gain: sendLevel }); // FX SEND
    w(sw.out, 'out', vca, 'in');
    w(env, 'env', vca, 'cv');
    w(drone, 'out', vca, 'cv');
    w(vca, 'out', flt, 'in');
    w(flt, 'lp12', ...vsw.input(1));
    w(flt, 'bp', ...vsw.input(2));
    w(flt, 'hp', ...vsw.input(3));
    w(vsw.out, 'out', shp, 'in');
    w(vsw.out, 'out', drive, 'a');
    w(shp, 'out', drive, 'b');
    w(drive, 'out', vv, 'in');
    w(vmax, 'max', vv, 'cv');
    w(vv, 'out', lvl, 'in');
    w(one, 'out', lvl, 'cv');
    w(vv, 'out', snd, 'in');
    w(one, 'out', snd, 'cv');
    w(lvl, 'out', mix, `in${i + 1}`);
    w(snd, 'out', send, `in${i + 1}`);
    // GROOVE: off, A, B, C, RND into the level
    const gsw = switchN(col, 8, 5, 1, ms);
    grooves.forEach((g, k) => feed([g], gsw.input(k + 2)));
    const gamt = vadd('scale', 8.3, { gain: 0.25, offset: 0 });
    w(gsw.out, 'out', gamt, 'in');
    to([gamt, 'out'], { m: lvl, param: 'gain' });
    // the modulation LFO and CONTROL ALL on the eight knobs (tune: pb's gain, CONTROL ALL's tune went in above)
    const algos = made.map(([a]) => a);
    const uniq = (ts: Target[]): Target[] => ts.filter((t, k) => ts.findIndex((u) => u.m === t.m && u.param === t.param && u.port === t.port) === k);
    const targets: Record<Exclude<(typeof KNOBS)[number], 'tune'>, Target[]> = {
      decay: [{ m: env, param: 'r2' }],
      'param 1': uniq(algos.flatMap((a) => a.t1)),
      'param 2': uniq(algos.flatMap((a) => a.t2)),
      cutoff: [{ m: flt, param: 'cutoff' }],
      drive: [{ m: drive, port: 'pos' }],
      send: [{ m: snd, param: 'gain' }],
      level: [{ m: lvl, param: 'gain' }],
    };
    const lfoRows: Row[] = [['lfo → tune', pb, 'gain']];
    Object.entries(targets).forEach(([k, ts], j) => {
      const dep = vadd('scale', 9 + j * 0.05, { gain: 0, offset: 0 });
      w(modOut, 'out', dep, 'in');
      for (const t of ts) {
        to([dep, 'out'], t);
        to([all[k as keyof typeof targets], 'out'], t);
      }
      lfoRows.push([`lfo → ${k}`, dep, 'gain']);
    });
    const rows: Row[] = [
      ['tune', pb, 'offset'], ['decay', env, 'r2'], ['algo', sw.sel, 'pos'],
      ['cutoff', flt, 'cutoff'], ['vcf', vsw.sel, 'pos'], ['drive', drive, 'mix'], ['send', snd, 'gain'], ['level', lvl, 'gain'],
      ['drone', drone, 'value'], ['groove', gsw.sel, 'pos'], ['fill', fill, 'div'],
    ];
    return { members: ms, hit, out: lvl, rows, algos, lfoRows, ins: { trig: [[hit, 'a'], [mv1, 'b']], accent: [[mv1, 'a']], lock: [[tsum, 'b']] } };
  };

  // the oscillators of an algorithm: pitch from the voice's bus and, by `drop`, its pitch envelope
  const pitched = (v: V, osc: number, drop: number): void => {
    w(v.pb, 'out', osc, 'pitch');
    w(v.penv, 'env', drop, 'in');
    w(drop, 'out', osc, 'pitch');
  };
  const at = (v: V, c: number) => (type: string, r: number, p: Record<string, number> = {}, o?: { p1?: string }): number => {
    const id = add(type, v.col + c, r, p, o);
    v.ms.push(id);
    return id;
  };
  const foldDrum = (v: V, coarse: number): [Algo, Out] => {
    const a = at(v, 0.3);
    const osc = a('osc', 1, { wave: 0, coarse, level: 1 });
    const drop = a('scale', 1.1, { gain: 2, offset: 0 });
    const fold = a('shape', 1.2, { drive: 1.2, mode: 2, level: 0.9 });
    pitched(v, osc, drop);
    w(osc, 'out', fold, 'in');
    // the transient: none, a noise click or a pulse click (a 3 ms envelope)
    const cenv = a('env', 1.3, { l1: 1, r1: 0.001, l2: 0, r2: 0.003, l3: 0, r3: 0.001, l4: 0, r4: 0.001 });
    const nzc = a('noise', 1.4, { level: 0.6, color: 0 });
    const pl = a('osc', 1.5, { wave: 3, coarse: 24, level: 0.6 });
    const tr = switchN(v.col + 0.3, 1.6, 3, 2, v.ms);
    const cv = a('vca', 1.9);
    w(v.hit, 'or', cenv, 'gate');
    feed(nzc, tr.input(2));
    feed(pl, tr.input(3));
    w(tr.out, 'out', cv, 'in');
    w(cenv, 'env', cv, 'cv');
    return [{ mode: ['transient', tr.sel, 'pos'], p1: ['fold', fold, 'drive'], p2: ['pitch env', drop, 'gain'], t1: [{ m: fold, param: 'drive' }], t2: [{ m: drop, param: 'gain' }] }, [[fold, 'out'], [cv, 'out']]];
  };
  const wavetableDrum = (v: V, coarse: number): [Algo, Out] => {
    const a = at(v, 0.6);
    const wt = a('wavetable', 1, { bank: 1, pos: 0.3, coarse, level: 1 });
    const drop = a('scale', 1.1, { gain: 0.4, offset: 0 });
    pitched(v, wt, drop);
    return [{ mode: ['wavetable', wt, 'bank'], p1: ['surf', wt, 'pos'], p2: ['pitch env', drop, 'gain'], t1: [{ m: wt, param: 'pos' }], t2: [{ m: drop, param: 'gain' }] }, wt];
  };

  const voices: Voice[] = [
    voice(0, 0.45, 9000, 1, 1, 0.9, 0, (v) => {
      // SIMPLE DRUM: an oscillator (the waveform is the mode); param 1 = the decay of the voice's pitch envelope (the one
      // the other two algorithms use too: one algorithm sounds at a time)
      const a = at(v, 0.9);
      const osc = a('osc', 1, { wave: 1, coarse: -27, level: 1 });
      const drop = a('scale', 1.2, { gain: 2, offset: 0 });
      pitched(v, osc, drop);
      return [foldDrum(v, -27), wavetableDrum(v, -24), [{ mode: ['waveform', osc, 'wave'], p1: ['pitch decay', v.penv, 'r2'], p2: ['pitch env', drop, 'gain'], t1: [{ m: v.penv, param: 'r2' }], t2: [{ m: drop, param: 'gain' }] }, osc]];
    }),
    voice(1, 0.3, 7000, 1, 2, 0.7, 0.2, (v) => {
      // COMPLEX DRUM: a carrier (the waveform is the mode) whose phase follows a sine modulator (param 1 = its frequency)
      const a = at(v, 0.9);
      const car = a('osc', 1, { wave: 0, coarse: -12, pm: 2, level: 1 });
      const md = a('osc', 1.1, { wave: 0, coarse: 7, level: 1 });
      const drop = a('scale', 1.2, { gain: 0.6, offset: 0 });
      const mdrop = a('scale', 1.3, { gain: 0.6, offset: 0 });
      pitched(v, car, drop);
      w(v.pb, 'out', md, 'pitch');
      w(v.penv, 'env', mdrop, 'in');
      w(mdrop, 'out', md, 'pitch');
      w(md, 'out', car, 'pm');
      return [foldDrum(v, -15), wavetableDrum(v, -12), [{ mode: ['waveform', car, 'wave'], p1: ['mod freq', md, 'coarse'], p2: ['pitch env', drop, 'gain'], t1: [{ m: md, param: 'coarse' }], t2: [{ m: drop, param: 'gain' }] }, car]];
    }),
    voice(2, 0.18, 2500, 1, 1, 0.7, 0.3, (v) => {
      const a = (c: number) => at(v, c);
      // RESONANT DRUMS: a 2 ms strike into a resonator (snare, bass drum) or a sine (noise / tone), each with the noise
      // burst (param 1 = its tone, a low pass; param 2 = its decay)
      const r = a(0.3);
      const strike = r('pulse', 1, { time: 0.002 });
      const hitIn = r('scale', 1.1, { gain: 0.05, offset: 0 });
      const sn = r('modal', 1.2, { coarse: -7, decay: 0.15, struct: 0.4, bright: 0.6, damp: 0.4 });
      const bd = r('modal', 1.3, { coarse: -24, decay: 0.4, struct: 0, bright: 0.3, damp: 0.5 });
      const tone = r('osc', 1.4, { wave: 0, coarse: -8, level: 0.9 });
      const nzv = r('noise', 1.5, { level: 1, color: 0 });
      const nlp = r('filter', 1.6, { cutoff: 5000, res: 0 });
      const nenv = r('env', 1.7, { l1: 1, r1: 0.001, l2: 0, r2: 0.12, l3: 0, r3: 0.001, l4: 0, r4: 0.001 });
      const nvca = r('vca', 1.8);
      w(v.hit, 'or', strike, 'trig');
      w(strike, 'out', hitIn, 'in');
      w(hitIn, 'out', sn, 'in');
      w(hitIn, 'out', bd, 'in');
      w(v.pb, 'out', sn, 'pitch');
      w(v.pb, 'out', bd, 'pitch');
      w(v.pb, 'out', tone, 'pitch');
      w(v.hit, 'or', nenv, 'gate');
      w(nzv, 'out', nlp, 'in');
      w(nlp, 'lp12', nvca, 'in');
      w(nenv, 'env', nvca, 'cv');
      const kinds = ([[sn, 0.6], [bd, 0.15], [tone, 0.6]] as const).map(([src, n], k) => {
        const m = r('mixer', 2 + k * 0.1, { l1: 1, l2: n, l3: 0, l4: 0 });
        w(src, 'out', m, 'in1');
        w(nvca, 'out', m, 'in2');
        return m;
      });
      const rd = switchN(v.col + 0.3, 2.4, 3, 1, v.ms);
      kinds.forEach((m, k) => feed(m, rd.input(k + 1)));
      // SLAP: a 30 ms window opens; while open, a square at the burst rate (the mode: three spaces between the repeats)
      // retriggers a short noise band; then the tail (param 1, "reverb"), all through a drive (param 2, crunch)
      const s = a(0.6);
      const win = s('pulse', 1, { time: 0.03 });
      const rate = s('osc', 1.1, { wave: 3, coarse: -24, level: 1 }); // (an Oscillator: an LFO stops at 40 Hz)
      // the mode: a Selector's table of three places in the rate's range
      const spacing = s('select', 1.15, { pos: 2, count: 3, v1: 0, v2: 0.5, v3: 1 });
      const and = s('logic', 1.2, { thresh: 0.5 });
      const benv = s('env', 1.3, { l1: 1, r1: 0.001, l2: 0, r2: 0.008, l3: 0, r3: 0.001, l4: 0, r4: 0.001 });
      const cbp = s('filter', 1.5, { cutoff: 1200, res: 0.5 });
      const bv = s('vca', 1.6);
      const tenv = s('env', 1.7, { l1: 1, r1: 0.001, l2: 0, r2: 0.15, l3: 0, r3: 0.001, l4: 0, r4: 0.001 });
      const tv = s('vca', 1.8, { gain: 0.5 });
      const crunch = s('shape', 1.9, { drive: 2, mode: 0, level: 0.7 });
      pin(rate, 'p1', 'coarse', [unit('osc', 'coarse', -36), unit('osc', 'coarse', -12)]); // 33, 65 or 131 repeats a second
      w(spacing, 'out', rate, 'p1');
      w(v.hit, 'or', win, 'trig');
      w(v.hit, 'or', rate, 'sync');
      w(v.hit, 'or', tenv, 'gate');
      w(win, 'out', and, 'a');
      w(rate, 'out', and, 'b');
      w(and, 'and', benv, 'gate');
      w(nzv, 'out', cbp, 'in');
      w(cbp, 'bp', bv, 'in');
      w(cbp, 'bp', tv, 'in');
      w(benv, 'env', bv, 'cv');
      w(tenv, 'env', tv, 'cv');
      w(bv, 'out', crunch, 'in');
      w(tv, 'out', crunch, 'in');
      // KARPLUS / CHORD: modes 1 and 2 a plucked string, its burst noise or pulse (edge = damping, twang = a pitch
      // envelope); mode 3 the CHORD of firmware 1.3: four wavetable oscillators, param 1 their waveform, param 2 the chord.
      // Param 1 and 2 are Macros, as each turns two things.
      const k3 = a(0.9);
      const str = k3('string', 1, { decay: 0.6, damp: 0.3, burst: 0, coarse: -5, level: 0.8 });
      const twang = k3('scale', 1.1, { gain: 0.1, offset: 0 });
      const edge = k3('macro', 1.15, { value: 0.3 });
      const twm = k3('macro', 1.2, { value: 0.25 });
      const ks = switchN(v.col + 0.9, 1.3, 3, 1, v.ms);
      w(v.hit, 'or', str, 'gate');
      w(v.pb, 'out', str, 'pitch');
      w(v.penv, 'env', twang, 'in');
      w(twang, 'out', str, 'pitch');
      pin(str, 'p1', 'burst', [0, 1]); // mode 2's gate: 0 noise, 1 pulse
      w(ks.sel, 'g2', str, 'p1');
      pin(str, 'p2', 'damp', [0, 1]);
      w(edge, 'out', str, 'p2');
      pin(twang, 'p1', 'gain', [unit('scale', 'gain', 0), unit('scale', 'gain', 0.4)]);
      w(twm, 'out', twang, 'p1');
      // the chord: param 2 (0..1) picks 1..6 on two Selectors, each a table of the chords' third and top (octaves); the
      // fifth is its oscillator's coarse tune
      const chord = (row: number, sts: number[]): number => {
        const sel = k3('select', row, { pos: 1, count: 6, ...Object.fromEntries(sts.map((st, k) => [`v${k + 1}`, st / 12])) });
        w(twm, 'out', sel, 'pos');
        return sel;
      };
      const third = chord(1.6, [4, 3, 5, 4, 3, 4]); // major, minor, sus4, maj7, min7, 7
      const top = chord(1.7, [12, 12, 12, 11, 10, 10]);
      const wts = [undefined, third, undefined, top].map((interval, k) => {
        const wt = k3('wavetable', 2.8 + k * 0.05, { bank: 1, pos: 0.3, coarse: k === 2 ? 2 : -5, level: 0.3 });
        w(v.pb, 'out', wt, 'pitch');
        if (interval !== undefined) w(interval, 'out', wt, 'pitch');
        pin(wt, 'p1', 'pos', [0, 1]);
        w(edge, 'out', wt, 'p1');
        return wt;
      });
      feed(str, ks.input(1));
      feed(str, ks.input(2));
      feed(wts.map((x): Src => [x, 'out']), ks.input(3));
      return [
        [{ mode: ['resonant', rd.sel, 'pos'], p1: ['noise tone', nlp, 'cutoff'], p2: ['noise decay', nenv, 'r2'], t1: [{ m: nlp, param: 'cutoff' }], t2: [{ m: nenv, param: 'r2' }] }, rd.out],
        [{ mode: ['spacing', spacing, 'pos'], p1: ['reverb', tv, 'gain'], p2: ['crunch', crunch, 'drive'], t1: [{ m: tv, param: 'gain' }], t2: [{ m: crunch, param: 'drive' }] }, crunch],
        [{ mode: ['mode', ks.sel, 'pos'], p1: ['edge/wave', edge, 'value'], p2: ['twang/chord', twm, 'value'], t1: [{ m: str, port: 'p2' }, ...wts.map((x) => ({ m: x, port: 'p1' }))], t2: [{ m: twang, port: 'p1' }, { m: third, port: 'pos' }, { m: top, port: 'pos' }] }, ks.out],
      ];
    }),
    voice(3, 0.06, 6000, 3, 1, 0.5, 0.15, (v) => {
      const a = (c: number) => at(v, c);
      // NOISE HAT: white noise, metallic noise (a detuned square cluster with noise) or a pulse stack (two squares with
      // noise); its own high pass, which the envelope sweeps by param 1
      const h = a(0.3);
      const wn = h('noise', 1, { level: 1, color: 0 });
      const metal = h('osc', 1.1, { wave: 3, coarse: 38, level: 0.6, unison: 5, detune: 90, pw: 0.3 });
      const sq1 = h('osc', 1.2, { wave: 3, coarse: 31, pw: 0.3, level: 0.6 });
      const sq2 = h('osc', 1.3, { wave: 3, coarse: 37, fine: 40, pw: 0.4, level: 0.6 });
      const hs = switchN(v.col + 0.3, 1.6, 3, 3, v.ms);
      feed(wn, hs.input(1));
      feed([[metal, 'out'], [wn, 'out']], hs.input(2));
      feed([[sq1, 'out'], [sq2, 'out'], [wn, 'out']], hs.input(3));
      const hp = h('filter', 2.1, { cutoff: 4000, res: 0 });
      const hamt = h('scale', 2.2, { gain: 1, offset: 0 });
      w(hs.out, 'out', hp, 'in');
      w(v.env, 'env', hamt, 'in');
      w(hamt, 'out', hp, 'cv');
      // NOISE/TONE: mode 1 DIGITAL NOISE (firmware 1.1: noise sampled at a rate the tune sets, through a low pass that
      // follows the tune, `timbre`); modes 2 and 3 a square whose phase follows a sine at two intervals (param 1 = how far
      // the envelope opens the modulation), crossfaded with noise (param 2)
      const t = a(0.6);
      const tone = t('osc', 1, { wave: 3, coarse: 30, pm: 0.5, level: 0.7 }, { p1: 'pm' });
      const tmod = t('osc', 1.1, { wave: 0, coarse: 37, level: 1 });
      const pamt = t('scale', 1.2, { gain: 2, offset: 0 });
      const nt = t('xfade', 1.4, { mix: 0.5 });
      const dck = t('osc', 1.5, { wave: 3, coarse: 48, level: 1 });
      const dsh = t('sh', 1.55);
      const dnf = t('filter', 1.6, { cutoff: 12000, res: 0 });
      const ns = switchN(v.col + 0.6, 1.7, 3, 2, v.ms);
      w(v.pb, 'out', tone, 'pitch');
      w(v.pb, 'out', tmod, 'pitch');
      w(tmod, 'out', tone, 'pm');
      w(v.env, 'env', pamt, 'in');
      w(pamt, 'out', tone, 'p1');
      w(wn, 'out', nt, 'a');
      w(tone, 'out', nt, 'b');
      pin(tmod, 'p1', 'coarse', [unit('osc', 'coarse', 37), unit('osc', 'coarse', 43)]); // mode 3's gate: a fifth, an octave
      w(ns.sel, 'g3', tmod, 'p1');
      w(v.pb, 'out', dck, 'pitch');
      w(wn, 'out', dsh, 'in');
      w(dck, 'out', dsh, 'clock');
      w(dsh, 'out', dnf, 'in');
      w(v.pb, 'out', dnf, 'cv');
      w(dnf, 'lp12', ...ns.input(1));
      feed(nt, ns.input(2));
      feed(nt, ns.input(3));
      // ACOUSTIC HATS: stand-ins for the original's samples, a closed hat, an open hat and a ride (a bell of phase-
      // modulated sines with noise), through a sample-rate reducer (param 1)
      const s = a(0.9);
      const ah = s('osc', 1, { wave: 3, coarse: 40, level: 0.6, unison: 5, detune: 70, pw: 0.4 });
      const ahp = s('filter', 1.2, { cutoff: 7000, res: 0 });
      const cl = s('env', 1.3, { l1: 1, r1: 0.001, l2: 0, r2: 0.05, l3: 0, r3: 0.001, l4: 0, r4: 0.001 });
      const op = s('env', 1.4, { l1: 1, r1: 0.001, l2: 0, r2: 0.5, l3: 0, r3: 0.001, l4: 0, r4: 0.001 });
      const clv = s('vca', 1.5);
      const opv = s('vca', 1.6);
      const bell = s('osc', 1.7, { wave: 0, coarse: 26, pm: 3, level: 0.5 });
      const bmod = s('osc', 1.8, { wave: 0, coarse: 43, fine: 30, level: 1 });
      w(ah, 'out', ahp, 'in');
      w(wn, 'out', ahp, 'in');
      w(v.hit, 'or', cl, 'gate');
      w(v.hit, 'or', op, 'gate');
      w(ahp, 'hp', clv, 'in');
      w(ahp, 'hp', opv, 'in');
      w(cl, 'env', clv, 'cv');
      w(op, 'env', opv, 'cv');
      w(v.pb, 'out', ah, 'pitch');
      w(v.pb, 'out', bell, 'pitch');
      w(v.pb, 'out', bmod, 'pitch');
      w(bmod, 'out', bell, 'pm');
      const as = switchN(v.col + 0.9, 2.0, 3, 1, v.ms);
      feed(clv, as.input(1));
      feed(opv, as.input(2));
      feed([[bell, 'out'], [ahp, 'hp']], as.input(3));
      const sr = s('crush', 2.5, { bits: 16, rate: 1 });
      w(as.out, 'out', sr, 'in');
      const attack: Target = { m: v.env, param: 'r1' };
      return [
        [{ mode: ['noise', hs.sel, 'pos'], p1: ['env amount', hamt, 'gain'], p2: ['attack', v.env, 'r1'], t1: [{ m: hamt, param: 'gain' }], t2: [attack] }, [[hp, 'hp']]],
        [{ mode: ['mode', ns.sel, 'pos'], p1: ['env amount', pamt, 'gain'], p2: ['noise/tone', nt, 'mix'], extra: [['timbre', dnf, 'cutoff']], t1: [{ m: pamt, param: 'gain' }, { m: dnf, param: 'cutoff' }], t2: [{ m: nt, port: 'pos' }, attack] }, ns.out],
        [{ mode: ['sample', as.sel, 'pos'], p1: ['sample rate', sr, 'rate'], p2: ['attack', v.env, 'r1'], t1: [{ m: sr, param: 'rate' }], t2: [attack] }, sr],
      ];
    }),
  ];
  voices.forEach((v, i) => d.nest(`voice ${i + 1}`, 1 + i * 1.25, 0, v.members, { inputs: [['trig', v.hit, 'a']], outputs: [['out', v.out, 'out']] }));
  d.input('keys', map, 'keys');
  d.input('clock', clockTo[0][0], clockTo[0][1], ...clockTo.slice(1));
  d.input('run', runTo[0][0], runTo[0][1], ...runTo.slice(1));
  voices.forEach((v, i) => {
    for (const k of ['trig', 'accent', 'lock'] as const) d.input(`${k} ${i + 1}`, v.ins[k][0][0], v.ins[k][0][1], ...v.ins[k].slice(1));
  });
  d.output('out', vol, 'out');
  const shown = new Set<string>();
  voices.forEach((v, i) => {
    const r = (name: string): Row => v.rows.find((x) => x[0] === name)!;
    // the FM-1 version's rows in its order (param 1 / 2: the first algorithm's), then the rest of the voice
    const first = (row: Row, o: { head?: string; col?: boolean } = {}): void => {
      d.param(row[0], row[1], row[2], o);
      shown.add(`${row[1]}.${row[2]}`);
    };
    first(r('tune'), { head: `voice ${i + 1}`, col: true });
    first(r('decay'));
    first(r('algo'));
    v.algos.forEach((a, k) => {
      for (const [n, row] of [['mode', a.mode], ['param 1', a.p1], ['param 2', a.p2], ...(a.extra ?? []).map((x) => ['extra', x] as const)] as const) {
        if (shown.has(`${row[1]}.${row[2]}`)) continue; // (voice 4's attack: one row)
        d.param(row[2] === 'r1' ? row[0] : `${k + 1} ${row[0]}`, row[1], row[2], k === 0 && n === 'mode' ? { group: true } : {});
        shown.add(`${row[1]}.${row[2]}`);
      }
    });
    first(r('cutoff'), { head: `voice ${i + 1} out` });
    for (const n of ['vcf', 'drive', 'send', 'level', 'drone', 'groove', 'fill']) first(r(n));
    v.lfoRows.forEach((row, k) => d.param(row[0], row[1], row[2], k === 0 ? { head: `voice ${i + 1} lfo` } : {}));
  });
  d.param('time', dly, 'time', { col: true, head: 'bbd' });
  d.param('feedback', dly, 'fb');
  d.param('lfo rate', lfo, 'rate');
  d.param('mod depth', toTime, 'gain');
  d.param('colour', colour, 'mix');
  d.param('vintage', vintage, 'level');
  d.param('sync', dly, 'sync');
  d.param('sync note', dly, 'note');
  d.param('mod wave', wsw.sel, 'pos', { head: 'modulation' });
  d.param('mod rate', mlfo, 'rate');
  d.param('mod sync', mlfo, 'sync');
  d.param('mod div', mlfo, 'div');
  d.param('mod mult', mlfo, 'mult');
  d.param('mod lvl', modOut, 'gain');
  KNOBS.forEach((k, j) => d.param(`all ${k}`, all[k], 'value', j === 0 ? { head: 'control all' } : {}));
  d.param('quantise', quantOn, 'value');
  d.param('volume', vol, 'gain', { head: 'master' });
  d.param('master send', msend, 'gain');
  d.param('comp thrshld', thr, 'value');
  d.param('comp amt', amt, 'value');
  d.param('out', scope, 'view', { col: true });
});
// drums are played by short trigs: every envelope is one-shot (gen-assemblies.ts does the same for its Drums shelf)
for (const m of built.def.modules) if (m.type === 'env') m.params.shot = 1;

/** the voices' tracks: the FM-1 version's PATTERN split by row, each note a C4 (no tune lock) with its accent */
const TRACKS = KIT_NOTES.slice(0, 4);

export const xl: Xl = {
  base: 'Perun 4',
  build: (fm1: Patch): Patch => {
    const x = around('Perun 4', built);
    const p = x.p;
    p.notes = NOTES;
    // the keys pass through an empty PATTERN track (the Arpeggiator goes after it: players) into the Drum map
    const pattern = fm1.modules.find((m) => m.type === 'steps' && m.name === 'PATTERN')!;
    const into = x.a.inputs.find((r) => r.label === 'keys')!;
    p.cables = p.cables.filter((c) => !(c.from.module === x.main.id && c.from.port === 'keys'));
    const st = addModule(p, DEFS.steps, 20, 300);
    st.name = 'PATTERN';
    st.notes = [];
    wire(p, x.main.id, 'keys', st.id, 'keys');
    for (const t of [into, ...(into.also ?? [])]) wire(p, st.id, 'keys', t.module, t.port);
    plugIn(p, x.main.id, 'clock', x.a, 'clock');
    plugIn(p, x.main.id, 'run', x.a, 'run');
    TRACKS.forEach((note, i) => {
      const t = addModule(p, DEFS.steps, 20, 600 + 300 * i);
      t.name = `VOICE ${i + 1}`;
      Object.assign(t.params, pattern.params);
      t.notes = fixNotes((pattern.notes ?? []).filter((n) => n.note === note).map((n): StepNote => ({ ...n, note: STEP_NOTE })));
      plugIn(p, t.id, 'trig', x.a, `trig ${i + 1}`);
      plugIn(p, t.id, 'vel', x.a, `accent ${i + 1}`);
      plugIn(p, t.id, 'pitch', x.a, `lock ${i + 1}`);
    });
    p.octave = -1;
    const q = players(p, true);
    matchLevel(q, fm1, KIT_NOTES.slice(0, 4));
    return q;
  },
};
