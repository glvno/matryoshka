// SPDX-License-Identifier: GPL-3.0-only
// Stereo mode (#1141, release 1.27): a module of an eligible type (ModuleDef.stereo) runs as two copies, L and R, with
// one set of parameters (ModuleInst.stereo). The editor's ST button on the card sets it (a structural edit); inside a poly
// assembly it is off (its modules run once per voice there). Not a parameter: no preset, Mutate or structure sees it.
import { DEFS, RIGHT_OUT } from './modules';
import type { Cable, ModuleInst, Patch } from './patch';
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

/** a Stereo utility's stereo jacks (#1324): its `in` and its `out` carry both sides */
export const stereoJack = (type: string, port: string): boolean => type === 'stutil' && (port === 'in' || port === 'out');

/** what a cable carries (feeds.ts, the same rules), for its line and its mark: 'both' sides; 'avg', both averaged into a
 *  mono jack ((L + R) / 2); 'left', a stereo outlet's left alone into a mono jack; null, one signal */
export function cableSides(p: Patch, c: Cable): 'both' | 'avg' | 'left' | null {
  if (c.side) return null;
  const type = (id: number): string => p.modules.find((m) => m.id === id)?.type ?? '';
  const from = type(c.from.module), to = type(c.to.module);
  const intoPair = stereoModule(p, c.to.module) || (to === 'stutil' && c.to.port === 'in') ||
    (PAIR_LEFT[to] === c.to.port && !p.cables.some((x) => x.to.module === c.to.module && x.to.port === 'r'));
  if (stereoModule(p, c.from.module)) return stereoModule(p, c.to.module) || intoPair ? 'both' : 'avg';
  // a pair's left output: both sides into a stereo module (#1141), and from a Stereo utility's `out` or into its `in` (#1324)
  // into an input pair too; else its left
  if (!RIGHT_OUT[from] || c.from.port !== DEFS[from].outputs[0].name) return null;
  if (stereoModule(p, c.to.module) || ((from === 'stutil' || to === 'stutil') && intoPair)) return 'both';
  return from === 'stutil' ? 'left' : null;
}

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
