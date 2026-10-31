// SPDX-License-Identifier: GPL-3.0-only
// The A/B flip's plan (#103, ab.ts): the canvas keeps its layout, the sound is the target's, and only value changes go live.
import { describe, expect, it } from 'vitest';
import { flipPlan, type LiveMsg } from './ab';
import { DEFS } from './modules';
import { addModule, type ModuleInst, type Patch } from './patch';
import { encodePatch } from './patchbin';
import { PRESETS } from './presets';

const copy = (p: Patch): Patch => JSON.parse(JSON.stringify(p)) as Patch;
const base = (): Patch => {
  const p = PRESETS['Oracle V']();
  p.view = { zoom: 0.8, x: 10, y: 20 };
  p.octave = -1;
  return p;
};
/** B: a copy of `a` changed by `f`, with every card, frame and the view moved */
const other = (a: Patch, f: (b: Patch) => void): Patch => {
  const b = copy(a);
  for (const m of b.modules) [m.x, m.y] = [m.x + 500, m.y + 300];
  for (const x of b.assemblies ?? []) {
    [x.x, x.y, x.open] = [x.x + 400, x.y + 100, !x.open];
    x.frameSize = { width: 900, height: 700 };
  }
  b.view = { zoom: 1.5, x: 0, y: 0 };
  b.octave = 2;
  b.name = 'the B side';
  f(b);
  return b;
};
const steps = (p: Patch): ModuleInst => p.modules.find((m) => m.type === 'steps')!;
const withParams = (p: Patch): ModuleInst => p.modules.find((m) => m.type !== 'fm1' && DEFS[m.type].params.length > 0)!;
const routed = (p: Patch): ModuleInst => p.modules.find((m) => DEFS[m.type].paramInputs)!;
/** the sound the engines get: the binary patch (the editor-only fields are not in it) */
const sound = (p: Patch): string => Array.from(encodePatch(p, true)).join(',');

/** the layout of `a` is on `p`, and the sound is that of `b` */
function expectFlipped(a: Patch, b: Patch, p: Patch): void {
  const pos = new Map(a.modules.map((m) => [m.id, [m.x, m.y]]));
  for (const m of p.modules) if (pos.has(m.id)) expect([m.x, m.y]).toEqual(pos.get(m.id));
  for (const x of p.assemblies ?? []) {
    const was = a.assemblies?.find((y) => y.id === x.id);
    if (!was) continue;
    expect([x.x, x.y, x.open, x.frameSize, x.size]).toEqual([was.x, was.y, was.open, was.frameSize, was.size]);
  }
  expect([p.view, p.octave, p.name]).toEqual([a.view, a.octave, b.name]);
  expect(sound(p)).toBe(sound(b));
}

