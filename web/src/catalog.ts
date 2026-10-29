// SPDX-License-Identifier: GPL-3.0-only
// What the editor offers to add or open, in one place: the command palette, the assembly browser and the Open picker all
// read these lists, so anything hidden or retired in one is gone from the others too (glvno/matryoshka#84).
import type { AssemblyDef } from './assembly';
import { addedCommunity, chipOfEntry, openCommunity, pairXl } from './community';
import { FACTORY, FACTORY_SHELVES, loadLibrary, shelvesOf, USER_SHELF } from './assemblies';
import { moduleName } from './labels';
import type { ModuleDef, Patch } from './patch';
import { PRESETS } from './presets';
import { chipOf, type Chip } from './sandbox';
import { savedPatches } from './saved';

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
  /** the Your patches name it opens from (a saved patch): saving over that copy offers no Undo (#148) */
  from?: string;
  /** an added community patch's author, shown after its name ("Sol 29N XL · michael glaviano") */
  author?: string;
  /** an XL listed right under its FM-1 version */
  xl?: boolean;
  /** its chip, FM-1 · NN % or SANDBOX (sandbox.ts), worked out when asked */
  chip: () => Chip;
}

/** a factory patch's chip: the factory patches do not change while the page is open, so each is worked out once */
const factoryChips = new Map<string, Chip>();
const factoryChip = (name: string): Chip => {
  let c = factoryChips.get(name);
  if (!c) factoryChips.set(name, (c = chipOf(PRESETS[name]())));
  return c;
};

/** the Open picker's two groups: Your patches (saved ones newest first, then the community patches added in Library >
 *  Community, community.ts, with their authors) and the factory patches, each XL right under its FM-1 version. The
 *  tutorial's patches open from the course, and community patches show only once added. */
export function openableGroups(): { label: string; items: Openable[] }[] {
  const mine = savedPatches();
  const saved = new Set(mine.map((e) => e.name));
  return [
    {
      label: 'Your patches',
      items: [
        ...mine.map((e) => ({ value: `saved:${e.name}`, name: e.name, from: e.name, load: () => JSON.parse(JSON.stringify(e.patch)) as Patch, chip: () => chipOf(e.patch) })),
        ...addedCommunity()
          .filter((c) => !saved.has(c.entry.title))
          .map((c) => ({ value: `community:${c.entry.title}`, name: c.entry.title, author: c.entry.author, load: () => openCommunity(c), chip: () => chipOfEntry(c) })),
      ],
    },
    { label: 'Factory patches', items: pairXl(Object.keys(PRESETS)).map(({ name, xl }) => ({ value: name, name, xl, load: PRESETS[name], chip: () => factoryChip(name) })) },
  ].filter((g) => g.items.length);
}

/** the Open picker's entry for an option value */
export const openableByValue = (value: string): Openable | undefined => openableGroups().flatMap((g) => g.items).find((o) => o.value === value);
