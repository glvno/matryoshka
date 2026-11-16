// SPDX-License-Identifier: GPL-3.0-only
// The factory drum kits' pattern sets (#923, D-829): patterns 2.. of a factory patch kept as read-only entries of the
// FM-1's pattern store, which the patch links (format 59's links section, D-1015), so a set larger than the patch's
// 3,840 bytes plays from the patch. Pattern 1 stays the patch's own (its demonstration pattern, D-882); each kit's song
// chains the set. gen-presets.ts writes the entries into factory-store.json (the editor's copy, pattern-store.ts
// factoryEntries), export-defs.ts packs them into firmware/src/factory_tier.h (KIT_GROUPS, patlink.c), compiled in with
// the firmware tier, which both kits belong to (#915).
//
// A kit's entries take ids from its own first id (KIT_IDS_PER_KIT apart, append-only), pattern p (0-based, 1..) at first
// + p - 1, so a saved patch's links keep their meaning when a later set grows.
//
// Grids: one row per drum, a character per step: `.` rest, `x` a hit, `X` an accented hit (velocity 127: the 909 Kit's
// drums that accent on their own), `f` a flam (the 909 Kit: the drum's FLAM row in place of its own row). The 808 Kit
// accents with its AC row only, as the TR-808 does.
import type { Patch } from './patch';
import { deviceView } from './poly';
import { encodePayload, fnv, FNV0 } from './pattern-store';
import { ACCENT_VEL, STEP_VEL, type Pattern, type SongEntry, type StepNote } from './track';

/** the first read-only id of the factory patches' patterns (patlink.c PL_KIT: one above the store's user ids) */
export const KIT_FIRST_ID = 0xe000;
/** ids a kit may take: one per pattern 2..64 */
export const KIT_IDS_PER_KIT = 64;

type Grid = Record<string, string>;
export interface KitPattern { name: string; grid: Grid }
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

/** a rhythm's A and B variations */
const ab = (name: string, a: Grid, b: Grid): KitPattern[] => [{ name: `${name} A`, grid: a }, { name: `${name} B`, grid: b }];

// The TR-808: its 12 basic rhythms, each with an A and a B variation, after the styles the TR-808 is known for and the
// rhythm patterns of its owner's manual. Rhythm 1's A is the patch's own pattern 1 (ELECTRO A).
const KIT808: FactoryKit = {
  patch: '808 Kit',
  first: KIT_FIRST_ID,
  prefix: '808',
  keys: { BD: 53, SD: 55, CP: 57, CH: 59, OH: 60, LT: 62, RS: 64, CB: 65, MT: 67, HT: 69, CY: 71, AC: 72 },
  patterns: [
    { name: 'ELECTRO B', grid: {
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
    }),
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
    }),
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
    }),
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
    }),
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
    }),
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
    }),
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
    }),
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
    }),
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
    }),
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
    }),
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
    }),
  ],
  // a rhythm track: ELECTRO with its B every fourth bar, then MIAMI BASS, back to ELECTRO
  songs: [[1, 1, 1, 2, 1, 1, 2, 2, 9, 9, 9, 10, 1, 1, 2, 2]],
};

