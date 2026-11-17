// SPDX-License-Identifier: GPL-3.0-only
// Mutate and Randomize (#944, #1006): new values for the parameters of the chosen cards, as a sound-design tool. Mutate
// moves about one row in four (MUTATE_SHARE, at least MUTATE_LEAST), each by up to ± the amount of its range, and changes a
// switch or a choice with a chance equal to the amount; Randomize puts every row anywhere in its range. Both move in the
// space macro ranges and the morph move in (octaves for a logarithmic parameter, paramUnit), stay between a macro range's
// From and To, keep to the row's range (rowRange) and steps (stepToward), never reach a stretch past max, and leave alone
// what is locked, what the FM-1 sets when the patch loads, and the modules that play rather than sound (MUTATE_SKIP). A
// level row never ends above the larger of its value and its default, so a result is never suddenly loud. Pitch rows
// (pitchRows) stay as they are unless "Mutate pitch" is on, and then move only by musical steps. A row of an engine with
// factory presets may take a preset's value instead of noise (MutateOptions.pools). Make candidates with two or more keeps
// breeds (breedPatch). The editor applies the result as one undo step (Editor.mutate, Editor.makeCandidates). D-975, D-987.
import { assembliesOf, tiedTo, type AssemblyInst, type RowTarget } from './assembly';
import { RATIOS, rowRange } from './modules';
import { paramUnit, paramValue, topOf, type Cable, type ModuleDef, type ModuleInst, type ParamDef, type Patch } from './patch';
import { stepToward } from './value-input';

export type MutateMode = 'mutate' | 'randomize';

/** the amounts Mutate offers, a share of each parameter's range */
export const MUTATE_AMOUNTS = [0.05, 0.1, 0.25, 0.5] as const;
/** the amount until the user picks another (kept per browser by the host) */
export const MUTATE_DEFAULT = 0.1;
/** Mutate: the chance each row that is not a switch moves */
export const MUTATE_SHARE = 0.25;
/** Mutate: the fewest rows that move, when that many can */
export const MUTATE_LEAST = 2;
/** the chance a moving row of an engine with factory presets takes the value of one of them instead of noise */
export const PRESET_DRAW = 0.5;

/** the modules that play, route or show rather than sound: Mutate and Randomize never move them (Main's tempo, the master
 * level, the voices and key range, a pattern's length and rate, the arpeggio, the drum notes, the chords, a Scope) */
export const MUTATE_SKIP: Record<string, true> = { fm1: true, output: true, alloc: true, steps: true, arp: true, drummap: true, harm: true, scope: true, part: true };

/** the level rows besides `level` itself: the Mixer's inputs, the VCA's gain, the Dynamics' make-up gain */
const LEVELS: Record<string, readonly string[]> = { mixer: ['l1', 'l2', 'l3', 'l4'], vca: ['gain'], dyn: ['gain'] };
/** a level row: Mutate and Randomize never raise it above the larger of its value and its default */
export const isLevel = (type: string, param: string): boolean => param === 'level' || !!LEVELS[type]?.includes(param);

/** a switch or a choice: a toggle, a choice list, or a small whole-number row with no unit (a voice count, a Selector's
 *  position, a sequence's length) */
export const isSwitch = (pd: ParamDef): boolean => !!pd.toggle || !!pd.choices || ((pd.step ?? 0) >= 1 && !pd.unit && pd.max - pd.min <= 16);

/** how a pitch row moves with "Mutate pitch" on: a parameter's own `pitch` (patch.ts), or `offset` for a value row that adds
 *  octaves to a pitch (by an octave, a fifth up or a fourth down); `held` never moves */
export type PitchKind = NonNullable<ParamDef['pitch']> | 'offset';

