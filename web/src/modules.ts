// SPDX-License-Identifier: GPL-3.0-only
// The module library: definitions (shared with the editor) and DSP implementations.

import { ARP_MODES, ARP_RATES } from './arpeggiator';
import { DRUM_ROWS, STEP_NOTE, STEP_VEL, STEPS_MAX, TRACK_NAME_MAX, type ModuleDef, type ParamDef, type PortDef } from './patch';
import { STEPS_RATE_HT, STEPS_RATE_PIN_MAX, STEPS_RATES, SWING_MAX, SWING_PIN_MAX, type SongEntry, type StepNote } from './track';
import WT from './wavetables.json';
import { rateEnvelopeInit, rateEnvelopeProcess } from './rate-envelope';
import { formatValue } from './labels';

export interface Voice {
  /** octaves relative to middle C (MIDI 60) */
  pitch: number;
  gate: number;
  velocity: number;
  /** A key press reached this allocator in the current block; independent of pitch selection. */
  keyTrig: boolean;
  /** this held voice is at the lowest/highest note currently assigned in its group */
  low: boolean;
  high: boolean;
  /** the allocator is in unison mode, independent of held keys */
  unison: boolean;
  /** a clock tick (24 per quarter note) falls in this block while the transport runs */
  clock: boolean;
  /** the transport runs (PLAY, MIDI Start / Stop): the Main module's run output */
  run: boolean;
  /** the clock's ticks in this block while the transport runs: the sample they fall on (-1: none; MIDI clock ticks all
   * fall on sample 0), how many, and the samples per tick (from the tempo, or measured from MIDI clock) */
  tick: number;
  ticks: number;
  tickLen: number;
  /** the FM-1's patch buttons held / switched on (bit i = PANEL_BUTTONS[i]): the Main module's button outputs */
  buttons: number;
  /** the performance controls, the same for every voice: pitch bend -1..1, mod wheel 0..1, channel aftertouch 0..1 */
  bend: number;
  mod: number;
  at: number;
  /** MIDI CC 2, 64 and 65 as independent 0..1 patch controls */
  breath: number;
  sustain: number;
  foot: number;
  /** the part's number in its poly assembly (0 first) and how many parts it has (1 for the shared keyboard) */
  index: number;
  parts: number;
  /** 1 while the note began over a held one (a legato transition), 0 after a fresh start; kept until the next note */
  legato: number;
  /** the last pitch step of this voice in octaves, signed, kept until the next note */
  jump: number;
  /** the part's pitch flaw in octaves (its detune plus its drift's wander, PolyCfg.flaws): the Part module adds it; 0 outside */
  flaw: number;
}

/** the pitch bend range: +-2 semitones on the Main module's pitch output */
export const BEND_OCT = 2 / 12;

/** the FM-1's audio rate (its I2S clock, M-VAVE fm1_open FM1_AUDIO_HARDWARE_RATE; ENG_SR in engine.h). The engine runs at
 * any rate; the delay and reverb lines are fixed sample counts at this rate (as the firmware's) and scale with the rate. */
export const DEVICE_SR = 44118;

export interface Ctx {
  sr: number;
  n: number;
  inp: Record<string, Float32Array>;
  out: Record<string, Float32Array>;
  connected: Record<string, boolean>;
  /** the outputs something reads (a cable from it, a scope probe or a watch); a module may leave the others unwritten, as
   * engine.c does with an output on dummy_out. Absent: every output is read. */
  used?: Record<string, boolean>;
  p: Record<string, number>;
  voice: Voice;
  /** Display-only values after dedicated CV processing; never fed back into DSP parameters. */
  display?: Record<string, number>;
}

export interface ModuleImpl<S = any> {
  def: ModuleDef;
  init(sr: number): S;
  /** give a new instance its own random seed (engine.ts instSeed: module index and voice), for drift */
  seed?(st: S, seed: number): void;
  process(c: Ctx, st: S): void;
}

const audio = (name: string): PortDef => ({ name, kind: 'audio' });
const control = (name: string): PortDef => ({ name, kind: 'control' });
const gate = (name: string): PortDef => ({ name, kind: 'gate' });
/** the keyboard's held keys (Main -> Voice allocator): no signal a module reads, the allocator takes its notes through it */
const keys = (name: string): PortDef => ({ name, kind: 'keys' });
const param = (name: string, min: number, max: number, def: number, extra: Partial<ParamDef> = {}): ParamDef => ({
  name,
  min,
  max,
  default: def,
  ...extra,
});

/** where a filter's cutoff rests with a steady cv: cvamt octaves per unit (the editor clamps it to the range) */
const cutoffRest = (p: Record<string, number>, cv: number): number => (p.cutoff ?? 1000) * Math.pow(2, cv * (p.cvamt ?? 1));

const WAVES = ['sine', 'triangle', 'saw', 'square'];
const OSC_WAVES = [...WAVES, 'sharktooth', 'reverse saw'];
const C4 = 261.6255653;

function polyBlep(t: number, dt: number): number {
  if (t < dt) {
    t /= dt;
    return t + t - t * t - 1;
  }
  if (t > 1 - dt) {
    t = (t - 1) / dt;
    return t * t + t + t + 1;
  }
  return 0;
}

function wave(kind: number, phase: number, dt: number, pw = 0.5): number {
  switch (kind) {
    case 0:
      return Math.sin(2 * Math.PI * phase);
    case 1:
      return 4 * Math.abs(phase - Math.floor(phase + 0.5)) - 1;
    case 2:
      return 2 * phase - 1 - polyBlep(phase, dt);
    case 4: // ideal triangle/saw hybrid: both odd and even harmonics, softer than the saw alone
      return (wave(1, phase, dt) + wave(2, phase, dt)) / 2;
    case 5:
      return -wave(2, phase, dt);
    default: {
      let v = phase < pw ? 1 : -1;
      v += polyBlep(phase, dt);
      v -= polyBlep((phase + 1 - pw) % 1, dt);
      return v;
    }
  }
}

/**
 * The FM-1 front panel as a module, the patch's only input: the voice that the 27 note keys and MIDI play
 * (pitch/gate/velocity; MIDI is handled by the firmware / the browser host, not by a module) and encoders 1-4 as 0..1 values. In the browser the panel is the module's own sliders; on the
 * device the encoders feed the same outputs.
 */
/**
 * The Random module's values, integer arithmetic so the firmware matches bit for bit (Q15 values -1..1).
 * hash32: a fixed random value of a key (lowbias32). A walk: every `hold` blocks it picks a new random target, each block
 * it moves 2 / hold of the way there (hold 256 at the default rate: a new target about every 0.7 s).
 */
export function hash32(x: number): number {
  x >>>= 0;
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d) >>> 0;
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}
/** a hash as Q15 -1..1 */
export const q15 = (h: number): number => (h >>> 16) - 32768;
export interface Walk {
  seed: number;
  count: number;
  y: number;
  t: number;
}
const lcg = (s: number): number => (Math.imul(s, 1664525) + 1013904223) >>> 0;
export function walkInit(seed: number): Walk {
  const w: Walk = { seed: lcg(seed >>> 0), count: 0, y: 0, t: 0 };
  w.t = w.y = q15(w.seed);
  return w;
}
/** one block of a walk that retargets every `hold` blocks (1..65535) */
export function walkStep(w: Walk, hold: number): void {
  if (--w.count <= 0) {
    w.count = hold;
    w.seed = lcg(w.seed);
    w.t = q15(w.seed);
  }
  w.y += ((w.t - w.y) * Math.min(32768, Math.floor(65536 / hold))) >> 15;
}
/** blocks between a walk's targets at `rate` Hz (128-frame blocks; the firmware computes it the same way) */
export const walkHold = (sr: number, rate: number): number => Math.max(1, Math.min(65535, Math.round(sr / (128 * Math.max(0.01, rate)))));
/** the seed of a module instance: module index in the patch, part */
export const instSeed = (mod: number, v: number): number => Math.imul(mod * 8 + v + 1, 0x9e3779b9) >>> 0;
/** a Random module's fixed value (Q15) from its instance seed */
export const randomFixed = (seed: number): number => q15(hash32(seed >>> 0));
/** the seed of part v's drift walk in poly group g (engine.c group_seed) */
export const driftSeed = (g: number, v: number): number => Math.imul(0x51ed + g * 16 + v, 0x9e3779b9) >>> 0;
/** a part's pitch flaw, Q16 octaves: detune (cents) plus the drift walk (Q15) scaled by drift % (engine.c the same) */
export const flawQ16 = (detune: number, drift: number, walkY: number): number =>
  Math.trunc((detune * 65536) / 1200) + Math.trunc((walkY * drift * 1092) / 3276800); // 1092 = DRIFT_CENTS (20) / 1200 in Q16

export const LEGATO_MODES = ['auto', 'off', 'on'];
export const PRIORITIES = ['last', 'low', 'high'];
/** how a poly assembly hands notes to its parts (engine.ts allocate): the next part in turn, the lowest-numbered free
 * part, or a free part whose last note was the key (else the one free the longest) */
export const ASSIGN_MODES = ['rotate', 'lowest', 'reuse', 'reset'];

/** the FM-1 panel's buttons a patch owns (#57 decision 4), gate outputs of the Main module; the device keeps PRESET, PLAY,
 * SAVE, HOME and OCT- / OCT+. The knobs K1..K4 are no signals: they edit the rows of the device page in focus (pages.ts),
 * and the SELECT / ALGO encoders pick the device and the page. */
export const PANEL_BUTTONS = ['fx', 'scl', 'env', 'lfo', 'edit', 'glo', 'arp'];
/** a panel button's name on screen: SEL for `scl` (Felucca's table spells it SCL; the button reads SEL), else the id in capitals */
export const buttonLabel = (b: string): string => (b === 'scl' ? 'SEL' : b.toUpperCase());
/** what a fixed button does, for the dock and the button editor */
export const FIXED_DOES: Record<string, string> = {
  glo: 'the FM-1’s own settings on its knobs (MIDI channel, clock in, MIDI out, LEDs; set them on the FM-1); again: back',
  scl: 'one level deeper on the FM-1: an environment row’s pages, a track’s steps',
  env: 'the environment on the FM-1: every device from Main to the Output (here the canvas is the environment); held + SAVE stores the device’s preset',
};   // SEQ and REC: the device's step page (#83)
/** the Main module's tempo range (bpm) */
export const TEMPO_MIN = 20;
export const TEMPO_MAX = 300;

const fm1: ModuleImpl<null> = {
  def: {
    type: 'fm1',
    label: 'Main',
    // the one input: the morph position added to the `morph` parameter (block mean, one block late), so an LFO or a
    // sequencer can morph the patch; the engine reads it, not this module (engine.ts morphPosition)
    inputs: [control('morph')],
    // pitch / gate / vel: the shared keyboard (one note: the last held, legato); keys: the held keys for Voice allocators
    // (the keyboard's ribbon cable to a polysynth's CPU); clock: 24 ppqn while the transport runs; run: high while it runs
    outputs: [control('pitch'), gate('gate'), control('vel'), gate('clock'), control('bend'), control('mod'), control('at'), keys('keys'), gate('run'), ...PANEL_BUTTONS.map(gate), control('breath'), control('sustain'), control('foot')],
    params: [
      param('morph', 0, 1, 0, { step: 0.01, input: 'morph', rest: (p, cv) => (p.morph ?? 0) + cv }),
      // the patch's tempo: the engine's clock (24 ppqn) runs from it unless MIDI clock comes in; arpeggiators and the clock output follow it
      param('tempo', TEMPO_MIN, TEMPO_MAX, 120, { step: 1, unit: 'bpm' }),
    ],
  },
  init: () => null,
  process(c) {
    c.out.pitch.fill(c.voice.pitch + c.voice.bend * BEND_OCT, 0, c.n); // the bend is already in the pitch (+-2 st)
    c.out.gate.fill(c.voice.gate, 0, c.n);
    c.out.vel.fill(c.voice.velocity, 0, c.n);
    c.out.bend.fill(c.voice.bend, 0, c.n); // the raw wheel, for other uses
    c.out.mod.fill(c.voice.mod, 0, c.n);
    c.out.at.fill(c.voice.at, 0, c.n);
    c.out.breath.fill(c.voice.breath, 0, c.n);
    c.out.sustain.fill(c.voice.sustain, 0, c.n);
    c.out.foot.fill(c.voice.foot, 0, c.n);
    c.out.keys.fill(c.voice.gate, 0, c.n); // 1 while a key is down (a scope shows it; the allocators take the keys themselves)
    // clock: 24 ppqn (the tempo, or MIDI clock) while the transport runs, a pulse of half a block per block that saw a tick
    const hi = c.voice.clock ? Math.ceil(c.n / 2) : 0;
    c.out.clock.fill(1, 0, hi);
    c.out.clock.fill(0, hi, c.n);
    c.out.run.fill(c.voice.run ? 1 : 0, 0, c.n);
    PANEL_BUTTONS.forEach((b, i) => c.out[b].fill((c.voice.buttons >> i) & 1, 0, c.n));
  },
};

/** operator feedback: fb = 1 moves the phase by pi radians per unit of the two-sample average of the raw wave (the DX7's level 7) */
const FB_RAD = Math.PI;
/** the 2x decimator of the FM oscillator: a polyphase half-band of four first-order allpass sections (two per path), Q16 like the
 *  firmware: flat to 0.22 fs_os (19.4 kHz), 41 dB down above 0.28 fs_os (24.7 kHz, what folds onto 19.4 kHz) */
const HB = [5376, 17567, 35764, 55599].map((q) => q / 65536);

interface OscState {
  phase: number;
  /** the previous sync sample: a rising edge (through 0.5) restarts the phase */
  s1: number;
  /** the last two raw wave values (feedback) and the previous pm sample (interpolation), only in FM mode */
  y1: number;
  y2: number;
  pm1: number;
  /** the decimator: the odd sub-sample waiting for the next frame and x1 / y1 of the four allpass sections */
  xb: number;
  ap: number[];
  /** the phases of unison voices 2..5 (voice 1 is `phase`), plain path only */
  ph: number[];
}

/** unison voice j of n: its detune in octaves, spread symmetrically from -detune to +detune cents */
const unisonOct = (j: number, n: number, detune: number): number => (n > 1 ? (detune * ((2 * j) / (n - 1) - 1)) / 1200 : 0);

/** the stack choices: the intervals (semitones) the copies cycle through, copy j at STACKS[k][j % length] */
export const STACK_NAMES = ['off', '+oct', '+5th', '+oct+5th', '-oct'];
export const STACKS = [[0], [0, 12], [0, 7], [0, 12, 19], [0, -12]];
export const OSC_COPIES = 5;


/**
 * the copy weights for unison with blend (b): the centre copy (the two middle ones for an even count) gets 1 - b, the
 * others b, normalised to a sum of 1; with one or two copies all are equal. b = 0.5 is the plain average.
 */
export function blendWeights(n: number, b: number): number[] {
  if (n <= 2) return Array(n).fill(1 / n);
  const centre = (j: number): boolean => (n % 2 ? j === (n - 1) / 2 : j === n / 2 - 1 || j === n / 2);
  const w = Array.from({ length: n }, (_, j) => (centre(j) ? 1 - b : b));
  const sum = w.reduce((a, x) => a + x, 0);
  return w.map((x) => x / sum);
}

/** one first-order allpass section of the decimator: y = a (x - y1) + x1 */
function allpass(s: number[], k: number, a: number, x: number): number {
  const y = a * (x - s[k + 1]) + s[k];
  s[k] = x;
  s[k + 1] = y;
  return y;
}

const osc: ModuleImpl<OscState> = {
  def: {
    type: 'osc',
    label: 'Oscillator',
    inputs: [control('pitch'), audio('pm'), gate('sync')],
    outputs: [audio('out')],
    params: [
      param('wave', 0, 3, 0, { step: 1, choices: OSC_WAVES, top: 5 }),
      param('pw', 0.05, 0.95, 0.5, { step: 0.01 }),
      param('coarse', -48, 48, 0, { step: 1, unit: 'st' }),
      param('fine', -100, 100, 0, { step: 1, unit: 'ct' }),
      param('pm', 0, 8, 0, { step: 0.01 }),
      param('level', 0, 1, 0.8, { step: 0.01 }),
      param('fb', 0, 1, 0, { step: 0.01 }),
      param('unison', 1, 5, 1, { step: 1 }),
      param('detune', 0, 100, 10, { step: 1, unit: 'ct' }),
      param('blend', 0, 1, 0.5, { step: 0.01 }),
      param('stack', 0, 4, 0, { step: 1, choices: STACK_NAMES }),
    ],
  },
  init: () => ({ phase: 0, s1: 0, y1: 0, y2: 0, pm1: 0, xb: 0, ap: [0, 0, 0, 0, 0, 0, 0, 0], ph: [0, 0, 0, 0] }),
  process(c, s) {
    const { pitch, pm, sync } = c.inp;
    const pw = Math.min(0.95, Math.max(0.05, c.p.pw ?? 0.5));
    const base = (c.p.coarse ?? 0) / 12 + (c.p.fine ?? 0) / 1200;
    const kind = Math.round(c.p.wave ?? 0);
    const idx = c.connected.pm ? (c.p.pm ?? 0) : 0;
    const fb = c.p.fb ?? 0;
    const lvl = c.p.level ?? 1;
    const out = c.out.out;
    if (idx <= 0 && fb <= 0) {
      // the plain oscillator: one wave per frame; unison: n detuned copies (phases s.phase, s.ph[0..n-2]) weighted by blend;
      // stack: the copies cycle through its intervals (at least one copy per interval)
      const stk = STACKS[Math.max(0, Math.min(STACKS.length - 1, Math.round(c.p.stack ?? 0)))];
      const nu = Math.min(OSC_COPIES, Math.max(stk.length, Math.max(1, Math.min(5, Math.round(c.p.unison ?? 1)))));
      const det = c.p.detune ?? 0;
      const off = Array.from({ length: nu }, (_, j) => unisonOct(j, nu, det) + stk[j % stk.length] / 12);
      const wt = blendWeights(nu, Math.min(1, Math.max(0, c.p.blend ?? 0.5)));
      for (let i = 0; i < c.n; i++) {
        const f = C4 * Math.pow(2, pitch[i] + base);
        const rst = sync[i] >= 0.5 && s.s1 < 0.5;
        s.s1 = sync[i];
        if (nu === 1) {
          const dt = Math.min((f * Math.pow(2, off[0])) / c.sr, 0.45);
          if (rst) s.phase = 0;
          s.phase += dt;
          if (s.phase >= 1) s.phase -= 1;
          out[i] = wave(kind, s.phase, dt, pw) * lvl;
          continue;
        }
        const dt0 = Math.min(f * Math.pow(2, off[0]) / c.sr, 0.45);
        if (rst) s.phase = 0;
        s.phase += dt0;
        if (s.phase >= 1) s.phase -= 1;
        let y = wave(kind, s.phase, dt0, pw) * wt[0];
        for (let j = 1; j < nu; j++) {
          const dtj = Math.min(f * Math.pow(2, off[j]) / c.sr, 0.45);
          if (rst) s.ph[j - 1] = 0;
          s.ph[j - 1] += dtj;
          if (s.ph[j - 1] >= 1) s.ph[j - 1] -= 1;
          y += wave(kind, s.ph[j - 1], dtj, pw) * wt[j];
        }
        out[i] = y * lvl;
      }
      s.y1 = s.y2 = s.pm1 = s.xb = 0;
      s.ap.fill(0);
      return;
    }
    // FM mode (phase modulation or feedback): two waves per frame, pm interpolated between frames, then the half-band
    // decimator, so sidebands up to the old sample rate are filtered out instead of folding back
    const K = 1 / (2 * Math.PI);
    for (let i = 0; i < c.n; i++) {
      const f = C4 * Math.pow(2, pitch[i] + base);
      const dt = Math.min(f / c.sr, 0.45) / 2;
      if (sync[i] >= 0.5 && s.s1 < 0.5) s.phase = 0;
      s.s1 = sync[i];
      const pmNow = idx > 0 ? pm[i] : 0;
      const pmMid = (s.pm1 + pmNow) / 2;
      s.pm1 = pmNow;
      let ya = 0;
      for (let sub = 0; sub < 2; sub++) {
        s.phase += dt;
        if (s.phase >= 1) s.phase -= 1;
        let ph = s.phase + (idx * (sub ? pmNow : pmMid) + fb * FB_RAD * (s.y1 + s.y2) * 0.5) * K;
        ph -= Math.floor(ph);
        const y = wave(kind, ph, dt, pw);
        s.y2 = s.y1;
        s.y1 = y;
        if (sub) {
          // path 0 takes the even sub-sample, path 1 the odd one of the previous frame (the z^-1 of the half-band)
          const p0 = allpass(s.ap, 4, HB[2], allpass(s.ap, 0, HB[0], ya));
          const p1 = allpass(s.ap, 6, HB[3], allpass(s.ap, 2, HB[1], s.xb));
          s.xb = y;
          out[i] = (p0 + p1) * 0.5 * lvl;
        } else ya = y;
      }
    }
  },
};

/** Note lengths of the synced delay, shortest first (the time knob steps through them): name and length in quarter notes = num / den. */
export const DELAY_DIVS: { name: string; num: number; den: number }[] = [
  { name: '1/16T', num: 1, den: 6 },
  { name: '1/16', num: 1, den: 4 },
  { name: '1/8T', num: 1, den: 3 },
  { name: '1/16.', num: 3, den: 8 },
  { name: '1/8', num: 1, den: 2 },
  { name: '1/8.', num: 3, den: 4 },
  { name: '1/4', num: 1, den: 1 },
  { name: '3/8', num: 3, den: 2 },
  { name: '1/2', num: 2, den: 1 },
  { name: '5/8', num: 5, den: 2 },
  { name: '1/1', num: 4, den: 1 },
];
/** the clock input is the Main module's clock: 24 pulses per quarter note */
export const DELAY_CLK_PPQN = 24;

/** the delay's time knob, ms: as long as the FM-1's line (DELAY_LEN, 23000 samples at DEVICE_SR; ping-pong halves it) */
export const DELAY_TIME_MIN = 1;
export const DELAY_TIME_MAX = 520;
/** the browser's delay reaches further (a browser-only ability: a patch past DELAY_TIME_MAX is over the FM-1 budget); its
 * line holds this much */
