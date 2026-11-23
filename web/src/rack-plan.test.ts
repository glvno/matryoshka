// SPDX-License-Identifier: GPL-3.0-only
// The FX rack as the binary holds it and both engines run it (format 66, #1214): rack-plan.ts and patchbin.ts rackRecord.
import { describe, expect, it } from 'vitest';
import { allModules, assemblyById, chainHelpers, exposePort, makeAssembly, promote } from './assembly';
import { Engine } from './engine';
import { addDrawer, insertEffect, wrapEffect } from './fx-drawer';
import { DEFS, DEVICE_SR } from './modules';
import { addModule, connect, emptyPatch, type Patch } from './patch';
import { deviceSection, encodePatch, FLAG_RACK, FORMAT_RACK, rackRecord, RACK_OUTPUT } from './patchbin';
import { deviceView } from './poly';
import { FX_RUNS, FX_TARGETS_MAX, rackPlan } from './rack-plan';

/** an instrument of two Constants (left 0.125, right -0.0625) on the Output's l and r, with a row so it is a device */
function synth(): { p: Patch; inst: number; left: number; right: number } {
  const p = emptyPatch();
  const left = addModule(p, DEFS.const, 0, 0), right = addModule(p, DEFS.const, 0, 160), out = addModule(p, DEFS.output, 640, 0);
  left.params.value = 0.125;
  right.params.value = -0.0625;
  out.params.level = 1;
  connect(p, DEFS, { module: left.id, port: 'out' }, { module: out.id, port: 'l' });
  connect(p, DEFS, { module: right.id, port: 'out' }, { module: out.id, port: 'r' });
  const a = makeAssembly(p, [left.id, right.id], 'Synth');
  exposePort(a, 'out', left.id, 'out');
  exposePort(a, 'out', right.id, 'out');
  promote(a, left.id, 'value', p);
  return { p, inst: a.id, left: left.id, right: right.id };
}

/** a wet effect around a chain of `n` Drives (one copy: n targets) */
function drives(p: Patch, n: number): number {
  const ids = Array.from({ length: n }, (_, i) => addModule(p, DEFS.shape, 300 + 100 * i, 600).id);
  for (let i = 1; i < n; i++) connect(p, DEFS, { module: ids[i - 1], port: 'out' }, { module: ids[i], port: 'in' });
  const a = makeAssembly(p, ids, `Drives ${n}`);
  exposePort(a, 'in', ids[0], 'in');
  exposePort(a, 'out', ids[n - 1], 'out');
  promote(a, ids[0], 'drive', p);
  return wrapEffect(p, { assembly: a.id }, 'wet').id;
}

const record = (p: Patch): number[] => {
  const view = deviceView(p, true);
  return rackRecord(p, view.patch, deviceSection(p, view.patch), view.groups);
};

