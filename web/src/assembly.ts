// SPDX-License-Identifier: GPL-3.0-only
// Assemblies: a group of prewired modules shown as one card with the ports and parameters it exposes.
//
// The patch stays flat. `Patch.assemblies` is an overlay: each entry names its member modules (ids in `patch.modules`),
// the inner ports it exposes and the inner parameters it promotes. Cables always run between inner ports, so the engine,
// the voice split, the binary format and the FM-1 never see assemblies; an editor that does not know the overlay loads
// the same patch and only loses the grouping. An assembly holds plain modules and, nested, other assemblies (`children`,
// to any depth), never the FM-1 panel or an Output. A container input may fan out to several inner inputs
// (`PortRef.also`: one "gate" jack for two envelopes). A saved assembly (`AssemblyDef`, one JSON file) is a small patch of
// its own: every module inside with local ids, the cables between them, the nested assemblies, the exposed ports and
// promoted parameters.
import {
  addModule,
  defaultParams,
  fixMatrix,
  fixCards,
  fixInputRoutes,
  fixTrack,
  removeModule,
  sameEnd,
  type Cable,
  type Endpoint,
  type ModuleDef,
  type ModuleInst,
  type Patch,
  type ParamDef,
  type PolyCards,
  rowDef,
  topOf,
} from './patch';
import { isPin } from './parameter-routing';
import { migrateParts, oscDrift, takeDrift } from './poly';
import { longName } from './labels';

export type Target = Endpoint;

export interface PortRef {
  module: number;
  port: string;
  label: string;
  /** further inner inputs this container input also feeds (merged ports; inputs only). A cable to the port goes to all of them. */
  also?: Target[];
}
export interface ParamRef {
  module: number;
  param: string;
  label: string;
  /** a new column of the collapsed card starts at this row (layout only, like the rest of the overlay) */
  col?: true;
  /** a heading above this row on the collapsed card */
  head?: string;
  /** a new group (one FM-1 page, pages.ts `groupStarts`) starts at this row, before the four of the last one are full:
   * a page break the user set (Arrange mode shows it with a ×) */
  group?: true;
  /** a group starts at this row because Arrange mode kept the pages around a move as they were (arrange.ts pinPages): a
   * start like `group`, but not one the user set, so it has no × */
  pin?: true;
  /** a display on this row reaches across this many columns of the collapsed card, its own and those to its right (2..;
   * see `spanPlan`; cut short where the card has fewer columns or another span is in the way) */
  span?: number;
  /** further parameters the row sets (#357, like `PortRef.also`): turning the row moves every one of them to the same
   * value, the card shows the first's. Each has the same range as the first (`sameRange`); a cable or a macro on the row
   * reaches all of them, and so do card presets, the morph and the FM-1's device page */
  also?: RowTarget[];
  /** names of a Selector's positions (#358), position 1 first: the row is a row of named choices on the card, on the
   * Selector's own card and on the FM-1. Only on a Selector's `pos` row; ROW_NAMES_MAX names of ROW_NAME_MAX characters */
  names?: string[];
  /** this row starts copies of the same controls, shown one at a time (`RowCopies`): layout only */
  copies?: RowCopies;
}

/**
 * Copies of the same controls that the original instrument edits one at a time (D-347 amended: the Casio CZ's eight
 * envelope steps, each a rate and a level, picked with a step select): the row that carries it and the rows after it,
 * `count` copies of `rows` rows each, in order. The collapsed card shows one copy, picked on a row of its own named
 * `name` ("step"), and the FM-1 starts each copy on a new page, so ALGO steps through them. Layout only, like a heading:
 * every row stays a row (presets, the morph, cables and the binary see them all). A run broken by a heading, a column
 * break or a missing row is shown as plain rows (`copyRuns`).
 */
export interface RowCopies { rows: number; count: number; name?: string }
/** the most rows a copy has (up to four FM-1 pages) and the most copies */
export const COPY_ROWS_MAX = 16;
export const COPIES_MAX = 16;

/** a parameter a card row sets */
export interface RowTarget { module: number; param: string }

/** the most position names a row keeps (a Selector's positions, modules.ts SELECT_N) and their longest (the FM-1's
 * NAME_MAX, pages.ts) */
export const ROW_NAMES_MAX = 8;
export const ROW_NAME_MAX = 12;

/** a row's parameters: the first, then the ones it also sets */
export const rowTargets = (r: ParamRef): RowTarget[] => [{ module: r.module, param: r.param }, ...(r.also ?? [])];
const sameTarget = (a: RowTarget, b: RowTarget): boolean => a.module === b.module && a.param === b.param;

/** two parameters one row can set together: the same range, step, curve, unit and choices (a value of one is a value of
 * the other, on the FM-1 too) */
export function sameRange(a: ParamDef, b: ParamDef): boolean {
  return a.min === b.min && a.max === b.max && topOf(a) === topOf(b) && (a.step ?? 0) === (b.step ?? 0) && !!a.log === !!b.log
    && !!a.bend === !!b.bend && !!a.toggle === !!b.toggle && (a.unit ?? '') === (b.unit ?? '')
    && (a.choices ?? []).join('\n') === (b.choices ?? []).join('\n') && !a.screen && !b.screen;
}

/** the extras of a promoted parameter from a file: the further targets and the position names, each only when well formed */
function rowExtras(r: Record<string, unknown>): Pick<ParamRef, 'also' | 'names'> {
  const out: Pick<ParamRef, 'also' | 'names'> = {};
  if (Array.isArray(r.also)) {
    const also = r.also.flatMap((t: unknown) => (isRec(t) && Number.isInteger(Number(t.module)) && typeof t.param === 'string' ? [{ module: Number(t.module), param: t.param }] : []));
    if (also.length) out.also = also;
  }
  const names = fixNames(r.names);
  if (names) out.names = names;
  return out;
}

/** position names as a row keeps them: trimmed, cut to ROW_NAME_MAX, at most ROW_NAMES_MAX, none empty at the end;
 * undefined when none is left */
export function fixNames(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const names = raw.slice(0, ROW_NAMES_MAX).map((x) => (typeof x === 'string' ? x.trim().slice(0, ROW_NAME_MAX).trim() : ''));
  while (names.length && !names[names.length - 1]) names.pop();
  return names.length ? names : undefined;
}

/** a heading with no rows on an assembly card (Arrange mode keeps it, arrange.ts): it sits before the section that the
 * row (module, param) opens, or with `after` after the last row of that row's column. The FM-1 has no page for it. */
export interface EmptyHead { head: string; module: number; param: string; after?: true }

/** the longest heading kept */
const HEAD_MAX = 40;

/** the widest span kept (a card has at most this many columns worth spanning) */
const SPAN_MAX = 16;

/** the layout fields of a promoted parameter from a file: a column break, a heading, a group start and a span, each only
 * when well formed */
function rowLayout(r: Record<string, unknown>): Pick<ParamRef, 'col' | 'head' | 'group' | 'pin' | 'span' | 'copies'> {
  const out: Pick<ParamRef, 'col' | 'head' | 'group' | 'pin' | 'span' | 'copies'> = {};
  const c = isRec(r.copies) ? r.copies : undefined;
  if (c && Number.isInteger(c.rows) && Number.isInteger(c.count)) {
    const rows = c.rows as number, count = c.count as number;
    const name = typeof c.name === 'string' ? c.name.trim().slice(0, ROW_NAME_MAX).trim() : '';
    if (rows >= 1 && rows <= COPY_ROWS_MAX && count >= 2 && count <= COPIES_MAX) out.copies = { rows, count, ...(name ? { name } : {}) };
  }
  if (r.col === true) out.col = true;
  if (r.group === true) out.group = true;
  else if (r.pin === true) out.pin = true;
  const head = typeof r.head === 'string' ? r.head.trim().slice(0, HEAD_MAX) : '';
  if (head) out.head = head;
  if (Number.isInteger(r.span) && (r.span as number) >= 2) out.span = Math.min(r.span as number, SPAN_MAX);
  return out;
}

/** a column break or group start on the first row means nothing: drop them */
function tidyRows(list: ParamRef[]): ParamRef[] {
  if (list[0]?.col || list[0]?.group || list[0]?.pin) {
    const { col: _, group: _g, pin: _p, ...rest } = list[0];
    list[0] = rest;
  }
  return list;
}

/**
 * The promoted parameters `keep` accepts. A column break, heading, group start or span belongs to its place in the list,
 * not to its row: a row that goes hands them to the next row that stays (whose own heading and span win, being nearer); with no row
 * after it they go too.
 */
export function keepParams(list: ParamRef[], keep: (r: ParamRef) => boolean): ParamRef[] {
  // a run of copies that loses a row is plain rows again (its copies would no longer line up)
  const broken = new Set<ParamRef>();
  list.forEach((r, i) => {
    if (r.copies && list.slice(i, i + r.copies.rows * r.copies.count).some((x) => !keep(x))) broken.add(r);
  });
  if (broken.size) list = list.map((r) => { if (!broken.has(r)) return r; const { copies: _, ...rest } = r; return rest; });
  const out: ParamRef[] = [];
  let col = false;
  let group = false;
  let pin = false;
  let head: string | undefined;
  let span: number | undefined;
  for (const r of list) {
    if (!keep(r)) {
      col ||= !!r.col;
      group ||= !!r.group;
      pin ||= !!r.pin;
      if (r.head) head = r.head;
      if (r.span) span = r.span;
      continue;
    }
    if (col || group || pin || head || span) {
      const n: ParamRef = { ...r };
      if (col) n.col = true;
      if (group) n.group = true;
      else if (pin && !n.group) n.pin = true;
      if (head && !n.head) n.head = head;
      if (span && !n.span) n.span = span;
      out.push(n);
      col = false;
      group = false;
      pin = false;
      head = undefined;
      span = undefined;
    } else out.push(r);
  }
  return tidyRows(out);
}

/** a parameter row of a member card, as pick mode selects it */
export interface PickRow { module: number; param: string }

/** pick mode's check box over some rows (a member card's header, #186): all of them on the card, none, or some */
export function pickState(a: AssemblyInst, rows: readonly PickRow[]): 'all' | 'none' | 'some' {
  const on = rows.filter((r) => isPromoted(a, r.module, r.param)).length;
  return on === 0 ? 'none' : on === rows.length ? 'all' : 'some';
}

/** one action on several rows in pick mode (#186): if any is off the card they all go on (the new ones in the given
 * order), if all are on they all come off. False when there are no rows */
export function pickRows(a: AssemblyInst, rows: readonly PickRow[], p?: Patch): boolean {
  if (!rows.length) return false;
  const off = rows.filter((r) => !isPromoted(a, r.module, r.param));
  if (off.length) for (const r of off) promote(a, r.module, r.param, p);
  else for (const r of rows) demote(a, r.module, r.param);
  return true;
}

