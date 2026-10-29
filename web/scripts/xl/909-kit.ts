// SPDX-License-Identifier: GPL-3.0-only
// 909 Kit XL: the 909 Kit with every instrument, knob and pattern feature of the Roland TR-909. The FM-1 version
// (web/presets/NN-909-kit.json, D-337 in docs/ledger/patches-and-presets.md) plays rows 3 and 5..8 on one lean card
// "perc": the clap is the snare's noise through a band pass, the open hat is the closed hat's filtered noise, the tom a
// sine, the rim a short triangle, the cowbell two squares, each with one envelope and its velocity through a macro range.
// Its kick, snare and closed hat (rows 1, 2, 4), its DRUMS track and Drum map stay as they are here.
// The TR-909 (Roland's owner's manual, archive.org "synthmanual-roland-tr-909-owners-manual"; Electronics & Music Maker,
// March 1984) has a bass drum (TUNE LEVEL ATTACK DECAY), snare (TUNE LEVEL TONE SNAPPY), low / mid / high toms (TUNE
// LEVEL DECAY), rim shot and hand clap (LEVEL), closed and open hi-hat (one LEVEL, a DECAY each; the closed hat cuts the
// open one), crash and ride (LEVEL TUNE), TOTAL ACCENT, and per pattern: SCALE (1/16, 1/8 triplet, 1/32, 1/16 triplet),
// LAST STEP (1..16), SHUFFLE (7 levels) and FLAM (8 intervals).
// Three tracks, each with its Drum map, all on PLAY:
//   DRUMS (the FM-1 version's rows and keys): KICK SNARE CLAP CL HAT OP HAT LOW TOM RIM HI TOM (row 8: the TR-909 has
//     no cowbell, D-340)
//   DRUMS 2: MID TOM CRASH RIDE ACCENT, on the white keys G4 A4 B4 C5
//   FLAM: BD SD LT MT HT FLAM, each on the black key above its drum (F#3 G#3 D#4 G#4 F#4)
// Main's keys go into all three, so the keyboard plays every row. The new voices, each a card with the original's knobs:
//   clap (row 3): its own noise through a band pass, retriggered three times in 30 ms (a window and a 100 Hz square),
//     then a tail; LEVEL
//   open hat (row 5): its own metallic source (a detuned square cluster and noise, high passed); DECAY; the closed hat's
//     row latches it shut (a sample and hold on either hat's trigger)
//   low / mid / high tom: a sine with a pitch drop and a little low-passed noise; TUNE, DECAY, LEVEL
//   rim (row 7): two short sines (about 520 Hz and 1.6 kHz) and a high-passed click; LEVEL
//   crash, ride: stand-ins for the original's samples, a detuned square cluster stacked an octave and a fifth up, and
//     noise, high passed, with fixed long decays as on the original; TUNE (the cluster and the filter), LEVEL
// The hats share one LEVEL (a Mixer after both, on the hihat card). The card "accent flam" holds the rest:
//   accent: a step of the ACCENT row accents every drum on it by TOTAL ACCENT (1 + total accent). The six drums the
//     TR-909 accents on their own (kick, snare, the toms, closed hat) also take their row's velocity: a step above 100
//     plays louder, 127 by the fixed 1.27 of the FM-1 version. The louder of the two wins (the manual: a high TOTAL
//     ACCENT hides the drum's own accent). Each drum holds the level it was hit with (a sample and hold).
//   flam: a FLAM row plays its drum twice, on the step and FLAM later (10..38 ms, not tempo bound), without the drum's
//     own accent (the TR-909 writes a flam in place of a plain or accented step); TOTAL ACCENT still counts
//   shuffle, scale: one Macro each into all three tracks' swing (50..75 %) and rate (1/8T, 1/16, 1/16T, 1/32)
// Not here: LAST STEP is each track's len (set the three alike: a Steps track has two pins, both taken); the patterns,
// tracks and chains of the TR-909's memory (a song mode would need a pattern-chaining sequencer module); the jacks
// (individual outputs, trigger outs, sync, MIDI) and the tape and cartridge memory.
import { DEFS } from '../../src/modules';
import { addModule, paramUnit, rowDef, STEP_VEL, type ModuleInst, type Patch } from '../../src/patch';
import { addMember, assembliesOf, assemblyOf, deleteAssembly, removeMember, type AssemblyInst, type ParamRef } from '../../src/assembly';
import { mod, players, plugIn, plugOut, wire } from '../factory-build';
import { define, KIT_NOTES, matchLevel, place, type Built, type Def } from './def';
import type { Xl } from './xl';

