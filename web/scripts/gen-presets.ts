// SPDX-License-Identifier: GPL-3.0-only
// Writes the factory patches (web/presets/NN-name.json, NN = the slot, the order the firmware compiles them in) from
// the factory assemblies (src/assemblies, made by gen-assemblies.ts: run that first). Each patch: the Main module, the
// assembly (or a few modules), Main's keys / mod wheel into it, its outputs into the Output, K1..K4 routed to the
// controls that matter most, each knob starting where the assembly's value is (so the patch sounds as designed until a
// knob is turned), and the Output's level set from a render so the patches play at about the same loudness.
// The 909 Kit is kept as its file. Run from web/:  npx vite-node scripts/gen-presets.ts
import { readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { DEFS } from '../src/modules';
import { addModule, connect, emptyPatch, modulate, validatePatch, type ModuleInst, type Patch } from '../src/patch';
import { FACTORY } from '../src/assemblies';
import { insertAssembly, type AssemblyInst } from '../src/assembly';
import { connectParameter } from '../src/parameter-routing';
import { deviceBudget } from '../src/patchbin';
import { setPoly } from '../src/poly';
import { Engine } from '../src/engine';

const DIR = new URL('../presets/', import.meta.url);
const KEEP = '909-kit.json'; // ours, kept as written

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

/** Main's knob `k` moves this parameter over its whole range: the base goes to the range's minimum, the knob starts
 * where the value was (depth 1 through a free pin) */
function knob(p: Patch, main: ModuleInst, k: string, r: Ref): void {
  const m = mod(p, r.module);
  const pd = DEFS[m.type].params.find((q) => q.name === r.param)!;
  const want = m.params[r.param];
  connectParameter(p, DEFS, { module: main.id, port: k }, m.id, r.param);
  const pin = (['p1', 'p2'] as const).findIndex((q) => (m.map?.[q] ?? []).includes(r.param) && p.cables.some((c) => c.from.module === main.id && c.from.port === k && c.to.module === m.id && c.to.port === q));
  if (pin < 0) throw new Error(`${p.name}: ${k} found no pin on ${m.type}.${r.param}`);
  const att = m.att![pin];
  m.params[r.param] = pd.min;
  let lo = 0, hi = 1;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (modulate(pd, pd.min, mid * att) < want) lo = mid;
    else hi = mid;
  }
  main.params[k] = Math.round(((lo + hi) / 2) * 10000) / 10000;
}

interface Inst {
  p: Patch;
  main: ModuleInst;
  out: ModuleInst;
  a: AssemblyInst;
  set(label: string, v: number, after?: string): void;
  knobs(...k: [string, string?][]): void;
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
    knobs: (...ks) => ks.forEach(([label, after], i) => knob(p, main, `k${i + 1}`, row(a, label, after))),
  };
  return inst;
}

// ---- loudness: the Output's level from a render (a held note, or a chord on a poly patch), clamped to 0.05..1
const SR = 44118;
function peakOf(p: Patch, notes: number[], secs = 1.2): number {
  const e = new Engine(SR);
  e.load(p);
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
  const single = peakOf(p, opts.drums ? [] : [48], opts.drums ? 4 : 1.2) / 0.1;
  const chord = opts.chord ? peakOf(p, [48, 55, 60, 64]) / 0.1 : 0;
  let lv = Math.min(0.45 / Math.max(single, 1e-6), chord ? 0.85 / chord : 1);
  lv = Math.max(0.05, Math.min(1, lv));
  out.params.level = Math.round(lv * 100) / 100;
}

const presets: (() => Patch)[] = [];

// Oracle V: the factory assembly at four voices (five estimate over the FM-1's CPU)
presets.push(() => {
  const x = around('Oracle V', 'Oracle V');
  x.set('voices', 4);
  x.knobs(['cutoff'], ['res'], ['d', 'filter env'], ['r', 'amp env']);
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
  for (const [k, m, q] of [['k1', flt, 'cutoff'], ['k2', flt, 'res'], ['k3', env, 'a'], ['k4', env, 'r']] as const) knob(p, main, k, { module: m.id, param: q });
  level(p);
  return p;
});

// Simple FM: two operators (the factory fm pair), one note at a time from Main
presets.push(() => {
  const x = around('Simple FM', 'fm pair', { pitchGate: true });
  x.knobs(['index'], ['mod decay'], ['mod sustain'], ['release']); // not feedback: above 0 the modulator runs oversampled (the CPU estimate counts a knob on it that way)
  level(x.p);
  return x.p;
});

// Plucked String: the factory pluck (a Karplus-Strong string, a tracking low pass) on four voices
presets.push(() => {
  const x = around('Plucked String', 'pluck', { pitchGate: true, poly: 4 });
  x.knobs(['decay'], ['damp'], ['tone']);
  level(x.p, { chord: true });
  return x.p;
});

presets.push(() => {
  const x = around('Monolith D', 'Monolith D');
  x.set('glide', 0.04);
  x.knobs(['cutoff'], ['emphasis'], ['d', 'filter contour'], ['glide']);
  level(x.p);
  return x.p;
});

