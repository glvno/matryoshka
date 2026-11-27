// SPDX-License-Identifier: GPL-3.0-only
import { keyReach } from './key-routing';
// Devices and their pages: what the FM-1 lets you play with K1..K4, and what Main's knobs in the editor's dock turn.
//
// Every top-level thing on the canvas, a module or an assembly, is a device (docs/ledger/vocabulary.md "Device"), unless it is editor-only
// (a Scope) or a Part; one with no rows is left out too. Devices come in the environment's grouped order (#196): Main
// first; then each Steps track (its page: LEN RATE SWING GATE) followed by the devices it drives (a cable from it, or from
// an Arpeggiator it plays through, into them); an assembly with a Steps track inside (the kits' DRUMS) is that track's
// device: it stands where a track does, driven by its own track, and its card's rows are its pages. Then the others (an
// Arpeggiator among them, never where a patch opens); the Output last. Tracks and the rest go in the canvas's reading order (columns from the left,
// a card within half a card of a column's first card in it, each column from the top). A device's rows are the rows
// of its collapsed card: an assembly's promoted parameters, a plain module's every parameter. A heading starts a section;
// a section holds groups of at most PAGE_ROWS rows (`groupStarts`), and each group is one page ("Filter 2/2" = the
// section's second group). Groups fill in fours; a row's `group` flag (Arrange's "new group") or a column break ends one
// early. An envelope's shape on the card (adsr / env `view`) is drawn above the page that holds its rows. Pure model code: the editor, the binary
// format (patchbin.ts) and the tests use it.
import { assembliesOf, childrenOf, copyStarts, deviceModules, drawerOf, drawers, effectsOf, outputDrawer, parentOf, ties, type AssemblyInst, type RowTarget } from './assembly';
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
/** how far right a card may start and still be in the column of the card above it (half a card) */
const COLUMN_SLACK = 150;

export interface PageRow {
  module: number;
  param: string;
  label: string;
  /** the further parameters the row sets (#357: its card row's, and those tied to it through nested cards) */
  also?: RowTarget[];
  /** its positions' names (#358: a Selector's, from its card row) */
  names?: string[];
  /** the FM-1's top for a Voice allocator's voices row (ParamRef.top): the most voices its VOICES row offers */
  top?: number;
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
  /** a DX7 voice page the FM-1 adds itself after an assembly device's pages (DX7_CARD_SECTIONS): not in the binary's list */
  voice?: true;
}
export interface Device {
  /** `a<id>` for an assembly, `m<id>` for a module (stable while the patch is edited) */
  key: string;
  name: string;
  /** the assembly, or the module, it is */
  asm?: number;
  module?: number;
  pages: Page[];
  /** Main, a Steps track, an Arpeggiator, a Harmonizer or the Output (else an instrument, an effect, ...) */
  kind?: 'main' | 'steps' | 'arp' | 'harm' | 'output';
  /** the Steps track (module id) that drives it: it follows the track in the environment (#196). On a card with a track
   * inside, that track: the card drives itself (the binary's track byte is the card's own index) */
  track?: number;
}

/** where focus goes on a fresh patch: its first instrument, the first device that is not Main, a Steps track, an
 *  Arpeggiator, a Harmonizer or the Output (a Tidy puts a Harmonizer before the instrument it plays, D-1458), else the
 *  first. The FM-1's pages_home is the same */
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

/** a DX7's voice rows (#1338): their PageRow.param is `voice.<field>`, a value of the module's voice (ModuleInst.voice), not a
 *  parameter; the FM-1 turns them (pages_ui.c dx7_page, VOICE_NOW), the editor's card edits them */
export const VOICE_ROW = 'voice.';
export const isVoiceRow = (param: string): boolean => param.startsWith(VOICE_ROW);
/** a DX7's pages, as pages_ui.c dx7_page builds them (the same 13 pages, so FOCUS agrees): sections of groups of rows, a
 *  row a parameter or `field:label` of a voice row. The operator pages show the operator the FM-1's picker (`op`) picked */
