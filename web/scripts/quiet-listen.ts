// SPDX-License-Identifier: GPL-3.0-only
// Listening files for the quiet-load change (#1086), through the FM-1's own engine (engine.c as wasm): each factory preset
// that sounded at load as it did (BASE's card: loaded, no key, the transport stopped) beside the same preset now (PLAY
// running for its PATTERN track, or for Canvas a key held with ARP on), and each new demonstration pattern alone.
// Writes OUT/<slug>--old.wav, --new.wav (stereo, 16-bit, 44,118 Hz) and OUT/summary.md / summary.json (loudness, peak).
// Run from web/: npx vite-node scripts/quiet-listen.ts OUT [BASE=origin/main]
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { applyPreset } from '../src/device-presets';
import { FACTORY } from '../src/assemblies';
import { Fm1Engine } from '../src/fm1-engine';
import { Fm1Bridge } from '../src/fm1-engine-host';
import { integratedLoudness } from '../src/loudness';
import { DEVICE_SR } from '../src/modules';
import type { Patch } from '../src/patch';
import { cardSlug, parseCard } from '../src/preset-cards';
import { buildFm1EngineWasm } from './fm1-wasm.mjs';
import { factoryPatches, presetDevices, withPreset } from './quiet-load';

const out = resolve(process.argv[2] ?? '../build/listen-quiet');
const base = process.argv[3] ?? 'origin/main';
const SECS = 14, PLAY_SECS = 10, KEY = 60;
/** the presets that sounded at load, and the keyboard presets that gained a demonstration pattern */
const CHANGED: Record<string, string[]> = {
  Canvas: ['Sequencer Run', 'Easel Bongos', 'FM Chimes'],
  '8 Lire': ['Eight Drone', 'Trill Delay', 'Feedback Howl'],
  'Elvira 2': ['Deep Drone', 'Beating Cluster'],
};
const NEW_PATTERN: Record<string, string[]> = {
  '8 Lire': ['Init', 'Lyre Chord', 'Pair FM Bells'],
  'Elvira 2': ['Init', 'Fifths Pad', 'Rusty Bells', 'Pulse Lantern'],
};

const wasm = new WebAssembly.Module(readFileSync(buildFm1EngineWasm(join(tmpdir(), `fm1-engine-listen-${process.pid}.wasm`))));
const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** the Arpeggiator rate (ARP_RATE_CHOICES) nearest each Canvas preset's old pulser period at 120 BPM: 0.18 s 1/8T, 0.25 s
 *  1/8, 0.5 s 1/4 */
const ARP_RATE: Record<string, [number, string]> = { 'Sequencer Run': [3, '1/8T'], 'Easel Bongos': [2, '1/8'], 'FM Chimes': [0, '1/4'] };

/** SECS of the FM-1 engine playing `p`: `play` runs the transport (or, `key`, holds KEY with the Arpeggiator on at
 *  `rate`) for PLAY_SECS, then stops; neither: loaded and left alone */
function render(p: Patch, how: 'idle' | 'play' | 'key', rate = 4): Float32Array[] {
  const q = structuredClone(p);
  if (how === 'key') Object.assign(q.modules.find((m) => m.type === 'arp')!, { bypass: false }).params.rate = rate;
  const e = new Fm1Engine(wasm, DEVICE_SR);
  if (e.apply(new Fm1Bridge().load(q)) !== 0) throw new Error(`${p.name}: the FM-1 engine does not load it`);
  const n = SECS * DEVICE_SR, L = new Float32Array(n), R = new Float32Array(n);
  for (let at = 0; at < n; at += 128) {
    if (at === 0 && how === 'play') e.hear({ t: 'transport', on: true });
    if (at === 0 && how === 'key') e.hear({ t: 'on', note: KEY, vel: 100 / 127 });
    if (at <= PLAY_SECS * DEVICE_SR && at + 128 > PLAY_SECS * DEVICE_SR) {
      if (how === 'play') e.hear({ t: 'transport', on: false });
      if (how === 'key') e.hear({ t: 'off', note: KEY, vel: 0 });
    }
    const m = Math.min(128, n - at);
    e.render(L.subarray(at, at + m), R.subarray(at, at + m));
  }
  return [L, R];
}

