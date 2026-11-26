// SPDX-License-Identifier: GPL-3.0-only
// The FM-1 reader's round trip (patch-reader.ts, D-1354): every golden kit (every factory and example patch among them,
// scripts/golden.ts) and every Community patch is encoded, read back and encoded again. It reports the patches whose
// second binary differs from the first, those that render differently in the browser engine, and how many come back with
// every assembly device recognised from the definitions this browser would have (the factory set, and the assemblies of the
// other patches of the set: "the assemblies in the browser's patches"), some of them, or none.
// Run from web/:  GOLDEN_PATCHES=../build/golden-patches.json npx vite-node scripts/golden.ts
//                 npx vite-node scripts/reader-roundtrip.ts [../build/golden-patches.json] [--only NAME] [--no-render]
import { readFileSync } from 'node:fs';
import { Engine } from '../src/engine';
import { DEFS, DEVICE_SR } from '../src/modules';
import { deviceBudget, encodePatch, Q, toQ16 } from '../src/patchbin';
import { readFromFm1 } from '../src/patch-reader';
import { shippedLibrary } from '../src/assembly-match';
import { assembliesOf, parentOf, toDef, type AssemblyDef } from '../src/assembly';
import { deviceView } from '../src/poly';
import { encodePayload } from '../src/pattern-store';
import { validatePatch, type Patch } from '../src/patch';
import { communityEntries } from '../src/community';
import { decodeShare } from '../src/share';
import { devicesOf } from '../src/pages';
import { parseBinary } from '../src/bin-parse';

type Ev = [number, string, number, number?];
interface Kit { name: string; patch: Patch; events: Ev[] | null; end: number | null; force: number; custom: boolean }

const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : undefined;
const render = !args.includes('--no-render');
const file = args.find((a) => a.endsWith('.json')) ?? '../build/golden-patches.json';
const kits: Kit[] = JSON.parse(readFileSync(file, 'utf8'));
for (const entry of communityEntries()) {
  try {
    kits.push({ name: `community: ${entry.title}`, patch: await decodeShare(entry.code, DEFS), events: null, end: null, force: 0, custom: false });
  } catch { /* an entry this editor cannot decode */ }
}

const EVENTS: Ev[] = [[0, 'on', 60], [128 * 40, 'on', 67], [128 * 80, 'off', 67], [128 * 120, 'off', 60]];
/** the patch at the precision the binary holds it (Q16.16 values, a parameter at its default as written its exact default,
 *  macro range and MIDI mapping ends in 1/255): what the FM-1 plays of it, so what a patch read back plays in the browser */
function held(src: Patch): Patch {
  const p = structuredClone(src);
  const q = (v: number, d = NaN): number => (toQ16(v) === toQ16(d) ? d : toQ16(v) / Q);
  const e = (v: number): number => Math.round(v * 255) / 255;
  for (const m of p.modules) {
    const def = (k: string): number | undefined => DEFS[m.type]?.params.find((x) => x.name === k)?.default;
    for (const k of Object.keys(m.params)) m.params[k] = q(m.params[k], def(k));
    if (m.paramsB) for (const k of Object.keys(m.paramsB)) m.paramsB[k] = q(m.paramsB[k], def(k));
    if (m.att) m.att = [q(m.att[0]), q(m.att[1])];
    for (const s of ['p1', 'p2'] as const) for (const r of Object.values(m.range?.[s] ?? {})) { r[0] = e(r[0]); r[1] = e(r[1]); }
    for (const l of [...(m.locks ?? []), ...(m.patterns ?? []).flatMap((x) => x?.locks ?? [])]) l.value = q(l.value);
  }
  for (const b of p.midiLearn ?? []) { if (b.lo !== undefined) b.lo = e(b.lo); if (b.hi !== undefined) b.hi = e(b.hi); }
  return p;
}
function play(p: Patch, evs: Ev[], end: number, ids: (sourceIndex: number) => number | undefined): Float32Array {
  const e = new Engine(DEVICE_SR);
  e.load(p, true);   // (the device form, which the binary is: the dead modules the compile pass drops are not in it)
  const out = new Float32Array(2 * end);
  let pos = 0;
  const seg = (to: number): void => {
    if (to <= pos) return;
    const a = new Float32Array(to - pos), b = new Float32Array(to - pos);
    e.render(a, b);
    for (let i = 0; i < a.length; i++) { out[2 * (pos + i)] = a[i]; out[2 * (pos + i) + 1] = b[i]; }
    pos = to;
  };
  for (const [fr, kind, note, ch] of evs) {
    seg(fr);
    if (kind === 'arm') e.arm(note < 0 ? null : ids(note) ?? null);
    else if (kind === 'rec') { const id = ids(note); if (id !== undefined) e.setRec(id, !!ch); }
    else if (kind === 'thon' || kind === 'thoff') { const id = ids(note); if (id !== undefined) e.thru(id, ch ?? 60, kind === 'thon' ? 100 : 0); }
    else if (kind === 'cc') e.cc(note, ch ?? 0);
    else if (kind === 'pat') e.setPattern(note);
    else if (kind === 'song') e.setSong(note);
    else if (kind === 'on') e.noteOn(note, 1, ch ?? 1);
    else if (kind === 'von') e.noteOn(note, (ch ?? 127) / 127, 1);
    else if (kind === 'at') e.aftertouch(note / 127);
    else if (kind === 'off') e.noteOff(note, ch ?? 1);
    else if (kind === 'kon') e.noteOn(note, 1, 1, true);
    else if (kind === 'koff') e.noteOff(note, 1, true);
    else if (kind === 'cbon' || kind === 'cboff') e.chordButton(note, kind === 'cbon');
    else if (kind === 'bon' || kind === 'boff') e.setButton(note, kind === 'bon');
    else if (kind === 'ext' || kind === 'int') e.clockExternal(kind === 'ext');
    else if (kind === 'tick') e.clockTick();
    else if (kind === 'once') e.playOnce();
    else if (kind === 'cin') e.countIn(note);
    else if (kind === 'meter') e.meter = note;
    else if (kind === 'fill') e.setFill(!!note);
    else if (kind === 'run' || kind === 'stop') e.transport(kind === 'run');
    // (arms, armx and take need the kit's own bookkeeping: such kits render without them, both sides alike)
  }
  seg(end);
  return out;
}

