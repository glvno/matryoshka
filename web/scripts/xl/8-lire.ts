// SPDX-License-Identifier: GPL-3.0-only
// 8 Lire XL: the SOMA Laboratory Lyra-8 as its user manual describes it (v2.1, 2020:
// https://somasynths.com/wp-content/uploads/2020/11/LYRA-8_manual_Eng_V2_1.pdf), where the FM-1's 8 Lire
// (gen-assemblies.ts) had to cut or guess. Eight voices in four pairs (1-2, 3-4, 5-6, 7-8) and two groups (1-4, 5-8):
//  - each voice: TUNE (coarse / fine), its own envelope (attack / release per voice here: the Lyra's are fixed), a
//    triangle that its pair's SHARP turns into a square (a Waveshaper per voice, so the shaped wave is also what it sends
//    to FM), and its own vibrato LFO (eight, at eight rates), on with VIBRATO. The envelope is part of the voice, as the
//    manual says: it bends the pitch a little (up to 6 cents) as it opens;
//  - the plates: how hard a plate is touched (Main's velocity, plus its aftertouch as the pressure) sets how far the
//    envelopes open and how fast: a light touch opens them partly and slowly. TOUCH sets how much (0 = every touch opens
//    fully). The velocity is the last key's, for all eight: one held per plate would need a product per copy of the
//    plate (32 more modules, past what a share link holds); one Drum map repeating its rows (#184) gives it for free;
//  - each pair: SHARP, MOD (depth), the modulation source switch (up FM from a pair of the other half of its group,
//    centre off, down LFO CV: the Hyper LFO, or the output with TOTAL FB) and FAST: down, the pair's release is short
//    (flipping it cuts a ringing voice short), its plates need more pressure (they open less and more slowly) and its
//    HOLD needs a higher setting before the pair sounds;
//  - each group: HOLD (the voices' floor) and PITCH (a transposition that keeps the intervals);
//  - the FM structure switch (34>56 78>12): down, 1-2 and 3-4 modulate each other and so do 5-6 and 7-8; up, 3-4 also
//    drives 5-6 and 7-8 drives 1-2, one closed loop through all eight;
//  - the Hyper LFO: FREQ A, FREQ B, AND / OR (the two squares multiplied or added) and LINK (A modulates B's rate);
//  - the MOD DELAY: two lines, TIME 1 / TIME 2, a MOD depth each, SELF / LFO (the time modulated by the line's own
//    output, or the LFO), TRIANGLE / SQUARE (the LFO for the delay: the sum of two triangles at FREQ A and B, or the AND
//    square), one FB for both lines with cross-feedback (each line also feeds the other, through a soft clip so it can
//    self-oscillate without running away), MIX, and its hiss (HISS: the manual's lo-fi delay is noisy);
//  - the DISTORTION after the delay: DRIVE, MIX (clean / distorted), VOL; mono out;
//  - the crosstalk: BLEED keeps every voice faintly sounding, as the manual's "noise and bleed" page describes;
//  - the rear jacks, as the assembly's inputs (a cable from any module of the patch): EXT IN (mixed with the voices,
//    so through the delay and distortion, and into TOTAL FB and SELF), HOLD GATE (scales both HOLDs), CV VOICES (replaces
//    the LFO CV bus for the pairs set to LFO CV) and CV DELAY (replaces SELF / LFO as the delay lines' modulation). The
//    Lyra switches each on by a cable in the jack; here a row says the jack is plugged (HOLD GATE, CV VOICES, CV DELAY).
// Switches are rows 0..1 (a Crossfader or a Macro: in between mixes the two positions; the three-way source switch is
// FM at 0, off at 0.5, LFO CV at 1). Cables that close a loop (FM between pairs, TOTAL FB, the delay's cross-feedback and
// SELF) run one block late, as on the FM-1 version. SELF reads the line's output level (rectified), since a parameter
// input takes one value per block. The keys stay as on the FM-1 version: four Drum maps put the eight plates on the white
// keys from F3, repeated over the keybed (#184 will let one map repeat its rows). Not here: EXT IN from outside the
// browser (a live audio input needs a new module type, an audio input in both engines), the phones and balanced outputs
// and the power (hardware), the plates' response to skin moisture (hardware: velocity and aftertouch stand in for it).
import { DEFS } from '../../src/modules';
import { connect, validatePatch, type Patch } from '../../src/patch';
import { players } from '../factory-build';
import { around, define, KIT_NOTES, matchLevel, type Built } from './def';
import type { Xl } from './xl';

