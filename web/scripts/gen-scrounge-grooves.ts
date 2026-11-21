// SPDX-License-Identifier: GPL-3.0-only
// Scrounge's grooves after its first six (factory/bank.json, D-1056): patterns 7 on of its tracks, and song 2, which chains
// them. They play what the first six do not: the Scrooge's per-step CHOP (a Steps ratchet, #675: the step's curve fires 2
// to 5 times inside its step), its per-step TIME (micro timing, #677: the curve starts up to 23/24 of a step late) and its
// tracks' own lengths under LEN GLB. Patterns 1 to 6 and song 1 stay as they are. Four grooves, so the patch keeps some
// room for a player's own notes (the owner, 2026-11-20).
// Run from web/:  npx vite-node scripts/gen-scrounge-grooves.ts
// then gen-presets.ts, legacy-factory.ts and npm run export-defs.
import { readFileSync, writeFileSync } from 'node:fs';
import { DEFS } from '../src/modules';
import { validatePatch, type ModuleInst, type Patch } from '../src/patch';
import { ACCENT_VEL, STEP_VEL, type Pattern, type StepNote } from '../src/track';

/** each track's key (its Drum map row's), by track name */
const KEY: Record<string, number> = { 'VOICE 1': 53, 'VOICE 2': 55, 'VOICE 3': 57, 'VOICE 4': 59, 'VOICE 5': 60, 'MOD X': 62, 'MOD Y': 64, 'LEN GLB': 60 };
/** the grooves before these: patterns 1 to FIRST */
const FIRST = 6;

/** one track of a groove: a step per character (`.` a rest, `o` a soft POKE, `x` the default, `X` the hardest), its length
 *  the string's; `chop` a step's ratchet, `time` a step's micro timing in 24ths of a step */
interface Lane { steps: string; chop?: Record<number, number>; time?: Record<number, number> }
/** a track left out plays its pattern 1 row */
type Groove = Record<string, string | Lane>;

const POKE: Record<string, number> = { o: 64, x: STEP_VEL, X: ACCENT_VEL };

const GROOVES: Groove[] = [
  // 7, Chopped Dust: Dusty Boom Bap with CHOP rolls on the high hit and the snare laid back by TIME
  {
    'VOICE 1': 'X..x......x..x..',
    'VOICE 2': { steps: '..x...x.x.x.x.xx', chop: { 10: 2, 14: 3, 15: 4 } },
    'VOICE 3': { steps: '....X.......X...', time: { 4: 5, 12: 5 } },
  },
  // 8, Ratchet Techno: four on the floor with a kick stutter into the next bar, chopped hits and a growl that chops harder
  {
    'VOICE 1': { steps: 'X...X...X...X..x', chop: { 15: 2 } },
    'VOICE 2': { steps: '..X...X...X...X.', chop: { 6: 2, 14: 3 } },
    'VOICE 3': { steps: '....x.......x...', chop: { 12: 2 } },
    'VOICE 4': { steps: 'x..x..x..x..x.x.', chop: { 12: 3, 14: 5 } },
    'VOICE 5': '................',
  },
  // 9, Flam Shuffle: every off-beat high hit a third of a step late (a triplet shuffle), the snare's soft step before it
  // TIMEd onto it (the manual's trick of two steps played as one: here a flam)
  {
    'VOICE 1': 'X.....x...X.....',
    'VOICE 2': { steps: '.x.x.x.x.x.x.x.x', time: { 1: 8, 3: 8, 5: 8, 7: 8, 9: 8, 11: 8, 13: 8, 15: 8 } },
    'VOICE 3': { steps: '...oX......oX...', time: { 3: 20, 11: 20 } },
    'VOICE 4': '................',
    'VOICE 5': 'x.......x.....x.',
  },
  // 10, Odd Lengths: each track its own length (the Scrooge's LEN TRK), all back to step 1 after 32 steps (LEN GLB); no
  // CHOP, which put its busiest steps near the FM-1's CPU limit (the owner, 2026-11-20)
  {
    'VOICE 1': 'X.....x...X.....',
    'VOICE 2': 'x.x.xx.',
    'VOICE 3': '....X.....x.',
    'VOICE 4': 'x..o.',
    'VOICE 5': 'x...x..x.',
    'MOD X': 'x.....x....',
    'MOD Y': 'x............',
    'LEN GLB': 'x' + '.'.repeat(31),
  },
];

function pattern(t: ModuleInst, lane: string | Lane): Pattern {
  const { steps, chop = {}, time = {} } = typeof lane === 'string' ? { steps: lane } : lane;
  const notes = [...steps].flatMap((c, at): StepNote[] => {
    if (c === '.') return [];
    if (!POKE[c]) throw new Error(`${t.name}: step ${at} is '${c}'`);
    return [{ at, len: 1, note: KEY[t.name!], vel: POKE[c], ...(chop[at] ? { ratchet: chop[at] } : {}), ...(time[at] ? { micro: time[at] } : {}) }];
  });
  for (const at of [...Object.keys(chop), ...Object.keys(time)]) if (steps[Number(at)] === '.' || steps[Number(at)] === undefined) throw new Error(`${t.name}: no hit on step ${at} to time`);
  return { notes, ...(steps.length !== t.params.len ? { len: steps.length } : {}) };
}

const file = new URL('../factory/bank.json', import.meta.url);
const bank = JSON.parse(readFileSync(file, 'utf8')) as { name: string; patch: Patch }[];
const entry = bank.find((e) => e.name === 'Scrounge');
if (!entry) throw new Error('factory/bank.json has no Scrounge');
const tracks = entry.patch.modules.filter((m) => m.type === 'steps');
for (const g of GROOVES) for (const name of Object.keys(g)) if (!tracks.some((t) => t.name === name)) throw new Error(`Scrounge has no track ${name}`);
for (const t of tracks) {
  // (patterns 2 to FIRST as they are, a track without them padded with its pattern 1; then one per groove)
  const kept = Array.from({ length: FIRST - 1 }, (_, j) => t.patterns?.[j] ?? null);
  const added = GROOVES.map((g) => (g[t.name!] === undefined ? null : pattern(t, g[t.name!])));
  t.patterns = [...kept, ...added] as Pattern[];
  while (t.patterns.length && !t.patterns.at(-1)) t.patterns.pop();
  if (!t.patterns.length) delete t.patterns;
}
const main = entry.patch.modules.find((m) => m.type === 'fm1')!;
const songs = main.seq!.songs!;
songs.length = 1;
songs.push(GROOVES.map((_, j) => ({ pat: FIRST + j, shift: 0 })));
entry.patch = validatePatch(entry.patch, DEFS);
writeFileSync(file, JSON.stringify(bank, null, 1) + '\n');
console.log(`Scrounge: patterns 1 to ${FIRST + GROOVES.length}, song 2 chains ${FIRST + 1} to ${FIRST + GROOVES.length}`);
