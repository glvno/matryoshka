// SPDX-License-Identifier: GPL-3.0-only
// Meridian 8 XL: the Landscape NOON, with what the FM-1 version (scripts/gen-assemblies.ts, Meridian 8) left out to fit.
// Sources: Landscape's NOON manual (landscape.fm/s/Noon-Manual-baw6.pdf: power, channels, inputs, CV mute, sliders,
// volume, link, mod, mute, touch plates, audio input, outputs, pitch, drone, tips) and the instrument's page
// (landscape.fm/noon: each channel's character words).
// - The first design the FM-1 could not hold (commit 18ccc6e: it read 85 %): DOT and BACID through Multimodes whose cutoff
//   the power moves per sample (the FM-1 version: Ladders, once per block), CYMPATH a three-voice cluster (one oscillator's
//   three detuned copies) instead of one narrow square.
// - The gate's voltage: a NOON channel runs on the voltage its gate input brings ("powered and controlled directly from
//   its respective gate input"), so its power is its envelope x the key's velocity (a Steps note's: the pattern's accents).
// - Each channel's MOD button ("change the behavior and sound of each circuit": two modes), as a crossfade from the
//   circuit to its second mode: DOT the filter pinged (band pass), DUAL its sine through a pinged filter, SYS phased, PLAST
//   static (crushed), CYMPATH the cluster uncrushed (scream), CYRINX folded (rough), LARYNX folded (squeal), BACID the
//   filter's band pass (acidic). Which second mode each circuit has is our reading of the channel's words.
// - The eight mute buttons (`on`, 1 = button down): after the gate input (not the odd / even CV, which has its own
//   buttons), so a muted channel still takes CV and a link still shares a neighbour's power into it.
// - The odd and even CV inputs (the `odd cv` / `even cv` knobs, and the assembly's inputs of those names for a cable),
//   each channel through its CV mute button; CV alone powers a channel (the drone).
// - LINK as voltage sharing: the seven buttons between neighbours share both ways, the two at the ends wrap around one
//   way each (`8>1`: channel 8's power into 1, `1>8`: 1's into 8). Linked, a powered channel partly powers an unpowered one.
// - CYMPATH's voltage starving: its pitch slider also sets its loudness (lower is lower and quieter).
// - The touch plates. A finger across a channel's pair (`touch`, how much skin: a Math's ka) puts the channel's power onto
//   a shared bus (the Math's abs: touch x power) and takes the bus back, riding on the channel's power (its mul: touch x
//   power x bus), by how hard the fingers press (`press`, plus the keyboard's aftertouch from Main's `at`) and through the
//   skin (a slow random wobble on the bus: moisture). So one finger modulates its own channel, fingers on several channels
//   send modulation between them, and short trigs give little to share, as the manual says. `left plate` is a finger on
//   the left-side plates: the incoming CVs and gates go onto the bus too (the drone patch: left plate spanned with a
//   bottom plate).
// - The audio input, fed from inside: each channel's `to in` sends its output into the audio input (the manual's internal
//   processing, a channel's output patched back into the input), as does the assembly's `audio` input for a cable from
//   any other module. The DOT/DUAL link button opens it, and it feeds DUAL through a drive: a filter-distortion-VCA that
//   DUAL's power plays.
// - The individual outputs as the assembly's outputs `1`..`8` (each channel before the main mix), and each channel's
//   `to main` (0 takes it out of the main outputs, as plugging its individual output does).
// - The passive mix: the odd / even CVs and outputs bleed into each other (`bleed`, a little by default); at 1 both sides
//   carry all eight channels, as the NOON with only its top main output plugged.
// Kept as on the FM-1 version: the eight channels on the white keys from F3, their two tone sliders and volume, odd to
// the left and even to the right, the main volume (driving the mix into compression, the passive mix's), the 16-step
// pattern. Not here: the external audio input from outside the browser (a module that reads the computer's audio input
// would be needed: an Audio in, with a block of samples from the browser's input in the browser engine and from the
// FM-1's ADC in the firmware), the jacks themselves (the gate and CV inputs come from the keys, the knobs and cables
// inside the patch; the individual outputs reach other modules, not a mixer).
import { addModule, paramUnit } from '../../src/patch';
import { DEFS } from '../../src/modules';
import { level, players, wire } from '../factory-build';
import type { Xl } from './xl';
import { around, define, type Def } from './def';

