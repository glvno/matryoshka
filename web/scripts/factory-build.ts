// SPDX-License-Identifier: GPL-3.0-only
// What the factory patch generators share (gen-presets.ts for the FM-1's, gen-xl.ts and scripts/xl/*.ts for the XLs): a
// patch around a factory assembly (around), its rows by label (row, Inst.set), cables into and out of an assembly
// (plugIn, plugOut), the Output's level from a render (level) and the players (an Arpeggiator and a PATTERN track: players).
import { DEFS } from '../src/modules';
import { addModule, connect, disconnect, emptyPatch, validatePatch, type Cable, type ModuleInst, type Patch } from '../src/patch';
import { setKind, setSwitches, setTarget } from '../src/buttons';
import { FACTORY } from '../src/assemblies';
import { allModules, assembliesOf, insertAssembly, parentOf, type AssemblyInst } from '../src/assembly';
import { deviceBudget } from '../src/patchbin';
import { allocatorOf, setPoly } from '../src/poly';
import { Engine } from '../src/engine';

export type Ref = { module: number; param: string };
/** a row of an assembly card by label; a label that repeats (a d s r) by the section after the row `after` */
export function row(a: AssemblyInst, label: string, after?: string): Ref {
  const from = after ? a.params.findIndex((r) => r.label === after) : 0;
  if (from < 0) throw new Error(`no row ${after}`);
  const r = a.params.slice(from).find((x) => x.label === label);
  if (!r) throw new Error(`no row ${label}`);
  return r;
}
export const mod = (p: Patch, id: number): ModuleInst => p.modules.find((m) => m.id === id)!;
export const wire = (p: Patch, a: number, ap: string, b: number, bp: string): void => {
  if (!connect(p, DEFS, { module: a, port: ap }, { module: b, port: bp })) throw new Error(`${p.name}: bad cable ${a}.${ap} -> ${b}.${bp}`);
};
export function plugIn(p: Patch, from: number, port: string, a: AssemblyInst, label: string): void {
  const r = a.inputs.find((x) => x.label === label);
  if (!r) throw new Error(`${p.name}: no input ${label}`);
  for (const t of [r, ...(r.also ?? [])]) wire(p, from, port, t.module, t.port); // an input may feed several ports
}
export function plugOut(p: Patch, a: AssemblyInst, label: string, to: number, port: string): void {
  const r = a.outputs.find((x) => x.label === label);
  if (!r) throw new Error(`${p.name}: no output ${label}`);
  wire(p, r.module, r.port, to, port);
}

