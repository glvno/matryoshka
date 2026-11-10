// SPDX-License-Identifier: GPL-3.0-only
import { createHash } from 'node:crypto';
import { seedPresetPattern } from '../src/preset-patterns';
// #833: raw, repeatable browser-engine auditions. No demo compression or limiting.
// Run: vite-node scripts/preset-auditions.ts OUT_DIR [--only NAME] [--inventory]
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { applyPreset, presetsOf } from '../src/device-presets';
import { presetPattern } from '../src/preset-pattern-data';
import { structureOf } from '../src/structure';
import { factoryPresets } from '../src/factory-presets';
import { Engine } from '../src/engine';
import { FM1_PRESETS } from '../src/presets';
import { devicesOf } from '../src/pages';
import { DEVICE_SR, DEFS } from '../src/modules';
import { integratedLoudness } from '../src/loudness';
import { deviceBudget } from '../src/patchbin';
import { addModule, type Patch } from '../src/patch';
import { around, plugIn, wire } from './factory-build';
import { fixNotes, patternNotes } from '../src/track';

const melodic = ['Io 4', 'Monolith D', 'Sallen 20', 'Silver Box', 'Vernon 100', 'Wanderer'];
const drones = ['8 Lire', 'Elvira 2'];
const drums = ['Scrounge', 'Meridian 8', 'Perun 4', 'Spokes 6', 'Verona Drum 1', '808 Kit', '909 Kit', '<7PH', 'drum kit'];
const names = [...melodic, ...drones, ...drums];
const sr = DEVICE_SR, seconds = 16, block = 128;
const out = resolve(process.argv[2] ?? '../build/preset-auditions');
const only = process.argv[process.argv.indexOf('--only') + 1];
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
factoryPresets();
mkdirSync(out, { recursive: true });

type Event = { at: number; note: number; on: boolean; vel: number };
function render(patch: Patch, kind: string): [Float32Array, Float32Array] {
  const q = structuredClone(patch);
  // Diagnostic output: expose peaks hidden by the engine's final clamp. Scale back exactly afterward.
  q.modules.filter((m) => m.type === 'output').forEach((m) => m.params.level /= 16);
  const engine = new Engine(sr);
  engine.load(q);
  const events: Event[] = [];
  const hit = (at: number, duration: number, note: number, vel = 100 / 127) => {
    events.push({ at, note, vel, on: true }, { at: at + duration, note, vel, on: false });
  };
  if (kind === 'drum') engine.transport(true);
  else if (kind === 'drone') {
    const map = q.modules.find((m) => m.type === 'drummap');
    const keys = map ? [...new Set(Array.from({ length: 8 }, (_, i) => map.params[`n${i + 1}`]))] : [53, 55, 57, 59];
    keys.forEach((note, i) => hit(i * 0.2, 10 - i * 0.2, note));
  } else {
    hit(0, 2, 36); hit(3, 2, 60); hit(6, 1, 84, 0.5);
    [48, 55, 60, 63, 67, 70, 67, 63].forEach((note, i) => hit(8 + i * 0.35, 0.25, note, i % 2 ? 0.55 : 1));
    hit(12, 1, 48); hit(12, 1, 55); hit(12, 1, 60);
  }
  events.sort((a, b) => a.at - b.at || Number(a.on) - Number(b.on));
  const l = new Float32Array(sr * seconds), r = new Float32Array(l.length);
  const bl = new Float32Array(block), br = new Float32Array(block);
  let next = 0;
  for (let offset = 0; offset < l.length; offset += block) {
    while (next < events.length && events[next].at * sr <= offset) {
      const ev = events[next++];
      if (ev.on) engine.noteOn(ev.note, ev.vel); else engine.noteOff(ev.note);
    }
    if (kind === 'drum' && offset >= sr * 13) engine.transport(false);
    engine.render(bl, br);
    for (let i = 0; i < Math.min(block, l.length - offset); i++) { l[offset + i] = bl[i] * 16; r[offset + i] = br[i] * 16; }
  }
  return [l, r];
}

function wav(ch: Float32Array[], gain = 1): Buffer {
  const b = Buffer.alloc(44 + ch[0].length * 8);
  b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(3, 20); b.writeUInt16LE(2, 22);
  b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 8, 28); b.writeUInt16LE(8, 32); b.writeUInt16LE(32, 34);
  b.write('data', 36); b.writeUInt32LE(b.length - 44, 40);
  for (let i = 0; i < ch[0].length; i++) { b.writeFloatLE(ch[0][i] * gain, 44 + i * 8); b.writeFloatLE(ch[1][i] * gain, 48 + i * 8); }
  return b;
}
interface Entry { id: string; instrument: string; device: string; preset: string; kind: string; peak: number; loudness: number; matchedGain: number; budget: { fits: boolean; bytes: number; cpu: number; memory: number } }
const entries: Entry[] = process.argv.includes('--only') && existsSync(resolve(out, 'manifest.json'))
  ? JSON.parse(readFileSync(resolve(out, 'manifest.json'), 'utf8')).entries.filter((e: { instrument: string }) => e.instrument !== only) : [];
