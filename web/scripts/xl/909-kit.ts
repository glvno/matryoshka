// SPDX-License-Identifier: GPL-3.0-only
// 909 Kit XL: the 909 Kit with a full voice of its own on every Drum map row and the Roland TR-909's accent. The FM-1
// version (web/presets/NN-909-kit.json, D-337 in docs/ledger/patches-and-presets.md) plays rows 3 and 5..8 on one lean
// card "perc": the clap is the snare's noise through a band pass, the open hat is the closed hat's filtered noise, the tom
// a sine, the rim a short triangle, the cowbell two squares, each with one envelope and its velocity through a macro
// range. Its kick, snare and closed hat (rows 1, 2, 4), its DRUMS track and Drum map stay as they are here.
// The TR-909 (Roland's owner's manual; Electronics & Music Maker, March 1984) has a bass drum (TUNE LEVEL ATTACK DECAY),
// snare (TUNE LEVEL TONE SNAPPY), low / mid / high toms (TUNE LEVEL DECAY), rim shot and hand clap (LEVEL), closed and open
// hi-hat (one LEVEL, a DECAY each; the closed hat cuts the open one), crash and ride (LEVEL TUNE), and TOTAL ACCENT, the
// strength of an accented step. Eight rows hold eight of them: the rows keep the kits' order and black-key mapping, with
// row 8 the high tom in place of the cowbell (the TR-909 has none); the mid tom, crash and ride do not fit eight rows.
// The new voices, each a card with the original's knobs and its own sources:
//   clap (row 3): its own noise through a band pass, retriggered three times in 30 ms (a window and a 100 Hz square),
//     then a tail; LEVEL
//   open hat (row 5): its own metallic source (a detuned square cluster and noise, high passed); DECAY, LEVEL; the closed
//     hat's row latches it shut (a sample and hold on either hat's trigger)
//   low tom (row 6), high tom (row 8): a sine with a pitch drop and a little low-passed noise; TUNE, DECAY, LEVEL
//   rim (row 7): two short sines (about 520 Hz and 1.6 kHz) and a high-passed click; LEVEL
// Accent: every row's velocity becomes its level through (velocity - 100 / 127) x TOTAL ACCENT + 1, so a plain step
// (velocity 100) plays the voice as tuned and an accented one (127) louder by TOTAL ACCENT (1.27: the FM-1 version's
// 127 / 100), one row on the Macros card.
import { DEFS } from '../../src/modules';
import { addModule, STEP_VEL, type Patch } from '../../src/patch';
import { assembliesOf, deleteAssembly, insertAssembly } from '../../src/assembly';
import type { AssemblyDef } from '../../src/assembly';
import { mod, players, plugIn, plugOut, wire } from '../factory-build';
import { define, KIT_NOTES, matchLevel, type Def } from './def';
import type { Xl } from './xl';

const NOTES = 'The 909 Kit with a full voice on every row and the TR-909\'s TOTAL ACCENT (Macros). Rows: kick, snare, clap ' +
  '(its own noise, three bursts and a tail), closed hat, open hat (its own metal and noise; the closed hat cuts it), low ' +
  'tom, rim, high tom (row 8: the TR-909 has no cowbell). The mid tom, crash and ride do not fit eight rows.';

/** the velocity of a plain step as the Drum map gives it (0..1) */
const PLAIN = STEP_VEL / 127;
/** TOTAL ACCENT at which an accent plays as on the FM-1 version (127 / 100 of a plain step) */
const ACCENT = Math.round(((127 / STEP_VEL - 1) / (1 - PLAIN)) * 100) / 100;

/** drums are played by short trigs: every envelope one-shot (gen-assemblies.ts does the same for its Drums shelf) */
function drums(built: { def: AssemblyDef }): AssemblyDef {
  for (const m of built.def.modules) if (m.type === 'env') m.params.shot = 1;
  return built.def;
}

/** a voice: its sources into `out`, an input `gate`, the accent stage (vel, accent) into its level VCA */
function voice(name: string, f: (b: Def, gate: (m: number, port: string) => void) => { into: [number, string][]; rows: [string, number, string][] }, lvl: number): AssemblyDef {
  return drums(define(name, (b) => {
    const gates: [number, string][] = [];
    const { into, rows } = f(b, (m, port) => gates.push([m, port]));
    const acc = b.add('math', 4, 0, { ka: 1, kb: 1, off: -PLAIN });
    const one = b.add('scale', 4, 0.2, { gain: 1, offset: 1 });
    const out = b.add('vca', 4, 0.4, { gain: lvl });
    for (const [m, port] of into) b.wire(m, port, out, 'in');
    b.wire(acc, 'mul', one, 'in');
    b.wire(one, 'out', out, 'cv');
    b.input('gate', gates[0][0], gates[0][1], ...gates.slice(1));
    b.input('vel', acc, 'a');
    b.input('accent', acc, 'b');
    b.output('out', out, 'out');
    rows.forEach(([label, m, param], i) => b.param(label, m, param, i === 0 ? { head: name } : {}));
    b.param('level', out, 'gain');
  }));
}