/** a Shift-click range: the keys from `from` to `to` in `order`, either way round (only `to` when `from` is not there) */
export function keyRange(order: readonly string[], from: string | null, to: string): string[] {
  const j = order.indexOf(to);
  if (j < 0) return [];
  const i = from === null ? -1 : order.indexOf(from);
  if (i < 0) return [to];
  return order.slice(Math.min(i, j), Math.max(i, j) + 1);
}

/** start a new column of the collapsed card at row `i` (not the first), or join it to the column before */
export function setColumnBreak(list: ParamRef[], i: number, on: boolean): void {
  const r = list[i];
  if (!r) return;
  if (on && i > 0) r.col = true;
  else delete r.col;
}

/** the heading above row `i`; an empty text removes it */
export function setHeading(list: ParamRef[], i: number, text: string): void {
  const r = list[i];
  if (!r) return;
  const t = text.trim().slice(0, HEAD_MAX);
  if (t) r.head = t;
  else delete r.head;
}

/** how many columns the display on row `i` reaches across (1 or less = its own only) */
export function setSpan(list: ParamRef[], i: number, span: number): void {
  const r = list[i];
  if (!r) return;
  if (span >= 2) r.span = Math.min(Math.floor(span), SPAN_MAX);
  else delete r.span;
}

/** a stretch of a collapsed card's columns: one column's stack, or a group of columns a spanning row reaches across */
export type SpanBlock<T> =
  | { col: number; items: T[] }
  | { from: number; to: number; above: SpanBlock<T>[]; band: T; below: SpanBlock<T>[] };

/**
 * The columns of a collapsed card (`cols[k]` = the rows of column `from + k`, top down) cut into stretches by the rows
 * that span (`span(t)` columns: their own and those to the right). A span covers a group of columns: the stacks of the
 * group above the spanning row, the row across the group, the stacks below; columns outside run past untouched. In each
 * covered column as many rows go above as the spanning row has above it in its own column (so a covered column whose
 * rows are taller leaves its rest below, a shorter one leaves empty space). Spans may nest or sit side by side but never
 * partly overlap: they are taken in reading order (column by column, top down), and one that starts inside an earlier
 * span's group is cut short at the group's right edge; a span is also cut short at the card's right edge. Decided from
 * the rows alone, so the layout needs no measuring.
 */
export function spanPlan<T>(cols: T[][], span: (t: T) => number | undefined, from = 0): SpanBlock<T>[] {
  const to = from + cols.length;
  const groups: { c: number; e: number; i: number }[] = [];
  cols.forEach((list, k) => {
    const c = from + k;
    list.forEach((t, i) => {
      const s = Math.min(Math.floor(span(t) ?? 1), to - c);
      if (s < 2 || groups.some((g) => c >= g.c && c < g.e)) return;
      groups.push({ c, e: c + s, i });
    });
  });
  const out: SpanBlock<T>[] = [];
  for (let c = from; c < to;) {
    const g = groups.find((x) => x.c === c);
    if (!g) {
      if (cols[c - from].length) out.push({ col: c, items: cols[c - from] });
      c++;
      continue;
    }
    const own = cols[c - from], covered = cols.slice(c - from + 1, g.e - from), k = g.i;
    out.push({
      from: c, to: g.e, band: own[k],
      above: spanPlan([own.slice(0, k), ...covered.map((l) => l.slice(0, k))], span, c),
      below: spanPlan([own.slice(k + 1), ...covered.map((l) => l.slice(k))], span, c),
    });
    c = g.e;
  }
  return out;
}

/** the collapsed card's columns: the indices of the promoted parameters in each, split at the column breaks */
export function paramColumns(list: ParamRef[]): number[][] {
  const cols: number[][] = [[]];
  list.forEach((r, i) => {
    if (r.col && cols[cols.length - 1].length) cols.push([]);
    cols[cols.length - 1].push(i);
  });
  return cols;
}

/** move an exposed jack before or after another of the same side */
export function moveRef<T>(list: T[], from: number, to: number, after: boolean): T[] {
  if (from === to || list[from] === undefined || list[to] === undefined) return list;
  const moving = list[from];
  const rest = list.filter((_, i) => i !== from);
  const i = rest.indexOf(list[to]);
  rest.splice(after ? i + 1 : i, 0, moving);
  return rest;
}

export interface AssemblyLayout {
  /** Legacy collapsed-card size, retained for file compatibility but ignored by the editor. */
  size?: { width: number; height: number };
  /** User-sized expanded frame, in unscaled canvas pixels. */
  frameSize?: { width: number; height: number };
}

/** Accept bounded layout metadata; it never changes audio or firmware data. */
export function assemblyLayout(raw: AssemblyLayout): AssemblyLayout {
  const result: AssemblyLayout = {};
  for (const key of ['size', 'frameSize'] as const) {
    const value = raw[key];
    if (value && Number.isFinite(value.width) && Number.isFinite(value.height) && value.width > 0 && value.height > 0)
      result[key] = { width: Math.min(4000, Math.max(236, value.width)), height: Math.min(4000, Math.max(80, value.height)) };
  }
  return result;
}

/** an assembly in a patch: the overlay entry */
export interface AssemblyInst extends AssemblyLayout {
  v: 1;
  id: number;
  /** the library name it was made from or saved as */
  name: string;
  /** this instance's label on the canvas ("operator 2") */
  label: string;
  /** the collapsed card's position */
  x: number;
  y: number;
  /** open: the member cards are shown inside a frame; collapsed: one card with the exposed ports */
  open: boolean;
  /** the direct member modules */
  modules: number[];
  /** nested assemblies (ids in `patch.assemblies`); their modules are members too */
  children?: number[];
  inputs: PortRef[];
  outputs: PortRef[];
  params: ParamRef[];
  /** headings with no rows (Arrange mode, arrange.ts) */
  heads?: EmptyHead[];
  /** the group switch is off: every member module is bypassed (editor only, like the rest of the overlay) */
  bypass?: boolean;
  /** with `bypass`: the members that were bypassed on their own before the group went off; they stay off when it comes back */
  kept?: number[];
  /** a poly assembly, a rack of voice cards: its members run once per voice of the allocator that feeds it (poly.ts).
   * Unlike the rest of the overlay, the engine reads this. */
  poly?: PolyCards;
  /** the preset it was last set to (#192, device-presets.ts): shown by name, for display only (the patch plays its values) */
  preset?: string;
}

/** a nested assembly inside a saved definition: local module ids and local assembly ids, positions relative like the modules */
export interface NestedDef extends AssemblyLayout {
  id: number;
  name: string;
  label: string;
  x: number;
  y: number;
  open: boolean;
  modules: number[];
  children?: number[];
  inputs: PortRef[];
  outputs: PortRef[];
  params: ParamRef[];
  heads?: EmptyHead[];
  poly?: PolyCards;
}

/** a saved assembly: the file format, the library entry and the factory set. Module ids are local (1..n), positions relative. */
export interface AssemblyDef extends AssemblyLayout {
  format: 'matryoshka-assembly';
  version: 1;
  name: string;
  /** a factory assembly's shelf in the browser (CATEGORIES in assemblies.ts); the user's own have none */
  category?: string;
  /** a factory engine's one-line description (scripts/gen-assemblies.ts BLURBS): the engine tiles, the assembly browser,
   *  the palette and the patch card show it in place of the module list; the user's own have none */
  blurb?: string;
  /** saved by the tutorial under this tag ("my-voice"); later chapters find it by the tag whatever its name */
  tutorial?: string;
  /** every module inside, the nested ones included */
  modules: ModuleInst[];
  cables: Cable[];
  inputs: PortRef[];
  outputs: PortRef[];
  params: ParamRef[];
  heads?: EmptyHead[];
  /** the top level's direct children (ids in `assemblies`); modules not claimed by a nested assembly are its direct members */
  children?: number[];
  assemblies?: NestedDef[];
  /** the top level is a poly assembly */
  poly?: PolyCards;
}

export const ASSEMBLY_FORMAT = 'matryoshka-assembly';
/** the format files had under the upstream name (modular-1): still read, saved as ASSEMBLY_FORMAT */
export const LEGACY_ASSEMBLY_FORMAT = 'modular-1-assembly';
/** module types that cannot be members: the one panel and the output are the patch's own */
export const EXCLUDED_TYPES = new Set(['fm1', 'output']);
/** how deep assemblies nest (a top-level assembly is level 1): no limit the user meets (the FM-1 never sees assemblies);
 * only a guard for the walks up the tree */
export const MAX_DEPTH = 64;
const KNOBS = ['k1', 'k2', 'k3', 'k4'] as const;

export const assembliesOf = (p: Patch): AssemblyInst[] => p.assemblies ?? [];
export const assemblyById = (p: Patch, id: number): AssemblyInst | undefined => assembliesOf(p).find((a) => a.id === id);

/** the assembly a module is a direct member of */
export function assemblyOf(p: Patch, moduleId: number): AssemblyInst | undefined {
  return assembliesOf(p).find((a) => a.modules.includes(moduleId));
}

/** the assembly an assembly is nested in */
export function parentOf(p: Patch, asmId: number): AssemblyInst | undefined {
  return assembliesOf(p).find((a) => a.children?.includes(asmId));
}

export const childrenOf = (p: Patch, a: AssemblyInst): AssemblyInst[] => (a.children ?? []).map((id) => assemblyById(p, id)).filter((x): x is AssemblyInst => !!x);

/** every assembly nested in `a`, parents before their children */
export function descendants(p: Patch, a: AssemblyInst): AssemblyInst[] {
  const out: AssemblyInst[] = [];
  const seen = new Set<number>([a.id]);
  const walk = (x: AssemblyInst): void => {
    for (const c of childrenOf(p, x)) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      out.push(c);
      walk(c);
    }
  };
  walk(a);
  return out;
}

/** the modules of an assembly, the nested ones included */
export function allModules(p: Patch, a: AssemblyInst): number[] {
  const ids = [...a.modules];
  for (const d of descendants(p, a)) ids.push(...d.modules);
  return ids;
}

/**
 * The group switch: off bypasses every member (nested ones too) and remembers which were already off; on restores exactly
 * that, so a member you switched off yourself stays off. Returns the ids of the modules whose flag changed.
 */
export function bypassAssembly(p: Patch, a: AssemblyInst, off: boolean): number[] {
  const changed: number[] = [];
  const members = allModules(p, a);
  const mods = members.map((id) => p.modules.find((m) => m.id === id)!);
  if (off) {
    a.kept = mods.filter((m) => m.bypass).map((m) => m.id);
    for (const m of mods) if (!m.bypass) {
      m.bypass = true;
      changed.push(m.id);
    }
    a.bypass = true;
    for (const d of descendants(p, a)) if (d.bypass) delete d.kept; // a nested group's own switch is superseded: it comes back with this one
  } else {
    const keep = new Set(a.kept ?? []);
    for (const m of mods) if (m.bypass && !keep.has(m.id)) {
      delete m.bypass;
      changed.push(m.id);
    }
    delete a.bypass;
    delete a.kept;
    for (const d of descendants(p, a)) {
      delete d.bypass;
      delete d.kept;
    }
  }
  return changed;
}

