// SPDX-License-Identifier: GPL-3.0-only
// 808 Kit XL: the 808 Kit with every instrument, knob and switch of the Roland TR-808, after its owner's manual
// (archive.org "synthmanual-roland-tr-808-owners-manual": "Control Descriptions", "Specifications"). The FM-1 version
// (web/presets/NN-808-kit.json, gen-presets.ts) plays eight of the eleven voices, its rows accent their own drum by
// velocity, and its card "808 kit" has the TR-808's knobs for those eight. Its drums, DRUMS track and Drum map stay as
// they are here.
// The TR-808 has eleven voices, sixteen sounds: bass drum (LEVEL TONE DECAY), snare drum (LEVEL TONE SNAPPY), low / mid /
// high tom (LEVEL TUNING; a switch makes each a low / mid / high conga), rim shot (LEVEL; switched: claves), hand clap
// (LEVEL; switched: maracas), cow bell (LEVEL), cymbal (LEVEL TONE DECAY), open hihat (LEVEL DECAY), closed hihat (LEVEL;
// it cuts the open one), ACCENT (its own row of steps; LEVEL), and PRE-SCALE (3, 4, 6 or 8 steps a beat).
// Two tracks, each with its Drum map, both on PLAY:
//   DRUMS (the FM-1 version's rows and keys): BD SD CP/MA CH OH LT/LC RS/CL CB
//   DRUMS 2: MT/MC HT/HC CY AC, on the white keys G4 A4 B4 C5
// Main's keys go into both, so the keyboard plays every row. The card "808 kit" holds everything, one heading per
// instrument in the panel's order, its rows named as the panel names its knobs:
//   accent: level. A step of the AC row accents every voice on it: each voice holds the level it was hit with (a sample
//     and hold on its row's trigger), 1 or, accented, 1 + ACCENT LEVEL. The rows' own velocities do nothing (the TR-808
//     has none): only the AC row accents.
//   the tom / conga, rim / claves and clap / maracas switches: a Selector each, its positions named (tom / conga,
//     rim shot / claves, hand clap / maracas; both sound, the Selector picks one). A pair shares its LEVEL and, for the toms, its TUNING (a Macro moving both
//     voices' pitch, -7..+7 semitones).
//   the cymbal and the hihats share one metallic source, six square oscillators at the TR-808's frequencies (205, 304,
//     370, 523, 540 and 800 Hz). The cymbal is that source through a band pass (its low band, DECAY sets its length) and a
//     high pass (its high band, short), TONE the balance between the two. The hihats are the FM-1 version's hats on that
//     source (it had a detuned square cluster and noise).
//   pre-scale: a Selector into both tracks' rate, its positions named 1/8T 1/16 1/16T 1/32 (3, 4, 6, 8 steps a beat; the
//     manual gives the divisions, not which panel position is which, so the order is by division).
// New voices (stand-ins for the TR-808's circuits, which the manual does not describe; the tunings are estimates):
//   mid and high tom: the factory tom as the low tom, higher; the congas: the same, higher still, shorter, with less drop
//   claves: a sine at about 2.5 kHz with a 35 ms decay; maracas: high-passed noise with a 30 ms decay
// Not here:
// - The rhythm memory, which needs Steps features the engines lack (issue #351): 12 BASIC RHYTHMs with A / B variations
//   played A, B or AB; 4 INTRO / FILL INs with their own A / B; AUTO FILL IN every 2, 4, 8, 12 or 16 bars and the TAP
//   fill; the 12 RHYTHM TRACKs of up to 64 bars (COMPOSE: song mode). #351 lists "Pattern chaining, song mode, master
//   length" and fill-only trig conditions; pattern slots with variations and auto fill are not listed there yet.
// - The step count (CLEAR + step, 1..32 over the 1st and 2nd PART) is each track's len: set the two alike.
// - Hardware: the separate outputs per instrument, the HI / LO master outputs, the three trigger outputs, DIN SYNC and
//   the two pedal jacks (start / stop, fill in).
import { DEFS } from '../../src/modules';
import { addModule, paramUnit, paramValue, removeModule, rowDef, type ModuleInst, type Patch } from '../../src/patch';
import { addChild, allModules, assembliesOf, insertAssembly, reconcile, type AssemblyInst } from '../../src/assembly';
import { FACTORY } from '../../src/assemblies';
import { mod, players, plugIn, wire } from '../factory-build';
import { define, KIT_NOTES, matchLevel, place, type Built } from './def';
import type { Xl } from './xl';