/** a 909 tom: a sine with a pitch drop and a little low-passed noise, one envelope */
const tom = (name: string, coarse: number, decay: number): AssemblyDef => voice(name, (b, gate) => {
  const osc = b.add('osc', 0, 0, { wave: 0, coarse, level: 1 });
  const penv = b.add('env', 0, 1, { l1: 1, r1: 0.001, l2: 0, r2: 0.06, l3: 0, r3: 0.001, l4: 0, r4: 0.001 });
  const drop = b.add('scale', 1, 1, { gain: 0.35, offset: 0 });
  const nz = b.add('noise', 1, 0, { level: 0.3, color: 0 });
  const lp = b.add('filter', 2, 0, { cutoff: 1800, res: 0 });
  const mix = b.add('mixer', 2, 1, { l1: 1, l2: 0.4, l3: 0, l4: 0 });
  const env = b.add('env', 3, 0, { l1: 1, r1: 0.001, l2: 0, r2: decay, l3: 0, r3: 0.001, l4: 0, r4: 0.001 });
  const vca = b.add('vca', 3, 1);
  b.wire(penv, 'env', drop, 'in');
  b.wire(drop, 'out', osc, 'pitch');
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
  // the closed hat cuts it: either hat's trigger samples the open hat's gate (1 after an open hit, 0 after a closed one)
  const either = b.add('logic', 0, 2, { thresh: 0.5 });
  const latch = b.add('sh', 1, 2, { mode: 0 });
  const cut = b.add('vca', 2, 2);
  const acc = b.add('math', 3, 0, { ka: 1, kb: 1, off: -PLAIN });
  const one = b.add('scale', 3, 0.2, { gain: 1, offset: 1 });
  const out = b.add('vca', 3, 1, { gain: 1.2 });
  b.wire(metal, 'out', src, 'in1');
  b.wire(nz, 'out', src, 'in2');
  b.wire(src, 'out', hp, 'in');
  b.wire(hp, 'hp', vca, 'in');
  b.wire(env, 'env', vca, 'cv');
  b.wire(either, 'or', latch, 'clock');
  b.wire(vca, 'out', cut, 'in');
  b.wire(latch, 'out', cut, 'cv');
  b.wire(cut, 'out', out, 'in');
  b.wire(acc, 'mul', one, 'in');
  b.wire(one, 'out', out, 'cv');
  b.input('gate', env, 'gate', [either, 'a'], [latch, 'in']);
  b.input('choke', either, 'b');
  b.input('vel', acc, 'a');
  b.input('accent', acc, 'b');
  b.output('out', out, 'out');
  b.param('decay', env, 'r3', { head: 'open hat' });
  b.param('level', out, 'gain');
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

// the Drum map row each new voice plays
const VOICES: [number, AssemblyDef][] = [[3, CLAP], [5, OPEN_HAT], [6, tom('low tom', -17, 0.35)], [7, RIM], [8, tom('high tom', -8, 0.28)]];

export const xl: Xl = {
  base: '909 Kit',
  build: (fm1: Patch): Patch => {
    const before = structuredClone(fm1);
    const p = fm1;
    p.notes = NOTES;
    const perc = assembliesOf(p).find((a) => a.name === 'perc')!;
    const percAt = { x: perc.x, y: perc.y };
    deleteAssembly(p, perc.id);
    const map = p.modules.find((m) => m.type === 'drummap')!;
    map.names = ['KICK', 'SNARE', 'CLAP', 'CL HAT', 'OP HAT', 'LOW TOM', 'RIM', 'HI TOM'];
    const out = p.modules.find((m) => m.type === 'output')!;
    const mix = p.modules.find((m) => m.type === 'mixer' && p.cables.some((c) => c.from.module === m.id && c.to.module === out.id))!;
    // TOTAL ACCENT: one Offset on the Macros card, into every row's accent stage
    const macros = assembliesOf(p).find((a) => a.name === 'Macros')!;
    const total = addModule(p, DEFS.const, mod(p, macros.modules[0]).x, mod(p, macros.modules[0]).y + 600);
    total.params.value = ACCENT;
    macros.modules.push(total.id);
    macros.params.push({ module: total.id, param: 'value', label: 'total accent' });
    // rows 1, 2, 4: their velocity VCAs (gain 127 / 100, cv the row's velocity) get the accent stage in front
    for (const r of [1, 2, 4]) {
      const c = p.cables.find((x) => x.from.module === map.id && x.from.port === `v${r}` && mod(p, x.to.module).type === 'vca')!;
      const vca = mod(p, c.to.module);
      const home = assembliesOf(p).find((a) => a.modules.includes(vca.id))!;
      removeCable(p, c);
      const acc = addModule(p, DEFS.math, vca.x, vca.y + 250);
      Object.assign(acc.params, { ka: 1, kb: 1, off: -PLAIN });
      const one = addModule(p, DEFS.scale, vca.x, vca.y + 450);
      Object.assign(one.params, { gain: 1, offset: 1 });
      vca.params.gain = 1;
      home.modules.push(acc.id, one.id);
      wire(p, map.id, `v${r}`, acc.id, 'a');
      wire(p, total.id, 'out', acc.id, 'b');
      wire(p, acc.id, 'mul', one.id, 'in');
      wire(p, one.id, 'out', vca.id, 'cv');
    }
    VOICES.forEach(([r, def], i) => {
      const a = insertAssembly(p, DEFS, def, percAt.x + 420 * i, percAt.y);
      plugIn(p, map.id, `g${r}`, a, 'gate');
      plugIn(p, map.id, `v${r}`, a, 'vel');
      plugIn(p, total.id, 'out', a, 'accent');
      if (def === OPEN_HAT) plugIn(p, map.id, 'g4', a, 'choke');
      plugOut(p, a, 'out', mix.id, 'in3');
    });
    matchLevel(p, before, KIT_NOTES);
    return players(p, true);   // (an Arpeggiator, bypassed, between DRUMS and the Drum map)
  },
};

function removeCable(p: Patch, c: Patch['cables'][number]): void {
  p.cables = p.cables.filter((x) => x !== c);
}
