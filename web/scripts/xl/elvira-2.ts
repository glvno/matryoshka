// SPDX-License-Identifier: GPL-3.0-only
// Elvira 2 XL: the neutral labs Elmyra 2 as its manual (v2.4, neutral-labs.com) describes it, where the FM-1's Elvira 2
// (gen-assemblies.ts) had to cut. Kept from the FM-1 version: four voices, each a wavetable oscillator (PG's four pages =
// `page`, WAVE, TUNE) into a VCA on its own envelope (the ENV knob's attack and release as two rows) plus DRONE; the mix
// saturated, the ladder low pass (CUTOFF, RESO), the delay (TIME, FDBK, MIX), OUCH (BITE, a folding Waveshaper, into
// CHOKE, a low pass open at the right), VOL; LFO 1 (sine) and LFO 2 (WAV: a choice of waves, S&H among them). Restored:
//  - the delay reaches the original's 1.6 s (the browser's Delay, past the FM-1's 520 ms);
//  - more of the MOD programs, each a row of its own and clean at its default: SRR (the sample rate, as before),
//    BITMANGLER (here the bit depth, not flipped bits), NOISE (white noise crossfaded in); the program chosen per voice
//    is just the row turned;
//  - the mix saturation's amount (an advanced setting on the original: none / soft / hard / dirty);
//  - OUCH's feedback loop and the modifier ports, as a loop from CHOKE's output back into BITE (FEEDBACK) through a
//    soft clip, and DIODE (the fold's asymmetry, a diode's one-sidedness);
//  - the LFOs patchable: on the original either LFO goes to any CV input; here each has an amount into CUTOFF, BITE,
//    CHOKE, the delay TIME, the four voices' WAVE and their MOD (SRR);
//  - the sequencer: a row of eight steps per voice (the original records up to 128 TUNE settings per voice), each with
//    its own length, clocked by Main's clock (it plays with the transport, as the original's needs SYNC's clock; a step
//    per sixteenth, its clock divider on the voice's `seq` card), into the voice's pitch through a Quantizer: CHRM, per
//    voice, with the original's scales (chromatic, major, minor, major and minor pentatonic), on the sequence's steps
//    (TUNE adds to them). The steps are 0 (no change) until set; they live on each voice's `seq` card.
// TUNE stays in semitones plus FINE in cents, which is the continuous TUNE of the original. Not here (the module set has
// no equal or the patch gains nothing from them): the DETUNE, SUBOSC, CHORD, DUAL, HARDSYNC, SHAPER, SATURATOR and DJ
// programs (two or three oscillators or a filter more per voice), the filter types and the reversed routing, the reverb
// option, the ATT and ADD utilities, the ENV outputs, the external audio input. The OUCH loop closes one block late (about
// 3 ms), so it rings as a comb rather than as the analog loop. The keys play the voices as touchpads, as on the FM-1
// version: rows 1-4 and 5-8 of four Drum maps are voices 1-4 (#184 will let one map repeat its rows).
import { DEFS } from '../../src/modules';
import { validatePatch } from '../../src/patch';
import { players } from '../factory-build';
import { around, define, KIT_NOTES, matchLevel, type Built } from './def';
import { platesOf } from './8-lire';
import type { Xl } from './xl';

