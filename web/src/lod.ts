// SPDX-License-Identifier: GPL-3.0-only
/**
 * Semantic zoom (D-1448): the canvas draws less detail the further out it is zoomed. This file holds the rules as pure
 * functions; editor.ts applies them.
 *
 * Levels: 0 the full card (40 % and up); 1 the sliders: each row keeps its control and loses its words, the title stays at
 * 12 px on screen (16 % to 40 %); 2 the names: each card only its name, drawn on a canvas with the columns spread apart
 * (4.5 % to 16 %, far-view.ts); 3 the blocks: assemblies as named blocks and one arrow per pair (below 4.5 %).
 */

/** a level of detail */
export type Lod = 0 | 1 | 2 | 3;
export const LOD_FULL: Lod = 0;
export const LOD_SLIDERS: Lod = 1;
export const LOD_NAMES: Lod = 2;
export const LOD_BLOCKS: Lod = 3;

/** the zoom below which each level gives way to the next (level k ends at LOD_BOUNDS[k]) */
export const LOD_BOUNDS = [0.4, 0.16, 0.045] as const;

/** a level changes 8 % past its boundary, both ways, so a zoom resting on a boundary never flickers */
export const LOD_HYSTERESIS = 1.08;

/** the level at zoom `z`, coming from level `cur`: snapped, with the hysteresis band round each boundary */
export function lodFor(z: number, cur: Lod): Lod {
  let l: number = cur;
  while (l < LOD_BOUNDS.length && z < LOD_BOUNDS[l] / LOD_HYSTERESIS) l++;
  while (l > 0 && z > LOD_BOUNDS[l - 1] * LOD_HYSTERESIS) l--;
  return l as Lod;
}

/** a card's title size at the zoom of 1 (style.css .mhead > span: 15 px) and on screen at the sliders level */
export const TITLE_PX = 15;
export const LOD_TITLE_PX = 12;

/** the scale that keeps a 15 px title 12 px tall on screen at zoom `z` */
export const titleScale = (z: number): number => LOD_TITLE_PX / (TITLE_PX * z);

/** the screen px a title leaves free on its card: its padding and a little air */
export const TITLE_ROOM = 14;

/**
 * whether a name `nameW` px wide at the title's 15 px still fits on one line of a card `cardW` px wide (both in layout px)
 * once the title is 12 px on screen at zoom `z`; when it does not, the card shows its tag instead
 */
export const nameFits = (nameW: number, cardW: number, z: number): boolean => nameW * (LOD_TITLE_PX / TITLE_PX) <= cardW * z - TITLE_ROOM;

/**
 * the scale for a title `textW` px wide at 15 px (the name, or the tag when the name does not fit) on a card `cardW` px wide
 * at zoom `z`: 12 px on screen, smaller when even that is wider than the card (a tag on a narrow card far out)
 */
export const titleScaleFor = (textW: number, cardW: number, z: number): number =>
  Math.min(titleScale(z), Math.max(0, cardW * z - TITLE_ROOM) / (Math.max(1, textW) * z));

/** where the pointer is inside an element, as fractions of its width and height (D-1449) */
export interface Anchor { fx: number; fy: number }

interface Box { left: number; top: number; width: number; height: number }

/** the pointer's place inside `r` (client px), clamped to the element */
export function anchorIn(r: Box, at: { x: number; y: number }): Anchor {
  const f = (v: number, a: number, s: number): number => (s > 0 ? Math.min(1, Math.max(0, (v - a) / s)) : 0.5);
  return { fx: f(at.x, r.left, r.width), fy: f(at.y, r.top, r.height) };
}

/**
 * how far (client px) the view must move so that the anchored point of the element, now drawn at `r`, is back under the
 * pointer `at`: the camera moves by this divided by the zoom
 */
export function anchorShift(a: Anchor, r: Box, at: { x: number; y: number }): { dx: number; dy: number } {
  return { dx: r.left + a.fx * r.width - at.x, dy: r.top + a.fy * r.height - at.y };
}