const NOTES = 'Every TR-808 voice, knob and switch. Two tracks: DRUMS (the 808 Kit\'s rows) and DRUMS 2 (mid tom, hi tom, ' +
  'cymbal, ACCENT). Only the AC row accents (by the accent level), as on the TR-808. Switches: ' +
  'tom / conga for the three toms, rim shot / claves, hand clap / maracas. pre-scale sets both tracks\' rate. The step count is ' +
  'each track\'s len: set them alike. Not here: the rhythm memory (A / B variations, fill-ins, auto fill, rhythm tracks).';

/** a card row: heading, label, module, parameter and, for a Selector, its positions' names */
type Row = [string, string, ModuleInst, string, string[]?];

/** the FM-1 version's accent: velocity 127 plays 127 / 100 of a plain step (gen-presets.ts) */
const FM1_ACCENT = 127 / 100;
/** ACCENT LEVEL as it ships: an accented step at 1.5 times a plain one */
const ACCENT = 0.5;
/** the six square oscillators of the TR-808's cymbal and hihats, in Hz */
const METAL_HZ = [205.3, 304.4, 369.6, 522.7, 540, 800];
/** the oscillators' coarse 0 (C4) in Hz */
const C4 = 261.63;

/** drums are played by short trigs: every envelope one-shot (gen-assemblies.ts does the same for its Drums shelf) */
function drums(built: Built): Built {
  for (const m of built.def.modules) if (m.type === 'env') m.params.shot = 1;
  return built;
}

const METAL = define('metal', (b) => {
  const mix = b.add('mixer', 1, 0, { l1: 0.3, l2: 0.3, l3: 0.3, l4: 0.3 });
  const mix2 = b.add('mixer', 1, 1, { l1: 0.3, l2: 0.3, l3: 1, l4: 0 });
  METAL_HZ.forEach((hz, i) => {
    const st = 12 * Math.log2(hz / C4);
    const coarse = Math.round(st);
    const o = b.add('osc', 0, i * 0.5, { wave: 3, coarse, fine: Math.round((st - coarse) * 100), level: 1, pw: 0.5 });
    if (i < 4) b.wire(o, 'out', mix, `in${i + 1}`);
    else b.wire(o, 'out', mix2, `in${i - 3}`);
  });
  b.wire(mix, 'out', mix2, 'in3');
  b.output('out', mix2, 'out');
});

const CYMBAL = drums(define('cymbal', (b) => {
  const low = b.add('filter', 0, 0, { cutoff: 3500, res: 0.35 });
  const high = b.add('filter', 0, 1, { cutoff: 8000, res: 0.1 });
  const lenv = b.add('env', 1, 0, { l1: 1, r1: 0.001, l2: 0.5, r2: 0.08, l3: 0, r3: 1.6, l4: 0, r4: 0.001 });
  const henv = b.add('env', 1, 1, { l1: 1, r1: 0.001, l2: 0.3, r2: 0.05, l3: 0, r3: 0.35, l4: 0, r4: 0.001 });
  const lv = b.add('vca', 2, 0);
  const hv = b.add('vca', 2, 1);
  const tone = b.add('xfade', 3, 0, { mix: 0.5 });
  const out = b.add('vca', 3, 1, { gain: 2 });   // (the held level is 0.5 on a plain step)
  b.wire(low, 'bp', lv, 'in');
  b.wire(high, 'hp', hv, 'in');
  b.wire(lenv, 'env', lv, 'cv');
  b.wire(henv, 'env', hv, 'cv');
  b.wire(lv, 'out', tone, 'a');
  b.wire(hv, 'out', tone, 'b');
  b.wire(tone, 'out', out, 'in');
  b.input('metal', low, 'in', [high, 'in']);
  b.input('gate', lenv, 'gate', [henv, 'gate']);
  b.input('level', out, 'cv');
  b.output('out', out, 'out');
  b.param('tone', tone, 'mix', { head: 'cymbal' });
  b.param('decay', lenv, 'r3');
}));

