// SPDX-License-Identifier: GPL-3.0-only
// Devices and their pages: what the FM-1 lets you play with K1..K4, and what Main's knobs in the editor's dock turn.
//
// Every top-level thing on the canvas, a module or an assembly, is a device (docs/ledger/vocabulary.md "Device"), unless it is editor-only
// (a Scope) or a Part; one with no rows is left out too. Devices come in the environment's grouped order (#196): Main
// first; then each Steps track (its page: LEN RATE SWING GATE) followed by the devices it drives (a cable from it, or from
// an Arpeggiator it plays through, into them); then the others (an Arpeggiator among them, never where a patch opens); the
// Output last. Tracks and the rest go in the canvas's reading order (columns from the left,
// as Tidy reads them, each from the top). A device's rows are the rows
// of its collapsed card: an assembly's promoted parameters, a plain module's every parameter. A heading starts a section;
// a section holds groups of at most PAGE_ROWS rows (`groupStarts`), and each group is one page ("Filter 2/2" = the
// section's second group). Groups fill in fours; a row's `group` flag (Arrange's "new group") or a column break ends one
// early. An envelope's shape on the card (adsr / env `view`) is drawn above the page that holds its rows. Pure model code: the editor, the binary
// format (patchbin.ts) and the tests use it.
import { allModules, assembliesOf, copyStarts, parentOf, ties, type AssemblyInst, type RowTarget } from './assembly';
import { longName, moduleName } from './labels';
import { EDITOR_ONLY, rowDef, type ModuleDef, type ModuleInst, type Patch } from './patch';

/** rows on a page: the four knobs K1..K4 */
export const PAGE_ROWS = 4;
/** characters of a device, page or row name the binary carries (the FM-1's screen) */
export const NAME_MAX = 12;
/** top-level modules that are no devices */
export const NOT_DEVICES = new Set(['part', ...EDITOR_ONLY]);
/** module types whose card display is an envelope shape the FM-1 draws */
export const ENVELOPES = new Set(['adsr', 'env', 'env8']);
/** how far right a card may start and still be in the column of the card above it (half a card, as tidy.ts reads it) */
const COLUMN_SLACK = 150;

export interface PageRow {
  module: number;
  param: string;
  label: string;
  /** the further parameters the row sets (#357: its card row's, and those tied to it through nested cards) */
  also?: RowTarget[];
  /** its positions' names (#358: a Selector's, from its card row) */
  names?: string[];
}
export interface Page {
  /** the heading, or the device's name for rows before the first heading */
  name: string;
  /** which page of its group this is (0-based) and how many the group has: "Filter 2/2" */
  part: number;
  parts: number;
  rows: PageRow[];
  /** an envelope module whose shape is drawn above the rows */
  display?: number;
}
export interface Device {
  /** `a<id>` for an assembly, `m<id>` for a module (stable while the patch is edited) */
  key: string;
  name: string;
  /** the assembly, or the module, it is */
  asm?: number;
  module?: number;
  pages: Page[];
  /** Main, a Steps track, an Arpeggiator or the Output (else an instrument, an effect, ...) */
  kind?: 'main' | 'steps' | 'arp' | 'output';
  /** the Steps track (module id) that drives it: it follows the track in the environment (#196) */
  track?: number;
}

/** where focus goes on a fresh patch: the first device that is not Main, a Steps track, an Arpeggiator or the Output, else
 * the first */
export const homeDevice = (devices: Device[]): number => Math.max(0, devices.findIndex((d) => !d.kind));

/** a page's title as the editor and the FM-1 show it: the name, and "2/3" when its group spans pages */
export const pageTitle = (pg: Page): string => (pg.parts > 1 ? `${pg.name} ${pg.part + 1}/${pg.parts}` : pg.name);

/** characters of knob names the editor's page picker shows before it says "page 2/3" instead */
export const LABEL_MAX = 30;

