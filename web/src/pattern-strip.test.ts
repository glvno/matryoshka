// @vitest-environment jsdom
// SPDX-License-Identifier: GPL-3.0-only
import { expect, it } from 'vitest';
import { patternStrip } from './pattern-strip';
import { SongView } from './song';
import { patternName, type SongEntry } from './track';

it('the strip steps the pattern, shows the one a track waits for, copies to the next empty one, doubles, halves and clears all (asked first)', () => {
  let p = 0, cleared = 0, doubled = 0, halved = 0;
  const copies: [number, number][] = [];
  const s = patternStrip({
    pattern: () => p, names: () => undefined, select: (x) => { p = x; s.refresh(); }, used: () => new Set([0]),
    shape: (x) => ({ own: x === 0 }), setShape: () => {}, clear: () => {}, copy: (a, b) => copies.push([a, b]), double: () => { doubled++; }, halve: () => { halved++; }, nextEmpty: (from) => from + 1,
    clearAll: () => { cleared++; }, empty: () => cleared > 0, song: () => {}, playing: () => 0,
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
  ([...s.el.querySelectorAll('.pat-act')].find((b) => b.textContent === '×2') as HTMLButtonElement).click();
  expect(doubled).toBe(1);
  ([...s.el.querySelectorAll('.pat-act')].find((b) => b.textContent === '÷2') as HTMLButtonElement).click();
  expect([doubled, halved]).toEqual([1, 1]);
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
  expect([...s.el.querySelectorAll<HTMLButtonElement>('.pat-act')].map((b) => b.textContent)).toEqual(['copy', '×2', '÷2', 'clear', 'clear all', 'song']);
  expect(patternStrip({ pattern: () => 0, names: () => undefined, select: () => {}, used: () => new Set(), shape: () => ({ own: true }), setShape: () => {},
    clear: () => {}, copy: () => {}, double: () => {}, halve: () => {}, nextEmpty: () => 1, clearAll: () => {}, empty: () => true, song: () => {}, playing: () => 0 }, { compact: true })
    .el.textContent).not.toMatch(/clear all/);
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