/** 1 for a top-level assembly, 2 inside one, ... */
export function depthOf(p: Patch, a: AssemblyInst): number {
  let d = 1;
  for (let x = parentOf(p, a.id); x && d <= MAX_DEPTH + 1; x = parentOf(p, x.id)) d++;
  return d;
}

/** the levels an assembly spans: 1 without children */
export function heightOf(p: Patch, a: AssemblyInst): number {
  return 1 + Math.max(0, ...childrenOf(p, a).map((c) => heightOf(p, c)));
}

/** the ids of modules inside collapsed assemblies (nested ones included): not drawn as cards */
export function hiddenModules(p: Patch): Set<number> {
  const h = new Set<number>();
  for (const a of assembliesOf(p)) if (!a.open) for (const id of allModules(p, a)) h.add(id);
  return h;
}

/** the ids of assemblies nested in a collapsed one: neither their card nor their frame is drawn */
export function hiddenAssemblies(p: Patch): Set<number> {
  const h = new Set<number>();
  for (const a of assembliesOf(p)) if (!a.open) for (const d of descendants(p, a)) h.add(d.id);
  return h;
}

/** the inner inputs a container input feeds: its primary and the merged ones */
export const targetsOf = (r: PortRef): Target[] => [{ module: r.module, port: r.port }, ...(r.also ?? [])];

/** the exposed port that carries this inner port (as its primary or merged into it) */
export function findRef(a: AssemblyInst, dir: 'in' | 'out', module: number, port: string): PortRef | undefined {
  return (dir === 'in' ? a.inputs : a.outputs).find((r) => targetsOf(r).some((t) => t.module === module && t.port === port));
}

export function isExposed(a: AssemblyInst, dir: 'in' | 'out', module: number, port: string): boolean {
  return !!findRef(a, dir, module, port);
}

/** whether the card has a row that sets this parameter (as its first or one it also sets, #357) */
export function isPromoted(a: AssemblyInst, module: number, param: string): boolean {
  return !!rowOf(a, module, param);
}

/** the card row that sets this parameter (as its first or one it also sets) */
export function rowOf(a: AssemblyInst, module: number, param: string): ParamRef | undefined {
  return a.params.find((r) => (r.module === module && r.param === param) || !!r.also?.some((t) => t.module === module && t.param === param));
}

/** the cables that cross the assembly's boundary */
export function outsideCables(p: Patch, a: AssemblyInst): Cable[] {
  const m = new Set(allModules(p, a));
  return p.cables.filter((c) => m.has(c.from.module) !== m.has(c.to.module));
}

function uniqueLabel(taken: Iterable<string>, want: string): string {
  const set = new Set(taken);
  if (!set.has(want)) return want;
  for (let n = 2; ; n++) if (!set.has(`${want} ${n}`)) return `${want} ${n}`;
}

/**
 * Exposed pins become promoted parameters. The editor has no p1 / p2 jacks, so an assembly offers modulation through the
 * sliders of the parameters a pin routes to (a cable to such a slider goes to the inner pin). A pin routed nowhere stays
 * an exposed input, so its cable can still be seen. Returns the inputs left; the promotions are added to `params`.
 */
export function pinsToParams(inputs: PortRef[], params: ParamRef[], moduleOf: (id: number) => ModuleInst | undefined): PortRef[] {
  const out: PortRef[] = [];
  for (const r of inputs) {
    const keep: Target[] = [];
    for (const t of targetsOf(r)) {
      const m = moduleOf(t.module);
      const routed = isPin(t.port) && m?.map?.[t.port]?.length ? m.map[t.port] : null;
      if (!routed || !m) {
        keep.push(t);
        continue;
      }
      for (const param of routed) promoteOnce(params, m, param);
    }
    if (!keep.length) continue;
    const next: PortRef = { module: keep[0].module, port: keep[0].port, label: r.label };
    if (keep.length > 1) next.also = keep.slice(1);
    out.push(next);
  }
  return out;
}

const promoteOnce = (params: ParamRef[], m: ModuleInst, param: string, label?: string): void => {
  if (!params.some((q) => rowTargets(q).some((t) => t.module === m.id && t.param === param))) params.push({ module: m.id, param, label: label ?? longName(m.type, param) });
};

/** the inner ports with a cable to or from outside: the ports an assembly must expose */
export function boundary(p: Patch, members: Iterable<number>): { inputs: Target[]; outputs: Target[] } {
  const m = new Set(members);
  const inputs: Target[] = [];
  const outputs: Target[] = [];
  for (const c of p.cables) {
    if (m.has(c.to.module) && !m.has(c.from.module) && !inputs.some((r) => sameEnd(r, c.to))) inputs.push({ module: c.to.module, port: c.to.port });
    if (m.has(c.from.module) && !m.has(c.to.module) && !outputs.some((r) => sameEnd(r, c.from))) outputs.push({ module: c.from.module, port: c.from.port });
  }
  return { inputs, outputs };
}

/** why a module cannot join an assembly, or null */
export function memberProblem(p: Patch, moduleId: number, a?: AssemblyInst): string | null {
  const m = p.modules.find((x) => x.id === moduleId);
  if (!m) return `no module ${moduleId}`;
  if (EXCLUDED_TYPES.has(m.type)) return 'the Main panel and the Output cannot be part of an assembly';
  const other = assemblyOf(p, moduleId);
  if (other && other !== a) return `${describe(p, m)} is already in "${other.label}"`;
  return null;
}

/** why an assembly cannot be nested in `parent`, or null */
export function childProblem(p: Patch, parent: AssemblyInst, childId: number): string | null {
  const c = assemblyById(p, childId);
  if (!c) return `no assembly ${childId}`;
  if (c.id === parent.id) return `"${c.label}" cannot contain itself`;
  if (descendants(p, c).some((d) => d.id === parent.id)) return `"${parent.label}" is already inside "${c.label}"`;
  const other = parentOf(p, c.id);
  if (other && other.id !== parent.id) return `"${c.label}" is already in "${other.label}"`;
  if (depthOf(p, parent) + heightOf(p, c) > MAX_DEPTH) return `assemblies nest at most ${MAX_DEPTH} deep`;
  if (polyAt(p, parent) && (c.poly || descendants(p, c).some((d) => d.poly))) return 'poly assemblies do not nest in each other';
  return null;
}

/** is `a` or an assembly above it a poly assembly */
function polyAt(p: Patch, a: AssemblyInst): AssemblyInst | undefined {
  for (let x: AssemblyInst | undefined = a; x; x = parentOf(p, x.id)) if (x.poly) return x;
  return undefined;
}

function describe(p: Patch, m: ModuleInst): string {
  const same = p.modules.filter((x) => x.type === m.type);
  return same.length > 1 ? `${m.type} ${same.indexOf(m) + 1}` : m.type;
}

/** is this inner port on a direct member, or exposed by the child that holds it (what a parent may show) */
function reachable(p: Patch, a: AssemblyInst, dir: 'in' | 'out', module: number, port: string): boolean {
  if (a.modules.includes(module)) return true;
  const c = childrenOf(p, a).find((x) => allModules(p, x).includes(module));
  return !!c && isExposed(c, dir, module, port);
}

function reachableParam(p: Patch, a: AssemblyInst, module: number, param: string): boolean {
  if (a.modules.includes(module)) return true;
  const c = childrenOf(p, a).find((x) => allModules(p, x).includes(module));
  return !!c && isPromoted(c, module, param);
}

/**
 * The card's rows with their further targets checked (#357): a target that is gone, not reachable, set from a screen, a
 * Voice allocator's, another row's or of another range than the row's first goes; a row whose first is gone is led by
 * the next target that stays. Position names stay on a Selector's `pos` row only (#358). The rows themselves are checked
 * by the caller.
 */
function cleanRows(p: Patch, a: AssemblyInst, member: Set<number>, defs?: Record<string, ModuleDef>): ParamRef[] {
  if (!a.params.some((r) => r.also || r.names)) return a.params;
  const typeOf = (id: number): string | undefined => p.modules.find((m) => m.id === id)?.type;
  const pdOf = (t: RowTarget): ParamDef | undefined => { const ty = typeOf(t.module); return ty && defs?.[ty] ? rowDef(defs[ty], t.param) : undefined; };
  const ok = (t: RowTarget): boolean => member.has(t.module) && (!defs || (!!pdOf(t) && !pdOf(t)!.onScreen && typeOf(t.module) !== 'alloc')) && reachableParam(p, a, t.module, t.param);
  const firsts = new Set(a.params.map((r) => `${r.module}:${r.param}`));
  const seen = new Set<string>();
  return a.params.map((r) => {
    if (!r.also && !r.names) return r;
    const n: ParamRef = { ...r };
    if (r.also) {
      const ts = rowTargets(r).filter((t, i) => {
        const k = `${t.module}:${t.param}`;
        if (!ok(t) || seen.has(k) || (i > 0 && firsts.has(k))) return false;
        seen.add(k);
        return true;
      });
      const lead = ts[0] ?? { module: r.module, param: r.param };
      const same = (t: RowTarget): boolean => !defs || sameRange(pdOf(lead)!, pdOf(t)!);
      const also = ts.slice(1).filter(same);
      n.module = lead.module;
      n.param = lead.param;
      if (also.length) n.also = also;
      else delete n.also;
    }
    if (r.names && defs && !(typeOf(n.module) === 'select' && n.param === 'pos')) delete n.names;
    return n;
  });
}

/**
 * Keep an assembly consistent with the patch: members that are gone leave, exposures and promotions of departed modules
 * go, a parent only shows what its children expose, and every inner port with an outside cable is exposed (labels of
 * ports that stay are kept). Children must be reconciled first (reconcileAll does). Returns false when nothing is left.
 */
