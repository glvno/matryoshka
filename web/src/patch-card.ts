// SPDX-License-Identifier: GPL-3.0-only
// The patch card (glvno/matryoshka#163): a 1200 x 900 PNG of the patch, drawn from the patch data (never a screenshot of
// the page), for a post. Always the dark theme, whatever the app shows: the colours are the dark tokens of tokens.css,
// copied here once (patch-card.test.ts checks they still match). Header: MATRYOSHKA PATCH, the title, the notes, "by"
// and the engines; the map: the canvas's top-level cards (collapsed assemblies and the modules not inside one) in their
// saved arrangement, each box showing what a player knows it by (an engine's blurb, its pages of knobs as the FM-1 has
// them, pages.ts, as bars with their values; less per box on a busy map), with the cables between them in their role
// colours (cable-role.ts); footer: the counts, the FM-1 fit and "play it: link in the comments". cardLayout is pure
// (tests run it in node); renderPatchCard draws.
import { FACTORY } from './assemblies';
import { allModules, assembliesOf, findRef, hiddenAssemblies, hiddenModules, paramColumns, parentOf, type AssemblyInst } from './assembly';
import { cableRole, type CableRole } from './cable-role';
import { instIsEngine } from './engines';
import { choiceName, formatValue, moduleName } from './labels';
import { DEFS, rowRange } from './modules';
import { deviceBudget } from './patchbin';
import { assemblyPages, modulePages, pageTitle, PAGE_ROWS } from './pages';
import { rowDef, toUnit, type ModuleDef, type ModuleInst, type Patch } from './patch';

export const CARD_W = 1200, CARD_H = 900;
const PAD = 56;
/** the header's baselines: the title, the first line of notes (and the lines' step); the footer's top */
const TITLE_Y = 145, NOTES_Y = 181, NOTE_LH = 26, FOOTER_Y = CARD_H - PAD - 36;
/** the margin inside the map; the dock's height (the Main module, along the map's bottom) */
const MAP_IN = 24, DOCK_H = 26;
/** a small patch is not blown up past this (a real card is 236 px wide on the canvas) */
const MAX_SCALE = 0.8;
/** a box's label: its font size, the room either side, and a generous width per (upper-case, condensed) character */
export const LABEL_PX = 13, LABEL_PAD = 8, LABEL_CHAR = 8;

/** the dark theme's tokens (tokens.css, `:root[data-theme="dark"]` and the --ref-* palette) */
export const DARK = {
  bg: '#171f21', // --ref-night
  panel: '#202a2c', // --ref-ink
  ink: '#fff7e8', // --ref-ivory
  muted: '#b4b8ad', // --ref-mist
  line: '#344345', // --ref-slate
  stone: '#63695f', // the card border, a step under --muted
  accent: '#e7775d', // --ref-coral: the signal cables
  secondary: '#79c7c1', // --ref-seafoam: modulation
  gate: '#e8b65a', // --ref-gold: gates, triggers, clocks
  map: '#1b2426', // the map's ground, between --ref-night and --ref-ink
} as const;

/** a row of a box: a parameter as the card's bar shows it, its name, its value and where the value sits in its range */
export interface CardRow { label: string; value: string; u: number }
/** a page of a box (pages.ts: what the FM-1 shows on K1..K4) */
export interface CardPage { title: string; rows: CardRow[] }
/** a page placed in its box: its column's left edge and width, its top; only the rows that fit */
export interface PlacedPage extends CardPage { x: number; y: number; w: number; titleH: number }
/** how much a box shows: its pages with titles and sliders; its rows without page titles, smaller; its name only */
export type Detail = 'full' | 'compact' | 'names';
export type Pt = { x: number; y: number };
export type Rect = { x: number; y: number; w: number; h: number };
export interface CardBox extends Rect {
  label: string;
  kind: 'module' | 'assembly' | 'frame' | 'dock';
  /** an engine's one-line description (its factory definition's blurb), when the box has room for it */
  blurb?: string;
  /** the pages drawn inside, placed */
  pages?: PlacedPage[];
}
/** a cable; `dock`: which end is at the dock (it leaves or meets the dock's top edge, not a side) */
export interface CardLine { from: Pt; to: Pt; role: CableRole; dock?: 'from' | 'to' }
export interface CardLayout { map: Rect; boxes: CardBox[]; lines: CardLine[]; scale: number; detail: Detail }

/** a card's size on the canvas, estimated from its rows (the editor measures the DOM; the card has none) */
function moduleSize(def: ModuleDef | undefined): { w: number; h: number } {
  if (!def) return { w: 236, h: 120 };
  // The preview draws rows, not ports. Undisplayed ports/rows must not shrink neighboring cards.
  const rows = Math.min(def.params.length, MODULE_PAGES * PAGE_ROWS) + (def.views?.length ?? 0);
  return { w: 236, h: Math.min(540, Math.max(90, 44 + 26 * rows)) };
}
function assemblySize(a: AssemblyInst): { w: number; h: number } {
  const cols = paramColumns(a.params);
  const rows = Math.max(1, ...cols.map((c) => c.length), Math.ceil(Math.max(a.inputs.length, a.outputs.length) / 2));
  return { w: cols.length > 1 ? cols.length * 320 - 20 : 236, h: Math.min(540, 50 + 30 * rows) };
}

/** `text` cut to fit `width` at about `charW` per character, with an ellipsis; '' when not even one letter fits */
export function cutLabel(text: string, width: number, charW = LABEL_CHAR): string {
  const n = Math.floor(width / charW);
  if (text.length <= n) return text;
  return n >= 2 ? `${text.slice(0, n - 1).trimEnd()}…` : '';
}

