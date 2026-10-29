// SPDX-License-Identifier: GPL-3.0-only
import { DEFS } from './modules';
import { addModule, connect, emptyPatch, validatePatch, type Patch, type Source } from './patch';

export interface AddOpts {
  map?: Partial<Record<Source, string[]>>;
  att?: [number, number];
}
export type Build = (add: (type: string, x: number, y: number, params?: Record<string, number>, opts?: AddOpts) => number, wire: (a: number, ap: string, b: number, bp: string) => void) => void;

export function make(name: string, build: Build): Patch {
  const p = emptyPatch(name);
  const add = (type: string, x: number, y: number, params: Record<string, number> = {}, opts: AddOpts = {}): number => {
    const m = addModule(p, DEFS[type], Math.round(x * 1.3), Math.round(y * 1.3)); // cards are wider and taller than they used to be
    Object.assign(m.params, params);
    if (opts.map) Object.assign(m.map!, opts.map);
    if (opts.att) m.att = opts.att;
    return m.id;
  };
  const wire = (a: number, ap: string, b: number, bp: string): void => {
    if (!connect(p, DEFS, { module: a, port: ap }, { module: b, port: bp })) throw new Error(`preset ${name}: bad cable ${a}.${ap} -> ${b}.${bp}`);
  };
  build(add, wire);
  return p;
}

/** an XL's name: its FM-1 version's name and " XL" ("Algo Four XL") */
export const XL_SUFFIX = ' XL';
/** the FM-1 version an XL is named after ("Algo Four XL" -> "Algo Four"); undefined: not an XL's name */
export const xlBase = (name: string): string | undefined => (name.endsWith(XL_SUFFIX) ? name.slice(0, -XL_SUFFIX.length) : undefined);

const load = (raw: unknown): Patch => validatePatch(structuredClone(raw), DEFS);

/** a factory patch's file, checked (validatePatch) the first time it is opened rather than when the page loads: its name
 * is read from the file as validatePatch reads it */
interface Entry { name: string; patch: () => Patch }
const entries = (files: Record<string, unknown>): Entry[] =>
  Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1)).map(([, raw]) => {
    let p: Patch | undefined;
    const name = String((raw as { name?: unknown } | null)?.name ?? 'patch');
    shapes.set(name, shapeOf(raw as Patch));
    return { name, patch: () => (p ??= load(raw)) };
  });

/** what sameStructure (patch.ts) compares first, cheaply: the module types in order and the number of cables. Two patches of
 * different shapes never have the same structure */
export const shapeOf = (p: Pick<Patch, 'modules' | 'cables'>): string => `${p.modules.map((m) => m.type).join(',')}|${p.cables.length}`;
const shapes = new Map<string, string>();
/** a factory patch's shape, read from its file without building the patch (checking it keeps every factory patch's shape:
 * presets.test.ts) */
export const factoryShape = (name: string): string | undefined => shapes.get(name);
const makers = (es: Entry[]): Record<string, () => Patch> => Object.fromEntries(es.map((e): [string, () => Patch] => [e.name, () => structuredClone(e.patch())]));

/**
 * The browser's list of factory patches: the FM-1's, each followed by its XLs (an XL whose FM-1 version is missing comes
 * at the end). The order is what the Open picker shows.
 */
export function withXls<T extends { name: string }>(fm1: T[], xls: T[]): T[] {
  const out: T[] = [];
  const placed = new Set<T>();
  for (const p of fm1) {
    out.push(p);
    for (const x of xls) if (xlBase(x.name) === p.name && !placed.has(x)) (out.push(x), placed.add(x));
  }
  return [...out, ...xls.filter((x) => !placed.has(x))];
}

/** The FM-1's factory patches: web/presets/NN-name.json (NN = slot in the bank, the order the firmware compiles them in).
 * Everything that goes to the FM-1 (export-defs, the bank, the golden kits, the CPU measurements) reads these, never PRESETS. */
const fm1Files = import.meta.glob<unknown>('../presets/*.json', { eager: true, import: 'default' });
const FM1_LIST = entries(fm1Files);
export const FM1_PRESETS: Record<string, () => Patch> = makers(FM1_LIST);

/** The XLs: web/presets/xl/<name>.json (scripts/gen-xl.ts), full browser versions of factory patches cut down to fit the
 * FM-1. Browser only: never in the FM-1's bank, presets.h or the emulated PRESET. */
const xlFiles = import.meta.glob<unknown>('../presets/xl/*.json', { eager: true, import: 'default' });
const XL_LIST = entries(xlFiles);
export const XL_PRESETS: Record<string, () => Patch> = makers(XL_LIST);

/** Every factory patch the browser offers (FM1_PRESETS with each XL after its FM-1 version). Each call returns a fresh copy. */
export const PRESETS: Record<string, () => Patch> = makers(withXls(FM1_LIST, XL_LIST));

/** a factory patch that is an XL (browser only) */
export const isXl = (name: string): boolean => name in XL_PRESETS;
