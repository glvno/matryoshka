// SPDX-License-Identifier: GPL-3.0-only
// Meridian 8 XL: the Landscape NOON, with what the FM-1 version (scripts/gen-assemblies.ts, Meridian 8) left out to fit.
// Sources: Landscape's NOON manual (landscape.fm/s/Noon-Manual-baw6.pdf: power, channels, inputs, CV mute, sliders,
// volume, link, mod, mute, touch plates, audio input, outputs, pitch, drone, tips) and the instrument's page
// (landscape.fm/noon: each channel's character words).
//
// The card has the NOON's 58 controls, one row each; a button is a row of named positions (a Selector):
//  - per channel (DOT, DUAL, SYS, PLAST, CYMPATH, CYRINX, LARYNX, BACID), as "Sliders" lists them: `main` (the main
//    pitch / tone / texture slider), `secondary` (the secondary one), `volume`; then its MOD button (`mod`: up, down),
//    its mute button (`mute`: mute, on) and its CV mute button (`cv mute`: mute, on). Each channel's own card shows the
//    same six;
//  - the nine LINK buttons (off, on): `1-2` (the DOT/DUAL button, which also opens the audio input) .. `7-8`, and the
//    two at the ends, `8>1` and `1>8`;
//  - the main volume (`main volume`).
// Plus the Scope's screen (`out`), a display, not a control.
//
// How each part is built (none of this is on the card; its values stay set in the patch):
//  - the first design the FM-1 could not hold (commit 18ccc6e: it read 85 %): DOT and BACID through Multimodes whose
//    cutoff the power moves per sample (the FM-1 version: Ladders, once per block), CYMPATH a three-voice cluster (one
//    oscillator's three detuned copies) instead of one narrow square;
//  - the gate's voltage: a NOON channel runs on the voltage its gate input brings ("powered and controlled directly from
//    its respective gate input"), so a higher gate is more power. The key's velocity (a Steps note's: the pattern's
//    accents) scales the channel's power (by 0.5: a Macro, 0 = every gate the same, 1 = power = envelope x velocity);
//  - each MOD button switches the circuit to its second mode: DOT the filter pinged (band pass), DUAL its sine through
//    a pinged filter, SYS phased, PLAST static (crushed), CYMPATH the cluster uncrushed (scream), CYRINX folded
//    (rough), LARYNX folded (squeal), BACID the filter's band pass (acidic). Which second mode each circuit has is our
//    reading of the channel's words; up is the first mode;
//  - the mute buttons sit after the gate input (not the odd / even CV, which has its own buttons), so a muted channel
//    still takes CV and a link still shares a neighbour's power into it;
//  - LINK as voltage sharing: the seven buttons between neighbours share both ways, the two at the ends wrap around one
//    way each (`8>1`: channel 8's power into 1, `1>8`: 1's into 8). Linked, a powered channel partly powers an unpowered
//    one;
//  - CYMPATH's voltage starving: its main slider also sets its loudness (lower is lower and quieter);
//  - the passive mix: the odd / even CVs and outputs bleed into each other a little (a Macro, 0.05).
//
// The patch points, as the assembly's ports (a cable is the NOON's interface for each):
//  - the gate inputs are the keys (the eight channels on the white keys from F3, played by the PATTERN track);
//  - the odd and even CV inputs are the inputs `odd cv` and `even cv`, each channel through its CV mute button; CV
//    alone powers a channel (the drone). A Macro inside the assembly for each (0) stands for a fixed voltage;
//  - the external audio input is the input `audio`, opened by the DOT/DUAL link button, into DUAL through a drive. The
//    manual's internal processing (a channel's individual output patched back into the audio input) is a cable from
//    the assembly's output `1`..`8` to its own input `audio`;
//  - the individual outputs are the outputs `1`..`8` (each channel before the main mix); `l` and `r` are the two main
//    outputs, odd channels left and even right.
// The touch plates: the keyboard's aftertouch is a finger across every channel's pair of plates and the left-side
// plates at once. A touched channel's power goes onto a shared bus, and the bus comes back into every touched channel
// through the skin (a slow random wobble on the bus: moisture), so channels send modulation between them and partly
// power an unpowered one, and short trigs give little to share, as the manual says. How much skin each channel has is
// an Attenuverter inside the assembly (1 each); the assembly's input `touch` takes a cable as the pressure too.
//
// Not here, and why (D-347's reasons): the NOON takes a channel out of the main outputs when its individual output is
// plugged, and sends all eight channels to the top main output when the bottom one is unplugged; the engines cannot
// tell that a port has a cable, so a Mixer level per channel (1) and a mono Macro (0) inside the assembly stand for
// those plugs. Audio from outside the browser into the audio input needs a module that reads the computer's audio input
// (an Audio in, in both engines). The jacks themselves, the passive circuit's skin and moisture response: hardware.
import { addModule, paramUnit } from '../../src/patch';
import { DEFS } from '../../src/modules';
import { level, players, wire } from '../factory-build';
import type { Xl } from './xl';
import { around, define, type Def } from './def';

