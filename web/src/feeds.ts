// SPDX-License-Identifier: GPL-3.0-only
// What each copy of a module adds into each of its inputs, as both engines wire them at load (engine.c cab_feed; engine.ts
// wire keeps the same rules on its nodes): a poly group's output read outside the group adds every part, read inside it
// each part its own; stereo mode, jack pairs and side cables (#1141). The budget (patchbin.ts poolUse, signal-buffers.ts)
// and the two-core plan (schedule.ts) count with it.
import { DEFS, RIGHT_IN, RIGHT_OUT } from './modules';
import type { Patch } from './patch';
import type { DeviceGroup } from './poly';

export interface FeedCable { from: number; to: number; output: string; input: string; side?: 'l' | 'r' }
/** a device form by module index: type, poly group (-1: none), copies; its cables */
export interface FeedModel { type: string[]; group: number[]; copies: number[]; cables: FeedCable[] }
/** source copy `copy` of cable `cable`'s module, its output `port`, added as it is (1), halved (a stereo source into a
 *  mono jack: (L + R) / 2) or with a poly group's paraphonic weight ('para', engine.ts paraMix, engine.c para_w) */
export interface Feed { cable: number; copy: number; port: string; w: 1 | 0.5 | 'para' }

/** the model of a device form (poly.ts deviceView(source, true)): a stereo module (patchbin.ts stereoIn) has two copies */
export function feedModel(p: Patch, groups: readonly DeviceGroup[]): FeedModel {
  const index = new Map(p.modules.map((m, i) => [m.id, i]));
  const group = p.modules.map((m) => groups.findIndex((g) => g.modules.has(m.id)));
  return {
    type: p.modules.map((m) => m.type),
    group,
    copies: p.modules.map((m, i) => (group[i] >= 0 ? groups[group[i]].cfg.parts : m.stereo && DEFS[m.type].stereo ? 2 : 1)),
    cables: p.cables.map((c) => ({ from: index.get(c.from.module)!, to: index.get(c.to.module)!, output: c.from.port, input: c.to.port, ...(c.side ? { side: c.side } : {}) })),
  };
}

/** module m runs in stereo mode: two copies outside the poly groups, copy 0 L, copy 1 R */
export const stereoAt = (x: FeedModel, m: number): boolean => x.group[m] < 0 && x.copies[m] === 2;

/** cable c is a stereo cable into the left jack of an input pair whose right jack has no cable (modules.ts RIGHT_IN): L
 *  into the left jack, R into the right one (engine.c cab_split) */
export function pairSplit(x: FeedModel, c: number): boolean {
  const k = x.cables[c], r = RIGHT_IN[x.type[k.to]];
  return !!r && !k.side && k.input === DEFS[x.type[k.to]].inputs[0].name && stereoAt(x, k.from) && !x.cables.some((d) => d.to === k.to && d.input === r);
}

/** what cable c adds into input `input` of copy v of its module (engine.c cab_feed); [] nothing */
export function cableFeeds(x: FeedModel, c: number, input: string, v: number): Feed[] {
  const k = x.cables[c], f = k.from, t = k.to, st = stereoAt(x, t);
  if (k.input !== input) return input === RIGHT_IN[x.type[t]] && pairSplit(x, c) ? [{ cable: c, copy: 1, port: k.output, w: 1 }] : [];
  if (k.side && st && (k.side === 'r' ? 1 : 0) !== v) return [];
  const ro = RIGHT_OUT[x.type[f]];
  const port = st && ro && k.output === DEFS[x.type[f]].outputs[0].name && (k.side ? k.side === 'r' : v === 1) ? ro : k.output;
  const one = (copy: number, w: Feed['w'] = 1): Feed => ({ cable: c, copy, port, w });
  if (x.group[f] >= 0 && x.group[f] !== x.group[t]) return Array.from({ length: x.copies[f] }, (_, w) => one(w, 'para'));
  if (!stereoAt(x, f)) return [one(x.group[f] >= 0 ? v : 0)];
  if (k.side) return [one(k.side === 'r' ? 1 : 0)];
  if (st || pairSplit(x, c)) return [one(st ? v : 0)];
  return [one(0, 0.5), one(1, 0.5)];
}

/** every feed of input `input` of copy v of module m, in cable order */
export function feeds(x: FeedModel, m: number, input: string, v: number): Feed[] {
  const out: Feed[] = [];
  x.cables.forEach((k, c) => { if (k.to === m) out.push(...cableFeeds(x, c, input, v)); });
  return out;
}

/** the most sources one copy of module m sums into `input` (the copies of a stereo module can differ: side cables) */
export const sourcesInto = (x: FeedModel, m: number, input: string): number =>
  Math.max(feeds(x, m, input, 0).length, stereoAt(x, m) ? feeds(x, m, input, 1).length : 0);

/** output `port` of module m is read: a cable from it, or it is a pair's right output whose left one feeds a stereo module
 *  (engine.c out_read) */
export function outputRead(x: FeedModel, m: number, port: string): boolean {
  const left = DEFS[x.type[m]].outputs[0].name;
  return x.cables.some((k) => k.from === m && (k.output === port || (port === RIGHT_OUT[x.type[m]] && k.output === left && stereoAt(x, k.to))));
}

/** the copies of cable c's reader that read copy s of output `port` of its source through it (any output: port null;
 *  engine.c cab_reads) */
export function cableReaders(x: FeedModel, c: number, port: string | null, s: number): number[] {
  const k = x.cables[c], rin = RIGHT_IN[x.type[k.to]], out: number[] = [];
  for (let w = 0; w < x.copies[k.to]; w++)
    if ([k.input, ...(rin && rin !== k.input ? [rin] : [])].some((j) => cableFeeds(x, c, j, w).some((f) => f.copy === s && (port === null || f.port === port)))) out.push(w);
  return out;
}
