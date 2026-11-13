// SPDX-License-Identifier: GPL-3.0-only
// Draft engine after the Roland SH-101 (issue #869): its block diagram and specifications in Roland's service notes
// (Nov. 1982). Built with the same calls as gen-assemblies.ts (add / wire / input / output / param), plus rows that set
// several parameters (`also`). Writes sh-101-assembly.json (Library > Assemblies > Import .json) and sh-101.json (a
// patch: Main -> engine -> Output) next to this file. Not a factory engine yet: #869 lists what moving it into
// gen-assemblies.ts takes.
// Run from web/:  npx vite-node scripts/sh-101-draft/build.ts
import { writeFileSync } from 'node:fs';
import { DEFS } from '../../src/modules';
import { defaultMap, defaultParams, rowDef, newPatch, connect, validatePatch, type ModuleInst, type Source, type Endpoint } from '../../src/patch';
import { insertAssembly, targetsOf, validateAssemblyDef, type AssemblyDef, type ParamRef, type PortRef } from '../../src/assembly';
import { defIsEngine } from '../../src/engines';
import { cpuEstimate } from '../../src/cpu';
import { deviceBudget } from '../../src/patchbin';
import { renderAudition } from '../audition-render';

const OUT = new URL('./', import.meta.url);
const GX = 320, GY = 560;

// ---- the builder (gen-assemblies.ts `build`, the subset used here, plus rows that set several parameters: `also`)
const modules: ModuleInst[] = [];
const cables: AssemblyDef['cables'] = [];
const inputs: PortRef[] = [];
const outputs: PortRef[] = [];
const params: ParamRef[] = [];
const has = (id: number, port: string, dir: 'inputs' | 'outputs'): void => {
  const m = modules[id - 1];
  if (!m || !DEFS[m.type][dir].some((p) => p.name === port)) throw new Error(`no ${dir} ${port} on module ${id}`);
};
const add = (type: string, col: number, row: number, p: Record<string, number> = {}, pins?: { p1?: string; p2?: string; att?: [number, number] }): number => {
  const def = DEFS[type];
  for (const k of Object.keys(p)) if (!def.params.some((q) => q.name === k)) throw new Error(`${type} has no parameter ${k}`);
  const m: ModuleInst = { id: modules.length + 1, type, x: col * GX, y: row * GY, params: { ...defaultParams(def), ...p } };
  if (def.paramInputs) {
    const map = defaultMap(def) as Record<Source, string[]>;
    if (pins?.p1) map.p1 = [pins.p1];
    if (pins?.p2) map.p2 = [pins.p2];
    m.att = pins?.att ?? [1, 1];
    m.map = map;
  }
  modules.push(m);
  return m.id;
};
const wire = (a: number, ap: string, b: number, bp: string): void => {
  has(a, ap, 'outputs');
  has(b, bp, 'inputs');
  cables.push({ from: { module: a, port: ap }, to: { module: b, port: bp } });
};
const input = (label: string, module: number, port: string, ...also: [number, string][]): void => {
  has(module, port, 'inputs');
  for (const [m, p] of also) has(m, p, 'inputs');
  inputs.push({ module, port, label, ...(also.length ? { also: also.map(([m, p]) => ({ module: m, port: p })) } : {}) });
};
const output = (label: string, module: number, port: string): void => {
  has(module, port, 'outputs');
  outputs.push({ module, port, label });
};
const param = (label: string, module: number, name: string, o: { head?: string; col?: boolean; names?: string[]; also?: [number, string][] } = {}): void => {
  if (!rowDef(DEFS[modules[module - 1].type], name)) throw new Error(`no parameter ${name} on module ${module}`);
  params.push({
    module, param: name, label,
    ...(o.col && params.length ? { col: true as const } : {}),
    ...(o.head ? { head: o.head } : {}),
    ...(o.names ? { names: o.names } : {}),
    ...(o.also ? { also: o.also.map(([m, p]) => ({ module: m, param: p })) } : {}),
  });
};

// ---- the instrument
// CPU: the key assigner. One voice, last-note priority, legato on (a new key over a held one does not drop the gate:
// GATE+TRIG makes the retrigger itself, below).
const part = add('alloc', 0, 2, { voices: 1, legato: 2, priority: 0 });