/** the inputs that set a pitch */
const PITCH_INPUTS: Record<string, readonly string[]> = { osc: ['pitch'], string: ['pitch'], wavetable: ['pitch'], grain: ['pitch'], comb: ['pitch'], modal: ['pitch'], pd: ['pitch'], steps: ['transpose'] };
/** the modules a pitch passes through on its way to a pitch input (through their signal inputs) */
const THROUGH: Record<string, true> = { scale: true, math: true, select: true, range: true, matrix: true, mixer: true, glide: true, quant: true, sh: true, shreg: true, xfade: true };
/** inputs that pass no pitch through a module: positions, clocks, triggers, the parameter inputs */
const NOT_THROUGH: Record<string, true> = { pos: true, clock: true, reset: true, trig: true, gate: true, p1: true, p2: true };
/** the rows of a value module that carry its output's pitch when it reaches a pitch input: `offset` adds octaves, `held`
 *  scales or picks (a gain, a Selector's position, a Quantizer's scale), which no musical step keeps in tune */
const VALUE_ROWS: Record<string, (param: string) => PitchKind | undefined> = {
  const: (q) => (q === 'value' ? 'offset' : undefined),
  scale: (q) => (q === 'offset' ? 'offset' : q === 'gain' ? 'held' : undefined),
  math: (q) => (q === 'off' ? 'offset' : q === 'ka' || q === 'kb' ? 'held' : undefined),
  select: (q) => (/^v\d+$/.test(q) ? 'offset' : q === 'pos' || q === 'count' ? 'held' : undefined),
  seq: (q) => (/^s\d+$/.test(q) ? 'offset' : undefined),
  range: (q) => (['inlo', 'inhi', 'outlo', 'outhi', 'curve'].includes(q) ? 'held' : undefined),
  matrix: () => 'held',
  mixer: (q) => (/^l\d$/.test(q) ? 'held' : undefined),
  quant: (q) => (q === 'scale' || q === 'root' ? 'held' : undefined),
};

/**
 * The pitch rows of `p`: a parameter marked `pitch` in its definition, and a value row (VALUE_ROWS) of a module whose
 * output reaches a pitch input, directly, through other modules a pitch passes through, or through a parameter input
 * mapped to a pitch row. Undefined: not a pitch row.
 */
export function pitchRows(p: Patch, defs: Record<string, ModuleDef>): (m: ModuleInst, param: string) => PitchKind | undefined {
  const byId = new Map(p.modules.map((m) => [m.id, m]));
  const reach = new Set<number>();
  const kind = (m: ModuleInst, param: string): PitchKind | undefined =>
    defs[m.type]?.params.find((q) => q.name === param)?.pitch ?? (reach.has(m.id) ? VALUE_ROWS[m.type]?.(param) : undefined);
  const feedsPitch = (c: Cable): boolean => {
    const to = byId.get(c.to.module);
    if (!to) return false;
    if (PITCH_INPUTS[to.type]?.includes(c.to.port)) return true;
    if (c.to.port === 'p1' || c.to.port === 'p2') return !!to.map?.[c.to.port]?.some((q) => kind(to, q) !== undefined);
    return reach.has(to.id) && !!THROUGH[to.type] && !NOT_THROUGH[c.to.port];
  };
  for (let grew = true; grew;) {
    grew = false;
    for (const c of p.cables) if (!reach.has(c.from.module) && feedsPitch(c)) reach.add(c.from.module), (grew = true);
  }
  return kind;
}

/** is this parameter locked: on its own (the row's ⋮ menu), by its card, or by an assembly it is a member of (at any depth) */
export function isLocked(p: Patch, m: ModuleInst, param: string): boolean {
  if (m.mutateLockAll || m.mutateLock?.includes(param)) return true;
  const asms = assembliesOf(p);
  const seen = new Set<AssemblyInst>();
  for (let a = asms.find((x) => x.modules.includes(m.id)); a && !seen.has(a); a = asms.find((x) => x.children?.includes(a!.id))) {
    if (a.mutateLockAll) return true;
    seen.add(a);
  }
  return false;
}

/** lock or unlock one parameter (its ⋮ menu); false when nothing changed */
export function setParamLock(m: ModuleInst, param: string, on: boolean): boolean {
  const list = m.mutateLock ?? [];
  if (list.includes(param) === on) return false;
  const next = on ? [...list, param] : list.filter((x) => x !== param);
  if (next.length) m.mutateLock = next;
  else delete m.mutateLock;
  return true;
}