const DX7_SECTIONS: [string, string[][]][] = [
  ['', [['level', 'tune', 'mod', 'ops'], ['range', 'dest', 'alg:algorithm', 'fb:feedback']]],
  ['operator', [['op:op', 'level:out level', 'coarse:coarse', 'fine:fine'], ['mode:mode', 'detune:detune', 'vel:velocity', 'ams:ams'],
    ['r1:rate 1', 'r2:rate 2', 'r3:rate 3', 'r4:rate 4'], ['l1:level 1', 'l2:level 2', 'l3:level 3', 'l4:level 4'],
    ['bp:break', 'ld:l depth', 'rd:r depth', 'lc:l curve'], ['rc:r curve', 'rs:rate scale']]],
  ['pitch eg', [['pr1:rate 1', 'pr2:rate 2', 'pr3:rate 3', 'pr4:rate 4'], ['pl1:level 1', 'pl2:level 2', 'pl3:level 3', 'pl4:level 4']]],
  ['lfo', [['wave:wave', 'speed:speed', 'delay:delay', 'sync:sync'], ['pmd:pmd', 'amd:amd', 'pms:pms', 'oks:osc sync']]],
  ['voice', [['transpose:transpose']]],
];
/** the voice pages the FM-1 adds after the pages of an assembly device holding exactly one DX7 (a poly DX7 in its card;
 *  pages_ui.c pages_dx7_cards): a page DX7 with the algorithm and feedback, then the operator, pitch EG, LFO and voice */
const DX7_CARD_SECTIONS: [string, string[][]][] = [['dx7', [['alg:algorithm', 'fb:feedback']]], ...DX7_SECTIONS.slice(1)];
/** a DX7's sections (DX7_SECTIONS or DX7_CARD_SECTIONS) for module `id`, the first named `device` when it has no name */
const dx7Sections = (list: [string, string[][]][], id: number, device: string, label: (name: string) => string): Section[] =>
  list.map(([head, groups]) => ({ name: head || device, groups: groups.map((g) => ({ displays: [], rows: g.map((r) => {
    const [field, l] = r.split(':');
    return l === undefined ? { module: id, param: field, label: label(field) } : { module: id, param: VOICE_ROW + field, label: l };
  }) })) }));

/** a plain module's sections: one, its parameters in groups of four */
function moduleSections(type: string, def: ModuleDef, id: number, name?: string): Section[] {
  // the spelled-out name, or the short one where that would not fit the FM-1's screen
  const label = (name: string): string => { const long = longName(type, name); return long.length <= NAME_MAX ? long : name; };
  const device = name || moduleName(type, def.label);
  if (type === 'dx7') return dx7Sections(DX7_SECTIONS, id, device, label);
  // a Matrix (#525): a section per output, "out 1".."out 4", its four pins (pages_ui.c pages_plain the same)
  const items = moduleRows(def).map((pd, i) => ({ pd, knob: !pd.screen, head: type === 'matrix' && i % PAGE_ROWS === 0 ? `out ${i / PAGE_ROWS + 1}` : undefined }));
  return sectionsOf(device, items, ({ pd }) => (pd.screen ? id : { module: id, param: pd.name, label: label(pd.name) }));
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
    if (it.r.top !== undefined) row.top = it.r.top;
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
  const ms = deviceModules(p, a).map((id) => p.modules.find((m) => m.id === id)).filter((m) => !!m);
  return ms.length ? { x: Math.min(...ms.map((m) => m!.x)), y: Math.min(...ms.map((m) => m!.y)) } : { x: a.x, y: a.y };
}

const typeIn = (p: Patch) => (id: number): string | undefined => p.modules.find((m) => m.id === id)?.type;
/** a plain module's pages, as its device would have them (the patch card draws them for any module) */
export const modulePages = (p: Patch, m: ModuleInst, defs: Record<string, ModuleDef>): Page[] =>
  defs[m.type] ? paginate(moduleSections(m.type, defs[m.type], m.id, m.name), typeIn(p)) : [];
/** an assembly's pages, as its device would have them (the patch card draws them for a nested one too) */
export const assemblyPages = (p: Patch, a: AssemblyInst, defs: Record<string, ModuleDef>): Page[] => paginate(assemblySections(p, a, defs), typeIn(p));

/** The drum maps that actually trigger an assembly, and the Steps tracks whose keys reach them.
 * Audio and velocity/control cables cannot claim pattern ownership. keyReach is bounded by a visited set. */
