// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { buildFactoryBank, buildSelectedFactoryBank, factoryFile, factoryFxAudit, selectedFactoryNames, selectedFactoryProfile, shippedFactoryBank } from './factory-bank';
import { FACTORY_KITS, withKitPatterns } from './factory-kit-patterns';
import SOURCE from '../factory/bank.json';
import { fxBusOf, type FxStageKind } from './fx-bus';
import { EXAMPLE_PRESETS, factoryShape, FM1_PRESETS, PRESETS, shapeOf } from './presets';
import type { Patch } from './patch';

const OMIT_ALL: readonly FxStageKind[] = ['drive', 'chorus', 'delay', 'reverb'];
const patchOf = (name: string, bank = buildFactoryBank()): Patch => bank.find(entry => entry.name === name)!.patch;

describe('hardware candidate measurement profiles', () => {

  it('unions measured omissions with interface effects and leaves original auxiliary mono voices alone', () => {
    const p = patchOf('Hera 4', buildFactoryBank({ 'Hera 4': { voices: 3, omit: ['delay', 'reverb', 'delay'] } }));
    expect(p.modules.filter(m => m.type === 'alloc').map(m => m.params.voices)).toEqual([3, 1]);
    expect(fxBusOf(p)!.stages.map(stage => stage.kind)).toEqual(['drive']);
  });


  it.each([0, 1, 2, 2.5, 6, NaN, Infinity])('rejects an invalid Oracle V voice request %s', voices => {
    expect(() => buildFactoryBank({ 'Oracle V': { voices } })).toThrow(/voices/);
  });

  it.each([1, 2])('allows the owner-approved Expander S reduction to %s without relaxing other engines', voices => {
    const p = patchOf('Expander S', buildFactoryBank({ 'Expander S': { voices, omit: OMIT_ALL } }));
    expect(p.modules.find(m => m.type === 'alloc')!.params.voices).toBe(voices);
    expect(() => buildFactoryBank({ 'Io 4': { voices } })).toThrow(/voices/);
  });

  it('rejects mono conversion, protected drum/drone changes and non-candidate names', () => {
    expect(() => buildFactoryBank({ 'Monolith D': { voices: 3 } })).toThrow(/voices/);
    expect(() => buildFactoryBank({ '808 Kit': { voices: 3 } })).toThrow(/protected/);
    expect(() => buildFactoryBank({ '808 Kit': { omit: ['reverb'] } })).toThrow(/protected/);
    expect(() => buildFactoryBank({ '808 Kit': { drumRack: true, voices: 3 } })).toThrow(/protected/);
    expect(() => buildFactoryBank({ '8 Lire': { omit: ['reverb'] } })).toThrow(/protected/);
    expect(() => buildFactoryBank({ '8 Lire': { drumRack: true } })).toThrow(/drum kit/);
    expect(() => buildFactoryBank({ 'Hera 4': { drumRack: true } })).toThrow(/drum kit/);
    expect(() => buildFactoryBank({ Init: { voices: 3 } })).toThrow(/Unknown factory candidate/);
    expect(() => buildFactoryBank({ 'Hera 4': { harmonizer: 'removed' } })).toThrow(/monophonic/);
    expect(() => buildFactoryBank({ 'Hera 4': { bankName: 'Oracle V' } })).toThrow(/unique/);
  });

  it('keeps the unselected allocation and fresh copies after building or editing measured variants', () => {
    const original = patchOf('Expander S');
    const variant = patchOf('Expander S', buildFactoryBank({ 'Expander S': { voices: 3, omit: OMIT_ALL } }));
    expect(variant.modules.find(m => m.type === 'alloc')!.params.voices).toBe(3);
    expect(variant.assemblies!.flatMap(a => a.params).find(row => row.param === 'voices')!.top).toBe(3);
    variant.modules[0].params.tempo = 12;
    expect(patchOf('Expander S')).toEqual(original);
    const opened = FM1_PRESETS['Expander S']();
    opened.modules[0].params.tempo = 13;
    expect(FM1_PRESETS['Expander S']().modules[0].params.tempo).not.toBe(13);
  });

});

