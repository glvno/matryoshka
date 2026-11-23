// SPDX-License-Identifier: GPL-3.0-only
// The pattern sets the 808 and 909 Kits shipped with up to 1.24.1 (#923, D-829): patterns 2.. of the patch linked to
// read-only entries of the FM-1's pattern store (format 59's links section, D-1015), pattern 1 the patch's own (its
// demonstration pattern, D-882), each kit's song chaining the set. The kits ship without them now (factory-bank.ts
// UNSHIPPED_PATTERNS, #1202 G8): the bank in full keeps them as test and measurement material only. The entries
// themselves are frozen data, factory-store.json (the legacy factory patterns a saved patch may still link), which these
// grids give byte for byte (factory-kit-patterns.test.ts).
//
// A kit's entries take ids from its own first id (KIT_IDS_PER_KIT apart), pattern p (0-based, 1..) at first + p - 1.
//
// Grids: one row per drum, a character per step: `.` rest, `x` a hit, `X` an accented hit (velocity 127: the 909 Kit's
// drums that accent on their own), `f` a flam (the 909 Kit: the drum's FLAM row in place of its own row). The 808 Kit
// accents with its AC row only, as the TR-808 does.
//
// Fill-ins (#852, D-830's FILL): a pattern's `fill` names the rows that play otherwise while FILL is held, from its step
// `from` (0-based) to the bar's end; every other row and step plays as without FILL. withFill turns that into trig
// conditions: a hit the fill takes away gets NOT FILL, a hit it adds FILL, so with FILL let go the pattern plays as
// before. After the TR-808 owner's manual (p. 11-12, "Adding Intros and Fill Ins": TAP plays a fill-in rhythm once at
// the end of the measure, then the basic rhythm again; its pattern sheets "Fill in 1" to "Fill in 3": a snare lead-in,
// tom runs from high to low in pairs), a fill takes the bar's second half so holding FILL anywhere in the bar leads back
// into the rhythm's downbeat. A fill keeps its rhythm's bass drum (but MIAMI BASS's roll) and accents: a bass drum
// rings on into the next hit, and an accent lifts every drum on its step, so either would make the downbeat after the
// fill or the fill itself peak over the rhythm (D-854).
import type { Patch } from './patch';
import { deviceView } from './poly';
import { encodePayload, fnv, FNV0 } from './pattern-store';
import { ACCENT_VEL, COND_FILL, COND_NOT, STEP_VEL, type Pattern, type SongEntry, type StepNote } from './track';

/** the first read-only id of the factory patches' patterns (patlink.c PL_KIT: one above the store's user ids) */
export const KIT_FIRST_ID = 0xe000;
/** ids a kit may take: one per pattern 2..64 */
export const KIT_IDS_PER_KIT = 64;

type Grid = Record<string, string>;
/** a fill-in: from step `from` on, its rows (16 - from steps each) in place of the pattern's while FILL is held */
export interface Fill { from: number; grid: Grid }
export interface KitPattern { name: string; grid: Grid; fill?: Fill }
export interface FactoryKit {
  /** the factory patch */
  patch: string;
  /** its entries' first id */
  first: number;
  /** the stored names' prefix */
  prefix: string;
  /** each row's key (its Drum map row's note) and, for a drum that flams, its FLAM row's key */
  keys: Record<string, number>;
  flams?: Record<string, number>;
  /** patterns 2.. (pattern 1 is the patch's own) */
  patterns: KitPattern[];
  /** the patch's songs, patterns 1-based as the FM-1 shows them */
  songs: number[][];
}

/** a rhythm's A and B variations, with their fill-ins (B's is A's unless it has its own) */
const ab = (name: string, a: Grid, b: Grid, fa?: Fill, fb = fa): KitPattern[] => [{ name: `${name} A`, grid: a, fill: fa }, { name: `${name} B`, grid: b, fill: fb }];

