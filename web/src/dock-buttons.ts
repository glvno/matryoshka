// SPDX-License-Identifier: GPL-3.0-only
// The Main dock's button block (#113, design board D): the FM-1's two button rows in device order, and the gold traces
// from the patch buttons up to their jacks on the dock's top edge. Pure geometry, no DOM (dock-buttons.test.ts).

import { PANEL_BUTTONS } from './modules';

/** the FM-1's buttons, row by row as on the device */
export const FM1_BUTTON_ROWS: readonly (readonly string[])[] = [
  ['fx', 'scl', 'env', 'lfo', 'edit', 'glo'],
  ['home', 'save', 'arp', 'seq', 'play', 'rec'],
];

/** what a button in the dock is: a patch button (a Main output with a jack), the transport, or the device's own (inert here) */
export function buttonKind(b: string): 'patch' | 'play' | 'device' {
  return PANEL_BUTTONS.includes(b) ? 'patch' : b === 'play' ? 'play' : 'device';
}

/** the jack column of a patch button: the top row's under their buttons, the rest in the lanes right of the grid */
export function jackColumn(b: string): number {
  const top = FM1_BUTTON_ROWS[0].indexOf(b);
  if (top >= 0) return top;
  const rest = PANEL_BUTTONS.filter((x) => !FM1_BUTTON_ROWS[0].includes(x));
  return FM1_BUTTON_ROWS[0].length + rest.indexOf(b);
}

export interface Pt { x: number; y: number }

/** corner radius of a trace's bends */
export const TRACE_R = 6;

/**
 * A trace's path from the top of a button (`from`) to the bottom of its jack (`to`). Straight up when the jack is above the
 * button; else (ARP) up into the gap above the button's row at `gapY`, along it, then up the lane to the jack, rounded.
 */
export function tracePath(from: Pt, to: Pt, gapY: number, r = TRACE_R): string {
  const f = (n: number): string => String(Math.round(n * 10) / 10);
  if (Math.abs(from.x - to.x) < 1) return `M${f(to.x)} ${f(from.y)} V${f(to.y)}`;
  const s = Math.sign(to.x - from.x);
  const k = Math.max(0, Math.min(r, Math.abs(to.x - from.x) / 2, (from.y - gapY), (gapY - to.y) / 2));
  return `M${f(from.x)} ${f(from.y)} V${f(gapY + k)} Q${f(from.x)} ${f(gapY)} ${f(from.x + s * k)} ${f(gapY)}`
    + ` H${f(to.x - s * k)} Q${f(to.x)} ${f(gapY)} ${f(to.x)} ${f(gapY - k)} V${f(to.y)}`;
}
