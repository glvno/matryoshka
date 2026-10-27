// SPDX-License-Identifier: GPL-3.0-only
// 8 Lire XL: the SOMA Laboratory Lyra-8 as its user manual describes it (v2.1, 2020:
// https://somasynths.com/wp-content/uploads/2020/11/LYRA-8_manual_Eng_V2_1.pdf), where the FM-1's 8 Lire
// (gen-assemblies.ts) had to cut or guess. Eight voices in four pairs (1-2, 3-4, 5-6, 7-8) and two groups (1-4, 5-8).
//
// The card has the Lyra-8's 46 controls (the manual's "Controls description", numbered 1 to 23), one row each, named as
// the panel names them; a switch is a row of named positions (a Selector):
//  - per voice: TUNE (`tune 1`..`tune 8`, the oscillator's coarse tune in semitones);
//  - per pair: the FM modulation source switch (`source`: fm, off, lfo), MOD, SHARP, FAST (off, fast);
//  - per group: HOLD, PITCH;
//  - for all voices: the FM structure switch (`34>56 78>12`: off, on), TOTAL FB (off, on), VIBRATO (off, on);
//  - the Hyper LFO: FREQ A, FREQ B, AND / OR (and, or), LINK (off, on);
//  - the MOD DELAY: TIME 1, TIME 2, MOD 1, MOD 2, SELF / LFO (lfo, self), TRIANGLE / SQUARE, FB, MIX;
//  - the DISTORTION: DRIVE, MIX, VOL.
// Plus the Scope's screen (`out`), a display, not a control.
//
// How each part is built (none of this is on the card; its values stay set in the patch):
//  - each voice: a triangle that its pair's SHARP turns into a square (a Waveshaper per voice, so the shaped wave is also
//    what it sends to FM), its own envelope and its own vibrato LFO (eight, at eight rates), on with VIBRATO. The
//    manual's envelopes are fixed, so their attack and release are set per voice in the patch, as is a fine tune under
//    TUNE (the Lyra's TUNE is continuous; the row steps in semitones). The envelope is part of the voice, as the manual
//    says: it bends the pitch a little (up to 6 cents) and sharpens the wave a little as it opens;
//  - the plates (sensors 1..8): how hard a plate is touched (its velocity, held from the touch on, plus Main's
//    aftertouch as the pressure) sets how far its envelope opens and how fast: a light touch opens it partly and
//    slowly. How much is a Macro inside the assembly (0.5; 0 = every touch opens it fully). The Drum map holds each
//    plate's velocity from its touch on, whichever key played it;
//  - FAST down: the pair's release is short (flipping it cuts a ringing voice short), its plates need more pressure and
//    its HOLD needs a higher setting before the pair sounds;
//  - the source switch: FM from a pair of the other half of its group, off, or LFO CV (the Hyper LFO, or the output
//    with TOTAL FB). The FM structure switch: off, 1-2 and 3-4 modulate each other and so do 5-6 and 7-8; on, 3-4 also
//    drives 5-6 and 7-8 drives 1-2, one closed loop through all eight;
//  - the Hyper LFO: two triangles; AND multiplies their squares, OR adds them; LINK on puts FREQ A on FREQ B's rate
//    (a tenth of its travel: our choice, the manual gives no depth);
//  - the delay: two lines (TRIANGLE: the sum of the two LFO triangles; SQUARE: the AND square), one FB for both with
//    cross-feedback through a soft clip, and a little hiss (the manual's "noise and bleed" page: its delay is noisy);
//  - the crosstalk: every voice sounds faintly all the time (the same page), a floor under HOLD.
// Cables that close a loop (FM between pairs, TOTAL FB, the delay's cross-feedback and SELF) run one block late, as on
// the FM-1 version. SELF reads the line's output level (rectified), since a parameter input takes one value per block.
// The keys are as on the FM-1 version: one Drum map with `repeat` on puts the eight plates on the white keys from F3 and
// repeats them over the keybed in blocks of eight white keys, a black key playing the plate of the white key below it.
//
// The rear jacks are the assembly's inputs, for a cable from any module of the patch: EXT IN (mixed with the voices),
// HOLD GATE (scales both HOLDs), CV VOICES (replaces the LFO CV bus for the pairs set to lfo) and CV DELAY (replaces SELF
// / LFO as the delay lines' modulation). The Lyra-8 switches HOLD GATE, CV VOICES and CV DELAY over when a cable goes in
// its jack; the engines cannot tell that an input has a cable, so each has a crossfader (or Macro) inside the assembly,
// at 0 (nothing plugged): set it to 1 in the expanded assembly to use the jack. EXT IN needs no switch.
//
// Not here, and why (D-347's reasons): the switching of a jack by plugging it (the engines do not report a plugged
// input); EXT IN from outside the browser (a live audio input needs a new module type, an audio input in both engines);
// the phones and balanced outputs and the power (hardware); the plates' response to skin moisture (hardware: velocity
// and aftertouch stand in for it).
import { DEFS } from '../../src/modules';
import { connect, validatePatch, type Patch } from '../../src/patch';
import { players } from '../factory-build';
import { around, define, KIT_NOTES, matchLevel, type Built } from './def';
import type { Xl } from './xl';

