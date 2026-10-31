// SPDX-License-Identifier: GPL-3.0-only
// The preset demo (web/demo/README.md): every FM-1 factory patch's presets on the editor's Emulator view (EMU), in a
// headed Chrome window sized for a screen recording, at the song's tempo (the default song: 100 bpm, about 2:41).
//   npm run demo [-- --song NAME] [--seconds S | --tempo BPM] [--init] [--only A,B] [--skip A,B] [--url URL]
//                [--size WxH] [--wasm FILE] [--no-normalize | --loudness DB] [--dry-run] [--headless] [--shots]
// Everything runs on one beat grid. Patches played from the keys come first: each patch is opened (a beat), then the
// PRESET encoder steps its engine's factory presets on bar lines, and each preset plays a bar of the song. With a chord
// loop (songs/loop.json, the default) each preset plays a part that suits it: a pad holds the chord, a bass plays a root
// riff, a lead a short melody, a bell or pluck an arpeggio, a drone engine its rows on the black keys. With a list of
// notes (songs/moonlight.json) each preset plays the next notes. Patches that play from a pattern (pattern 1 of a Steps
// track has notes: the drum machines and kits) come last: their tempo is set to the demo's (PLAY held + PRESET, not
// stored), PLAY runs the pattern and PRESET steps the presets, a bar each. A caption over the panel names the patch and
// the preset. The page's Web MIDI sees no ports, so no FM-1 is ever reached; nothing is stored. Each step's loudness is
// measured first, offline with the browser's engine, and the page evens it out with a gain and a limiter after MASTER.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { allModules, parentOf } from '../src/assembly';
import { applyPreset, presetsOf } from '../src/device-presets';
import { Engine } from '../src/engine';
import { rowOrder } from '../src/structure';
import { instIsEngine } from '../src/engines';
import '../src/factory-presets';
import { binaryPage } from '../src/patchbin';
import { FM1_PRESETS } from '../src/presets';

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = resolve(WEB, '..');
const OUT = join(ROOT, 'build/demo');
const args = process.argv.slice(2);
const flag = (n: string): boolean => args.includes(n);
const opt = (n: string): string | undefined => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const num = (n: string, d: number): number => { const v = opt(n); if (v === undefined) return d; const x = Number(v); if (!Number.isFinite(x) || x <= 0) throw new Error(`${n} takes a positive number`); return x; };
const list = (n: string): string[] | undefined => opt(n)?.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

const SONG = opt('--song') ?? 'loop';
/** a time budget the tempo is raised to fit (only when given: by default the demo plays at the song's tempo) */
const SECONDS = opt('--seconds') !== undefined ? num('--seconds', 0) : undefined;
const TEMPO = opt('--tempo') ? Math.round(num('--tempo', 0)) : undefined;
const INIT = flag('--init');
const ONLY = list('--only');
const SKIP = list('--skip') ?? [];
const [W, H] = (opt('--size') ?? '1600x900').split('x').map(Number);
/** beats a patch gets to load (and a pattern patch to take the tempo) before its first preset's bar */
const LOAD_BEATS = Math.round(num('--load-beats', 1));
const PATTERN_LOAD_BEATS = LOAD_BEATS + 1;
/** ms before a bar line that its PRESET click (and OCT- / OCT+) happen, so the preset is in before the first note */
const LEAD_MS = 80;

