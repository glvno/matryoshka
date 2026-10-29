// @vitest-environment jsdom
// SPDX-License-Identifier: GPL-3.0-only
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DEFS } from './modules';
import { addModule, emptyPatch } from './patch';
import { PianoRoll } from './roll';
import type { StepNote } from './track';
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} });
  vi.useFakeTimers();
});
afterEach(() => { vi.runAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); document.body.innerHTML = ''; });
function roll(notes: StepNote[] = [{ at: 63, len: 3, note: 60, vel: 100 }]) {
  const st = addModule(emptyPatch('roll'), DEFS.steps, 0, 0); st.notes = notes;
  const r = new PianoRoll({
    track: () => st, label: () => 'track', plays: () => [], drums: () => null,
    notes: n => { st.notes = n; }, begin: () => () => {}, len: n => { st.params.len = n; },
    play: () => {}, arm: () => {}, armed: () => false, rec: () => {}, recording: () => false, close: () => {},
  });
  document.body.append(r.el); r.key('a', false, true);
  return { r, st };
}
it('transposes and moves a note whose duration extends beyond step 64', () => {
  const { r, st } = roll(); r.key('ArrowUp', false, false);
  expect(st.notes![0]).toMatchObject({ at: 63, len: 3, note: 61 });
  r.key('ArrowLeft', false, false);
  expect(st.notes![0]).toMatchObject({ at: 62, len: 3, note: 61 });
  r.key('ArrowRight', false, false); r.key('ArrowRight', false, false);
  expect(st.notes![0].at).toBe(63);
});
it('changes duration independently of the start, up to 64 visits', () => {
  const { r, st } = roll(); r.key('ArrowRight', true, false);
  expect(st.notes![0].len).toBe(4);
  for (let i = 0; i < 70; i++) r.key('ArrowRight', true, false);
  expect(st.notes![0]).toMatchObject({ at: 63, len: 64 });
  r.key('ArrowLeft', true, false); expect(st.notes![0].len).toBe(63);
});
it('pastes long notes at step 64 without shortening them', () => {
  const { r, st } = roll(); r.key('x', false, true); r.key('v', false, true);
  expect(st.notes).toEqual([{ at: 63, len: 3, note: 60, vel: 100 }]);
});
it('duplicates notes near the grid end without shortening their durations', () => {
  const { r, st } = roll([{ at: 60, len: 3, note: 60, vel: 100 }]); r.key('d', false, true);
  expect(st.notes).toContainEqual({ at: 63, len: 3, note: 60, vel: 100 });
});
it('drags a long note without moving it backward to fit its duration inside the grid', () => {
  const { r, st } = roll();
  const grid = r.el.querySelector<HTMLElement>('.roll-grid')!;
  Object.defineProperties(grid, { clientWidth: { value: 1280 }, clientHeight: { value: 240 } });
  r.render();
  const note = r.el.querySelector<HTMLElement>('.roll-note')!;
  const y = parseFloat(note.style.top) + 6;
  grid.dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientX: 1270, clientY: y }));
  grid.dispatchEvent(new MouseEvent('pointermove', { clientX: 1270, clientY: y - 12 }));
  grid.dispatchEvent(new MouseEvent('pointerup'));
  expect(st.notes![0]).toMatchObject({ at: 63, len: 3, note: 61 });
});
it('resizes a note beyond the last grid step without truncating its duration', () => {
  const { r, st } = roll([{ at: 60, len: 3, note: 60, vel: 100 }]);
  const grid = r.el.querySelector<HTMLElement>('.roll-grid')!;
  Object.defineProperties(grid, { clientWidth: { value: 1280 }, clientHeight: { value: 240 } });
  r.render();
  const y = parseFloat(r.el.querySelector<HTMLElement>('.roll-note')!.style.top) + 6;
  grid.dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientX: 1258, clientY: y }));
  grid.dispatchEvent(new MouseEvent('pointermove', { clientX: 1320, clientY: y }));
  grid.dispatchEvent(new MouseEvent('pointerup'));
  expect(st.notes![0]).toMatchObject({ at: 60, len: 7 });
});
