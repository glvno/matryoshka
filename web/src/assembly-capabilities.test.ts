// SPDX-License-Identifier: GPL-3.0-only
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { capabilitiesOf, assemblyCapabilities, definitionGraph, previewBypass, recognizeEngine } from './assembly-capabilities';
import { insertAssembly, type AssemblyDef } from './assembly';
import { DEFS } from './modules';
import { addModule, connect, newPatch, validatePatch, type Patch } from './patch';

const fixture = (name: string): Patch => validatePatch(JSON.parse(readFileSync(new URL(`../../docs/capability-examples/${name}.json`, import.meta.url), 'utf8')), DEFS);
const factory = (name: string): AssemblyDef => JSON.parse(readFileSync(new URL(`./assemblies/${name}.json`, import.meta.url), 'utf8'));

describe('assembly capability evidence', () => {
  it('recognizes both factory and user-built effects without changing either patch', () => {
    for (const name of ['01-factory-effects', '02-custom-effects']) {
      const p = fixture(name), before = structuredClone(p);
      const a = p.assemblies!.find(a => a.name === 'echo' || a.name === 'Two filters')!;
      const report = capabilitiesOf(p, a);
      expect(report.engine).toBeNull();
      expect(report.audio?.paths).toHaveLength(1);
      expect(report.audio?.paths[0].modules).toHaveLength(2);
      a.name = 'not an effect'; a.label = 'My renamed thing';
      expect(capabilitiesOf(p, a).audio?.paths).toEqual(report.audio?.paths);
      a.name = before.assemblies!.find(x => x.id === a.id)!.name;
      a.label = before.assemblies!.find(x => x.id === a.id)!.label;
      expect(p).toEqual(before);
    }
  });

  it('refreshes after cable removal, restoration and an exposed output change', () => {
    const p = fixture('02-custom-effects'), a = p.assemblies!.find(a => a.name === 'Two filters')!;
    const original = structuredClone(p.cables);
    p.cables = p.cables.filter(c => !(a.modules.includes(c.from.module) && a.modules.includes(c.to.module)));
    expect(capabilitiesOf(p, a).audio).toBeNull();
    p.cables = original;
    expect(capabilitiesOf(p, a).audio).not.toBeNull();
    a.outputs[0].port = 'not-a-port';
    expect(capabilitiesOf(p, a).audio).toBeNull();
  });

  it('does not infer module dependencies from the presence of audio ports alone', () => {
    const a = factory('echo'); a.modules[0].type = 'vca';
    const report = assemblyCapabilities(definitionGraph(a));
    expect(report.audio).toBeNull();
    expect(report.diagnostics.join(' ')).toContain('not described yet for: vca');
  });

  it('keeps parent and child identities, shared effects, mapped voicing and audio without an engine', () => {
    for (const [name, count] of [['05-shared-effects', 2], ['06-no-engine', 0], ['07-nested', 2], ['08-drums', 1]] as const) {
      const p = fixture(name);
      expect(p.assemblies!.filter(a => capabilitiesOf(p, a).engine)).toHaveLength(count);
      expect(p.assemblies!.filter(a => capabilitiesOf(p, a).audio)).toHaveLength(1);
    }
  });

  it('can report engine and audio-processing capabilities on the same assembly', () => {
    const p = fixture('07-nested'), a = p.assemblies!.find(a => a.name === 'Combined sound')!;
    const fx = p.assemblies!.find(a => a.name === 'echo')!;
    a.inputs.push(structuredClone(fx.inputs[0]));
    const report = capabilitiesOf(p, a);
    expect(report.engine).not.toBeNull(); expect(report.audio).not.toBeNull();
  });

  it('preserves the historical engine result even when its audio output is unrelated', () => {
    const a = factory('mono-lead'); a.cables = [];
    const result = recognizeEngine(definitionGraph(a));
    expect(result?.inputs[0].voicing).toHaveLength(1);
    expect(result?.outputs.length).toBeGreaterThan(0);
  });

  it('finds merged targets, later qualifying inputs, and terminates on keys cycles', () => {
    const a = factory('mono-lead');
    const alloc = a.modules.find(m => m.type === 'alloc')!;
    const id = Math.max(...a.modules.map(m => m.id)) + 1;
    a.modules.push({ id, type: 'arp', x: 0, y: 0, params: {} });
    const input = { module: id, port: 'keys', label: 'unvoiced' };
    a.inputs = [input, { module: alloc.id, port: 'keys', label: 'voiced' }];
    expect(recognizeEngine(definitionGraph(a))?.inputs.map(i => i.port.label)).toEqual(['voiced']);
    a.inputs = [{ ...input, also: [{ module: alloc.id, port: 'keys' }] }];
    expect(recognizeEngine(definitionGraph(a))?.inputs[0].voicing).toEqual([alloc.id]);
    a.inputs = [input];
    a.cables.push({ from: { module: id, port: 'keys' }, to: { module: id, port: 'keys' } });
    expect(recognizeEngine(definitionGraph(a))).toBeNull();
    a.cables.push({ from: { module: id, port: 'keys' }, to: { module: alloc.id, port: 'keys' } });
    expect(recognizeEngine(definitionGraph(a))).not.toBeNull();
  });

  it('treats feedback as a structural audio path but does not invent a bypass contract for it', () => {
    const p = fixture('02-custom-effects'), a = p.assemblies!.find(a => a.name === 'Two filters')!;
    expect(connect(p, DEFS, a.outputs[0], a.inputs[0])).toBe(true);
    expect(capabilitiesOf(p, a).audio).not.toBeNull();
    expect(previewBypass(p, a, { input: a.inputs[0], output: a.outputs[0] }).ok).toBe(false);
  });
});

describe('explicit bypass preview', () => {
  it('validates existing mono serial bypass semantics without applying them', () => {
    for (const name of ['01-factory-effects', '02-custom-effects', '05-shared-effects']) {
      const p = fixture(name), before = structuredClone(p);
      const a = p.assemblies!.find(a => a.name === 'echo' || a.name === 'Two filters')!;
      expect(previewBypass(p, a, { input: a.inputs[0], output: a.outputs[0] })).toMatchObject({ ok: true, state: 'frozen', tails: 'muted', memory: 'retained' });
      expect(p).toEqual(before);
    }
  });
  it('rejects a stale declaration and outside cables reaching internal ports', () => {
    const p = fixture('02-custom-effects'), a = p.assemblies!.find(a => a.name === 'Two filters')!;
    const draft = { input: structuredClone(a.inputs[0]), output: structuredClone(a.outputs[0]) };
    a.outputs[0].port = 'hp';
    expect(previewBypass(p, a, draft).ok).toBe(false);
    a.outputs[0] = draft.output;
    const lfo = addModule(p, DEFS.lfo, 0, 0);
    expect(connect(p, DEFS, { module: lfo.id, port: 'out' }, { module: a.modules[1], port: 'cv' })).toBe(true);
    expect(previewBypass(p, a, draft)).toMatchObject({ ok: false, reason: expect.stringContaining('outside cable') });
  });
  it('rejects multiple or merged audio inputs without rewriting the patch', () => {
    const p = newPatch(DEFS), a = insertAssembly(p, DEFS, factory('echo'), 0, 0);
    a.inputs[0].also = [{ module: a.modules[1], port: 'in' }];
    expect(capabilitiesOf(p, a).audio).toBeNull();
    expect(previewBypass(p, a, { input: a.inputs[0], output: a.outputs[0] }).ok).toBe(false);
  });
});