describe('A/B flip plan (#103)', () => {
  it('values only: no reload, one live message per difference, the layout stays', () => {
    const a = base();
    const id = withParams(a).id;
    const pd = DEFS[withParams(a).type].params[0];
    const b = other(a, (b) => {
      const m = b.modules.find((x) => x.id === id)!;
      m.params[pd.name] = (m.params[pd.name] ?? pd.default) === pd.max ? pd.min : pd.max;
      b.morphName = 'elsewhere';
    });
    const plan = flipPlan(a, b);
    expect(plan.reload).toBe(false);
    expect(plan.live).toEqual([{ t: 'param', id, name: pd.name, value: b.modules.find((x) => x.id === id)!.params[pd.name] }]);
    expectFlipped(a, b, plan.patch);
    expect(plan.patch.morphName).toBe('elsewhere');
  });

  it('the same patch, moved about: nothing to send', () => {
    const a = base();
    const plan = flipPlan(a, other(a, () => {}));
    expect([plan.reload, plan.live]).toEqual([false, []]);
    expectFlipped(a, other(a, () => {}), plan.patch);
  });

  it('Steps notes, bypass, attenuverters and ranges go live', () => {
    const a = base();
    const s = steps(a).id;
    const r = routed(a);
    const pd = DEFS[r.type].params[0];
    r.att = [0.5, -0.25];
    const b = other(a, (b) => {
      steps(b).notes = [{ at: 0, len: 1, note: 48, vel: 100 }];
      const m = b.modules.find((x) => x.id === r.id)!;
      delete m.att; // (a side without attenuverters: they flip back to [1, 1])
      m.range = { p1: { [pd.name]: [0.25, 0.75] } };
      b.modules.find((x) => x.id === withParams(a).id)!.bypass = true;
    });
    const plan = flipPlan(a, b);
    expect(plan.reload).toBe(false);
    const kinds = (t: LiveMsg['t']): LiveMsg[] => plan.live.filter((m) => m.t === t);
    expect(kinds('track')).toEqual([{ t: 'track', id: s, notes: steps(b).notes }]);
    expect(kinds('att')).toEqual([{ t: 'att', id: r.id, index: 0, value: 1 }, { t: 'att', id: r.id, index: 1, value: 1 }]);
    expect(kinds('range')).toEqual([{ t: 'range', id: r.id, index: 0, name: pd.name, range: [0.25, 0.75] }]);
    expect(kinds('bypass')).toEqual([{ t: 'bypass', id: withParams(a).id, on: true }]);
    expectFlipped(a, b, plan.patch);
  });

  const reloads: [string, (b: Patch) => void][] = [
    ['a parameter route (map)', (b) => { routed(b).map = { p1: [DEFS[routed(b).type].params[0].name], p2: [], k1: [], k2: [], k3: [], k4: [] }; }],
    ['an input route (inputMap)', (b) => { routed(b).inputMap = { x: [DEFS[routed(b).type].params[0].name] }; }],
    ['the morph B side (paramsB)', (b) => { withParams(b).paramsB = { [DEFS[withParams(b).type].params[0].name]: 0.5 }; }],
    ['a Steps track name', (b) => { steps(b).name = 'LEAD'; }],
    ['a Steps pattern 2', (b) => { steps(b).patterns = [{ notes: [{ at: 0, len: 1, note: 50, vel: 90 }] } as never]; }],
    ['the Main panel', (b) => { const m = b.modules.find((x) => x.type === 'fm1')!; m.panel = { ...m.panel, labels: { k1: 'CUT' } }; }],
    ['a poly rack turned off', (b) => { delete b.assemblies!.find((x) => x.poly)!.poly; }],
    ['a poly rack\'s flaws', (b) => { b.assemblies!.find((x) => x.poly)!.poly = { flaws: [{ detune: 10, drift: 0, bright: 0 } as never] }; }],
    ['an assembly label', (b) => { b.assemblies![0].label = 'other'; }],
    ['an assembly\'s exposed params', (b) => { b.assemblies![0].params = []; }],
  ];
  for (const [what, f] of reloads)
    it(`${what}: a full load, the layout stays`, () => {
      const a = base();
      const b = other(a, f);
      const plan = flipPlan(a, b);
      expect([plan.reload, plan.live]).toEqual([true, []]);
      expectFlipped(a, b, plan.patch);
    });

  it('a Drum map row name: a full load', () => {
    const a = PRESETS['808 Kit']();
    const b = copy(a);
    const d = b.modules.find((m) => m.type === 'drummap')!;
    d.names = ['KICK'];
    expect(flipPlan(a, b).reload).toBe(true);
  });

  it('another structure: a full load; what exists on one side only keeps the target\'s place', () => {
    const a = base();
    let added = 0;
    const b = other(a, (b) => { added = addModule(b, DEFS.osc, 1234, 567).id; });
    const plan = flipPlan(a, b);
    expect(plan.reload).toBe(true);
    expectFlipped(a, b, plan.patch);
    const m = plan.patch.modules.find((x) => x.id === added)!;
    expect([m.x, m.y]).toEqual([1234, 567]);
  });

  it('leaves both patches as they were', () => {
    const a = base();
    const b = other(a, (b) => { withParams(b).params.x = 1; });
    const [ja, jb] = [JSON.stringify(a), JSON.stringify(b)];
    flipPlan(a, b);
    expect([JSON.stringify(a), JSON.stringify(b)]).toEqual([ja, jb]);
  });
});
