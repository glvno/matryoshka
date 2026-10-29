// SPDX-License-Identifier: GPL-3.0-only
// The song drawer (#375): opened by SONG on a Steps card's pattern strip, over the canvas above the dock like the piano
// roll. Songs 1..8 in tabs; PATTERN / SONG says what the patch plays (its selected pattern, or the song shown); a song is a
// list of entries, a pattern and a shift (-12..+12 semitones, never on a track that plays a Drum map) each: add one at the
// end, insert a copy before one, delete one, drag one to another place. While a song plays, the entry each track plays is
// marked (from the engine). The editor owns the patch: the drawer only reports through `ops` (setSong is one undo step;
// choosing a song or the pattern is none, as on the FM-1).
import { patternName, PATTERNS_MAX, SHIFT_MAX, SONG_LEN_MAX, SONGS_MAX, type SongEntry } from './track';

export interface SongOps {
  songs(): SongEntry[][];
  /** the song that plays (0: the pattern) and the selected pattern, how the editor names patterns */
  playing(): number;
  pattern(): number;
  names(): '303' | undefined;
  setSong(k: number, entries: SongEntry[]): void;
  /** play song n (1..8), or the pattern (0) */
  play(n: number): void;
  close(): void;
}

export class SongView {
  readonly el: HTMLElement;
  private tabs: HTMLElement;
  private mode: HTMLElement;
  private list: HTMLElement;
  private shown = 0;
  /** the entries the tracks play now (from the engine), marked */
  private live = new Set<number>();
  private drag = -1;

  constructor(private ops: SongOps) {
    const el = (this.el = document.createElement('section'));
    el.className = 'song-drawer';
    el.setAttribute('aria-label', 'Songs');
    const head = document.createElement('div');
    head.className = 'song-head';
    const title = document.createElement('b');
    title.textContent = 'Songs';
    this.tabs = document.createElement('div');
    this.tabs.className = 'song-tabs';
    this.tabs.setAttribute('role', 'tablist');
    this.mode = document.createElement('div');
    this.mode.className = 'song-mode';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'song-close';
    close.textContent = '×';
    close.setAttribute('aria-label', 'Close the songs');
    close.onclick = () => ops.close();
    head.append(title, this.tabs, this.mode, close);
    this.list = document.createElement('div');
    this.list.className = 'song-list';
    el.append(head, this.list);
    if (ops.playing() > 0) this.shown = ops.playing() - 1;
    this.render();
  }

  /** the entries the tracks play (the engine's patternView): marked while this song plays */
  showLive(song: number, entries: number[]): void {
    const now = new Set(song === this.shown + 1 ? entries.filter((e) => e >= 0) : []);
    if (now.size === this.live.size && [...now].every((e) => this.live.has(e))) return;
    this.live = now;
    for (const row of this.list.querySelectorAll<HTMLElement>('.song-row')) row.classList.toggle('live', this.live.has(Number(row.dataset.k)));
  }

  private entries(): SongEntry[] {
    return this.ops.songs()[this.shown] ?? [];
  }
  private put(entries: SongEntry[]): void {
    this.ops.setSong(this.shown, entries.slice(0, SONG_LEN_MAX));
  }

