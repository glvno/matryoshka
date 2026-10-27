// SPDX-License-Identifier: GPL-3.0-only
// Oracle V XL: the Sequential Prophet-5 (Rev 4) whole, which the FM-1 version (scripts/gen-assemblies.ts, Oracle V) cut
// to fit. Source: Sequential's Prophet-5 User's Guide 1.3 (chapter 2, Prophet-5 Controls: Global Settings, Oscillators,
// Mixer, Filter, Filter Envelope, Amplifier Envelope, LFO, Wheel-Mod, Poly Mod, Vintage, Pitch and Mod Wheels,
// Aftertouch, Glide, Unison, Chord Memory, Master Tune, the Release Switch, Key Priority Modes).
// - Oscillator A: saw and pulse, each on or off, both at once; frequency (semitones); pulse width; sync to B. Oscillator
//   B: saw, triangle and pulse, each on or off; frequency (`freq`, octaves rounded to semitones: 0.58 a fifth), fine
//   (semitones, 0..1), pulse width; lo freq (4 octaves down: an LFO per voice for Poly Mod) and keyboard (off: B ignores
//   the keys). A pulse is its saw against a threshold through a steep, 2x oversampled hard clip, so its width moves per
//   sample (Poly Mod and the wheel move it at audio rate). B's triangle is a second oscillator on B's pitch, in phase.
// - Mixer: A, B, noise. Filter: cutoff, resonance, envelope amount, keyboard amount (0 off, 0.5 half, 1 full) and the Rev
//   switch (`filter rev`: 0 the Rev 1 / 2 filter, here the Multimode's 24 dB low pass, 1 the Rev 3 filter, here the
//   Ladder, whose pass band drops with resonance as the CEM 3320's does). Cutoff and resonance are Macros that set both
//   filters (0..1 over the whole range). Two ADSRs. Release OFF makes both envelopes release fast.
//   In rEL mode, MIDI sustain (CC 64) also enables their programmed release. In HLd mode it holds the gates instead.
//   Pedal values 0..63 are up and 64..127 down (User’s Guide, Global Settings p. 15 and Release Switch p. 43).
// - Velocity to the filter envelope amount and to the amplifier, each switchable (0 off, 1 on), with a response curve
//   (`vel curve` 0 linear, 1 squared). Aftertouch to the filter and to the LFO amount, each by its own amount, with a curve.
// - Poly Mod, per voice: the filter envelope and oscillator B (its waves as mixed), each by its own amount, into
//   oscillator A's frequency, its pulse width and the filter, at audio rate.
// - LFO: saw, triangle and square, each on or off, from 0.022 to 500 Hz (`lfo freq` -4..4, three oscillators in phase).
//   Wheel-Mod: the LFO / noise source mix, through the mod wheel plus the initial amount (and aftertouch), into frequency
//   A, frequency B, pulse width A, pulse width B and the filter, each by its own amount (the original's switches).
// - Keys: five voices; unison with a separate voice count, its detune (semitones), chord memory
//   (`chord 2`..`chord 5`: each voice's interval above the key, octaves rounded to semitones, picked per voice by a
//   Selector on its index; voice 1 plays the key), key priority (low or last) and retrigger (`legato` off); glide; pitch wheel range (octaves: 0.08 a
//   semitone, 1 an octave); transpose (octaves rounded to semitones); master tune (semitones); MIDI channel.
// - Vintage (0 the Rev 4's stability, 1 a Rev 1's): per voice, oscillator A and B drift, the cutoff, envelope times and
//   amplifier gain spread, on top of the voice cards' flaws. A-440: the reference tone.
// Not here, and why:
// - Needing a module type, or a new ability of one, in both engines: a chord learned from the held keys (the Voicing would
//   need a chord memory; here the intervals are set by hand, and with five voices); the 16 alternative tunings and
//   seven velocity / eight aftertouch curves.
// The LFO stays three oscillators: the LFO module's fast range reaches 80 Hz, the original 500 Hz.
// Over the FM-1 in modules, instances, buffers, bytes and CPU (Tier 1 of issue #351: 420 % -> 398 %), so it stays an XL.
// - Hardware: the CV and gate jacks, the filter-envelope and volume pedal jacks, the Tune button (the analog
//   oscillators' and filters' calibration), the pot modes, parameter transmission over MIDI and program dumps (the
//   editor stores and sends patches).
// The five voices, the card's first pages and the K1..K4 rows stay as on the FM-1 version; the new rows are on pages after.
import { BEND_OCT, DEFS } from '../../src/modules';
import { paramUnit } from '../../src/patch';
import { players, level, plugIn } from '../factory-build';
import type { Xl } from './xl';
import { aroundDef, edit } from './asm-edit';

