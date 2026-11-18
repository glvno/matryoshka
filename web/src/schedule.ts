// SPDX-License-Identifier: GPL-3.0-only
import { DEFS, STACKS } from './modules';
import type { ModuleInst, Patch } from './patch';
import type { DeviceGroup } from './poly';

/** engine.c SCH_SYNC and SCH_FORK: a wait across the cores, and handing the job over, in schedule cost units (64 cycles) */
export const SCH_SYNC = 6;
export const SCH_FORK = 24;
/** engine.c SCH_KMAX, SCH_RV_MIX, ENG_MAX_INST (D-1103): Reverb kernels with an item of their own; a Reverb's own turn once
 * its kernel has one (the mix), in schedule cost units; the module copies (sch.it holds one more item) */
export const SCH_KMAX = 4;
export const SCH_RV_MIX = 16;
/** engine.c SCH_ITEM, SCH_GAIN: what the rig's plan adds for each item (rendering an item beyond its module's own time,
 * measured on the test rig); the CPU table's plan stays unless the rig's ends sooner by 1 / SCH_GAIN, both counted at the
 * rig's costs (#1073) */
export const SCH_ITEM = 4;
export const SCH_GAIN = 25;
const MAX_INST = 254;

/** one copy's cost in the plan's units (64 cycles) by module type (engine.c DEF_COST or DEF_TCOST), and a module's that is
 * bypassed when the patch loads (DEF_COST_BYPASS or DEF_TCOST_BYPASS, D-1104: a master FX stage's targets as saved) */
export interface PlanCosts {
  cost: (type: string) => number;
  bypass: number;
}

/** the copies of an oscillator's wave it plays (engine.c sch_voices, m_osc: its unison or its stack's notes, the more) */
export function oscVoices(m: ModuleInst): number {
  const param = (name: string): number => m.params[name] ?? DEFS.osc.params.find((d) => d.name === name)?.default ?? 0;
  return Math.max(Math.min(5, Math.max(1, Math.round(param('unison')))), STACKS[Math.min(4, Math.max(0, Math.round(param('stack'))))].length);
}
/** A patch's two-core schedule on the FM-1 (#802, engine.c sched_build). An item is one copy of a module of the device form:
 * one part's in its poly group, else the module's. `order` is engine.c's E.order (module indices), `copies[m]` a module's
 * copies, `lane[m][v]` the core of its copy v (1: the second core). A Reverb with a kernel item (D-1103: its lines, which
 * read the block before) has it as copy 1, first in its lane, waiting for nothing; `kernels` lists those Reverbs. `on`
 * false: no schedule, `lane` the poly segments' odd parts (the lanes signal-buffers.ts counts by default). */
export interface Schedule {
  on: boolean;
  order: number[];
  copies: number[];
  lane: number[][];
  /** each lane's items, in order: [module index, copy] */
  items: [number, number][][];
  /** the copies [module, copy] each item waits for (sch_deps), by `${m}/${v}` */
  deps: Map<string, [number, number][]>;
  kernels: number[];
}

/** `work(m)`: one copy's cycles; a Reverb with a kernel item splits them between its kernel (copy 1) and its mix */
export function scheduleWork(s: Schedule, work: (m: number) => number): (m: number, v: number) => number {
  const mix = SCH_RV_MIX * 64;
  return (m, v) => {
    const w = work(m);
    if (!s.kernels.includes(m)) return w;
    return v === 1 ? Math.max(0, w - mix) : Math.min(w, mix);
  };
}

/** Input must be deviceView(source, true); `rig`: the plan's costs measured on the test rig (engine.c DEF_COST,
 * DEF_COST_BYPASS); `table`: the CPU table's (DEF_TCOST, DEF_TCOST_BYPASS); `helpers`: fx-bus.ts fxHelperIds(source), which
 * play though the patch marks them bypassed. Two plans, each item in E.order where it would end first: one at the table's
 * costs, one at the rig's (an oscillator's cost times its voices, SCH_ITEM more an item). The rig's plan is kept when, at
 * the rig's costs, it ends sooner than the table's by 1 / SCH_GAIN (#1073): where the two are closer, the costs' own error
 * decides which ends first on the FM-1, and the table's plan is the one the FM-1 played before */
