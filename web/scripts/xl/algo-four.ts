// SPDX-License-Identifier: GPL-3.0-only
// Algo Four XL: the Yamaha DX100 in full, after the Yamaha DX100 Owner's Manual (chapter III "The Function Mode", chapter
// IV "The Voice Parameters", the specifications and the voice data tables 5-1 / 5-2; a copy:
// homepages.abdn.ac.uk/d.j.benson/pages/dx7/manuals/dx100-man.pdf). The FM-1 version (gen-assemblies.ts,
// Algo Four) plays three voices, gives the two modulators ADSRs, keeps operator 4's feedback at 0 and wires one algorithm
// (5: 2 into 1, 4 into 3).
//
// The card (docs/ledger/patches-and-presets.md D-347): one row per parameter of the DX100, named as its LCD names it
// (lowercase), switches as named choices:
//   voice        algorithm (1..8), feedback
//   lfo          lfo wave (SAW UP, SQUARE, TRIANGLE, S/HOLD), lfo speed, lfo delay, pmd, amd, lfo sync (OFF, ON), pms, ams
//   per operator freq ratio, detune, out level, key velocity; ar, d1r, d1l, d2r; rr, rate scaling, level scaling, eg bias
//                sens; operator (the OPERATOR ON-OFF buttons: OFF, ON) and ams (AMS ON-OFF: OFF, ON). The DX100 edits one
//                operator at a time (OPERATOR SELECT): the card shows the operators as copies, one at a time, picked on an
//                `op` row (D-638), in four runs of at most four rows (one FM-1 page each), so the card has four `op` rows
//                where the DX100 has one button
//   performance  poly/mono, p bend range, porta mode (FULL TIME, FINGERED), porta time, foot sw (SUSTAIN, PORTAMENTO), mw
//                pitch, mw ampli, bc pitch, bc ampli, bc p bias, bc e bias, transpose, m.tune
// PB MODE offers LOW, HIGH and KON. The four `op` row runs remain a card limitation.
// How each is built:
// - POLY/MONO: the Voicing's voice count (8 = POLY, "up to 8 notes"; 1 = MONO).
// - ALGORITHM 1..8: a Selector's position. Its value table puts the position on its out, which moves each voice's four
//   route Selectors to the same position: one in front of the phase input of each of operators 1, 2 and 3 and one for
//   what is heard. Input k of each takes what algorithm k sends there, cables summed:
//     algorithm  paths                heard
//     1          4→3, 3→2, 2→1       1
//     2          3→2, 4→2, 2→1       1
//     3          3→2, 2→1, 4→1       1
//     4          4→3, 3→1, 2→1       1
//     5          2→1, 4→3            1, 3
//     6          4→1, 4→2, 4→3       1, 2, 3
//     7          4→3                 1, 2, 3
//     8          (none)              1, 2, 3, 4
// - FEEDBACK 0..7 on operator 4, in every algorithm.
// - Per operator: FREQUENCY RATIO (`freq ratio`, semitones, with `detune` in cents: 3.14 = 20 st - 19 ct), DETUNE
//   (+-2.6 cents: the same `detune`), OPERATOR OUT LEVEL, the envelope (AR, D1R towards D1L, D2R towards the Env L/R's
//   third level, RR; the Env L/R module, its first level at the top as the DX100's attack; the DX100's rates are speeds,
//   here times), KEY VELOCITY 0..7 (0 none, 1 the full range; a note at velocity v plays at 1 - velocity x (1 - v)),
//   KEYBOARD SCALING LEVEL (the level falls by that much over the four octaves above C2, the DX100's lowest key), RATE
//   SCALING 0..3 (every segment's time halves per octave above C2 at 3), the AMS switch (a Selector in front of the
//   amplitude modulation: OFF passes nothing), EG BIAS SENSITIVITY 0..7 and the operator's switch (a Selector after the
//   oscillator: OFF silences it). Velocity, level scaling, amplitude modulation and EG bias move the oscillator's level
//   (its p2 pin, the four added).
// - The LFO, once for all voices: LFO WAVE (a Selector, the four waves the manual lists, in its order), LFO SPEED, LFO
//   DELAY (a Macro on an Env L/R that holds the LFO at 0 for that time, then fades it in over as long, as the manual's
//   "initial delay ... which slowly increases over" the same time; 0 none, 1 = 10 s; it starts again on a key played
//   after all were released), LFO SYNC (ON restarts the LFO on every key played, at the wave's peak: a second Selector,
//   set by the wave, gives the LFO's `phase`; the saw starts at the foot of its ramp, just past its peak), LFO PMD and
//   AMD, PITCH MODULATION SENSITIVITY (`pms`: 1 = 7, the PMD at 1 then +-800 cents) and AMPLITUDE MODULATION
//   SENSITIVITY (`ams`: 1 = 3, the level then down to 0 at the LFO's peak).
// - Performance (stored per voice on the DX100): PITCH BEND RANGE (octaves: 0.17 = 2 semitones, 1 = 12), PORTAMENTO TIME
//   (seconds; 0.001 off) and MODE (FINGERED glides only from a held key; with more than one voice each voice glides from
//   its own last note), FOOT SWITCH ASSIGN (the footswitch is Main sustain, MIDI CC 64: SUSTAIN holds
//   the notes to the D2R limit; PORTAMENTO glides only while it is down), MODULATION WHEEL RANGE PITCH and AMPLITUDE,
//   BREATH RANGE PITCH, AMPLITUDE, PITCH BIAS (+-4 octaves, as the manual) and EG BIAS: the breath controller is the
//   Main `breath` output (MIDI CC 2).
// - KEY SHIFT and the voice's TRANSPOSE (`transpose`, octaves, rounded to semitones by a Quantizer: 0.08 = +1, 2 = +24)
//   and MASTER TUNE (`m.tune`, semitones, +-1 as the manual's +-100 cents).
// - PB MODE gates the scaled bend per voice with Voicing low/high outputs, or a constant one for KON.
//   Low/high follow held allocated notes; Kon keeps bending release tails too.
// Not on the card, and why:
// - Construction, kept at its values in the patch: each operator's octave (ratios past 16.96 need it on top of the freq
//   ratio's semitones) and phase modulation index (the modulator's out level is the depth on the DX100), the Env L/R's
//   third level (D2R decays towards it: 0 as on the DX100; a D2R of 0, holding at D1L, needs it at D1L, which the card
//   cannot set), the LFO's range (`lfo speed` spans 0.02..40 Hz on its normal range; the DX100's 0.0008..55 Hz needs the
//   range too), and the envelope and output displays.
// - POLY/MONO is a number (8 or 1), not a switch: a Selector cannot set a Voicing's voice count (D-635 keeps a Voicing's
//   settings off a shared row). Named choices need that in both engines.
// Too big for the FM-1. The browser version keeps all eight voices; deviceBudget reports its current limits.
// The cassette interface, the voice memories, VOICE NAME and the MIDI functions are the browser's patches and presets. The
// DX100 has no chorus, pitch EG or foot volume (its voice data marks them "not used").
import type { Patch } from '../../src/patch';
import { players, plugIn } from '../factory-build';
import { around, define, matchLevel, type Def } from './def';
import { setCopies } from '../../src/assembly';
import type { Xl } from './xl';