// the FM-1 version's local module ids (src/assemblies/oracle-v.json)
const LFO = 1, WHEEL = 2, VIB = 3, NOISE = 4, ALLOC = 5, GLIDE = 6, OSC_B = 7, OSC_A = 8, POLY_ENV = 9, SYNC = 10, FENV = 11,
  FILTER = 12, AENV = 13, VCA = 14, SCOPE_FILTER = 15, SCOPE_LFO = 17;
/** the LFO's range, Hz (the guide: 0.022 to 500 Hz): `lfo freq` -4..4 spans it, an exponential scale */
const LFO_LO = 0.022, LFO_HI = 500;
const C4 = 261.6255653;
const LFO_GAIN = Math.log2(LFO_HI / LFO_LO) / 8;
const LFO_MID = Math.log2(Math.sqrt(LFO_HI * LFO_LO) / C4);
/** the FM-1 version's LFO rate (Hz) on `lfo freq` */
const lfoFreq = (hz: number): number => Math.round(((Math.log2(hz / C4) - LFO_MID) / LFO_GAIN) * 100) / 100;
/** the cutoff and resonance Macros: 0..1 over the filters' whole range (their pins' macro range) */
const cutoffUnit = (hz: number): number => Math.round(paramUnit(DEFS.filter.params.find((d) => d.name === 'cutoff')!, hz) * 100) / 100;