const NOTES = 'Every TR-909 drum, knob and pattern feature. Three tracks: DRUMS (the 909 Kit\'s rows), DRUMS 2 (mid tom, ' +
  'crash, ride, ACCENT), FLAM (kick, snare, toms). The crash and ride stand in for samples. Card accent flam: TOTAL ACCENT, ' +
  'FLAM, SHUFFLE and SCALE for all three tracks; kick, snare, toms and closed hat also accent on velocity 127. The hats ' +
  'share one level (hihat card). LAST STEP is each track\'s len: set them alike.';

/** the velocity of a plain step as the Drum map gives it (0..1) */
const PLAIN = STEP_VEL / 127;
/** a drum's own accent: level 1 + K (velocity - plain), so 127 plays 127 / 100 of a plain step, as on the FM-1 version */
const K = Math.round(((127 / STEP_VEL - 1) / (1 - PLAIN)) * 100) / 100;
/** TOTAL ACCENT as it ships: an accented step at 1.5 times a plain one */
const TOTAL = 0.5;
/** the flam's second hit after 10..38 ms (the TR-909's eight intervals, after the e-licktronic forum's measurements); the
 * envelope's second rise (r3) reaches 0.95 in that time */
const FLAM_MS: [number, number] = [10, 38];
const R3 = rowDef(DEFS.env, 'r3')!;
const flamRange: [number, number] = [paramUnit(R3, FLAM_MS[0] / 1000 / 0.95), paramUnit(R3, FLAM_MS[1] / 1000 / 0.95)];

/** drums are played by short trigs: every envelope one-shot (gen-assemblies.ts does the same for its Drums shelf) */
function drums(built: Built): Built {
  for (const m of built.def.modules) if (m.type === 'env') m.params.shot = 1;
  return built;
}

/** a voice: its sources into `out`, an input `gate`, its level (the accent stage) on the out VCA's cv */
function voice(name: string, f: (b: Def, gate: (m: number, port: string) => void) => { into: [number, string][]; rows: [string, number, string][] }, lvl: number): Built {
  return drums(define(name, (b) => {
    const gates: [number, string][] = [];
    const { into, rows } = f(b, (m, port) => gates.push([m, port]));
    const out = b.add('vca', 4, 0.4, { gain: lvl });
    for (const [m, port] of into) b.wire(m, port, out, 'in');
    b.input('gate', gates[0][0], gates[0][1], ...gates.slice(1));
    b.input('level', out, 'cv');
    b.output('out', out, 'out');
    rows.forEach(([label, m, param], i) => b.param(label, m, param, i === 0 ? { head: name } : {}));
    b.param('level', out, 'gain', rows.length ? {} : { head: name });
  }));
}

/** a 909 tom: a sine with a pitch drop and a little low-passed noise, one envelope */
const tom = (name: string, coarse: number, decay: number): Built => voice(name, (b, gate) => {
  const osc = b.add('osc', 0, 0, { wave: 0, coarse, level: 1 });
  const penv = b.add('env', 0, 1, { l1: 0.35, r1: 0.001, l2: 0, r2: 0.06, l3: 0, r3: 0.001, l4: 0, r4: 0.001 });
  const nz = b.add('noise', 1, 0, { level: 0.3, color: 0 });
  const lp = b.add('filter', 2, 0, { cutoff: 1800, res: 0 });
  const mix = b.add('mixer', 2, 1, { l1: 1, l2: 0.4, l3: 0, l4: 0 });
  const env = b.add('env', 3, 0, { l1: 1, r1: 0.001, l2: 0, r2: decay, l3: 0, r3: 0.001, l4: 0, r4: 0.001 });
  const vca = b.add('vca', 3, 1);
  b.wire(penv, 'env', osc, 'pitch');   // (a drop of 0.35 octave)
  b.wire(nz, 'out', lp, 'in');
  b.wire(osc, 'out', mix, 'in1');
  b.wire(lp, 'lp12', mix, 'in2');
  b.wire(mix, 'out', vca, 'in');
  b.wire(env, 'env', vca, 'cv');
  gate(env, 'gate');
  gate(penv, 'gate');
  return { into: [[vca, 'out']], rows: [['tune', osc, 'coarse'], ['decay', env, 'r2']] };
}, 0.5);

