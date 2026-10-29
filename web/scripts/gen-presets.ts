// SPDX-License-Identifier: GPL-3.0-only
// Writes the factory patches (web/presets/NN-name.json, NN = the slot, the order the firmware compiles them in) from
// the factory assemblies (src/assemblies, made by gen-assemblies.ts: run that first). Each patch: the Main module, the
// assembly (or a few modules), Main's keys / mod wheel into it, its outputs into the Output, and the Output's level set
// from a render so the patches play at about the same loudness. The knobs need no routing: they turn the rows of the
// device page in focus, and the assembly's card is its pages (pages.ts).
// The 909 Kit is kept as its file; <7PH (the 909 Kit's drums and a Silver Box on its own track) is built from it
// and comes after it. The XLs (browser-only versions, web/presets/xl) are gen-xl.ts's. The helpers are factory-build.ts's.
// Run from web/:  npx vite-node scripts/gen-presets.ts
import { readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { DEFS } from '../src/modules';
import { addModule, defaultMap, emptyPatch, paramUnit, removeModule, rowDef, STEP_VEL, validatePatch, type ModuleInst, type Patch } from '../src/patch';
import { ACCENT_VEL, fixNotes, patternNotes, type StepNote } from '../src/track';
import { FACTORY } from '../src/assemblies';
import { allModules, insertAssembly, makeAssembly, removeMember, type AssemblyInst } from '../src/assembly';
import { deviceBudget } from '../src/patchbin';
import { around, level, mod, peakOf, players, plugIn, plugOut, row, wire, type Inst } from './factory-build';

const DIR = new URL('../presets/', import.meta.url);
const KEEP = '909-kit.json'; // ours, kept as written
/** the drum kits' Drum map rows (#141): the white keys from F3, the FM-1's lowest key at octave 0 */
const KIT_NOTES = [53, 55, 57, 59, 60, 62, 64, 65];

const presets: (() => Patch)[] = [];

// Oracle V: the factory assembly at its five voices (they fit since the engine speed-ups, branch cpu-opt)
presets.push(() => {
  const x = around('Oracle V', 'Oracle V');
  x.set('voices', 5);
  level(x.p, { chord: true });
  return x.p;
});

// Init: the plainest subtractive voice, one note at a time from Main: saw, 24 dB low pass, VCA, ADSR
presets.push(() => {
  const p = emptyPatch('Init');
  const main = addModule(p, DEFS.fm1, 20, 20);
  const osc = addModule(p, DEFS.osc, 360, 20);
  Object.assign(osc.params, { wave: 2, level: 0.8 });
  const flt = addModule(p, DEFS.filter, 680, 20);
  Object.assign(flt.params, { cutoff: 2400, res: 0.2 });
  const env = addModule(p, DEFS.adsr, 680, 560);
  Object.assign(env.params, { a: 0.005, d: 0.3, s: 0.7, r: 0.3 });
  const vca = addModule(p, DEFS.vca, 1000, 20);
  const out = addModule(p, DEFS.output, 1320, 20);
  wire(p, main.id, 'pitch', osc.id, 'pitch');
  wire(p, main.id, 'gate', env.id, 'gate');
  wire(p, osc.id, 'out', flt.id, 'in');
  wire(p, flt.id, 'lp24', vca.id, 'in');
  wire(p, env.id, 'env', vca.id, 'cv');
  wire(p, vca.id, 'out', out.id, 'l');
  wire(p, vca.id, 'out', out.id, 'r');
  level(p);
  return p;
});

// Simple FM: two operators (the factory fm pair), one note at a time from Main
presets.push(() => {
  const x = around('Simple FM', 'fm pair', { pitchGate: true });
  level(x.p);
  return x.p;
});

// Plucked String: the factory pluck (a Karplus-Strong string, a tracking low pass) on four voices
presets.push(() => {
  const x = around('Plucked String', 'pluck', { pitchGate: true, poly: 4 });
  level(x.p, { chord: true });
  return x.p;
});

presets.push(() => {
  const x = around('Monolith D', 'Monolith D');
  x.set('glide on', 2); // a 40 ms glide, as this patch has always had
  plugIn(x.p, x.main.id, 'bend', x.a, 'bend'); // the PITCH wheel's half octave
  level(x.p);
  return x.p;
});

// Silver Box's demo patterns and song (#375): pattern 1 stays empty (the keys play it as a synth, PLAY plays nothing), I-A2
// .. I-A5 are acid lines in C minor (the Silver Box plays an octave down: 36 = C2), X an accent, a note two steps long
// into the next note a slide; I-A5 is in the TB-303's triplet mode (12 steps of 1/16T). Song 1 chains them with shifts;
// the patterns are named as on the TB-303 (editor only). Choose the song on the FM-1: SEL on the SEQ page, K4 right.
type Line = [number, number, number, boolean?][];
const SB_LINES: { notes: Line; len?: number; rate?: number }[] = [
  { notes: [[0, 36, 1, true], [2, 48, 1], [3, 36, 1], [4, 46, 2], [5, 48, 1, true], [7, 36, 1], [8, 51, 1], [9, 48, 2], [10, 46, 1], [12, 36, 1, true], [13, 39, 1], [14, 43, 2], [15, 46, 1]] },
  { notes: [[0, 36, 2], [2, 36, 1, true], [3, 48, 1], [5, 36, 1], [6, 39, 2], [7, 41, 1, true], [8, 43, 1], [10, 36, 1], [11, 48, 1, true], [12, 46, 2], [13, 43, 1], [14, 39, 1], [15, 41, 1]] },
  { notes: [[0, 36, 1, true], [1, 36, 1], [2, 48, 1, true], [4, 36, 1], [5, 36, 1], [6, 50, 2], [7, 51, 1, true], [9, 36, 1], [10, 34, 1], [12, 36, 1, true], [13, 48, 2], [14, 46, 1], [15, 43, 1]] },
  { notes: [[0, 36, 1, true], [1, 43, 1], [2, 48, 2], [3, 46, 1], [4, 36, 1, true], [5, 39, 1], [6, 43, 1], [7, 51, 2], [8, 48, 1, true], [9, 36, 1], [10, 46, 1], [11, 48, 1]], len: 12, rate: 5 },
];
presets.push(() => {
  const x = around('Silver Box', 'Silver Box');
  level(x.p);
  return x.p;
});
/** the demo patterns and song into Silver Box's PATTERN track (players() makes the track) */
function silverDemo(p: Patch): Patch {
  if (p.name !== 'Silver Box') return p;
  const track = p.modules.find((m) => m.type === 'steps')!;
  track.patterns = SB_LINES.map((l) => ({
    notes: l.notes.map(([at, note, len, acc]) => ({ at, len, note, vel: acc ? ACCENT_VEL : STEP_VEL })).sort((a, b) => a.at - b.at || a.note - b.note),
    ...(l.len ? { len: l.len } : {}), ...(l.rate !== undefined ? { rate: l.rate } : {}),
  }));
  p.modules.find((m) => m.type === 'fm1')!.seq = { names: '303', songs: [[[1, 0], [1, 0], [2, 0], [2, 5], [3, 0], [1, 7], [4, 0], [1, 0]].map(([pat, shift]) => ({ pat, shift }))] };
  return validatePatch(p, DEFS);
}

presets.push(() => {
  const x = around('Hera 6', 'Hera 6');
  x.set('voices', 6); // all six (they fit since the engine speed-ups, branch cpu-opt)
  level(x.p, { chord: true });
  return x.p;
});

presets.push(() => {
  const x = around('Sallen 20', 'Sallen 20');
  // the momentary switch: FX, a Gate button held down (the mod wheel is the control wheel: around() plugs it in)
  const panel = (x.main.panel ??= {});
  if (panel.kinds) delete panel.kinds.fx;
  panel.labels = { ...panel.labels, fx: 'SWITCH' };
  plugIn(x.p, x.main.id, 'fx', x.a, 'switch');
  level(x.p);
  return x.p;
});

presets.push(() => {
  const x = around('Expander S', 'Expander S');
  level(x.p, { chord: true });
  return x.p;
});

presets.push(() => {
  const x = around('Algo Four', 'Algo Four');
  level(x.p, { chord: true });
  return x.p;
});

presets.push(() => {
  const x = around('Canvas', 'Canvas');
  level(x.p);
  return x.p;
});

presets.push(() => {
  const x = around('Wanderer', 'Wanderer');
  level(x.p, { chord: true });
  return x.p;
});

presets.push(() => {
  const x = around('Briefcase 3', 'Briefcase 3');
  level(x.p);
  return x.p;
});

presets.push(() => {
  const x = around('Io 4', 'Io 4');
  x.p.notes = 'Jupiter-4 architecture, four voices. UNISON ON is UNISON I; SHARE is UNISON II: one key uses four voices, two keys use two each, three or four use one each. Assignment still uses separate assign and unison rows. Other control gaps remain under the 1.5 fidelity audit.';
  plugIn(x.p, x.main.id, 'bend', x.a, 'bend'); // the lever's BEND (its LFO is the mod wheel: around)
  level(x.p, { chord: true });
  return x.p;
});

presets.push(() => {
  const x = around('Vernon 100', 'Vernon 100');
  level(x.p, { chord: true });
  x.p.octave = -1;   // opens an octave down: the keyboard's A plays C3, where its bass and lead sit
  return x.p;
});


// 8 Lire (#182): the eight voices on the white keys from F3, repeated over the keybed (the assembly's Drum maps), at
// octave -1 as the kits
presets.push(() => {
  const x = around('8 Lire', '8 Lire');
  // the level: all eight plates held (from F3, as the kits)
  const out = x.out;
  out.params.level = 0.1;
  out.params.level = Math.round(Math.max(0.05, Math.min(1, 0.85 / (peakOf(x.p, KIT_NOTES, 3) / 0.1))) * 100) / 100;
  x.p.octave = -1;
  return x.p;
});


// Elvira 2: the four voices on the white keys from F3 (twice: F G A B, C D E F), repeated over the keybed as 8 Lire's
presets.push(() => {
  const x = around('Elvira 2', 'Elvira 2');
  x.out.params.level = 0.1;
  x.out.params.level = Math.round(Math.max(0.05, Math.min(1, 0.85 / (peakOf(x.p, KIT_NOTES.slice(0, 4), 3) / 0.1))) * 100) / 100;
  x.p.octave = -1;
  return x.p;
});


/** a drum engine on the transport, as the 808 Kit: Main's keys into a Steps track (`track`, so the keys play it unarmed),
 * the track's keys into the engine; `rows` are the patterns of the engine's Drum map rows (X: an accent) */
function sequenced(x: Inst, track: string, rows: Record<number, string>): void {
  const p = x.p;
  const into = x.a.inputs.find((r) => r.label === 'keys')!;
  p.cables = p.cables.filter((c) => !(c.from.module === x.main.id && c.from.port === 'keys'));
  const st = addModule(p, DEFS.steps, 20, 300);
  st.name = track;
  wire(p, x.main.id, 'keys', st.id, 'keys');
  for (const t of [into, ...(into.also ?? [])]) wire(p, st.id, 'keys', t.module, t.port);
  const map = mod(p, into.module);
  const notes: StepNote[] = [];
  for (const [r, steps] of Object.entries(rows)) {
    const key = Math.round(map.params[`n${r}`]);
    for (const n of patternNotes(steps) ?? []) notes.push({ ...n, note: key });
  }
  st.notes = fixNotes(notes);
  level(p, { drums: true });
  p.octave = -1;
}

// Scrounge: the five voices and the two modulation tracks on the white keys from F3 (as the kits), a pattern on the
// transport (PLAY starts it) as the original's factory pattern starts on RUN
presets.push(() => {
  const x = around('Scrounge', 'Scrounge');
  sequenced(x, 'PATTERN', {
    1: 'X.....x...X..x..',
    2: '..x...x...x.x.xx',
    3: '....X.......X..x',
    4: '.......x.....x..',
    5: 'x..x..x..x.x..x.',
    6: 'X.......x.......',
    7: '....x.........x.',
  });
  return x.p;
});


// Meridian 8: the eight channels on the white keys from F3 (as the kits), a gate pattern on the transport (the original
// needs a sequencer to power it); a held key keeps its channel powered
presets.push(() => {
  const x = around('Meridian 8', 'Meridian 8');
  sequenced(x, 'PATTERN', {
    1: 'x.....x...x.....',
    2: '....x.......x...',
    3: '..x.......x...x.',
    4: '.x...x...x...x.x',
    5: 'X.......X.......',
    6: '.......x.....x..',
    7: '...x.......x....',
    8: 'x..x..x...x..x..',
  });
  return x.p;
});


// Perun 4: the four voices on F3 G3 A3 B3 (the kits' first rows), a pattern with accents (X) on the transport
presets.push(() => {
  const x = around('Perun 4', 'Perun 4');
  sequenced(x, 'PATTERN', {
    1: 'X...x...X...x..x',
    2: '..x....x..x...x.',
    3: '....X.......X.x.',
    4: 'x.X.x.X.x.X.xxX.',
  });
  return x.p;
});


// 808 Kit (after the Roland TR-808, its owner's manual: "Control Descriptions", "Specifications"): a drum machine on the
// transport (PLAY starts it, the Main module's tempo sets it). One DRUMS track (#138) into a Drum map whose rows play the
// factory drum assemblies: 1 bass drum (boom kick), 2 snare drum, 3 hand clap, 4 closed and 5 open hihat (one hats
// assembly), 6 low tom, 7 rim shot, 8 cow bell. Main's keys go into DRUMS (#141), so the keys play the drums unarmed;
// the rows sit on the white keys from F3 (the FM-1's lowest key at octave 0: F3 G3 A3 B3 C4 D4 E4 F4), the editor opens
// at octave -1 (f g h j k l ...).
// One card, "808 kit", holds the drums and the two mixers, with the TR-808's knobs only, one heading per instrument in the
// panel's order, named as the panel names them: bass drum (level, tone, decay), snare drum (level, tone, snappy), low tom
// (level, tuning), rim shot, hand clap, cow bell (level), open hihat (level, decay), closed hihat (level). The drums' own
// rows that the TR-808 lacks (tune, drop, snap, flam, stick ...) keep their values but leave the card.
// - Bass drum TONE: a low pass after the kick, on a 1 ms click (the trigger's pulse, which the TR-808's bass drum lets
//   through): it sets how bright the attack is.
// - Snare drum TONE: two body sines, about 238 and 335 Hz (the TR-808's two shell oscillators), and the balance between
//   them (a Crossfader). SNAPPY is the noise's level.
// - The hihats: the factory hats (a detuned square cluster and noise, high passed) with the closed hat cutting the open
//   one: either hat's trigger samples the open hat's gate (a sample and hold: 1 after an open hit, 0 after a closed one),
//   which keeps the open hat's VCA open or shut.
// - Accents: the TR-808 accents every drum on a step of its ACCENT row, by ACCENT LEVEL. Here each row accents its own
//   drum by its velocity (X in the patterns, 127: 1.27 times a plain step): the Drum map's ninth row and a hold per drum
//   do not fit. Each drum's velocity sets the gain of a VCA inside it through a macro range (as the 909 Kit's, D-337);
//   the tom and the rim strike through a VCA on it. So no drum needs a velocity VCA after it.
// Left out, to fit the FM-1 (the 808 Kit XL has them): the mid and high toms, the cymbal, the congas, claves and maracas
// on the switches, the ACCENT row and ACCENT LEVEL. Missing from the Steps tracks (#351): the patterns' A / B variations,
// the intro / fill-ins and AUTO FILL IN, and the rhythm tracks (song mode).
/** a row's velocity 127 plays its drum this much louder than a plain step */
const ACCENT_808 = 127 / STEP_VEL;
presets.push(() => {
  const p = emptyPatch('808 Kit');
  addModule(p, DEFS.fm1, 20, 20);
  const st = addModule(p, DEFS.steps, 380, 20);
  st.name = 'DRUMS';
  const map = addModule(p, DEFS.drummap, 800, 20);
  KIT_NOTES.forEach((n, r) => (map.params[`n${r + 1}`] = n));
  wire(p, st.id, 'keys', map.id, 'keys');
  const main = p.modules.find((m) => m.type === 'fm1')!;
  wire(p, main.id, 'keys', st.id, 'keys');
  const mixA = addModule(p, DEFS.mixer, 3360, 20);
  Object.assign(mixA.params, { l1: 0.8, l2: 0.5, l3: 0.5, l4: 1 });
  const mixB = addModule(p, DEFS.mixer, 3360, 600);
  Object.assign(mixB.params, { l1: 1, l2: 0.45, l3: 0.35, l4: 0.3 });
  const out = addModule(p, DEFS.output, 3700, 20);
  /** a factory drum at column i, its modules by their ids in the definition */
  const drum = (name: string, i: number, label: string): { a: AssemblyInst; m: (local: number) => ModuleInst } => {
    const def = FACTORY.find((d) => d.name === name);
    if (!def) throw new Error(`no factory assembly ${name}`);
    const before = p.modules.length;
    const a = insertAssembly(p, DEFS, def, 380 + 420 * i, 600);
    a.label = label;
    const fresh = p.modules.slice(before);
    const byId = new Map(def.modules.map((m, index) => [m.id, fresh[index]]));
    return { a, m: (local) => {
      const m = byId.get(local);
      if (!m) throw new Error(`${name}: no module ${local} in the drum definition`);
      return m;
    } };
  };
  /** the drum's velocity (row r's v) sets `param` of `m` through a macro range: a plain step (velocity STEP_VEL) plays it
   * at its value, 127 at 127 / 100 of it */
  const velocity = (a: AssemblyInst, r: number, ...on: [ModuleInst, string][]): void => {
    for (const [m, param] of on) {
      const pd = rowDef(DEFS[m.type], param)!;
      m.map = { ...m.map!, p1: [param] };
      m.att = [1, 1];
      m.range = { p1: { [param]: [paramUnit(pd, 0), paramUnit(pd, m.params[param] * ACCENT_808)] } };
      wire(p, map.id, `v${r}`, m.id, 'p1');
    }
    a.inputs.push({ module: on[0][0].id, port: 'p1', label: 'vel', ...(on.length > 1 ? { also: on.slice(1).map(([m]) => ({ module: m.id, port: 'p1' })) } : {}) });
  };
  // bass drum: the boom kick, a 1 ms click into its VCA, a low pass after it (TONE)
  const bd = drum('boom kick', 0, 'bass drum');
  const click = addModule(p, DEFS.pulse, bd.m(1).x, bd.m(1).y + 1120);
  click.params.time = 0.001;
  const clickLevel = addModule(p, DEFS.scale, bd.m(1).x + 320, bd.m(1).y + 1120);
  Object.assign(clickLevel.params, { gain: 0.3, offset: 0 });
  const bdTone = addModule(p, DEFS.filter, bd.m(5).x + 320, bd.m(5).y);
  Object.assign(bdTone.params, { cutoff: 1500, res: 0 });
  wire(p, click.id, 'out', clickLevel.id, 'in');
  wire(p, clickLevel.id, 'out', bd.m(5).id, 'in');
  wire(p, bd.m(5).id, 'out', bdTone.id, 'in');
  for (const id of [click.id, clickLevel.id, bdTone.id]) bd.a.modules.push(id);
  bd.a.inputs[0].also = [...(bd.a.inputs[0].also ?? []), { module: click.id, port: 'trig' }];
  bd.a.outputs = [{ module: bdTone.id, port: 'lp12', label: 'out' }];
  velocity(bd.a, 1, [bd.m(5), 'gain']);
  // snare drum: two body sines (the shells) through a Crossfader (TONE); SNAPPY the noise's level
  const sd = drum('snare', 1, 'snare drum');
  Object.assign(sd.m(5).params, { coarse: -2, fine: 36 });   // (238 Hz)
  const shell2 = addModule(p, DEFS.osc, sd.m(5).x, sd.m(5).y + 560);
  Object.assign(shell2.params, { wave: 0, coarse: 4, fine: 28, level: 1 });   // (335 Hz)
  const sdTone = addModule(p, DEFS.xfade, sd.m(6).x, sd.m(6).y + 560);
  sdTone.params.mix = 0.5;
  p.cables = p.cables.filter((c) => !(c.from.module === sd.m(5).id && c.to.module === sd.m(6).id));
  wire(p, sd.m(5).id, 'out', sdTone.id, 'a');
  wire(p, shell2.id, 'out', sdTone.id, 'b');
  wire(p, sdTone.id, 'out', sd.m(6).id, 'in');
  sd.m(4).params.r3 = 0.1;   // (the noise's decay)
  sd.m(8).params.l1 = 0.45;   // (SNAPPY)
  sd.m(8).params.l2 = 1;   // (the two shells at 0.5 each)
  for (const id of [shell2.id, sdTone.id]) sd.a.modules.push(id);
  velocity(sd.a, 2, [sd.m(3), 'gain'], [sd.m(6), 'gain']);
  const cp = drum('clap', 2, 'hand clap');
  velocity(cp.a, 3, [cp.m(5), 'gain'], [cp.m(7), 'gain']);
  // the hihats: the closed hat cuts the open one through a sample and hold (in place of the factory hats' 250 ms choke)
  const hh = drum('hats', 3, 'hihats');
  const latch = addModule(p, DEFS.sh, hh.m(9).x, hh.m(9).y);
  latch.params.mode = 0;
  for (const local of [9, 10]) removeModule(p, hh.m(local).id);
  hh.a.modules = hh.a.modules.filter((id) => p.modules.some((m) => m.id === id));
  hh.a.modules.push(latch.id);
  wire(p, latch.id, 'out', hh.m(11).id, 'cv');
  hh.a.inputs = [
    { module: hh.m(5).id, port: 'gate', label: 'gate', also: [{ module: latch.id, port: 'clock' }] },
    { module: hh.m(7).id, port: 'gate', label: 'open', also: [{ module: latch.id, port: 'in' }, { module: latch.id, port: 'clock' }] },
  ];
  velocity(hh.a, 4, [hh.m(6), 'gain']);
  hh.a.inputs[hh.a.inputs.length - 1].label = 'closed vel';
  velocity(hh.a, 5, [hh.m(8), 'gain']);
  hh.a.inputs[hh.a.inputs.length - 1].label = 'open vel';
  Object.assign(hh.m(12).params, { l1: 0.5, l2: 0.5 });   // (CLOSED and OPEN HIHAT LEVEL: set from a render below)
  /** the tom's and the rim's strike: a VCA on the row's velocity in place of the Scale (`hit`) between the pulse and the
   * body, as loud on a plain step (a macro range on so small a gain would not survive the FM-1's 256 range steps) */
  const strike = (d: typeof bd, r: number): void => {
    const hit = d.m(2);
    const vca = addModule(p, DEFS.vca, hit.x, hit.y);
    vca.params.gain = Math.round(hit.params.gain * ACCENT_808 * 10000) / 10000;
    for (const c of p.cables) {
      if (c.to.module === hit.id) c.to = { module: vca.id, port: 'in' };
      if (c.from.module === hit.id) c.from = { module: vca.id, port: 'out' };
    }
    removeModule(p, hit.id);
    d.a.modules = d.a.modules.map((id) => (id === hit.id ? vca.id : id));
    wire(p, map.id, `v${r}`, vca.id, 'cv');
    d.a.inputs.push({ module: vca.id, port: 'cv', label: 'vel' });
  };
  const lt = drum('tom', 4, 'low tom');
  strike(lt, 6);
  const rs = drum('rim', 5, 'rim shot');
  strike(rs, 7);
  const cb = drum('cowbell', 6, 'cow bell');
  velocity(cb.a, 8, [cb.m(6), 'gain']);
  //                       drum  map row  pattern (X: an accent)  mixer
  const drums: [typeof bd, number, string, number, string][] = [
    [bd, 1, 'X...x...x.x.....', mixA.id, 'in1'],
    [sd, 2, '....X.......X..x', mixA.id, 'in2'],
    [cp, 3, '............X...', mixA.id, 'in3'],
    [hh, 4, 'x.X.x.X.x.X.x.X.', mixB.id, 'in1'],
    [hh, 5, '..............x.', -1, ''],
    [lt, 6, '................', mixB.id, 'in2'],
    [rs, 7, '................', mixB.id, 'in3'],
    [cb, 8, '..........x.....', mixB.id, 'in4'],
  ];
  const notes: StepNote[] = [];
  for (const [d, r, steps, to, port] of drums) {
    const key = Math.round(map.params[`n${r}`]);
    for (const n of patternNotes(steps) ?? []) notes.push({ ...n, note: key });
    plugIn(p, map.id, `g${r}`, d.a, r === 5 ? 'open' : 'gate');
    if (to >= 0) plugOut(p, d.a, 'out', to, port);
  }
  st.notes = fixNotes(notes);
  wire(p, mixB.id, 'out', mixA.id, 'in4');
  wire(p, mixA.id, 'out', out.id, 'l');
  wire(p, mixA.id, 'out', out.id, 'r');
  // the hats' two levels: each hat about as loud as the 808 Kit's two hihat assemblies were (their peaks at the Output's
  // level 0.1)
  out.params.level = 0.1;
  for (const [r, lv, want] of [[4, 'l1', 0.034], [5, 'l2', 0.029]] as const) {
    hh.m(12).params[lv] = 1;
    const other = lv === 'l1' ? 'l2' : 'l1';
    const keep = hh.m(12).params[other];
    hh.m(12).params[other] = 0;
    const got = peakOf(p, [Math.round(map.params[`n${r}`])], 1.5);
    hh.m(12).params[other] = keep;
    hh.m(12).params[lv] = Math.round(Math.min(1, want / Math.max(got, 1e-6)) * 100) / 100;
  }
  // the card: one "808 kit" around the drums and the mixers, the TR-808's knobs in its panel's order
  const card = makeAssembly(p, [mixA.id, mixB.id], '808 kit', drums.map(([d]) => d.a.id).filter((id, i, all) => all.indexOf(id) === i));
  Object.assign(card, { x: 380, y: 600 });   // (under the track, where the drums are)
  const rows: [string, string, ModuleInst, string][] = [
    ['bass drum', 'level', mixA, 'l1'], ['', 'tone', bdTone, 'cutoff'], ['', 'decay', bd.m(4), 'r3'],
    ['snare drum', 'level', mixA, 'l2'], ['', 'tone', sdTone, 'mix'], ['', 'snappy', sd.m(8), 'l1'],
    ['low tom', 'level', mixB, 'l2'], ['', 'tuning', lt.m(3), 'coarse'],
    ['rim shot', 'level', mixB, 'l3'],
    ['hand clap', 'level', mixA, 'l3'],
    ['cow bell', 'level', mixB, 'l4'],
    ['open hihat', 'level', hh.m(12), 'l2'], ['', 'decay', hh.m(7), 'r3'],
    ['closed hihat', 'level', hh.m(12), 'l1'],
  ];
  card.params = rows.map(([head, label, m, param]) => ({ module: m.id, param, label, ...(head ? { head } : {}) }));
  // each drum's own card (open the 808 kit card to see them) shows the same rows
  for (const [d] of drums) d.a.params = card.params.filter((r) => allModules(p, d.a).includes(r.module)).map(({ module, param, label }) => ({ module, param, label }));
  // (by hand, not reconcile: that would show the velocity pins as rows) the card's jacks: each drum's, after its name
  card.inputs = [...new Set(drums.map(([d]) => d.a))].flatMap((a) => a.inputs.map((r) => ({ ...r, label: `${a.label} ${r.label}` })));
  card.outputs = [{ module: mixA.id, port: 'out', label: 'out' }];
  level(p, { drums: true });
  p.octave = -1;
  return p;
});

// ---- after the 909 Kit (it is built from it)
const kept = readdirSync(DIR).find((f) => f.endsWith(KEEP));
if (!kept) throw new Error(`presets/*-${KEEP} is missing (restore it from git)`);
const keptJson = readFileSync(new URL(kept, DIR), 'utf8');
const after: (() => Patch)[] = [];

// <7PH: a groove-box test patch, the 909 Kit's drums with a Silver Box on its own track, PLAY starts both at one
// tempo. Main's keys go into PATTERN (they play the bass unarmed); DRUMS has no cable from Main, so its keys reach the kit
// only when DRUMS is armed. The bass joins the kit's mixer on in4, so one page balances kick, snare, hats and bass.
// PATTERN: a 16-step acid line in B flat minor (the kick sits on B flat), X an accent, a note two steps long either a
// slide (a note starts on the next step: the voice glides) or a tie (the next step rests).
const GROOVE_TEMPO = 124;
/** the bass's level in the kit's mixer (in4) */
const GROOVE_BASS = 0.7;
const BASS: [number, number, number, boolean][] = [
  // step, note (the Silver Box plays an octave down: 46 = B flat 1), length in steps, accent
  [0, 46, 1, true],
  [1, 58, 1, false],
  [3, 46, 1, false],
  [4, 58, 2, false], // slide into
  [5, 61, 1, true],
  [6, 58, 1, false],
  [7, 56, 1, false],
  [8, 46, 2, true], // tie (9 rests)
  [10, 58, 1, false],
  [11, 63, 2, false], // slide into
  [12, 65, 1, true],
  [13, 63, 1, false],
  [14, 61, 2, false], // slide into
  [15, 58, 1, false],
];
after.push(() => {
  const p = validatePatch(JSON.parse(keptJson), DEFS);
  p.name = '<7PH';
  const main = p.modules.find((m) => m.type === 'fm1')!;
  main.params.tempo = GROOVE_TEMPO;
  const drums = p.modules.find((m) => m.type === 'steps' && m.name === 'DRUMS')!;
  p.cables = p.cables.filter((c) => !(c.from.module === main.id && c.to.module === drums.id));
  const out = p.modules.find((m) => m.type === 'output')!;
  const mix = p.modules.find((m) => m.type === 'mixer' && p.cables.some((c) => c.from.module === m.id && c.to.module === out.id))!;
  // the bass's track under DRUMS, the Silver Box under the kit (the canvas reads columns from the left)
  const st = addModule(p, DEFS.steps, drums.x, 2600);
  st.name = 'PATTERN';
  st.notes = fixNotes(BASS.map(([at, note, len, acc]) => ({ at, len, note, vel: acc ? ACCENT_VEL : STEP_VEL })));
  const def = FACTORY.find((d) => d.name === 'Silver Box')!;
  const a = insertAssembly(p, DEFS, def, 920, 2600);
  // This groove-box test patch is full. Keep the oscillator's plain waveform row here; the standalone instrument has
  // the TB-303's named saw/square switch. Removing its helper preserves the existing sound and test-patch byte budget.
  const waveform = a.params.find((r) => r.label === 'waveform')!;
  const selector = waveform.module;
  const oscillator = mod(p, p.cables.find((c) => c.from.module === selector && c.to.port === 'p1')!.to.module);
  waveform.module = oscillator.id;
  waveform.param = 'wave';
  delete waveform.names;
  removeMember(p, a, selector);
  removeModule(p, selector);
  oscillator.map!.p1 = defaultMap(DEFS.osc).p1;
  // Also, its TUNING row stays on the oscillator's fine tune (a
  // semitone either way), the Macro and Attenuverter that give the standalone Silver Box the TB-303's ±500 cents are left
  // out (they play 0 there, so the sound is the same), and the cutoff row keeps its short name
  a.params.find((r) => r.label === 'cut off freq')!.label = 'cutoff';
  const tuning = a.params.find((r) => r.label === 'tuning')!;
  const knob = tuning.module;
  const span = p.cables.find((c) => c.from.module === knob)!.to.module;
  tuning.module = p.cables.find((c) => c.from.module === span)!.to.module;
  tuning.param = 'fine';
  for (const id of [knob, span]) {
    removeModule(p, id);
    removeMember(p, a, id);
  }
  wire(p, main.id, 'keys', st.id, 'keys');
  plugIn(p, st.id, 'keys', a, 'keys');
  plugOut(p, a, 'out', mix.id, 'in4');
  mix.params.l4 = GROOVE_BASS;
  if (!p.cables.some((c) => c.from.module === mix.id && c.to.module === out.id && c.to.port === 'r')) wire(p, mix.id, 'out', out.id, 'r');
  level(p, { drums: true });
  p.octave = -1;
  return p;
});

// Spokes 6 (after the Elektron Model:Cycles): three Steps tracks into the engine, as the original's tracks: DRUMS plays
// its four drum machines (the Drum map's rows on the white keys from F3, X an accent: the original's PUNCH), TONE and
// CHORD its two melodic ones (their pitch and gate outputs into the voice). Main's keys go into TONE (they play the FM voice
// unarmed); DRUMS and CHORD are reached from the keys when armed. A 16-step groove in A minor at 120 BPM, the original's default tempo: the chord (a minor triad)
// stabs on the offbeats into the delay.
after.push(() => {
  const x = around('Spokes 6', 'Spokes 6');
  const p = x.p;
  x.main.params.tempo = 120;
  p.cables = p.cables.filter((c) => !(c.from.module === x.main.id && c.from.port === 'keys'));
  /** a Steps track into the engine: its keys into the Drum map (`keys`), or its pitch and gate into a melodic voice */
  const track = (name: string, y: number, input: string, notes: StepNote[]): void => {
    const st = addModule(p, DEFS.steps, 20, y);
    st.name = name;
    st.notes = fixNotes(notes);
    if (input === 'keys') plugIn(p, st.id, 'keys', x.a, input);
    else {
      plugIn(p, st.id, 'pitch', x.a, `${input} pitch`);
      plugIn(p, st.id, 'trig', x.a, `${input} gate`);
    }
    if (name === 'TONE') wire(p, x.main.id, 'keys', st.id, 'keys');
  };
  const map = mod(p, x.a.inputs.find((r) => r.label === 'keys')!.module);
  const drums: StepNote[] = [];
  const rows: Record<number, string> = {
    1: 'X...x...X...x..x',
    2: '....X.......X...',
    3: 'x.x.X.x.x.x.X.xx',
    4: '...x..x....x.x..',
  };
  for (const [r, steps] of Object.entries(rows)) {
    const key = Math.round(map.params[`n${r}`]);
    for (const n of patternNotes(steps) ?? []) drums.push({ ...n, note: key });
  }
  track('DRUMS', 300, 'keys', drums);
  //                         step, note, accent
  const tone: [number, number, boolean][] = [[0, 45, true], [3, 45, false], [6, 57, false], [8, 45, true], [10, 48, false], [11, 52, false], [14, 55, false]];
  track('TONE', 600, 'tone', tone.map(([at, note, acc]) => ({ at, len: 1, note, vel: acc ? ACCENT_VEL : STEP_VEL })));
  track('CHORD', 900, 'chord', [[3, 57], [10, 57], [13, 55]].map(([at, note]) => ({ at, len: 1, note, vel: STEP_VEL })));
  level(p, { drums: true });
  p.octave = -1;
  return p;
});

// Cassia 1 (after the Casio CZ-1): two voices on the FM-1 (owner, 2026-10-26), Main's aftertouch into its `at`, and the
// players (D-336) as every melodic patch
after.push(() => {
  const x = around('Cassia 1', 'Cassia 1');
  plugIn(x.p, x.main.id, 'at', x.a, 'at');
  x.set('voices', 2);
  level(x.p, { chord: true });
  return players(validatePatch(structuredClone(x.p), DEFS));
});

// ---- write: build and check every patch first, then clear the folder (but the kept file), number them, the 909 Kit
// after them, then the patches built from it
const slug = (n: string): string => n.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const made = presets.map((f) => silverDemo(players(validatePatch(structuredClone(f()), DEFS))));
const later = after.map((f) => validatePatch(structuredClone(f()), DEFS));
for (const p of [...made, ...later]) {
  const b = deviceBudget(p);
  if (!b.fits) {
    console.log(p.name, (b.cpu.use * 100).toFixed(0), '%', JSON.stringify(b.cpu.modules.slice(0, 8).map((m) => [m.type, m.copies, Math.round(m.cycles)])));
    throw new Error(`${p.name} does not fit the FM-1: ${b.over.map((o) => o.key).join(', ')}`);
  }
}
for (const f of readdirSync(DIR)) if (f.endsWith('.json')) unlinkSync(new URL(f, DIR));
const write = (p: Patch, i: number): void => {
  const b = deviceBudget(p);
  writeFileSync(new URL(`${String(i).padStart(2, '0')}-${slug(p.name)}.json`, DIR), JSON.stringify(p, null, 1) + '\n');
  console.log(`${String(i).padStart(2, '0')} ${p.name.padEnd(16)} cpu ${(b.cpu.use * 100).toFixed(0)} %  memory ${(b.memory * 100).toFixed(0)} %  level ${p.modules.find((m) => m.type === 'output')!.params.level}`);
};
made.forEach(write);
writeFileSync(new URL(`${String(made.length).padStart(2, '0')}-${KEEP}`, DIR), keptJson);
console.log(`${made.length} 909 Kit (kept)`);
later.forEach((p, i) => write(p, made.length + 1 + i));