export const DELAY_TIME_BROWSER = 1600;
/** the FM-1's delay line, samples at DEVICE_SR (engine.c DELAY_LEN) */
const DELAY_LEN = 23000;
/** the browser's line: DELAY_TIME_BROWSER and a little (as the FM-1's line is 520 ms and a little) */
const DELAY_LEN_BROWSER = Math.ceil((DELAY_TIME_BROWSER / 1000) * DEVICE_SR) + 60;

/** which note length the time knob selects when the delay is synced: its range split into DELAY_DIVS.length steps */
export function delayDivIndex(time: number, tmin: number, tmax: number): number {
  return Math.max(0, Math.min(DELAY_DIVS.length - 1, Math.round(((time - tmin) / (tmax - tmin)) * (DELAY_DIVS.length - 1))));
}

const LFO_WAVES = [...WAVES, 'S&H'];

/** the extra note lengths of the synced delay (its `note` row; 0 `time`: the time knob picks from DELAY_DIVS), in quarter
 * notes = num / den. Appended to, never reordered (a patch stores the index). */
export const DELAY_NOTES: { name: string; num: number; den: number }[] = [
  { name: 'time', num: 0, den: 1 },
  { name: '1/32', num: 1, den: 8 },
  { name: '1/2T', num: 4, den: 3 },
  { name: '1/2.', num: 3, den: 1 },
  { name: '1/1T', num: 8, den: 3 },
  { name: '1/1.', num: 6, den: 1 },
];
/** the delay's `swell`: the feedback times 198 / 95 (0.95 becomes 1.98, the Model:Cycles' most), the loop through delayClip */
export const DELAY_SWELL_NUM = 198;
export const DELAY_SWELL_DEN = 95;
/** the soft clip in the swelling delay's loop: x - 4/27 x^3, flat at +-1 from |x| = 1.5 (engine.c dly_soft the same) */
export const delayClip = (x: number): number => (x >= 1.5 ? 1 : x <= -1.5 ? -1 : x - (4 / 27) * x * x * x);

/** the free LFO's rate ranges: the `rate` row times LFO_RANGE_K (slow 0.0008..1.6 Hz, fast 0.04..80 Hz) */
export const LFO_RANGES = ['norm', 'slow', 'fast', 'wide'];
export const LFO_RANGE_K = [1, 1 / 25, 2, 1];
/** the free rate as the LFO runs it: the `rate` row times its range's factor (slow / 25, fast x 2; the card and the FM-1's
 * page show this, pages_ui.c stretched), the knob keeps the row's own range */
const lfoRateText = (v: number, p: Record<string, number>): string => {
  const r = Math.round(p.range ?? 0);
  const f = formatValue(v * (r === 1 || r === 2 ? LFO_RANGE_K[r] : 1), 'Hz', false);
  return `${f.num} ${f.unit}`;
};
/** the synced LFO's speed against its note length: ÷8 makes a cycle 8 times as long, x8 an eighth as long (a 1/16 triplet
 * x8 is half a clock tick). The length is multiplied by num / den. Appended to, never reordered. */
export const LFO_MULTS: { name: string; num: number; den: number }[] = [
  { name: '/8', num: 8, den: 1 },
  { name: '/4', num: 4, den: 1 },
  { name: '/2', num: 2, den: 1 },
  { name: 'x1', num: 1, den: 1 },
  { name: 'x2', num: 1, den: 2 },
  { name: 'x4', num: 1, den: 4 },
  { name: 'x8', num: 1, den: 8 },
];
const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
/**
 * A synced LFO's cycle against the 24 ppqn clock (engine.c m_lfo the same): per8 = 8 x the clock ticks per cycle (a whole
 * number for every length and speed); snap = the ticks between restarts, where a whole number of cycles ends on a tick;
 * cycles = the cycles per snap; num / den = the length in quarter notes. A length of whole ticks snaps every cycle
 * (cycles 1), as before the speeds came.
 */
export function lfoSyncCycle(div: number, mult: number): { per8: number; snap: number; cycles: number; num: number; den: number } {
  const d = DELAY_DIVS[Math.max(0, Math.min(DELAY_DIVS.length - 1, div))];
  const m = LFO_MULTS[Math.max(0, Math.min(LFO_MULTS.length - 1, mult))];
  const per8 = (192 * d.num * m.num) / (d.den * m.den);
  const g = gcd(per8, 8);
  return { per8, snap: per8 / g, cycles: 8 / g, num: d.num * m.num, den: d.den * m.den };
}

interface LfoState {
  phase: number;
  seed: number;
  held: number;
  clkHi: boolean;
  rstHi: boolean;
  /** clk edges counted since the last snap (synced) */
  ticks: number;
  /** cycles ended since the last snap to the clock (synced, while the clock runs) */
  wraps: number;
  /** samples since the last clk edge, and the smoothed distance between edges (0 = none seen yet) */
  since: number;
  interval: number;
}

/** A triangle's rise occupies `duty` of its cycle; at the ends it becomes a falling or rising saw. */
function lfoWave(kind: number, phase: number, dt: number, duty: number): number {
  if (kind !== 1 || duty === .5) return wave(kind, phase, dt, duty);
  if (duty === 0) return -wave(2, phase, dt);
  if (duty === 1) return wave(2, phase, dt);
  return phase < duty ? 2 * phase / duty - 1 : 1 - 2 * (phase - duty) / (1 - duty);
}

/**
 * LFO. `rate` in Hz times the `range` (slow / 25, fast x2), or `wide` from 0.0008 to 55 Hz in wide range. With `sync`, one cycle per note length `div` (as the delay)
 * at the `mult` speed (÷8 .. x8). The clk input is a 24 ppqn clock (the Main module's clock output): the cycle snaps to every
 * n-th edge (n = 24 x the note length in quarter notes; for a length that ends between ticks, to the first tick a whole
 * number of cycles ends on) and runs at the measured clock speed in between. Without a clock (none for half a second) it
 * runs at `bpm`. A rising edge at reset restarts the cycle. S&H draws a new value at every cycle start. `phase` moves where
 * a cycle starts on the wave (90 degrees: a sine starts at its peak); `dir` back runs the wave backward (a saw falls).
 */
const lfo: ModuleImpl<LfoState> = {
  def: {
    type: 'lfo',
    label: 'LFO',
    inputs: [gate('clk'), gate('reset')],
    outputs: [control('out')],
    params: [
      param('wave', 0, 4, 0, { step: 1, choices: LFO_WAVES }),
      param('rate', 0.02, 40, 4, { unit: 'Hz', step: 0.01, log: true, altText: { when: 'range', text: lfoRateText } }),
      param('depth', 0, 1, 1, { step: 0.01 }),
      param('sync', 0, 1, 0, { step: 1, choices: ['free', 'sync'], toggle: true }),
      param('div', 0, DELAY_DIVS.length - 1, 6, { step: 1, choices: DELAY_DIVS.map((d) => d.name) }),
      param('bpm', 40, 300, 120, { step: 1 }),
      param('phase', 0, 360, 0, { step: 1, unit: 'deg', since: 35 }),
      param('range', 0, 2, 0, { step: 1, choices: LFO_RANGES, top: 3, since: 35 }),
      param('dir', 0, 1, 0, { step: 1, choices: ['fwd', 'back'], toggle: true, since: 35 }),
      param('mult', 0, LFO_MULTS.length - 1, 3, { step: 1, choices: LFO_MULTS.map((m) => m.name), since: 35 }),
      param('wide', 0.0008, 55, 4, { unit: 'Hz', step: 0.0001, log: true, since: 40 }),
    ],
  },
  init: (sr) => ({ phase: 0, seed: 0x2545f491, held: 0, clkHi: false, rstHi: false, ticks: 0, wraps: 0, since: sr, interval: 0 }),
  process(c, s) {
    const kind = Math.round(c.p.wave ?? 0);
    // backward: the wave read at off - phase, which for these waves is -w(phase - off) (the triangle is the same both ways)
    const back = (c.p.dir ?? 0) >= 0.5;
    let duty = .5;
    if (c.connected.shape) {
      let sum = 0;
      for (let i = 0; i < c.n; i++) sum += c.inp.shape[i];
      duty = Math.max(0, Math.min(1, Math.trunc(sum * 65536 / c.n) / 65536));
    }
    if (back) duty = 1 - duty;
    const depth = (c.p.depth ?? 1) * (back && kind !== 1 ? -1 : 1);
    const off = ((c.p.phase ?? 0) / 360) * (back ? -1 : 1);
    const sync = (c.p.sync ?? 0) >= 0.5;
    const cyc = lfoSyncCycle(Math.round(c.p.div ?? 6), Math.round(c.p.mult ?? 3));
    const perCycle = cyc.per8 / 8; // clock ticks per cycle
    const dtBpm = ((c.p.bpm ?? 120) * cyc.den) / (60 * cyc.num * c.sr);
    const range = Math.max(0, Math.min(LFO_RANGES.length - 1, Math.round(c.p.range ?? 0)));
    const dtFree = (range === 3 ? (c.p.wide ?? 4) : (c.p.rate ?? 1) * LFO_RANGE_K[range]) / c.sr;
    const newCycle = (): void => {
      // sample & hold: new random value (-1..1) at every cycle start
      s.seed = (Math.imul(s.seed, 1664525) + 1013904223) >>> 0;
      s.held = s.seed / 0x80000000 - 1;
    };
    for (let i = 0; i < c.n; i++) {
      const clk = c.inp.clk[i] >= 0.5;
      const rst = c.inp.reset[i] >= 0.5;
      if (s.since < c.sr) s.since++;
      if (clk && !s.clkHi) {
        if (s.since >= c.sr / 2) s.interval = 0;
        else s.interval = s.interval > 0 ? s.interval + (s.since - s.interval) / 8 : s.since;
        s.since = 0;
        if (sync && ++s.ticks >= cyc.snap) {
          s.ticks = 0;
          s.wraps = 0;
          s.phase = 0;
          newCycle();
        }
      }
      s.clkHi = clk;
      if (rst && !s.rstHi) {
        s.phase = 0;
        s.ticks = 0;
        s.wraps = 0;
        newCycle();
      }
      s.rstHi = rst;
      const live = sync && s.interval > 0 && s.since < c.sr / 2;
      const dt = !sync ? dtFree : live ? 1 / (perCycle * s.interval) : dtBpm;
      s.phase += dt;
      if (s.phase >= 1) {
        if (live && s.wraps + 1 >= cyc.cycles) s.phase = 1 - 1e-6; // wait for the clock's next snap
        else {
          s.phase -= 1;
          if (live) s.wraps++;
          newCycle();
        }
      }
      const ph = off ? s.phase + off - Math.floor(s.phase + off) : s.phase;
      c.out.out[i] = (kind === 4 ? s.held : lfoWave(kind, ph, dt, duty)) * depth;
      c.out.pulse[i] = wave(3, ph, dt, duty) * (c.p.depth ?? 1) * (back ? -1 : 1);
    }
  },
};

const noise: ModuleImpl<{ seed: number; y: number }> = {
  def: { type: 'noise', label: 'Noise', inputs: [], outputs: [audio('out')], params: [param('level', 0, 1, 0.5, { step: 0.01 }), param('color', 0, 1, 0, { step: 0.01 })] },
  init: () => ({ seed: 0x1234567, y: 0 }),
  process(c, s) {
    const lvl = c.p.level ?? 1;
    const k = Math.pow(2, -5 * (c.p.color ?? 0));
    for (let i = 0; i < c.n; i++) {
      s.seed = (Math.imul(s.seed, 1664525) + 1013904223) >>> 0;
      s.y += k * ((s.seed / 0x80000000) - 1 - s.y);
      c.out.out[i] = s.y * lvl;
    }
  },
};

const constant: ModuleImpl<null> = {
  def: { type: 'const', label: 'Offset', inputs: [], outputs: [control('out')], params: [param('value', -4, 4, 0, { step: 0.01 })] },
  init: () => null,
  process(c) {
    c.out.out.fill(c.p.value ?? 0, 0, c.n);
  },
};

/** a performance value for a device page (what Main's knobs K1..K4 were before they became edit bindings): its one row is
 * turned like any other, its output carries it to pins and inputs */
const macro: ModuleImpl<null> = {
  def: { type: 'macro', label: 'Macro', inputs: [], outputs: [control('out')], params: [param('value', 0, 1, 0.5, { step: 0.01 })] },
  init: () => null,
  process(c) {
    c.out.out.fill(c.p.value ?? 0, 0, c.n);
  },
};

const scale: ModuleImpl<null> = {
  def: {
    type: 'scale',
    label: 'Attenuverter',
    inputs: [control('in')],
    outputs: [control('out')],
    params: [param('gain', -4, 4, 1, { step: 0.01 }), param('offset', -4, 4, 0, { step: 0.01 })],
  },
  init: () => null,
  process(c) {
    for (let i = 0; i < c.n; i++) c.out.out[i] = c.inp.in[i] * (c.p.gain ?? 1) + (c.p.offset ?? 0);
  },
};

/** the ADSR's `long`: decay and release times this (decay up to 12 s, release up to 19.2 s; the Juno-106's reach 12 s) */
export const ADSR_LONG = 2.4;
/** a decay or release time as `long` plays it, for the card ("12 s") */
const longTime = (v: number): string => {
  const t = v * ADSR_LONG;
  return t < 1 ? `${Math.round(t * 1000)} ms` : `${t < 10 ? t.toFixed(2) : t.toFixed(1)} s`;
};

interface AdsrState {
  stage: 0 | 1 | 2 | 3 | 4; // idle, attack, decay, sustain, release
  v: number;
  prev: number;
}

const adsr: ModuleImpl<AdsrState> = {
  def: {
    type: 'adsr',
    label: 'ADSR',
    inputs: [gate('gate')],
    outputs: [control('env')],
    params: [
      param('a', 0.001, 5, 0.01, { unit: 's', step: 0.001, log: true }),
      param('d', 0.001, 5, 0.2, { unit: 's', step: 0.001, log: true, altText: { when: 'long', text: longTime } }),
      param('s', 0, 1, 0.6, { step: 0.01 }),
      param('r', 0.001, 8, 0.3, { unit: 's', step: 0.001, log: true, altText: { when: 'long', text: longTime } }),
      param('long', 0, 1, 0, { step: 1, choices: ['off', 'on'], toggle: true, since: 35 }),
    ],
    views: [param('view', 0, 0, 0, { screen: true })],
  },
  init: () => ({ stage: 0, v: 0, prev: 0 }),
  process(c, s) {
    const rate = (t: number) => 1 - Math.exp(-4.6 / Math.max(t * c.sr, 1)); // reaches ~99% in t seconds
    const k = (c.p.long ?? 0) >= 0.5 ? ADSR_LONG : 1;
    const ad = rate((c.p.d ?? 0.2) * k);
    const ar = rate((c.p.r ?? 0.3) * k);
    const aInc = 1 / Math.max((c.p.a ?? 0.01) * c.sr, 1);
    const sus = c.p.s ?? 0.6;
    for (let i = 0; i < c.n; i++) {
      const g = c.inp.gate[i] > 0.5 ? 1 : 0;
      if (g && !s.prev) s.stage = 1;
      // Hold defers release without hiding the gate's next rising edge. It cannot start an idle envelope
      // or freeze a release already in progress.
      else if (!g && s.stage !== 0 && s.stage !== 4 && (c.inp.hold?.[i] ?? 0) <= 0.5) s.stage = 4;
      s.prev = g;
      switch (s.stage) {
        case 1:
          s.v += aInc;
          if (s.v >= 1) {
            s.v = 1;
            s.stage = 2;
          }
          break;
        case 2:
          s.v += (sus - s.v) * ad;
          if (Math.abs(s.v - sus) < 1e-4) s.stage = 3;
          break;
        case 3:
          s.v = sus;
          break;
        case 4:
          s.v -= s.v * ar;
          if (s.v < 1e-4) {
            s.v = 0;
            s.stage = 0;
          }
          break;
      }
      c.out.env[i] = s.v;
    }
  },
};

const vca: ModuleImpl<null> = {
  def: {
    type: 'vca',
    label: 'VCA',
    inputs: [audio('in'), control('cv')],
    outputs: [audio('out')],
    params: [param('gain', 0, 2, 1, { step: 0.01, input: 'cv', rest: (p, cv) => cv * (p.gain ?? 1) })],
  },
  init: () => null,
  // an unplugged cv is silence (the buffer is zero): a VCA with no control is closed, as on a modular
  process(c) {
    let cv = 0;
    for (let i = 0; i < c.n; i++) {
      cv = c.inp.cv[i];
      c.out.out[i] = c.inp.in[i] * cv * (c.p.gain ?? 1);
    }
    if (c.display) c.display.gain = cv * (c.p.gain ?? 1);
  },
};

/** the Multimode filter's self-oscillation (its `osc` parameter, on): from this `res` up, the damping falls by FILTER_OSC_K
 * per unit of res past it (below 0 from about res 0.95, where the oscillation starts) and grows with FILTER_OSC_GAIN per
 * unit past it times the band-pass state squared (held to +-FILTER_OSC_CLIP): about 0.5 peak on lp12 at res 1, at any cutoff.
 * A filter at rest starts from a band-pass state of FILTER_OSC_SEED. engine.c reads these from defs.h. */
export const FILTER_OSC_FROM = 0.85;
export const FILTER_OSC_K = 1.19;
export const FILTER_OSC_GAIN = 5.6;
export const FILTER_OSC_CLIP = 2;
export const FILTER_OSC_SEED = 1 / 1024;

/** state variable filter, two stages: stage 1 (12 dB) gives lp12 / bp / hp (and hp6, a resonant 6 dB high pass, appended), stage 2 takes lp12 and adds the other 12 dB (lp24) */
const filter: ModuleImpl<{ ic1: number; ic2: number; jc1: number; jc2: number }> = {
  def: {
    type: 'filter',
    label: 'Multimode',
    inputs: [audio('in'), control('cv'), control('morph')],
    outputs: [audio('lp24'), audio('lp12'), audio('bp'), audio('hp'), audio('mix'), audio('notch'), audio('peak'), audio('ap')],
    params: [
      param('cutoff', 20, 16000, 1200, { unit: 'Hz', step: 1, log: true, bend: true, input: 'cv', rest: cutoffRest }),
      param('res', 0, 1, 0.2, { step: 0.01 }),
      param('cvamt', 0, 4, 1, { unit: 'oct', step: 0.01 }),
      param('track', 0, 1, 0, { step: 1, choices: ['off', 'on'], toggle: true }),
      param('morph', 0, 1, 0, { step: 0.01, input: 'morph', rest: (p, cv) => (p.morph ?? 0) + cv }),
      param('osc', 0, 1, 0, { step: 1, choices: ['off', 'on'], toggle: true, since: 47 }),
    ],
  },
  init: () => ({ ic1: 0, ic2: 0, jc1: 0, jc2: 0 }),
  process(c, s) {
    const res = c.p.res ?? 0;
    // self-oscillation (osc on, res past FILTER_OSC_FROM): the damping k goes below 0 near the top (the loop gains),
    // and grows with the band pass's square (k + gam b^2, b the stage 1 band-pass state held to +-FILTER_OSC_CLIP): a
    // bounded sine-like oscillation at the cutoff whose level does not depend on the cutoff (a Van der Pol oscillator).
    // From silence a small kick starts it. Below FILTER_OSC_FROM, or off, the filter is unchanged.
    const over = (c.p.osc ?? 0) >= 0.5 ? Math.max(0, res - FILTER_OSC_FROM) : 0;
    const k0 = 2 - 1.98 * res - FILTER_OSC_K * over, gam = FILTER_OSC_GAIN * over;
    let k = k0;
    if (over > 0 && s.ic1 === 0 && s.ic2 === 0) s.ic1 = FILTER_OSC_SEED;
    const k2 = Math.SQRT2; // stage 2 is damped (Q 0.7): the resonance peak comes from stage 1 alone
    const tr = (c.p.track ?? 0) >= 0.5 ? c.voice.pitch : 0; // keyboard tracking: the cutoff follows the played pitch 1 octave per octave (C4 = the cutoff as set)
    let fc = c.p.cutoff ?? 1000, m = c.p.morph ?? 0;
    for (let i = 0; i < c.n; i++) {
      fc = Math.min((c.p.cutoff ?? 1000) * Math.pow(2, c.inp.cv[i] * (c.p.cvamt ?? 1) + tr), c.sr * 0.45);
      const g = Math.tan((Math.PI * fc) / c.sr);
      if (over > 0) {
        const b = Math.min(FILTER_OSC_CLIP, Math.max(-FILTER_OSC_CLIP, s.ic1));
        k = k0 + gam * b * b;
      }
      const a1 = 1 / (1 + g * (g + k));
      const a2 = g * a1;
      const a3 = g * a2;
      const v0 = c.inp.in[i];
      const v3 = v0 - s.ic2;
      const v1 = a1 * s.ic1 + a2 * v3;
      const v2 = s.ic2 + a2 * s.ic1 + a3 * v3;
      s.ic1 = 2 * v1 - s.ic1;
      s.ic2 = 2 * v2 - s.ic2;
      const kv1 = k * v1;
      const hp = v0 - kv1 - v2;
      const b1 = 1 / (1 + g * (g + k2));
      const b2 = g * b1;
      const b3 = g * b2;
      const w3 = v2 - s.jc2;
      const w1 = b1 * s.jc1 + b2 * w3;
      const w2 = s.jc2 + b2 * s.jc1 + b3 * w3;
      s.jc1 = 2 * w1 - s.jc1;
      s.jc2 = 2 * w2 - s.jc2;
      m = Math.min(1, Math.max(0, (c.p.morph ?? 0) + c.inp.morph[i]));
      c.out.lp12[i] = v2;
      c.out.bp[i] = v1;
      c.out.hp[i] = hp;
      c.out.lp24[i] = w2;
      c.out.mix[i] = w2 + (hp - w2) * m; // morph 0 = 24 dB low pass, 1 = high pass
      c.out.notch[i] = v0 - kv1; // = lp12 + hp: a null at the cutoff
      c.out.peak[i] = v2 - hp; // = lp12 - hp: a resonant bump at the cutoff over a flat response
      c.out.ap[i] = v0 - 2 * kv1; // = notch - k bp: flat magnitude, the phase turns through 360 degrees around the cutoff
      // hp + 2 bp: the high pass of the MS-20 filter (s^2 + 2s over the same resonant denominator; Stinchcombe, "A Study of
      // the Korg MS10 & MS20 Filters", section 7): 6 dB per octave below the cutoff, the resonance peak at it, flat above
      c.out.hp6[i] = hp + 2 * v1;
    }
    if (c.display) {
      c.display.cutoff = fc;
      c.display.morph = m;
    }
  },
};

