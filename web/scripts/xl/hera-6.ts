// SPDX-License-Identifier: GPL-3.0-only
// Hera 6 XL: the Juno-106 as its owner's manual describes it, where the FM-1 version (scripts/gen-assemblies.ts, Hera 6)
// had to cut. Source: Roland Juno-106 Owner's Manual (DCO, HPF, VCF, VCA, LFO, Bender sections).
// - Each voice's low pass follows its envelope and the LFO per sample: the Multimode's 24 dB low pass in place of the
//   Ladder, whose cutoff moves once per 128-sample block. The LFO reaches the DCO's pitch per sample too (the FM-1 version:
//   the fine tune, once per block).
// - The DCO's saw and pulse sound together (the manual: "each switch can be individually turned on or off").
// - The VCF envelope's polarity switch (an attenuverter: -1 inverts the envelope).
// - The VCA by the envelope or by the gate.
// - The LFO's delay time (the LFO fades in after a key is pressed; an envelope on a VCA after the LFO, keyed by a one-voice
//   allocator that holds while any key is down).
// - The HPF's position 0, the bass boost (a low pass at 120 Hz mixed back in).
// - The bender lever's LFO: Main's mod wheel brings in vibrato by the LFO modulation depth.
// Kept as on the FM-1 version: six voices, the chorus (its rate and depth reach the original's I and II), the K1..K4
// pages. Not here: the DCO range switch (Main's octave does that).
import { level, players } from '../factory-build';
import type { Xl } from './xl';
import { aroundDef, edit } from './asm-edit';

// the FM-1 version's local module ids (src/assemblies/hera-6.json)
const LFO = 1, VIB = 2, PWM = 3, LFO_FILTER = 4, PART = 6, OSC = 7, SUB = 8, LADDER = 9, ENV = 10, VCA = 11, HPF = 12, CHORUS = 13, SCOPE = 14;

export const xl: Xl = {
  base: 'Hera 6',
  build: () => {
    const def = edit('Hera 6', (e) => {
      // ---- the filter: the Multimode, cutoff per sample; the envelope through the polarity attenuverter
      e.retype(LADDER, 'filter', { cutoff: 1400, res: 0.15, cvamt: 2.2, track: 1 });
      e.unwire(ENV, 'env', LADDER, 'cv');
      const polarity = e.add('scale', 3, 1.5, { gain: 1, offset: 0 });
      e.wire(ENV, 'env', polarity, 'in');
      e.wire(polarity, 'out', LADDER, 'cv');
      // ---- the DCO: saw and pulse together (OSC becomes the pulse, a new saw beside it)
      Object.assign(e.m(OSC).params, { wave: 3, level: 0 });
      const saw = e.add('osc', 2, 0.5, { wave: 2, level: 0.55 });
      e.wire(PART, 'pitch', saw, 'pitch');
      e.wire(saw, 'out', LADDER, 'in');
      // ---- the LFO into the pitch per sample (the FM-1 version: the fine tune pin); 1/6 octave = the pin's 200 cents
      e.unwire(VIB, 'out', OSC, 'p1');
      e.unwire(VIB, 'out', SUB, 'p1');
      for (const o of [OSC, SUB, saw]) e.wire(VIB, 'out', o, 'pitch');
      // ---- the VCA by the envelope or the gate
      e.unwire(ENV, 'env', VCA, 'cv');
      const vcaMode = e.add('xfade', 4, 1, { mix: 0 });
      e.wire(ENV, 'env', vcaMode, 'a');
      e.wire(PART, 'gate', vcaMode, 'b');
      e.wire(vcaMode, 'out', VCA, 'cv');
      e.join('voice', polarity, saw, vcaMode);
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
      for (const s of [VIB, PWM, LFO_FILTER]) e.wire(delayed, 'out', s, 'in');
      // ---- the bender lever's LFO: the mod wheel opens vibrato by its depth
      const lever = e.add('vca', 0, 4.5, { gain: 1 });
      e.wire(LFO, 'out', lever, 'in');
      e.input('wheel', lever, 'cv');
      const leverDepth = e.add('scale', 0.5, 4.5, { gain: 0.04, offset: 0 });
      e.wire(lever, 'out', leverDepth, 'in');
      for (const o of [OSC, SUB, saw]) e.wire(leverDepth, 'out', o, 'pitch');
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
      // ---- the card: the FM-1 version's rows, the DCO's wave choice now two levels, then the new sections
      e.rebind(e.rowAt('wave'), 'saw', saw, 'level');
      e.insertRow(e.rowAt('saw') + 1, 'pulse', OSC, 'level');
      e.param('lfo delay', delayEnv, 'a', { col: true, head: 'lfo delay · lever' });
      e.param('lever lfo', leverDepth, 'gain');
      e.param('env polarity', polarity, 'gain', { head: 'vcf · vca' });
      e.param('vca gate', vcaMode, 'mix');
      e.param('bass boost', sum, 'l2');
    });
    const x = aroundDef('Hera 6', def);
    x.set('voices', 6);
    level(x.p, { chord: true });
    x.p.notes = NOTES;
    return players(x.p, true);
  },
};

const NOTES =
  'The Juno-106 as its owner’s manual describes it: each voice’s 24 dB low pass follows its envelope and the LFO per sample, the LFO reaches the pitch per sample, saw and pulse together, the envelope polarity switch, the VCA by envelope or gate, the LFO delay, the HPF’s bass boost, the bender lever’s LFO on the mod wheel. Six voices, as the original. Chorus I or II: its rate and depth.';
