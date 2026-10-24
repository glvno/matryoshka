// SPDX-License-Identifier: GPL-3.0-only
// An XL: the full browser version of a factory patch that was cut down to fit the FM-1, named "<FM-1 version> XL"
// (docs/ledger/patches-and-presets.md D-338). Each XL is one file, scripts/xl/<slug>.ts, exporting `xl` (an Xl), plus one
// line in scripts/xl/index.ts; gen-xl.ts writes them to web/presets/xl/<slug>.json, where src/presets.ts finds them.
// XLs never go to the FM-1, so the FM-1's budget does not bind them: one over it is a sandbox patch.
import { DEFS } from '../../src/modules';
import { validatePatch, type Patch } from '../../src/patch';
import { deviceBudget, type Budget } from '../../src/patchbin';
import { XL_SUFFIX } from '../../src/presets';

export interface Xl {
  /** the FM-1 version's name (a factory patch in web/presets): the XL is named after it, "<base> XL" */
  base: string;
  /** the XL, from a fresh copy of its FM-1 version (start from it, or ignore it and build anew: factory-build.ts) */
  build(fm1: Patch): Patch;
}

export interface BuiltXl {
  patch: Patch;
  /** what it costs on the FM-1, for the log: an XL that fits is allowed */
  budget: Budget;
}

/** the file an XL is written to in web/presets/xl */
export const xlFile = (name: string): string => `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}.json`;

/** build the XLs against the FM-1's factory patches: each named "<base> XL", checked, in registry order. Throws on an XL
 * whose FM-1 version does not exist and on two XLs of one name. */
export function buildXls(xls: Xl[], fm1: Record<string, () => Patch>): BuiltXl[] {
  const seen = new Set<string>();
  return xls.map((x) => {
    const from = fm1[x.base];
    if (!from) throw new Error(`XL of "${x.base}": there is no FM-1 factory patch of that name`);
    const name = x.base + XL_SUFFIX;
    if (seen.has(name)) throw new Error(`two XLs named "${name}"`);
    seen.add(name);
    const patch = validatePatch(structuredClone({ ...x.build(from()), name }), DEFS);
    return { patch, budget: deviceBudget(patch) };
  });
}