// ---- notes and the keybed
const SEMI: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const ACC: Record<string, number> = { '': 0, '#': 1, '##': 2, x: 2, b: -1, bb: -2 };
function midi(p: string | number): number {
  if (typeof p === 'number') return p;
  const m = /^([A-Ga-g])(##|#|x|bb|b)?(-?\d)$/.exec(p.trim());
  if (!m) throw new Error(`song ${SONG}: "${p}" is no note name (C#3, Db3, E#1; C4 = MIDI 60)`);
  return 12 * (Number(m[3]) + 1) + SEMI[m[1].toUpperCase()] + ACC[m[2] ?? ''];
}
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const noteName = (n: number): string => `${NAMES[n % 12]}${Math.floor(n / 12) - 1}`;
/** the keybed: 27 keys from F3 (MIDI 53) at the panel's octave (-3..3, OCT- / OCT+) */
const keyLo = (oct: number): number => 53 + 12 * oct;
/** the octave whose keys hold all these notes, the nearest to `prev` (fewest OCT presses); null: none does */
function octaveFor(notes: number[], prev: number): number | null {
  const lo = Math.min(...notes), hi = Math.max(...notes);
  const fit = [-3, -2, -1, 0, 1, 2, 3].filter((o) => lo >= keyLo(o) && hi <= keyLo(o) + 26);
  return fit.length ? fit.sort((a, b) => Math.abs(a - prev) - Math.abs(b - prev))[0] : null;
}
/** black keys 1..8 (F#3, G#3, A#3, C#4, ...) as key numbers: on the FM-1 they play a Drum map's rows 1..8 (D-520) */
const BLACK = [1, 3, 5, 8, 10, 13, 15, 17];

// ---- the song: web/demo/songs/<name>.json, a chord loop or a list of notes
const songFile = join(WEB, 'demo/songs', `${SONG}.json`);
if (!existsSync(songFile)) {
  const have = readdirSync(join(WEB, 'demo/songs')).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
  throw new Error(`no song ${SONG} (web/demo/songs/${SONG}.json); there are: ${have.join(', ')}`);
}
type Phrase = [number, number, number[]][];
interface LoopSong {
  title?: string; tempo?: number; beatsPerBar?: number; chords: string[];
  roles: Record<string, { from?: string; phrase: Phrase }>;
  guess?: [string, string[]][]; default?: string; higher?: { words: string[]; shift: number };
  overrides?: Record<string, string | { role: string; shift?: number }>;
}
interface NotesSong { title?: string; tempo?: number; chords?: boolean; notes: [string | number | (string | number)[], number][] }
const song = JSON.parse(readFileSync(songFile, 'utf8')) as LoopSong & NotesSong;
const LOOP = Array.isArray(song.chords);
const BAR = LOOP ? song.beatsPerBar ?? 4 : 0;

/** one note event in a preset's bar: when (beats from its start), how long (beats), which keys */
interface Ev { at: number; len: number; keys: number[] }
/** a preset's part: its role, the panel's octave, the notes (for the plan), its events, its length in beats */
interface Part { role: string; oct: number; notes: number[]; events: Ev[]; beats: number }

// a chord loop: chord n of the loop as a root and intervals
const chordOf = (c: string): { root: number; iv: number[] } => {
  const m = /^([A-G])(#|b)?(m|dim)?$/.exec(c.trim());
  if (!m) throw new Error(`song ${SONG}: chord "${c}" (a root A-G, # or b, then m or dim)`);
  return { root: (SEMI[m[1]] + ACC[m[2] ?? ''] + 12) % 12, iv: m[3] === 'm' ? [0, 3, 7] : m[3] === 'dim' ? [0, 3, 6] : [0, 4, 7] };
};
const CHORDS = LOOP ? song.chords.map(chordOf) : [];
/** a preset's role and shift: an override by "patch > preset", then by patch, then the name's words, else the default */
function roleOf(patch: string, preset: string): { role: string; shift: number; why: string } {
  const o = song.overrides?.[`${patch} > ${preset}`] ?? song.overrides?.[patch];
  const words = preset.toLowerCase().split(/[^a-z0-9]+/);
  const higher = song.higher && words.some((w) => song.higher!.words.includes(w)) ? song.higher.shift : 0;
  if (o) return typeof o === 'string' ? { role: o, shift: higher, why: 'set' } : { role: o.role, shift: o.shift ?? higher, why: 'set' };
  const g = song.guess?.find(([, ws]) => words.some((w) => ws.includes(w)));
  return { role: g?.[0] ?? song.default ?? Object.keys(song.roles)[0], shift: higher, why: g ? 'name' : 'default' };
}
/** a bar of a role over chord `c` (the loop's chord n), for an engine of `voices` voices */
function loopPart(role: string, shift: number, c: number, voices: number, oct: number): Part {
  const r = song.roles[role];
  if (!r) throw new Error(`song ${SONG}: no role ${role}`);
  const ch = CHORDS[c % CHORDS.length];
  if (role === 'drone') {   // a Drum map's rows on the black keys, counted from the bar's chord
    const events = r.phrase.map(([at, len, tones]) => ({ at, len, keys: tones.map((t) => BLACK[(c + t) % 8]) }));
    return { role, oct, notes: [], events, beats: BAR };
  }
  const from = midi(r.from ?? 'C3');
  const root = from + ((ch.root - (from % 12) + 12) % 12) + shift;
  const tone = (t: number): number => root + ch.iv[t % 3] + 12 * Math.floor(t / 3);
  const notes = r.phrase.map(([, , tones]) => tones.slice(0, Math.max(1, voices)).map(tone));
  const o = octaveFor(notes.flat(), oct);
  if (o === null) throw new Error(`song ${SONG}: role ${role}'s bar spans more than the 27 keys`);
  const events = r.phrase.map(([at, len], i) => ({ at, len, keys: notes[i].map((n) => n - keyLo(o)) }));
  return { role, oct: o, notes: notes.flat(), events, beats: BAR };
}

// a list of notes (Moonlight): one key an entry (its lowest note) unless --chords / "chords": true; each note a beat,
// or the song's lengths with --rhythm; the octave that holds most of the song, a note outside it moved an octave in
const NOTES_EACH = Math.round(num('--notes', 3));
const NOTE_EVENTS = LOOP ? [] : song.notes.map(([p, beats]) => {
  const ns = [...new Set((Array.isArray(p) ? p : [p]).map(midi))];
  return { notes: flag('--chords') || song.chords === true ? ns : [Math.min(...ns)], beats: flag('--rhythm') ? beats : 1 };
});
const allNotes = NOTE_EVENTS.flatMap((e) => e.notes);
const NOTE_OCT = LOOP ? 0 : [-3, -2, -1, 0, 1, 2, 3].map((o) => ({ o, n: allNotes.filter((x) => x >= keyLo(o) && x <= keyLo(o) + 26).length }))
  .sort((a, b) => b.n - a.n || Math.abs(a.o) - Math.abs(b.o))[0].o;
const PITCHES = [...new Set(allNotes)].sort((a, b) => a - b);
let folded = 0;
function notesPart(start: number, rows: boolean): Part {
  const evs = Array.from({ length: NOTES_EACH }, (_, i) => NOTE_EVENTS[(start + i) % NOTE_EVENTS.length]);
  let at = 0;
  const events = evs.map((e) => {
    const keys = [...new Set(e.notes.map((n) => {
      if (rows) return BLACK[PITCHES.indexOf(n) % 8];
      let x = n;
      while (x < keyLo(NOTE_OCT)) x += 12;
      while (x > keyLo(NOTE_OCT) + 26) x -= 12;
      if (x !== n) folded++;
      return x - keyLo(NOTE_OCT);
    }))];
    const ev = { at, len: e.beats, keys };
    at += e.beats;
    return ev;
  });
  return { role: rows ? 'drone' : 'notes', oct: NOTE_OCT, notes: evs.flatMap((e) => e.notes), events, beats: at };
}

// ---- the plan: which patches, which presets, in what order (from the patches themselves, as the FM-1 has them)
interface Item { name: string; engine: string | null; aid: number | null; device: number; presets: (string | null)[]; rows: boolean; voices: number; tempo: number }
const keyboard: Item[] = [];
const drums: Item[] = [];
const left: string[] = [];
for (const [name, make] of Object.entries(FM1_PRESETS)) {
  if (ONLY && !ONLY.includes(name.toLowerCase())) continue;
  if (SKIP.includes(name.toLowerCase())) continue;
  const p = make();
  // a patch plays from its pattern when the pattern its Steps track plays on PLAY (pattern 1) has notes
  const pattern = p.modules.some((m) => m.type === 'steps' && (m.notes?.length ?? 0) > 0);
  // its engine: the first top-level engine assembly with factory presets (the device the FM-1's PRESET steps)
  const eng = (p.assemblies ?? []).filter((a) => a && !parentOf(p, a.id) && instIsEngine(p, a))
    .map((a) => ({ a, presets: presetsOf(p, a).filter((x) => x.factory).map((x) => x.name) }))
    .find((x) => x.presets.length);
  const presets = (eng?.presets ?? []).filter((x) => INIT || x !== 'Init');
  const members = eng ? allModules(p, eng.a).map((id) => p.modules.find((m) => m.id === id)).filter((m) => !!m) : [];
  const types = members.map((m) => m.type);
  // played on the black keys: its keys reach a Drum map and no Voicing (D-520: then black keys 1..8 play rows 1..8)
  const rows = types.includes('drummap') && !types.includes('alloc');
  // its polyphony as the patch comes: the most voices of a Voicing in it (a chord on fewer voices keeps its lowest tones)
  const voices = Math.max(1, ...members.filter((m) => m.type === 'alloc').map((m) => Math.round(m.params.voices ?? 1)));
  const tempo = Math.round(p.modules.find((m) => m.type === 'fm1')?.params.tempo ?? 120);
  const item: Item = { name, engine: eng?.a.label ?? null, aid: eng?.a.id ?? null, device: eng ? binaryPage(p, `a${eng.a.id}`, 0)?.[0] ?? -1 : -1, presets, rows, voices, tempo };
  if (pattern) drums.push({ ...item, presets: presets.length ? presets : [null] });
  else if (presets.length) keyboard.push(item);
  else left.push(name);
}
if (!keyboard.length && !drums.length) throw new Error('no patch to demo (check --only / --skip)');

// each keyboard preset's part: the loop's chords go on across presets and patches (a bar each), as does a list's notes
let bar = 0;
let oct = 0;
const parts = keyboard.map((it) => it.presets.map((name) => {
  let part: Part;
  if (LOOP) {
    const r = it.rows ? { role: 'drone', shift: 0, why: 'black keys' } : roleOf(it.name, name!);
    part = { ...loopPart(r.role, r.shift, bar, it.voices, oct), role: r.why === 'name' ? r.role : `${r.role} (${r.why})` };
  } else {
    part = notesPart(bar * NOTES_EACH, it.rows);
  }
  bar++;
  oct = part.oct;
  return part;
}));
const DRUM_BEATS = Math.round(num('--drum-beats', LOOP ? BAR : 4));
const kbBeats = parts.flat().reduce((s, x) => s + x.beats, 0);
const drumSteps = drums.reduce((s, i) => s + i.presets.length, 0);
const loadBeats = keyboard.length * LOAD_BEATS + drums.length * PATTERN_LOAD_BEATS;
const beats = kbBeats + drumSteps * DRUM_BEATS + loadBeats;
// the tempo: --tempo, else the song's own (120 for a song without one); with --seconds, raised to the lowest whole bpm
// that fits that budget
const fitTempo = SECONDS ? Math.ceil((beats * 60) / SECONDS) : 0;
const tempo = TEMPO ?? Math.max(song.tempo ?? 120, fitTempo);
const beatMs = 60000 / tempo;
const totalS = (beats * beatMs) / 1000;
const mmss = (s: number): string => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

console.log(`song: ${song.title ?? SONG}${LOOP ? `, ${song.chords.join(' ')}, a bar of ${BAR} beats a preset` : `, ${NOTES_EACH} notes a preset`}`);
console.log(`\nplayed from the keys: ${keyboard.length} patches, ${parts.flat().length} presets${INIT ? ' (Init included)' : ' (Init skipped)'}`);
console.log(`  ${'patch'.padEnd(15)} ${'preset'.padEnd(17)} ${'role'.padEnd(18)} ${'oct'.padStart(3)}  ${'notes'.padEnd(9)} bars`);
for (const [n, it] of keyboard.entries()) {
  for (const [j, name] of it.presets.entries()) {
    const p = parts[n][j];
    const range = p.notes.length ? `${noteName(Math.min(...p.notes))}-${noteName(Math.max(...p.notes))}` : 'black keys';
    console.log(`  ${(j ? '' : it.name).padEnd(15)} ${name!.padEnd(17)} ${(p.role + (it.voices === 1 && !it.rows && p.role.startsWith('pad') ? ', mono' : '')).padEnd(18)} ${String(p.oct).padStart(3)}  ${range.padEnd(9)} ${LOOP ? 1 : (p.beats / (BAR || 1) || p.beats)}${LOOP ? '' : ' beats'}`);
  }
}
if (folded) console.log(`  (${folded} notes moved an octave in to fit the keys)`);
console.log(`\nfrom a pattern (PLAY, tempo set to ${tempo} bpm, not stored): ${drums.length} patches, ${drumSteps} steps of ${DRUM_BEATS} beats`);
for (const i of drums) console.log(`  ${i.name.padEnd(15)} ${i.presets.map((x) => x ?? '(as it comes: no presets)').join(', ')}${i.tempo !== tempo ? `  (its own tempo ${i.tempo})` : ''}`);
if (left.length) console.log(`\nleft out (no factory presets, played from the keys): ${left.join(', ')}`);
console.log(`\ntempo: ${tempo} bpm${TEMPO ? ' (--tempo)' : SECONDS && tempo > (song.tempo ?? 120) ? ` (the song's ${song.tempo ?? 120} raised to fit ${SECONDS} s; at ${song.tempo ?? 120} the demo takes ${mmss((beats * 60) / (song.tempo ?? 120))})` : song.tempo ? " (the song's)" : ''}, a beat ${beatMs.toFixed(0)} ms${LOOP ? `, a preset's bar ${((BAR * beatMs) / 1000).toFixed(2)} s` : ''}`);
console.log(`time: ${beats} beats: keys ${kbBeats} + patterns ${drumSteps * DRUM_BEATS} + loads ${loadBeats} = ${totalS.toFixed(1)} s (${mmss(totalS)})${SECONDS && totalS > SECONDS + 0.5 ? `  OVER the ${SECONDS} s budget` : ''}`);

// ---- loudness: every patch rendered offline first, with the browser's engine (engine.ts) at 48 kHz, as the demo plays
// it (its presets in turn on the same beat grid, the keys at the panel's octave, velocity 0.8 as the panel's keys send,
// the same note lengths; a pattern patch's pattern at the demo's tempo). A step's loudness is BS.1770's: K-weighted, the
// mean square of both channels over its bar, in LKFS (ungated: a bar is short). The page then lifts or lowers each step to
// the target with a gain after MASTER, and a limiter stops a raised step from clipping. The factory levels are #448.
const NORMALIZE = !flag('--no-normalize');
const LOUDNESS = opt('--loudness') !== undefined ? Number(opt('--loudness')) : undefined;
if (LOUDNESS !== undefined && !Number.isFinite(LOUDNESS)) throw new Error('--loudness takes a level in dB (LKFS), such as -20');
/** the most a step is raised or lowered, dB */
const GAIN_UP = 18, GAIN_DOWN = -12;
const SR = 48000;
/** BS.1770's K-weighting at `fs` as two biquads [b0, b1, b2, a1, a2] (a high shelf, then a high pass; libebur128's form) */
function kWeighting(fs: number): number[][] {
  let K = Math.tan((Math.PI * 1681.974450955533) / fs);
  const Q1 = 0.7071752369554196, Vh = 10 ** (3.999843853973347 / 20), Vb = Vh ** 0.4996667741545416;
  let a0 = 1 + K / Q1 + K * K;
  const shelf = [(Vh + (Vb * K) / Q1 + K * K) / a0, (2 * (K * K - Vh)) / a0, (Vh - (Vb * K) / Q1 + K * K) / a0, (2 * (K * K - 1)) / a0, (1 - K / Q1 + K * K) / a0];
  K = Math.tan((Math.PI * 38.13547087602444) / fs);
  const Q2 = 0.5003270373238773;
  a0 = 1 + K / Q2 + K * K;
  return [shelf, [1, -2, 1, (2 * (K * K - 1)) / a0, (1 - K / Q2 + K * K) / a0]];
}
const KW = kWeighting(SR);
/** both channels K-weighted (their filters run on across the whole render), squared and summed: the mean of a stretch
 *  of it is BS.1770's mean square */
function kPower(l: Float32Array, r: Float32Array): Float64Array {
  const out = new Float64Array(l.length);
  for (const x of [l, r]) {
    let y: Float32Array | Float64Array = x;
    for (const [b0, b1, b2, a1, a2] of KW) {
      const z: Float64Array = new Float64Array(y.length);
      let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
      for (let i = 0; i < y.length; i++) {
        const v = b0 * y[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
        x2 = x1; x1 = y[i]; y2 = y1; y1 = v; z[i] = v;
      }
      y = z;
    }
    for (let i = 0; i < y.length; i++) out[i] += y[i] * y[i];
  }
  return out;
}
const lkfs = (ms: number): number => (ms > 0 ? -0.691 + 10 * Math.log10(ms) : -Infinity);
/** a step of a patch, for its render: the preset (null: as the patch comes), the bar's keys and its length */
interface Bar0 { preset: string | null; events: Ev[]; oct: number; beats: number }
/**
 * A patch's steps' loudness, rendered as the page plays them, in one go: the patch opened, its load beats, then each
 * step's preset taken (Engine.load keeps running voices, delays and reverbs, as the editor's engine does when PRESET
 * steps on the panel) and its bar played. A step's loudness is over what its gain covers in the page: from its preset's
 * click (80 ms before the bar line from the keys, on it for a pattern) to the next step's, so a ringing tail counts.
 */
function loudnessOfPatch(it: Item, bars: Bar0[], pattern: boolean): number[] {
  const make = (preset: string | null): ReturnType<(typeof FM1_PRESETS)[string]> => {
    const p = FM1_PRESETS[it.name]();
    if (preset) {
      const a = (p.assemblies ?? []).find((x) => x?.id === it.aid);
      const pr = a && presetsOf(p, a).find((x) => x.factory && x.name === preset);
      if (!a || !pr || !applyPreset(p, a, pr)) throw new Error(`loudness: ${it.name} > ${preset} did not apply`);
    }
    const main = p.modules.find((m) => m.type === 'fm1');
    if (main && pattern) main.params.tempo = tempo;   // (PLAY held + PRESET in the load beats)
    return p;
  };
  const smp = (ms: number): number => Math.round((ms * SR) / 1000);
  const lead = pattern ? 0 : LEAD_MS;
  const acts: { t: number; f: () => void }[] = [];
  const e = new Engine(SR);
  e.load(make(null));
  // a preset reaches the page's engine as the emulated FM-1 sends it: one parameter message for each card row whose
  // value changed on the FM-1, in the rows' canonical order (structure.ts rowOrder). Not a load of the preset's patch:
  // a Voicing's row (Engine.setParam) reloads the patch the engine was given, which drops the rows set before it in
  // the same step, and the page plays that
  let dev = make(null);
  const take = (preset: string | null): void => {
    const q = make(preset);
    const a = (q.assemblies ?? []).find((x) => x?.id === it.aid);
    const was = (id: number, k: string): number | undefined => dev.modules.find((m) => m.id === id)?.params[k];
    const sent = new Set<string>();
    for (const row of a ? rowOrder(q, a) : []) {
      const v = q.modules.find((m) => m.id === row.module)?.params[row.param];
      sent.add(`${row.module}.${row.param}`);
      if (typeof v === 'number' && v !== was(row.module, row.param)) e.setParam(row.module, row.param, v);
    }
    // (then what the rows are tied to: the editor sets those after them)
    for (const m of q.modules)
      for (const [k, v] of Object.entries(m.params)) if (!sent.has(`${m.id}.${k}`) && typeof v === 'number' && v !== was(m.id, k)) e.setParam(m.id, k, v);
    dev = q;
  };
  let beat = pattern ? PATTERN_LOAD_BEATS : LOAD_BEATS;
  const edges: number[] = [];
  for (const [j, b] of bars.entries()) {
    const t0 = beat * beatMs;
    const click = smp(t0 - lead);
    edges.push(click);
    acts.push({ t: click, f: () => take(b.preset) });
    if (pattern && j === 0) acts.push({ t: smp(t0), f: () => e.transport(true) });
    // the keys as the page presses them: down on the beat, up a little before the note's end (at most 100 ms)
    for (const ev of b.events) {
      const len = ev.len * beatMs;
      const notes = ev.keys.map((k) => keyLo(b.oct) + k);
      acts.push({ t: smp(t0 + ev.at * beatMs), f: () => { for (const n of notes) e.noteOn(n, 0.8); } });
      acts.push({ t: smp(t0 + ev.at * beatMs + len - Math.min(100, len * 0.25)), f: () => { for (const n of notes) e.noteOff(n); } });
    }
    beat += b.beats;
  }
  const end = smp(beat * beatMs - lead);
  edges.push(end);
  acts.sort((a, b) => a.t - b.t);   // (stable: a bar's preset before its first note)
  const l = new Float32Array(end), r = new Float32Array(end);
  let pos = 0;
  for (const a of [...acts, { t: end, f: () => {} }]) {
    for (const t = Math.min(end, Math.max(pos, a.t)); pos < t; ) {
      const n = Math.min(4096, t - pos);
      e.render(l.subarray(pos, pos + n), r.subarray(pos, pos + n));
      pos += n;
    }
    a.f();
  }
  const pw = kPower(l, r);
  return bars.map((_, j) => {
    let s = 0;
    for (let i = edges[j]; i < edges[j + 1]; i++) s += pw[i];
    return lkfs(s / Math.max(1, edges[j + 1] - edges[j]));
  });
}
/** each step's loudness and gain (dB), in the order the demo plays them: the keyboard steps, then the pattern steps */
interface Level { patch: string; preset: string; lkfs: number; gain: number; capped: boolean }
const levels: Level[] = [];
let target = 0;
if (NORMALIZE) {
  const t = Date.now();
  for (const [n, it] of keyboard.entries()) {
    const ls = loudnessOfPatch(it, it.presets.map((name, j) => ({ preset: name, ...parts[n][j] })), false);
    it.presets.forEach((name, j) => levels.push({ patch: it.name, preset: name!, lkfs: ls[j], gain: 0, capped: false }));
  }
  for (const it of drums) {
    const ls = loudnessOfPatch(it, it.presets.map((name) => ({ preset: name, events: [], oct: 0, beats: DRUM_BEATS })), true);
    it.presets.forEach((name, j) => levels.push({ patch: it.name, preset: name ?? '(pattern)', lkfs: ls[j], gain: 0, capped: false }));
  }
  const heard = levels.filter((x) => Number.isFinite(x.lkfs)).map((x) => x.lkfs).sort((a, b) => a - b);
  const median = heard.length ? (heard.length % 2 ? heard[(heard.length - 1) / 2] : (heard[heard.length / 2 - 1] + heard[heard.length / 2]) / 2) : -20;
  target = LOUDNESS ?? median;
  for (const x of levels) {
    if (!Number.isFinite(x.lkfs)) continue;   // (silent offline: left as it is)
    const g = target - x.lkfs;
    x.gain = Math.min(GAIN_UP, Math.max(GAIN_DOWN, g));
    x.capped = x.gain !== g;
  }
  const sorted = levels.filter((x) => Number.isFinite(x.lkfs)).sort((a, b) => a.lkfs - b.lkfs);
  console.log(`\nloudness (BS.1770 K-weighted, ungated, over each bar; rendered offline at 48 kHz in ${((Date.now() - t) / 1000).toFixed(1)} s): target ${target.toFixed(1)} LKFS${LOUDNESS === undefined ? ' (the median step)' : ' (--loudness)'}, gain ${GAIN_DOWN}..+${GAIN_UP} dB at most`);
  if (sorted.length) console.log(`  spread: ${sorted[0].lkfs.toFixed(1)} (${sorted[0].patch} > ${sorted[0].preset}) .. ${sorted[sorted.length - 1].lkfs.toFixed(1)} LKFS (${sorted[sorted.length - 1].patch} > ${sorted[sorted.length - 1].preset})`);
  console.log(`  ${'patch'.padEnd(15)} ${'preset'.padEnd(17)} ${'LKFS'.padStart(6)} ${'gain'.padStart(6)}`);
  let last = '';
  for (const x of levels) {
    console.log(`  ${(x.patch === last ? '' : x.patch).padEnd(15)} ${x.preset.padEnd(17)} ${(Number.isFinite(x.lkfs) ? x.lkfs.toFixed(1) : 'silent').padStart(6)} ${((x.gain >= 0 ? '+' : '') + x.gain.toFixed(1)).padStart(6)}${x.capped ? '  (capped)' : ''}`);
    last = x.patch;
  }
} else console.log('\nloudness: as the patches come (--no-normalize)');
if (flag('--dry-run')) process.exit(0);

// ---- the browser
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const children: ChildProcess[] = [];
process.on('exit', () => { for (const c of children) try { c.kill(); } catch { /* gone */ } });
for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(s, () => void (cleanup?.() ?? Promise.resolve()).catch(() => {}).finally(() => process.exit(130)));
const freePort = (): Promise<number> => new Promise((res) => {
  const s = createServer();
  s.listen(0, '::1', () => { const a = s.address(); const p = typeof a === 'object' && a ? a.port : 0; s.close(() => res(p)); });
});
const answers = async (u: string): Promise<boolean> => {
  try { return (await fetch(u, { signal: AbortSignal.timeout(1500) })).ok; } catch { return false; }
};

/** the page's Web MIDI: no ports at all (a connected FM-1 is never seen, so nothing reaches it) */
const NO_MIDI = (): void => {
  const none = { inputs: new Map(), outputs: new Map(), sysexEnabled: true, onstatechange: null, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false };
  Object.defineProperty(Navigator.prototype, 'requestMIDIAccess', { configurable: true, value: () => Promise.resolve(none) });
};
/** The output, on whatever feeds the speakers (after MASTER): with `normalize`, it goes through the demo's gain (set by
 *  __demoGain(dB), eased in over about 20 ms) and a limiter (-3 dBFS, 20:1, 1 ms / 100 ms; its automatic make-up gain
 *  taken back off, so it is level below the threshold) before the speakers. An analyser on each channel of what reaches
 *  the speakers gives the peak and the K-weighted mean square (BS.1770, as the offline measure), read and reset by
 *  __demoLevel(). */
const TAP = (normalize: boolean): void => {
  const connect = AudioNode.prototype.connect as (this: AudioNode, ...a: unknown[]) => unknown;
  (AudioNode.prototype as unknown as { connect: unknown }).connect = function (this: AudioNode & { tapped?: true }, ...a: unknown[]) {
    if (!(a[0] instanceof AudioDestinationNode) || this.tapped) return connect.apply(this, a);
    this.tapped = true;
    const ctx = this.context;
    let out: AudioNode = this;
    if (normalize) {
      const gain = ctx.createGain();
      const lim = ctx.createDynamicsCompressor();
      lim.threshold.value = -3; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = 0.001; lim.release.value = 0.1;
      // (the Web Audio compressor adds make-up gain: (1 / its gain at 0 dBFS) ^ 0.6, Blink's and the spec's rule)
      const full = 10 ** ((-3 + 3 / 20) / 20);
      const trim = ctx.createGain();
      trim.gain.value = full ** 0.6;
      connect.call(this, gain); connect.call(gain, lim); connect.call(lim, trim);
      out = trim;
      (window as unknown as { __demoGain: (db: number) => void }).__demoGain = (db) => gain.gain.setTargetAtTime(10 ** (db / 20), ctx.currentTime, 0.02);
    }
    const r = connect.call(out, a[0]);
    // the level meter: per channel, the samples since the last read (an analyser holds the last 2048)
    const split = ctx.createChannelSplitter(2);
    connect.call(out, split);
    const sr = ctx.sampleRate;
    const kw = (f0: number, q: number, shelf: boolean): IIRFilterNode => {
      const K = Math.tan((Math.PI * f0) / sr), a0 = 1 + K / q + K * K;
      const Vh = 10 ** (3.999843853973347 / 20), Vb = Vh ** 0.4996667741545416;
      const b = shelf ? [Vh + (Vb * K) / q + K * K, 2 * (K * K - Vh), Vh - (Vb * K) / q + K * K] : [1, -2, 1].map((x) => x * a0);
      return ctx.createIIRFilter(b.map((x) => x / a0), [1, (2 * (K * K - 1)) / a0, (1 - K / q + K * K) / a0]);
    };
    const meters = [0, 1].map((ch) => {
      const raw = ctx.createAnalyser(), kd = ctx.createAnalyser();
      raw.fftSize = kd.fftSize = 2048;
      const k1 = kw(1681.974450955533, 0.7071752369554196, true), k2 = kw(38.13547087602444, 0.5003270373238773, false);
      connect.call(split, raw, ch); connect.call(split, k1, ch); connect.call(k1, k2); connect.call(k2, kd);
      return { raw, kd, rb: new Float32Array(2048), kb: new Float32Array(2048) };
    });
    let peak = 0, sum = 0, count = 0, then = ctx.currentTime;
    setInterval(() => {
      const now = ctx.currentTime;
      const n = Math.min(2048, Math.round((now - then) * sr));
      then = now;
      if (n <= 0) return;
      for (const m of meters) {
        m.raw.getFloatTimeDomainData(m.rb); m.kd.getFloatTimeDomainData(m.kb);
        for (const v of m.rb) peak = Math.max(peak, Math.abs(v));
        for (let i = 2048 - n; i < 2048; i++) sum += m.kb[i] * m.kb[i];
      }
      count += n;
    }, 20);
    (window as unknown as { __demoLevel: () => { peak: number; ms: number } }).__demoLevel = () => {
      const x = { peak, ms: count ? sum / count : 0 };
      peak = 0; sum = 0; count = 0;
      return x;
    };
    return r;
  };
};
/** the Emulator view alone, filling the window under the demo's caption: no sidebar, status line, deck, switch or hint,
 *  and no "Over the FM-1 budget" card over the panel (a factory patch near the budget can show one: it still plays) */
const CLEAN = `
#fm1-view { position: fixed !important; inset: 0 !important; z-index: 2147483000 !important; overflow: hidden !important;
  padding-top: 10vh !important; box-sizing: border-box !important; }
#fm1-view .fm1-hint, #fm1-view .fm1-follow, #fm1-view .fm1-chip, #fm1-view .fm1-alert { display: none !important; }
.sidebar, .mobile-bar, .tutorial-offer, #view-switch, #library-tabs, #fm1-connect, .statusline, .deck, .dock-wrap, #wheels, .help-btn, .side-collapse { visibility: hidden !important; }
#fm1-view .fm1-body { width: min(94vw, calc(84vh * 1280 / 678)) !important; }
#demo-caption { position: fixed; top: 3vh; left: 0; right: 0; z-index: 2147483001; text-align: center; pointer-events: none;
  font: 700 5.4vh/1 'Barlow Condensed', 'Barlow Semi Condensed', system-ui, sans-serif; letter-spacing: .04em;
  text-transform: uppercase; color: var(--ink, #1d2a2b); }
#demo-caption span { margin-left: .7em; font-weight: 500; font-size: .66em; letter-spacing: .02em; text-transform: none; color: var(--muted, #6b6b62); }
`;

async function main(): Promise<void> {
  let url = opt('--url');
  if (!url) {
    url = 'http://[::1]:5173/';
    if (!(await answers(url))) {
      // no dev server on 5173: one of this checkout on a free port (never a second one on 5173)
      const port = await freePort();
      if (!existsSync(join(WEB, 'public/fm1-ui.wasm')) && spawnSync('npm', ['run', '-s', 'fm1-wasm'], { cwd: WEB, stdio: 'inherit' }).status !== 0)
        throw new Error('npm run fm1-wasm failed (the Emulator view needs public/fm1-ui.wasm)');
      const vite = spawn('npx', ['vite', '--port', String(port), '--strictPort', '--host', '::1'], { cwd: WEB, stdio: ['ignore', 'pipe', 'inherit'] });
      children.push(vite);
      url = `http://[::1]:${port}/`;
      await new Promise<void>((res) => vite.stdout!.on('data', (d) => { if (/ready in|Local:/.test(String(d))) res(); }));
      console.log(`\nno dev server answered on [::1]:5173: started one of this checkout on ${url}`);
    }
  }
  if (!url.endsWith('/')) url += '/';
  if (!(await answers(`${url}fm1-ui.wasm`))) throw new Error(`${url}fm1-ui.wasm is missing: run npm run fm1-wasm in that server's web/`);
  console.log(`editor: ${url}`);
  mkdirSync(OUT, { recursive: true });
  if (flag('--shots')) for (const f of readdirSync(OUT)) if (f.endsWith('.png')) rmSync(join(OUT, f));   // (the last run's)

  const headless = flag('--headless');
  const browser = await chromium.launch({ channel: 'chrome', headless, ignoreDefaultArgs: ['--enable-automation'], args: ['--autoplay-policy=no-user-gesture-required', `--window-size=${W},${H + 88}`] });
  const context = await browser.newContext({ viewport: { width: W, height: H } });
  await context.addInitScript(NO_MIDI);
  await context.addInitScript(TAP, NORMALIZE);
  // (the browser is Playwright's own, with a new empty profile that is deleted when it closes: nothing it stores reaches
  // the owner's Chrome, whatever origin it opens)
  const page = await context.newPage();
  cleanup = () => browser.close();
  // --wasm FILE: the Emulator view runs this build of the FM-1's UI instead of the server's (a server whose
  // public/fm1-ui.wasm is older than its firmware sources)
  const wasm = opt('--wasm');
  if (wasm) {
    const file = resolve(process.cwd(), wasm);
    if (!existsSync(file)) throw new Error(`--wasm ${wasm}: no such file (npm run fm1-wasm writes public/fm1-ui.wasm)`);
    await page.route('**/fm1-ui.wasm', (r) => r.fulfill({ path: file, contentType: 'application/wasm' }));
    console.log(`fm1-ui.wasm: ${file}`);
  }
  page.on('pageerror', (e) => console.log(`  page error: ${e.message}`));
  await page.goto(`${url}#emu`);
  await page.waitForFunction(() => !!(window as unknown as { __m1test?: unknown }).__m1test, null, { timeout: 30000 });
  await page.keyboard.press('Escape');   // a welcome card or dialog of a first visit
  await page.addStyleTag({ content: CLEAN });
  // the caption: the demo's own, over the panel (the FM-1 names a patch only when PRESET or a program change loads it)
  await page.evaluate(() => { const c = document.createElement('div'); c.id = 'demo-caption'; document.body.append(c); });
  const call = <R>(f: string, ...a: unknown[]): Promise<R> => page.evaluate(([f, a]) => {
    const t = (window as unknown as { __m1test: Record<string, (...x: unknown[]) => unknown> }).__m1test;
    if (typeof t[f as string] !== 'function') throw new Error(`the page has no __m1test.${f as string}: is it a dev server of a checkout with the demo hook?`);
    return t[f as string](...(a as unknown[]));
  }, [f, a] as const) as Promise<R>;
  type EmuState = { loaded: string; device: number; page: number; octave: number };
  const emuState = (): Promise<EmuState> => call<EmuState>('emu');
  await page.waitForFunction(() => document.querySelector('.fm1-lcd') !== null, null, { timeout: 15000 });
  for (let t = Date.now(); (await emuState()).device < 0 && Date.now() - t < 15000; ) await sleep(100);

  // The controls: the panel's own elements and handlers, as a person's input reaches them. Encoders get wheel events
  // (fm1-view.ts: one click each), keys and buttons pointer events (two keys at once for a chord, which one mouse cannot
  // do). A preset's whole bar (OCT- / OCT+, the PRESET click, the check, its notes, the peak) is one call into the page,
  // timed there against the plan's clock (Date.now() is the same clock on both sides): a busy page costs no round trips.
  type Now = { name: string; off: number; rows: number } | null;
  interface Bar { t: number; end: number; gain: number | null; oct: number; clicks: number; engine: string | null; want: string | null; events: Ev[]; beatMs: number; pattern: boolean; start: boolean; stop: boolean; caption: [string, string] }
  const step = (s: Bar): Promise<{ now: Now; peak: number; ms: number; k: number; loaded: string; octave: number }> => page.evaluate(async (s) => {
    const w = window as unknown as { __m1test: { presetNow(l: string): Now; emu(): { loaded: string; octave: number } }; __demoLevel?: () => { peak: number; ms: number }; __demoGain?: (db: number) => void };
    const until = (t: number): Promise<void> => new Promise((r) => setTimeout(r, Math.max(0, t - Date.now())));
    const wheel = (label: string, clicks: number): void => {
      const d = document.querySelector(`#fm1-view [aria-label="${label} encoder"]`);
      for (let i = 0; i < Math.abs(clicks); i++) d?.dispatchEvent(new WheelEvent('wheel', { deltaY: clicks > 0 ? -100 : 100, bubbles: true, cancelable: true }));
    };
    const pointer = (el: Element | null, type: string, id: number): void => {
      el?.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: id, pointerType: 'touch', isPrimary: false }));
    };
    const key = (k: number, type: string): void => pointer(document.querySelector(`#fm1-view .fm1-key[aria-label="key ${k + 1}"]`), type, 100 + k);
    const button = (label: string): void => {
      const b = [...document.querySelectorAll('#fm1-view .fm1-btn')].find((x) => x.textContent === label) ?? null;
      pointer(b, 'pointerdown', 99);
      pointer(b, 'pointerup', 99);
    };
    const cap = document.getElementById('demo-caption');
    // a bar line: the octave and the preset just before it (a pattern's preset on it, so its beat stays whole)
    await until(s.pattern ? s.t : s.t - 80);
    for (let o = w.__m1test.emu().octave; o > s.oct; o--) button('Oct-');
    for (let o = w.__m1test.emu().octave; o < s.oct; o++) button('Oct+');
    wheel('Presets', s.clicks);
    if (s.gain !== null) w.__demoGain?.(s.gain);   // (the step's level, from the offline measure)
    let now = s.engine ? w.__m1test.presetNow(s.engine) : null;
    // (a patch whose values matched no preset as it came: the first click lands on Init, one more goes on)
    if (s.want && s.want !== 'Init' && now?.name === 'Init' && !now.off) { wheel('Presets', 1); now = w.__m1test.presetNow(s.engine!); }
    if (cap) cap.innerHTML = `${s.caption[0]}${s.caption[1] ? `<span>${s.caption[1]}</span>` : ''}`;
    if (s.start) button('PLAY');
    // (the patch the emulated FM-1 runs after the click: another one means PRESET stepped patches, not presets)
    const loaded = w.__m1test.emu().loaded;
    await until(s.t);
    // late (a slow page): the notes are squeezed into what is left of the bar, by half at most
    const k = s.events.length ? Math.min(1, Math.max(0.5, (s.end - Date.now()) / (s.end - s.t))) : 1;
    const t0 = Date.now();
    const on = s.events.map((e) => ({ ...e, down: t0 + e.at * s.beatMs * k, up: t0 + (e.at + e.len) * s.beatMs * k - Math.min(100, e.len * s.beatMs * k * 0.25) }));
    const edges = [...on.map((e) => ({ t: e.down, keys: e.keys, type: 'pointerdown' })), ...on.map((e) => ({ t: e.up, keys: e.keys, type: 'pointerup' }))].sort((a, b) => a.t - b.t);
    for (const e of edges) {
      await until(e.t);
      for (const n of e.keys) key(n, e.type);
    }
    await until(s.end - (s.pattern ? 0 : 80));
    if (s.stop) button('PLAY');
    const lv = w.__demoLevel?.() ?? { peak: -1, ms: 0 };
    return { now, peak: lv.peak, ms: lv.ms, k, loaded, octave: w.__m1test.emu().octave };
  }, s);
  /** Main's tempo, as the FM-1 sets it: PLAY held + PRESET (1 bpm a click, 5 when turned fast), read back from the editor
   *  (the emulated FM-1 sends it on); demo only: the patch is never stored */
  const setTempo = (bpm: number): Promise<number> => page.evaluate(async (bpm) => {
    const w = window as unknown as { __m1test: { patchJson(): string } };
    const now = (): number => Math.round((JSON.parse(w.__m1test.patchJson()) as { modules: { type: string; params: { tempo?: number } }[] }).modules.find((m) => m.type === 'fm1')?.params.tempo ?? 0);
    const d = document.querySelector('#fm1-view [aria-label="Presets encoder"]');
    const play = [...document.querySelectorAll('#fm1-view .fm1-btn')].find((x) => x.textContent === 'PLAY') ?? null;
    const pointer = (type: string): void => { play?.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 98, pointerType: 'touch', isPrimary: false })); };
    pointer('pointerdown');
    let last = 0, lastDir = 0;
    for (let i = 0; i < 60 && now() !== bpm; i++) {
      const dir = Math.sign(bpm - now());
      // (a click within 80 ms of one the same way counts 5: near the target, wait that out)
      if (Math.abs(bpm - now()) < 5 && dir === lastDir) await new Promise((r) => setTimeout(r, Math.max(0, 90 - (performance.now() - last))));
      d?.dispatchEvent(new WheelEvent('wheel', { deltaY: dir > 0 ? -100 : 100, bubbles: true, cancelable: true }));
      last = performance.now();
      lastDir = dir;
    }
    pointer('pointerup');   // (a release after PLAY held + PRESET neither starts nor stops)
    return now();
  }, bpm);

  // the audio starts with the first press on the panel (as for a person): a click on the screen's bezel
  await page.locator('.fm1-bezel').click();
  for (let t = Date.now(); !(await page.evaluate(() => typeof (window as unknown as { __demoLevel?: unknown }).__demoLevel === 'function')) && Date.now() - t < 5000; ) await sleep(100);
  const peak = (): Promise<unknown> => page.evaluate(() => (window as unknown as { __demoLevel?: () => unknown }).__demoLevel?.());

  const open = async (it: Item): Promise<void> => {
    await page.evaluate((n) => { const c = document.getElementById('demo-caption'); if (c) c.textContent = n; }, it.name);
    if (!(await call<boolean>('openFactory', it.name))) throw new Error(`the page has no factory patch ${it.name}`);
    const want = it.name.toUpperCase();
    for (let t = Date.now(); (await emuState()).loaded !== want && Date.now() - t < 5000; ) await sleep(20);
    if ((await emuState()).loaded !== want) console.log(`  warning: the emulated FM-1 did not take ${it.name}`);
    // the engine's device in focus (a fresh patch starts on its first instrument, which is it in every factory patch)
    for (let i = 0; i < 8 && it.device >= 0; i++) {
      const d = (await emuState()).device;
      if (d === it.device) break;
      await page.evaluate(([n]) => {
        const e = document.querySelector('#fm1-view [aria-label="Select encoder"]');
        for (let j = 0; j < Math.abs(n); j++) e?.dispatchEvent(new WheelEvent('wheel', { deltaY: n > 0 ? -100 : 100, bubbles: true, cancelable: true }));
      }, [it.device - d]);
      await sleep(40);
    }
    await peak();   // (from here on: this patch's)
  };
  /** PRESET alone steps the focused device's presets since firmware #395 (2026-10-29); in an older build of the FM-1's
   *  UI it steps the patches, and every step after it plays another patch: stop and say how to get a current build */
  const stale = (it: Item, loaded: string): void => {
    if (loaded === it.name.toUpperCase()) return;
    throw new Error(`PRESET opened another patch (${loaded}) instead of ${it.name}'s next preset: the server's fm1-ui.wasm is older than #395 (PRESET alone steps the device's presets). Run npm run fm1-wasm in that server's web/ (the page loads it on the next run, no restart needed), or pass --wasm public/fm1-ui.wasm after npm run fm1-wasm in this checkout`);
  };
  const says = (want: string, now: Now): string => (now?.name === want && !now.off ? '' : now ? `  (the engine is nearest ${now.name}: ${now.off} of its ${now.rows} rows differ)` : '  (no preset matched)');

  const shots = flag('--shots');
  const report: { patch: string; preset: string; ok: boolean; peak: number; live: number; capped: boolean }[] = [];
  /** the steps' gains (dB), in play order (null: --no-normalize) */
  let li = 0;
  const nextLevel = (): Level | null => (NORMALIZE ? levels[li++] : null);
  const db = (r: { ms: number }): string => (r.ms > 0 ? `${lkfs(r.ms).toFixed(1)} LKFS` : 'silent');
  const gainSays = (lv: Level | null): string => (lv ? `  gain ${(lv.gain >= 0 ? '+' : '') + lv.gain.toFixed(1)}${lv.capped ? ' (capped)' : ''}` : '');
  const t0 = Date.now() + 1000;   // (a second to settle: the first beat is the first patch's load)
  let at = 0;   // the plan's clock, in beats from t0
  const ms = (b: number): number => t0 + b * beatMs;
  const lateBy = (b: number): number => Date.now() - ms(b);
  let shotN = 0;
  const shot = (name: string, when: number): void => {
    const n = ++shotN;
    setTimeout(() => void page.screenshot({ path: join(OUT, `${String(n).padStart(2, '0')}-${name.replace(/[^\w-]+/g, '_')}.png`) }).catch(() => {}), Math.max(0, when - Date.now()));
  };
  const stamp = (): string => `${((Date.now() - t0) / 1000).toFixed(1).padStart(6)} s`;
  let loadLate = 0;

  console.log(`\nplaying (${mmss(totalS)} planned, ${tempo} bpm)`);
  await sleep(Math.max(0, t0 - Date.now()));
  for (const [n, it] of keyboard.entries()) {
    await open(it);
    loadLate = Math.max(loadLate, lateBy(at + LOAD_BEATS) + 80);
    at += LOAD_BEATS;
    for (const [j, name] of it.presets.entries()) {
      const p = parts[n][j];
      if (shots && j === 1) shot(`${it.name}-${name}`, ms(at + Math.min(1, p.beats / 2)));
      const lv = nextLevel();
      const r = await step({ t: ms(at), end: ms(at + p.beats), gain: lv?.gain ?? null, oct: p.oct, clicks: 1, engine: it.engine, want: name, events: p.events, beatMs, pattern: false, start: false, stop: false, caption: [it.name, name!] });
      stale(it, r.loaded);
      at += p.beats;
      report.push({ patch: it.name, preset: name!, ok: r.now?.name === name && !r.now.off, peak: r.peak, live: lkfs(r.ms), capped: !!lv?.capped });
      console.log(`  ${stamp()}  ${it.name} > ${name} [${p.role}]${says(name!, r.now)}  peak ${r.peak.toFixed(3)}, ${db(r)}${gainSays(lv)}${r.k < 0.9 ? `  (notes at ${(r.k * 100).toFixed(0)} %: late)` : ''}${r.octave !== p.oct ? `  (octave ${r.octave}, not ${p.oct})` : ''}`);
    }
  }
  for (const it of drums) {
    await open(it);
    const got = await setTempo(tempo);
    if (got !== tempo) console.log(`  warning: ${it.name}'s tempo is ${got}, not ${tempo}`);
    loadLate = Math.max(loadLate, lateBy(at + PATTERN_LOAD_BEATS));
    at += PATTERN_LOAD_BEATS;
    for (const [j, name] of it.presets.entries()) {
      if (shots && j === 0) shot(`${it.name}-${name ?? 'pattern'}`, ms(at + DRUM_BEATS / 2));
      const last = j === it.presets.length - 1;
      const lv = nextLevel();
      const r = await step({ t: ms(at), end: ms(at + DRUM_BEATS), gain: lv?.gain ?? null, oct: (await emuState()).octave, clicks: name ? 1 : 0, engine: name ? it.engine : null, want: name, events: [], beatMs,
        pattern: true, start: j === 0, stop: last, caption: [it.name, name ?? ''] });
      stale(it, r.loaded);
      at += DRUM_BEATS;
      report.push({ patch: it.name, preset: name ?? '(pattern)', ok: !name || (r.now?.name === name && !r.now.off), peak: r.peak, live: lkfs(r.ms), capped: !!lv?.capped });
      console.log(`  ${stamp()}  ${it.name} > ${name ?? '(its pattern)'}${name ? says(name, r.now) : ''}  peak ${r.peak.toFixed(3)}, ${db(r)}${gainSays(lv)}`);
    }
  }
  const took = (Date.now() - t0) / 1000;
  const silent = report.filter((r) => r.peak >= 0 && r.peak < 0.002);
  const wrong = report.filter((r) => !r.ok);
  console.log(`\ndone: ${took.toFixed(1)} s played, ${totalS.toFixed(1)} s planned (${(took - totalS >= 0 ? '+' : '') + (took - totalS).toFixed(1)} s); the slowest load ran ${loadLate > 0 ? `${loadLate.toFixed(0)} ms into its first bar` : 'on time'}`);
  console.log(`${report.length} steps; silent: ${silent.length ? silent.map((r) => `${r.patch} > ${r.preset}`).join(', ') : 'none'}; preset not confirmed in the editor: ${wrong.length ? wrong.map((r) => `${r.patch} > ${r.preset}`).join(', ') : 'none'}`);
  const heard = report.filter((r) => Number.isFinite(r.live)).sort((a, b) => a.live - b.live);
  if (heard.length) {
    const lo = heard[0], hi = heard[heard.length - 1], mid = heard[Math.floor(heard.length / 2)];
    const loudest = [...report].sort((a, b) => b.peak - a.peak)[0];
    console.log(`at the speakers (${NORMALIZE ? `evened out to ${target.toFixed(1)} LKFS` : 'as the patches come'}): ${lo.live.toFixed(1)} (${lo.patch} > ${lo.preset}) .. ${hi.live.toFixed(1)} LKFS (${hi.patch} > ${hi.preset}) a bar, median ${mid.live.toFixed(1)}; the highest peak ${loudest.peak.toFixed(3)} (${loudest.patch} > ${loudest.preset})${NORMALIZE ? `; capped: ${report.filter((r) => r.capped).map((r) => `${r.patch} > ${r.preset}`).join(', ') || 'none'}` : ''}`);
  }
  if (shots) console.log(`screenshots: ${OUT}`);
  await sleep(1200);
}

/** closes the browser (set once it is open) */
let cleanup: (() => Promise<void>) | null = null;
main().then(
  async () => { await cleanup?.(); process.exit(0); },
  async (e: Error) => { console.error(`demo: ${e.message}`); await cleanup?.().catch(() => {}); process.exit(1); },
);