// PORTAMENTO (0..5 s) and its ON / OFF / AUTO switch: the switch's value moves the slew's time through its pin
// (x the time's whole range): ON 0 (the time as set), OFF -1 (the shortest), AUTO the key's legato gate - 1.
const porta = add('glide', 1, 2, { time: 0.15 }, { p1: 'time', att: [1, 1] });
const portaMode = add('select', 1, 3, { count: 3, pos: 2, v1: 0, v2: -1, v3: -1, fade: 0 });
wire(part, 'pitch', porta, 'in');
wire(part, 'legato', portaMode, 'in3');
wire(portaMode, 'out', porta, 'p1');

// RANGE 16' .. 2': octaves added to the VCO's pitch (not to KYBD, which reads the key's CV after the portamento).
const range = add('select', 2, 3, { count: 4, pos: 2, v1: -1, v2: 0, v3: 1, v4: 2, fade: 0 });

// The VCO's pitch: one sum (an Attenuverter at gain 1) of the glided key, RANGE, MOD, the lever's LFO and the bender.
const vcoPitch = add('scale', 2, 2, { gain: 1, offset: 0 });
wire(porta, 'out', vcoPitch, 'in');
wire(range, 'out', vcoPitch, 'in');

// The VCO's pulse and saw, and the SUB OSC (a divider of the VCO: here an oscillator on the same pitch, 1 or 2 octaves
// down, phase locked to it). analog 1: the circuit's wave shapes.
const pulse = add('osc', 3, 0, { wave: 3, pw: 0.5, level: 1, analog: 1 }, { p1: 'pw', att: [-0.5, 1] });
const saw = add('osc', 3, 1, { wave: 2, level: 1, analog: 1 });
// SUB OSC switch: 1 OCT DOWN square, 2 OCT DOWN square, 2 OCT DOWN 25 % pulse. Pin 1 takes the Selector's value
// (x 96 st x 0.125: -1 = 12 st lower), pin 2 the third position's gate (x 0.9 x -0.2778: pulse width 0.5 -> 0.25).
const sub = add('osc', 3, 2, { wave: 3, pw: 0.5, coarse: -12, level: 1, analog: 1 }, { p1: 'coarse', p2: 'pw', att: [0.125, -0.2778] });
const subMode = add('select', 2, 4, { count: 3, pos: 1, v1: 0, v2: -1, v3: -1, fade: 0 });
wire(subMode, 'out', sub, 'p1');
wire(subMode, 'g3', sub, 'p2');
for (const o of [pulse, saw, sub]) wire(vcoPitch, 'out', o, 'pitch');

const noise = add('noise', 3, 3, { level: 1, color: 0 });

// LFO / CLK (0.1 .. 30 Hz): the triangle (`out`) and the square (`pulse`, the same cycle). RANDOM: the noise sampled at
// each cycle (the CPU's random voltage, clocked by the LFO). The MOD waveform switch picks triangle, square, random or
// noise; the selected wave feeds VCO MOD and VCF MOD.
const lfo = add('lfo', 0, 0, { wave: 1, rate: 3, depth: 1 });
const random = add('sh', 0, 1, { mode: 0 });
wire(noise, 'out', random, 'in');
wire(lfo, 'pulse', random, 'clock');
const lfoWave = add('select', 1, 0, { count: 4, pos: 1, fade: 0 });
wire(lfo, 'out', lfoWave, 'in1');
wire(lfo, 'pulse', lfoWave, 'in2');
wire(random, 'out', lfoWave, 'in3');
wire(noise, 'out', lfoWave, 'in4');
const vcoMod = add('scale', 2, 0, { gain: 0, offset: 0 }); // VCO MOD: octaves per unit of the selected wave
wire(lfoWave, 'out', vcoMod, 'in');
wire(vcoMod, 'out', vcoPitch, 'in');

// The ENV GEN (A 1.5 ms .. 4 s, D and R 2 ms .. 10 s: `long` on, so the decay and release rows reach 12 s / 19 s)
const env = add('adsr', 5, 2, { a: 0.003, d: 0.25, s: 0.4, r: 0.1, long: 1 });

// PWM: the source switch ENV / MAN / LFO (the LFO's triangle, made 0..1, as the diagram's "~" contact), times the PWM
// slider, narrows the pulse from 50 % (0) toward 5 % (1) through the oscillator's pin (x 0.9 x -0.5).
const lfoUni = add('scale', 1, 1, { gain: 0.5, offset: 0.5 });
wire(lfo, 'out', lfoUni, 'in');
const pwmSrc = add('select', 2, 1, { count: 3, pos: 2, v1: 0, v2: 1, v3: 0, fade: 0 });
wire(env, 'env', pwmSrc, 'in1');
wire(lfoUni, 'out', pwmSrc, 'in3');
const pwm = add('scale', 2.5, 1, { gain: 0, offset: 0 });
wire(pwmSrc, 'out', pwm, 'in');
wire(pwm, 'out', pulse, 'p1');