function wav([L, R]: Float32Array[]): Buffer {
  const n = L.length, b = Buffer.alloc(44 + n * 4);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 4, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(2, 22); b.writeUInt32LE(DEVICE_SR, 24);
  b.writeUInt32LE(DEVICE_SR * 4, 28); b.writeUInt16LE(4, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 4, 40);
  const q = (v: number): number => Math.round(Math.max(-1, Math.min(1, v)) * 32767);
  for (let i = 0; i < n; i++) { b.writeInt16LE(q(L[i]), 44 + i * 4); b.writeInt16LE(q(R[i]), 46 + i * 4); }
  return b;
}

interface Row { patch: string; preset: string; file: string; how: string; lufs: number | null; peak: number | null }
const rows: Row[] = [];
function keep(patch: string, preset: string, tag: string, how: string, ch: Float32Array[]): void {
  const file = `${slug(patch)}--${slug(preset)}--${tag}.wav`;
  writeFileSync(resolve(out, file), wav(ch));
  let m = 0;
  for (const c of ch) for (const v of c) m = Math.max(m, Math.abs(v));
  const l = integratedLoudness(ch[0], ch[1], DEVICE_SR);
  rows.push({ patch, preset, file, how, lufs: Number.isFinite(l) ? +l.toFixed(1) : null, peak: m ? +(20 * Math.log10(m)).toFixed(1) : null });
  console.log(`${file}: ${how}, ${rows.at(-1)!.lufs} LUFS, peak ${rows.at(-1)!.peak} dBFS`);
}

mkdirSync(out, { recursive: true });
const patches = factoryPatches();
for (const name of [...new Set([...Object.keys(CHANGED), ...Object.keys(NEW_PATTERN)])]) {
  const patch = patches.find((x) => x.name === name)!.patch;
  const { asm, presets } = presetDevices(patch)[0];
  const def = FACTORY.find((d) => d.name === name)!;
  const old = parseCard(execFileSync('git', ['show', `${base}:web/presets/cards/${cardSlug(name)}.txt`], { encoding: 'utf8' }), def);
  if (old.errors.length) throw new Error(`${base}'s ${name} card: ${old.errors.join('; ')}`);
  for (const preset of CHANGED[name] ?? []) {
    const now = withPreset(patch, asm.id, presets.find((x) => x.name === preset)!);
    const was = structuredClone(now);
    if (!applyPreset(was, was.assemblies!.find((a) => a.id === asm.id)!, old.presets.find((x) => x.name === preset)!)) throw new Error(`${name} / ${preset}: ${base}'s values do not load`);
    keep(name, preset, 'old', `${base}: loaded, no key, transport stopped`, render(was, 'idle'));
    if (name === 'Canvas') {
      const [rate, label] = ARP_RATE[preset];
      keep(name, preset, 'new', `now: C4 held ${PLAY_SECS} s with ARP on at ${label}`, render(now, 'key', rate));
    } else keep(name, preset, 'new', `now: PLAY for ${PLAY_SECS} s, then STOP`, render(now, 'play'));
  }
  for (const preset of NEW_PATTERN[name] ?? []) {
    const now = withPreset(patch, asm.id, presets.find((x) => x.name === preset)!);
    keep(name, preset, 'new', `now: its new pattern, PLAY for ${PLAY_SECS} s, then STOP (no ${base} file: it was silent on PLAY)`, render(now, 'play'));
  }
}
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
writeFileSync(resolve(out, 'summary.json'), JSON.stringify({ engine: 'FM-1 engine (engine.c as wasm)', sr: DEVICE_SR, seconds: SECS, base, head: sha, rows }, null, 1) + '\n');
const md = [
  `# Quiet load (#1086): listening files`, '',
  `Generated ad hoc on ${new Date().toISOString().slice(0, 10)} from this repository at commit ${sha} (with the working tree's changes), not maintained, stale after 24 hours. Rendered by web/scripts/quiet-listen.ts through the FM-1 engine (engine.c as wasm), ${DEVICE_SR} Hz, ${SECS} s each; "old" is ${base}'s card.`, '',
  '| Patch | Preset | File | How | LUFS | Peak dBFS |', '|---|---|---|---|---|---|',
  ...rows.map((r) => `| ${r.patch} | ${r.preset} | ${r.file} | ${r.how} | ${r.lufs ?? '-inf'} | ${r.peak ?? '-inf'} |`), ''];
writeFileSync(resolve(out, 'summary.md'), md.join('\n'));