/**
 * Ladder filter (four one-pole stages in a feedback loop, the Moog shape) with drive. Zero-delay feedback: the loop is
 * solved linearly (y4 = (G^4 x + S) / (1 + k G^4) with the stage states S), then the loop input u = sat(drive x - k y4)
 * runs through the four stages, so the saturator sits in the loop (self-oscillation at res 1 limits itself). sat is
 * v - v^3 / 6.75 up to |v| = 1.5 and +-1 beyond (slope 1 at 0, peak 1). The coefficients (G = g / (1 + g),
 * g = tan(pi fc / sr)) are computed once per block from the block mean of the cv input, cvamt and key tracking: cheaper
 * than the SVF's per-sample update, which the Filter module keeps for audio-rate cutoff modulation. Outputs: lp24 (stage
 * 4) and lp12 (stage 2). No resonance compensation: the passband drops with res as on the original.
 */
const ladder: ModuleImpl<{ s: Float64Array }> = {
  def: {
    type: 'ladder',
    label: 'Ladder',
    inputs: [audio('in'), control('cv')],
    outputs: [audio('lp24'), audio('lp12')],
    params: [
      param('cutoff', 20, 16000, 1200, { unit: 'Hz', step: 1, log: true, bend: true, input: 'cv', rest: cutoffRest }),
      param('res', 0, 1, 0.2, { step: 0.01 }),
      param('drive', 1, 8, 1, { step: 0.01, log: true }),
      param('cvamt', 0, 4, 1, { unit: 'oct', step: 0.01 }),
      param('track', 0, 1, 0, { step: 1, choices: ['off', 'on'], toggle: true }),
    ],
  },
  init: () => ({ s: new Float64Array(4) }),
  process(c, st) {
    const s = st.s;
    const audio = !!c.connected.fm;
    let cvm = 0;
    for (let i = 0; i < c.n; i++) cvm += c.inp.cv[i];
    cvm /= c.n;
    const tr = (c.p.track ?? 0) >= 0.5 ? c.voice.pitch : 0;
    const k = 4 * (c.p.res ?? 0);
    const drive = c.p.drive ?? 1;
    let G = 0, G2 = 0, G3 = 0, G4 = 0, hG = 0, F = 0;
    for (let i = 0; i < c.n; i++) {
      if (i === 0 || (audio && c.inp.fm[i] !== c.inp.fm[i - 1])) {
        const cv = cvm + (audio ? c.inp.fm[i] : 0);
        const fc = Math.min((c.p.cutoff ?? 1000) * Math.pow(2, cv * (c.p.cvamt ?? 1) + tr), c.sr * .45);
        if (c.display) c.display.cutoff = fc;
        const g = Math.tan((Math.PI * fc) / c.sr);
        G = g / (1 + g);
        G2 = G * G; G3 = G2 * G; G4 = G3 * G; hG = 1 - G;
        F = 1 / (1 + k * G4);
      }
      const x = c.inp.in[i];
      const S = (G3 * s[0] + G2 * s[1] + G * s[2] + s[3]) * hG;
      const y4 = (G4 * x + S) * F;
      let u = drive * x - k * y4;
      u = u >= 1.5 ? 1 : u <= -1.5 ? -1 : u - (u * u * u) / 6.75;
      let y2 = 0;
      for (let j = 0; j < 4; j++) {
        const v = G * (u - s[j]);
        u = v + s[j];
        s[j] = u + v;
        if (j === 1) y2 = u;
      }
      c.out.lp24[i] = u;
      c.out.lp12[i] = y2;
    }
  },
};

/** 20 log10(x) = DB_PER_OCT log2(x) */
const DB_PER_OCT = 6.0205999;

/**
 * Envelope follower and compressor. The detector is a peak follower of |side| (or of |in| when side is not connected): one
 * pole that reaches 99 % in `attack` on the way up and in `release` on the way down (the ADSR's rate formula). `env` outputs
 * it (0..1, a control). Above `thresh` (dB) the signal is compressed by `ratio`: gain = (thresh / env)^(1 - 1/ratio), in the
 * log domain, then `gain` dB of makeup. Below the threshold only the makeup applies.
 */
const dyn: ModuleImpl<{ env: number }> = {
  def: {
    type: 'dyn',
    label: 'Compressor',
    inputs: [audio('in'), audio('side')],
    outputs: [audio('out'), control('env')],
    params: [
      param('thresh', -40, 0, -12, { unit: 'dB', step: 0.5 }),
      param('ratio', 1, 20, 4, { step: 0.1 }),
      param('attack', 0.001, 0.2, 0.01, { unit: 's', step: 0.001, log: true }),
      param('release', 0.01, 1, 0.1, { unit: 's', step: 0.01, log: true }),
      param('gain', 0, 24, 0, { unit: 'dB', step: 0.5 }),
    ],
  },
  init: () => ({ env: 0 }),
  process(c, s) {
    const ka = 1 - Math.exp(-4.6 / Math.max((c.p.attack ?? 0.01) * c.sr, 1));
    const kr = 1 - Math.exp(-4.6 / Math.max((c.p.release ?? 0.1) * c.sr, 1));
    const det = c.connected.side ? c.inp.side : c.inp.in;
    const thrLog = (c.p.thresh ?? -12) / DB_PER_OCT;
    const thr = Math.pow(2, thrLog);
    const slope = 1 - 1 / Math.max(1, c.p.ratio ?? 4);
    const makeupLog = (c.p.gain ?? 0) / DB_PER_OCT;
    const makeup = Math.pow(2, makeupLog);
    for (let i = 0; i < c.n; i++) {
      const a = Math.abs(det[i]);
      s.env += (a > s.env ? ka : kr) * (a - s.env);
      const g = s.env > thr ? Math.pow(2, makeupLog - slope * (Math.log2(s.env) - thrLog)) : makeup;
      c.out.out[i] = c.inp.in[i] * g;
      c.out.env[i] = s.env;
    }
  },
};

/** Quantize one audio sample to a signed 16-bit word for bitwise operations. */
const xorWord = (x: number): number => Math.max(-32768, Math.min(32767, Math.floor(x * 32768)));

/** Arithmetic on a' = a·ka + off, b' = b·kb, including bitwise XOR of their signed 16-bit samples. */
const math: ModuleImpl<null> = {
  def: {
    type: 'math',
    label: 'Math',
    inputs: [control('a'), control('b')],
    outputs: [control('add'), control('sub'), control('mul'), control('min'), control('max'), control('abs'), gate('cmp'), audio('xor')],
    params: [param('ka', -4, 4, 1, { step: 0.01 }), param('kb', -4, 4, 1, { step: 0.01 }), param('off', -4, 4, 0, { step: 0.01 })],
  },
  init: () => null,
  process(c) {
    const ka = c.p.ka ?? 1, kb = c.p.kb ?? 1, off = c.p.off ?? 0;
    const o = c.out;
    for (let i = 0; i < c.n; i++) {
      const a = c.inp.a[i] * ka + off, b = c.inp.b[i] * kb;
      o.add[i] = a + b;
      o.sub[i] = a - b;
      o.mul[i] = a * b;
      o.min[i] = Math.min(a, b);
      o.max[i] = Math.max(a, b);
      o.abs[i] = Math.abs(a);
      o.cmp[i] = a > b ? 1 : 0;
      o.xor[i] = (xorWord(a) ^ xorWord(b)) / 32768;
    }
  },
};

/** gates from two inputs (high at or above `thresh`): and, or, xor, not (of a) */
const logic: ModuleImpl<null> = {
  def: {
    type: 'logic',
    label: 'Logic',
    inputs: [gate('a'), gate('b')],
    outputs: [gate('and'), gate('or'), gate('xor'), gate('not')],
    params: [param('thresh', 0.05, 0.95, 0.5, { step: 0.01 })],
  },
  init: () => null,
  process(c) {
    const t = c.p.thresh ?? 0.5;
    const o = c.out;
    for (let i = 0; i < c.n; i++) {
      const a = c.inp.a[i] >= t, b = c.inp.b[i] >= t;
      o.and[i] = a && b ? 1 : 0;
      o.or[i] = a || b ? 1 : 0;
      o.xor[i] = a !== b ? 1 : 0;
      o.not[i] = a ? 0 : 1;
    }
  },
};

/** the granular module's buffer: one second, and up to this many grains at once */
export const GRAIN_SECONDS = 1;
export const GRAIN_MAX = 8;
/** spray scatters a grain's start by up to this many seconds */
const GRAIN_SPRAY_S = 0.25;

interface Grain {
  /** start sample in the buffer, samples played so far, samples to play, read rate (samples per sample) */
  start: number;
  t: number;
  len: number;
  rate: number;
  left: number;
}
interface GrainState {
  buf: Float32Array;
  w: number;
  /** the spawn accumulator (grains per sample), the random seed, the previous trig sample */
  acc: number;
  seed: number;
  prev: number;
  g: Grain[];
}

/**
 * Granular: records its input into a one second buffer (freeze stops the recording) and plays up to GRAIN_MAX grains from
 * it. `density` grains per second start on their own (0 = none), a rising edge on `trig` starts one too. A grain reads
 * `size` seconds of the buffer, `position` back from the newest audio (0 = the newest, 1 = the oldest) plus a random
 * `spray` (up to 0.25 s), at the rate 2^(pitch / 12), under a Hann window, linearly interpolated; the grains are summed
 * (not normalised: density x size is the average overlap). out = in (1 - mix) + grains mix. Shared like the delay: one
 * instance per patch, one line on the FM-1.
 */
const grain: ModuleImpl<GrainState> = {
  def: {
    type: 'grain',
    label: 'Granular',
    inputs: [audio('in'), gate('trig')],
    outputs: [audio('out')],
    params: [
      param('position', 0, 1, 0.3, { step: 0.01 }),
      param('size', 0.01, 0.5, 0.08, { unit: 's', step: 0.001, log: true }),
      param('density', 0, 100, 20, { unit: 'Hz', step: 0.5 }),
      param('pitch', -24, 24, 0, { unit: 'st', step: 1 }),
      param('spray', 0, 1, 0.2, { step: 0.01 }),
      param('freeze', 0, 1, 0, { step: 1, choices: ['off', 'on'], toggle: true }),
      param('mix', 0, 1, 0.5, { step: 0.01 }),
    ],
  },
  init: (sr) => ({
    buf: new Float32Array(Math.round(sr * GRAIN_SECONDS)),
    w: 0,
    acc: 0,
    seed: 0x7f4a7c15,
    prev: 0,
    g: Array.from({ length: GRAIN_MAX }, () => ({ start: 0, t: 0, len: 0, rate: 1, left: 0 })),
  }),
  process(c, s) {
    const LEN = s.buf.length;
    const dinc = Math.floor(((c.p.density ?? 0) / c.sr) * 16777216) / 16777216; // grains per sample, in steps of 2^-24 like the firmware, so both spawn on the same samples
    const rate = Math.pow(2, Math.trunc(c.p.pitch ?? 0) / 12);
    let len = Math.max(1, Math.round((c.p.size ?? 0.08) * c.sr));
    let span = Math.floor(len * rate) + 1;
    if (span > LEN - 2) {
      len = Math.floor((LEN - 2) / rate);
      span = Math.floor(len * rate) + 1;
    }
    const avail = LEN - 1 - span;
    const position = c.p.position ?? 0;
    const sprayS = Math.floor((c.p.spray ?? 0) * Math.floor(GRAIN_SPRAY_S * c.sr)); // whole samples first, as the firmware's ENG_SR / 4
    const freeze = (c.p.freeze ?? 0) >= 0.5;
    const mix = c.p.mix ?? 0.5;
    const dry = 1 - mix;
    const spawn = (): void => {
      let g: Grain | undefined;
      for (const k of s.g) if (k.left === 0) { g = k; break; }
      s.seed = (Math.imul(s.seed, 1664525) + 1013904223) >>> 0;
      if (!g) return;
      const rnd = (s.seed >>> 8) / 16777216;
      let off = Math.floor(position * avail) + Math.floor(rnd * sprayS);
      if (off > avail) off = avail;
      const back = span + off;
      g.start = s.w >= back ? s.w - back : s.w + LEN - back;
      g.t = 0;
      g.len = len;
      g.rate = rate;
      g.left = len;
    };
    for (let i = 0; i < c.n; i++) {
      const x = c.inp.in[i];
      const tr = c.inp.trig[i];
      s.acc += dinc;
      if (s.acc >= 1) {
        s.acc -= 1;
        spawn();
      }
      if (tr >= 0.5 && s.prev < 0.5) spawn();
      s.prev = tr;
      let sum = 0;
      for (const g of s.g) {
        if (g.left === 0) continue;
        const rp = g.t * g.rate;
        let i0 = g.start + Math.floor(rp);
        if (i0 >= LEN) i0 -= LEN;
        const i1 = i0 + 1 === LEN ? 0 : i0 + 1;
        const fr = rp - Math.floor(rp);
        const v = s.buf[i0] + (s.buf[i1] - s.buf[i0]) * fr;
        const sn = Math.sin((Math.PI * g.t) / g.len);
        sum += v * sn * sn;
        g.t++;
        g.left--;
      }
      if (!freeze) {
        s.buf[s.w] = x;
        if (++s.w === LEN) s.w = 0;
      }
      c.out.out[i] = x * dry + sum * mix;
    }
  },
};

/**
 * Comb filter: a delay line of one period (pitch + coarse, like the string) with signed feedback and a one-pole damping
 * in the loop: y = in + fb lp(y[n - period]), clamped to +-2; out = in (1 - mix) + y mix. Positive feedback peaks at the
 * harmonics of the pitch, negative at the odd ones. Lowest note 40 Hz (the string's line length).
 */
const comb: ModuleImpl<{ buf: Float32Array; w: number; lp: number }> = {
  def: {
    type: 'comb',
    label: 'Comb filter',
    inputs: [audio('in'), control('pitch')],
    outputs: [audio('out')],
    params: [
      param('coarse', -24, 24, 0, { step: 1, unit: 'st' }),
      param('fb', -0.98, 0.98, 0.7, { step: 0.01 }),
      param('damp', 0, 1, 0.2, { step: 0.01 }),
      param('mix', 0, 1, 1, { step: 0.01 }),
    ],
  },
  init: (sr) => ({ buf: new Float32Array(Math.ceil(sr / STR_LOW) + 1), w: 0, lp: 0 }),
  process(c, s) {
    const len = s.buf.length;
    const f = C4 * Math.pow(2, c.inp.pitch[0] + (c.p.coarse ?? 0) / 12);
    const period = Math.min(len - 2, Math.max(2, c.sr / f));
    const cl = 1 - 0.9 * (c.p.damp ?? 0.2);
    const d = Math.max(1, period - (1 - cl) / cl);
    const di = Math.floor(d);
    const fr = d - di;
    const fb = c.p.fb ?? 0;
    const mix = c.p.mix ?? 1;
    for (let i = 0; i < c.n; i++) {
      const x = c.inp.in[i];
      const r0 = s.buf[(s.w - di + len) % len];
      const r1 = s.buf[(s.w - di - 1 + len) % len];
      s.lp += (r0 + (r1 - r0) * fr - s.lp) * cl;
      const y = Math.max(-2, Math.min(2, x + s.lp * fb));
      s.buf[s.w] = y;
      s.w = (s.w + 1) % len;
      c.out.out[i] = x * (1 - mix) + y * mix;
    }
  },
};

/** the modal resonator's partials: harmonic ratios and the ratios of a free bar, `struct` morphs between them */
const MODAL_N = 6;
const MODAL_BAR = [1, 2.756, 5.404, 8.933, 13.34, 18.64];

/**
 * Modal resonator: six two-pole resonators y = a sin(th) x + 2 r cos(th) y1 - r^2 y2 (impulse response r^n sin(th n): the
 * ring of an impulse has the input's amplitude) at the ratios of the harmonics (struct 0) to a free bar (struct 1) of the
 * pitch; `decay` is the fundamental's time to -60 dB, partial i decays in decay / (1 + 2 damp i); the amplitudes fall as
 * (0.3 + 0.7 bright)^i and are normalised to a sum of 1. Partials above 0.45 sr are left out. The states are held to +-8:
 * excite it with short bursts (a pulse, a plucked string, a gated noise); a steady input builds up to the clamp.
 */
const modal: ModuleImpl<{ y1: Float64Array; y2: Float64Array }> = {
  def: {
    type: 'modal',
    label: 'Resonator',
    inputs: [audio('in'), control('pitch')],
    outputs: [audio('out')],
    params: [
      param('coarse', -24, 24, 0, { step: 1, unit: 'st' }),
      param('decay', 0.05, 5, 1, { unit: 's', step: 0.01, log: true }),
      param('struct', 0, 1, 0, { step: 0.01 }),
      param('bright', 0, 1, 0.5, { step: 0.01 }),
      param('damp', 0, 1, 0.3, { step: 0.01 }),
    ],
  },
  init: () => ({ y1: new Float64Array(MODAL_N), y2: new Float64Array(MODAL_N) }),
  process(c, s) {
    const f0 = C4 * Math.pow(2, c.inp.pitch[0] + (c.p.coarse ?? 0) / 12);
    const st = c.p.struct ?? 0, damp = c.p.damp ?? 0.3, decay = c.p.decay ?? 1;
    const bw = 0.3 + 0.7 * (c.p.bright ?? 0.5);
    const g = new Float64Array(MODAL_N), c1 = new Float64Array(MODAL_N), c2 = new Float64Array(MODAL_N);
    let sum = 0, a = 1;
    const amp = new Float64Array(MODAL_N);
    for (let i = 0; i < MODAL_N; i++) {
      amp[i] = a;
      sum += a;
      a *= bw;
    }
    for (let i = 0; i < MODAL_N; i++) {
      const f = f0 * (i + 1 + st * (MODAL_BAR[i] - (i + 1)));
      if (f >= c.sr * 0.45) continue;
      const th = (2 * Math.PI * f) / c.sr;
      const r = Math.pow(2, -LOG2_1000 / ((decay / (1 + 2 * damp * i)) * c.sr));
      g[i] = (amp[i] / sum) * Math.sin(th);
      c1[i] = 2 * r * Math.cos(th);
      c2[i] = r * r;
    }
    for (let n = 0; n < c.n; n++) {
      const x = c.inp.in[n];
      let y = 0;
      for (let i = 0; i < MODAL_N; i++) {
        const v = Math.max(-8, Math.min(8, g[i] * x + c1[i] * s.y1[i] - c2[i] * s.y2[i]));
        s.y2[i] = s.y1[i];
        s.y1[i] = v;
        y += v;
      }
      c.out.out[n] = y;
    }
  },
};

/** the Hilbert pair: two chains of four second-order allpasses y = a^2 (x + y2) - x2 whose outputs are 90 degrees apart
 *  (Olli Niemitalo's coefficients); chain A's output is delayed by one sample */
const HILBERT_A = [0.6923878, 0.9360654322959, 0.988229522686, 0.9987488452737];
const HILBERT_B = [0.4021921162426, 0.856171088242, 0.9722909545651, 0.9952884791278];

/** one chain, each section in the form w = x + a^2 w2, y = a^2 w - w2 (two states per section: s holds w1, w2) */
function hilbert(s: Float64Array, a: number[], x: number): number {
  for (let k = 0; k < 4; k++) {
    const o = 2 * k;
    const w = x + a[k] * a[k] * s[o + 1];
    x = a[k] * a[k] * w - s[o + 1];
    s[o + 1] = s[o];
    s[o] = w;
  }
  return x;
}

/**
 * Frequency shifter (single sideband): the Hilbert pair gives I (chain A, one sample late) and Q (chain B), a quadrature
 * oscillator at `shift` + cv x cvamt Hz (per block, from the block mean of cv) moves the whole spectrum: up = I cos + Q sin,
 * down = I cos - Q sin (with this Hilbert pair's sign convention); each output is in (1 - mix) + shifted mix. A negative
 * shift swaps the two.
 */
const shift: ModuleImpl<{ a: Float64Array; b: Float64Array; ia: number; phase: number }> = {
  def: {
    type: 'shift',
    label: 'Freq shifter',
    inputs: [audio('in'), control('cv')],
    outputs: [audio('up'), audio('down')],
    params: [
      param('shift', -1000, 1000, 100, { unit: 'Hz', step: 0.5, input: 'cv', rest: (p, cv) => (p.shift ?? 0) + cv * (p.cvamt ?? 0) }),
      param('cvamt', 0, 1000, 100, { unit: 'Hz', step: 1 }),
      param('mix', 0, 1, 1, { step: 0.01 }),
    ],
  },
  init: () => ({ a: new Float64Array(8), b: new Float64Array(8), ia: 0, phase: 0 }),
  process(c, s) {
    let cvm = 0;
    for (let i = 0; i < c.n; i++) cvm += c.inp.cv[i];
    cvm /= c.n;
    const hz = (c.p.shift ?? 0) + cvm * (c.p.cvamt ?? 0);
    if (c.display) c.display.shift = hz;
    const inc = hz / c.sr;
    const mix = c.p.mix ?? 1;
    const dry = 1 - mix;
    for (let i = 0; i < c.n; i++) {
      const x = c.inp.in[i];
      const ya = hilbert(s.a, HILBERT_A, x);
      const I = s.ia;
      s.ia = ya;
      const Q = hilbert(s.b, HILBERT_B, x);
      const co = Math.cos(2 * Math.PI * s.phase), si = Math.sin(2 * Math.PI * s.phase);
      s.phase += inc;
      s.phase -= Math.floor(s.phase);
      c.out.up[i] = x * dry + (I * co + Q * si) * mix;
      c.out.down[i] = x * dry + (I * co - Q * si) * mix;
    }
  },
};

