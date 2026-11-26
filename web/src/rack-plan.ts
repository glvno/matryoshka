// SPDX-License-Identifier: GPL-3.0-only
// The FX rack as both engines run it (format 66, #1214): which effects the binary lists, in device order, which of their
// modules switch as one effect with the master FX runtime (D-1100), and the FX drawers. patchbin.ts writes it (rackRecord),
// engine.ts runs it, so the editor's engine and the FM-1's play the same targets.
import { allModules, assemblyById, chainHelpers, rackOf } from './assembly';
import { DEFS } from './modules';
import { thruInput, type Patch } from './patch';
import { devicesOf, type Device } from './pages';
import { deviceView, type DeviceGroup } from './poly';

/** an effect's most targets (engine.h ENG_FX_TARGETS_MAX), all effects' together (ENG_FX_RUNS), the most drawers
 *  (ENG_FX_DRAWERS) */
export const FX_TARGETS_MAX = 8, FX_RUNS = 32, FX_DRAWERS = 16;
/** the devices the binary lists (patchbin.ts MAX_DEVICES) */
const LISTED = 32;

export interface RackPlanEffect {
  /** the effect's assembly */
  asm: number;
  /** its modules that switch together with the master FX runtime (module ids); [] when it switches by ordinary bypass:
   *  more than FX_TARGETS_MAX, past FX_RUNS in all, or a module that cannot run so (in a poly group, no through input) */
  targets: number[];
}
export interface RackPlanDrawer {
  /** the instrument's assembly, or the Output drawer */
  owner: number | 'output';
  /** its listed effects' assemblies, in chain order */
  effects: number[];
}
export interface RackPlan {
  /** every listed effect (fx-drawer.ts rackOf: in a drawer or on the canvas), in device order */
  effects: RackPlanEffect[];
  drawers: RackPlanDrawer[];
  /** fx-drawer.ts chainHelpers: run unbypassed, left out of every Toggle */
  helpers: Set<number>;
}

/** the patch's FX rack as the binary holds it, null when it has none (`view`: its compiled device form, poly.ts
 *  deviceView(source, true), worked out here when not given). An effect or drawer whose device the binary leaves out (past
 *  the first 32 devices, or without a row on a module the device form keeps: patchbin.ts deviceSection) is not in it. */
export function rackPlan(source: Patch, view?: { patch: Patch; groups: readonly DeviceGroup[] }): RackPlan | null {
  const rack = rackOf(source);
  if (!rack.effects.length && !rack.drawers.length) return null;
  const { patch: dev, groups } = view ?? deviceView(source, true);
  const byId = new Map(dev.modules.map((m) => [m.id, m]));
  const listed = (d: Device): boolean => d.pages.some((pg) => pg.rows.some((r) => {
    const m = byId.get(r.module);
    return !!m && (m.type === 'part' || DEFS[m.type].params.some((q) => q.name === r.param));
  }));
  const devs = devicesOf(source, DEFS).slice(0, LISTED);
  const deviceAt = (asm: number): number => devs.findIndex((d) => d.asm === asm && listed(d));
  const helpers = chainHelpers(source);
  const poly = new Set(groups.flatMap((g) => [...g.modules]));
  let runs = 0;
  const effects = rack.effects.map((e) => ({ asm: e.asm, device: deviceAt(e.asm) })).filter((e) => e.device >= 0)
    .sort((a, b) => a.device - b.device).map(({ asm }): RackPlanEffect => {
      const a = assemblyById(source, asm);
      const members = (a ? allModules(source, a) : []).filter((id) => !helpers.has(id)).flatMap((id) => byId.get(id) ?? []);
      const runnable = members.length <= FX_TARGETS_MAX && runs + members.length <= FX_RUNS
        && members.every((m) => !poly.has(m.id) && thruInput(DEFS[m.type]) !== undefined);   // (a stereo module is one target, #1141)
      if (!runnable) return { asm, targets: [] };
      runs += members.length;
      return { asm, targets: members.map((m) => m.id) };
    });
  const inRack = new Set(effects.map((e) => e.asm));
  const drawers = rack.drawers.filter((d) => d.owner === 'output' || deviceAt(d.owner) >= 0).slice(0, FX_DRAWERS)
    .map((d): RackPlanDrawer => ({ owner: d.owner, effects: d.effects.filter((id) => inRack.has(id)) }));
  return effects.length || drawers.length ? { effects, drawers, helpers } : null;
}

/** the modules the FX rack switches as effects (module ids): schedule.ts orders a stereo one's copies (#1141) */
export const rackTargets = (source: Patch): Set<number> => new Set(rackPlan(source)?.effects.flatMap((e) => e.targets) ?? []);
