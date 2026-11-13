// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { buildFactoryBank, buildSelectedFactoryBank, factoryFile, factoryFxAudit, selectedFactoryNames, selectedFactoryProfile } from './factory-bank';
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


  it.each([0, 1, 2, 2.5, 5, NaN, Infinity])('rejects an invalid Oracle V voice request %s', voices => {
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
    expect(() => buildFactoryBank({ '8 Lire': { omit: ['reverb'] } })).toThrow(/protected/);
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

  it('exposes the approved 22 names in order, with examples only in the editor', () => {
    const names = [
      'Oracle V', 'Monolith D', 'Silver Box', 'Hera 3', 'Sallen 20', 'Expander S', 'Algo Four',
      'Canvas', 'Wanderer', 'Briefcase 3', 'Io 4', 'Vernon 100', '8 Lire', 'Elvira 2',
      'Scrounge', 'Meridian 8', 'Perun 4', '808 Kit', '909 Kit', 'Spokes 6', 'Cassia 1', 'Verona Drum 1',
    ];
    expect(Object.keys(FM1_PRESETS)).toEqual(names);
    expect(selectedFactoryNames).toEqual(names);
    expect(Object.keys(EXAMPLE_PRESETS)).toEqual([
      'Init', 'Simple FM', 'Plucked String', 'Basic Poly', 'Drift Poly', 'Mono Lead', 'Supersaw Stack', '<7PH',
    ]);
    for (const name of Object.keys(EXAMPLE_PRESETS)) {
      expect(FM1_PRESETS[name]).toBeUndefined();
      expect(PRESETS[name]).toBe(EXAMPLE_PRESETS[name]);
    }
    expect(FM1_PRESETS['Hera 4']).toBeUndefined();
    expect(PRESETS['Hera 4']).toBeUndefined();
    expect(factoryShape('Hera 4')).toBeUndefined();
    expect(factoryShape('Hera 3')).toBe(shapeOf(FM1_PRESETS['Hera 3']()));
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
    expect(bank).toHaveLength(22);
    expect(protectedEntries).toHaveLength(9);
    expect(bank.map(entry => entry.name)).toEqual(SOURCE.map(entry => selectedFactoryProfile[entry.name]?.bankName ?? entry.name));
    for (const source of protectedEntries) {
      expect(selectedFactoryProfile[source.name]).toBeUndefined();
      expect(patchOf(source.name, bank)).toEqual(source.patch);
    }
    for (const [name, options] of Object.entries(selectedFactoryProfile)) if (options.outputLevel !== undefined) {
      expect(factoryFxAudit.some(audit => audit.name === name), name).toBe(true);
      expect(patchOf(options.bankName ?? name, bank).modules.find(module => module.type === 'output')!.params.level, name).toBe(options.outputLevel);
    }
  });

  it.each([
    ['Monolith D', [1], ['drive', 'chorus', 'delay', 'reverb']],
    ['Silver Box', [1], ['drive', 'chorus', 'delay', 'reverb']],
    ['Algo Four', [4], ['drive', 'delay', 'reverb']],
    ['Oracle V', [4], ['drive', 'chorus']],
    ['Canvas', [1], ['delay']],
    ['Expander S', [3], ['drive', 'chorus', 'delay', 'reverb']],
    ['Briefcase 3', [1], ['drive', 'chorus', 'delay']],
    ['Wanderer', [1, 1], ['drive', 'delay', 'reverb']],
    ['Cassia 1', [4], ['drive', 'delay']],
    ['Vernon 100', [1, 1], ['drive', 'chorus', 'delay']],
    ['Sallen 20', [1], ['drive', 'chorus', 'delay']],
    ['Hera 3', [3, 1], []],
    ['Io 4', [4, 1], ['drive', 'delay']],
  ] as const)('retains selected voices and added FX for %s', (name, voices, addedFx) => {
    const p = patchOf(name, bank);
    expect(p.modules.filter(m => m.type === 'alloc').map(m => m.params.voices)).toEqual(voices);
    const bus = fxBusOf(p);
    expect(bus?.stages.map(stage => stage.kind) ?? []).toEqual(addedFx);
    for (const stage of bus?.stages ?? []) {
      for (const id of stage.targets) expect(p.modules.find(m => m.id === id)!.bypass).toBe(true);
    }
    const sourceName = Object.entries(selectedFactoryProfile).find(([source, options]) => (options.bankName ?? source) === name)![0];
    if (selectedFactoryProfile[sourceName].harmonizer === 'removed') expect(p.modules.some(m => m.type === 'harm')).toBe(false);
    else expect(p.modules.find(m => m.type === 'harm')!.bypass).toBe(true);
    expect(p.modules.find(m => m.type === 'arp')!.bypass).toBe(true);
    const source = SOURCE.find(entry => entry.name === sourceName)!.patch;
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
