// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { allModules, bypassAssembly, makeAssembly, rowTargets } from './assembly';
import { fxBusOf, withFxBus, type FxStageKind } from './fx-bus';
import { DEFS, DEVICE_SR, IMPLS, type Ctx, type Voice } from './modules';
import { addModule, connect, newPatch, processingOrder, thruInput, validatePatch, type Endpoint, type Patch } from './patch';

const voice: Voice = {
  pitch: 0, gate: 0, velocity: 0, keyTrig: false, low: false, high: false, unison: false,
  clock: false, run: false, tick: -1, ticks: 0, tickLen: DEVICE_SR / 48, buttons: 0,
  bend: 0, mod: 0, at: 0, breath: 0, sustain: 0, foot: 0, index: 0, parts: 1, legato: 0, jump: 0, flaw: 0,
};

function sourcePatch(right = true): Patch {
  const p = newPatch(DEFS, 'Stereo source');
  const output = p.modules.find((m) => m.type === 'output')!;
  const l = addModule(p, DEFS.macro, 0, 0);
  const r = addModule(p, DEFS.macro, 0, 560);
  connect(p, DEFS, { module: l.id, port: 'out' }, { module: output.id, port: 'l' });
  if (right) connect(p, DEFS, { module: r.id, port: 'out' }, { module: output.id, port: 'r' });
  return p;
}

// Exercise actual ordinary DSP kernels and ordinary bypass, without importing the engine/codec/page layers.
function render(p: Patch, l: Float32Array, r: Float32Array): [Float32Array, Float32Array] {
  const sources = p.modules.filter((m) => m.type === 'macro');
  const output = p.modules.find((m) => m.type === 'output')!;
  const states = new Map(p.modules.map((m) => [m.id, IMPLS[m.type].init(DEVICE_SR)]));
  const order = processingOrder(p).order;
  const result: [Float32Array, Float32Array] = [new Float32Array(l.length), new Float32Array(l.length)];
  for (let at = 0; at < l.length; at += 128) {
    const n = Math.min(128, l.length - at);
    const outputs = new Map<number, Record<string, Float32Array>>();
    const input = (to: Endpoint): Float32Array => {
      const values = new Float32Array(n);
      for (const c of p.cables.filter((c) => c.to.module === to.module && c.to.port === to.port)) {
        const from = outputs.get(c.from.module)![c.from.port];
        for (let i = 0; i < n; i++) values[i] += from[i];
      }
      return values;
    };
    for (const id of order) {
      const m = p.modules.find((m) => m.id === id)!;
      if (m.id === sources[0].id || m.id === sources[1].id) {
        outputs.set(id, { out: (m.id === sources[0].id ? l : r).slice(at, at + n) });
        continue;
      }
      const impl = IMPLS[m.type];
      const inp = Object.fromEntries(impl.def.inputs.map((port) => [port.name, input({ module: id, port: port.name })]));
      const out = Object.fromEntries(impl.def.outputs.map((port) => [port.name, new Float32Array(n)]));
      const connected = Object.fromEntries(impl.def.inputs.map((port) => [port.name, p.cables.some((c) => c.to.module === id && c.to.port === port.name)]));
      const context: Ctx = { sr: DEVICE_SR, n, inp, out, connected, p: m.params, voice };
      if (m.bypass) {
        const thru = thruInput(impl.def);
        if (thru) for (const values of Object.values(out)) values.set(inp[thru]);
      } else impl.process(context, states.get(id));
      outputs.set(id, out);
      if (id === output.id) {
        result[0].set(inp.l, at);
        result[1].set(connected.r ? inp.r : inp.l, at);
      }
    }
  }
  return result;
}

