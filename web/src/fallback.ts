// SPDX-License-Identifier: GPL-3.0-only
// The FM-1's fallback patch: what safe mode plays, and what the device falls back to when nothing else loads (no bank, a
// slot that does not load). As small as a playable patch gets, so it never overloads and needs nothing from the pools:
// Main pitch -> a saw -> a VCA opened by an ADSR on Main's gate -> the output. export-defs.ts compiles it into presets.h
// (FALLBACK_PATCH); it is not one of the factory patches.
import { DEFS } from './modules';
import { addModule, connect, emptyPatch, type Patch } from './patch';

export const FALLBACK_NAME = 'SAFE PATCH';

export function fallbackPatch(): Patch {
  const p = emptyPatch(FALLBACK_NAME);
  const main = addModule(p, DEFS.fm1, 20, 20);
  const osc = addModule(p, DEFS.osc, 340, 20);
  const env = addModule(p, DEFS.adsr, 340, 300);
  const vca = addModule(p, DEFS.vca, 660, 20);
  const out = addModule(p, DEFS.output, 980, 20);
  Object.assign(osc.params, { wave: 2, level: 0.8 });
  Object.assign(env.params, { a: 0.005, d: 0.3, s: 0.6, r: 0.3 });
  out.params.level = 0.5;
  for (const [a, ap, b, bp] of [
    [main, 'pitch', osc, 'pitch'],
    [main, 'gate', env, 'gate'],
    [osc, 'out', vca, 'in'],
    [env, 'env', vca, 'cv'],
    [vca, 'out', out, 'l'],
    [vca, 'out', out, 'r'],
  ] as const)
    if (!connect(p, DEFS, { module: a.id, port: ap }, { module: b.id, port: bp })) throw new Error(`fallback: ${ap} -> ${bp}`);
  return p;
}