export function reconcile(p: Patch, a: AssemblyInst, defs?: Record<string, ModuleDef>): boolean {
  const ids = new Set(p.modules.map((m) => m.id));
  a.modules = a.modules.filter((id) => ids.has(id));
  if (a.children) {
    a.children = a.children.filter((id) => id !== a.id && assemblyById(p, id));
    if (!a.children.length) delete a.children;
  }
  const members = allModules(p, a);
  if (!members.length) return false;
  const member = new Set(members);
  if (a.kept) {
    a.kept = a.kept.filter((id) => member.has(id));
    if (!a.bypass) delete a.kept;
  }
  const typeOf = (id: number): string => p.modules.find((m) => m.id === id)!.type;
  // an allocator inside feeds an input inside: the note comes from within, so the jack on the card is dead (an outside
  // cable into the same input still crosses the frame and exposes it again below)
  const fedByPart = (t: Target): boolean =>
    p.cables.some((c) => sameEnd(c.to, t) && member.has(c.from.module) && typeOf(c.from.module) === 'alloc');
  const portOk = (dir: 'in' | 'out', t: Target): boolean => {
    if (!member.has(t.module) || (dir === 'in' && fedByPart(t))) return false;
    const def = defs?.[typeOf(t.module)];
    if (def && !(dir === 'in' ? def.inputs : def.outputs).some((q) => q.name === t.port)) return false;
    return reachable(p, a, dir, t.module, t.port);
  };
  const clean = (dir: 'in' | 'out', list: PortRef[]): PortRef[] => {
    const out: PortRef[] = [];
    const seen = new Set<string>();
    for (const r of list) {
      const ts = targetsOf(r).filter((t) => {
        const k = `${t.module}:${t.port}`;
        if (seen.has(k) || !portOk(dir, t)) return false;
        seen.add(k);
        return true;
      });
      if (!ts.length) continue;
      const next: PortRef = { module: ts[0].module, port: ts[0].port, label: r.label };
      if (dir === 'in' && ts.length > 1) next.also = ts.slice(1);
      out.push(next);
    }
    return out;
  };
  const moduleOf = (id: number): ModuleInst | undefined => p.modules.find((m) => m.id === id);
  a.inputs = clean('in', pinsToParams(a.inputs, a.params, moduleOf));
  a.outputs = clean('out', a.outputs);
  a.params = keepParams(cleanRows(p, a, member, defs), (r) => member.has(r.module) && (!defs || !rowDef(defs[typeOf(r.module)], r.param)?.onScreen && !!rowDef(defs[typeOf(r.module)], r.param)) && reachableParam(p, a, r.module, r.param));
  const b = boundary(p, members);
  for (const r of b.inputs) {
    // an outside cable into a routed pin shows on the sliders it feeds: promote those instead of exposing the pin
    const m = moduleOf(r.module);
    const routed = isPin(r.port) && m?.map?.[r.port]?.length ? m.map[r.port] : null;
    if (routed && m) for (const param of routed) {
      if (reachableParam(p, a, m.id, param)) promoteOnce(a.params, m, param, childLabel(p, a, 'param', m.id, param));
    }
    else if (!isExposed(a, 'in', r.module, r.port)) a.inputs.push({ ...r, label: uniqueLabel(a.inputs.map((x) => x.label), childLabel(p, a, 'in', r.module, r.port) ?? r.port) });
  }
  for (const r of b.outputs) if (!isExposed(a, 'out', r.module, r.port)) a.outputs.push({ ...r, label: uniqueLabel(a.outputs.map((x) => x.label), childLabel(p, a, 'out', r.module, r.port) ?? r.port) });
  return true;
}

/** reconcile every assembly, children before parents; empty ones are dropped. Returns the labels of the dropped ones. */
export function reconcileAll(p: Patch, defs?: Record<string, ModuleDef>): string[] {
  if (!p.assemblies) return [];
  const dropped: string[] = [];
  for (let pass = 0; pass < 8; pass++) {
    const list = [...assembliesOf(p)].sort((u, v) => depthOf(p, v) - depthOf(p, u));
    let changed = false;
    for (const a of list) {
      if (reconcile(p, a, defs)) continue;
      dropped.push(a.label);
      detach(p, a.id);
      p.assemblies = assembliesOf(p).filter((x) => x.id !== a.id);
      changed = true;
    }
    if (!changed) break;
  }
  if (!p.assemblies?.length) delete p.assemblies;
  return dropped;
}

/** take an assembly out of its parent's children (it becomes top level) */
function detach(p: Patch, asmId: number): void {
  const parent = parentOf(p, asmId);
  if (!parent) return;
  parent.children = parent.children!.filter((id) => id !== asmId);
  if (!parent.children.length) delete parent.children;
}

const nextAssemblyId = (p: Patch): number => assembliesOf(p).reduce((m, a) => Math.max(m, a.id), 0) + 1;
const instanceLabel = (p: Patch, name: string): string => uniqueLabel(assembliesOf(p).map((a) => a.label), name);

/**
 * Group the given modules and assemblies (`childIds`, which become its children) into a new, collapsed assembly: the
 * ports with outside cables are exposed. One may hold assemblies only. Modules that are all direct members of one
 * assembly form a child of it (nesting); assemblies only, a child of their parent.
 */
export function makeAssembly(p: Patch, memberIds: number[], name = 'assembly', childIds: number[] = []): AssemblyInst {
  const ids = [...new Set(memberIds)];
  const kids = [...new Set(childIds)];
  if (!ids.length && !kids.length) throw new Error('select the modules first (shift-click, or drag a box on the canvas)');
  const parent = ids.length ? assemblyOf(p, ids[0]) : parentOf(p, kids[0]);
  for (const id of ids) {
    const why = memberProblem(p, id, parent);
    if (why) throw new Error(why);
    if (parent && !parent.modules.includes(id)) throw new Error(`${describe(p, p.modules.find((m) => m.id === ids[0])!)} is already in "${parent.label}": to nest, select modules inside it only`);
  }
  if (parent && depthOf(p, parent) + 1 > MAX_DEPTH) throw new Error(`assemblies nest at most ${MAX_DEPTH} deep`);
  const at = [...ids.map((id) => p.modules.find((m) => m.id === id)!), ...kids.map((id) => assemblyById(p, id) ?? { x: Infinity, y: Infinity })];
  const a: AssemblyInst = {
    v: 1,
    id: nextAssemblyId(p),
    name,
    label: instanceLabel(p, name),
    x: Math.min(...at.map((m) => m.x)),
    y: Math.min(...at.map((m) => m.y)),
    open: false,
    modules: ids,
    inputs: [],
    outputs: [],
    params: [],
  };
  p.assemblies = [...assembliesOf(p), a];
  if (parent) {
    parent.modules = parent.modules.filter((id) => !ids.includes(id));
    parent.children = [...(parent.children ?? []), a.id];
  }
  for (const id of kids) addChild(p, a, id);
  reconcile(p, a);
  if (parent) reconcile(p, parent);
  return a;
}

/** dissolve one level: the direct members and children stay, as plain modules / assemblies (or as members of the parent) */
export function ungroup(p: Patch, id: number): void {
  const a = assemblyById(p, id);
  if (!a) return;
  const parent = parentOf(p, id);
  if (parent) {
    parent.modules.push(...a.modules);
    if (a.children) parent.children = [...(parent.children ?? []), ...a.children];
    detach(p, id);
  }
  p.assemblies = assembliesOf(p).filter((x) => x.id !== id);
  if (!p.assemblies.length) delete p.assemblies;
  if (parent) reconcile(p, parent);
}

/** delete the assembly with its direct modules and their cables; nested assemblies survive (one level up) */
export function deleteAssembly(p: Patch, id: number): void {
  const a = assemblyById(p, id);
  if (!a) return;
  for (const m of a.modules) removeModule(p, m);
  ungroup(p, id);
}

/** ports that were exposed only for cables to or from the newcomers become inner wiring again */
function retract(p: Patch, a: AssemblyInst, newIds: number[]): void {
  const mine = new Set(allModules(p, a));
  const inner = (m: number): boolean => mine.has(m) || newIds.includes(m);
  const fed = (t: Target): boolean => p.cables.some((c) => sameEnd(c.to, t) && newIds.includes(c.from.module)) && !p.cables.some((c) => sameEnd(c.to, t) && !inner(c.from.module));
  a.inputs = a.inputs.flatMap((r) => {
    const ts = targetsOf(r).filter((t) => !fed(t));
    if (!ts.length) return [];
    const next: PortRef = { module: ts[0].module, port: ts[0].port, label: r.label };
    if (ts.length > 1) next.also = ts.slice(1);
    return [next];
  });
  a.outputs = a.outputs.filter((r) => !(p.cables.some((c) => sameEnd(c.from, r) && newIds.includes(c.to.module)) && !p.cables.some((c) => sameEnd(c.from, r) && !inner(c.to.module))));
}

/** a module joins */
export function addMember(p: Patch, a: AssemblyInst, moduleId: number): void {
  const why = memberProblem(p, moduleId, a);
  if (why) throw new Error(why);
  if (a.modules.includes(moduleId)) return;
  retract(p, a, [moduleId]);
  a.modules.push(moduleId);
  reconcile(p, a);
}

export function removeMember(p: Patch, a: AssemblyInst, moduleId: number): void {
  a.modules = a.modules.filter((id) => id !== moduleId);
  if (reconcile(p, a)) return;
  ungroup(p, a.id);
}

/** an assembly joins as a nested one (moving out of its previous parent, if any) */
export function addChild(p: Patch, parent: AssemblyInst, childId: number): void {
  if (parent.children?.includes(childId)) return;
  const prev = parentOf(p, childId);
  detach(p, childId);
  const why = childProblem(p, parent, childId);
  if (why) {
    if (prev) prev.children = [...(prev.children ?? []), childId];
    throw new Error(why);
  }
  const c = assemblyById(p, childId)!;
  retract(p, parent, allModules(p, c));
  parent.children = [...(parent.children ?? []), childId];
  reconcile(p, parent);
}

export function removeChild(p: Patch, parent: AssemblyInst, childId: number): void {
  if (!parent.children?.includes(childId)) return;
  detach(p, childId);
  if (reconcile(p, parent)) return;
  ungroup(p, parent.id);
}

/** the label a nested assembly gives an inner row or jack it shows, which a parent showing it too takes over */
function childLabel(p: Patch | undefined, a: AssemblyInst, kind: 'param' | 'in' | 'out', module: number, name: string): string | undefined {
  if (!p || a.modules.includes(module)) return undefined;
  const c = childrenOf(p, a).find((x) => allModules(p, x).includes(module));
  if (!c) return undefined;
  return kind === 'param' ? c.params.find((r) => r.module === module && r.param === name)?.label : findRef(c, kind, module, name)?.label;
}

/** show an inner port on the card; `also` merges further inner inputs into the same jack. With the patch, a port a nested
 * assembly shows keeps that assembly's label */
export function exposePort(a: AssemblyInst, dir: 'in' | 'out', module: number, port: string, also?: Target[], p?: Patch): void {
  if (isExposed(a, dir, module, port)) return;
  const list = dir === 'in' ? a.inputs : a.outputs;
  const r: PortRef = { module, port, label: uniqueLabel(list.map((x) => x.label), childLabel(p, a, dir, module, port) ?? port) };
  const extra = dir === 'in' ? (also ?? []).filter((t) => !isExposed(a, 'in', t.module, t.port) && !(t.module === module && t.port === port)) : [];
  if (extra.length) r.also = extra;
  list.push(r);
}

