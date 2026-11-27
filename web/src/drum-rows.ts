// SPDX-License-Identifier: GPL-3.0-only
// A drum track's rows as one list (docs/ledger/steps.md D-520, firmware/src/engine.c eng_steps_rows / eng_keys_rows): the
// rows of every Drum map the track plays, directly or through the Arpeggiator it feeds, the maps in the FM-1's module
// order. With two maps or more, the rows whose note is 0 are left out (unless that leaves none). Black keys 1..11 play 11
// of them from a bank's first (rows 8b + 1 ..); OCT picks the bank, and the SEQ page's grid shows 8 at a time (D-521).
import { keyReach } from './key-routing';
import { DRUM_MAP_DEFAULT, DRUM_ROWS, drumRowName } from './modules';
import type { ModuleInst, Patch } from './patch';
import { deviceView } from './poly';

/** the most rows the list holds (engine.h ENG_DRUM_LIST: three banks of 8) */
export const DRUM_LIST = 24;

export interface DrumRow {
  /** the Drum map the row is in, and its row there (0..7) */
  map: ModuleInst;
  row: number;
  /** the note it plays (0..127) and its name */
  note: number;
  name: string;
}

/** row r's note of a Drum map, as the FM-1 reads it (engine.c eng_drummap_note) */
export const drumRowNote = (map: ModuleInst, r: number): number => Math.max(0, Math.min(127, Math.round(map.params[`n${r + 1}`] ?? DRUM_MAP_DEFAULT[r].note)));

/** the rows of these Drum maps as one list, the maps in the FM-1's module order */
export function drumRowList(p: Patch, maps: readonly ModuleInst[]): DrumRow[] {
  const order = new Map(deviceView(p, true).patch.modules.map((m, i) => [m.id, i]));
  const at = (m: ModuleInst): number => order.get(m.id) ?? order.size + p.modules.indexOf(m);
  const sorted = [...new Set(maps)].sort((a, b) => at(a) - at(b));
  const rows = (all: boolean): DrumRow[] => sorted.flatMap((map) => Array.from({ length: DRUM_ROWS }, (_, row) => ({ map, row, note: drumRowNote(map, row), name: drumRowName(map.names, row) })))
    .filter((r) => all || r.note > 0).slice(0, DRUM_LIST);
  const some = rows(sorted.length === 1);
  return some.length ? some : rows(true);
}

/** the Drum maps a Steps track plays: cabled from its keys out, or through the Arpeggiator it feeds */
export const trackDrumMaps = (p: Patch, steps: number): ModuleInst[] => {
  const reach = keyReach(p, steps);
  return p.modules.filter((m) => m.type === 'drummap' && reach.has(m.id));
};

/** a drum track's rows (engine.c eng_steps_rows): [] for a track into no Drum map */
export const trackDrumRows = (p: Patch, steps: number): DrumRow[] => drumRowList(p, trackDrumMaps(p, steps));