function drumDrivers(p: Patch, members: Set<number>, defs: Record<string, ModuleDef>): number[] | undefined {
  const maps = p.modules.filter((m) => m.type === 'drummap' && p.cables.some((c) =>
    c.from.module === m.id && /^g[1-8]$/.test(c.from.port) && members.has(c.to.module) &&
    defs[p.modules.find((m) => m.id === c.to.module)?.type ?? '']?.inputs.some((port) => port.name === c.to.port && port.kind === 'gate')));
  if (!maps.length) return undefined;
  return p.modules.filter((m) => m.type === 'steps' && maps.some((map) => keyReach(p, m.id).has(map.id))).map((m) => m.id);
}

/** Pattern replacement needs one note/gate driver; control-only environment grouping grants no permission. */
export function patternDriver(p: Patch, a: AssemblyInst, defs: Record<string, ModuleDef>): number | undefined {
  const members = new Set(deviceModules(p, a));
  const mapped = drumDrivers(p, members, defs);
  // (Drum maps that no track reaches drive nothing: the other rules decide, as pages_ui.c dp_pattern_module does)
  if (mapped?.length) return mapped.length === 1 ? mapped[0] : undefined;
  const tracks = p.modules.filter((m) => m.type === 'steps' && p.cables.some((c) => {
    if (!members.has(c.to.module) || !keyReach(p, m.id).has(c.from.module)) return false;
    if (c.from.port === 'keys' && c.to.port === 'keys') return true;
    const source = p.modules.find((x) => x.id === c.from.module);
    return source && ['steps', 'arp', 'harm'].includes(source.type) &&
      defs[source.type]?.outputs.some((port) => port.name === c.from.port && port.kind === 'gate') &&
      defs[p.modules.find((x) => x.id === c.to.module)?.type ?? '']?.inputs.some((port) => port.name === c.to.port && port.kind === 'gate');
  }));
  return tracks.length === 1 ? tracks[0].id : undefined;
}

/** the Steps track inside top-level card `a`, which makes the card that track's device, driven by it (the kits' DRUMS,
 *  #1202 K2, D-1062); undefined: none */
export const cardTrack = (p: Patch, a: AssemblyInst): number | undefined =>
  deviceModules(p, a).find((id) => p.modules.find((m) => m.id === id)?.type === 'steps');
/** the patch has a card that is its own track's device: firmware without INFO byte 25 bit 0 (1.25) does not treat it as
 *  the track (no P-lock pages for it), so the editor does not send it there (D-1062) */
export const holdsTrackCard = (p: Patch, defs: Record<string, ModuleDef>): boolean =>
  assembliesOf(p).some((a) => !parentOf(p, a.id) && cardTrack(p, a) !== undefined && assemblyPages(p, a, defs).length > 0);

/** an assembly's device pages: its own, then those of the children it shows as embedded cards (`cards`); holding exactly
 *  one DX7 (a poly DX7 in its card, #1338), then that DX7's voice pages, which the FM-1 adds itself (pages_ui.c
 *  pages_dx7_cards) */
function devicePages(p: Patch, a: AssemblyInst, defs: Record<string, ModuleDef>): Page[] {
  const own = [...assemblyPages(p, a, defs), ...childrenOf(p, a).filter((c) => a.cards?.includes(c.id) && !c.drawer).flatMap((c) => assemblyPages(p, c, defs))];
  const dx7 = deviceModules(p, a).filter((id) => p.modules.find((m) => m.id === id)?.type === 'dx7');
  if (!own.length || dx7.length !== 1) return own;
  return [...own, ...paginate(dx7Sections(DX7_CARD_SECTIONS, dx7[0], 'dx7', (n) => n), typeIn(p)).map((pg): Page => ({ ...pg, voice: true }))];
}

/** the patch's devices in the environment's grouped order (see the top of this file). An FX drawer is never a device: each
 *  of its effects is one, right after its instrument (the Output drawer's right before the Output), in chain order; an
 *  instrument's device leaves its drawer out (deviceModules) */