// The TR-909: patterns in the styles it shaped, its fills (snare rolls, tom runs, flams) and an intro. Pattern 1 is the
// patch's own.
const KIT909: FactoryKit = {
  patch: '909 Kit',
  first: KIT_FIRST_ID + KIT_IDS_PER_KIT,
  prefix: '909',
  keys: { BD: 53, SD: 55, CP: 57, CH: 59, OH: 60, LT: 62, RS: 64, HT: 65, MT: 67, CR: 69, RD: 71, AC: 72 },
  flams: { BD: 54, SD: 56, LT: 63, MT: 68, HT: 66 },
  patterns: [
    { name: 'HOUSE', grid: {
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
    { name: 'TECHNO A', grid: {
      BD: 'X...X...X...X...',
      CP: '....x.......x...',
      OH: '..x...x...x...x.',
      RD: 'x.x.x.x.x.x.x.x.',
      AC: 'x...x...x...x...',
    } },
    { name: 'TECHNO B', grid: {
      BD: 'X...X...X...X..x',
      CP: '....x.......x...',
      CH: 'xx.xxx.xxx.xxx.x',
      OH: '..x...x...x...x.',
      RD: 'x.x.x.x.x.x.x.x.',
      LT: '...........x....',
      AC: '..x...x...x...x.',
    } },
    { name: 'ACID', grid: {
      BD: 'X...x...X...x...',
      SD: '....X.......X...',
      CH: 'xxXxxxXxxxXxxxXx',
      CP: '............x...',
    } },
    { name: 'JACK', grid: {
      BD: 'X...x...X...x...',
      CP: '....x.......x...',
      RS: '..x..x....x..x..',
      CH: 'xx.xxx.xxx.xxx.x',
      OH: '..x...x...x...x.',
      AC: '....x.......x...',
    } },
    { name: 'GARAGE', grid: {
      BD: 'X.....x...x.....',
      SD: '....X.......X...',
      CH: 'x.xx..x.x.xx..x.',
      OH: '....x.......x...',
      RS: '...x.......x..x.',
      AC: '....x.......x...',
    } },
    { name: 'ELECTRO', grid: {
      BD: 'X.....x...x.....',
      SD: '....X.......X...',
      CP: '....x.......x...',
      CH: 'x.x.x.x.x.x.x.xx',
      HT: '..........x.....',
      MT: '...........x....',
      AC: 'x...x.......x...',
    } },
    { name: 'BREAKS', grid: {
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

/** a grid's notes, in the engine's order (by step, then note) */
export function gridNotes(kit: FactoryKit, grid: Grid): StepNote[] {
  const out: StepNote[] = [];
  for (const [row, steps] of Object.entries(grid)) {
    const key = kit.keys[row];
    if (key === undefined) throw new Error(`${kit.patch}: no row ${row}`);
    for (let at = 0; at < steps.length; at++) {
      const c = steps[at];
      if (c === '.') continue;
      const note = c === 'f' ? kit.flams?.[row] : key;
      if (note === undefined || !'xXf'.includes(c)) throw new Error(`${kit.patch}: ${row} step ${at + 1} '${c}'`);
      out.push({ at, len: 1, note, vel: c === 'X' ? ACCENT_VEL : STEP_VEL });
    }
  }
  return out.sort((a, b) => a.at - b.at || a.note - b.note);
}

/** a kit pattern's stored name: the kit's prefix and the pattern's name */
export const kitPatternName = (kit: FactoryKit, k: number): string => `${kit.prefix} ${kit.patterns[k].name}`;

/** factory patch `p` (changed in place) with its kit's patterns 2.., songs and links, when it has a kit */
export function withKitPatterns(p: Patch): Patch {
  const kit = FACTORY_KITS.find((k) => k.patch === p.name);
  if (!kit) return p;
  const tracks = p.modules.filter((m) => m.type === 'steps');
  if (tracks.length !== 1) throw new Error(`${kit.patch}: a kit's patterns are for its one Steps track`);
  tracks[0].patterns = kit.patterns.map((x): Pattern => ({ notes: gridNotes(kit, x.grid) }));
  const main = p.modules.find((m) => m.type === 'fm1')!;
  const songs = kit.songs.map((s) => s.map((n): SongEntry => ({ pat: n - 1, shift: 0 })));
  const dev = deviceView(p, true).patch;
  const links = Object.fromEntries(kit.patterns.map((_, k) => [k + 1, { id: kit.first + k, hash: fnv(FNV0, encodePayload(p, k + 1, dev)) }]));
  main.seq = { ...main.seq, songs, links };
  return p;
}

/** a read-only store entry of a factory patch's pattern: its id, the patch, its stored name and payload */
export interface KitStoreEntry { id: number; kit: string; name: string; payload: Uint8Array }

/** the factory patches' linked patterns as store entries, in id order (gen-presets.ts writes them into
 *  factory-store.json): each link's payload as the patch has it */
export function kitStoreEntries(bank: readonly { name: string; patch: Patch }[]): KitStoreEntry[] {
  return FACTORY_KITS.flatMap((kit) => {
    const p = bank.find((x) => x.name === kit.patch)?.patch;
    if (!p) throw new Error(`no factory patch ${kit.patch}`);
    const dev = deviceView(p, true).patch;
    return kit.patterns.map((_, k) => ({ id: kit.first + k, kit: kit.patch, name: kitPatternName(kit, k), payload: encodePayload(p, k + 1, dev) }));
  });
}
