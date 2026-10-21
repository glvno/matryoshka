// SPDX-License-Identifier: GPL-3.0-only
// What the editor offers to add or open, in one place: the command palette, the assembly browser and the Open picker all
// read these lists, so anything hidden or retired in one is gone from the others too (glvno/matryoshka#84).
import type { AssemblyDef } from './assembly';
import { FACTORY, FACTORY_SHELVES, loadLibrary, shelvesOf, USER_SHELF } from './assemblies';
import { moduleName } from './labels';
import type { ModuleDef, Patch } from './patch';
import { PRESETS } from './presets';
import { savedPatches } from './saved';
import { CHAPTERS, LISTED, chapterEnd } from './tutorial/chapters';

/** module types that never go on the canvas by hand: Main is docked (one per patch), Part is the engine's form of a
 *  voice allocator's output */
const NOT_ADDABLE = new Set(['fm1', 'part']);

/** the modules + Add module offers (the palette filtered to "module"), with the names it shows */
export const addableModules = (defs: Record<string, ModuleDef>): { type: string; name: string; def: ModuleDef }[] =>
  Object.values(defs)
    .filter((d) => !NOT_ADDABLE.has(d.type))
    .map((d) => ({ type: d.type, name: moduleName(d.type, d.label), def: d }));

/** the assemblies the browser shows, each with its shelf: the user's library first, then the factory set, the engines first
 *  (engines.ts; one on another shelf than Voices is listed on both, as the drum kit) */
export const assemblyShelves = (): { shelf: string; def: AssemblyDef }[] => [
  ...loadLibrary().map((def) => ({ shelf: USER_SHELF, def })),
  ...FACTORY_SHELVES.flatMap((shelf) => FACTORY.filter((def) => shelvesOf(def).includes(shelf)).map((def) => ({ shelf, def }))),
];
export const SHELVES = [USER_SHELF, ...FACTORY_SHELVES];

export interface Openable {
  /** the Open picker's option value */
  value: string;
  name: string;
  load: () => Patch;
}

/** the Open picker's groups, in its order: Your patches (newest first), the examples, the tutorial chapters' ends */
export function openableGroups(): { label: string; items: Openable[] }[] {
  const mine = savedPatches();
  return [
    { label: 'Your patches', items: mine.map((e) => ({ value: `saved:${e.name}`, name: e.name, load: () => JSON.parse(JSON.stringify(e.patch)) as Patch })) },
    { label: 'Examples', items: Object.entries(PRESETS).map(([name, make]) => ({ value: name, name, load: make })) },
    {
      label: 'Tutorial',
      items: LISTED.map((i, n) => ({
        value: `tutorial:${i}`,
        name: `${n + 1}. ${CHAPTERS[i].title}${CHAPTERS[i].published ? '' : ' (unpublished)'}`,
        load: () => chapterEnd(i),
      })),
    },
  ].filter((g) => g.items.length);
}

/** the Open picker's entry for an option value */
export const openableByValue = (value: string): Openable | undefined => openableGroups().flatMap((g) => g.items).find((o) => o.value === value);