/** the white keys from F3 (gen-assemblies.ts PLATE_KEYS[1], the drum kits' rows) */
const ROW_KEYS = [53, 55, 57, 59, 60, 62, 64, 65];

const COARSE = DEFS.osc.params.find((d) => d.name === 'coarse')!;
const GAIN = DEFS.scale.params.find((d) => d.name === 'gain')!;

interface Ch {
  name: string;
  env: number;
  vca: number;
  /** the channel's power (its gate's, after its mute button, and its CV): what it plays and shares on a link */
  pw: number;
  members: number[];
  /** where power from outside the channel (a link) goes in: the circuit's power node */
  power: [number, string][];
  s1: [number, string, string];
  s2: [number, string, string];
  /** the MOD crossfade, the mute button (the gate's VCA), the touch plates' Math */
  mod: number;
  mute: number;
  touch: number;
}

function build(e: Def): void {
  const map = e.add('drummap', 0, 0, Object.fromEntries(ROW_KEYS.map((n, r) => [`n${r + 1}`, n])));
  e.module(map).names = ['DOT', 'DUAL', 'SYS', 'PLAST', 'CYMPATH', 'CYRINX', 'LARYNX', 'BACID'];
  // the odd and even CV inputs, and their crosstalk (the passive design sums them to their channels)
  const odd = e.add('macro', 0, 1, { value: 0 });
  const even = e.add('macro', 0, 2, { value: 0 });
  const oddBus = e.add('scale', 0, 1.5, { gain: 1, offset: 0 });
  const evenBus = e.add('scale', 0, 2.5, { gain: 1, offset: 0 });
  const bleed = e.add('macro', 0, 3, { value: 0.05 });
  const xo = e.add('vca', 0, 3.5, { gain: 1 });
  const xe = e.add('vca', 0, 4, { gain: 1 });
  e.wire(odd, 'out', oddBus, 'in');
  e.wire(even, 'out', evenBus, 'in');
  e.wire(even, 'out', xo, 'in');
  e.wire(odd, 'out', xe, 'in');
  e.wire(bleed, 'out', xo, 'cv');
  e.wire(bleed, 'out', xe, 'cv');
  e.wire(xo, 'out', oddBus, 'in');
  e.wire(xe, 'out', evenBus, 'in');
  // the touch plates: pressure (press + aftertouch), the shared bus with the skin's wobble, the left-side plates
  const press = e.add('macro', 0, 5.5, { value: 0.5 });
  const pressure = e.add('scale', 0, 6, { gain: 1, offset: 0 });
  e.wire(press, 'out', pressure, 'in');
  const skin = e.add('random', 0, 6.5, { mode: 1, rate: 7 });
  const wobble = e.add('scale', 0, 7, { gain: 0.5, offset: 1 });
  e.wire(skin, 'out', wobble, 'in');
  const bus = e.add('scale', 0, 7.5, { gain: 1, offset: 0 });
  const busV = e.add('vca', 0, 8, { gain: 1 });
  e.wire(bus, 'out', busV, 'in');
  e.wire(wobble, 'out', busV, 'cv');
  const left = e.add('macro', 0, 8.5, { value: 0 });
  const leftSrc = e.add('scale', 0, 9, { gain: 0.5, offset: 0 });
  const leftV = e.add('vca', 0, 9.5, { gain: 1 });
  e.wire(oddBus, 'out', leftSrc, 'in');
  e.wire(evenBus, 'out', leftSrc, 'in');
  e.wire(leftSrc, 'out', leftV, 'in');
  e.wire(left, 'out', leftV, 'cv');
  const touchIn = e.add('vca', 0, 10, { gain: 1 });
  e.wire(busV, 'out', touchIn, 'in');
  e.wire(leftV, 'out', touchIn, 'in');
  e.wire(pressure, 'out', touchIn, 'cv');
  // the DOT/DUAL link button: it also opens the audio input
  const dotDual = e.add('macro', 1, 6, { value: 0 });
  // the audio input: the channels' sends and the assembly's `audio`, opened by the DOT/DUAL link button
  const ain = e.add('scale', 0, 10.5, { gain: 1, offset: 0 });
  const sendA = e.add('mixer', 0, 11.5, { l1: 0, l2: 0, l3: 0, l4: 0 });
  const sendB = e.add('mixer', 0, 12, { l1: 0, l2: 0, l3: 0, l4: 0 });
  const ainV = e.add('vca', 0, 11, { gain: 1 });
  e.wire(ain, 'out', ainV, 'in');
  e.wire(dotDual, 'out', ainV, 'cv');
  e.wire(sendA, 'out', ain, 'in');
  e.wire(sendB, 'out', ain, 'in');
  // the main mix: odd left, even right (each channel's level its `to main`), bleeding into each other; the main volume
  // drives it
  const oddSum = e.add('mixer', 9, 0, { l1: 1, l2: 1, l3: 1, l4: 1 });
  const evenSum = e.add('mixer', 9, 0.5, { l1: 1, l2: 1, l3: 1, l4: 1 });
  const bl = e.add('vca', 9, 1, { gain: 1 });
  const br = e.add('vca', 9, 1.5, { gain: 1 });
  const L = e.add('shape', 10, 0, { drive: 1.5, mode: 0, level: 0 });
  const R = e.add('shape', 10, 1, { drive: 1.5, mode: 0, level: 0 });
  e.wire(oddSum, 'out', L, 'in');
  e.wire(evenSum, 'out', R, 'in');
  e.wire(evenSum, 'out', bl, 'in');
  e.wire(oddSum, 'out', br, 'in');
  e.wire(bleed, 'out', bl, 'cv');
  e.wire(bleed, 'out', br, 'cv');
  e.wire(bl, 'out', L, 'in');
  e.wire(br, 'out', R, 'in');
  e.pin(L, 'p1', 'level');
  e.pin(R, 'p1', 'level');
  const main = e.add('macro', 10, 2, { value: 0.8 });
  const scope = e.add('scope', 11, 0, { time: 16 });

  /** a channel: its power (an ADSR on its gate, scaled by the gate's voltage, through its mute button, plus its CV) into
   * its VCA and `power`; `a` / `b` are the MOD crossfade's two inputs, `post` a module between the crossfade and the VCA */
  type Circuit = Omit<Ch, 'name' | 'env' | 'vca' | 'mod' | 'pw' | 'mute' | 'touch' | 'power'> & { power: [number, string][]; a: [number, string]; also?: [number, string]; b: [number, string]; post?: number };
  const channel = (i: number, name: string, adsr: Record<string, number>, f: (col: number, pw: number) => Circuit): Ch => {
    const col = 1 + i;
    const env = e.add('adsr', col, 0, adsr);
    const gv = e.add('vca', col, 0.25, { gain: 1 }); // the gate's voltage: envelope x velocity; its gain the mute button
    const pw = e.add('scale', col, 0.5, { gain: 1, offset: 0 });
    // what reaches the circuit: its own power, the links' and the touch plates'
    const node = e.add('scale', col, 0.75, { gain: 1, offset: 0 });
    const vca = e.add('vca', col, 4, { gain: 0.8 });
    const mod = e.add('xfade', col, 3.5, { mix: 0 });
    e.wire(map, `g${i + 1}`, env, 'gate');
    e.wire(env, 'env', gv, 'in');
    e.wire(map, `v${i + 1}`, gv, 'cv');
    e.wire(gv, 'out', pw, 'in');
    e.wire(map, `g${i + 1}`, leftSrc, 'in'); // (the gate inputs themselves, before the channel)
    e.wire(pw, 'out', node, 'in');
    const c = f(col, node);
    e.wire(c.a[0], c.a[1], mod, 'a');
    if (c.also) e.wire(c.also[0], c.also[1], mod, 'a');
    e.wire(c.b[0], c.b[1], mod, 'b');
    if (c.post) {
      e.wire(mod, 'out', c.post, 'in');
      e.wire(c.post, 'out', vca, 'in');
    } else e.wire(mod, 'out', vca, 'in');
    const power: [number, string][] = [[vca, 'cv'], ...c.power];
    for (const [m, port] of power) e.wire(node, 'out', m, port);
    // the touch plates: how much skin (`touch`, the Math's ka) x the channel's power onto the bus (abs), the bus back into
    // the channel by the same (mul: touch x power x bus, so what a finger passes rides on the channel's own power)
    const touch = e.add('math', col, 4.5, { ka: 0, kb: 1, off: 0 });
    e.wire(pw, 'out', touch, 'a');
    e.wire(touchIn, 'out', touch, 'b');
    e.wire(touch, 'abs', bus, 'in');
    e.wire(touch, 'mul', node, 'in');
    // the sends: into the audio input, into the main mix
    e.wire(vca, 'out', i < 4 ? sendA : sendB, `in${(i % 4) + 1}`);
    e.wire(vca, 'out', i % 2 === 0 ? oddSum : evenSum, `in${(i >> 1) + 1}`);
    return {
      name, env, vca, mod, pw, mute: gv, touch, s1: c.s1, s2: c.s2, power: [[node, 'in']],
      members: [env, gv, pw, node, ...c.members, mod, ...(c.post ? [c.post] : []), vca],
    };
  };
  const chs: Ch[] = [
    // DOT: knock / tap / flutter / filter / saw: a saw through a Multimode the power sweeps; MOD: the filter pinged
    channel(0, 'dot', { a: 0.002, d: 0.08, s: 0.6, r: 0.15 }, (col) => {
      const osc = e.add('osc', col, 1, { wave: 2, coarse: -17, level: 0.8 });
      const lp = e.add('filter', col, 2, { cutoff: 600, res: 0.4, cvamt: 3 });
      e.wire(osc, 'out', lp, 'in');
      return { members: [osc, lp], power: [[osc, 'pitch'], [lp, 'cv']], s1: [osc, 'coarse', 'pitch'], s2: [lp, 'cutoff', 'filter'], a: [lp, 'lp12'], b: [lp, 'bp'] };
    }),
    // DUAL: clicks / pings / sine / filter: a sine pinged up by the power; MOD: through a resonant band pass the power
    // sweeps. The audio input comes in here, through a drive, into both sides
    channel(1, 'dual', { a: 0.001, d: 0.25, s: 0.3, r: 0.3 }, (col, pw) => {
      const osc = e.add('osc', col, 1, { wave: 0, coarse: -24, level: 1 });
      const ping = e.add('scale', col, 2, { gain: 1.5, offset: 0 });
      const bp = e.add('filter', col, 2.5, { cutoff: 400, res: 0.9, cvamt: 3 });
      const drive = e.add('shape', col, 3, { drive: 3, mode: 0, level: 0.8 });
      e.wire(pw, 'out', ping, 'in');
      e.wire(ping, 'out', osc, 'pitch');
      e.wire(osc, 'out', bp, 'in');
      e.wire(ainV, 'out', drive, 'in');
      e.wire(drive, 'out', bp, 'in');
      return { members: [osc, ping, bp, drive], power: [[bp, 'cv']], s1: [osc, 'coarse', 'pitch'], s2: [ping, 'gain', 'ping'], a: [osc, 'out'], also: [drive, 'out'], b: [bp, 'bp'] };
    }),
    // SYS: hollow / laser / wood / phased: a resonator struck at the gate, the power sweeps its pitch; MOD: phased
    channel(2, 'sys', { a: 0.001, d: 0.1, s: 0.5, r: 0.2 }, (col) => {
      const strike = e.add('pulse', col, 1, { time: 0.002 });
      const hit = e.add('scale', col, 1.5, { gain: 0.03, offset: 0 });
      const res = e.add('modal', col, 2, { coarse: -10, decay: 0.4, struct: 0.3, bright: 0.6, damp: 0.4 });
      const ph = e.add('phaser', col, 2.5, { rate: 3, depth: 0.9, center: 900, fb: 0.7, mix: 1 });
      e.wire(map, 'g3', strike, 'trig');
      e.wire(strike, 'out', hit, 'in');
      e.wire(hit, 'out', res, 'in');
      e.wire(res, 'out', ph, 'in');
      return { members: [strike, hit, res, ph], power: [[res, 'pitch']], s1: [res, 'coarse', 'pitch'], s2: [res, 'struct', 'hollow'], a: [res, 'out'], b: [ph, 'out'] };
    }),
    // PLAST: stretch / wrap / static / wet / squish: noise through a comb the power stretches; MOD: static (crushed)
    channel(3, 'plast', { a: 0.003, d: 0.12, s: 0.4, r: 0.25 }, (col) => {
      const nz = e.add('noise', col, 1, { level: 0.6, color: 0.3 });
      const cb = e.add('comb', col, 2, { coarse: 5, fb: 0.85, damp: 0.3, mix: 1 });
      const st = e.add('crush', col, 2.5, { bits: 5, rate: 6 });
      e.wire(nz, 'out', cb, 'in');
      e.wire(cb, 'out', st, 'in');
      return { members: [nz, cb, st], power: [[cb, 'pitch']], s1: [cb, 'coarse', 'tone'], s2: [cb, 'fb', 'squish'], a: [cb, 'out'], b: [st, 'out'] };
    }),
    // CYMPATH: metal / strike / harmonic / scream / crumble: a three-voice cluster of narrow squares crumbled by a
    // Bitcrusher; MOD: the cluster uncrushed. Voltage starving: the pitch slider (a Macro on the coarse tune, -10 .. +40
    // semitones) also sets the level, so lower is quieter
    channel(4, 'cympath', { a: 0.001, d: 0.15, s: 0.2, r: 0.35 }, (col) => {
      const osc = e.add('osc', col, 1, { wave: 3, coarse: 26, pw: 0.35, level: 0.6, unison: 3, detune: 100, blend: 0.5 });
      const slider = e.add('macro', col, 0.9, { value: 0.72 }); // (26 semitones, as the FM-1 version)
      const starve = e.add('scale', col, 1.25, { gain: 1, offset: 0.28 });
      const sv = e.add('vca', col, 1.5, { gain: 1 });
      const crush = e.add('crush', col, 2, { bits: 16, rate: 3 });
      e.wire(slider, 'out', osc, 'p1');
      e.pin(osc, 'p1', 'coarse', [paramUnit(COARSE, -10), paramUnit(COARSE, 40)]);
      e.wire(slider, 'out', starve, 'in');
      e.wire(osc, 'out', sv, 'in');
      e.wire(starve, 'out', sv, 'cv');
      e.wire(sv, 'out', crush, 'in');
      return { members: [osc, slider, starve, sv, crush], power: [[osc, 'pitch']], s1: [slider, 'value', 'pitch'], s2: [crush, 'rate', 'crumble'], a: [crush, 'out'], b: [sv, 'out'] };
    }),
    // CYRINX: avian / atonal / rough / angular: a chirping triangle; MOD: folded
    channel(5, 'cyrinx', { a: 0.005, d: 0.06, s: 0.5, r: 0.12 }, (col, pw) => {
      const osc = e.add('osc', col, 1, { wave: 1, coarse: 12, level: 0.9 });
      const chirp = e.add('scale', col, 2, { gain: 2, offset: 0 });
      const fold = e.add('shape', col, 2.5, { drive: 4, mode: 2, level: 0.7 });
      e.wire(pw, 'out', chirp, 'in');
      e.wire(chirp, 'out', osc, 'pitch');
      e.wire(osc, 'out', fold, 'in');
      return { members: [osc, chirp, fold], power: [], s1: [osc, 'coarse', 'pitch'], s2: [chirp, 'gain', 'chirp'], a: [osc, 'out'], b: [fold, 'out'] };
    }),
    // LARYNX: vocal / round / squeal / bubble: a saw through a formant filter the power moves; MOD: folded
    channel(6, 'larynx', { a: 0.01, d: 0.2, s: 0.6, r: 0.3 }, (col) => {
      const osc = e.add('osc', col, 1, { wave: 2, coarse: -12, level: 0.8 });
      const vow = e.add('vowel', col, 2, { vowel: 0.5, res: 0.7, level: 1 });
      const sq = e.add('shape', col, 2.5, { drive: 6, mode: 2, level: 0.6 });
      e.wire(osc, 'out', vow, 'in');
      e.wire(vow, 'out', sq, 'in');
      return { members: [osc, vow, sq], power: [[osc, 'pitch'], [vow, 'vowel']], s1: [osc, 'coarse', 'pitch'], s2: [vow, 'vowel', 'vowel'], a: [vow, 'out'], b: [sq, 'out'] };
    }),
    // BACID: bass / slam / acidic: a saw into a resonant 24 dB Multimode the power sweeps, then the drive (the FM-1 version's
    // Ladder drive 2: the slam); MOD: its band pass
    channel(7, 'bacid', { a: 0.001, d: 0.18, s: 0.4, r: 0.2 }, (col) => {
      const osc = e.add('osc', col, 1, { wave: 2, coarse: -29, level: 0.9 });
      const lp = e.add('filter', col, 2, { cutoff: 150, res: 0.75, cvamt: 4 });
      const slam = e.add('shape', col, 3, { drive: 2, mode: 0, level: 0.8 });
      e.wire(osc, 'out', lp, 'in');
      return { members: [osc, lp], power: [[lp, 'cv']], s1: [osc, 'coarse', 'pitch'], s2: [lp, 'res', 'acid'], a: [lp, 'lp24'], b: [lp, 'bp'], post: slam };
    }),
  ];
  // the links: the seven between neighbours share both ways, the two at the ends one way each
  // (each an Attenuverter whose gain is the button; DOT/DUAL's turned by its Macro)
  const link = (k: number, from: Ch[], to: Ch[]): number => {
    const v = e.add('scale', 1 + k, 6.5, { gain: 0, offset: 0 });
    for (const c of from) e.wire(c.pw, 'out', v, 'in');
    for (const c of to) for (const [m, port] of c.power) e.wire(v, 'out', m, port);
    return v;
  };
  const links = [...Array.from({ length: 7 }, (_, i) => link(i, [chs[i], chs[i + 1]], [chs[i], chs[i + 1]])), link(7, [chs[7]], [chs[0]]), link(8, [chs[0]], [chs[7]])];
  e.wire(dotDual, 'out', links[0], 'p1');
  e.pin(links[0], 'p1', 'gain', [paramUnit(GAIN, 0), paramUnit(GAIN, 1)]);
  // the CV inputs, each channel through its CV mute button, into its power
  const cvMutes = chs.map((c, i) => {
    const m = e.add('scale', 1 + i, 0.6, { gain: 1, offset: 0 });
    e.wire(i % 2 === 0 ? oddBus : evenBus, 'out', m, 'in');
    e.wire(m, 'out', c.pw, 'in');
    return m;
  });
  e.wire(main, 'out', L, 'p1');
  e.wire(main, 'out', R, 'p1');
  e.wire(L, 'out', scope, 'a');
  e.wire(R, 'out', scope, 'b');
  chs.forEach((c, i) => e.nest(`${i + 1} ${c.name}`, 1 + i, 0, c.members, { inputs: [['gate', c.env, 'gate'], ['power', c.power[0][0], 'in']], outputs: [['out', c.vca, 'out']] }));
  e.input('keys', map, 'keys');
  e.input('odd cv', oddBus, 'in', [xe, 'in']);
  e.input('even cv', evenBus, 'in', [xo, 'in']);
  e.input('touch', pressure, 'in');
  e.input('audio', ain, 'in');
  e.output('l', L, 'out');
  e.output('r', R, 'out');
  chs.forEach((c, i) => e.output(`${i + 1}`, c.vca, 'out'));
  chs.forEach((c, i) => {
    e.param(c.s1[2], c.s1[0], c.s1[1], { head: `${i + 1} ${c.name}`, ...(i % 4 === 0 ? { col: true } : {}) });
    e.param(c.s2[2], c.s2[0], c.s2[1]);
    e.param('vol', c.vca, 'gain');
    e.param('mod', c.mod, 'mix');
    e.param('on', c.mute, 'gain');
    e.param('touch', c.touch, 'ka');
    e.param('to in', i < 4 ? sendA : sendB, `l${(i % 4) + 1}`);
    e.param('to main', i % 2 === 0 ? oddSum : evenSum, `l${(i >> 1) + 1}`);
  });
  links.forEach((l, i) => (i ? e.param(i < 7 ? `${i + 1}-${i + 2}` : i === 7 ? '8>1' : '1>8', l, 'gain') : e.param('1-2', dotDual, 'value', { col: true, head: 'link' })));
  e.param('odd cv', odd, 'value', { col: true, head: 'cv' });
  e.param('even cv', even, 'value');
  cvMutes.forEach((m, i) => e.param(`${i + 1} cv`, m, 'gain', i === 0 ? { head: 'cv mute' } : {}));
  e.param('press', press, 'value', { col: true, head: 'touch plates' });
  e.param('left plate', left, 'value');
  e.param('main', main, 'value', { head: 'out' });
  e.param('bleed', bleed, 'value');
  e.param('out', scope, 'view', { col: true });
}

