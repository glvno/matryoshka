// SPDX-License-Identifier: GPL-3.0-only
// Stereo mode in the editor's model (#1141): the switch, poly assemblies, and what never sees it (C5, C8).
import { describe, expect, it } from 'vitest';
import { insertAssembly, makeAssembly, promote, toDef } from './assembly';
import { clipText, copyItems, parseClip, pasteClip } from './clipboard';
import { applyPreset, capturePreset } from './device-presets';
import { DEFS } from './modules';
import { breedPatch, mutatePatch } from './mutate';
import { addModule, connect, newPatch, type Patch } from './patch';
import { setPoly } from './poly';
import { runsStereo, setStereo, stereoProblem } from './stereo';
import { structureOf } from './structure';

const ELIGIBLE = ['vca', 'filter', 'mixer', 'shape', 'xfade', 'vowel', 'phaser', 'crush', 'ladder', 'dyn', 'comb', 'modal', 'shift', 'lpg', 'limit', 'eq'];

/** an oscillator into a filter and a Drive, the last two an assembly with a row each */
function chain(): { p: Patch; filter: number; drive: number; asm: number } {
  const p = newPatch(DEFS);
  const osc = addModule(p, DEFS.osc, 0, 0), filter = addModule(p, DEFS.filter, 300, 0), drive = addModule(p, DEFS.shape, 600, 0);
  connect(p, DEFS, { module: osc.id, port: 'out' }, { module: filter.id, port: 'in' });
  connect(p, DEFS, { module: filter.id, port: 'lp24' }, { module: drive.id, port: 'in' });
  const a = makeAssembly(p, [filter.id, drive.id], 'Tone');
  promote(a, filter.id, 'cutoff', p);
  promote(a, drive.id, 'drive', p);
  return { p, filter: filter.id, drive: drive.id, asm: a.id };
}
const mod = (p: Patch, id: number) => p.modules.find((m) => m.id === id)!;

describe('stereo mode (#1141)', () => {
  it('is offered on exactly the eligible types', () => {
    expect(Object.values(DEFS).filter((d) => d.stereo).map((d) => d.type).sort()).toEqual([...ELIGIBLE].sort());
    const p = newPatch(DEFS);
    expect(stereoProblem(p, addModule(p, DEFS.reverb, 0, 0))).toBeUndefined();
    expect(() => setStereo(p, addModule(p, DEFS.osc, 0, 0), true)).toThrow(/no stereo mode/);
  });

  it('is refused inside a poly assembly, with the reason, and a module that has it runs mono there', () => {
    const { p, filter, asm } = chain();
    setStereo(p, mod(p, filter), true);
    expect(runsStereo(p, mod(p, filter))).toBe(true);
    setPoly(p, DEFS, p.assemblies!.find((a) => a.id === asm)!, true);
    expect(stereoProblem(p, mod(p, filter))).toMatch(/poly assembly "Tone"/);
    expect(runsStereo(p, mod(p, filter))).toBe(false);
    expect(() => setStereo(p, mod(p, filter), true)).toThrow(/poly assembly/);
    setStereo(p, mod(p, filter), false);
    expect(mod(p, filter).stereo).toBeUndefined();
  });

  it('structure and presets ignore it: a preset of the mono form loads on the stereo one and back', () => {
    const { p, filter, drive, asm } = chain();
    const a = p.assemblies!.find((x) => x.id === asm)!;
    const mono = structureOf(p, a);
    mod(p, filter).params.cutoff = 900;
    mod(p, drive).params.drive = 7;
    const preset = capturePreset(p, a, 'warm');
    setStereo(p, mod(p, filter), true);
    setStereo(p, mod(p, drive), true);
    expect(structureOf(p, a)).toBe(mono);
    mod(p, filter).params.cutoff = 100;
    mod(p, drive).params.drive = 2;
    expect(applyPreset(p, a, preset)).toBe(true);
    expect([mod(p, filter).params.cutoff, mod(p, drive).params.drive]).toEqual([900, 7]);
    expect([mod(p, filter).stereo, mod(p, drive).stereo]).toEqual([true, true]);
    const stereoPreset = capturePreset(p, a, 'wide');
    expect(stereoPreset.structure).toBe(preset.structure);
    expect(JSON.stringify(stereoPreset)).not.toMatch(/stereo/);
  });

  it('Mutate, Randomize and breeding never flip it', () => {
    const { p, filter, drive } = chain();
    setStereo(p, mod(p, filter), true);
    const scope = { modules: [filter, drive], assemblies: [] };
    for (const mode of ['mutate', 'randomize'] as const) for (let k = 0; k < 8; k++) {
      const out = mutatePatch(p, scope, mode, 1, DEFS).patch;
      expect([mod(out, filter).stereo, mod(out, drive).stereo]).toEqual([true, undefined]);
    }
    const other = structuredClone(p);
    delete mod(other, filter).stereo;
    mod(other, drive).stereo = true;
    const bred = breedPatch(p, [other], scope, 1, DEFS).patch;
    expect([mod(bred, filter).stereo, mod(bred, drive).stereo]).toEqual([true, undefined]);
  });

  it('copy and paste, saved assemblies and their copies keep it', () => {
    const { p, filter, drive, asm } = chain();
    setStereo(p, mod(p, drive), true);
    const clip = parseClip(clipText(copyItems(p, [], [asm])!), DEFS)!;
    const pasted = pasteClip(p, DEFS, clip, 0, 900);
    const types = (ids: number[]) => ids.map((id) => mod(p, id)).map((m) => [m.type, !!m.stereo]);
    const all = [...pasted.modules, ...pasted.assemblies.flatMap((id) => p.assemblies!.find((a) => a.id === id)!.modules)];
    expect(types(all).sort()).toEqual([['filter', false], ['shape', true]]);
    const def = toDef(p, p.assemblies!.find((a) => a.id === asm)!);
    expect(def.modules.map((m) => !!m.stereo)).toEqual([false, true]);
    const copy = insertAssembly(p, DEFS, def, 0, 1800);
    expect(copy.modules.map((id) => !!mod(p, id).stereo)).toEqual([false, true]);
    expect(mod(p, filter).stereo).toBeUndefined();
  });
});
