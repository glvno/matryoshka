// SPDX-License-Identifier: GPL-3.0-only
// Four saved-patch experiments, each paired with its unchanged dry sound and phrase.
// Run: vite-node scripts/preset-effects-auditions.ts OUT_DIR
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { FM1_PRESETS } from '../src/presets';
import { factoryPresets } from '../src/factory-presets';
import { applyPreset, presetsOf } from '../src/device-presets';
import { devicesOf } from '../src/pages';
import { addModule, validatePatch, type Patch } from '../src/patch';
import { DEFS, DEVICE_SR } from '../src/modules';
import { deviceBudget } from '../src/patchbin';
import { integratedLoudness } from '../src/loudness';
import { wire } from './factory-build';
import { renderAudition, auditionWav } from './audition-render';

type Effect = { type: 'shape' | 'filter' | 'delay' | 'reverb' | 'chorus'; params: Record<string, number>; label: string };
const studies: { preset: string; treatment: string; effects: Effect[] }[] = [
  { preset: 'Fat Bass', treatment: 'Warm drive', effects: [
    { type: 'shape', label: 'Soft drive', params: { drive: 1.5, mode: 0, level: 0.8 } },
    { type: 'filter', label: 'Drive tone', params: { cutoff: 4200, res: 0 } },
  ] },
  { preset: 'Glide Lead', treatment: 'Tape echo', effects: [
    { type: 'delay', label: 'Tape echo', params: { time: 280, length: 500, fb: 0.28, mix: 0.22, tape: 1, wow: 0.08 } },
  ] },
  { preset: 'Rhea Plucked Bass', treatment: 'Small room', effects: [
    { type: 'reverb', label: 'Small room', params: { size: 0.25, damp: 0.65, mix: 0.14, pre: 8, mod: 0.1 } },
  ] },
  { preset: 'Pink Wind', treatment: 'Drifting space', effects: [
    { type: 'delay', label: 'Drifting echo', params: { time: 360, length: 500, fb: 0.42, mix: 0.3, tape: 1, wow: 0.15 } },
    { type: 'reverb', label: 'Dark space', params: { size: 0.68, damp: 0.7, mix: 0.3, pre: 15, mod: 0.2 } },
    { type: 'chorus', label: 'Stereo movement', params: { rate: 0.16, depth: 0.25, mix: 0.25 } },
  ] },
];

function addEffects(p: Patch, effects: Effect[]): void {
  const output = p.modules.find((m) => m.type === 'output')!;
  const feeds = p.cables.filter((c) => c.to.module === output.id);
  const source = feeds.find((c) => c.to.port === 'l')?.from;
  if (!source || feeds.some((c) => c.from.module !== source.module || c.from.port !== source.port)) throw new Error('Expected a mono Monolith output');
  p.cables = p.cables.filter((c) => c.to.module !== output.id);
  let from = source;
  let stereo: { module: number; port: string } | undefined;
  effects.forEach((effect, index) => {
    if (stereo) throw new Error('Stereo effect must be last');
    const m = addModule(p, DEFS[effect.type], output.x + index * 320, output.y + 320);
    m.name = effect.label;
    Object.assign(m.params, effect.params);
    wire(p, from.module, from.port, m.id, 'in');
    from = { module: m.id, port: effect.type === 'filter' ? 'lp12' : effect.type === 'chorus' ? 'l' : 'out' };
    if (effect.type === 'chorus') stereo = { module: m.id, port: 'r' };
  });
  wire(p, from.module, from.port, output.id, 'l');
  wire(p, (stereo ?? from).module, (stereo ?? from).port, output.id, 'r');
}

const out = resolve(process.argv[2] ?? '../build/monolith-effects');
mkdirSync(out, { recursive: true });
factoryPresets();
const source = {
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  workingTreeDiffSha256: createHash('sha256').update(execFileSync('git', ['diff', 'HEAD'], { maxBuffer: 64 << 20 })).digest('hex'),
};
const entries = [];
for (const study of studies) {
  const original = FM1_PRESETS['Monolith D']();
  const device = devicesOf(original, DEFS).find((d) => d.asm !== undefined)!;
  const assembly = original.assemblies!.find((a) => a.id === device.asm)!;
  const preset = presetsOf(original, assembly).find((p) => p.name === study.preset);
  if (!preset || !applyPreset(original, assembly, preset)) throw new Error(`Missing preset ${study.preset}`);
  for (const wet of [false, true]) {
    let p = structuredClone(original);
    const treatment = wet ? study.treatment : 'Dry';
    p.name = `${study.preset} - ${treatment}`;
    if (wet) addEffects(p, study.effects);
    p = validatePatch(p, DEFS);
    const budget = deviceBudget(p);
    if (!budget.fits) throw new Error(`${p.name} exceeds device budget: ${JSON.stringify(budget)}`);
    const channels = renderAudition(p, 'melodic');
    let peak = 0;
    for (const channel of channels) for (const sample of channel) {
      if (!Number.isFinite(sample)) throw new Error(`${p.name}: nonfinite output`);
      peak = Math.max(peak, Math.abs(sample));
    }
    const loudness = integratedLoudness(channels[0], channels[1], DEVICE_SR);
    const matchedGain = Number.isFinite(loudness) ? Math.min(10 ** ((-23 - loudness) / 20), peak ? 0.88 / peak : 1) : 1;
    const id = `monolith-fx--${study.preset.toLowerCase().replace(/[^a-z0-9]+/g, '-')}--${wet ? 'effected' : 'dry'}`;
    const saved = JSON.stringify(p);
    writeFileSync(resolve(out, id + '.json'), saved);
    writeFileSync(resolve(out, id + '.wav'), auditionWav(channels));
    writeFileSync(resolve(out, id + '--matched.wav'), auditionWav(channels, matchedGain));
    entries.push({ id, instrument: 'Monolith D effects study', device: study.preset, preset: `${study.preset} / ${treatment}`, kind: 'melodic', treatment, peak, loudness, matchedGain,
      effects: wet ? study.effects : [], provenance: { ...source, patchSha256: createHash('sha256').update(saved).digest('hex') },
      budget: { fits: budget.fits, bytes: budget.items.find((i) => i.key === 'bytes')!.used, cpu: budget.cpu.use, memory: budget.memory } });
    console.log(`${p.name}: ${loudness.toFixed(1)} LUFS, peak ${peak.toFixed(4)}, CPU estimate ${(budget.cpu.use * 100).toFixed(1)}%`);
  }
}
writeFileSync(resolve(out, 'manifest.json'), JSON.stringify({ date: new Date().toISOString(), ...source, source: 'browser Engine; saved-patch experiments, not factory presets or hardware recordings', sr: DEVICE_SR, seconds: 16, entries }, null, 2));
