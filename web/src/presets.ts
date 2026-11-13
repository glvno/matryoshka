// SPDX-License-Identifier: GPL-3.0-only
import EXAMPLES from '../factory/examples.json';
import { buildSelectedFactoryBank, selectedFactoryNames, type FactoryCandidate } from './factory-bank';
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


const load = (raw: unknown): Patch => validatePatch(structuredClone(raw), DEFS);

/** A named patch loaded only when opened. Editor example files are validated on first use. */
interface Entry { name: string; patch: () => Patch }

/** what sameStructure (patch.ts) compares first, cheaply: the module types in order and the number of cables. Two patches of
 * different shapes never have the same structure */
export const shapeOf = (p: Pick<Patch, 'modules' | 'cables'>): string => `${p.modules.map((m) => m.type).join(',')}|${p.cables.length}`;
const shapes = new Map<string, string>();
/** Lazily build the selected patch's shape, including its players and FX. */
export const factoryShape = (name: string): string | undefined => {
  if (!shapes.has(name) && PRESETS[name]) shapes.set(name, shapeOf(PRESETS[name]()));
  return shapes.get(name);
};
const makers = (es: Entry[]): Record<string, () => Patch> => Object.fromEntries(es.map((e): [string, () => Patch] => [e.name, () => structuredClone(e.patch())]));


/** Approved defaults, built once on first open. Generated JSON is an export, not the provider. */
let bank: FactoryCandidate[] | undefined;
const FM1_LIST: Entry[] = selectedFactoryNames.map((name, index) => ({
  name, patch: () => (bank ??= buildSelectedFactoryBank())[index].patch,
}));
export const FM1_PRESETS: Record<string, () => Patch> = makers(FM1_LIST);

/** Original editor/assembly examples never enter the hardware defaults. */
export const EXAMPLE_PRESETS: Record<string, () => Patch> = makers(EXAMPLES.map(({ name, patch }) => {
  let checked: Patch | undefined;
  return { name, patch: () => checked ??= load(patch) };
}));

/** Everything the editor can open directly, independently of the opt-in Community catalogue. */
export const PRESETS: Record<string, () => Patch> = { ...FM1_PRESETS, ...EXAMPLE_PRESETS };

