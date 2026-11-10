// SPDX-License-Identifier: GPL-3.0-only
import { expect, it } from 'vitest';
import { FM1_PRESETS } from './presets';
import { factoryPresets } from './factory-presets';
import { applyPreset, presetsOf } from './device-presets';
import { devicesOf } from './pages';
import { DEFS } from './modules';
import { addModule, validatePatch } from './patch';
import { noteWord } from './track';
import { invalidatePresetPatterns, presetPattern, seedPresetPattern } from './preset-patterns';
import { PRESET_PATTERNS, patternRevision, setPresetPatterns } from './preset-pattern-data';
factoryPresets();
function fixture(name = 'Spokes 6') {
  const p = FM1_PRESETS[name]();
  const d = devicesOf(p, DEFS).find((d) => d.asm !== undefined)!;
  const a = p.assemblies!.find((a) => a.id === d.asm)!;
  const t = p.modules.find((m) => m.id === d.track)!;
  const presets = presetsOf(p, a);
  a.preset = 'Init';
  seedPresetPattern(p, a, presetPattern(presets[0].structure, 'Init')!.id);
  return { p, a, t, presets };
}
it('switches only the untouched drum default, including after save/reload', () => {
  const { p, a, t, presets } = fixture();
  const others = structuredClone(p.modules.filter((m) => m.type === 'steps' && m.id !== t.id));
  const main = structuredClone(p.modules.find((m) => m.type === 'fm1'));
  expect(applyPreset(p, a, presets[1])).toBe(true);
  expect(t.notes!.map(noteWord)).toEqual(presetPattern(presets[1].structure, presets[1].name)!.notes);
  const loaded = validatePatch(JSON.parse(JSON.stringify(p)), DEFS);
  const aa = loaded.assemblies!.find((x) => x.id === a.id)!;
  expect(applyPreset(loaded, aa, presets[2])).toBe(true);
  expect(loaded.modules.find((m) => m.id === t.id)!.notes!.map(noteWord)).toEqual(presetPattern(presets[2].structure, presets[2].name)!.notes);
  expect(loaded.modules.filter((m) => m.type === 'steps' && m.id !== t.id)).toEqual(others);
  expect(loaded.modules.find((m) => m.type === 'fm1')).toEqual(main);
});
it.each(['note', 'velocity', 'chance', 'tie', 'lock', 'length', 'rate', 'swing', 'gate', 'direction'])('preserves a user edit to %s while loading the sound', (edit) => {
  const { p, a, t, presets } = fixture();
  if (edit === 'note') t.notes![0].note++;
  if (edit === 'velocity') t.notes![0].vel--;
  if (edit === 'chance') t.notes![0].chance = 50;
  if (edit === 'tie') t.notes![0].wrap = true;
  if (edit === 'lock') t.locks = [{ at: 0, module: a.params[0].module, param: a.params[0].param, value: 0.1 }];
  if (edit === 'length') t.params.len = 12;
  if (edit === 'rate') t.params.rate = 3;
  if (edit === 'swing') t.params.swing = 60;
  if (edit === 'gate') t.params.gate = 0.5;
  if (edit === 'direction') t.params.dir = 1;
  const before = structuredClone(t);
  expect(applyPreset(p, a, presets[1])).toBe(true);
  expect(a.preset).toBe(presets[1].name);
  expect(t).toEqual(before);
});
it('preserves missing selected patterns and global selection; changes an owned untouched copy only', () => {
  const { p, a, t, presets } = fixture();
  p.modules.find((m) => m.type === 'fm1')!.seq = { pattern: 2 };
  const original = structuredClone(t.notes);
  applyPreset(p, a, presets[1]);
  expect(t.notes).toEqual(original);
  expect(t.patterns).toBeUndefined();
  a.preset = 'Init';
  seedPresetPattern(p, a, presetPattern(presets[0].structure, 'Init')!.id);
  t.patterns = [null, { notes: structuredClone(original) }];
  applyPreset(p, a, presets[1]);
  expect(t.patterns[1]!.notes!.map(noteWord)).toEqual(presetPattern(presets[1].structure, presets[1].name)!.notes);
  expect(t.notes).toEqual(original);
  expect(p.modules.find((m) => m.type === 'fm1')!.seq).toEqual({ pattern: 2 });
});
it('does not attach defaults to user sounds', () => {
  const { p, a, t, presets } = fixture();
  const before = structuredClone(t);
  delete before.factoryPatterns;
  applyPreset(p, a, { ...presets[1], factory: undefined });
  expect(t).toEqual(before);
  a.preset = 'My edited sound';
  delete t.factoryPatterns;
  applyPreset(p, a, presets[2]);
  expect(t).toEqual(before);
});
it.each(['Scrounge', 'Meridian 8', 'Perun 4', 'Spokes 6', 'Verona Drum 1', '808 Kit', '909 Kit', '<7PH'])('%s defaults are distinct and all select', (name) => {
  const { p, a, t, presets } = fixture(name);
  const seen = new Set<string>();
  for (const preset of presets) {
    applyPreset(p, a, preset);
    const notes = presetPattern(preset.structure, preset.name)!.notes;
    expect(t.notes!.map(noteWord)).toEqual(notes);
    expect(seen.has(JSON.stringify(notes))).toBe(false);
    seen.add(JSON.stringify(notes));
  }
});

