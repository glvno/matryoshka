// SPDX-License-Identifier: GPL-3.0-only
// Build the shared editor/firmware sound-to-pattern table from authored lane patterns.
// A lane is one key's 16 steps: `.` a rest, `x` a note, `X` an accented note, `-` the note before it held one step more
// (a tie), `~` a drone (#384: a note tied across the loop point onto itself, which holds while the pattern plays, #1086).
import authored from '../presets/patterns/defaults.json';
import { factoryPresetDefs } from '../src/factory-presets';
import { defStructure } from '../src/structure';
import { ACCENT_VEL, fixNotes, isDrone, isShortNote, noteWord, STEP_VEL, STEPS_MAX, wordNote, type StepNote } from '../src/track';
import { patternRevision, type PresetPattern } from '../src/preset-pattern-data';
import { readFileSync } from 'node:fs';

/** one lane's notes on `note` */
function laneNotes(lane: string, note: number, where: string): StepNote[] {
  if (lane.length !== 16) throw new Error(`${where}: a lane has 16 steps, not ${lane.length}`);
  const out: StepNote[] = [];
  [...lane].forEach((c, at) => {
    const last = out.at(-1);
    if (c === 'x' || c === 'X') out.push({ at, len: 1, note, vel: c === 'X' ? ACCENT_VEL : STEP_VEL });
    else if (c === '~') out.push({ at, len: STEPS_MAX, note, vel: STEP_VEL, wrap: true });
    else if (c === '-') {
      if (!last || isDrone(last) || last.at + last.len !== at) throw new Error(`${where}: a tie at step ${at + 1} follows no note`);
      last.len++;
    } else if (c !== '.') throw new Error(`${where}: unknown step "${c}"`);
  });
  return out;
}

/** a factory pattern's note: a 16-step note (short words), or a drone starting on one of the 16 steps */
const factoryNote = (n: StepNote): boolean => isShortNote(n) || (isDrone(n) && n.at < 16 && (n.vel === STEP_VEL || n.vel === ACCENT_VEL) && !n.chance && !n.cond && !n.micro && !n.ratchet);

export function buildPresetPatterns(): PresetPattern[] {
const entries: PresetPattern[] = [];
for (const bank of authored) {
  const def = factoryPresetDefs().find((d) => d.name === bank.engine);
  if (!def) throw new Error(`Missing pattern engine ${bank.engine}`);
  const structure = defStructure(def);
  const card = readFileSync(new URL(`../presets/cards/${bank.card}.txt`, import.meta.url), 'utf8');
  const names = ['Init', ...Array.from(card.matchAll(/^preset:\s*(.+)$/gm), (m) => m[1].trim())];
  const seen = new Set<string>();
  for (const name of names) {
    const pattern = bank.patterns.find((p) => p.name === name);
    if (!pattern) throw new Error(`${bank.engine}: missing ${name} pattern`);
    const notes = pattern.notes ?? (fixNotes(Object.entries(pattern.rows ?? {}).flatMap(([key, lane]) =>
      laneNotes(lane, Number(key), `${bank.engine} ${name} ${key}`))) ?? []).map(noteWord);
    if (!notes.length || notes.length > 128 || !notes.every((w) => factoryNote(wordNote(w)))) throw new Error(`${bank.engine} ${name}: invalid pattern size`);
    if (seen.has(JSON.stringify(notes))) throw new Error(`${bank.engine} ${name}: duplicate groove`);
    seen.add(JSON.stringify(notes));
    const content = { structure, name, notes, len: 16, rate: 4, swing: 50, gate: 0.25, dir: 0 };
    // Content is immutable under an identity: changed notes/settings are a new revision.
    entries.push({ id: patternRevision(content), ...content });
  }
}
if (entries.some((e) => e.id === '00000000') || new Set(entries.map((e) => e.id)).size !== entries.length) throw new Error('Factory pattern identity collision');
return entries;
}
