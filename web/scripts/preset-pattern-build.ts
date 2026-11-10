// SPDX-License-Identifier: GPL-3.0-only
// Build the shared editor/firmware sound-to-pattern table from authored lane patterns.
import authored from '../presets/patterns/defaults.json';
import { factoryPresetDefs } from '../src/factory-presets';
import { defStructure } from '../src/structure';
import { fixNotes, isShortNote, noteWord, patternNotes, wordNote } from '../src/track';
import { patternRevision, type PresetPattern } from '../src/preset-pattern-data';
import { readFileSync } from 'node:fs';

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
      (patternNotes(lane) ?? []).map((n) => ({ ...n, note: Number(key) })))) ?? []).map(noteWord);
    if (!notes.length || notes.length > 128 || !notes.every((w) => isShortNote(wordNote(w)))) throw new Error(`${bank.engine} ${name}: invalid pattern size`);
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