const mixer: ModuleImpl<null> = {
  def: {
    type: 'mixer',
    label: 'Mixer 4',
    inputs: [audio('in1'), audio('in2'), audio('in3'), audio('in4')],
    thru: 'in1',
    outputs: [audio('out')],
    params: [1, 2, 3, 4].map((n) => param(`l${n}`, 0, 1, 0.7, { step: 0.01 })),
  },
  init: () => null,
  process(c) {
    for (let i = 0; i < c.n; i++) {
      c.out.out[i] =
        c.inp.in1[i] * (c.p.l1 ?? 0) + c.inp.in2[i] * (c.p.l2 ?? 0) + c.inp.in3[i] * (c.p.l3 ?? 0) + c.inp.in4[i] * (c.p.l4 ?? 0);
    }
  },
};

interface DelayState {
  buf: Float32Array;
  w: number;
  /** clock tempo: sample counter, the last 24 pulse times, pulses seen, previous level, samples per quarter note */
  t: number;
  ring: Float64Array;
  seen: number;
  prev: boolean;
  beat: number;
}

/**
 * Delay. free: `time` in ms; sync: `time` picks a note length (DELAY_DIVS) at the tempo of the `clk` input (the Main module's
 * clock; 120 bpm until 24 pulses have come in). The tempo is the time of the last 24 pulses, smoothed. Ping-pong splits the
 * one buffer in two halves (A, B): the input enters A, A's echo goes to B, B's back to A, so the echoes alternate out
 * (left) and r (right), each with feedback `fb`; the dry/wet `mix` applies to both. Each half is at most half the buffer, so
 * the delay time is limited to about 260 ms then (800 ms past the FM-1's range). Without ping-pong r is the same as out.
 * The browser's `time` reaches DELAY_TIME_BROWSER (1.6 s), the FM-1's DELAY_TIME_MAX: within that the browser plays as the
 * FM-1 (its line's length bounds a synced note length too); past it the patch is browser only (patchbin.ts browserOnly).
 * `note` (synced): one of DELAY_NOTES in place of the time knob's length. `swell`: the feedback x 198 / 95 (0.95 reads
 * 1.98) and the loop through a soft clip (delayClip), so a feedback past 1 swells to about full level and holds there.
 */
const delay: ModuleImpl<DelayState> = {
  def: {
    type: 'delay',
    label: 'Delay',
    inputs: [audio('in'), gate('clk')],
    outputs: [audio('out'), audio('r')],
    params: [
      param('time', DELAY_TIME_MIN, DELAY_TIME_MAX, 250, { unit: 'ms', step: 1, browserMax: DELAY_TIME_BROWSER, altText: { when: 'sync', text: (v) => DELAY_DIVS[delayDivIndex(v, DELAY_TIME_MIN, DELAY_TIME_MAX)].name } }),
      param('fb', 0, 0.95, 0.4, { step: 0.01, altText: { when: 'swell', text: (v) => ((v * DELAY_SWELL_NUM) / DELAY_SWELL_DEN).toFixed(2) } }),
      param('mix', 0, 1, 0.3, { step: 0.01 }),
      param('sync', 0, 1, 0, { step: 1, choices: ['free', 'sync'], toggle: true }),
      param('pingpong', 0, 1, 0, { step: 1, choices: ['off', 'on'], toggle: true }),
      param('note', 0, DELAY_NOTES.length - 1, 0, { step: 1, choices: DELAY_NOTES.map((d) => d.name), since: 35 }),
      param('swell', 0, 1, 0, { step: 1, choices: ['off', 'on'], toggle: true, since: 35 }),
    ],
  },
  init: (sr) => ({ buf: new Float32Array(Math.round((sr * DELAY_LEN_BROWSER) / DEVICE_SR)), w: 0, t: 0, ring: new Float64Array(DELAY_CLK_PPQN), seen: 0, prev: false, beat: Math.round(sr / 2) }),
  process(c, s) {
    const len = s.buf.length;
    const half = Math.floor(len / 2);
    const pp = (c.p.pingpong ?? 0) >= 0.5;
    // a time within the FM-1's range plays as on the FM-1, whose line is shorter: a synced note length longer than that
    // line is cut to it there, so here too. Only a time past it (browser only) reaches the longer line.
    const fm1 = (c.p.time ?? 250) <= DELAY_TIME_MAX;
    const lim = fm1 ? Math.round((c.sr * DELAY_LEN) / DEVICE_SR) : len;
    if (c.connected.clk) {
      for (let i = 0; i < c.n; i++) {
        s.t++;
        const hi = c.inp.clk[i] >= 0.5;
        if (hi && !s.prev) {
          const k = s.seen % DELAY_CLK_PPQN;
          if (s.seen >= DELAY_CLK_PPQN) {
            const m = s.t - s.ring[k];
            if (m >= c.sr * 0.2 && m <= c.sr * 1.5) s.beat = s.seen === DELAY_CLK_PPQN ? m : s.beat + Math.trunc((m - s.beat) / 4);
          }
          s.ring[k] = s.t;
          s.seen++;
        }
        s.prev = hi;
      }
    }
    let samples: number;
    if ((c.p.sync ?? 0) >= 0.5) {
      const note = Math.max(0, Math.min(DELAY_NOTES.length - 1, Math.round(c.p.note ?? 0)));
      const div = note ? DELAY_NOTES[note] : DELAY_DIVS[delayDivIndex(c.p.time ?? 250, DELAY_TIME_MIN, DELAY_TIME_MAX)];
      samples = Math.round((div.num * s.beat) / div.den);
    } else samples = Math.round(((c.p.time ?? 250) / 1000) * c.sr);
    const swell = (c.p.swell ?? 0) >= 0.5;
    const fb = ((c.p.fb ?? 0) * (swell ? DELAY_SWELL_NUM : 1)) / (swell ? DELAY_SWELL_DEN : 1);
    // swell: the loop through a soft clip (it holds a feedback past 1 at about full level instead of running away)
    const clip = swell ? delayClip : (x: number): number => x;
    const mix = c.p.mix ?? 0;
    const o = c.out.out;
    const r = c.out.r;
    if (!pp) {
      const d = Math.max(1, Math.min(lim - 1, samples));
      for (let i = 0; i < c.n; i++) {
        const e = s.buf[(s.w - d + len) % len];
        s.buf[s.w] = clip(c.inp.in[i] + e * fb);
        s.w = (s.w + 1) % len;
        o[i] = c.inp.in[i] * (1 - mix) + e * mix;
        r[i] = o[i];
      }
      return;
    }
    const d = Math.max(1, Math.min(Math.floor(lim / 2) - 1, samples));
    if (s.w >= half) s.w = 0;
    for (let i = 0; i < c.n; i++) {
      const rp = (s.w - d + half) % half;
      const ea = s.buf[rp];
      const eb = s.buf[half + rp];
      s.buf[half + s.w] = clip(ea * fb);
      s.buf[s.w] = clip(c.inp.in[i] + eb * fb);
      s.w = (s.w + 1) % half;
      const dry = c.inp.in[i] * (1 - mix);
      o[i] = dry + ea * mix;
      r[i] = dry + eb * mix;
    }
  },
};

/**
 * Reverb: an eight-line feedback delay network (FDN) with a Householder feedback matrix, a one-pole damping filter and a
 * decay gain in every line, two input diffusion allpasses, a pre-delay and a slow modulation of two of the lines (a
 * chorus of the tail that breaks up the metallic ring of fixed lines). Line lengths at DEVICE_SR (primes, 7.5..25 ms):
 * RV_LINE; the per-line gain g = 10^(-3 L / (T sr)) makes every line decay 60 dB in T = 0.2 x 2^(5 size) seconds
 * (0.2 .. 6.4 s). Input: x -> pre-delay -> two allpasses (g 0.5) -> x RV_GIN into every line; the feedback is
 * f_i = t_i - (sum of t) / 4 (Householder, lossless) with t_i = damped and decayed line output; wet = (sum of the raw
 * line outputs) x RV_GOUT. `freeze` holds the tail: every g is 1, no damping, and the input stops entering the lines (the
 * dry signal still passes). Lines 0 and 1 are read with a fractional delay that swings by mod x RV_MOD samples at
 * RV_MOD_HZ (sine, linear interpolation). Mono, shared per patch like the delay; the firmware keeps the same lines as
 * int16 (Q13) in one 16 KB block per instance.
 */
export const RV_LINE = [331, 439, 547, 661, 773, 881, 991, 1117];
export const RV_DIFF = [223, 347];
/** the pre-delay line: 40 ms at DEVICE_SR (the `pre` parameter's range) */
export const RV_PRE = 1764;
export const RV_PRE_MS = 40;
const RV_GIN = 0.125;
const RV_GOUT = 0.5;
const RV_MOD = 6;
const RV_MOD_HZ = [0.5, 0.83];
interface ReverbState {
  pre: Float32Array;
  pi: number;
  ap: Float32Array[];
  ai: number[];
  line: Float32Array[];
  li: number[];
  lp: number[];
  /** the two modulation LFOs, in turns */
  ph: number[];
}

const reverb: ModuleImpl<ReverbState> = {
  def: {
    type: 'reverb',
    label: 'Reverb',
    inputs: [audio('in')],
    outputs: [audio('out')],
    params: [
      param('size', 0, 1, 0.5, { step: 0.01 }),
      param('damp', 0, 1, 0.4, { step: 0.01 }),
      param('mix', 0, 1, 0.3, { step: 0.01 }),
      param('pre', 0, RV_PRE_MS, 0, { unit: 'ms', step: 0.5 }),
      param('mod', 0, 1, 0.3, { step: 0.01 }),
      param('freeze', 0, 1, 0, { step: 1, choices: ['off', 'on'], toggle: true, since: 35 }),
    ],
  },
  init: (sr) => {
    const len = (n: number): number => Math.max(4, Math.round((n * sr) / DEVICE_SR));
    return {
      pre: new Float32Array(len(RV_PRE)),
      pi: 0,
      ap: RV_DIFF.map((n) => new Float32Array(len(n))),
      ai: [0, 0],
      line: RV_LINE.map((n) => new Float32Array(len(n))),
      li: RV_LINE.map(() => 0),
      lp: RV_LINE.map(() => 0),
      ph: [0, 0],
    };
  },
  process(c, s) {
    // freeze: an infinite decay (every line's gain 1, no damping) and nothing new into the lines; the tail holds
    const frz = (c.p.freeze ?? 0) >= 0.5;
    const T = 0.2 * Math.pow(2, 5 * (c.p.size ?? 0.5));
    const g = s.line.map((b) => (frz ? 1 : Math.pow(2, (-9.965784 * b.length) / (T * c.sr)))); // 10^(-3 L / (T sr))
    const d = frz ? 0 : (c.p.damp ?? 0.4) * 0.8;
    const gin = frz ? 0 : RV_GIN;
    const mix = c.p.mix ?? 0.3;
    const dpre = Math.min(s.pre.length - 1, Math.round(((c.p.pre ?? 0) / 1000) * c.sr));
    const depth = (c.p.mod ?? 0) * RV_MOD;
    const inc = RV_MOD_HZ.map((f) => f / c.sr);
    const t = new Array<number>(8);
    for (let i = 0; i < c.n; i++) {
      const x = c.inp.in[i];
      // pre-delay
      let u = x;
      if (dpre > 0) {
        const rp = s.pi - dpre + s.pre.length;
        u = s.pre[rp % s.pre.length];
      }
      s.pre[s.pi] = x;
      if (++s.pi === s.pre.length) s.pi = 0;
      // input diffusion
      for (let k = 0; k < 2; k++) {
        const buf = s.ap[k];
        const bo = buf[s.ai[k]];
        const y = bo - u;
        buf[s.ai[k]] = u + bo * 0.5;
        if (++s.ai[k] === buf.length) s.ai[k] = 0;
        u = y;
      }
      u *= gin;
      // the lines: read (lines 0 and 1 at a modulated fractional delay), damp, decay, mix, write
      let wet = 0, sum = 0;
      for (let k = 0; k < 8; k++) {
        const buf = s.line[k];
        const w = s.li[k];
        let o: number;
        if (k < 2 && depth > 0) {
          const dl = buf.length - 2 - depth * (0.5 + 0.5 * Math.sin(2 * Math.PI * s.ph[k]));
          const di = Math.floor(dl);
          const fr = dl - di;
          const a = buf[(w - di + buf.length) % buf.length];
          const b = buf[(w - di - 1 + buf.length) % buf.length];
          o = a + (b - a) * fr;
        } else o = buf[w];
        wet += o;
        s.lp[k] = o * (1 - d) + s.lp[k] * d;
        t[k] = s.lp[k] * g[k];
        sum += t[k];
      }
      sum *= 0.25;
      for (let k = 0; k < 8; k++) {
        const buf = s.line[k];
        buf[s.li[k]] = u + t[k] - sum;
        if (++s.li[k] === buf.length) s.li[k] = 0;
      }
      for (let k = 0; k < 2; k++) {
        s.ph[k] += inc[k];
        if (s.ph[k] >= 1) s.ph[k] -= 1;
      }
      c.out.out[i] = x * (1 - mix) + wet * RV_GOUT * mix;
    }
  },
};

const output: ModuleImpl<null> = {
  def: {
    type: 'output',
    label: 'Output',
    inputs: [{ ...audio('l'), label: 'l (mono)' }, audio('r')],
    outputs: [],
    params: [param('level', 0, 1, 0.15, { step: 0.01 })], // low by default: a new patch's first, unshaped note should not be loud
  },
  init: () => null,
  process() {
    /* read by the engine */
  },
};

export const GLIDE_CURVES = ['exp', 'lin'];

/**
 * portamento, or a slew on any control. exp: a one-pole glide that reaches 99 % of a step in `time`, whatever its size;
 * lin: a constant rate of one unit (an octave of pitch) per `time`, so a bigger step takes longer
 */
const glide: ModuleImpl<{ y: number }> = {
  def: {
    type: 'glide',
    label: 'Slew limiter',
    inputs: [control('in')],
    outputs: [control('out')],
    params: [param('time', 0.001, 5, 0.1, { unit: 's', step: 0.001, log: true }), param('curve', 0, 1, 0, { step: 1, choices: GLIDE_CURVES })],
  },
  init: () => ({ y: 0 }),
  process(c, s) {
    if (Math.round(c.p.curve ?? 0) === 1) {
      const step = 1 / Math.max((c.p.time ?? 0.1) * c.sr, 1);
      for (let i = 0; i < c.n; i++) {
        const d = c.inp.in[i] - s.y;
        s.y += d > step ? step : d < -step ? -step : d;
        c.out.out[i] = s.y;
      }
      return;
    }
    const k = 1 - Math.exp(-4.6 / Math.max((c.p.time ?? 0.1) * c.sr, 1));
    for (let i = 0; i < c.n; i++) {
      s.y += k * (c.inp.in[i] - s.y);
      c.out.out[i] = s.y;
    }
  },
};

const SHAPES = ['soft', 'hard', 'fold'];
const OS_CHOICES = ['off', 'on'];

/**
 * 2x oversampling around a nonlinearity (the `os` toggle of the shaper and the digitizer): the input is interpolated to two
 * sub-samples by the FM oscillator's polyphase half-band used as an interpolator (even sub-sample = path 0, odd = path 1),
 * f runs on each, and the same half-band decimates the pair back (path 1 takes the odd sub-sample of the previous frame,
 * as in the oscillator). The harmonics the nonlinearity adds between 22 and 44 kHz are filtered out instead of folding
 * back. s.ap: 8 allpass states of the interpolator then 8 of the decimator, s.xb: the odd sub-sample waiting.
 */
interface OsState {
  xb: number;
  ap: number[];
}
const osInit = (): OsState => ({ xb: 0, ap: new Array(16).fill(0) });
function os2(s: OsState, x: number, f: (v: number) => number): number {
  const u0 = allpass(s.ap, 4, HB[2], allpass(s.ap, 0, HB[0], x));
  const u1 = allpass(s.ap, 6, HB[3], allpass(s.ap, 2, HB[1], x));
  const y0 = f(u0);
  const y1 = f(u1);
  const p0 = allpass(s.ap, 12, HB[2], allpass(s.ap, 8, HB[0], y0));
  const p1 = allpass(s.ap, 14, HB[3], allpass(s.ap, 10, HB[1], s.xb));
  s.xb = y1;
  return (p0 + p1) * 0.5;
}

/** the shaper's curve for the driven sample x: a cubic soft clip, a hard clip or a triangle fold, the peak at 1 */
function shapeCurve(x: number, mode: number): number {
  if (mode === 1) return Math.max(-1, Math.min(1, x));
  if (mode === 2) {
    const t = (((x + 1) % 4) + 4) % 4; // a triangle of period 4: back and forth between -1 and 1
    return t < 2 ? t - 1 : 3 - t;
  }
  return Math.abs(x) >= 1 ? Math.sign(x) : 1.5 * x - 0.5 * x * x * x; // cubic: smooth up to the knee at 1
}

/** the shaper's whole transfer: `sym` offsets the driven sample, then the curve runs `stages` times with a gain of 2 between them */
function shapeChain(x: number, mode: number, sym: number, stages: number): number {
  let y = shapeCurve(x + sym, mode);
  for (let k = 1; k < stages; k++) y = shapeCurve(y * 2, mode);
  return y;
}

/**
 * A waveshaper: drive into a cubic soft clip, a hard clip or a triangle fold; the peak stays at 1; `os` runs it 2x oversampled.
 * `sym` adds an offset before the curve (asymmetry: even harmonics, and a DC part that a high pass after it removes), `stages`
 * cascades the curve 1..4 times with a gain of 2 between stages: a fold folds its folds (a denser wavefolder), a clip saturates
 * like cascaded gain stages.
 */
const shape: ModuleImpl<OsState> = {
  def: {
    type: 'shape',
    label: 'Waveshaper',
    inputs: [audio('in')],
    outputs: [audio('out')],
    params: [
      param('drive', 1, 32, 2, { step: 0.01, log: true }),
      param('mode', 0, 2, 0, { step: 1, choices: SHAPES }),
      param('level', 0, 1, 0.7, { step: 0.01 }),
      param('os', 0, 1, 0, { step: 1, choices: OS_CHOICES, toggle: true }),
      param('sym', -1, 1, 0, { step: 0.01 }),
      param('stages', 1, 4, 1, { step: 1 }),
    ],
  },
  init: osInit,
  process(c, s) {
    const drive = c.p.drive ?? 1;
    const mode = Math.round(c.p.mode ?? 0);
    const lvl = c.p.level ?? 1;
    const os = (c.p.os ?? 0) >= 0.5;
    const sym = c.p.sym ?? 0;
    const stages = Math.max(1, Math.min(4, Math.round(c.p.stages ?? 1)));
    const f = (v: number): number => shapeChain(v, mode, sym, stages);
    for (let i = 0; i < c.n; i++) {
      const x = c.inp.in[i] * drive;
      c.out.out[i] = (os ? os2(s, x, f) : f(x)) * lvl;
    }
  },
};

/**
 * A level / rate envelope (the DX7 shape): on a gate it runs through three segments to l1, l2, l3 (each in its time r),
 * holds l3 while the gate stays up, and on release goes to l4 in r4 and stays there. A rising segment is linear at the
 * rate that would cover 0..1 in r (the ADSR's attack); a falling one approaches its level exponentially, 99 % in r (the
 * ADSR's decay) and ends after r (the last 1 % is stepped). A segment that starts at its level is skipped. Stage: 0 idle at
 * l4, 1..3 the segments, 4 holding l3, 5 the release. `shot` (one-shot, for drums played by short trigs): the gate only
 * starts it, the three segments run through whatever the gate does, then the release follows at once.
 */
interface EnvState {
  stage: 0 | 1 | 2 | 3 | 4 | 5;
  v: number;
  prev: number;
  /** samples spent in the current segment */
  t: number;
}

const env: ModuleImpl<EnvState> = {
  def: {
    type: 'env',
    label: 'Env L/R',
    inputs: [gate('gate')],
    outputs: [control('env')],
    params: [
      param('l1', 0, 1, 1, { step: 0.01 }),
      param('r1', 0.001, 10, 0.01, { unit: 's', step: 0.001, log: true }),
      param('l2', 0, 1, 0.6, { step: 0.01 }),
      param('r2', 0.001, 10, 0.3, { unit: 's', step: 0.001, log: true }),
      param('l3', 0, 1, 0.6, { step: 0.01 }),
      param('r3', 0.001, 10, 1, { unit: 's', step: 0.001, log: true }),
      param('l4', 0, 1, 0, { step: 0.01 }),
      param('r4', 0.001, 10, 0.5, { unit: 's', step: 0.001, log: true }),
      param('shot', 0, 1, 0, { step: 1, toggle: true }),
    ],
    views: [param('view', 0, 0, 0, { screen: true })],
  },
  init: () => ({ stage: 0, v: 0, prev: 0, t: 0 }),
  process(c, s) {
    const lv = [0, c.p.l1 ?? 1, c.p.l2 ?? 0.6, c.p.l3 ?? 0.6, c.p.l3 ?? 0.6, c.p.l4 ?? 0];
    const tm = [0, c.p.r1 ?? 0.01, c.p.r2 ?? 0.3, c.p.r3 ?? 1, 0, c.p.r4 ?? 0.5];
    const len = tm.map((t) => Math.max(Math.round(t * c.sr), 1));
    const inc = len.map((l) => 1 / l);
    const k = len.map((l) => 1 - Math.exp(-4.6 / l));
    const shot = (c.p.shot ?? 0) >= 0.5;
    for (let i = 0; i < c.n; i++) {
      const g = c.inp.gate[i] > 0.5 ? 1 : 0;
      if (g && !s.prev) {
        s.stage = 1;
        s.t = 0;
      } else if (!g && s.prev && !shot) {
        s.stage = 5;
        s.t = 0;
      }
      s.prev = g;
      // a segment: linear up, exponential down; done -> the next stage (the hold stages track their level)
      for (let guard = 0; guard < 4; guard++) {
        const st = s.stage;
        if (st === 0 || st === 4) {
          s.v = lv[st === 0 ? 5 : 3];
          break;
        }
        const t = lv[st];
        s.t++;
        if (s.v < t) {
          s.v += inc[st];
          if (s.v < t) break;
        } else if (s.t < len[st]) {
          s.v += (t - s.v) * k[st];
          break;
        }
        s.v = t;
        s.stage = st === 5 ? 0 : st === 3 && shot ? 5 : ((st + 1) as EnvState['stage']);
        s.t = 0;
      }
      c.out.env[i] = s.v;
    }
  },
};