export function devicesOf(p: Patch, defs: Record<string, ModuleDef>): Device[] {
  const inAsm = new Set(assembliesOf(p).flatMap((a) => a.modules));
  const items: { x: number; y: number; dev: Device }[] = [];
  const KINDS: Record<string, Device['kind']> = { fm1: 'main', steps: 'steps', arp: 'arp', harm: 'harm', output: 'output' };
  for (const m of p.modules) {
    if (inAsm.has(m.id) || NOT_DEVICES.has(m.type) || !defs[m.type]) continue;
    const pages = modulePages(p, m, defs);
    const name = m.name || moduleName(m.type, defs[m.type].label);   // its own name (#518; a Steps track's), else its type's
    if (pages.length) items.push({ x: m.x, y: m.y, dev: { key: `m${m.id}`, name, module: m.id, pages, ...(KINDS[m.type] ? { kind: KINDS[m.type] } : {}) } });
  }
  for (const a of assembliesOf(p)) {
    if (parentOf(p, a.id) || a.drawer) continue;
    const pages = devicePages(p, a, defs);
    const inner = cardTrack(p, a);
    if (pages.length) items.push({ ...placeOf(p, a), dev: { key: `a${a.id}`, name: a.label, asm: a.id, pages, ...(inner !== undefined ? { track: inner } : {}) } });
  }
  // each drawer's effects as devices, in chain order
  const effectDevices = (d: AssemblyInst | undefined): Device[] => (d ? effectsOf(p, d) : []).flatMap((e) => {
    const pages = assemblyPages(p, e, defs);
    return pages.length ? [{ key: `a${e.id}`, name: e.label, asm: e.id, pages }] : [];
  });
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
  for (const d of reading) for (const id of d.asm !== undefined ? deviceModules(p, assembliesOf(p).find((a) => a.id === d.asm)!) : [d.module!]) deviceOf.set(id, d);
  const drums = new Map(reading.filter((d) => d.asm !== undefined).map((d) =>
    [d, drumDrivers(p, new Set(deviceModules(p, assembliesOf(p).find((a) => a.id === d.asm)!)), defs)]));
  const out: Device[] = reading.filter((d) => d.kind === 'main');
  const placed = new Set<Device>(out);
  // (a card with its own track is its track's device, never driven by another track)
  const tracks = reading.filter((d) => d.kind === 'steps' || (d.asm !== undefined && d.track !== undefined));
  for (const t of tracks) {
    out.push(t);
    placed.add(t);
    const track = t.module ?? t.track!;
    // (a cable from it, or from an Arpeggiator it plays through)
    const from = new Set([...keyReach(p, track)].filter(id => ['steps', 'harm', 'arp'].includes(p.modules.find(m => m.id === id)?.type ?? '')));
    const direct = (d: Device): boolean => p.cables.some((c) => from.has(c.from.module) && deviceOf.get(c.to.module) === d);
    const driven = reading.filter((d) => !placed.has(d) && (!d.kind || d.kind === 'harm') && !tracks.includes(d) && (direct(d) ||
      (drums.get(d)?.length === 1 && drums.get(d)![0] === track)));
    // Keep directly connected pages (the external Drum map) before the kit reached through that map.
    driven.sort((a, b) => Number(!direct(a)) - Number(!direct(b)));
    for (const d of driven) {
      d.track = track;
      out.push(d);
      placed.add(d);
    }
  }
  out.push(...reading.filter((d) => !placed.has(d) && d.kind !== 'output'));
  out.push(...reading.filter((d) => d.kind === 'output'));
  // (the effects go in last, so no rule above places them: each instrument's right after it, the Output drawer's before the
  // Output, with those of an instrument that is no device itself)
  const placedDrawers = new Set<number>();
  const withFx = out.flatMap((d) => {
    const drawer = d.asm !== undefined ? drawerOf(p, d.asm) : undefined;
    if (drawer) placedDrawers.add(drawer.id);
    return [d, ...effectDevices(drawer)];
  });
  const rest = drawers(p).filter((a) => a.drawer!.taps && !placedDrawers.has(a.id));
  const output = [...rest, outputDrawer(p)].flatMap(effectDevices);
  const at = withFx.findIndex((d) => d.kind === 'output');
  withFx.splice(at < 0 ? withFx.length : at, 0, ...output);
  return withFx;
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