/** the map's top on the card: under the title, or under its notes (up to three lines) */
export const mapTop = (noteLines: number): number => (noteLines > 0 ? NOTES_Y + (Math.min(3, noteLines) - 1) * NOTE_LH + 30 : TITLE_Y + 42);
/** about how many lines the notes wrap to on the card (the renderer counts them exactly and passes its count) */
export const noteLinesOf = (p: Patch): number => {
  const n = notesOf(p).length;
  return n ? Math.min(3, Math.ceil(n / 100)) : 0;
};
const notesOf = (p: Patch): string => (typeof p.notes === 'string' ? p.notes.trim() : '');

/** a box's insides: the name's band, the blurb's line, the side padding, the room under the last row */
export const HEAD_H = 28, BLURB_H = 17, BOX_PAD = 10, BOX_FOOT = 8;
/** a page's title band (full detail only); a row's height and its bar's; a column's width and the gaps */
export const PAGE_TITLE_H = { full: 15, compact: 0, names: 0 } as const;
/** a band's title height: none when no page in it has a title */
const titleH = (band: CardPage[], detail: Detail): number => (band.some((pg) => pg.title) ? PAGE_TITLE_H[detail] : 0);
export const ROW_H = { full: 22, compact: 19, names: 0 } as const;
export const BAR_H = { full: 18, compact: 16, names: 0 } as const;
const COL_W = { full: 160, compact: 128, names: 0 } as const;
const COL_GAP = 12, BAND_GAP = 8;
/** pages a natural box puts side by side; a module shows its first pages only (its main parameters) */
const NATURAL_COLS = { full: 5, compact: 3, names: 0 } as const;
const MODULE_PAGES = 2;
/** the gap kept between two boxes; the smallest a box is cut to */
const BOX_GAP = 10, MIN_W = 40, MIN_H = 24;

/** the detail for a map of `n` boxes: the Demo (dozens) gets rows without page titles, a huge patch names only */
export const detailFor = (n: number): Detail => (n <= 12 ? 'full' : n <= 40 ? 'compact' : 'names');

/** a parameter's value as the card shows it (editor.ts param rows: the choice's name, the number and its unit) */
function rowOf(type: string, def: ModuleDef, params: Record<string, number>, param: string, label: string, names?: string[]): CardRow | null {
  const own = rowDef(def, param);
  if (!own || own.screen || own.onScreen) return null;
  const pd = rowRange(type, params, own);   // (a Selector's positions in use, #358)
  const v = params[param] ?? pd.default;
  let value: string;
  let u: number;
  if (names?.[Math.round(v) - pd.min]) {   // a Selector's position by its card row's name (#358)
    value = names[Math.round(v) - pd.min];
    u = toUnit(pd, v);
  } else if (pd.altText && (params[pd.altText.when] ?? 0) >= 0.5) {
    value = pd.altText.text(v, params);
    u = toUnit(pd, v);
  } else if (pd.choices) {
    const i = Math.max(0, Math.min(pd.choices.length - 1, Math.round(v)));
    value = choiceName(type, pd.name, pd.choices[i] ?? '');
    u = pd.choices.length > 1 ? i / (pd.choices.length - 1) : 0;
  } else if (pd.toggle) {
    value = v >= 0.5 ? 'on' : 'off';
    u = v >= 0.5 ? 1 : 0;
  } else {
    const f = formatValue(v, pd.unit, pd.min < 0);
    value = f.unit ? `${f.num} ${f.unit}` : f.num;
    u = toUnit(pd, v);
  }
  return { label, value, u: Number.isFinite(u) ? Math.min(1, Math.max(0, u)) : 0 };
}

/** a box's pages with their rows' values: an assembly's pages, a module's first ones. A page named after the box (a plain
 *  module's, an assembly's rows before its first heading) has no title: the box's name says it. */
function pagesOf(p: Patch, defs: Record<string, ModuleDef>, item: { asm?: AssemblyInst; module?: ModuleInst; label: string }): CardPage[] {
  const pages = item.asm ? assemblyPages(p, item.asm, defs) : item.module ? modulePages(p, item.module, defs).slice(0, MODULE_PAGES) : [];
  return pages.flatMap((pg) => {
    const rows = pg.rows.flatMap((r) => {
      const m = p.modules.find((x) => x.id === r.module);
      const def = m && defs[m.type];
      const row = m && def && rowOf(m.type, def, m.params, r.param, r.label, r.names);
      return row ? [row] : [];
    });
    return rows.length ? [{ title: pg.name.toUpperCase() === item.label ? '' : pageTitle(pg), rows }] : [];
  });
}

/** a factory engine's blurb, by the name it was inserted as */
const blurbOf = (a: AssemblyInst): string | undefined => FACTORY.find((d) => d.name === a.name)?.blurb;

/** the height `pages` take laid out `cols` side by side */
function bandsHeight(pages: CardPage[], cols: number, detail: Detail): number {
  let h = 0;
  for (let i = 0; i < pages.length; i += cols) {
    const rows = Math.max(...pages.slice(i, i + cols).map((pg) => pg.rows.length));
    h += (h ? BAND_GAP : 0) + titleH(pages.slice(i, i + cols), detail) + rows * ROW_H[detail];
  }
  return h;
}

