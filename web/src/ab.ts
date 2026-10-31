// The A/B flip (#103): what a flip from the patch on screen to the other snapshot does. The canvas keeps its layout
// (card and frame positions, frame sizes, expanded or collapsed, the view, the octave); the sound is the target's. When only
// values differ the engines take them as live messages (the voices keep sounding); anything else is a full load.

import { DEFS } from './modules';
import { sameStructure, type Patch, type ModuleInst } from './patch';
import type { StepNote } from './track';

/** one live change, as the editor's onParam / onAtt / onBypass / onRange / onTrack events carry it */
export type LiveMsg =
  | { t: 'param'; id: number; name: string; value: number }
  | { t: 'att'; id: number; index: 0 | 1; value: number }
  | { t: 'bypass'; id: number; on: boolean }
  | { t: 'range'; id: number; index: 0 | 1; name: string; range: [number, number] | null }
  | { t: 'track'; id: number; notes: StepNote[] | undefined };

export interface FlipPlan {
  /** the target with the current patch's canvas fields */
  patch: Patch;
  /** a full load is needed (onStructure: the browser engine loads, the FM-1 takes the patch again) */
  reload: boolean;
  /** with reload false: the changes to send, one per difference */
  live: LiveMsg[];
}

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/** the target with the canvas fields of `current`: module positions and assembly geometry by id (what exists on both
 * sides), the view, the octave and the sidebar toys' sources. The name, the notes and the sound are the target's */
export function keepLayout(current: Patch, target: Patch): Patch {
  const p = clone(target);
  const mods = new Map(current.modules.map((m) => [m.id, m]));
  for (const m of p.modules) {
    const c = mods.get(m.id);
    if (c) [m.x, m.y] = [c.x, c.y];
  }
  const asms = new Map((current.assemblies ?? []).map((a) => [a.id, a]));
  for (const a of p.assemblies ?? []) {
    const c = asms.get(a.id);
    if (!c) continue;
    [a.x, a.y, a.open] = [c.x, c.y, c.open];
    for (const k of ['frameSize', 'size'] as const) {
      if (c[k]) a[k] = { ...c[k] };
      else delete a[k];
    }
  }
  for (const k of ['view', 'octave', 'slackFrom', 'zoomFrom'] as const) {
    if (current[k] !== undefined) (p as unknown as Record<string, unknown>)[k] = clone(current[k]);
    else delete p[k];
  }
  return p;
}

/** a patch without the canvas fields and the fields a live message carries: two patches whose rests match differ only in
 * what live messages can bring across. A field not named here counts, so a new one falls to a full load */
function rest(p: Patch): string {
  const q = clone(p) as unknown as Record<string, unknown> & Patch;
  for (const k of ['view', 'octave', 'slackFrom', 'zoomFrom', 'name', 'morphName', 'notes'] as const) delete q[k];
  for (const m of q.modules as (ModuleInst & Record<string, unknown>)[]) {
    for (const k of ['x', 'y', 'params', 'att', 'bypass', 'range', 'notes'] as const) delete m[k];
  }
  for (const a of q.assemblies ?? []) {
    const r = a as unknown as Record<string, unknown>;
    for (const k of ['x', 'y', 'open', 'frameSize', 'size', 'bypass', 'kept', 'preset']) delete r[k];
  }
  q.cables = [...q.cables].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return JSON.stringify(q);
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** the live messages that take `m` to `t` (one module, same id and type) */
function moduleChanges(m: ModuleInst, t: ModuleInst): LiveMsg[] {
  const out: LiveMsg[] = [];
  const def = DEFS[m.type];
  for (const pd of def?.params ?? []) {
    const v = t.params[pd.name] ?? pd.default;
    if ((m.params[pd.name] ?? pd.default) !== v) out.push({ t: 'param', id: m.id, name: pd.name, value: v });
  }
  const ma = m.att ?? [1, 1];
  const ta = t.att ?? [1, 1];
  for (const k of [0, 1] as const) if (ma[k] !== ta[k]) out.push({ t: 'att', id: m.id, index: k, value: ta[k] });
  if (!!m.bypass !== !!t.bypass) out.push({ t: 'bypass', id: m.id, on: !!t.bypass });
  for (const [s, index] of [['p1', 0], ['p2', 1]] as const) {
    const names = new Set([...Object.keys(m.range?.[s] ?? {}), ...Object.keys(t.range?.[s] ?? {})]);
    for (const name of names) {
      const r = t.range?.[s]?.[name] ?? null;
      if (!same(r, m.range?.[s]?.[name])) out.push({ t: 'range', id: m.id, index, name, range: r ? [r[0], r[1]] : null });
    }
  }
  if (m.type === 'steps' && !same(m.notes, t.notes)) out.push({ t: 'track', id: m.id, notes: t.notes ? clone(t.notes) : undefined });
  return out;
}

/** what a flip from `current` to `target` does (neither is changed) */
export function flipPlan(current: Patch, target: Patch): FlipPlan {
  const patch = keepLayout(current, target);
  const reload = !sameStructure(current, target)
    || current.modules.some((m, i) => m.id !== target.modules[i].id)
    || rest(current) !== rest(target);
  if (reload) return { patch, reload, live: [] };
  return { patch, reload, live: current.modules.flatMap((m, i) => moduleChanges(m, target.modules[i])) };
}
