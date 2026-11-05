// SPDX-License-Identifier: GPL-3.0-only
// Verona Drum 1's voices (#613), after the instrument channels of the Vermona DRM1 MKIV (its user manual, "The instrument
// channels of the DRM1 MKIV", pages 11 to 18: vermona.com, drm1mk4_manual_web_en.pdf). One function per channel, each the
// channel's own signal flow with one row per knob, named as the panel names it. gen-assemblies.ts builds the FM-1 engine
// from them (six channels, one shared noise source) and scripts/xl/verona-drum-1.ts the XL (all eight, each with its own noise,
// pan and the second hi-hat notes). Both builders have `add`, `wire` and `module`, which is all a voice needs.
//
// What each knob does, after the manual:
//  - KICK: a sine through a waveshaper (WAVE: from sine to an overdriven square), its pitch swept down by its own envelope
//    (BEND the depth, TIME its length; TIME does nothing at BEND 0, as on the original), the amp envelope (DECAY), a
//    short noise burst at a fixed length (NOISE its level) and a transient spike (ATTACK its level).
//  - DRUM 1 / DRUM 2: a sine through the waveshaper (WAVE), the one envelope (DECAY) on the level and, by BEND, the pitch
//    (centre none, clockwise falling, counter-clockwise rising), a sine modulator into the pitch (FM INT its depth, FM
//    FREQ its pitch, restarted by every hit, so the modulation starts at the same point each time), the spike (ATTACK).
//    Drum 2 sits higher (its PITCH's default), as the original's Drum 2 covers a higher range.
//  - MULTI: three square oscillators; PITCH moves all three, PITCH 2 and PITCH 3 set the second and third below it
//    (octaves), and fully counter-clockwise they are off; BEND as Drum's, the spike (ATTACK), then a high pass (HIGHPASS).
//  - SNARE: the spike rings a resonant low pass (ATTACK the spike, RESONANCE, FILTER its pitch: the tonal part). Beside it
//    the noise (NOISE its level, DECAY NOISE its length) and the pseudo reverb, a longer noise tail (REVERB its level,
//    DECAY REV its length). The DRM1's "electronic pseudo reverb" is not described further; a tail is the plainest reading.
//  - HI HAT 1 / 2: noise and a detuned cluster of squares (PITCH), crossfaded (MIX: counter-clockwise noise only), through a
//    resonant low pass (FILTER, RESONANCE) whose cutoff the envelope sweeps by BEND (as Drum's pitch); the spike (ATTACK)
//    is the cluster itself for a few milliseconds, so it follows PITCH. A hit is open (DECAY) or closed (a fixed short
//    decay): the TRIG switch says which the channel's row plays, as the original's TRIG button mode does.
//  - CLAP: a run of transient spikes (CLAP: their rate, so their number in a fixed window; fully counter-clockwise one),
//    noise shaped by them (NOISE its level, NOISE COLOR: white to darker), the pseudo reverb tail (REVERB, DECAY REV), all
//    through a resonant low pass (FILTER, RESONANCE).
// The rows are in the panel's order. A voice's velocity (a Drum map row's v) scales its level, as the DRM1's MIDI velocity
// does. Its VOLUME and PAN are the builder's (the output stage differs between the two versions).
import type { ModuleInst } from '../src/patch';

export interface VoiceBuilder {
  add(type: string, col: number, row: number, params?: Record<string, number>): number;
  wire(a: number, ap: string, b: number, bp: string): void;
  module(id: number): ModuleInst;
}

/** a built voice: its modules, the inputs that take its row's gate (and, for a hat, the closed notes'), the input that
 * takes its velocity, its output, and its knob rows in the panel's order */
export interface Voice {
  members: number[];
  gate: [number, string][];
  /** (hi-hats) the inputs a closed-only row's gate goes into: the envelopes and the latch's clock */
  closed?: [number, string][];
  vel: [number, string];
  /** (hi-hats) the closed-only row's velocity */
  closedVel?: [number, string];
  out: [number, string];
  rows: [string, number, string][];
}