  render(): void {
    const songs = this.ops.songs(), playing = this.ops.playing(), names = this.ops.names();
    this.tabs.replaceChildren(...Array.from({ length: SONGS_MAX }, (_, k) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'song-tab' + (k === this.shown ? ' on' : '') + (k + 1 === playing ? ' playing' : '') + (songs[k]?.length ? ' used' : '');
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(k === this.shown));
      b.textContent = String(k + 1);
      b.title = `song ${k + 1}${songs[k]?.length ? `: ${songs[k].length} entries` : ' (empty)'}${k + 1 === playing ? ', playing' : ''}`;
      b.onclick = () => {
        this.shown = k;
        if (playing > 0 && playing !== k + 1) this.ops.play(k + 1);   // (a song plays: the one shown plays, as ALGO on the FM-1)
        this.render();
      };
      return b;
    }));
    const modeBtn = (text: string, on: boolean, title: string, go: () => void): HTMLButtonElement => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'song-mode-btn' + (on ? ' on' : '');
      b.textContent = text;
      b.title = title;
      b.setAttribute('aria-pressed', String(on));
      b.onclick = go;
      return b;
    };
    this.mode.replaceChildren(
      modeBtn(`pattern ${patternName(this.ops.pattern(), names)}`, playing === 0, 'the patch plays its selected pattern (on the FM-1: K4 left on the SONG page)', () => this.ops.play(0)),
      modeBtn(`song ${this.shown + 1}`, playing === this.shown + 1, 'the patch plays this song: each track an entry a pass, from the first (on the FM-1: K4 right)', () => this.ops.play(this.shown + 1)),
    );
    const es = this.entries();
    const rows = es.map((e, k) => {
      const row = document.createElement('div');
      row.className = 'song-row' + (this.live.has(k) ? ' live' : '');
      row.dataset.k = String(k);
      row.draggable = true;
      row.ondragstart = (ev) => {
        this.drag = k;
        ev.dataTransfer?.setData('text/plain', String(k));
      };
      row.ondragover = (ev) => ev.preventDefault();
      row.ondrop = (ev) => {
        ev.preventDefault();
        const from = this.drag;
        this.drag = -1;
        if (from < 0 || from === k) return;
        const next = [...es];
        const [moved] = next.splice(from, 1);
        next.splice(k, 0, moved);
        this.put(next);
      };
      const no = document.createElement('span');
      no.className = 'song-no';
      no.textContent = String(k + 1).padStart(2, '0');
      const pat = document.createElement('select');
      pat.className = 'song-pat';
      pat.title = 'the pattern this entry plays';
      pat.onkeydown = (ev) => ev.stopPropagation();
      pat.replaceChildren(...Array.from({ length: PATTERNS_MAX }, (_, p) => Object.assign(document.createElement('option'), { value: String(p), text: patternName(p, names) })));
      pat.value = String(e.pat);
      pat.onchange = () => this.put(es.map((x, j) => (j === k ? { ...x, pat: Number(pat.value) } : x)));
      const shift = document.createElement('input');
      shift.type = 'number';
      shift.className = 'song-shift';
      shift.min = String(-SHIFT_MAX);
      shift.max = String(SHIFT_MAX);
      shift.step = '1';
      shift.value = String(e.shift);
      shift.title = 'its shift in semitones (−12..+12; a track that plays a Drum map is never shifted)';
      shift.onkeydown = (ev) => ev.stopPropagation();
      shift.onchange = () => {
        const v = Math.max(-SHIFT_MAX, Math.min(SHIFT_MAX, Math.round(Number(shift.value) || 0)));
        this.put(es.map((x, j) => (j === k ? { ...x, shift: v } : x)));
      };
      const ins = document.createElement('button');
      ins.type = 'button';
      ins.className = 'song-ins';
      ins.textContent = '+';
      ins.title = 'insert a copy of this entry before it (on the FM-1: FX held + K1)';
      ins.disabled = es.length >= SONG_LEN_MAX;
      ins.onclick = () => this.put([...es.slice(0, k), { ...e }, ...es.slice(k)]);
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'song-del';
      del.textContent = '×';
      del.title = 'delete this entry (on the FM-1: SEQ held + REC, twice)';
      del.onclick = () => this.put(es.filter((_, j) => j !== k));
      row.append(no, pat, shift, ins, del);
      return row;
    });
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'song-add';
    add.textContent = es.length >= SONG_LEN_MAX ? 'full: 64 entries' : '+ entry';
    add.title = 'a new entry at the end: the last entry’s pattern, else the selected one (on the FM-1: K1 on END)';
    add.disabled = es.length >= SONG_LEN_MAX;
    add.onclick = () => this.put([...es, { pat: es.length ? es[es.length - 1].pat : this.ops.pattern(), shift: 0 }]);
    const note = document.createElement('p');
    note.className = 'song-note';
    note.textContent = 'Each track plays one entry per pass of its own, in order, then the first again. PLAY starts a song at its first entry.';
    this.list.replaceChildren(...rows, add, note);
  }
}