const CLAP = voice('clap', (b, gate) => {
  const win = b.add('pulse', 0, 0, { time: 0.03 });
  const rate = b.add('lfo', 0, 1, { wave: 3, rate: 100, depth: 1 });
  const and = b.add('logic', 1, 0, { thresh: 0.5 });
  const benv = b.add('env', 1, 1, { l1: 1, r1: 0.001, l2: 0, r2: 0.009, l3: 0, r3: 0.001, l4: 0, r4: 0.001 });
  const nz = b.add('noise', 2, 0, { level: 1, color: 0 });
  const bp = b.add('filter', 2, 1, { cutoff: 1100, res: 0.45 });
  const bv = b.add('vca', 3, 0);
  const tenv = b.add('env', 3, 1, { l1: 1, r1: 0.001, l2: 0, r2: 0.14, l3: 0, r3: 0.001, l4: 0, r4: 0.001 });
  const tv = b.add('vca', 3, 2, { gain: 0.45 });
  b.wire(win, 'out', and, 'a');
  b.wire(rate, 'out', and, 'b');
  b.wire(and, 'and', benv, 'gate');
  b.wire(nz, 'out', bp, 'in');
  b.wire(bp, 'bp', bv, 'in');
  b.wire(bp, 'bp', tv, 'in');
  b.wire(benv, 'env', bv, 'cv');
  b.wire(tenv, 'env', tv, 'cv');
  gate(win, 'trig');
  gate(rate, 'reset');
  gate(tenv, 'gate');
  return { into: [[bv, 'out'], [tv, 'out']], rows: [] };
}, 1.2);

const OPEN_HAT = drums(define('open hat', (b) => {
  const metal = b.add('osc', 0, 0, { wave: 3, coarse: 38, level: 0.6, unison: 5, detune: 90, pw: 0.3 });
  const nz = b.add('noise', 0, 1, { level: 0.5, color: 0 });
  const src = b.add('mixer', 1, 0, { l1: 0.7, l2: 0.7, l3: 0, l4: 0 });
  const hp = b.add('filter', 1, 1, { cutoff: 7000, res: 0.2 });
  const env = b.add('env', 2, 0, { l1: 1, r1: 0.001, l2: 0.4, r2: 0.05, l3: 0, r3: 0.45, l4: 0, r4: 0.001 });
  const vca = b.add('vca', 2, 1);
  // the closed hat cuts it: either hat's trigger (the two gates summed) samples the open hat's gate (1 after an open hit,
  // 0 after a closed one)
  const latch = b.add('sh', 1, 2, { mode: 0 });
  const cut = b.add('vca', 2, 2);
  const out = b.add('vca', 3, 1, { gain: 1.2 });
  b.wire(metal, 'out', src, 'in1');
  b.wire(nz, 'out', src, 'in2');
  b.wire(src, 'out', hp, 'in');
  b.wire(hp, 'hp', vca, 'in');
  b.wire(env, 'env', vca, 'cv');
  b.wire(vca, 'out', cut, 'in');
  b.wire(latch, 'out', cut, 'cv');
  b.wire(cut, 'out', out, 'in');
  b.input('gate', env, 'gate', [latch, 'in']);
  b.input('either hat', latch, 'clock');   // (both hats' rows)
  b.input('level', out, 'cv');
  b.output('out', out, 'out');
  b.param('decay', env, 'r3', { head: 'open hat' });   // (its LEVEL is the hats' one, on the hihat card)
}));