/** where the voice's own noise comes from: a Noise module of its own (the XL) or a shared one (the FM-1 version) */
export type NoiseFrom = (b: VoiceBuilder, col: number, row: number) => [number, string];
export const ownNoise: NoiseFrom = (b, col, row) => [b.add('noise', col, row, { level: 1, color: 0 }), 'out'];

/** an envelope: rise in 1 ms to `l1`, fall to 0 over `decay` seconds, one shot (a drum's trig is short) */
const decayEnv = (b: VoiceBuilder, col: number, row: number, decay: number, l1 = 1): number =>
  b.add('env', col, row, { l1, r1: 0.001, l2: 0, r2: decay, l3: 0, r3: 0.001, l4: 0, r4: 0.001, shot: 1 });

/** the velocity stage: a VCA whose cv is the row's velocity; gain 127 / 100 so a plain step (velocity 100) plays the voice
 * at its own level */
export const VEL_GAIN = 1.27;

export interface Out {
  /** a VCA after the voice: cv the velocity, gain VOLUME */
  vel: number;
}

/** KICK: DECAY PITCH BEND TIME WAVE NOISE ATTACK. `lean` (the FM-1): the noise burst lasts as long as the pitch sweep
 * (TIME) instead of its own fixed time, which saves an envelope. */
export function kick(b: VoiceBuilder, col: number, noise: NoiseFrom, o: { coarse?: number; lean?: boolean } = {}): Voice {
  const osc = b.add('osc', col, 0, { wave: 0, coarse: o.coarse ?? -29, level: 1 });
  const penv = decayEnv(b, col, 1, 0.04);
  const bend = b.add('scale', col, 1.5, { gain: 2.2, offset: 0 });
  const wave = b.add('shape', col, 2, { drive: 1.4, mode: 0, level: 0.8 });
  const amp = decayEnv(b, col, 2.5, 0.5);
  const vca = b.add('vca', col, 3, { gain: 1 });
  const [nz, nzp] = noise(b, col, 3.5);
  const nEnv = o.lean ? penv : decayEnv(b, col, 4, 0.012);
  const nVca = b.add('vca', col, 4.5, { gain: 0.25 });
  const spike = decayEnv(b, col, 5, 0.002, 0.5);
  const sum = b.add('vca', col, 5.5, { gain: VEL_GAIN });
  b.wire(penv, 'env', bend, 'in');
  b.wire(bend, 'out', osc, 'pitch');
  b.wire(osc, 'out', wave, 'in');
  b.wire(wave, 'out', vca, 'in');
  b.wire(amp, 'env', vca, 'cv');
  b.wire(nz, nzp, nVca, 'in');
  b.wire(nEnv, 'env', nVca, 'cv');
  for (const m of [vca, nVca]) b.wire(m, 'out', sum, 'in');
  b.wire(spike, 'env', sum, 'in');
  const own = isShared(b, nz) ? [] : [nz];
  return {
    members: [osc, penv, bend, wave, amp, vca, ...own, ...(o.lean ? [] : [nEnv]), nVca, spike, sum],
    gate: [[penv, 'gate'], [amp, 'gate'], ...(o.lean ? [] : [[nEnv, 'gate'] as [number, string]]), [spike, 'gate']],
    vel: [sum, 'cv'], out: [sum, 'out'],
    rows: [['decay', amp, 'r2'], ['pitch', osc, 'coarse'], ['bend', bend, 'gain'], ['time', penv, 'r2'], ['wave', wave, 'drive'], ['noise', nVca, 'gain'], ['attack', spike, 'l1']],
  };
}

