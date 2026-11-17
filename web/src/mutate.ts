// SPDX-License-Identifier: GPL-3.0-only
// Mutate and Randomize (#944): new values for the parameters of the chosen cards, as a sound-design tool. Mutate moves each
// parameter by up to ± the amount of its range, Randomize anywhere in it. Both move in the space macro ranges and the
// morph move in (octaves for a logarithmic parameter, paramUnit), stay between a macro range's From and To, keep to the
// row's range (rowRange) and steps (stepToward), never reach a stretch past max, and leave alone what is locked, what the
// FM-1 sets when the patch loads, and the modules that play rather than sound (MUTATE_SKIP). A level row never ends above
// the larger of its value and its default, so a result is never suddenly loud. The editor applies the result as one undo
// step (Editor.mutate).
import { assembliesOf, tiedTo, type AssemblyInst, type RowTarget } from './assembly';
import { rowRange } from './modules';
import { paramUnit, paramValue, topOf, type ModuleDef, type ModuleInst, type ParamDef, type Patch } from './patch';
import { stepToward } from './value-input';

export type MutateMode = 'mutate' | 'randomize';

/** the amounts Mutate offers, a share of each parameter's range */
export const MUTATE_AMOUNTS = [0.05, 0.1, 0.25, 0.5] as const;
/** the amount until the user picks another (kept per browser by the host) */
export const MUTATE_DEFAULT = 0.1;

/** the modules that play, route or show rather than sound: Mutate and Randomize never move them (Main's tempo, the master
 * level, the voices and key range, a pattern's length and rate, the arpeggio, the drum notes, the chords, a Scope) */
export const MUTATE_SKIP: Record<string, true> = { fm1: true, output: true, alloc: true, steps: true, arp: true, drummap: true, harm: true, scope: true, part: true };

/** the level rows besides `level` itself: the Mixer's inputs, the VCA's gain, the Dynamics' make-up gain */
const LEVELS: Record<string, readonly string[]> = { mixer: ['l1', 'l2', 'l3', 'l4'], vca: ['gain'], dyn: ['gain'] };
/** a level row: Mutate and Randomize never raise it above the larger of its value and its default */
export const isLevel = (type: string, param: string): boolean => param === 'level' || !!LEVELS[type]?.includes(param);

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

export interface MutateResult {
  /** the patch with the new values (a copy; the input is left alone) */
  patch: Patch;
  /** how many parameters changed */
  moved: number;
}

/**
 * Mutate or randomize the parameters of `scope` in a copy of `p`. `amount`: Mutate's largest move, a share of the range
 * (Randomize ignores it); `rnd` gives 0..1. Parameters that card rows tie (#357) move as one, and stay put when any of them
 * is locked. A value outside min..max (a stretch) stays as it is.
 */
export function mutatePatch(p: Patch, scope: MutateScope, mode: MutateMode, amount: number, defs: Record<string, ModuleDef>, rnd: () => number = Math.random): MutateResult {
  const out = structuredClone(p);
  const byId = new Map(out.modules.map((m) => [m.id, m]));
  const pdOf = (t: RowTarget): ParamDef | undefined => {
    const m = byId.get(t.module);
    return m && defs[m.type]?.params.find((q) => q.name === t.param);
  };
  const key = (t: RowTarget): string => `${t.module}:${t.param}`;
  const targets: RowTarget[] = [
    ...scope.modules.flatMap((id) => {
      const m = byId.get(id);
      return m && defs[m.type] ? defs[m.type].params.map((pd) => ({ module: id, param: pd.name })) : [];
    }),
    ...scope.assemblies.flatMap((id) => assembliesOf(out).find((a) => a.id === id)?.params.map((r) => ({ module: r.module, param: r.param })) ?? []),
  ];
  const seen = new Set<string>();
  const set: RowTarget[] = [];
  for (const t of targets) {
    if (seen.has(key(t))) continue;
    const group = tiedTo(out, t.module, t.param);
    for (const g of group) seen.add(key(g));
    if (group.some((g) => {
      const m = byId.get(g.module), pd = pdOf(g);
      return !m || !pd || MUTATE_SKIP[m.type] || pd.fixed || pd.screen || pd.onScreen || isLocked(out, m, g.param);
    })) continue;
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
    const u = Math.min(hi, Math.max(lo, paramUnit(rd, from)));
    let v = paramValue(rd, mode === 'randomize' ? lo + rnd() * (hi - lo) : Math.min(hi, Math.max(lo, u + (rnd() * 2 - 1) * amount)));
    if (isLevel(m.type, pd.name)) v = Math.min(v, Math.max(from, pd.default));
    for (const g of group) {
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
    m.params[t.param] = stepToward(rd, from, Math.min(rd.max, Math.max(rd.min, m.params[t.param])), { hi: rd.max });
    if (m.params[t.param] !== from) moved++;
  }
  return { patch: out, moved };
}