export function lireXl(maps: Record<string, number>[]): Built {
  return define('8 Lire XL', (b) => {
    const plate = maps.map((keys, i) => b.add('drummap', 0, [6, 0, 7, 8][i] ?? 9 + i, keys));
    for (const map of plate) b.module(map).names = Array.from({ length: 8 }, (_, r) => `VOICE ${r + 1}`);   // (as the FM-1 version: the rows are the voices)
    // the Hyper LFO: two triangles; their squares (Logic, just above zero) multiplied (AND) or added (and + or = a + b)
    const lfoA = b.add('lfo', 0, 1, { wave: 1, rate: 0.7, depth: 1 });
    const lfoB = b.add('lfo', 0, 2, { wave: 1, rate: 1.9, depth: 1 });
    const link = b.add('scale', 0, 3, { gain: 0, offset: 0 });
    const logic = b.add('logic', 0, 4, { thresh: 0.05 });
    const sum = b.add('mixer', 0, 5, { l1: 0.5, l2: 0.5, l3: 0, l4: 0 });
    const hyper = b.add('xfade', 1, 5, { mix: 0 }); // 0 = AND, 1 = OR (the sum)
    const triSum = b.add('mixer', 2, 5, { l1: 0.5, l2: 0.5, l3: 0, l4: 0 });
    const dlyLfo = b.add('xfade', 3, 5, { mix: 0 }); // 0 = triangle, 1 = square
    b.wire(lfoA, 'out', link, 'in');
    b.wire(link, 'out', lfoB, 'p1');
    b.pin(lfoB, 'p1', 'rate');
    b.wire(lfoA, 'out', logic, 'a');
    b.wire(lfoB, 'out', logic, 'b');
    b.wire(logic, 'and', sum, 'in1');
    b.wire(logic, 'or', sum, 'in2');
    b.wire(logic, 'and', hyper, 'a');
    b.wire(sum, 'out', hyper, 'b');
    b.wire(lfoA, 'out', triSum, 'in1');
    b.wire(lfoB, 'out', triSum, 'in2');
    b.wire(triSum, 'out', dlyLfo, 'a');
    b.wire(logic, 'and', dlyLfo, 'b');
    // TOTAL FB: the LFO CV bus is the Hyper LFO or the output (after the distortion); CV VOICES (1 = a cable in the
    // jack): the assembly's `cv voices` input replaces both
    const lfoCv = b.add('xfade', 4, 5, { mix: 0 });
    const cvVoices = b.add('xfade', 4, 6, { mix: 0 });
    b.wire(hyper, 'out', lfoCv, 'a');
    b.wire(lfoCv, 'out', cvVoices, 'a');
    // the switches that act on several places: Macros, each pinned where it acts
    const structure = b.add('macro', 5, 5, { value: 0 });
    const vibrato = b.add('macro', 6, 5, { value: 0 });
    const selfLfo = b.add('macro', 7, 5, { value: 0 });
    const fb = b.add('macro', 8, 5, { value: 0.35 });
    const touch = b.add('macro', 9, 5, { value: 0.5 });
    const cvDelay = b.add('macro', 10, 5, { value: 0 });
    const sharp = [0, 1, 2, 3].map((p) => b.add('macro', 1 + 2 * p, 6, { value: 0.15 }));
    const fast = [0, 1, 2, 3].map((p) => b.add('macro', 2 + 2 * p, 9, { value: 0 })); // 0 = up (off), 1 = down
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
    // the touch: how far a plate opens the envelope, min(1 - TOUCH + TOUCH x (velocity + pressure), 1) (Main's velocity
    // and aftertouch, wired by the XL), times the pair's sensitivity: 1, or 0.7 with FAST down
    const touched = b.add('math', 10, 4, { ka: 0, kb: 1, off: 1 });
    b.wire(touch, 'out', touched, 'p1');
    b.pin(touched, 'p1', 'ka', [0.5, 0.5 + 1 / 8]); // 0 .. 1
    b.wire(touch, 'out', touched, 'p2');
    b.pin(touched, 'p2', 'off', [0.5 + 1 / 8, 0.5]); // 1 .. 0
    b.wire(one, 'out', touched, 'b');
    const opens = fast.map((f, p) => {
      const o = b.add('math', 2 + 2 * p, 11, { ka: -0.3, kb: 1, off: 1 });
      b.wire(f, 'out', o, 'a');
      b.wire(touched, 'min', o, 'b');
      return o;
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
      // the envelope is part of the voice: up to 6 cents sharper as it opens
      b.wire(env, 'env', osc, 'p1');
      b.pin(osc, 'p1', 'fine');
      b.module(osc).att = [0.03, 1];
      for (const m of plate) b.wire(m, `g${i + 1}`, env, 'gate'); // (any copy of the plate holds the gate up)
      // the envelope, opened as far as the touch says
      const level = b.add('math', 1 + i, 12, { ka: 1, kb: 1, off: 0 });
      b.wire(opens[p], 'mul', level, 'a');
      b.wire(env, 'env', level, 'b');
      b.wire(level, 'mul', vca, 'cv');
      // a plate opened less also opens more slowly (attack + 0.3 x (1 - opening) of its range); FAST down shortens the
      // release (- 0.35 of its range: 1.2 s becomes 0.05 s)
      b.wire(opens[p], 'mul', env, 'p1');
      b.wire(minusOne, 'out', env, 'p1');
      b.pin(env, 'p1', 'a');
      b.wire(fast[p], 'out', env, 'p2');
      b.pin(env, 'p2', 'r');
      b.module(env).att = [-0.3, -0.35];
      return { osc, shp, env, vca, vlfo, level };
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
      const sw = b.add('macro', 1 + 2 * p, 9, { value: 0 });
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
    b.wire(vol, 'out', lfoCv, 'b'); // TOTAL FB
    const scope = b.add('scope', 16, 2, { time: 16 });
    b.wire(vol, 'out', scope, 'a');
    voices.forEach((v, i) => b.nest(`voice ${i + 1}`, 1 + i, 0, [v.osc, v.shp, v.env, v.vca, v.vlfo, v.level], {
      inputs: [['mod', v.osc, 'pitch'], ['hold', v.vca, 'cv'], ['sharp', v.shp, 'p1'], ['vibrato', v.vlfo, 'p1']],
      outputs: [['out', v.vca, 'out']],
    }));
    b.input('keys', plate[1], 'keys', ...plate.filter((_, i) => i !== 1).map((m) => [m, 'keys'] as [number, string]));
    // the touch (Main's velocity and aftertouch, wired by the XL) and the rear jacks
    b.input('touch', touched, 'a');
    b.input('ext in', mix, 'in1');
    b.input('hold gate', holdGate, 'b');
    b.input('cv voices', cvVoices, 'b');
    b.input('cv delay', lines[0].ext, 'b', [lines[1].ext, 'b']);
    b.output('out', vol, 'out');

    // the card: the FM-1 version's pages first where they still stand, then the rest
    for (const g of [0, 1]) {
      const name = g ? '5-8' : '1-4';
      b.param('hold', hold[g], 'value', { col: g === 1, head: name });
      b.param('pitch', pitch[g], 'value');
      for (const p of [2 * g, 2 * g + 1]) b.param(`source ${2 * p + 1}-${2 * p + 2}`, mods[p].sw, 'value');
      for (const p of [2 * g, 2 * g + 1]) b.param(`mod ${2 * p + 1}-${2 * p + 2}`, mods[p].depth, 'gain', p === 2 * g ? { group: true } : {});
      for (const p of [2 * g, 2 * g + 1]) b.param(`sharp ${2 * p + 1}-${2 * p + 2}`, sharp[p], 'value');
      for (const p of [2 * g, 2 * g + 1]) b.param(`fast ${2 * p + 1}-${2 * p + 2}`, fast[p], 'value', p === 2 * g ? { group: true } : {});
    }
    b.param('34>56 78>12', structure, 'value', { head: 'all voices' });
    b.param('total fb', lfoCv, 'mix');
    b.param('vibrato', vibrato, 'value');
    b.param('touch', touch, 'value');
    b.param('bleed', bleed, 'value');
    b.param('freq a', lfoA, 'rate', { col: true, head: 'hyper lfo' });
    b.param('freq b', lfoB, 'rate');
    b.param('and / or', hyper, 'mix');
    b.param('link', link, 'gain');
    b.param('time 1', lines[0].d, 'time', { head: 'delay' });
    b.param('time 2', lines[1].d, 'time');
    b.param('mod 1', lines[0].depth, 'gain');
    b.param('mod 2', lines[1].depth, 'gain');
    b.param('lfo / self', selfLfo, 'value', { group: true });
    b.param('tri / sq', dlyLfo, 'mix');
    b.param('feedback', fb, 'value');
    b.param('mix', dlyMix, 'mix');
    b.param('hiss', hiss, 'level');
    b.param('drive', drive, 'drive', { head: 'distortion' });
    b.param('mix', distMix, 'mix');
    b.param('vol', vol, 'gain');
    b.param('hold gate', holdGate, 'mix', { head: 'jacks' });
    b.param('cv voices', cvVoices, 'mix');
    b.param('cv delay', cvDelay, 'value');
    voices.forEach((v, i) => {
      b.param('tune', v.osc, 'coarse', { head: `voice ${i + 1}`, ...(i % 4 === 0 ? { col: true } : {}) });
      b.param('fine', v.osc, 'fine');
      b.param('attack', v.env, 'a');
      b.param('release', v.env, 'r');
    });
    b.param('out', scope, 'view', { col: true });
  });
}

/** the Drum maps' rows of the FM-1 version, in its order (the plates' keys) */
export const platesOf = (fm1: Patch): Record<string, number>[] =>
  fm1.modules.filter((m) => m.type === 'drummap').map((m) => Object.fromEntries(Object.entries(m.params).filter(([k]) => /^n\d$/.test(k))));

/** the patch's notes (Patch.notes, at most 500 characters) */
const NOTES =
  'The SOMA Lyra-8 in full, after its manual (v2.1): two delay lines with cross-feedback, LFO / SELF, TRI / SQ and hiss, the distortion after it, FM / off / LFO per pair, FAST per pair, the 34>56 78>12 switch, PITCH and HOLD per group, TOTAL FB, VIBRATO, the Hyper LFO, touch (velocity and aftertouch open the envelopes), bleed. The rear jacks are inputs of the assembly, each with a "plugged" row. Switches are 0..1 rows (the source switch: FM 0, off 0.5, LFO 1).';

export const xl: Xl = {
  base: '8 Lire',
  build: (fm1) => {
    const x = around('8 Lire XL', lireXl(platesOf(fm1)));
    x.p.octave = -1;
    // the touch: Main's velocity and aftertouch
    const t = x.a.inputs.find((r) => r.label === 'touch')!;
    for (const port of ['vel', 'at'])
      if (!connect(x.p, DEFS, { module: x.main.id, port }, { module: t.module, port: t.port })) throw new Error(`8 Lire XL: no ${port} cable`);
    matchLevel(x.p, fm1, KIT_NOTES);
    x.p.notes = NOTES;
    return players(validatePatch(x.p, DEFS), true);
  },
};