const RIM = voice('rim', (b, gate) => {
  const o1 = b.add('osc', 0, 0, { wave: 0, coarse: 12, level: 0.8 });
  const o2 = b.add('osc', 0, 1, { wave: 0, coarse: 31, level: 0.5 });
  const nz = b.add('noise', 0, 2, { level: 0.5, color: 0 });
  const hp = b.add('filter', 1, 2, { cutoff: 5000, res: 0 });
  const tenv = b.add('env', 1, 0, { l1: 1, r1: 0.001, l2: 0, r2: 0.025, l3: 0, r3: 0.001, l4: 0, r4: 0.001 });
  const cenv = b.add('env', 1, 1, { l1: 1, r1: 0.001, l2: 0, r2: 0.004, l3: 0, r3: 0.001, l4: 0, r4: 0.001 });
  const mix = b.add('mixer', 2, 0, { l1: 1, l2: 1, l3: 0, l4: 0 });
  const tv = b.add('vca', 2, 1);
  const cv = b.add('vca', 2, 2);
  b.wire(o1, 'out', mix, 'in1');
  b.wire(o2, 'out', mix, 'in2');
  b.wire(mix, 'out', tv, 'in');
  b.wire(tenv, 'env', tv, 'cv');
  b.wire(nz, 'out', hp, 'in');
  b.wire(hp, 'hp', cv, 'in');
  b.wire(cenv, 'env', cv, 'cv');
  gate(tenv, 'gate');
  gate(cenv, 'gate');
  return { into: [[tv, 'out'], [cv, 'out']], rows: [] };
}, 0.35);

/** a cymbal (a stand-in for the TR-909's 6-bit samples): a detuned square cluster and noise, high passed, a fixed decay (the
 * original has none to turn); TUNE (octaves) moves the cluster and the filter, as the original's sample rate does */
const cymbal = (name: string, o: { coarse: number; noise: number; hp: number; hold: number; decay: number }, lvl: number): Built => voice(name, (b, gate) => {
  const tune = b.add('const', 0, 2, { value: 0 });
  const metal = b.add('osc', 0, 0, { wave: 3, coarse: o.coarse, level: 0.6, unison: 5, detune: 70, pw: 0.35, stack: 3 });
  const nz = b.add('noise', 0, 1, { level: o.noise, color: 0 });
  const mix = b.add('mixer', 1, 0, { l1: 0.6, l2: 0.7, l3: 0, l4: 0 });
  const hp = b.add('filter', 2, 0, { cutoff: o.hp, res: 0.15 });
  const env = b.add('env', 3, 0, { l1: 1, r1: 0.001, l2: o.hold, r2: 0.06, l3: 0, r3: o.decay, l4: 0, r4: 0.001 });
  const vca = b.add('vca', 3, 1);
  b.wire(tune, 'out', metal, 'pitch');
  b.wire(tune, 'out', hp, 'cv');
  b.wire(metal, 'out', mix, 'in1');
  b.wire(nz, 'out', mix, 'in2');
  b.wire(mix, 'out', hp, 'in');
  b.wire(hp, 'hp', vca, 'in');
  b.wire(env, 'env', vca, 'cv');
  gate(env, 'gate');
  return { into: [[vca, 'out']], rows: [['tune', tune, 'value']] };
}, lvl);

const CRASH = cymbal('crash', { coarse: 30, noise: 0.8, hp: 5000, hold: 0.55, decay: 1.4 }, 0.7);
const RIDE = cymbal('ride', { coarse: 27, noise: 0.35, hp: 3500, hold: 0.45, decay: 2.2 }, 1);

/** the drums, in the card's order: their key, whether the TR-909 accents them on their own, whether they flam */
const DRUMS = [
  { key: 'bd', own: true, flam: true }, { key: 'sd', own: true, flam: true }, { key: 'hc', own: false, flam: false },
  { key: 'ch', own: true, flam: false }, { key: 'oh', own: false, flam: false }, { key: 'lt', own: true, flam: true },
  { key: 'mt', own: true, flam: true }, { key: 'ht', own: true, flam: true }, { key: 'rs', own: false, flam: false },
  { key: 'cr', own: false, flam: false }, { key: 'rd', own: false, flam: false },
];

