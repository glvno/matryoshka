// SPDX-License-Identifier: GPL-3.0-only
// Arming as a set (#190, docs/ledger/vocabulary.md "Arm"): any device with a keys input can be armed, several at once. While any device
// is armed only armed devices hear Main's keys, cable or not; while none is, the cables decide. Arming reroutes only Main:
// other key sources (Steps tracks, Arpeggiators) keep playing what they drive. The engine plays the arm as a patch
// transform (armView): Main's keys cables into unarmed devices go, Main's keys into each armed device's keys input come;
// the editor draws the same as virtual cables. Not saved, no undo.
import { allModules, assembliesOf, assemblyById, parentOf, targetsOf, type AssemblyInst } from './assembly';
import { DEFS } from './modules';
import type { Cable, ModuleDef, Patch } from './patch';
import { deviceView } from './poly';

/** a device's key, as pages.ts names devices: `a<id>` an assembly, `m<id>` a module */
export type DeviceKey = string;

const kindIn = (p: Patch, defs: Record<string, ModuleDef>, module: number, port: string): string | undefined =>
  defs[p.modules.find((m) => m.id === module)?.type ?? '']?.inputs.find((x) => x.name === port)?.kind;

/** the outermost assembly holding a module, or none */
function outerOf(p: Patch, module: number): AssemblyInst | undefined {
  let a = assembliesOf(p).find((x) => x.modules.includes(module));
  for (let up = a && parentOf(p, a.id); up; up = parentOf(p, up.id)) a = up;
  return a;
}

/** the device a module belongs to: its outermost assembly, else itself */
export const deviceOfModule = (p: Patch, module: number): DeviceKey => {
  const a = outerOf(p, module);
  return a ? `a${a.id}` : `m${module}`;
};

/** where Main's keys go when the device is armed: the targets of its keys inputs (none: it cannot be armed) */
export function keysTargets(p: Patch, key: DeviceKey, defs: Record<string, ModuleDef> = DEFS): { module: number; port: string }[] {
  const id = Number(key.slice(1));
  if (key[0] === 'a') {
    const a = assemblyById(p, id);
    if (!a || parentOf(p, a.id)) return [];
    return a.inputs.filter((r) => kindIn(p, defs, r.module, r.port) === 'keys').flatMap(targetsOf);
  }
  const m = p.modules.find((x) => x.id === id);
  if (!m || m.type === 'fm1') return []; // (a module inside an assembly can be armed on its own, as a Steps track's card arms it)
  return (defs[m.type]?.inputs ?? []).filter((x) => x.kind === 'keys').map((x) => ({ module: id, port: x.name }));
}

/** a device that can be armed: it has a keys input */
export const armable = (p: Patch, key: DeviceKey, defs: Record<string, ModuleDef> = DEFS): boolean => keysTargets(p, key, defs).length > 0;

/** every armable device of a patch, modules then assemblies */
export function armableDevices(p: Patch, defs: Record<string, ModuleDef> = DEFS): DeviceKey[] {
  const keys = [...p.modules.filter((m) => !outerOf(p, m.id)).map((m) => `m${m.id}`), ...assembliesOf(p).map((a) => `a${a.id}`)];
  return keys.filter((k) => armable(p, k, defs));
}

/** the armed set with the devices that are gone or cannot be armed any more left out */
export const keepArmed = (p: Patch, armed: Iterable<DeviceKey>, defs: Record<string, ModuleDef> = DEFS): DeviceKey[] =>
  [...new Set(armed)].filter((k) => armable(p, k, defs));

/** whether a cable carries Main's keys */
const fromMainKeys = (p: Patch, c: Cable): boolean => c.from.port === 'keys' && p.modules.find((m) => m.id === c.from.module)?.type === 'fm1';

/** Main's keys cables the arm overrides (into devices not armed), while any device is armed; none while none is */
export function mutedCables(p: Patch, armed: Iterable<DeviceKey>, defs: Record<string, ModuleDef> = DEFS): Cable[] {
  const on = new Set(keepArmed(p, armed, defs));
  if (!on.size) return [];
  return p.cables.filter((c) => fromMainKeys(p, c) && !on.has(deviceOfModule(p, c.to.module)) && !on.has(`m${c.to.module}`));
}

/** the virtual cables the arm adds: Main's keys into each armed device's keys targets not cabled from Main already */
export function virtualCables(p: Patch, armed: Iterable<DeviceKey>, defs: Record<string, ModuleDef> = DEFS): Cable[] {
  const main = p.modules.find((m) => m.type === 'fm1');
  if (!main) return [];
  const out: Cable[] = [];
  for (const k of keepArmed(p, armed, defs))
    for (const t of keysTargets(p, k, defs))
      // (a keys input another key source cables into keeps it: an input takes one source of keys)
      if (!p.cables.some((c) => c.to.module === t.module && c.to.port === t.port) && !out.some((c) => c.to.module === t.module && c.to.port === t.port))
        out.push({ from: { module: main.id, port: 'keys' }, to: { module: t.module, port: t.port } });
  return out;
}

/** the patch as the engine plays it while these devices are armed: the same patch when none is */
export function armView(p: Patch, armed: Iterable<DeviceKey>, defs: Record<string, ModuleDef> = DEFS): Patch {
  const list = keepArmed(p, armed, defs);
  if (!list.length) return p;
  const muted = new Set(mutedCables(p, list, defs));
  return { ...p, cables: [...p.cables.filter((c) => !muted.has(c)), ...virtualCables(p, list, defs)] };
}

/** the armed devices as the FM-1 takes them (#191, engine.c eng_arm_mask): a mask of their modules' indices in the device
 * form, as two 32-bit halves */
export function armMask(p: Patch, armed: Iterable<DeviceKey>, defs: Record<string, ModuleDef> = DEFS): [number, number] {
  const index = new Map(deviceView(p, true).patch.modules.map((m, i) => [m.id, i]));
  let lo = 0, hi = 0;
  for (const k of keepArmed(p, armed, defs)) {
    const id = Number(k.slice(1));
    const a = k[0] === 'a' ? assemblyById(p, id) : undefined;
    for (const m of a ? allModules(p, a) : [id]) {
      const i = index.get(m);
      if (i === undefined) continue;
      if (i < 32) lo |= 1 << i;
      else if (i < 64) hi |= 1 << (i - 32);
    }
  }
  return [lo >>> 0, hi >>> 0];
}

/** the reverse: the devices whose modules a mask from the FM-1 names */
export function armedFromMask(p: Patch, lo: number, hi: number, defs: Record<string, ModuleDef> = DEFS): DeviceKey[] {
  const mods = deviceView(p, true).patch.modules;
  const keys = new Set<DeviceKey>();
  mods.forEach((m, i) => {
    const on = i < 32 ? (lo >>> i) & 1 : i < 64 ? (hi >>> (i - 32)) & 1 : 0;
    if (on && p.modules.some((x) => x.id === m.id)) keys.add(deviceOfModule(p, m.id));
  });
  return keepArmed(p, keys, defs);
}
