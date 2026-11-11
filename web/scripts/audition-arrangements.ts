// SPDX-License-Identifier: GPL-3.0-only
// Listening arrangements only. Loading a sound preset still preserves the musician's melodic tracks.
import type { Patch } from '../src/patch';
import { fixNotes } from '../src/track';

type Phrase = [at: number, length: number, note: number, velocity: number][];
const arrangements: Record<string, { tone: Phrase; chord: Phrase }> = {
  Init: { tone: [[0, 1, 45, 127], [3, 1, 45, 100], [6, 1, 57, 100], [8, 1, 45, 127], [10, 1, 48, 100], [11, 1, 52, 100], [14, 1, 55, 100]], chord: [[3, 1, 57, 100], [10, 1, 57, 100], [13, 1, 55, 100]] },
  'Tight Techno': { tone: [[0, 1, 36, 110], [7, 1, 36, 85], [8, 1, 36, 100], [14, 1, 43, 80]], chord: [[2, 1, 60, 80], [6, 1, 60, 65], [11, 1, 63, 85]] },
  'Boom Bap': { tone: [[0, 2, 43, 105], [6, 1, 46, 75], [8, 2, 41, 100], [14, 1, 38, 70]], chord: [] },
  Industrial: { tone: [[1, 1, 36, 100], [7, 1, 37, 80], [11, 1, 36, 90]], chord: [[0, 1, 48, 80], [10, 1, 49, 65]] },
  'FM Melodic': { tone: [[0, 2, 60, 95], [3, 1, 67, 75], [5, 2, 69, 90], [8, 1, 64, 85], [10, 2, 62, 75], [14, 1, 67, 65]], chord: [[0, 3, 48, 70], [8, 3, 53, 65]] },
  'Lo-fi House': { tone: [[0, 1, 38, 105], [3, 1, 50, 70], [7, 1, 45, 85], [8, 1, 41, 100], [12, 1, 48, 75]], chord: [[2, 1, 62, 80], [6, 1, 62, 65], [10, 1, 65, 75], [15, 1, 60, 60]] },
};

export function arrangeSpokesAudition(p: Patch, preset: string): void {
  const phrase = arrangements[preset];
  if (!phrase) throw new Error(`Missing Spokes audition arrangement: ${preset}`);
  for (const [name, notes] of [['TONE', phrase.tone], ['CHORD', phrase.chord]] as const) {
    const track = p.modules.find((m) => m.type === 'steps' && m.name === name);
    if (!track) throw new Error(`Spokes audition has no ${name} track`);
    track.notes = fixNotes(notes.map(([at, len, note, vel]) => ({ at, len, note, vel })));
  }
}