/** a Selector's values v1..vn spread evenly over 0..1 (position 1 at 0, n at 1) */
const steps = (n: number): Record<string, number> => Object.fromEntries(Array.from({ length: n }, (_, k) => [`v${k + 1}`, k / (n - 1)]));
/** FLAM's eight intervals (the TR-909 sets them on step keys 1..8), position 1 the shortest; SHUFFLE's seven levels,
 * position 1 straight; SCALE's four lengths in the TR-909's order */
const FLAM_NAMES = ['1', '2', '3', '4', '5', '6', '7', '8'];
const FLAM_POS = 4;
const SHUFFLE_NAMES = ['1', '2', '3', '4', '5', '6', '7'];
const SCALE_NAMES = ['1/16', '1/8T', '1/32', '1/16T'];
/** name the positions of these Selector rows (ParamRef.names, D-636 in docs/ledger/editor.md) */
function named(built: Built, names: Record<string, string[]>): Built {
  for (const r of built.def.params) if (names[r.label]) r.names = [...names[r.label]];
  return built;
}

/** the card "accent flam": per drum its level (inputs `<key>`: the row's gate, `<key> vel`) and, for a drum that flams,
 * its trigger (`<key> flam`, its FLAM row's gate; out `<key> trig`); `accent` (the ACCENT row's gate);
 * the SHUFFLE and SCALE Macros out to the tracks */
const CONTROL = named(drums(define('accent flam', (b) => {
  const acc = b.add('math', 0, 0, { ka: TOTAL, kb: 0, off: 1 });   // 1 + TOTAL ACCENT on an accented step, else 1
  // FLAM, SHUFFLE and SCALE are switches on the TR-909 (set with the step keys): Selectors, their values into the tracks
  const flam = b.add('select', 0, 1, { pos: FLAM_POS, count: 8, ...steps(8) });
  const shuffle = b.add('select', 0, 2, { pos: 1, count: 7, ...steps(7) });
  const scale = b.add('select', 0, 3, { pos: 1, count: 4, v1: 1 / 3, v2: 0, v3: 1, v4: 2 / 3 });   // (the tracks' rate range: 1/8T 1/16 1/16T 1/32)
  DRUMS.forEach((d, i) => {
    const col = 1 + i;
    // the level the drum was hit with, held until its next hit
    const held = b.add('sh', col, 0, { mode: 0 });
    let vel: [number, string] | null = null;
    if (d.own) {
      const own = b.add('math', col, 1, { ka: K, kb: 1, off: 1 - K * PLAIN });   // the louder of its own and the total accent
      b.wire(acc, 'add', own, 'b');
      b.wire(own, 'max', held, 'in');
      vel = [own, 'a'];
    } else b.wire(acc, 'add', held, 'in');
    if (d.flam) {
      // the drum's trigger: its row's gate, or the FLAM row's envelope crossing 0.95 (the Logic's threshold) twice: at once,
      // and FLAM later (it falls back to 0, then rises again over r3). A short pulse on the FLAM row samples the level
      // with the velocity at 0 (a flam has no accent of its own; TOTAL ACCENT still counts), once for both hits.
      const flams = b.add('env', col, 2, { l1: 1, r1: 0.001, l2: 0, r2: 0.001, l3: 1, r3: 0.025, l4: 0, r4: 0.001 });
      const both = b.add('logic', col, 3, { thresh: 0.95 });
      const onset = b.add('pulse', col, 4, { time: 0.002 });
      const vsel = b.add('xfade', col, 5, { mix: 0 });
      b.wire(flams, 'env', both, 'b');
      b.wire(onset, 'out', held, 'clock');
      b.wire(onset, 'out', vsel, 'pos');
      b.wire(flam, 'out', flams, 'p1');
      b.pin(flams, 'p1', 'r3', flamRange);
      b.wire(vsel, 'out', vel![0], vel![1]);
      b.input(d.key, both, 'a', [held, 'clock']);
      b.input(`${d.key} vel`, vsel, 'a');
      b.input(`${d.key} flam`, flams, 'gate', [onset, 'trig']);
      b.output(`${d.key} trig`, both, 'or');
    } else {
      b.input(d.key, held, 'clock');
      if (vel) b.input(`${d.key} vel`, vel[0], vel[1]);
    }
    b.output(`${d.key} level`, held, 'out');
  });
  b.input('accent', acc, 'a');
  b.output('shuffle', shuffle, 'out');
  b.output('scale', scale, 'out');
  b.param('total accent', acc, 'ka', { head: 'accent flam' });
  b.param('flam', flam, 'pos');
  b.param('shuffle', shuffle, 'pos');
  b.param('scale', scale, 'pos');
})), { flam: FLAM_NAMES, shuffle: SHUFFLE_NAMES, scale: SCALE_NAMES });

