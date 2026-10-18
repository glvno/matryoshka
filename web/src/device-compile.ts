// SPDX-License-Identifier: GPL-3.0-only
// The device compile pass: the last step of poly.ts deviceView, so the browser engine, the binary for the FM-1, the
// budget and the CPU estimate all see it. It changes what runs, never what comes out (device-compile.test.ts renders
// every factory patch and assembly with and without it and compares them sample for sample):
//   - dead modules go: nothing they output reaches an Output or the Main module (its morph input), directly or through
//     other modules, so they cannot be heard. An Arpeggiator that plays a poly group (DeviceGroup.src: its keys cables are
//     gone in the device form) is live too, with whatever feeds it (its clock). A Random module seeds from its index in the patch (engine.ts instSeed), so
//     modules before the last Random module stay (removing them would reseed it); Part modules always stay (a poly
//     group's notes need it), and so do Steps modules (the FM-1's SEQ page lists every track).
//   - modules hoisted out of a poly group run once instead of once per voice: their inputs come only from outside the
//     group (or from other hoisted modules), so every copy would compute the same thing; their outputs stay inside the
//     group (a cable leaving a poly group sums its copies, which a single copy would not); and nothing about them depends on
//     the voice: not a Part or Random module (per-voice notes, per-voice seeds), not a filter / ladder that can track the
//     played pitch, not a module a part's flaws scale (FLAW_TARGETS) when the group has flaws. Copies are identical only
//     if they start alike: they do when a patch loads (a voice added later by a live edit starts fresh, then plays the
//     hoisted module's one copy like the others).
import { FLAW_TARGETS, type Cable, type ModuleInst, type Patch } from './patch';

/** the compile pass can be switched off (the tests render both ways) */
export const DEVICE_COMPILE = { on: true };

export interface CompileGroup {
  modules: Set<number>;
  cfg: { flaws?: { detune: number; drift: number; bright: number; env: number; level: number }[] };
  /** the Arpeggiator (id) whose notes the group plays (poly.ts DeviceGroup.src) */
  src?: number;
}

/** module types that never run once for all voices: they read the voice (Part, key tracking) or seed per voice */
const PER_VOICE = new Set(['part', 'random', 'fm1', 'output']);
const TRACKING = new Set(['filter', 'ladder']);

/** does a filter / ladder possibly follow the played pitch (its track switch on, in either morph set, or modulated)? */
function mayTrack(m: ModuleInst): boolean {
  if ((m.params.track ?? 0) >= 0.5 || (m.paramsB?.track ?? 0) >= 0.5) return true;
  const mapped = (x: Record<string, string[] | undefined> | undefined): boolean => !!x && Object.values(x).some((l) => l?.includes('track'));
  return mapped(m.map as Record<string, string[]> | undefined) || mapped(m.inputMap as Record<string, string[]> | undefined) || Object.values(m.range ?? {}).some((r) => !!r && 'track' in r);
}

/** does any part of the group carry a flaw that scales this module type's parameters? */
function flawed(g: CompileGroup, type: string): boolean {
  const f = g.cfg.flaws ?? [];
  return (Object.keys(FLAW_TARGETS) as (keyof typeof FLAW_TARGETS)[]).some((key) => FLAW_TARGETS[key][type] && f.some((x) => x && x[key] !== (key === 'level' ? 100 : 0)));
}

/** the modules nothing audible depends on (ids); `roots`: modules that count as heard (the groups' Arpeggiators). Steps
 * modules always count: the FM-1's SEQ page lists every track, one not cabled yet too (#83) */
export function deadModules(p: Patch, roots: number[] = []): Set<number> {
  const into = new Map<number, number[]>();
  for (const c of p.cables) into.set(c.to.module, [...(into.get(c.to.module) ?? []), c.from.module]);
  const live = new Set<number>();
  const stack = [...p.modules.filter((m) => m.type === 'output' || m.type === 'fm1' || m.type === 'steps').map((m) => m.id), ...roots];
  while (stack.length) {
    const id = stack.pop()!;
    if (live.has(id)) continue;
    live.add(id);
    for (const f of into.get(id) ?? []) stack.push(f);
  }
  const lastRandom = p.modules.reduce((k, m, i) => (m.type === 'random' ? i : k), -1);
  return new Set(p.modules.filter((m, i) => !live.has(m.id) && i > lastRandom && m.type !== 'part').map((m) => m.id));
}

/** the modules of group `g` that can run once (ids) */
export function hoistable(p: Patch, g: CompileGroup): Set<number> {
  const byId = new Map(p.modules.map((m) => [m.id, m]));
  const eligible = (id: number): boolean => {
    const m = byId.get(id);
    if (!m || PER_VOICE.has(m.type)) return false;
    if (TRACKING.has(m.type) && mayTrack(m)) return false;
    return !flawed(g, m.type);
  };
  const ins = new Map<number, Cable[]>();
  for (const c of p.cables) ins.set(c.to.module, [...(ins.get(c.to.module) ?? []), c]);
  // forward closure: inputs only from outside the group or from modules already taken
  const h = new Set<number>();
  for (let grew = true; grew; ) {
    grew = false;
    for (const id of g.modules) {
      if (h.has(id) || !eligible(id)) continue;
      if ((ins.get(id) ?? []).every((c) => !g.modules.has(c.from.module) || h.has(c.from.module))) {
        h.add(id);
        grew = true;
      }
    }
  }
  // a cable leaving the group sums its copies: a module feeding the outside keeps them
  for (const c of p.cables) if (h.has(c.from.module) && !g.modules.has(c.to.module)) h.delete(c.from.module);
  return h;
}

/** apply the pass to a device-form patch and its groups (both new objects; the inputs are not changed) */
export function compileDevice<G extends CompileGroup>(p: Patch, groups: G[]): { patch: Patch; groups: G[] } {
  if (!DEVICE_COMPILE.on) return { patch: p, groups };
  const dead = deadModules(p, groups.flatMap((g) => (g.src === undefined ? [] : [g.src])));
  const q: Patch = dead.size
    ? { ...p, modules: p.modules.filter((m) => !dead.has(m.id)), cables: p.cables.filter((c) => !dead.has(c.from.module) && !dead.has(c.to.module)) }
    : p;
  const out = groups.map((g) => {
    const modules = new Set([...g.modules].filter((id) => !dead.has(id)));
    const h = hoistable(q, { ...g, modules });
    for (const id of h) modules.delete(id);
    return { ...g, modules };
  });
  return { patch: q, groups: out };
}
