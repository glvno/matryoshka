// SPDX-License-Identifier: GPL-3.0-only
// Devices and their pages: what the FM-1 lets you play with K1..K4, and what Main's knobs in the editor's dock turn.
//
// Every top-level thing on the canvas, a module or an assembly, is a device, unless it is the Main panel, the Output (the
// MASTER pot), a Steps track (the SEQ page) or editor-only (a Scope); one with no rows is left out too. Devices come in
// the canvas's reading order (columns from the left, as Tidy reads them, each from the top). A device's rows are the rows
// of its collapsed card: an assembly's promoted parameters, a plain module's every parameter. A heading starts a page,
// and a page holds at most PAGE_ROWS rows: a longer group goes on over more pages ("Filter 2/2"). An envelope's shape on
// the card (adsr / env `view`) is drawn above the page that holds its rows. Pure model code: the editor, the binary
// format (patchbin.ts) and the tests use it.
import { allModules, assembliesOf, parentOf, type AssemblyInst } from './assembly';
import { longName, moduleName } from './labels';
import { EDITOR_ONLY, rowDef, type ModuleDef, type Patch } from './patch';

/** rows on a page: the four knobs K1..K4 */
export const PAGE_ROWS = 4;
/** characters of a device, page or row name the binary carries (the FM-1's screen) */
export const NAME_MAX = 12;
/** top-level modules that are no devices */
export const NOT_DEVICES = new Set(['fm1', 'output', 'steps', 'part', ...EDITOR_ONLY]);
/** module types whose card display is an envelope shape the FM-1 draws */
export const ENVELOPES = new Set(['adsr', 'env']);
/** how far right a card may start and still be in the column of the card above it (half a card, as tidy.ts reads it) */
const COLUMN_SLACK = 150;

export interface PageRow { module: number; param: string; label: string }
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
}

/** a page's title as the editor and the FM-1 show it: the name, and "2/3" when its group spans pages */
export const pageTitle = (pg: Page): string => (pg.parts > 1 ? `${pg.name} ${pg.part + 1}/${pg.parts}` : pg.name);

interface Group { name: string; rows: PageRow[]; displays: { module: number; at: number }[] }

/** cut a heading's rows into pages of PAGE_ROWS and put each envelope shape on the page that holds its rows */
function paginate(groups: Group[], typeOf: (id: number) => string | undefined): Page[] {
  const out: Page[] = [];
  for (const g of groups) {
    if (!g.rows.length) continue;
    const parts = Math.ceil(g.rows.length / PAGE_ROWS);
    const pages: Page[] = Array.from({ length: parts }, (_, i) => ({ name: g.name, part: i, parts, rows: g.rows.slice(i * PAGE_ROWS, (i + 1) * PAGE_ROWS) }));
    for (const d of g.displays) {
      if (!ENVELOPES.has(typeOf(d.module) ?? '')) continue;
      const own = pages.findIndex((pg) => pg.rows.some((r) => r.module === d.module));
      const pg = pages[own >= 0 ? own : Math.min(parts - 1, Math.floor(d.at / PAGE_ROWS))];
      pg.display ??= d.module;
    }
    out.push(...pages);
  }
  return out;
}

/** a plain module's rows: every parameter (never the ones set from its screen) */
function moduleGroups(type: string, def: ModuleDef, id: number): Group[] {
  // the spelled-out name, or the short one where that would not fit the FM-1's screen
  const label = (name: string): string => { const long = longName(type, name); return long.length <= NAME_MAX ? long : name; };
  const rows = def.params.filter((pd) => !pd.onScreen && !pd.screen).map((pd) => ({ module: id, param: pd.name, label: label(pd.name) }));
  const displays = ENVELOPES.has(type) ? [{ module: id, at: 0 }] : [];
  return [{ name: moduleName(type, def.label), rows, displays }];
}

/** an assembly's rows: its promoted parameters, cut into groups at the headings */
function assemblyGroups(p: Patch, a: AssemblyInst, defs: Record<string, ModuleDef>): Group[] {
  const groups: Group[] = [{ name: a.label, rows: [], displays: [] }];
  for (const r of a.params) {
    const m = p.modules.find((x) => x.id === r.module);
    const def = m && defs[m.type];
    const pd = def && rowDef(def, r.param);
    if (!m || !pd || pd.onScreen) continue;
    if (r.head) groups.push({ name: r.head, rows: [], displays: [] });
    const g = groups[groups.length - 1];
    if (pd.screen) g.displays.push({ module: m.id, at: g.rows.length });
    else g.rows.push({ module: m.id, param: r.param, label: r.label });
  }
  return groups;
}

/** where a top-level item sits on the canvas: a collapsed card's corner, an open frame's first member */
function placeOf(p: Patch, a: AssemblyInst): { x: number; y: number } {
  if (!a.open) return { x: a.x, y: a.y };
  const ms = allModules(p, a).map((id) => p.modules.find((m) => m.id === id)).filter((m) => !!m);
  return ms.length ? { x: Math.min(...ms.map((m) => m!.x)), y: Math.min(...ms.map((m) => m!.y)) } : { x: a.x, y: a.y };
}

/** the patch's devices in reading order (see the top of this file) */
export function devicesOf(p: Patch, defs: Record<string, ModuleDef>): Device[] {
  const inAsm = new Set(assembliesOf(p).flatMap((a) => a.modules));
  const typeOf = (id: number): string | undefined => p.modules.find((m) => m.id === id)?.type;
  const items: { x: number; y: number; dev: Device }[] = [];
  for (const m of p.modules) {
    if (inAsm.has(m.id) || NOT_DEVICES.has(m.type) || !defs[m.type]) continue;
    const pages = paginate(moduleGroups(m.type, defs[m.type], m.id), typeOf);
    if (pages.length) items.push({ x: m.x, y: m.y, dev: { key: `m${m.id}`, name: moduleName(m.type, defs[m.type].label), module: m.id, pages } });
  }
  for (const a of assembliesOf(p)) {
    if (parentOf(p, a.id)) continue;
    const pages = paginate(assemblyGroups(p, a, defs), typeOf);
    if (pages.length) items.push({ ...placeOf(p, a), dev: { key: `a${a.id}`, name: a.label, asm: a.id, pages } });
  }
  // columns from the left; a card joins the column of the first card in it while it starts within half a card of it
  const cols: (typeof items)[] = [];
  for (const it of [...items].sort((u, v) => u.x - v.x || u.y - v.y)) {
    const col = cols[cols.length - 1];
    if (col && it.x < col[0].x + COLUMN_SLACK) col.push(it);
    else cols.push([it]);
  }
  return cols.flatMap((col) => col.sort((u, v) => u.y - v.y || u.x - v.x).map((it) => it.dev));
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
  if (!d) return { device: devices[0].key, page: 0 };
  return { device: d.key, page: Math.max(0, Math.min(d.pages.length - 1, focus!.page)) };
}