/** the rows of the new Drum maps: name and key; '-' rows are unused */
const MAP2: [string, number][] = [['MID TOM', 67], ['CRASH', 69], ['RIDE', 71], ['ACCENT', 72], ['-', 0], ['-', 0], ['-', 0], ['-', 0]];
const MAP3: [string, number][] = [['BD FLAM', 54], ['SD FLAM', 56], ['LT FLAM', 63], ['MT FLAM', 68], ['HT FLAM', 66], ['-', 0], ['-', 0], ['-', 0]];
/** each drum's row: [map (1..3), row] for its own row and its FLAM row */
const ROWS: Record<string, { at: [number, number]; flam?: [number, number] }> = {
  bd: { at: [1, 1], flam: [3, 1] }, sd: { at: [1, 2], flam: [3, 2] }, hc: { at: [1, 3] }, ch: { at: [1, 4] }, oh: { at: [1, 5] },
  lt: { at: [1, 6], flam: [3, 3] }, rs: { at: [1, 7] }, ht: { at: [1, 8], flam: [3, 5] }, mt: { at: [2, 1], flam: [3, 4] },
  cr: { at: [2, 2] }, rd: { at: [2, 3] },
};
/** the new voices by key */
const VOICES: [string, Built][] = [['hc', CLAP], ['oh', OPEN_HAT], ['lt', tom('low tom', -17, 0.35)], ['mt', tom('mid tom', -12, 0.32)], ['ht', tom('high tom', -8, 0.28)], ['rs', RIM], ['cr', CRASH], ['rd', RIDE]];

/**
 * The cards as the TR-909's panel (D-347 in docs/ledger/patches-and-presets.md): one row per knob, named as the panel
 * names it, in its order. The FM-1 version's kick, snare and hihat cards show how they are built (an envelope's r2, a
 * mixer's l2): those rows go, their values stay. Its "Macros" card (the FM-1's knob page: snare snap, kick decay, snare
 * tail, hat decay) duplicates them: each macro joins the voice it turns, off the card; snare snap is the snare's TONE.
 */
function panel(p: Patch, levelVca: Record<string, number>): void {
  const card = (name: string): AssemblyInst => {
    const a = assembliesOf(p).find((x) => x.name === name);
    if (!a) throw new Error(`909 Kit XL: no card ${name}`);
    return a;
  };
  const row = (a: AssemblyInst, label: string): ParamRef => {
    const r = a.params.find((x) => x.label === label);
    if (!r) throw new Error(`909 Kit XL: no row ${label} on ${a.name}`);
    return r;
  };
  // the Macros card's macros join the voices they turn
  const macros = card('Macros');
  const snap = row(macros, 'snare snap').module;
  for (const id of [...macros.modules]) {
    const to = p.cables.find((c) => c.from.module === id)!.to.module;
    removeMember(p, macros, id);
    addMember(p, assemblyOf(p, to)!, id);
  }
  if (assembliesOf(p).some((a) => a.name === 'Macros')) throw new Error('909 Kit XL: the Macros card is not empty');
  /** the card's rows: [label, module, parameter], the first keeping the card's heading */
  const set = (a: AssemblyInst, rows: [string, number, string][]): void => {
    const head = a.params[0]?.head;
    a.params = rows.map(([label, module, param], i) => ({ module, param, label, ...(i === 0 && head ? { head } : {}) }));
  };
  const at = (a: AssemblyInst, label: string): [number, string] => {
    const r = row(a, label);
    return [r.module, r.param];
  };
  const kick = card('kick');
  set(kick, [['tune', ...at(kick, 'coarse')], ['level', levelVca.bd, 'gain'], ['attack', ...at(kick, 'l2')], ['decay', ...at(kick, 'r3')]]);
  const snare = card('snare');
  set(snare, [['tune', ...at(snare, 'coarse')], ['level', ...at(snare, 'level')], ['tone', snap, 'value'], ['snappy', ...at(snare, 'l1')]]);
  const hihat = card('hihat');
  set(hihat, [['level', ...at(hihat, 'level')], ['ch decay', ...at(hihat, 'r3')]]);
  const oh = card('open hat');
  set(oh, [['oh decay', ...at(oh, 'decay')]]);
  for (const t of ['low tom', 'mid tom', 'high tom']) {
    const a = card(t);
    set(a, [['tune', ...at(a, 'tune')], ['level', ...at(a, 'level')], ['decay', ...at(a, 'decay')]]);
  }
  for (const t of ['crash', 'ride']) {
    const a = card(t);
    set(a, [['level', ...at(a, 'level')], ['tune', ...at(a, 'tune')]]);
  }
}

