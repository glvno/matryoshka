// SPDX-License-Identifier: GPL-3.0-only
// A candidate's Save… (D-1426): device presets when presets hold the difference from its patch, nothing when there is
// none, else a patch, with the reason.
import { beforeEach, describe, expect, it } from 'vitest';
import type { AssemblyInst } from './assembly';
import { saveCandidate } from './candidate-save';
import { capturePreset, currentValues, setFactoryPresets, userPresets } from './device-presets';
import { drawerScope, setRows } from './fx-preset';
import { drawerPresetInfo } from './fx-preset-format';
import { DEFS } from './modules';
import type { Patch } from './patch';
import { encodePatch } from './patchbin';
import { FM1_PRESETS } from './presets';
import { rowOrder } from './structure';

const mem = new Map<string, string>();
const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
beforeEach(() => {
  mem.clear();
  (globalThis as { localStorage?: unknown }).localStorage = storage;
  setFactoryPresets([]);
});

const encode = (p: Patch): Uint8Array => encodePatch(p, true);
const synth = (p: Patch): AssemblyInst => p.assemblies!.find((a) => a.name === 'Monolith D')!;
/** card row `row` of assembly `a` of `p` moved by a step, as the card moves it */
function tweak(p: Patch, a: AssemblyInst, row = 0): void {
  const rows = rowOrder(p, a), values = currentValues(p, a), r = rows[row];
  const pd = DEFS[p.modules.find((x) => x.id === r.module)!.type].params.find((x) => x.name === r.param)!;
  const by = pd.step ?? (pd.max - pd.min) / 10;
  values[row] += values[row] + by <= pd.max ? by : -by;
  setRows(p, rows, values);
}
/** factory Monolith D as opened, and a copy of it to change */
const pair = (): { base: Patch; sound: Patch } => ({ base: FM1_PRESETS['Monolith D'](), sound: FM1_PRESETS['Monolith D']() });

describe('Save… on a candidate (owner 2026-11-24: "if it can be saved as an existing device preset, do that, otherwise patch")', () => {
  it('values only: a new preset of the instrument with its drawer, named after the candidate', () => {
    const { base, sound } = pair();
    tweak(sound, synth(sound));
    const r = saveCandidate(sound, base, 'Monolith D C', encode);
    const scope = drawerScope(sound, synth(sound))!;
    expect(r).toEqual({ kind: 'presets', line: 'Saved preset Monolith D C on Monolith D', made: [expect.objectContaining({ structure: scope.structure, name: 'Monolith D C' })] });
    expect(userPresets().map((x) => [x.structure, x.name, x.values])).toEqual([[scope.structure, 'Monolith D C', capturePreset(sound, synth(sound), '').values]]);
  });
  it('the same tweak saved twice reuses the preset it made', () => {
    const { base, sound } = pair();
    tweak(sound, synth(sound));
    saveCandidate(sound, base, 'Monolith D C', encode);
    expect(saveCandidate(sound, base, 'Monolith D E', encode)).toEqual({ kind: 'presets', line: 'Monolith D is preset Monolith D C, already saved', made: [] });
    expect(userPresets()).toHaveLength(1);
  });
  it('the same as its patch: says so and saves nothing', () => {
    const { base, sound } = pair();
    expect(saveCandidate(sound, base, 'Monolith D B', encode)).toEqual({ kind: 'same', line: 'Monolith D B is the same as Monolith D: nothing saved' });
    expect(userPresets()).toEqual([]);
  });
  it('a drawer effect tweaked: one FXD1 preset of the instrument with its drawer', () => {
    const { base, sound } = pair();
    const scope = drawerScope(sound, synth(sound))!;
    tweak(sound, scope.effects.find((e) => e.name === 'Delay')!);
    const r = saveCandidate(sound, base, 'Monolith D B', encode);
    expect(r.kind).toBe('presets');
    expect(userPresets().map((x) => [x.structure, x.name, !!drawerPresetInfo(x)])).toEqual([[scope.structure, 'Monolith D B', true]]);
  });
  it('a cable changed: a patch, with the reason', () => {
    const { base, sound } = pair();
    sound.cables.pop();
    expect(saveCandidate(sound, base, 'Monolith D B', encode)).toEqual({ kind: 'patch', why: 'its modules, cables or name differ from Monolith D' });
    expect(userPresets()).toEqual([]);
  });
  it('a tempo change takes a patch, alone or with a tweak (no preset holds tempo), and saves no preset', () => {
    const { base, sound } = pair();
    sound.modules.find((m) => m.type === 'fm1')!.params.tempo = 151;
    const patch = { kind: 'patch', why: 'tempo/pattern changes need a patch' };
    expect(saveCandidate(sound, base, 'Monolith D B', encode)).toEqual(patch);
    tweak(sound, synth(sound));
    expect(saveCandidate(sound, base, 'Monolith D B', encode)).toEqual(patch);
    expect(userPresets()).toEqual([]);
  });
  it('a pattern change takes a patch: a track\'s pattern, or the selected pattern', () => {
    const { base, sound } = pair();
    const steps = sound.modules.find((m) => m.type === 'steps')!;
    steps.params.len = steps.params.len === 8 ? 16 : 8;
    expect(saveCandidate(sound, base, 'Monolith D B', encode)).toEqual({ kind: 'patch', why: 'tempo/pattern changes need a patch' });
    const picked = pair().sound;
    picked.modules.find((m) => m.type === 'fm1')!.seq = { pattern: 2 };
    expect(saveCandidate(picked, base, 'Monolith D C', encode)).toEqual({ kind: 'patch', why: 'tempo/pattern changes need a patch' });
  });
});