function native(kind: 'chorus' | 'delay' | 'reverb', params: Record<string, number>, input: Float32Array): [Float32Array, Float32Array] {
  const impl = IMPLS[kind];
  const state = impl.init(DEVICE_SR);
  const result: [Float32Array, Float32Array] = [new Float32Array(input.length), new Float32Array(input.length)];
  for (let at = 0; at < input.length; at += 128) {
    const n = Math.min(128, input.length - at);
    const inp = Object.fromEntries(impl.def.inputs.map((port) => [port.name, port.name === 'in' ? input.slice(at, at + n) : new Float32Array(n)]));
    const out = Object.fromEntries(impl.def.outputs.map((port) => [port.name, new Float32Array(n)]));
    impl.process({ sr: DEVICE_SR, n, inp, out, connected: { in: true }, p: params, voice }, state);
    result[0].set(out[kind === 'chorus' ? 'l' : 'out'], at);
    result[1].set(kind === 'reverb' ? out.out : out.r, at);
  }
  return result;
}

function activate(p: Patch, kind: FxStageKind, values: Record<string, number>): number[] {
  const stage = fxBusOf(p)!.stages.find((s) => s.kind === kind)!;
  const assembly = p.assemblies!.find((a) => a.id === stage.assembly)!;
  bypassAssembly(p, assembly, false);
  for (const [name, value] of Object.entries(values)) {
    const row = assembly.params.find((r) => r.label === name)!;
    for (const t of rowTargets(row)) p.modules.find((m) => m.id === t.module)!.params[t.param] = value;
  }
  return stage.targets;
}

const peak = (x: Float32Array): number => x.reduce((top, value) => Math.max(top, Math.abs(value)), 0);

function expectSignal(actual: Float32Array, expected: Float32Array): void {
  let error = 0;
  for (let i = 0; i < actual.length; i++) error = Math.max(error, Math.abs(actual[i] - expected[i]));
  expect(error).toBeLessThan(2e-7);
}

