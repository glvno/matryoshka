// SPDX-License-Identifier: GPL-3.0-only
// The pattern strip (#375): on a Steps card under its head and in the piano roll's header. ‹ P03 › steps the patch's
// pattern (track.ts SeqState.pattern: every track shows and plays its pattern of that number; while the transport runs a
// track takes it at the end of its pass, and the strip shows the one playing → the one waiting, blinking). Then this
// track's pattern: its own length and rate or the track's, Clear (its notes go: the pattern stays, silent), Copy (every
// track's pattern to the next empty number, or one asked for), and SONG, which opens the song drawer (song.ts). The editor
// owns the patch: the strip only reports through `ops`.
import { patternName, PATTERNS_MAX, STEPS_MAX, STEPS_RATES } from './track';

export interface PatternStripOps {
  /** the patch's selected pattern (0-based) and how the editor names patterns */
  pattern(): number;
  names(): '303' | undefined;
  select(p: number): void;
  /** the pattern numbers any track has (a dot on the label) */
  used(): Set<number>;
  /** this track's pattern p: has it its own (else it shows its pattern 1), its own length and rate (undefined: the track's) */
  shape(p: number): { own: boolean; len?: number; rate?: number };
  setShape(p: number, shape: { len?: number | null; rate?: number | null }): void;
  clear(p: number): void;
  /** copy pattern `from` of every track to `to`; the first number no track has (-1: none) */
  copy(from: number, to: number): void;
  nextEmpty(): number;
  /** open / close the song drawer, and the song that plays (0: none) */
  song(): void;
  playing(): number;
}

export interface PatternStrip {
  el: HTMLElement;
  /** the patch changed (a pattern chosen, edited, copied) */
  refresh(): void;
  /** the pattern this track plays now and the one it takes at the end of its pass (-1 none), from the engine */
  show(pat: number, queued: number): void;
}

export function patternStrip(ops: PatternStripOps, opts: { compact?: boolean } = {}): PatternStrip {
  const el = document.createElement('div');
  el.className = 'pattern-strip' + (opts.compact ? ' compact' : '');
  const btn = (text: string, cls: string, title: string, on: () => void): HTMLButtonElement => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.textContent = text;
    b.title = title;
    b.onclick = (e) => {
      e.stopPropagation();
      on();
    };
    return b;
  };
  const prev = btn('‹', 'pat-step', 'the previous pattern (on the FM-1: PRESET on the SEQ page; here [ )', () => ops.select(Math.max(0, ops.pattern() - 1)));
  const next = btn('›', 'pat-step', 'the next pattern (on the FM-1: PRESET on the SEQ page; here ] )', () => ops.select(Math.min(PATTERNS_MAX - 1, ops.pattern() + 1)));
  const label = document.createElement('span');
  label.className = 'pat-name';
  const pick = document.createElement('select');
  pick.className = 'pat-pick';
  pick.title = 'the patch’s pattern: every track plays its pattern of this number (one it has not got: its first). While playing, each track takes it at the end of its pass';
  pick.onchange = () => ops.select(Number(pick.value));
  pick.onkeydown = (e) => e.stopPropagation();
  const lenSel = document.createElement('select');
  lenSel.className = 'pat-len';
  lenSel.title = 'this pattern’s own length, or the track’s';
  lenSel.onkeydown = (e) => e.stopPropagation();
  lenSel.onchange = () => ops.setShape(ops.pattern(), { len: lenSel.value === '' ? null : Number(lenSel.value) });
  const rateSel = document.createElement('select');
  rateSel.className = 'pat-rate';
  rateSel.title = 'this pattern’s own rate, or the track’s';
  rateSel.onkeydown = (e) => e.stopPropagation();
  rateSel.onchange = () => ops.setShape(ops.pattern(), { rate: rateSel.value === '' ? null : Number(rateSel.value) });
  const clear = btn('clear', 'pat-act', 'clear this track’s notes in this pattern (the pattern stays, silent; undo brings them back)', () => ops.clear(ops.pattern()));
  const copy = btn('copy', 'pat-act', 'copy this pattern of every track to the next empty pattern (Alt-click: to a number you choose)', () => {});
  copy.onclick = (e) => {
    e.stopPropagation();
    const from = ops.pattern();
    let to = ops.nextEmpty();
    if (e.altKey || to < 0) {
      const asked = window.prompt(`Copy ${patternName(from, ops.names())} of every track to pattern number (1–${PATTERNS_MAX}):`, String((to < 0 ? from + 1 : to) + 1));
      if (asked === null) return;
      to = Math.round(Number(asked)) - 1;
      if (!(to >= 0 && to < PATTERNS_MAX)) return;
    }
    ops.copy(from, to);
    ops.select(to);
  };
  const song = btn('song', 'pat-act pat-song', 'SONG: the patch’s songs, patterns in a row with a shift each (on the FM-1: SEL tapped on the SEQ page)', () => ops.song());
  el.append(prev, label, pick, next, lenSel, rateSel, copy, clear, song);

  let playing = -1, waiting = -1;
  const fill = (s: HTMLSelectElement, items: [string, string][], value: string): void => {
    if (s.options.length !== items.length || [...s.options].some((o, i) => o.value !== items[i][0] || o.text !== items[i][1]))
      s.replaceChildren(...items.map(([v, t]) => Object.assign(document.createElement('option'), { value: v, text: t })));
    s.value = value;
  };
  const refresh = (): void => {
    const p = ops.pattern(), names = ops.names(), used = ops.used(), sh = ops.shape(p);
    fill(pick, Array.from({ length: PATTERNS_MAX }, (_, k): [string, string] => [String(k), `${patternName(k, names)}${used.has(k) ? ' •' : ''}`]), String(p));
    const shownName = playing >= 0 && waiting >= 0 && waiting !== playing ? `${patternName(playing, names)} → ${patternName(waiting, names)}` : patternName(p, names);
    label.textContent = shownName;
    label.classList.toggle('waiting', waiting >= 0 && waiting !== playing);
    label.classList.toggle('borrowed', !sh.own);
    label.title = sh.own ? 'this track’s pattern' : 'this track has no pattern of this number: it plays (and shows) its pattern 1; an edit makes this one from it';
    fill(lenSel, [['', p ? 'len: track’s' : 'len: the track’s'], ...Array.from({ length: STEPS_MAX }, (_, k): [string, string] => [String(k + 1), `len ${k + 1}`])], sh.len === undefined ? '' : String(sh.len));
    fill(rateSel, [['', 'rate: track’s'], ...STEPS_RATES.map((r, k): [string, string] => [String(k), `rate ${r}`])], sh.rate === undefined ? '' : String(sh.rate));
    lenSel.disabled = rateSel.disabled = p === 0;   // (pattern 1 is the track's own length and rate: its card's sliders)
    prev.disabled = p <= 0;
    next.disabled = p >= PATTERNS_MAX - 1;
    song.classList.toggle('on', ops.playing() > 0);
    song.textContent = ops.playing() > 0 ? `song ${ops.playing()}` : 'song';
  };
  refresh();
  return {
    el,
    refresh,
    show(pat, queued) {
      if (pat === playing && queued === waiting) return;
      playing = pat;
      waiting = queued;
      refresh();
    },
  };
}
