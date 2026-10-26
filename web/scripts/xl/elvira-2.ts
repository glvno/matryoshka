// SPDX-License-Identifier: GPL-3.0-only
// Elvira 2 XL: the neutral labs Elmyra 2 as its manual (v2.4, neutral-labs.com/elmyra2/downloads/Elmyra2-v2.4-manual.pdf)
// and its product page (neutral-labs.com/elmyra2: 41 patch points, 31 modulation targets) describe it, where the FM-1's
// Elvira 2 (gen-assemblies.ts) had to cut. The original's knobs have no scale, so most controls here are 0..1 rows
// (Macros) too. A choice of N settings is one such row read in N even steps, 0, 1 / (N - 1), .. 1 (the eleven programs:
// 0, 0.1, .. 1): comparators (Math) and a chain of Crossfaders pick the setting, as the module set has no switch.
//
// Each of the four voices:
//  - the touchpads are the keys, as on the FM-1 version (rows 1-4 and 5-8 of four Drum maps are voices 1-4). A key's
//    velocity is the pressure on the pads and Main's aftertouch (input `pressure`) presses harder while it is held. The
//    envelope (ENV as `attack` and `release`, down to 1 ms, which covers the short digital envelopes) times that
//    pressure is the voice's ENV output (`env 1..4`). GATE (`gate 1..4`) is continuous, as the pads are. `drone` (PG's
//    long press) holds the voice open while ENV still follows the pads; `level` is the per voice volume and mute
//    (code 412, MODP + PG);
//  - the oscillator: a Wavetable with PG's four pages (`page`, four steps) and WAVE (`wave`), on TUNE (`tune`, in
//    octaves and continuous, as the knob; `fine` in semitones, 0.01 = 1 cent) plus `octave` (codes 11..44: one octave
//    up, the sub oscillators staying where they were);
//  - MOD (`mod`) and MODP (`modp`, eleven steps), with every program of the manual's table: 0 DETUNE (two copies a
//    little lower and higher, louder and wider with MOD), 0.1 SUBOSC (a saw an octave and a square two octaves below),
//    0.2 CHORD (two more copies in just intonation; MOD in ten steps picks 1-5-8, major, minor, diminished, sus2, sus4,
//    augmented, major 7th, dominant 7th (with 7/4), minor 7th), 0.3 DUAL (a second copy from an octave below to an
//    octave above), 0.4 HARDSYNC (a copy reset by the main pitch, up to three octaves above it), 0.5 SHAPER (the wave's
//    upper half shifted down by MOD: the manual gives it one line), 0.6 SATURATOR, 0.7 BITMANGLER (as a bit depth), 0.8
//    SRR, 0.9 NOISE, 1 DJ (a low pass left of the middle, a high pass right of it, no resonance). MODP chaining (codes
//    421..424: `modp chain`, four steps: off, 3>4, 1>2 and 3>4, 2>3>4): a voice's program takes the voice before it
//    in place of its own oscillator;
//  - the sequencer: eight steps on the voice's `seq` card (the original records up to 128 TUNE settings), with its own
//    length, clock divider (codes 111v..114v: `clock div`) and order (codes 311..314, random: `dir`), on Main's clock
//    (it plays with the transport, as the original's needs SYNC's clock), added to TUNE.
// Pitch, for all voices: CHRM per voice (`chrm`, 0 off, 1 on: TUNE, FINE and the steps quantized), its `scale` (codes
// 11..14, five steps: chromatic, major, minor, major and minor pentatonic, from A), `tuning` (codes 111..114, five steps:
// 12, 7, 9, 15, 17 notes to the octave, from A0), `portamento` (codes 221..224, none to 1 s), `tune follow` (codes
// 2221..2224, four steps: off, 1>2, 1>2 3, 1>2 3 4: the later voices' TUNE becomes an interval above voice 1).
// The mix is summed and saturated (`saturation`, 0 = none; `drive`; `curve`, soft or hard: codes 121..124). The main
// filter has CUTOFF and RESO (`cutoff`, `reso`) and twelve types in `filter` (codes 331..3322): ladder low pass (the
// Ladder), ladder band pass and high pass (two state variable stages each), state variable low, band and high pass,
// high pass (on RESO) and low pass (on CUTOFF) in series and in parallel, base-width (RESO the base, CUTOFF the width)
// and its notch, comb (RESO the damping, CUTOFF the time) and comb tuned to voice 1. `routing` (codes 133 / 134): 0
// filter into delay, 1 delay into filter. The delay: TIME to 1.6 s; FDBK 0..2, 1 = 100 % as at the original's middle,
// past it through a soft clip; MIX; `color`, the low pass in its feedback loop (codes 321..324); `sync`, the time in
// note lengths of Main's clock (code 132). `reverb` (codes 441..4411, three steps): off; on, in place of the delay
// (`size`, `damp`, `mix`); lo-fi, a small crushed reverb after the delay. OUCH: BITE (a folding Waveshaper), CHOKE (a
// low pass, open at the right), the modifier ports as FEEDBACK (a loop from CHOKE back into BITE) and DIODE (the
// fold's asymmetry), `ext in` (the audio input's level); then VOL.
// The LFOs reach audio rate (Oscillators, 0.02 Hz to about 1 kHz: `lfo 1 freq`, `lfo 2 freq`). With `sync` (codes
// 2441..2444) each follows Main's clock instead: FREQ picks one, two or three cycles a beat, passing the dotted
// lengths between. LFO 2's WAV (`lfo 2 wav`) runs from a short attack and long decay through a complex wave to a
// rising saw, a square and a sine. `lfo 2 mode` (codes 2413 / 2414, three steps): the wave, S&H, S&G, with WAV as the
// random range. `lfo 1 wave` (eight steps; codes 241, 243, 2411, 2412, 243v): the sine, a copy of LFO 2's wave, S&H,
// S&G, voice 1..4's sequence. Each LFO has an amount into cutoff, bite (at audio rate), choke, the delay time and the
// voices' wave and mod. Beyond those, the original's jacks are the assembly's ports, so any source patches into any
// target as on the original: outputs `lfo 1`, `lfo 2`, `env 1..4`, `att 1`, `att 2`, `add`; inputs per voice gate,
// tune, wave and mod, then cutoff, reso, time, fdbk, mix, bite, choke, lfo 1 freq, lfo 2 freq, lfo 2 wav, att in, add
// in 1, add in 2, clock (SYNC) and ext in (the audio input, for any signal of the patch). ATT is two attenuators of
// `att in` (`att 1`, `att 2`), with an Offset of 1 wired in for the fixed voltage it gives with nothing in IN: unplug
// it to attenuate a signal alone. ADD attenuates two inputs and sums them (`add 1`, `add 2`).
// Not here, and why:
//  - the external audio itself: the module set has no audio input (a module for the browser's and the FM-1's audio
//    input would bring it; `ext in` takes any signal of the patch meanwhile);
//  - the CV jacks to and from other gear, the modifier ports' cards and parts, the 1V/octave calibration: hardware;
//  - BITMANGLER's flipped bits: a module that flips a sample's bits (XOR) is needed, so it is a bit depth here;
//  - the sequencer's 128 steps and its recording of the TUNE knob, and LFO 1's motion recording: a step sequencer
//    longer than eight steps that records a control, and a recorder that loops a control signal, are needed;
//  - LFO 2's four further wavetables (code 244), the exact complex waves and the oscillator pages: they are the
//    original's wavetables (here the browser's own four banks and a complex wave of sine, square and the decay).
// The delay's and OUCH's feedback loops close one block late (about 3 ms): the echoes come 3 ms after TIME, and OUCH
// rings as a comb rather than as the analog loop.
import { DEFS } from '../../src/modules';
import { validatePatch } from '../../src/patch';
import { players } from '../factory-build';
import { around, define, KIT_NOTES, matchLevel, type Built } from './def';
import { platesOf } from './8-lire';
import type { Xl } from './xl';