/** the cards Mutate and Randomize act on: module cards (every parameter of each) and assembly cards (the rows each shows) */
export interface MutateScope { modules: number[]; assemblies: number[] }

/** the cards Make candidates acts on with none selected: every module card outside an assembly and every top-level assembly
 *  card (its rows). The modules inside an assembly move only when their own card is selected (D-987). */
export function cardScope(p: Patch): MutateScope {
  const asms = assembliesOf(p);
  const inside = new Set(asms.flatMap((a) => a.modules));
  const nested = new Set(asms.flatMap((a) => a.children ?? []));
  return { modules: p.modules.filter((m) => !inside.has(m.id)).map((m) => m.id), assemblies: asms.filter((a) => !nested.has(a.id)).map((a) => a.id) };
}

export interface MutateOptions {
  /** "Mutate pitch" is on: pitch rows move, by musical steps only */
  pitch?: boolean;
  /** Mutate: the chance each row that is not a switch moves (MUTATE_SHARE) */
  share?: number;
  /** the values an engine's factory presets give a row, by `module:param`: a row that moves takes one of them with the
   *  chance PRESET_DRAW instead of noise (never a pitch row) */
  pools?: ReadonlyMap<string, readonly number[]>;
}

export interface MutateResult {
  /** the patch with the new values (a copy; the input is left alone) */
  patch: Patch;
  /** how many parameters changed */
  moved: number;
}

const key = (t: RowTarget): string => `${t.module}:${t.param}`;

/** a whole-number ratio or 0.5: where a Ratio may go with "Mutate pitch" on */
const MUSICAL_RATIO = RATIOS.map((r) => r === 0.5 || Number.isInteger(r));

/** the row targets of the cards in `scope`: every parameter of a module card, the rows of an assembly card */
function scopeTargets(p: Patch, scope: MutateScope, defs: Record<string, ModuleDef>): RowTarget[][] {
  const byId = new Map(p.modules.map((m) => [m.id, m]));
  return [
    ...scope.modules.map((id) => {
      const m = byId.get(id);
      return m && defs[m.type] ? defs[m.type].params.map((pd) => ({ module: id, param: pd.name })) : [];
    }),
    ...scope.assemblies.map((id) => assembliesOf(p).find((a) => a.id === id)?.params.map((r) => ({ module: r.module, param: r.param })) ?? []),
  ];
}

/** one row, or rows a card row ties (#357), that may move, with what a move needs */
interface Row { group: RowTarget[]; m: ModuleInst; pd: ParamDef; rd: ParamDef; from: number; lo: number; hi: number; kind?: PitchKind; pool?: readonly number[] }

/**
 * Mutate or randomize the parameters of `scope` in a copy of `p`. `amount`: Mutate's largest move, a share of the range
 * (Randomize ignores it); `rnd` gives 0..1. Parameters that card rows tie (#357) move as one, and stay put when any of them
 * is locked. A value outside min..max (a stretch) stays as it is. Pitch rows stay unless `opts.pitch`.
 */
