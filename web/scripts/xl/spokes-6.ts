// SPDX-License-Identifier: GPL-3.0-only
// Spokes 6 XL: the Elektron Model:Cycles whole, as far as modules reach, after its user manual (OS 1.x: the track
// parameters p. 37, GATE and the LFO pp. 38-39, the FX p. 40, the retrigs p. 27, the trig conditions pp. 31-32, chromatic
// mode p. 20, the scale menu p. 29, appendix B's modulation destinations, appendix C's chord shapes). The FM-1 version
// (gen-assemblies.ts, Spokes 6) has one fixed machine per track, no reverb, pan, per-track distortion, LFO, swing or chance,
// and its SNARE and METAL do without phase modulation, to fit.
//
// Six tracks, each the same: every track holds all six machines (KICK, SNARE, METAL, PERC, TONE, CHORD, each with its
// pitch, decay, color, shape, sweep and contour rows) and `machine` picks the one its trigs play (0 kick, 0.2 snare,
// 0.4 metal, 0.6 perc, 0.8 tone, 1 chord), as the original's MACHINES menu does; track n starts on machine n. All six
// play every trig and one Selector passes the chosen one's sound (with a 5 ms crossfade on a change). Per track:
// - the sequencer: three Steps tracks (NAME, NAME FL, NAME NF: `build` below). Each has its own length, rate (the scale
//   menu's per-track mode: 1/2 is the original's 1/8X, a step of a half note), swing (to 80 %, as the original) and
//   per-note chance, note, velocity and length (the trig's NOTE, VEL, LEN and its X % condition). FL plays only while the
//   master `fill` is on (the FILL condition), NF only while it is off (not FILL). Arming a track plays the keys through
//   it (chromatic mode; TONE also takes Main's keys unarmed, as on the FM-1).
// - pads: the empty DRUMS track's keys (arm it; its Arpeggiator, bypassed, in front) play the Drum map's rows 1..6 on the
//   white keys from F3, one per track at its root note, with the key's velocity (the T1..T6 pads).
// - `chance` (the probability every trig plays), `mute`, `fine` (a fine tune of up to a semitone and beyond), `level`
//   (the track level), `volume` + `dist` (VOLUME + DIST: a waveshaper's level and drive), `pan`, the `delay` and `reverb`
//   sends, `punch` (a compressor into a soft clip, crossfaded in), `gate` (GATE: 0 the envelope goes straight to its
//   decay, 1 it holds at full while the note is held, then decays).
// - retrigs: `retrig` on plays every trig as a roll at `retrig rate` (a note length synced to the tempo, sped up or
//   slowed down by `retrig x`: x8 of a 1/16 triplet is a 1/128 triplet; or `retrig hz` with `retrig sync` off) for
//   `retrig len` (`retrig inf`: until the next trig, the original's INF), its velocity fading over that length by
//   `retrig fade` (0.5 none, below fades in, above fades out).
// - the LFO: `lfo speed` (Hz, `lfo range` slow / fast: 0.0008 to 80 Hz) or, with `lfo sync`, `lfo mult` (a note length
//   at the tempo) times `lfo sync x` (/8 .. x8), `lfo back` (a negative speed: the wave runs backward), `lfo phase` (the
//   start phase, where a trig or the clock restarts it), `lfo wave` (sine, triangle, saw, square, random), `lfo depth`,
//   `lfo trig` (restart on every trig: the trig mode), `lfo env` (crossfades to a one-shot envelope of `lfo env time`
//   from every trig: the Envelope wave), `lfo fade in` / `lfo fade out` (0 none, else the speed of the fade after every
//   trig), and an amount per destination of appendix B's list: `lfo>pitch`, `fine`, `decay`, `color`, `shape`, `sweep`,
//   `contour`, `delay`, `reverb`, `vol`, `pan`, `punch`, `gate` (bipolar: a negative amount inverts, so the Ramp wave is
//   the saw inverted). The original's LFO has one destination: this one reaches each with its own amount (set one and
//   the others at 0 to play it as the original).
// - velocity: the same destinations plus the LFO's speed (and mult), wave, depth, fade and trig mode, `vel>...`, from the
//   note's velocity (full velocity = no change); `vel>vol` starts at 1 (an accent is louder).
// Master: the delay (`time`: a note length while `delay sync` is on, else ms; `note`: 1/32, 1/2T, 1/2., 1/1T or 1/1.
// in place of the time; `feedback`, which `swell` takes past 1 to 1.98 as the original's 100..198), the reverb (`size`,
// `freeze`: an infinite decay, `tone`: its high damping, `low cut`: a high pass on its return, the two halves of the
// original's bipolar TONE), `fill`, `click` (a metronome on the beat) and the scope.
//
// Not here, with why (the owner's rule for an XL: every feature of the original unless it needs a new module or Steps
// feature, is hardware, or needs the original's samples):
// - needs a Steps feature: parameter locks on any row but NOTE, VEL and LEN (and machine and preset locks); micro timing
//   (trig nudge); the conditions PRE, NEI, 1ST and A:B (a note carries only a chance); patterns, banks and chains (a
//   Steps track holds one pattern).
// - needs a module feature: the retrig rates 1/5, 1/10, 1/20, 1/40 and 1/80 synced to the tempo (a synced LFO's lengths
//   are halves and thirds, none a fifth; `retrig hz` reaches them at one tempo); a synced retrig length of up to 16 steps
//   at any tempo (`retrig len` is in seconds, 2 s at most: 16 steps at 120 BPM); the chord machine's 34 named chord
//   types on one knob (a Selector holds eight values: 34 shapes of three intervals would take a dozen and more per track;
//   here the chord's notes are three interval rows, `shape`, `note 3` and the `color` stack, which reach them all, and
//   `spread` detunes for the unisons).
// - hardware: the pads' velocity curve, MIDI out per track, the click's own output, Control All, Overbridge and the +Drive.
import { addModule, paramUnit, type Patch } from '../../src/patch';
import { DEFS } from '../../src/modules';
import { Engine } from '../../src/engine';
import { fixNotes, type StepNote } from '../../src/track';
import { players, plugIn, wire } from '../factory-build';
import { around, define, KIT_NOTES } from './def';
import type { Xl } from './xl';