// The TR-808's fill-ins, one per rhythm in its style (the rhythm's A and B share it, but ROCK's).
const hush = (...rows: string[]): Grid => Object.fromEntries(rows.map((r) => [r, '........']));
/** "Fill in 1" in the bar's second half: snare, then high, mid and low tom in pairs (the snare after the bass drum) */
const F_ELECTRO: Fill = { from: 8, grid: { ...hush('CP', 'CH', 'OH', 'CB'), SD: '.x......', HT: '..xx....', MT: '....xx..', LT: '......xx' } };
/** a snare roll over the four on the floor */
const F_DISCO: Fill = { from: 8, grid: { ...hush('CH', 'OH'), SD: 'x.x.xxxx' } };
/** a sixteenth snare figure with the hats, as "Fill in-1" */
const F_FUNK: Fill = { from: 8, grid: { ...hush('OH', 'CB'), SD: 'x.xx.xxx', CH: '.x..x...' } };
/** snare and clap stutter */
const F_HIPHOP: Fill = { from: 8, grid: { OH: '........', SD: '....xxxx', CP: '....x...', CH: 'x.x.....' } };
/** a rolling bass drum */
const F_MIAMI: Fill = { from: 8, grid: { ...hush('CH', 'OH', 'CB'), BD: 'x.x..xxx', SD: '......xx', CP: '....x...' } };
/** a clap roll over the four on the floor */
const F_HOUSE: Fill = { from: 8, grid: { ...hush('SD', 'CH', 'OH', 'RS', 'HT', 'MT'), CP: 'x.x.xxxx' } };
/** snare, then the toms down in sixteenths */
const F_SLOWJAM: Fill = { from: 8, grid: { ...hush('CP', 'CH', 'OH', 'RS'), SD: 'x.x.....', HT: '....x...', MT: '.....x..', LT: '......xx' } };
/** three snares after the bass drum, then the toms down */
const F_ROCK_A: Fill = { from: 8, grid: { CH: '........', SD: '.xxx....', HT: '....xx..', MT: '......x.', LT: '.......x' } };
/** (ROCK B is a tom fill already) a sixteenth snare roll after the bass drum */
const F_ROCK_B: Fill = { from: 8, grid: { ...hush('CH', 'HT', 'MT', 'LT'), SD: '.xxxxxxx' } };
/** the toms (congas with their switches) under the rim shot's clave */
const F_BOSSA: Fill = { from: 8, grid: { CH: '........', HT: 'x.x.....', MT: '...x.x..', LT: '......xx' } };
/** a snare figure over the surdo bass drum */
const F_SAMBA: Fill = { from: 8, grid: { ...hush('CH', 'CB', 'MT', 'LT', 'RS'), SD: 'x.xx.xxx' } };
/** after the drop: snare, then mid and low tom */
const F_REGGAE: Fill = { from: 8, grid: { ...hush('CH', 'OH', 'HT'), SD: '..x.xx..', MT: '......x.', LT: '.......x' } };
/** the toms down in eighths, then snare and clap */
const F_SYNTHPOP: Fill = { from: 8, grid: { ...hush('CH', 'OH', 'CB'), HT: 'x.......', MT: '..x.....', LT: '....x...', SD: '......xx', CP: '......xx' } };