// SOURCE MIXER: pulse, saw, sub, noise
const mixer = add('mixer', 4, 1, { l1: 0, l2: 0.6, l3: 0.35, l4: 0 });
wire(pulse, 'out', mixer, 'in1');
wire(saw, 'out', mixer, 'in2');
wire(sub, 'out', mixer, 'in3');
wire(noise, 'out', mixer, 'in4');

// VCF: a 24 dB low pass (cutoff, resonance), cvamt 1: ENV, MOD, KYBD (0..100 % of the key's CV after the portamento),
// the bender and the lever's LFO each reach the cutoff through their own amount, in octaves.
const vcf = add('ladder', 5, 0, { cutoff: 500, res: 0.35, cvamt: 1, drive: 1, track: 0, diode: 0 });
wire(mixer, 'out', vcf, 'in');
const vcfEnv = add('scale', 5, 1, { gain: 3, offset: 0 });
wire(env, 'env', vcfEnv, 'in');
wire(vcfEnv, 'out', vcf, 'cv');
const vcfMod = add('scale', 4, 0, { gain: 0, offset: 0 });
wire(lfoWave, 'out', vcfMod, 'in');
wire(vcfMod, 'out', vcf, 'cv');
const kybd = add('scale', 4, 2, { gain: 0.5, offset: 0 });
wire(porta, 'out', kybd, 'in');
wire(kybd, 'out', vcf, 'cv');

// The ENV GEN's trigger switch: GATE+TRIG (each new key restarts it, legato too: the key's gate with its one-sample
// trig taken out), GATE (only a new phrase restarts it), LFO (the LFO's square restarts it while a key is held).
const gateTrig = add('logic', 4, 3, { thresh: 0.5 });
wire(part, 'gate', gateTrig, 'a');
wire(part, 'trig', gateTrig, 'b');
const lfoTrig = add('logic', 4, 4, { thresh: 0.5 });
wire(part, 'gate', lfoTrig, 'a');
wire(lfo, 'pulse', lfoTrig, 'b');
const trigMode = add('select', 5, 3, { count: 3, pos: 1, fade: 0 });
wire(gateTrig, 'xor', trigMode, 'in1');
wire(part, 'gate', trigMode, 'in2');
wire(lfoTrig, 'and', trigMode, 'in3');
wire(trigMode, 'out', env, 'gate');

// VCA: ENV or GATE, then VOLUME
const vcaMode = add('select', 6, 1, { count: 2, pos: 1, fade: 0 });
wire(env, 'env', vcaMode, 'in1');
wire(part, 'gate', vcaMode, 'in2');
const vca = add('vca', 6, 0, { gain: 1 });
wire(vcf, 'lp24', vca, 'in');
wire(vcaMode, 'out', vca, 'cv');

// BENDER: the lever's VCO and VCF amounts (Main's bend; the key's pitch already carries Main's 2 semitones), and
// ~LFO MOD: the LFO's triangle, opened by pushing the lever (Main's mod), through one amount into the VCO and the VCF.
const bendVco = add('scale', 0, 3, { gain: 0, offset: 0 });
const bendVcf = add('scale', 0, 4, { gain: 0, offset: 0 });
wire(bendVco, 'out', vcoPitch, 'in');
wire(bendVcf, 'out', vcf, 'cv');
const lfoMod = add('vca', 1, 4, { gain: 0.1 });
wire(lfo, 'out', lfoMod, 'in');
wire(lfoMod, 'out', vcoPitch, 'in');
wire(lfoMod, 'out', vcf, 'cv');

input('keys', part, 'keys');
input('bend', bendVco, 'in', [bendVcf, 'in']);
input('lfo mod', lfoMod, 'cv');
output('out', vca, 'out');