it('preserves the hybrid bass track and its mixer level when selecting a drum sound', () => {
  const { p, a, t, presets } = fixture('<7PH');
  const bass = structuredClone(p.modules.filter((m) => m.type === 'steps' && m.id !== t.id));
  const mix = p.modules.find((m) => m.type === 'mixer' && p.cables.some((c) => c.from.module === m.id && p.modules.some((o) => o.type === 'output' && o.id === c.to.module)))!;
  const level = mix.params.l4;
  applyPreset(p, a, presets[1]);
  expect(p.modules.filter((m) => m.type === 'steps' && m.id !== t.id)).toEqual(bass);
  expect(mix.params.l4).toBe(level);
});

it('does not recover factory provenance from a USER name or identical values after save/load', () => {
  const { p, a, t, presets } = fixture('808 Kit');
  const original = structuredClone(t.notes);
  applyPreset(p, a, { ...presets[0], factory: undefined });
  expect(t.factoryPatterns).toBeUndefined();
  const loaded = validatePatch(JSON.parse(JSON.stringify(p)), DEFS);
  applyPreset(loaded, loaded.assemblies!.find((x) => x.id === a.id)!, presets[1]);
  expect(loaded.modules.find((m) => m.id === t.id)!.notes).toEqual(original);
});
it('preserves legacy/unknown provenance instead of guessing from a default name', () => {
  const { p, a, t, presets } = fixture('808 Kit');
  delete t.factoryPatterns;
  const original = structuredClone(t.notes);
  applyPreset(p, a, presets[1]);
  expect(t.notes).toEqual(original);
});

it('preserves unknown history when a shipped default receives a new revision', () => {
  const { p, a, t, presets } = fixture('808 Kit');
  const notes = structuredClone(t.notes), catalog = PRESET_PATTERNS;
  const old = presetPattern(presets[0].structure, 'Init')!;
  const changed = { ...old, rate: old.rate + 1 };
  changed.id = patternRevision(changed);
  try {
    setPresetPatterns(catalog.map((x) => x.id === old.id ? changed : x));
    applyPreset(p, a, presets[1]);
    expect(t.notes).toEqual(notes);
    expect(t.factoryPatterns!.ids[0]).toBe(old.id);
  } finally { setPresetPatterns(catalog); }
});
it('preserves an ambiguous actual 808 route and ignores unrelated control wiring', () => {
  const { p, a, t, presets } = fixture('808 Kit');
  const other = addModule(p, DEFS.steps, 0, 0), map = p.modules.find((m) => m.type === 'drummap')!;
  const original = structuredClone(t.notes);
  p.cables.push({ from: { module: other.id, port: 'keys' }, to: { module: map.id, port: 'keys' } });
  applyPreset(p, a, presets[1]);
  expect(t.notes).toEqual(original);
  p.cables.pop();
  const osc = p.modules.find((m) => m.type === 'osc')!;
  p.cables.push({ from: { module: other.id, port: 'vel' }, to: { module: osc.id, port: 'pitch' } });
  applyPreset(p, a, presets[1]);
  expect(t.notes!.map(noteWord)).toEqual(presetPattern(presets[1].structure, presets[1].name)!.notes);
  expect(other.notes).toBeUndefined();
});

it('preserves SAVE then physical USER then browser factory selection after ownership invalidation', () => {
  const { p, a, t, presets } = fixture('808 Kit');
  const original = structuredClone(t.notes);
  invalidatePresetPatterns(p); // SLOT_NOW from SAVE; later device clear cannot be mapped until a new snapshot
  expect(t.factoryPatterns).toBeUndefined();
  const reload = validatePatch(JSON.parse(JSON.stringify(p)), DEFS);
  applyPreset(reload, reload.assemblies!.find((x) => x.id === a.id)!, presets[1]);
  expect(reload.modules.find((m) => m.id === t.id)!.notes).toEqual(original);
  expect(p.modules.find((m) => m.id === t.id)!.notes).toEqual(original);
});
it('preserves a disconnected 808 default with only a Steps velocity cable into oscillator pitch', () => {
  const { p, a, t, presets } = fixture('808 Kit');
  const map = p.modules.find((m) => m.type === 'drummap')!;
  p.cables = p.cables.filter((c) => !(c.from.module === map.id && /^g[1-8]$/.test(c.from.port)));
  const osc = p.modules.find((m) => m.type === 'osc')!;
  p.cables.push({ from: { module: t.id, port: 'vel' }, to: { module: osc.id, port: 'pitch' } });
  const notes = structuredClone(t.notes);
  expect(devicesOf(p, DEFS).find((d) => d.asm === a.id)!.track).toBeUndefined();
  applyPreset(p, a, presets[1]);
  expect(t.notes).toEqual(notes);
});
