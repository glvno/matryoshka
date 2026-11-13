// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { DEFS, PANEL_BUTTONS } from './modules';
import { addModule } from './patch';
import { fxBusOf, withFxBus, type FxStageKind } from './fx-bus';
import { deviceView } from './poly';
import { baseFormat, buttonRecord, BYPASS_BIT, deviceBudget, deviceSection, encodePatch, encodedSize, FLAG_FX_BUS, FLAG_PATTERN_ORIGINS, FX_STAGE_COUNT, fxRecord, GROUP_REC, layout, moduleRecordSize, originRecord, PANEL_BYTES, rangeList } from './patchbin';
import { subtractiveSaw } from './test-patches';
import { setKind, setSwitches, setTarget, toggleTargets } from './buttons';

function fixture() {
  const p = subtractiveSaw();
  // This editor-only module precedes every added effect. Wire indices must not be editor IDs or source positions.
  addModule(p, DEFS.scope, 0, 0);
  return withFxBus(p);
}

describe('optional format55 master FX codec', () => {
  it('does not grant FX capabilities from module names or require format55 for them', () => {
    const p = subtractiveSaw();
    p.modules.forEach((m) => { m.name = 'Master FX'; });
    expect(fxBusOf(p)).toBeNull();
    expect(fxRecord(p, deviceView(p, true).patch)).toEqual([]);
    expect(baseFormat(p)).toBeLessThan(55);
    const bin = encodePatch(p, true);
    expect((bin[6] | bin[7] << 8) & FLAG_FX_BUS).toBe(0);
  });

  it('versions the independent Harmony indicator without fabricating an FX record or changing generic Toggles', () => {
    const p = subtractiveSaw();
    const harm = addModule(p, DEFS.harm, 0, 0);
    harm.bypass = true;
    setKind(p, 'lfo', 'bypass');
    setTarget(p, 'lfo', { module: harm.id });
    setSwitches(p, 'lfo', true);
    const bin = encodePatch(p, true);
    expect(bin[1]).toBe(55);
    expect((bin[6] | bin[7] << 8) & FLAG_FX_BUS).toBe(0);
    setTarget(p, 'lfo', { module: p.modules.find(m => m.type === 'osc')!.id });
    expect(baseFormat(p)).toBeLessThan(55);
  });

  it('writes graph order and compiled indices, with real device and first-page rows', () => {
    const p = fixture(), bus = fxBusOf(p)!;
    expect(bus).not.toBeNull();
    const dev = deviceView(p, true).patch, devs = deviceSection(p, dev), record = fxRecord(p, dev, devs);
    const device = devs.findIndex((d) => d.asm === bus.assembly);
    expect(record[0]).toBe(FX_STAGE_COUNT);
    let at = 1;
    bus.stages.forEach((stage, kind) => {
      const [wireKind, wireDevice, page, count] = record.slice(at, at + 4);
      at += 4;
      expect(wireKind).toBe(kind);
      expect(wireDevice).toBe(device);
      const first = devs[device].pages.findIndex((pg) => pg.rows.some((r) => stage.targets.includes(r.module) || r.also?.some((t) => stage.targets.includes(t.module))));
      expect(page).toBe(first);
      const actual = record.slice(at, at + count);
      expect(actual.map((i) => dev.modules[i].id)).toEqual(stage.targets);
      expect(actual.some((i, j) => i !== p.modules.findIndex((m) => m.id === stage.targets[j]))).toBe(true);
      at += count;
    });
    expect(at).toBe(record.length);
    expect(baseFormat(p)).toBe(55);
    const bin = encodePatch(p, true);
    expect(bin[1]).toBe(55);
    expect((bin[6] | bin[7] << 8) & FLAG_FX_BUS).toBe(FLAG_FX_BUS);
    expect([...bin.subarray(bin.length - record.length)]).toEqual(record);
    expect(encodedSize(p)).toBe(bin.length);
    expect(layout(p).need).toBeGreaterThanOrEqual(bin.length);
    expect(deviceBudget(p).items.find((x) => x.key === 'bytes')!.used).toBe(layout(p).need);
  });

  it.each([
    ['drive', 'chorus', 'delay'],
    ['drive', 'chorus', 'reverb'],
    ['drive', 'delay'],
    ['reverb'],
    ['chorus', 'delay'],
  ] as FxStageKind[][])('serializes present stages by actual kind when omitting %j', (...omit) => {
    const p = withFxBus(subtractiveSaw(), { omit }), bus = fxBusOf(p)!;
    const dev = deviceView(p, true).patch, devs = deviceSection(p, dev), record = fxRecord(p, dev, devs);
    expect(record[0]).toBe(bus.stages.length);
    let at = 1;
    for (const stage of bus.stages) {
      const kind = ['drive', 'chorus', 'delay', 'reverb'].indexOf(stage.kind);
      expect(record[at]).toBe(kind);
      const page = devs[record[at + 1]].pages[record[at + 2]];
      expect(page.rows.some(r => stage.targets.includes(r.module) || r.also?.some(t => stage.targets.includes(t.module)))).toBe(true);
      const n = record[at + 3];
      expect(record.slice(at + 4, at + 4 + n).map(i => dev.modules[i].id)).toEqual(stage.targets);
      expect(n).toBe(stage.kind === 'reverb' ? 1 : 2);
      at += 4 + n;
    }
    expect(at).toBe(record.length);
    const bin = encodePatch(p, true);
    expect([...bin.subarray(bin.length - record.length)]).toEqual(record);
  });

  it('activates mono-wet helpers only in compiled format55 without changing saved bypass or control bindings', () => {
    const p = withFxBus(subtractiveSaw(), { omit: ['drive', 'chorus', 'delay'] }), stage = fxBusOf(p)!.stages[0];
    const saved = JSON.stringify(p), bin = encodePatch(p, true), compiled = layout(p);
    const { p: dev, groups, keep } = compiled;
    let at = 8 + GROUP_REC * groups.length + (groups.length ? dev.modules.length : 0) + PANEL_BYTES;
    const flags = new Map<number, number>();
    for (const m of dev.modules) {
      flags.set(m.id, bin[at] & BYPASS_BIT);
      at += moduleRecordSize(m, bin[1], false, keep.get(m.id));
    }
    expect(stage.helpers.length).toBeGreaterThan(0);
    for (const id of stage.helpers) expect(flags.get(id)).toBe(0);
    expect(flags.get(stage.targets[0])).toBe(BYPASS_BIT);
    const kernel = p.modules.find(m => m.id === stage.targets[0])!;
    expect(kernel.params.mix).toBe(1);
    const root = p.assemblies!.find(a => a.id === fxBusOf(p)!.assembly)!;
    const mix = root.params.find(r => r.label.toLowerCase() === 'mix' && stage.helpers.includes(r.module));
    expect(mix).toBeDefined();
    expect(mix!.param).toBe('value');
    expect(stage.targets).not.toContain(mix!.module);
    expect(JSON.stringify(p)).toBe(saved);
  });

  it('compiles an ordinary whole-Reverb-assembly Toggle to its DSP kernel without wet-return helpers', () => {
    const p = withFxBus(subtractiveSaw(), { omit: ['drive', 'chorus', 'delay'] }), stage = fxBusOf(p)!.stages[0];
    for (const b of PANEL_BUTTONS) setKind(p, b, 'gate');
    setKind(p, 'edit', 'bypass');
    setTarget(p, 'edit', { asm: stage.assembly });
    setSwitches(p, 'edit', true);
    expect(toggleTargets(p, 'edit')).toEqual(expect.arrayContaining([...stage.targets, ...stage.helpers]));
    const saved = JSON.stringify(p), dev = deviceView(p, true).patch;
    const record = buttonRecord(p, dev);
    expect(record.slice(PANEL_BUTTONS.length)).toEqual([1, dev.modules.findIndex(m => m.id === stage.targets[0])]);
    encodePatch(p, true);
    expect(JSON.stringify(p)).toBe(saved);
  });

  it('places FX after actual factory origins and before mutable macro ranges', () => {
    const p = fixture();
    const track = addModule(p, DEFS.steps, -200, 0);
    track.factoryPatterns = { version: 1, ids: ['12345678'] };
    const target = p.modules.find((m) => m.type === 'osc')!;
    target.map = { p2: [], ...target.map, p1: ['coarse'] };
    target.range = { p1: { coarse: [-12, 12] } };
    const dev = deviceView(p, true).patch, fx = fxRecord(p, dev), origins = originRecord(dev);
    expect(origins.length).toBeGreaterThan(0);
    const ranges = rangeList(dev), rangeBytes = 1 + 5 * ranges.length;
    expect(ranges.length).toBeGreaterThan(0);
    const bin = encodePatch(p, true), at = bin.length - rangeBytes - fx.length;
    expect((bin[6] | bin[7] << 8) & FLAG_PATTERN_ORIGINS).toBe(FLAG_PATTERN_ORIGINS);
    expect([...bin.subarray(at - origins.length, at)]).toEqual([...origins]);
    expect([...bin.subarray(at, at + fx.length)]).toEqual(fx);
    expect(bin[at + fx.length]).toBe(ranges.length);
  });

  it('rejects targets or device pages removed by compilation rather than emitting unchecked metadata', () => {
    const p = fixture(), bus = fxBusOf(p)!, dev = deviceView(p, true).patch;
    const id = bus.stages[0].targets[0];
    const dropped = { ...dev, modules: dev.modules.filter((m) => m.id !== id) };
    expect(() => fxRecord(p, dropped)).toThrow(/target/);
    const wrongType = structuredClone(dev);
    wrongType.modules.find((m) => m.id === id)!.type = 'const';
    expect(() => fxRecord(p, wrongType)).toThrow(/target/);
    const devs = deviceSection(p, dev);
    expect(() => fxRecord(p, dev, devs.filter((d) => d.asm !== bus.assembly))).toThrow(/device/);
    const noRows = structuredClone(devs);
    noRows.find((d) => d.asm === bus.assembly)!.pages = [];
    expect(() => fxRecord(p, dev, noRows)).toThrow(/page/);
  });
});