export function mutatePatch(p: Patch, scope: MutateScope, mode: MutateMode, amount: number, defs: Record<string, ModuleDef>, rnd: () => number = Math.random, opts: MutateOptions = {}): MutateResult {
  const out = structuredClone(p);
  const byId = new Map(out.modules.map((m) => [m.id, m]));
  const pdOf = (t: RowTarget): ParamDef | undefined => {
    const m = byId.get(t.module);
    return m && defs[m.type]?.params.find((q) => q.name === t.param);
  };
  const pitchOf = pitchRows(out, defs);
  const pick = <T>(xs: readonly T[]): T => xs[Math.min(xs.length - 1, Math.floor(rnd() * xs.length))];
  const seen = new Set<string>();
  const rows: Row[] = [];
  for (const t of scopeTargets(out, scope, defs).flat()) {
    if (seen.has(key(t))) continue;
    const group = tiedTo(out, t.module, t.param);
    for (const g of group) seen.add(key(g));
    if (group.some((g) => {
      const m = byId.get(g.module), pd = pdOf(g);
      return !m || !pd || MUTATE_SKIP[m.type] || pd.fixed || pd.screen || pd.onScreen || isLocked(out, m, g.param);
    })) continue;
    const kinds = group.map((g) => pitchOf(byId.get(g.module)!, g.param)).filter((k): k is PitchKind => !!k);
    const kind = kinds.includes('held') ? 'held' : kinds[0];
    if (kind && (!opts.pitch || kind === 'held')) continue;
    const m = byId.get(t.module)!, pd = pdOf(t)!;
    const from = m.params[pd.name] ?? pd.default;
    if (from < pd.min || from > pd.max) continue;
    // in the unit space of the row's range (a Selector's positions in use, a Delay's time its line holds: rowRange),
    // between the ends of the parameter's macro ranges in use (positions in its own range)
    const rd = rowRange(m.type, m.params, pd);
    let lo = 0, hi = 1;
    for (const pin of ['p1', 'p2'] as const) {
      const r = m.map?.[pin]?.includes(pd.name) ? m.range?.[pin]?.[pd.name] : undefined;
      if (!r) continue;
      const [a, b] = [paramUnit(rd, paramValue(pd, r[0])), paramUnit(rd, paramValue(pd, r[1]))];
      lo = Math.max(lo, Math.min(a, b));
      hi = Math.min(hi, Math.max(a, b));
    }
    if (lo > hi) [lo, hi] = [hi, lo];   // (two macro ranges that do not overlap: between their nearest ends)
    const pool = kind ? undefined : group.map((g) => opts.pools?.get(key(g))).find((x) => x?.length);
    rows.push({ group, m, pd, rd, from, lo, hi, kind, pool });
  }
  // which rows move: every one for Randomize; for Mutate a share of the rows and the switches by the amount, at least
  // MUTATE_LEAST (rows first)
  let moving = rows;
  if (mode === 'mutate') {
    const share = opts.share ?? MUTATE_SHARE;
    const chosen = new Set(rows.filter((r) => rnd() < (!r.kind && isSwitch(r.pd) ? amount : share)));
    for (const sw of [false, true]) {
      const rest = rows.filter((r) => !chosen.has(r) && (!r.kind && isSwitch(r.pd)) === sw);
      while (chosen.size < MUTATE_LEAST && rest.length) chosen.add(rest.splice(Math.min(rest.length - 1, Math.floor(rnd() * rest.length)), 1)[0]);
    }
    moving = rows.filter((r) => chosen.has(r));
  }
  const inBounds = (r: Row, v: number): boolean => {
    if (v < r.rd.min || v > r.rd.max) return false;
    const u = paramUnit(r.rd, v);
    return u >= r.lo - 1e-9 && u <= r.hi + 1e-9;
  };
  /** values set exactly (a musical step), not rounded to the row's steps afterwards */
  const exact = new Set<string>();
  const set: RowTarget[] = [];
  for (const r of moving) {
    const { m, pd, rd, from, lo, hi } = r;
    let v: number | undefined;
    if (r.kind) {
      if (r.kind === 'semitones' || r.kind === 'offset') {
        const steps = (r.kind === 'semitones' ? [12, -12, 7, -5] : [1, -1, 7 / 12, -5 / 12]).map((d) => from + d).filter((x) => inBounds(r, x));
        if (steps.length) v = pick(steps);
      } else if (r.kind === 'ratio') {
        const at = Math.round(from);
        const ok = RATIOS.map((_, i) => i).filter((i) => i !== at && MUSICAL_RATIO[i] && inBounds(r, i));
        // Mutate: the nearest musical ratio above or below; Randomize: any
        const near = mode === 'randomize' ? ok : [Math.max(-1, ...ok.filter((i) => i < at)), Math.min(Infinity, ...ok.filter((i) => i > at))].filter((i) => i >= 0 && i < RATIOS.length);
        if (near.length) v = pick(near);
      } else {
        const cents = (mode === 'randomize' ? 1 : amount) * 10;
        const x = Math.round(from + (rnd() * 2 - 1) * cents);
        v = Math.min(rd.max, Math.max(rd.min, x));
        if (!inBounds(r, v)) v = undefined;
      }
      if (v === undefined) continue;
      for (const g of r.group) exact.add(key(g));
    } else if (r.pool && rnd() < PRESET_DRAW) {
      const x = pick(r.pool);
      v = paramValue(rd, Math.min(hi, Math.max(lo, paramUnit(rd, Math.min(rd.max, Math.max(rd.min, x))))));
    } else if (mode === 'mutate' && isSwitch(pd)) {
      // another of its values, by chance (chosen above), not by distance
      const step = Math.max(1, pd.step ?? 1);
      const others: number[] = [];
      for (let x = rd.min; x <= rd.max + 1e-9; x += step) if (Math.abs(x - from) > 1e-9 && inBounds(r, x)) others.push(x);
      if (!others.length) continue;
      v = pick(others);
    } else {
      const u = Math.min(hi, Math.max(lo, paramUnit(rd, from)));
      v = paramValue(rd, mode === 'randomize' ? lo + rnd() * (hi - lo) : Math.min(hi, Math.max(lo, u + (rnd() * 2 - 1) * amount)));
    }
    if (isLevel(m.type, pd.name)) v = Math.min(v, Math.max(from, pd.default));
    for (const g of r.group) {
      const gpd = pdOf(g)!;
      byId.get(g.module)!.params[g.param] = Math.min(topOf(gpd), Math.max(gpd.min, v));
      set.push(g);
    }
  }
  // the rows' own ranges and steps, once every new value is in: a Selector's position within its new count, a Delay's time
  // within what its line holds with its new ping-pong (rowRange)
  let moved = 0;
  for (const t of set) {
    const m = byId.get(t.module)!, pd = pdOf(t)!;
    const from = p.modules.find((x) => x.id === t.module)!.params[t.param] ?? pd.default;
    const rd = rowRange(m.type, m.params, pd);
    const v = Math.min(rd.max, Math.max(rd.min, m.params[t.param]));
    m.params[t.param] = exact.has(key(t)) ? v : stepToward(rd, from, v, { hi: rd.max });
    if (m.params[t.param] !== from) moved++;
  }
  return { patch: out, moved };
}

