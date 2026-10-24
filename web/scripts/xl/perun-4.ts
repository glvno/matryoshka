// SPDX-License-Identifier: GPL-3.0-only
// Perun 4 XL: the Erica Synths PERKONS HD-01 in full, after its user manual (PERKONS_manual_10_26.pdf, firmware 1.3: "The
// sound engines", "Modulation settings") and Sound On Sound's review. The FM-1 version (gen-assemblies.ts, Perun 4) keeps
// one algorithm per voice, drops the phase modulation it tried for voices 2 and 4, turns the VCF switch into a low pass
// to high pass sweep and lets its only LFO reach the delay time.
//
// Each voice here has the original's eleven controls: TUNE, DECAY, the ALGO switch (three algorithms, row `algo`, 1..3),
// MODE, PARAM 1 and PARAM 2 (three rows per algorithm, named as the manual's table names them and numbered by the
// algorithm: `1 transient`, `1 fold`, `1 pitch env`, `2 wavetable`, ...), CUTOFF, the VCF switch (row `vcf`: 1 low pass,
// 2 band pass, 3 high pass), DRIVE (the overdrive's dry / wet), FX SEND and LEVEL. The VCF has no resonance control on the original either (the manual lists none; Sound On
// Sound: "No resonance control exists"), so neither has this one. A three-position switch is an Offset (1, 2, 3) into
// two crossfaders (the module set has no switch); values between blend two neighbours.
//   voice 1: FOLD DRUM 1 (transient none / noise / pulse; fold, pitch env), WAVETABLE DRUM (wavetable 1..3: the wavetable
//     oscillator's bank; surf = the position, pitch env), SIMPLE DRUM (waveform; pitch env decay, pitch env amount)
//   voice 2: FOLD DRUM 2, WAVETABLE DRUM, COMPLEX DRUM (waveform; the modulating oscillator's frequency into the carrier's
//     phase, pitch env): the phase modulation the FM-1 version left out
//   voice 3: RESONANT DRUMS (snare / bass drum / noise and tone: a struck resonator and a noise burst; noise tone, noise
//     decay), SLAP (an analogue-style clap: a noise band retriggered while a 30 ms window is open; the mode is the space
//     between the repeats, the burst rate; reverb = its tail, crunch = drive), KARPLUS (a plucked string: the burst; edge =
//     damping, twang = a pitch envelope)
//   voice 4: NOISE HAT (white / metallic / pulse stack noise; envelope amount = the envelope into its high pass, attack),
//     NOISE/TONE (a phase-modulated square tone and noise; mode = the modulator's interval, envelope amount = the envelope
//     into the phase modulation index, noise / tone mix), ACOUSTIC HATS (the original plays samples of a closed hat, an
//     open hat and a ride; here three synthesized stand-ins; sample rate = a sample-rate reducer, attack). Voice 4's two
//     "attack" parameters are its envelope's attack, one row.
// The modulation LFO (wave, rate, MOD LVL) reaches every voice's tune with a depth row each (on the original it can be
// assigned to any of the eight knobs, depth up to 80 %; the tunings are what this patch offers: a share link with the
// layout has to stay under its limit). The delay keeps its own sine LFO on its time, as on the original. Accents: a row's
// velocity is the hit's height, as on the FM-1 version.
import { addModule, type Patch } from '../../src/patch';
import { DEFS } from '../../src/modules';
import { fixNotes, type StepNote } from '../../src/track';
import { players, wire } from '../factory-build';
import { around, define, KIT_NOTES, matchLevel, type Def } from './def';
import type { Xl } from './xl';

const NOTES = 'After the Erica Synths PERKONS HD-01 manual (1.3): per voice three algorithms (algo 1..3) with three modes and ' +
  'their PARAM 1 / 2, tune, decay, cutoff, VCF LP / BP / HP (no resonance, as the original), drive (dry / wet), send, level. ' +
  'Voice 2\'s COMPLEX DRUM and voice 4\'s NOISE/TONE phase-modulate. The modulation LFO reaches every tune; the delay keeps its own LFO. ' +
  'Voice 4\'s ACOUSTIC HATS are samples on the original, synthesized here.';

