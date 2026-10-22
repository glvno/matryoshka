// SPDX-License-Identifier: GPL-3.0-only
// "Tidy up": line the canvas up in columns, the way a desktop's Clean Up does, keeping the user's arrangement (which
// column a card is in and its order down the column). Expanded assemblies are tidied inside first and then move as one
// block. Pure model code: the editor passes the cards' sizes.
import { assembliesOf, childrenOf, moveAssembly, parentOf, type AssemblyInst, type Rect } from './assembly';
import type { Patch } from './patch';

/** space between cards, and between the canvas edge and the first column / row */
export const TIDY_GAP = 20;

export interface TidySizes {
  /** a module card's size (0 when unknown: the caller's default is used) */
  module(id: number): { w: number; h: number };
  /** a collapsed assembly card's size */
  container(id: number): { w: number; h: number };
  /** an expanded assembly's frame around its content: padding (top / bottom, and `padX` left / right when it differs), header
   *  height (with a poly strip) and least width */
  frame(a: AssemblyInst): { pad: number; padX?: number; head: number; minW: number };
}

type Item = { r: Rect; move: (dx: number, dy: number) => void };

/** the width : height the packing aims for (a canvas is wider than tall) */
const ASPECT = 2;

/** do two boxes come closer than TIDY_GAP? */
const near = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.w + TIDY_GAP && b.x < a.x + a.w + TIDY_GAP && a.y < b.y + b.h + TIDY_GAP && b.y < a.y + a.h + TIDY_GAP;

/** the strict overlap of two boxes */
const overlap = (a: Rect, b: Rect): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * Is this a pile rather than an arrangement: at least three items, and at least half of them lying on another (a share
 * link without its layout, every card at 0, 0)? A pile has no columns to keep.
 */
export function piled(rects: Rect[]): boolean {
  const on = rects.filter((r, i) => rects.some((o, j) => i !== j && overlap(r, o))).length;
  return on >= 3 && on * 2 >= rects.length;
}

/**
 * The items' new places, packed from (`x0`, `y0`) (#121). The user's columns (cards whose left edges are within the first
 * half of the column's first card) keep their order left to right and their order down the column, but a card does not
 * have to sit straight under the one before it: it takes the free spot that grows the layout least (the larger of its
 * width / ASPECT and its height: what Fit has to show), then the highest, then the leftmost, no further left than the
 * previous column's last left edge and no higher than the card before it in its column. A short card under a wide one
 * leaves no gap down the whole column, and a later column fills the room beside a narrow card. The columns are read from
 * the layout given, so tidying a packed layout again may read others: the editor leaves a layout it tidied alone.
 * A pile (`piled`) is packed freely in the items' own order (the patch's), each card in its own unconstrained column.
 */
function arrange(items: Item[], x0: number, y0: number): void {
  const free = piled(items.map((it) => it.r));
  const cols: Item[][] = [];
  if (free) for (const it of items) cols.push([it]);
  else for (const it of [...items].sort((a, b) => a.r.x - b.r.x || a.r.y - b.r.y)) {
    const col = cols[cols.length - 1];
    if (col && it.r.x < col[0].r.x + col[0].r.w / 2) col.push(it);
    else cols.push([it]);
  }
  const placed: Rect[] = [];
  let right = x0, bottom = y0, floor = x0;
  for (const col of cols) {
    col.sort((a, b) => a.r.y - b.r.y || a.r.x - b.r.x);
    let top = y0, colLeft = floor;
    for (const it of col) {
      const { w, h } = it.r;
      const xs = [floor, ...placed.map((r) => r.x + r.w + TIDY_GAP)].filter((x) => x >= floor);
      const ys = [top, ...placed.map((r) => r.y + r.h + TIDY_GAP)].filter((y) => y >= top);
      let best: { x: number; y: number; cost: number } | null = null;
      for (const y of ys)
        for (const x of xs) {
          const cost = Math.max((Math.max(right, x + w) - x0) / ASPECT, Math.max(bottom, y + h) - y0);
          if (best && (cost > best.cost || (cost === best.cost && (y > best.y || (y === best.y && x >= best.x))))) continue;
          const box = { x, y, w, h };
          if (!placed.some((r) => near(r, box))) best = { x, y, cost };
        }
      const { x, y } = best!; // (a spot right of everything placed is always free)
      it.move(x - it.r.x, y - it.r.y);
      it.r.x = x;
      it.r.y = y;
      placed.push({ ...it.r });
      right = Math.max(right, x + w);
      bottom = Math.max(bottom, y + h);
      top = y + h + TIDY_GAP;
      colLeft = Math.max(colLeft, x);
    }
    if (!free) floor = colLeft + TIDY_GAP;
  }
}