export function schedule(p: Patch, groups: DeviceGroup[], rig: PlanCosts, table: PlanCosts, helpers: Set<number>): Schedule {
  const index = new Map(p.modules.map((m, i) => [m.id, i]));
  const group = p.modules.map((m) => groups.findIndex((g) => g.modules.has(m.id)));
  const copies = group.map((g) => (g < 0 ? 1 : groups[g].cfg.parts));
  const cables = p.cables.map((c) => ({ from: index.get(c.from.module)!, to: index.get(c.to.module)! }));
  const visited = new Set<number>(), order: number[] = [];
  function visit(m: number): void {
    visited.add(m);
    // (a cable into a Part orders nothing: engine.c visit, patch.ts processingOrder)
    for (const c of cables) if (c.to === m && !visited.has(c.from) && p.modules[m].type !== 'part') visit(c.from);
    order.push(m);
  }
  p.modules.forEach((_, m) => { if (!visited.has(m)) visit(m); });
  const pos: number[] = [];
  order.forEach((m, k) => { pos[m] = k; });
  const steps = (m: number): boolean => p.modules[m].type === 'steps';
  const split = (m: number): boolean => group[m] >= 0 && copies[m] >= 2 && !steps(m);
  const parity = (): number[][] => copies.map((n, m) => Array.from({ length: n }, (_, v) => (split(m) ? v & 1 : 0)));
  const deps = new Map<string, [number, number][]>();
  for (const m of order)
    for (let v = 0; v < copies[m]; v++) {
      const d: [number, number][] = [];
      for (const { from: f, to: t } of cables) {
        if (f === t) continue;
        if (t === m && pos[f] < pos[m]) {
          // the copies of f that copy v of m reads: every part of another group's, else its own part or the one copy
          if (group[f] >= 0 && group[f] !== group[m]) for (let w = 0; w < copies[f]; w++) d.push([f, w]);
          else d.push([f, copies[f] > 1 ? v : 0]);
        } else if (f === m && pos[t] < pos[m]) {
          // a feedback cable's readers, which read the block before
          for (let w = 0; w < copies[t]; w++)
            if ((group[m] >= 0 && group[m] !== group[t]) || (copies[m] > 1 ? w : 0) === v) d.push([t, w]);
        }
      }
      for (const o of order)
        if (pos[o] < pos[m] && (steps(m) || steps(o))) for (let w = 0; w < copies[o]; w++) d.push([o, w]);
      deps.set(`${m}/${v}`, d);
    }
  // D-1103: each Reverb's kernel first (copy 1), waiting for nothing, where it would end first; its Reverb waits for it
  const total0 = copies.reduce((a, b) => a + b, 0);
  const kernels: number[] = [];
  for (const m of order)
    if (p.modules[m].type === 'reverb' && kernels.length < SCH_KMAX && total0 + kernels.length < MAX_INST + 1) kernels.push(m);
  for (const m of kernels) {
    deps.set(`${m}/1`, []);
    deps.get(`${m}/0`)!.push([m, 1]);
  }
  // (as the patch binary marks them: never the panel, the output or a Reverb stage's helpers)
  const off = (m: number): boolean => !!p.modules[m].bypass && !helpers.has(p.modules[m].id) && p.modules[m].type !== 'fm1' && p.modules[m].type !== 'output';
  // one plan at costs `c` (a copy of module m) and `kc` (a kernel): where each item ends first, or with `fixed` lanes when
  // the block ends with them
  const plan = (c: (m: number) => number, kc: (m: number) => number, fixed?: number[][]): { lane: number[][]; end: number; total: number; n1: number } => {
    const lane = fixed ?? parity();
    const fin = copies.map((n) => new Array<number>(n).fill(0));
    const end = [0, SCH_FORK];
    let n1 = 0, total = 0;
    for (const m of kernels) {
      const k = kc(m);
      const best = fixed ? fixed[m][1] : end[1] + k < end[0] + k ? 1 : 0;
      lane[m][1] = best;
      fin[m][1] = end[best] += k;
      n1 += best;
      total += k;
    }
    for (const m of order) {
      const k = c(m);
      for (let v = 0; v < copies[m]; v++) {
        let best = -1, bestFin = 0;
        for (const l of fixed ? [fixed[m][v]] : steps(m) ? [0] : [0, 1]) {
          let t = end[l];
          for (const [f, w] of deps.get(`${m}/${v}`)!) t = Math.max(t, fin[f][w] + (lane[f][w] !== l ? SCH_SYNC : 0));
          if (best < 0 || t + k < bestFin) [bestFin, best] = [t + k, l];
        }
        lane[m][v] = best;
        fin[m][v] = end[best] = bestFin;
        n1 += best;
        total += k;
      }
    }
    return { lane, end: Math.max(end[0], end[1]), total, n1 };
  };
  const tc = (m: number): number => (off(m) ? table.bypass : kernels.includes(m) ? SCH_RV_MIX : table.cost(p.modules[m].type));
  const tk = (m: number): number => (off(m) ? 0 : table.cost('reverb'));
  const rc = (m: number): number => SCH_ITEM + (off(m) ? rig.bypass : kernels.includes(m) ? SCH_RV_MIX : rig.cost(p.modules[m].type) * (p.modules[m].type === 'osc' ? oscVoices(p.modules[m]) : 1));
  const rk = (m: number): number => SCH_ITEM + (off(m) ? 0 : rig.cost('reverb'));
  const on = (x: { end: number; total: number; n1: number }): boolean => x.n1 > 0 && x.end + SCH_FORK < x.total;
  const a = plan(tc, tk), b = plan(rc, rk);
  const aAtRig = on(a) ? plan(rc, rk, a.lane).end : b.total;
  const lane = on(b) && b.end * SCH_GAIN < aAtRig * (SCH_GAIN - 1) ? b.lane : on(a) ? a.lane : undefined;
  const items: [number, number][][] = [[], []];
  if (!lane) return { on: false, order, copies, lane: parity(), items, deps, kernels: [] };
  for (const m of kernels) items[lane[m][1]].push([m, 1]);
  for (const m of order) for (let v = 0; v < copies[m]; v++) items[lane[m][v]].push([m, v]);
  return { on: true, order, copies, lane, items, deps, kernels };
}