const NOTES = 'After the Elektron Model:Cycles manual: six tracks, each able to play any of the six FM machines (kick, ' +
  'snare, metal, perc, tone, chord: pitch, decay, color, shape, sweep, contour), with fine tune, level, volume + dist, pan, ' +
  'delay and reverb sends, punch, gate mode, chance, mute, retrigs (rate to a 1/128 triplet, length or INF, fade) and an ' +
  'LFO (speed or a tempo multiple, backward, start phase, wave, depth, trig mode, envelope wave, fade in / out) and ' +
  'velocity, each reaching appendix B\'s destinations; three Steps tracks per track (always, fill, not fill: per-track ' +
  'length, scale down to 1/8X, swing to 80 % and per-note chance), pads on DRUMS, a tempo-synced delay that swells past ' +
  '100 %, a reverb with freeze and low cut, fill and click. Elektron does not publish the engines: what color, shape, ' +
  'sweep and contour do per machine follows the manual and reviews. Missing (no module or Steps feature does it yet): ' +
  'parameter locks beyond note, velocity and length, micro timing, the PRE / NEI / 1ST / A:B conditions, patterns and ' +
  'chains, the quintuplet retrig rates synced, retrig lengths in steps, the 34 chord types on one knob.';

const TEMPO = 120;
type Ref = [number, string];
type Dest = 'decay' | 'color' | 'shape' | 'sweep' | 'contour';
/** a machine: its modules, the audio it makes, where the track's pitch and gate go, what `gate` and the destinations move */
interface Machine {
  name: string;
  members: number[];
  out: number[];
  /** the oscillators the track's pitch (note, fine, LFO, velocity) goes into, or a pitch scale's `in` */
  pitch: Ref[];
  gates: Ref[];
  /** the gate mode: these parameters of this module, between these ends as `gate` goes 0..1 */
  gate: [number, Record<string, [number, number]>];
  rows: [string, number, string][];
  dest: Record<Dest, [number, string[]]>;
}

/** env (Env L/R) time as a unit position (paramUnit) */
const envU = (s: number): number => paramUnit(DEFS.env.params.find((q) => q.name === 'r1')!, s);
const pulseU = (s: number): number => paramUnit(DEFS.pulse.params.find((q) => q.name === 'time')!, s);

const LFO_DESTS = ['pitch', 'fine', 'decay', 'color', 'shape', 'sweep', 'contour', 'delay', 'reverb', 'vol', 'pan', 'punch', 'gate'] as const;
const VEL_DESTS = [...LFO_DESTS, 'lfo speed', 'lfo wave', 'lfo depth', 'lfo fade', 'lfo trig'] as const;
type ModDest = (typeof VEL_DESTS)[number];

const TRACKS = ['kick', 'snare', 'metal', 'perc', 'tone', 'chord'];

