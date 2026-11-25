// SPDX-License-Identifier: GPL-3.0-only
// Stereo mode (#1141, release 1.27): a module of an eligible type (ModuleDef.stereo) runs as two copies, L and R, with
// one set of parameters (ModuleInst.stereo). The editor's ST button on the card sets it (a structural edit); inside a poly
// assembly it is off (its modules run once per voice there). Not a parameter: no preset, Mutate or structure sees it.
import { DEFS } from './modules';
import type { ModuleInst, Patch } from './patch';
import { polyOfModule } from './poly';

/** the left jack of a type's input pair (the right one is `r`): a stereo cable into it while `r` is free gives L to it and
 *  R to `r`; into any other mono jack it averages the sides (C2) */
export const PAIR_LEFT: Record<string, string> = { output: 'l', delay: 'in', reverb: 'in', chorus: 'in' };

/** why `m` cannot run in stereo, or null; undefined when its type has no stereo mode at all (no ST button) */
export function stereoProblem(p: Patch, m: ModuleInst): string | null | undefined {
  if (!DEFS[m.type]?.stereo) return undefined;
  const poly = polyOfModule(p, m.id);
  return poly ? `Stereo is off inside the poly assembly "${poly.label}": its modules run once per voice there` : null;
}

/** `m` runs as an L/R pair of copies: stereo set, an eligible type, outside every poly assembly */
export const runsStereo = (p: Patch, m: ModuleInst | undefined): boolean => !!m?.stereo && stereoProblem(p, m) === null;

/** the module with this id runs in stereo */
export const stereoModule = (p: Patch, id: number): boolean => runsStereo(p, p.modules.find((m) => m.id === id));

/** stereo mode on or off; throws the reason when it cannot be on */
export function setStereo(p: Patch, m: ModuleInst, on: boolean): void {
  if (!on) {
    delete m.stereo;
    return;
  }
  const why = stereoProblem(p, m);
  if (why === undefined) throw new Error(`A ${DEFS[m.type]?.label ?? m.type} has no stereo mode.`);
  if (why) throw new Error(why);
  m.stereo = true;
}