/** DRUM 1 / DRUM 2: DECAY PITCH BEND ATTACK FM INT FM FREQ WAVE */
export function drum(b: VoiceBuilder, col: number, o: { coarse: number; decay: number }): Voice {
  const osc = b.add('osc', col, 0, { wave: 0, coarse: o.coarse, level: 1 });
  const fm = b.add('osc', col, 1, { wave: 0, coarse: -24, level: 1 });
  const fmInt = b.add('scale', col, 1.5, { gain: 0, offset: 0 });
  const amp = decayEnv(b, col, 2, o.decay);
  const bend = b.add('scale', col, 2.5, { gain: 0.5, offset: 0 });
  const wave = b.add('shape', col, 3, { drive: 1.2, mode: 0, level: 0.8 });
  const vca = b.add('vca', col, 3.5, { gain: 1 });
  const spike = decayEnv(b, col, 4, 0.002, 0.3);
  const sum = b.add('vca', col, 4.5, { gain: VEL_GAIN });
  b.wire(fm, 'out', fmInt, 'in');
  b.wire(fmInt, 'out', osc, 'pitch');
  b.wire(amp, 'env', bend, 'in');
  b.wire(bend, 'out', osc, 'pitch');
  b.wire(osc, 'out', wave, 'in');
  b.wire(wave, 'out', vca, 'in');
  b.wire(amp, 'env', vca, 'cv');
  b.wire(vca, 'out', sum, 'in');
  b.wire(spike, 'env', sum, 'in');
  return {
    members: [osc, fm, fmInt, amp, bend, wave, vca, spike, sum],
    gate: [[amp, 'gate'], [spike, 'gate'], [fm, 'sync']],
    vel: [sum, 'cv'], out: [sum, 'out'],
    rows: [['decay', amp, 'r2'], ['pitch', osc, 'coarse'], ['bend', bend, 'gain'], ['attack', spike, 'l1'], ['fm int', fmInt, 'gain'], ['fm freq', fm, 'coarse'], ['wave', wave, 'drive']],
  };
}

/** MULTI: DECAY PITCH BEND ATTACK PITCH 2 PITCH 3 HIGHPASS. PITCH (the bend Attenuverter's offset, octaves: its output,
 * the envelope times BEND plus PITCH, goes into every oscillator's pitch) moves all three oscillators;
 * PITCH 2 / 3 set the second and third below it. In full (the XL) they are Offsets too (octaves), and at their lowest
 * (-4) the oscillator is off (a Math compares the Offset with -3.95 into a VCA), as the original's turn off fully
 * counter-clockwise. `lean` (the FM-1): they are the oscillators' coarse tune, without the off position. */
export function multi(b: VoiceBuilder, col: number, o: { lean?: boolean } = {}): Voice {
  const amp = decayEnv(b, col, 0.5, 0.22);
  const bend = b.add('scale', col, 1, { gain: 0, offset: 0 });
  const o1 = b.add('osc', col, 1.5, { wave: 3, coarse: 19, level: 0.25 });
  const vca = b.add('vca', col, 4, { gain: 1 });
  const members = [amp, bend, o1];
  /** the second or third oscillator, `oct` octaves below PITCH; returns its row */
  const extra = (row: number, oct: number): [number, string] => {
    const osc = b.add('osc', col, row + 0.33, { wave: 3, coarse: o.lean ? Math.round(19 + 12 * Math.max(oct, -4)) : 19, level: 0.25 });
    b.wire(bend, 'out', osc, 'pitch');
    members.push(osc);
    if (o.lean) {
      b.wire(osc, 'out', vca, 'in');
      return [osc, 'coarse'];
    }
    const k = b.add('const', col, row, { value: oct });
    const on = b.add('math', col, row + 0.66, { ka: 1, kb: 0, off: 3.95 });
    const gate = b.add('vca', col, row + 0.8, { gain: 1 });
    b.wire(k, 'out', osc, 'pitch');
    b.wire(k, 'out', on, 'a');
    b.wire(on, 'cmp', gate, 'cv');
    b.wire(osc, 'out', gate, 'in');
    b.wire(gate, 'out', vca, 'in');
    members.push(k, on, gate);
    return [k, 'value'];
  };
  const p2 = extra(2, -0.55);
  const p3 = extra(3, o.lean ? -0.55 : -4);   // (the FM-1's third sounds: on the second's pitch)
  const spike = decayEnv(b, col, 4.5, 0.002, 0.2);
  const hp = b.add('filter', col, 5, { cutoff: 250, res: 0.1 });
  const sum = b.add('vca', col, 5.5, { gain: VEL_GAIN });
  b.wire(amp, 'env', bend, 'in');
  b.wire(bend, 'out', o1, 'pitch');
  b.wire(o1, 'out', vca, 'in');
  b.wire(amp, 'env', vca, 'cv');
  b.wire(vca, 'out', hp, 'in');
  b.wire(hp, 'hp', sum, 'in');
  b.wire(spike, 'env', sum, 'in');
  members.push(vca, spike, hp, sum);
  return {
    members,
    gate: [[amp, 'gate'], [spike, 'gate']],
    vel: [sum, 'cv'], out: [sum, 'out'],
    rows: [['decay', amp, 'r2'], ['pitch', bend, 'offset'], ['bend', bend, 'gain'], ['attack', spike, 'l1'], ['pitch 2', ...p2], ['pitch 3', ...p3], ['highpass', hp, 'cutoff']],
  };
}

