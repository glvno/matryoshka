// @vitest-environment jsdom
// SPDX-License-Identifier: GPL-3.0-only
import { afterEach, expect, it } from 'vitest';
import { stepGrid, stopEntry, recordInput, recordTarget } from './step-grid';
import type { ModuleInst } from './patch';
import { chordFits } from './track';

afterEach(stopEntry);
it('records transformed pitches once on the first root release and ignores controls and stale replies', () => {
  const m: ModuleInst = { id: 3, type: 'steps', x: 0, y: 0, params: { len: 16 } };
  const g = stepGrid(m, 0, {
    notes: n => { m.notes = n; }, begin: () => () => {}, name: () => {}, mute: () => {}, arm: () => {}, armed: () => true,
    rec: () => {}, recording: () => true, roll: () => {}, lockRows: () => [], locks: () => {},
  });
  g.rec(true);
  const t = recordTarget()!;
  const input = (note: number, notes: number[], down: boolean) => recordInput({ ...t, note, notes, down, vel: 1 });
  input(56, [], true); input(56, [], false); expect(m.notes).toBeUndefined();
  input(60, [60,64,67], true); input(65, [65,69,72], true);
  input(60, [60,64,67], false);
  expect(m.notes?.map(n => [n.at,n.note])).toEqual([60,64,65,67,69,72].map(n => [0,n]));
  input(65, [65,69,72], false);
  expect(m.notes?.length).toBe(6);
  stopEntry(); g.rec(true);
  input(72, [72,76,79], true); input(72, [72,76,79], false);
  expect(m.notes?.length).toBe(6);
});
it('a full track never accepts a partial chord', () => {
  const notes = Array.from({ length: 126 }, (_, note) => ({ at: 1, len: 1, note, vel: 100 }));
  expect(chordFits(notes, 0, [{note:60},{note:64}], 16)).toBe(true);
  expect(chordFits(notes, 0, [{note:60},{note:64},{note:67}], 16)).toBe(false);
});
