// SPDX-License-Identifier: GPL-3.0-only
// Writes the factory patches (web/presets/NN-name.json, NN = the slot, the order the firmware compiles them in) from
// the factory assemblies (src/assemblies, made by gen-assemblies.ts: run that first). Each patch: the Main module, the
// assembly (or a few modules), Main's keys / mod wheel into it, its outputs into the Output, and the Output's level set
// from a render so the patches play at about the same loudness. The knobs need no routing: they turn the rows of the
// device page in focus, and the assembly's card is its pages (pages.ts).
// The 909 Kit is kept as its file. Run from web/:  npx vite-node scripts/gen-presets.ts
import { readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { DEFS } from '../src/modules';
import { addModule, connect, emptyPatch, STEP_VEL, validatePatch, type ModuleInst, type Patch } from '../src/patch';
import { fixNotes, patternNotes, type StepNote } from '../src/track';
import { FACTORY } from '../src/assemblies';
import { insertAssembly, type AssemblyInst } from '../src/assembly';
import { deviceBudget } from '../src/patchbin';
import { setPoly } from '../src/poly';
import { Engine } from '../src/engine';

const DIR = new URL('../presets/', import.meta.url);
const KEEP = '909-kit.json'; // ours, kept as written
/** the drum kits' Drum map rows (#141): the white keys from F3, the FM-1's lowest key at octave 0 */
const KIT_NOTES = [53, 55, 57, 59, 60, 62, 64, 65];

type Ref = { module: number; param: string };
/** a row of an assembly card by label; a label that repeats (a d s r) by the section after the row `after` */
function row(a: AssemblyInst, label: string, after?: string): Ref {
  const from = after ? a.params.findIndex((r) => r.label === after) : 0;
  if (from < 0) throw new Error(`no row ${after}`);
  const r = a.params.slice(from).find((x) => x.label === label);
  if (!r) throw new Error(`no row ${label}`);
  return r;
}
const mod = (p: Patch, id: number): ModuleInst => p.modules.find((m) => m.id === id)!;
const wire = (p: Patch, a: number, ap: string, b: number, bp: string): void => {
  if (!connect(p, DEFS, { module: a, port: ap }, { module: b, port: bp })) throw new Error(`${p.name}: bad cable ${a}.${ap} -> ${b}.${bp}`);
};
function plugIn(p: Patch, from: number, port: string, a: AssemblyInst, label: string): void {
  const r = a.inputs.find((x) => x.label === label);
  if (!r) throw new Error(`${p.name}: no input ${label}`);
  wire(p, from, port, r.module, r.port);
}
function plugOut(p: Patch, a: AssemblyInst, label: string, to: number, port: string): void {
  const r = a.outputs.find((x) => x.label === label);
  if (!r) throw new Error(`${p.name}: no output ${label}`);
  wire(p, r.module, r.port, to, port);
}

interface Inst {
  p: Patch;
  main: ModuleInst;
  out: ModuleInst;
  a: AssemblyInst;
  set(label: string, v: number, after?: string): void;
}
/** a patch around one factory assembly: Main's keys (or pitch / gate) and mod wheel in, the outputs to the Output */
function around(name: string, asm: string, o: { pitchGate?: boolean; poly?: number } = {}): Inst {
  const def = FACTORY.find((d) => d.name === asm);
  if (!def) throw new Error(`no factory assembly ${asm}`);
  const p = emptyPatch(name);
  const main = addModule(p, DEFS.fm1, 20, 20);
  const a = insertAssembly(p, DEFS, def, 20, 60);
  const right = Math.max(...p.modules.map((m) => m.x)) + 380;
  const out = addModule(p, DEFS.output, right, 20);
  if (o.pitchGate) {
    plugIn(p, main.id, 'pitch', a, 'pitch');
    plugIn(p, main.id, 'gate', a, 'gate');
  } else plugIn(p, main.id, 'keys', a, 'keys');
  if (a.inputs.some((x) => x.label === 'wheel')) plugIn(p, main.id, 'mod', a, 'wheel');
  if (a.outputs.some((x) => x.label === 'l')) {
    plugOut(p, a, 'l', out.id, 'l');
    plugOut(p, a, 'r', out.id, 'r');
  } else {
    plugOut(p, a, 'out', out.id, 'l');
    plugOut(p, a, 'out', out.id, 'r');
  }
  if (o.poly) {
    setPoly(p, DEFS, a, true);
    const alloc = p.modules.find((m) => m.type === 'alloc' && a.modules.includes(m.id))!;
    alloc.params.voices = o.poly;
  }
  const inst: Inst = {
    p, main, out, a,
    set: (label, v, after) => {
      const r = row(a, label, after);
      mod(p, r.module).params[r.param] = v;
    },
  };
  return inst;
}

// ---- loudness: the Output's level from a render (a held note, or a chord on a poly patch), clamped to 0.05..1
const SR = 44118;
function peakOf(p: Patch, notes: number[], secs = 1.2, run = false): number {
  const e = new Engine(SR);
  e.load(p);
  e.transport(run); // (the drum kits play on the transport)
  for (const n of notes) e.noteOn(n);
  const l = new Float32Array(Math.round(SR * secs));
  const r = new Float32Array(l.length);
  e.render(l, r);
  let peak = 0;
  for (let i = 0; i < l.length; i++) peak = Math.max(peak, Math.abs(l[i]), Math.abs(r[i]));
  return peak;
}
function level(p: Patch, opts: { chord?: boolean; drums?: boolean } = {}): void {
  const out = p.modules.find((m) => m.type === 'output')!;
  out.params.level = 0.1;
  const single = peakOf(p, opts.drums ? [] : [48], opts.drums ? 4 : 1.2, !!opts.drums) / 0.1;
  const chord = opts.chord ? peakOf(p, [48, 55, 60, 64]) / 0.1 : 0;
  let lv = Math.min(0.45 / Math.max(single, 1e-6), chord ? 0.85 / chord : 1);
  lv = Math.max(0.05, Math.min(1, lv));
  out.params.level = Math.round(lv * 100) / 100;
}

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
  x.set('glide', 0.04);
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
  for (const t of x.a.inputs.find((r) => r.label === 'keys')!.also ?? []) wire(x.p, x.main.id, 'keys', t.module, t.port); // the other blocks' maps
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
  for (const t of x.a.inputs.find((r) => r.label === 'keys')!.also ?? []) wire(x.p, x.main.id, 'keys', t.module, t.port); // the other blocks' maps
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
  sequenced(x, 'SCROUNGE', {
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

// ---- write: build and check every patch first, then clear the folder (but the kept file), number them, the 909 Kit last
const slug = (n: string): string => n.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const made = presets.map((f) => validatePatch(structuredClone(f()), DEFS));
for (const p of made) {
  const b = deviceBudget(p);
  if (!b.fits) {
    console.log(p.name, (b.cpu.use * 100).toFixed(0), '%', JSON.stringify(b.cpu.modules.slice(0, 8).map((m) => [m.type, m.copies, Math.round(m.cycles)])));
    throw new Error(`${p.name} does not fit the FM-1: ${b.over.map((o) => o.key).join(', ')}`);
  }
}
const kept = readdirSync(DIR).find((f) => f.endsWith(KEEP));
if (!kept) throw new Error(`presets/*-${KEEP} is missing (restore it from git)`);
const keptJson = readFileSync(new URL(kept, DIR), 'utf8');
for (const f of readdirSync(DIR)) if (f.endsWith('.json')) unlinkSync(new URL(f, DIR));
made.forEach((p, i) => {
  const b = deviceBudget(p);
  writeFileSync(new URL(`${String(i).padStart(2, '0')}-${slug(p.name)}.json`, DIR), JSON.stringify(p, null, 1) + '\n');
  console.log(`${String(i).padStart(2, '0')} ${p.name.padEnd(16)} cpu ${(b.cpu.use * 100).toFixed(0)} %  memory ${(b.memory * 100).toFixed(0)} %  level ${p.modules.find((m) => m.type === 'output')!.params.level}`);
});
writeFileSync(new URL(`${String(made.length).padStart(2, '0')}-${KEEP}`, DIR), keptJson);
console.log(`${made.length} 909 Kit (kept)`);
