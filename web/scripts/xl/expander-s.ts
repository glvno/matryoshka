// SPDX-License-Identifier: GPL-3.0-only
// Expander S XL: the Oberheim Eight Voice, eight whole SEMs and the keyboard that plays them, where the FM-1 version
// (scripts/gen-assemblies.ts, Expander S: four voices on one shared card) had to cut. Sources: the reference manual of
// the tomoberheim SEM (Marion Systems, 2009: every front panel control of the SEM, which follows the 1974 module);
// J. Paradiso's Oberheim 4-Voice MIDI Interface manual (MIT, 1990: the keyboard module's switches, item by item); the
// Sound International review of the Four Voice (May 1978); Cherry Audio's Eight Voice user guide (2024: the envelope
// routing, the Eight Voice's history; its own additions are not taken); Arturia's Oberheim SEM V manual (2014).
//
// Each SEM is its own nested assembly with every knob of its own, as on the original (eight SEMs, eight sets of knobs):
//  - VCO 1 and VCO 2: frequency (`freq`, semitones) and `fine`, pulse width, the MODULATION knob as two rows (left of
//    centre the frequency, `fm`; right of centre the pulse width, `pwm`) and its source switch (`src`: 0 the envelope,
//    1 the LFO; VCO 1 takes envelope 1, VCO 2 envelope 2); `sync` (VCO 2 hard-synced to VCO 1).
//  - The filter's input mixer: each VCO's knob turns up its saw or its pulse (`wave` picks which, `vco 1` / `vco 2` the
//    level, a VCA after the oscillator; centre = off is level 0).
//  - The VCF: `cutoff`, `resonance`, `mode` (low pass, notch at the centre, high pass: a crossfade of the low and high
//    pass outputs, as the SEM's pot), `bp` (band pass), the MODULATION knob (`vcf mod`, either direction) and its source
//    switch (`vcf src`: 0 envelope 2, 1 the LFO).
//  - Two ADS envelopes (`env 1 attack`, `decay`, `sustain`; `env 2` the same): the decay is also the release, as on the
//    SEM. Attack and decay are Macros, 0..1 (0 = 1 ms, 1 = 5 s, logarithmic), each pinned to the envelope; the sustain is
//    the envelope's own. Envelope 1 opens the VCA, envelope 2 is the filter's.
//  - The LFO (a sine, `lfo rate`); `vca on` (the VCA held open: a drone); the output module's `level` and `pan`.
//  - A slow pitch drift of its own (`drift` on the keyboard sets it for all eight: the SEMs were never quite in tune).
// The keyboard: three Voicings play the SEMs. One holds all eight (no split): `unison` (every SEM on the one note),
// `assign` (rotate = CONT, lowest = RESET, reuse = REASSIGN), `priority` (which note unison plays). With `split` on, the
// lower part of the keybed (up to `lower top`) plays SEMs 1 up, the upper part (from `upper bottom`) SEMs 8 down,
// `lower voices` / `upper voices` SEMs each (4-4; 1-3, 2-2, 3-1 on the Four Voice; they should add up to eight), each with
// its own unison (the split's duophonic unison). Portamento: its time, and a switch per half (`porta lower`,
// `porta upper`: both on = BOTH; without split the SEMs glide when either is on). `octave` transposes every SEM (octaves:
// the keyboard's OCTAVE switch), `tune` the master tune (octaves), `vcf` the keyboard's VCF knob (moves every SEM's
// cutoff, 2 octaves per unit). Pitch bend (the master tune's centre-stop bend) comes in with the keys. Switches are 0..1
// rows (a Crossfader or a Macro). The card: all SEMs, the keyboard, the split, then a section per SEM.
// All SEMs: a row per SEM control (the same labels) that moves it on all eight at once, added to each SEM's own setting,
// so their differences stay (0 = no change; the programmer did the like, adding a voltage to the knob settings: Cherry
// Audio's guide). An Offset per row goes into every SEM's parameter input (pin) or cv input, through a Scale so that one
// unit is one unit of the SEM's row. Units: `freq` octaves, `fine` semitones, `cutoff` and `lfo rate` octaves, the
// switches (`src`, `sync`, `mode`, `bp`, `vcf src`, `vca on`) and `wave` in their own steps (+1 = one position up; they
// stop at the ends), attack and decay in their Macro's 0..1, the rest in the row's own unit. A SEM's row shows its own
// setting; what it plays is that plus the all-SEMs row. The all-SEMs sustain: each envelope has two shadows, one with
// sustain 1 and one with 0 (the same attack and decay), and adds x times their difference, which moves its sustain by x
// and leaves its attack alone. No row overrides: every all-SEMs row is an offset.
// How a Voicing reaches one SEM: a Voicing's voices run on the cards of a poly assembly, and what leaves the cards is their
// sum. So each card sends its pitch and gate as one signal times "my voice number is at least j" (j = 1 .. 7 or 8), and
// outside, SEM j takes the sum for j - 1 less the sum for j: exactly voice j's, split back into pitch and gate. A split
// Voicing's cards also count themselves (the sum of a 1 on every card is its number of voices) to know their voice
// number at any voice count.
// Not here: the SEMs' EXT positions and the patch panel's jacks (external audio, modulation and control inputs, the
// LFO trigger: hardware jacks), the programmer's cassette interface (hardware), the keyboard's R/C assign mode (the first
// note after all keys are up goes to voice 1, then cyclic: a Voicing assign mode that does not exist yet). The programmer's
// sixteen programs are the patch's presets. The SEM has no sub oscillator and no noise, and neither has this.
import { DEFS } from '../../src/modules';
import { validatePatch } from '../../src/patch';
import { level, players } from '../factory-build';
import { around, define, type Def } from './def';
import type { Xl } from './xl';