export const xl: Xl = {
  base: 'Oracle V',
  build: () => {
    const voice: number[] = [];
    let ladder = 0;
    const def = edit('Oracle V', (e) => {
      const per = (type: string, col: number, r: number, p: Record<string, number> = {}, o: { p1?: string; p2?: string } = {}): number => {
        const id = e.add(type, col, r, p, o);
        voice.push(id);
        return id;
      };
      const one = e.add('const', 0, 5, { value: 1 });

      // ---- the keys: the Voicing's pitch has the wheel at +-2 semitones in it; it is taken out before the glide and put
      // back at the bend range after. Transpose and chord memory go in before the glide (so the filter tracks them).
      const bendIn = e.add('scale', 0, 5.5, { gain: 1, offset: 0 });
      const unbend = e.add('scale', 0.5, 5.5, { gain: -BEND_OCT, offset: 0 });
      const bendAmt = e.add('scale', 1, 5.5, { gain: BEND_OCT, offset: 0 });
      e.wire(bendIn, 'out', unbend, 'in');
      e.wire(unbend, 'out', GLIDE, 'in');
      e.wire(bendIn, 'out', bendAmt, 'in');
      e.input('bend', bendIn, 'in');
      const transpose = e.add('const', 0, 6, { value: 0 });
      const transQ = e.add('quant', 0.5, 6, { scale: 0, root: 0 }); // (octaves to whole semitones)
      e.wire(transpose, 'out', transQ, 'in');
      e.wire(transQ, 'out', GLIDE, 'in');
      // chord memory: a Selector per voice picks the voice's interval above the key (v2..v5, octaves rounded to semitones;
      // voice 1 plays the key) by the Voicing's index (-1..1 over five voices, halved: positions 1..5 around 3)
      const chordPos = per('scale', 1, 6, { gain: 0.5, offset: 0 });
      e.wire(ALLOC, 'index', chordPos, 'in');
      const chordMix = per('select', 1.5, 6, { count: 5, pos: 3 });
      e.wire(chordPos, 'out', chordMix, 'pos');
      const chordQ = per('quant', 2, 6, { scale: 0, root: 0 });
      e.wire(chordMix, 'out', chordQ, 'in');
      const chordGate = per('math', 2.25, 6, { ka: 1, kb: 1 });
      e.wire(chordQ, 'out', chordGate, 'a');
      e.wire(ALLOC, 'unison', chordGate, 'b');
      e.wire(chordGate, 'mul', GLIDE, 'in');
      // unison detune: the voices spread by their index, semitones
      const detune = e.add('const', 0, 6.5, { value: 0 });
      const spread = per('math', 2, 6.5, { ka: 1, kb: 1 / 12, off: 0 });
      e.wire(ALLOC, 'index', spread, 'a');
      e.wire(detune, 'out', spread, 'b');
      const uniSpread = per('math', 2.25, 6.5, { ka: 1, kb: 1 });
      e.wire(spread, 'mul', uniSpread, 'a');
      e.wire(ALLOC, 'unison', uniSpread, 'b');
      const tune = e.add('const', 0, 7, { value: 0 }); // master tune, semitones
      const tuneOct = e.add('scale', 0.5, 7, { gain: 1 / 12, offset: 0 });
      e.wire(tune, 'out', tuneOct, 'in');

      // ---- vintage: per voice, drift of each oscillator, and spreads of the cutoff, the envelope times and the gain
      const vintage = e.add('const', 0, 7.5, { value: 0 });
      const vint = (mode: number, k: number, r: number): number => {
        const rnd = per('random', 2.5, r, { mode, rate: 0.4 });
        const m = per('math', 3, r, { ka: k, kb: 1, off: 0 });
        e.wire(rnd, 'out', m, 'a');
        e.wire(vintage, 'out', m, 'b');
        return m;
      };
      const vintA = vint(1, 0.012, 6), vintB = vint(1, 0.012, 6.25), vintF = vint(0, 0.3, 6.5), vintE = vint(0, 0.04, 6.75), vintL = vint(0, 0.05, 7);

      // ---- the pitch of each oscillator, per voice
      const busA = per('scale', 2.5, 0, { gain: 1, offset: 0 });
      const busB = per('scale', 1.5, 0, { gain: 1, offset: 0 });
      e.unwire(GLIDE, 'out', OSC_A, 'pitch');
      e.unwire(POLY_ENV, 'out', OSC_A, 'pitch');
      e.wire(GLIDE, 'out', busA, 'in');
      for (const [s, port] of [[tuneOct, 'out'], [bendAmt, 'out'], [uniSpread, 'mul']] as const) {
        e.wire(s, port, busA, 'in');
        e.wire(s, port, busB, 'in');
      }
      e.wire(vintA, 'mul', busA, 'in');
      e.wire(vintB, 'mul', busB, 'in');
      e.wire(busA, 'out', OSC_A, 'pitch');
      e.wire(busB, 'out', OSC_B, 'pitch');

      // ---- oscillator A: one saw; the pulse is the saw against 2 pw - 1 (saw + 1 - 2 pw through a steep hard clip)
      e.unwire(OSC_B, 'out', OSC_A, 'pm');
      e.unwire(OSC_A, 'out', FILTER, 'in');
      e.unwire(VIB, 'out', OSC_A, 'p1');
      e.unwire(VIB, 'out', OSC_B, 'p1');
      Object.assign(e.m(OSC_A).params, { wave: 2, level: 1, pm: 0 });
      const pulse = (osc: number, pw: number, col: number, r: number): number => {
        const cmp = per('math', col, r, { ka: 1, kb: 2, off: 1 });
        e.wire(osc, 'out', cmp, 'a');
        e.wire(pw, 'out', cmp, 'b');
        const clip = per('shape', col + 0.5, r, { drive: 32, mode: 1, level: 1, os: 1, sym: 0, stages: 3 });
        e.wire(cmp, 'sub', clip, 'in');
        return clip;
      };
      const pw = per('scale', 3.5, 2, { gain: 0, offset: 0.5 }); // its offset is the pulse width, its gain Poly Mod's pw A
      const pulseA = pulse(OSC_A, pw, 3, 0.5);
      const waves = per('math', 4, 0.5, { ka: 1, kb: 0, off: 0 }); // ka: saw on, kb: pulse on
      e.wire(OSC_A, 'out', waves, 'a');
      e.wire(pulseA, 'out', waves, 'b');

      // ---- oscillator B: a saw and its pulse, and a triangle oscillator on the same pitch (in phase: both start at 0 and
      // step alike), mixed by their switches. B's frequency (octaves, rounded to semitones) and fine (semitones) go into
      // its pitch, so both oscillators follow them.
      const fm1Fine = e.m(OSC_B).params.fine ?? 0;
      Object.assign(e.m(OSC_B).params, { wave: 2, level: 1, coarse: 0, fine: 0 });
      const tri = per('osc', 2, 2, { wave: 1, level: 1 });
      e.wire(busB, 'out', tri, 'pitch');
      const bFreq = e.add('const', 0, 1, { value: 0 });
      const bFreqQ = e.add('quant', 0.5, 1, { scale: 0, root: 0 });
      e.wire(bFreq, 'out', bFreqQ, 'in');
      e.wire(bFreqQ, 'out', busB, 'in');
      const bFine = e.add('const', 0, 1.5, { value: fm1Fine / 100 });
      const bFineOct = e.add('scale', 0.5, 1.5, { gain: 1 / 12, offset: 0 });
      e.wire(bFine, 'out', bFineOct, 'in');
      e.wire(bFineOct, 'out', busB, 'in');
      const pwB = per('scale', 2, 2.5, { gain: 1, offset: 0.5 });
      const pulseB = pulse(OSC_B, pwB, 2.5, 2.5);
      const bWaves = per('mixer', 3, 2, { l1: 1, l2: 0, l3: 0, l4: 0 });
      e.wire(OSC_B, 'out', bWaves, 'in1');
      e.wire(tri, 'out', bWaves, 'in2');
      e.wire(pulseB, 'out', bWaves, 'in3');

      // ---- the mixer per voice: A, B, noise (B and the noise at full level before it, so Poly Mod's osc B amount and the
      // wheel's noise do not depend on the mixer)
      const mix = per('mixer', 4, 0.5, { l1: 0.55, l2: 0.45, l3: 0, l4: 0 });
      e.unwire(OSC_B, 'out', FILTER, 'in');
      e.unwire(NOISE, 'out', FILTER, 'in');
      e.m(NOISE).params.level = 1;
      e.wire(waves, 'add', mix, 'in1');
      e.wire(bWaves, 'out', mix, 'in2');
      e.wire(NOISE, 'out', mix, 'in3');

      // ---- the filters: the Multimode (Rev 1 / 2) and the Ladder (Rev 3), the same cutoff, resonance and cv, crossfaded
      e.retype(FILTER, 'filter', { cutoff: 600, res: 0.2, cvamt: 1, track: 0 });
      e.m(FILTER).map!.p1 = ['cutoff'];
      e.m(FILTER).map!.p2 = ['res'];
      ladder = per('ladder', 4.5, 0.5, { cutoff: 600, res: 0.2, drive: 1, cvamt: 1, track: 0 }, { p1: 'cutoff', p2: 'res' });
      const cutM = e.add('macro', 5, 5, { value: cutoffUnit(600) });
      const resM = e.add('macro', 5, 5.5, { value: 0.2 });
      for (const f of [FILTER, ladder]) {
        e.wire(mix, 'out', f, 'in');
        e.wire(cutM, 'out', f, 'p1');
        e.wire(resM, 'out', f, 'p2');
      }
      const fbus = per('scale', 4, 1.5, { gain: 1, offset: 0 }); // everything that moves the cutoff, octaves
      e.wire(fbus, 'out', FILTER, 'cv');
      e.wire(fbus, 'out', ladder, 'cv');
      const rev = per('xfade', 5, 0.5, { mix: 0 });
      e.unwire(FILTER, 'lp24', VCA, 'in');
      e.unwire(FILTER, 'lp24', SCOPE_FILTER, 'a');
      e.wire(FILTER, 'lp24', rev, 'a');
      e.wire(ladder, 'lp24', rev, 'b');
      e.wire(rev, 'out', VCA, 'in');
      e.wire(rev, 'out', SCOPE_FILTER, 'a');
      const track = per('scale', 3.5, 1.5, { gain: 0, offset: 0 }); // keyboard amount: 0 off, 0.5 half, 1 full
      e.wire(GLIDE, 'out', track, 'in');
      e.wire(track, 'out', fbus, 'in');
      e.wire(vintF, 'mul', fbus, 'in');

      // ---- velocity: a curve, then a switch each for the filter envelope amount and the amplifier
      const velSq = per('math', 5.5, 1, { ka: 1, kb: 1, off: 0 });
      e.wire(ALLOC, 'vel', velSq, 'a');
      e.wire(ALLOC, 'vel', velSq, 'b');
      const vel = per('xfade', 5.5, 1.5, { mix: 0 });
      e.wire(ALLOC, 'vel', vel, 'a');
      e.wire(velSq, 'mul', vel, 'b');
      const velSwitch = (r: number): number => {
        const s = per('xfade', 6, r, { mix: 0 });
        e.wire(one, 'out', s, 'a');
        e.wire(vel, 'out', s, 'b');
        return s;
      };
      const velF = velSwitch(1), velA = velSwitch(1.5);
      // the filter envelope amount, octaves, on an attenuverter; velocity scales it
      e.unwire(FENV, 'env', FILTER, 'cv');
      const fenvVel = per('math', 4.5, 1, { ka: 1, kb: 1, off: 0 });
      e.wire(FENV, 'env', fenvVel, 'a');
      e.wire(velF, 'out', fenvVel, 'b');
      const envAmt = per('scale', 4.5, 1.5, { gain: 3.5, offset: 0 });
      e.wire(fenvVel, 'mul', envAmt, 'in');
      e.wire(envAmt, 'out', fbus, 'in');
      e.unwire(AENV, 'env', VCA, 'cv');
      const ampVel = per('math', 6, 2, { ka: 1, kb: 1, off: 0 });
      e.wire(AENV, 'env', ampVel, 'a');
      e.wire(velA, 'out', ampVel, 'b');
      e.wire(ampVel, 'mul', VCA, 'cv');
      e.wire(vintL, 'mul', VCA, 'p1');

      // ---- the envelopes' pins: p1 the vintage spread of a / d / r, p2 the Release switch (off: r 0.8 of its range shorter)
      for (const env of [FENV, AENV]) {
        e.m(env).map!.p1 = ['a', 'd', 'r'];
        e.m(env).map!.p2 = ['r'];
        e.wire(vintE, 'mul', env, 'p1');
      }
      const release = e.add('select', 6, 5, { count: 2, pos: 2, v1: 0, v2: 1 });
      const pedal = e.add('logic', 6, 5.5, { thresh: 0.5 });
      e.input('sustain', pedal, 'a');
      const pedalMode = e.add('select', 6, 6, { count: 2, pos: 1 });
      const releasePedal = e.add('logic', 6.5, 5.5, { thresh: 0.5 });
      const holdPedal = e.add('logic', 6.5, 6, { thresh: 0.5 });
      for (const [dest, mode] of [[releasePedal, 'g1'], [holdPedal, 'g2']] as const) {
        e.wire(pedal, 'or', dest, 'a');
        e.wire(pedalMode, mode, dest, 'b');
      }
      const releaseOn = e.add('logic', 7, 5, { thresh: 0.5 });
      e.wire(release, 'out', releaseOn, 'a');
      e.wire(releasePedal, 'and', releaseOn, 'b');
      const releaseTime = e.add('scale', 7.5, 5, { gain: 0.8, offset: -0.8 });
      e.wire(releaseOn, 'or', releaseTime, 'in');
      e.wire(releaseTime, 'out', FENV, 'p2');
      e.wire(releaseTime, 'out', AENV, 'p2');
      // The envelope's hold input preserves note-on edges when a voice is reused under the pedal.
      for (const env of [FENV, AENV]) e.wire(holdPedal, 'and', env, 'hold');

      // ---- Poly Mod: filter env (POLY_ENV) and osc B amounts summed, into freq A, pw A, filter
      Object.assign(e.m(POLY_ENV).params, { gain: 0, offset: 0 });
      const pmB = per('scale', 2.5, 1.5, { gain: 0, offset: 0 });
      e.wire(bWaves, 'out', pmB, 'in');
      const bus = per('scale', 3, 1.5, { gain: 1, offset: 0 });
      e.wire(POLY_ENV, 'out', bus, 'in');
      e.wire(pmB, 'out', bus, 'in');
      const toFreqA = per('scale', 3.5, 1, { gain: 1, offset: 0 });
      e.wire(bus, 'out', toFreqA, 'in');
      e.wire(toFreqA, 'out', busA, 'in');
      e.wire(bus, 'out', pw, 'in');
      const toFilter = per('scale', 4, 2, { gain: 0, offset: 0 });
      e.wire(bus, 'out', toFilter, 'in');
      e.wire(toFilter, 'out', fbus, 'in');

      // ---- oscillator B's keyboard switch (crossfade from nothing to the keys) and lo freq (an offset, octaves)
      e.unwire(GLIDE, 'out', OSC_B, 'pitch');
      const kbd = per('xfade', 1, 1.5, { mix: 1 });
      e.wire(GLIDE, 'out', kbd, 'b');
      e.wire(kbd, 'out', busB, 'in');
      const lo = e.add('const', 0, 4, { value: 0 });
      e.wire(lo, 'out', busB, 'in');

      // ---- the LFO: three oscillators in phase (saw, triangle, square), 0.022..500 Hz; the FM-1 version's LFO becomes the
      // triangle
      e.unwire(LFO, 'out', WHEEL, 'in');
      e.unwire(LFO, 'out', SCOPE_LFO, 'a');
      e.retype(LFO, 'osc', { wave: 1, level: 1 });
      e.m(LFO).map!.p1 = ['fine'];
      e.m(LFO).map!.p2 = ['pw'];
      const lfoRate = e.add('const', 0, 2.5, { value: lfoFreq(5) });
      const lfoPitch = e.add('scale', 0.5, 2.5, { gain: LFO_GAIN, offset: LFO_MID });
      e.wire(lfoRate, 'out', lfoPitch, 'in');
      const lfoSaw = e.add('osc', 0.5, 0, { wave: 2, level: 1 });
      const lfoSquare = e.add('osc', 0.5, 0.25, { wave: 3, level: 1, pw: 0.5 });
      const lfoMix = e.add('mixer', 1, 0, { l1: 0, l2: 1, l3: 0, l4: 0 });
      for (const [o, port] of [[lfoSaw, 'in1'], [LFO, 'in2'], [lfoSquare, 'in3']] as const) {
        e.wire(lfoPitch, 'out', o, 'pitch');
        e.wire(o, 'out', lfoMix, port);
      }
      e.wire(lfoMix, 'out', SCOPE_LFO, 'a');

      // ---- Wheel-Mod: LFO / noise mix, the wheel plus the initial amount (plus aftertouch), five destinations
      const noise2 = e.add('noise', 0, 3.5, { level: 1, color: 0 });
      const source = e.add('xfade', 0.5, 0.5, { mix: 0 });
      e.wire(lfoMix, 'out', source, 'a');
      e.wire(noise2, 'out', source, 'b');
      e.wire(source, 'out', WHEEL, 'in');
      const initial = e.add('const', 0, 4.5, { value: 0 });
      e.wire(initial, 'out', WHEEL, 'cv');
      e.m(VIB).params.gain = 1;
      const dest = (to: [number, string][], gain: number, r: number): number => {
        const s = e.add('scale', 0.5, r, { gain, offset: 0 });
        e.wire(VIB, 'out', s, 'in');
        for (const [m, port] of to) e.wire(s, 'out', m, port);
        return s;
      };
      const wFreqA = dest([[busA, 'in']], 0.24, 2.5); // 0.24: the FM-1 version's vibrato, +-48 cents
      const wFreqB = dest([[busB, 'in']], 0.24, 3);
      const wPwA = dest([[pw, 'in']], 0, 3.5);
      const wPwB = dest([[pwB, 'in']], 0, 4);
      const wFilter = dest([[fbus, 'in']], 0, 4.5);

      // ---- aftertouch (channel pressure, as the original's): a curve, then the filter and the LFO amount
      const atIn = e.add('scale', 7, 5, { gain: 1, offset: 0 });
      e.input('at', atIn, 'in');
      const atSq = e.add('math', 7, 5.5, { ka: 1, kb: 1, off: 0 });
      e.wire(atIn, 'out', atSq, 'a');
      e.wire(atIn, 'out', atSq, 'b');
      const at = e.add('xfade', 7.5, 5, { mix: 0 });
      e.wire(atIn, 'out', at, 'a');
      e.wire(atSq, 'mul', at, 'b');
      const atFilter = e.add('scale', 8, 5, { gain: 0, offset: 0 });
      const atLfo = e.add('scale', 8, 5.5, { gain: 0, offset: 0 });
      e.wire(at, 'out', atFilter, 'in');
      e.wire(at, 'out', atLfo, 'in');
      e.wire(atFilter, 'out', fbus, 'in');
      e.wire(atLfo, 'out', WHEEL, 'cv');

      // ---- A-440: the reference tone, beside the voices on the way out
      const a440 = e.add('osc', 7, 0, { wave: 3, coarse: 9, level: 0 });
      const out = e.add('mixer', 7.5, 0, { l1: 1, l2: 0.25, l3: 0, l4: 0 });
      e.wire(VCA, 'out', out, 'in1');
      e.wire(a440, 'out', out, 'in2');
      const o = e.def.outputs.find((x) => x.label === 'out')!;
      Object.assign(o, { module: out, port: 'out' });

      e.join('voice', ...voice);

      // ---- the card: the FM-1 version's rows, rebound where the modules changed, then the new sections
      e.rebind(e.rowAt('wave'), 'saw', waves, 'ka', 'A saw');
      e.insertRow(e.rowAt('saw') + 1, 'pulse', waves, 'kb', { inner: 'A pulse' });
      e.rebind(e.rowAt('pw'), 'pw', pw, 'offset', 'A pw');
      e.rebind(e.rowAt('wave'), 'saw', bWaves, 'l1', 'B saw'); // (osc B's)
      e.insertRow(e.rowAt('saw', 1) + 1, 'tri', bWaves, 'l2', { inner: 'B tri' });
      e.insertRow(e.rowAt('saw', 1) + 2, 'pulse', bWaves, 'l3', { inner: 'B pulse' });
      e.rebind(e.rowAt('freq'), 'freq', bFreq, 'value', 'B freq');
      e.rebind(e.rowAt('fine'), 'fine', bFine, 'value', 'B fine');
      e.insertRow(e.rowAt('fine') + 1, 'pw', pwB, 'offset', { inner: 'B pw' });
      e.insertRow(e.rowAt('pw') + 1, 'freq', OSC_A, 'coarse', { inner: 'A freq' });
      e.rebind(e.rowAt('A level'), 'A level', mix, 'l1');
      e.rebind(e.rowAt('B level'), 'B level', mix, 'l2');
      e.rebind(e.rowAt('noise'), 'noise', mix, 'l3');
      e.rebind(e.rowAt('cutoff'), 'cutoff', cutM, 'value');
      e.rebind(e.rowAt('res'), 'res', resM, 'value');
      e.rebind(e.rowAt('env amt'), 'env amt', envAmt, 'gain');
      e.rebind(e.rowAt('kbd track'), 'kbd track', track, 'gain');
      e.rebind(e.rowAt('pmod env→A'), 'pmod env', POLY_ENV, 'gain');
      e.rebind(e.rowAt('pmod B→A'), 'pmod osc B', pmB, 'gain');
      e.rebind(e.rowAt('lfo rate'), 'lfo freq', lfoRate, 'value');
      e.rebind(e.rowAt('lfo wave'), 'lfo saw', lfoMix, 'l1');
      e.insertRow(e.rowAt('lfo saw') + 1, 'lfo tri', lfoMix, 'l2');
      e.insertRow(e.rowAt('lfo tri') + 1, 'lfo square', lfoMix, 'l3');
      e.rebind(e.rowAt('vibrato'), 'wheel amt', VIB, 'gain');
      e.param('→ freq A', toFreqA, 'gain', { col: true, head: 'poly mod', inner: 'pmod → freq A' });
      e.param('→ pw A', pw, 'gain', { inner: 'pmod → pw A' });
      e.param('→ filter', toFilter, 'gain', { inner: 'pmod → filter' });
      e.param('source mix', source, 'mix', { head: 'wheel mod' });
      e.param('lfo amount', initial, 'value');
      e.param('freq A', wFreqA, 'gain');
      e.param('freq B', wFreqB, 'gain');
      e.param('pw A', wPwA, 'gain');
      e.param('pw B', wPwB, 'gain');
      e.param('filter', wFilter, 'gain');
      e.param('B kbd', kbd, 'mix', { head: 'osc B mode' });
      e.param('B lo freq', lo, 'value');
      e.param('priority', ALLOC, 'priority', { col: true, head: 'keys' });
      e.param('legato', ALLOC, 'legato');
      e.param('uni voices', ALLOC, 'stack');
      e.param('uni detune', detune, 'value');
      e.param('bend range', bendAmt, 'gain');
      e.param('transpose', transpose, 'value');
      e.param('master tune', tune, 'value');
      e.param('channel', ALLOC, 'channel');
      e.param('chord 2', chordMix, 'v2', { head: 'chord memory' });
      e.param('chord 3', chordMix, 'v3');
      e.param('chord 4', chordMix, 'v4');
      e.param('chord 5', chordMix, 'v5');
      e.param('vel curve', vel, 'mix', { col: true, head: 'touch' });
      e.param('vel → filter', velF, 'mix');
      e.param('vel → amp', velA, 'mix');
      e.param('at curve', at, 'mix');
      e.param('at → filter', atFilter, 'gain');
      e.param('at → lfo amt', atLfo, 'gain');
      e.param('release', release, 'pos', { head: 'switches' });
      e.def.params[e.def.params.length - 1].names = ['OFF', 'ON'];
      e.param('release/sustain', pedalMode, 'pos');
      e.def.params[e.def.params.length - 1].names = ['rEL', 'HLd'];
      e.param('filter rev', rev, 'mix');
      e.param('vintage', vintage, 'value');
      e.param('A-440', a440, 'level');
    });
    const x = aroundDef('Oracle V', def);
    plugIn(x.p, x.main.id, 'bend', x.a, 'bend');
    plugIn(x.p, x.main.id, 'at', x.a, 'at');
    plugIn(x.p, x.main.id, 'sustain', x.a, 'sustain');
    // the cutoff and resonance Macros set both filters over their whole range (insertAssembly does not copy macro ranges)
    const fresh = x.p.modules.slice(1, 1 + def.modules.length); // (after Main, in the definition's order)
    for (const local of [FILTER, ladder]) {
      const m = fresh[local - 1];
      if (m.type !== def.modules[local - 1].type) throw new Error('Oracle V XL: the modules moved');
      m.range = { p1: { cutoff: [0, 1] }, p2: { res: [0, 1] } };
    }
    x.set('voices', 5);
    level(x.p, { chord: true });
    x.p.notes = NOTES;
    return players(x.p, true);
  },
};

const NOTES =
  'The Prophet-5 Rev 4 whole (Sequential Prophet-5 User’s Guide): oscillator A saw and pulse, B saw, triangle and pulse, each on or off, sync, B’s keyboard switch and lo freq; the Rev 1/2 and Rev 3 filters, keyboard amount, velocity and aftertouch, the Release switch; Poly Mod (filter envelope and oscillator B into A’s frequency, pulse width and the filter, at audio rate) and Wheel-Mod (LFO saw / triangle / square, 0.022 to 500 Hz, or noise into both frequencies, both pulse widths and the filter); unison with a separate voice count and detune, chord memory, key priority, pitch wheel range, transpose, master tune, vintage, A-440. Five voices. MIDI CC 64: rEL enables programmed release, HLd holds notes. Not here: learning a chord from the keys (its intervals are set by hand), the alternative tunings and response curves, the CV and gate jacks.';