// The TR-808: its 12 basic rhythms, each with an A and a B variation, after the styles the TR-808 is known for and the
// rhythm patterns of its owner's manual. Rhythm 1's A is the patch's own pattern 1 (ELECTRO A). Pattern 1 has no
// fill-in: it is the factory demonstration pattern its presets swap for their own while its notes are the factory's
// exactly (preset-patterns.ts applyPresetPattern), and those patterns hold 32 short notes at most (factory.c FC_NOTES).
const KIT808: FactoryKit = {
  patch: '808 Kit',
  first: KIT_FIRST_ID,
  prefix: '808',
  keys: { BD: 53, SD: 55, CP: 57, CH: 59, OH: 60, LT: 62, RS: 64, CB: 65, MT: 67, HT: 69, CY: 71, AC: 72 },
  patterns: [
    { name: 'ELECTRO B', fill: F_ELECTRO, grid: {
      BD: 'x...x...x.x..x..',
      SD: '....x.......x...',
      CP: '............x...',
      CH: 'x.x.x.x.x.x.x...',
      OH: '..............x.',
      CB: '..........x.....',
      MT: '............x...',
      LT: '.............x.x',
      AC: 'x.......x.......',
    } },
    ...ab('DISCO', {
      BD: 'x...x...x...x...',
      CP: '....x.......x...',
      CH: 'x...x...x...x...',
      OH: '..x...x...x...x.',
      AC: '..x...x...x...x.',
    }, {
      BD: 'x...x...x...x...',
      SD: '....x.......x.xx',
      CP: '....x.......x...',
      CH: 'xx.xxx.xxx.xxx.x',
      OH: '..x...x...x...x.',
      CY: 'x...............',
      AC: '..x...x...x...x.',
    }, F_DISCO),
    ...ab('FUNK', {
      BD: 'x.x....x..x.....',
      SD: '....x..x.x..x...',
      CH: 'xxxxxx.xxxxxxx.x',
      OH: '......x.......x.',
      AC: 'x...x.......x...',
    }, {
      BD: 'x.x....x..x..x..',
      SD: '....x..x.x..x.xx',
      CH: 'xxxxxx.xxxxxxx..',
      OH: '......x.......x.',
      CB: '...........x....',
      AC: 'x...x.......x..x',
    }, F_FUNK),
    ...ab('HIP HOP', {
      BD: 'x......x..x.....',
      SD: '....x.......x...',
      CP: '....x.......x...',
      CH: 'x.x.x.x.x.x.x.x.',
      AC: '....x.......x...',
    }, {
      BD: 'x......x..x..x..',
      SD: '....x.......x..x',
      CP: '....x.......x...',
      CH: 'x.x.x.x.x.xxx...',
      OH: '..............x.',
      AC: '....x.......x...',
    }, F_HIPHOP),
    ...ab('MIAMI BASS', {
      BD: 'x.....x...x..x..',
      CP: '....x.......x...',
      CH: 'xxxxxxxxxxxxxxxx',
      CB: '.......x......x.',
      AC: '....x.......x...',
    }, {
      BD: 'x.....x.x.x..x..',
      SD: '..............xx',
      CP: '....x.......x...',
      CH: 'xxxxxxxxxxxx.x..',
      OH: '............x...',
      CB: '.......x......x.',
      AC: '....x.......x...',
    }, F_MIAMI),
    ...ab('HOUSE', {
      BD: 'x...x...x...x...',
      CP: '....x.......x...',
      CH: 'x...x...x...x...',
      OH: '..x...x...x...x.',
      RS: '...x.......x....',
      AC: '..x...x...x...x.',
    }, {
      BD: 'x...x...x...x...',
      SD: '...............x',
      CP: '....x.......x...',
      CH: 'x..xx..xx..xx...',
      OH: '..x...x...x...x.',
      RS: '...x.......x...x',
      HT: '..........x.....',
      MT: '...........x....',
      AC: '..x...x...x...x.',
    }, F_HOUSE),
    ...ab('SLOW JAM', {
      BD: 'x.......x.x.....',
      SD: '....x.......x...',
      CP: '....x.......x...',
      CH: 'x.xxx.x.x.xxx.x.',
      RS: '...........x....',
      AC: '....x.......x...',
    }, {
      BD: 'x.......x.x...x.',
      SD: '....x.......x...',
      CP: '....x.......x..x',
      CH: 'x.xxx.x.x.xxx...',
      OH: '..............x.',
      LT: '.............x..',
      AC: '....x.......x...',
    }, F_SLOWJAM),
    ...ab('ROCK', {
      BD: 'x.......x.x.....',
      SD: '....x.......x...',
      CH: 'x.x.x.x.x.x.x.x.',
      AC: 'x...x...x...x...',
    }, {
      BD: 'x.......x.......',
      SD: '....x.........xx',
      CH: 'x.x.x.x.........',
      HT: '........xx......',
      MT: '..........xx....',
      LT: '............xx..',
      AC: 'x...x...x.....xx',
    }, F_ROCK_A, F_ROCK_B),
    ...ab('BOSSA NOVA', {
      BD: 'x..x....x..x....',
      RS: 'x..x..x...x..x..',
      CH: 'x.x.x.x.x.x.x.x.',
      AC: 'x.......x.......',
    }, {
      BD: 'x..x....x..x....',
      RS: '..x.x...x..x..x.',
      CH: 'x.x.x.x.x.x.x.x.',
      LT: '.............x..',
      MT: '......x.........',
      AC: 'x.......x.......',
    }, F_BOSSA),
    ...ab('SAMBA', {
      BD: 'x..xx..xx..xx..x',
      RS: 'x.x..x.x.x..x.x.',
      CH: 'xxxxxxxxxxxxxxxx',
      AC: '....x.......x...',
    }, {
      BD: 'x..xx..xx..xx..x',
      RS: 'x.x..x.x.x..x.x.',
      CH: 'xxxxxxxxxxxxxxxx',
      CB: 'x.x...x.x.x...x.',
      MT: '...x.......x....',
      LT: '......x.......x.',
      AC: '....x.......x...',
    }, F_SAMBA),
    ...ab('REGGAE', {
      BD: '........x.......',
      RS: '........x.......',
      CH: 'x.x.x.x.x.x.x.x.',
      AC: '........x.......',
    }, {
      BD: '........x.......',
      RS: '........x.......',
      CH: 'x.xxx.x.x.xx....',
      OH: '......x.........',
      HT: '............x...',
      MT: '.............x..',
      LT: '..............x.',
      AC: '........x.......',
    }, F_REGGAE),
    ...ab('SYNTH POP', {
      BD: 'x.....x.x.......',
      SD: '....x.......x...',
      CP: '....x.......x...',
      CH: 'xxxxxxxxxxxxxxxx',
      CB: '..........x...x.',
      AC: 'x...x...x...x...',
    }, {
      BD: 'x.....x.x..x..x.',
      SD: '....x.......x...',
      CP: '....x.......x...',
      CH: 'xxxxxxxxxxxxxx..',
      OH: '..............x.',
      AC: 'x...x...x...x...',
    }, F_SYNTHPOP),
  ],
  // a rhythm track: ELECTRO with its B every fourth bar, then MIAMI BASS, back to ELECTRO
  songs: [[1, 1, 1, 2, 1, 1, 2, 2, 9, 9, 9, 10, 1, 1, 2, 2]],
};