/**
 * A plucked string (Karplus-Strong): a delay line of one period with a one-pole damping filter in its loop. A rising gate
 * fires a burst of one period (noise, or a square cycle) into the loop; whatever comes in at `exc` is added too, so an
 * oscillator click or a noise hit plucks it, and a steady signal makes it a tuned resonator. `decay` is the time to -60 dB
 * (per block, from the block's first pitch), `damp` the loop lowpass (0 = bright), whose delay the tuning compensates.
 * The period is set once per block: lowest note 40 Hz (period 1/40 s). The loop is held to +-2 (a steady exciter is
 * amplified by 1 / (1 - g)).
 */
const STR_LOW = 40;
const LOG2_1000 = Math.log2(1000);
interface StringState {
  buf: Float32Array;
  w: number;
  lp: number;
  s1: number;
  seed: number;
  /** burst samples left and the burst's length */
  burst: number;
  blen: number;
}

const string: ModuleImpl<StringState> = {
  def: {
    type: 'string',
    label: 'String',
    inputs: [control('pitch'), gate('gate'), audio('exc')],
    outputs: [audio('out')],
    params: [
      param('decay', 0.05, 10, 2, { unit: 's', step: 0.01, log: true }),
      param('damp', 0, 1, 0.3, { step: 0.01 }),
      param('burst', 0, 1, 0, { step: 1, choices: ['noise', 'pulse'] }),
      param('coarse', -24, 24, 0, { step: 1, unit: 'st' }),
      param('level', 0, 1, 0.8, { step: 0.01 }),
    ],
  },
  init: (sr) => ({ buf: new Float32Array(Math.ceil(sr / STR_LOW) + 1), w: 0, lp: 0, s1: 0, seed: 0x3779b97f, burst: 0, blen: 1 }),
  process(c, s) {
    const len = s.buf.length;
    const f = C4 * Math.pow(2, c.inp.pitch[0] + (c.p.coarse ?? 0) / 12);
    const period = Math.min(len - 2, Math.max(2, c.sr / f));
    const cl = 1 - 0.9 * (c.p.damp ?? 0.3);
    const dl = (1 - cl) / cl; // the one-pole's delay at low frequencies, taken off the line
    const d = Math.max(1, period - dl);
    const di = Math.floor(d);
    const fr = d - di;
    const g = Math.pow(2, (-LOG2_1000 * period) / ((c.p.decay ?? 2) * c.sr));
    const kind = Math.round(c.p.burst ?? 0);
    const lvl = c.p.level ?? 1;
    const bl = Math.round(period);
    for (let i = 0; i < c.n; i++) {
      const gate = c.inp.gate[i];
      if (gate >= 0.5 && s.s1 < 0.5) {
        s.burst = bl;
        s.blen = bl;
      }
      s.s1 = gate;
      let x = c.inp.exc[i];
      if (s.burst > 0) {
        if (kind === 0) {
          s.seed = (Math.imul(s.seed, 1664525) + 1013904223) >>> 0;
          x += s.seed / 0x80000000 - 1;
        } else x += s.blen - s.burst < s.blen >> 1 ? 1 : -1;
        s.burst--;
      }
      const r0 = s.buf[(s.w - di + len) % len];
      const r1 = s.buf[(s.w - di - 1 + len) % len];
      const r = r0 + (r1 - r0) * fr;
      s.lp += (r - s.lp) * cl;
      const y = Math.max(-2, Math.min(2, x + s.lp * g)); // a steady exciter would otherwise grow by 1 / (1 - g)
      s.buf[s.w] = y;
      s.w = (s.w + 1) % len;
      c.out.out[i] = y * lvl;
    }
  },
};

/**
 * The wavetables (tools/gen_wavetables.py): banks of eight frames, each frame its first 32 harmonics, at three mip
 * levels (32, 16, 8 harmonics) so the high notes do not alias. Built once from the coefficients in wavetables.json; the
 * firmware has the same tables as int16 in wt_tables.h.
 */
const WT_N = 256;
const WT_MIPS = [32, 16, 8];
const WT_BANKS: string[] = WT.banks;
const WT_T: Float32Array[][] = WT_MIPS.map((nh) =>
  (WT.frames as number[][][]).map((f) => {
    const t = new Float32Array(WT_N + 1);
    for (let i = 0; i < WT_N; i++) {
      let y = 0;
      for (let k = 1; k <= nh; k++) y += f[k - 1][0] * Math.cos((2 * Math.PI * k * i) / WT_N) + f[k - 1][1] * Math.sin((2 * Math.PI * k * i) / WT_N);
      t[i] = y;
    }
    t[WT_N] = t[0];
    return t;
  }),
);

interface WtState {
  phase: number;
  s1: number;
}

const wavetable: ModuleImpl<WtState> = {
  def: {
    type: 'wavetable',
    label: 'Wavetable',
    inputs: [control('pitch'), audio('pm'), gate('sync')],
    outputs: [audio('out')],
    params: [
      param('bank', 0, 3, 0, { step: 1, choices: WT_BANKS, top: WT_BANKS.length - 1 }),
      param('pos', 0, 1, 0, { step: 0.01 }),
      param('coarse', -48, 48, 0, { step: 1, unit: 'st' }),
      param('fine', -100, 100, 0, { step: 1, unit: 'ct' }),
      param('pm', 0, 8, 0, { step: 0.01 }),
      param('level', 0, 1, 0.8, { step: 0.01 }),
    ],
  },
  init: () => ({ phase: 0, s1: 0 }),
  process(c, s) {
    const { pitch, pm, sync } = c.inp;
    const base = (c.p.coarse ?? 0) / 12 + (c.p.fine ?? 0) / 1200;
    const bank = Math.round(c.p.bank ?? 0);
    const posf = Math.min(7, Math.max(0, (c.p.pos ?? 0) * 7));
    const f0 = Math.floor(posf);
    const f1 = Math.min(7, f0 + 1);
    const fm = posf - f0;
    const idx = c.connected.pm ? (c.p.pm ?? 0) : 0;
    const lvl = c.p.level ?? 1;
    const K = 1 / (2 * Math.PI);
    // the mip level from the block's first pitch: 32 harmonics below sr / 64, 16 below sr / 32, else 8
    const dt0 = (C4 * Math.pow(2, pitch[0] + base)) / c.sr;
    const mip = dt0 < 1 / 64 ? 0 : dt0 < 1 / 32 ? 1 : 2;
    const ta = WT_T[mip][bank * 8 + f0];
    const tb = WT_T[mip][bank * 8 + f1];
    for (let i = 0; i < c.n; i++) {
      const f = C4 * Math.pow(2, pitch[i] + base);
      const dt = Math.min(f / c.sr, 0.45);
      if (sync[i] >= 0.5 && s.s1 < 0.5) s.phase = 0;
      s.s1 = sync[i];
      s.phase += dt;
      if (s.phase >= 1) s.phase -= 1;
      let ph = s.phase + idx * pm[i] * K;
      ph -= Math.floor(ph);
      const x = ph * WT_N;
      const xi = Math.floor(x);
      const xf = x - xi;
      const ya = ta[xi] + (ta[xi + 1] - ta[xi]) * xf;
      const yb = tb[xi] + (tb[xi + 1] - tb[xi]) * xf;
      c.out.out[i] = (ya + (yb - ya) * fm) * lvl;
    }
  },
};

/**
 * A stereo chorus: one delay line, two taps swept in quadrature by a sine at `rate` around 12 ms by up to 8 ms (`depth`),
 * read with linear interpolation. Shared like the delay (one per patch on the FM-1); its l / r go to the output.
 */
const CH_BASE = 0.012;
const CH_SWING = 0.008;
interface ChorusState {
  buf: Float32Array;
  w: number;
  phase: number;
}

const chorus: ModuleImpl<ChorusState> = {
  def: {
    type: 'chorus',
    label: 'Chorus',
    inputs: [audio('in')],
    outputs: [audio('l'), audio('r')],
    params: [param('rate', 0.05, 5, 0.6, { unit: 'Hz', step: 0.01, log: true }), param('depth', 0, 1, 0.5, { step: 0.01 }), param('mix', 0, 1, 0.5, { step: 0.01 })],
  },
  init: (sr) => ({ buf: new Float32Array(Math.ceil(sr * 0.021)), w: 0, phase: 0 }),
  process(c, s) {
    const len = s.buf.length;
    const dphi = (c.p.rate ?? 0.6) / c.sr;
    const base = CH_BASE * c.sr;
    const swing = CH_SWING * c.sr * (c.p.depth ?? 0.5);
    const mix = c.p.mix ?? 0.5;
    const dry = 1 - mix;
    const tap = (d: number): number => {
      const di = Math.floor(d);
      const fr = d - di;
      const a = s.buf[(s.w - di + len) % len];
      const b = s.buf[(s.w - di - 1 + len) % len];
      return a + (b - a) * fr;
    };
    for (let i = 0; i < c.n; i++) {
      const x = c.inp.in[i];
      s.buf[s.w] = x;
      const dl = base + swing * Math.sin(2 * Math.PI * s.phase);
      const dr = base + swing * Math.sin(2 * Math.PI * (s.phase + 0.25));
      c.out.l[i] = x * dry + tap(dl) * mix;
      c.out.r[i] = x * dry + tap(dr) * mix;
      s.w = (s.w + 1) % len;
      s.phase += dphi;
      if (s.phase >= 1) s.phase -= 1;
    }
  },
};

/**
 * An eight-step control sequencer. A rising edge on `clock` moves to the next step (`len` steps, `dir`: forward, backward,
 * pendulum without repeating the ends, random); `reset` goes back to step 1. `out` is the current step's value all the
 * time (turning the step's knob is heard at once); `gate` follows the clock while the step is not a rest. A step turned
 * fully down (-1) is a rest.
 */
const SEQ_DIRS = ['fwd', 'back', 'pendulum', 'random'];
interface SeqState {
  pos: number;
  down: number;
  c1: number;
  r1: number;
  seed: number;
  /** the glide one-pole on out */
  y: number;
  /** samples between the last two clock edges (0 until two were seen) and since the last one */
  period: number;
  since: number;
  /** samples the gate stays up (gate length > 0) */
  gleft: number;
}

const seq: ModuleImpl<SeqState> = {
  def: {
    type: 'seq',
    label: 'Sequencer',
    inputs: [gate('clock'), gate('reset')],
    outputs: [control('out'), gate('gate')],
    params: [
      ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => param(`s${n}`, -1, 1, 0, { step: 0.01 })),
      param('len', 1, 8, 8, { step: 1 }),
      param('dir', 0, 3, 0, { step: 1, choices: SEQ_DIRS }),
      param('glide', 0, 1, 0, { step: 0.01 }),
      param('gate', 0, 1, 0, { step: 0.01 }),
    ],
  },
  init: () => ({ pos: 0, down: 0, c1: 0, r1: 0, seed: 0x9e3779b9, y: 0, period: 0, since: -1, gleft: 0 }),
  process(c, s) {
    const steps = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => c.p[`s${n}`] ?? 0);
    const len = Math.min(8, Math.max(1, Math.round(c.p.len ?? 8)));
    const dir = Math.round(c.p.dir ?? 0);
    // glide and gate length are fractions of the clock period, measured between the last two edges: nothing until two
    // edges were seen. glide: a one-pole on out that reaches 99 % in glide x period (0 = out is the step itself).
    // gate: the gate output stays up for gate x period after the edge (1 = legato, the steps tie); 0 = it follows the clock
    const gl = c.p.glide ?? 0;
    const glen = c.p.gate ?? 0;
    const k = gl > 0 && s.period > 0 ? 1 - Math.exp(-4.6 / Math.max(gl * s.period, 1)) : 0;
    const { clock, reset } = c.inp;
    for (let i = 0; i < c.n; i++) {
      const rst = reset[i] >= 0.5 && s.r1 < 0.5;
      const clk = clock[i] >= 0.5 && s.c1 < 0.5;
      s.r1 = reset[i];
      s.c1 = clock[i];
      if (s.since >= 0 && s.since < 8388608) s.since++; // -1 until the first edge
      if (clk) {
        if (s.since > 0) s.period = s.since;
        s.since = 0;
      }
      if (rst) {
        s.pos = 0;
        s.down = 0;
      } else if (clk) {
        if (s.pos >= len) s.pos = len - 1;
        if (dir === 1) s.pos = (s.pos + len - 1) % len;
        else if (dir === 2) {
          if (!s.down) {
            if (s.pos + 1 < len) s.pos++;
            else {
              s.pos = Math.max(len - 2, 0);
              s.down = 1;
            }
          } else if (s.pos > 0) s.pos--;
          else {
            s.pos = Math.min(1, len - 1);
            s.down = 0;
          }
        } else if (dir === 3) {
          s.seed = (Math.imul(s.seed, 1664525) + 1013904223) >>> 0;
          s.pos = (s.seed >>> 16) % len;
        } else s.pos = (s.pos + 1) % len;
      }
      const v = steps[Math.min(s.pos, len - 1)];
      if (k > 0) {
        s.y += k * (v - s.y);
        c.out.out[i] = s.y;
      } else c.out.out[i] = s.y = v;
      if (glen > 0 && s.period > 0) {
        if (clk) s.gleft = v > -1 ? Math.round(glen * s.period) : 0;
        c.out.gate[i] = s.gleft > 0 ? 1 : 0;
        if (s.gleft > 0) s.gleft--;
      } else c.out.gate[i] = clock[i] >= 0.5 && v > -1 ? 1 : 0;
    }
  },
};

/** a clock divider: `out` passes every `div`-th clock pulse (its width is the clock's), `d2` `d4` `d8` every 2nd, 4th, 8th; `reset` restarts the count so the next pulse is a downbeat */
const clkdiv: ModuleImpl<{ count: number; c1: number; r1: number }> = {
  def: {
    type: 'clkdiv',
    label: 'Clock divider',
    inputs: [gate('clock'), gate('reset')],
    outputs: [gate('out'), gate('d2'), gate('d4'), gate('d8')],
    params: [param('div', 1, 16, 3, { step: 1 })],
  },
  init: () => ({ count: -1, c1: 0, r1: 0 }),
  process(c, s) {
    const div = Math.min(16, Math.max(1, Math.round(c.p.div ?? 3)));
    const { clock, reset } = c.inp;
    for (let i = 0; i < c.n; i++) {
      if (reset[i] >= 0.5 && s.r1 < 0.5) s.count = -1;
      else if (clock[i] >= 0.5 && s.c1 < 0.5) s.count = (s.count + 1) % (16 * div);
      s.r1 = reset[i];
      s.c1 = clock[i];
      const hi = clock[i] >= 0.5 && s.count >= 0;
      c.out.out[i] = hi && s.count % div === 0 ? 1 : 0;
      c.out.d2[i] = hi && s.count % 2 === 0 ? 1 : 0;
      c.out.d4[i] = hi && s.count % 4 === 0 ? 1 : 0;
      c.out.d8[i] = hi && s.count % 8 === 0 ? 1 : 0;
    }
  },
};

/** sample & hold: `out` takes `in` on a rising edge of `clock` (hold), or follows it while the clock is up (track) */
const sh: ModuleImpl<{ v: number; c1: number }> = {
  def: {
    type: 'sh',
    label: 'S&H',
    inputs: [control('in'), gate('clock')],
    outputs: [control('out')],
    params: [param('mode', 0, 1, 0, { step: 1, choices: ['hold', 'track'] })],
  },
  init: () => ({ v: 0, c1: 0 }),
  process(c, s) {
    const track = Math.round(c.p.mode ?? 0) === 1;
    const { clock } = c.inp;
    for (let i = 0; i < c.n; i++) {
      const up = clock[i] >= 0.5;
      if (track ? up : up && s.c1 < 0.5) s.v = c.inp.in[i];
      s.c1 = clock[i];
      c.out.out[i] = s.v;
    }
  },
};

