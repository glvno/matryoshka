// SPDX-License-Identifier: GPL-3.0-only
// The D-1010 master FX bus recognizer, kept to convert old patches (fx-legacy.ts): what it takes for a bus and what it
// declines (the cases moved here from the bus's own tests when the bus became the FX drawer), and what the conversion makes.
import { describe, expect, it } from 'vitest';
import { allModules, bypassAssembly, drawerOf, drawers, effectsOf, fixAssemblies, makeAssembly, outputDrawer, rowTargets } from './assembly';
import { withFxBus } from './factory-bank';
import { convertLegacyBus, fxBusOf, type FxStageKind } from './fx-legacy';
import { DEFS } from './modules';
import { addModule, connect, newPatch, validatePatch, type Patch } from './patch';

function sourcePatch(right = true): Patch {
  const p = newPatch(DEFS, 'Stereo source');
  const output = p.modules.find((m) => m.type === 'output')!;
  const l = addModule(p, DEFS.macro, 0, 0);
  const r = addModule(p, DEFS.macro, 0, 560);
  connect(p, DEFS, { module: l.id, port: 'out' }, { module: output.id, port: 'l' });
  if (right) connect(p, DEFS, { module: r.id, port: 'out' }, { module: output.id, port: 'r' });
  return p;
}
const bus = (p: Patch) => fxBusOf(p, DEFS);

describe('recognizing a D-1010 bus', () => {
  it('keeps recognition across helper power states used by target-only runtime transitions', () => {
    const p = withFxBus(sourcePatch(), { omit: ['drive', 'chorus', 'delay'] });
    const stage = bus(p)!.stages[0];
    for (const id of stage.helpers) delete p.modules.find((m) => m.id === id)!.bypass;
    expect(bus(p)!.stages[0]).toEqual(stage);
    delete p.modules.find((m) => m.id === stage.targets[0])!.bypass;
    expect(bus(p)!.stages[0]).toEqual(stage);
    p.modules.find((m) => m.id === stage.targets[0])!.bypass = true;
    expect(bus(p)!.stages[0]).toEqual(stage);
  });

  it('declines authored Reverb helper bypass combinations without using the group switch as authority', () => {
    const canonical = withFxBus(sourcePatch(), { omit: ['drive', 'chorus', 'delay'] });
    const stage = bus(canonical)!.stages[0];
    for (const kernelOff of [false, true]) {
      for (const groupOff of [false, true]) {
        for (let mask = 0; mask < 1 << stage.helpers.length; mask++) {
          const p = structuredClone(canonical);
          p.modules.find((m) => m.id === stage.targets[0])!.bypass = kernelOff;
          p.assemblies!.find((a) => a.id === stage.assembly)!.bypass = groupOff;
          stage.helpers.forEach((id, i) => { p.modules.find((m) => m.id === id)!.bypass = !!(mask & (1 << i)); });
          const saved = structuredClone(p);
          // Runtime helpers are all active, or legacy OFF bypasses every helper and the kernel.
          const recognized = mask === 0 || kernelOff && mask === (1 << stage.helpers.length) - 1;
          expect(bus(p) !== null).toBe(recognized);
          expect(p).toEqual(saved);
        }
      }
    }
  });

  it('declines kept child bypass exceptions even while every Reverb member is OFF', () => {
    const canonical = withFxBus(sourcePatch(), { omit: ['drive', 'chorus', 'delay'] });
    const stage = bus(canonical)!.stages[0];
    for (const id of [...stage.targets, ...stage.helpers]) {
      const p = structuredClone(canonical);
      const assembly = p.assemblies!.find((a) => a.id === stage.assembly)!;
      assembly.kept = [id];
      expect(bus(p)).toBeNull();
      bypassAssembly(p, assembly, false);
      expect(p.modules.find((m) => m.id === id)!.bypass).toBe(true);
      expect(assembly.kept).toBeUndefined();
    }
    canonical.assemblies!.find((a) => a.id === stage.assembly)!.kept = [];
    expect(bus(canonical)).not.toBeNull();
  });

  it('rejects lost taps, untied controls, hidden modulation, feedback and nonterminal inserts', () => {
    const original = withFxBus(sourcePatch());
    const cases: ((p: Patch) => void)[] = [
      (p) => { p.cables.splice(p.cables.findIndex((c) => c.from.port === 'r' && p.modules.find((m) => m.id === c.from.module)?.type === 'delay'), 1); },
      (p) => { const root = p.assemblies!.find((a) => a.id === bus(p)!.assembly)!; delete root.params[0].also; },
      (p) => { const stage = bus(p)!.stages[1]; p.modules.find((m) => m.id === stage.targets[1])!.params.depth = 0.2; },
      (p) => { const stage = bus(p)!.stages[2]; p.cables.push({ from: { module: stage.targets[1], port: 'r' }, to: { module: stage.targets[0], port: 'in' } }); },
      (p) => { const root = p.assemblies!.find((a) => a.id === bus(p)!.assembly)!; connect(p, DEFS, { module: p.modules.find((m) => m.type === 'macro')!.id, port: 'out' }, { module: root.modules[0], port: 'p1' }); },
      (p) => { connect(p, DEFS, { module: p.modules.find((m) => m.type === 'macro')!.id, port: 'out' }, { module: p.modules.find((m) => m.type === 'output')!.id, port: 'l' }); },
      (p) => { p.modules.find((m) => m.type === 'math')!.params.ka = 0.5; },
      (p) => { p.cables.splice(p.cables.findIndex((c) => p.modules.find((m) => m.id === c.from.module)?.type === 'math' && c.from.port === 'sub'), 1); },
      (p) => { const stage = bus(p)!.stages[3]; p.assemblies!.find((a) => a.id === stage.assembly)!.modules[1] = stage.targets[0]; },
      (p) => { const stage = bus(p)!.stages[0]; p.assemblies!.find((a) => a.id === stage.assembly)!.poly = {}; },
      (p) => { const stage = bus(p)!.stages[3]; p.modules.find((m) => m.id === stage.targets[0])!.params.mix = 0.3; },
      (p) => { const stage = bus(p)!.stages[3]; p.modules.find((m) => stage.helpers.includes(m.id) && m.type === 'scale')!.params.gain = 0.5; },
      (p) => { const stage = bus(p)!.stages[3]; p.modules.find((m) => stage.helpers.includes(m.id) && m.type === 'macro')!.params.value = 2; },
      (p) => { const stage = bus(p)!.stages[3]; const wet = p.modules.find((m) => stage.helpers.includes(m.id) && m.type === 'math' && m.params.ka === 1)!; p.cables.find((c) => c.from.module === wet.id)!.from.port = 'add'; },
      (p) => { const root = p.assemblies!.find((a) => a.id === bus(p)!.assembly)!; root.params[0].also!.push({ module: p.modules.find((m) => m.type === 'macro')!.id, param: 'value' }); },
    ];
    for (const change of cases) {
      const p = structuredClone(original);
      change(p);
      expect(bus(p)).toBeNull();
      // (an unrecognized bus stays as it is when the patch opens)
      const opened = validatePatch(structuredClone(p), DEFS);
      expect(drawers(opened)).toEqual([]);
    }
    for (const a of original.assemblies!) { a.label = 'Anything'; a.name = 'Not FX'; }
    expect(bus(original)).not.toBeNull();
    expect(allModules(original, original.assemblies!.find((a) => a.id === bus(original)!.assembly)!)).toEqual(original.modules.slice(-14).map((m) => m.id));
    const rows = original.assemblies!.find((a) => a.id === bus(original)!.assembly)!.params;
    expect(rows.slice(0, -6).every((r) => rowTargets(r).length === 2)).toBe(true);
    expect(rows.slice(-6).every((r) => rowTargets(r).length === 1)).toBe(true);
    expect(bus(sourcePatch())).toBeNull();
  });
});

