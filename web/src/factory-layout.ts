// SPDX-License-Identifier: GPL-3.0-only
// Where the factory patches' and examples' top-level cards sit: as Tidy lays them out with the cards' real sizes (D-1446),
// written by scripts/factory-layout.ts from a headless editor into factory/layout.json. The canvas's reading order is the
// FM-1's device order (pages.ts devicesOf), so this layout also sets the factory patches' page order (D-1458). The
// cards inside an assembly keep the places they come with: the first expansion lays them out (tidy.ts tidyAssembly).
import LAYOUT from '../factory/layout.json';
import { assembliesOf, moveAssembly, parentOf } from './assembly';
import type { Patch } from './patch';

/** a patch's top-level places, each [x, y]: module id → its card's (not in an assembly; Main is docked and has none),
 *  assembly id → its collapsed card's (top level, not an FX drawer) */
export interface FactoryLayout { m: Record<string, number[]>; a: Record<string, number[]> }

export const FACTORY_LAYOUT: Readonly<Record<string, FactoryLayout>> = LAYOUT;

/** the top-level cards a layout places: modules in no assembly but Main, top-level assemblies but FX drawers */
export function layoutCards(p: Patch): { m: number[]; a: number[] } {
  const inAsm = new Set(assembliesOf(p).flatMap((a) => a.modules));
  return {
    m: p.modules.filter((m) => !inAsm.has(m.id) && m.type !== 'fm1').map((m) => m.id),
    a: assembliesOf(p).filter((a) => !parentOf(p, a.id) && !a.drawer).map((a) => a.id),
  };
}

/** put `p`'s top-level cards where the layout of `name` has them (an assembly moves with its members); a patch without one
 *  keeps its places */
export function applyFactoryLayout(p: Patch, name: string): void {
  const l = FACTORY_LAYOUT[name];
  if (!l) return;
  for (const m of p.modules) {
    const at = l.m[m.id];
    if (at) [m.x, m.y] = at;
  }
  for (const a of assembliesOf(p)) {
    const at = l.a[a.id];
    if (at) moveAssembly(p, a, at[0] - a.x, at[1] - a.y);
  }
}