const NOTES = "DX100 panel; operators use four pickers (card limit). POLY/MONO is voice count (8/1): Selectors cannot set it. LFO SPEED is 0.02–40 Hz, not 0.0008–55; its range control is hidden. D2R zero cannot hold D1L from this card (linked level hidden). PB MODE selects LOW/HIGH/KON. Breath uses CC 2; foot uses CC 64. Ratio uses semitones, detune cents, bend octaves. Cartridge, MIDI settings and stored patch memory are hardware/storage, not reproduced.";


/** each path's algorithms (1..8): the route Selectors' input k takes the path when algorithm k lists it */
const PATHS: [string, number, number, number[]][] = [
  // label, from operator, into operator (0: heard), algorithms
  ['2→1', 2, 1, [1, 2, 3, 4, 5]],
  ['3→1', 3, 1, [4]],
  ['4→1', 4, 1, [3, 6]],
  ['3→2', 3, 2, [1, 2, 3]],
  ['4→2', 4, 2, [2, 6]],
  ['4→3', 4, 3, [1, 4, 5, 6, 7]],
  ['out 2', 2, 0, [6, 7, 8]],
  ['out 3', 3, 0, [5, 6, 7, 8]],
  ['out 4', 4, 0, [8]],
];

/** position names and runs of copies by card row index, set on the definition after `define` */
const NAMES = new Map<number, string[]>();
const COPIES: { at: number; rows: number; head: string; col: boolean }[] = [];