// The card, the SH-101's panel left to right
param('rate', lfo, 'rate', { head: 'modulator' });
param('waveform', lfoWave, 'pos', { names: ['TRIANGLE', 'SQUARE', 'RANDOM', 'NOISE'] });
param('vco mod', vcoMod, 'gain', { col: true, head: 'vco' });
param('range', range, 'pos', { names: ["16'", "8'", "4'", "2'"] });
param('pw', pwm, 'gain');
param('pwm source', pwmSrc, 'pos', { names: ['ENV', 'MAN', 'LFO'] });
param('tune', saw, 'fine', { also: [[pulse, 'fine'], [sub, 'fine']] });
param('pulse', mixer, 'l1', { col: true, head: 'source mixer' });
param('saw', mixer, 'l2');
param('sub osc', mixer, 'l3');
param('sub mode', subMode, 'pos', { names: ['1 OCT DOWN', '2 OCT DOWN', '2 OCT PULSE'] });
param('noise', mixer, 'l4');
param('freq', vcf, 'cutoff', { col: true, head: 'vcf' });
param('res', vcf, 'res');
param('vcf env', vcfEnv, 'gain');
param('vcf mod', vcfMod, 'gain');
param('kybd', kybd, 'gain');
param('vca', vcaMode, 'pos', { col: true, head: 'vca / env', names: ['ENV', 'GATE'] });
param('env trigger', trigMode, 'pos', { names: ['GATE+TRIG', 'GATE', 'LFO'] });
param('attack', env, 'a');
param('decay', env, 'd');
param('sustain', env, 's');
param('release', env, 'r');
param('portamento', porta, 'time', { col: true, head: 'controller' });
param('porta mode', portaMode, 'pos', { names: ['ON', 'OFF', 'AUTO'] });
param('bend vco', bendVco, 'gain');
param('bend vcf', bendVcf, 'gain');
param('lfo mod', lfoMod, 'gain');
param('volume', vca, 'gain');

const raw: AssemblyDef = {
  format: 'matryoshka-assembly', version: 1, name: 'SH-101',
  blurb: 'Roland SH-101 after its block diagram: VCO with sub and noise, 24 dB VCF, one ADSR, LFO, portamento, bender.',
  modules, cables, inputs, outputs, params,
};
const def = validateAssemblyDef(structuredClone(raw), DEFS);
if (def.modules.length !== modules.length || def.cables.length !== cables.length || def.params.length !== params.length) throw new Error('validateAssemblyDef dropped parts of the assembly');
if (!defIsEngine(def)) throw new Error('not recognised as an engine');

// ---- the patch: Main -> SH-101 -> Output
const p = newPatch(DEFS, 'SH-101');
const a = insertAssembly(p, DEFS, def, 300, 300);
const main = p.modules.find((m) => m.type === 'fm1')!.id;
const out = p.modules.find((m) => m.type === 'output')!;
out.params.level = 1; // the factory patches' Output level
const link = (from: Endpoint, to: Endpoint): void => {
  if (!connect(p, DEFS, from, to)) throw new Error(`rejected ${from.module}.${from.port} -> ${to.module}.${to.port}`);
};
const port = (label: string): PortRef => a.inputs.find((r) => r.label === label)!;
for (const t of targetsOf(port('keys'))) link({ module: main, port: 'keys' }, t);
for (const t of targetsOf(port('bend'))) link({ module: main, port: 'bend' }, t);
for (const t of targetsOf(port('lfo mod'))) link({ module: main, port: 'mod' }, t);
link(a.outputs[0], { module: out.id, port: 'l' });
const patch = validatePatch(structuredClone(p), DEFS);
if (patch.modules.length !== p.modules.length || JSON.stringify(patch.cables) !== JSON.stringify(p.cables)) throw new Error('validatePatch changed the patch');

writeFileSync(new URL('sh-101-assembly.json', OUT), JSON.stringify(def, null, 2) + '\n');
writeFileSync(new URL('sh-101.json', OUT), JSON.stringify(patch, null, 2) + '\n');

// ---- FM-1 fit and the level of the audition phrase
const cpu = cpuEstimate(patch);
const budget = deviceBudget(patch);
console.log('modules', modules.length, 'cables', cables.length, 'rows', params.length);
console.log('cpu', JSON.stringify(cpu, (k, v) => (typeof v === 'number' ? Math.round(v * 1000) / 1000 : v)).slice(0, 600));
console.log('budget', JSON.stringify(budget).slice(0, 600));
const [l] = renderAudition(patch, 'melodic');
let peak = 0, sum = 0;
for (const x of l) { peak = Math.max(peak, Math.abs(x)); sum += x * x; }
console.log('render peak', peak.toFixed(3), 'rms', Math.sqrt(sum / l.length).toFixed(4));