/**
 * What the editor's page picker shows for page `i` of a device: never the device's name (#154). A page under a heading of
 * its own shows its title; a page before the first heading (its section is named after the device) shows its knobs' row
 * names ("cutoff · res · env · drive"), or "page 2/3" when they do not fit or another page of the section has the same
 * names. The section's only page always shows its knob names (the picker cuts them short). The FM-1 shows "PAGE 2/3"
 * for such a page (pages_ui.c pages_chips): its chip has no room for knob names.
 */
export function pageLabel(dev: Device, i: number): string {
  const pg = dev.pages[i];
  if (pg.name !== dev.name) return pageTitle(pg);
  const knobs = (q: Page): string => q.rows.map((r) => r.label).join(' · ');
  const own = knobs(pg);
  const twin = dev.pages.some((q, j) => j !== i && q.name === pg.name && knobs(q) === own);
  const fallback = `page ${pg.part + 1}/${pg.parts}`;
  if (pg.parts > 1 && (own.length > LABEL_MAX || twin)) return fallback;
  return own && own !== dev.name ? own : fallback;
}

/** a row of a card as grouping sees it: its layout flags, and whether it takes a knob (a display does not); `copy`: a copy
 * of a run shown one at a time starts here, or the run ended (assembly.ts copyStarts) */
export interface GroupItem { head?: string; group?: true; pin?: true; col?: true; copy?: boolean; knob: boolean }

/**
 * Where a card's groups start (true at the first item of each): at the first item, a heading, a `group` or `pin` flag, a column
 * break, and wherever the group already has PAGE_ROWS knob rows (a display there starts the next group, so it stays with
 * the rows under it). Items set from the screen (onScreen) are not passed in.
 */
export function groupStarts(items: GroupItem[]): boolean[] {
  let n = 0;
  return items.map((it, i) => {
    const start = i === 0 || !!it.head || !!it.group || !!it.pin || !!it.col || !!it.copy || n >= PAGE_ROWS;
    if (start) n = 0;
    if (it.knob) n++;
    return start;
  });
}

interface Section { name: string; groups: { rows: PageRow[]; displays: number[] }[] }

/** each group with rows is a page of its section; an envelope shape goes on the section's page that holds its module's
 * rows, else on the page of its own group, else of the nearest group with rows before it (after it, at the top) */
function paginate(sections: Section[], typeOf: (id: number) => string | undefined): Page[] {
  const out: Page[] = [];
  for (const s of sections) {
    const pageOf: number[] = []; // group index -> its page, -1 without rows
    let parts = 0;
    for (const g of s.groups) pageOf.push(g.rows.length ? parts++ : -1);
    const pages: Page[] = s.groups.filter((g) => g.rows.length).map((g, part) => ({ name: s.name, part, parts, rows: g.rows }));
    if (!pages.length) continue;
    s.groups.forEach((g, gi) => {
      for (const d of g.displays) {
        if (!ENVELOPES.has(typeOf(d) ?? '')) continue;
        const own = pages.findIndex((pg) => pg.rows.some((r) => r.module === d));
        const before = pageOf.slice(0, gi + 1).filter((x) => x >= 0);
        pages[own >= 0 ? own : before.length ? before[before.length - 1] : 0].display ??= d;
      }
    });
    out.push(...pages);
  }
  return out;
}

/** cut items into sections (at headings) and groups (`groupStarts`) */
function sectionsOf<T extends GroupItem>(first: string, items: T[], row: (t: T) => PageRow | number): Section[] {
  const starts = groupStarts(items);
  const out: Section[] = [{ name: first, groups: [] }];
  items.forEach((it, i) => {
    if (it.head) out.push({ name: it.head, groups: [] });
    const s = out[out.length - 1];
    if (starts[i] || !s.groups.length) s.groups.push({ rows: [], displays: [] });
    const g = s.groups[s.groups.length - 1];
    const r = row(it);
    if (typeof r === 'number') g.displays.push(r);
    else g.rows.push(r);
  });
  return out;
}