/** each SEM's own spread (the FM-1 version's flaws, then four more): cents of tune, semitones of cutoff, % of the
 * envelope times, % of the level */
const SPREAD = [
  { detune: 3, bright: 1, env: 3, level: 100 }, { detune: -4, bright: -1, env: -4, level: 96 },
  { detune: 2, bright: 0, env: 5, level: 100 }, { detune: -2, bright: 2, env: -3, level: 97 },
  { detune: -3, bright: -2, env: 2, level: 98 }, { detune: 4, bright: 1, env: -5, level: 100 },
  { detune: -1, bright: -1, env: 4, level: 96 }, { detune: 2, bright: 2, env: -2, level: 99 },
];
const SEMS = 8;
/** a log parameter's unit position (paramUnit) for a value */
const unitOf = (type: string, param: string, v: number): number => {
  const pd = DEFS[type].params.find((q) => q.name === param)!;
  return Math.log(v / pd.min) / Math.log(pd.max / pd.min);
};
/** the decay Macro's range on an ADSR's release: the same seconds as on its decay (whose range is shorter) */
const RELEASE_RANGE = Math.log(5000) / Math.log(8000);

type End = [number, string];

const built = define('Expander S XL', (b: Def) => {
  // ---- the keyboard
  const all = b.add('alloc', 0, 0, { voices: SEMS });
  const lo = b.add('alloc', 0, 4, { voices: 4, high: 59 });
  const hi = b.add('alloc', 0, 8, { voices: 4, low: 60 });
  const split = b.add('macro', 3, 0, { value: 0 });
  const portaTime = b.add('macro', 3, 0.5, { value: 0.5 });
  const portaLo = b.add('macro', 3, 1, { value: 0 });
  const portaHi = b.add('macro', 3, 1.5, { value: 0 });
  const portaAny = b.add('math', 3, 2, { ka: 1, kb: 1, off: 0 });
  b.wire(portaLo, 'out', portaAny, 'a');
  b.wire(portaHi, 'out', portaAny, 'b');
  const drift = b.add('macro', 3, 2.5, { value: 0.25 });
  const octave = b.add('const', 3, 3, { value: 0 });
  const tune = b.add('const', 3, 3.5, { value: 0 });
  const vcf = b.add('const', 3, 4, { value: 0 });
  const unity = b.add('const', 3, 4.5, { value: 1 });

  // ---- all SEMs at once: an Offset per row (0 = no change), added to each SEM's own setting through a parameter input
  // or a cv input, through a Scale when the row's unit is not that input's
  const allRows: [string, number][] = [];
  const allRow = (label: string, unit?: number): End => {
    const c = b.add('const', 4, 0.25 * allRows.length, { value: 0 });
    allRows.push([label, c]);
    if (unit === undefined) return [c, 'out'];
    const s = b.add('scale', 4.5, 0.25 * allRows.length, { gain: unit, offset: 0 });
    b.wire(c, 'out', s, 'in');
    return [s, 'out'];
  };
  const GAIN = 1 / 8; // a Scale's gain: a pin moves it by 8 per unit
  const vcoRows = (n: string) => ({
    freq: allRow(`vco ${n} freq`), // octaves, into the pitch
    fine: allRow(`vco ${n} fine`, 1 / 12), // semitones
    pw: allRow(`vco ${n} pw`, 1 / 0.9),
    src: allRow(`vco ${n} src`),
    fm: allRow(`vco ${n} fm`, GAIN),
    pwm: allRow(`vco ${n} pwm`, GAIN),
  });
  const ALL = {
    vco: [vcoRows('1'), vcoRows('2')],
    sync: allRow('sync', GAIN),
    mix: ['1', '2'].map((n) => ({ wave: allRow(`vco ${n} wave`, 1 / 3), level: allRow(`vco ${n}`, 1 / 2) })),
    cutoff: allRow('cutoff', 1 / 2), // octaves, into the cv (2 octaves per unit)
    res: allRow('resonance'),
    mode: allRow('mode'),
    bp: allRow('bp'),
    fsrc: allRow('vcf src'),
    famt: allRow('vcf mod', GAIN),
    env: ['1', '2'].map((n) => {
      const attack = allRow(`env ${n} attack`);
      const decay = allRow(`env ${n} decay`);
      const sustain = allRow(`env ${n} sustain`);
      const less = b.add('scale', 5, 0.25 * allRows.length, { gain: -1, offset: 0 });
      b.wire(...sustain, less, 'in');
      return { attack, decay, sustain, less: [less, 'out'] as End };
    }),
    lfo: allRow('lfo rate', 1 / Math.log2(2000)), // octaves (a pin moves a log parameter by its range per unit)
    vcaOn: allRow('vca on'),
    level: allRow('level', 1 / 2),
    pan: allRow('pan'),
  };

  /**
   * A Voicing's rack of cards that hands each voice to one SEM. A card sends its pitch and gate as one signal (pitch +
   * 16 x gate: a pitch stays within +-8 octaves), and that times "my voice number >= j" for j = 1 .. top: a Crossfader
   * from nothing to it whose position is twice the voice number plus 1 - 2 j (an Offset outside, one per j, that every card
   * shares), which is 1 or more from voice j up and -1 or less below. `counted`: the cards count themselves (a split
   * Voicing, whose voice count is a row). Returns where each seat's signal comes out (seat s = voice s: 1 .. top, and
   * top + 1 for all eight) and the voice count (counted ones).
   */
  const step = Array.from({ length: SEMS }, (_, i) => b.add('const', 0, 12 + 0.25 * i, { value: -1 - 2 * i })); // 1 - 2 j
  const router = (label: string, col: number, row: number, alloc: number, top: number, counted: boolean) => {
    const members: number[] = [];
    const add = (type: string, c: number, r: number, p: Record<string, number>): number => {
      const id = b.add(type, c, r, p);
      members.push(id);
      return id;
    };
    const both = add('math', col, row, { ka: 16, kb: 1, off: 0 }); // 16 x gate + pitch
    b.wire(alloc, 'gate', both, 'a');
    b.wire(alloc, 'pitch', both, 'b');
    let twice: End;
    let count: number | undefined;
    if (counted) {
      count = add('scale', col, row + 0.25, { gain: 0, offset: 1 }); // 1 on every card: the sum is the voice count
      const nm1 = b.add('math', col + 2, row, { ka: 1, kb: 1, off: -1 }); // n - 1, back to every card
      b.wire(count, 'out', nm1, 'a');
      const t = add('math', col, row + 0.5, { ka: 1, kb: 1, off: 1 }); // (index + 1) (n - 1) = twice the voice number
      b.wire(alloc, 'index', t, 'a');
      b.wire(nm1, 'add', t, 'b');
      twice = [t, 'mul'];
    } else {
      // eight voices fixed: the index -1 .. 1 is the voice number (0 .. 7) / 3.5 - 1
      const t = add('scale', col, row + 0.5, { gain: 7, offset: 7 });
      b.wire(alloc, 'index', t, 'in');
      twice = [t, 'out'];
    }
    const S: End[] = [[both, 'add']];
    for (let j = 1; j <= top; j++) {
      const at = add('xfade', col + 1, row + 0.25 * j, { mix: 0 });
      b.wire(both, 'add', at, 'b');
      b.wire(...twice, at, 'pos');
      b.wire(step[j - 1], 'out', at, 'pos');
      S.push([at, 'out']);
    }
    b.nest(label, col, row, members, { poly: {}, inputs: [['pitch', both, 'b'], ['gate', both, 'a']] });
    // outside, seat s = the sum for s - 1 less the sum for s
    const seats: End[] = [];
    for (let s = 1; s <= top; s++) {
      const d = b.add('math', col + 2, row + 0.5 + 0.25 * s, { ka: 1, kb: 1, off: 0 });
      b.wire(S[s - 1][0], S[s - 1][1], d, 'a');
      b.wire(S[s][0], S[s][1], d, 'b');
      seats.push([d, 'sub']);
    }
    if (!counted) seats.push(S[top]); // the last seat: all that is "at least top"
    return { seats, count };
  };
  // all eight: seats 1 .. 8 (seat 8 is "at least 7", as there are eight voices); a split Voicing's go to "at least 8", so
  // a voice count over eight cannot land on seat 8
  const rAll = router('voices', 1, 0, all, SEMS - 1, false);
  const rLo = router('lower', 1, 4, lo, SEMS, true);
  const rHi = router('upper', 1, 8, hi, SEMS, true);

  // ---- the eight SEMs
  const mixL = b.add('mixer', 40, 0, { l1: 1, l2: 1, l3: 0, l4: 0 }); // (SEMs 1-4 in in1, 5-8 in in2)
  const mixR = b.add('mixer', 40, 1, { l1: 1, l2: 1, l3: 0, l4: 0 });
  const scope = b.add('scope', 41, 0, { time: 16 });
  b.wire(mixL, 'out', scope, 'a');
  type Sem = Record<string, number>;
  const sems: Sem[] = [];
  for (let k = 1; k <= SEMS; k++) {
    const f = SPREAD[k - 1];
    const c0 = 5 + 4 * ((k - 1) % 4), r0 = 6 * Math.floor((k - 1) / 4);
    const m: Sem = {};
    const add = (name: string, type: string, c: number, r: number, p: Record<string, number> = {}): number => (m[name] = b.add(type, c0 + c, r0 + r, p));
    // which Voicing plays it: all eight, or (split) the lower or the upper part's
    const inLo = b.add('math', c0, r0 + 5.5, { ka: 1, kb: 1, off: 0.5 - k }); // the lower part has k voices or more
    b.wire(rLo.count!, 'out', inLo, 'a');
    const part = b.add('xfade', c0 + 0.3, r0 + 5.5, { mix: 0 });
    b.wire(...rHi.seats[SEMS - k], part, 'a'); // the upper part's voice 9 - k
    b.wire(...rLo.seats[k - 1], part, 'b');
    b.wire(inLo, 'cmp', part, 'pos');
    const sel = b.add('xfade', c0 + 0.6, r0 + 5.5, { mix: 0 });
    b.wire(...rAll.seats[k - 1], sel, 'a');
    b.wire(part, 'out', sel, 'b');
    b.wire(split, 'out', sel, 'pos');
    // and back to a gate (over 8) and a pitch (less 16 x the gate)
    const gateOf = b.add('math', c0 + 0.9, r0 + 5.5, { ka: 1, kb: 1, off: -8 });
    b.wire(sel, 'out', gateOf, 'a');
    const pitchOf = b.add('math', c0 + 1.2, r0 + 5.5, { ka: 1, kb: 16, off: 0 });
    b.wire(sel, 'out', pitchOf, 'a');
    b.wire(gateOf, 'cmp', pitchOf, 'b');
    const pitch: End = [pitchOf, 'sub'], gate: End = [gateOf, 'cmp'];
    // portamento: the glide, on when its half's switch is (without split: either switch)
    const glide = add('glide', 'glide', 0, 0, { time: 0.1 });
    b.wire(...pitch, glide, 'in');
    b.wire(portaTime, 'out', glide, 'p1');
    b.pin(glide, 'p1', 'time', [0, unitOf('glide', 'time', 2)]); // 0 .. 2 s
    const half = add('half', 'xfade', 0, 0.25, { mix: 0 });
    b.wire(portaHi, 'out', half, 'a');
    b.wire(portaLo, 'out', half, 'b');
    b.wire(inLo, 'cmp', half, 'pos');
    const on = add('on', 'xfade', 0, 0.5, { mix: 0 });
    b.wire(portaAny, 'max', on, 'a');
    b.wire(half, 'out', on, 'b');
    b.wire(split, 'out', on, 'pos');
    const pIn = add('pIn', 'xfade', 0, 0.75, { mix: 0 });
    b.wire(...pitch, pIn, 'a');
    b.wire(glide, 'out', pIn, 'b');
    b.wire(on, 'out', pIn, 'pos');
    // drift: a slow random walk, up to 20 cents
    const walk = add('walk', 'random', 0, 1, { mode: 1, rate: 0.3 });
    const wander = add('wander', 'scale', 0, 1.25, { gain: 0, offset: 0 });
    b.wire(walk, 'out', wander, 'in');
    b.wire(drift, 'out', wander, 'p1');
    b.pin(wander, 'p1', 'gain', [0.5, 0.5 + 20 / 1200 / 8]);
    // the oscillators (each through a VCA, its mixer knob), the LFO
    const o1 = add('o1', 'osc', 1, 0, { wave: 2, level: 1, fine: f.detune });
    const o2 = add('o2', 'osc', 1, 1, { wave: 3, level: 1, pw: 0.4, fine: 5 + f.detune });
    const lv1 = add('lv1', 'vca', 1.5, 0, { gain: 0.5 });
    const lv2 = add('lv2', 'vca', 1.5, 1, { gain: 0.4 });
    const lfo = add('lfo', 'lfo', 1, 2, { wave: 0, rate: 5, depth: 1 });
    b.wire(ALL.lfo[0], ALL.lfo[1], lfo, 'p2');
    // the envelopes: ADS, the decay also the release. Attack and decay are Macros (a pin each: they turn two envelopes
    // alike); the sustain is the envelope's own. The all-SEMs sustain adds x (one with sustain 1 less one with sustain 0):
    // its sustain level rises by x, its decay ends there, its attack is unchanged.
    const e = (100 + f.env) / 100;
    const envs = ([['1', 0.8], ['2', 0.4]] as const).map(([n, s], i) => {
      const atk = add(`atk${n}`, 'macro', 2, i + 0.25, { value: unitOf('adsr', 'a', 0.01 * e) });
      const dec = add(`dec${n}`, 'macro', 2, i + 0.5, { value: unitOf('adsr', 'd', 0.6 * e) });
      const all = ALL.env[i];
      b.wire(...all.attack, atk, 'p1');
      b.wire(...all.decay, dec, 'p1');
      const env = add(`env${n}`, 'adsr', 2, i, { a: 0.01 * e, s });
      const top = add(`top${n}`, 'adsr', 2.3, i, { s: 1 });
      const floor = add(`floor${n}`, 'adsr', 2.3, i + 0.5, { s: 0 });
      for (const x of [env, top, floor]) {
        b.wire(...gate, x, 'gate');
        b.wire(dec, 'out', x, 'p1');
        b.wire(atk, 'out', x, 'p2');
        b.pin(x, 'p1', 'r', [0, RELEASE_RANGE]);
        b.pin(x, 'p1', 'd', [0, 1]);
        b.module(x).map!.p1 = ['d', 'r'];
        b.pin(x, 'p2', 'a', [0, 1]);
      }
      const up = add(`up${n}`, 'vca', 2.6, i, { gain: 1 });
      b.wire(top, 'env', up, 'in');
      b.wire(...all.sustain, up, 'cv');
      const down = add(`down${n}`, 'vca', 2.6, i + 0.5, { gain: 1 });
      b.wire(floor, 'env', down, 'in');
      b.wire(...all.less, down, 'cv');
      /** wire the envelope (with the all-SEMs sustain) into an input */
      return (to: number, port: string): void => {
        for (const from of [env, up, down]) b.wire(from, from === env ? 'env' : 'out', to, port);
      };
    });
    for (const [o, lv, v, mx] of [[o1, lv1, ALL.vco[0], ALL.mix[0]], [o2, lv2, ALL.vco[1], ALL.mix[1]]] as const) {
      b.wire(pIn, 'out', o, 'pitch');
      b.wire(wander, 'out', o, 'pitch');
      b.wire(octave, 'out', o, 'pitch');
      b.wire(tune, 'out', o, 'pitch');
      b.wire(...v.freq, o, 'pitch');
      b.wire(...v.fine, o, 'pitch');
      b.wire(...v.pw, o, 'p2');
      b.wire(...mx.wave, o, 'p1');
      b.wire(o, 'out', lv, 'in');
      b.wire(unity, 'out', lv, 'cv');
      b.wire(...mx.level, lv, 'p1');
    }
    // each VCO's modulation: source (its envelope or the LFO), FM, PWM
    ([[o1, '1'], [o2, '2']] as const).forEach(([o, n], i) => {
      const v = ALL.vco[i];
      const src = add(`src${n}`, 'xfade', 3, i, { mix: 1 });
      envs[i](src, 'a');
      b.wire(lfo, 'out', src, 'b');
      b.wire(...v.src, src, 'pos');
      const fm = add(`fm${n}`, 'scale', 3, i + 0.33, { gain: 0, offset: 0 });
      b.wire(src, 'out', fm, 'in');
      b.wire(fm, 'out', o, 'pitch');
      b.wire(...v.fm, fm, 'p1');
      const pwm = add(`pwm${n}`, 'scale', 3, i + 0.66, { gain: 0, offset: 0 });
      b.wire(src, 'out', pwm, 'in');
      b.wire(pwm, 'out', o, 'p2');
      b.wire(...v.pwm, pwm, 'p1');
    });
    const sync = add('sync', 'scale', 1, 1.5, { gain: 0, offset: 0 });
    b.wire(o1, 'out', sync, 'in');
    b.wire(sync, 'out', o2, 'sync');
    b.wire(...ALL.sync, sync, 'p1');
    // the VCF: its input mixer is the oscillators' VCAs; cutoff moved by its source (envelope 2 or the LFO) and the
    // keyboard's VCF knob
    const flt = add('flt', 'filter', 4, 0, { cutoff: Math.round(1100 * Math.pow(2, f.bright / 12)), res: 0.35, cvamt: 2 });
    b.wire(lv1, 'out', flt, 'in');
    b.wire(lv2, 'out', flt, 'in');
    b.wire(...ALL.cutoff, flt, 'cv');
    b.wire(...ALL.res, flt, 'p2');
    const fsrc = add('fsrc', 'xfade', 4, 1, { mix: 0 });
    envs[1](fsrc, 'a');
    b.wire(lfo, 'out', fsrc, 'b');
    b.wire(...ALL.fsrc, fsrc, 'pos');
    const famt = add('famt', 'scale', 4, 1.33, { gain: 1.5, offset: 0 });
    b.wire(fsrc, 'out', famt, 'in');
    b.wire(famt, 'out', flt, 'cv');
    b.wire(...ALL.famt, famt, 'p1');
    b.wire(vcf, 'out', flt, 'cv');
    const mode = add('mode', 'xfade', 5, 0, { mix: 0 });
    b.wire(flt, 'lp12', mode, 'a');
    b.wire(flt, 'hp', mode, 'b');
    b.wire(...ALL.mode, mode, 'pos');
    const bp = add('bp', 'xfade', 5, 0.5, { mix: 0 });
    b.wire(mode, 'out', bp, 'a');
    b.wire(flt, 'bp', bp, 'b');
    b.wire(...ALL.bp, bp, 'pos');
    // the VCA: envelope 1, or held open
    const vcaOn = add('vcaOn', 'xfade', 5, 1, { mix: 0 });
    envs[0](vcaOn, 'a');
    b.wire(unity, 'out', vcaOn, 'b');
    b.wire(...ALL.vcaOn, vcaOn, 'pos');
    const vca = add('vca', 'vca', 6, 0, { gain: Math.round(0.6 * f.level) / 100 });
    b.wire(bp, 'out', vca, 'in');
    b.wire(vcaOn, 'out', vca, 'cv');
    b.wire(...ALL.level, vca, 'p1');
    const pan = add('pan', 'pan', 6, 1, { pan: Math.round(40 * (2 * (k - 1) - 7) / 7) / 100 });
    b.wire(vca, 'out', pan, 'in');
    b.wire(...ALL.pan, pan, 'pos');
    b.wire(pan, 'l', mixL, k <= 4 ? 'in1' : 'in2');
    b.wire(pan, 'r', mixR, k <= 4 ? 'in1' : 'in2');
    const members = Object.values(m);
    b.nest(`sem ${k}`, c0, r0, members, { inputs: [['pitch', glide, 'in'], ['gate', m.env1, 'gate']], outputs: [['l', pan, 'l'], ['r', pan, 'r']] });
    sems.push(m);
  }
  b.input('keys', all, 'keys', [lo, 'keys'], [hi, 'keys']);
  b.output('l', mixL, 'out');
  b.output('r', mixR, 'out');

  // ---- the card: the keyboard, the split, then each SEM
  const breaks = new Set(['vco 2 freq', 'vco 1 wave', 'cutoff', 'env 1 attack', 'lfo rate']);
  allRows.forEach(([label, c], i) => b.param(label, c, 'value', i ? { group: breaks.has(label) } : { head: 'all SEMs' }));
  b.param('unison', all, 'unison', { col: true, head: 'keyboard' });
  b.param('assign', all, 'assign');
  b.param('priority', all, 'priority');
  b.param('octave', octave, 'value');
  b.param('tune', tune, 'value');
  b.param('vcf', vcf, 'value');
  b.param('portamento', portaTime, 'value', { group: true });
  b.param('porta lower', portaLo, 'value');
  b.param('porta upper', portaHi, 'value');
  b.param('drift', drift, 'value');
  b.param('split', split, 'value', { col: true, head: 'split' });
  b.param('lower voices', lo, 'voices');
  b.param('upper voices', hi, 'voices');
  b.param('lower top', lo, 'high');
  b.param('upper bottom', hi, 'low');
  b.param('lower unison', lo, 'unison');
  b.param('upper unison', hi, 'unison');
  sems.forEach((m, i) => {
    b.param('vco 1 freq', m.o1, 'coarse', { col: true, head: `sem ${i + 1}` });
    b.param('vco 1 fine', m.o1, 'fine');
    b.param('vco 1 pw', m.o1, 'pw');
    b.param('vco 1 src', m.src1, 'mix');
    b.param('vco 1 fm', m.fm1, 'gain');
    b.param('vco 1 pwm', m.pwm1, 'gain');
    b.param('vco 2 freq', m.o2, 'coarse', { group: true });
    b.param('vco 2 fine', m.o2, 'fine');
    b.param('vco 2 pw', m.o2, 'pw');
    b.param('vco 2 src', m.src2, 'mix');
    b.param('vco 2 fm', m.fm2, 'gain');
    b.param('vco 2 pwm', m.pwm2, 'gain');
    b.param('sync', m.sync, 'gain');
    b.param('vco 1 wave', m.o1, 'wave', { group: true });
    b.param('vco 1', m.lv1, 'gain');
    b.param('vco 2 wave', m.o2, 'wave');
    b.param('vco 2', m.lv2, 'gain');
    b.param('cutoff', m.flt, 'cutoff', { group: true });
    b.param('resonance', m.flt, 'res');
    b.param('mode', m.mode, 'mix');
    b.param('bp', m.bp, 'mix');
    b.param('vcf src', m.fsrc, 'mix');
    b.param('vcf mod', m.famt, 'gain');
    b.param('env 1 attack', m.atk1, 'value', { group: true });
    b.param('env 1 decay', m.dec1, 'value');
    b.param('env 1 sustain', m.env1, 's');
    b.param('env 2 attack', m.atk2, 'value');
    b.param('env 2 decay', m.dec2, 'value');
    b.param('env 2 sustain', m.env2, 's');
    b.param('lfo rate', m.lfo, 'rate', { group: true });
    b.param('vca on', m.vcaOn, 'mix');
    b.param('level', m.vca, 'gain');
    b.param('pan', m.pan, 'pan');
  });
  b.param('out', scope, 'view', { col: true });
});

const NOTES =
  'The Oberheim Eight Voice: eight SEMs, each with every knob of its own (two VCOs with FM / PWM from an envelope or its LFO and sync, the saw / pulse mixer, the 12 dB VCF from low pass through notch to high pass or band pass, two ADS envelopes, VCA on, level and pan), an all-SEMs row per control that moves all eight at once, played by the keyboard: unison, assign, split with its own unison per half, portamento per half, octave, tune, VCF. Not here: the jacks, the R/C assign mode.';

export const xl: Xl = {
  base: 'Expander S',
  build: () => {
    const x = around('Expander S XL', built);
    level(x.p, { chord: true });
    x.p.notes = NOTES;
    return players(validatePatch(x.p, DEFS), true);
  },
};
