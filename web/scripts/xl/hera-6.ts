// SPDX-License-Identifier: GPL-3.0-only
// Hera 6 XL: the Juno-106 as its owner's manual describes it, where the FM-1 version (scripts/gen-assemblies.ts, Hera 6)
// had to cut. Source: Roland Juno-106 Owner's Manual (DCO, HPF, VCF, VCA, ENV, LFO, Keyboard, Assign Mode, Controller,
// Key Transpose, Remote Control, Chorus Effect, Specifications).
// - Each voice's low pass follows its envelope, the LFO, the keys and the bender per sample: the Multimode's 24 dB low
//   pass in place of the Ladder, whose cutoff moves once per 128-sample block. Every amount is its own row in octaves
//   (the FM-1 version's env amount scaled the LFO too): ENV, the polarity switch (an attenuverter: -1 inverts the
//   envelope), LFO, KYBD (0..1, the manual's key follow of 0 to 100 %).
// - The DCO: saw and pulse sound together (the manual: "each switch can be individually turned on or off"); the range
//   switch (16' 8' 4': a Selector, 1 2 3, of -1, 0 or 1 octave); the PWM mode switch (MAN: the pw row
//   sets the width; LFO: the pwm row is the depth); the LFO into the pitch per sample (the FM-1 version: the fine tune,
//   once per block).
// - The VCA by the envelope or by the gate.
// - The envelope's decay and release to 12 s (the ADSR's long times; release reaches 19.2 s).
// - The LFO's delay time (the LFO fades in after a key is pressed; an envelope on a VCA after the LFO, keyed by a one-voice
//   allocator that holds while any key is down).
// - The HPF's position 0, the bass boost (a low pass at 120 Hz mixed back in).
// - The controller panel: the bender's DCO sensitivity (0..1 octave either way; Main's bend in, the 2 semitones a part
//   always bends taken back out) and VCF sensitivity (octaves of cutoff); the lever's LFO (Main's mod wheel brings in
//   vibrato by the LFO trigger depth); portamento, its on / off switch (a Selector: 1 off, 2 on) and time (a slew per voice: each voice glides from
//   its own last note, as on the original, whose manual suggests Poly 2 for it).
// - Assign mode: Poly 1 (the next voice in turn, releases overlap), Poly 2 (the lowest free voice, so a note cuts the
//   release of the one before), and both pressed, solo unison (all six voices on one key): the allocator's assign and
//   unison rows.
// - Key transpose (+-1 octave in semitones: an offset quantized to semitones, before the portamento and the key follow);
//   the rear panel's tune (+-1/4 tone).
// - Hold (the pedal's function, as a row): a voice whose key is let go keeps its gate while hold is on and its envelope
//   still sounds (a voice that decayed to silence is let go, as on the original).
// Kept as on the FM-1 version: six voices, one noise source, the chorus (its rate and depth reach the original's I and II),
// the K1..K4 pages; the new rows come after.
// Not here:
// - Poly 2 with six keys down takes over a voice (the original then plays no more keys). It needs a "no take-over" choice
//   on the Voice allocator, in both engines.
// Over the FM-1's CPU (Tier 1 of issue #351, 2026-10-26: 194 % -> 177 %; module instances 136 -> 120 of 128): three
// oscillators per voice whose pitch moves every sample (portamento, the LFO) and the per-sample filter. Even with the
// Ladder (145 %) and no per-sample pitch (about 123 %) six voices do not fit, so it stays an XL (D-348 does not apply).
// - The hold and patch shift pedal jacks, the tape interface, the memory and the MIDI function switch: hardware and
//   storage, no part of the sound (the editor keeps the patches; MIDI's hold, CC 64, does not reach Main).
import { level, players, plugIn } from '../factory-build';
import type { Xl } from './xl';
import { aroundDef, edit } from './asm-edit';
import { ADSR_LONG, BEND_OCT } from '../../src/modules';