describe('the FX rack (format 66)', () => {
  it('lists an instrument drawer and the Output drawer, effects in device order, helpers never targets', () => {
    const { p, inst } = synth();
    const d = addDrawer(p, inst);
    const phaser = insertEffect(p, d, { type: 'phaser' });
    const chorus = insertEffect(p, d, { type: 'chorus' });
    const reverb = insertEffect(p, d, { type: 'reverb' });
    const delay = insertEffect(p, addDrawer(p, 'output'), { type: 'delay' });
    const plan = rackPlan(p)!;
    expect(plan.effects.map((e) => e.asm)).toEqual([phaser.id, chorus.id, reverb.id, delay.id]);
    const helpers = chainHelpers(p);
    for (const e of plan.effects) {
      const a = assemblyById(p, e.asm)!;
      expect(e.targets).toEqual(allModules(p, a).filter((id) => !helpers.has(id)));
    }
    expect(plan.effects.map((e) => e.targets.map((id) => p.modules.find((m) => m.id === id)!.type)))
      .toEqual([['phaser', 'phaser'], ['chorus', 'chorus'], ['reverb'], ['delay', 'delay']]);
    expect(plan.drawers).toEqual([{ owner: inst, effects: [phaser.id, chorus.id, reverb.id] }, { owner: 'output', effects: [delay.id] }]);

    const view = deviceView(p, true), devs = deviceSection(p, view.patch);
    const index = new Map(view.patch.modules.map((m, i) => [m.id, i]));
    const dev = (asm: number): number => devs.findIndex((x) => x.asm === asm);
    expect(dev(phaser.id)).toBe(dev(inst) + 1);
    expect(record(p)).toEqual([
      4,
      ...plan.effects.flatMap((e) => [dev(e.asm), e.targets.length, ...e.targets.map((id) => index.get(id)!)]),
      2, dev(inst), 0, 3, RACK_OUTPUT, 3, 1,
    ]);
  });

  it('writes format 66 with flag bit 14 and the helpers playing only for a patch with a rack', () => {
    const { p, inst } = synth();
    expect(encodePatch(p)[1]).toBeLessThan(FORMAT_RACK);
    const d = addDrawer(p, inst);
    expect(rackPlan(p)).not.toBeNull();   // (an empty drawer alone is a rack: the FM-1 knows the instrument has one)
    const reverb = insertEffect(p, d, { type: 'reverb' });
    for (const id of allModules(p, reverb)) p.modules.find((m) => m.id === id)!.bypass = true;
    const bin = encodePatch(p);
    expect(bin[1]).toBe(FORMAT_RACK);
    expect((bin[6] | bin[7] << 8) & FLAG_RACK).toBe(FLAG_RACK);
    // the helpers' records say playing whatever their saved flag; the kernel's says bypassed
    const helpers = chainHelpers(p);
    const playing = structuredClone(p);
    for (const m of playing.modules) if (helpers.has(m.id)) delete m.bypass;
    expect(encodePatch(playing)).toEqual(bin);
    const kernelOn = structuredClone(p);
    delete kernelOn.modules.find((m) => m.type === 'reverb')!.bypass;
    expect(encodePatch(kernelOn)).not.toEqual(bin);
  });

  it('gives an effect past eight targets none: it switches by ordinary bypass, in both engines', () => {
    const { p, inst } = synth();
    const d = addDrawer(p, inst);
    const big = insertEffect(p, d, { assembly: drives(p, FX_TARGETS_MAX + 1) });
    const fits = insertEffect(p, d, { assembly: drives(p, FX_TARGETS_MAX) });
    const plan = rackPlan(p)!;
    expect(plan.effects.find((e) => e.asm === big.id)!.targets).toEqual([]);
    expect(plan.effects.find((e) => e.asm === fits.id)!.targets).toHaveLength(FX_TARGETS_MAX);
    const e = new Engine(DEVICE_SR);
    e.load(p, true);
    expect(e.fxCount()).toBe(2);
  });

  it('runs at most FX_RUNS targets in all, in device order', () => {
    const { p, inst } = synth();
    const d = addDrawer(p, inst);
    const ids = Array.from({ length: FX_RUNS / FX_TARGETS_MAX + 1 }, () => insertEffect(p, d, { assembly: drives(p, FX_TARGETS_MAX) }).id);
    const plan = rackPlan(p)!;
    expect(plan.effects.map((e) => e.asm)).toEqual(ids);
    expect(plan.effects.map((e) => e.targets.length)).toEqual([...ids.slice(0, -1).map(() => FX_TARGETS_MAX), 0]);
  });

  it('switches a drawer effect whole in the editor engine: off ramps to exact dry, a helper stays playing', () => {
    const { p, inst } = synth();
    const d = addDrawer(p, inst);
    insertEffect(p, d, { type: 'phaser' });
    insertEffect(p, d, { type: 'chorus' });
    insertEffect(p, d, { type: 'reverb' });
    const e = new Engine(DEVICE_SR);
    e.load(p);
    expect(e.fxCount()).toBe(3);
    for (let i = 0; i < 3; i++) expect(e.fxOn(i)).toBe(true);
    const l = new Float32Array(DEVICE_SR), r = new Float32Array(DEVICE_SR);
    e.render(l, r);
    expect(l.some((x) => Math.abs(x - 0.125) > 1e-4)).toBe(true);
    for (let i = 0; i < 3; i++) e.setFx(i, false);
    for (const id of chainHelpers(p)) e.setBypass(id, true);   // (runtime-owned: ignored)
    for (let k = 0; k < 14; k++) e.render(l, r);
    const a = new Float32Array(128), b = new Float32Array(128);
    e.render(a, b);
    expect(Math.max(...a.map((x) => Math.abs(x - 0.125)))).toBeLessThan(1e-6);
    expect(Math.max(...b.map((x) => Math.abs(x + 0.0625)))).toBeLessThan(1e-6);
  });
});