export interface Inst {
  p: Patch;
  main: ModuleInst;
  out: ModuleInst;
  a: AssemblyInst;
  set(label: string, v: number, after?: string): void;
}
/** a patch around one factory assembly: Main's keys (or pitch / gate) and mod wheel in, the outputs to the Output */
export function around(name: string, asm: string, o: { pitchGate?: boolean; poly?: number } = {}): Inst {
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
export function peakOf(p: Patch, notes: number[], secs = 1.2, run = false): number {
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
export function level(p: Patch, opts: { chord?: boolean; drums?: boolean } = {}): void {
  const out = p.modules.find((m) => m.type === 'output')!;
  out.params.level = 0.1;
  const single = peakOf(p, opts.drums ? [] : [48], opts.drums ? 4 : 1.2, !!opts.drums) / 0.1;
  const chord = opts.chord ? peakOf(p, [48, 55, 60, 64]) / 0.1 : 0;
  let lv = Math.min(0.45 / Math.max(single, 1e-6), chord ? 0.85 / chord : 1);
  lv = Math.max(0.05, Math.min(1, lv));
  out.params.level = Math.round(lv * 100) / 100;
}

// ---- the players (the owner, 2026-10-23: docs/ledger/patches-and-presets.md D-336): every melodic patch gets an Arpeggiator on ARP, bypassed (the patch sounds as before until ARP is pressed: bypassed it hands the keys
// straight on), and an empty 16-step Steps track PATTERN in front of it: Main's keys -> PATTERN (they pass through it
// unarmed) -> the Arpeggiator -> what Main's keys played, so the track's notes and the keys both go through the
// arpeggiator. A patch with a PATTERN already (Scrounge, Meridian 8, Perun 4) gets the arpeggiator after it. One that
// played Main's pitch / gate gets a one-voice Voicing for the arpeggiator to play. Oracle V and Algo Four run past the CPU
// estimate's warning with them (the owner accepts it); one that would not fit the FM-1's limits would get the arpeggiator
// alone, else neither. The drum kits, <7PH and Spokes 6 get neither on the FM-1 (Spokes 6's melodic voices play their
// Steps tracks' pitch and gate, which an arpeggiator's keys cannot reach); an XL is the kitchen sink and gets both, a
// kit's arpeggiator between its DRUMS track and its Drum map.
export const DRUMS = new Set(['808 Kit', '909 Kit', '<7PH', 'Spokes 6']);
export type Player = 'both' | 'arp' | 'none';
export function withPlayers(src: Patch, what: Player): Patch {
  const p = structuredClone(src);
  if (what === 'none') return p;
  const main = p.modules.find((m) => m.type === 'fm1')!;
  const below = Math.max(...p.modules.map((m) => m.y)) + 300;
  const keysOut = (id: number): Cable[] => p.cables.filter((c) => c.from.module === id && c.from.port === 'keys' && mod(p, c.to.module).type !== 'steps');
  let track = p.modules.find((m) => m.type === 'steps' && (m.name === 'PATTERN' || m.name === 'DRUMS'));
  let into = keysOut(track?.id ?? main.id);
  if (!into.length) {
    // Main's pitch / gate played the voice: a one-voice Voicing between (its pitch and gate as Main's were), inside the
    // voice's assembly when it is one (the Poly switch: the patch keeps opening on the voice), else on its own
    const played = p.cables.filter((c) => c.from.module === main.id && (c.from.port === 'pitch' || c.from.port === 'gate'));
    const asm = assembliesOf(p).find((a) => !parentOf(p, a.id) && played.every((c) => allModules(p, a).includes(c.to.module)));
    if (asm) {
      setPoly(p, DEFS, asm, true);
      allocatorOf(p, asm)!.params.voices = 1;
    } else {
      const v = addModule(p, DEFS.alloc, 380, below);
      v.params.voices = 1;
      for (const c of played) c.from = { module: v.id, port: c.from.port };
      wire(p, main.id, 'keys', v.id, 'keys');
    }
    into = keysOut(main.id);
  }
  if (what === 'both' && !track) {
    track = addModule(p, DEFS.steps, 20, below);
    track.name = 'PATTERN';
    track.notes = [];
    wire(p, main.id, 'keys', track.id, 'keys');
  }
  const from = track ?? main;
  // (the arpeggiator right of the voice: the FM-1 lists it after it, and a patch opens on the voice: pages.ts)
  const arp = addModule(p, DEFS.arp, Math.max(...p.modules.filter((m) => m.type !== 'output').map((m) => m.x)) + 380, below);
  arp.bypass = true;
  for (const c of into) {
    disconnect(p, c);
    wire(p, arp.id, 'keys', c.to.module, c.to.port);
  }
  wire(p, from.id, 'keys', arp.id, 'keys');
  // an assembly's `arp clock` output steps the arpeggiator, one step per edge (Io 4: the Jupiter-4's TRIGGER RATE)
  for (const a of assembliesOf(p)) if (!parentOf(p, a.id)) for (const o of a.outputs) if (o.label === 'arp clock') wire(p, o.module, o.port, arp.id, 'clk');
  setKind(p, 'arp', 'bypass');
  setTarget(p, 'arp', { module: arp.id });
  setSwitches(p, 'arp', true);
  return p;
}
/** the most a patch takes: the players that fit the FM-1 (its limits; the CPU estimate's warning is no bar); with
 * `browser` (an XL: it never goes to the FM-1) both, whatever the budget, the drum kits too */
export function players(p: Patch, browser = false): Patch {
  if (browser) return validatePatch(withPlayers(p, 'both'), DEFS);
  if (DRUMS.has(p.name)) return p;
  // Io 4's four voices shed on the rig with PATTERN, despite the model saying it fits. Keep its existing player set.
  // Measurement: docs/measurements/2026-10-26-io-4-player-budget.json. An XL still gets both above.
  const attempts: Player[] = p.name === 'Io 4' ? ['arp'] : ['both', 'arp'];
  for (const what of attempts) {
    const q = validatePatch(withPlayers(p, what), DEFS);
    if (deviceBudget(q).fits) return q;
  }
  return p;
}