/** the size a box's content wants: its name, its blurb, its pages side by side (up to NATURAL_COLS, then in bands) */
function naturalSize(label: string, blurb: string | undefined, pages: CardPage[], detail: Detail): { w: number; h: number } {
  const nameW = label.length * LABEL_CHAR + 2 * LABEL_PAD;
  const blurbW = blurb ? Math.min(360, blurb.length * 6.6 + 2 * BOX_PAD) : 0;
  const top = HEAD_H + (blurb ? BLURB_H : 0);
  if (detail === 'names' || !pages.length) return { w: Math.max(nameW, blurbW, 90), h: top + 6 };
  const cols = Math.min(pages.length, NATURAL_COLS[detail]);
  const w = 2 * BOX_PAD + cols * COL_W[detail] + (cols - 1) * COL_GAP;
  return { w: Math.max(w, nameW, blurbW), h: top + bandsHeight(pages, cols, detail) + BOX_FOOT };
}

/** how many pages side by side a box of width `w` takes */
const colsIn = (w: number, n: number, detail: Detail): number =>
  Math.min(n, Math.max(1, Math.floor((w - 2 * BOX_PAD + COL_GAP) / (COL_W[detail] + COL_GAP))));

/** the pages placed inside a box of its final size: as many columns as its width takes, bands down while rows fit */
function placePages(b: Rect, top: number, pages: CardPage[], detail: Detail): PlacedPage[] {
  const iw = b.w - 2 * BOX_PAD;
  if (detail === 'names' || !pages.length || iw < 70) return [];
  const colW = COL_W[detail];
  const cols = colsIn(b.w, pages.length, detail);
  const cw = Math.min(colW * 1.3, (iw - (cols - 1) * COL_GAP) / cols);
  const bottom = b.y + b.h - BOX_FOOT + (ROW_H[detail] - BAR_H[detail]);
  const out: PlacedPage[] = [];
  let y = top;
  for (let i = 0; i < pages.length; i += cols) {
    const band = pages.slice(i, i + cols);
    const th = titleH(band, detail);
    const fit = Math.min(Math.max(...band.map((pg) => pg.rows.length)), Math.floor((bottom - y - th) / ROW_H[detail]));
    if (fit < 1) break;
    band.forEach((pg, k) => out.push({ title: pg.title, titleH: th, rows: pg.rows.slice(0, fit), x: b.x + BOX_PAD + k * (cw + COL_GAP), y, w: cw }));
    y += th + fit * ROW_H[detail] + BAND_GAP;
  }
  return out;
}

/** how far right a card may start and still be in the column of the card above it (pages.ts reads columns the same way) */
const COLUMN_SLACK = 150;

/**
 * The boxes' left edges, column by column (the canvas's columns, as pages.ts reads them): every column gets its widest
 * box's width, or an equal cut of the map's width when they do not all fit (the narrow ones keep theirs), and starts at
 * its scaled place on the canvas, or right after the column before it. A box keeps its own width: where it runs into the
 * next column's boxes, `separate` cuts it back.
 */
function packColumns(items: { x: number; y: number }[], rects: Rect[], ix0: number, ix1: number): void {
  const cols: number[][] = [];
  for (const i of items.map((_, i) => i).sort((a, b) => items[a].x - items[b].x || items[a].y - items[b].y)) {
    const col = cols[cols.length - 1];
    if (col && items[i].x < items[col[0]].x + COLUMN_SLACK) col.push(i);
    else cols.push([i]);
  }
  if (!cols.length) return;
  const want = cols.map((c) => Math.max(...c.map((i) => rects[i].w)));
  const room = ix1 - ix0 - (cols.length - 1) * BOX_GAP;
  let cap = Math.max(...want);
  if (want.reduce((a, w) => a + w, 0) > room) {
    let lo = 0, hi = cap;
    for (let k = 0; k < 40; k++) {
      const mid = (lo + hi) / 2;
      if (want.reduce((a, w) => a + Math.min(w, mid), 0) <= room) lo = mid;
      else hi = mid;
    }
    cap = lo;
  }
  const w = want.map((x) => Math.min(x, cap));
  const x = cols.map((c) => Math.min(...c.map((i) => rects[i].x)));
  for (let k = 0; k < cols.length; k++) x[k] = Math.max(x[k], ix0, k ? x[k - 1] + w[k - 1] + BOX_GAP : ix0);
  for (let k = cols.length - 1, bound = ix1; k >= 0; k--) {
    x[k] = Math.min(x[k], bound - w[k]);
    bound = x[k] - BOX_GAP;
  }
  cols.forEach((c, k) => {
    for (const i of c) rects[i].x = x[k];
  });
}

const overlaps = (a: Rect, b: Rect, gap: number): boolean => a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;

/**
 * Boxes that run into each other are cut back, never moved: of the two, the one whose edge would meet the other's corner
 * gives up width or height, whichever keeps more of it.
 */
function separate(boxes: Rect[], gap: number): void {
  for (let pass = 0; pass < 6; pass++) {
    let changed = false;
    for (const a of boxes)
      for (const b of boxes) {
        if (a === b || !overlaps(a, b, gap)) continue;
        // options: cut the box on the left (or above) back to the other's left (or top) edge
        const opts: { box: Rect; dim: 'w' | 'h'; to: number }[] = [];
        if (b.x > a.x) opts.push({ box: a, dim: 'w', to: b.x - a.x - gap });
        if (a.x > b.x) opts.push({ box: b, dim: 'w', to: a.x - b.x - gap });
        if (b.y > a.y) opts.push({ box: a, dim: 'h', to: b.y - a.y - gap });
        if (a.y > b.y) opts.push({ box: b, dim: 'h', to: a.y - b.y - gap });
        if (!opts.length) {
          opts.push({ box: b, dim: 'h', to: MIN_H }); // two boxes at one place: the second gives way
        }
        const kept = (o: (typeof opts)[number]): number => (o.to >= (o.dim === 'w' ? MIN_W : MIN_H) ? o.to / o.box[o.dim] : -1 + o.to / o.box[o.dim]);
        const best = opts.reduce((x, y) => (kept(y) > kept(x) ? y : x));
        best.box[best.dim] = Math.max(4, best.to);
        changed = true;
      }
    if (!changed) break;
  }
}