/** hide an exposed port (a merged one as a whole); refused while an outside cable uses any of its inner ports */
export function hidePort(p: Patch, a: AssemblyInst, dir: 'in' | 'out', module: number, port: string): void {
  const ref = findRef(a, dir, module, port);
  if (!ref) return;
  const ts = targetsOf(ref);
  const wired = outsideCables(p, a).some((c) => ts.some((t) => (dir === 'in' ? sameEnd(c.to, t) : sameEnd(c.from, t))));
  if (wired) throw new Error(`${ref.label} still has a cable from outside: remove it first`);
  if (dir === 'in') a.inputs = a.inputs.filter((r) => r !== ref);
  else a.outputs = a.outputs.filter((r) => r !== ref);
}

/** merge the container input that carries `from` into the one that carries `into`: one jack feeding both (and whatever each already fed) */
export function mergePorts(p: Patch, a: AssemblyInst, defs: Record<string, ModuleDef>, into: Target, from: Target): void {
  const r1 = findRef(a, 'in', into.module, into.port);
  const r2 = findRef(a, 'in', from.module, from.port);
  if (!r1 || !r2) throw new Error('both ports must be exposed');
  if (r1 === r2) return;
  const kind = (t: Target): string => defs[p.modules.find((m) => m.id === t.module)!.type].inputs.find((q) => q.name === t.port)!.kind;
  if (kind(into) !== kind(from)) throw new Error(`cannot merge a ${kind(from)} port into a ${kind(into)} port`);
  r1.also = [...(r1.also ?? []), ...targetsOf(r2)];
  a.inputs = a.inputs.filter((r) => r !== r2);
}

/** split a merged port: every inner input it fed gets its own jack again */
export function unmergePort(a: AssemblyInst, module: number, port: string): void {
  const ref = findRef(a, 'in', module, port);
  if (!ref?.also?.length) return;
  const at = a.inputs.indexOf(ref);
  const extra: PortRef[] = ref.also.map((t) => ({ ...t, label: '' }));
  delete ref.also;
  const list = [...a.inputs.slice(0, at + 1), ...extra, ...a.inputs.slice(at + 1)];
  for (const r of extra) r.label = uniqueLabel(list.filter((x) => x.label).map((x) => x.label), r.port);
  a.inputs = list;
}

/** the heading each row of a card sits under: its own, else the last one above it (undefined before the first) */
function headings(params: readonly ParamRef[]): (string | undefined)[] {
  let h: string | undefined;
  return params.map((r) => (h = r.head ?? h));
}

/**
 * Put a parameter on the card. With the patch, a row a nested assembly shows comes over named as it is there: the
 * heading is that assembly's label and the page it sits on ("Lire 5-8", or just "Lire" above its first heading), the
 * label stays its own ("hold"). It joins the rows already under that heading, else starts a block of its own at the end.
 * Names are copied once; a row from a direct member takes the parameter's name.
 */
export function promote(a: AssemblyInst, module: number, param: string, p?: Patch): void {
  if (isPromoted(a, module, param)) return;
  const c = p && !a.modules.includes(module) ? childrenOf(p, a).find((x) => allModules(p, x).includes(module)) : undefined;
  if (!c) {
    a.params.push({ module, param, label: uniqueLabel(a.params.map((r) => r.label), param) });
    return;
  }
  const at = c.params.findIndex((r) => r.module === module && r.param === param);
  const page = at < 0 ? undefined : headings(c.params)[at];
  const head = (page ? `${c.label} ${page}` : c.label).slice(0, HEAD_MAX);
  const heads = headings(a.params);
  const last = heads.lastIndexOf(head);
  const block = a.params.filter((_, i) => heads[i] === head).map((r) => r.label);
  const r: ParamRef = { module, param, label: uniqueLabel(block, at < 0 ? param : c.params[at].label) };
  if (last < 0) a.params.push({ ...r, head });
  else a.params.splice(last + 1, 0, r);
}

/** take a parameter off the card: its row goes; one a row also sets leaves that row, and a row's first that also sets
 * others hands the row to the next (#357) */
export function demote(a: AssemblyInst, module: number, param: string): void {
  const r = rowOf(a, module, param);
  if (!r) return;
  const me = { module, param };
  if (!sameTarget(r, me)) {
    r.also = r.also!.filter((t) => !sameTarget(t, me));
    if (!r.also.length) delete r.also;
    return;
  }
  if (r.also?.length) {
    const [next, ...rest] = r.also;
    r.module = next.module;
    r.param = next.param;
    if (rest.length) r.also = rest;
    else delete r.also;
    return;
  }
  a.params = keepParams(a.params, (x) => x !== r);
}

/** let the card row that sets `into` set `from` too, with whatever `from`'s row set (#357): one row for both. Throws when
 * a parameter is not on the card or the ranges differ (sameRange) */
export function mergeRows(p: Patch, a: AssemblyInst, defs: Record<string, ModuleDef>, into: RowTarget, from: RowTarget): void {
  const r1 = rowOf(a, into.module, into.param);
  const r2 = rowOf(a, from.module, from.param);
  if (!r1 || !r2) throw new Error('both parameters must be on the card');
  if (r1 === r2) return;
  const pd = (t: RowTarget): ParamDef | undefined => { const m = p.modules.find((x) => x.id === t.module); return m && rowDef(defs[m.type], t.param); };
  const lead = pd(r1)!;
  for (const t of rowTargets(r2)) {
    const m = p.modules.find((x) => x.id === t.module)!;
    if (m.type === 'alloc' || !sameRange(lead, pd(t)!)) throw new Error(`"${r2.label}" cannot join "${r1.label}": their ranges differ`);
  }
  r1.also = [...(r1.also ?? []), ...rowTargets(r2)];
  if (!r1.names && r2.names) r1.names = [...r2.names];
  a.params = keepParams(a.params, (x) => x !== r2);
}

/** split a row that sets several parameters: each one it also set gets its own row again, right after it */
export function splitRow(a: AssemblyInst, module: number, param: string): void {
  const r = a.params.find((x) => x.module === module && x.param === param);
  if (!r?.also?.length) return;
  const at = a.params.indexOf(r);
  const extra: ParamRef[] = r.also.map((t) => ({ ...t, label: '' }));
  delete r.also;
  const list = [...a.params.slice(0, at + 1), ...extra, ...a.params.slice(at + 1)];
  for (const x of extra) x.label = uniqueLabel(list.filter((y) => y.label).map((y) => y.label), x.param);
  a.params = list;
}

/** the runs of copies on a card (`RowCopies`) that hold together: `count` copies of `rows` rows from row `at`, with no
 * heading, column break or other run inside, all on the card */
export function copyRuns(list: readonly ParamRef[]): { at: number; rows: number; count: number; name: string }[] {
  const out: { at: number; rows: number; count: number; name: string }[] = [];
  for (let i = 0; i < list.length; i++) {
    const c = list[i].copies;
    if (!c) continue;
    const end = i + c.rows * c.count;
    if (end > list.length || list.slice(i + 1, end).some((r) => r.head || r.col || r.copies)) continue;
    out.push({ at: i, rows: c.rows, count: c.count, name: c.name ?? 'step' });
    i = end - 1;
  }
  return out;
}

/** where a run of copies makes an FM-1 page start (each copy, and the row after the run): true at those rows */
export function copyStarts(list: readonly ParamRef[]): boolean[] {
  const out = list.map(() => false);
  for (const run of copyRuns(list)) {
    for (let k = 0; k < run.count; k++) out[run.at + k * run.rows] = true;
    if (run.at + run.rows * run.count < list.length) out[run.at + run.rows * run.count] = true;
  }
  return out;
}

/** let rows `i`.. be `count` copies of `rows` rows shown one at a time (`RowCopies`); rows < 1 or count < 2: plain rows */
export function setCopies(list: ParamRef[], i: number, rows: number, count: number, name?: string): void {
  const r = list[i];
  if (!r) return;
  const c = rowLayout({ copies: { rows, count, name } }).copies;
  if (c && i + rows * count <= list.length) r.copies = c;
  else delete r.copies;
}

/** the names of row `i`'s positions (a Selector's, #358); none: the numbers again */
export function setRowNames(list: ParamRef[], i: number, names: readonly string[]): void {
  const r = list[i];
  if (!r) return;
  const n = fixNames(names);
  if (n) r.names = n;
  else delete r.names;
}

/** the parameters card rows tie together (#357) and the position names they give (#358), worked out once for a patch */
export interface Ties {
  /** every parameter tied to this one, itself first: the rows of every assembly that set it, the rows that set any of
   * those, and so on (a nested card's row and its parent's); just itself when no row ties it */
  tied(module: number, param: string): RowTarget[];
  /** the position names a card row gives this parameter: its own row's, else those of a row it is tied to */
  names(module: number, param: string): string[] | undefined;
}

export function ties(p: Patch): Ties {
  const key = (t: RowTarget): string => `${t.module}:${t.param}`;
  const up = new Map<string, string>();
  const find = (k: string): string => {
    let r = k;
    while (up.has(r) && up.get(r) !== r) r = up.get(r)!;
    return r;
  };
  const rows = assembliesOf(p).flatMap((a) => a.params.filter((r) => r.also?.length || r.names));
  for (const r of rows) {
    const ts = rowTargets(r).map(key);
    for (const k of ts) if (!up.has(k)) up.set(k, k);
    for (const k of ts.slice(1)) up.set(find(k), find(ts[0]));
  }
  const groups = new Map<string, RowTarget[]>();
  for (const k of up.keys()) {
    const [m, ...rest] = k.split(':');
    const g = groups.get(find(k)) ?? [];
    g.push({ module: Number(m), param: rest.join(':') });
    groups.set(find(k), g);
  }
  const named = new Map<string, string[]>();
  for (const r of rows) if (r.names && !named.has(find(key(r)))) named.set(find(key(r)), r.names);
  return {
    tied(module, param) {
      const me = { module, param };
      const g = up.has(key(me)) ? groups.get(find(key(me))) : undefined;
      return [me, ...(g ?? []).filter((t) => !sameTarget(t, me))];
    },
    names(module, param) {
      const k = key({ module, param });
      return up.has(k) ? named.get(find(k)) : undefined;
    },
  };
}

/** every parameter tied to this one by card rows (#357), itself first (Ties.tied) */
export const tiedTo = (p: Patch, module: number, param: string): RowTarget[] => ties(p).tied(module, param);

/** the position names a card row gives this parameter (#358, Ties.names) */
export const rowNames = (p: Patch, module: number, param: string): string[] | undefined => ties(p).names(module, param);

/**
 * Make every parameter a row ties (#357) follow the row's first: its value (clamped to its range), whether p1 / p2 route
 * to it, its macro range on that pin, the pin's depth where the pin routes to it alone on both, and the side-input routes
 * to it. What the editor's cables and menus did to the first reaches the others this way. Returns whether anything changed.
 */
