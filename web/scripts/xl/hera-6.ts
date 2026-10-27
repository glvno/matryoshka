// SPDX-License-Identifier: GPL-3.0-only
// Hera 6 XL: the Juno-106 as its owner's manual describes it, where the FM-1 version (scripts/gen-assemblies.ts, Hera 6)
// had to cut. Source: Roland Juno-106 Owner's Manual (the panel drawing on page 3; DCO p. 16, HPF and VCF p. 18, VCA and
// ENV p. 20, LFO p. 21, Keyboard and Assign Mode p. 22, Controller p. 23, Key Transpose and Remote Control p. 24, Chorus
// Effect p. 29; the rear panel's TUNE, p. 5).
//
// The card (docs/ledger/patches-and-presets.md D-347): one row per control of the original, named as its panel names it.
//   LFO        rate, delay time
//   DCO        range (switch: 16', 8', 4'), lfo, pwm, pwm mode (switch: LFO, MAN), pulse and saw (each a switch: OFF,
//              ON), sub, noise
//   HPF        freq (switch: 0, 1, 2, 3; 0 the bass boost)
//   VCF        freq, res, polarity (switch: POSITIVE, NEGATIVE), env, lfo, kybd
//   VCA        mode (switch: ENV, GATE), level
//   ENV        a, d, s, r
//   CHORUS     chorus (switch: OFF, I, II)
//   bender     dco, vcf, lfo (the controller's DCO, VCF and LFO sliders)
//   portamento portamento (the time knob), porta switch (OFF, ON)
//   keys       assign mode (POLY 1, POLY 2), unison (POLY 1 and POLY 2 pressed together: solo unison), key transpose, tune
// That is 34 rows for the Juno's 33 controls: the assign mode buttons are two rows (see "Not on the card").
// How each is built:
// - Each voice's low pass follows its envelope, the LFO, the keys and the bender per sample: the Multimode's 24 dB low
//   pass in place of the Ladder, whose cutoff moves once per 128-sample block. env, lfo and kybd are amounts in octaves;
//   polarity is a Selector between the envelope and the envelope inverted.
// - The DCO: saw and pulse each through a Selector (OFF passes nothing), so both can sound together ("each switch can be
//   individually turned on or off"); range (a Selector of -1, 0 or 1 octave); one PWM slider: with pwm mode on MAN it sets
//   the width (0 a square, 1 the narrowest pulse), on LFO the depth of the LFO's sweep; the LFO into the pitch per sample.
// - The HPF's four positions: a Selector's value moves the high pass's cutoff (1 open, 2 about 240 Hz, 3 about 720 Hz, set
//   by ear: the manual gives no frequencies); position 0 opens it and mixes a low pass at 120 Hz back in (the bass boost).
// - The VCA by the envelope or by the gate.
// - The envelope's decay and release to 12 s (the ADSR's long times; release reaches 19.2 s).
// - The LFO's delay time (the LFO fades in after a key is pressed; an envelope on a VCA after the LFO, keyed by a one-voice
//   allocator that holds while any key is down).
// - The chorus: two Chorus modules, I (0.5 Hz) and II (0.8 Hz, deeper; set by ear), and the dry signal, picked by a
//   Selector per side. The manual: "It is not possible to use I and II at the same time", so there is no I + II.
// - The controller panel: the bender's DCO sensitivity (0..1 octave either way; Main's bend in, the 2 semitones a part
//   always bends taken back out) and VCF sensitivity (octaves of cutoff); the lever's LFO (Main's mod wheel brings in
//   vibrato by the LFO slider); portamento, its switch and time (a slew per voice: each voice glides from its own last
//   note, as on the original, whose manual suggests Poly 2 for it).
// - Assign mode: Poly 1 (the next voice in turn, releases overlap), Poly 2 (the lowest free voice, so a note cuts the
//   release of the one before), and both pressed, solo unison (all six voices on one key).
// - Key transpose (+-1 octave in semitones: an offset quantized to semitones, before the portamento and the key follow);
//   the rear panel's tune (+-1/4 tone).
// - The PEDAL HOLD jack: Main's sustain output (MIDI CC 64) is the pedal: a voice whose key is let go keeps its gate while it is down
//   and its envelope still sounds (a voice that decayed to silence is let go, as on the original).
// Not on the card, and why:
// - Construction, kept at its values in the patch: the voice count (six, as the original), the chorus modules' settings,
//   the bass boost's level, the hold's threshold (the pedal plays it).
// - VOLUME: the Output module's level, outside the card.
// - The assign mode is two rows, `assign mode` (rotate is POLY 1, lowest is POLY 2; the Voicing's third choice, reuse, is
//   not the Juno's) and `unison`: a switch of the three would need the Voicing's settings on a Selector (D-635 keeps a
//   Voicing's settings off a shared row), in both engines.
// - Poly 2 with six keys down takes over a voice (the original then plays no more keys). Its assign control still needs to select
//   the allocator's no-steal setting together with lowest-free assignment.
// - The patch shift pedal jack, the tape interface, the memory and the MIDI function switch: hardware and storage, no part
//   of the sound (the editor keeps the patches).
// Over the FM-1's CPU (Tier 1 of issue #351, 2026-10-26: 194 % -> 177 %; module instances 136 -> 120 of 128): three
// oscillators per voice whose pitch moves every sample (portamento, the LFO) and the per-sample filter. Even with the
// Ladder (145 %) and no per-sample pitch (about 123 %) six voices do not fit, so it stays an XL (D-348 does not apply).
import { level, players, plugIn } from '../factory-build';
import type { Xl } from './xl';
import { aroundDef, edit, type Ed, type RowOpts } from './asm-edit';
import { ADSR_LONG, BEND_OCT, DEFS } from '../../src/modules';
import { paramUnit } from '../../src/patch';