/** SNARE: DECAY REV REVERB DECAY NOISE NOISE ATTACK RESONANCE FILTER */
export function snare(b: VoiceBuilder, col: number, noise: NoiseFrom): Voice {
  const [nz, nzp] = noise(b, col, 0);
  const nEnv = decayEnv(b, col, 0.5, 0.16);
  const nVca = b.add('vca', col, 1, { gain: 0.55 });
  const rEnv = decayEnv(b, col, 1.5, 0.35);
  const rVca = b.add('vca', col, 2, { gain: 0.12 });
  const spike = decayEnv(b, col, 2.5, 0.001, 1);
  const lp = b.add('filter', col, 3, { cutoff: 240, res: 0.88 });
  const sum = b.add('vca', col, 3.5, { gain: VEL_GAIN });
  b.wire(nz, nzp, nVca, 'in');
  b.wire(nEnv, 'env', nVca, 'cv');
  b.wire(nz, nzp, rVca, 'in');
  b.wire(rEnv, 'env', rVca, 'cv');
  b.wire(spike, 'env', lp, 'in');
  b.wire(lp, 'lp12', sum, 'in');
  b.wire(nVca, 'out', sum, 'in');
  b.wire(rVca, 'out', sum, 'in');
  const own = isShared(b, nz) ? [] : [nz];
  return {
    members: [...own, nEnv, nVca, rEnv, rVca, spike, lp, sum],
    gate: [[nEnv, 'gate'], [rEnv, 'gate'], [spike, 'gate']],
    vel: [sum, 'cv'], out: [sum, 'out'],
    rows: [['decay rev', rEnv, 'r2'], ['reverb', rVca, 'gain'], ['decay noise', nEnv, 'r2'], ['noise', nVca, 'gain'], ['attack', spike, 'l1'], ['resonance', lp, 'res'], ['filter', lp, 'cutoff']],
  };
}

/** a hi-hat row's hit as a pulse this long (s): see hihat */
export const HIT_PULSE = 0.002;

/** the closed hi-hat's fixed decay (the original's is "fixed short", independent of DECAY) */
export const CLOSED_DECAY = 0.045;

/** HI HAT 1 / 2: DECAY FILTER BEND ATTACK RESONANCE MIX PITCH. A hit is open (DECAY) or closed (a fixed short decay):
 * the amp envelope falls to its second level over the closed hat's fixed time, then to 0 over DECAY, and a latch (a S&H
 * clocked by every hit of the channel) holds 1 after an open hit, 0 after a closed one, into that second level (a pin), so
 * a closed hit dies in the fixed time and cuts an open one ringing. The velocity is that of the row that hit last (a
 * Crossfader the latch moves). Two ways to play it:
 *  - `trig` (the XL): the channel's row plays it open or closed by the TRIG switch, as the original's TRIG button mode
 *    (a Math times the row's gate by the switch into the latch); `closed` is a second row that always plays it closed
 *    (the original's second MIDI note), and a second latch says which row hit last.
 *  - no `trig` (the FM-1): the row plays it open, `closed` closed, as the original's two MIDI notes.
 * The spike (ATTACK) opens the VCA further for a few milliseconds, so it is the hat's own sound and follows PITCH.
 * The two rows share the envelopes' gates and the latch's clock, and inputs add, so while one row's key is still down the
 * other row's gate makes no new edge there and its hit is lost (the closed hat right after the open one, the 1.10 early
 * check). So a row's gate comes in through a Pulse of its own (HIT_PULSE), which is down again 2 ms after the press: the
 * other row's next press is a new edge, and the latch reads a closed hit as closed while the open row's key is held. The
 * XL pulses both rows. The FM-1 version pulses only the open row (a second Pulse is 33 patch bytes it does not have), so
 * there a closed hit right after an open one cuts it, but an open hit pressed while the closed row's key is still down
 * is lost. */