export function syncTied(p: Patch, defs: Record<string, ModuleDef>): boolean {
  let changed = false;
  const byId = new Map(p.modules.map((m) => [m.id, m]));
  for (const a of assembliesOf(p))
    for (const r of a.params) {
      if (!r.also?.length) continue;
      const src = byId.get(r.module);
      const pd = src && defs[src.type]?.params.find((q) => q.name === r.param);
      if (!src || !pd) continue;
      for (const t of r.also) {
        const m = byId.get(t.module);
        const tp = m && defs[m.type]?.params.find((q) => q.name === t.param);
        if (!m || !tp) continue;
        const v = Math.min(topOf(tp), Math.max(tp.min, src.params[r.param] ?? pd.default));
        if (m.params[t.param] !== v) (m.params[t.param] = v, changed = true);
        for (const [pin, k] of [['p1', 0], ['p2', 1]] as const) {
          if (!m.map || !src.map) continue;
          const on = src.map[pin].includes(r.param);
          if (on !== m.map[pin].includes(t.param)) {
            m.map[pin] = on ? [...m.map[pin], t.param] : m.map[pin].filter((x) => x !== t.param);
            changed = true;
          }
          const want = on ? src.range?.[pin]?.[r.param] : undefined;
          const have = m.range?.[pin]?.[t.param];
          if (want?.[0] !== have?.[0] || want?.[1] !== have?.[1]) {
            m.range ??= {};
            const list = { ...(m.range[pin] ?? {}) };
            if (want) list[t.param] = [want[0], want[1]];
            else delete list[t.param];
            if (Object.keys(list).length) m.range[pin] = list;
            else delete m.range[pin];
            if (!m.range.p1 && !m.range.p2) delete m.range;
            changed = true;
          }
          const alone = (x: ModuleInst, name: string): boolean => x.map![pin].length === 1 && x.map![pin][0] === name;
          if (on && src.att && m.att && alone(src, r.param) && alone(m, t.param) && m.att[k] !== src.att[k]) {
            m.att = [...m.att] as [number, number];
            m.att[k] = src.att[k];
            changed = true;
          }
        }
        for (const [port, list] of Object.entries(src.inputMap ?? {})) {
          if (!list.includes(r.param) || !defs[m.type].inputs.some((q) => q.name === port) || m.inputMap?.[port]?.includes(t.param)) continue;
          m.inputMap = { ...(m.inputMap ?? {}), [port]: [...(m.inputMap?.[port] ?? []), t.param] };
          changed = true;
        }
      }
    }
  return changed;
}

/** move the collapsed card, every member and every nested assembly by (dx, dy) */
export function moveAssembly(p: Patch, a: AssemblyInst, dx: number, dy: number): void {
  const asms = [a, ...descendants(p, a)];
  const ids = new Set(asms.flatMap((x) => x.modules));
  for (const x of asms) {
    x.x = Math.max(0, x.x + dx);
    x.y = Math.max(0, x.y + dy);
  }
  for (const m of p.modules) if (ids.has(m.id)) {
    m.x = Math.max(0, m.x + dx);
    m.y = Math.max(0, m.y + dy);
  }
}

/** the editor's card grid: columns 320 px apart (a card is 236..300 px wide), rows 560 px (what "Add module" uses), a 20 px margin */
export const GRID = { x: 320, y: 560, cols: 4, margin: 20 };

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const overlaps = (a: Rect, b: Rect): boolean => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

/**
 * The first grid cell, in reading order, where a card of w x h would not touch any of the occupied rectangles. The scan
 * never ends on a row: a canvas can always grow downwards.
 */
export function freeSpot(occupied: Rect[], w: number, h: number): { x: number; y: number } {
  for (let row = 0; ; row++)
    for (let col = 0; col < GRID.cols; col++) {
      const r = { x: GRID.margin + col * GRID.x, y: GRID.margin + row * GRID.y, w, h };
      if (!occupied.some((o) => overlaps(o, r))) return { x: r.x, y: r.y };
    }
}

/** the vertical step of the cells `freeSpotNear` tries: a quarter row, so a card fits a view shorter than two rows */
export const ROW_STEP = GRID.y / 4;

/**
 * Where a new card of w x h goes in view (#175): of the free cells (GRID.x columns from the margin, ROW_STEP rows) that lie
 * wholly inside `view`, the one whose centre is nearest `origin` (the cursor, or the view's centre). When none is free
 * (the view is full, or smaller than the card), the free cell that needs the least scrolling to be seen, then the one
 * nearest `origin`. Every rectangle is in patch layout pixels; the canvas grows right and down, so a cell is always found.
 */
export function freeSpotNear(occupied: Rect[], w: number, h: number, view: Rect, origin: { x: number; y: number }): { x: number; y: number } {
  const right = Math.max(view.x + view.w, ...occupied.map((o) => o.x + o.w));
  const bottom = Math.max(view.y + view.h, ...occupied.map((o) => o.y + o.h));
  const cols = Math.ceil(Math.max(0, right - GRID.margin) / GRID.x) + 1;
  const rows = Math.ceil(Math.max(0, bottom - GRID.margin) / ROW_STEP) + 1;
  // how far a span sticks out of the view's span (one longer than the view: how far its start is from the view's)
  const out = (a: number, len: number, v0: number, vlen: number): number => (len > vlen ? Math.abs(a - v0) : Math.max(0, v0 - a, a + len - v0 - vlen));
  let best: { x: number; y: number } | null = null;
  let bestOut = Infinity, bestNear = Infinity;
  for (let row = 0; row <= rows; row++)
    for (let col = 0; col <= cols; col++) {
      const r = { x: GRID.margin + col * GRID.x, y: GRID.margin + row * ROW_STEP, w, h };
      const away = Math.hypot(out(r.x, w, view.x, view.w), out(r.y, h, view.y, view.h));
      if (away > bestOut) continue;
      const near = Math.hypot(r.x + w / 2 - origin.x, r.y + h / 2 - origin.y);
      if (away === bestOut && near >= bestNear) continue;
      if (occupied.some((o) => overlaps(o, r))) continue;
      best = { x: r.x, y: r.y };
      bestOut = away;
      bestNear = near;
    }
  return best!;
}

const memberModules = (p: Patch, a: AssemblyInst): ModuleInst[] => a.modules.map((id) => p.modules.find((m) => m.id === id)!).filter(Boolean);

/** whether two member cards sit on top of each other (closer than most of a card in both directions) */
export function overlapping(p: Patch, a: AssemblyInst): boolean {
  const ms = memberModules(p, a);
  for (let i = 0; i < ms.length; i++)
    for (let j = i + 1; j < ms.length; j++) if (Math.abs(ms[i].x - ms[j].x) < 200 && Math.abs(ms[i].y - ms[j].y) < 120) return true;
  return false;
}

/** lay the members out on the grid from their top left corner, in their current reading order */
export function tileMembers(p: Patch, a: AssemblyInst): void {
  const ms = memberModules(p, a).sort((u, v) => u.y - v.y || u.x - v.x);
  const x0 = Math.min(...ms.map((m) => m.x));
  const y0 = Math.min(...ms.map((m) => m.y));
  ms.forEach((m, i) => {
    m.x = x0 + (i % GRID.cols) * GRID.x;
    m.y = y0 + Math.floor(i / GRID.cols) * GRID.y;
  });
}

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

function stripKnobs(m: ModuleInst): void {
  if (m.map) for (const k of KNOBS) m.map[k] = [];
}

/** the saved form of an assembly: every module with local ids 1..n, nested assemblies with local ids, positions from the top left member, no knob assignments */
export function toDef(p: Patch, a: AssemblyInst): AssemblyDef {
  const nested = descendants(p, a);
  const order = [...a.modules, ...nested.flatMap((d) => d.modules)];
  const ms = order.map((id) => clone(p.modules.find((m) => m.id === id)!));
  const local = new Map(order.map((id, i) => [id, i + 1]));
  const localAsm = new Map(nested.map((d, i) => [d.id, i + 1]));
  const x0 = Math.min(...ms.map((m) => m.x));
  const y0 = Math.min(...ms.map((m) => m.y));
  const kept = a.bypass ? new Set(a.kept ?? []) : null; // a group that is off: the definition gets the members' own switches
  for (const m of ms) {
    if (kept) {
      if (kept.has(m.id)) m.bypass = true;
      else delete m.bypass;
    }
    m.id = local.get(m.id)!;
    m.x -= x0;
    m.y -= y0;
    stripKnobs(m);
  }
  const remap = <T extends { module: number }>(r: T): T => ({ ...r, module: local.get(r.module)! });
  const port = (r: PortRef): PortRef => {
    const n = remap(r);
    if (r.also) n.also = r.also.map(remap);
    return n;
  };
  const row = (r: ParamRef): ParamRef => {
    const n = remap(r);
    if (r.also) n.also = r.also.map(remap);
    if (r.names) n.names = [...r.names];
    if (r.copies) n.copies = { ...r.copies };
    return n;
  };
  const def: AssemblyDef = {
    format: ASSEMBLY_FORMAT,
    version: 1,
    name: a.name,
    ...assemblyLayout(a),
    modules: ms,
    cables: p.cables.filter((c) => local.has(c.from.module) && local.has(c.to.module)).map((c) => ({ from: remap(c.from), to: remap(c.to) })),
    inputs: a.inputs.map(port),
    outputs: a.outputs.map(port),
    params: a.params.map(row),
  };
  if (a.heads?.length) def.heads = a.heads.map(remap);
  if (a.poly) def.poly = { ...a.poly };
  if (nested.length) {
    def.children = (a.children ?? []).map((id) => localAsm.get(id)!);
    def.assemblies = nested.map((d) => {
      const n: NestedDef = {
        id: localAsm.get(d.id)!,
        name: d.name,
        label: d.label,
        x: d.x - x0,
        y: d.y - y0,
        open: d.open,
        ...assemblyLayout(d),
        modules: d.modules.map((id) => local.get(id)!),
        inputs: d.inputs.map(port),
        outputs: d.outputs.map(port),
        params: d.params.map(row),
      };
      if (d.heads?.length) n.heads = d.heads.map(remap);
      if (d.children?.length) n.children = d.children.map((id) => localAsm.get(id)!);
      if (d.poly) n.poly = { ...d.poly };
      return n;
    });
  }
  return def;
}