// The TR-909's fill-ins, on its grooves (its fills and intro have none), in the manner of its own fills: snare rolls
// ending on accented hits and flams, tom runs down; the groove's bass drum and AC row stay. Pattern 1, the patch's own,
// has none, as the 808 Kit's (and the patch has 9 of its 3,840 bytes left).
const G_HOUSE: Fill = { from: 8, grid: { ...hush('CH', 'OH'), SD: 'x.x.xxXX' } };
const G_TECHNO_A: Fill = { from: 8, grid: { ...hush('OH', 'RD'), HT: 'Xx......', MT: '..Xx....', LT: '....Xx..', SD: '......ff' } };
const G_TECHNO_B: Fill = { from: 8, grid: { ...hush('CH', 'OH', 'RD', 'LT'), SD: 'x.xxxxXX' } };
const G_ACID: Fill = { from: 8, grid: { CH: '........', SD: 'x.x.XxXX' } };
const G_JACK: Fill = { from: 8, grid: { ...hush('RS', 'CH', 'OH'), CP: 'x.x.xxxx' } };
const G_GARAGE: Fill = { from: 8, grid: { ...hush('CH', 'OH', 'RS'), SD: '.xx.Xxff' } };
const G_ELECTRO: Fill = { from: 8, grid: { ...hush('CH', 'CP'), HT: 'X.x.....', MT: '...x.X..', LT: '......Xf', SD: '....X...' } };
const G_BREAKS: Fill = { from: 8, grid: { ...hush('RD', 'OH'), SD: 'xxx.Xxxf' } };