const built = define('Perun 4 XL', (d) => {
  // (a module with a pin routed to one parameter, as gen-assemblies.ts's builder takes it)
  const b = {
    ...d,
    add: (type: string, col: number, row: number, p: Record<string, number> = {}, o?: { p1?: string }): number => {
      const id = d.add(type, col, row, p);
      if (o?.p1) d.pin(id, 'p1', o.p1);
      return id;
    },
  } satisfies Def;
  const map = b.add('drummap', 0, 0, Object.fromEntries(KIT_NOTES.map((n, r) => [`n${r + 1}`, n])));
  d.module(map).names = ['VOICE 1', 'VOICE 2', 'VOICE 3', 'VOICE 4', 'ROW 5', 'ROW 6', 'ROW 7', 'ROW 8'];
  const lfo = b.add('lfo', 0, 1, { wave: 0, rate: 0.3, depth: 1 }); // the delay's own LFO
  const toTime = b.add('scale', 0, 2, { gain: 0.02, offset: 0 });
  const modLfo = b.add('lfo', 0, 3, { wave: 1, rate: 2, depth: 0.5 }); // the modulation LFO
  const mix = b.add('mixer', 6, 0, { l1: 0.9, l2: 0.7, l3: 0.7, l4: 0.5 });
  const send = b.add('mixer', 6, 1, { l1: 0, l2: 0.2, l3: 0.3, l4: 0.15 });
  const dly = b.add('delay', 7, 1, { time: 300, fb: 0.35, mix: 1 }, { p1: 'time' });
  const comp = b.add('dyn', 7, 0, { thresh: -14, ratio: 3, attack: 0.005, release: 0.15, gain: 3 });
  const scope = b.add('scope', 8, 0, { time: 16 });
  b.wire(lfo, 'out', toTime, 'in');
  b.wire(toTime, 'out', dly, 'p1');
  b.wire(send, 'out', dly, 'in');
  b.wire(mix, 'out', comp, 'in');
  b.wire(dly, 'out', comp, 'in');
  b.wire(comp, 'out', scope, 'a');

  /** a three-position switch: an Offset (1..3) picks input a, b or c through two crossfaders (their positions: the Offset
   * less 1 and less 2, from two Offsets all the switches share) */
  const less1 = b.add('const', 0, 4, { value: -1 });
  const less2 = b.add('const', 0, 4.2, { value: -2 });
  const switch3 = (col: number, row: number, at: number, ms: number[]): { sel: number; a: number; b: number; c: number; out: number } => {
    const sel = b.add('const', col, row, { value: at });
    const x1 = b.add('xfade', col, row + 0.1, { mix: 0 });
    const x2 = b.add('xfade', col, row + 0.2, { mix: 0 });
    b.wire(sel, 'out', x1, 'pos');
    b.wire(less1, 'out', x1, 'pos');
    b.wire(sel, 'out', x2, 'pos');
    b.wire(less2, 'out', x2, 'pos');
    b.wire(x1, 'out', x2, 'a');
    ms.push(sel, x1, x2);
    return { sel, a: x1, b: x1, c: x2, out: x2 };
  };
  type Out = number | [number, string][];
  const into = (from: Out, sw: { a: number; c: number }, which: 'a' | 'b' | 'c'): void => {
    for (const [m, port] of typeof from === 'number' ? [[from, 'out'] as [number, string]] : from) b.wire(m, port, which === 'c' ? sw.c : sw.a, which === 'c' ? 'b' : which);
  };

  type Row = [string, number, string];
  type Algo = { mode: Row; p1: Row; p2: Row };
  type Voice = { members: number[]; env: number; out: number; rows: Row[]; algos: Algo[] };

  const voice = (i: number, decay: number, cutoff: number, vcf: number, algo: number, make: (v: { col: number; ms: number[]; pb: number; penv: number; env: number; g: string }) => [Algo, Out][]): Voice => {
    const col = 1 + i * 1.25;
    const ms: number[] = [];
    const add = (type: string, r: number, p: Record<string, number> = {}, o?: { p1?: string }): number => {
      const id = b.add(type, col, r, p, o);
      ms.push(id);
      return id;
    };
    const g = `g${i + 1}`;
    const env = add('env', 0, { l1: 0, r1: 0.001, l2: 0, r2: decay, l3: 0, r3: 0.001, l4: 0, r4: 0.001 }, { p1: 'l1' });
    const pb = add('scale', 0.2, { gain: 0, offset: 0 }); // the voice's pitch: tune (offset, octaves) and the LFO (gain)
    const penv = add('env', 0.4, { l1: 1, r1: 0.001, l2: 0, r2: 0.05, l3: 0, r3: 0.001, l4: 0, r4: 0.001 });
    b.wire(map, g, env, 'gate');
    b.wire(map, `v${i + 1}`, env, 'p1');
    b.wire(map, g, penv, 'gate');
    b.wire(modLfo, 'out', pb, 'in');
    const sw = switch3(col, 4, algo, ms);
    const made = make({ col, ms, pb, penv, env, g });
    made.forEach(([, out], k) => into(out, sw, (['a', 'b', 'c'] as const)[k]));
    const vca = add('vca', 5, { gain: 1 });
    const flt = add('filter', 5.2, { cutoff, res: 0 });
    const vsw = switch3(col, 5.4, vcf, ms);
    const shp = add('shape', 6, { drive: 8, mode: 0, level: 0.5 });
    const drive = add('xfade', 6.2, { mix: 0.15 });
    b.wire(sw.out, 'out', vca, 'in');
    b.wire(env, 'env', vca, 'cv');
    b.wire(vca, 'out', flt, 'in');
    b.wire(flt, 'lp12', vsw.a, 'a');
    b.wire(flt, 'bp', vsw.a, 'b');
    b.wire(flt, 'hp', vsw.c, 'b');
    b.wire(vsw.out, 'out', shp, 'in');
    b.wire(vsw.out, 'out', drive, 'a');
    b.wire(shp, 'out', drive, 'b');
    b.wire(drive, 'out', mix, `in${i + 1}`);
    b.wire(drive, 'out', send, `in${i + 1}`);
    const rows: Row[] = [
      ['tune', pb, 'offset'], ['decay', env, 'r2'], ['algo', sw.sel, 'value'],
      ['cutoff', flt, 'cutoff'], ['vcf', vsw.sel, 'value'], ['drive', drive, 'mix'],
      ['lfo → tune', pb, 'gain'],
    ];
    return { members: ms, env, out: drive, rows, algos: made.map(([a]) => a) };
  };

  // the oscillators of an algorithm: pitch from the voice's bus and, by `amt`, its pitch envelope
  const pitched = (v: { pb: number; penv: number }, osc: number, drop: number): void => {
    b.wire(v.pb, 'out', osc, 'pitch');
    b.wire(v.penv, 'env', drop, 'in');
    b.wire(drop, 'out', osc, 'pitch');
  };
  const foldDrum = (v: { col: number; ms: number[]; pb: number; penv: number; g: string }, coarse: number): [Algo, Out] => {
    const add = (type: string, r: number, p: Record<string, number> = {}): number => { const id = b.add(type, v.col + 0.3, r, p); v.ms.push(id); return id; };
    const osc = add('osc', 1, { wave: 0, coarse, level: 1 });
    const drop = add('scale', 1.1, { gain: 2, offset: 0 });
    const fold = add('shape', 1.2, { drive: 1.2, mode: 2, level: 0.9 });
    pitched(v, osc, drop);
    b.wire(osc, 'out', fold, 'in');
    // the transient: none, a noise click or a pulse click (a 3 ms envelope)
    const cenv = add('env', 1.3, { l1: 1, r1: 0.001, l2: 0, r2: 0.003, l3: 0, r3: 0.001, l4: 0, r4: 0.001 });
    const nz = add('noise', 1.4, { level: 0.6, color: 0 });
    const pl = add('osc', 1.5, { wave: 3, coarse: 24, level: 0.6 });
    const tr = switch3(v.col + 0.3, 1.6, 2, v.ms);
    const cv = add('vca', 1.9);
    b.wire(map, v.g, cenv, 'gate');
    b.wire(nz, 'out', tr.a, 'b');
    b.wire(pl, 'out', tr.c, 'b');
    b.wire(tr.out, 'out', cv, 'in');
    b.wire(cenv, 'env', cv, 'cv');
    return [{ mode: ['transient', tr.sel, 'value'], p1: ['fold', fold, 'drive'], p2: ['pitch env', drop, 'gain'] }, [[fold, 'out'], [cv, 'out']]];
  };
  const wavetableDrum = (v: { col: number; ms: number[]; pb: number; penv: number }, coarse: number): [Algo, Out] => {
    const add = (type: string, r: number, p: Record<string, number> = {}): number => { const id = b.add(type, v.col + 0.6, r, p); v.ms.push(id); return id; };
    const wt = add('wavetable', 1, { bank: 1, pos: 0.3, coarse, level: 1 });
    const drop = add('scale', 1.1, { gain: 0.4, offset: 0 });
    pitched(v, wt, drop);
    return [{ mode: ['wavetable', wt, 'bank'], p1: ['surf', wt, 'pos'], p2: ['pitch env', drop, 'gain'] }, wt];
  };

  const voices: Voice[] = [
    voice(0, 0.45, 9000, 1, 1, (v) => {
      // SIMPLE DRUM: an oscillator (the waveform is the mode); param 1 = the decay of the voice's pitch envelope (the one
      // the other two algorithms use too: one algorithm sounds at a time)
      const add = (type: string, r: number, p: Record<string, number> = {}): number => { const id = b.add(type, v.col + 0.9, r, p); v.ms.push(id); return id; };
      const osc = add('osc', 1, { wave: 1, coarse: -27, level: 1 });
      const drop = add('scale', 1.2, { gain: 2, offset: 0 });
      pitched(v, osc, drop);
      return [foldDrum(v, -27), wavetableDrum(v, -24), [{ mode: ['waveform', osc, 'wave'], p1: ['pitch decay', v.penv, 'r2'], p2: ['pitch env', drop, 'gain'] }, osc]];
    }),
    voice(1, 0.3, 7000, 1, 2, (v) => {
      // COMPLEX DRUM: a carrier (the waveform is the mode) whose phase follows a sine modulator (param 1 = its frequency)
      const add = (type: string, r: number, p: Record<string, number> = {}): number => { const id = b.add(type, v.col + 0.9, r, p); v.ms.push(id); return id; };
      const car = add('osc', 1, { wave: 0, coarse: -12, pm: 2, level: 1 });
      const md = add('osc', 1.1, { wave: 0, coarse: 7, level: 1 });
      const drop = add('scale', 1.2, { gain: 0.6, offset: 0 });
      const mdrop = add('scale', 1.3, { gain: 0.6, offset: 0 });
      pitched(v, car, drop);
      b.wire(v.pb, 'out', md, 'pitch');
      b.wire(v.penv, 'env', mdrop, 'in');
      b.wire(mdrop, 'out', md, 'pitch');
      b.wire(md, 'out', car, 'pm');
      return [foldDrum(v, -15), wavetableDrum(v, -12), [{ mode: ['waveform', car, 'wave'], p1: ['mod freq', md, 'coarse'], p2: ['pitch env', drop, 'gain'] }, car]];
    }),
    voice(2, 0.18, 2500, 1, 1, (v) => {
      const add = (type: string, c: number, r: number, p: Record<string, number> = {}): number => { const id = b.add(type, v.col + c, r, p); v.ms.push(id); return id; };
      // RESONANT DRUMS: a 2 ms strike into a resonator (snare, bass drum) or a sine (noise / tone), each with the noise
      // burst (param 1 = its tone, a low pass; param 2 = its decay)
      const strike = add('pulse', 0.3, 1, { time: 0.002 });
      const hit = add('scale', 0.3, 1.1, { gain: 0.05, offset: 0 });
      const sn = add('modal', 0.3, 1.2, { coarse: -7, decay: 0.15, struct: 0.4, bright: 0.6, damp: 0.4 });
      const bd = add('modal', 0.3, 1.3, { coarse: -24, decay: 0.4, struct: 0, bright: 0.3, damp: 0.5 });
      const tone = add('osc', 0.3, 1.4, { wave: 0, coarse: -8, level: 0.9 });
      const nz = add('noise', 0.3, 1.5, { level: 1, color: 0 });
      const nlp = add('filter', 0.3, 1.6, { cutoff: 5000, res: 0 });
      const nenv = add('env', 0.3, 1.7, { l1: 1, r1: 0.001, l2: 0, r2: 0.12, l3: 0, r3: 0.001, l4: 0, r4: 0.001 });
      const nvca = add('vca', 0.3, 1.8);
      b.wire(map, v.g, strike, 'trig');
      b.wire(strike, 'out', hit, 'in');
      b.wire(hit, 'out', sn, 'in');
      b.wire(hit, 'out', bd, 'in');
      b.wire(v.pb, 'out', sn, 'pitch');
      b.wire(v.pb, 'out', bd, 'pitch');
      b.wire(v.pb, 'out', tone, 'pitch');
      b.wire(map, v.g, nenv, 'gate');
      b.wire(nz, 'out', nlp, 'in');
      b.wire(nlp, 'lp12', nvca, 'in');
      b.wire(nenv, 'env', nvca, 'cv');
      const kinds = [[sn, 0.6], [bd, 0.15], [tone, 0.6]].map(([src, n], k) => {
        const m = add('mixer', 0.3, 2 + k * 0.1, { l1: 1, l2: n, l3: 0, l4: 0 });
        b.wire(src, 'out', m, 'in1');
        b.wire(nvca, 'out', m, 'in2');
        return m;
      });
      const rd = switch3(v.col + 0.3, 2.4, 1, v.ms);
      b.wire(kinds[0], 'out', rd.a, 'a');
      b.wire(kinds[1], 'out', rd.a, 'b');
      b.wire(kinds[2], 'out', rd.c, 'b');
      // SLAP: a 30 ms window opens; while open, a square at the burst rate (the mode: the space between the repeats)
      // retriggers a short noise band; then the tail (param 1, "reverb"), all through a drive (param 2, crunch)
      const win = add('pulse', 0.6, 1, { time: 0.03 });
      const rate = add('lfo', 0.6, 1.1, { wave: 3, rate: 100, depth: 1 });
      const and = add('logic', 0.6, 1.2, { thresh: 0.5 });
      const benv = add('env', 0.6, 1.3, { l1: 1, r1: 0.001, l2: 0, r2: 0.008, l3: 0, r3: 0.001, l4: 0, r4: 0.001 });
      const cbp = add('filter', 0.6, 1.5, { cutoff: 1200, res: 0.5 });
      const bv = add('vca', 0.6, 1.6);
      const tenv = add('env', 0.6, 1.7, { l1: 1, r1: 0.001, l2: 0, r2: 0.15, l3: 0, r3: 0.001, l4: 0, r4: 0.001 });
      const tv = add('vca', 0.6, 1.8, { gain: 0.5 });
      const crunch = add('shape', 0.6, 1.9, { drive: 2, mode: 0, level: 0.7 });
      b.wire(map, v.g, win, 'trig');
      b.wire(map, v.g, rate, 'reset');
      b.wire(map, v.g, tenv, 'gate');
      b.wire(win, 'out', and, 'a');
      b.wire(rate, 'out', and, 'b');
      b.wire(and, 'and', benv, 'gate');
      b.wire(nz, 'out', cbp, 'in');
      b.wire(cbp, 'bp', bv, 'in');
      b.wire(cbp, 'bp', tv, 'in');
      b.wire(benv, 'env', bv, 'cv');
      b.wire(tenv, 'env', tv, 'cv');
      b.wire(bv, 'out', crunch, 'in');
      b.wire(tv, 'out', crunch, 'in');
      // KARPLUS: a plucked string (the mode: its burst, noise or pulse; edge = damping; twang = a pitch envelope)
      const str = add('string', 0.9, 1, { decay: 0.6, damp: 0.3, burst: 0, coarse: -5, level: 0.8 });
      const twang = add('scale', 0.9, 1.1, { gain: 0.1, offset: 0 });
      b.wire(map, v.g, str, 'gate');
      b.wire(v.pb, 'out', str, 'pitch');
      b.wire(v.penv, 'env', twang, 'in');
      b.wire(twang, 'out', str, 'pitch');
      return [
        [{ mode: ['resonant', rd.sel, 'value'], p1: ['noise tone', nlp, 'cutoff'], p2: ['noise decay', nenv, 'r2'] }, rd.out],
        [{ mode: ['spacing', rate, 'rate'], p1: ['reverb', tv, 'gain'], p2: ['crunch', crunch, 'drive'] }, crunch],
        [{ mode: ['burst', str, 'burst'], p1: ['edge', str, 'damp'], p2: ['twang', twang, 'gain'] }, str],
      ];
    }),
    voice(3, 0.06, 6000, 3, 1, (v) => {
      const add = (type: string, c: number, r: number, p: Record<string, number> = {}, o?: { p1?: string }): number => { const id = b.add(type, v.col + c, r, p, o); v.ms.push(id); return id; };
      // NOISE HAT: white noise, metallic noise (a detuned square cluster with noise) or a pulse stack (two squares with
      // noise); its own high pass, which the envelope sweeps by param 1
      const wn = add('noise', 0.3, 1, { level: 1, color: 0 });
      const metal = add('osc', 0.3, 1.1, { wave: 3, coarse: 38, level: 0.6, unison: 5, detune: 90, pw: 0.3 });
      const sq = add('osc', 0.3, 1.2, { wave: 3, coarse: 31, pw: 0.3, level: 0.6 });
      const sq2 = add('osc', 0.3, 1.3, { wave: 3, coarse: 37, fine: 40, pw: 0.4, level: 0.6 });
      const hs = switch3(v.col + 0.3, 1.6, 3, v.ms);
      b.wire(wn, 'out', hs.a, 'a');
      b.wire(metal, 'out', hs.a, 'b');
      b.wire(wn, 'out', hs.a, 'b');
      b.wire(sq, 'out', hs.c, 'b');
      b.wire(sq2, 'out', hs.c, 'b');
      b.wire(wn, 'out', hs.c, 'b');
      const hp = add('filter', 0.3, 2.1, { cutoff: 4000, res: 0 });
      const hamt = add('scale', 0.3, 2.2, { gain: 1, offset: 0 });
      b.wire(hs.out, 'out', hp, 'in');
      b.wire(v.env, 'env', hamt, 'in');
      b.wire(hamt, 'out', hp, 'cv');
      // NOISE/TONE: a square whose phase follows a sine (the mode: the modulator's interval; param 1 = how far the
      // envelope opens the modulation), crossfaded with noise (param 2)
      const tone = add('osc', 0.6, 1, { wave: 3, coarse: 30, pm: 0.5, level: 0.7 }, { p1: 'pm' });
      const tmod = add('osc', 0.6, 1.1, { wave: 0, coarse: 37, level: 1 });
      const pamt = add('scale', 0.6, 1.2, { gain: 2, offset: 0 });
      const nt = add('xfade', 0.6, 1.4, { mix: 0.5 });
      b.wire(v.pb, 'out', tone, 'pitch');
      b.wire(v.pb, 'out', tmod, 'pitch');
      b.wire(tmod, 'out', tone, 'pm');
      b.wire(v.env, 'env', pamt, 'in');
      b.wire(pamt, 'out', tone, 'p1');
      b.wire(wn, 'out', nt, 'a');
      b.wire(tone, 'out', nt, 'b');
      // ACOUSTIC HATS: stand-ins for the original's samples, a closed hat, an open hat and a ride (a bell of phase-
      // modulated sines with noise), through a sample-rate reducer (param 1)
      const ah = add('osc', 0.9, 1, { wave: 3, coarse: 40, level: 0.6, unison: 5, detune: 70, pw: 0.4 });
      const ahp = add('filter', 0.9, 1.2, { cutoff: 7000, res: 0 });
      const cl = add('env', 0.9, 1.3, { l1: 1, r1: 0.001, l2: 0, r2: 0.05, l3: 0, r3: 0.001, l4: 0, r4: 0.001 });
      const op = add('env', 0.9, 1.4, { l1: 1, r1: 0.001, l2: 0, r2: 0.5, l3: 0, r3: 0.001, l4: 0, r4: 0.001 });
      const clv = add('vca', 0.9, 1.5);
      const opv = add('vca', 0.9, 1.6);
      const bell = add('osc', 0.9, 1.7, { wave: 0, coarse: 26, pm: 3, level: 0.5 });
      const bmod = add('osc', 0.9, 1.8, { wave: 0, coarse: 43, fine: 30, level: 1 });
      b.wire(ah, 'out', ahp, 'in');
      b.wire(wn, 'out', ahp, 'in');
      b.wire(map, v.g, cl, 'gate');
      b.wire(map, v.g, op, 'gate');
      b.wire(ahp, 'hp', clv, 'in');
      b.wire(ahp, 'hp', opv, 'in');
      b.wire(cl, 'env', clv, 'cv');
      b.wire(op, 'env', opv, 'cv');
      b.wire(v.pb, 'out', ah, 'pitch');
      b.wire(v.pb, 'out', bell, 'pitch');
      b.wire(v.pb, 'out', bmod, 'pitch');
      b.wire(bmod, 'out', bell, 'pm');
      const as = switch3(v.col + 0.9, 2.0, 1, v.ms);
      b.wire(clv, 'out', as.a, 'a');
      b.wire(opv, 'out', as.a, 'b');
      b.wire(bell, 'out', as.c, 'b');
      b.wire(ahp, 'hp', as.c, 'b');
      const sr = add('crush', 0.9, 2.5, { bits: 16, rate: 1 });
      b.wire(as.out, 'out', sr, 'in');
      return [
        [{ mode: ['noise', hs.sel, 'value'], p1: ['env amount', hamt, 'gain'], p2: ['attack', v.env, 'r1'] }, [[hp, 'hp']]],
        [{ mode: ['interval', tmod, 'coarse'], p1: ['env amount', pamt, 'gain'], p2: ['noise/tone', nt, 'mix'] }, nt],
        [{ mode: ['sample', as.sel, 'value'], p1: ['sample rate', sr, 'rate'], p2: ['attack', v.env, 'r1'] }, sr],
      ];
    }),
  ];
  voices.forEach((v, i) => b.nest(`voice ${i + 1}`, 1 + i * 1.25, 0, v.members, { inputs: [['gate', v.env, 'gate']], outputs: [['out', v.out, 'out']] }));
  b.input('keys', map, 'keys');
  b.output('out', comp, 'out');
  const shown = new Set<string>();
  voices.forEach((v, i) => {
    const r = (name: string): Row => v.rows.find((x) => x[0] === name)!;
    // the FM-1 version's rows in its order (param 1 / 2: the first algorithm's), then the rest of the voice
    const first = (row: Row, o: { head?: string; col?: boolean } = {}): void => {
      b.param(row[0], row[1], row[2], o);
      shown.add(`${row[1]}.${row[2]}`);
    };
    first(r('tune'), { head: `voice ${i + 1}`, col: true });
    first(r('decay'));
    first(r('algo'));
    v.algos.forEach((a, k) => {
      for (const [n, row] of [['mode', a.mode], ['param 1', a.p1], ['param 2', a.p2]] as const) {
        if (shown.has(`${row[1]}.${row[2]}`)) continue; // (voice 4's attack: one row)
        b.param(row[1] === v.env ? row[0] : `${k + 1} ${row[0]}`, row[1], row[2], k === 0 && n === 'mode' ? { group: true } : {});
        shown.add(`${row[1]}.${row[2]}`);
      }
    });
    first(r('cutoff'), { head: `voice ${i + 1} out` });
    first(r('vcf'));
    first(r('drive'));
    b.param('send', send, `l${i + 1}`);
    b.param('level', mix, `l${i + 1}`);
    first(r('lfo → tune'));
  });
  b.param('time', dly, 'time', { col: true, head: 'delay' });
  b.param('feedback', dly, 'fb');
  b.param('lfo → time', toTime, 'gain');
  b.param('lfo rate', lfo, 'rate');
  b.param('mod wave', modLfo, 'wave', { head: 'modulation' });
  b.param('mod rate', modLfo, 'rate');
  b.param('mod lvl', modLfo, 'depth');
  b.param('comp', comp, 'thresh', { head: 'master' });
  b.param('master', comp, 'gain');
  b.param('out', scope, 'view', { col: true });
});
// drums are played by short trigs: every envelope is one-shot (gen-assemblies.ts does the same for its Drums shelf)
for (const m of built.def.modules) if (m.type === 'env') m.params.shot = 1;
// a voice's nested card shows the voice's own rows, not its algorithms' (they are on the Perun 4 XL card): a share link
// with the layout stays under its limit
const VOICE_ROWS = new Set(['tune', 'decay', 'algo', 'cutoff', 'vcf', 'drive']);
for (const n of built.def.assemblies ?? []) n.params = n.params.filter((r) => VOICE_ROWS.has(r.label ?? r.param));

export const xl: Xl = {
  base: 'Perun 4',
  build: (fm1: Patch): Patch => {
    const x = around('Perun 4', built);
    const p = x.p;
    p.notes = NOTES;
    // the FM-1 version's pattern, on the same PATTERN track between Main's keys and the drums
    const pattern = fm1.modules.find((m) => m.type === 'steps' && m.name === 'PATTERN')!;
    const into = x.a.inputs.find((r) => r.label === 'keys')!;
    p.cables = p.cables.filter((c) => !(c.from.module === x.main.id && c.from.port === 'keys'));
    const st = addModule(p, DEFS.steps, 20, 300);
    st.name = 'PATTERN';
    st.notes = fixNotes(structuredClone(pattern.notes ?? []) as StepNote[]);
    wire(p, x.main.id, 'keys', st.id, 'keys');
    for (const t of [into, ...(into.also ?? [])]) wire(p, st.id, 'keys', t.module, t.port);
    p.octave = -1;
    const q = players(p, true);
    matchLevel(q, fm1, KIT_NOTES.slice(0, 4));
    return q;
  },
};
