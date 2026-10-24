// SPDX-License-Identifier: GPL-3.0-only
// 8 Lire XL: the SOMA Laboratory Lyra-8 as its user manual (v2.x, somasynths.com) describes it, where the FM-1's 8 Lire
// (gen-assemblies.ts) had to cut or guess. Eight voices in four pairs (1-2, 3-4, 5-6, 7-8) and two groups (1-4, 5-8):
//  - each voice: TUNE (coarse / fine), its own envelope (attack / release: the FAST switch's two speeds, per voice here),
//    a triangle that its pair's SHARP turns into a square (a Waveshaper per voice, so the shaped wave is also what it
//    sends to FM), and its own vibrato LFO (eight, at eight rates), on with VIBRATO;
//  - each pair: SHARP, MOD (depth) and the modulation source (FM from a pair of the other half of its group, or LFO CV:
//    the Hyper LFO, or the output with TOTAL FB);
//  - each group: HOLD (the voices' floor) and PITCH (a transposition that keeps the intervals);
//  - the FM structure switch (34>56 78>12): down, 1-2 and 3-4 modulate each other and so do 5-6 and 7-8; up, 3-4 also
//    drives 5-6 and 7-8 drives 1-2, one closed loop through all eight;
//  - the Hyper LFO: FREQ A, FREQ B, AND / OR (the two squares multiplied or added) and LINK (A modulates B's rate);
//  - the MOD DELAY: two lines, TIME 1 / TIME 2, a MOD depth each, SELF / LFO (the time modulated by the line's own
//    output, or the LFO), TRIANGLE / SQUARE (the LFO for the delay: the sum of two triangles at FREQ A and B, or the AND
//    square), one FB for both lines with cross-feedback (each line also feeds the other, through a soft clip so it can
//    self-oscillate without running away), MIX;
//  - the DISTORTION after the delay: DRIVE, MIX (clean / distorted), VOL; mono out.
// Switches are rows 0..1 (a Crossfader or a Macro: in between mixes the two positions). Cables that close a loop (FM
// between pairs, TOTAL FB, the delay's cross-feedback and SELF) run one block late, as on the FM-1 version. SELF reads the
// line's output level (rectified), since a parameter input takes one value per block. The keys stay as on the FM-1
// version: four Drum maps put the eight plates on the white keys from F3, repeated over the keybed (#184 will let one map
// repeat its rows). Not here: the rear jacks (EXT IN, HOLD GATE, CV DELAY, CV VOICES) and the touch plates' pressure.
import { DEFS } from '../../src/modules';
import { validatePatch, type Patch } from '../../src/patch';
import { players } from '../factory-build';
import { around, define, KIT_NOTES, matchLevel, type Built } from './def';
import type { Xl } from './xl';