/** a two-position switch as a Selector's table: position 1 plays 0, position 2 plays 1 */
const OFF_ON = { count: 2, v1: 0, v2: 1 };
/** how far LINK moves FREQ B's rate (the pin's attenuverter: the triangle of FREQ A times this much of the rate's travel) */
const LINK_FM = 0.1;

/** the names of each switch's positions, position 1 first (the Lyra-8's panel names only some of them) */
const NAMES: Record<string, string[]> = {
  source: ['fm', 'off', 'lfo'], fast: ['off', 'fast'], '34>56 78>12': ['off', 'on'], 'total fb': ['off', 'on'], vibrato: ['off', 'on'],
  'and / or': ['and', 'or'], link: ['off', 'on'], 'self / lfo': ['lfo', 'self'], 'tri / square': ['triangle', 'square'],
};

export function lireXl(keys: Record<string, number>): Built {
  const built = define('8 Lire XL', (b) => {
    const plate = b.add('drummap', 0, 0, { ...keys, repeat: 1 });
    b.module(plate).names = Array.from({ length: 8 }, (_, r) => `VOICE ${r + 1}`);   // (as the FM-1 version: the rows are the voices)
    // the Hyper LFO: two triangles; their squares (Logic, just above zero) multiplied (AND) or added (and + or = a + b)
    const lfoA = b.add('lfo', 0, 1, { wave: 1, rate: 0.7, depth: 1 });
    const lfoB = b.add('lfo', 0, 2, { wave: 1, rate: 1.9, depth: 1 });
    const link = b.add('select', 0, 3, { count: 2 }); // LINK: off, on (A into B's rate)
    const logic = b.add('logic', 0, 4, { thresh: 0.05 });
    const sum = b.add('mixer', 0, 5, { l1: 0.5, l2: 0.5, l3: 0, l4: 0 });
    const hyper = b.add('select', 1, 5, { count: 2 }); // AND / OR (the sum)
    const triSum = b.add('mixer', 2, 5, { l1: 0.5, l2: 0.5, l3: 0, l4: 0 });
    const dlyLfo = b.add('select', 3, 5, { count: 2 }); // TRIANGLE / SQUARE
    b.wire(lfoA, 'out', link, 'in2');
    b.wire(link, 'out', lfoB, 'p1');
    b.pin(lfoB, 'p1', 'rate');
    b.module(lfoB).att = [LINK_FM, 1];
    b.wire(lfoA, 'out', logic, 'a');
    b.wire(lfoB, 'out', logic, 'b');
    b.wire(logic, 'and', sum, 'in1');
    b.wire(logic, 'or', sum, 'in2');
    b.wire(logic, 'and', hyper, 'in1');
    b.wire(sum, 'out', hyper, 'in2');
    b.wire(lfoA, 'out', triSum, 'in1');
    b.wire(lfoB, 'out', triSum, 'in2');
    b.wire(triSum, 'out', dlyLfo, 'in1');
    b.wire(logic, 'and', dlyLfo, 'in2');
    // TOTAL FB: the LFO CV bus is the Hyper LFO or the output (after the distortion); CV VOICES (its crossfader at 1 =
    // a cable in the jack): the assembly's `cv voices` input replaces both
    const lfoCv = b.add('select', 4, 5, { count: 2 });
    const cvVoices = b.add('xfade', 4, 6, { mix: 0 });
    b.wire(hyper, 'out', lfoCv, 'in1');
    b.wire(lfoCv, 'out', cvVoices, 'a');
    // the switches that act on several places: Selectors as tables (0, 1), each wired or pinned where it acts
    const structure = b.add('select', 5, 5, OFF_ON);
    const vibrato = b.add('select', 6, 5, OFF_ON);
    const selfLfo = b.add('select', 7, 5, OFF_ON);
    const fb = b.add('macro', 8, 5, { value: 0.35 });
    const touch = b.add('macro', 9, 5, { value: 0.5 });
    const cvDelay = b.add('macro', 10, 5, { value: 0 });
    const sharp = [0, 1, 2, 3].map((p) => b.add('macro', 1 + 2 * p, 6, { value: 0.15 }));
    const fast = [0, 1, 2, 3].map((p) => b.add('select', 2 + 2 * p, 9, OFF_ON)); // 0 = up (off), 1 = down
    // groups: HOLD and PITCH; HOLD GATE (1 = a cable in the jack): the assembly's `hold gate` input scales both HOLDs
    const hold = [0, 1].map((g) => b.add('const', 2 + 4 * g, 4, { value: 0 }));
    const pitch = [0, 1].map((g) => b.add('const', 3 + 4 * g, 4, { value: 0 }));
    const one = b.add('const', 16, 1, { value: 1 });
    const minusOne = b.add('const', 16, 3, { value: -1 });
    const holdGate = b.add('xfade', 9, 4, { mix: 0 });
    b.wire(one, 'out', holdGate, 'a');
    // a pair's HOLD: its group's (times HOLD GATE), less 0.3 with FAST down, never below BLEED (the pair needs a higher
    // HOLD to sound)
    const holdPair = [0, 1, 2, 3].map((p) => {
      const h = b.add('math', 2 + 2 * p, 10, { ka: 1, kb: 1, off: 0 });
      b.wire(hold[p >> 1], 'out', h, 'a');
      b.wire(fast[p], 'out', h, 'p1');
      b.pin(h, 'p1', 'off', [0.5, 0.5 - 0.3 / 8]); // 0 .. -0.3, then `max` with b
      b.wire(holdGate, 'out', h, 'p2');
      b.pin(h, 'p2', 'ka', [0.5, 0.5 + 1 / 8]); // 0 .. 1
      return h;
    });
    const bleed = b.add('const', 9, 3, { value: 0.003 }); // the crosstalk: every voice sounds faintly all the time
    for (const h of holdPair) b.wire(bleed, 'out', h, 'b'); // (the floor under HOLD)
    // a pair's plate sensitivity: 1, or 0.7 with FAST down (a plate opens less, and so more slowly)
    const sens = fast.map((f, p) => {
      const s = b.add('scale', 2 + 2 * p, 11, { gain: -0.3, offset: 1 });
      b.wire(f, 'out', s, 'in');
      return s;
    });
    //               coarse  fine attack release vibrato rate
    const tunes: [number, number, number, number, number][] = [
      [-22, 0, 0.02, 1.2, 5.1], [-22, 7, 0.02, 1.2, 5.6], [-15, 0, 0.6, 2.5, 4.7], [-15, -6, 0.6, 2.5, 6.1],
      [-10, 0, 0.01, 0.6, 5.3], [-3, 4, 0.01, 0.6, 4.9], [0, 0, 0.9, 3, 5.8], [4, -3, 0.9, 3, 6.4],
    ];
    const voices = tunes.map(([coarse, fine, a, r, vib], i) => {
      const p = i >> 1;
      const osc = b.add('osc', 1 + i, 0, { wave: 1, coarse, fine, level: 0.5 });
      const shp = b.add('shape', 1 + i, 1, { drive: 1, mode: 0, level: 0.6 });
      const env = b.add('adsr', 1 + i, 2, { a, d: 0.2, s: 1, r });
      const vca = b.add('vca', 1 + i, 3, { gain: 1 });
      const vlfo = b.add('lfo', 1 + i, 7, { wave: 0, rate: vib, depth: 0 });
      b.wire(osc, 'out', shp, 'in');
      b.wire(shp, 'out', vca, 'in');
      b.wire(holdPair[p], 'max', vca, 'cv');
      b.wire(pitch[i >> 2], 'out', osc, 'pitch');
      b.wire(vlfo, 'out', osc, 'pitch');
      b.wire(sharp[p], 'out', shp, 'p1');
      b.pin(shp, 'p1', 'drive', [0, 0.8]); // triangle .. nearly square
      b.wire(vibrato, 'out', vlfo, 'p1');
      b.pin(vlfo, 'p1', 'depth', [0, 0.02]); // a quarter tone at the most
      // the envelope is part of the voice: up to 6 cents sharper and a little more drive as it opens
      b.wire(env, 'env', osc, 'p1');
      b.pin(osc, 'p1', 'fine');
      b.module(osc).att = [0.03, 1];
      b.wire(env, 'env', shp, 'p2');
      b.pin(shp, 'p2', 'drive');
      b.module(shp).att = [1, 0.05];
      // the touch: the plate's gate, and its velocity, which the Drum map holds from the touch on
      b.wire(plate, `g${i + 1}`, env, 'gate');
      // how far the plate opens the envelope: (1 - TOUCH + TOUCH x (velocity + pressure)) x the pair's sensitivity
      const open = b.add('math', 1 + i, 12, { ka: 0, kb: 1, off: 1 });
      b.wire(plate, `v${i + 1}`, open, 'a');
      b.wire(touch, 'out', open, 'p1');
      b.pin(open, 'p1', 'ka', [0.5, 0.5 + 1 / 8]); // 0 .. 1
      b.wire(touch, 'out', open, 'p2');
      b.pin(open, 'p2', 'off', [0.5 + 1 / 8, 0.5]); // 1 .. 0
      b.wire(sens[p], 'out', open, 'b');
      const level = b.add('math', 1 + i, 13, { ka: 1, kb: 1, off: 0 });
      b.wire(open, 'mul', level, 'a');
      b.wire(env, 'env', level, 'b');
      b.wire(level, 'mul', vca, 'cv');
      // a plate opened less also opens more slowly (attack + 0.3 x (1 - opening) of its range); FAST down shortens the
      // release (- 0.35 of its range: 1.2 s becomes 0.05 s)
      b.wire(open, 'mul', env, 'p1');
      b.wire(minusOne, 'out', env, 'p1');
      b.pin(env, 'p1', 'a');
      b.wire(fast[p], 'out', env, 'p2');
      b.pin(env, 'p2', 'r');
      b.module(env).att = [-0.3, -0.35];
      return { osc, shp, env, vca, vlfo, open, level };
    });
    // pairs: the FM source (another pair's voices, after their VCAs: an operator fades with its envelope), the source
    // switch (FM / off / LFO CV at 0 / 0.5 / 1: two Crossfaders, each moved twice as far as the switch: its value on the
    // pin and on `pos`) and MOD; pairs 1-2 and 5-6 choose their FM pair by the structure switch
    const pairOut = (p: number): number[] => [voices[2 * p].vca, voices[2 * p + 1].vca];
    const fmFrom = [[1, 3], [0], [3, 1], [2]]; // 1-2 <- 3-4 (up: 7-8), 3-4 <- 1-2, 5-6 <- 7-8 (up: 3-4), 7-8 <- 5-6
    const mods = fmFrom.map((from, p) => {
      let fm: number;
      if (from.length === 2) {
        fm = b.add('xfade', 1 + 2 * p, 8, { mix: 0 });
        for (const v of pairOut(from[0])) b.wire(v, 'out', fm, 'a');
        for (const v of pairOut(from[1])) b.wire(v, 'out', fm, 'b');
        b.wire(structure, 'out', fm, 'pos');
      } else {
        fm = b.add('mixer', 1 + 2 * p, 8, { l1: 1, l2: 1, l3: 0, l4: 0 });
        pairOut(from[0]).forEach((v, k) => b.wire(v, 'out', fm, `in${k + 1}`));
      }
      const sw = b.add('select', 1 + 2 * p, 9, { count: 3, v1: 0, v2: 0.5, v3: 1 }); // FM, off, LFO CV
      const fmOn = b.add('xfade', 1 + 2 * p, 10, { mix: 0 }); // the FM, faded out by 2 x (0 at 0.5 and up)
      b.wire(fm, 'out', fmOn, 'a');
      b.wire(sw, 'out', fmOn, 'p1');
      b.pin(fmOn, 'p1', 'mix');
      b.wire(sw, 'out', fmOn, 'pos');
      const src = b.add('xfade', 2 + 2 * p, 8, { mix: 0 }); // then LFO CV, faded in by 2 x - 1
      b.wire(fmOn, 'out', src, 'a');
      b.wire(cvVoices, 'out', src, 'b');
      b.wire(sw, 'out', src, 'p1');
      b.pin(src, 'p1', 'mix');
      b.wire(sw, 'out', src, 'pos');
      b.wire(minusOne, 'out', src, 'pos');
      const depth = b.add('scale', 2 + 2 * p, 6, { gain: 0, offset: 0 });
      b.wire(src, 'out', depth, 'in');
      for (const v of [voices[2 * p], voices[2 * p + 1]]) b.wire(depth, 'out', v.osc, 'pitch');
      return { sw, depth };
    });
    // the voices' mix (EXT IN joins it), then the MOD DELAY: two lines (wet only), each fed the voices, its hiss and the
    // other line through FB
    const mix = b.add('mixer', 9, 0, { l1: 0.7, l2: 0.7, l3: 0.7, l4: 0.7 });
    voices.forEach((v, i) => b.wire(v.vca, 'out', mix, `in${(i >> 1) + 1}`));
    const hiss = b.add('noise', 9, 2, { level: 0.003, color: 0 });
    const lines = [330, 470].map((time, k) => {
      const d = b.add('delay', 10, 2 * k, { time, fb: 0, mix: 1 });
      const cross = b.add('scale', 11, 2 * k, { gain: 0, offset: 0 });
      const clip = b.add('shape', 11, 2 * k + 1, { drive: 1, mode: 0, level: 1 });
      const self = b.add('math', 12, 2 * k, { ka: 1, kb: 0, off: 0 });
      const how = b.add('xfade', 12, 2 * k + 1, { mix: 0 }); // 0 = LFO, 1 = SELF
      const ext = b.add('xfade', 13, 2 * k + 1, { mix: 0 }); // 1 = CV DELAY (a cable in the jack)
      const depth = b.add('scale', 13, 2 * k, { gain: 0, offset: 0 });
      b.wire(mix, 'out', d, 'in');
      b.wire(hiss, 'out', d, 'in');
      b.wire(d, 'out', cross, 'in');
      b.wire(cross, 'out', clip, 'in');
      b.wire(d, 'out', self, 'a');
      b.wire(dlyLfo, 'out', how, 'a');
      b.wire(self, 'abs', how, 'b');
      b.wire(selfLfo, 'out', how, 'pos');
      b.wire(how, 'out', ext, 'a');
      b.wire(cvDelay, 'out', ext, 'pos');
      b.wire(ext, 'out', depth, 'in');
      b.wire(depth, 'out', d, 'p1');
      b.pin(d, 'p1', 'time');
      b.wire(fb, 'out', d, 'p2');
      b.pin(d, 'p2', 'fb', [0, 0.6]);
      b.wire(fb, 'out', cross, 'p1');
      b.pin(cross, 'p1', 'gain', [0.5, 0.5 + 0.6 / 8]); // 0 .. 0.6 into the other line
      return { d, clip, depth, ext };
    });
    b.wire(lines[0].clip, 'out', lines[1].d, 'in');
    b.wire(lines[1].clip, 'out', lines[0].d, 'in');
    const wet = b.add('mixer', 14, 0, { l1: 0.7, l2: 0.7, l3: 0, l4: 0 });
    b.wire(lines[0].d, 'out', wet, 'in1');
    b.wire(lines[1].d, 'out', wet, 'in2');
    const dlyMix = b.add('xfade', 14, 1, { mix: 0.35 });
    b.wire(mix, 'out', dlyMix, 'a');
    b.wire(wet, 'out', dlyMix, 'b');
    // the DISTORTION: DRIVE, MIX of clean and distorted, VOL
    const drive = b.add('shape', 15, 0, { drive: 1.5, mode: 0, level: 0.7 });
    const distMix = b.add('xfade', 15, 1, { mix: 1 });
    const vol = b.add('vca', 16, 0, { gain: 1 });
    b.wire(dlyMix, 'out', drive, 'in');
    b.wire(dlyMix, 'out', distMix, 'a');
    b.wire(drive, 'out', distMix, 'b');
    b.wire(distMix, 'out', vol, 'in');
    b.wire(one, 'out', vol, 'cv');
    b.wire(vol, 'out', lfoCv, 'in2'); // TOTAL FB
    const scope = b.add('scope', 16, 2, { time: 16 });
    b.wire(vol, 'out', scope, 'a');
    b.input('keys', plate, 'keys');
    // the plates' pressure (Main's aftertouch, wired by the XL) and the rear jacks
    b.input('pressure', voices[0].open, 'a', ...voices.slice(1).map((v) => [v.open, 'a'] as [number, string]));
    b.input('ext in', mix, 'in1');
    b.input('hold gate', holdGate, 'b');
    b.input('cv voices', cvVoices, 'b');
    b.input('cv delay', lines[0].ext, 'b', [lines[1].ext, 'b']);
    b.output('out', vol, 'out');

    // the card: the Lyra-8's controls, one row each, named as its panel names them (switches as named positions)
    for (const g of [0, 1]) {
      const name = g ? '5-8' : '1-4';
      b.param('hold', hold[g], 'value', { col: g === 1, head: name });
      b.param('pitch', pitch[g], 'value');
      for (const p of [2 * g, 2 * g + 1]) b.param(`source ${2 * p + 1}-${2 * p + 2}`, mods[p].sw, 'pos');
      for (const p of [2 * g, 2 * g + 1]) b.param(`mod ${2 * p + 1}-${2 * p + 2}`, mods[p].depth, 'gain', p === 2 * g ? { group: true } : {});
      for (const p of [2 * g, 2 * g + 1]) b.param(`sharp ${2 * p + 1}-${2 * p + 2}`, sharp[p], 'value');
      for (const p of [2 * g, 2 * g + 1]) b.param(`fast ${2 * p + 1}-${2 * p + 2}`, fast[p], 'pos', p === 2 * g ? { group: true } : {});
    }
    b.param('34>56 78>12', structure, 'pos', { head: 'all voices' });
    b.param('total fb', lfoCv, 'pos');
    b.param('vibrato', vibrato, 'pos');
    b.param('freq a', lfoA, 'rate', { col: true, head: 'hyper lfo' });
    b.param('freq b', lfoB, 'rate');
    b.param('and / or', hyper, 'pos');
    b.param('link', link, 'pos');
    b.param('time 1', lines[0].d, 'time', { head: 'mod delay' });
    b.param('time 2', lines[1].d, 'time');
    b.param('mod 1', lines[0].depth, 'gain');
    b.param('mod 2', lines[1].depth, 'gain');
    b.param('self / lfo', selfLfo, 'pos', { group: true });
    b.param('tri / square', dlyLfo, 'pos');
    b.param('fb', fb, 'value');
    b.param('mix', dlyMix, 'mix');
    b.param('drive', drive, 'drive', { head: 'distortion' });
    b.param('mix', distMix, 'mix');
    b.param('vol', vol, 'gain');
    voices.forEach((v, i) => b.param(`tune ${i + 1}`, v.osc, 'coarse', i === 0 ? { col: true, head: 'tune' } : i === 4 ? { group: true } : {}));
    b.param('out', scope, 'view', { col: true });
  });
  for (const r of built.def.params) {
    const names = NAMES[r.label.replace(/ \d-\d$/, '')];
    if (names) r.names = names;
  }
  return built;
}