describe('converting a D-1010 bus', () => {
  it('turns every sparse bus into a drawer of the same stages in order; an Output drawer without a sole instrument', () => {
    const kinds: FxStageKind[] = ['drive', 'chorus', 'delay', 'reverb'];
    for (let mask = 1; mask < 16; mask++) {
      const present = kinds.filter((_, i) => mask & (1 << i));
      const p = withFxBus(sourcePatch(), { omit: kinds.filter((kind) => !present.includes(kind)) });
      const b = bus(p)!;
      const q = convertLegacyBus(structuredClone(p), DEFS);
      expect(q.modules).toEqual(p.modules.map((m) => (b.stages.some((s) => s.helpers.includes(m.id)) ? (({ bypass: _, ...rest }) => rest)(m) : m)));
      expect(q.cables).toEqual(p.cables);
      const d = outputDrawer(q)!;
      expect(d.id).toBe(b.assembly);
      expect(effectsOf(q, d).map((e) => e.id)).toEqual(b.stages.map((s) => s.assembly));
      for (const [i, e] of effectsOf(q, d).entries()) expect(e.chain!.helpers ?? []).toEqual(b.stages[i].helpers);
      expect(JSON.stringify(convertLegacyBus(structuredClone(q), DEFS))).toBe(JSON.stringify(q));
      fixAssemblies(q, DEFS);
      expect(outputDrawer(q)?.id).toBe(b.assembly);
    }
  });

  it('gives the bus to the one instrument whose outputs feed it, tapping those outputs', () => {
    const source = sourcePatch();
    const macros = source.modules.filter((m) => m.type === 'macro').map((m) => m.id);
    const inst = makeAssembly(source, macros, 'Core');
    const q = validatePatch(withFxBus(source), DEFS);
    fixAssemblies(q, DEFS);
    const d = drawerOf(q, inst.id)!;
    expect(d.drawer!.taps).toEqual(macros.map((module) => ({ module, port: 'out' })));
    expect(effectsOf(q, d)).toHaveLength(4);
    // two instruments: the Output drawer
    const two = sourcePatch();
    for (const m of two.modules.filter((x) => x.type === 'macro')) makeAssembly(two, [m.id], 'part');
    const q2 = validatePatch(withFxBus(two), DEFS);
    expect(outputDrawer(q2)).toBeDefined();
  });

  it('a mono source keeps the Output mono fallback: both taps are the one output', () => {
    const source = sourcePatch(false);
    const inst = makeAssembly(source, source.modules.filter((m) => m.type === 'macro').map((m) => m.id), 'Core');
    const q = validatePatch(withFxBus(source), DEFS);
    const taps = drawerOf(q, inst.id)!.drawer!.taps!;
    expect(taps[0]).toEqual(taps[1]);
  });
});