/**
 * Breed a candidate from two or more kept snapshots (D-987): each card of `scope` takes its rows from one of `keeps`,
 * chosen at random per card, so a card's rows stay together and no value is a blend; then a Mutate at half the amount
 * moves some of them. A row whose module is not in every keep, and a locked row, keeps its value in `p` (the patch on
 * screen). `moved`: how many parameters differ from `p`.
 */
export function breedPatch(p: Patch, keeps: readonly Patch[], scope: MutateScope, amount: number, defs: Record<string, ModuleDef>, rnd: () => number = Math.random, opts: MutateOptions = {}): MutateResult {
  const bred = structuredClone(p);
  const byId = new Map(bred.modules.map((m) => [m.id, m]));
  const keepMods = keeps.map((k) => new Map(k.modules.map((m) => [m.id, m])));
  for (const card of scopeTargets(bred, scope, defs)) {
    if (!card.length) continue;
    const parent = keepMods[Math.min(keeps.length - 1, Math.floor(rnd() * keeps.length))];
    for (const t of card) for (const g of tiedTo(bred, t.module, t.param)) {
      const m = byId.get(g.module), pd = m && defs[m.type]?.params.find((q) => q.name === g.param);
      if (!m || !pd || MUTATE_SKIP[m.type] || pd.fixed || pd.screen || pd.onScreen || isLocked(bred, m, g.param)) continue;
      if (keepMods.some((k) => k.get(g.module)?.type !== m.type)) continue;
      m.params[g.param] = parent.get(g.module)!.params[g.param] ?? pd.default;
    }
  }
  const out = mutatePatch(bred, scope, 'mutate', amount / 2, defs, rnd, opts).patch;
  let moved = 0;
  for (const m of out.modules) {
    const was = p.modules.find((x) => x.id === m.id);
    for (const pd of defs[m.type]?.params ?? []) if ((m.params[pd.name] ?? pd.default) !== (was?.params[pd.name] ?? pd.default)) moved++;
  }
  return { patch: out, moved };
}