export function hihat(b: VoiceBuilder, col: number, noise: NoiseFrom, o: { trig?: 1 | 2; pitch?: number } = {}): Voice {
  const [nz, nzp] = noise(b, col, 0);
  const metal = b.add('osc', col, 0.5, { wave: 3, coarse: o.pitch ?? 30, level: 0.7, unison: 5, detune: 60, pw: 0.4 });
  const mix = b.add('xfade', col, 1, { mix: 0.5 });
  const latch = b.add('sh', col, 2.5, { mode: 0 });
  const amp = b.add('env', col, 3, { l1: 1, r1: 0.001, l2: 0, r2: CLOSED_DECAY, l3: 0, r3: 0.35, l4: 0, r4: 0.001, shot: 1 });
  b.module(amp).map!.p1 = ['l2'];
  b.module(amp).att = [0.85, 1];
  const spike = decayEnv(b, col, 3.5, 0.004, 0.4);
  const bend = b.add('scale', col, 4, { gain: 0, offset: 0 });
  const lp = b.add('filter', col, 4.5, { cutoff: 9000, res: 0.25 });
  const vca = b.add('vca', col, 5, { gain: 1 });
  const vsel = b.add('xfade', col, 5.25, { mix: 0 });
  const sum = b.add('vca', col, 5.5, { gain: VEL_GAIN });
  b.wire(nz, nzp, mix, 'a');
  b.wire(metal, 'out', mix, 'b');
  b.wire(mix, 'out', lp, 'in');
  b.wire(latch, 'out', amp, 'p1');
  b.wire(amp, 'env', bend, 'in');
  b.wire(bend, 'out', lp, 'cv');
  b.wire(lp, 'lp12', vca, 'in');
  b.wire(amp, 'env', vca, 'cv');
  b.wire(spike, 'env', vca, 'cv');
  b.wire(vca, 'out', sum, 'in');
  b.wire(vsel, 'out', sum, 'cv');
  const hits: [number, string][] = [[amp, 'gate'], [spike, 'gate'], [latch, 'clock']];
  const members = [...(isShared(b, nz) ? [] : [nz]), metal, mix, latch, amp, spike, bend, lp, vca, vsel, sum];
  const rows: [string, number, string][] = [
    ['decay', amp, 'r3'], ['filter', lp, 'cutoff'], ['bend', bend, 'gain'], ['attack', spike, 'l1'], ['resonance', lp, 'res'], ['mix', mix, 'mix'], ['pitch', metal, 'coarse'],
  ];
  const pOpen = b.add('pulse', col - 0.25, 2, { time: HIT_PULSE });
  members.push(pOpen);
  /** each row's hits from its own pulse: [[the pulse's trig]] is what the row's gate goes into */
  const via = (pl: number, to: [number, string][]): [number, string][] => {
    for (const [m, port] of to) b.wire(pl, 'out', m, port);
    return [[pl, 'trig']];
  };
  if (!o.trig) {
    b.wire(latch, 'out', vsel, 'pos');
    return { members, gate: via(pOpen, [...hits, [latch, 'in']]), closed: hits, vel: [vsel, 'b'], closedVel: [vsel, 'a'], out: [sum, 'out'], rows };
  }
  // TRIG: open (1) or closed (0); the row's gate times it into the latch; a second latch, 1 after the row and 0 after the
  // closed row, picks the velocity
  const pClosed = b.add('pulse', col - 0.25, 2.5, { time: HIT_PULSE });
  const trig = b.add('select', col + 0.5, 1.5, { pos: o.trig, count: 2, v1: 1, v2: 0 });
  const which = b.add('math', col + 0.5, 2, { ka: 1, kb: 1, off: 0 });
  const last = b.add('sh', col + 0.5, 2.5, { mode: 0 });
  b.wire(trig, 'out', which, 'b');
  b.wire(which, 'mul', latch, 'in');
  b.wire(last, 'out', vsel, 'pos');
  members.push(pClosed, trig, which, last);
  rows.push(['trig', trig, 'pos']);
  return { members, gate: via(pOpen, [...hits, [which, 'a'], [last, 'in'], [last, 'clock']]), closed: via(pClosed, [...hits, [last, 'clock']]), vel: [vsel, 'b'], closedVel: [vsel, 'a'], out: [sum, 'out'], rows };
}
/** the TRIG switch's positions */
export const TRIG_NAMES = ['open', 'closed'];