// The TR-909: patterns in the styles it shaped, its fills (snare rolls, tom runs, flams) and an intro. Pattern 1 is the
// patch's own.
const KIT909: FactoryKit = {
  patch: '909 Kit',
  first: KIT_FIRST_ID + KIT_IDS_PER_KIT,
  prefix: '909',
  keys: { BD: 53, SD: 55, CP: 57, CH: 59, OH: 60, LT: 62, RS: 64, HT: 65, MT: 67, CR: 69, RD: 71, AC: 72 },
  flams: { BD: 54, SD: 56, LT: 63, MT: 68, HT: 66 },
  patterns: [
    { name: 'HOUSE', fill: G_HOUSE, grid: {
      BD: 'X...x...X...x...',
      CP: '....x.......x...',
      CH: 'x...x...x...x...',
      OH: '..x...x...x...x.',
      AC: '..x...x...x...x.',
    } },
    { name: 'HOUSE FILL', grid: {
      BD: 'X...x...X...x...',
      SD: '........x.x.xxXX',
      CP: '....x...........',
      OH: '..x...x.........',
      AC: '..............xx',
    } },
    { name: 'TECHNO A', fill: G_TECHNO_A, grid: {
      BD: 'X...X...X...X...',
      CP: '....x.......x...',
      OH: '..x...x...x...x.',
      RD: 'x.x.x.x.x.x.x.x.',
      AC: 'x...x...x...x...',
    } },
    { name: 'TECHNO B', fill: G_TECHNO_B, grid: {
      BD: 'X...X...X...X..x',
      CP: '....x.......x...',
      CH: 'xx.xxx.xxx.xxx.x',
      OH: '..x...x...x...x.',
      RD: 'x.x.x.x.x.x.x.x.',
      LT: '...........x....',
      AC: '..x...x...x...x.',
    } },
    { name: 'ACID', fill: G_ACID, grid: {
      BD: 'X...x...X...x...',
      SD: '....X.......X...',
      CH: 'xxXxxxXxxxXxxxXx',
      CP: '............x...',
    } },
    { name: 'JACK', fill: G_JACK, grid: {
      BD: 'X...x...X...x...',
      CP: '....x.......x...',
      RS: '..x..x....x..x..',
      CH: 'xx.xxx.xxx.xxx.x',
      OH: '..x...x...x...x.',
      AC: '....x.......x...',
    } },
    { name: 'GARAGE', fill: G_GARAGE, grid: {
      BD: 'X.....x...x.....',
      SD: '....X.......X...',
      CH: 'x.xx..x.x.xx..x.',
      OH: '....x.......x...',
      RS: '...x.......x..x.',
      AC: '....x.......x...',
    } },
    { name: 'ELECTRO', fill: G_ELECTRO, grid: {
      BD: 'X.....x...x.....',
      SD: '....X.......X...',
      CP: '....x.......x...',
      CH: 'x.x.x.x.x.x.x.xx',
      HT: '..........x.....',
      MT: '...........x....',
      AC: 'x...x.......x...',
    } },
    { name: 'BREAKS', fill: G_BREAKS, grid: {
      BD: 'X.x.......xx....',
      SD: '....X..x.x..X..x',
      RD: 'x.x.x.x.x.x.x.x.',
      OH: '..............x.',
      AC: '....x.......x...',
    } },
    { name: 'TOM FILL', grid: {
      BD: 'X.......x.......',
      SD: '....X.........ff',
      CH: 'x.x.x.x.........',
      HT: '........Xx......',
      MT: '..........Xx....',
      LT: '............Xf..',
      AC: '..............xx',
    } },
    { name: 'INTRO', grid: {
      BD: 'X...x...X...x...',
      CP: '............x.xx',
      CR: 'x...............',
      AC: '..............xx',
    } },
  ],
  // a track: the intro, house with its fill, the patch's own groove and a tom fill, techno, acid
  songs: [[12, 12, 2, 2, 2, 3, 1, 1, 1, 11, 4, 4, 4, 5, 6, 3]],
};