export const xl: Xl = {
  base: '909 Kit',
  build: (fm1: Patch): Patch => {
    const before = structuredClone(fm1);
    const p = fm1;
    p.notes = NOTES;
    const perc = assembliesOf(p).find((a) => a.name === 'perc')!;
    const percAt = { x: perc.x, y: perc.y };
    deleteAssembly(p, perc.id);
    const main = p.modules.find((m) => m.type === 'fm1')!;
    const map1 = p.modules.find((m) => m.type === 'drummap')!;
    map1.names = ['KICK', 'SNARE', 'CLAP', 'CL HAT', 'OP HAT', 'LOW TOM', 'RIM', 'HI TOM'];
    const drumsTrack = p.modules.find((m) => m.type === 'steps' && m.name === 'DRUMS')!;
    const out = p.modules.find((m) => m.type === 'output')!;
    const mix = p.modules.find((m) => m.type === 'mixer' && p.cables.some((c) => c.from.module === m.id && c.to.module === out.id))!;
    // DRUMS 2 and FLAM: a track and its Drum map each, below DRUMS; Main's keys play them too
    const track = (name: string, rows: [string, number][], k: number): ModuleInst => {
      const t = addModule(p, DEFS.steps, drumsTrack.x, drumsTrack.y + 300 * k);
      t.name = name;
      t.notes = [];
      const m = addModule(p, DEFS.drummap, map1.x, map1.y + 300 * k);
      m.names = rows.map(([n]) => n);
      rows.forEach(([, note], r) => (m.params[`n${r + 1}`] = note));
      wire(p, main.id, 'keys', t.id, 'keys');
      wire(p, t.id, 'keys', m.id, 'keys');
      return t;
    };
    const t2 = track('DRUMS 2', MAP2, 1);
    const t3 = track('FLAM', MAP3, 2);
    const maps = [map1, ...[t2, t3].map((t) => mod(p, p.cables.find((c) => c.from.module === t.id && c.to.port === 'keys')!.to.module))];
    const row = (at: [number, number]): [number, string, string] => [maps[at[0] - 1].id, `g${at[1]}`, `v${at[1]}`];
    // the card accent flam, below the voices; SHUFFLE and SCALE into every track
    const ctl = place(p, CONTROL, percAt.x, percAt.y + 1300).a;
    for (const t of [drumsTrack, t2, t3]) {
      t.map = { ...t.map!, p1: ['swing'], p2: ['rate'] };
      t.range = { p1: { swing: [0, 1] }, p2: { rate: [3 / 6, 1] } };   // SHUFFLE 50..75 %, SCALE 1/8T 1/16 1/16T 1/32
      plugOut(p, ctl, 'shuffle', t.id, 'p1');
      plugOut(p, ctl, 'scale', t.id, 'p2');
    }
    plugIn(p, maps[1].id, 'g4', ctl, 'accent');
    const levelIn = (key: string): void => {
      const [m, g, v] = row(ROWS[key].at);
      plugIn(p, m, g, ctl, key);
      if (ctl.inputs.some((x) => x.label === `${key} vel`)) plugIn(p, m, v, ctl, `${key} vel`);
      const f = ROWS[key].flam;
      if (f) {
        const [fm, fg] = row(f);
        plugIn(p, fm, fg, ctl, `${key} flam`);
      }
    };
    /** a drum's trigger: its row's gate, or the card's trig for a drum that flams */
    const trig = (key: string): [number, string] => {
      if (!ROWS[key].flam) {
        const [m, g] = row(ROWS[key].at);
        return [m, g];
      }
      const r = ctl.outputs.find((x) => x.label === `${key} trig`)!;
      return [r.module, r.port];
    };
    const levelOut = (key: string): [number, string] => {
      const r = ctl.outputs.find((x) => x.label === `${key} level`)!;
      return [r.module, r.port];
    };
    /** the accent VCA after kick, snare and closed hat: the voice's LEVEL */
    const levelVca: Record<string, number> = {};
    // kick, snare, closed hat (rows 1, 2, 4): their gates from the trigger, their velocity VCAs' cv from the card
    for (const [key, r] of [['bd', 1], ['sd', 2], ['ch', 4]] as const) {
      const [tm, tp] = trig(key);
      for (const c of p.cables.filter((x) => x.from.module === map1.id && x.from.port === `g${r}`)) c.from = { module: tm, port: tp };
      const c = p.cables.find((x) => x.from.module === map1.id && x.from.port === `v${r}` && mod(p, x.to.module).type === 'vca')!;
      mod(p, c.to.module).params.gain = 1;
      levelVca[key] = c.to.module;
      c.from = { module: levelOut(key)[0], port: levelOut(key)[1] };
      levelIn(key);   // (after: its own row's gate and velocity go into the card)
    }
    const snare = assembliesOf(p).find((a) => a.name === 'snare')!;
    const sdVca = p.cables.find((c) => c.from.module === levelOut('sd')[0] && c.from.port === levelOut('sd')[1] && mod(p, c.to.module).type === 'vca')!.to.module;
    snare.params.push({ module: sdVca, param: 'gain', label: 'level' });
    // the hats' one LEVEL: a Mixer after both, on the hihat card
    const hihat = assembliesOf(p).find((a) => a.name === 'hihat')!;
    const chVca = p.cables.find((c) => c.from.module === levelOut('ch')[0] && c.from.port === levelOut('ch')[1] && mod(p, c.to.module).type === 'vca')!.to.module;
    const hats = addModule(p, DEFS.mixer, mod(p, chVca).x + 320, mod(p, chVca).y);
    Object.assign(hats.params, { l1: 1, l2: 0, l3: 0, l4: 0 });
    hihat.modules.push(hats.id);
    hihat.params.push({ module: hats.id, param: 'l1', label: 'level' });
    for (const c of p.cables.filter((x) => x.from.module === chVca && x.to.module === mix.id)) c.from = { module: hats.id, port: 'out' };   // (into the mix as the closed hat was)
    wire(p, chVca, 'out', hats.id, 'in1');
    // the new voices
    VOICES.forEach(([key, built], i) => {
      const a = place(p, built, percAt.x + 420 * (i % 4), percAt.y + 560 * Math.floor(i / 4)).a;
      levelIn(key);
      const [tm, tp] = trig(key);
      plugIn(p, tm, tp, a, 'gate');
      const [lm, lp] = levelOut(key);
      plugIn(p, lm, lp, a, 'level');
      if (key === 'oh') {
        plugIn(p, map1.id, 'g4', a, 'either hat');
        plugIn(p, map1.id, 'g5', a, 'either hat');
        plugOut(p, a, 'out', hats.id, 'in1');
      } else plugOut(p, a, 'out', mix.id, 'in3');
    });
    panel(p, levelVca);
    matchLevel(p, before, KIT_NOTES);
    return players(p, true);   // (an Arpeggiator, bypassed, between DRUMS and the Drum map)
  },
};
