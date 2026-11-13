// SPDX-License-Identifier: GPL-3.0-only
import { bypassAssembly, type AssemblyInst, type RowTarget } from './assembly';
import { fxBusOf, type FxBus, type FxStage } from './fx-bus';
import { FX_PRESET_CONTROLS, FX_PRESET_KINDS, fxPresetStructure } from './fx-preset-format';
import { DEFS } from './modules';
import { devicesOf } from './pages';
import { topOf, type Patch } from './patch';
import { structureOf } from './structure';

export interface FxPresetScope { baseStructure: string; structure: string; mask: number; bus: FxBus }

/** A master rack belongs to a sound only when exactly one other assembly device exists. */
export function fxPresetScope(p: Patch, a: AssemblyInst): FxPresetScope | null {
  const bus = fxBusOf(p);
  if (!bus) return null;
  const owners = devicesOf(p, DEFS).filter(d => d.asm !== undefined && d.asm !== bus.assembly);
  if (owners.length !== 1 || owners[0].asm !== a.id) return null;
  const baseStructure = structureOf(p, a);
  const mask = bus.stages.reduce((bits, s) => bits | 1 << FX_PRESET_KINDS.indexOf(s.kind), 0);
  return { baseStructure, structure: fxPresetStructure(baseStructure, mask), mask, bus };
}

/** Semantic order is independent of card captions, row order and page breaks. */
function bindings(p: Patch, stage: FxStage): RowTarget[][] {
  return FX_PRESET_CONTROLS[stage.kind].map(param => {
    if (stage.kind === 'reverb' && param === 'mix')
      return [{ module: p.modules.find(m => stage.helpers.includes(m.id) && m.type === 'macro')!.id, param: 'value' }];
    return stage.targets.map(module => ({ module, param }));
  });
}

/** Reject malformed effect values before any part of a scoped sound is changed. */
export function validFxValues(p: Patch, scope: FxPresetScope, values: readonly number[], at: number): boolean {
  for (const stage of scope.bus.stages) {
    at++;
    for (const rows of bindings(p, stage)) {
      const value = values[at++];
      for (const row of rows) {
        const m = p.modules.find(m => m.id === row.module)!;
        const pd = DEFS[m.type].params.find(pd => pd.name === row.param)!;
        if (!Number.isFinite(value) || value < pd.min || value > topOf(pd)) return false;
      }
      if (stage.kind === 'reverb' && rows[0].param === 'value' && (value < 0 || value > 1)) return false;
    }
  }
  return true;
}

export function currentFxValues(p: Patch, scope: FxPresetScope): number[] {
  return scope.bus.stages.flatMap(stage => [
    Number(!p.modules.find(m => m.id === stage.targets[0])!.bypass),
    ...bindings(p, stage).map(rows => p.modules.find(m => m.id === rows[0].module)!.params[rows[0].param]),
  ]);
}

/** Restore one complete logical stage, not the old group switch's kept list. */
export function setFxStageEnabled(p: Patch, stage: FxStage, on: boolean): number[] {
  const assembly = p.assemblies!.find(a => a.id === stage.assembly)!;
  delete assembly.kept;
  bypassAssembly(p, assembly, false);
  if (!on) bypassAssembly(p, assembly, true);
  return assembly.modules;
}

/** Caller validates the entire scoped record before changing either synth or effects. */
export function applyFxValues(p: Patch, scope: FxPresetScope, values: readonly number[], at: number): void {
  for (const stage of scope.bus.stages) {
    const on = values[at++] === 1;
    for (const rows of bindings(p, stage)) {
      const value = values[at++];
      for (const row of rows) {
        const m = p.modules.find(m => m.id === row.module)!;
        const pd = DEFS[m.type].params.find(pd => pd.name === row.param)!;
        m.params[row.param] = Math.min(topOf(pd), Math.max(pd.min, value));
      }
    }
    setFxStageEnabled(p, stage, on);
  }
}