/** the top-level cards of a patch that are FM-1 devices */
const cardsOf = (p: Patch): number => devicesOf(p, DEFS).filter((d) => d.asm !== undefined).length;

// the assemblies "this browser" has: the factory set and those of every kit (each patch is read without its own)
const own = new Map<string, AssemblyDef[]>();
for (const k of kits) {
  try {
    const p = validatePatch(structuredClone(k.patch), DEFS);
    own.set(k.name, assembliesOf(p).filter((a) => !parentOf(p, a.id)).map((a) => toDef(p, a)));
  } catch { own.set(k.name, []); }
}
const tally = { kits: 0, skipped: 0, overBudget: 0, unread: 0, same: 0, differ: 0, rendersSame: 0, rendersDiffer: 0, full: 0, partial: 0, flat: 0, plain: 0, cards: 0, recognised: 0 };
const differ: string[] = [], renders: string[] = [], partial: string[] = [];
for (const k of kits) {
  if (only && k.name !== only) continue;
  if (k.custom) { tally.skipped++; continue; }
  tally.kits++;
  let src: Patch, bin: Uint8Array;
  try {
    src = validatePatch(structuredClone(k.patch), DEFS);
    bin = encodePatch(src, true, k.force);
  } catch (e) { tally.skipped++; tally.kits--; console.log(`skip ${k.name}: ${(e as Error).message}`); continue; }
  // (a kit over the FM-1's budget never reaches an FM-1 slot: some are written past what the format can count)
  const over = !deviceBudget(src).fits;
  if (over) tally.overBudget++;
  const tag = over ? ' [over the FM-1 budget: never in a slot]' : '';
  const patterns = new Map<number, Uint8Array>();
  const links = src.modules.find((m) => m.type === 'fm1')?.seq?.links ?? {};
  for (const [p, l] of Object.entries(links)) patterns.set(l.id, encodePayload(src, Number(p)));
  const library = [...shippedLibrary(), ...[...own].filter(([n]) => n !== k.name).flatMap(([, d]) => d)];
  const r = readFromFm1(bin, { name: src.name, library, patterns });
  if (!r) { tally.unread++; differ.push(`${k.name}: not read (${parseBinary(bin) ? 'build' : 'parse'})${tag}`); continue; }
  let again: Uint8Array | null = null;
  try { again = encodePatch(r.patch, true, k.force, 0, new Map([...patterns].map(([id, pl]) => [id, Object.values(links).find((l) => l.id === id)!.hash]))); } catch (e) { differ.push(`${k.name}: ${(e as Error).message}`); }
  const ok = !!again && again.length === bin.length && again.every((x, i) => x === bin[i]);
  if (ok) tally.same++;
  else {
    tally.differ++;
    if (again) {
      const at = again.findIndex((x, i) => x !== bin[i]);
      differ.push(`${k.name}: ${bin.length} → ${again.length} bytes, first difference at ${at < 0 ? Math.min(bin.length, again.length) : at} (format ${bin[1]} → ${again[1]})${tag}`);
    }
  }
  const c = cardsOf(src);
  tally.cards += c;
  tally.recognised += Math.min(c, r.recognised);
  if (!c) tally.plain++;
  else if (r.recognised >= c) tally.full++;
  else if (r.recognised) { tally.partial++; partial.push(`${k.name}: ${r.recognised} of ${c}`); }
  else { tally.flat++; partial.push(`${k.name}: 0 of ${c}`); }
  if (render) {
    const dev = deviceView(src, true).patch;
    const index = new Map(dev.modules.map((m, i) => [m.id, i]));
    const ids = (i: number): number | undefined => { const at = index.get(src.modules[i]?.id ?? -1); return at === undefined ? undefined : r.patch.modules.find((m) => m.id === at + 1)?.id ?? at + 1; };
    const end = k.end ?? 128 * 180;
    const a = play(held(src), k.events ?? EVENTS, end, (i) => src.modules[i]?.id);
    const b = play(r.patch, k.events ?? EVENTS, end, ids);
    let worst = 0;
    for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i] - b[i]));
    if (worst === 0) tally.rendersSame++;
    else { tally.rendersDiffer++; renders.push(`${k.name}: differs by up to ${worst.toExponential(2)}`); }
  }
}
console.log(differ.map((s) => `DIFFERS ${s}`).join('\n'));
console.log(renders.map((s) => `RENDERS ${s}`).join('\n'));
if (process.env.SHOW_PARTIAL) console.log(partial.map((s) => `CARDS ${s}`).join('\n'));
console.log(JSON.stringify(tally));