describe('owner-selected factory defaults', () => {
  const bank = Object.entries(FM1_PRESETS).map(([name, make]) => ({ name, patch: make() }));

  it('exposes the selected names in order, with examples only in the editor', () => {
    expect(Object.keys(FM1_PRESETS)).toEqual(selectedFactoryNames);
    for (const name of Object.keys(EXAMPLE_PRESETS)) {
      expect(FM1_PRESETS[name]).toBeUndefined();
      expect(PRESETS[name]).toBe(EXAMPLE_PRESETS[name]);
    }
    expect(FM1_PRESETS['Hera 4']).toBeUndefined();
    expect(PRESETS['Hera 4']).toBeUndefined();
    expect(factoryShape('Hera 4')).toBeUndefined();
    expect(factoryShape('Hera 6')).toBe(shapeOf(FM1_PRESETS['Hera 6']()));
  });

  it('uses the selected graphs unchanged in browser defaults and generated numeric files', () => {
    expect(bank).toEqual(buildSelectedFactoryBank());
    const generated = import.meta.glob<Patch>('../presets/[0-9]*.json', { eager: true, import: 'default' });
    expect(Object.keys(generated).sort()).toEqual(bank.map(({ name }, index) => `../presets/${factoryFile(index, name)}`).sort());
    for (const [index, { name, patch }] of bank.entries()) {
      expect(generated[`../presets/${factoryFile(index, name)}`], name).toEqual(patch);
      expect(patch.name).toBe(name);
    }
  });

  it('preserves protected patches byte for byte and sets only the selected melodic Outputs', () => {
    const protectedEntries = SOURCE.filter(entry => !factoryFxAudit.some(audit => audit.name === entry.name));
    expect(bank).toHaveLength(SOURCE.length);
    expect(bank.map(entry => entry.name)).toEqual(SOURCE.map(entry => selectedFactoryProfile[entry.name]?.bankName ?? entry.name));
    // (the patches with a demo set ship without it, #1179: the shipped bank is the full one without them, and the full
    // one holds the protected patches to their source)
    const full = buildSelectedFactoryBank({ full: true });
    expect(bank).toEqual(shippedFactoryBank(full));
    for (const source of protectedEntries) {
      // (a drum kit with a pattern set, D-829: its source plus those patterns, links and songs, nothing else; D-1053, D-1055)
      const kit = FACTORY_KITS.some(k => k.patch === source.name);
      const original = kit ? withKitPatterns(structuredClone(source.patch) as unknown as Patch) : source.patch as unknown as Patch;
      if (!selectedFactoryProfile[source.name]) {
        expect(patchOf(source.name, full)).toEqual(original);
        continue;
      }
      // (a drum kit with the master FX bus: every module and cable of the kit as it was, but the Output's, which the bus
      // now feeds; every stage bypassed; FX opens the bus's pages, the other buttons as they were; owner 2026-11-19, D-1200)
      expect(selectedFactoryProfile[source.name].drumRack).toBe(true);
      const p = patchOf(source.name, full);
      const output = original.modules.find(m => m.type === 'output')!.id;
      for (const m of original.modules) expect(p.modules.find(x => x.id === m.id), `${source.name} ${m.id}`).toEqual(m.type === 'fm1' ? { ...m, panel: p.modules.find(x => x.id === m.id)!.panel } : m);
      for (const c of original.cables.filter(c => c.to.module !== output)) expect(p.cables).toContainEqual(c);
      expect((p.assemblies ?? []).slice(0, original.assemblies?.length ?? 0)).toEqual(original.assemblies ?? []);
      const bus = fxBusOf(p)!;
      for (const stage of bus.stages) for (const id of stage.targets) expect(p.modules.find(m => m.id === id)!.bypass).toBe(true);
      expect(p.modules.find(m => m.type === 'fm1')!.panel!.kinds).toEqual({ fx: 'page' });
    }
    for (const [name, options] of Object.entries(selectedFactoryProfile)) if (options.outputLevel !== undefined) {
      expect(factoryFxAudit.some(audit => audit.name === name), name).toBe(true);
      expect(patchOf(options.bankName ?? name, bank).modules.find(module => module.type === 'output')!.params.level, name).toBe(options.outputLevel);
    }
  });

  it.each(factoryFxAudit.map(audit => audit.name))('retains selected voices and keeps added FX bypassed for %s', sourceName => {
    const options = selectedFactoryProfile[sourceName];
    const p = patchOf(options?.bankName ?? sourceName, bank);
    const source = SOURCE.find(entry => entry.name === sourceName)!.patch as unknown as Patch;
    for (const m of p.modules.filter(m => m.type === 'alloc')) {
      const original = source.modules.find(o => o.id === m.id)!.params.voices;
      expect(m.params.voices, `${sourceName} alloc ${m.id}`).toBe(options?.voices !== undefined && original > 1 ? options.voices : original);
    }
    const bus = fxBusOf(p);
    for (const stage of bus?.stages ?? []) {
      for (const id of stage.targets) expect(p.modules.find(m => m.id === id)!.bypass).toBe(true);
    }
    if (options?.harmonizer === 'removed') expect(p.modules.some(m => m.type === 'harm')).toBe(false);
    else expect(p.modules.find(m => m.type === 'harm')!.bypass).toBe(true);
    expect(p.modules.find(m => m.type === 'arp')!.bypass).toBe(true);
    const audit = factoryFxAudit.find(entry => entry.name === sourceName)!;
    for (const effect of audit.existingFx) for (const id of effect.kernels) {
      const original = source.modules.find(m => m.id === id)!;
      expect(p.modules.find(m => m.id === id)!.params).toEqual(original.params);
      expect(p.modules.find(m => m.id === id)!.bypass).toEqual('bypass' in original ? original.bypass : undefined);
    }
  });


  it.each(['Wanderer', 'Vernon 100', 'Canvas'])('does not alter original articulation or DSP parameters for %s', name => {
    const p = patchOf(name, bank);
    const source = SOURCE.find(entry => entry.name === name)!.patch;
    for (const m of source.modules) expect(p.modules.find(candidate => candidate.id === m.id)!.params).toEqual(m.params);
    const ids = new Set(source.modules.filter(m => !['fm1', 'arp', 'harm', 'steps', 'output'].includes(m.type)).map(m => m.id));
    expect(p.cables.filter(c => ids.has(c.from.module) && ids.has(c.to.module)))
      .toEqual(source.cables.filter(c => ids.has(c.from.module) && ids.has(c.to.module)));
  });
});