/** a plain module's card rows in order: its displays, then every parameter (never the ones set from its screen); the
 * card and the FM-1 group them in fours */
export function moduleRows(def: ModuleDef): ModuleDef['params'] {
  return [...(def.type === 'steps' ? [] : def.views ?? []), ...def.params.filter((pd) => !pd.onScreen)];
}

/** a plain module's sections: one, its parameters in groups of four */
function moduleSections(type: string, def: ModuleDef, id: number): Section[] {
  // the spelled-out name, or the short one where that would not fit the FM-1's screen
  const label = (name: string): string => { const long = longName(type, name); return long.length <= NAME_MAX ? long : name; };
  const items = moduleRows(def).map((pd) => ({ pd, knob: !pd.screen }));
  return sectionsOf(moduleName(type, def.label), items, ({ pd }) => (pd.screen ? id : { module: id, param: pd.name, label: label(pd.name) }));
}

/** an assembly's sections: its promoted parameters, cut at the headings, in groups */
function assemblySections(p: Patch, a: AssemblyInst, defs: Record<string, ModuleDef>): Section[] {
  const copy = copyStarts(a.params);
  const items = a.params.flatMap((r, i) => {
    const m = p.modules.find((x) => x.id === r.module);
    const def = m && defs[m.type];
    const pd = def && rowDef(def, r.param);
    if (!m || !pd || pd.onScreen) return [];
    return [{ head: r.head, group: r.group, pin: r.pin, col: r.col, copy: copy[i], knob: !pd.screen, r, screen: !!pd.screen }];
  });
  const tie = items.some((it) => it.r.also || it.r.names) || assembliesOf(p).some((x) => x.params.some((r) => r.also || r.names)) ? ties(p) : null;
  return sectionsOf(a.label, items, (it) => {
    if (it.screen) return it.r.module;
    const row: PageRow = { module: it.r.module, param: it.r.param, label: it.r.label };
    const also = tie?.tied(row.module, row.param).slice(1) ?? [];
    const names = it.r.names ?? tie?.names(row.module, row.param);
    if (also.length) row.also = also;
    if (names) row.names = names;
    return row;
  });
}

/** a page's title as the FM-1's page chip shows it in focus (pages_ui.c pages_chips): the heading in capitals, cut to
 * NAME_MAX, or "PAGE" for a page before the first heading (its section takes the device's name), and "2/3" when its
 * section has several pages */
export function fm1PageTitle(device: string, pg: Page): string {
  const base = pg.name === device ? 'PAGE' : pg.name.slice(0, NAME_MAX).toUpperCase();
  return pg.parts > 1 ? `${base} ${pg.part + 1}/${pg.parts}` : base;
}

/** where a top-level item sits on the canvas: a collapsed card's corner, an open frame's first member */
function placeOf(p: Patch, a: AssemblyInst): { x: number; y: number } {
  if (!a.open) return { x: a.x, y: a.y };
  const ms = allModules(p, a).map((id) => p.modules.find((m) => m.id === id)).filter((m) => !!m);
  return ms.length ? { x: Math.min(...ms.map((m) => m!.x)), y: Math.min(...ms.map((m) => m!.y)) } : { x: a.x, y: a.y };
}

const typeIn = (p: Patch) => (id: number): string | undefined => p.modules.find((m) => m.id === id)?.type;
/** a plain module's pages, as its device would have them (the patch card draws them for any module) */
export const modulePages = (p: Patch, m: ModuleInst, defs: Record<string, ModuleDef>): Page[] =>
  defs[m.type] ? paginate(moduleSections(m.type, defs[m.type], m.id), typeIn(p)) : [];
/** an assembly's pages, as its device would have them (the patch card draws them for a nested one too) */
export const assemblyPages = (p: Patch, a: AssemblyInst, defs: Record<string, ModuleDef>): Page[] => paginate(assemblySections(p, a, defs), typeIn(p));