for (const name of names) {
  if (process.argv.includes('--only') && only !== name) continue;
  const original = name === 'drum kit' ? (() => {
    const x = around('drum kit', 'drum kit');
    x.p.cables = x.p.cables.filter((c) => c.from.module !== x.main.id);
    const track = addModule(x.p, DEFS.steps, 20, 300);
    track.name = 'PATTERN';
    wire(x.p, x.main.id, 'keys', track.id, 'keys');
    plugIn(x.p, track.id, 'keys', x.a, 'keys');
    const map = x.p.modules.find((m) => m.type === 'drummap')!;
    const rows: Record<number, string> = { 1: 'X...x...x.x.....', 2: '....X.......X..x', 3: '............X...', 4: 'x.X.x.X.x.X.x.X.', 6: '......x.......x.', 8: '..........x.....' };
    track.notes = fixNotes(Object.entries(rows).flatMap(([row, pattern]) => (patternNotes(pattern) ?? []).map((n) => ({ ...n, note: map.params[`n${row}`] }))));
    x.out.params.level = 0.5;
    return x.p;
  })() : FM1_PRESETS[name]();
  if (name === 'drum kit') for (const a of original.assemblies ?? []) { const init = presetPattern(structureOf(original, a), 'Init'); if (init) { a.preset = 'Init'; seedPresetPattern(original, a, init.id); } }
  const kind = melodic.includes(name) ? 'melodic' : drones.includes(name) ? 'drone' : 'drum';
  const devices = devicesOf(original, DEFS).filter((d) => d.asm !== undefined);
  const candidates = devices.flatMap((d) => {
    const a = original.assemblies!.find((a) => a.id === d.asm)!;
    return presetsOf(original, a).map((preset) => ({ assembly: a.id, device: d.name, preset }));
  });
  // Kept kits currently lack a preset selector. Record them explicitly instead of silently omitting them.
  const variants = candidates.length ? candidates : [{ assembly: -1, device: name, preset: { name: 'Init' } }];
  for (const variant of variants) {
    const p = structuredClone(original);
    if ('values' in variant.preset) applyPreset(p, p.assemblies!.find((a) => a.id === variant.assembly)!, variant.preset);
    const id = `${slug(name)}--${slug(variant.device)}--${slug(variant.preset.name)}`;
    if (process.argv.includes('--inventory')) { console.log(`${id}: ${kind}`); continue; }
    const ch = render(p, kind);
    let peak = 0, invalid = 0;
    for (const c of ch) for (const v of c) { if (!Number.isFinite(v)) invalid++; peak = Math.max(peak, Math.abs(v)); }
    if (invalid) throw new Error(`${id}: ${invalid} nonfinite samples`);
    const loudness = integratedLoudness(ch[0], ch[1], sr);
    const gain = Number.isFinite(loudness) ? Math.min(10 ** ((-23 - loudness) / 20), peak ? 0.88 / peak : 1) : 1;
    writeFileSync(resolve(out, `${id}.wav`), wav(ch));
    writeFileSync(resolve(out, `${id}--matched.wav`), wav(ch, gain));
    writeFileSync(resolve(out, `${id}.json`), JSON.stringify(p));
    entries.push({ id, instrument: name, device: variant.device, preset: variant.preset.name, kind, peak, loudness, matchedGain: gain,
      budget: ((b) => ({ fits: b.fits, bytes: b.items.find((i) => i.key === 'bytes')!.used, cpu: b.cpu.use, memory: b.memory }))(deviceBudget(p)) });
    console.log(`${id}: ${loudness.toFixed(1)} LUFS, peak ${peak.toFixed(4)}`);
    writeFileSync(resolve(out, 'manifest.json'), JSON.stringify({ date: new Date().toISOString(), commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), workingTreeDiffSha256: createHash('sha256').update(execFileSync('git', ['diff', 'HEAD'], { maxBuffer: 64 << 20 })).digest('hex'), source: 'browser Engine; not a hardware recording', sr, seconds,
      diagnostic: 'Output attenuated 16x before final clamp then restored in float WAV; no demo limiter; matched WAV uses a constant gain capped at 0.88 peak', entries }, null, 2));
  }
}
