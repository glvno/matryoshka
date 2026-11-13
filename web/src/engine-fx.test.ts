// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import { Engine } from './engine';
import { fxBusOf, withFxBus, type FxBus, type FxStageKind } from './fx-bus';
import { DEFS, DEVICE_SR, IMPLS } from './modules';
import { addModule, connect, emptyPatch, type Patch } from './patch';
import { setKind, setSwitches, setTarget } from './buttons';

const SR = DEVICE_SR;
interface StereoFxFixture { patch: Patch; left: number; right: number; bus: FxBus }
function stereo(omit: readonly FxStageKind[] = []): StereoFxFixture {
  const source = emptyPatch();
  const left = addModule(source, DEFS.const, 0, 0);
  const right = addModule(source, DEFS.const, 0, 160);
  const output = addModule(source, DEFS.output, 320, 0);
  left.params.value = 0.125;
  right.params.value = -0.0625;
  output.params.level = 1;
  connect(source, DEFS, { module: left.id, port: 'out' }, { module: output.id, port: 'l' });
  connect(source, DEFS, { module: right.id, port: 'out' }, { module: output.id, port: 'r' });
  const patch = withFxBus(source, { omit });
  return { patch, left: left.id, right: right.id, bus: fxBusOf(patch)! };
}
function render(e: Engine, n: number) {
  const l = new Float32Array(n), r = new Float32Array(n);
  e.render(l, r);
  return { l, r };
}
const energy = (a: Float32Array): number => a.reduce((sum, x) => sum + x * x, 0);
const max = (a: Float32Array): number => a.reduce((v, x) => Math.max(v, Math.abs(x)), 0);
function params(f: StereoFxFixture, stage: number, values: Record<string, number>) {
  for (const id of f.bus.stages[stage].targets) Object.assign(f.patch.modules.find(m => m.id === id)!.params, values);
}
function silence(e: Engine, f: StereoFxFixture) {
  e.setParam(f.left, 'value', 0);
  e.setParam(f.right, 'value', 0);
}

