// SPDX-License-Identifier: GPL-3.0-only
// P-locks as the engines play them (#524): which parameters each locked row sets and each pattern's locks, in the device
// form's module indices. patchbin.ts lockRecord writes this plan into the binary (engine.c reads it back the same way);
// engine.ts plays it. One plan for both, so the browser and the FM-1 lock the same parameters.
import { DEFS } from './modules';
import type { ParamDef, Patch } from './patch';
import { devicesOf, findRow, type Device } from './pages';
import { LOCK_ROWS_MAX, LOCKS_MAX, patternLocks, PATTERNS_MAX } from './track';

/** the most parameters one locked row sets: its own and the further ones of its page row (engine.c ENG_LOCK_PAIRS) */
export const LOCK_PAIRS_MAX = 6;
/** the most locked rows a patch holds, all tracks together (engine.c ENG_LOCK_TARGETS), and the most locks (ENG_MAX_LOCKS,
 * patchbin.ts DEVICE.locks) */
export const LOCK_TARGETS_MAX = 32;
export const PATCH_LOCKS_MAX = 256;

/** a lock's value as both engines play it: within the parameter's range, to its top (a stretch past max, ParamDef.top) */
export const lockValue = (pd: ParamDef, v: number): number => Math.min(pd.top ?? pd.max, Math.max(pd.min, v));

export interface LockTrack {
  /** the Steps module's index in the device form */
  track: number;
  /** per locked row the parameters it sets (module index, parameter index), its own first */
  rows: [number, number][][];
  /** per pattern with locks (0-based) its locks: step, row (index into rows), value (the row's parameter's units, clamped) */
  pats: { p: number; locks: { at: number; row: number; value: number }[] }[];
}

/**
 * The patch's locks that play (`dev`: the device form of `source`). A lock plays when its module is in the device form and
 * its parameter is a plain one (a Voice allocator's settings never lock). A row's further parameters come from the device
 * page row it is on (pages.ts findRow: PageRow.also). Rows past LOCK_ROWS_MAX of a track or LOCK_TARGETS_MAX of the patch,
 * and locks past PATCH_LOCKS_MAX, are left out.
 */
export function lockPlan(source: Patch, dev: Patch): LockTrack[] {
  const tracks = dev.modules.flatMap((m, i) => (m.type === 'steps' && (m.locks?.length || m.patterns?.some((x) => x?.locks?.length)) ? [i] : []));
  if (!tracks.length) return [];
  const index = new Map(dev.modules.map((m, i) => [m.id, i]));
  let devices: Device[] | null = null;
  const pairOf = (module: number, param: string): [number, number] | null => {
    const i = index.get(module);
    if (i === undefined || dev.modules[i].type === 'part') return null;
    const j = DEFS[dev.modules[i].type]?.params.findIndex((q) => q.name === param) ?? -1;
    return j < 0 ? null : [i, j];
  };
  const out: LockTrack[] = [];
  let targets = 0, total = 0;
  for (const ti of tracks) {
    const m = dev.modules[ti];
    const keys: string[] = [];
    const t: LockTrack = { track: ti, rows: [], pats: [] };
    for (let p = 0; p < PATTERNS_MAX; p++) {
      const list: LockTrack['pats'][number]['locks'] = [];
      for (const l of (patternLocks(m, p) ?? []).slice(0, LOCKS_MAX)) {
        const own = pairOf(l.module, l.param);
        if (!own || total >= PATCH_LOCKS_MAX) continue;
        const key = `${l.module}/${l.param}`;
        let r = keys.indexOf(key);
        if (r < 0) {
          if (keys.length >= LOCK_ROWS_MAX || targets >= LOCK_TARGETS_MAX) continue;
          devices ??= devicesOf(source, DEFS);
          const at = findRow(devices, l.module, l.param);
          const row = at ? devices[at.device].pages[at.page].rows[at.row] : undefined;
          const pairs: [number, number][] = [own];
          for (const x of row?.also ?? []) {
            const q = pairOf(x.module, x.param);
            if (q && pairs.length < LOCK_PAIRS_MAX && !pairs.some((y) => y[0] === q[0] && y[1] === q[1])) pairs.push(q);
          }
          keys.push(key);
          r = t.rows.push(pairs) - 1;
          targets++;
        }
        list.push({ at: l.at, row: r, value: lockValue(DEFS[dev.modules[own[0]].type].params[own[1]], l.value) });
        total++;
      }
      if (list.length) t.pats.push({ p, locks: list });
    }
    if (t.pats.length) out.push(t);
  }
  return out;
}