/** the factory kits whose patterns are in the store, in their ids' order (append-only) */
export const FACTORY_KITS: readonly FactoryKit[] = [KIT808, KIT909];

/** a grid's notes, in the engine's order (by step, then note); its first column is step `from` */
export function gridNotes(kit: FactoryKit, grid: Grid, from = 0): StepNote[] {
  const out: StepNote[] = [];
  for (const [row, steps] of Object.entries(grid)) {
    const key = kit.keys[row];
    if (key === undefined) throw new Error(`${kit.patch}: no row ${row}`);
    for (let i = 0; i < steps.length; i++) {
      const c = steps[i], at = from + i;
      if (c === '.') continue;
      const note = c === 'f' ? kit.flams?.[row] : key;
      if (note === undefined || !'xXf'.includes(c)) throw new Error(`${kit.patch}: ${row} step ${at + 1} '${c}'`);
      out.push({ at, len: 1, note, vel: c === 'X' ? ACCENT_VEL : STEP_VEL });
    }
  }
  return out.sort((a, b) => a.at - b.at || a.note - b.note);
}

/** notes `plain` with fill-in `fill` (#852): a note the fill takes away plays NOT FILL, one it adds FILL, the rest as
 *  they are, so with FILL let go they play as `plain` */
export function withFill(kit: FactoryKit, plain: readonly StepNote[], fill: Fill | undefined): StepNote[] {
  if (!fill) return [...plain];
  const rows = new Set(Object.keys(fill.grid).flatMap((r) => [kit.keys[r], kit.flams?.[r]]));
  const added = new Map(gridNotes(kit, fill.grid, fill.from).map((n) => [n.at * 128 + n.note, n]));
  const out: StepNote[] = [];
  for (const n of plain) {
    if (n.cond || n.chance !== undefined) throw new Error(`${kit.patch}: a fill-in over a note with a condition or chance`);
    if (n.at < fill.from || !rows.has(n.note)) {
      out.push(n);
      continue;
    }
    const k = n.at * 128 + n.note, same = added.get(k);
    added.delete(k);
    if (!same) out.push({ ...n, cond: COND_FILL | COND_NOT });
    else if (same.vel === n.vel && same.len === n.len) out.push(n);
    else throw new Error(`${kit.patch}: step ${n.at + 1} note ${n.note} differs with FILL held`);
  }
  for (const n of added.values()) out.push({ ...n, cond: COND_FILL });
  return out.sort((a, b) => a.at - b.at || a.note - b.note);
}

/** factory patch `p` (changed in place) with its kit's patterns 2.., songs and links, when it has a kit */
export function withKitPatterns(p: Patch): Patch {
  const kit = FACTORY_KITS.find((k) => k.patch === p.name);
  if (!kit) return p;
  const tracks = p.modules.filter((m) => m.type === 'steps');
  if (tracks.length !== 1) throw new Error(`${kit.patch}: a kit's patterns are for its one Steps track`);
  tracks[0].patterns = kit.patterns.map((x): Pattern => ({ notes: withFill(kit, gridNotes(kit, x.grid), x.fill) }));
  const main = p.modules.find((m) => m.type === 'fm1')!;
  const songs = kit.songs.map((s) => s.map((n): SongEntry => ({ pat: n - 1, shift: 0 })));
  const dev = deviceView(p, true).patch;
  const links = Object.fromEntries(kit.patterns.map((_, k) => [k + 1, { id: kit.first + k, hash: fnv(FNV0, encodePayload(p, k + 1, dev)) }]));
  main.seq = { ...main.seq, songs, links };
  return p;
}