/** put a saved assembly into the patch, collapsed at (x, y), with fresh module and assembly ids */
export function insertAssembly(p: Patch, defs: Record<string, ModuleDef>, def: AssemblyDef, x: number, y: number): AssemblyInst {
  const fresh = new Map<number, number>();
  for (const src of def.modules) {
    const m = addModule(p, defs[src.type], x + src.x, y + src.y);
    m.params = { ...m.params, ...clone(src.params) };
    if (src.att) m.att = [...src.att];
    if (src.map) m.map = clone(src.map);
    if (src.range) m.range = clone(src.range);
    if (src.inputMap) m.inputMap = structuredClone(src.inputMap);
    if (src.bypass) m.bypass = true; // toDef writes the members' own switches
    if (src.type === 'steps') {   // a track's name and notes (a definition from before #133: its pattern and step values, migrated)
      const old = src as typeof src & { steps?: unknown; vels?: unknown };
      Object.assign(m, clone({ name: src.name, steps: old.steps, notes: src.notes, vels: old.vels, patterns: src.patterns }));
      fixTrack(m);
    }
    if (src.type === 'drummap' && src.names) {   // a Drum map's row names
      m.names = clone(src.names);
      fixTrack(m);
    }
    fixInputRoutes(m, defs[src.type]);
    fixMatrix(m, defs[src.type]);
    stripKnobs(m);
    fresh.set(src.id, m.id);
  }
  const remap = <T extends { module: number }>(r: T): T => ({ ...r, module: fresh.get(r.module)! });
  const port = (r: PortRef): PortRef => {
    const n = remap(r);
    if (r.also) n.also = r.also.map(remap);
    return n;
  };
  const row = (r: ParamRef): ParamRef => {
    const n = remap(r);
    if (r.also) n.also = r.also.map(remap);
    if (r.names) n.names = [...r.names];
    if (r.copies) n.copies = { ...r.copies };
    return n;
  };
  for (const c of def.cables) p.cables.push({ from: remap(c.from), to: remap(c.to) });
  const nested = def.assemblies ?? [];
  let nextId = nextAssemblyId(p);
  const freshAsm = new Map(nested.map((d) => [d.id, nextId++]));
  const claimed = new Set(nested.flatMap((d) => d.modules));
  const taken = assembliesOf(p).map((o) => o.label);
  const made: AssemblyInst[] = nested.map((d) => {
    const n: AssemblyInst = {
      v: 1,
      id: freshAsm.get(d.id)!,
      name: d.name,
      label: uniqueLabel(taken, d.label || d.name),
      x: Math.max(0, x + d.x),
      y: Math.max(0, y + d.y),
      open: d.open,
      ...assemblyLayout(d),
      modules: d.modules.map((id) => fresh.get(id)!),
      inputs: d.inputs.map(port),
      outputs: d.outputs.map(port),
      params: d.params.map(row),
    };
    if (d.heads?.length) n.heads = d.heads.map(remap);
    taken.push(n.label);
    if (d.children?.length) n.children = d.children.map((id) => freshAsm.get(id)!);
    if (d.poly) n.poly = fixCards(d.poly);
    return n;
  });
  const a: AssemblyInst = {
    v: 1,
    id: nextId,
    name: def.name,
    ...assemblyLayout(def),
    label: uniqueLabel(taken, def.name),
    x,
    y,
    open: false,
    modules: def.modules.filter((src) => !claimed.has(src.id)).map((src) => fresh.get(src.id)!),
    inputs: def.inputs.map(port),
    outputs: def.outputs.map(port),
    params: def.params.map(row),
  };
  if (def.heads?.length) a.heads = def.heads.map(remap);
  if (def.children?.length) a.children = def.children.map((id) => freshAsm.get(id)!);
  if (def.poly) a.poly = fixCards(def.poly);
  p.assemblies = [...assembliesOf(p), ...made, a];
  for (const n of [...made].reverse()) reconcile(p, n, defs);
  reconcile(p, a, defs);
  return a;
}

const isRec = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object';

/** structural check of a saved assembly (a file, a library entry, a factory file). Throws with a readable message. */
/**
 * Drop the Main panel and the Output from a definition (a file or library entry made by hand, or by an older editor):
 * their cables, exposed ports and promoted parameters go with them. Returns how many modules went.
 */
export function stripPatchIO(d: AssemblyDef): number {
  const gone = new Set(d.modules.filter((m) => isRec(m) && EXCLUDED_TYPES.has(String(m.type))).map((m) => m.id));
  if (!gone.size) return 0;
  d.modules = d.modules.filter((m) => !gone.has(m.id));
  d.cables = d.cables.filter((c) => isRec(c) && isRec(c.from) && isRec(c.to) && !gone.has(c.from.module) && !gone.has(c.to.module));
  const keep = (r: unknown): boolean => isRec(r) && !gone.has(r.module as number) && !(Array.isArray(r.also) && r.also.some((a) => isRec(a) && gone.has(a.module as number)));
  if (Array.isArray(d.inputs)) d.inputs = d.inputs.filter(keep);
  if (Array.isArray(d.outputs)) d.outputs = d.outputs.filter(keep);
  if (Array.isArray(d.params)) d.params = d.params.filter(keep);
  if (Array.isArray(d.assemblies)) for (const n of d.assemblies) if (isRec(n) && Array.isArray(n.modules)) n.modules = n.modules.filter((id) => !gone.has(id as number));
  return gone.size;
}

/** a definition from before poly assemblies: the oscillators' drift settings become Random modules (poly.ts oscDrift) */
function migrateDefDrift(d: AssemblyDef, defs: Record<string, ModuleDef>): void {
  if (!Array.isArray(d.cables)) return;
  const ms = d.modules.filter((m) => isRec(m) && isRec(m.params));
  const drifted = takeDrift(ms);
  if (Array.isArray(d.params)) d.params = d.params.filter((r) => !(isRec(r) && r.param === 'drift' && ms.find((m) => m.id === r.module)?.type === 'osc'));
  if (!drifted.size) return;
  oscDrift(ms, d.cables, defs, drifted, [], (osc) => {
    const at = freeSpot(d.modules.map((m) => ({ x: m.x, y: m.y, w: GRID.x, h: GRID.y })), GRID.x - 34, GRID.y - 60);
    const r: ModuleInst = { id: d.modules.reduce((m, x) => Math.max(m, Number(x.id) || 0), 0) + 1, type: 'random', x: at.x, y: at.y, params: defaultParams(defs.random) };
    fixMatrix(r, defs.random);
    d.modules.push(r);
    const host = d.assemblies?.find((n) => isRec(n) && Array.isArray(n.modules) && n.modules.includes(osc.id));
    if (host) host.modules.push(r.id);
    return r;
  });
}

/** a definition from before Voice allocators: its Part becomes an allocator (poly.ts migrateParts) whose keys input the
 * card shows (and every nested card around it) */
function migrateDefParts(d: AssemblyDef, defs: Record<string, ModuleDef>): void {
  const nested = (Array.isArray(d.assemblies) ? d.assemblies : []).filter((n) => isRec(n) && Array.isArray(n.modules));
  for (const { alloc, around } of migrateParts(d.modules.filter((m) => isRec(m) && typeof m.type === 'string'), nested, defs, d)) {
    const ref = { module: alloc.id, port: 'keys', label: 'keys' };
    for (const n of around) if (Array.isArray(n.inputs)) (n.inputs as PortRef[]).unshift({ ...ref });
    if (Array.isArray(d.inputs)) d.inputs.unshift({ ...ref });
  }
}