const built = define('Algo Four XL', (b) => {
  const part = b.add('alloc', 0, 2, { voices: 8 });

  // ---- shared: the algorithm (a Selector's position, 1..8). Its value table puts the position on its out as 0..1, which
  // moves each voice's four route Selectors to the same position.
  const algo = b.add('select', 8, 0, { pos: 5, count: 8, ...Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8].map((k) => [`v${k}`, (k - 1) / 7])) });

  // ---- shared: the LFO with its delay and sync
  const lfo = b.add('lfo', 0, 0, { wave: 0, rate: 5.5, depth: 1, phase: 0, range: 0 });
  // the wave in the DX100's order (1 SAW UP, 2 SQUARE, 3 TRIANGLE, 4 S/HOLD; 5 sine, extra): a Selector whose value is the
  // LFO's wave / 4 (p1 turns `wave` across its 0..4), and a second Selector, set by that value, gives the phase the wave's
  // peak is at (p2 turns `phase` across 0..360 degrees), so a reset (LFO SYNC) starts the wave at its peak
  const WAVE_OF = [2, 3, 1, 4, 0]; // the LFO's wave (sine, triangle, saw, square, S&H) of each DX100 position
  const PEAK_AT = [90, 180, 0, 0, 0]; // degrees, by the LFO's wave: the saw starts at the foot of its ramp, just past its peak
  const lfoWave = b.add('select', 0, -0.4, { pos: 1, count: 4, ...Object.fromEntries(WAVE_OF.map((w, k) => [`v${k + 1}`, w / 4])) });
  const lfoPeak = b.add('select', 0, -0.2, { pos: 1, count: 5, ...Object.fromEntries(PEAK_AT.map((d, w) => [`v${w + 1}`, d / 360])) });
  b.pin(lfo, 'p1', 'wave');
  b.pin(lfo, 'p2', 'phase');
  b.wire(lfoWave, 'out', lfo, 'p1');
  b.wire(lfoWave, 'out', lfoPeak, 'pos');
  b.wire(lfoPeak, 'out', lfo, 'p2');
  const delayEnv = b.add('env', 0, 0.3, { l1: 0, r1: 0.001, l2: 1, r2: 0.001, l3: 1, r3: 0.001, l4: 0, r4: 0.5 });
  const delay = b.add('macro', 0, 0.4, { value: 0 });
  b.pin(delayEnv, 'p1', 'r1', [0, 1]);
  b.pin(delayEnv, 'p1', 'r2', [0, 1]);
  b.module(delayEnv).map!.p1 = ['r1', 'r2'];
  b.wire(delay, 'out', delayEnv, 'p1');
  b.wire(part, 'gate', delayEnv, 'gate'); // (the voices' gates summed: any key down)
  const slew = b.add('glide', 0, 0.5, { time: 0.005, curve: 0 });
  const keyOn = b.add('math', 0, 0.6, { ka: 1, kb: 1, off: -0.5 }); // high briefly whenever one more key is down
  const sync = b.add('select', 0, 0.7, { pos: 2, count: 2, v1: 0, v2: 1 }); // OFF, ON
  const syncAnd = b.add('logic', 0, 0.8, {});
  b.wire(part, 'gate', slew, 'in');
  b.wire(part, 'gate', keyOn, 'a');
  b.wire(slew, 'out', keyOn, 'b');
  b.wire(keyOn, 'cmp', syncAnd, 'a');
  b.wire(sync, 'out', syncAnd, 'b');
  b.wire(syncAnd, 'and', lfo, 'reset');

  // pitch modulation: LFO x (PMD + wheel + breath) x PMS, delayed, +-800 cents at 1 x 1
  const pmd = b.add('macro', 0, 1, { value: 0 });
  const wheelP = b.add('scale', 0, 1.1, { gain: 0.15, offset: 0 });
  const breathP = b.add('scale', 0, 1.2, { gain: 0, offset: 0 });
  const pms = b.add('vca', 0, 1.3, { gain: 0.5 });
  const pmDel = b.add('vca', 0, 1.4, { gain: 1 });
  const pmOct = b.add('scale', 0, 1.5, { gain: 800 / 1200, offset: 0 });
  b.wire(lfo, 'out', pms, 'in');
  for (const d of [pmd, wheelP, breathP]) b.wire(d, 'out', pms, 'cv');
  b.wire(pms, 'out', pmDel, 'in');
  b.wire(delayEnv, 'env', pmDel, 'cv');
  b.wire(pmDel, 'out', pmOct, 'in');
  // amplitude modulation: (LFO + 1) / 2 x (AMD + wheel + breath) x AMS, delayed, taken off the level of each AM operator
  const uni = b.add('scale', 1, 1, { gain: -0.5, offset: -0.5 });
  const amd = b.add('macro', 1, 1.1, { value: 0 });
  const wheelA = b.add('scale', 1, 1.2, { gain: 0, offset: 0 });
  const breathA = b.add('scale', 1, 1.3, { gain: 0, offset: 0 });
  const ams = b.add('vca', 1, 1.4, { gain: 1 });
  const amDel = b.add('vca', 1, 1.5, { gain: 1 });
  b.wire(lfo, 'out', uni, 'in');
  b.wire(uni, 'out', ams, 'in');
  for (const d of [amd, wheelA, breathA]) b.wire(d, 'out', ams, 'cv');
  b.wire(ams, 'out', amDel, 'in');
  b.wire(delayEnv, 'env', amDel, 'cv');
  // EG bias: breath range x (breath - 1): 0 with the breath at full, down to -range with none
  const breathLess = b.add('scale', 2, 1, { gain: 1, offset: -1 });
  const egBias = b.add('scale', 2, 1.1, { gain: 0, offset: 0 });
  b.wire(breathLess, 'out', egBias, 'in');
  // pitch bias: breath x +-4 octaves
  const bias = b.add('scale', 2, 1.2, { gain: 0, offset: 0 });

  // ---- shared: the pitch every operator adds (transpose, master tune, LFO, bias), then each operator's octave
  const transpose = b.add('const', 3, 1, { value: 0 });
  const semis = b.add('quant', 3, 1.1, { scale: 0, root: 0 });
  b.wire(transpose, 'out', semis, 'in');
  const semitone = b.add('const', 3, 1.2, { value: 1 / 12 });
  const tune = b.add('scale', 3, 1.3, { gain: 0, offset: 0 });
  b.wire(semitone, 'out', tune, 'in');
  const bend = b.add('math', 3, 1.4, { ka: 2 / 12, kb: 1, off: 0 });
  const bendIn = b.add('scale', 3, 1.35, { gain: 1, offset: 0 }); // (the bend wheel: to the bend range and to each voice's key)
  b.wire(bendIn, 'out', bend, 'a');
  const bus = b.add('scale', 3, 1.5, { gain: 1, offset: 0 });
  b.wire(semis, 'out', bus, 'in');
  b.wire(tune, 'out', bus, 'in');
  b.wire(pmOct, 'out', bus, 'in');
  b.wire(bias, 'out', bus, 'in');

  // ---- shared: the footswitch (sustain or portamento) and the portamento mode
  const assign = b.add('select', 4, 1, { pos: 1, count: 2, v1: 0, v2: 1 }); // SUSTAIN, PORTAMENTO
  const fx = b.add('logic', 4, 1.1, {}); // a = assign, b = the switch: and = portamento pedal, not = assigned to sustain
  const sus = b.add('logic', 4, 1.2, {}); // a = the switch, b = assigned to sustain: and = sustain pedal
  const susNot = b.add('logic', 4, 1.3, {}); // not = no sustain pedal
  const portaOn = b.add('logic', 4, 1.4, {}); // or: portamento allowed (the pedal down, or the switch is the sustain pedal)
  const fingered = b.add('select', 4, 1.5, { pos: 1, count: 2, v1: 0, v2: 1 }); // FULL TIME, FINGERED
  const full = b.add('logic', 4, 1.6, {}); // not = full time
  b.wire(assign, 'out', fx, 'a');
  b.wire(fx, 'not', sus, 'b');
  b.wire(sus, 'and', susNot, 'a');
  b.wire(fx, 'and', portaOn, 'a');
  b.wire(fx, 'not', portaOn, 'b');
  b.wire(fingered, 'out', full, 'a');

  // ---- per voice
  const voice: number[] = [];
  const v = (type: string, col: number, row: number, p: Record<string, number> = {}): number => {
    const id = b.add(type, col, row, p);
    voice.push(id);
    return id;
  };
  // the key's pitch without the Voicing's own +-2 semitone bend (bend is added per voice after portamento), its portamento, the gate
  // the sustain pedal holds, the velocity less 1, the keys above C2 (level scaling: a quarter per octave; rate scaling)
  const bendMode = v('select', 0, 4, { pos: 3, count: 3, v1: 0, v2: 0, v3: 1, fade: 0 });
  const voiceBend = v('vca', 0, 4.1, { gain: 1 });
  b.wire(part, 'low', bendMode, 'in1');
  b.wire(part, 'high', bendMode, 'in2');
  b.wire(bend, 'add', voiceBend, 'in');
  b.wire(bendMode, 'out', voiceBend, 'cv');
  const key = v('math', 1, 4, { ka: 1, kb: -2 / 12, off: 0 });
  const porta = v('glide', 1, 4.1, { time: 0.001, curve: 0 });
  const portaPick = v('xfade', 1, 4.2, { mix: 0 });
  const legatoOr = v('logic', 1, 4.3, {});
  const portaAnd = v('logic', 1, 4.4, {});
  const gateOr = v('logic', 1, 4.5, {});
  const gate = v('sh', 1, 4.6, { mode: 1 });
  const velLess = v('scale', 1, 4.7, { gain: 1, offset: -1 });
  const kbLevel = v('math', 1, 4.8, { ka: -0.25, kb: 1, off: -0.5 });
  const kbRate = v('math', 1, 4.9, { ka: -0.025, kb: 1, off: -0.05 });
  b.wire(part, 'pitch', key, 'a');
  b.wire(bendIn, 'out', key, 'b');
  b.wire(key, 'add', porta, 'in');
  b.wire(key, 'add', portaPick, 'a');
  b.wire(porta, 'out', portaPick, 'b');
  b.wire(part, 'legato', legatoOr, 'a');
  b.wire(full, 'not', legatoOr, 'b');
  b.wire(legatoOr, 'or', portaAnd, 'a');
  b.wire(portaOn, 'or', portaAnd, 'b');
  b.wire(portaAnd, 'and', portaPick, 'pos');
  b.wire(part, 'gate', gate, 'in');
  b.wire(part, 'gate', gateOr, 'b');
  b.wire(susNot, 'not', gateOr, 'a');
  b.wire(gateOr, 'or', gate, 'clock');
  b.wire(part, 'vel', velLess, 'in');
  b.wire(key, 'add', kbLevel, 'a');
  b.wire(key, 'add', kbRate, 'a');

  // the FM-1 version's sound (algorithm 5), its modulators' envelopes as they were before they became ADSRs
  const setup: [Record<string, number>, Record<string, number>, number][] = [
    [{ wave: 0, level: 1, pm: 2.2 }, { l1: 1, r1: 0.002, l2: 0.6, r2: 1.2, l3: 0.35, r3: 1, l4: 0, r4: 0.5 }, 0.5],
    [{ wave: 0, level: 1, coarse: 12, pm: 1.5 }, { l1: 1, r1: 0.002, l2: 0.4, r2: 0.6, l3: 0.2, r3: 2, l4: 0, r4: 0.4 }, 0.8],
    [{ wave: 0, level: 1, pm: 1.5 }, { l1: 1, r1: 0.002, l2: 0.5, r2: 0.25, l3: 0, r3: 0.6, l4: 0, r4: 0.3 }, 0.35],
    [{ wave: 0, level: 1, coarse: 45, fine: 70, fb: 0.2 }, { l1: 1, r1: 0.001, l2: 0.2, r2: 0.12, l3: 0, r3: 0.3, l4: 0, r4: 0.2 }, 0.6],
  ];
  const op: number[] = [];
  const env: number[] = [];
  const vca: number[] = [];
  const octave: number[] = [];
  const ame: number[] = [];
  const ameOn: number[] = [];
  const opOn: number[] = [];
  const ebs: number[] = [];
  const vel: number[] = [];
  const kls: number[] = [];
  const krs: number[] = [];
  setup.forEach(([o, e, gain], i) => {
    op.push(v('osc', 2 + i, 4, o));
    env.push(v('env', 2 + i, 5, e));
    vca.push(v('vca', 2 + i, 6, { gain }));
    vel.push(v('xfade', 2 + i, 4.2, { mix: 0 }));
    kls.push(v('scale', 2 + i, 4.4, { gain: 0, offset: 0 }));
    krs.push(v('scale', 2 + i, 4.6, { gain: 0, offset: 0 }));
    octave.push(b.add('scale', 2 + i, 2, { gain: 1, offset: 0 }));
    ame.push(v('scale', 2 + i, 2.2, { gain: 1, offset: 0 }));
    ameOn.push(v('select', 2 + i, 2.1, { pos: 2, count: 2 })); // the AMS switch: OFF passes nothing
    opOn.push(v('select', 2 + i, 4.1, { pos: 2, count: 2 })); // the operator's switch: OFF silences it
    ebs.push(v('scale', 2 + i, 2.4, { gain: 0, offset: 0 }));
    b.pin(op[i], 'p2', 'level');
    b.pin(env[i], 'p1', 'r1');
    b.module(env[i]).map!.p1 = ['r1', 'r2', 'r3', 'r4'];
    b.wire(portaPick, 'out', op[i], 'pitch');
    b.wire(voiceBend, 'out', op[i], 'pitch');
    b.wire(bus, 'out', octave[i], 'in');
    b.wire(octave[i], 'out', op[i], 'pitch');
    b.wire(gate, 'out', env[i], 'gate');
    b.wire(op[i], 'out', opOn[i], 'in2');
    b.wire(opOn[i], 'out', vca[i], 'in');
    b.wire(env[i], 'env', vca[i], 'cv');
    b.wire(velLess, 'out', vel[i], 'b');
    b.wire(kbLevel, 'min', kls[i], 'in');
    b.wire(kbRate, 'min', krs[i], 'in');
    b.wire(amDel, 'out', ameOn[i], 'in2');
    b.wire(ameOn[i], 'out', ame[i], 'in');
    b.wire(egBias, 'out', ebs[i], 'in');
    for (const [m, port] of [[vel[i], 'out'], [kls[i], 'out'], [ame[i], 'out'], [ebs[i], 'out']] as [number, string][]) b.wire(m, port, op[i], 'p2');
    b.wire(krs[i], 'out', env[i], 'p1');
  });
  // the paths: a Selector in front of each modulated operator's phase and one for what is heard, each input k the sum of
  // what algorithm k sends there (operator 1 is heard in every algorithm)
  const into = [0, 1, 2].map((i) => v('select', 1 + i, 7, { pos: 1, count: 8, fade: 5 }));
  const out = v('select', 5, 7, { pos: 1, count: 8, fade: 5 });
  for (const s of [...into, out]) b.wire(algo, 'out', s, 'pos');
  for (let k = 1; k <= 8; k++) {
    b.wire(vca[0], 'out', out, `in${k}`);
    for (const [, from, to, algos] of PATHS) if (algos.includes(k)) b.wire(vca[from - 1], 'out', to ? into[to - 1] : out, `in${k}`);
  }
  for (let i = 0; i < 3; i++) b.wire(into[i], 'out', op[i], 'pm');
  const scope = b.add('scope', 6, 0, { time: 16 });
  b.wire(out, 'out', scope, 'a');
  b.nest('voice', 1, 4, voice, {
    inputs: [['pitch', key, 'a'], ['gate', gate, 'in']],
    poly: { flaws: Array.from({ length: 8 }, () => ({ detune: 0, drift: 0, bright: 0, env: 0, level: 100 })) },
  });

  b.input('keys', part, 'keys');
  b.input('wheel', wheelP, 'in', [wheelA, 'in']);
  b.input('breath', breathP, 'in', [breathA, 'in'], [breathLess, 'in'], [bias, 'in']);
  b.input('bend', bendIn, 'in');
  b.input('foot', fx, 'b', [sus, 'a']);
  b.output('out', out, 'out');

  // ---- the card: the DX100's parameters, named as its LCD names them (lowercase). The four operators' parameters are
  // copies the card shows one operator at a time (OPERATOR SELECT), in runs of four rows (one FM-1 page each)
  // (def.ts's param takes no names or copies: they are noted by row index here and set on the definition after it)
  let rowsSoFar = 0;
  const param: Def['param'] = (label, module, p, o) => {
    b.param(label, module, p, o);
    rowsSoFar++;
  };
  const named = (label: string, module: number, names: string[], o: { col?: boolean; head?: string } = {}): void => {
    NAMES.set(rowsSoFar, names);
    param(label, module, 'pos', o);
  };
  param('algorithm', algo, 'pos', { head: 'voice' });
  param('feedback', op[3], 'fb');
  named('lfo wave', lfoWave, ['SAW UP', 'SQUARE', 'TRIANGLE', 'S/HOLD'], { head: 'lfo' });
  param('lfo speed', lfo, 'rate');
  param('lfo delay', delay, 'value');
  param('pmd', pmd, 'value');
  param('amd', amd, 'value');
  named('lfo sync', sync, ['OFF', 'ON']);
  param('pms', pms, 'gain');
  param('ams', ams, 'gain');
  const runs: [string, (i: number) => void][] = [
    ['operator', (i) => {
      param('freq ratio', op[i], 'coarse');
      param('detune', op[i], 'fine');
      param('out level', vca[i], 'gain');
      param('key velocity', vel[i], 'mix');
    }],
    ['operator eg', (i) => {
      param('ar', env[i], 'r1');
      param('d1r', env[i], 'r2');
      param('d1l', env[i], 'l2');
      param('d2r', env[i], 'r3');
    }],
    ['operator scaling', (i) => {
      param('rr', env[i], 'r4');
      param('rate scaling', krs[i], 'gain');
      param('level scaling', kls[i], 'gain');
      param('eg bias sens', ebs[i], 'gain');
    }],
    ['operator on-off', (i) => {
      named('operator', opOn[i], ['OFF', 'ON']);
      named('ams', ameOn[i], ['OFF', 'ON']);
    }],
  ];
  runs.forEach(([head, rows], k) => {
    const at = rowsSoFar;
    for (let i = 0; i < 4; i++) rows(i);
    COPIES.push({ at, rows: (rowsSoFar - at) / 4, head, col: k === 0 });
  });
  param('poly/mono', part, 'voices', { col: true, head: 'performance' });
  param('p bend range', bend, 'ka');
  named('pb mode', bendMode, ['LOW', 'HIGH', 'KON']);
  named('porta mode', fingered, ['FULL TIME', 'FINGERED']);
  param('porta time', porta, 'time');
  named('foot sw', assign, ['SUSTAIN', 'PORTAMENTO']);
  param('mw pitch', wheelP, 'gain');
  param('mw ampli', wheelA, 'gain');
  param('bc pitch', breathP, 'gain');
  param('bc ampli', breathA, 'gain');
  param('bc p bias', bias, 'gain');
  param('bc e bias', egBias, 'gain');
  param('transpose', transpose, 'value');
  param('m.tune', tune, 'gain');
});
for (const [i, names] of NAMES) {
  const row = built.def.params[i];
  row.names = names;
  for (const a of built.def.assemblies ?? []) for (const r of a.params)
    if (r.module === row.module && r.param === row.param) r.names = [...names];
}
for (const c of COPIES) {
  const r = built.def.params[c.at];
  r.head = c.head;
  if (c.col) r.col = true;
  setCopies(built.def.params, c.at, c.rows, 4, 'op');
  // the voice card shows the same run one operator at a time when all of it is the voice's
  const voice = built.def.assemblies!.find((n) => n.label === 'voice')!;
  const run = built.def.params.slice(c.at, c.at + c.rows * 4);
  const first = voice.params.findIndex((q) => q.module === run[0].module && q.param === run[0].param);
  if (first >= 0 && run.every((x, k) => voice.params[first + k]?.module === x.module && voice.params[first + k]?.param === x.param)) setCopies(voice.params, first, c.rows, 4, 'op');
}

export const xl: Xl = {
  base: 'Algo Four',
  build: (fm1: Patch): Patch => {
    const x = around('Algo Four', built);
    x.p.notes = NOTES;
    plugIn(x.p, x.main.id, 'mod', x.a, 'wheel');
    plugIn(x.p, x.main.id, 'breath', x.a, 'breath');
    plugIn(x.p, x.main.id, 'bend', x.a, 'bend');
    plugIn(x.p, x.main.id, 'sustain', x.a, 'foot'); // MIDI CC 64, routed by FOOT SW ASSIGN
    const p = players(x.p, true);
    matchLevel(p, fm1, [48, 55, 60, 64]);
    return p;
  },
};