describe('recognized master FX engine behavior', () => {
  it.each([false, true])('preserves distinct stereo dry input with the complete bus off (compile=%s)', compile => {
    const f = stereo(), e = new Engine(SR);
    e.load(f.patch, compile);
    expect(e.fxCount()).toBe(4);
    for (let s = 0; s < 4; s++) {
      expect(e.fxKind(s)).toBe(s);
      expect(e.fxOn(s)).toBe(false);
      expect(e.fxDevice(s)).toBe(e.fxDevice(0));
      expect(e.fxPage(s)).toBeGreaterThanOrEqual(0);
    }
    const out = render(e, 513);
    expect([...out.l].every(x => x === 0.125)).toBe(true);
    expect([...out.r].every(x => x === -0.0625)).toBe(true);
  });

  it.each([false, true])('keeps sparse stage identity, pages and single-kernel stereo dry through reloads (compile=%s)', compile => {
    const f = stereo(['drive', 'delay']), e = new Engine(SR), saved = JSON.stringify(f.patch);
    e.load(f.patch, compile);
    expect(e.fxCount()).toBe(2);
    expect([e.fxKind(0), e.fxKind(1), e.fxKind(2)]).toEqual([1, 3, -1]);
    expect(e.fxPage(1)).toBeGreaterThan(e.fxPage(0));
    e.setBypass(f.bus.stages[1].targets[0], false);
    expect(e.fxOn(1)).toBe(true);
    expect(e.fxOn(0)).toBe(false);
    e.arm([`a${f.bus.assembly}`]);
    expect([e.fxKind(0), e.fxKind(1)]).toEqual([1, 3]);
    expect(e.fxOn(1)).toBe(true);
    e.setFx(1, false);
    render(e, SR * 3);
    const dry = render(e, 128);
    expect(dry.l[0] - dry.r[0]).toBeCloseTo(0.1875, 6);
    expect(JSON.stringify(f.patch)).toBe(saved);
  });

  it.each([false, true])('spills only mono wet over untouched stereo dry and admits no new OFF input (compile=%s)', compile => {
    const f = stereo(['drive', 'chorus', 'delay']), e = new Engine(SR);
    params(f, 0, { size: 0.8, mod: 0 });
    const saved = JSON.stringify(f.patch);
    e.load(f.patch, compile);
    expect(e.fxKind(0)).toBe(3);
    expect(f.bus.stages[0].targets).toHaveLength(1);
    // A fully OFF wet kernel must not return its mono input as another dry signal.
    let dry = render(e, 128);
    expect([...dry.l].every(x => x === 0.125)).toBe(true);
    expect([...dry.r].every(x => x === -0.0625)).toBe(true);
    e.setFx(0, true);
    const on = render(e, SR);
    expect(energy(on.l.map(x => x - 0.125))).toBeGreaterThan(1e-8);
    expect(max(on.l.map((x, i) => x - on.r[i] - 0.1875))).toBeLessThan(1e-6);
    e.setFx(0, false);
    const spill = render(e, 4096);
    expect(energy(spill.l.map(x => x - 0.125))).toBeGreaterThan(1e-8);
    expect(max(spill.l.map((x, i) => x - spill.r[i] - 0.1875))).toBeLessThan(1e-6);
    render(e, SR * 12);
    e.setParam(f.left, 'value', 0.25);
    e.setParam(f.right, 'value', -0.125);
    render(e, SR);
    dry = render(e, 128);
    expect(max(dry.l.map(x => x - 0.25))).toBeLessThan(1e-6);
    expect(max(dry.r.map(x => x + 0.125))).toBeLessThan(1e-6);
    expect(JSON.stringify(f.patch)).toBe(saved);
  });

  it('bounds a single frozen wet kernel over live stereo dry without reviving its old tail', () => {
    const f = stereo(['drive', 'chorus', 'delay']), e = new Engine(SR), kernel = f.bus.stages[0].targets[0];
    e.load(f.patch, true);
    e.setFx(0, true);
    render(e, SR);
    e.setParam(kernel, 'freeze', 1);
    e.setFx(0, false);
    expect(energy(render(e, 4096).l.map(x => x - 0.125))).toBeGreaterThan(1e-8);
    render(e, SR * 2);
    const dry = render(e, 128);
    expect([...dry.l].every(x => x === 0.125)).toBe(true);
    expect([...dry.r].every(x => x === -0.0625)).toBe(true);
    expect(e.parameterValues().find(m => m.id === kernel)!.params.freeze).toBe(1);
    expect(e.parameterValues().find(m => m.id === kernel)!.params.mix).toBe(1);
    silence(e, f);
    e.setFx(0, true);
    expect(max(render(e, 4096).l)).toBe(0);
  });

  it.each([false, true])('keeps whole-assembly Toggle tails and arming from bypassing wet helpers (compile=%s)', compile => {
    const f = stereo(['drive', 'chorus', 'delay']), e = new Engine(SR);
    addModule(f.patch, DEFS.fm1, 0, 320);
    setKind(f.patch, 'edit', 'bypass');
    setTarget(f.patch, 'edit', { asm: f.bus.stages[0].assembly });
    setSwitches(f.patch, 'edit', true);
    const saved = JSON.stringify(f.patch);
    e.load(f.patch, compile);
    expect(e.buttonMask & (1 << 4)).not.toBe(0);
    e.setButton(4, false);
    expect(e.fxOn(0)).toBe(true);
    render(e, SR);
    e.setButton(4, true);
    expect(e.fxOn(0)).toBe(false);
    expect(energy(render(e, 4096).l.map(x => x - 0.125))).toBeGreaterThan(1e-8);
    e.arm([`a${f.bus.assembly}`]);
    expect(e.fxOn(0)).toBe(false);
    expect(e.buttonMask & (1 << 4)).not.toBe(0);
    expect(energy(render(e, 4096).l.map(x => x - 0.125))).toBeGreaterThan(1e-8);
    e.setButton(4, false);
    expect(e.fxOn(0)).toBe(true);
    expect(energy(render(e, 4096).l.map(x => x - 0.125))).toBeGreaterThan(1e-8);
    expect(JSON.stringify(f.patch)).toBe(saved);
  });

  it('keeps stage state and recognition through an arming reload without mutating the caller', () => {
    const f = stereo(), e = new Engine(SR);
    const saved = JSON.stringify(f.patch);
    e.load(f.patch);
    e.setFx(0, true);
    e.arm([`a${f.bus.assembly}`]);
    expect(e.fxCount()).toBe(4);
    expect(e.fxOn(0)).toBe(true);
    expect(e.fxOn(1)).toBe(false);
    e.arm([]);
    expect(e.fxCount()).toBe(4);
    expect(e.fxOn(0)).toBe(true);
    expect(JSON.stringify(f.patch)).toBe(saved);
  });

  it('runs all stages together and switches either stereo kernel coherently with a sample-counted dry ramp', () => {
    const f = stereo(), e = new Engine(SR);
    params(f, 0, { drive: 4, level: 0.7 });
    params(f, 2, { time: 25, fb: 0.3, mix: 0.4 });
    e.load(f.patch, true);
    for (let s = 0; s < 4; s++) e.setFx(s, true);
    const active = render(e, SR);
    expect([...active.l, ...active.r].every(Number.isFinite)).toBe(true);
    expect(active.l[active.l.length - 1]).not.toBe(0.125);
    expect(active.l[active.l.length - 1]).not.toBe(active.r[active.r.length - 1]);
    // Keep only Drive active so its final dry identity is not obscured by legitimate spillover.
    for (let s = 1; s < 4; s++) e.setFx(s, false);
    silence(e, f);
    render(e, SR * 8);
    e.setParam(f.left, 'value', 0.125);
    e.setParam(f.right, 'value', -0.0625);
    const before = render(e, 4096);
    e.setBypass(f.bus.stages[0].targets[1], true);
    expect(e.fxOn(0)).toBe(false);
    const first = render(e, 1);
    expect(Math.abs(first.l[0] - before.l[before.l.length - 1])).toBeLessThan(0.002);
    render(e, 1023);
    const dry = render(e, 128);
    expect(dry.l[0]).toBeCloseTo(0.125, 5);
    expect(dry.r[0]).toBeCloseTo(-0.0625, 5);
    e.setBypass(f.bus.stages[0].targets[0], false);
    expect(e.fxOn(0)).toBe(true);
    expect(render(e, 2048).l[2047]).not.toBe(dry.l[0]);
  });

  it('stops feeding an off Delay while allowing its existing echoes to spill into the dry signal', () => {
    const f = stereo(), e = new Engine(SR);
    params(f, 2, { time: 30, fb: 0, mix: 1 });
    e.load(f.patch);
    e.setFx(2, true);
    render(e, 4096);
    e.setFx(2, false);
    expect(e.fxOn(2)).toBe(false);
    const spill = render(e, 1024);
    expect(Math.max(...spill.l)).toBeGreaterThan(0.125);
    render(e, 4096);
    const dry = render(e, 128);
    expect(max(dry.l)).toBeCloseTo(0.125, 6);
    expect(max(dry.r)).toBeCloseTo(0.0625, 6);
  });

  it('does not apply the sustained-tail bound to a naturally decaying Delay', () => {
    const f = stereo(), e = new Engine(SR);
    params(f, 2, { time: 500, fb: 0.9, mix: 1 });
    e.load(f.patch);
    e.setFx(2, true);
    render(e, SR);
    silence(e, f);
    e.setFx(2, false);
    render(e, SR * 2);
    expect(energy(render(e, SR).l)).toBeGreaterThan(0.001);
  });

  it.each([2, 3])('bounds a self-sustaining stage %s without editing its saved controls or resurrecting its tail', stage => {
    const f = stereo(), e = new Engine(SR);
    params(f, stage, stage === 2 ? { time: 30, fb: 0.95, swell: 1, mix: 1 } : { size: 0.8, mix: 1, mod: 0 });
    e.load(f.patch);
    e.setFx(stage, true);
    render(e, SR);
    if (stage === 3) for (const id of f.bus.stages[stage].targets) e.setParam(id, 'freeze', 1);
    silence(e, f);
    e.setFx(stage, false);
    expect(energy(render(e, 4096).l)).toBeGreaterThan(1e-8);
    expect(energy(render(e, SR).l)).toBeGreaterThan(0); // still the two-second fade, not the quiet-window end
    render(e, SR);
    const quiet = render(e, 128);
    expect(max(quiet.l)).toBe(0);
    expect(max(quiet.r)).toBe(0);
    for (const id of f.bus.stages[stage].targets) {
      const values = e.parameterValues().find(m => m.id === id)!.params;
      expect(values[stage === 2 ? 'swell' : 'freeze']).toBe(1);
      if (stage === 2) expect(values.fb).toBe(0.95);
    }
    e.setFx(stage, true);
    const resumed = render(e, 4096);
    expect(max(resumed.l)).toBe(0);
    expect(max(resumed.r)).toBe(0);
  });

  it.each([2, 3])('ends a silent natural OFF tail of stage %s so its kernel stops running', stage => {
    const f = stereo(), e = new Engine(SR), kind = stage === 2 ? 'delay' : 'reverb';
    params(f, stage, stage === 2 ? { time: 290, fb: 0.3, mix: 0.3 } : { size: 0.8, mix: 1, mod: 0 });
    e.load(f.patch);
    e.setFx(stage, true);
    render(e, SR);
    silence(e, f);
    e.setFx(stage, false);
    const process = vi.spyOn(IMPLS[kind], 'process');
    try {
      expect(energy(render(e, SR / 2).l)).toBeGreaterThan(0);
      expect(process).toHaveBeenCalled();
      render(e, SR * 4);
      process.mockClear();
      e.setParam(f.left, 'value', 0.125);
      e.setParam(f.right, 'value', -0.0625);
      const dry = render(e, 4096);
      expect(process).not.toHaveBeenCalled();
      expect([...dry.l].every(x => x === 0.125)).toBe(true);
      expect([...dry.r].every(x => x === -0.0625)).toBe(true);
      e.setFx(stage, true);
      render(e, 128);
      expect(process).toHaveBeenCalled();
    } finally {
      process.mockRestore();
    }
  });

  it('keeps an audible natural Delay tail running however long it lasts', () => {
    const f = stereo(), e = new Engine(SR);
    params(f, 2, { time: 500, fb: 0.95, mix: 1 });
    e.load(f.patch);
    e.setFx(2, true);
    render(e, SR);
    silence(e, f);
    e.setFx(2, false);
    render(e, SR * 6);
    expect(max(render(e, SR).l)).toBeGreaterThan(6 / 65536);
  });

  it('keeps legacy Delay bypass as a state-preserving immediate through path', () => {
    const p = emptyPatch();
    const input = addModule(p, DEFS.const, 0, 0), delay = addModule(p, DEFS.delay, 200, 0), output = addModule(p, DEFS.output, 400, 0);
    input.params.value = 0.125;
    Object.assign(delay.params, { time: 30, mix: 1, fb: 0.8 });
    output.params.level = 1;
    connect(p, DEFS, { module: input.id, port: 'out' }, { module: delay.id, port: 'in' });
    connect(p, DEFS, { module: delay.id, port: 'out' }, { module: output.id, port: 'l' });
    const e = new Engine(SR);
    e.load(p);
    expect(e.fxCount()).toBe(0);
    render(e, 4096);
    e.setParam(input.id, 'value', 0);
    e.setBypass(delay.id, true);
    expect(max(render(e, SR * 3).l)).toBe(0);
    e.setBypass(delay.id, false);
    expect(energy(render(e, 4096).l)).toBeGreaterThan(0.01);
  });
});