/** the white keys from F3 (gen-assemblies.ts PLATE_KEYS[1], the drum kits' rows) */
const ROW_KEYS = [53, 55, 57, 59, 60, 62, 64, 65];

const COARSE = DEFS.osc.params.find((d) => d.name === 'coarse')!;
const GAIN = DEFS.scale.params.find((d) => d.name === 'gain')!;
const KA = DEFS.math.params.find((d) => d.name === 'ka')!;
const OFF = DEFS.math.params.find((d) => d.name === 'off')!;

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
  /** the MOD crossfade, the mute button, the touch (skin x pressure) */
  mod: number;
  mute: number;
  touch: number;
}

/** a two-position button as a Selector's table: position 1 plays 0, position 2 plays 1 */
const OFF_ON = { count: 2, v1: 0, v2: 1 };
/** the names of the buttons' positions by row label */
const NAMES: Record<string, string[]> = { mod: ['up', 'down'], mute: ['mute', 'on'], 'cv mute': ['mute', 'on'] };
const LINK_NAMES = ['off', 'on'];

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
  // the gate's voltage: each channel's power is its envelope x (1 - gate v + gate v x velocity)
  const gateV = e.add('macro', 0, 5, { value: 0.5 });
  // the touch plates: pressure (press + aftertouch), the shared bus with the skin's wobble, the left-side plates
  const press = e.add('macro', 0, 5.5, { value: 0 });
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
  const touchIn = e.add('scale', 0, 10, { gain: 1, offset: 0 });
  e.wire(busV, 'out', touchIn, 'in');
  e.wire(leftV, 'out', touchIn, 'in');
  // the DOT/DUAL link button: it also opens the audio input
  const dotDual = e.add('select', 1, 6, OFF_ON);
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
  const mono = e.add('macro', 11, 2, { value: 0 });
  const both = e.add('scale', 11, 0.5, { gain: 0.5, offset: 0 });
  const Lo = e.add('xfade', 11, 0, { mix: 0 });
  const Ro = e.add('xfade', 11, 1, { mix: 0 });
  e.wire(L, 'out', both, 'in');
  e.wire(R, 'out', both, 'in');
  e.wire(L, 'out', Lo, 'a');
  e.wire(R, 'out', Ro, 'a');
  e.wire(both, 'out', Lo, 'b');
  e.wire(both, 'out', Ro, 'b');
  e.wire(mono, 'out', Lo, 'pos');
  e.wire(mono, 'out', Ro, 'pos');
  const scope = e.add('scope', 12, 0, { time: 16 });

  /** a channel: its power (an ADSR on its gate, scaled by the gate's voltage, through its mute button, plus its CV) into
   * its VCA and `power`; `a` / `b` are the MOD crossfade's two inputs, `post` a module between the crossfade and the VCA */
  type Circuit = Omit<Ch, 'name' | 'env' | 'vca' | 'mod' | 'pw' | 'mute' | 'touch' | 'power'> & { power: [number, string][]; a: [number, string]; also?: [number, string]; b: [number, string]; post?: number };
  const channel = (i: number, name: string, adsr: Record<string, number>, f: (col: number, pw: number) => Circuit): Ch => {
    const col = 1 + i;
    const env = e.add('adsr', col, 0, adsr);
    const gv = e.add('math', col, 0.25, { ka: 0, kb: 1, off: 1 }); // the gate's voltage: (velocity x ka + off) x envelope
    const mute = e.add('select', col, 0.4, { count: 2, pos: 2 }); // the mute button (mute, on), after the gate input
    const pw = e.add('scale', col, 0.5, { gain: 1, offset: 0 });
    // what reaches the circuit: its own power, the links' and the touch plates'
    const node = e.add('scale', col, 0.75, { gain: 1, offset: 0 });
    const vca = e.add('vca', col, 4, { gain: 0.8 });
    const mod = e.add('select', col, 3.5, { count: 2 }); // the MOD button: the circuit's two modes
    e.wire(map, `g${i + 1}`, env, 'gate');
    e.wire(map, `v${i + 1}`, gv, 'a');
    e.wire(env, 'env', gv, 'b');
    e.wire(gateV, 'out', gv, 'p1');
    e.wire(gateV, 'out', gv, 'p2');
    e.pin(gv, 'p1', 'ka', [paramUnit(KA, 0), paramUnit(KA, 1)]);
    e.pin(gv, 'p2', 'off', [paramUnit(OFF, 1), paramUnit(OFF, 0)]);
    e.wire(gv, 'mul', mute, 'in2');
    e.wire(mute, 'out', pw, 'in');
    e.wire(map, `g${i + 1}`, leftSrc, 'in'); // (the gate inputs themselves, before the channel)
    e.wire(pw, 'out', node, 'in');
    const c = f(col, node);
    e.wire(c.a[0], c.a[1], mod, 'in1');
    if (c.also) e.wire(c.also[0], c.also[1], mod, 'in1');
    e.wire(c.b[0], c.b[1], mod, 'in2');
    if (c.post) {
      e.wire(mod, 'out', c.post, 'in');
      e.wire(c.post, 'out', vca, 'in');
    } else e.wire(mod, 'out', vca, 'in');
    const power: [number, string][] = [[vca, 'cv'], ...c.power];
    for (const [m, port] of power) e.wire(node, 'out', m, port);
    // the touch plates: how much skin (`touch`) x pressure; the channel's power onto the bus, the bus back into the channel
    const touch = e.add('scale', col, 4.5, { gain: 1, offset: 0 });
    const tOut = e.add('vca', col, 4.75, { gain: 1 });
    const tIn = e.add('vca', col, 5, { gain: 1 });
    e.wire(pressure, 'out', touch, 'in');
    e.wire(pw, 'out', tOut, 'in');
    e.wire(touch, 'out', tOut, 'cv');
    e.wire(tOut, 'out', bus, 'in');
    e.wire(touchIn, 'out', tIn, 'in');
    e.wire(touch, 'out', tIn, 'cv');
    e.wire(tIn, 'out', node, 'in');
    // the sends: into the audio input, into the main mix
    e.wire(vca, 'out', i < 4 ? sendA : sendB, `in${(i % 4) + 1}`);
    e.wire(vca, 'out', i % 2 === 0 ? oddSum : evenSum, `in${(i >> 1) + 1}`);
    return {
      name, env, vca, mod, pw, mute, touch, s1: c.s1, s2: c.s2, power: [[node, 'in']],
      members: [env, mute, pw, node, ...c.members, mod, ...(c.post ? [c.post] : []), vca],
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
    const m = e.add('select', 1 + i, 0.6, { count: 2, pos: 2 }); // the CV mute button (mute, on)
    e.wire(i % 2 === 0 ? oddBus : evenBus, 'out', m, 'in2');
    e.wire(m, 'out', c.pw, 'in');
    return m;
  });
  // the other eight link buttons (off, on): each sets its link's gain to 0 or 1
  const buttons = links.slice(1).map((l, i) => {
    const sw = e.add('select', 2 + i, 6.75, OFF_ON);
    e.wire(sw, 'out', l, 'p1');
    e.pin(l, 'p1', 'gain', [paramUnit(GAIN, 0), paramUnit(GAIN, 1)]);
    return sw;
  });
  // the left-side plates: the keyboard's aftertouch presses them too
  e.wire(pressure, 'out', leftV, 'cv');
  e.wire(main, 'out', L, 'p1');
  e.wire(main, 'out', R, 'p1');
  e.wire(Lo, 'out', scope, 'a');
  e.wire(Ro, 'out', scope, 'b');
  chs.forEach((c, i) => e.nest(`${i + 1} ${c.name}`, 1 + i, 0, [...c.members, cvMutes[i]], { inputs: [['gate', c.env, 'gate'], ['power', c.power[0][0], 'in']], outputs: [['out', c.vca, 'out']] }));
  e.input('keys', map, 'keys');
  e.input('odd cv', oddBus, 'in', [xe, 'in']);
  e.input('even cv', evenBus, 'in', [xo, 'in']);
  e.input('touch', pressure, 'in');
  e.input('audio', ain, 'in');
  e.output('l', Lo, 'out');
  e.output('r', Ro, 'out');
  chs.forEach((c, i) => e.output(`${i + 1}`, c.vca, 'out'));
  // the card: the NOON's controls, one row each (the manual's "Sliders", "Volume controls", "Link buttons", "Mod
  // buttons", "Mute buttons" and "CV mute buttons")
  chs.forEach((c, i) => {
    e.param('main', c.s1[0], c.s1[1], { head: `${i + 1} ${c.name}`, ...(i % 4 === 0 ? { col: true } : {}) });
    e.param('secondary', c.s2[0], c.s2[1]);
    e.param('volume', c.vca, 'gain');
    e.param('mod', c.mod, 'pos');
    e.param('mute', c.mute, 'pos');
    e.param('cv mute', cvMutes[i], 'pos');
  });
  e.param('1-2', dotDual, 'pos', { col: true, head: 'link' });
  buttons.forEach((sw, i) => e.param(i < 6 ? `${i + 2}-${i + 3}` : i === 6 ? '8>1' : '1>8', sw, 'pos'));
  e.param('main volume', main, 'value', { head: 'out' });
  e.param('out', scope, 'view', { col: true });
}

export const xl: Xl = {
  base: 'Meridian 8',
  build: (fm1) => {
    const built = define('Meridian 8', build);
    for (const list of [built.def.params, ...(built.def.assemblies ?? []).map((n) => n.params)])
      for (const r of list) {
        const names = NAMES[r.label] ?? (/^(\d-\d|\d>\d)$/.test(r.label) ? LINK_NAMES : undefined);
        if (names) r.names = names;
      }
    const x = around('Meridian 8', built);
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
  'The Landscape NOON, after its manual. The card is its 58 controls: per channel main, secondary, volume, MOD, mute and CV mute; nine LINK buttons; the main volume. Patch points are ports: odd / even cv, audio (opened by the 1-2 link; patch an output 1..8 into it for internal processing), outputs 1..8, l, r. Aftertouch presses all touch plates. Not here: audio from outside the browser; plug-sensing outputs (a level and a mono Macro inside stand in).';