// the FM-1 version's local module ids (src/assemblies/hera-6.json)
const LFO = 1, VIB = 2, PWM = 3, LFO_FILTER = 4, PART = 6, OSC = 7, SUB = 8, LADDER = 9, ENV = 10, VCA = 11, HPF = 12, CHORUS = 13, SCOPE = 14;
/** the quantizer's scales (modules.ts SCALES): chromatic */
const CHROMATIC = 0;

export const xl: Xl = {
  base: 'Hera 6',
  build: () => {
    const def = edit('Hera 6', (e) => {
      const voice = e.nest('voice');
      // ---- the keys' offsets, once for all voices: the bend a part always carries taken back out, plus the key transpose
      const keyOffs = e.add('scale', 1.5, 4.5, { gain: 1, offset: 0 });
      const unbend = e.add('scale', 1, 4.5, { gain: -BEND_OCT, offset: 0 });
      e.wire(unbend, 'out', keyOffs, 'in');
      const transpose = e.add('const', 1, 5, { value: 0 });
      const semis = e.add('quant', 1.5, 5, { scale: CHROMATIC, root: 0 });
      e.wire(transpose, 'out', semis, 'in');
      e.wire(semis, 'out', keyOffs, 'in');
      // ---- the keys' pitch per voice, then the portamento: a slew, or straight through when off (a Selector: 1 off, 2 on)
      e.unwire(PART, 'pitch', OSC, 'pitch');
      e.unwire(PART, 'pitch', SUB, 'pitch');
      const porta = e.add('glide', 2, 2, { time: 0.2, curve: 0 });
      const portaOn = e.add('select', 2.5, 2, { count: 2, pos: 1 });
      for (const [m, port] of [[porta, 'in'], [portaOn, 'in1']] as const) {
        e.wire(PART, 'pitch', m, port);
        e.wire(keyOffs, 'out', m, port);
      }
      e.wire(porta, 'out', portaOn, 'in2');
      // ---- the DCO's pitch: the keys plus, once for all voices, the range switch (a Selector: 1 16', 2 8', 3 4'), the
      // tune, the LFO, the lever's LFO and the bender
      const dcoMod = e.add('scale', 1.5, 6, { gain: 1, offset: 0 });
      const range = e.add('select', 1, 5.5, { count: 3, pos: 2, v1: -1, v2: 0, v3: 1 });
      e.wire(range, 'out', dcoMod, 'in');
      const tune = e.add('const', 1, 6, { value: 0 });
      e.wire(tune, 'out', dcoMod, 'in');
      const dcoBend = e.add('scale', 1, 6.5, { gain: BEND_OCT, offset: 0 });
      e.wire(dcoBend, 'out', dcoMod, 'in');
      const dcoPitch = e.add('scale', 3, 2, { gain: 1, offset: 0 });
      e.wire(portaOn, 'out', dcoPitch, 'in');
      e.wire(dcoMod, 'out', dcoPitch, 'in');
      // ---- the DCO: saw and pulse together (OSC becomes the pulse, a new saw beside it)
      Object.assign(e.m(OSC).params, { wave: 3, level: 0 });
      const saw = e.add('osc', 2, 0.5, { wave: 2, level: 0.55 });
      e.wire(saw, 'out', LADDER, 'in');
      for (const o of [OSC, SUB, saw]) e.wire(dcoPitch, 'out', o, 'pitch');
      // ---- the LFO into the pitch per sample (the FM-1 version: the fine tune pin)
      e.unwire(VIB, 'out', OSC, 'p1');
      e.unwire(VIB, 'out', SUB, 'p1');
      e.wire(VIB, 'out', dcoMod, 'in');
      // ---- the filter: the Multimode, cutoff per sample, 1 octave per unit of its cv; each source by its own amount
      e.retype(LADDER, 'filter', { cutoff: 1400, res: 0.15, cvamt: 1, track: 0 });
      e.unwire(ENV, 'env', LADDER, 'cv');
      const envAmt = e.add('scale', 3, 1.5, { gain: 2.2, offset: 0 });
      const polarity = e.add('scale', 3.5, 1.5, { gain: 1, offset: 0 });
      e.wire(ENV, 'env', envAmt, 'in');
      e.wire(envAmt, 'out', polarity, 'in');
      e.wire(polarity, 'out', LADDER, 'cv');
      const kybd = e.add('scale', 3, 2.5, { gain: 1, offset: 0 });
      e.wire(portaOn, 'out', kybd, 'in');
      e.wire(kybd, 'out', LADDER, 'cv');
      const vcfBend = e.add('scale', 1, 7, { gain: 0, offset: 0 });
      e.wire(vcfBend, 'out', LADDER, 'cv');
      e.input('bend', unbend, 'in', [dcoBend, 'in'], [vcfBend, 'in']);
      // ---- hold: the gate stays up while hold is on and the envelope still sounds. One Logic per voice: its b is the hold
      // level (just under the threshold while hold is on, far below it while off) plus the envelope, so b is high while
      // hold is on and the envelope is above silence (1e-4); the gate is a or b
      const hold = e.add('macro', 1, 7.5, { value: 0 });
      const holdLevel = e.add('scale', 1.5, 7.5, { gain: 4.4999, offset: -4 });
      e.wire(hold, 'out', holdLevel, 'in');
      const gate = e.add('logic', 4.5, 2.5, { thresh: 0.5 });
      e.unwire(PART, 'gate', ENV, 'gate');
      e.wire(PART, 'gate', gate, 'a');
      e.wire(holdLevel, 'out', gate, 'b');
      e.wire(ENV, 'env', gate, 'b');
      e.wire(gate, 'or', ENV, 'gate');
      // ---- the VCA by the envelope or the gate
      e.unwire(ENV, 'env', VCA, 'cv');
      const vcaMode = e.add('xfade', 4, 1, { mix: 0 });
      e.wire(ENV, 'env', vcaMode, 'a');
      e.wire(gate, 'or', vcaMode, 'b');
      e.wire(vcaMode, 'out', VCA, 'cv');
      // ---- decay and release to 12 s as on the original: the ADSR's long times (x 2.4), set to sound as before
      Object.assign(e.m(ENV).params, { d: 0.8 / ADSR_LONG, r: 0.5 / ADSR_LONG, long: 1 });
      e.join('voice', porta, portaOn, dcoPitch, saw, envAmt, polarity, kybd, gate, vcaMode);
      // the voice card's inputs: the pitch now goes into the portamento, the gate into the hold's gate
      voice.inputs = voice.inputs.map((r) => (r.label === 'pitch' ? { module: porta, port: 'in', label: 'pitch', also: [{ module: portaOn, port: 'in1' }] } : r.label === 'gate' ? { module: gate, port: 'a', label: 'gate' } : r));
      // ---- the LFO's delay: a one-voice allocator's gate (held while any key is) opens a VCA after the LFO
      const held = e.add('alloc', 0, 4, { voices: 1, legato: 2 });
      const keys = e.def.inputs.find((r) => r.label === 'keys')!;
      keys.also = [...(keys.also ?? []), { module: held, port: 'keys' }];
      const delayEnv = e.add('adsr', 0.5, 4, { a: 0.001, d: 0.001, s: 1, r: 8 });
      e.wire(held, 'gate', delayEnv, 'gate');
      const delayed = e.add('vca', 0.5, 0.5, { gain: 1 });
      e.unwire(LFO, 'out', VIB, 'in');
      e.unwire(LFO, 'out', PWM, 'in');
      e.unwire(LFO, 'out', LFO_FILTER, 'in');
      e.wire(LFO, 'out', delayed, 'in');
      e.wire(delayEnv, 'env', delayed, 'cv');
      for (const s of [VIB, LFO_FILTER]) e.wire(delayed, 'out', s, 'in');
      // ---- the PWM mode switch: MAN (0) the pw row alone, LFO (1) the LFO by the pwm row
      const pwmMode = e.add('xfade', 0.5, 1.5, { mix: 1 });
      e.wire(delayed, 'out', pwmMode, 'b');
      e.wire(pwmMode, 'out', PWM, 'in');
      // ---- the bender lever's LFO: the mod wheel opens vibrato by its depth
      const lever = e.add('vca', 0, 4.5, { gain: 1 });
      e.wire(LFO, 'out', lever, 'in');
      e.input('wheel', lever, 'cv');
      const leverDepth = e.add('scale', 0.5, 4.5, { gain: 0.04, offset: 0 });
      e.wire(lever, 'out', leverDepth, 'in');
      e.wire(leverDepth, 'out', dcoMod, 'in');
      // ---- the HPF's bass boost: a low pass of the voices mixed in beside the high pass
      const boost = e.add('filter', 5, 1, { cutoff: 120, res: 0, cvamt: 1, track: 0 });
      e.wire(VCA, 'out', boost, 'in');
      const sum = e.add('mixer', 5.5, 0.5, { l1: 1, l2: 0, l3: 0, l4: 0 });
      e.unwire(HPF, 'hp', CHORUS, 'in');
      e.unwire(HPF, 'hp', SCOPE, 'a');
      e.wire(HPF, 'hp', sum, 'in1');
      e.wire(boost, 'lp12', sum, 'in2');
      e.wire(sum, 'out', CHORUS, 'in');
      e.wire(sum, 'out', SCOPE, 'a');
      // ---- the card: the FM-1 version's rows (the DCO's wave choice now two levels; env and kybd now amounts in octaves),
      // then the new sections
      e.rebind(e.rowAt('wave'), 'saw', saw, 'level');
      e.insertRow(e.rowAt('saw') + 1, 'pulse', OSC, 'level');
      e.rebind(e.rowAt('env'), 'env', envAmt, 'gain');
      e.rebind(e.rowAt('kybd'), 'kybd', kybd, 'gain');
      e.param('lfo delay', delayEnv, 'a', { col: true, head: 'lfo delay · lever' });
      e.param('lever lfo', leverDepth, 'gain');
      e.param('env polarity', polarity, 'gain', { head: 'vcf · vca' });
      e.param('vca gate', vcaMode, 'mix');
      e.param('bass boost', sum, 'l2');
      e.param('range', range, 'pos', { col: true, head: 'dco · keys' });
      e.param('pwm lfo', pwmMode, 'mix');
      e.param('transpose', transpose, 'value');
      e.param('tune', tune, 'value');
      e.param('dco bend', dcoBend, 'gain', { head: 'bender' });
      e.param('vcf bend', vcfBend, 'gain');
      e.param('portamento', portaOn, 'pos', { col: true, head: 'portamento · assign' });
      e.param('porta time', porta, 'time');
      e.param('assign', PART, 'assign');
      e.param('unison', PART, 'unison');
      e.param('hold', hold, 'value');
    });
    const x = aroundDef('Hera 6', def);
    plugIn(x.p, x.main.id, 'bend', x.a, 'bend');
    x.set('voices', 6);
    level(x.p, { chord: true });
    x.p.notes = NOTES;
    return players(x.p, true);
  },
};

const NOTES =
  'The Juno-106 as its owner’s manual describes it. DCO: saw and pulse together, range (1 16’, 2 8’, 3 4’), pwm lfo (0 MAN: pw is the width, 1 LFO: pwm the depth). HPF 1..3 on hpf, 0 on bass boost. A 24 dB low pass per voice; env, polarity, lfo, kybd in octaves. VCA by env or gate. Decay and release to 12 s. LFO delay. Bender: dco bend, vcf bend (octaves), the lever’s LFO on the mod wheel. Portamento (1 off, 2 on). Assign: rotate Poly 1, lowest Poly 2, unison solo. Transpose (0.08 a semitone), tune, hold. Six voices, chorus.';
