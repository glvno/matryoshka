// SPDX-License-Identifier: GPL-3.0-only
// Two-finger touch on the canvas (#153): a pinch zooms around the fingers' midpoint, and the midpoint's movement pans.

export interface Pt { x: number; y: number }

/** a pinch from its start: the fingers' distance and the zoom then */
export interface Pinch { d: number; z: number }

const dist = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.y - b.y);
const mid = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/** a pinch starting with the fingers at `a`, `b` and the canvas at `zoom` */
export function pinchStart(a: Pt, b: Pt, zoom: number): Pinch {
  return { d: Math.max(1, dist(a, b)), z: zoom };
}

/**
 * One move of a two-finger gesture: the zoom (the start's zoom times the ratio of the fingers' distance now to the
 * start's, within min..max), the point to hold still while zooming (the midpoint now, client px) and the scroll that pans
 * the canvas by the midpoint's movement since the previous move (for `scrollBy`: the content follows the fingers).
 */
export function pinchStep(p: Pinch, prev: [Pt, Pt], now: [Pt, Pt], min: number, max: number): { zoom: number; at: Pt; pan: Pt } {
  const zoom = Math.min(max, Math.max(min, p.z * (dist(now[0], now[1]) / p.d)));
  const m0 = mid(prev[0], prev[1]), at = mid(now[0], now[1]);
  return { zoom, at, pan: { x: m0.x - at.x, y: m0.y - at.y } };
}
