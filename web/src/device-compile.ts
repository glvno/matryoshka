// SPDX-License-Identifier: GPL-3.0-only
// The device compile pass: the last step of poly.ts deviceView, so the browser engine, the binary for the FM-1, the
// budget and the CPU estimate all see it. It changes what runs, never what comes out (device-compile.test.ts renders
// every factory patch and assembly with and without it and compares them sample for sample):
//   - dead modules go (D-361, #801): a module stays when something heard depends on it, directly or through other
//     modules. Heard: the Output and the Main module (its morph input). Kept for what they do of their own, whatever
//     their outputs reach: every Steps track (the FM-1's SEQ page lists every track, one not cabled yet too, #83),
//     Arpeggiator and Drum map, the Arpeggiator or track a poly group plays
//     (DeviceGroup.src: its keys cables are gone in the device form), and what the FM-1 addresses by index and would
//     otherwise lose (device-shown.ts shownModules: a P-lock's target, which the FM-1 hands back with the track's locks;
//     a Toggle's targets, whose bypass is its light). Part modules always stay (a poly group's notes need them). A module
//     no one hears is not on the FM-1's pages either: its rows and a device made only of such modules are left out
//     (patchbin.ts deviceSection). Some modules start from their index in the patch (a Random module's, a Steps
//     track's and a Shift register's seed, an oscillator's analog tolerances while its analog amount can be above 0:
//     engine.ts instSeed, engine.c inst_init), so dead modules before the last of those that stays stay too (removing
//     them would reseed it). Indices change when modules go: everything the editor and the FM-1 exchange by module index
//     maps through this form (device.ts deviceIndex, main.ts fm1Event, arm.ts armMask), and a change to what goes
//     changes the bytes, so Live sends the whole patch again.
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
const PER_VOICE = new Set(['part', 'random', 'shreg', 'steps', 'fm1', 'output']);
const TRACKING = new Set(['filter', 'ladder']);

/** does a filter / ladder possibly follow the played pitch (its track switch on, in either morph set, or modulated)? */
function mayTrack(m: ModuleInst, shown: () => Shown): boolean {
  if ((m.params.track ?? 0) >= 0.5 || (m.paramsB?.track ?? 0) >= 0.5) return true;
  const mapped = (x: Record<string, string[] | undefined> | undefined): boolean => !!x && Object.values(x).some((l) => l?.includes('track'));
  return mapped(m.map as Record<string, string[]> | undefined) || mapped(m.inputMap as Record<string, string[]> | undefined) || Object.values(m.range ?? {}).some((r) => !!r && 'track' in r)
    || !!shown().sets.get(m.id)?.has('track');
}

/** does any part of the group carry a flaw that scales this module type's parameters? */
function flawed(g: CompileGroup, type: string): boolean {
  const f = g.cfg.flaws ?? [];
  return (Object.keys(FLAW_TARGETS) as (keyof typeof FLAW_TARGETS)[]).some((key) => FLAW_TARGETS[key][type] && f.some((x) => x && x[key] !== (key === 'level' ? 100 : 0)));
}

/** what the FM-1 addresses of a patch (device-shown.ts shownModules): `held`, modules kept whatever they reach (a
 * P-lock's target, a Toggle's targets); `sets`, per module id the parameters the FM-1 can set (a device page's rows and
 * the further parameters a row sets, a plain module's device: all its parameters, an assembly's card rows, P-locks) */
export interface Shown { held: Set<number>; sets: Map<number, Set<string>> }

/** what the FM-1 addresses of a patch (device-shown.ts shownModules installs itself here: importing it would close an
 * import cycle through patch.ts, which needs this file through poly.ts; every file that runs the pass for the FM-1
 * imports it). Until it is installed the pass does not run: what the FM-1 addresses must never be dropped */
export const SHOWN: { of: ((p: Patch) => Shown) | null } = { of: null };

/** module types kept for what they do of their own, whatever their outputs reach (see the top of this file) */
const KEPT = new Set(['output', 'fm1', 'steps', 'arp', 'drummap']);

/** what the FM-1 addresses, or a function that works it out when the pass first needs it (most patches never need it:
 * every module is heard, and no oscillator in a poly group is a candidate to run once) */
export type ShownSource = Shown | (() => Shown);
const lazy = (s: ShownSource | undefined): (() => Shown) => {
  if (s === undefined) return () => ({ held: new Set(), sets: new Map() });
  if (typeof s !== 'function') return () => s;
  let v: Shown | undefined;
  return () => (v ??= s());
};