/** a short voice: a source into a VCA on a one-shot envelope, then the level VCA (its gain on the accent stage) */
const short = (name: string, src: (b: Parameters<Parameters<typeof define>[1]>[0]) => [number, string], attack: number, decay: number): Built => drums(define(name, (b) => {
  const [m, port] = src(b);
  const env = b.add('env', 1, 1, { l1: 1, r1: attack, l2: 0, r2: decay, l3: 0, r3: 0.001, l4: 0, r4: 0.001 });
  const vca = b.add('vca', 2, 0);
  const out = b.add('vca', 3, 0, { gain: 2 });   // (the held level is 0.5 on a plain step)
  b.wire(m, port, vca, 'in');
  b.wire(env, 'env', vca, 'cv');
  b.wire(vca, 'out', out, 'in');
  b.input('gate', env, 'gate');
  b.input('level', out, 'cv');
  b.output('out', out, 'out');
}));
const CLAVES = short('claves', (b) => [b.add('osc', 0, 0, { wave: 0, coarse: 39, level: 0.8 }), 'out'], 0.001, 0.035);
const MARACAS = short('maracas', (b) => {
  const nz = b.add('noise', 0, 0, { level: 1, color: 0 });
  const hp = b.add('filter', 1, 0, { cutoff: 5000, res: 0.1 });
  b.wire(nz, 'out', hp, 'in');
  return [hp, 'hp'];
}, 0.004, 0.03);

/** the rows of DRUMS 2's Drum map: name and key */
const MAP2: [string, number][] = [['MT/MC', 67], ['HT/HC', 69], ['CY', 71], ['AC', 72], ['-', 0], ['-', 0], ['-', 0], ['-', 0]];

