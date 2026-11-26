// SPDX-License-Identifier: GPL-3.0-only
import { DEFS } from './modules';
import type { Patch } from './patch';
import type { DeviceGroup } from './poly';
import type { Schedule } from './schedule';
import { cableReaders, feedModel, outputRead, sourcesInto } from './feeds';

/** Unknown rules and disconnected devices always use separate charging. */
export type BufferAllocation = 0 | 1;
export const bufferAllocation = (rule?: number): BufferAllocation => rule === 1 ? 1 : 0;

/** Accounting of engine.c's lifetime allocator. Input must be deviceView(source, true).
 * `separate` models ENG_BUF_REUSE=0 or a compiled candidate. Current encoders never emit legacy disabled-input masks.
 * `sched`: a two-core schedule's lanes (schedule.ts, #802), where a value read across the lanes keeps its buffer.
 * Who reads which copy: feeds.ts (stereo copies, jack pairs and side cables, #1141; engine.c cab_reads). */
export function signalBuffers(p: Patch, groups: DeviceGroup[], separate = false, sched?: Schedule): { values: number; physical: number } {
  const x = feedModel(p, groups);
  const { group, copies, cables } = x;
  const split = (m: number): boolean => group[m] >= 0 && copies[m] >= 2 && p.modules[m].type !== 'steps';
  const scheduled = sched?.on ? sched : undefined;
  const lane = (m: number, v: number): number => scheduled ? scheduled.lane[m][v] : split(m) ? v & 1 : 0;
  const late = (m: number): boolean => ['output', 'fm1', 'arp', 'part'].includes(p.modules[m].type);
  const visited = new Set<number>(), order: number[] = [];
  function visit(m: number): void {
    visited.add(m);
    // (a cable into a Part orders nothing: engine.c visit, patch.ts processingOrder)
    for (const c of cables) if (c.to === m && !visited.has(c.from) && p.modules[m].type !== 'part') visit(c.from);
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
    for (const [ci, c] of cables.entries()) {
      if (c.from !== m) continue;
      const readers = cableReaders(x, ci, port, v);
      if (!readers.length) continue;
      if (pos[c.to] <= start || (group[m] >= 0 && group[c.to] !== group[m]) || late(c.to)) return Infinity;
      for (const w of readers) {
        const at = lane(c.to, w) === lane(m, v) ? pos[c.to] : scheduled ? Infinity : split(c.to) ? segmentEnd[pos[c.to]] : pos[c.to];
        end = Math.max(end, at);
      }
    }
    return end;
  }
  order.forEach((m, k) => {
    const def = DEFS[p.modules[m].type];
    for (const port of def.inputs)
      if (sourcesInto(x, m, port.name) >= 2) for (let v = 0; v < copies[m]; v++) take(k, late(m) ? Infinity : k, lane(m, v));
    for (const port of def.outputs) {
      if (!outputRead(x, m, port.name)) continue;
      for (let v = 0; v < copies[m]; v++) take(k, lastReader(m, port.name, v, k), lane(m, v));
    }
  });
  return { values, physical: buffers.length };
}