/** the scales of the quantizer as semitones above the root */
const SCALES: { name: string; st: number[] }[] = [
  { name: 'chromatic', st: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
  { name: 'major', st: [0, 2, 4, 5, 7, 9, 11] },
  { name: 'minor', st: [0, 2, 3, 5, 7, 8, 10] },
  { name: 'pent maj', st: [0, 2, 4, 7, 9] },
  { name: 'pent min', st: [0, 3, 5, 7, 10] },
  { name: 'dorian', st: [0, 2, 3, 5, 7, 9, 10] },
  { name: 'mixolydian', st: [0, 2, 4, 5, 7, 9, 10] },
  { name: 'blues', st: [0, 3, 5, 6, 7, 10] },
  { name: 'whole', st: [0, 2, 4, 6, 8, 10] },
  { name: 'fifths', st: [0, 7] },
  { name: 'octaves', st: [0] },
];
const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const SCALE_TABLE = SCALES;

/** a pitch quantizer: the nearest note of `scale` on `root` (pitch in octaves, C4 = 0; ties go down) */
const quant: ModuleImpl<null> = {
  def: {
    type: 'quant',
    label: 'Quantizer',
    inputs: [control('in')],
    outputs: [control('out')],
    params: [param('scale', 0, SCALES.length - 1, 1, { step: 1, choices: SCALES.map((x) => x.name) }), param('root', 0, 11, 0, { step: 1, choices: NOTES })],
  },
  init: () => null,
  process(c) {
    const sc = SCALES[Math.min(SCALES.length - 1, Math.max(0, Math.round(c.p.scale ?? 0)))].st;
    const root = Math.round(c.p.root ?? 0);
    for (let i = 0; i < c.n; i++) {
      const semis = c.inp.in[i] * 12 - root;
      const oct = Math.floor(semis / 12);
      const w = semis - 12 * oct;
      let best = sc[0];
      let bd = Math.abs(w - best);
      for (let k = 1; k <= sc.length; k++) {
        const d = k < sc.length ? sc[k] : sc[0] + 12;
        const dd = Math.abs(w - d);
        if (dd < bd) {
          bd = dd;
          best = d;
        }
      }
      c.out.out[i] = (12 * oct + best + root) / 12;
    }
  },
};

/** a trigger to a gate of a set length: a rising edge on `trig` raises `out` for `time` (a new edge restarts it). `inf`:
 * the window does not end (the Model:Cycles' INF retrig length); switched off, it ends `time` later. */
const pulse: ModuleImpl<{ rem: number; t1: number }> = {
  def: {
    type: 'pulse',
    label: 'Pulse',
    inputs: [gate('trig')],
    outputs: [gate('out')],
    params: [param('time', 0.001, 2, 0.1, { unit: 's', step: 0.001, log: true }), param('inf', 0, 1, 0, { step: 1, choices: ['off', 'on'], toggle: true, since: 35 })],
  },
  init: () => ({ rem: 0, t1: 0 }),
  process(c, s) {
    const len = Math.max(1, Math.round((c.p.time ?? 0.1) * c.sr));
    const inf = (c.p.inf ?? 0) >= 0.5;
    const { trig } = c.inp;
    for (let i = 0; i < c.n; i++) {
      if (trig[i] >= 0.5 && s.t1 < 0.5) s.rem = len;
      s.t1 = trig[i];
      c.out.out[i] = s.rem > 0 ? 1 : 0;
      if (s.rem > 0 && !inf) s.rem--;
    }
  },
};


/** equal-power pan: l = cos, r = sin of (position + 1) pi / 4; the `pos` input adds to the parameter (the panel's spread, an LFO) */
const pan: ModuleImpl<null> = {
  def: {
    type: 'pan',
    label: 'Pan',
    inputs: [audio('in'), control('pos')],
    outputs: [audio('l'), audio('r')],
    params: [param('pan', -1, 1, 0, { step: 0.01, input: 'pos', rest: (p, cv) => (p.pan ?? 0) + cv })],
  },
  init: () => null,
  process(c) {
    const base = c.p.pan ?? 0;
    let p = base;
    for (let i = 0; i < c.n; i++) {
      p = Math.min(1, Math.max(-1, base + c.inp.pos[i]));
      const a = ((p + 1) * Math.PI) / 4;
      c.out.l[i] = c.inp.in[i] * Math.cos(a);
      c.out.r[i] = c.inp.in[i] * Math.sin(a);
    }
    if (c.display) c.display.pan = p;
  },
};

/** linear crossfade a -> b by mix + pos */
const xfade: ModuleImpl<null> = {
  def: {
    type: 'xfade',
    label: 'Crossfader',
    inputs: [audio('a'), audio('b'), control('pos')],
    thru: 'a',
    outputs: [audio('out')],
    params: [param('mix', 0, 1, 0.5, { step: 0.01, input: 'pos', rest: (p, cv) => (p.mix ?? 0.5) + cv })],
  },
  init: () => null,
  process(c) {
    const base = c.p.mix ?? 0.5;
    let m = base;
    for (let i = 0; i < c.n; i++) {
      m = Math.min(1, Math.max(0, base + c.inp.pos[i]));
      c.out.out[i] = c.inp.a[i] * (1 - m) + c.inp.b[i] * m;
    }
    if (c.display) c.display.mix = m;
  },
};

/** the formants (Hz) of A E I O U and their gains: three parallel band passes, the position morphs between neighbours */
const FORMANTS = [
  [730, 1090, 2440],
  [530, 1840, 2480],
  [390, 1990, 2550],
  [570, 840, 2410],
  [440, 1020, 2240],
];
const FORMANT_GAIN = [1, 0.5, 0.25];

interface VowelState {
  ic1: number[];
  ic2: number[];
}

/** a vowel filter: three SVF band passes (normalized band, peak 1) at the formants of the vowel `vowel` + input, once per block */
const vowel: ModuleImpl<VowelState> = {
  def: {
    type: 'vowel',
    label: 'Formant filter',
    inputs: [audio('in'), control('vowel')],
    outputs: [audio('out')],
    params: [param('vowel', 0, 4, 0, { step: 0.01, input: 'vowel', rest: (p, cv) => (p.vowel ?? 0) + cv }), param('res', 0, 1, 0.5, { step: 0.01 }), param('level', 0, 1, 0.7, { step: 0.01 })],
  },
  init: () => ({ ic1: [0, 0, 0], ic2: [0, 0, 0] }),
  process(c, s) {
    const v = Math.min(4, Math.max(0, (c.p.vowel ?? 0) + c.inp.vowel[0]));
    if (c.display) c.display.vowel = v;
    const vi = Math.min(3, Math.floor(v));
    const t = v - vi;
    const k = 1 / (2 + 18 * (c.p.res ?? 0.5));
    const lvl = c.p.level ?? 0.7;
    const a1: number[] = [];
    const a2: number[] = [];
    const a3: number[] = [];
    for (let f = 0; f < 3; f++) {
      const hz = FORMANTS[vi][f] + (FORMANTS[vi + 1][f] - FORMANTS[vi][f]) * t;
      const g = Math.tan((Math.PI * Math.min(hz, c.sr * 0.45)) / c.sr);
      a1[f] = 1 / (1 + g * (g + k));
      a2[f] = g * a1[f];
      a3[f] = g * a2[f];
    }
    for (let i = 0; i < c.n; i++) {
      const v0 = c.inp.in[i];
      let sum = 0;
      for (let f = 0; f < 3; f++) {
        const v3 = v0 - s.ic2[f];
        const v1 = a1[f] * s.ic1[f] + a2[f] * v3;
        const v2 = s.ic2[f] + a2[f] * s.ic1[f] + a3[f] * v3;
        s.ic1[f] = 2 * v1 - s.ic1[f];
        s.ic2[f] = 2 * v2 - s.ic2[f];
        sum += FORMANT_GAIN[f] * k * v1;
      }
      c.out.out[i] = sum * lvl;
    }
  },
};

interface PhaserState {
  /** the sweep LFO's phase, 0..1 */
  ph: number;
  /** x1 / y1 of the four allpass stages */
  ap: number[];
  /** the last output of stage 4 (feedback) */
  fbv: number;
}

/** a four-stage phaser: one allpass coefficient for all stages from a triangle sweep of +-2 depth octaves around center, set once per block */
const phaser: ModuleImpl<PhaserState> = {
  def: {
    type: 'phaser',
    label: 'Phaser',
    inputs: [audio('in')],
    outputs: [audio('out')],
    params: [
      param('rate', 0.02, 10, 0.5, { unit: 'Hz', step: 0.01, log: true }),
      param('depth', 0, 1, 0.7, { step: 0.01 }),
      param('center', 100, 4000, 800, { unit: 'Hz', step: 1, log: true }),
      param('fb', 0, 0.9, 0.3, { step: 0.01 }),
      param('mix', 0, 1, 0.5, { step: 0.01 }),
    ],
  },
  init: () => ({ ph: 0, ap: [0, 0, 0, 0, 0, 0, 0, 0], fbv: 0 }),
  process(c, s) {
    const rate = c.p.rate ?? 0.5;
    const tri = wave(1, s.ph, 0);
    const f = Math.min(c.sr * 0.45, Math.max(20, (c.p.center ?? 800) * Math.pow(2, 2 * (c.p.depth ?? 0) * tri)));
    const g = Math.tan((Math.PI * f) / c.sr);
    const a = (g - 1) / (g + 1);
    const fb = c.p.fb ?? 0;
    const mix = c.p.mix ?? 0.5;
    for (let i = 0; i < c.n; i++) {
      const x0 = c.inp.in[i];
      let x = Math.min(8, Math.max(-8, x0 + fb * s.fbv));
      for (let k = 0; k < 4; k++) x = allpass(s.ap, 2 * k, a, x);
      s.fbv = x;
      c.out.out[i] = x0 * (1 - mix) + x * mix;
    }
    s.ph += (c.n * rate) / c.sr;
    s.ph -= Math.floor(s.ph);
  },
};

/** bit depth and sample rate reduction: 2^bits levels over -1..1, every taken sample held for `rate` samples */
/** bit depth and sample rate reduction; `os` runs it 2x oversampled (the rate counts input samples either way) */
const crush: ModuleImpl<{ held: number; cnt: number } & OsState> = {
  def: {
    type: 'crush',
    label: 'Bitcrusher',
    inputs: [audio('in')],
    outputs: [audio('out')],
    params: [param('bits', 1, 16, 8, { step: 1 }), param('rate', 1, 64, 1, { step: 1 }), param('os', 0, 1, 0, { step: 1, choices: OS_CHOICES, toggle: true })],
  },
  init: () => ({ held: 0, cnt: 0, ...osInit() }),
  process(c, s) {
    const bits = Math.round(c.p.bits ?? 8);
    const os = (c.p.os ?? 0) >= 0.5;
    const rate = Math.round(c.p.rate ?? 1) * (os ? 2 : 1);
    const q = Math.pow(2, bits - 1);
    const f = (v: number): number => {
      if (s.cnt <= 0) {
        s.held = Math.floor(v * q + 0.5) / q;
        s.cnt = rate;
      }
      s.cnt--;
      return s.held;
    };
    for (let i = 0; i < c.n; i++) c.out.out[i] = os ? os2(s, c.inp.in[i], f) : f(c.inp.in[i]);
  },
};

/**
 * The engine's form of a Voice allocator (poly.ts deviceView puts one in every poly group, as the FM-1 runs it; patches
 * do not hold it any more: old ones get an allocator instead). A poly assembly's own keyboard: the note its part plays (pitch with the bend and the part's detune / drift flaw, gate, velocity), the part's place among
 * the parts (index -1 first .. 1 last, 0 with one part), whether the note began over a held one (legato) and its pitch
 * step from the previous note in octaves (jump; the first from C4). Outside a poly assembly it is the shared keyboard.
 */
const part: ModuleImpl<null> = {
  def: {
    type: 'part',
    label: 'Part',
    inputs: [],
    outputs: [control('pitch'), gate('gate'), control('vel'), control('index'), gate('legato'), control('jump'), gate('trig'), gate('low'), gate('high'), gate('unison')],
    params: [],
  },
  init: () => null,
  process(c) {
    const v = c.voice;
    c.out.pitch.fill(v.pitch + v.bend * BEND_OCT + v.flaw, 0, c.n);
    c.out.gate.fill(v.gate, 0, c.n);
    c.out.vel.fill(v.velocity, 0, c.n);
    c.out.index.fill(v.parts > 1 ? (2 * v.index - (v.parts - 1)) / (v.parts - 1) : 0, 0, c.n);
    c.out.legato.fill(v.legato, 0, c.n);
    c.out.jump.fill(v.jump, 0, c.n);
    c.out.trig.fill(0, 0, c.n);
    if (v.keyTrig) c.out.trig[0] = 1;
    c.out.low.fill(v.low ? 1 : 0, 0, c.n);
    c.out.high.fill(v.high ? 1 : 0, 0, c.n);
    c.out.unison.fill(v.unison ? 1 : 0, 0, c.n);
  },
};

export const RANDOM_MODES = ['fixed', 'walk'];
interface RandomState {
  seed: number;
  walk: Walk;
  heldSeed: number;
  held: number;
  clock: number;
}
/**
 * A random value per copy, -1..1: `fixed` never changes (an analog part's tolerance), `walk` wanders slowly, a new target
 * every 1 / rate seconds (drift). `held` draws a new independent value on each rising `clock` edge. Each copy has its
 * own stream: the seed mixes the module's place in the patch and its part. The clocked stream does not alter `out`.
 */
const random: ModuleImpl<RandomState> = {
  def: {
    type: 'random',
    label: 'Random',
    inputs: [],
    outputs: [control('out'), control('held')],
    params: [param('mode', 0, 1, 0, { step: 1, choices: RANDOM_MODES }), param('rate', 0.05, 20, 1.5, { unit: 'Hz', step: 0.01, log: true })],
  },
  init: () => ({ seed: 0, walk: walkInit(0), heldSeed: 0, held: 0, clock: 0 }),
  seed(s, seed) {
    s.seed = seed;
    s.walk = walkInit(seed ^ 0x2545f491);
    s.heldSeed = hash32(seed ^ 0xa511e9b3);
  },
  process(c, s) {
    walkStep(s.walk, walkHold(c.sr, c.p.rate ?? 1.5)); // every block, so the wander does not depend on the mode
    const q = Math.round(c.p.mode ?? 0) ? s.walk.y : randomFixed(s.seed);
    c.out.out.fill(q / 32768, 0, c.n);
    if (c.used?.held === false) return;
    for (let i = 0; i < c.n; i++) {
      const clock = c.inp.clock[i];
      if (clock >= 0.5 && s.clock < 0.5) {
        s.heldSeed = lcg(s.heldSeed);
        s.held = q15(s.heldSeed) / 32768;
      }
      s.clock = clock;
      c.out.held[i] = s.held;
    }
  },
};

export const UNISON_MODES = ['off', 'on'];
export const UNISON_ASSIGN = [...UNISON_MODES, 'share'];
/** a Voice allocator's MIDI channel: `all` = the device's channel (MENU > MIDI CHANNEL on the FM-1, every channel in the browser) */
export const KEY_CHANNELS = ['all', ...Array.from({ length: 16 }, (_, i) => `${i + 1}`)];
const PITCH_CLASSES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
/** MIDI note numbers as names, C4 = 60 (the allocator's key range) */
export const NOTE_NAMES = Array.from({ length: 128 }, (_, n) => `${PITCH_CLASSES[n % 12]}${Math.floor(n / 12) - 1}`);
/**
 * Voice allocator: a polysynth's CPU. It takes the keys held on its `keys` input (Main's keys) and hands them to `voices`
 * voices (assign, priority, legato as poly.ts describes; unison: up to stack voices play the note the priority picks, with zero selecting all). Each
 * output is per voice: into a poly assembly voice i reaches copy i (the voice cards), into a module that runs once the
 * voices sum. The poly assemblies it feeds run once per voice. The engines run it in its Part form (poly.ts deviceView).
 * channel / low / high: it takes only the keys of that MIDI channel (all = the device's) between those notes (a split or
 * a layer per channel); an Arpeggiator's notes are judged by the range only.
 */
const alloc: ModuleImpl<null> = {
  def: {
    type: 'alloc',
    label: 'Voicing',
    inputs: [keys('keys')],
    outputs: [control('pitch'), gate('gate'), control('vel'), control('index'), gate('legato'), control('jump'), gate('trig'), gate('low'), gate('high'), gate('unison')],
    params: [
      param('voices', 1, 16, 4, { step: 1 }),
      param('assign', 0, 2, 0, { step: 1, choices: ASSIGN_MODES, top: 3 }),
      param('legato', 0, 2, 0, { step: 1, choices: LEGATO_MODES }),
      param('priority', 0, 2, 0, { step: 1, choices: PRIORITIES }),
      param('unison', 0, 1, 0, { step: 1, choices: UNISON_ASSIGN, top: 2 }),
      param('channel', 0, 16, 0, { step: 1, choices: KEY_CHANNELS }),
      param('low', 0, 127, 0, { step: 1, choices: NOTE_NAMES }),
      param('high', 0, 127, 127, { step: 1, choices: NOTE_NAMES }),
      param('steal', 0, 1, 1, { step: 1, choices: UNISON_MODES, toggle: true, since: 37 }),
      param('stack', 0, 16, 0, { step: 1, choices: ['all', ...Array.from({ length: 16 }, (_, i) => `${i + 1}`)], since: 38 }),
    ],
  },
  init: () => null,
  process: (c) => part.process(c, null),
};

/**
 * Arpeggiator: keys in, keys out (between the Main module and a Voice allocator). It plays the held keys one at a time
 * (arpeggiator.ts: mode, octaves, tempo rate or continuous Hz input, clock-edge override, gate length, latch). It runs once
 * (SHARED_TYPES); the engine runs its notes, not process(): the keys output only shows the gate of the note it plays.
 */
const arp: ModuleImpl<null> = {
  def: {
    type: 'arp',
    label: 'Arpeggiator',
    inputs: [keys('keys'), gate('clk'), control('rate')],
    outputs: [keys('keys')],
    params: [
      param('mode', 0, ARP_MODES.length - 1, 0, { step: 1, choices: ARP_MODES }),
      param('rate', 0, ARP_RATES.length - 1, 4, { step: 1, choices: ARP_RATES }),
      param('octaves', 1, 4, 1, { step: 1 }),
      param('gate', 0.1, 1, 0.5, { step: 0.01 }),
      param('latch', 0, 1, 0, { step: 1, choices: ['off', 'on'], toggle: true }),
    ],
  },
  init: () => null,
  process(c) {
    c.out.keys.fill(c.voice.gate, 0, c.n);
  },
};

/** a note a Steps track is sounding: the key it sent (its note + the transpose), steps still to go after the one it is
 * on, samples until it ends (TRACK_POLY at most; engine.c trk_snd); `thru`: a key played into the armed track (#134,
 * the note played), sounding until it is let go */
export interface StepsSound { key: number; left: number; cnt: number; thru?: number }
/** how many notes a Steps track sounds at once (a further note ends the oldest) */
export const TRACK_POLY = 8;

/** a track's pattern as the engine holds it (track.ts Pattern; pattern 1 has no length or rate of its own) */
export interface StepsPattern { notes: StepNote[]; len?: number; rate?: number }
/** the patch's song state the engine shares with its tracks (Main's `seq`): the song playing (0 none) and the songs */
export interface StepsSong { song: number; songs: SongEntry[][] }

/** the Steps module's state: its patterns (ModuleInst.notes, .patterns, loaded by the engine), the notes of the one it
 * plays, and where it plays */
export interface StepsState {
  notes: StepNote[];
  /** pattern k + 1 at k (null: the track has none of that number, which plays its pattern 1) */
  pats: (StepsPattern | null)[];
  /** the pattern playing (0-based; one the track has not got plays pattern 1), the one to play from the end of this pass
   * (-1 none; with the transport stopped it plays from the next block), the song entry playing (-1: the next pass plays
   * the first), the entry's shift (semitones; never on a track that plays a Drum map: `drum`) */
  pat: number;
  queued: number;
  songPos: number;
  shift: number;
  drum: boolean;
  song: StepsSong;
  /** what the pitch / vel outputs hold: the last note that started (before the first: STEP_NOTE / STEP_VEL), pitch in
   * octaves from C4 */
  pitch: number;
  vel: number;
  seed: number;
  /** muted (the device's SEQ page, the editor's card; never saved): no new notes */
  mute: boolean;
  /** the transport as the last block saw it, the clk / reset inputs' last samples */
  run: boolean;
  c1: number;
  r1: number;
  /** half ticks since the last step (its own clock; -1 after a step half a tick past one), the step playing (-1: the next
   * step is the first), times round the pattern */
  count: number;
  pos: number;
  /** ordinal visit within the current traversal, independent of the step chosen */
  visit: number;
  loop: number;
  /** a step half a tick after a tick (1/64): samples to go (0: none) */
  half: number;
  /** a swung step waiting: samples to go (0: none) and which step */
  pend: number;
  pstep: number;
  /** the notes sounding; one low trig sample before a note that starts while one sounds */
  snd: StepsSound[];
  gap: boolean;
  /** clk mode: samples since the last edge and between the last two (-1 / 0 before) */
  since: number;
  period: number;
  /** keys out: the notes started (key | 0x80, velocity 1..127) and ended (key, 0) this block, in order; the engine hands
   * them to the poly groups the track plays at the start of the next block */
  ev: number[];
  /** keys in while the track is armed (#134; editor only, the engine's noteOn / noteOff put them here): played notes
   * (note | 0x80, velocity 1..127) and let go (note, 0), passed through at the start of the next block */
  thru: number[];
  /** live recording (#135; editor only, Engine.setRec): the played notes become notes of the track while it runs */
  rec: boolean;
  /** samples since the last step began and a step's length then (where a played note lands: the nearest step) */
  ago: number;
  sl: number;
  /** the notes being recorded: the step they landed on, samples since that step's start (negative: before it), velocity */
  rin: { note: number; at: number; t: number; vel: number; loop: number }[];
  /** recorded notes (lengths in whole steps, at least one) and the time round the pattern they were played on, for the
   * editor to take (Engine.takeRecorded) */
  took: { note: StepNote; loop: number }[];
}

/** does note j of step k (in stored order) play on time `loop` round the pattern (firmware: steps_plays); note 0 hashes as
 * the step did before #133, so a migrated pattern plays the same */
export function notePlays(seed: number, loop: number, k: number, j: number, chance = 100): boolean {
  const code = Math.min(19, Math.max(0, Math.round((100 - chance) / 5)));
  return !code || hash32((seed ^ Math.imul(loop, 0x9e3779b9) ^ Math.imul(k + 1, 0x85ebca6b) ^ Math.imul(j, 0xc2b2ae35)) >>> 0) % 100 < 100 - 5 * code;
}

/** the pattern a track plays (pats[pat], else its pattern 1) */
export const stepsPattern = (s: StepsState): StepsPattern => s.pats[s.pat] ?? s.pats[0] ?? { notes: [] };
/** pattern p plays now: its notes are the track's */
export function stepsGo(s: StepsState, p: number): void {
  s.pat = p;
  s.notes = stepsPattern(s).notes;
}
/** the end of a pass (engine.c steps_turn): in a song, the next entry's pattern and shift (after the last, the first
 * again); else a queued pattern */
function stepsTurn(s: StepsState): void {
  const song = s.song.song > 0 ? s.song.songs[s.song.song - 1] : undefined;
  if (song?.length) {
    s.songPos = s.songPos + 1 >= song.length ? 0 : s.songPos + 1;
    const e = song[s.songPos];
    stepsGo(s, e.pat);
    s.shift = s.drum ? 0 : e.shift;
    s.queued = -1;
    return;
  }
  s.shift = 0;
  if (s.queued >= 0) stepsGo(s, s.queued);
  s.queued = -1;
}

const stepCycle = (len: number, dir: number): number => dir === 2 && len > 1 ? 2 * (len - 1) : len;

/** Preview the next visited step without consuming it, also used by live recording. */
function nextStep(s: StepsState, len: number, dir: number): { visit: number; pos: number; loop: number } {
  const visit = s.pos < 0 || s.visit + 1 >= stepCycle(len, dir) ? 0 : s.visit + 1;
  const loop = (s.loop + (visit === 0 ? 1 : 0)) >>> 0;
  const pos = dir === 3 ? hash32((s.seed ^ Math.imul(loop, 0x9e3779b9) ^ Math.imul(visit + 1, 0x85ebca6b)) >>> 0) % len
    : dir === 1 ? len - 1 - visit : dir === 2 && visit >= len ? 2 * (len - 1) - visit : visit;
  return { visit, pos, loop };
}

/** a MIDI note as the pitch output gives it: octaves from C4, Q16 rounded half away from zero (as engine.c) */
const stepPitch = (note: number): number => (Math.sign(note - STEP_NOTE) * Math.round((Math.abs(note - STEP_NOTE) * 65536) / 12)) / 65536;

/**
 * Steps: a track of notes (#83, #133). Each note (ModuleInst.notes, track.ts) starts on a step, lasts a number of steps
 * and has a velocity and a chance; a step can hold several (a chord). `len` plays the first steps; a note is cut at the
 * end of its traversal. `dir` selects forward, backward, ping-pong without repeated endpoints, or seeded random.
 * Swing counts visits in time order; live recording previews the same next visit as playback. With nothing in clk it follows the engine's clock while the transport runs: the first step when
 * PLAY starts, then one step per `rate` (STEPS_RATES: half ticks of the 24 ppqn clock, STEPS_RATE_HT), each on the sample
 * its tick falls on; 1/64 is a tick and a half, so every second step lands half a tick (tickLen / 2 samples, rounded down)
 * after a tick. A rising edge in clk is a step instead. reset: the next step is the first. `swing` (50 % straight, 80 % the
 * most) delays every second step by (swing - 50) / 50 of a step. Rates 1/2 and 1/64 and swing past 75 % are a stretch of
 * the range (ParamDef.top): pins, macro ranges and the morph span what they did before (#351). A note sounds for `gate` of its last step (a longer note holds through the
 * steps before it: two steps at most from the last, so a stopped clock lets it end).
 * keys out: every note on / off, transposed, like Main's keys (the instrument's allocator decides the voices; the engine
 * delivers them at the start of the next block). The mono outputs: trig is up while any note sounds (one low sample when
 * a note starts while one sounds), pitch (octaves from C4, plus transpose) and vel (velocity / 127) hold the last note
 * that started. The name travels in its binary record (`data`), the notes in the notes section (patchbin.ts flag bit 4);
 * it runs once (SHARED_TYPES).
 * keys in (#134, after the pins): while the track is armed (the editor's ARM; Engine.arm) the keys played go in and
 * straight through, as the track's own notes: transposed, into keys out and the mono outputs, held until let go (muted
 * too). A cable from Main's keys into it does the same while no track is armed (#138: Main's keys play the track's
 * instrument, the track adds its notes). Other cables into it play no part. The FM-1 does neither (#139).
 */
const steps: ModuleImpl<StepsState> = {
  def: {
    type: 'steps',
    label: 'Steps',
    inputs: [gate('clk'), gate('reset'), control('transpose')],
    outputs: [gate('trig'), control('pitch'), control('vel'), keys('keys')],
    views: [param('grid', 0, 0, 0, { screen: true })],
    params: [
      param('len', 1, STEPS_MAX, 16, { step: 1 }),
      param('rate', 0, STEPS_RATE_PIN_MAX, 4, { step: 1, choices: STEPS_RATES, top: STEPS_RATES.length - 1 }),
      param('swing', 50, SWING_PIN_MAX, 50, { step: 1, unit: '%', top: SWING_MAX }),
      param('gate', 0.01, 1, 0.25, { step: 0.01 }),
      param('dir', 0, 3, 0, { step: 1, choices: ['fwd', 'back', 'ping-pong', 'random'], since: 44 }),
    ],
    data: TRACK_NAME_MAX,
  },
  init: () => ({ notes: [], pats: [{ notes: [] }], pat: 0, queued: -1, songPos: -1, shift: 0, drum: false, song: { song: 0, songs: [] }, pitch: 0, vel: STEP_VEL / 127, seed: 0, mute: false, run: false, c1: 0, r1: 0, count: 0, pos: -1, visit: 0, loop: 0, half: 0, pend: 0, pstep: 0, snd: [], gap: false, since: -1, period: 0, ev: [], thru: [], rec: false, ago: 0, sl: 0, rin: [], took: [] }),
  seed(s, seed) {
    s.seed = seed;
  },
  process(c, s) {
    const q16 = (v: number | undefined): number => Math.round((v ?? 0) * 65536);
    const v = c.voice;
    if (s.queued >= 0 && !v.run) { // stopped: a chosen pattern plays at once
      stepsGo(s, s.queued);
      s.queued = -1;
    }
    // the pattern's own length and rate, else the track's (a pattern switch at the end of a pass changes them)
    let len = 0, ht = 0, step = 0;
    const shape = (): void => {
      const x = s.pat > 0 ? s.pats[s.pat] : null;
      len = Math.min(STEPS_MAX, Math.max(1, x?.len ?? Math.round(c.p.len ?? 16)));
      ht = STEPS_RATE_HT[Math.min(STEPS_RATE_HT.length - 1, Math.max(0, x?.rate ?? Math.round(c.p.rate ?? 4)))];
      step = Math.floor((ht * v.tickLen) / 2); // a step's samples at the clock's rate
    };
    shape();
    const dir = Math.max(0, Math.min(3, Math.round(c.p.dir ?? 0)));
    const swing = q16(c.p.swing ?? 50) - 50 * 65536;
    const gate = q16(c.p.gate ?? 0.25);
    const ext = !!c.connected.clk;
    const { clk, reset, transpose } = c.inp;
    const end = (j: number): void => {
      s.ev.push(s.snd[j].key, 0);
      s.snd.splice(j, 1);
    };
    const fire = (k: number, i: number): void => {
      const sl = ext && s.period > 0 ? s.period : ext ? 6 * v.tickLen : step;
      // a note's samples from here: through to the next step while more follow (two steps at most), else gate of a step
      const hold = (left: number): number => (left > 0 ? 2 * sl : Math.max(1, Math.floor((gate * sl) / 65536)));
      for (const x of s.snd)
        if (x.left > 0 && x.cnt > 0 && !s.mute) x.cnt = hold(--x.left);
      if (s.mute) return;
      const was = s.snd.some((x) => x.cnt > 0);
      const semis = Math.floor((q16(transpose[i]) * 12 + 32768) / 65536);
      let j = 0, any = false;
      for (const n of s.notes) {
        if (n.at !== k) continue;
        if (notePlays(s.seed, s.loop, k, j++, n.chance)) {
          const note = Math.max(0, Math.min(127, n.note + s.shift)); // (a song entry's shift)
          const key = Math.max(0, Math.min(127, note + semis));
          const same = s.snd.findIndex((x) => x.key === key);
          if (same >= 0) end(same);
          if (s.snd.length >= TRACK_POLY) end(0);
          const left = Math.min(n.len, Math.max(1, stepCycle(len, dir) - s.visit)) - 1;
          s.snd.push({ key, left, cnt: hold(left) });
          s.ev.push(key | 0x80, n.vel);
          s.pitch = stepPitch(note);
          s.vel = n.vel / 127;
          any = true;
        }
      }
      if (any) s.gap = was;
    };
    const live = s.rec && s.pos >= 0 && s.sl > 0 && (ext || v.run);
    if (s.thru.length) {
      // the armed track's keys in: each into keys out (transposed as the track's notes) and the mono outputs; recording
      // live, a note lands on the nearest step and lasts the whole steps it was held (at least one)
      const semis = Math.floor((q16(transpose[0]) * 12 + 32768) / 65536);
      for (let e = 0; e < s.thru.length; e += 2) {
        const note = s.thru[e] & 0x7f;
        const at = s.snd.findIndex((x) => x.thru === note);
        if (at >= 0) end(at);
        const r = s.rin.findIndex((x) => x.note === note);
        if (r >= 0) {
          const x = s.rin.splice(r, 1)[0];
          s.took.push({ note: { at: x.at, len: Math.min(STEPS_MAX, Math.max(1, Math.round(x.t / s.sl))), note, vel: x.vel }, loop: x.loop });
        }
        if (!(s.thru[e] & 0x80)) continue;
        if (live) {
          const next = s.ago * 2 >= s.sl;
          const target = next ? nextStep(s, len, dir) : s;
          s.rin.push({ note, at: target.pos, t: next ? s.ago - s.sl : s.ago, vel: s.thru[e + 1], loop: target.loop });
        }
        const was = s.snd.some((x) => x.cnt > 0);
        const key = Math.max(0, Math.min(127, note + semis));
        const same = s.snd.findIndex((x) => x.key === key);
        if (same >= 0) end(same);
        if (s.snd.length >= TRACK_POLY) end(0);
        s.snd.push({ key, left: 0, cnt: 1, thru: note });
        s.ev.push(key | 0x80, s.thru[e + 1]);
        s.pitch = stepPitch(note);
        s.vel = s.thru[e + 1] / 127;
        s.gap = was;
      }
      s.thru.length = 0;
    }
    for (let i = 0; i < c.n; i++) {
      let adv = 0;
      if (reset[i] >= 0.5 && s.r1 < 0.5) s.pos = -1;
      s.r1 = reset[i];
      if (ext) {
        if (s.since >= 0 && s.since < 8388608) s.since++;
        if (clk[i] >= 0.5 && s.c1 < 0.5) {
          if (s.since > 0) s.period = s.since;
          s.since = 0;
          adv++;
        }
        s.c1 = clk[i];
      } else {
        if (i === 0 && v.run && !s.run) {
          s.count = 0;
          s.half = 0;
          s.pos = -1;
          s.songPos = -1; // (a song starts again from its first entry)
          adv++;
        }
        if (s.half > 0 && v.run && --s.half === 0) adv++;
        if (v.run && i === v.tick) {
          if (s.half > 0) { // (the clock came early: the step half a tick on is now)
            s.half = 0;
            adv++;
          }
          for (let t = 0; t < v.ticks; t++)
            if ((s.count += 2) >= ht) {
              s.count = 0;
              adv++;
            }
          if (ht & 1 && s.count + 1 === ht) { // the next step falls half a tick from now (1/64)
            s.half = Math.max(1, v.tickLen >> 1);
            s.count = -1;
          }
        }
      }
      if (s.pend > 0 && --s.pend === 0 && (dir === 0 || s.pstep < len)) fire(s.pstep, i);
      s.ago++;
      for (; adv > 0; adv--) {
        let next = nextStep(s, len, dir);
        if (next.visit === 0) { // the end of a pass: a song's next entry, a queued pattern
          stepsTurn(s);
          shape();
          next = nextStep(s, len, dir);
        }
        // In the new play modes a live length edit can end the pass before an old note's countdown does: such a note ends
        // after this sample, so a note starting now still gets its low trig sample. A note whose countdown ran out keeps
        // its gate tail. Forward keeps its older behaviour (D-538).
        if (next.visit === 0 && dir !== 0)
          for (const x of s.snd)
            if (x.thru === undefined && x.left > 0 && x.cnt > 0) { x.left = 0; x.cnt = 1; }
        s.pos = next.pos; s.visit = next.visit; s.loop = next.loop;
        const sl = ext ? s.period : step;
        s.ago = 0;
        s.sl = sl;
        const d = s.visit & 1 && swing > 0 && sl > 0 ? Math.floor((swing * sl) / (50 * 65536)) : 0;
        if (d > 0) {
          s.pend = d;
          s.pstep = s.pos;
        } else fire(s.pos, i);
      }
      const up = !s.gap && s.snd.some((x) => x.cnt > 0) ? 1 : 0;
      c.out.trig[i] = up;
      c.out.keys[i] = up;
      c.out.pitch[i] = s.pitch + transpose[i];
      c.out.vel[i] = s.vel;
      if (s.gap) s.gap = false;
      else
        for (let j = s.snd.length - 1; j >= 0; j--)
          if (s.snd[j].cnt > 0 && s.snd[j].thru === undefined && --s.snd[j].cnt === 0) end(j);
    }
    for (const x of s.rin) x.t += c.n;
    s.run = v.run;
  },
};

/** a Drum map's rows (#137) and their defaults: General MIDI drum notes (36 kick, 38 snare, 39 clap, 42 closed hat, 46 open
 * hat, 45 low tom, 37 rim, 56 cowbell; NOTE_NAMES calls 36 C2) and the names the roll shows */
export { DRUM_ROWS };
export const DRUM_MAP_DEFAULT: readonly { name: string; note: number }[] = [
  { name: 'KICK', note: 36 }, { name: 'SNARE', note: 38 }, { name: 'CLAP', note: 39 }, { name: 'CL HAT', note: 42 },
  { name: 'OP HAT', note: 46 }, { name: 'LOW TOM', note: 45 }, { name: 'RIM', note: 37 }, { name: 'COWBELL', note: 56 },
];

/** a Drum map's row r (0..7) as the editor names it: its own name, else the default */
export const drumRowName = (names: readonly string[] | undefined, r: number): string => names?.[r] || DRUM_MAP_DEFAULT[r]?.name || `ROW ${r + 1}`;

/** a Drum map as it runs: each row's gate (0 / 1) and velocity (0..1), the rows whose gate restarts this block (a low first
 * sample), and the notes the engine delivered (key | 0x80, velocity 1..127 / key, 0), taken at the start of the block */
export interface DrumMapState { gate: number[]; vel: number[]; gap: number; ev: number[]; held: number[] }

/** a Drum map lets go of every row at once (all notes off, its keys' source switched): the keys it held too */
export function dropRows(s: DrumMapState): void {
  s.gate.fill(0);
  s.held.fill(0);
}

/** a white key's place among the white keys of its octave, a black key's the white key's below it (#184) */
const WHITE_AT = [0, 0, 1, 1, 2, 3, 3, 4, 4, 5, 5, 6];
/** the white keys of an octave, bit n = semitone n (C D E F G A B) */
const WHITE_KEYS = 0xab5;
/**
 * The rows a key plays on a Drum map with `repeat` on (#184; engine.c dm_rows the same), bit r = row r: the rows' keys,
 * lowest to highest, are a block that repeats up and down the keybed, so every key plays a row. When every row is on a
 * white key the block is counted in white keys and a black key plays the row of the white key below it (rows on F3..F4
 * repeat every eight white keys: the next block starts on G4); otherwise it is counted in semitones, and keys that fall on
 * no row in the block stay silent.
 */
export function drumRowsOf(notes: readonly number[], key: number): number {
  const white = notes.every((n) => (WHITE_KEYS >> n % 12) & 1);
  const place = (k: number): number => (white ? Math.floor(k / 12) * 7 + WHITE_AT[k % 12] : k);
  const at = notes.map(place), lo = Math.min(...at), period = Math.max(...at) - lo + 1;
  const x = (((place(key) - lo) % period) + period) % period;
  let rows = 0;
  at.forEach((a, r) => { if (a - lo === x) rows |= 1 << r; });
  return rows;
}

/**
 * Drum map (#137): keys in, eight rows out. A row's note (n1..n8, General MIDI drums by default) held in the keys raises
 * its gate (g1..g8) while it is down and sets its velocity output (v1..v8, velocity / 127, kept after); a row hit again
 * while its gate is up (or let go and hit again in one block) gets one low sample first, so the drum restarts. The keys come as an allocator's do (Main's, or a
 * Steps track's keys out: the engines deliver the notes at the start of the next block; poly.ts keysInto); its record's
 * data byte says from where (0 none, 1 Main's keys, 2 + the module index of the Steps module). Row names (ModuleInst.names)
 * are the editor's (the roll's rows); it runs once. With `repeat` on (#184) the rows' keys repeat over the keybed
 * (drumRowsOf), so every key plays a row; a row that another key still holds up neither restarts nor takes the new
 * velocity, and its gate falls when the last of its keys is let go.
 */
const drummap: ModuleImpl<DrumMapState> = {
  def: {
    type: 'drummap',
    label: 'Drum map',
    inputs: [keys('keys')],
    outputs: Array.from({ length: DRUM_ROWS }, (_, r) => [gate(`g${r + 1}`), control(`v${r + 1}`)]).flat(),
    params: [
      ...DRUM_MAP_DEFAULT.map((d, r) => param(`n${r + 1}`, 0, 127, d.note, { step: 1, choices: NOTE_NAMES })),
      // the rows repeat over the keybed, so every key plays one (#184; off: only the rows' own keys)
      param('repeat', 0, 1, 0, { step: 1, choices: ['off', 'on'], toggle: true, since: 35 }),
    ],
    data: 1,
  },
  init: () => ({ gate: Array(DRUM_ROWS).fill(0), vel: Array(DRUM_ROWS).fill(0), gap: 0, ev: [], held: Array(128).fill(0) }),
  process(c, s) {
    let fell = 0; // (a row let go and hit again in one block restarts too)
    const notes = DRUM_MAP_DEFAULT.map((d, r) => Math.max(0, Math.min(127, Math.round(c.p[`n${r + 1}`] ?? d.note))));
    const repeat = Math.round(c.p.repeat ?? 0) >= 1;
    for (let e = 0; e < s.ev.length; e += 2) {
      const key = s.ev[e] & 0x7f, on = s.ev[e] & 0x80;
      const rows = repeat ? drumRowsOf(notes, key) : 0;
      // (repeat: the rows another key still holds up, which this key neither restarts nor lets fall)
      let other = 0;
      if (repeat) {
        s.held[key] = on ? 1 : 0;
        for (let k = 0; k < 128; k++) if (s.held[k] && k !== key) other |= drumRowsOf(notes, k);
      }
      for (let r = 0; r < DRUM_ROWS; r++) {
        if (repeat ? !((rows >> r) & 1) : Math.round(c.p[`n${r + 1}`] ?? DRUM_MAP_DEFAULT[r].note) !== key) continue;
        if ((other >> r) & 1) continue;
        if (!on) {
          if (s.gate[r]) fell |= 1 << r;
          s.gate[r] = 0;
        } else {
          if (s.gate[r] || (fell >> r) & 1) s.gap |= 1 << r;
          s.gate[r] = 1;
          s.vel[r] = s.ev[e + 1] / 127;
        }
      }
    }
    s.ev.length = 0;
    for (let r = 0; r < DRUM_ROWS; r++) {
      const g = c.out[`g${r + 1}`], v = c.out[`v${r + 1}`];
      g.fill(s.gate[r], 0, c.n);
      if ((s.gap >> r) & 1) g[0] = 0;
      v.fill(s.vel[r], 0, c.n);
    }
    s.gap = 0;
  },
};

/** the phase distortion oscillator's waveforms, after the Casio CZ: five bends of a sine's phase, then the three resonance
 * windows (falling ramp, triangle, trapezoid) */
export const PD_WAVES = ['saw', 'square', 'pulse', 'dbl sine', 'saw-pulse', 'reso 1', 'reso 2', 'reso 3'];
/** the first resonance waveform in PD_WAVES */
export const PD_RESO = 5;
/** the five bends at full DCW, as the bent phase minus the ramp u (cycles): from u = x on, b + slope (u - x). The bend is
 * continuous (so is the wave); slope -1 holds the sine where it is. Saw: half the sine in 7/8 of the cycle, the rest in 1/8;
 * square: the sine held at its peak and trough; pulse: the whole sine in the first 1/8, then held; double sine: each half
 * of the cycle bent as the saw; saw-pulse: the saw's bend in the first half, then held. (engine.c PD_X, PD_B, PD_K) */
export const PD_SEGS: [number, number, number][][] = [
  [[0, 0, -3 / 7], [0.875, -0.375, 3]],
  [[0, 0, 1], [0.125, 0.125, -1], [0.375, -0.125, 1], [0.625, 0.125, -1], [0.875, -0.125, 1]],
  [[0, 0, 7], [0.125, 0.875, -1]],
  [[0, 0, -3 / 7], [0.4375, -0.1875, 3], [0.5, 0, -3 / 7], [0.9375, -0.1875, 3]],
  [[0, 0, 1 / 7], [0.4375, 0.0625, 7], [0.5, 0.5, -1]],
];
/** each bend's steepest slope: at full DCW the bent phase runs up to 1 + this many times as fast as the note */
export const PD_STEEP = [3, 1, 7, 3, 7];
/** the band limit: the fastest part of the bent wave (and the resonance sine) stays below this fraction of the sample rate */
export const PD_FMAX = 0.25;
/** the resonance range's top, octaves */
export const PD_RANGE_MAX = 5;

interface PdState {
  phase: number;
  /** the resonance sine's phase, restarted every cycle */
  r: number;
  /** the cycle is an odd one (the second waveform's) */
  odd: number;
  s1: number;
}

/**
 * Phase distortion oscillator, after the Casio CZ. It reads a sine with its phase bent: `dcw` (the parameter plus the
 * input, 0..1) scales the bend, 0 is a sine and 1 the full shape (PD_SEGS). The resonance waveforms are a sine restarted
 * every cycle, raised by dcw x `range` octaves, faded by a window (reso 1 a falling ramp, 2 a triangle, 3 a trapezoid).
 * `wave2` plays a second waveform on every other cycle, as the CZ's line does (so the pattern repeats every two cycles:
 * an octave down when the two differ). The band limit: dcw is held back as the note rises so the bent sine never runs
 * faster than PD_FMAX of the sample rate, and the resonance stops rising there; worked out once a block from the block's
 * first pitch. pm: phase modulation in radians (x `pm`), as the oscillator's plain path (no oversampling). sync: a rising
 * edge restarts the cycle (and the first waveform).
 */
const pd: ModuleImpl<PdState> = {
  def: {
    type: 'pd',
    label: 'PD Osc',
    inputs: [control('pitch'), control('dcw'), audio('pm'), gate('sync')],
    outputs: [audio('out')],
    params: [
      param('wave', 0, PD_WAVES.length - 1, 0, { step: 1, choices: PD_WAVES }),
      param('wave2', 0, PD_WAVES.length, 0, { step: 1, choices: ['off', ...PD_WAVES] }),
      param('dcw', 0, 1, 0.5, { step: 0.01, input: 'dcw', rest: (p, cv) => (p.dcw ?? 0.5) + cv }),
      param('range', 0, PD_RANGE_MAX, 3, { step: 0.01, unit: 'oct' }),
      param('coarse', -48, 48, 0, { step: 1, unit: 'st' }),
      param('fine', -100, 100, 0, { step: 1, unit: 'ct' }),
      param('pm', 0, 8, 0, { step: 0.01 }),
      param('level', 0, 1, 0.8, { step: 0.01 }),
    ],
  },
  init: () => ({ phase: 0, r: 0, odd: 0, s1: 0 }),
  process(c, s) {
    const { pitch, dcw, pm, sync } = c.inp;
    const out = c.out.out;
    const base = (c.p.coarse ?? 0) / 12 + (c.p.fine ?? 0) / 1200;
    const w1 = Math.min(PD_WAVES.length - 1, Math.max(0, Math.round(c.p.wave ?? 0)));
    const w2p = Math.min(PD_WAVES.length, Math.max(0, Math.round(c.p.wave2 ?? 0)));
    const alt = w2p > 0 ? 1 : 0;
    const w2 = alt ? w2p - 1 : w1;
    const d0 = c.p.dcw ?? 0.5;
    const range = Math.min(PD_RANGE_MAX, Math.max(0, c.p.range ?? 3));
    const idx = c.connected.pm ? (c.p.pm ?? 0) : 0;
    const lvl = c.p.level ?? 1;
    const K = 1 / (2 * Math.PI);
    // the band limit from the block's first pitch: room = how many times the note fits below PD_FMAX; a bend's dcw at most
    // (room - 1) / steepness, a resonance's rise at most log2(room) octaves
    const room = PD_FMAX / Math.min((C4 * Math.pow(2, pitch[0] + base)) / c.sr, 0.45);
    const cap = (w: number): number => (w < PD_RESO ? Math.min(1, Math.max(0, (room - 1) / PD_STEEP[w])) : 0);
    const cap1 = cap(w1), cap2 = cap(w2);
    // the resonance's ratio 2^(dcw x range): worked out at the block's first and last sample, a straight line between
    const lim = Math.max(0, Math.log2(room));
    const ratioAt = (i: number): number => Math.pow(2, Math.min(Math.min(1, Math.max(0, d0 + dcw[i])) * range, lim));
    const m0 = ratioAt(0), dm = c.n ? (ratioAt(c.n - 1) - m0) / c.n : 0;
    for (let i = 0; i < c.n; i++) {
      const dt = Math.min((C4 * Math.pow(2, pitch[i] + base)) / c.sr, 0.45);
      // a new cycle (or a sync) restarts the resonance sine at the phase the ramp has reached, times its ratio
      let fresh = false;
      if (sync[i] >= 0.5 && s.s1 < 0.5) {
        s.phase = s.odd = 0;
        fresh = true;
      }
      s.s1 = sync[i];
      s.phase += dt;
      if (s.phase >= 1) {
        s.phase -= 1;
        s.odd ^= 1;
        fresh = true;
      }
      const second = s.odd & alt;
      const w = second ? w2 : w1;
      const d = Math.min(1, Math.max(0, d0 + dcw[i]));
      const pmo = idx ? idx * pm[i] * K : 0;
      const u = s.phase;
      let y: number;
      if (w < PD_RESO) {
        const seg = PD_SEGS[w];
        let j = seg.length - 1;
        while (u < seg[j][0]) j--;
        const [x, b, k] = seg[j];
        y = Math.sin(2 * Math.PI * (u + Math.min(d, second ? cap2 : cap1) * (b + k * (u - x)) + pmo));
      } else {
        const ratio = m0 + dm * i;
        s.r = fresh ? u * ratio : s.r + Math.min(dt * ratio, 0.45);
        s.r -= Math.floor(s.r);
        const win = w === PD_RESO ? 1 - u : w === PD_RESO + 1 ? 1 - Math.abs(2 * u - 1) : Math.min(4 * u, 2 - 2 * u, 1);
        y = win * Math.sin(2 * Math.PI * (s.r + pmo));
      }
      out[i] = y * lvl;
    }
  },
};

/** the Selector's positions: inputs in1..in8, gates g1..g8, values v1..v8 */
export const SELECT_N = 8;
/** the position a Selector plays (1..count): `pos` plus the `pos` input, which spans the positions in use (0..1 = 1..count),
 * rounded to the nearest (the firmware: round_q16) */
export const selectPos = (pos: number, count: number, cv: number): number => {
  const n = Math.min(SELECT_N, Math.max(2, Math.round(count)));
  return Math.min(n, Math.max(1, Math.floor(pos + cv * (n - 1) + 0.5)));
};
/** the positions a Selector uses (2..SELECT_N, its `count`) */
export const selectCount = (params: Record<string, number>): number => Math.min(SELECT_N, Math.max(2, Math.round(params.count ?? SELECT_N)));
/**
 * The range a row of this module's parameter offers (#358): a Selector's position spans the positions in use, 1..count,
 * so the card, the knobs and a typed value never pick one that plays nothing (the FM-1: pages_ui.c row_top). Any other
 * parameter: its own definition.
 */
export function rowRange(type: string, params: Record<string, number>, pd: ParamDef): ParamDef {
  if (type !== 'select' || pd.name !== 'pos') return pd;
  return { ...pd, max: selectCount(params), top: undefined, browserMax: undefined };
}
/** what a Selector's crossfade moves its weights by each sample (Q16, as the firmware: an integer increment, so both engines
 * fade alike); 65536 or more: it switches at once */
export const selectFadeInc = (fade: number, sr: number): number => {
  const samples = Math.floor((Math.round(fade * 65536) * Math.floor((sr * 65536) / 1000)) / 2 ** 32);
  return samples > 0 ? Math.floor(65536 / samples) : 65536;
};
/** a Selector as it runs: each input's weight (Q16 integers; one of them 65536 when settled), the position chosen (0-based,
 * -1 before the first block) and whether a crossfade is under way */
export interface SelectState { w: number[]; k: number; fading: boolean }
/** the Selector's port and parameter names by position (built once: no string is made per block) */
const SEL_IN = Array.from({ length: SELECT_N }, (_, j) => `in${j + 1}`);
const SEL_V = Array.from({ length: SELECT_N }, (_, j) => `v${j + 1}`);
const SEL_G = Array.from({ length: SELECT_N }, (_, j) => `g${j + 1}`);

/**
 * Selector (#351): a stepped switch. `pos` (1..8, with the `pos` input: 0..1 spans 1..count) chooses one of the inputs
 * in1..in8; `out` is that input plus its value (v1..v8: with nothing patched in, the Selector is a table of values), and
 * the gate of that position (g1..g8) is high, the others low, so one choice can switch several things at once. The
 * position is read once per block (the `pos` input's first sample). `fade` (ms) crossfades from the inputs playing to the
 * chosen one when the position changes, against clicks; 0 switches at once.
 */
const select: ModuleImpl<SelectState> = {
  def: {
    type: 'select',
    label: 'Selector',
    inputs: [control('pos'), ...Array.from({ length: SELECT_N }, (_, k) => audio(`in${k + 1}`))],
    thru: 'in1',
    outputs: [audio('out'), ...Array.from({ length: SELECT_N }, (_, k) => gate(`g${k + 1}`))],
    params: [
      param('pos', 1, SELECT_N, 1, { step: 1, input: 'pos', rest: (p, cv) => selectPos(p.pos ?? 1, p.count ?? SELECT_N, cv) }),
      param('count', 2, SELECT_N, SELECT_N, { step: 1 }),
      param('fade', 0, 100, 0, { step: 0.1, unit: 'ms' }),
      ...Array.from({ length: SELECT_N }, (_, k) => param(`v${k + 1}`, -4, 4, 0, { step: 0.001 })),
    ],
  },
  init: () => ({ w: Array(SELECT_N).fill(0), k: -1, fading: false }),
  process(c, s) {
    const k = selectPos(c.p.pos ?? 1, c.p.count ?? SELECT_N, c.inp.pos[0]) - 1;
    const inc = selectFadeInc(c.p.fade ?? 0, c.sr);
    if (s.k < 0 || (k !== s.k && inc >= 65536)) {
      s.w.fill(0);
      s.w[k] = 65536;
      s.fading = false;
    } else if (k !== s.k) s.fading = true;
    s.k = k;
    const out = c.out.out;
    if (!s.fading) {
      const x = c.inp[SEL_IN[k]], v = c.p[SEL_V[k]] ?? 0;
      for (let i = 0; i < c.n; i++) out[i] = x[i] + v;
    } else {
      const xs = SEL_IN.map((name) => c.inp[name]);
      const vs = SEL_V.map((name) => c.p[name] ?? 0);
      for (let i = 0; i < c.n; i++) {
        let y = 0;
        for (let j = 0; j < SELECT_N; j++) {
          const t = j === k ? 65536 : 0, w = s.w[j];
          if (w === t && w === 0) continue;
          s.w[j] = w < t ? Math.min(t, w + inc) : Math.max(t, w - inc);
          y += (xs[j][i] + vs[j]) * (s.w[j] / 65536);
        }
        out[i] = y;
      }
      s.fading = s.w.some((w, j) => w !== (j === k ? 65536 : 0));
    }
    for (let j = 0; j < SELECT_N; j++) if (!c.used || c.used[SEL_G[j]]) c.out[SEL_G[j]].fill(j === k ? 1 : 0, 0, c.n);
    if (c.display) c.display.pos = k + 1;
  },
};

export const SCOPE_MODES = ['time', 'spectrum'];
/** the shortest / longest window of a Scope (ms) */
export const SCOPE_TIME_MIN = 1;
export const SCOPE_TIME_MAX = 2000;
/**
 * Scope: an editor-only display. It draws what is cabled into `a` and `b` (as a probe sees it: a per-voice audio signal
 * summed over the voices, a control signal from the newest held voice); `view` is its screen, which goes on an assembly
 * card like a parameter; `voices` draws each voice of such a signal as its own thin trace instead. It has no outputs; the engines and the FM-1 never see it (poly.ts deviceView drops it, it has
 * no type index: patchbin.ts TYPE_ORDER).
 */
const scope: ModuleImpl<null> = {
  def: {
    type: 'scope',
    label: 'Scope',
    inputs: [audio('a'), audio('b')],
    outputs: [],
    views: [param('view', 0, 0, 0, { screen: true })],
    params: [
      param('time', SCOPE_TIME_MIN, SCOPE_TIME_MAX, 16, { unit: 'ms', log: true, onScreen: true }),
      param('mode', 0, 1, 0, { step: 1, choices: SCOPE_MODES, onScreen: true }),
      // each voice of a per-voice source as its own trace (#54), set from the toolbar's Voices button
      param('voices', 0, 1, 0, { step: 1, choices: ['sum', 'each'], toggle: true, onScreen: true }),
    ],
  },
  init: () => null,
  process: () => {},
};

/**
 * The eight-step envelope (the Casio CZ's DCO / DCW / DCA envelopes): step k runs to level lk in time rk, by the Env L/R's
 * segment rules (rising linear, falling 99 % in rk then stepped, a finished step goes on to the next in the same sample).
 * A gate starts step 1. `end` is the last step: after it the envelope rests at its level (normally 0). `sus` is the step
 * whose level holds while the gate stays up; the gate's fall jumps to the step after it, which runs to the end (sus = end:
 * the gate's fall ends it where it is). Sus off, or past the end: the gate only starts it, every step runs through (the
 * CZ without a sustain point; Env L/R's one-shot). Stage: 0 resting at the end's level, 1..8 the steps, 9 (ENV8_HOLD) holding.
 * With 18 parameters its masks in the binary are u32 (patchbin.ts maskBytes), so pins can move sus and end too.
 */
export const ENV8_STEPS = 8;
/** the envelopes: a poly part goes idle only once all of its envelopes have finished (stage 0; engine.ts partQuiet) */
export const ENVELOPE_TYPES = new Set(['adsr', 'env', 'env8', 'rateenv']);
export const ENV8_HOLD = 9;
/** the step the sustain holds (0 none): sus, when it is not past the end */
export const env8Sus = (sus: number, end: number): number => (sus >= 1 && sus <= end ? sus : 0);
/** the last step, 1..8 */
export const env8End = (end: number): number => Math.max(1, Math.min(ENV8_STEPS, Math.round(end)));

interface Env8State {
  stage: number;
  v: number;
  prev: number;
  /** samples spent in the current step */
  t: number;
}

const env8: ModuleImpl<Env8State> = {
  def: {
    type: 'env8',
    label: 'Env 8',
    inputs: [gate('gate')],
    outputs: [control('env')],
    params: [
      ...Array.from({ length: ENV8_STEPS }, (_, i) => {
        // the defaults: an ADSR (1 at once, 0.6 in 0.3 s held, 0 in 0.5 s), the steps after it at 0
        const [l, r] = [[1, 0.01], [0.6, 0.3], [0, 0.5]][i] ?? [0, 0.2];
        return [param(`l${i + 1}`, 0, 1, l, { step: 0.01 }), param(`r${i + 1}`, 0.001, 10, r, { unit: 's', step: 0.001, log: true })];
      }).flat(),
      param('sus', 0, ENV8_STEPS, 2, { step: 1, choices: ['off', ...Array.from({ length: ENV8_STEPS }, (_, i) => String(i + 1))] }),
      param('end', 1, ENV8_STEPS, 3, { step: 1 }),
    ],
    views: [param('view', 0, 0, 0, { screen: true })],
  },
  init: () => ({ stage: 0, v: 0, prev: 0, t: 0 }),
  process(c, s) {
    const lv = [0];
    const len = [1];
    for (let k = 1; k <= ENV8_STEPS; k++) {
      lv.push(c.p[`l${k}`] ?? 0);
      len.push(Math.max(Math.round((c.p[`r${k}`] ?? 0.2) * c.sr), 1));
    }
    const inc = len.map((l) => 1 / l);
    const kk = len.map((l) => 1 - Math.exp(-4.6 / l));
    const end = env8End(c.p.end ?? 3);
    const hs = env8Sus(Math.round(c.p.sus ?? 2), end);
    for (let i = 0; i < c.n; i++) {
      const g = c.inp.gate[i] > 0.5 ? 1 : 0;
      if (g && !s.prev) {
        s.stage = 1;
        s.t = 0;
      } else if (!g && s.prev && hs && (s.stage === ENV8_HOLD || (s.stage >= 1 && s.stage <= hs))) {
        s.stage = hs < end ? hs + 1 : 0;
        s.t = 0;
      }
      s.prev = g;
      for (let guard = 0; guard < 10; guard++) {
        const st = s.stage;
        if (st === 0) {
          s.v = lv[end];
          break;
        }
        if (st === ENV8_HOLD) {
          if (hs) {
            s.v = lv[hs];
            break;
          }
          s.stage = 0; // the sustain was switched off while holding: rest
          continue;
        }
        if (st > end) {
          s.stage = 0; // the end was moved before this step
          continue;
        }
        const t = lv[st];
        s.t++;
        if (s.v < t) {
          s.v += inc[st];
          if (s.v < t) break;
        } else if (s.t < len[st]) {
          s.v += (t - s.v) * kk[st];
          break;
        }
        s.v = t;
        s.stage = st === hs && g ? ENV8_HOLD : st === end ? 0 : st + 1;
        s.t = 0;
      }
      c.out.env[i] = s.v;
    }
  },
};

const rateenv: ModuleImpl<ReturnType<typeof rateEnvelopeInit>> = {
  def: {
    type: 'rateenv', label: 'Rate Env',
    inputs: [gate('gate'), control('pitch'), gate('hold')], outputs: [control('env')],
    params: [
      param('ar', 0, 31, 31, { step: 1 }),
      param('d1r', 0, 31, 12, { step: 1 }),
      param('d1l', 0, 15, 10, { step: 1 }),
      param('d2r', 0, 31, 0, { step: 1 }),
      param('rr', 0, 15, 8, { step: 1 }),
      param('krs', 0, 3, 0, { step: 1 }),
    ],
  },
  init: rateEnvelopeInit,
  process: rateEnvelopeProcess,
};

/** DX100 owner manual p.34: the displayed ratio table, used as rounded multipliers rather than a chip model.
 * Output is a pitch offset in octaves, added by a cable to any oscillator pitch input. */
export const RATIOS = [
  0.50, 0.71, 0.78, 0.87, 1.00, 1.41, 1.57, 1.73,
  2.00, 2.82, 3.00, 3.14, 3.46, 4.00, 4.24, 4.71,
  5.00, 5.19, 5.65, 6.00, 6.28, 6.92, 7.00, 7.07,
  7.85, 8.00, 8.48, 8.65, 9.00, 9.42, 9.89, 10.00,
  10.38, 10.99, 11.00, 11.30, 12.00, 12.11, 12.56, 12.72,
  13.00, 13.84, 14.00, 14.10, 14.13, 15.00, 15.55, 15.57,
  15.70, 16.96, 17.27, 17.30, 18.37, 18.84, 19.03, 19.78,
  20.41, 20.76, 21.20, 21.98, 22.49, 23.55, 24.22, 25.95,
];
/** Quantized octave offsets shared by both engines. */
export const RATIO_OCT = RATIOS.map(r => Math.round(Math.log2(r) * 65536) / 65536);
export const ratioIndex = (value = 4): number => Math.max(0, Math.min(RATIOS.length - 1, Math.round(value)));

/** Seven detune positions, linearly spaced over the manual's ±2.6 cents. */
export const RATIO_DETUNE_OCT = Array.from({ length: 7 }, (_, i) => Math.round((i - 3) * 2.6 / 3 / 1200 * 65536) / 65536);
const ratio: ModuleImpl<null> = {
  def: {
    type: 'ratio', label: 'Ratio', inputs: [], outputs: [control('pitch')],
    params: [
      param('ratio', 0, 63, 4, { step: 1, choices: RATIOS.map(r => r.toFixed(2)) }),
      param('detune', 0, 6, 3, { step: 1, choices: ['-3', '-2', '-1', '0', '+1', '+2', '+3'] }),
    ],
  },
  init: () => null,
  process(c) {
    const detune = Math.max(0, Math.min(6, Math.round(c.p.detune ?? 3)));
    c.out.pitch.fill(RATIO_OCT[ratioIndex(c.p.ratio)] + RATIO_DETUNE_OCT[detune], 0, c.n);
  },
};

/** The Follower's fixed envelope times (99 % of a step, the ADSR's rate formula), its pitch detector's limits and smoothing. */
export const ESP_ATTACK = 0.003;
export const ESP_RELEASE = 0.08;
/** the band-passed signal's peak must reach this (about -48 dB) before a crossing counts: silence gives no pitch */
export const ESP_FLOOR = 1 / 256;
/** the longest period measured, in samples (about 10.8 Hz at 44118 Hz); a longer gap starts the measurement again */
export const ESP_MAX_PERIOD = 4096;
/** the shortest period accepted, in samples */
export const ESP_MIN_PERIOD = 2;
/** amp is held to +-ESP_CLIP (room for the C engine's Q24 band-pass states) */
export const ESP_CLIP = 16;
/** the peak hold falls by 1 / 2^9 of itself per sample (about 12 ms); the pitch output glides 1 / 2^6 of the way per sample */
export const ESP_PEAK_SHIFT = 9;
export const ESP_GLIDE_SHIFT = 6;
const C4_HZ = 261.6255653;

interface EspState {
  /** envelope follower (of amp), the low cut's one-pole, the high cut's one-pole, the band-passed peak hold */
  env: number; lc: number; hc: number; pk: number;
  /** the trigger, the detector armed (the band-passed signal went below -hysteresis), a previous crossing to measure from */
  trig: boolean; arm: boolean; valid: boolean;
  /** samples since the last crossing, its fraction of a sample back, the previous band-passed sample */
  cnt: number; frac: number; prev: number;
  /** the measured pitch (octaves from C4), the glided output */
  t: number; y: number;
}
const espRest = (): Omit<EspState, 't' | 'y'> => ({ env: 0, lc: 0, hc: 0, pk: 0, trig: false, arm: false, valid: false, cnt: 0, frac: 0, prev: 0 });

/**
 * Follower, after the Korg MS-20's External Signal Processor (its owner's manual, 1978: "External Signal Processor (ESP)",
 * "Using the External Signal Processor"). `in` x `level` is `amp` (the preamp out). An envelope follower on |amp| (attack
 * ESP_ATTACK, release ESP_RELEASE) gives `env`; `trig` rises when env passes `thresh` and falls below 3/4 of it. A band pass,
 * a one-pole high pass at `lowcut` then a one-pole low pass at `highcut` (6 dB per octave each side), gives `bp`. The pitch
 * to voltage converter measures bp's period between rising crossings of +h after it went below -h (h = a quarter of bp's
 * peak hold), each crossing placed between its two samples by linear interpolation, and outputs log2(f / C4) in octaves, as
 * every pitch signal here, plus `cvadj` semitones, through a short glide. It holds the last pitch while bp's peak is below
 * ESP_FLOOR or the period is out of range. With nothing patched to `in` it rests (outputs 0, the pitch held). Both engines do
 * the same (engine.c m_esp).
 */
const esp: ModuleImpl<EspState> = {
  def: {
    type: 'esp',
    label: 'Follower',
    inputs: [audio('in')],
    outputs: [audio('amp'), audio('bp'), control('pitch'), control('env'), gate('trig')],
    params: [
      param('level', 0, 4, 1, { step: 0.01 }),
      param('lowcut', 20, 5000, 40, { unit: 'Hz', step: 1, log: true }),
      param('highcut', 50, 10000, 2000, { unit: 'Hz', step: 1, log: true }),
      param('cvadj', -12, 12, 0, { unit: 'st', step: 0.01 }),
      param('thresh', 0, 1, 0.1, { step: 0.01 }),
    ],
  },
  init: () => ({ ...espRest(), t: 0, y: 0 }),
  process(c, s) {
    const o = c.out, n = c.n;
    const adj = (c.p.cvadj ?? 0) / 12;
    if (!c.connected.in) {
      Object.assign(s, espRest());
      o.amp.fill(0, 0, n); o.bp.fill(0, 0, n); o.env.fill(0, 0, n); o.trig.fill(0, 0, n);
      o.pitch.fill(s.y + adj, 0, n);
      return;
    }
    const level = c.p.level ?? 1, th = c.p.thresh ?? 0.1, off = th * 0.75;
    const ka = 1 - Math.exp(-4.6 / Math.max(ESP_ATTACK * c.sr, 1)), kr = 1 - Math.exp(-4.6 / Math.max(ESP_RELEASE * c.sr, 1));
    const kl = 1 - Math.exp((-2 * Math.PI * (c.p.lowcut ?? 40)) / c.sr), kh = 1 - Math.exp((-2 * Math.PI * (c.p.highcut ?? 2000)) / c.sr);
    const base = Math.log2(c.sr / C4_HZ);
    for (let i = 0; i < n; i++) {
      const x = Math.max(-ESP_CLIP, Math.min(ESP_CLIP, c.inp.in[i] * level));
      o.amp[i] = x;
      const a = Math.abs(x);
      s.env += (a > s.env ? ka : kr) * (a - s.env);
      if (s.trig ? s.env < off : s.env > th) s.trig = !s.trig;
      s.lc += kl * (x - s.lc);
      s.hc += kh * (x - s.lc - s.hc);
      const b = s.hc, ab = Math.abs(b);
      s.pk = ab > s.pk ? ab : s.pk - s.pk / (1 << ESP_PEAK_SHIFT);
      const h = s.pk / 4;
      if (++s.cnt > ESP_MAX_PERIOD) (s.cnt = ESP_MAX_PERIOD), (s.valid = false);
      if (s.pk >= ESP_FLOOR) {
        if (b < -h) s.arm = true;
        else if (s.arm && b >= h) {
          const f = b > s.prev ? Math.min(1, (b - h) / (b - s.prev)) : 0;
          const per = s.cnt - f + s.frac;
          if (s.valid && per >= ESP_MIN_PERIOD) s.t = base - Math.log2(per);
          s.arm = false, s.valid = true, s.cnt = 0, s.frac = f;
        }
      }
      s.prev = b;
      s.y += (s.t - s.y) / (1 << ESP_GLIDE_SHIFT);
      o.bp[i] = b;
      o.pitch[i] = s.y + adj;
      o.env[i] = s.env;
      o.trig[i] = s.trig ? 1 : 0;
    }
  },
};

const ALL = [fm1, osc, lfo, noise, constant, scale, adsr, vca, filter, mixer, delay, reverb, output, glide, shape, env, string, wavetable, chorus, seq, clkdiv, sh, quant, pulse, pan, xfade, vowel, phaser, crush, ladder, dyn, math, logic, grain, comb, modal, shift, part, random, alloc, scope, arp, steps, macro, drummap, pd, env8, select, rateenv, ratio, esp];

/**
 * Every module except the FM-1 panel (the input) and the output has two parameter inputs, p1 and p2, each with an
 * attenuverter (-1..1), and a matrix that says which parameters p1, p2 and the knobs k1..k4 control. A parameter's
 * effective value is its base + (block mean of p1 x att1 + block mean of p2 x att2, for the inputs that control it) x
 * (max - min), clamped.
 */
export const PIN_EXEMPT = new Set(['fm1', 'output', 'alloc', 'scope', 'arp', 'drummap']);
export const PIN_NAMES = ['p1', 'p2'] as const;
for (const m of ALL)
  if (!PIN_EXEMPT.has(m.def.type) && m.def.params.length) {
    m.def.paramInputs = true;
    m.def.inputs.push({ name: 'p1', kind: 'control', pin: 1 }, { name: 'p2', kind: 'control', pin: 2 });
  }

// ports added after the pins (port indices are append-only): the Steps module's keys in (#134)
steps.def.inputs.push(keys('keys'));
random.def.inputs.push(gate('clock'));
ladder.def.inputs.push(control('fm'));
lfo.def.inputs.push(control('shape'));
lfo.def.outputs.push(control('pulse'));
adsr.def.inputs.push(gate('hold'));
filter.def.outputs.push(audio('hp6'));

export const IMPLS: Record<string, ModuleImpl> = Object.fromEntries(ALL.map((m) => [m.def.type, m as ModuleImpl]));

export const DEFS: Record<string, ModuleDef> = Object.fromEntries(Object.values(IMPLS).map((m) => [m.def.type, m.def]));
