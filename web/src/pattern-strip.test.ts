// @vitest-environment jsdom
// SPDX-License-Identifier: GPL-3.0-only
import { expect, it } from 'vitest';
import { patternStrip } from './pattern-strip';
import { SongView } from './song';
import { patternName, type SongEntry } from './track';

it('the strip steps the pattern, shows the one a track waits for, copies to the next empty one and clears all (asked first)', () => {
  let p = 0, cleared = 0;
  const copies: [number, number][] = [];
  const s = patternStrip({
    pattern: () => p, names: () => undefined, select: (x) => { p = x; s.refresh(); }, used: () => new Set([0]),
    shape: (x) => ({ own: x === 0 }), setShape: () => {}, clear: () => {}, copy: (a, b) => copies.push([a, b]), nextEmpty: (from) => from + 1,
    clearAll: () => { cleared++; }, empty: () => cleared > 0, demoSet: () => undefined, loadDemoSet: () => {}, song: () => {}, playing: () => 0,
  });
  const name = (): string => s.el.querySelector('.pat-name')!.textContent!;
  expect(name()).toBe('P01');
  (s.el.querySelectorAll('.pat-step')[1] as HTMLButtonElement).click();
  expect(p).toBe(1);
  expect(name()).toBe('P02');
  expect(s.el.querySelector('.pat-name')!.classList.contains('borrowed')).toBe(true);
  s.show(1, 2);
  expect(name()).toBe('P02 → P03');
  expect(s.el.querySelector('.pat-name')!.classList.contains('waiting')).toBe(true);
  (s.el.querySelector('.pat-act') as HTMLButtonElement).click();
  expect(copies).toEqual([[1, 2]]);
  const clearAll = [...s.el.querySelectorAll('.pat-act')].find((b) => b.textContent === 'clear all') as HTMLButtonElement;
  const was = window.confirm;
  window.confirm = () => false;
  clearAll.click();
  expect(cleared).toBe(0);
  window.confirm = () => true;
  clearAll.click();
  window.confirm = was;
  s.refresh();
  expect(cleared).toBe(1);
  expect(clearAll.disabled).toBe(true);
  expect(patternStrip({ pattern: () => 0, names: () => undefined, select: () => {}, used: () => new Set(), shape: () => ({ own: true }), setShape: () => {},
    clear: () => {}, copy: () => {}, nextEmpty: () => 1, clearAll: () => {}, empty: () => true, demoSet: () => '808 Kit', loadDemoSet: () => {}, song: () => {}, playing: () => 0 }, { compact: true })
    .el.textContent).not.toMatch(/clear all|demo set/);
});

it('the demo set button shows only on a patch with a demo set, and asks first only when something would be replaced', () => {
  let set: string | undefined, empty = true, loads = 0, asked = 0;
  const s = patternStrip({
    pattern: () => 0, names: () => undefined, select: () => {}, used: () => new Set([0]), shape: () => ({ own: true }), setShape: () => {},
    clear: () => {}, copy: () => {}, nextEmpty: () => 1, clearAll: () => {}, empty: () => empty, demoSet: () => set, loadDemoSet: () => { loads++; },
    song: () => {}, playing: () => 0,
  });
  const acts = (): string[] => [...s.el.querySelectorAll<HTMLButtonElement>('.pat-act')].filter((b) => !b.hidden).map((b) => b.textContent!);
  const demo = [...s.el.querySelectorAll<HTMLButtonElement>('.pat-act')].find((b) => b.textContent === 'demo set')!;
  expect(acts()).toEqual(['copy', 'clear', 'clear all', 'song']);
  set = '909 Kit';
  s.refresh();
  expect(acts()).toEqual(['copy', 'clear', 'clear all', 'demo set', 'song']);
  expect(demo.title).toBe('Load the 909 Kit’s demo set: its patterns, links and songs, as the patch shipped (FM-1: SEQ held + SEL)');
  const was = window.confirm;
  let answer = false;
  window.confirm = (q) => { asked++; expect(q).toBe('Replace every pattern and song with the 909 Kit’s demo set? Undo brings them back.'); return answer; };
  try {
    demo.click();                    // (nothing to replace: no question)
    expect([asked, loads]).toEqual([0, 1]);
    empty = false;
    demo.click();
    expect([asked, loads]).toEqual([1, 1]);
    answer = true;
    demo.click();
    expect([asked, loads]).toEqual([2, 2]);
  } finally { window.confirm = was; }
});

it('the song drawer adds, inserts and deletes entries, and plays the song shown', () => {
  let songs: SongEntry[][] = [[]];
  let playing = 0;
  const v = new SongView({
    songs: () => songs, playing: () => playing, pattern: () => 4, names: () => '303',
    setSong: (k, e) => { songs = [...songs]; songs[k] = e; v.render(); }, play: (n) => { playing = n; v.render(); }, close: () => {},
  });
  (v.el.querySelector('.song-add') as HTMLButtonElement).click();
  expect(songs[0]).toEqual([{ pat: 4, shift: 0 }]);
  (v.el.querySelector('.song-ins') as HTMLButtonElement).click();
  expect(songs[0].length).toBe(2);
  (v.el.querySelector('.song-del') as HTMLButtonElement).click();
  expect(songs[0].length).toBe(1);
  (v.el.querySelectorAll('.song-mode-btn')[1] as HTMLButtonElement).click();
  expect(playing).toBe(1);
  expect(v.el.querySelector('.song-pat option')!.textContent).toBe('I-A1');
  v.showLive(1, [0]);
  expect(v.el.querySelector('.song-row')!.classList.contains('live')).toBe(true);
  expect(patternName(63, '303')).toBe('IV-B8');
  expect(patternName(9)).toBe('P10');
});