export function elviraXl(maps: Record<string, number>[]): Built {
  return define('Elvira 2 XL', (b) => {
    const plate = maps.map((keys, i) => b.add('drummap', 0, [6, 0, 7, 8][i] ?? 9 + i, keys));
    for (const map of plate) b.module(map).names = [1, 2, 3, 4, 1, 2, 3, 4].map((v, r) => `VOICE ${v}${r < 4 ? '' : 'B'}`);   // (as the FM-1 version)
    const lfo1 = b.add('lfo', 0, 1, { wave: 0, rate: 0.2, depth: 1 });
    const lfo2 = b.add('lfo', 0, 2, { wave: 2, rate: 3, depth: 1 });
    const noise = b.add('noise', 0, 3, { level: 0.8, color: 0 });
    // each LFO into each destination by an amount: cutoff, bite, choke, time, wave, mod
    const DEST = ['cutoff', 'bite', 'choke', 'time', 'wave', 'mod'] as const;
    const amt = [lfo1, lfo2].map((lfo, k) => Object.fromEntries(DEST.map((d, j) => {
      const s = b.add('scale', 9 + k, j, { gain: 0, offset: 0 });
      b.wire(lfo, 'out', s, 'in');
      return [d, s];
    })) as Record<(typeof DEST)[number], number>);
    //               bank pos  coarse attack release
    const set: [number, number, number, number, number][] = [
      [0, 0.2, -15, 0.05, 0.8], [1, 0.4, -8, 0.05, 0.8], [2, 0.3, -3, 0.3, 1.5], [3, 0.6, 0, 0.3, 1.5],
    ];
    const voices = set.map(([bank, pos, coarse, a, r], i) => {
      const wt = b.add('wavetable', 1 + i, 0, { bank, pos, coarse, level: 0.8 });
      const crush = b.add('crush', 1 + i, 1, { bits: 16, rate: 1 });
      const nz = b.add('xfade', 1 + i, 2, { mix: 0 });
      const env = b.add('adsr', 1 + i, 3, { a, d: 0.2, s: 1, r });
      const drone = b.add('const', 1 + i, 4, { value: 0 });
      const vca = b.add('vca', 1 + i, 5, { gain: 1 });
      const seq = b.add('seq', 1 + i, 6, { len: 8, gate: 0 });
      const div = b.add('clkdiv', 1 + i, 8, { div: 6 }); // Main's 24 ppqn clock: a step per sixteenth
      const chrm = b.add('quant', 1 + i, 7, { scale: 0, root: 0 });
      b.wire(wt, 'out', crush, 'in');
      b.wire(crush, 'out', nz, 'a');
      b.wire(noise, 'out', nz, 'b');
      b.wire(nz, 'out', vca, 'in');
      b.wire(env, 'env', vca, 'cv');
      b.wire(drone, 'out', vca, 'cv');
      b.wire(div, 'out', seq, 'clock');
      b.wire(seq, 'out', chrm, 'in');
      b.wire(chrm, 'out', wt, 'pitch');
      for (const k of [0, 1]) {
        b.wire(amt[k].wave, 'out', wt, 'p1');
        b.wire(amt[k].mod, 'out', crush, 'p1');
      }
      b.pin(wt, 'p1', 'pos');
      b.pin(crush, 'p1', 'rate');
      for (const map of plate) for (const row of [i + 1, i + 5]) b.wire(map, `g${row}`, env, 'gate'); // (any key of the voice holds the gate up)
      return { wt, crush, nz, env, drone, vca, seq, div, chrm };
    });
    const mix = b.add('mixer', 5, 0, { l1: 0.7, l2: 0.7, l3: 0.7, l4: 0.7 });
    const sat = b.add('shape', 5, 1, { drive: 2, mode: 0, level: 0.8 });
    const lpf = b.add('ladder', 6, 0, { cutoff: 2500, res: 0.25, cvamt: 3 });
    const dly = b.add('delay', 6, 1, { time: 400, fb: 0.4, mix: 0.3 });
    const ouchIn = b.add('mixer', 7, 2, { l1: 1, l2: 0, l3: 0, l4: 0 }); // the delay, plus the loop (FEEDBACK)
    const bite = b.add('shape', 7, 0, { drive: 1, mode: 2, level: 0.8, sym: 0 });
    const choke = b.add('filter', 7, 1, { cutoff: 16000, res: 0 });
    const loop = b.add('shape', 8, 2, { drive: 1, mode: 0, level: 1 });
    const scope = b.add('scope', 8, 0, { time: 16 });
    voices.forEach((v, i) => b.wire(v.vca, 'out', mix, `in${i + 1}`));
    b.wire(mix, 'out', sat, 'in');
    b.wire(sat, 'out', lpf, 'in');
    b.wire(lpf, 'lp24', dly, 'in');
    b.wire(dly, 'out', ouchIn, 'in1');
    b.wire(ouchIn, 'out', bite, 'in');
    b.wire(bite, 'out', choke, 'in');
    b.wire(choke, 'lp12', loop, 'in');
    b.wire(loop, 'out', ouchIn, 'in2');
    b.wire(choke, 'lp12', scope, 'a');
    for (const k of [0, 1]) {
      b.wire(amt[k].cutoff, 'out', lpf, 'cv');
      b.wire(amt[k].bite, 'out', bite, 'p1');
      b.wire(amt[k].choke, 'out', choke, 'cv');
      b.wire(amt[k].time, 'out', dly, 'p1');
    }
    b.pin(bite, 'p1', 'drive');
    b.pin(dly, 'p1', 'time');
    voices.forEach((v, i) => b.nest(`voice ${i + 1}`, 1 + i, 0, [v.wt, v.crush, v.nz, v.env, v.drone, v.vca], {
      inputs: [['gate', v.env, 'gate'], ['pitch', v.wt, 'pitch']],
      outputs: [['out', v.vca, 'out']],
    }));
    voices.forEach((v, i) => b.nest(`seq ${i + 1}`, 1 + i, 6, [v.seq, v.div, v.chrm], {
      inputs: [['clock', v.div, 'clock']],
      outputs: [['pitch', v.chrm, 'out']],
      params: [...[1, 2, 3, 4, 5, 6, 7, 8].map((s) => [`step ${s}`, v.seq, `s${s}`] as [string, number, string]), ['glide', v.seq, 'glide'], ['dir', v.seq, 'dir'], ['clock div', v.div, 'div'], ['root', v.chrm, 'root']],
    }));
    b.input('keys', plate[1], 'keys', ...plate.filter((_, i) => i !== 1).map((m) => [m, 'keys'] as [number, string]));
    b.input('clock', voices[0].div, 'clock', ...voices.slice(1).map((v) => [v.div, 'clock'] as [number, string]));
    b.output('out', choke, 'lp12');

    // the card: the FM-1 version's pages first, each voice's added rows as one more page of it, then the rest
    voices.forEach((v, i) => {
      b.param('tune', v.wt, 'coarse', { head: `voice ${i + 1}`, ...(i % 2 === 0 ? { col: true } : {}) });
      b.param('fine', v.wt, 'fine');
      b.param('wave', v.wt, 'pos');
      b.param('page', v.wt, 'bank');
      b.param('mod', v.crush, 'rate', { group: true });
      b.param('attack', v.env, 'a');
      b.param('release', v.env, 'r');
      b.param('drone', v.drone, 'value');
      b.param('bits', v.crush, 'bits', { group: true });
      b.param('noise', v.nz, 'mix');
      b.param('seq steps', v.seq, 'len');
      b.param('chrm', v.chrm, 'scale');
    });
    b.param('cutoff', lpf, 'cutoff', { col: true, head: 'lpf' });
    b.param('reso', lpf, 'res');
    b.param('saturation', sat, 'drive');
    b.param('time', dly, 'time', { head: 'delay' });
    b.param('fdbk', dly, 'fb');
    b.param('mix', dly, 'mix');
    b.param('bite', bite, 'drive', { head: 'ouch' });
    b.param('choke', choke, 'cutoff');
    b.param('vol', bite, 'level');
    b.param('feedback', ouchIn, 'l2', { group: true });
    b.param('diode', bite, 'sym');
    b.param('lfo 1 freq', lfo1, 'rate', { col: true, head: 'lfos' });
    b.param('lfo 1 → cutoff', amt[0].cutoff, 'gain');
    b.param('lfo 2 freq', lfo2, 'rate', { group: true });
    b.param('lfo 2 wav', lfo2, 'wave');
    b.param('lfo 2 → bite', amt[1].bite, 'gain');
    b.param('lfo 1 → bite', amt[0].bite, 'gain', { head: 'lfo 1 to' });
    b.param('lfo 1 → choke', amt[0].choke, 'gain');
    b.param('lfo 1 → time', amt[0].time, 'gain');
    b.param('lfo 1 → wave', amt[0].wave, 'gain', { group: true });
    b.param('lfo 1 → mod', amt[0].mod, 'gain');
    b.param('lfo 2 → cutoff', amt[1].cutoff, 'gain', { head: 'lfo 2 to' });
    b.param('lfo 2 → choke', amt[1].choke, 'gain');
    b.param('lfo 2 → time', amt[1].time, 'gain');
    b.param('lfo 2 → wave', amt[1].wave, 'gain', { group: true });
    b.param('lfo 2 → mod', amt[1].mod, 'gain');
    b.param('out', scope, 'view', { col: true });
  });
}

/** the patch's notes (Patch.notes, at most 500 characters) */
const NOTES =
  "The neutral labs Elmyra 2 in full, after its manual (v2.4, neutral-labs.com): the delay to 1.6 s, BITS and NOISE beside the SRR program, the mix saturation, OUCH's feedback loop and DIODE, both LFOs into cutoff, bite, choke, time, wave and mod, and an 8-step sequence per voice on the transport with CHRM scales (the steps are on each seq card). Not here: the programs that need more oscillators, the filter types, the reverb. Browser only.";

export const xl: Xl = {
  base: 'Elvira 2',
  build: (fm1) => {
    const x = around('Elvira 2 XL', elviraXl(platesOf(fm1)));
    const clock = x.a.inputs.find((r) => r.label === 'clock')!;
    for (const t of [clock, ...(clock.also ?? [])]) x.p.cables.push({ from: { module: x.main.id, port: 'clock' }, to: { module: t.module, port: t.port } });
    x.p.octave = -1;
    matchLevel(x.p, fm1, KIT_NOTES.slice(0, 4));
    x.p.notes = NOTES;
    return players(validatePatch(x.p, DEFS), true);
  },
};