const built = define('Spokes 6 XL', (b) => {
  /** the pins taken on each module (one source group per pin) */
  const taken = new Map<number, Record<string, string>>();
  /** the pin of `id` that controls `params` (with macro ranges), taken now if no pin does yet; returns it */
  const pinOf = (id: number, params: string[], ranges?: Record<string, [number, number]>): 'p1' | 'p2' => {
    const key = params.join() + (ranges ? JSON.stringify(ranges) : '');
    const t = taken.get(id) ?? {};
    taken.set(id, t);
    for (const p of ['p1', 'p2'] as const) if (t[p] === key) return p;
    const free = (['p1', 'p2'] as const).find((p) => t[p] === undefined);
    if (!free) throw new Error(`Spokes 6 XL: no pin left on ${b.module(id).type} ${id} for ${params}`);
    t[free] = key;
    for (const q of params) b.pin(id, free, q, ranges?.[q]);
    b.module(id).map![free] = [...params];
    return free;
  };
  /** cable `src` into the parameters `params` of `id` through a pin */
  const modulate = (src: number, id: number, params: string[], ranges?: Record<string, [number, number]>, port = 'out'): void => {
    b.wire(src, port, id, pinOf(id, params, ranges));
  };

  const map = b.add('drummap', 0, 0, Object.fromEntries(KIT_NOTES.map((n, r) => [`n${r + 1}`, n])));
  b.module(map).names = ['KICK', 'SNARE', 'METAL', 'PERC', 'TONE', 'CHORD', 'ROW 7', 'ROW 8'];
  const one = b.add('const', 0, 0.5, { value: 1 });
  const clocked: Ref[] = [];
  const fill = b.add('macro', 0, 1.5, { value: 0 });
  const nofill = b.add('scale', 0, 2, { gain: -1, offset: 1 });
  b.wire(fill, 'out', nofill, 'in');
  // the stereo mix: A takes tracks 1..4, B tracks 5 and 6, A's sum and the returns
  const lA = b.add('mixer', 8, 0, { l1: 1, l2: 1, l3: 1, l4: 1 });
  const rA = b.add('mixer', 8, 0.5, { l1: 1, l2: 1, l3: 1, l4: 1 });
  const lB = b.add('mixer', 8, 1, { l1: 1, l2: 1, l3: 1, l4: 1 });
  const rB = b.add('mixer', 8, 1.5, { l1: 1, l2: 1, l3: 1, l4: 1 });
  const dsA = b.add('mixer', 8, 2, { l1: 1, l2: 1, l3: 1, l4: 1 });
  const dsB = b.add('mixer', 8, 2.5, { l1: 1, l2: 1, l3: 1, l4: 0 });
  const rsA = b.add('mixer', 8, 3, { l1: 1, l2: 1, l3: 1, l4: 1 });
  const rsB = b.add('mixer', 8, 3.5, { l1: 1, l2: 1, l3: 1, l4: 0 });
  // the delay synced to the tempo (time: a note length, here 1/8.), the reverb, its low cut
  const dly = b.add('delay', 9, 2, { time: 261, fb: 0.4, mix: 1, pingpong: 1, sync: 1 });
  const rev = b.add('reverb', 9, 3, { size: 0.6, damp: 0.5, mix: 1 });
  const lowcut = b.add('filter', 9, 3.5, { cutoff: 20, res: 0 });
  clocked.push([dly, 'clk']);
  // the click: a short blip on every beat (the clock's 24th pulse) while `click` is on
  const div3 = b.add('clkdiv', 9, 4, { div: 3 });
  const div8 = b.add('clkdiv', 9, 4.3, { div: 8 });
  const clickOn = b.add('macro', 9, 4.6, { value: 0 });
  const clickG = b.add('logic', 9, 4.9);
  const clickEnv = b.add('adsr', 9, 5.2, { a: 0.001, d: 0.025, s: 0, r: 0.02 });
  const clickOsc = b.add('osc', 9, 5.5, { wave: 0, coarse: 24, level: 0.3 });
  const clickVca = b.add('vca', 9, 5.8, { gain: 1 });
  clocked.push([div3, 'clock']);
  b.wire(div3, 'out', div8, 'clock');
  b.wire(div8, 'out', clickG, 'a');
  b.wire(clickOn, 'out', clickG, 'b');
  b.wire(clickG, 'and', clickEnv, 'gate');
  b.wire(clickOsc, 'out', clickVca, 'in');
  b.wire(clickEnv, 'env', clickVca, 'cv');
  b.wire(clickVca, 'out', lB, 'in4');
  b.wire(clickVca, 'out', rB, 'in4');
  const scope = b.add('scope', 10, 0, { time: 16 });
  b.wire(lA, 'out', lB, 'in3');
  b.wire(rA, 'out', rB, 'in3');
  b.wire(dsA, 'out', dsB, 'in3');
  b.wire(rsA, 'out', rsB, 'in3');
  b.wire(dsB, 'out', dly, 'in');
  b.wire(rsB, 'out', rev, 'in');
  b.wire(rev, 'out', lowcut, 'in');
  b.wire(dly, 'out', lB, 'in4');
  b.wire(dly, 'r', rB, 'in4');
  b.wire(lowcut, 'hp', lB, 'in4');
  b.wire(lowcut, 'hp', rB, 'in4');
  b.wire(lB, 'out', scope, 'a');
  b.wire(rB, 'out', scope, 'b');

  // ---- the machines (as the FM-1 version's, with phase modulation on the snare and the metal); a drum's amp envelope is
  // one-shot (gate 0) or held while the note is (gate 1); `pitch` is where the track's pitch goes
  /** a drum's amp envelope: l1 at once, to l2 in r2 (the decay); gate 1 makes l2 = l3 = 1 and the release (r4) the decay */
  const drumEnv = (col: number, row: number, decay: number): number =>
    b.add('env', col, row, { l1: 1, r1: 0.001, l2: 0, r2: decay, l3: 0, r3: 0.001, l4: 0, r4: decay, shot: 1 });
  const DRUM_GATE: Record<string, [number, number]> = { l2: [0, 1], l3: [0, 1], shot: [1, 0] };
  const kick = (col: number): Machine => {
    const env = drumEnv(col, 7, 0.45);
    const penv = b.add('adsr', col, 7.2, { a: 0.001, d: 0.05, s: 0, r: 0.08 });
    const sweep = b.add('scale', col, 7.4, { gain: 2.5, offset: -2.25 });
    const car = b.add('osc', col, 7.6, { wave: 0, pm: 0.4, level: 1 });
    const op = b.add('osc', col, 7.8, { wave: 0, coarse: 12, level: 1 });
    const vca = b.add('vca', col, 8, { gain: 1 });
    b.wire(penv, 'env', sweep, 'in');
    b.wire(sweep, 'out', car, 'pitch');
    b.wire(sweep, 'out', op, 'pitch');
    b.wire(op, 'out', car, 'pm');
    b.wire(car, 'out', vca, 'in');
    b.wire(env, 'env', vca, 'cv');
    return {
      name: 'kick', members: [env, penv, sweep, car, op, vca], out: [vca], pitch: [[car, 'pitch'], [op, 'pitch']], gates: [[env, 'gate'], [penv, 'gate']], gate: [env, DRUM_GATE],
      rows: [['pitch', sweep, 'offset'], ['decay', env, 'r2'], ['color', car, 'pm'], ['shape', op, 'coarse'], ['sweep', sweep, 'gain'], ['contour', penv, 'd']],
      dest: { decay: [env, ['r2', 'r4']], color: [car, ['pm']], shape: [op, ['coarse']], sweep: [sweep, ['gain']], contour: [penv, ['d']] },
    };
  };
  const snare = (col: number): Machine => {
    const env = drumEnv(col, 9, 0.16);
    const sweep = b.add('scale', col, 9.2, { gain: 0.5, offset: -0.75 });
    const car = b.add('osc', col, 9.4, { wave: 0, pm: 1.2, level: 0.8 });
    const op = b.add('osc', col, 9.6, { wave: 0, coarse: 6, fine: 30, level: 1 });
    const vca = b.add('vca', col, 9.8, { gain: 1 });
    const nz = b.add('noise', col, 10, { level: 0.8, color: 0.3 });
    const nenv = b.add('adsr', col, 10.2, { a: 0.001, d: 0.12, s: 0, r: 0.15 });
    const nvca = b.add('vca', col, 10.4, { gain: 1 });
    b.wire(env, 'env', sweep, 'in');
    b.wire(sweep, 'out', car, 'pitch');
    b.wire(sweep, 'out', op, 'pitch');
    b.wire(op, 'out', car, 'pm');
    b.wire(car, 'out', vca, 'in');
    b.wire(env, 'env', vca, 'cv');
    b.wire(nz, 'out', nvca, 'in');
    b.wire(nenv, 'env', nvca, 'cv');
    return {
      name: 'snare', members: [env, sweep, car, op, vca, nz, nenv, nvca], out: [vca, nvca], pitch: [[car, 'pitch'], [op, 'pitch']], gates: [[env, 'gate'], [nenv, 'gate']], gate: [env, DRUM_GATE],
      rows: [['pitch', sweep, 'offset'], ['decay', env, 'r2'], ['color', car, 'pm'], ['shape', nz, 'level'], ['sweep', sweep, 'gain'], ['contour', nenv, 'd']],
      dest: { decay: [env, ['r2', 'r4']], color: [car, ['pm']], shape: [nz, ['level']], sweep: [sweep, ['gain']], contour: [nenv, ['d']] },
    };
  };
  const metal = (col: number): Machine => {
    const env = drumEnv(col, 11, 0.12);
    const pitch = b.add('scale', col, 11.2, { gain: 0, offset: 2.5 });
    const car = b.add('osc', col, 11.4, { wave: 3, pw: 0.5, pm: 2, level: 0.8 });
    const op = b.add('osc', col, 11.6, { wave: 0, coarse: 7, fine: 35, level: 1 });
    const open = b.add('scale', col, 11.8, { gain: 1, offset: 0 });
    const hp = b.add('filter', col, 12, { cutoff: 2500, res: 0.1, cvamt: 2 });
    const vca = b.add('vca', col, 12.2, { gain: 1 });
    b.wire(pitch, 'out', car, 'pitch');
    b.wire(pitch, 'out', op, 'pitch');
    b.wire(op, 'out', car, 'pm');
    b.wire(env, 'env', open, 'in');
    b.wire(open, 'out', hp, 'cv');
    b.wire(car, 'out', hp, 'in');
    b.wire(hp, 'hp', vca, 'in');
    b.wire(env, 'env', vca, 'cv');
    return {
      name: 'metal', members: [env, pitch, car, op, open, hp, vca], out: [vca], pitch: [[car, 'pitch'], [op, 'pitch']], gates: [[env, 'gate']], gate: [env, DRUM_GATE],
      rows: [['pitch', pitch, 'offset'], ['decay', env, 'r2'], ['color', op, 'coarse'], ['shape', hp, 'cutoff'], ['sweep', open, 'gain'], ['contour', car, 'pm']],
      dest: { decay: [env, ['r2', 'r4']], color: [op, ['coarse']], shape: [hp, ['cutoff']], sweep: [open, ['gain']], contour: [car, ['pm']] },
    };
  };
  const perc = (col: number): Machine => {
    const env = drumEnv(col, 13, 0.25);
    const sweep = b.add('scale', col, 13.2, { gain: 0.3, offset: -0.5 });
    const ienv = b.add('adsr', col, 13.4, { a: 0.001, d: 0.08, s: 0, r: 0.1 });
    const car = b.add('osc', col, 13.6, { wave: 0, pm: 2.5, level: 1 });
    const op = b.add('osc', col, 13.8, { wave: 0, coarse: 19, level: 1 });
    const ivca = b.add('vca', col, 14, { gain: 1 });
    const vca = b.add('vca', col, 14.2, { gain: 1 });
    b.wire(env, 'env', sweep, 'in');
    b.wire(sweep, 'out', car, 'pitch');
    b.wire(sweep, 'out', op, 'pitch');
    b.wire(op, 'out', ivca, 'in');
    b.wire(ienv, 'env', ivca, 'cv');
    b.wire(ivca, 'out', car, 'pm');
    b.wire(car, 'out', vca, 'in');
    b.wire(env, 'env', vca, 'cv');
    return {
      name: 'perc', members: [env, sweep, ienv, car, op, ivca, vca], out: [vca], pitch: [[car, 'pitch'], [op, 'pitch']], gates: [[env, 'gate'], [ienv, 'gate']], gate: [env, DRUM_GATE],
      rows: [['pitch', sweep, 'offset'], ['decay', env, 'r2'], ['color', car, 'pm'], ['shape', op, 'coarse'], ['sweep', sweep, 'gain'], ['contour', ienv, 'd']],
      dest: { decay: [env, ['r2', 'r4']], color: [car, ['pm']], shape: [op, ['coarse']], sweep: [sweep, ['gain']], contour: [ienv, ['d']] },
    };
  };
  const tone = (col: number): Machine => {
    const pitch = b.add('scale', col, 15, { gain: 1, offset: 0 });
    const env = b.add('adsr', col, 15.2, { a: 0.002, d: 0.5, s: 0, r: 0.3 });
    const ienv = b.add('adsr', col, 15.4, { a: 0.001, d: 0.3, s: 0, r: 0.3 });
    const op = b.add('osc', col, 15.6, { wave: 0, coarse: 12, level: 1 });
    const nz = b.add('noise', col, 15.8, { level: 0, color: 0 });
    const ivca = b.add('vca', col, 16, { gain: 1 });
    const car = b.add('osc', col, 16.2, { wave: 0, pm: 1.5, level: 1 });
    const vca = b.add('vca', col, 16.4, { gain: 1 });
    b.wire(pitch, 'out', op, 'pitch');
    b.wire(pitch, 'out', car, 'pitch');
    b.wire(op, 'out', ivca, 'in');
    b.wire(nz, 'out', ivca, 'in');
    b.wire(ienv, 'env', ivca, 'cv');
    b.wire(ivca, 'out', car, 'pm');
    b.wire(car, 'out', vca, 'in');
    b.wire(env, 'env', vca, 'cv');
    return {
      name: 'tone', members: [pitch, env, ienv, op, nz, ivca, car, vca], out: [vca], pitch: [[pitch, 'in']], gates: [[env, 'gate'], [ienv, 'gate']], gate: [env, { s: [0, 1] }],
      rows: [['pitch', pitch, 'offset'], ['decay', env, 'd'], ['color', op, 'coarse'], ['shape', car, 'pm'], ['sweep', nz, 'level'], ['contour', ienv, 'd']],
      dest: { decay: [env, ['d']], color: [op, ['coarse']], shape: [car, ['pm']], sweep: [nz, ['level']], contour: [ienv, ['d']] },
    };
  };
  const chord = (col: number): Machine => {
    // four voices: the root with its stack (color), the second note (shape), the third (note 3), a detuned root (spread);
    // the amp is an attack (contour) times a decay (decay), so the gate mode and both can be modulated
    const pitch = b.add('scale', col, 17, { gain: 1, offset: 0 });
    const atk = b.add('adsr', col, 17.2, { a: 0.005, d: 0.001, s: 1, r: 0.4 });
    const dec = b.add('adsr', col, 17.4, { a: 0.001, d: 0.8, s: 0, r: 0.4 });
    const o1 = b.add('osc', col, 17.6, { wave: 2, stack: 2, level: 0.45 });
    const o2 = b.add('osc', col, 17.8, { wave: 2, coarse: 3, fine: 4, level: 0.3 });
    const o3 = b.add('osc', col, 18, { wave: 2, fine: -12, level: 0.25 });
    const o4 = b.add('osc', col, 18.2, { wave: 2, coarse: 0, fine: 7, level: 0.15 });
    const lp = b.add('filter', col, 18.4, { cutoff: 2000, res: 0.2 });
    const va = b.add('vca', col, 18.6, { gain: 1 });
    const vd = b.add('vca', col, 18.8, { gain: 1 });
    for (const o of [o1, o2, o3, o4]) {
      b.wire(pitch, 'out', o, 'pitch');
      b.wire(o, 'out', lp, 'in');
    }
    b.wire(lp, 'lp24', va, 'in');
    b.wire(atk, 'env', va, 'cv');
    b.wire(va, 'out', vd, 'in');
    b.wire(dec, 'env', vd, 'cv');
    return {
      name: 'chord', members: [pitch, atk, dec, o1, o2, o3, o4, lp, va, vd], out: [vd], pitch: [[pitch, 'in']], gates: [[atk, 'gate'], [dec, 'gate']], gate: [dec, { s: [0, 1] }],
      rows: [['pitch', pitch, 'offset'], ['decay', dec, 'd'], ['color', o1, 'stack'], ['shape', o2, 'coarse'], ['sweep', lp, 'cutoff'], ['contour', atk, 'a'], ['note 3', o4, 'coarse'], ['spread', o3, 'fine']],
      dest: { decay: [dec, ['d']], color: [o1, ['stack']], shape: [o2, ['coarse']], sweep: [lp, ['cutoff']], contour: [atk, ['a']] },
    };
  };
  const MACHINES = [kick, snare, metal, perc, tone, chord];

  // ---- a track
  const PAN = [0, -0.15, 0.3, -0.35, 0.1, 0.25];
  const VOLUME = [0.9, 0.85, 0.9, 0.6, 0.35, 0.7];
  const DSEND = [0, 0.15, 0.1, 0.3, 0.25, 0.2];
  const RSEND = [0, 0.25, 0.2, 0.2, 0.2, 0.5];
  const CHANCE_HZ = [39.1, 37.3, 35.7, 33.1, 31.9, 29.7];
  type Track = { name: string; members: number[]; ins: [string, number, string][]; l: number; r: number; rows: [string, number, string, { head?: string; col?: boolean; group?: boolean }?][] };
  const tracks: Track[] = [];
  const lanes: Record<string, Ref[]> = {};
  const track = (i: number): void => {
    const name = TRACKS[i];
    const col = 1 + i;
    const members: number[] = [];
    const add = (type: string, row: number, p: Record<string, number> = {}): number => {
      const id = b.add(type, col, row, p);
      members.push(id);
      return id;
    };
    const ins: Track['ins'] = [];
    const lane = (label: string, ...to: Ref[]): void => {
      lanes[`${name} ${label}`] = to;
      ins.push([`${name} ${label}`, ...to[0]]);
    };
    // the sources: the track's three Steps tracks (always, fill, not fill) and its pad, combined into one gate; the
    // velocity and the note of whichever fired, held from its trig
    // (gates: a VCA is an and, a mixer an or)
    const fT = add('vca', 0, { gain: 1 });
    const nT = add('vca', 0.05, { gain: 1 });
    const any = add('mixer', 0.1, { l1: 1, l2: 1, l3: 1, l4: 1 });
    b.wire(fill, 'out', fT, 'cv');
    b.wire(nofill, 'out', nT, 'cv');
    b.wire(fT, 'out', any, 'in2');
    b.wire(nT, 'out', any, 'in3');
    b.wire(map, `g${i + 1}`, any, 'in4');
    lane('trig', [any, 'in1']);
    lane('fill trig', [fT, 'in']);
    lane('nfill trig', [nT, 'in']);
    const pick = (what: 'vel' | 'pitch', row: number): number => {
      const x1 = add('xfade', row, { mix: 0 });
      const x2 = add('xfade', row + 0.05, { mix: 0 });
      const x3 = add('xfade', row + 0.1, { mix: 0 });
      const held = add('sh', row + 0.15);
      b.wire(fT, 'out', x1, 'pos');
      b.wire(x1, 'out', x2, 'a');
      b.wire(nT, 'out', x2, 'pos');
      b.wire(x2, 'out', x3, 'a');
      b.wire(map, `g${i + 1}`, x3, 'pos');
      if (what === 'vel') b.wire(map, `v${i + 1}`, x3, 'b'); // (a pad plays the root: its pitch is 0)
      b.wire(x3, 'out', held, 'in');
      b.wire(any, 'out', held, 'clock');
      lane(what, [x1, 'a']);
      lane(`fill ${what}`, [x1, 'b']);
      lane(`nfill ${what}`, [x2, 'b']);
      return held;
    };
    const vel = pick('vel', 0.25);
    const note = pick('pitch', 0.5);
    // chance and mute: a random value held at the trig (an S&H LFO of its own speed, so the tracks draw apart) above
    // 1 - 2 chance plays it; mute adds 4 to the bar
    const rnd = add('lfo', 0.75, { wave: 4, rate: CHANCE_HZ[i], depth: 1 });
    const rndH = add('sh', 0.8);
    const chance = add('macro', 0.85, { value: 1 });
    const mute = add('macro', 0.9, { value: 0 });
    const cmp = add('math', 0.95, { ka: 1, kb: 4, off: 1 });
    const gated = add('vca', 1, { gain: 1 });
    b.wire(rnd, 'out', rndH, 'in');
    b.wire(any, 'out', rndH, 'clock');
    b.wire(rndH, 'out', cmp, 'a');
    b.wire(mute, 'out', cmp, 'b');
    modulate(chance, cmp, ['off'], { off: [paramUnit(DEFS.math.params[2], -1), paramUnit(DEFS.math.params[2], 1)] });
    b.wire(any, 'out', gated, 'in');
    b.wire(cmp, 'cmp', gated, 'cv');
    // retrigs: a square restarted by the trig, for `retrig len`, in place of the trig while `retrig` is on; its velocity
    // fade is the amp (`retrig fade`: 0.5 none, a fade in below, a fade out above, over the same length)
    const rtOn = add('macro', 1.05, { value: 0 });
    const rtLen = add('macro', 1.1, { value: 0.5 });
    const rtLfo = add('lfo', 1.15, { wave: 3, sync: 1, div: 1, rate: 16, bpm: TEMPO });
    const rtWin = add('pulse', 1.2, { time: 0.25 });
    const rtG = add('vca', 1.25, { gain: 1 });
    const gate = add('xfade', 1.3, { mix: 0 });
    clocked.push([rtLfo, 'clk']);
    b.wire(gated, 'out', rtLfo, 'reset');
    b.wire(gated, 'out', rtWin, 'trig');
    b.wire(rtLfo, 'out', rtG, 'in');
    b.wire(rtWin, 'out', rtG, 'cv');
    b.wire(gated, 'out', gate, 'a');
    b.wire(rtG, 'out', gate, 'b');
    b.wire(rtOn, 'out', gate, 'pos');
    const LEN: [number, number] = [pulseU(0.02), pulseU(2)];
    const LEN_ENV: [number, number] = [envU(0.02), envU(2)];
    modulate(rtLen, rtWin, ['time'], { time: LEN });
    const rtFade = add('macro', 1.35, { value: 0.5 });
    const fm = add('math', 1.4, { ka: 2, off: -1 });
    const fa = add('vca', 1.45, { gain: 1 });
    const envG = add('vca', 1.5, { gain: 1 });
    const fin = add('env', 1.55, { l1: 0, r1: 0.001, l2: 1, r2: 0.25, l3: 1, r3: 0.001, l4: 1, r4: 0.001, shot: 1 });
    const fout = add('env', 1.6, { l1: 1, r1: 0.001, l2: 0, r2: 0.25, l3: 0, r3: 0.001, l4: 0, r4: 0.001, shot: 1 });
    const fsel = add('xfade', 1.65, { mix: 0 });
    const amp = add('xfade', 1.7, { mix: 0 });
    b.wire(rtFade, 'out', fm, 'a');
    b.wire(fm, 'abs', fa, 'in');
    b.wire(rtOn, 'out', fa, 'cv');
    b.wire(gated, 'out', envG, 'in');
    b.wire(rtOn, 'out', envG, 'cv');
    for (const e of [fin, fout]) {
      b.wire(envG, 'out', e, 'gate');
      modulate(rtLen, e, ['r2'], { r2: LEN_ENV });
    }
    b.wire(fin, 'env', fsel, 'a');
    b.wire(fout, 'env', fsel, 'b');
    b.wire(fm, 'cmp', fsel, 'pos');
    b.wire(one, 'out', amp, 'a');
    b.wire(fsel, 'out', amp, 'b');
    b.wire(fa, 'out', amp, 'pos');
    // the LFO: free (Hz) or synced (a note length), restarted by the trig while `lfo trig` is on; `lfo env` crossfades to
    // a one-shot decay from every trig; the fades: an envelope from every trig in front of the depth
    const lfo = add('lfo', 2, { wave: 0, rate: 2, depth: 1, bpm: TEMPO });
    const rstOn = add('macro', 2.05, { value: 0 });
    const rst = add('vca', 2.1, { gain: 1 });
    const lenv = add('env', 2.15, { l1: 1, r1: 0.001, l2: 0, r2: 0.5, l3: 0, r3: 0.001, l4: 0, r4: 0.001, shot: 1 });
    const wsel = add('xfade', 2.2, { mix: 0 });
    clocked.push([lfo, 'clk']);
    b.wire(gated, 'out', rst, 'in');
    b.wire(rstOn, 'out', rst, 'cv');
    b.wire(rst, 'out', lfo, 'reset');
    b.wire(gated, 'out', lenv, 'gate');
    b.wire(lfo, 'out', wsel, 'a');
    b.wire(lenv, 'env', wsel, 'b');
    const FADE: [number, number] = [envU(10), envU(0.05)];
    const fade = (row: number, inward: boolean): [number, number] => {
      const m = add('macro', row, { value: 0 });
      const on = add('math', row + 0.05, { off: -0.005 });
      const e = add('env', row + 0.1, inward
        ? { l1: 0, r1: 0.001, l2: 1, r2: 1, l3: 1, r3: 0.001, l4: 1, r4: 0.001, shot: 1 }
        : { l1: 1, r1: 0.001, l2: 1, r2: 0.001, l3: 1, r3: 0.001, l4: 0, r4: 1, shot: 1 });
      b.wire(m, 'out', on, 'a');
      b.wire(gated, 'out', e, 'gate');
      // on: the fade-in starts from 0 (else 1: nothing to fade), the fade-out ends at 0 (else 1); the macro: its speed
      modulate(on, e, [inward ? 'l1' : 'l4'], { [inward ? 'l1' : 'l4']: [1, 0] }, 'cmp');
      modulate(m, e, [inward ? 'r2' : 'r4'], { [inward ? 'r2' : 'r4']: FADE });
      return [m, e];
    };
    const [fadeIn, finE] = fade(2.25, true);
    const [fadeOut, foutE] = fade(2.4, false);
    const vIn = add('vca', 2.55, { gain: 1 });
    const depth = add('vca', 2.6, { gain: 1 });
    b.wire(wsel, 'out', vIn, 'in');
    b.wire(finE, 'env', vIn, 'cv');
    b.wire(vIn, 'out', depth, 'in');
    b.wire(foutE, 'env', depth, 'cv');
    const lfoBus = depth;
    // velocity: 0 at full velocity, -1 at none
    const velBus = add('scale', 2.65, { gain: 1, offset: -1 });
    b.wire(vel, 'out', velBus, 'in');

    // the voice's pitch: the note, fine tune and the modulation, into every machine
    const fine = add('scale', 2.7, { gain: 0, offset: 0 });
    const fineSum = add('scale', 2.75, { gain: 1 / 12, offset: 0 });
    const pbus = add('scale', 2.8, { gain: 1, offset: 0 });
    b.wire(one, 'out', fine, 'in');
    b.wire(fine, 'out', fineSum, 'in');
    b.wire(fineSum, 'out', pbus, 'in');
    b.wire(note, 'out', pbus, 'in');

    // the machines and which one plays: every machine plays every trig, and a Selector passes the chosen one's sound
    // (`machine` 0..1 spans its positions 1..6: within 0.1 of k / 5 plays machine k), with a short crossfade on a change
    const machine = add('macro', 3, { value: i / 5 });
    const gateMode = add('macro', 3.05, { value: 0 });
    const choice = add('select', 3.1, { pos: 1, count: MACHINES.length, fade: 5 });
    b.wire(machine, 'out', choice, 'pos');
    const ms: Machine[] = [];
    MACHINES.forEach((make, k) => {
      const m = make(col);
      members.push(...m.members);
      for (const [id, port] of m.gates) b.wire(gate, 'out', id, port);
      for (const [id, port] of m.pitch) b.wire(pbus, 'out', id, port);
      for (const o of m.out) b.wire(o, 'out', choice, `in${k + 1}`);
      modulate(gateMode, m.gate[0], Object.keys(m.gate[1]), m.gate[1]);
      ms.push(m);
    });
    // punch (a compressor into a soft clip, crossfaded in), volume + dist, the level (and the retrig fade), pan, sends
    const punch = add('xfade', 4, { mix: 0 });
    const pdyn = add('dyn', 4.05, { thresh: -20, ratio: 8, attack: 0.003, release: 0.08, gain: 10 });
    const pclip = add('shape', 4.1, { drive: 1.6, mode: 0, level: 0.75 });
    b.wire(choice, 'out', punch, 'a');
    b.wire(choice, 'out', pdyn, 'in');
    b.wire(pdyn, 'out', pclip, 'in');
    b.wire(pclip, 'out', punch, 'b');
    const dist = add('shape', 4.15, { drive: 1, mode: 0, level: VOLUME[i] });
    const level = add('vca', 4.2, { gain: 1 });
    const pan = add('pan', 4.25, { pan: PAN[i] });
    const ds = add('vca', 4.3, { gain: DSEND[i] });
    const rs = add('vca', 4.35, { gain: RSEND[i] });
    b.wire(punch, 'out', dist, 'in');
    b.wire(dist, 'out', level, 'in');
    b.wire(amp, 'out', level, 'cv');
    b.wire(level, 'out', pan, 'in');
    for (const s of [ds, rs]) {
      b.wire(level, 'out', s, 'in');
      b.wire(one, 'out', s, 'cv');
    }
    const n = i < 4 ? i + 1 : i - 3;
    const [l, r, dm, rm] = i < 4 ? [lA, rA, dsA, rsA] : [lB, rB, dsB, rsB];
    b.wire(pan, 'l', l, `in${n}`);
    b.wire(pan, 'r', r, `in${n}`);
    b.wire(ds, 'out', dm, `in${n}`);
    b.wire(rs, 'out', rm, `in${n}`);

    // the modulation: an amount per source and destination (appendix B), a scale each
    const target = (d: ModDest, src: number, port: string): void => {
      if (d === 'pitch') return void b.wire(src, port, pbus, 'in');
      if (d === 'fine') return void b.wire(src, port, fineSum, 'in');
      if (d === 'pan') return void b.wire(src, port, pan, 'pos');
      if (d === 'punch') return void b.wire(src, port, punch, 'pos');
      if (d === 'delay') return modulate(src, ds, ['gain'], undefined, port);
      if (d === 'reverb') return modulate(src, rs, ['gain'], undefined, port);
      if (d === 'vol') return modulate(src, dist, ['level', 'drive'], undefined, port);
      if (d === 'gate') return modulate(src, gateMode, ['value'], undefined, port);
      if (d === 'lfo speed') return modulate(src, lfo, ['rate', 'div'], undefined, port);
      if (d === 'lfo wave') return modulate(src, lfo, ['wave'], undefined, port);
      if (d === 'lfo depth') return modulate(src, depth, ['gain'], undefined, port);
      if (d === 'lfo trig') return modulate(src, rstOn, ['value'], undefined, port);
      if (d === 'lfo fade') {
        modulate(src, fadeIn, ['value'], undefined, port);
        return modulate(src, fadeOut, ['value'], undefined, port);
      }
      for (const mm of ms) {
        const [id, params] = mm.dest[d];
        modulate(src, id, params, undefined, port);
      }
    };
    // one Math per destination both reach: add = LFO x ka + velocity x kb; a Scale for velocity's own (the LFO's rows)
    const amounts: [string, number, string][] = [];
    LFO_DESTS.forEach((d, j) => {
      const x = add('math', 5 + j * 0.03, { ka: 0, kb: d === 'vol' ? 1 : 0, off: 0 });
      b.wire(lfoBus, 'out', x, 'a');
      b.wire(velBus, 'out', x, 'b');
      target(d, x, 'add');
      amounts.push([`lfo>${d}`, x, 'ka'], [`vel>${d}`, x, 'kb']);
    });
    VEL_DESTS.slice(LFO_DESTS.length).forEach((d, j) => {
      const x = add('scale', 5.5 + j * 0.03, { gain: 0, offset: 0 });
      b.wire(velBus, 'out', x, 'in');
      target(d, x, 'out');
      amounts.push([`vel>${d}`, x, 'gain']);
    });

    const rows: Track['rows'] = [
      ['machine', machine, 'value', { head: `${i + 1} ${name}`, ...(i % 2 === 0 ? { col: true } : {}) }],
      ['fine', fine, 'gain'],
      ['level', level, 'gain'],
      ['volume', dist, 'level'],
      ['dist', dist, 'drive'],
      ['pan', pan, 'pan'],
      ['delay', ds, 'gain'],
      ['reverb', rs, 'gain'],
      ['punch', punch, 'mix', { group: true }],
      ['gate', gateMode, 'value'],
      ['chance', chance, 'value'],
      ['mute', mute, 'value'],
      ['retrig', rtOn, 'value', { group: true }],
      ['retrig rate', rtLfo, 'div'],
      ['retrig sync', rtLfo, 'sync'],
      ['retrig x', rtLfo, 'mult'],
      ['retrig hz', rtLfo, 'rate'],
      ['retrig len', rtLen, 'value'],
      ['retrig inf', rtWin, 'inf'],
      ['retrig fade', rtFade, 'value'],
      ['lfo speed', lfo, 'rate', { head: `${i + 1} lfo` }],
      ['lfo sync', lfo, 'sync'],
      ['lfo mult', lfo, 'div'],
      ['lfo sync x', lfo, 'mult'],
      ['lfo range', lfo, 'range'],
      ['lfo back', lfo, 'dir'],
      ['lfo phase', lfo, 'phase'],
      ['lfo wave', lfo, 'wave'],
      ['lfo depth', depth, 'gain'],
      ['lfo trig', rstOn, 'value'],
      ['lfo env', wsel, 'mix'],
      ['lfo env time', lenv, 'r2'],
      ['lfo fade in', fadeIn, 'value'],
      ['lfo fade out', fadeOut, 'value'],
      ...amounts.filter(([l]) => l.startsWith('lfo>')).map(([l, x, p], j): Track['rows'][number] => [l, x, p, j === 0 ? { group: true } : undefined]),
      ...amounts.filter(([l]) => l.startsWith('vel>')).map(([l, x, p], j): Track['rows'][number] => [l, x, p, j === 0 ? { head: `${i + 1} velocity` } : undefined]),
      ...ms.flatMap((m) => m.rows.map(([l, id, p], j): Track['rows'][number] => [l, id, p, j === 0 ? { head: `${i + 1} ${m.name} machine` } : undefined])),
    ];
    tracks.push({ name, members, ins, l: pan, r: pan, rows });
  };
  TRACKS.forEach((_, i) => track(i));
  tracks.forEach((t, i) => b.nest(`${i + 1} ${t.name}`, 1 + i, 0, t.members, { inputs: t.ins, outputs: [['l', t.l, 'l'], ['r', t.r, 'r']] }));
  b.input('keys', map, 'keys');
  b.input('clock', ...clocked[0], ...clocked.slice(1));
  for (const [label, to] of Object.entries(lanes)) b.input(label, ...to[0], ...to.slice(1));
  b.output('l', lB, 'out');
  b.output('r', rB, 'out');
  for (const t of tracks) for (const [label, id, p, o] of t.rows) b.param(label, id, p, o);
  b.param('time', dly, 'time', { col: true, head: 'delay' });
  b.param('delay sync', dly, 'sync');
  b.param('note', dly, 'note');
  b.param('feedback', dly, 'fb');
  b.param('swell', dly, 'swell');
  b.param('size', rev, 'size', { head: 'reverb' });
  b.param('freeze', rev, 'freeze');
  b.param('tone', rev, 'damp');
  b.param('low cut', lowcut, 'cutoff');
  b.param('fill', fill, 'value', { head: 'master' });
  b.param('click', clickOn, 'value');
  b.param('out', scope, 'view', { col: true });
});