/** the rows of the FM-1 version's Drum map (the plates' keys, which it repeats over the keybed) */
export const platesOf = (fm1: Patch): Record<string, number> => {
  const map = fm1.modules.find((m) => m.type === 'drummap');
  if (!map) throw new Error(`${fm1.name}: no Drum map`);
  return Object.fromEntries(Object.entries(map.params).filter(([k]) => /^n\d$/.test(k)));
};

/** the patch's notes (Patch.notes, at most 500 characters) */
const NOTES =
  'The SOMA Lyra-8 after its manual (v2.1). The card is its 46 controls: TUNE per voice; source (FM / off / LFO), MOD, SHARP, FAST per pair; HOLD, PITCH per group; 34>56 78>12, TOTAL FB, VIBRATO; the Hyper LFO; the MOD DELAY; the DISTORTION. The rear jacks are inputs; the Lyra switches them by plugging, here a crossfader inside the assembly (0 = unplugged). Not here: outside audio into EXT IN (no audio input module), the plates\' skin response (velocity and aftertouch stand in).';

export const xl: Xl = {
  base: '8 Lire',
  build: (fm1) => {
    const x = around('8 Lire XL', lireXl(platesOf(fm1)));
    x.p.octave = -1;
    // the plates' pressure: Main's aftertouch
    const pressure = x.a.inputs.find((r) => r.label === 'pressure') as { module: number; port: string; also?: { module: number; port: string }[] };
    for (const t of [pressure, ...(pressure.also ?? [])])
      if (!connect(x.p, DEFS, { module: x.main.id, port: 'at' }, { module: t.module, port: t.port })) throw new Error('8 Lire XL: no pressure cable');
    matchLevel(x.p, fm1, KIT_NOTES);
    x.p.notes = NOTES;
    return players(validatePatch(x.p, DEFS), true);
  },
};