/** a module card or an assembly (a collapsed card, or an expanded frame whose content is tidied first) as one item */
function itemsOf(p: Patch, sizes: TidySizes, skip: Set<number>) {
  const moduleItem = (id: number): Item | null => {
    const m = p.modules.find((x) => x.id === id);
    if (!m || skip.has(id)) return null;
    const s = sizes.module(id);
    return { r: { x: m.x, y: m.y, w: s.w, h: s.h }, move: (dx, dy) => { m.x += dx; m.y += dy; } };
  };
  /** an expanded assembly's content, arranged from its current top left; the frame's box around it, or null when empty */
  const inside = (a: AssemblyInst): Rect | null => {
    const inner = [...a.modules.map(moduleItem), ...childrenOf(p, a).map(asmItem)].filter((x): x is Item => !!x);
    if (!inner.length) return null;
    const { pad, head, minW } = sizes.frame(a);
    const padX = sizes.frame(a).padX ?? pad;
    const left = Math.min(...inner.map((it) => it.r.x));
    const top = Math.min(...inner.map((it) => it.r.y));
    arrange(inner, left, top);
    delete a.frameSize;
    const right = Math.max(...inner.map((it) => it.r.x + it.r.w));
    const bottom = Math.max(...inner.map((it) => it.r.y + it.r.h));
    return { x: left - padX, y: top - pad - head, w: Math.max(right - left + 2 * padX, minW), h: bottom - top + 2 * pad + head };
  };
  const asmItem = (a: AssemblyInst): Item | null => {
    if (!a.open) {
      const s = sizes.container(a.id);
      return { r: { x: a.x, y: a.y, w: s.w, h: s.h }, move: (dx, dy) => moveAssembly(p, a, dx, dy) };
    }
    const r = inside(a);
    return r && { r, move: (dx, dy) => moveAssembly(p, a, dx, dy) };
  };
  return { moduleItem, asmItem, inside };
}

/** Tidy the inside of one expanded assembly (its first expansion in a session), keeping its top left corner */
export function tidyAssembly(p: Patch, a: AssemblyInst, sizes: TidySizes): void {
  if (a.open) itemsOf(p, sizes, new Set()).inside(a);
}

/**
 * Tidy the whole canvas. `skip` = module ids that are not on the canvas (the docked Main panel). Expanded assemblies
 * lose a size the user gave their frame, so the frame fits its tidied content. Returns nothing; positions change in `p`.
 */
export function tidy(p: Patch, sizes: TidySizes, skip: Set<number> = new Set()): void {
  const inAsm = new Set(assembliesOf(p).flatMap((a) => a.modules));
  const { moduleItem, asmItem } = itemsOf(p, sizes, skip);
  const top = [
    ...p.modules.filter((m) => !inAsm.has(m.id)).map((m) => moduleItem(m.id)),
    ...assembliesOf(p).filter((a) => !parentOf(p, a.id)).map(asmItem),
  ].filter((x): x is Item => !!x);
  arrange(top, TIDY_GAP, TIDY_GAP);
}

/** the canvas is a pile (`piled`): its module cards (not the skipped ones) lie on one another, as a share link without its
 *  layout opens */
export function isPile(p: Patch, sizes: TidySizes, skip: Set<number> = new Set()): boolean {
  return piled(p.modules.filter((m) => !skip.has(m.id)).map((m) => ({ x: m.x, y: m.y, ...sizes.module(m.id) })));
}