/**
 * The map in card coordinates: one box per top-level card (a collapsed assembly that is not inside another collapsed one,
 * a module not inside a collapsed assembly), a dashed frame per open assembly around its cards, the Main module as the
 * dock along the bottom (where the app shows it), and a line per cable between two different boxes (a cable inside one
 * box is left out; equal ones drawn once). The boxes keep the canvas's arrangement (its places, scaled to fit, from the
 * cards' estimated sizes: the patch keeps no sizes); each is then sized to its content (its name, an engine's blurb, its
 * pages of sliders as the FM-1 has them), cut back where it would run into another or out of the map, and filled with
 * the pages that fit. The more boxes, the less each shows (`detailFor`). `noteLines`: how many lines of notes the header
 * shows.
 */
export function cardLayout(p: Patch, defs: Record<string, ModuleDef>, noteLines = noteLinesOf(p)): CardLayout {
  const top = mapTop(noteLines);
  const map = { x: PAD, y: top, w: CARD_W - 2 * PAD, h: FOOTER_Y - 22 - top };
  const hiddenM = hiddenModules(p);
  const hiddenA = hiddenAssemblies(p);
  type Item = { x: number; y: number; w: number; h: number; label: string; kind: 'module' | 'assembly'; asm?: AssemblyInst; module?: ModuleInst };
  const items: Item[] = [];
  const owner = new Map<number, number>(); // module id -> item index; -1: the dock
  const main = p.modules.find((m) => m.type === 'fm1' && !hiddenM.has(m.id));
  if (main) owner.set(main.id, -1);
  for (const m of p.modules) {
    if (hiddenM.has(m.id) || m === main) continue;
    const def = defs[m.type];
    owner.set(m.id, items.length);
    items.push({ x: m.x, y: m.y, ...moduleSize(def), label: moduleName(m.type, def?.label ?? m.type).toUpperCase(), kind: 'module', module: m });
  }
  for (const a of assembliesOf(p)) {
    if (a.open || hiddenA.has(a.id)) continue;
    const i = items.length;
    for (const id of allModules(p, a)) owner.set(id, i);
    items.push({ x: a.x, y: a.y, ...assemblySize(a), label: (a.label || a.name).toUpperCase(), kind: 'assembly', asm: a });
  }
  // an estimated size never runs into the card to its right (in about the same row) or below it
  for (const a of items)
    for (const b of items)
      if (b !== a && b.x > a.x && Math.abs(b.y - a.y) < 40) a.w = Math.max(60, Math.min(a.w, b.x - a.x - 20));
  for (const a of items)
    for (const b of items)
      if (b !== a && b.y > a.y && b.x < a.x + a.w && a.x < b.x + b.w) a.h = Math.max(50, Math.min(a.h, b.y - a.y - 20));
  // open assemblies: a frame around their visible cards (an outer frame a little further out than its children's)
  type Frame = { label: string; inner: number[]; g: number };
  const frames: Frame[] = [];
  for (const a of assembliesOf(p)) {
    if (!a.open || hiddenA.has(a.id)) continue;
    const ids = new Set(allModules(p, a));
    const inner = [...new Set([...owner].filter(([id, i]) => i >= 0 && ids.has(id)).map(([, i]) => i))];
    if (!inner.length) continue;
    let depth = 0;
    for (let x = parentOf(p, a.id); x && depth < 8; x = parentOf(p, x.id)) depth++;
    frames.push({ label: (a.label || a.name).toUpperCase(), inner, g: 16 + 10 * (3 - Math.min(3, depth)) });
  }
  const frameRect = (f: Frame, boxes: Rect[], k: number): Rect => {
    const inner = f.inner.map((i) => boxes[i]);
    const x0 = Math.min(...inner.map((b) => b.x)) - f.g * k, y0 = Math.min(...inner.map((b) => b.y)) - (f.g + 24) * k;
    const x1 = Math.max(...inner.map((b) => b.x + b.w)) + f.g * k, y1 = Math.max(...inner.map((b) => b.y + b.h)) + f.g * k;
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  };
  const iw = map.w - 2 * MAP_IN, ih = map.h - 2 * MAP_IN - (main ? DOCK_H + MAP_IN : 0);
  const ix0 = map.x + MAP_IN, iy0 = map.y + MAP_IN, ix1 = ix0 + iw, iy1 = iy0 + ih;
  const dock: CardBox | undefined = main && { x: ix0, y: map.y + map.h - MAP_IN - DOCK_H, w: iw, h: DOCK_H, label: 'MAIN', kind: 'dock' };
  // the scale and the places: from the estimated sizes, the frames included
  const all = [...frames.map((f) => frameRect(f, items, 1)), ...items];
  const bx0 = all.length ? Math.min(...all.map((b) => b.x)) : 0, by0 = all.length ? Math.min(...all.map((b) => b.y)) : 0;
  const bw = Math.max(1, ...all.map((b) => b.x + b.w - bx0)), bh = Math.max(1, ...all.map((b) => b.y + b.h - by0));
  const scale = Math.min(MAX_SCALE, iw / bw, ih / bh);
  const ox = ix0 + (iw - bw * scale) / 2, oy = iy0 + (ih - bh * scale) / 2;
  const detail = detailFor(items.length);
  // each box at its place, at its content's size (names only: the estimated size), inside the map, then cut back
  const contents = items.map((it) => {
    const blurb = it.asm && blurbOf(it.asm);
    return { blurb, pages: detail === 'names' ? [] : pagesOf(p, defs, it) };
  });
  const rects: Rect[] = items.map((it, i) => {
    const nat = detail === 'names' ? { w: it.w * scale, h: it.h * scale } : naturalSize(it.label, contents[i].blurb, contents[i].pages, detail);
    return { x: ox + (it.x - bx0) * scale, y: oy + (it.y - by0) * scale, ...nat };
  });
  if (detail !== 'names') packColumns(items, rects, ix0, ix1);
  // a box that would run out of the map's right (bottom) edge moves left (up), as far as the boxes beside it leave room
  for (const r of rects) {
    if (r.x + r.w > ix1) {
      const left = rects.filter((o) => o !== r && o.x < r.x && o.y < r.y + r.h && r.y < o.y + o.h);
      r.x = Math.min(r.x, Math.max(ix1 - r.w, ix0, ...left.map((o) => o.x + o.w + BOX_GAP)));
    }
    if (r.y + r.h > iy1) {
      const above = rects.filter((o) => o !== r && o.y < r.y && o.x < r.x + r.w && r.x < o.x + o.w);
      r.y = Math.min(r.y, Math.max(iy1 - r.h, iy0, ...above.map((o) => o.y + o.h + BOX_GAP)));
    }
    r.w = Math.max(4, Math.min(r.w, ix1 - r.x));
    r.h = Math.max(4, Math.min(r.h, iy1 - r.y));
  }
  separate(rects, detail === 'names' ? Math.max(2, 20 * scale) : BOX_GAP);
  // a box cut narrower than its content puts fewer pages side by side: it grows down, as far as the boxes under it leave room
  if (detail !== 'names')
    rects.forEach((r, i) => {
      const { blurb, pages } = contents[i];
      if (!pages.length) return;
      const need = HEAD_H + (blurb ? BLURB_H : 0) + bandsHeight(pages, colsIn(r.w, pages.length, detail), detail) + BOX_FOOT;
      const under = rects.filter((o) => o !== r && o.y > r.y && o.x < r.x + r.w && r.x < o.x + o.w);
      if (need > r.h) r.h = Math.max(r.h, Math.min(need, iy1 - r.y, ...under.map((o) => o.y - r.y - BOX_GAP)));
    });
  // centred in the map again, now that the sizes are known
  const frameRects = (): Rect[] => frames.map((f) => frameRect(f, rects, scale));
  {
    const now = [...frameRects(), ...rects];
    if (now.length) {
      const x0 = Math.min(...now.map((b) => b.x)), x1 = Math.max(...now.map((b) => b.x + b.w));
      const y0 = Math.min(...now.map((b) => b.y)), y1 = Math.max(...now.map((b) => b.y + b.h));
      const shift = (lo: number, hi: number, min: number, max: number): number => {
        const want = (min + max) / 2 - (lo + hi) / 2;
        return hi - lo > max - min ? min - lo : Math.min(max - hi, Math.max(min - lo, want));
      };
      const dx = shift(x0, x1, ix0, ix1), dy = shift(y0, y1, iy0, iy1);
      for (const r of rects) (r.x += dx), (r.y += dy);
    }
  }
  const placed: CardBox[] = items.map((it, i) => {
    const r = rects[i];
    const label = r.h >= LABEL_PX + 8 ? cutLabel(it.label, r.w - 2 * LABEL_PAD) : '';
    const { blurb, pages } = contents[i];
    const showBlurb = !!blurb && detail !== 'names' && r.h >= HEAD_H + BLURB_H && r.w >= 90;
    const box: CardBox = { ...r, label, kind: it.kind };
    if (showBlurb) box.blurb = blurb;
    const inside = placePages(r, r.y + HEAD_H + (showBlurb ? BLURB_H : 0), pages, detail);
    if (inside.length) box.pages = inside;
    return box;
  });
  const placedFrames: CardBox[] = frames.map((f, i) => {
    const r = frameRects()[i];
    return { ...r, label: r.h >= LABEL_PX + 8 ? cutLabel(f.label, r.w - 2 * LABEL_PAD) : '', kind: 'frame' };
  });
  const boxes = [...placedFrames, ...placed, ...(dock ? [dock] : [])];

  /** where on a box's edge a port sits: its place among the card's (or the assembly's exposed) ports of that side */
  const edgeY = (i: number, module: number, port: string, dir: 'in' | 'out'): number => {
    const it = items[i];
    let k = -1, n = 1;
    if (it.asm) {
      const list = dir === 'in' ? it.asm.inputs : it.asm.outputs;
      const ref = findRef(it.asm, dir, module, port);
      k = ref ? list.indexOf(ref) : -1;
      n = list.length;
    } else {
      const def = defs[p.modules.find((m) => m.id === module)?.type ?? ''];
      const list = (dir === 'in' ? def?.inputs : def?.outputs) ?? [];
      k = list.findIndex((q) => q.name === port);
      n = list.length;
    }
    const b = placed[i];
    const f = k < 0 ? 0.5 : (k + 1) / (n + 1);
    return b.y + Math.min(b.h - 4, Math.max(Math.min(LABEL_PX + 10, b.h / 2), b.h * f));
  };
  const inDock = (x: number): number => Math.min(dock!.x + dock!.w - 8, Math.max(dock!.x + 8, x));
  const lines: CardLine[] = [];
  const seen = new Set<string>();
  for (const c of p.cables) {
    const a = owner.get(c.from.module), b = owner.get(c.to.module);
    if (a === undefined || b === undefined || a === b) continue;
    const role = cableRole(defs[p.modules.find((m) => m.id === c.to.module)?.type ?? ''], c.to.port);
    let line: CardLine;
    if (a < 0) {
      // out of the dock's top edge, up into the card's input
      const t = placed[b];
      line = { from: { x: inDock(t.x - 30 * scale), y: dock!.y }, to: { x: t.x, y: edgeY(b, c.to.module, c.to.port, 'in') }, role, dock: 'from' };
    } else if (b < 0) {
      const f = placed[a];
      line = { from: { x: f.x + f.w, y: edgeY(a, c.from.module, c.from.port, 'out') }, to: { x: inDock(f.x + f.w + 30 * scale), y: dock!.y }, role, dock: 'to' };
    } else {
      line = { from: { x: placed[a].x + placed[a].w, y: edgeY(a, c.from.module, c.from.port, 'out') }, to: { x: placed[b].x, y: edgeY(b, c.to.module, c.to.port, 'in') }, role };
    }
    const key = `${Math.round(line.from.x)},${Math.round(line.from.y)},${Math.round(line.to.x)},${Math.round(line.to.y)},${role}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(line);
  }
  return { map, boxes, lines, scale, detail };
}

export interface PatchFacts {
  modules: number;
  cables: number;
  /** the engines (engines.ts) by name, outermost only, each once */
  engines: string[];
  /** fits the FM-1, and the estimated CPU there in % (null when it cannot be counted) */
  fits: boolean;
  cpu: number | null;
}

export function patchFacts(p: Patch, defs: Record<string, ModuleDef>): PatchFacts {
  const engines: string[] = [];
  for (const a of assembliesOf(p)) {
    if (!instIsEngine(p, a, defs)) continue;
    let inEngine = false;
    for (let x = parentOf(p, a.id), d = 0; x && d < 8; x = parentOf(p, x.id), d++) if (instIsEngine(p, x, defs)) inEngine = true;
    const name = a.name || a.label;
    if (!inEngine && name && !engines.includes(name)) engines.push(name);
  }
  let fits = false, cpu: number | null = null;
  try {
    const b = deviceBudget(p);
    fits = b.fits;
    cpu = Math.round(b.cpu.use * 100);
  } catch {
    /* cannot be counted: shown as a sandbox patch */
  }
  return { modules: p.modules.length, cables: p.cables.length, engines, fits, cpu };
}

/** the FM-1 line, as the budget panel says it: "Plays on the FM-1 · 71 %", or "Sandbox" (too big for the FM-1, it plays in
 *  the browser, sandbox.ts) with how far over the CPU is */
export function fitLine(f: PatchFacts): string {
  if (f.fits) return f.cpu === null ? 'Plays on the FM-1' : `Plays on the FM-1 · ${f.cpu} %`;
  return f.cpu !== null && f.cpu > 100 ? `Sandbox · ${f.cpu} % of the FM-1` : 'Sandbox · bigger than the FM-1 holds';
}

const plural = (n: number, one: string): string => `${n.toLocaleString('en')} ${one}${n === 1 ? '' : 's'}`;

export interface CardOptions {
  /** the author's name: "by <name>" when given */
  by?: string;
}

const F_HEAD = "700 15px 'Barlow Semi Condensed', system-ui, sans-serif";
const titleFont = (px: number): string => `700 ${px}px 'Barlow Semi Condensed', system-ui, sans-serif`;
const F_BODY = (px: number): string => `500 ${px}px 'Barlow', system-ui, sans-serif`;
const F_LABEL = `600 ${LABEL_PX}px 'Barlow Condensed', 'Barlow Semi Condensed', system-ui, sans-serif`;
/** a row's name (the card's --cap) and value, a page's title, by detail */
const F_CAP = (px: number): string => `600 ${px}px 'Barlow Condensed', 'Barlow Semi Condensed', system-ui, sans-serif`;
const ROW_FONT = { full: [10.5, 11.5], compact: [10, 10.5], names: [10, 10] } as const;
const FONTS = [F_HEAD, titleFont(76), F_BODY(20), F_LABEL, F_CAP(10.5), F_BODY(11.5)];
/** a parameter bar (style.css .param.bar): --bar, ink 7 % into the panel, and --bar-fill, the control colour at 24 % */
const BAR_BG = '#303839', BAR_FILL = 'rgba(121, 199, 193, 0.24)';

type Ctx = CanvasRenderingContext2D;

/** `text` cut with an ellipsis to fit `max` pixels in the context's font */
function fit(ctx: Ctx, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text;
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(`${text.slice(0, mid).trimEnd()}…`).width <= max) lo = mid;
    else hi = mid - 1;
  }
  return lo ? `${text.slice(0, lo).trimEnd()}…` : '';
}

/** up to `max` lines of `text` wrapped at `width`; the last cut with an ellipsis when there is more */
function wrap(ctx: Ctx, text: string, width: number, max: number): string[] {
  const lines: string[] = [];
  for (const word of text.replace(/\s+/g, ' ').trim().split(' ')) {
    const next = lines.length ? `${lines[lines.length - 1]} ${word}` : word;
    if (lines.length && ctx.measureText(next).width <= width) lines[lines.length - 1] = next;
    else lines.push(word);
  }
  const kept = lines.slice(0, max);
  if (lines.length > max) kept[max - 1] = fit(ctx, `${lines.slice(max - 1).join(' ')}`, width - 1);
  return kept.map((l) => fit(ctx, l, width));
}

function roundRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2));
}

function pill(ctx: Ctx, x: number, y: number, text: string, warn: boolean): number {
  ctx.font = F_BODY(17);
  const w = ctx.measureText(text).width + 28;
  roundRect(ctx, x, y, w, 36, 18);
  ctx.fillStyle = warn ? DARK.gate : DARK.line; // a sandbox patch: gold, as in the app
  ctx.fill();
  ctx.fillStyle = warn ? DARK.bg : DARK.ink;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + 14, y + 19);
  return w;
}

function drawCable(ctx: Ctx, l: CardLine, k: number): void {
  const dx = Math.max(30, Math.abs(l.to.x - l.from.x) / 2), dy = Math.max(30, Math.abs(l.to.y - l.from.y) / 2);
  const path = (): void => {
    ctx.beginPath();
    ctx.moveTo(l.from.x, l.from.y);
    const c1 = l.dock === 'from' ? [l.from.x, l.from.y - dy] : [l.from.x + dx, l.from.y];
    const c2 = l.dock === 'to' ? [l.to.x, l.to.y - dy] : [l.to.x - dx, l.to.y];
    ctx.bezierCurveTo(c1[0], c1[1], c2[0], c2[1], l.to.x, l.to.y);
  };
  const stroke = (color: string, w: number): void => {
    path();
    ctx.strokeStyle = color;
    ctx.lineWidth = w * k;
    ctx.stroke();
  };
  ctx.lineCap = 'round';
  if (l.role === 'signal') stroke(DARK.accent, 6);
  else if (l.role === 'mod') stroke(DARK.secondary, 3.5);
  else if (l.role === 'gate') (stroke(DARK.gate, 6), stroke(DARK.map, 2.4)); // a hollow rail, as on the canvas
  else (stroke(DARK.ink, 7), stroke(DARK.map, 4.6), stroke(DARK.ink, 1.2)); // keys: a three-wire ribbon
}

/** a box's blurb and pages: each row a bar, as on the card in the app (its name at the left, its value at the right, the
 *  fill to the value) */
function drawInside(ctx: Ctx, b: CardBox, detail: Detail): void {
  if (b.blurb) {
    ctx.font = F_BODY(12.5);
    ctx.letterSpacing = '0px';
    ctx.fillStyle = DARK.muted;
    const t = fit(ctx, b.blurb, b.w - 2 * LABEL_PAD);
    if (t) ctx.fillText(t, b.x + LABEL_PAD, b.y + HEAD_H + 9);
  }
  const [capPx, valPx] = ROW_FONT[detail];
  for (const pg of b.pages ?? []) {
    if (pg.titleH && pg.title) {
      ctx.font = F_CAP(10);
      ctx.letterSpacing = '1px';
      ctx.fillStyle = DARK.muted;
      const t = fit(ctx, pg.title.toUpperCase(), pg.w);
      if (t) ctx.fillText(t, pg.x + 1, pg.y + 9);
    }
    pg.rows.forEach((r, k) => {
      const y = pg.y + pg.titleH + k * ROW_H[detail], h = BAR_H[detail];
      roundRect(ctx, pg.x, y, pg.w, h, 5);
      ctx.fillStyle = BAR_BG;
      ctx.fill();
      if (r.u > 0) {
        ctx.save();
        roundRect(ctx, pg.x, y, pg.w, h, 5);
        ctx.clip();
        ctx.fillStyle = BAR_FILL;
        ctx.fillRect(pg.x, y, pg.w * r.u, h);
        ctx.restore();
      }
      const mid = y + h / 2 + valPx * 0.36;
      ctx.font = F_BODY(valPx);
      ctx.letterSpacing = '0px';
      ctx.textAlign = 'right';
      const value = fit(ctx, r.value, pg.w * 0.55);
      const vw = ctx.measureText(value).width;
      ctx.fillStyle = DARK.ink;
      ctx.fillText(value, pg.x + pg.w - 6, mid);
      ctx.textAlign = 'left';
      ctx.font = F_CAP(capPx);
      ctx.letterSpacing = '0.6px';
      const label = fit(ctx, r.label.toUpperCase(), pg.w - 12 - vw - 6);
      if (label) ctx.fillText(label, pg.x + 6, mid);
    });
  }
}

/** draw the card on a 1200 x 900 context (fonts already loaded) */
export function drawPatchCard(ctx: Ctx, p: Patch, opts: CardOptions = {}, defs: Record<string, ModuleDef> = DEFS): void {
  const facts = patchFacts(p, defs);
  ctx.save();
  ctx.fillStyle = DARK.bg;
  ctx.fillRect(0, 0, CARD_W, CARD_H);
  ctx.textBaseline = 'alphabetic';

  // header, right column: by, engines (the title gets the rest of the width)
  ctx.font = F_BODY(18);
  ctx.textAlign = 'right';
  const by = opts.by?.trim();
  const right = [by ? `by ${by}` : '', facts.engines.length ? `Engines: ${facts.engines.join(', ')}` : ''].filter(Boolean).map((t) => fit(ctx, t, 380));
  const rightW = Math.max(0, ...right.map((t) => ctx.measureText(t).width));
  ctx.fillStyle = DARK.muted;
  right.forEach((t, i) => ctx.fillText(t, CARD_W - PAD, PAD + 16 + i * 26));
  ctx.textAlign = 'left';

  ctx.font = F_HEAD;
  ctx.fillStyle = DARK.accent;
  ctx.letterSpacing = '2.4px';
  ctx.fillText('MATRYOSHKA PATCH', PAD, PAD + 14);
  // the title: upper case, as large as fits beside the right column (76 down to 40 px), then cut
  const titleMax = CARD_W - 2 * PAD - (rightW ? rightW + 32 : 0);
  const title = (p.name.trim() || 'Untitled').toUpperCase();
  let px = 76;
  ctx.letterSpacing = '1.5px';
  for (; px > 40; px -= 4) {
    ctx.font = titleFont(px);
    if (ctx.measureText(title).width <= titleMax) break;
  }
  ctx.font = titleFont(px);
  ctx.fillStyle = DARK.ink;
  ctx.fillText(fit(ctx, title, titleMax), PAD, TITLE_Y);
  ctx.letterSpacing = '0px';
  const notes = notesOf(p);
  ctx.font = F_BODY(20);
  const noteLines = notes ? wrap(ctx, notes, CARD_W - 2 * PAD, 3) : [];
  ctx.fillStyle = DARK.muted;
  noteLines.forEach((l, i) => ctx.fillText(l, PAD, NOTES_Y + i * NOTE_LH));

  // the map
  const layout = cardLayout(p, defs, noteLines.length);
  const { map } = layout;
  roundRect(ctx, map.x, map.y, map.w, map.h, 14);
  ctx.fillStyle = DARK.map;
  ctx.fill();
  ctx.strokeStyle = DARK.line;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.save();
  roundRect(ctx, map.x, map.y, map.w, map.h, 14);
  ctx.clip();
  const k = Math.min(1, Math.max(0.45, layout.scale / 0.5));
  const r = Math.max(3, 10 * Math.min(1, layout.scale / 0.6));
  for (const b of layout.boxes.filter((b) => b.kind === 'frame')) {
    roundRect(ctx, b.x, b.y, b.w, b.h, r + 2);
    ctx.setLineDash([6, 5]);
    ctx.strokeStyle = DARK.stone;
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.setLineDash([]);
  }
  for (const l of layout.lines) drawCable(ctx, l, k);
  ctx.font = F_LABEL;
  ctx.letterSpacing = '1.2px';
  for (const b of layout.boxes) {
    if (b.kind !== 'frame') {
      roundRect(ctx, b.x, b.y, b.w, b.h, b.kind === 'dock' ? 6 : r);
      ctx.fillStyle = DARK.panel;
      ctx.fill();
      ctx.strokeStyle = DARK.stone;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      if (b.kind === 'assembly' && b.w > 14 && b.h > 14) {
        // an assembly: a second outline inside, one doll in another
        roundRect(ctx, b.x + 4, b.y + 4, b.w - 8, b.h - 8, Math.max(2, r - 3));
        ctx.strokeStyle = DARK.line;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
    if (b.label) {
      const label = fit(ctx, b.label, b.w - 2 * LABEL_PAD);
      ctx.fillStyle = b.kind === 'frame' ? DARK.muted : DARK.ink;
      if (label) ctx.fillText(label, b.x + LABEL_PAD, b.kind === 'dock' ? b.y + b.h / 2 + LABEL_PX * 0.36 : b.y + LABEL_PX + 8);
    }
    drawInside(ctx, b, layout.detail);
    ctx.font = F_LABEL;
    ctx.letterSpacing = '1.2px';
  }
  ctx.restore();
  ctx.letterSpacing = '0px';

  // footer
  let x = PAD;
  x += pill(ctx, x, FOOTER_Y, plural(facts.modules, 'module'), false) + 12;
  x += pill(ctx, x, FOOTER_Y, plural(facts.cables, 'cable'), false) + 12;
  pill(ctx, x, FOOTER_Y, fitLine(facts), !facts.fits);
  ctx.font = F_BODY(17);
  ctx.fillStyle = DARK.muted;
  ctx.textAlign = 'right';
  ctx.fillText('play it: link in the comments', CARD_W - PAD, FOOTER_Y + 19);
  ctx.restore();
}

/** wait for the card's fonts (style.css loads them from public/fonts); a font that fails falls back to system-ui */
async function loadFonts(): Promise<void> {
  try {
    await Promise.all(FONTS.map((f) => document.fonts.load(f)));
  } catch {
    /* drawn in the fallback font */
  }
}

/** draw the card onto `canvas` (sized to 1200 x 900) */
export async function paintPatchCard(canvas: HTMLCanvasElement, p: Patch, opts: CardOptions = {}, defs: Record<string, ModuleDef> = DEFS): Promise<void> {
  await loadFonts();
  canvas.width = CARD_W;
  canvas.height = CARD_H;
  drawPatchCard(canvas.getContext('2d')!, p, opts, defs);
}

/** the card as a PNG */
export async function renderPatchCard(p: Patch, opts: CardOptions = {}, defs: Record<string, ModuleDef> = DEFS): Promise<Blob> {
  const canvas = document.createElement('canvas');
  await paintPatchCard(canvas, p, opts, defs);
  return new Promise((ok, fail) => canvas.toBlob((b) => (b ? ok(b) : fail(new Error('the card could not be drawn'))), 'image/png'));
}

/** a file name for the patch: its name, safe for a file system */
export const fileStem = (p: Patch): string => p.name.replace(/[^\w.-]+/g, '_') || 'patch';

/** download the card as `<patch name>.png` */
export async function savePatchCard(p: Patch, opts: CardOptions = {}, defs: Record<string, ModuleDef> = DEFS): Promise<void> {
  const blob = await renderPatchCard(p, opts, defs);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${fileStem(p)}.png`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
