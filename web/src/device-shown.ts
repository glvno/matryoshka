// SPDX-License-Identifier: GPL-3.0-only
// What the FM-1 addresses of a patch by module index, for the device compile pass (device-compile.ts, D-361, #801). Apart
// from device-compile.ts because its imports would close an import cycle there (patch.ts -> poly.ts ->
// device-compile.ts); every file that runs the pass imports this one, and until one has the pass does not run.
import { DEFS, PANEL_BUTTONS } from './modules';
import type { Patch } from './patch';
import { devicesOf } from './pages';
import { assemblyById, rowTargets } from './assembly';
import { toggleTargets } from './buttons';
import { patternLocks, PATTERNS_MAX } from './track';
import { SHOWN, type Shown } from './device-compile';

/**
 * What the FM-1 addresses of a patch (`p`: with its assemblies, before the device form). Held (kept whatever they reach):
 * the targets of the P-locks (the FM-1 hands a track's locks back after an edit on its SEQ page: one on a module it has
 * not got would be lost) and of the Toggle buttons (a Toggle lights while its targets are bypassed). The parameters it
 * can set: every device's rows and the further parameters a row sets (pages.ts devicesOf: a plain module's device pages
 * all its parameters), an assembly device's card rows (what a preset holds: structure.ts structureAndRows lists them in a
 * preset's order), the P-locks' parameters.
 */
export function shownModules(p: Patch): Shown {
  const held = new Set<number>();
  const sets = new Map<number, Set<string>>();
  const set = (id: number, param: string): void => {
    let s = sets.get(id);
    if (!s) sets.set(id, (s = new Set()));
    s.add(param);
  };
  const byId = new Map(p.modules.map((m) => [m.id, m]));
  for (const d of devicesOf(p, DEFS)) {
    const own = d.module === undefined ? undefined : byId.get(d.module);
    if (own) for (const q of DEFS[own.type]?.params ?? []) set(own.id, q.name);
    for (const pg of d.pages)
      for (const r of pg.rows) for (const t of rowTargets(r)) set(t.module, t.param);
    const a = d.asm === undefined ? undefined : assemblyById(p, d.asm);
    if (a) for (const r of a.params) for (const t of rowTargets(r)) set(t.module, t.param);
  }
  for (const b of PANEL_BUTTONS) for (const id of toggleTargets(p, b)) held.add(id);
  for (const m of p.modules) {
    if (m.type !== 'steps') continue;
    for (let k = 0; k < PATTERNS_MAX; k++)
      for (const l of patternLocks(m, k) ?? []) {
        held.add(l.module);
        set(l.module, l.param);
      }
  }
  return { held, sets };
}

SHOWN.of = shownModules;
