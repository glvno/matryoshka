// SPDX-License-Identifier: GPL-3.0-only
// What the factory patch generators share (gen-presets.ts for the FM-1's, gen-xl.ts and scripts/xl/*.ts for the XLs): a
// patch around a factory assembly (around), its rows by label (row, Inst.set), cables into and out of an assembly
// (plugIn, plugOut), the Output's level from a render (level) and the players (an Arpeggiator and a PATTERN track: players).
import { DEFS } from '../src/modules';
import { addModule, connect, disconnect, emptyPatch, validatePatch, type Cable, type ModuleInst, type Patch } from '../src/patch';
import { setKind, setSwitches, setTarget } from '../src/buttons';
import { FACTORY } from '../src/assemblies';
import { allModules, assembliesOf, insertAssembly, parentOf, type AssemblyDef, type AssemblyInst } from '../src/assembly';
import { LEVEL_ROWS, cases, gainFor, levelRows, measure, peakBound, scaledRow, type Case, type LevelRow, type Loudness } from '../src/levels';
import { cardRows, formatValue } from '../src/preset-cards';
import { deviceBudget } from '../src/patchbin';
import { allocatorOf, setPoly } from '../src/poly';
import { Engine } from '../src/engine';
import { HEADROOM, peakOfPlay, plays } from '../src/headroom';
import { factoryPresets } from '../src/factory-presets'; // (the engines' factory presets, which headroom plays)
import { defStructureAndOrder } from '../src/structure';

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

/** the Output's level lowered (never raised) so that no way of playing the patch peaks over HEADROOM: itself and each of
 * its engines at each factory preset, with min(voices, 8) keys held, its Drum maps' keys, its patterns running
 * (src/headroom.ts, #440), at the FM-1's rate and at 48 kHz. Every factory patch goes through it last, after its level from
 * the rules above. */
