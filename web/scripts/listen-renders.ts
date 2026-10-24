// SPDX-License-Identifier: GPL-3.0-only
// Renders every XL and its FM-1 version with the same phrase through the browser engine, for listening side by side
// (#292): build/listen/<slug>.wav (stereo, 16-bit) and build/listen/listen.json (per pair: both files, integrated
// loudness after BS.1770, sample peak, the difference, a flag past MAX_DIFF dB). The factory XLs and the community pairs.
// The phrase: a patch whose Steps tracks hold notes runs its transport and holds a low key; the rest play four chords, then a line.
// Notes follow the patch's keyboard octave (Patch.octave). The FM-1's own rendering (the emulator) is not included.
// Run from web/:  npm run listen-renders
import { mkdirSync, writeFileSync } from 'node:fs';
import { communityEntries } from '../src/community';
import { Engine } from '../src/engine';
import { DEFS } from '../src/modules';
import type { Patch } from '../src/patch';
import { FM1_PRESETS, XL_PRESETS, xlBase } from '../src/presets';
import { decodeShare } from '../src/share';
import { lufs, peakDb } from './loudness';

const SR = 44100, BLOCK = 128, SECS = 12, VEL = 100 / 127;
const MAX_DIFF = 3; // dB of integrated loudness between an XL and its FM-1 version before the pair is flagged
const out = new URL('../../build/listen/', import.meta.url);

type Ev = [time: number, note: number, on: boolean];
const CHORDS = [[48, 60, 64, 67], [45, 57, 60, 64], [41, 57, 60, 65], [43, 55, 59, 62]];
const LINE = [60, 62, 64, 67, 69, 67, 64, 62];

/** the phrase's key events, sorted by time */
function phrase(sequenced: boolean, octave: number): Ev[] {
  const t = 12 * octave, ev: Ev[] = [];
  if (sequenced) return [[0, 48 + t, true], [SECS - 2, 48 + t, false]];
  CHORDS.forEach((c, i) => c.forEach((n) => ev.push([i * 1.5, n + t, true], [i * 1.5 + 1.35, n + t, false])));
  for (let r = 0; r < 2; r++) LINE.forEach((n, i) => { const s = 6 + r * 2 + i * 0.25; ev.push([s, n + t, true], [s + 0.22, n + t, false]); });
  return ev.sort((a, b) => a[0] - b[0] || Number(a[2]) - Number(b[2]));
}

function render(p: Patch): Float32Array[] {
  const e = new Engine(SR);
  e.load(p);
  const sequenced = p.modules.some((m) => m.type === 'steps' && m.notes?.length);
  if (sequenced) e.transport(true);
  const ev = phrase(sequenced, p.octave ?? 0);
  const n = SECS * SR, L = new Float32Array(n), R = new Float32Array(n), bl = new Float32Array(BLOCK), br = new Float32Array(BLOCK);
  let k = 0;
  for (let s = 0; s < n; s += BLOCK) {
    while (k < ev.length && ev[k][0] * SR <= s) {
      const [, note, on] = ev[k++];
      if (on) e.noteOn(note, VEL); else e.noteOff(note);
    }
    e.render(bl, br);
    L.set(bl.subarray(0, Math.min(BLOCK, n - s)), s);
    R.set(br.subarray(0, Math.min(BLOCK, n - s)), s);
  }
  return [L, R];
}

function wav([L, R]: Float32Array[]): Buffer {
  const n = L.length, b = Buffer.alloc(44 + n * 4);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 4, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(2, 22); b.writeUInt32LE(SR, 24);
  b.writeUInt32LE(SR * 4, 28); b.writeUInt16LE(4, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 4, 40);
  const q = (v: number): number => Math.round(Math.max(-1, Math.min(1, v)) * 32767);
  for (let i = 0; i < n; i++) { b.writeInt16LE(q(L[i]), 44 + i * 4); b.writeInt16LE(q(R[i]), 46 + i * 4); }
  return b;
}

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const round1 = (v: number): number | null => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);

function measure(name: string, p: Patch) {
  const ch = render(p);
  const file = `${slug(name)}.wav`;
  writeFileSync(new URL(file, out), wav(ch));
  return { name, file, lufs: round1(lufs(ch, SR)), peak: round1(peakDb(ch)) };
}

mkdirSync(out, { recursive: true });
const pairs: [string, Patch, Patch, string][] = [];
for (const [xlName, make] of Object.entries(XL_PRESETS)) {
  const base = xlBase(xlName)!;
  if (FM1_PRESETS[base]) pairs.push([base, FM1_PRESETS[base](), make(), 'factory']);
}
const community = new Map<string, Patch>();
for (const e of communityEntries()) community.set(e.title, await decodeShare(e.code, DEFS));
for (const [title, xl] of community) {
  const base = xlBase(title);
  if (base && community.has(base)) pairs.push([base, community.get(base)!, xl, 'community']);
}

const table = pairs.map(([base, fm1, xl, kind]) => {
  const a = measure(base, fm1), b = measure(`${base} XL`, xl);
  const diff = a.lufs !== null && b.lufs !== null ? round1(b.lufs - a.lufs) : null;
  return { pair: base, kind, fm1: a, xl: b, diff, flag: diff === null || Math.abs(diff) > MAX_DIFF };
});
writeFileSync(new URL('listen.json', out), JSON.stringify({ sr: SR, seconds: SECS, maxDiff: MAX_DIFF, pairs: table }, null, 1) + '\n');
for (const t of table)
  console.log(`${t.pair.padEnd(16)} FM-1 ${String(t.fm1.lufs).padStart(6)} LUFS ${String(t.fm1.peak).padStart(6)} dBFS   XL ${String(t.xl.lufs).padStart(6)} LUFS ${String(t.xl.peak).padStart(6)} dBFS   ${t.diff! > 0 ? '+' : ''}${t.diff} dB${t.flag ? '  FLAG' : ''}`);
console.log(`${table.length} pairs -> build/listen/`);
