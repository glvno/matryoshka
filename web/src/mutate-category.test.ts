// SPDX-License-Identifier: GPL-3.0-only
// Mutate with a category (#1033, D-994, D-995): roles found from the wiring on every factory patch, every role row inside
// the category's range after a Mutate, Randomize, candidate or breed, Any unchanged, held rows and locks kept, the timbre
// leaning the category's way.
import { describe, expect, it } from 'vitest';
import { DEFS } from './modules';
import { BRIGHT, breedPatch, cardScope, CATEGORIES, heldRows, isLocked, mutatePatch, PROFILES, roleRows, roleSpan, setParamLock, spanValues, type MutateOptions, type MutateScope } from './mutate';
import { defaultParams, paramUnit, type Cable, type ModuleInst, type Patch } from './patch';
import { FM1_PRESETS } from './presets';

const mod = (id: number, type: string, params: Record<string, number> = {}): ModuleInst =>
  ({ id, type, x: 0, y: 0, params: { ...defaultParams(DEFS[type]), ...params }, ...(DEFS[type].paramInputs ? { att: [1, 1], map: { p1: [], p2: [] } } : {}) }) as ModuleInst;
const cable = (from: number, fp: string, to: number, tp: string): Cable => ({ from: { module: from, port: fp }, to: { module: to, port: tp } });
const seeded = (seed: number): (() => number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const everything = (p: Patch): MutateScope => ({ modules: p.modules.map((m) => m.id), assemblies: (p.assemblies ?? []).map((a) => a.id) });
const categories = CATEGORIES.filter((c) => c !== 'any');

/** a voice: an oscillator through a filter and a VCA to the Output, an ADSR on each, a slew limiter on the pitch */
function voice(): Patch {
  const modules = [mod(1, 'alloc'), mod(2, 'glide'), mod(3, 'osc'), mod(4, 'filter', { cutoff: 2000 }), mod(5, 'vca'), mod(6, 'output'), mod(7, 'adsr'), mod(8, 'adsr'), mod(9, 'lfo'), mod(10, 'vca'), mod(11, 'adsr')];
  const cables = [cable(1, 'pitch', 2, 'in'), cable(2, 'out', 3, 'pitch'), cable(3, 'out', 4, 'in'), cable(4, 'lp24', 5, 'in'), cable(5, 'out', 6, 'l'),
    cable(1, 'gate', 7, 'gate'), cable(1, 'gate', 8, 'gate'), cable(7, 'env', 5, 'cv'), cable(8, 'env', 4, 'cv'),
    // an LFO whose depth an envelope raises (a delayed vibrato): that envelope shapes the LFO, not the sound
    cable(9, 'out', 10, 'in'), cable(11, 'env', 10, 'cv'), cable(10, 'out', 4, 'cv')];
  return { version: 2, name: 'v', modules, cables } as Patch;
}

describe('roles (#1033)', () => {
  it('finds the loudness and tone envelopes, the cutoff on the way and the glide on the pitch', () => {
    const p = voice();
    const roles = roleRows(p, DEFS);
    const at = (id: number, param: string): string | undefined => roles.of(p.modules.find((m) => m.id === id)!, param)?.role;
    expect([at(7, 'a'), at(7, 'd'), at(7, 's'), at(7, 'r')]).toEqual(['amp-a', 'amp-d', 'amp-s', 'amp-r']);
    expect([at(8, 'a'), at(8, 's')]).toEqual(['tone-a', 'tone-s']);
    expect(at(11, 'a')).toBeUndefined();
    expect([at(4, 'cutoff'), at(4, 'res'), at(2, 'time')]).toEqual(['cutoff', undefined, 'glide']);
    expect(roles.holds(p.modules[6], 'long') && roles.holds(p.modules[6], 'ads') && roles.holds(p.modules[1], 'fall')).toBe(true);
    // an ADSR in "long" counts its times 2.4 times longer
    expect(roles.of({ ...p.modules[6], params: { ...p.modules[6].params, long: 1 } }, 'a')).toBeDefined();
  });

  it('follows only the input a Selector picks, and its position from a fixed Selector', () => {
    const p = voice();
    // the loudness envelope or a plain gate into the VCA, as an engine's VCA mode switch does
    p.modules.push(mod(12, 'select', { pos: 2, count: 2 }));
    p.cables = p.cables.filter((c) => !(c.from.module === 7 && c.to.module === 5));
    p.cables.push(cable(7, 'env', 12, 'in1'), cable(1, 'gate', 12, 'in2'), cable(12, 'out', 5, 'cv'));
    expect(roleRows(p, DEFS).envelopes.get(7)).toBeUndefined();
    p.modules.find((m) => m.id === 12)!.params.pos = 1;
    expect(roleRows(p, DEFS).envelopes.get(7)).toBe('amp');
    // a fixed Selector's value moves the position (Algo Four's algorithm)
    p.modules.push(mod(13, 'select', { pos: 2, count: 2, v1: 0, v2: 1 }));
    p.cables.push(cable(13, 'out', 12, 'pos'));
    expect(roleRows(p, DEFS).envelopes.get(7)).toBeUndefined();
  });

  it('on every factory patch: the envelopes each engine gives a role', () => {
    const found: Record<string, string> = {};
    for (const name of Object.keys(FM1_PRESETS)) {
      const jobs = [...roleRows(FM1_PRESETS[name](), DEFS).envelopes.values()];
      found[name] = `${jobs.filter((j) => j === 'amp').length} amp, ${jobs.filter((j) => j === 'tone').length} tone`;
    }
    expect(found).toEqual({
      'Monolith D': '1 amp, 1 tone', 'Oracle V': '1 amp, 1 tone', 'Silver Box': '2 amp, 1 tone', 'Hera 6': '1 amp, 0 tone', 'Sallen 20': '1 amp, 0 tone',
      'Expander S': '1 amp, 1 tone', 'Algo Four': '2 amp, 2 tone', Canvas: '1 amp, 0 tone', Wanderer: '1 amp, 0 tone', 'Briefcase 3': '1 amp, 0 tone',
      'Io 4': '1 amp, 1 tone', 'Vernon 100': '1 amp, 1 tone', '8 Lire': '8 amp, 0 tone', 'Elvira 2': '4 amp, 0 tone', Scrounge: '7 amp, 0 tone',
      'Meridian 8': '8 amp, 0 tone', '808 Kit': '10 amp, 0 tone', '909 Kit': '15 amp, 0 tone', 'Cassia 1': '2 amp, 2 tone', 'Verona Drum 1': '18 amp, 0 tone',
      'Shush 101': '1 amp, 0 tone',
    });
  });

  it('reads a Rate Env\'s rates as times, shorter as the rate rises', () => {
    const p = voice();
    p.modules[6] = mod(7, 'rateenv');
    const roles = roleRows(p, DEFS), m = p.modules[6];
    const rr = roles.of(m, 'rr')!, pd = DEFS.rateenv.params.find((q) => q.name === 'rr')!;
    expect(rr.measure(1)).toBeGreaterThan(rr.measure(14));
    const span = spanValues(pd, rr.measure, PROFILES.pad.amp.r)!;
    for (let v = 0; v <= 15; v++) {
      const x = rr.measure(v), inside = x >= PROFILES.pad.amp.r[0] && x <= PROFILES.pad.amp.r[1];
      expect(inside, `rr ${v}: ${x} s`).toBe(v >= span[0] && v <= span[1]);
    }
  });
});

/** the role rows (roles as `p` has them; those in `only`, by `module:param`) of `out` outside the category's range, with
 *  the cutoff's range from `p` */
function outside(p: Patch, out: Patch, category: (typeof categories)[number], only?: Set<string>): string[] {
  const roles = roleRows(p, DEFS), held = heldRows(p), bad: string[] = [];
  for (const m of p.modules) for (const pd of DEFS[m.type].params) {
    const r = roles.of(m, pd.name);
    if (!r || held.has(`${m.id}:${pd.name}`) || isLocked(p, m, pd.name) || (only && !only.has(`${m.id}:${pd.name}`))) continue;
    const span = roleSpan(PROFILES[category], r.role, m.params[pd.name] ?? pd.default);
    // (a macro range in use that leaves the category's range out holds the row at its nearest end instead)
    const macro = (['p1', 'p2'] as const).map((pin) => (m.map?.[pin]?.includes(pd.name) ? m.range?.[pin]?.[pd.name] : undefined)).filter((x) => x);
    if (macro.some((x) => [x![0], x![1]].every((v) => r.measure(v) < span[0]) || [x![0], x![1]].every((v) => r.measure(v) > span[1]))) continue;
    const x = r.measure(out.modules.find((q) => q.id === m.id)!.params[pd.name] ?? pd.default);
    if (!(x >= span[0] - 1e-6 && x <= span[1] + 1e-6)) bad.push(`${m.type}#${m.id}.${pd.name} (${r.role}) ${x} not in ${span}`);
  }
  return bad;
}

describe('a category Mutate (#1033)', () => {
  it('puts every role row in its range on every factory patch: Mutate, Randomize, a candidate, a bred one', () => {
    for (const name of Object.keys(FM1_PRESETS)) {
      const p = FM1_PRESETS[name]();
      const rnd = seeded(name.length);
      for (const category of categories) {
        const opts: MutateOptions = { category, anchor: p };
        for (const [mode, amount] of [['mutate', 0.1], ['randomize', 0], ['mutate', 0.5]] as const)
          expect(outside(p, mutatePatch(p, everything(p), mode, amount, DEFS, rnd, opts).patch, category), `${name} ${category} ${mode}`).toEqual([]);
        // (a candidate moves the canvas's cards: only the role rows on them)
        const cand = mutatePatch(p, cardScope(p), 'mutate', 0.25, DEFS, rnd, opts).patch;
        const scope = cardScope(p);
        const onCards = new Set([
          ...scope.modules.flatMap((id) => DEFS[p.modules.find((m) => m.id === id)!.type].params.map((pd) => `${id}:${pd.name}`)),
          ...scope.assemblies.flatMap((id) => p.assemblies!.find((a) => a.id === id)!.params.flatMap((r) => [r, ...(r.also ?? [])]).map((t) => `${t.module}:${t.param}`)),
        ]);
        expect(outside(p, cand, category, onCards), `${name} ${category} candidate`).toEqual([]);
        // (keeps from anywhere: the rows that decide the envelopes' roles stay as on screen, but a keep's Selector can take
        // a filter off the sound's way, and the bred patch's roles are what its Mutate steers: the rows with a role in both;
        // at amount 0 that Mutate flips no switch, so the result's roles are the bred patch's)
        const keeps = [0, 1].map(() => mutatePatch(p, everything(p), 'randomize', 0, DEFS, rnd).patch);
        const bred = breedPatch(p, keeps, everything(p), 0, DEFS, rnd, opts).patch, still = roleRows(bred, DEFS);
        const both = new Set(bred.modules.flatMap((m) => DEFS[m.type].params.filter((pd) => still.of(m, pd.name)).map((pd) => `${m.id}:${pd.name}`)));
        expect(outside(p, bred, category, both), `${name} ${category} bred`).toEqual([]);
      }
    }
  });

  it('is Mutate as before with Any', () => {
    for (const name of Object.keys(FM1_PRESETS)) {
      const p = FM1_PRESETS[name]();
      for (const mode of ['mutate', 'randomize'] as const) {
        const a = mutatePatch(p, everything(p), mode, 0.25, DEFS, seeded(9), {});
        const b = mutatePatch(p, everything(p), mode, 0.25, DEFS, seeded(9), { category: 'any', anchor: p });
        expect(b, `${name} ${mode}`).toEqual(a);
      }
    }
  });

  it('keeps held rows, locked rows and the switches the roles hold', () => {
    for (const name of Object.keys(FM1_PRESETS)) {
      const p = FM1_PRESETS[name]();
      const roles = roleRows(p, DEFS), held = heldRows(p);
      const env = [...roles.envelopes.keys()][0];
      if (env !== undefined) for (const pd of DEFS[p.modules.find((m) => m.id === env)!.type].params) setParamLock(p.modules.find((m) => m.id === env)!, pd.name, true);
      const rnd = seeded(name.length + 1);
      for (const category of categories) {
        const out = mutatePatch(p, everything(p), 'randomize', 0, DEFS, rnd, { category }).patch;
        for (const m of p.modules) {
          const after = out.modules.find((x) => x.id === m.id)!;
          for (const pd of DEFS[m.type].params) {
            if (!held.has(`${m.id}:${pd.name}`) && !roles.holds(m, pd.name) && m.id !== env) continue;
            expect(after.params[pd.name], `${name} ${category} ${m.type}#${m.id}.${pd.name}`).toBe(m.params[pd.name]);
          }
        }
      }
    }
  });

  it('moves a role row already inside its range within it, by up to the amount', () => {
    const p = voice();
    p.modules[6].params.a = 1;   // (a pad's attack already)
    for (const q of DEFS.adsr.params) if (q.name !== 'a') setParamLock(p.modules[6], q.name, true);
    const pd = DEFS.adsr.params.find((q) => q.name === 'a')!;
    const rnd = seeded(4);
    for (let i = 0; i < 50; i++) {
      const a = mutatePatch(p, { modules: [7], assemblies: [] }, 'mutate', 0.1, DEFS, rnd, { category: 'pad' }).patch.modules[6].params.a;
      expect(a).toBeGreaterThanOrEqual(0.3);
      expect(a).toBeLessThanOrEqual(2.5);
      expect(Math.abs(paramUnit(pd, a) - paramUnit(pd, 1))).toBeLessThanOrEqual(0.1 + 1e-3);
    }
    // outside it: into it, whatever the amount
    p.modules[6].params.a = 0.005;
    expect(mutatePatch(p, { modules: [7], assemblies: [] }, 'mutate', 0.05, DEFS, rnd, { category: 'pad' }).patch.modules[6].params.a).toBeGreaterThanOrEqual(0.3);
  });

  it('measures the cutoff from the anchor: a pad goes no brighter than the patch before the run', () => {
    const p = voice();
    const rnd = seeded(5);
    let q = p;
    for (let i = 0; i < 20; i++) q = mutatePatch(q, everything(q), 'mutate', 0.25, DEFS, rnd, { category: 'pad', anchor: p }).patch;
    const cutoff = q.modules.find((m) => m.id === 4)!.params.cutoff;
    expect(cutoff).toBeLessThanOrEqual(2000 + 1e-6);
    expect(cutoff).toBeGreaterThanOrEqual(2000 * 2 ** -1.5 - 1e-6);
  });

  it('leans the timbre: a pad\'s drive lower, a lead\'s higher, on average', () => {
    const p = { version: 2, name: 's', modules: [mod(1, 'shape', { drive: 4 })], cables: [] } as unknown as Patch;
    expect(BRIGHT.shape.drive).toBe(1);
    const pd = DEFS.shape.params.find((q) => q.name === 'drive')!;
    const mean = (category: 'pad' | 'lead' | 'any'): number => {
      const rnd = seeded(6);
      let sum = 0;
      for (let i = 0; i < 400; i++) sum += paramUnit(pd, mutatePatch(p, everything(p), 'mutate', 0.25, DEFS, rnd, { category, share: 1 }).patch.modules[0].params.drive);
      return sum / 400;
    };
    expect(mean('pad')).toBeLessThan(mean('any') - 0.02);
    expect(mean('lead')).toBeGreaterThan(mean('any') + 0.02);
  });
});
