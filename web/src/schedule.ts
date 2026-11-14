// SPDX-License-Identifier: GPL-3.0-only
import type { Patch } from './patch';
import type { DeviceGroup } from './poly';

/** engine.c SCH_SYNC and SCH_FORK: a wait across the cores, and handing the job over, in schedule cost units (64 cycles) */
export const SCH_SYNC = 6;
export const SCH_FORK = 24;

/** A patch's two-core schedule on the FM-1 (#802, engine.c sched_build). An item is one copy of a module of the device form:
 * one part's in its poly group, else the module's. `order` is engine.c's E.order (module indices), `copies[m]` a module's
 * copies, `lane[m][v]` the core of its copy v (1: the second core). `on` false: no schedule, `lane` the poly segments'
 * odd parts (the lanes signal-buffers.ts counts by default). */
export interface Schedule {
  on: boolean;
  order: number[];
  copies: number[];
  lane: number[][];
  /** each lane's items, in order: [module index, copy] */
  items: [number, number][][];
  /** the copies [module, copy] each item waits for (sch_deps), by `${m}/${v}` */
  deps: Map<string, [number, number][]>;
}

/** Input must be deviceView(source, true); `cost(type)`: one copy's cost in 64 cycles (engine.c DEF_COST) */
export function schedule(p: Patch, groups: DeviceGroup[], cost: (type: string) => number): Schedule {
  const index = new Map(p.modules.map((m, i) => [m.id, i]));
  const group = p.modules.map((m) => groups.findIndex((g) => g.modules.has(m.id)));
  const copies = group.map((g) => (g < 0 ? 1 : groups[g].cfg.parts));
  const cables = p.cables.map((c) => ({ from: index.get(c.from.module)!, to: index.get(c.to.module)! }));
  const visited = new Set<number>(), order: number[] = [];
  function visit(m: number): void {
    visited.add(m);
    for (const c of cables) if (c.to === m && !visited.has(c.from)) visit(c.from);
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
  const lane = parity();
  const fin = copies.map((n) => new Array<number>(n).fill(0));
  const end = [0, SCH_FORK];
  const n = [0, 0];
  let total = 0;
  for (const m of order) {
    const c = cost(p.modules[m].type);
    for (let v = 0; v < copies[m]; v++) {
      let best = 0, bestFin = 0;
      for (let l = 0; l < (steps(m) ? 1 : 2); l++) {
        let t = end[l];
        for (const [f, w] of deps.get(`${m}/${v}`)!) t = Math.max(t, fin[f][w] + (lane[f][w] !== l ? SCH_SYNC : 0));
        if (l === 0 || t + c < bestFin) [bestFin, best] = [t + c, l];
      }
      lane[m][v] = best;
      fin[m][v] = end[best] = bestFin;
      n[best]++;
      total += c;
    }
  }
  const items: [number, number][][] = [[], []];
  if (!n[1] || Math.max(end[0], end[1]) + SCH_FORK >= total) return { on: false, order, copies, lane: parity(), items, deps };
  for (const m of order) for (let v = 0; v < copies[m]; v++) items[lane[m][v]].push([m, v]);
  return { on: true, order, copies, lane, items, deps };
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