presets.push(() => {
  const x = around('Silver Box', 'Silver Box');
  x.knobs(['cutoff'], ['env mod'], ['decay'], ['accent']);
  level(x.p);
  return x.p;
});

presets.push(() => {
  const x = around('Hera 6', 'Hera 6');
  x.set('voices', 4); // six estimate 120 % of the FM-1's CPU
  x.knobs(['cutoff'], ['res'], ['a', 'envelope'], ['r', 'envelope']);
  level(x.p, { chord: true });
  return x.p;
});

presets.push(() => {
  const x = around('Sallen 20', 'Sallen 20');
  x.knobs(['lp cutoff'], ['lp peak'], ['hp cutoff'], ['hp peak']);
  level(x.p);
  return x.p;
});

presets.push(() => {
  const x = around('Expander S', 'Expander S');
  x.knobs(['cutoff'], ['env 1 amt'], ['mode'], ['r', 'env 2']);
  level(x.p, { chord: true });
  return x.p;
});

presets.push(() => {
  const x = around('Algo Four', 'Algo Four');
  x.knobs(['level 2'], ['level 4'], ['r2 1']); // a fourth knob would cost another 1.5 % per voice
  level(x.p, { chord: true });
  return x.p;
});

presets.push(() => {
  const x = around('Canvas', 'Canvas');
  x.knobs(['timbre'], ['fm index'], ['decay'], ['random']);
  level(x.p);
  return x.p;
});

presets.push(() => {
  const x = around('Wanderer', 'Wanderer');
  x.knobs(['cutoff'], ['res'], ['s&h → filter'], ['ring mod']);
  level(x.p, { chord: true });
  return x.p;
});

// 808 Kit: a drum machine that plays itself (as the 909 Kit): a square LFO at sixteenths is the clock, one sequencer
// per drum (a step at -1 rests), Main's gate restarts the pattern. The boom kick, a tonal snare, the clap, a closed and
// an open hat and the two-square cowbell, from the factory drum assemblies; two mixers (the second into the first's in4).
// About 45 modules: it needs the FM-1's 64-module table (ENG_MAX_MODULES).
presets.push(() => {
  const p = emptyPatch('808 Kit');
  const main = addModule(p, DEFS.fm1, 20, 20);
  const clk = addModule(p, DEFS.lfo, 20, 600);
  Object.assign(clk.params, { wave: 3, rate: 8, depth: 1 });
  const mixA = addModule(p, DEFS.mixer, 2940, 20);
  Object.assign(mixA.params, { l1: 0.8, l2: 0.45, l3: 0.5, l4: 1 });
  const mixB = addModule(p, DEFS.mixer, 2940, 600);
  Object.assign(mixB.params, { l1: 0.35, l2: 0.3, l3: 0.3, l4: 0 });
  const out = addModule(p, DEFS.output, 3260, 20);
  const R = -1;
  const drums: [string, number[], Record<string, number>, number, string][] = [
    ['boom kick', [0, R, R, R, 0, R, 0, R], {}, mixA.id, 'in1'],
    ['snare', [R, R, 0, R, R, R, R, R], { 'body tune': 2, decay: 0.1, noise: 0.45, body: 0.75 }, mixA.id, 'in2'],
    ['clap', [R, R, R, R, R, R, 0, R], {}, mixA.id, 'in3'],
    ['hihat', [0, 0, 0, 0, 0, 0, 0, R], { decay: 0.04 }, mixB.id, 'in1'],
    ['hihat', [R, R, R, R, R, R, R, 0], { decay: 0.3 }, mixB.id, 'in2'],
    ['cowbell', [R, R, R, R, R, 0, R, R], {}, mixB.id, 'in3'],
  ];
  const drumsOf: AssemblyInst[] = [];
  drums.forEach(([name, steps, params, to, port], i) => {
    const def = FACTORY.find((d) => d.name === name);
    if (!def) throw new Error(`no factory assembly ${name}`);
    const a = insertAssembly(p, DEFS, def, 380 + 420 * i, 600);
    for (const [label, v] of Object.entries(params)) {
      const r = row(a, label);
      mod(p, r.module).params[r.param] = v;
    }
    const sq = addModule(p, DEFS.seq, 380 + 420 * i, 20);
    steps.forEach((v, s) => (sq.params[`s${s + 1}`] = v));
    Object.assign(sq.params, { len: 8, dir: 0 });
    wire(p, clk.id, 'out', sq.id, 'clock');
    wire(p, main.id, 'gate', sq.id, 'reset');
    plugIn(p, sq.id, 'gate', a, 'gate');
    plugOut(p, a, 'out', to, port);
    drumsOf.push(a);
  });
  wire(p, mixB.id, 'out', mixA.id, 'in4');
  wire(p, mixA.id, 'out', out.id, 'l');
  wire(p, mixA.id, 'out', out.id, 'r');
  // K1 tempo, K2 kick decay, K3 clap tail, K4 closed hat decay
  knob(p, main, 'k1', { module: clk.id, param: 'rate' });
  knob(p, main, 'k2', row(drumsOf[0], 'decay'));
  knob(p, main, 'k3', row(drumsOf[2], 'tail'));
  knob(p, main, 'k4', row(drumsOf[3], 'decay'));
  level(p, { drums: true });
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