export const xl: Xl = {
  base: '808 Kit',
  build: (fm1: Patch): Patch => {
    const before = structuredClone(fm1);
    const p = fm1;
    p.notes = NOTES;
    const card = assembliesOf(p).find((a) => a.name === '808 kit')!;
    const child = (label: string): AssemblyInst => assembliesOf(p).find((a) => a.label === label)!;
    const main = p.modules.find((m) => m.type === 'fm1')!;
    const map1 = p.modules.find((m) => m.type === 'drummap')!;
    map1.names = ['BD', 'SD', 'CP/MA', 'CH', 'OH', 'LT/LC', 'RS/CL', 'CB'];
    const drumsTrack = p.modules.find((m) => m.type === 'steps' && m.name === 'DRUMS')!;
    const out = p.modules.find((m) => m.type === 'output')!;
    const mixA = mod(p, p.cables.find((c) => c.to.module === out.id)!.from.module);
    const mixB = mod(p, p.cables.find((c) => c.to.module === mixA.id && c.to.port === 'in4')!.from.module);
    const at = { x: card.x, y: card.y + 1800 };
    /** put new modules / top-level assemblies into the card */
    const join = (...ids: number[]): void => { card.modules.push(...ids); };
    const adopt = (a: AssemblyInst): void => addChild(p, card, a.id);
    const add = (type: string, x: number, y: number, params: Record<string, number> = {}): ModuleInst => {
      const m = addModule(p, DEFS[type], at.x + x * 320, at.y + y * 560);
      Object.assign(m.params, params);
      join(m.id);
      return m;
    };
    // ---- DRUMS 2 and its Drum map, below DRUMS; Main's keys play it too
    const t2 = addModule(p, DEFS.steps, drumsTrack.x, drumsTrack.y + 300);
    t2.name = 'DRUMS 2';
    t2.notes = [];
    const map2 = addModule(p, DEFS.drummap, map1.x, map1.y + 300);
    map2.names = MAP2.map(([n]) => n);
    MAP2.forEach(([, note], r) => (map2.params[`n${r + 1}`] = note));
    wire(p, main.id, 'keys', t2.id, 'keys');
    wire(p, t2.id, 'keys', map2.id, 'keys');
    // ---- pre-scale: a Selector of four rates into both tracks' rate (its values: the rates' unit positions, 1/8T 1/16
    // 1/16T 1/32 of the seven 1/4 .. 1/32; the range 0..1 reads them as they are)
    const preScale = add('select', 0, 0, { count: 4, pos: 2, fade: 0, v1: 3 / 6, v2: 4 / 6, v3: 5 / 6, v4: 1 });
    for (const t of [drumsTrack, t2]) {
      t.map = { ...t.map!, p1: ['rate'] };
      t.range = { p1: { rate: [0, 1] } };
      wire(p, preScale.id, 'out', t.id, 'p1');
    }
    // ---- the accent: 0.5 + ACCENT LEVEL / 2 on a step of the AC row, else 0.5 (the level stage's pins read 0..1, gain 0..2)
    const accLevel = add('macro', 1, 0, { value: ACCENT });
    const acc = add('math', 2, 0, { ka: ACCENT / 2, kb: 0, off: 0.5 });
    const KA = rowDef(DEFS.math, 'ka')!;
    acc.map = { ...acc.map!, p1: ['ka'] };
    acc.range = { p1: { ka: [paramUnit(KA, 0), paramUnit(KA, 0.5)] } };
    wire(p, accLevel.id, 'out', acc.id, 'p1');
    wire(p, map2.id, 'g4', acc.id, 'a');
    /** a lane's held level, clocked by its row's gate */
    let lanes = 0;
    const hold = (gate: [number, string]): ModuleInst => {
      const sh = add('sh', 3 + (lanes++ % 6), 0, { mode: 0 });
      wire(p, acc.id, 'add', sh.id, 'in');
      wire(p, gate[0], gate[1], sh.id, 'clock');
      return sh;
    };
    /** the FM-1 version's velocity pins on these modules now read the held level: a plain step plays as before */
    const repin = (held: ModuleInst, ...ms: ModuleInst[]): void => {
      for (const m of ms) {
        const [param] = m.map!.p1;
        const pd = rowDef(DEFS[m.type], param)!;
        const plain = paramValue(pd, m.range!.p1![param][1]) / FM1_ACCENT;
        m.range = { p1: { [param]: [paramUnit(pd, 0), paramUnit(pd, 2 * plain)] } };
        p.cables = p.cables.filter((c) => !(c.to.module === m.id && c.to.port === 'p1'));
        wire(p, held.id, 'out', m.id, 'p1');
      }
    };
    const velPinned = (a: AssemblyInst): ModuleInst[] => allModules(p, a).map((id) => mod(p, id)).filter((m) => m.range?.p1);
    /** the FM-1 version's strike VCAs (tom, rim) take the row's velocity on their cv: now the held level, at twice the gain
     * over 1.27 (a plain step plays as before) */
    const restrike = (held: ModuleInst, a: AssemblyInst): void => {
      for (const c of p.cables.filter((x) => x.from.module === map1.id && /^v\d$/.test(x.from.port) && x.to.port === 'cv' && allModules(p, a).includes(x.to.module))) {
        c.from = { module: held.id, port: 'out' };
        const m = mod(p, c.to.module);
        m.params.gain = (m.params.gain / FM1_ACCENT) * 2;
      }
    };
    const gateOf = (map: ModuleInst, r: number): [number, string] => [map.id, `g${r}`];
    // the FM-1 version's drums: bass drum, snare drum, closed hihat, open hihat, cow bell keep their lanes
    for (const [label, r] of [['bass drum', 1], ['snare drum', 2], ['cow bell', 8]] as const) repin(hold(gateOf(map1, r)), ...velPinned(child(label)));
    const hh = child('hihats');
    const [chPin, ohPin] = velPinned(hh);   // (closed, then open: gen-presets.ts pins them in that order)
    repin(hold(gateOf(map1, 4)), chPin);
    repin(hold(gateOf(map1, 5)), ohPin);
    // ---- the shared metal: into the cymbal and, in place of their own cluster and noise, the hihats
    const metal = place(p, METAL, at.x, at.y + 600).a;
    adopt(metal);
    const hatsSrc = allModules(p, hh).map((id) => mod(p, id)).find((m) => m.type === 'mixer' && p.cables.some((c) => c.from.module === m.id && mod(p, c.to.module).type === 'filter'))!;
    for (const c of p.cables.filter((x) => x.to.module === hatsSrc.id)) {
      removeModule(p, c.from.module);
      hh.modules = hh.modules.filter((id) => id !== c.from.module);
    }
    Object.assign(hatsSrc.params, { l1: 1, l2: 0 });
    wire(p, metal.outputs[0].module, metal.outputs[0].port, hatsSrc.id, 'in1');
    hh.inputs.push({ module: hatsSrc.id, port: 'in1', label: 'metal' });
    // ---- the new voices and the switches: each lane's held level into its voices' level, a Selector picking one of a pair
    const mixC = add('mixer', 9, 0, { l1: 0.45, l2: 0.45, l3: 0.9, l4: 0 });
    wire(p, mixC.id, 'out', mixA.id, 'in4');
    const tomDef = FACTORY.find((d) => d.name === 'tom')!;
    /** a factory tom at its settings, its modal body's pitch on a TUNING macro (+-7 semitones), its hit on the held level */
    const tom = (label: string, coarse: number, o: { decay: number; drop: number }, tuning: ModuleInst, held: ModuleInst, x: number): AssemblyInst => {
      const n = p.modules.length;
      const a = insertAssembly(p, DEFS, tomDef, at.x + x * 320, at.y + 1200);
      const [, hit, md, , sc] = p.modules.slice(n);   // (pulse, hit, modal body, drop envelope, drop)
      a.label = label;
      Object.assign(md.params, { coarse, decay: o.decay });
      sc.params.gain = o.drop;
      const C = rowDef(DEFS.modal, 'coarse')!;
      md.map = { ...md.map!, p1: ['coarse'] };
      md.range = { p1: { coarse: [paramUnit(C, coarse - 7), paramUnit(C, coarse + 7)] } };
      wire(p, tuning.id, 'out', md.id, 'p1');
      const G = rowDef(DEFS.scale, 'gain')!;
      hit.map = { ...hit.map!, p1: ['gain'] };
      hit.range = { p1: { gain: [paramUnit(G, 0), paramUnit(G, 2 * hit.params.gain)] } };
      wire(p, held.id, 'out', hit.id, 'p1');
      a.params = [];
      adopt(a);
      return a;
    };
    /** a switch: Selector position 1 the first voice, 2 the switched one, into the mixer channel */
    const switchOf = (a: AssemblyInst, b: AssemblyInst, x: number): ModuleInst => {
      const sel = add('select', x, 1, { count: 2, pos: 1, fade: 2 });
      for (const [v, port] of [[a, 'in1'], [b, 'in2']] as const) {
        const o = v.outputs.find((r) => r.label === 'out')!;
        p.cables = p.cables.filter((c) => !(c.from.module === o.module && c.from.port === o.port && [mixA.id, mixB.id].includes(c.to.module)));
        wire(p, o.module, o.port, sel.id, port);
      }
      return sel;
    };
    const voiceIn = (v: AssemblyInst, gate: [number, string], held: ModuleInst): void => {
      plugIn(p, gate[0], gate[1], v, 'gate');
      plugIn(p, held.id, 'out', v, 'level');
    };
    // the toms and congas: low (DRUMS row 6, the FM-1 version's tom), mid and high (DRUMS 2 rows 1, 2)
    const lt = child('low tom');
    const ltBody = allModules(p, lt).map((id) => mod(p, id)).find((m) => m.type === 'modal')!;
    const toms: { lane: [number, string]; tom?: AssemblyInst; coarse: number; head: string; level: [ModuleInst, string] }[] = [
      { lane: gateOf(map1, 6), tom: lt, coarse: ltBody.params.coarse, head: 'low tom', level: [mixB, 'l2'] },
      { lane: gateOf(map2, 1), coarse: ltBody.params.coarse + 5, head: 'mid tom', level: [mixC, 'l1'] },
      { lane: gateOf(map2, 2), coarse: ltBody.params.coarse + 10, head: 'hi tom', level: [mixC, 'l2'] },
    ];
    const tomRows: Row[] = [];
    toms.forEach((t, i) => {
      const held = hold(t.lane);
      const tuning = add('macro', 3 + i, 2, { value: 0.5 });
      let body = t.tom;
      if (body) {
        // the FM-1 version's tom: its TUNING row becomes the pair's macro
        const C = rowDef(DEFS.modal, 'coarse')!;
        ltBody.map = { ...ltBody.map!, p1: ['coarse'] };
        ltBody.range = { p1: { coarse: [paramUnit(C, t.coarse - 7), paramUnit(C, t.coarse + 7)] } };
        wire(p, tuning.id, 'out', ltBody.id, 'p1');
        restrike(held, lt);
        body.params = [];
      } else {
        body = tom(t.head, t.coarse, { decay: 0.5 - 0.05 * i, drop: 0.6 }, tuning, held, 3 * i);
        for (const g of [body.inputs.find((r) => r.label === 'gate')!]) for (const x of [g, ...(g.also ?? [])]) wire(p, t.lane[0], t.lane[1], x.module, x.port);
      }
      const conga = tom(t.head.replace('tom', 'conga'), t.coarse + 9, { decay: 0.25, drop: 0.2 }, tuning, held, 3 * i + 1);
      for (const g of [conga.inputs.find((r) => r.label === 'gate')!]) for (const x of [g, ...(g.also ?? [])]) wire(p, t.lane[0], t.lane[1], x.module, x.port);
      const sel = switchOf(body, conga, 3 * i + 2);
      wire(p, sel.id, 'out', t.level[0].id, t.level[1].replace('l', 'in'));
      tomRows.push([t.head, 'level', t.level[0], t.level[1]], ['', 'tuning', tuning, 'value'], ['', 'tom/conga', sel, 'pos', ['tom', 'conga']]);
    });
    // rim shot / claves (DRUMS row 7), hand clap / maracas (row 3), each pair on the FM-1 version's channel
    const pairRows: Row[] = [];
    for (const [label, alt, r, built, mix, ch, sw] of [
      ['rim shot', 'claves', 7, CLAVES, mixB, 'l3', 'rim/claves'],
      ['hand clap', 'maracas', 3, MARACAS, mixA, 'l3', 'clap/maraca'],
    ] as const) {
      const first = child(label);
      const held = hold(gateOf(map1, r));
      repin(held, ...velPinned(first));
      restrike(held, first);
      const second = place(p, built, at.x + (r === 7 ? 12 : 15) * 320, at.y + 1200).a;
      second.label = alt;
      adopt(second);
      voiceIn(second, gateOf(map1, r), held);
      const sel = switchOf(first, second, r === 7 ? 14 : 17);
      wire(p, sel.id, 'out', mix.id, ch.replace('l', 'in'));
      pairRows.push([label, 'level', mix, ch], ['', sw, sel, 'pos', [label, alt]]);
    }
    // the cymbal (DRUMS 2 row 3)
    const cy = place(p, CYMBAL, at.x + 18 * 320, at.y + 1200).a;
    adopt(cy);
    voiceIn(cy, gateOf(map2, 3), hold(gateOf(map2, 3)));
    plugIn(p, metal.outputs[0].module, metal.outputs[0].port, cy, 'metal');
    wire(p, cy.outputs.find((r) => r.label === 'out')!.module, 'out', mixC.id, 'in3');
    // ---- the card: the TR-808's panel, left to right (its jacks first: every cable from outside it)
    reconcile(p, card, DEFS);
    const fm1Rows = (head: string): Row[] => {
      const i = card.params.findIndex((r) => r.head === head);
      const j = card.params.findIndex((r, k) => k > i && r.head);
      return card.params.slice(i, j < 0 ? undefined : j).map((r) => [r.head ?? '', r.label, mod(p, r.module), r.param]);
    };
    const rows: Row[] = [
      ['accent', 'level', accLevel, 'value'],
      ...fm1Rows('bass drum'),
      ...fm1Rows('snare drum'),
      ...tomRows,
      ...pairRows,
      ...fm1Rows('cow bell'),
      ['cymbal', 'level', mixC, 'l3'], ...cy.params.map((r): Row => ['', r.label, mod(p, r.module), r.param]),
      ...fm1Rows('open hihat'),
      ...fm1Rows('closed hihat'),
      ['pre-scale', 'pre-scale', preScale, 'pos', ['1/8T', '1/16', '1/16T', '1/32']],
    ];
    card.params = rows.map(([head, label, m, param, names]) => ({ module: m.id, param, label, ...(head ? { head } : {}), ...(names ? { names: [...names] } : {}) }));
    // each nested card shows its own of these rows (a card shows only what its nested cards show)
    for (const a of assembliesOf(p).filter((x) => x.id !== card.id && allModules(p, card).includes(allModules(p, x)[0])))
      a.params = card.params.filter((r) => allModules(p, a).includes(r.module)).map(({ module, param, label }) => ({ module, param, label }));
    matchLevel(p, before, KIT_NOTES);
    return players(p, true);   // (an Arpeggiator, bypassed, between DRUMS and the Drum map)
  },
};
