// SPDX-License-Identifier: GPL-3.0-only
import { DEFS } from './modules';
import type { Patch } from './patch';
import type { DeviceGroup } from './poly';

/** Unknown rules and disconnected devices always use separate charging. */
export type BufferAllocation = 0 | 1;
export const bufferAllocation = (rule?: number): BufferAllocation => rule === 1 ? 1 : 0;

/** Accounting of engine.c's lifetime allocator. Input must be deviceView(source, true).
 * `separate` models ENG_BUF_REUSE=0 or a compiled candidate. Current encoders never emit legacy disabled-input masks. */
export function signalBuffers(p: Patch, groups: DeviceGroup[], separate = false): { values: number; physical: number } {
  const index = new Map(p.modules.map((m, i) => [m.id, i]));
  const group = p.modules.map((m) => groups.findIndex((g) => g.modules.has(m.id)));
  const copies = group.map((g) => g < 0 ? 1 : groups[g].cfg.parts);
  const cables = p.cables.map((c) => ({ from: index.get(c.from.module)!, to: index.get(c.to.module)!, output: c.from.port, input: c.to.port }));
  const split = (m: number): boolean => group[m] >= 0 && copies[m] >= 2 && p.modules[m].type !== 'steps';
  const lane = (m: number, v: number): number => split(m) ? v & 1 : 0;
  const late = (m: number): boolean => ['output', 'fm1', 'arp', 'part'].includes(p.modules[m].type);
  const visited = new Set<number>(), order: number[] = [];
  function visit(m: number): void {
    visited.add(m);
    for (const c of cables) if (c.to === m && !visited.has(c.from)) visit(c.from);
    order.push(m);
  }
  p.modules.forEach((_, m) => { if (!visited.has(m)) visit(m); });
  const pos: number[] = [], segmentEnd: number[] = [];
  order.forEach((m, k) => { pos[m] = k; });
  for (let k = order.length - 1; k >= 0; k--) {
    const m = order[k], next = order[k + 1];
    segmentEnd[k] = next !== undefined && split(m) && split(next) && group[m] === group[next] ? segmentEnd[k + 1] : k;
  }
  const buffers: { end: number; lane: number }[] = [];
  let values = 0;
  function take(start: number, end: number, lane: number): void {
    values++;
    if (separate) end = Infinity;
    const reusable = end !== Infinity ? buffers.find((b) => b.lane === lane && b.end < start) : undefined;
    if (reusable) reusable.end = end;
    else buffers.push({ end, lane });
  }
  function lastReader(m: number, port: string, v: number, start: number): number {
    let end = start;
    for (const c of cables) {
      if (c.from !== m || c.output !== port) continue;
      if (pos[c.to] <= start || (group[m] >= 0 && group[c.to] !== group[m]) || late(c.to)) return Infinity;
      for (let w = 0; w < copies[c.to]; w++) {
        if ((copies[m] > 1 ? w : 0) !== v) continue;
        const at = lane(c.to, w) !== lane(m, v) && split(c.to) ? segmentEnd[pos[c.to]] : pos[c.to];
        end = Math.max(end, at);
      }
    }
    return end;
  }
  order.forEach((m, k) => {
    const def = DEFS[p.modules[m].type];
    for (const port of def.inputs) {
      const sources = cables.filter((c) => c.to === m && c.input === port.name)
        .reduce((n, c) => n + (group[c.from] >= 0 && group[c.from] !== group[m] ? copies[c.from] : 1), 0);
      if (sources >= 2) for (let v = 0; v < copies[m]; v++) take(k, late(m) ? Infinity : k, lane(m, v));
    }
    for (const port of def.outputs) {
      if (!cables.some((c) => c.from === m && c.output === port.name)) continue;
      for (let v = 0; v < copies[m]; v++) take(k, lastReader(m, port.name, v, k), lane(m, v));
    }
  });
  return { values, physical: buffers.length };
}
