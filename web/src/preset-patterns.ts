// SPDX-License-Identifier: GPL-3.0-only
// Factory drum sounds have separate demonstration patterns (#833); saved sound presets remain values only.
import type { AssemblyInst } from './assembly';
import { DEFS } from './modules';
import { deviceBudget, DEVICE } from './patchbin';
import { devicesOf } from './pages';
import type { Patch, ModuleInst } from './patch';
import { noteWord, patternLocks, patternOf, wordNote } from './track';

export { presetPattern } from './preset-pattern-data';
import { presetPattern, presetPatternById } from './preset-pattern-data';

/** Only one unambiguous driving track may own the selected default. */
function target(p: Patch, a: AssemblyInst): { track: ModuleInst; selected: number } | undefined {
  const id = devicesOf(p, DEFS).find((d) => d.asm === a.id)?.track;
  const track = p.modules.find((m) => m.id === id && m.type === 'steps');
  const selected = p.modules.find((m) => m.type === 'fm1')?.seq?.pattern ?? 0;
  return track ? { track, selected } : undefined;
}
export function clearPresetPattern(p: Patch, a: AssemblyInst): void {
  const t = target(p, a);
  if (!t?.track.factoryPatterns) return;
  t.track.factoryPatterns.ids[t.selected] = null;
  while (t.track.factoryPatterns.ids.length && !t.track.factoryPatterns.ids.at(-1)) t.track.factoryPatterns.ids.pop();
  if (!t.track.factoryPatterns.ids.length) delete t.track.factoryPatterns;
}
/** Generation only: a newly authored factory patch carries its known initial default. */
export function seedPresetPattern(p: Patch, a: AssemblyInst, identity: string): void {
  const t = target(p, a);
  if (t) (t.track.factoryPatterns ??= { version: 1, ids: [] }).ids[t.selected] = identity;
}
/** Only explicit provenance and exact unchanged notes/settings authorize replacement.
 * Missing patterns keep their fallback; unknown/custom sounds never acquire ownership. */
export function applyPresetPattern(p: Patch, a: AssemblyInst, structure: string, name: string): boolean {
  const t = target(p, a);
  if (!t) return false;
  const { track, selected } = t;
  const before = presetPatternById(track.factoryPatterns?.ids[selected] ?? undefined), after = presetPattern(structure, name);
  if (!before || before.structure !== structure || !after) return false;
  const current = patternOf(track, selected);
  if (!current.own || current.len !== before.len || current.rate !== before.rate || patternLocks(track, selected)?.length) return false;
  if (['swing', 'gate', 'dir'].some((k) => Math.round((track.params[k] ?? (k === 'gate' ? 0.25 : k === 'swing' ? 50 : 0)) * 65536) !== Math.round(before[k as 'swing' | 'gate' | 'dir'] * 65536))) return false;
  const words = (current.notes ?? []).map(noteWord);
  if (words.length !== before.notes.length || words.some((w, i) => w !== before.notes[i])) return false;
  // Patterns all use the same length/rate in a bank: never alter shared track settings.
  if (after.len !== before.len || after.rate !== before.rate) return false;
  // Factory defaults use compact 16-step words. Reserve any growth before changing anything.
  const budget = deviceBudget(p);
  if (budget.items.find((i) => i.key === 'bytes')!.used + Math.max(0, (after.notes.length - before.notes.length) * (selected ? 2 : 4)) > DEVICE.bytes || budget.items.find((i) => i.key === 'notes')!.used + after.notes.length - before.notes.length > DEVICE.notes) return false;
  const notes = after.notes.map(wordNote);
  if (selected === 0) track.notes = notes;
  else track.patterns![selected - 1]!.notes = notes;
  track.factoryPatterns!.ids[selected] = after.id;
  return true;
}