export const xl: Xl = {
  base: 'Meridian 8',
  build: (fm1) => {
    const x = around('Meridian 8', define('Meridian 8', build));
    const p = x.p;
    // the pattern on a Steps track, as the FM-1 version (gen-presets.ts `sequenced`): Main's keys into PATTERN, PATTERN into
    // the channels; its notes and the tempo are the FM-1 version's
    const into = x.a.inputs.find((r) => r.label === 'keys')!;
    p.cables = p.cables.filter((c) => !(c.from.module === x.main.id && c.from.port === 'keys'));
    const st = addModule(p, DEFS.steps, 20, 300);
    st.name = 'PATTERN';
    wire(p, x.main.id, 'keys', st.id, 'keys');
    for (const t of [into, ...(into.also ?? [])]) wire(p, st.id, 'keys', t.module, t.port);
    // the keyboard's aftertouch presses on the touch plates
    const touch = x.a.inputs.find((r) => r.label === 'touch')!;
    wire(p, x.main.id, 'at', touch.module, touch.port);
    const from = fm1.modules.find((m) => m.type === 'steps' && m.name === 'PATTERN')!;
    st.notes = structuredClone(from.notes);
    for (const k of ['length', 'rate', 'swing', 'gate']) if (k in from.params) st.params[k] = from.params[k];
    x.main.params.tempo = fm1.modules.find((m) => m.type === 'fm1')!.params.tempo;
    level(p, { drums: true });
    p.octave = -1;
    p.notes = NOTES;
    return players(p, true);
  },
};

const NOTES =
  'The Landscape NOON, after its manual: eight channels with MOD, mute and CV mute buttons, velocity as the gate’s voltage, odd / even CV (drones), nine LINK buttons, CYMPATH’s voltage starving, the touch plates (touch, press, aftertouch, left plate), the audio input fed by the channels’ `to in` or a cable (the 1-2 link opens it), individual outputs, the passive mix’s bleed (1: mono). Not here: audio from outside the browser.';