const SR = 44118;
/** the RMS and peak of a patch over `secs` with the transport running (its patterns playing) */
function playing(p: Patch, secs = 4): { rms: number; peak: number } {
  const e = new Engine(SR);
  e.load(p);
  e.transport(true);
  const l = new Float32Array(SR * secs), r = new Float32Array(l.length);
  e.render(l, r);
  let sum = 0, peak = 0;
  for (let i = 0; i < l.length; i++) {
    sum += l[i] * l[i] + r[i] * r[i];
    peak = Math.max(peak, Math.abs(l[i]), Math.abs(r[i]));
  }
  return { rms: Math.sqrt(sum / (2 * l.length)), peak };
}

/** the Steps track names of track `t`: always, fill, not fill (at most 8 characters) */
const LANES = (t: string): [string, string][] => [['', t], ['fill ', `${t} FL`], ['nfill ', `${t} NF`]];

export const xl: Xl = {
  base: 'Spokes 6',
  build: (fm1: Patch): Patch => {
    const x = around('Spokes 6', built);
    const p = x.p;
    p.notes = NOTES;
    const tempo = fm1.modules.find((m) => m.type === 'fm1')!.params.tempo;
    x.main.params.tempo = tempo;
    for (const m of p.modules) if (m.type === 'lfo') m.params.bpm = tempo;
    plugIn(p, x.main.id, 'clock', x.a, 'clock');
    // the FM-1 version's patterns: DRUMS's rows to the drum tracks (at the root note), TONE and CHORD as they are; DRUMS
    // stays, empty, for the pads (its keys into the Drum map, the Arpeggiator between: D-342)
    p.cables = p.cables.filter((c) => !(c.from.module === x.main.id && c.from.port === 'keys'));
    const src = (name: string): StepNote[] => structuredClone(fm1.modules.find((m) => m.type === 'steps' && m.name === name)!.notes ?? []) as StepNote[];
    const drums = src('DRUMS');
    let y = 300;
    const steps = (name: string, notes: StepNote[]): number => {
      const st = addModule(p, DEFS.steps, 20, y);
      y += 300;
      st.name = name;
      st.notes = fixNotes(notes);
      return st.id;
    };
    const pads = steps('DRUMS', []);
    plugIn(p, pads, 'keys', x.a, 'keys');
    TRACKS.forEach((t, i) => {
      const own = i < 4 ? drums.filter((n) => n.note === KIT_NOTES[i]).map((n) => ({ ...n, note: 60 })) : src(t.toUpperCase());
      for (const [pre, label] of LANES(t.toUpperCase())) {
        const id = steps(label, pre ? [] : own);
        for (const out of ['trig', 'pitch', 'vel']) plugIn(p, id, out, x.a, `${t} ${pre}${out}`);
        if (t === 'tone' && !pre) wire(p, x.main.id, 'keys', id, 'keys');
      }
    });
    p.octave = -1;
    const q = players(p, true);
    // the level: the XL's patterns as loud as the FM-1 version's (RMS), playing, kept under a peak of 0.95
    const out = q.modules.find((m) => m.type === 'output')!;
    out.params.level = 0.1;
    const got = playing(q, 8); // (8 s: the delay and the reverb build up after the first 4)
    const lv = Math.min((0.1 * playing(fm1, 8).rms) / Math.max(got.rms, 1e-9), (0.1 * 0.95) / Math.max(got.peak, 1e-9));
    out.params.level = Math.round(Math.max(0.01, Math.min(1, lv)) * 100) / 100;
    return q;
  },
};