export function validateAssemblyDef(raw: unknown, defs: Record<string, ModuleDef>): AssemblyDef {
  if (!isRec(raw) || (raw.format !== ASSEMBLY_FORMAT && raw.format !== LEGACY_ASSEMBLY_FORMAT) || !Array.isArray(raw.modules) || !Array.isArray(raw.cables)) throw new Error('not a Matryoshka assembly');
  const d = raw as unknown as AssemblyDef;
  d.format = ASSEMBLY_FORMAT;
  const layout = assemblyLayout(d);
  delete d.size; delete d.frameSize;
  Object.assign(d, layout);
  stripPatchIO(d); // a patch's own modules never belong to a building block
  if (!d.modules.length) throw new Error('an assembly holds at least one module');
  migrateDefDrift(d, defs);
  migrateDefParts(d, defs);
  if (d.category !== undefined && typeof d.category !== 'string') delete d.category;
  if (d.tutorial !== undefined && typeof d.tutorial !== 'string') delete d.tutorial;
  if (d.blurb !== undefined && typeof d.blurb !== 'string') delete d.blurb;
  const seen = new Set<number>();
  for (const m of d.modules) {
    const def = defs[m.type];
    if (!def) throw new Error(`unknown module type "${m.type}"`);
    if (!Number.isInteger(m.id) || seen.has(m.id)) throw new Error(`bad or duplicate module id ${m.id}`);
    seen.add(m.id);
    m.params = { ...defaultParams(def), ...(m.params ?? {}) };
    m.x = Number(m.x) || 0;
    m.y = Number(m.y) || 0;
    fixMatrix(m, def);
    fixInputRoutes(m, def);
    fixTrack(m);
    stripKnobs(m);
  }
  const typeOf = (id: number): string | undefined => d.modules.find((m) => m.id === id)?.type;
  {   // a Steps module's acc output is gone (#133: an accent is full velocity): its cables and the cards' acc jacks go
    const acc = (r: unknown): boolean => isRec(r) && r.port === 'acc' && typeOf(Number(r.module)) === 'steps';
    d.cables = d.cables.filter((c) => !acc(c.from));
    if (Array.isArray(d.outputs)) d.outputs = d.outputs.filter((r) => !acc(r));
    for (const n of Array.isArray(d.assemblies) ? d.assemblies : []) if (isRec(n) && Array.isArray(n.outputs)) n.outputs = (n.outputs as unknown[]).filter((r) => !acc(r)) as typeof n.outputs;
  }
  for (const c of d.cables) {
    const tf = typeOf(c.from?.module);
    const tt = typeOf(c.to?.module);
    if (!tf || !tt) throw new Error('cable to a module outside the assembly');
    if (!defs[tf].outputs.some((o) => o.name === c.from.port)) throw new Error(`no output "${c.from.port}" on ${tf}`);
    if (!defs[tt].inputs.some((i) => i.name === c.to.port)) throw new Error(`no input "${c.to.port}" on ${tt}`);
  }
  const target = (r: unknown, dir: 'in' | 'out'): Target => {
    if (!isRec(r)) throw new Error('bad port');
    const t = typeOf(Number(r.module));
    if (!t || !(dir === 'in' ? defs[t].inputs : defs[t].outputs).some((q) => q.name === r.port)) throw new Error(`exposed ${dir === 'in' ? 'input' : 'output'} "${String(r.port)}" does not exist`);
    return { module: Number(r.module), port: String(r.port) };
  };
  const ports = (list: unknown, dir: 'in' | 'out'): PortRef[] =>
    (Array.isArray(list) ? list : []).flatMap((r: unknown) => {
      if (!isRec(r)) return [];
      const t = target(r, dir);
      const ref: PortRef = { ...t, label: String(r.label ?? r.port) };
      if (dir === 'in' && Array.isArray(r.also) && r.also.length) ref.also = r.also.map((x) => target(x, 'in'));
      return [ref];
    });
  const params = (list: unknown): ParamRef[] =>
    tidyRows((Array.isArray(list) ? list : []).flatMap((r: unknown) => {
      if (!isRec(r)) return [];
      const t = typeOf(Number(r.module));
      const pd = t ? rowDef(defs[t], String(r.param)) : undefined;
      if (!pd) throw new Error(`promoted parameter "${String(r.param)}" does not exist`);
      if (pd.onScreen) return []; // set on its module's screen: not a row of the card
      const ex = rowExtras(r);
      if (ex.also) ex.also = ex.also.filter((t) => { const tt = typeOf(t.module); const tq = tt ? rowDef(defs[tt], t.param) : undefined; return !!tq && tt !== 'alloc' && sameRange(pd, tq); });
      if (!ex.also?.length) delete ex.also;
      if (ex.names && !(t === 'select' && r.param === 'pos')) delete ex.names;
      return [{ module: Number(r.module), param: String(r.param), label: String(r.label ?? r.param), ...rowLayout(r), ...ex }];
    }));
  const moduleOf = (id: number): ModuleInst | undefined => d.modules.find((m) => m.id === id);
  d.params = params(d.params);
  const dh = emptyHeads(d.heads, d.params);
  if (dh) d.heads = dh; else delete d.heads;
  d.inputs = pinsToParams(ports(d.inputs, 'in'), d.params, moduleOf);
  d.outputs = ports(d.outputs, 'out');
  // nested assemblies: local ids, disjoint direct members, a tree of at most MAX_DEPTH levels
  const rawNested = (raw as { assemblies?: unknown }).assemblies;
  if (Array.isArray(rawNested) && rawNested.length) {
    const asmIds = new Set<number>();
    const claimed = new Set<number>();
    d.assemblies = rawNested.map((e: unknown): NestedDef => {
      if (!isRec(e) || !Number.isInteger(e.id) || !Array.isArray(e.modules)) throw new Error('bad nested assembly');
      if (asmIds.has(Number(e.id))) throw new Error(`duplicate nested assembly id ${String(e.id)}`);
      asmIds.add(Number(e.id));
      const mods = e.modules.map(Number);
      for (const id of mods) {
        if (!typeOf(id)) throw new Error(`nested assembly: module ${id} is not in the file`);
        if (claimed.has(id)) throw new Error(`nested assembly: module ${id} is in two assemblies`);
        claimed.add(id);
      }
      const n: NestedDef = {
        id: Number(e.id),
        name: String(e.name ?? 'assembly'),
        label: String(e.label ?? e.name ?? 'assembly'),
        x: Number(e.x) || 0,
        y: Number(e.y) || 0,
        open: !!e.open,
        ...assemblyLayout(e),
        modules: mods,
        inputs: [],
        outputs: ports(e.outputs, 'out'),
        params: params(e.params),
      };
      const nh = emptyHeads(e.heads, n.params);
      if (nh) n.heads = nh;
      n.inputs = pinsToParams(ports(e.inputs, 'in'), n.params, moduleOf);
      if (Array.isArray(e.children) && e.children.length) n.children = e.children.map(Number);
      if (e.poly) n.poly = fixCards(e.poly);
      return n;
    });
    const byId = new Map(d.assemblies.map((n) => [n.id, n]));
    const parent = new Map<number, number>();
    const link = (from: number, kids: number[] | undefined): void => {
      for (const k of kids ?? []) {
        if (!byId.has(k)) throw new Error(`nested assembly ${k} does not exist`);
        if (parent.has(k) || k === from) throw new Error(`nested assembly ${k} has two parents`);
        parent.set(k, from);
      }
    };
    const rawKids = (raw as { children?: unknown }).children;
    d.children = Array.isArray(rawKids) ? rawKids.map(Number) : [];
    link(0, d.children);
    for (const n of d.assemblies) link(n.id, n.children);
    for (const n of d.assemblies) if (!parent.has(n.id)) throw new Error(`nested assembly "${n.label}" is in no assembly`);
    const depth = (id: number, guard = 0): number => (id === 0 ? 1 : guard > MAX_DEPTH ? guard : 1 + depth(parent.get(id)!, guard + 1));
    for (const n of d.assemblies) if (depth(n.id) > MAX_DEPTH) throw new Error(`assemblies nest at most ${MAX_DEPTH} deep`);
    for (const n of d.assemblies) if (!n.modules.length && !n.children?.length) throw new Error(`nested assembly "${n.label}" is empty`);
    if (!d.children.length) delete d.children;
  } else {
    delete d.assemblies;
    delete d.children;
  }
  if (d.poly) d.poly = fixCards(d.poly);
  else delete d.poly;
  d.version = 1;
  d.name = String(d.name ?? 'assembly').trim() || 'assembly';
  return d;
}

/**
 * Check the overlay of a loaded patch: an entry that does not fit the modules is dropped and its modules stay plain; a
 * nesting that does not form a tree of at most MAX_DEPTH levels is undone. Returns one message per repair. Call after
 * validatePatch.
 */
export function fixAssemblies(p: Patch, defs: Record<string, ModuleDef>): string[] {
  const msgs: string[] = [];
  const raw = (p as { assemblies?: unknown }).assemblies;
  if (raw === undefined || raw === null) {
    delete p.assemblies;
    return msgs;
  }
  if (!Array.isArray(raw)) {
    delete p.assemblies;
    return ['assemblies dropped: not a list'];
  }
  const ids = new Set<number>();
  const used = new Set<number>();
  const ok: AssemblyInst[] = [];
  const wantKids = new Map<number, number[]>();
  raw.forEach((e: unknown, i: number) => {
    const label = isRec(e) && typeof e.label === 'string' ? e.label : `#${i + 1}`;
    const drop = (why: string): void => {
      msgs.push(`assembly "${label}" dropped: ${why}`);
    };
    if (!isRec(e) || !Array.isArray(e.modules)) return drop('bad entry');
    const members = e.modules.map(Number);
    const kids = Array.isArray(e.children) ? e.children.map(Number).filter((k) => Number.isInteger(k)) : [];
    if ((!members.length && !kids.length) || members.some((id) => !Number.isInteger(id))) return drop('no members');
    for (const id of members) {
      const m = p.modules.find((x) => x.id === id);
      if (!m) return drop(`module ${id} is missing`);
      if (EXCLUDED_TYPES.has(m.type)) return drop('it contains the Main panel or the Output');
      if (used.has(id)) return drop(`module ${id} is in two assemblies`);
    }
    const id = Number.isInteger(e.id) && !ids.has(Number(e.id)) ? Number(e.id) : ok.reduce((m, a) => Math.max(m, a.id), 0) + 1;
    const a: AssemblyInst = {
      v: 1,
      id,
      name: String(e.name ?? 'assembly'),
      label: typeof e.label === 'string' && e.label ? e.label : String(e.name ?? 'assembly'),
      x: Number(e.x) || 0,
      y: Number(e.y) || 0,
      open: !!e.open,
      ...assemblyLayout(e),
      modules: [...new Set(members)],
      inputs: refs(e.inputs, 'port'),
      outputs: refs(e.outputs, 'port').map((r) => ({ module: r.module, port: r.port, label: r.label })),
      params: tidyRows(refs(e.params, 'param') as unknown as ParamRef[]),
    };
    const ah = emptyHeads(e.heads, a.params);
    if (ah) a.heads = ah;
    if (e.poly) a.poly = fixCards(e.poly);
    if (typeof e.preset === 'string' && e.preset.trim()) a.preset = e.preset.trim().slice(0, 24);
    if (e.bypass) {
      // the group switch is off: without it the card read on while every member stayed off, and the switch could not bring them back
      a.bypass = true;
      const member = new Set(a.modules);
      a.kept = Array.isArray(e.kept) ? e.kept.filter((id): id is number => member.has(id)) : [];
    }
    for (const m of a.modules) used.add(m);
    ids.add(a.id);
    if (kids.length) wantKids.set(a.id, kids);
    ok.push(a);
  });
  p.assemblies = ok;
  // nesting: a child exists, has one parent, no cycles, at most MAX_DEPTH levels
  const parentOfId = new Map<number, number>();
  for (const a of ok) {
    const kids: number[] = [];
    for (const k of wantKids.get(a.id) ?? []) {
      const c = ok.find((x) => x.id === k);
      if (!c || k === a.id) msgs.push(`assembly "${a.label}": nested assembly ${k} is missing`);
      else if (parentOfId.has(k)) msgs.push(`assembly "${c.label}" is in two assemblies: kept in "${ok.find((x) => x.id === parentOfId.get(k))!.label}"`);
      else {
        parentOfId.set(k, a.id);
        kids.push(k);
      }
    }
    if (kids.length) a.children = kids;
  }
  for (const a of ok) {
    const seen = new Set<number>([a.id]);
    for (let x = parentOfId.get(a.id); x !== undefined; x = parentOfId.get(x)) {
      if (seen.has(x)) {
        msgs.push(`assembly "${a.label}": nesting loop undone`);
        const par = ok.find((q) => q.id === parentOfId.get(a.id))!;
        par.children = par.children!.filter((k) => k !== a.id);
        if (!par.children.length) delete par.children;
        parentOfId.delete(a.id);
        break;
      }
      seen.add(x);
    }
  }
  for (const a of ok)
    if (depthOf(p, a) > MAX_DEPTH) {
      const par = parentOf(p, a.id)!;
      msgs.push(`assembly "${a.label}" is nested too deep (more than ${MAX_DEPTH}): taken out of "${par.label}"`);
      par.children = par.children!.filter((k) => k !== a.id);
      if (!par.children.length) delete par.children;
    }
  reconcileAll(p, defs);
  syncTied(p, defs);   // (what a row sets follows its first, #357)
  return msgs;
}

/** the well-formed empty headings of a file: a heading of up to HEAD_MAX characters at a row the card has; none: undefined */
function emptyHeads(list: unknown, params: readonly ParamRef[]): EmptyHead[] | undefined {
  if (!Array.isArray(list)) return undefined;
  const out = list.flatMap((h: unknown): EmptyHead[] => {
    if (!isRec(h) || typeof h.head !== 'string') return [];
    const head = h.head.trim().slice(0, HEAD_MAX);
    const module = Number(h.module);
    const param = String(h.param);
    if (!head || !params.some((r) => r.module === module && r.param === param)) return [];
    return [{ head, module, param, ...(h.after === true ? { after: true as const } : {}) }];
  });
  return out.length ? out : undefined;
}

function refs(list: unknown, key: 'port' | 'param'): PortRef[] {
  return (Array.isArray(list) ? list : []).flatMap((r: unknown) => {
    if (!isRec(r) || !Number.isInteger(Number(r.module)) || typeof r[key] !== 'string') return [];
    const ref = { module: Number(r.module), [key]: r[key], label: String(r.label ?? r[key]), ...(key === 'param' ? { ...rowLayout(r), ...rowExtras(r) } : {}) } as unknown as PortRef;
    if (key === 'port' && Array.isArray(r.also)) {
      const also = r.also.flatMap((t: unknown) => (isRec(t) && Number.isInteger(Number(t.module)) && typeof t.port === 'string' ? [{ module: Number(t.module), port: t.port }] : []));
      if (also.length) ref.also = also;
    }
    return [ref];
  });
}