export function headroom(p: Patch, secs = 3): Patch {
  const out = p.modules.find((m) => m.type === 'output')!;
  const lv = out.params.level;
  out.params.level = 0.1;
  // (the peak at level 1, at the FM-1's rate and at a browser's usual 48 kHz: a drum's peak moves a few % with the rate)
  const loud = Math.max(...plays(p).flatMap((w) => [SR, 48000].map((sr) => peakOfPlay(w, secs, sr)))) / 0.1;
  out.params.level = loud * lv > HEADROOM ? Math.max(0.01, Math.floor((HEADROOM / loud) * 100) / 100) : lv;
  return p;
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


// ---- loudness (#448, src/levels.ts): the Output and the engine's level rows so that the patch and each factory preset of
// its engine land on the rule (one key at about -18 LUFS, a chord at most 3 LU over that, no way of playing it over the
// peak cap). The Output carries the patch's own sound (the engine at Init); each preset's level rows carry the rest.
// The Output is kept where Init's rows stay as they are when the rows' ranges allow, else moved so they do. A sound
// within LEVEL_HOLD of its rule keeps its value, so a run on settled levels changes nothing.
const LEVEL_HOLD = 0.3;

export interface LevelPlan {
  /** the engine whose level rows were set (null: a patch without one, its Output only) */
  engine: string | null;
  /** the level rows' values at Init (the factory assembly's: presets/cards/levels.json) */
  init: Record<string, number>;
  /** each factory preset's level rows (its card's lines) */
  presets: Record<string, Record<string, number>>;
  /** what was measured, before */
  measured: { preset: string; m: Loudness }[];
}

const dbOf = (k: number): number => 20 * Math.log10(k);

/** set a patch's Output and its engine's level rows at Init by the rule; returns the plan (the presets' rows to write on
 * the engine's card). `output` fixes the Output (an engine without a factory patch of its own, measured in a stand-in) */
export function loudness(p: Patch, o: { output?: number } = {}): LevelPlan {
  const out = p.modules.find((m) => m.type === 'output')!;
  const o0 = out.params.level;
  const list = cases(p);
  const measured = list.map((c) => ({ preset: c.preset, m: measure(c.patch) }));
  // (an assembly the players made an engine, a voice with a Voicing put in, has no presets: the Output alone)
  // (also an engine with no factory presets here, as <7PH's Silver Box)
  const engine = list.length > 1 && list[0].engine && LEVEL_ROWS[list[0].engine.name ?? ''] ? list[0].engine : null;
  if (!engine) {
    const g = gainFor(measured[0].m);
    if (o.output === undefined && Math.abs(dbOf(g)) > LEVEL_HOLD) out.params.level = Math.max(0.01, Math.min(1, (peakBound(measured[0].m) ? Math.floor : Math.round)(o0 * g * 100) / 100));
    return { engine: null, init: {}, presets: {}, measured };
  }
  if (list[0].preset !== 'Init') throw new Error(`${p.name}: its engine is at ${list[0].preset}, not Init`);
  const rowsIn = (c: Case): LevelRow[] => levelRows(c.patch, c.engine!);
  const valuesIn = (c: Case): number[] => rowsIn(c).map((r) => mod(c.patch, r.module).params[r.param]);
  // Init's gain: the patch's own sound and, when the patch differs from it, the Init preset (the same rows), the quieter
  const initAt = list.map((c, i) => (i === 0 || c.preset === 'Init' ? i : -1)).filter((i) => i >= 0);
  const gains = measured.map((x) => gainFor(x.m));
  const gInit = Math.min(...initAt.map((i) => gains[i]));
  const bound = (i: number): boolean => initAt.includes(i) ? initAt.some((j) => peakBound(measured[j].m)) : peakBound(measured[i].m);
  const rows = rowsIn(list[0]);
  // the room each sound's rows have, up and down, as gain factors
  const room = list.map((c) => {
    const v = valuesIn(c);
    let up = Infinity, dn = 0;
    rows.forEach((r, k) => {
      if (r.db) {
        up = Math.min(up, Math.pow(10, (r.max - v[k]) / 20));
        dn = Math.max(dn, Math.pow(10, (r.min - v[k]) / 20));
      } else if (v[k] > 0) {
        up = Math.min(up, r.max / v[k]);
        dn = Math.max(dn, (r.min + r.step) / v[k]);
      }
    });
    return { up, dn };
  });
  const gainOf = (i: number): number => (initAt.includes(i) ? gInit : gains[i]);
  let output = o.output ?? o0;
  if (o.output === undefined) {
    const lo = o0 * Math.max(...list.map((_, i) => gainOf(i) / room[i].up));
    const hi = Math.min(1, o0 * Math.min(...list.map((_, i) => gainOf(i) / room[i].dn)));
    const pref = Math.abs(dbOf(gInit)) <= LEVEL_HOLD ? o0 : o0 * gInit;
    output = Math.min(1, Math.max(lo, Math.min(hi, pref)));
    output = Math.max(0.01, Math.min(1, (output === lo ? Math.ceil : Math.round)(output * 100 - 1e-6) / 100));
    if (Math.abs(dbOf(output / o0)) < 1e-9) output = o0;
  }
  out.params.level = output;
  const valuesFor = (i: number): number[] => {
    const v = valuesIn(list[i]);
    const k = (gainOf(i) * o0) / output;
    if (Math.abs(dbOf(gainOf(i))) <= LEVEL_HOLD && Math.abs(dbOf(o0 / output)) < 1e-9) return v;
    return rows.map((r, j) => scaledRow(r, v[j], k, bound(i)));
  };
  const keyed = (v: number[]): Record<string, number> => Object.fromEntries(rows.map((r, j) => [r.key, v[j]]));
  const initValues = valuesFor(0);
  rows.forEach((r, j) => (mod(p, r.module).params[r.param] = initValues[j]));
  const presets: Record<string, Record<string, number>> = {};
  list.forEach((c, i) => {
    if (i === 0 || c.preset === 'Init') return;
    presets[c.preset] = keyed(valuesFor(i));
  });
  return { engine: engine.name ?? null, init: keyed(initValues), presets, measured };
}

/** a card's text with a preset's level rows set (their lines replaced, or added at the end of its block); an old
 * comment on a level row (the #440 cuts) goes with the line it explained */
export function setCardLevels(text: string, def: AssemblyDef, preset: string, values: Record<string, number>): string {
  const rows = cardRows(def);
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.trim().toLowerCase() === `preset: ${preset}`.toLowerCase());
  if (start < 0) throw new Error(`${def.name}'s card: no preset ${preset}`);
  let end = lines.findIndex((l, i) => i > start && /^\s*preset:/i.test(l));
  if (end < 0) end = lines.length;
  for (const [key, v] of Object.entries(values)) {
    const r = rows.find((x) => x.key === key)!;
    // (written as the card's header names it: the label alone when no other row has it)
    const alone = rows.filter((x) => x.label === r.label).length === 1 && !rows.some((x) => x.key === r.label && x !== r);
    const names = [key, ...(alone ? [r.label] : [])].map((n) => n.toLowerCase());
    const line = `  ${alone ? r.label : key} = ${formatValue(r, v)}`;
    const at = lines.findIndex((l, i) => i > start && i < end && names.includes(l.split('=')[0].trim().toLowerCase()) && l.includes('='));
    if (at >= 0) {
      lines[at] = line;
      if (/^\s*#.*#440/.test(lines[at - 1])) {
        lines.splice(at - 1, 1);
        end--;
      }
    } else {
      let last = end - 1;
      while (last > start && (!lines[last].trim() || lines[last].trim().startsWith('#'))) last--;
      lines.splice(last + 1, 0, line);
      end++;
    }
  }
  return lines.join('\n');
}

/** a plan's levels into this run's factory engine and presets (in memory), so that what follows (headroom, the patches
 * after) plays the presets at their new levels; the files (levels.json, the cards) are written at the end */
export function applyLevels(plan: LevelPlan): void {
  if (!plan.engine) return;
  const def = FACTORY.find((d) => d.name === plan.engine)!;
  const rows = cardRows(def);
  const { structure, order } = defStructureAndOrder(def);
  const at = (key: string): { i: number; pos: number } => {
    const i = rows.find((r) => r.key === key)!.i;
    return { i, pos: order.indexOf(i) };
  };
  const list = factoryPresets().filter((x) => x.structure === structure);
  const set = (name: string, values: Record<string, number>): void => {
    const pr = list.find((x) => x.name === name);
    if (!pr) throw new Error(`${def.name}: no factory preset ${name}`);
    for (const [key, v] of Object.entries(values)) pr.values[at(key).pos] = v;
  };
  for (const [key, v] of Object.entries(plan.init)) {
    const r = def.params[at(key).i];
    def.modules.find((m) => m.id === r.module)!.params[r.param] = v;
  }
  set('Init', plan.init);
  for (const [name, values] of Object.entries(plan.presets)) set(name, values);
}

/** an XL's Output by the loudness rule, from the patch as it is alone (its engines' presets come from their FM-1 versions'
 * cards or the rules, and headroom() after keeps them under the cap) */
export function loudnessOutput(p: Patch): Patch {
  const out = p.modules.find((m) => m.type === 'output')!;
  const m = measure(p);
  const g = gainFor(m);
  if (Math.abs(dbOf(g)) > LEVEL_HOLD) out.params.level = Math.max(0.01, Math.min(1, (peakBound(m) ? Math.floor : Math.round)(out.params.level * g * 100) / 100));
  return p;
}
