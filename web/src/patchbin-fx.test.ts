// SPDX-License-Identifier: GPL-3.0-only
// Format 66's FX rack section (patchbin.ts rackRecord, #1214) on the factory master FX bus made into an FX drawer.
import { describe, expect, it } from 'vitest';
import { DEFS, PANEL_BUTTONS } from './modules';
import { addModule, type Patch } from './patch';
import { withFxBus } from './factory-bank';
import { convertLegacyBus } from './fx-drawer';
import { fxBusOf, type FxBus, type FxStageKind } from './fx-legacy';
import { deviceView } from './poly';
import { baseFormat, buttonRecord, BYPASS_BIT, deviceBudget, deviceSection, encodePatch, encodedSize, FLAG_PATTERN_ORIGINS, FLAG_RACK, FORMAT_RACK, GROUP_REC, layout, moduleRecordSize, originRecord, panelBytes, rackRecord, RACK_OUTPUT, rangeList } from './patchbin';
import { subtractiveSaw } from './test-patches';
import { setKind, setSwitches, setTarget, toggleTargets } from './buttons';

/** the factory bus on a patch, made into an FX drawer; `bus`: what it was (its stages are the drawer's effects) */
function converted(p: Patch, omit: readonly FxStageKind[] = []): { p: Patch; bus: FxBus } {
  const built = withFxBus(p, { omit }), bus = fxBusOf(built, DEFS)!;
  return { p: convertLegacyBus(built), bus };
}
function fixture(): { p: Patch; bus: FxBus } {
  const p = subtractiveSaw();
  // This editor-only module precedes every added effect. Wire indices must not be editor IDs or source positions.
  addModule(p, DEFS.scope, 0, 0);
  return converted(p);
}
const recordOf = (p: Patch): number[] => {
  const view = deviceView(p, true);
  return rackRecord(p, view.patch, deviceSection(p, view.patch), view.groups);
};