/** the patch's devices in the environment's grouped order (see the top of this file) */
export function devicesOf(p: Patch, defs: Record<string, ModuleDef>): Device[] {
  const inAsm = new Set(assembliesOf(p).flatMap((a) => a.modules));
  const items: { x: number; y: number; dev: Device }[] = [];
  const KINDS: Record<string, Device['kind']> = { fm1: 'main', steps: 'steps', arp: 'arp', output: 'output' };
  for (const m of p.modules) {
    if (inAsm.has(m.id) || NOT_DEVICES.has(m.type) || !defs[m.type]) continue;
    const pages = modulePages(p, m, defs);
    const name = m.type === 'steps' && m.name ? m.name : moduleName(m.type, defs[m.type].label);
    if (pages.length) items.push({ x: m.x, y: m.y, dev: { key: `m${m.id}`, name, module: m.id, pages, ...(KINDS[m.type] ? { kind: KINDS[m.type] } : {}) } });
  }
  for (const a of assembliesOf(p)) {
    if (parentOf(p, a.id)) continue;
    const pages = assemblyPages(p, a, defs);
    if (pages.length) items.push({ ...placeOf(p, a), dev: { key: `a${a.id}`, name: a.label, asm: a.id, pages } });
  }
  // columns from the left; a card joins the column of the first card in it while it starts within half a card of it
  const cols: (typeof items)[] = [];
  for (const it of [...items].sort((u, v) => u.x - v.x || u.y - v.y)) {
    const col = cols[cols.length - 1];
    if (col && it.x < col[0].x + COLUMN_SLACK) col.push(it);
    else cols.push([it]);
  }
  const reading = cols.flatMap((col) => col.sort((u, v) => u.y - v.y || u.x - v.x).map((it) => it.dev));
  // the device each module belongs to: its outermost assembly's, else its own
  const deviceOf = new Map<number, Device>();
  for (const d of reading) for (const id of d.asm !== undefined ? allModules(p, assembliesOf(p).find((a) => a.id === d.asm)!) : [d.module!]) deviceOf.set(id, d);
  const out: Device[] = reading.filter((d) => d.kind === 'main');
  const placed = new Set<Device>(out);
  for (const t of reading.filter((d) => d.kind === 'steps')) {
    out.push(t);
    placed.add(t);
    // (a cable from it, or from an Arpeggiator it plays through)
    const from = new Set([t.module, ...p.cables.filter((c) => c.from.module === t.module && p.modules.find((m) => m.id === c.to.module)?.type === 'arp').map((c) => c.to.module)]);
    const driven = reading.filter((d) => !placed.has(d) && !d.kind && p.cables.some((c) => from.has(c.from.module) && deviceOf.get(c.to.module) === d));
    for (const d of driven) {
      d.track = t.module;
      out.push(d);
      placed.add(d);
    }
  }
  out.push(...reading.filter((d) => !placed.has(d) && d.kind !== 'output'));
  out.push(...reading.filter((d) => d.kind === 'output'));
  return out;
}

/** the device, page and row a module's parameter is on, if it is on one */
export function findRow(devices: Device[], module: number, param: string): { device: number; page: number; row: number } | undefined {
  for (let d = 0; d < devices.length; d++)
    for (let g = 0; g < devices[d].pages.length; g++) {
      const row = devices[d].pages[g].rows.findIndex((r) => r.module === module && r.param === param);
      if (row >= 0) return { device: d, page: g, row };
    }
  return undefined;
}

/** a focus (device key + page) that still exists, else the first page of the first device; null when there are none */
export function fixFocus(devices: Device[], focus: { device: string; page: number } | null): { device: string; page: number } | null {
  if (!devices.length) return null;
  const d = devices.find((x) => x.key === focus?.device);
  if (!d) return { device: devices[homeDevice(devices)].key, page: 0 };
  return { device: d.key, page: Math.max(0, Math.min(d.pages.length - 1, focus!.page)) };
}
