// SPDX-License-Identifier: GPL-3.0-only
// The closed FX drawer as a tab on its instrument's card (the fxsound design, direction C, chosen by the owner on
// 2026-11-24, docs/ledger/editor.md D-1341): its effects' names in signal order, each with its ⏻ and its mix as a mini
// bar, and the level after the effects as a meter. Where the tab goes on the card's edge and which rows fit; what each
// mini bar shows.
import type { AssemblyInst } from './assembly';
import { DEFS } from './modules';
import { toUnit, type Patch } from './patch';

/** the tab past the card's edge (the 18 px tucked under the card come on top), px */
export const TAB_W = 124;
/** the tab's header (FX n, the CPU share, the drawer's ⏻), one effect's row, the padding under the last row, px */
export const TAB_HEAD = 24;
export const TAB_ROW = 17;
export const TAB_FOOT = 5;
/** a jack the tab leaves free keeps this much of the card's edge clear on each side of its centre (a jack is 14 px), px */
export const TAB_CLEAR = 8;

/** what the tab's mini bar shows: an effect's mix, else its amount, else its first row */
const AMOUNT = [/\bmix\b/, /^(amount|depth|drive|level|gain|width|shimmer|smear|sensitivity)$/];

/** an effect's mix (else its amount, else its first row) as a share of its range, 0..1; null without a row */
export function effectAmount(p: Patch, e: AssemblyInst): number | null {
  const r = AMOUNT.map((re) => e.params.find((x) => re.test((x.label ?? x.param).toLowerCase()))).find((x) => !!x) ?? e.params[0];
  const m = r && p.modules.find((x) => x.id === r.module);
  const pd = m && DEFS[m.type]?.params.find((d) => d.name === r.param);
  if (!m || !pd) return null;
  return toUnit(pd, m.params[r.param] ?? pd.min);
}

/** where the tab goes, px from the card's top (`top`) and from the tab's own top (the rest) */
export interface TabPlan {
  top: number;
  h: number;
  /** each row's top: the effects shown, then (when some did not fit) the "+N" row */
  rows: number[];
  /** how many effects have a row */
  shown: number;
  /** the window round the free jacks between the chain's jacks (D-1341), or null */
  win: [number, number] | null;
}

/**
 * Plan the tab on a card `cardH` tall: it covers the chain's jacks (`taps`, their centres from the card's top) and
 * reaches up beside the card's header as far as the free jacks above them allow, and down as far as its rows need, never
 * over a free jack below (`free`: the other jacks on that edge). A free jack between the chain's jacks shows through a
 * window, as it did in the plug, and no row covers it. `count` effects: the rows that do not fit become "+N".
 */
export function planTab(taps: readonly number[], free: readonly number[], cardH: number, count: number): TabPlan {
  const y0 = Math.min(...taps), y1 = Math.max(...taps);
  const above = free.filter((y) => y < y0), below = free.filter((y) => y > y1);
  const top = Math.min(above.length ? Math.max(...above) + TAB_CLEAR : 3, y0 - 15);
  const floor = Math.max(below.length ? Math.min(...below) - TAB_CLEAR : cardH - 3, y1 + 15);
  const win: [number, number] | null = free.some((y) => y > y0 + 6 && y < y1 - 6) ? [y0 + 13 - top, y1 - 13 - top] : null;
  // the row slots down the tab, round the window, as far as the floor allows (an empty drawer has one row: "drop effects here")
  const want = Math.max(count, 1);
  const slots: number[] = [];
  for (let y = TAB_HEAD; slots.length < want + 1; y += TAB_ROW) {
    if (win && y + TAB_ROW > win[0] - 1 && y < win[1] + 1) y = win[1] + 1;
    if (top + y + TAB_ROW + TAB_FOOT > floor && slots.length) break;
    slots.push(y);
  }
  const shown = count <= slots.length ? count : Math.max(0, slots.length - 1);
  const rows = slots.slice(0, count > shown ? shown + 1 : want);
  const h = Math.max(y1 + 15 - top, rows[rows.length - 1] + TAB_ROW + TAB_FOOT);
  return { top, h, rows, shown, win };
}