describe('format 66 FX rack codec', () => {
  it('does not grant FX capabilities from module names', () => {
    const p = subtractiveSaw();
    p.modules.forEach((m) => { m.name = 'Master FX'; });
    expect(recordOf(p)).toEqual([]);
    expect(baseFormat(p)).toBeLessThan(55);
    const bin = encodePatch(p, true);
    expect((bin[6] | bin[7] << 8) & FLAG_RACK).toBe(0);
  });

  it('versions the independent Harmony indicator without fabricating a rack or changing generic Toggles', () => {
    const p = subtractiveSaw();
    const harm = addModule(p, DEFS.harm, 0, 0);
    harm.bypass = true;
    setKind(p, 'lfo', 'bypass');
    setTarget(p, 'lfo', { module: harm.id });
    setSwitches(p, 'lfo', true);
    const bin = encodePatch(p, true);
    expect(bin[1]).toBe(64);   // (format 55's indicator, written as format 64 at least: a Harmonizer, D-1041)
    expect((bin[6] | bin[7] << 8) & FLAG_RACK).toBe(0);
    setTarget(p, 'lfo', { module: p.modules.find(m => m.type === 'osc')!.id });
    expect(baseFormat(p)).toBeLessThan(55);
  });

  it('writes each stage as an effect of the Output drawer: its own device, compiled indices, the bus\'s order', () => {
    const { p, bus } = fixture();
    const dev = deviceView(p, true).patch, devs = deviceSection(p, dev), record = recordOf(p);
    expect(record[0]).toBe(bus.stages.length);
    let at = 1;
    const devices: number[] = [];
    for (const stage of bus.stages) {
      const [device, count] = record.slice(at, at + 2);
      expect(devs[device].asm).toBe(stage.assembly);
      devices.push(device);
      const actual = record.slice(at + 2, at + 2 + count);
      expect(actual.map((i) => dev.modules[i].id)).toEqual(stage.targets);
      expect(actual.some((i, j) => i !== p.modules.findIndex((m) => m.id === stage.targets[j]))).toBe(true);
      at += 2 + count;
    }
    expect(devices.every((d, i) => d === devices[0] + i)).toBe(true);
    expect(record.slice(at)).toEqual([1, RACK_OUTPUT, 0, bus.stages.length]);
    expect(baseFormat(p)).toBe(FORMAT_RACK);
    const bin = encodePatch(p, true);
    expect(bin[1]).toBe(FORMAT_RACK);
    expect((bin[6] | bin[7] << 8) & FLAG_RACK).toBe(FLAG_RACK);
    expect([...bin.subarray(bin.length - record.length)]).toEqual(record);
    expect(encodedSize(p)).toBe(bin.length);
    expect(layout(p).bytes).toBeGreaterThanOrEqual(bin.length);   // (the form written; `need` counts the smallest, D-1026)
    expect(deviceBudget(p).items.find((x) => x.key === 'bytes')!.used).toBe(layout(p).need);
  });

  it.each([
    ['drive', 'chorus', 'delay'],
    ['drive', 'chorus', 'reverb'],
    ['drive', 'delay'],
    ['reverb'],
    ['chorus', 'delay'],
  ] as FxStageKind[][])('writes the present stages\' targets when omitting %j', (...omit) => {
    const { p, bus } = converted(subtractiveSaw(), omit);
    const dev = deviceView(p, true).patch, record = recordOf(p);
    expect(record[0]).toBe(bus.stages.length);
    let at = 1;
    for (const stage of bus.stages) {
      const n = record[at + 1];
      expect(record.slice(at + 2, at + 2 + n).map(i => dev.modules[i].id)).toEqual(stage.targets);
      expect(n).toBe(stage.kind === 'reverb' ? 1 : 2);
      at += 2 + n;
    }
  });

  it('writes the wet Reverb\'s helpers playing without changing saved bypass or control bindings', () => {
    const { p, bus } = converted(subtractiveSaw(), ['drive', 'chorus', 'delay']), stage = bus.stages[0];
    const saved = JSON.stringify(p), bin = encodePatch(p, true), compiled = layout(p);
    const { p: dev, groups, keep } = compiled;
    let at = 8 + GROUP_REC * groups.length + (groups.length ? dev.modules.length : 0) + panelBytes(dev, bin[1]);
    const flags = new Map<number, number>();
    for (const m of dev.modules) {
      flags.set(m.id, bin[at] & BYPASS_BIT);
      at += moduleRecordSize(m, bin[1], false, keep.get(m.id));
    }
    expect(stage.helpers.length).toBeGreaterThan(0);
    for (const id of stage.helpers) expect(flags.get(id)).toBe(0);
    expect(flags.get(stage.targets[0])).toBe(BYPASS_BIT);
    expect(p.modules.find(m => m.id === stage.targets[0])!.params.mix).toBe(1);
    expect(JSON.stringify(p)).toBe(saved);
  });

  it('compiles a Toggle on the whole Reverb effect to its kernel, never a helper', () => {
    const { p, bus } = converted(subtractiveSaw(), ['drive', 'chorus', 'delay']), stage = bus.stages[0];
    for (const b of PANEL_BUTTONS) setKind(p, b, 'gate');
    setKind(p, 'edit', 'bypass');
    setTarget(p, 'edit', { asm: stage.assembly });
    setSwitches(p, 'edit', true);
    expect(toggleTargets(p, 'edit')).toEqual(stage.targets);
    const saved = JSON.stringify(p), dev = deviceView(p, true).patch;
    expect(buttonRecord(p, dev).slice(PANEL_BUTTONS.length)).toEqual([1, dev.modules.findIndex(m => m.id === stage.targets[0])]);
    encodePatch(p, true);
    expect(JSON.stringify(p)).toBe(saved);
  });

  it('places the rack after actual factory origins and before mutable macro ranges', () => {
    const { p } = fixture();
    const track = addModule(p, DEFS.steps, -200, 0);
    track.factoryPatterns = { version: 1, ids: ['12345678'] };
    const target = p.modules.find((m) => m.type === 'osc')!;
    target.map = { p2: [], ...target.map, p1: ['coarse'] };
    target.range = { p1: { coarse: [-12, 12] } };
    const dev = deviceView(p, true).patch, rack = recordOf(p), origins = originRecord(dev);
    expect(origins.length).toBeGreaterThan(0);
    const ranges = rangeList(dev), rangeBytes = 1 + 5 * ranges.length;
    expect(ranges.length).toBeGreaterThan(0);
    const bin = encodePatch(p, true), at = bin.length - rangeBytes - rack.length;
    expect((bin[6] | bin[7] << 8) & FLAG_PATTERN_ORIGINS).toBe(FLAG_PATTERN_ORIGINS);
    expect([...bin.subarray(at - origins.length, at)]).toEqual([...origins]);
    expect([...bin.subarray(at, at + rack.length)]).toEqual(rack);
    expect(bin[at + rack.length]).toBe(ranges.length);
  });

  it('refuses an effect device the compilation dropped rather than emitting unchecked metadata', () => {
    const { p, bus } = fixture(), view = deviceView(p, true);
    const devs = deviceSection(p, view.patch).filter((d) => d.asm !== bus.stages[1].assembly);
    expect(() => rackRecord(p, view.patch, devs, view.groups)).toThrow(/device/);
  });
});