/** CLAP: DECAY REV REVERB CLAP NOISE COLOR NOISE RESONANCE FILTER. The claps: an LFO square at CLAP's rate (its wide
 * range, 0.0008 to 80 Hz), restarted by the hit, through a 45 ms window (a Pulse and a Logic and): fully counter-clockwise
 * one clap, at 80 Hz four. Each rise strikes a short envelope: a spike itself, and the noise's level. */
export function clap(b: VoiceBuilder, col: number, noise: NoiseFrom, o: { color: boolean }): Voice {
  const rate = b.add('lfo', col, 0, { wave: 3, range: 3, wide: 55, depth: 1 });
  const win = b.add('pulse', col, 0.5, { time: 0.045 });
  const and = b.add('logic', col, 1, { thresh: 0.5 });
  const cenv = decayEnv(b, col, 1.5, 0.008);
  const [nz, nzp] = noise(b, col, 2);
  const nVca = b.add('vca', col, 2.5, { gain: 0.6 });
  const rEnv = decayEnv(b, col, 3, 0.2);
  const rVca = b.add('vca', col, 3.5, { gain: 0.45 });
  const lp = b.add('filter', col, 4, { cutoff: 2200, res: 0.45 });
  const sum = b.add('vca', col, 4.5, { gain: VEL_GAIN });
  b.wire(rate, 'out', and, 'a');
  b.wire(win, 'out', and, 'b');
  b.wire(and, 'and', cenv, 'gate');
  b.wire(nz, nzp, nVca, 'in');
  b.wire(cenv, 'env', nVca, 'cv');
  b.wire(nz, nzp, rVca, 'in');
  b.wire(rEnv, 'env', rVca, 'cv');
  b.wire(cenv, 'env', lp, 'in');
  b.wire(nVca, 'out', lp, 'in');
  b.wire(rVca, 'out', lp, 'in');
  b.wire(lp, 'lp12', sum, 'in');
  const own = isShared(b, nz);
  const rows: [string, number, string][] = [['decay rev', rEnv, 'r2'], ['reverb', rVca, 'gain'], ['clap', rate, 'wide']];
  if (o.color) rows.push(['noise color', nz, 'color']);
  rows.push(['noise', nVca, 'gain'], ['resonance', lp, 'res'], ['filter', lp, 'cutoff']);
  return {
    members: [rate, win, and, cenv, ...(own ? [] : [nz]), nVca, rEnv, rVca, lp, sum],
    gate: [[rate, 'reset'], [win, 'trig'], [rEnv, 'gate']],
    vel: [sum, 'cv'], out: [sum, 'out'], rows,
  };
}

/** the shared noise source of the FM-1 version is marked so a voice does not count it among its members */
const SHARED = new WeakSet<ModuleInst>();
export function sharedNoise(b: VoiceBuilder, col: number, row: number): NoiseFrom {
  const id = b.add('noise', col, row, { level: 1, color: 0 });
  SHARED.add(b.module(id));
  return () => [id, 'out'];
}
const isShared = (b: VoiceBuilder, id: number): boolean => SHARED.has(b.module(id));