/** can parameter `name` of `m` be other than its value in the A set: its B value, a cable or a macro, or the FM-1 (a row,
 * a P-lock: `shown`) can set it? */
function mayMove(m: ModuleInst, name: string, shown: () => Shown): boolean {
  const mapped = (x: Record<string, string[] | undefined> | undefined): boolean => !!x && Object.values(x).some((l) => l?.includes(name));
  return (!!m.paramsB && name in m.paramsB && m.paramsB[name] !== m.params[name]) || mapped(m.map as Record<string, string[]> | undefined)
    || mapped(m.inputMap as Record<string, string[]> | undefined) || Object.values(m.range ?? {}).some((r) => !!r && name in r)
    || !!shown().sets.get(m.id)?.has(name);
}

/** does the module's sound depend on its index in the patch (engine.ts instSeed: a Random module's, a Steps track's and a
 * Shift register's seed; an oscillator's analog tolerances while its analog amount can be above 0)? */
export function seeded(m: ModuleInst, shown?: ShownSource): boolean {
  if (m.type === 'random' || m.type === 'steps' || m.type === 'shreg') return true;
  return m.type === 'osc' && ((m.params.analog ?? 0) > 0 || (m.paramsB?.analog ?? 0) > 0 || mayMove(m, 'analog', lazy(shown)));
}

/** the modules nothing heard depends on (ids; see the top of this file). `roots`: modules that count as heard (the
 * groups' Arpeggiators and tracks); `shown`: what the FM-1 addresses (device-shown.ts shownModules) */
export function deadModules(p: Patch, roots: number[] = [], shown?: ShownSource): Set<number> {
  const seen = lazy(shown);
  const into = new Map<number, number[]>();
  for (const c of p.cables) into.set(c.to.module, [...(into.get(c.to.module) ?? []), c.from.module]);
  const live = new Set<number>();
  const reach = (stack: number[]): void => {
    while (stack.length) {
      const id = stack.pop()!;
      if (live.has(id)) continue;
      live.add(id);
      for (const f of into.get(id) ?? []) stack.push(f);
    }
  };
  reach([...p.modules.filter((m) => KEPT.has(m.type)).map((m) => m.id), ...roots]);
  const left = (): ModuleInst[] => p.modules.filter((m) => !live.has(m.id) && m.type !== 'part');
  if (!left().length) return new Set();
  reach([...seen().held]);
  const lastSeeded = p.modules.reduce((k, m, i) => (live.has(m.id) && seeded(m, seen) ? i : k), -1);
  return new Set(left().filter((m) => p.modules.indexOf(m) > lastSeeded).map((m) => m.id));
}

/** the modules of group `g` that can run once (ids) */
export function hoistable(p: Patch, g: CompileGroup, shown?: ShownSource): Set<number> {
  const seen = lazy(shown);
  const byId = new Map(p.modules.map((m) => [m.id, m]));
  const eligible = (id: number): boolean => {
    const m = byId.get(id);
    if (!m || PER_VOICE.has(m.type)) return false;
    if (TRACKING.has(m.type) && mayTrack(m, seen)) return false;
    if (seeded(m, seen)) return false;   // (an oscillator's analog tolerances differ per voice)
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

/** apply the pass to a device-form patch and its groups (both new objects; the inputs are not changed); `shown`: what the
 * FM-1 addresses of the patch (device-shown.ts shownModules of the patch before the device form); null: the pass does
 * not run (SHOWN) */
export function compileDevice<G extends CompileGroup>(p: Patch, groups: G[], shown: ShownSource | null): { patch: Patch; groups: G[] } {
  if (!DEVICE_COMPILE.on || !shown) return { patch: p, groups };
  const seen = lazy(shown);
  const dead = deadModules(p, groups.flatMap((g) => (g.src === undefined ? [] : [g.src])), seen);
  const q: Patch = dead.size
    ? { ...p, modules: p.modules.filter((m) => !dead.has(m.id)), cables: p.cables.filter((c) => !dead.has(c.from.module) && !dead.has(c.to.module)) }
    : p;
  const out = groups.map((g) => {
    const modules = new Set([...g.modules].filter((id) => !dead.has(id)));
    const h = hoistable(q, { ...g, modules }, seen);
    for (const id of h) modules.delete(id);
    return { ...g, modules };
  });
  return { patch: q, groups: out };
}