export function lireXl(maps: Record<string, number>[]): Built {
  return define('8 Lire XL', (b) => {
    const plate = maps.map((keys, i) => b.add('drummap', 0, [6, 0, 7, 8][i] ?? 9 + i, keys));
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
    // TOTAL FB: the LFO CV bus is the Hyper LFO or the output (after the distortion)
    const lfoCv = b.add('xfade', 4, 5, { mix: 0 });
    b.wire(hyper, 'out', lfoCv, 'a');
    // the switches that act on several places: Macros, each pinned where it acts
    const structure = b.add('macro', 5, 5, { value: 0 });
    const vibrato = b.add('macro', 6, 5, { value: 0 });
    const selfLfo = b.add('macro', 7, 5, { value: 0 });
    const fb = b.add('macro', 8, 5, { value: 0.35 });
    const sharp = [0, 1, 2, 3].map((p) => b.add('macro', 1 + 2 * p, 6, { value: 0.15 }));
    // groups: HOLD and PITCH
    const hold = [0, 1].map((g) => b.add('const', 2 + 4 * g, 4, { value: 0 }));
    const pitch = [0, 1].map((g) => b.add('const', 3 + 4 * g, 4, { value: 0 }));
    //               coarse  fine attack release vibrato rate
    const tunes: [number, number, number, number, number][] = [
      [-22, 0, 0.02, 1.2, 5.1], [-22, 7, 0.02, 1.2, 5.6], [-15, 0, 0.6, 2.5, 4.7], [-15, -6, 0.6, 2.5, 6.1],
      [-10, 0, 0.01, 0.6, 5.3], [-3, 4, 0.01, 0.6, 4.9], [0, 0, 0.9, 3, 5.8], [4, -3, 0.9, 3, 6.4],
    ];
    const voices = tunes.map(([coarse, fine, a, r, vib], i) => {
      const osc = b.add('osc', 1 + i, 0, { wave: 1, coarse, fine, level: 0.5 });
      const shp = b.add('shape', 1 + i, 1, { drive: 1, mode: 0, level: 0.6 });
      const env = b.add('adsr', 1 + i, 2, { a, d: 0.2, s: 1, r });
      const vca = b.add('vca', 1 + i, 3, { gain: 1 });
      const vlfo = b.add('lfo', 1 + i, 7, { wave: 0, rate: vib, depth: 0 });
      b.wire(osc, 'out', shp, 'in');
      b.wire(shp, 'out', vca, 'in');
      b.wire(env, 'env', vca, 'cv');
      b.wire(hold[i >> 2], 'out', vca, 'cv');
      b.wire(pitch[i >> 2], 'out', osc, 'pitch');
      b.wire(vlfo, 'out', osc, 'pitch');
      b.wire(sharp[i >> 1], 'out', shp, 'p1');
      b.pin(shp, 'p1', 'drive', [0, 0.8]); // triangle .. nearly square
      b.wire(vibrato, 'out', vlfo, 'p1');
      b.pin(vlfo, 'p1', 'depth', [0, 0.02]); // a quarter tone at the most
      for (const m of plate) b.wire(m, `g${i + 1}`, env, 'gate'); // (any copy of the plate holds the gate up)
      return { osc, shp, env, vca, vlfo };
    });
    // pairs: the FM source (another pair's voices, after their VCAs: an operator fades with its envelope), the source
    // switch (FM / LFO CV) and MOD; pairs 1-2 and 5-6 choose their FM pair by the structure switch
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
      const src = b.add('xfade', 2 + 2 * p, 8, { mix: 0 }); // 0 = FM, 1 = LFO CV
      b.wire(fm, 'out', src, 'a');
      b.wire(lfoCv, 'out', src, 'b');
      const depth = b.add('scale', 2 + 2 * p, 6, { gain: 0, offset: 0 });
      b.wire(src, 'out', depth, 'in');
      for (const v of [voices[2 * p], voices[2 * p + 1]]) b.wire(depth, 'out', v.osc, 'pitch');
      return { src, depth };
    });
    // the voices' mix, then the MOD DELAY: two lines (wet only), each fed the voices and the other line through FB
    const mix = b.add('mixer', 9, 0, { l1: 0.7, l2: 0.7, l3: 0.7, l4: 0.7 });
    voices.forEach((v, i) => b.wire(v.vca, 'out', mix, `in${(i >> 1) + 1}`));
    const lines = [330, 470].map((time, k) => {
      const d = b.add('delay', 10, 2 * k, { time, fb: 0, mix: 1 });
      const cross = b.add('scale', 11, 2 * k, { gain: 0, offset: 0 });
      const clip = b.add('shape', 11, 2 * k + 1, { drive: 1, mode: 0, level: 1 });
      const self = b.add('math', 12, 2 * k, { ka: 1, kb: 0, off: 0 });
      const how = b.add('xfade', 12, 2 * k + 1, { mix: 0 }); // 0 = LFO, 1 = SELF
      const depth = b.add('scale', 13, 2 * k, { gain: 0, offset: 0 });
      b.wire(mix, 'out', d, 'in');
      b.wire(d, 'out', cross, 'in');
      b.wire(cross, 'out', clip, 'in');
      b.wire(d, 'out', self, 'a');
      b.wire(dlyLfo, 'out', how, 'a');
      b.wire(self, 'abs', how, 'b');
      b.wire(selfLfo, 'out', how, 'pos');
      b.wire(how, 'out', depth, 'in');
      b.wire(depth, 'out', d, 'p1');
      b.pin(d, 'p1', 'time');
      b.wire(fb, 'out', d, 'p2');
      b.pin(d, 'p2', 'fb', [0, 0.6]);
      b.wire(fb, 'out', cross, 'p1');
      b.pin(cross, 'p1', 'gain', [0.5, 0.5 + 0.6 / 8]); // 0 .. 0.6 into the other line
      return { d, clip, depth };
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
    const one = b.add('const', 16, 1, { value: 1 });
    b.wire(dlyMix, 'out', drive, 'in');
    b.wire(dlyMix, 'out', distMix, 'a');
    b.wire(drive, 'out', distMix, 'b');
    b.wire(distMix, 'out', vol, 'in');
    b.wire(one, 'out', vol, 'cv');
    b.wire(vol, 'out', lfoCv, 'b'); // TOTAL FB
    const scope = b.add('scope', 16, 2, { time: 16 });
    b.wire(vol, 'out', scope, 'a');
    voices.forEach((v, i) => b.nest(`voice ${i + 1}`, 1 + i, 0, [v.osc, v.shp, v.env, v.vca, v.vlfo], {
      inputs: [['gate', v.env, 'gate'], ['mod', v.osc, 'pitch'], ['hold', v.vca, 'cv'], ['sharp', v.shp, 'p1'], ['vibrato', v.vlfo, 'p1']],
      outputs: [['out', v.vca, 'out']],
    }));
    b.input('keys', plate[1], 'keys', ...plate.filter((_, i) => i !== 1).map((m) => [m, 'keys'] as [number, string]));
    b.output('out', vol, 'out');

    // the card: the FM-1 version's pages first where they still stand, then the rest
    for (const g of [0, 1]) {
      const name = g ? '5-8' : '1-4';
      b.param('hold', hold[g], 'value', { col: g === 1, head: name });
      b.param('pitch', pitch[g], 'value');
      for (const p of [2 * g, 2 * g + 1]) b.param(`fm/lfo ${2 * p + 1}-${2 * p + 2}`, mods[p].src, 'mix');
      for (const p of [2 * g, 2 * g + 1]) b.param(`mod ${2 * p + 1}-${2 * p + 2}`, mods[p].depth, 'gain', p === 2 * g ? { group: true } : {});
      for (const p of [2 * g, 2 * g + 1]) b.param(`sharp ${2 * p + 1}-${2 * p + 2}`, sharp[p], 'value');
    }
    b.param('34>56 78>12', structure, 'value', { head: 'all voices' });
    b.param('total fb', lfoCv, 'mix');
    b.param('vibrato', vibrato, 'value');
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
    b.param('drive', drive, 'drive', { head: 'distortion' });
    b.param('mix', distMix, 'mix');
    b.param('vol', vol, 'gain');
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
  "The SOMA Lyra-8 in full, after its user manual (v2.1, somasynths.com): two delay lines (TIME and MOD each, LFO / SELF, TRI / SQ, one FEEDBACK with cross-feedback, MIX), the distortion after the delay (DRIVE, MIX, VOL), an FM or LFO source per pair, the 34>56 78>12 structure switch, PITCH per group, TOTAL FB, VIBRATO, the Hyper LFO's LINK, SHARP from triangle to square. Switches are 0..1 rows. Browser only: the FM-1 holds one delay.";

export const xl: Xl = {
  base: '8 Lire',
  build: (fm1) => {
    const x = around('8 Lire XL', lireXl(platesOf(fm1)));
    x.p.octave = -1;
    matchLevel(x.p, fm1, KIT_NOTES);
    x.p.notes = NOTES;
    return players(validatePatch(x.p, DEFS), true);
  },
};