/** When the scheduled render of one block ends on core 0, `work(m, v)` the cycles of each item; each lane renders its
 * items in order and waits for the other lane's items it depends on (`sync` cycles a wait), the second core starting
 * `fork` cycles late. Every item counted (a block with every part playing) */
export function scheduleTime(s: Schedule, work: (m: number, v: number) => number, sync: number, fork: number): number {
  const fin = new Map<string, number>();
  const at = [0, 0], free = [0, fork];
  const laneOf = (m: number, v: number): number => s.lane[m][v];
  // the lanes advance together: always the item whose lane is behind, once what it waits for has ended
  while (at[0] < s.items[0].length || at[1] < s.items[1].length) {
    let moved = false;
    for (const l of [0, 1]) {
      const it = s.items[l][at[l]];
      if (!it) continue;
      const d = s.deps.get(`${it[0]}/${it[1]}`)!;
      if (d.some(([f, w]) => !fin.has(`${f}/${w}`))) continue;
      let t = free[l];
      for (const [f, w] of d) t = Math.max(t, fin.get(`${f}/${w}`)! + (laneOf(f, w) !== l ? sync : 0));
      free[l] = t + work(it[0], it[1]);
      fin.set(`${it[0]}/${it[1]}`, free[l]);
      at[l]++;
      moved = true;
    }
    if (!moved) throw new Error('schedule: the lanes wait for each other');
  }
  return Math.max(free[0], free[1]);
}