describe('editable master FX', () => {
  it('preserves source modules, ownership, cards, players and saved state without aliasing', () => {
    const source = sourcePatch();
    source.notes = 'Keep this note';
    const allocator = addModule(source, DEFS.alloc, 640, 0);
    allocator.params.voices = 7;
    const steps = addModule(source, DEFS.steps, 960, 0);
    steps.notes = [{ at: 0, len: 2, note: 60, vel: 100, chance: 100 }];
    const instrument = makeAssembly(source, [source.modules.find((m) => m.type === 'macro')!.id], 'Core');
    instrument.preset = 'Original card';
    const before = structuredClone(source);
    const p = withFxBus(source);
    expect(source).toEqual(before);
    expect(p.modules.slice(0, source.modules.length)).toEqual(source.modules);
    expect(p.assemblies!.slice(0, source.assemblies!.length)).toEqual(source.assemblies);
    expect(p.notes).toBe(source.notes);
    expect(fxBusOf(p)!.stages.map((s) => s.kind)).toEqual(['drive', 'chorus', 'delay', 'reverb']);
    expect(fxBusOf(validatePatch(p, DEFS))).not.toBeNull();
    expect(withFxBus(p)).toEqual(p);
    expect(p.modules).not.toBe(source.modules);
    expect(p.modules.filter((m) => m.type === 'delay').map((m) => [m.params.length, m.params.rate])).toEqual([[500, 0], [500, 0]]);
  });

  it('adds only explicitly present stages, preserving order and stereo bypass for every sparse bus', () => {
    const kinds: FxStageKind[] = ['drive', 'chorus', 'delay', 'reverb'];
    const source = sourcePatch();
    const l = Float32Array.from([0.5, -0.25, 0, 0.125]);
    const r = Float32Array.from([0, 0.75, -0.5, 0]);
    for (let mask = 1; mask < 16; mask++) {
      const present = kinds.filter((_, i) => mask & (1 << i));
      const p = withFxBus(source, { omit: kinds.filter((kind) => !present.includes(kind)) });
      const bus = fxBusOf(p)!;
      expect(bus.stages.map((s) => s.kind)).toEqual(present);
      expect(bus.stages.map((s) => s.targets.length)).toEqual(present.map((kind) => kind === 'reverb' ? 1 : 2));
      expect(fxBusOf(validatePatch(p, DEFS))).not.toBeNull();
      expect(withFxBus(p, { omit: kinds })).toEqual(p);
      const actual = render(p, l, r);
      expectSignal(actual[0], l);
      expectSignal(actual[1], r);
    }
    const empty = withFxBus(source, { omit: kinds });
    expect(empty).toEqual(source);
    expect(empty).not.toBe(source);
    expect(fxBusOf(empty)).toBeNull();
  });

  it('exposes bounded Reverb controls while keeping its sole kernel wet-only and helpers ordinary', () => {
    const p = withFxBus(sourcePatch(), { omit: ['drive', 'chorus', 'delay'] });
    const stage = fxBusOf(p)!.stages[0];
    const assembly = p.assemblies!.find((a) => a.id === stage.assembly)!;
    expect(stage.targets).toHaveLength(1);
    expect(allModules(p, assembly).sort((a, b) => a - b)).toEqual([...stage.targets, ...stage.helpers].sort((a, b) => a - b));
    expect(allModules(p, assembly).every((id) => p.modules.find((m) => m.id === id)!.bypass)).toBe(true);
    expect(p.modules.find((m) => m.id === stage.targets[0])!.params.mix).toBe(1);
    const mix = assembly.params[2];
    const helper = p.modules.find((m) => m.id === mix.module)!;
    expect(helper.type).toBe('macro');
    expect(mix.param).toBe('value');
    const def = DEFS[helper.type].params.find((pd) => pd.name === mix.param)!;
    expect([def.min, def.max]).toEqual([0, 1]);
  });

  it('adds one averaged mono wet response without changing either stereo dry channel', () => {
    for (const mix of [0, 0.37, 1]) {
      const p = withFxBus(sourcePatch(), { omit: ['drive', 'chorus', 'delay'] });
      const targets = activate(p, 'reverb', { mix, mod: 0, pre: 10 });
      const l = new Float32Array(8192);
      const r = new Float32Array(l.length);
      l[0] = 0.5;
      r[137] = -0.25;
      const average = Float32Array.from(l, (v, i) => (v + r[i]) * 0.5);
      const wet = native('reverb', p.modules.find((m) => m.id === targets[0])!.params, average)[0];
      const actual = render(p, l, r);
      expectSignal(actual[0], Float32Array.from(l, (v, i) => v + wet[i] * mix));
      expectSignal(actual[1], Float32Array.from(r, (v, i) => v + wet[i] * mix));
      expectSignal(Float32Array.from(actual[0], (v, i) => v - actual[1][i]), Float32Array.from(l, (v, i) => v - r[i]));
      expect(peak(wet)).toBeGreaterThan(0.001);
      expect(fxBusOf(p)).not.toBeNull();
    }
  });

  it('makes ordinary Reverb stage and whole-bus OFF exact stereo dry with no averaged-dry injection', () => {
    for (const wholeBus of [false, true]) {
      const p = withFxBus(sourcePatch(), { omit: ['drive', 'chorus', 'delay'] });
      activate(p, 'reverb', { mix: 1 });
      const bus = fxBusOf(p)!;
      bypassAssembly(p, p.assemblies!.find((a) => a.id === (wholeBus ? bus.assembly : bus.stages[0].assembly))!, true);
      const l = Float32Array.from([0.5, 0, -0.25, 0]);
      const r = Float32Array.from([0, -0.75, 0, 0.125]);
      const actual = render(p, l, r);
      expectSignal(actual[0], l);
      expectSignal(actual[1], r);
      if (!wholeBus) expect(fxBusOf(p)).not.toBeNull();
    }
  });

  it('keeps recognition across helper power states used by target-only runtime transitions', () => {
    const p = withFxBus(sourcePatch(), { omit: ['drive', 'chorus', 'delay'] });
    const stage = fxBusOf(p)!.stages[0];
    for (const id of stage.helpers) delete p.modules.find((m) => m.id === id)!.bypass;
    expect(fxBusOf(p)!.stages[0]).toEqual(stage);
    delete p.modules.find((m) => m.id === stage.targets[0])!.bypass;
    expect(fxBusOf(p)!.stages[0]).toEqual(stage);
    p.modules.find((m) => m.id === stage.targets[0])!.bypass = true;
    expect(fxBusOf(p)!.stages[0]).toEqual(stage);
  });

  it('declines authored Reverb helper bypass combinations without using the group switch as authority', () => {
    const canonical = withFxBus(sourcePatch(), { omit: ['drive', 'chorus', 'delay'] });
    const stage = fxBusOf(canonical)!.stages[0];
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
          expect(fxBusOf(p) !== null).toBe(recognized);
          expect(p).toEqual(saved);
        }
      }
    }
  });

  it('declines kept child bypass exceptions even while every Reverb member is OFF', () => {
    const canonical = withFxBus(sourcePatch(), { omit: ['drive', 'chorus', 'delay'] });
    const stage = fxBusOf(canonical)!.stages[0];
    for (const id of [...stage.targets, ...stage.helpers]) {
      const p = structuredClone(canonical);
      const assembly = p.assemblies!.find((a) => a.id === stage.assembly)!;
      assembly.kept = [id];
      expect(fxBusOf(p)).toBeNull();
      bypassAssembly(p, assembly, false);
      expect(p.modules.find((m) => m.id === id)!.bypass).toBe(true);
      expect(assembly.kept).toBeUndefined();
    }
    canonical.assemblies!.find((a) => a.id === stage.assembly)!.kept = [];
    expect(fxBusOf(canonical)).not.toBeNull();
  });

  it('keeps arbitrary stereo samples and hard-panned inputs dry at every saved mix', () => {
    for (const mix of [0, 0.37, 1]) {
      const p = withFxBus(sourcePatch());
      for (const m of p.modules) if ('mix' in m.params && m.type !== 'reverb') m.params.mix = mix;
      const reverb = fxBusOf(p)!.stages.find((s) => s.kind === 'reverb')!;
      p.modules.find((m) => reverb.helpers.includes(m.id) && m.type === 'macro')!.params.value = mix;
      const l = Float32Array.from({ length: 1024 }, (_, i) => i === 0 ? 0.75 : i === 19 ? -0.5 : 0);
      const r = Float32Array.from({ length: 1024 }, (_, i) => i === 3 ? -0.25 : i === 47 ? 0.6 : 0);
      const actual = render(p, l, r);
      expectSignal(actual[0], l);
      expectSignal(actual[1], r);
      expect(fxBusOf(p)).not.toBeNull();
    }
  });

  it('keeps recursive whole-assembly bypass stereo identity too', () => {
    const p = withFxBus(sourcePatch());
    const bus = fxBusOf(p)!;
    for (const id of bus.stages.flatMap((s) => s.targets)) delete p.modules.find((m) => m.id === id)!.bypass;
    bypassAssembly(p, p.assemblies!.find((a) => a.id === bus.assembly)!, true);
    const l = Float32Array.from([0.5, 0, -0.25, 0]);
    const r = Float32Array.from([0, -0.75, 0, 0.125]);
    const actual = render(p, l, r);
    expectSignal(actual[0], l);
    expectSignal(actual[1], r);
  });

  it('preserves the Output mono fallback', () => {
    const p = withFxBus(sourcePatch(false));
    const l = Float32Array.from([0.25, -0.5, 0.75]);
    const actual = render(p, l, new Float32Array(l.length));
    expectSignal(actual[0], l);
    expectSignal(actual[1], l);
  });

  it('sums multiple original master cables on both sides of a mono source', () => {
    const source = sourcePatch(false);
    const sources = source.modules.filter((m) => m.type === 'macro');
    connect(source, DEFS, { module: sources[1].id, port: 'out' }, { module: source.modules.find((m) => m.type === 'output')!.id, port: 'l' });
    const p = withFxBus(source);
    const actual = render(p, Float32Array.from([0.25, -0.5]), Float32Array.from([0.5, 0.25]));
    expectSignal(actual[0], Float32Array.from([0.75, -0.25]));
    expectSignal(actual[1], Float32Array.from([0.75, -0.25]));
  });

  it('lets the ordinary stage group switch enable initially bypassed kernels without touching returns', () => {
    const p = withFxBus(sourcePatch());
    const bus = fxBusOf(p)!;
    const stage = p.assemblies!.find((a) => a.id === bus.stages[1].assembly)!;
    expect(stage.bypass).toBe(true);
    bypassAssembly(p, stage, false);
    expect(bus.stages[1].targets.every((id) => !p.modules.find((m) => m.id === id)!.bypass)).toBe(true);
    const root = p.assemblies!.find((a) => a.id === bus.assembly)!;
    expect(root.modules.every((id) => !p.modules.find((m) => m.id === id)!.bypass)).toBe(true);
    expect(fxBusOf(p)).not.toBeNull();
  });

  for (const kind of ['chorus', 'delay'] as const) {
    it(`reproduces native stereo ${kind} on mono input, including its opposite tap`, () => {
      const p = withFxBus(sourcePatch());
      const targets = activate(p, kind, kind === 'delay' ? { mix: 1, time: 20, fb: 0.65, pingpong: 1 } : { mix: 1, depth: 0.9, rate: 2 });
      const input = new Float32Array(8192);
      input[0] = 0.5;
      const actual = render(p, input, input);
      const expected = native(kind, p.modules.find((m) => m.id === targets[0])!.params, input);
      expectSignal(actual[0], expected[0]);
      expectSignal(actual[1], expected[1]);
      expect(peak(actual[0])).toBeGreaterThan(0.001);
      expect(peak(actual[1])).toBeGreaterThan(0.001);
      expect(actual[0].some((value, i) => Math.abs(value - actual[1][i]) > 0.001)).toBe(true);
    });

    it(`retains both native ${kind} taps from either hard-panned input`, () => {
      for (const side of [0, 1]) {
        const p = withFxBus(sourcePatch());
        const targets = activate(p, kind, kind === 'delay' ? { mix: 1, time: 20, fb: 0.65, pingpong: 1 } : { mix: 1, depth: 0.9, rate: 2 });
        const impulse = new Float32Array(8192);
        impulse[0] = 0.5;
        const silence = new Float32Array(impulse.length);
        const actual = render(p, side ? silence : impulse, side ? impulse : silence);
        const [l, r] = native(kind, p.modules.find((m) => m.id === targets[0])!.params, impulse);
        const expectedL = Float32Array.from(l, (v, i) => side ? 0.25 * (v - r[i]) : 0.75 * v + 0.25 * r[i]);
        const expectedR = Float32Array.from(r, (v, i) => side ? 0.25 * l[i] + 0.75 * v : 0.25 * (v - l[i]));
        expectSignal(actual[0], expectedL);
        expectSignal(actual[1], expectedR);
        expect(peak(actual[0])).toBeGreaterThan(0.001);
        expect(peak(actual[1])).toBeGreaterThan(0.001);
      }
    });
  }

  it('supports all four stages running together without collapsing hard-panned stereo', () => {
    const p = withFxBus(sourcePatch());
    for (const kind of ['drive', 'chorus', 'delay', 'reverb'] as const) activate(p, kind, {});
    const impulse = new Float32Array(16384);
    impulse[0] = 0.25;
    const [l, r] = render(p, impulse, new Float32Array(impulse.length));
    expect(peak(l)).toBeGreaterThan(0.01);
    expect(peak(r)).toBeGreaterThan(0.001);
    expect([...l, ...r].every(Number.isFinite)).toBe(true);
    expect(l.some((v, i) => Math.abs(v - r[i]) > 0.001)).toBe(true);
  });

  it('rejects lost taps, untied controls, hidden modulation, feedback and nonterminal inserts', () => {
    const original = withFxBus(sourcePatch());
    const cases: ((p: Patch) => void)[] = [
      (p) => { p.cables.splice(p.cables.findIndex((c) => c.from.port === 'r' && p.modules.find((m) => m.id === c.from.module)?.type === 'delay'), 1); },
      (p) => { const root = p.assemblies!.find((a) => a.id === fxBusOf(p)!.assembly)!; delete root.params[0].also; },
      (p) => { const stage = fxBusOf(p)!.stages[1]; p.modules.find((m) => m.id === stage.targets[1])!.params.depth = 0.2; },
      (p) => { const stage = fxBusOf(p)!.stages[2]; p.cables.push({ from: { module: stage.targets[1], port: 'r' }, to: { module: stage.targets[0], port: 'in' } }); },
      (p) => { const root = p.assemblies!.find((a) => a.id === fxBusOf(p)!.assembly)!; connect(p, DEFS, { module: p.modules.find((m) => m.type === 'macro')!.id, port: 'out' }, { module: root.modules[0], port: 'p1' }); },
      (p) => { connect(p, DEFS, { module: p.modules.find((m) => m.type === 'macro')!.id, port: 'out' }, { module: p.modules.find((m) => m.type === 'output')!.id, port: 'l' }); },
      (p) => { p.modules.find((m) => m.type === 'math')!.params.ka = 0.5; },
      (p) => { p.cables.splice(p.cables.findIndex((c) => p.modules.find((m) => m.id === c.from.module)?.type === 'math' && c.from.port === 'sub'), 1); },
      (p) => { const stage = fxBusOf(p)!.stages[3]; p.assemblies!.find((a) => a.id === stage.assembly)!.modules[1] = stage.targets[0]; },
      (p) => { const stage = fxBusOf(p)!.stages[0]; p.assemblies!.find((a) => a.id === stage.assembly)!.poly = {}; },
      (p) => { const stage = fxBusOf(p)!.stages[3]; p.modules.find((m) => m.id === stage.targets[0])!.params.mix = 0.3; },
      (p) => { const stage = fxBusOf(p)!.stages[3]; p.modules.find((m) => stage.helpers.includes(m.id) && m.type === 'scale')!.params.gain = 0.5; },
      (p) => { const stage = fxBusOf(p)!.stages[3]; p.modules.find((m) => stage.helpers.includes(m.id) && m.type === 'macro')!.params.value = 2; },
      (p) => { const stage = fxBusOf(p)!.stages[3]; const wet = p.modules.find((m) => stage.helpers.includes(m.id) && m.type === 'math' && m.params.ka === 1)!; p.cables.find((c) => c.from.module === wet.id)!.from.port = 'add'; },
      (p) => { const root = p.assemblies!.find((a) => a.id === fxBusOf(p)!.assembly)!; root.params[0].also!.push({ module: p.modules.find((m) => m.type === 'macro')!.id, param: 'value' }); },
    ];
    for (const change of cases) {
      const p = structuredClone(original);
      change(p);
      expect(fxBusOf(p)).toBeNull();
    }
    for (const a of original.assemblies!) { a.label = 'Anything'; a.name = 'Not FX'; }
    expect(fxBusOf(original)).not.toBeNull();
    expect(allModules(original, original.assemblies!.find((a) => a.id === fxBusOf(original)!.assembly)!)).toEqual(original.modules.slice(-14).map((m) => m.id));
    const rows = original.assemblies!.find((a) => a.id === fxBusOf(original)!.assembly)!.params;
    expect(rows.slice(0, -6).every((r) => rowTargets(r).length === 2)).toBe(true);
    expect(rows.slice(-6).every((r) => rowTargets(r).length === 1)).toBe(true);
    expect(fxBusOf(sourcePatch())).toBeNull();
  });
});