/** an output port */
type Out = [number, string];

/** the chords of CHORD (MOD from left to right): the two upper notes in octaves above the root, just intonation */
const CHORDS: [number, number][] = [
  [3 / 2, 2], [5 / 4, 3 / 2], [6 / 5, 3 / 2], [6 / 5, 64 / 45], [9 / 8, 3 / 2],
  [4 / 3, 3 / 2], [5 / 4, 25 / 16], [5 / 4, 15 / 8], [5 / 4, 7 / 4], [6 / 5, 9 / 5],
].map(([a, b]) => [Math.log2(a), Math.log2(b)]);
/** the LFOs' FREQ: 0.02 Hz at 0, LFO_OCT octaves more at 1 (an Oscillator's pitch is octaves from C4) */
const LFO_OCT = 15.6;
const LFO_BASE = Math.log2(0.02 / 261.6256);
const lfoFreq = (hz: number): number => Math.log2(hz / 0.02) / LFO_OCT;

export function elviraXl(maps: Record<string, number>[]): Built {
  return define('Elvira 2 XL', (b) => {
    const rows = new Map<number, number>();
    const put = (type: string, col: number, p: Record<string, number> = {}): number => {
      const r = rows.get(col) ?? 0;
      rows.set(col, r + 1);
      return b.add(type, col, r, p);
    };
    const wire = (from: Out, to: number, port: string): void => b.wire(from[0], from[1], to, port);
    /** comparators of a 0..1 choice of n: t[k] (k = 1..n - 1) is high from step k on (t[0] unused) */
    const steps = (src: Out, n: number, col: number): Out[] => {
      const t: Out[] = [['', ''] as unknown as Out];
      for (let k = 1; k < n; k++) {
        const m = put('math', col, { ka: 1, kb: 1, off: -(k - 0.5) / (n - 1) });
        wire(src, m, 'a');
        t.push([m, 'cmp']);
      }
      return t;
    };
    /** the option of the step chosen: a chain of Crossfaders, option k from t[k] on */
    const pick = (opts: Out[], t: Out[], col: number, from = 1): Out => {
      let y = opts[0];
      for (let k = 1; k < opts.length; k++) {
        const x = put('xfade', col, { mix: 0 });
        wire(y, x, 'a');
        wire(opts[k], x, 'b');
        wire(t[from + k - 1], x, 'pos');
        y = [x, 'out'];
      }
      return y;
    };
    const scaled = (src: Out, col: number, gain: number, offset = 0): Out => {
      const s = put('scale', col, { gain, offset });
      wire(src, s, 'in');
      return [s, 'out'];
    };
    const mixOf = (col: number, ins: [Out, number][]): Out => {
      const m = put('mixer', col, { l1: 0, l2: 0, l3: 0, l4: 0, ...Object.fromEntries(ins.map(([, l], k) => [`l${k + 1}`, l])) });
      ins.forEach(([o], k) => wire(o, m, `in${k + 1}`));
      return [m, 'out'];
    };

    const plate = maps.map((keys, i) => b.add('drummap', 0, [6, 0, 7, 8][i] ?? 9 + i, keys));
    for (const map of plate) b.module(map).names = [1, 2, 3, 4, 1, 2, 3, 4].map((v, r) => `VOICE ${v}${r < 4 ? '' : 'B'}`); // (as the FM-1 version)
    const G = 1; // the global controls' column
    const noise = put('noise', G, { level: 0.8, color: 0 });
    const one = put('const', G, { value: 1 });
    const macro = (value: number): number => put('macro', G, { value });
    // the global choices
    const scaleM = macro(0), tuningM = macro(0), portaM = macro(0), followM = macro(0), chainM = macro(0);
    const filterM = macro(0), routeM = macro(0), revM = macro(0), cutoffM = macro(0.72), resoM = macro(0.25);
    const tEdo = steps([tuningM, 'out'], 5, 2);
    const tFollow = steps([followM, 'out'], 4, 2);
    const tChain = steps([chainM, 'out'], 4, 2);
    const chain2 = put('math', 2, { ka: 1, kb: 1, off: 0 }); // 1 > 2: the second step only
    wire(tChain[2], chain2, 'a');
    wire(tChain[3], chain2, 'b');
    const chained: (Out | null)[] = [null, [chain2, 'sub'], tChain[3], tChain[1]];
    const followed: (Out | null)[] = [null, tFollow[1], tFollow[2], tFollow[3]];

    // ---- the LFOs: Oscillators (to audio rate) or, synced, LFOs on Main's clock; the waves derived from sine, saw, square
    const clockIn: [number, string][] = [];
    const lfoGen = (col: number, hz: number) => {
      const freq = macro(lfoFreq(hz));
      const sync = macro(0);
      const pitch = put('scale', col, { gain: LFO_OCT, offset: LFO_BASE });
      b.wire(freq, 'out', pitch, 'in');
      const base = [0, 2, 3].map((wave) => {
        const o = put('osc', col, { wave, level: 1 });
        b.wire(pitch, 'out', o, 'pitch');
        const l = put('lfo', col, { wave, sync: 1, div: 6, depth: 1 });
        clockIn.push([l, 'clk']);
        b.wire(freq, 'out', l, 'p1');
        b.pin(l, 'p1', 'div', [0.6, 0.2]); // one, two, three cycles a beat (1/4, 1/8, 1/8T) from left to right
        const x = put('xfade', col, { mix: 0 });
        b.wire(o, 'out', x, 'a');
        b.wire(l, 'out', x, 'b');
        b.wire(sync, 'out', x, 'pos');
        return [x, 'out'] as Out;
      });
      const [sine, saw, square] = base;
      const fall = put('math', col, { ka: -0.5, kb: 1, off: 0.5 }); // 1 .. 0 over the cycle
      wire(saw, fall, 'a');
      const f2 = put('math', col, {});
      b.wire(fall, 'add', f2, 'a');
      b.wire(fall, 'add', f2, 'b');
      const f4 = put('math', col, {});
      b.wire(f2, 'mul', f4, 'a');
      b.wire(f2, 'mul', f4, 'b');
      const decay = scaled([f4, 'mul'], col, 2, -1); // a short attack and a long (fourth power) decay
      const complex = mixOf(col, [[sine, 0.6], [square, 0.25], [decay, 0.4]]);
      // sample & hold: a new value at each cycle; sample & glide: from the last one to it over the cycle
      const sh1 = put('sh', col, { mode: 0 });
      b.wire(noise, 'out', sh1, 'in');
      wire(square, sh1, 'clock');
      const inv = put('math', col, { ka: -1, kb: 1, off: 0 });
      wire(square, inv, 'a');
      const sh3 = put('sh', col, { mode: 0 });
      b.wire(sh1, 'out', sh3, 'in');
      b.wire(inv, 'add', sh3, 'clock');
      const sh2 = put('sh', col, { mode: 0 });
      b.wire(sh3, 'out', sh2, 'in');
      wire(square, sh2, 'clock');
      const ramp = put('math', col, { ka: 0.5, kb: 1, off: 0.5 });
      wire(saw, ramp, 'a');
      const sg = put('xfade', col, { mix: 0 });
      b.wire(sh2, 'out', sg, 'a');
      b.wire(sh1, 'out', sg, 'b');
      b.wire(ramp, 'add', sg, 'pos');
      return { freq, sync, pitch, sine, saw, square, decay, complex, sh: [sh1, 'out'] as Out, sg: [sg, 'out'] as Out };
    };
    const L1 = lfoGen(3, 0.2);
    const L2 = lfoGen(4, 3);
    const wav = macro(1); // LFO 2's WAV: the sine at the right, the default wave
    const wavBus = put('scale', 4, { gain: 1, offset: 0 });
    b.wire(wav, 'out', wavBus, 'in');
    const continuum = (L: ReturnType<typeof lfoGen>, col: number): Out => {
      let y = L.decay;
      [L.complex, L.saw, L.square, L.sine].forEach((w, k) => {
        const x = put('xfade', col, { mix: 0 });
        wire(y, x, 'a');
        wire(w, x, 'b');
        const pos = put('scale', col, { gain: 4, offset: -k });
        b.wire(wavBus, 'out', pos, 'in');
        b.wire(pos, 'out', x, 'pos');
        y = [x, 'out'];
      });
      return y;
    };
    const wave1 = continuum(L1, 3);
    const wave2 = continuum(L2, 4);
    const ranged = (src: Out): Out => {
      const m = put('math', 4, {});
      wire(src, m, 'a');
      b.wire(wavBus, 'out', m, 'b');
      return [m, 'mul'];
    };
    const lfo1Wave = macro(0), lfo2Mode = macro(0);
    // (voice sequences joined below, once the voices exist)
    const lfo2 = pick([wave2, ranged(L2.sh), ranged(L2.sg)], steps([lfo2Mode, 'out'], 3, 4), 4);

    // ---- the patch points: LFO amounts into each destination (cutoff, bite, choke, time, wave, mod)
    const DEST = ['cutoff', 'bite', 'choke', 'time', 'wave', 'mod'] as const;
    const lfoOut: Out[] = [];
    const amt: Record<(typeof DEST)[number], number>[] = [];

    // ---- the voices
    //                bank tune   fine pos  attack release
    const set: [number, number, number, number, number, number][] = [
      [0, -1.25, 0, 0.2, 0.05, 0.8], [1, -0.67, 0.04, 0.4, 0.05, 0.8], [2, -0.25, 0, 0.3, 0.3, 1.5], [3, 0, 0, 0.6, 0.3, 1.5],
    ];
    const voices: {
      raw: number; glide: number; pb: number; prog: Out; vca: number; envOut: number; seq: number; div: number;
      tune: number; fine: number; octave: number; wave: number; page: number; mod: number; modp: number; env: number; drone: number;
      chrm: number; waveBus: number; modBus: number; touch: number; press: number; q12: number;
    }[] = [];
    set.forEach(([bank, tuneV, fineV, pos, a, r], i) => {
      const col = 10 + 3 * i;
      const P = (type: string, p: Record<string, number> = {}, c = col): number => put(type, c, p);
      // pitch: TUNE + FINE + the sequence (+ voice 1's pitch when following) -> CHRM -> portamento; + octave
      const tune = P('const', { value: tuneV });
      const fine = P('const', { value: fineV });
      const fineS = P('scale', { gain: 1 / 12, offset: 0 });
      b.wire(fine, 'out', fineS, 'in');
      const raw = P('scale', { gain: 1, offset: 0 });
      b.wire(tune, 'out', raw, 'in');
      b.wire(fineS, 'out', raw, 'in');
      const seq = put('seq', col + 2, { len: 8, gate: 0 });
      const div = put('clkdiv', col + 2, { div: 6 }); // Main's 24 ppqn clock: a step per sixteenth
      b.wire(div, 'out', seq, 'clock');
      b.wire(seq, 'out', raw, 'in');
      const q12 = P('quant', { scale: 0, root: 9 }); // the scales from A
      b.wire(raw, 'out', q12, 'in');
      b.wire(scaleM, 'out', q12, 'p1');
      b.pin(q12, 'p1', 'scale', [0, 0.4]); // five scales: chromatic, major, minor, major and minor pentatonic
      const edo = [7, 9, 15, 17].map((n): Out => {
        const pre = P('scale', { gain: n / 12, offset: (3.25 * n) / 12 }); // (A0 is 3.25 octaves below C4)
        b.wire(raw, 'out', pre, 'in');
        const q = P('quant', { scale: 0, root: 0 });
        b.wire(pre, 'out', q, 'in');
        const post = P('scale', { gain: 12 / n, offset: -3.25 });
        b.wire(q, 'out', post, 'in');
        return [post, 'out'];
      });
      const quantized = pick([[q12, 'out'], ...edo], tEdo, col + 1);
      const chrm = P('xfade', { mix: 0 });
      b.wire(raw, 'out', chrm, 'a');
      wire(quantized, chrm, 'b');
      const glide = P('glide', { time: 0.001, curve: 0 });
      b.wire(chrm, 'out', glide, 'in');
      b.wire(portaM, 'out', glide, 'p1');
      b.pin(glide, 'p1', 'time', [0, 0.811]); // none .. 1 s
      const octave = P('const', { value: 0 });
      const pb = P('scale', { gain: 1, offset: 0 });
      b.wire(glide, 'out', pb, 'in');
      b.wire(octave, 'out', pb, 'in');
      if (i > 0) {
        const f = P('xfade', { mix: 0 }); // voice 1's pitch, when following
        b.wire(voices[0].glide, 'out', f, 'b');
        wire(followed[i]!, f, 'pos');
        b.wire(f, 'out', raw, 'in');
      }
      // WAVE, PG (page), MOD, MODP
      const wave = P('macro', { value: pos });
      const waveBus = P('scale', { gain: 1, offset: 0 });
      b.wire(wave, 'out', waveBus, 'in');
      const page = P('macro', { value: bank / 3 });
      const mod = P('macro', { value: 0 });
      const modBus = P('math', { ka: 1, kb: 1, off: 0 }); // MOD and its modulation, not below 0
      b.wire(mod, 'out', modBus, 'a');
      const M: Out = [modBus, 'max'];
      const modp = P('macro', { value: 0.8 }); // SRR, as the FM-1 version
      const tProg = steps([modp, 'out'], 11, col + 1);
      const wt = (level = 0.8, offset?: Out, root: Out = [pb, 'out']): number => {
        const w = P('wavetable', { level });
        wire(root, w, 'pitch');
        if (offset) wire(offset, w, 'pitch');
        b.wire(waveBus, 'out', w, 'p1');
        b.pin(w, 'p1', 'pos', [0, 1]);
        b.wire(page, 'out', w, 'p2');
        b.pin(w, 'p2', 'bank', [0, 1]);
        return w;
      };
      const main = wt();
      const mainO: Out = [main, 'out'];
      // DETUNE
      const detA = wt(0.8, scaled(M, col, -0.025));
      const detB = wt(0.8, scaled(M, col, 0.025));
      const detV = P('vca', { gain: 1 });
      b.wire(detA, 'out', detV, 'in');
      b.wire(detB, 'out', detV, 'in');
      wire(M, detV, 'cv');
      const detune = mixOf(col, [[mainO, 1], [[detV, 'out'], 0.7]]);
      // SUBOSC (below TUNE without the octave switch)
      const subSaw = P('osc', { wave: 2, coarse: -12, level: 0.6 });
      const subSq = P('osc', { wave: 3, coarse: -24, level: 0.45 });
      b.wire(glide, 'out', subSaw, 'pitch');
      b.wire(glide, 'out', subSq, 'pitch');
      const subV = P('vca', { gain: 1 });
      b.wire(subSaw, 'out', subV, 'in');
      b.wire(subSq, 'out', subV, 'in');
      wire(M, subV, 'cv');
      const subosc = mixOf(col, [[mainO, 1], [[subV, 'out'], 0.8]]);
      // CHORD: the two upper notes step through CHORDS with MOD
      const tChord = steps(M, 10, col + 1); // ten chords
      const upper = [0, 1].map((n) => {
        const w = wt(0.8, [P('const', { value: CHORDS[0][n] }), 'out']);
        for (let k = 1; k < CHORDS.length; k++) {
          if (CHORDS[k][n] === CHORDS[k - 1][n]) continue;
          const s = P('scale', { gain: CHORDS[k][n] - CHORDS[k - 1][n], offset: 0 }, col + 1);
          wire(tChord[k], s, 'in');
          b.wire(s, 'out', w, 'pitch');
        }
        return [w, 'out'] as Out;
      });
      const chord = mixOf(col, [[mainO, 0.7], [upper[0], 0.7], [upper[1], 0.7]]);
      // DUAL
      const dual = mixOf(col, [[mainO, 0.8], [[wt(0.8, scaled(M, col, 2, -1)), 'out'], 0.8]]);
      // HARDSYNC: a copy reset by a square on the main pitch
      const master = P('osc', { wave: 3, level: 1 });
      b.wire(pb, 'out', master, 'pitch');
      const slave = wt(0.8, scaled(M, col, 3));
      b.wire(master, 'out', slave, 'sync');
      const oscStage = pick([detune, subosc, chord, dual, [slave, 'out'], mainO], tProg, col + 1);
      // MODP chaining: the voice before instead of this oscillator
      let src = oscStage;
      if (chained[i]) {
        const x = P('xfade', { mix: 0 });
        wire(oscStage, x, 'a');
        wire(voices[i - 1].prog, x, 'b');
        wire(chained[i]!, x, 'pos');
        src = [x, 'out'];
      }
      // SHAPER: the wave's upper half shifted down by MOD
      const upperHalf = P('math', { ka: 1, kb: 1, off: 0 });
      wire(src, upperHalf, 'a');
      const shift = P('vca', { gain: 1 });
      b.wire(upperHalf, 'cmp', shift, 'in');
      wire(M, shift, 'cv');
      const shaper = P('math', { ka: 1, kb: 1, off: 0 });
      wire(src, shaper, 'a');
      b.wire(shift, 'out', shaper, 'b');
      // SATURATOR
      const satS = P('shape', { drive: 1, mode: 0, level: 1 });
      wire(src, satS, 'in');
      wire(M, satS, 'p1');
      b.pin(satS, 'p1', 'drive', [0, 0.8]); // 1 .. 16
      const sat = P('xfade', { mix: 0 });
      wire(src, sat, 'a');
      b.wire(satS, 'out', sat, 'b');
      wire(M, sat, 'pos');
      // BITMANGLER (the bit depth), SRR
      const bits = P('crush', { bits: 16, rate: 1 });
      wire(src, bits, 'in');
      wire(M, bits, 'p1');
      b.pin(bits, 'p1', 'bits', [1, 1 / 15]); // 16 .. 2 bits
      const srr = P('crush', { bits: 16, rate: 1 });
      wire(src, srr, 'in');
      wire(M, srr, 'p1');
      b.pin(srr, 'p1', 'rate', [0, 1]);
      // NOISE
      const nz = P('xfade', { mix: 0 });
      wire(src, nz, 'a');
      b.wire(noise, 'out', nz, 'b');
      wire(M, nz, 'pos');
      // DJ: a low pass closing left of the middle, a high pass closing right of it
      const djLp = P('filter', { cutoff: 16000, res: 0 });
      wire(src, djLp, 'in');
      wire(scaled(M, col, 2), djLp, 'p1');
      b.pin(djLp, 'p1', 'cutoff', [0, 1]);
      const djHp = P('filter', { cutoff: 20, res: 0 });
      b.wire(djLp, 'lp12', djHp, 'in');
      wire(scaled(M, col, 2, -1), djHp, 'p1');
      b.pin(djHp, 'p1', 'cutoff', [0, 1]);
      const prog = pick([src, [shaper, 'sub'], [sat, 'out'], [bits, 'out'], [srr, 'out'], [nz, 'out'], [djHp, 'hp']], tProg, col + 1, 5);
      // the touchpads: the keys' gates (and GATE) open the envelope, their velocity (and GATE, aftertouch) is the pressure
      const touch = P('scale', { gain: 1, offset: 0 });
      const press = P('scale', { gain: 1, offset: 0 });
      for (const map of plate) for (const row of [i + 1, i + 5]) {
        b.wire(map, `g${row}`, touch, 'in');
        const v = P('math', {}, col + 2);
        b.wire(map, `g${row}`, v, 'a');
        b.wire(map, `v${row}`, v, 'b');
        b.wire(v, 'mul', press, 'in');
      }
      const env = P('adsr', { a, d: 0.2, s: 1, r });
      b.wire(touch, 'out', env, 'gate');
      const held = P('sh', { mode: 1 }); // the pressure while touched, held through the release
      b.wire(press, 'out', held, 'in');
      b.wire(touch, 'out', held, 'clock');
      const envOut = P('math', {});
      b.wire(env, 'env', envOut, 'a');
      b.wire(held, 'out', envOut, 'b');
      const drone = P('const', { value: 0 });
      const level = P('math', {});
      b.wire(envOut, 'mul', level, 'a');
      b.wire(drone, 'out', level, 'b');
      const vca = P('vca', { gain: 1 });
      wire(prog, vca, 'in');
      b.wire(level, 'max', vca, 'cv');
      voices.push({ raw, glide, pb, prog, vca, envOut, seq, div, tune, fine, octave, wave, page, mod, modp, env, drone, chrm, waveBus, modBus, touch, press, q12 });
    });
    // LFO 1: the sine, LFO 2's wave, S&H, S&G, a voice's sequence
    const lfo1 = pick([L1.sine, wave1, L1.sh, L1.sg, ...voices.map((v): Out => [v.seq, 'out'])], steps([lfo1Wave, 'out'], 8, 3), 3);
    lfoOut.push(lfo1, lfo2);
    lfoOut.forEach((lfo, k) => {
      amt.push(Object.fromEntries(DEST.map((d) => {
        const s = put('scale', 5 + k, { gain: 0, offset: 0 });
        wire(lfo, s, 'in');
        return [d, s];
      })) as Record<(typeof DEST)[number], number>);
    });
    for (const v of voices) for (const k of [0, 1]) {
      b.wire(amt[k].wave, 'out', v.waveBus, 'in');
      b.wire(amt[k].mod, 'out', v.modBus, 'a');
    }

    // ---- the mix, saturated
    const mix = put('mixer', 7, { l1: 0.7, l2: 0.7, l3: 0.7, l4: 0.7 });
    voices.forEach((v, i) => b.wire(v.vca, 'out', mix, `in${i + 1}`));
    const satS = put('shape', 7, { drive: 2, mode: 0, level: 0.8 });
    b.wire(mix, 'out', satS, 'in');
    const sat = put('xfade', 7, { mix: 1 });
    b.wire(mix, 'out', sat, 'a');
    b.wire(satS, 'out', sat, 'b');
    // ---- the main filter: twelve types, CUTOFF and RESO into each as the manual says
    const F = 8;
    const fin = put('xfade', F, { mix: 0 }); // the mix, or the delay when reversed
    b.wire(sat, 'out', fin, 'a');
    b.wire(routeM, 'out', fin, 'pos');
    const ccv = put('scale', F, { gain: 1, offset: 0 }); // the cutoff's modulation, octaves x 3
    const rbus = put('scale', F, { gain: 1, offset: 0 });
    b.wire(resoM, 'out', rbus, 'in');
    for (const k of [0, 1]) b.wire(amt[k].cutoff, 'out', ccv, 'in');
    const cut = (id: number, src: number = cutoffM): void => {
      b.wire(src, 'out', id, 'p1');
      b.pin(id, 'p1', 'cutoff', [0, 1]);
    };
    const res = (id: number): void => {
      b.wire(rbus, 'out', id, 'p2');
      b.pin(id, 'p2', 'res', [0, 1]);
    };
    const cv = (id: number): void => b.wire(ccv, 'out', id, 'cv');
    const ladder = put('ladder', F, { cutoff: 2500, res: 0.25, cvamt: 3 });
    b.wire(fin, 'out', ladder, 'in');
    cut(ladder); res(ladder); cv(ladder);
    const svf = put('filter', F, { cutoff: 2500, res: 0.25, cvamt: 3 });
    b.wire(fin, 'out', svf, 'in');
    cut(svf); res(svf); cv(svf);
    const svfStage = (port: string): number => { // a second stage: the four-pole band and high pass
      const f = put('filter', F, { cutoff: 2500, res: 0.1, cvamt: 3 });
      b.wire(svf, port, f, 'in');
      cut(f); cv(f);
      return f;
    };
    const bp4 = svfStage('bp'), hp4 = svfStage('hp');
    const hpR = put('filter', F, { cutoff: 100, res: 0 }); // high pass on RESO
    b.wire(fin, 'out', hpR, 'in');
    cut(hpR, rbus);
    const lpC = put('filter', F, { cutoff: 2500, res: 0, cvamt: 3 }); // low pass on CUTOFF
    b.wire(fin, 'out', lpC, 'in');
    cut(lpC); cv(lpC);
    const series = put('filter', F, { cutoff: 2500, res: 0, cvamt: 3 });
    b.wire(hpR, 'hp', series, 'in');
    cut(series); cv(series);
    const parallel = mixOf(F, [[[lpC, 'lp12'], 1], [[hpR, 'hp'], 1]]);
    const width = put('filter', F, { cutoff: 2500, res: 0, cvamt: 3 }); // base-width: RESO the base, CUTOFF the width above it
    b.wire(hpR, 'hp', width, 'in');
    b.wire(rbus, 'out', width, 'p1');
    wire(scaled([cutoffM, 'out'], F, 0.6), width, 'p1');
    b.pin(width, 'p1', 'cutoff', [0, 1]);
    cv(width);
    const notch = put('math', F, {});
    b.wire(fin, 'out', notch, 'a');
    b.wire(width, 'lp12', notch, 'b');
    const comb = put('comb', F, { coarse: 0, fb: 0.85, damp: 0.2, mix: 1 });
    b.wire(fin, 'out', comb, 'in');
    const combPitch = put('scale', F, { gain: 5.7, offset: -2.7 }); // CUTOFF: the time, 40 Hz .. 2 kHz
    b.wire(cutoffM, 'out', combPitch, 'in');
    b.wire(ccv, 'out', combPitch, 'in');
    b.wire(combPitch, 'out', comb, 'pitch');
    const comb1 = put('comb', F, { coarse: 0, fb: 0.6, damp: 0.2, mix: 1 });
    b.wire(fin, 'out', comb1, 'in');
    b.wire(voices[0].pb, 'out', comb1, 'pitch'); // tuned to voice 1
    for (const c of [comb, comb1]) {
      b.wire(rbus, 'out', c, 'p1');
      b.pin(c, 'p1', 'damp', [0, 1]);
    }
    const fout = pick([[ladder, 'lp24'], [bp4, 'bp'], [hp4, 'hp'], [svf, 'lp12'], [svf, 'bp'], [svf, 'hp'], [series, 'lp12'], parallel,
      [width, 'lp12'], [notch, 'sub'], [comb, 'out'], [comb1, 'out']], steps([filterM, 'out'], 12, F + 1), F + 1);
    // ---- the delay (its feedback outside it: the color low pass and past 100 %), the reverb
    const D = 10 + 3 * 4;
    const din = put('xfade', D, { mix: 0 }); // the filter, or the mix when reversed
    wire(fout, din, 'a');
    b.wire(sat, 'out', din, 'b');
    b.wire(routeM, 'out', din, 'pos');
    const dly = put('delay', D, { time: 400, fb: 0, mix: 1, sync: 0 });
    b.wire(din, 'out', dly, 'in');
    const color = put('filter', D, { cutoff: 6000, res: 0 });
    b.wire(dly, 'out', color, 'in');
    const fdbk = put('vca', D, { gain: 0.4 });
    b.wire(color, 'lp12', fdbk, 'in');
    b.wire(one, 'out', fdbk, 'cv');
    const clip = put('shape', D, { drive: 1, mode: 0, level: 1 });
    b.wire(fdbk, 'out', clip, 'in');
    b.wire(clip, 'out', dly, 'in');
    const dmix = put('xfade', D, { mix: 0.3 });
    b.wire(din, 'out', dmix, 'a');
    b.wire(dly, 'out', dmix, 'b');
    for (const k of [0, 1]) b.wire(amt[k].time, 'out', dly, 'p1');
    b.pin(dly, 'p1', 'time');
    const rv = put('reverb', D, { size: 0.5, damp: 0.4, mix: 0.3 });
    b.wire(din, 'out', rv, 'in');
    const lofi = put('reverb', D, { size: 0.3, damp: 0.6, mix: 1 });
    b.wire(dmix, 'out', lofi, 'in');
    const crush = put('crush', D, { bits: 6, rate: 4 });
    b.wire(lofi, 'out', crush, 'in');
    const lofiMix = mixOf(D, [[[dmix, 'out'], 1], [[crush, 'out'], 0.35]]);
    const fx = pick([[dmix, 'out'], [rv, 'out'], lofiMix], steps([revM, 'out'], 3, D), D);
    wire(fx, fin, 'b');
    const post = put('xfade', D, { mix: 0 });
    wire(fx, post, 'a');
    wire(fout, post, 'b');
    b.wire(routeM, 'out', post, 'pos');
    // ---- OUCH
    const O = D + 1;
    const ouchIn = put('mixer', O, { l1: 1, l2: 0, l3: 1, l4: 0 }); // the delay, the loop (FEEDBACK), the audio input
    b.wire(post, 'out', ouchIn, 'in1');
    const biteIn = put('vca', O, { gain: 1 }); // the LFOs into BITE at audio rate
    b.wire(ouchIn, 'out', biteIn, 'in');
    b.wire(one, 'out', biteIn, 'cv');
    for (const k of [0, 1]) b.wire(amt[k].bite, 'out', biteIn, 'cv');
    const bite = put('shape', O, { drive: 1, mode: 2, level: 0.9, sym: 0 });
    b.wire(biteIn, 'out', bite, 'in');
    b.pin(bite, 'p1', 'drive');
    const choke = put('filter', O, { cutoff: 16000, res: 0 });
    b.wire(bite, 'out', choke, 'in');
    for (const k of [0, 1]) b.wire(amt[k].choke, 'out', choke, 'cv');
    const loop = put('shape', O, { drive: 1, mode: 0, level: 1 });
    b.wire(choke, 'lp12', loop, 'in');
    b.wire(loop, 'out', ouchIn, 'in2');
    const vol = put('mixer', O, { l1: 1, l2: 0, l3: 0, l4: 0 });
    b.wire(choke, 'lp12', vol, 'in1');
    const scope = put('scope', O, { time: 16 });
    b.wire(vol, 'out', scope, 'a');
    // ---- ATT and ADD
    const U = O + 1;
    const attIn = put('const', U, { value: 1 }); // the fixed level with nothing in IN
    const att = [1, 0.5].map((gain) => {
      const s = put('scale', U, { gain, offset: 0 });
      b.wire(attIn, 'out', s, 'in');
      return s;
    });
    const add = put('math', U, { ka: 1, kb: 1, off: 0 });

    // ---- ports: the original's jacks
    b.input('keys', plate[1], 'keys', ...plate.filter((_, i) => i !== 1).map((m) => [m, 'keys'] as [number, string]));
    const clocks: [number, string][] = [...voices.map((v): [number, string] => [v.div, 'clock']), ...clockIn, [dly, 'clk']];
    b.input('clock', clocks[0][0], clocks[0][1], ...clocks.slice(1));
    b.input('pressure', voices[0].press, 'in', ...voices.slice(1).map((v) => [v.press, 'in'] as [number, string]));
    voices.forEach((v, i) => {
      b.input(`gate ${i + 1}`, v.touch, 'in', [v.press, 'in']);
      b.input(`tune ${i + 1}`, v.raw, 'in');
      b.input(`wave ${i + 1}`, v.waveBus, 'in');
      b.input(`mod ${i + 1}`, v.modBus, 'a');
    });
    b.input('cutoff', ccv, 'in');
    b.input('reso', rbus, 'in');
    b.input('time', dly, 'p1');
    b.pin(fdbk, 'p1', 'gain');
    b.input('fdbk', fdbk, 'p1');
    b.input('mix', dmix, 'pos');
    b.input('bite', bite, 'p1');
    b.input('choke', choke, 'cv');
    b.input('lfo 1 freq', L1.pitch, 'in');
    b.input('lfo 2 freq', L2.pitch, 'in');
    b.input('lfo 2 wav', wavBus, 'in');
    b.input('att in', att[0], 'in', [att[1], 'in']);
    b.input('add in 1', add, 'a');
    b.input('add in 2', add, 'b');
    b.input('ext in', ouchIn, 'in3');
    b.output('out', vol, 'out');
    b.output('lfo 1', lfo1[0], lfo1[1]);
    b.output('lfo 2', lfo2[0], lfo2[1]);
    voices.forEach((v, i) => b.output(`env ${i + 1}`, v.envOut, 'mul'));
    b.output('att 1', att[0], 'out');
    b.output('att 2', att[1], 'out');
    b.output('add', add, 'add');

    // ---- nested: a voice (its pitch, oscillators, programs and envelope), its sequence
    const taken = new Set<number>(voices.flatMap((v) => [v.seq, v.div]));
    voices.forEach((v, i) => {
      const col = 10 + 3 * i;
      const mods = b.module;
      // every module placed in the voice's three columns, but its sequence
      const ids: number[] = [];
      for (let id = 1; ; id++) {
        let m;
        try { m = mods(id); } catch { break; }
        const c = Math.round(m.x / 320);
        if (c >= col && c <= col + 2 && !taken.has(id)) ids.push(id);
      }
      for (const id of ids) taken.add(id);
      b.nest(`voice ${i + 1}`, col, 0, ids, {
        inputs: [['gate', v.touch, 'in'], ['tune', v.raw, 'in']],
        outputs: [['out', v.vca, 'out'], ['env', v.envOut, 'mul']],
      });
    });
    voices.forEach((v, i) => b.nest(`seq ${i + 1}`, 10 + 3 * i, 1, [v.seq, v.div], {
      inputs: [['clock', v.div, 'clock']],
      outputs: [['pitch', v.seq, 'out']],
      params: [...[1, 2, 3, 4, 5, 6, 7, 8].map((s) => [`step ${s}`, v.seq, `s${s}`] as [string, number, string]), ['glide', v.seq, 'glide'], ['dir', v.seq, 'dir'], ['clock div', v.div, 'div']],
    }));

    // the card: each voice, then the pitch, the mix and filter, the delay and reverb, OUCH, the LFOs, the utilities
    voices.forEach((v, i) => {
      b.param('tune', v.tune, 'value', { head: `voice ${i + 1}`, ...(i % 2 === 0 ? { col: true } : {}) });
      b.param('fine', v.fine, 'value');
      b.param('wave', v.wave, 'value');
      b.param('page', v.page, 'value');
      b.param('mod', v.mod, 'value', { group: true });
      b.param('modp', v.modp, 'value');
      b.param('attack', v.env, 'a');
      b.param('release', v.env, 'r');
      b.param('drone', v.drone, 'value', { group: true });
      b.param('level', v.vca, 'gain');
      b.param('chrm', v.chrm, 'mix');
      b.param('octave', v.octave, 'value');
      b.param('seq steps', v.seq, 'len', { group: true });
    });
    b.param('scale', scaleM, 'value', { col: true, head: 'pitch' });
    b.param('tuning', tuningM, 'value');
    b.param('portamento', portaM, 'value');
    b.param('tune follow', followM, 'value');
    b.param('modp chain', chainM, 'value', { group: true });
    b.param('cutoff', cutoffM, 'value', { head: 'filter' });
    b.param('reso', resoM, 'value');
    b.param('filter', filterM, 'value');
    b.param('routing', routeM, 'value');
    b.param('saturation', sat, 'mix', { group: true });
    b.param('drive', satS, 'drive');
    b.param('curve', satS, 'mode');
    b.param('time', dly, 'time', { col: true, head: 'delay' });
    b.param('fdbk', fdbk, 'gain');
    b.param('mix', dmix, 'mix');
    b.param('color', color, 'cutoff');
    b.param('sync', dly, 'sync', { group: true });
    b.param('reverb', revM, 'value', { head: 'reverb' });
    b.param('size', rv, 'size');
    b.param('damp', rv, 'damp');
    b.param('mix', rv, 'mix', { group: true });
    b.param('bite', bite, 'drive', { head: 'ouch' });
    b.param('choke', choke, 'cutoff');
    b.param('vol', vol, 'l1');
    b.param('feedback', ouchIn, 'l2', { group: true });
    b.param('diode', bite, 'sym');
    b.param('ext in', ouchIn, 'l3');
    b.param('lfo 1 freq', L1.freq, 'value', { col: true, head: 'lfos' });
    b.param('lfo 1 wave', lfo1Wave, 'value');
    b.param('lfo 1 sync', L1.sync, 'value');
    b.param('lfo 1 → cutoff', amt[0].cutoff, 'gain');
    b.param('lfo 2 freq', L2.freq, 'value', { group: true });
    b.param('lfo 2 wav', wav, 'value');
    b.param('lfo 2 mode', lfo2Mode, 'value');
    b.param('lfo 2 sync', L2.sync, 'value');
    b.param('lfo 2 → bite', amt[1].bite, 'gain', { group: true });
    b.param('lfo 1 → bite', amt[0].bite, 'gain', { head: 'lfo 1 to' });
    b.param('lfo 1 → choke', amt[0].choke, 'gain');
    b.param('lfo 1 → time', amt[0].time, 'gain');
    b.param('lfo 1 → wave', amt[0].wave, 'gain', { group: true });
    b.param('lfo 1 → mod', amt[0].mod, 'gain');
    b.param('lfo 2 → cutoff', amt[1].cutoff, 'gain', { head: 'lfo 2 to' });
    b.param('lfo 2 → choke', amt[1].choke, 'gain');
    b.param('lfo 2 → time', amt[1].time, 'gain');
    b.param('lfo 2 → wave', amt[1].wave, 'gain', { group: true });
    b.param('lfo 2 → mod', amt[1].mod, 'gain');
    b.param('att 1', att[0], 'gain', { col: true, head: 'att / add' });
    b.param('att 2', att[1], 'gain');
    b.param('add 1', add, 'ka');
    b.param('add 2', add, 'kb');
    b.param('out', scope, 'view', { group: true });
  });
}