// the FM-1 version's local module ids (src/assemblies/hera-6.json)
const LFO = 1, VIB = 2, PWM = 3, LFO_FILTER = 4, NOISE = 5, PART = 6, OSC = 7, SUB = 8, LADDER = 9, ENV = 10, VCA = 11, HPF = 12, CHORUS = 13, SCOPE = 14;
/** the quantizer's scales (modules.ts SCALES): chromatic */
const CHROMATIC = 0;
/** the high pass's cutoff, Hz, at the HPF's positions 2 and 3 (by ear) */
const HPF_2 = 240, HPF_3 = 720;
const cutoffUnit = (hz: number): number => paramUnit(DEFS.filter.params.find((d) => d.name === 'cutoff')!, hz);

/** a card row of named choices (a Selector's position) */
function named(e: Ed, label: string, module: number, names: string[], o: RowOpts = {}, also: number[] = []): void {
  e.param(label, module, 'pos', o);
  const r = e.def.params[e.def.params.length - 1];
  r.names = names;
  if (also.length) r.also = also.map((m) => ({ module: m, param: 'pos' }));
}

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
      // ---- the DCO: saw and pulse together, each through its switch (OSC becomes the pulse, a new saw beside it). The
      // pulse's switch takes the FM-1 version's cable into the filter, in its place.
      Object.assign(e.m(OSC).params, { wave: 3, level: 0.55 });
      const pulseOn = e.add('select', 2.5, 0.25, { count: 2, pos: 1 });
      const pulseCable = e.def.cables.find((c) => c.from.module === OSC && c.from.port === 'out' && c.to.module === LADDER)!;
      pulseCable.from = { module: pulseOn, port: 'out' };
      e.wire(OSC, 'out', pulseOn, 'in2');
      const saw = e.add('osc', 2, 0.5, { wave: 2, level: 0.55 });
      const sawOn = e.add('select', 2.5, 0.5, { count: 2, pos: 2 });
      e.wire(saw, 'out', sawOn, 'in2');
      e.wire(sawOn, 'out', LADDER, 'in');
      for (const o of [OSC, SUB, saw]) e.wire(dcoPitch, 'out', o, 'pitch');
      // ---- the LFO into the pitch per sample (the FM-1 version: the fine tune pin)
      e.unwire(VIB, 'out', OSC, 'p1');
      e.unwire(VIB, 'out', SUB, 'p1');
      e.wire(VIB, 'out', dcoMod, 'in');
      // ---- the filter: the Multimode, cutoff per sample, 1 octave per unit of its cv; each source by its own amount. The
      // polarity switch: a Selector between the envelope's amount and the same inverted
      e.retype(LADDER, 'filter', { cutoff: 1400, res: 0.15, cvamt: 1, track: 0 });
      e.unwire(ENV, 'env', LADDER, 'cv');
      const envAmt = e.add('scale', 3, 1.5, { gain: 2.2, offset: 0 });
      const polarity = e.add('scale', 3.5, 1.5, { gain: 1, offset: 0 });
      const inverted = e.add('scale', 3.25, 1.75, { gain: -1, offset: 0 });
      const polSwitch = e.add('select', 3.25, 1.5, { count: 2, pos: 1 });
      e.wire(ENV, 'env', envAmt, 'in');
      e.wire(envAmt, 'out', polSwitch, 'in1');
      e.wire(envAmt, 'out', inverted, 'in');
      e.wire(inverted, 'out', polSwitch, 'in2');
      e.wire(polSwitch, 'out', polarity, 'in');
      e.wire(polarity, 'out', LADDER, 'cv');
      const kybd = e.add('scale', 3, 2.5, { gain: 1, offset: 0 });
      e.wire(portaOn, 'out', kybd, 'in');
      e.wire(kybd, 'out', LADDER, 'cv');
      const vcfBend = e.add('scale', 1, 7, { gain: 0, offset: 0 });
      e.wire(vcfBend, 'out', LADDER, 'cv');
      e.input('bend', unbend, 'in', [dcoBend, 'in'], [vcfBend, 'in']);
      // ---- gate-mode amplitude stays up while hold is on and the envelope still sounds. Its Logic b is the hold
      // level (just under the threshold while hold is on, far below it while off) plus the envelope, so b is high while
      // hold is on and the envelope is above silence (1e-4); the gate is a or b. The pedal (Main's sustain) switches at MIDI value 64.
      const hold = e.add('logic', 1, 7.5, { thresh: 0.5 });
      const holdLevel = e.add('scale', 1.5, 7.5, { gain: 4.4999, offset: -4 });
      e.wire(hold, 'or', holdLevel, 'in');
      e.input('hold', hold, 'a');
      const gate = e.add('logic', 4.5, 2.5, { thresh: 0.5 });
      e.wire(PART, 'gate', gate, 'a');
      e.wire(holdLevel, 'out', gate, 'b');
      e.wire(ENV, 'env', gate, 'b');
      // Envelope hold keeps the original key-gate edges, so reused voices still attack.
      e.wire(gate, 'or', ENV, 'hold');
      // ---- the VCA by the envelope or the gate (a Selector: 1 ENV, 2 GATE)
      e.unwire(ENV, 'env', VCA, 'cv');
      const vcaMode = e.add('select', 4, 1, { count: 2, pos: 1 });
      e.wire(ENV, 'env', vcaMode, 'in1');
      e.wire(gate, 'or', vcaMode, 'in2');
      e.wire(vcaMode, 'out', VCA, 'cv');
      // ---- decay and release to 12 s as on the original: the ADSR's long times (x 2.4), set to sound as before
      Object.assign(e.m(ENV).params, { d: 0.8 / ADSR_LONG, r: 0.5 / ADSR_LONG, long: 1 });
      e.join('voice', PWM, porta, portaOn, dcoPitch, saw, sawOn, pulseOn, envAmt, inverted, polSwitch, polarity, kybd, gate, vcaMode);
      // the voice card's inputs: the pitch now goes into the portamento, the gate stays on the envelope and also drives gate-mode amplitude
      voice.inputs = voice.inputs.map((r) => (r.label === 'pitch' ? { module: porta, port: 'in', label: 'pitch', also: [{ module: portaOn, port: 'in1' }] } : r.label === 'gate' ? { module: ENV, port: 'gate', label: 'gate', also: [{ module: gate, port: 'a' }] } : r));
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
      // ---- the PWM slider and its mode switch (a Selector: 1 LFO, 2 MAN): on LFO the delayed LFO times the slider, on MAN
      // the slider less the width, into the pulse's width pin (0.5 plus the pin's value times the width's span, 0.9)
      Object.assign(e.m(PWM).params, { gain: 1 });
      const pwmSlider = e.add('macro', 0.5, 1.25, { value: 0.3 });
      const pwmLfo = e.add('vca', 0.5, 1.5, { gain: 1 });
      e.wire(delayed, 'out', pwmLfo, 'in');
      e.wire(pwmSlider, 'out', pwmLfo, 'cv');
      const pwmMan = e.add('scale', 0.5, 1.75, { gain: -0.5, offset: 0 });
      e.wire(pwmSlider, 'out', pwmMan, 'in');
      const pwmMode = e.add('select', 0.75, 1.5, { count: 2, pos: 1 });
      e.wire(pwmLfo, 'out', pwmMode, 'in1');
      e.wire(pwmMan, 'out', pwmMode, 'in2');
      e.wire(pwmMode, 'out', PWM, 'in');
      // ---- the bender lever's LFO: the mod wheel opens vibrato by its depth
      const lever = e.add('vca', 0, 4.5, { gain: 1 });
      e.wire(LFO, 'out', lever, 'in');
      e.input('wheel', lever, 'cv');
      const leverDepth = e.add('scale', 0.5, 4.5, { gain: 0.04, offset: 0 });
      e.wire(lever, 'out', leverDepth, 'in');
      e.wire(leverDepth, 'out', dcoMod, 'in');
      // ---- the HPF: four positions on a Selector, its value into the high pass's cutoff pin (in the cutoff's octaves) and
      // its first position's gate into the bass boost's level pin (a low pass of the voices mixed in beside the high pass)
      const boost = e.add('filter', 5, 1, { cutoff: 120, res: 0, cvamt: 1, track: 0 });
      e.wire(VCA, 'out', boost, 'in');
      const sum = e.add('mixer', 5.5, 0.5, { l1: 1, l2: 0, l3: 0, l4: 0 }, { p1: 'l2' });
      e.unwire(HPF, 'hp', CHORUS, 'in');
      e.unwire(HPF, 'hp', SCOPE, 'a');
      e.wire(HPF, 'hp', sum, 'in1');
      e.wire(boost, 'lp12', sum, 'in2');
      const hpf = e.add('select', 4.5, 0.5, { count: 4, pos: 2, v1: 0, v2: 0, v3: cutoffUnit(HPF_2) - cutoffUnit(20), v4: cutoffUnit(HPF_3) - cutoffUnit(20) });
      e.m(HPF).map!.p1 = ['cutoff'];
      e.wire(hpf, 'out', HPF, 'p1');
      e.wire(hpf, 'g1', sum, 'p1');
      // ---- the chorus: OFF (the dry voices), I (the FM-1 version's chorus) or II, a Selector per side
      const chorus2 = e.add('chorus', 6, 1.5, { rate: 0.8, depth: 0.9, mix: 0.5 });
      e.wire(sum, 'out', CHORUS, 'in');
      e.wire(sum, 'out', chorus2, 'in');
      e.wire(sum, 'out', SCOPE, 'a');
      const side = (port: 'l' | 'r', r: number): number => {
        const s = e.add('select', 6.5, r, { count: 3, pos: 2 });
        e.wire(sum, 'out', s, 'in1');
        e.wire(CHORUS, port, s, 'in2');
        e.wire(chorus2, port, s, 'in3');
        const o = e.def.outputs.find((x) => x.label === port)!;
        Object.assign(o, { module: s, port: 'out' });
        return s;
      };
      const chorusL = side('l', 0.5), chorusR = side('r', 1);

      // ---- the card: the Juno-106's controls, in its panel's order
      e.m(PART).params.voices = 6;
      e.def.params = [];
      e.param('rate', LFO, 'rate', { head: 'lfo' });
      e.param('delay time', delayEnv, 'a');
      named(e, 'range', range, ['16\'', '8\'', '4\''], { head: 'dco' });
      e.param('lfo', VIB, 'gain');
      e.param('pwm', pwmSlider, 'value');
      named(e, 'pwm mode', pwmMode, ['LFO', 'MAN']);
      named(e, 'pulse', pulseOn, ['OFF', 'ON']);
      named(e, 'saw', sawOn, ['OFF', 'ON']);
      e.param('sub', SUB, 'level');
      e.param('noise', NOISE, 'level');
      named(e, 'freq', hpf, ['0', '1', '2', '3'], { col: true, head: 'hpf' });
      e.param('freq', LADDER, 'cutoff', { head: 'vcf' });
      e.param('res', LADDER, 'res');
      named(e, 'polarity', polSwitch, ['POSITIVE', 'NEGATIVE']);
      e.param('env', envAmt, 'gain');
      e.param('lfo', LFO_FILTER, 'gain');
      e.param('kybd', kybd, 'gain');
      named(e, 'mode', vcaMode, ['ENV', 'GATE'], { col: true, head: 'vca' });
      e.param('level', VCA, 'gain');
      e.param('a', ENV, 'a', { head: 'env' });
      e.param('d', ENV, 'd');
      e.param('s', ENV, 's');
      e.param('r', ENV, 'r');
      named(e, 'chorus', chorusL, ['OFF', 'I', 'II'], { head: 'chorus' }, [chorusR]);
      e.param('dco', dcoBend, 'gain', { col: true, head: 'bender' });
      e.param('vcf', vcfBend, 'gain');
      e.param('lfo', leverDepth, 'gain');
      e.param('portamento', porta, 'time', { head: 'portamento' });
      named(e, 'porta switch', portaOn, ['OFF', 'ON']);
      e.param('assign mode', PART, 'assign', { head: 'keys' });
      e.param('unison', PART, 'unison');
      e.param('key transpose', transpose, 'value');
      e.param('tune', tune, 'value');
      // the voice card shows the card's rows of its own modules, and only those
      voice.params = e.def.params.filter((r) => voice.modules.includes(r.module)).map((r) => ({ module: r.module, param: r.param, label: r.label, ...(r.names ? { names: [...r.names] } : {}) }));
    });
    const x = aroundDef('Hera 6', def);
    plugIn(x.p, x.main.id, 'bend', x.a, 'bend');
    plugIn(x.p, x.main.id, 'sustain', x.a, 'hold'); // MIDI CC 64: 0..63 up, 64..127 down
    level(x.p, { chord: true });
    x.p.notes = NOTES;
    return players(x.p, true);
  },
};

const NOTES = "Juno-106 panel, six voices. MIDI CC 64 is the hold pedal; Output sets volume. Assign needs two rows: Selectors cannot set Voicing settings. Poly 2 steals when all voices are busy; its card still needs to select no-steal with Poly 2. HPF 2/3 and chorus II settings are approximated by ear. Patch shift, tape, memory and the MIDI function switch are hardware or storage, not reproduced.";
