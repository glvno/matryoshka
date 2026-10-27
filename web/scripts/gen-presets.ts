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
import { addModule, emptyPatch, STEP_VEL, validatePatch, type Patch } from '../src/patch';
import { ACCENT_VEL, fixNotes, patternNotes, type StepNote } from '../src/track';
import { FACTORY } from '../src/assemblies';
import { insertAssembly } from '../src/assembly';
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

presets.push(() => {
  const x = around('Silver Box', 'Silver Box');
  level(x.p);
  return x.p;
});

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


// 808 Kit: a drum machine on the transport (PLAY starts it, the Main module's tempo sets it): one DRUMS track (#138) into a
// Drum map whose rows play the boom kick, a tonal snare, the clap, a closed and an open hat, the tom, the rim and the
// two-square cowbell from the factory drum assemblies, each through a VCA on its row's velocity (gain 127 / 100: the
// default velocity plays the drum as tuned, an accent louder); three mixers (the third into the second's in4, the second
// into the first's). Main's keys go into DRUMS (#141), so the keys play the drums unarmed; the rows sit on the white keys
// from F3 (the FM-1's lowest key at octave 0: F3 G3 A3 B3 C4 D4 E4 F4), the editor opens at octave -1 (f g h j k l ...).
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
  const mixA = addModule(p, DEFS.mixer, 3780, 20);
  Object.assign(mixA.params, { l1: 0.8, l2: 0.45, l3: 0.5, l4: 1 });
  const mixB = addModule(p, DEFS.mixer, 3780, 600);
  Object.assign(mixB.params, { l1: 0.35, l2: 0.3, l3: 0.3, l4: 1 });
  const mixC = addModule(p, DEFS.mixer, 3780, 1100);
  Object.assign(mixC.params, { l1: 0.45, l2: 0.35, l3: 0, l4: 0 });
  const out = addModule(p, DEFS.output, 4100, 20);
  //            assembly     map row  pattern (X: an accent)  settings                                        mixer
  const drums: [string, number, string, Record<string, number>, number, string][] = [
    ['boom kick', 1, 'X...x...x.x.....', {}, mixA.id, 'in1'],
    ['snare', 2, '....X.......X..x', { 'body tune': 2, decay: 0.1, noise: 0.45, body: 0.75 }, mixA.id, 'in2'],
    ['clap', 3, '............X...', {}, mixA.id, 'in3'],
    ['hihat', 4, 'x.X.x.X.x.X.x.X.', { decay: 0.04 }, mixB.id, 'in1'],
    ['hihat', 5, '..............x.', { decay: 0.3 }, mixB.id, 'in2'],
    ['tom', 6, '................', {}, mixC.id, 'in1'],
    ['rim', 7, '................', {}, mixC.id, 'in2'],
    ['cowbell', 8, '..........x.....', {}, mixB.id, 'in3'],
  ];
  const notes: StepNote[] = [];
  drums.forEach(([name, r, steps, params, to, port], i) => {
    const def = FACTORY.find((d) => d.name === name);
    if (!def) throw new Error(`no factory assembly ${name}`);
    const a = insertAssembly(p, DEFS, def, 380 + 420 * i, 600);
    for (const [label, v] of Object.entries(params)) {
      const x = row(a, label);
      mod(p, x.module).params[x.param] = v;
    }
    const key = Math.round(map.params[`n${r}`]);
    for (const n of patternNotes(steps) ?? []) notes.push({ ...n, note: key });
    plugIn(p, map.id, `g${r}`, a, 'gate');
    // the drum's output through a VCA inside it whose cv (its vel input) is the row's velocity
    const vca = addModule(p, DEFS.vca, 380 + 420 * i, 1100);
    vca.params.gain = 127 / STEP_VEL;
    const o = a.outputs.find((x) => x.label === 'out')!;
    wire(p, o.module, o.port, vca.id, 'in');
    a.modules.push(vca.id);
    a.outputs = a.outputs.map((x) => (x === o ? { module: vca.id, port: 'out', label: 'out' } : x));
    a.inputs.push({ module: vca.id, port: 'cv', label: 'vel' });
    wire(p, map.id, `v${r}`, vca.id, 'cv');
    wire(p, vca.id, 'out', to, port);
  });
  st.notes = fixNotes(notes);
  wire(p, mixC.id, 'out', mixB.id, 'in4');
  wire(p, mixB.id, 'out', mixA.id, 'in4');
  wire(p, mixA.id, 'out', out.id, 'l');
  wire(p, mixA.id, 'out', out.id, 'r');
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
const made = presets.map((f) => players(validatePatch(structuredClone(f()), DEFS)));
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