/** the patch's notes (Patch.notes, at most 500 characters) */
const NOTES =
  "The neutral labs Elmyra 2 in full, after its manual (v2.4): per voice touch, ENV, drone, MOD with all eleven MODP programs (0 DETUNE .. 1 DJ in tenths), CHRM, scales and EDOs, octave, tune follow, an 8-step sequence; the twelve filter types, reversed routing, delay to 1.6 s with color and sync, reverb, OUCH, two LFOs to audio rate with S&H / S&G and sync, ATT, ADD, and the jacks as ports. A choice of N is a 0..1 row in N even steps. Not here: external audio, bit flipping, recording. Browser only.";

export const xl: Xl = {
  base: 'Elvira 2',
  build: (fm1) => {
    const x = around('Elvira 2 XL', elviraXl(platesOf(fm1)));
    for (const [label, port] of [['clock', 'clock'], ['pressure', 'at']]) {
      const r = x.a.inputs.find((q) => q.label === label)!;
      for (const t of [r, ...(r.also ?? [])]) x.p.cables.push({ from: { module: x.main.id, port }, to: { module: t.module, port: t.port } });
    }
    x.p.octave = -1;
    matchLevel(x.p, fm1, KIT_NOTES.slice(0, 4));
    x.p.notes = NOTES;
    return players(validatePatch(x.p, DEFS), true);
  },
};
