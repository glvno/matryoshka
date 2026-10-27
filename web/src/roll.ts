// SPDX-License-Identifier: GPL-3.0-only
// The piano roll (#136, design A of the #132 canvas; Ableton-style editing since the #136 follow-up): a drawer over the canvas, above the
// dock, full width, for one Steps track. All 64 steps in one row across under a ruler (bar numbers; drag the length
// marker to set `len`), a keyboard down the side (the wheel scrolls through the pitches; a press plays the key into the
// track's instrument; the keys Main plays light up; the pointer's key shows its name), a velocity lane under the notes,
// the playhead, the steps past `len` dimmed. A track whose keys go into a Drum map (#137) shows the map's rows instead of
// the keyboard; Fold shows only the pitches the track uses.
// Editing as in Ableton Live's MIDI editor:
//   a click on a note selects it (Shift: adds / takes it away), a drag moves the selection (Option: a copy), its right
//   edge its length, its left edge its start; Cmd-drag up / down its velocity; a press on the empty grid draws a band
//   round notes (Shift: adds) and puts the insert marker on that step; a double click adds a note there or removes the
//   one clicked; right-click removes one. Draw mode (B, or the pencil): a press paints notes, a drag paints one per step;
//   a press on a note removes it, a drag removes along. Keys: Delete / Backspace remove the selection, arrows move it a
//   step / a semitone (Shift + up / down: an octave; Shift + left / right: shorter / longer), Cmd-A all, Cmd-C / X / V
//   copy / cut / paste (at the insert marker), Cmd-D the selection again after itself, B draw mode, Esc deselect /
//   close. Every gesture is one undo step. While the focus is in the roll it keeps these keys (none reaches the canvas).
// The editor owns the patch: the roll reads the track through `ops.track()` and writes through `ops.notes`.
import { NOTE_NAMES } from './modules';
import type { ModuleInst } from './patch';
import { renamedKey } from './storage-key';
import { fixNotes, STEP_VEL, STEPS_MAX, STEPS_RATES, type StepNote } from './track';

export interface RollOps {
  /** the track as it is now (null: it is gone) and its label */
  track(): ModuleInst | null;
  /** the pattern strip for the header (pattern-strip.ts, #375) */
  strip?(): HTMLElement;
  label(): string;
  /** what it plays (poly.ts trackTargets) */
  plays(): string[];
  /** the rows of the Drum map its keys go into (#137: the roll shows them instead of a keyboard), or null */
  drums(): { name: string; note: number }[] | null;
  /** the track's new notes (inside begin / its result: one undo step) */
  notes(n: StepNote[] | undefined): void;
  begin(): () => void;
  /** the track's length (steps), from the ruler's marker */
  len(n: number): void;
  /** a note into the track's instrument (vel 0: let go), to hear it */
  play(note: number, vel: number): void;
  arm(on: boolean): void;
  armed(): boolean;
  rec(on: boolean): void;
  recording(): boolean;
  close(): void;
}

/** px per pitch row, of the keyboard's width, of a note's ends that change its length / start */
const RH = 12;
const EDGE = 6;
const BLACK = new Set([1, 3, 6, 8, 10]);
/** the drawer's height (px) when nothing was set; the user's own is kept per browser */
const ROLL_H = renamedKey('matryoshka.roll-h', 'modular-1.roll-h');
const ROLL_H_MIN = 200;
/** px of vertical drag per velocity step (Cmd-drag on a note) */
const VEL_PX = 1;

const id = (n: StepNote): string => `${n.at}:${n.note}`;
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
const same = (a: StepNote, b: StepNote): boolean => a.at === b.at && a.note === b.note;
/** notes laid over others: a note on the same step and pitch gives way */
const over = (top: StepNote[], under: StepNote[]): StepNote[] => [...top, ...under.filter((o) => !top.some((n) => same(n, o)))];

export class PianoRoll {
  readonly el: HTMLElement;
  private draw = false;
  private fold = false;
  /** the highest pitch shown (the top row) */
  private top = 84;
  private sel = new Set<string>();
  private pos = -1;
  /** the velocity and length a new note gets: the last ones drawn or set */
  private vel = STEP_VEL;
  private newLen = 1;
  /** the insert marker: where Cmd-V pastes (a press on the empty grid sets it) */
  private marker = 0;
  /** the copied notes, from the first one's step */
  private clip: StepNote[] = [];
  /** the pitches Main's keys hold now and the ones the roll's own keys sound (both light their keys) */
  private held = new Set<number>();
  private own = new Set<number>();
  /** the folded rows while a gesture runs (so a note moved does not reshuffle them under the pointer) */
  private frozen: number[] | null = null;
  private nameEl: HTMLElement;
  private playsEl: HTMLElement;
  private armBtn: HTMLButtonElement;
  private recBtn: HTMLButtonElement;
  private drawBtn: HTMLButtonElement;
  private foldBtn: HTMLButtonElement;
  private infoEl: HTMLElement;
  private lenEl: HTMLElement;
  private ruler: HTMLElement;
  private keys: HTMLElement;
  private grid: HTMLElement;
  private notesEl: HTMLElement;
  private past: HTMLElement;
  private playhead: HTMLElement;
  private markerEl: HTMLElement;
  private velLane: HTMLElement;
  private band: HTMLElement;

  constructor(private ops: RollOps) {
    const el = (this.el = document.createElement('section'));
    el.className = 'roll';
    el.tabIndex = -1;
    el.setAttribute('aria-label', 'Piano roll');
    try {
      const h = Number(localStorage.getItem(ROLL_H));
      if (h >= ROLL_H_MIN) el.style.height = `${h}px`;
    } catch { /* (no storage: the default height) */ }

    const head = document.createElement('div');
    head.className = 'roll-head';
    const grip = document.createElement('span');
    grip.className = 'roll-grip';
    grip.title = 'drag to make the roll taller or shorter';
    grip.onpointerdown = (e) => this.resize(e);
    this.nameEl = document.createElement('b');
    this.nameEl.className = 'roll-name';
    this.playsEl = document.createElement('span');
    this.playsEl.className = 'roll-plays';
    const btn = (text: string, cls: string, title: string, on: () => void): HTMLButtonElement => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = cls;
      b.textContent = text;
      b.title = title;
      // (the focus goes back to the roll: Space stays the transport, Delete stays the roll's)
      b.onclick = () => {
        on();
        this.el.focus({ preventScroll: true });
      };
      return b;
    };
    this.armBtn = btn('arm', 'roll-arm', 'ARM: Main’s keys play into this track and through to its instrument', () => this.ops.arm(!this.ops.armed()));
    this.recBtn = btn('● rec', 'roll-rec', 'REC (Shift+R): stopped, step entry on the card’s cursor; running, play along (each pass overdubs, one undo step)', () => this.ops.rec(!this.ops.recording()));
    this.lenEl = document.createElement('span');
    this.lenEl.className = 'roll-len';
    this.drawBtn = btn('✎ draw', 'roll-tool', 'Draw mode (B): a press paints a note, a drag one per step; a press on a note removes it', () => this.setDraw(!this.draw));
    this.foldBtn = btn('fold', 'roll-tool', 'Fold: only the pitches this track uses', () => this.setFold(!this.fold));
    const help = document.createElement('span');
    help.className = 'roll-help';
    help.textContent = '?';
    help.title = 'Click a note: select (Shift adds). Drag: move (Option: copy), its edges: length / start, Cmd-drag: velocity.\n'
      + 'Empty grid: drag a band; double-click adds a note, double-click a note removes it; right-click removes.\n'
      + 'Delete removes the selection; arrows move it (Shift + ↑↓ an octave, Shift + ←→ length); Cmd-A / C / X / V / D; B draw mode; Esc.';
    this.infoEl = document.createElement('span');
    this.infoEl.className = 'roll-info';
    const close = btn('×', 'roll-close', 'close the roll (Esc)', () => this.ops.close());
    close.setAttribute('aria-label', 'Close the roll');
    head.append(grip, this.nameEl, this.playsEl, this.armBtn, this.recBtn, this.lenEl, this.drawBtn, this.foldBtn, help, this.infoEl, close);
    const strip = ops.strip?.();
    if (strip) head.insertBefore(strip, this.lenEl);

    const rulerRow = document.createElement('div');
    rulerRow.className = 'roll-ruler-row';
    const corner = document.createElement('span');
    corner.className = 'roll-corner';
    this.ruler = document.createElement('div');
    this.ruler.className = 'roll-ruler';
    this.ruler.title = 'drag: the track’s length (the steps after it are dimmed)';
    rulerRow.append(corner, this.ruler);

    const body = document.createElement('div');
    body.className = 'roll-body';
    this.keys = document.createElement('div');
    this.keys.className = 'roll-keys';
    this.grid = document.createElement('div');
    this.grid.className = 'roll-grid';
    this.notesEl = document.createElement('div');
    this.notesEl.className = 'roll-notes';
    this.past = document.createElement('div');
    this.past.className = 'roll-past';
    this.playhead = document.createElement('div');
    this.playhead.className = 'roll-playhead';
    this.markerEl = document.createElement('div');
    this.markerEl.className = 'roll-marker';
    this.band = document.createElement('div');
    this.band.className = 'roll-band';
    this.band.hidden = true;
    this.grid.append(this.notesEl, this.past, this.markerEl, this.playhead, this.band);
    body.append(this.keys, this.grid);

    const vel = document.createElement('div');
    vel.className = 'roll-vel';
    const velName = document.createElement('span');
    velName.className = 'roll-vel-name';
    velName.textContent = 'vel';
    this.velLane = document.createElement('div');
    this.velLane.className = 'roll-vel-lane';
    this.velLane.title = 'press and sweep: the velocity of the notes starting on each step (the selected ones, if any are there)';
    vel.append(velName, this.velLane);
    el.append(head, rulerRow, body, vel);

    this.grid.addEventListener('pointerdown', (e) => this.gridDown(e));
    this.grid.addEventListener('dblclick', (e) => this.gridDouble(e));
    this.grid.addEventListener('pointermove', (e) => this.hover(e));
    this.grid.addEventListener('contextmenu', (e) => e.preventDefault());
    this.grid.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    this.keys.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    this.keys.addEventListener('pointerdown', (e) => this.keyDown(e));
    this.keys.addEventListener('pointermove', (e) => this.keyHover(e));
    this.keys.addEventListener('pointerleave', () => this.keyHover(null));
    this.velLane.addEventListener('pointerdown', (e) => this.velDown(e));
    this.ruler.addEventListener('pointerdown', (e) => this.rulerDown(e));
    new ResizeObserver(() => this.render()).observe(this.grid);
  }

  private get notes(): StepNote[] {
    return this.ops.track()?.notes ?? [];
  }
  private get len(): number {
    return clamp(Math.round(this.ops.track()?.params.len ?? 16), 1, STEPS_MAX);
  }
  /** px per step */
  private get sw(): number {
    return Math.max(1, this.grid.clientWidth) / STEPS_MAX;
  }
  /** the rows as a list of pitches, top first (a Drum map's, or the folded pitches), or null: every pitch from `top` down */
  private get list(): number[] | null {
    const d = this.ops.drums();
    if (d) return d.map((x) => x.note);
    if (!this.fold) return null;
    if (this.frozen) return this.frozen;
    const ps = [...new Set([...this.notes.map((n) => n.note), ...this.held])].sort((a, b) => b - a);
    return ps.length ? ps : null;
  }
  private get rows(): number {
    const l = this.list;
    return l ? l.length : Math.max(1, Math.ceil(this.grid.clientHeight / RH));
  }
  /** px per row: a pitch's, or a listed row's (the rows fill the height) */
  private get rh(): number {
    const l = this.list;
    if (!l) return RH;
    return this.ops.drums() ? clamp(Math.floor(this.grid.clientHeight / l.length), 14, 48) : clamp(Math.floor(this.grid.clientHeight / l.length), 8, 28);
  }
  /** the row a note is drawn on (the top row 0; may be out of view; a note not in the list: -1) and the note of a row */
  private rowOf(note: number): number {
    const l = this.list;
    return l ? l.indexOf(note) : this.top - note;
  }
  private noteAt(row: number): number {
    const l = this.list;
    return l ? l[clamp(row, 0, l.length - 1)] : clamp(this.top - row, 0, 127);
  }
  /** the rows a note may move to */
  private get rowRange(): [number, number] {
    const l = this.list;
    return l ? [0, l.length - 1] : [this.top - 127, this.top];
  }

  /** the pitches in view round the track's notes (C4 for an empty track), once the grid has its size */
  private centred = false;
  private centre(): void {
    const ns = this.notes.map((n) => n.note);
    const mid = ns.length ? Math.round((Math.min(...ns) + Math.max(...ns)) / 2) : 60;
    this.top = clamp(mid + Math.floor(this.rows / 2), this.rows - 1, 127);
    this.centred = true;
  }

  private setDraw(on: boolean): void {
    this.draw = on;
    this.el.classList.toggle('drawing', on);
    this.drawBtn.classList.toggle('on', on);
    this.drawBtn.setAttribute('aria-pressed', String(on));
    this.render();
  }
  private setFold(on: boolean): void {
    this.fold = on;
    this.foldBtn.classList.toggle('on', on);
    this.foldBtn.setAttribute('aria-pressed', String(on));
    this.render();
  }

  /** the playhead (-1: none) */
  show(pos: number): void {
    if (pos === this.pos) return;
    this.pos = pos;
    this.placePlayhead();
  }

  private placePlayhead(): void {
    this.playhead.hidden = this.pos < 0;
    this.playhead.style.left = `${this.pos * this.sw}px`;
    this.playhead.style.width = `${this.sw}px`;
  }

  /** a key Main plays went down / up: its key lights while held (armed or not, recording or not) */
  heldKey(note: number, on: boolean): void {
    if (on) this.held.add(note);
    else this.held.delete(note);
    if (this.fold && !this.ops.drums() && !this.notes.some((n) => n.note === note)) this.render();   // (a folded row comes and goes)
    else this.paintHeld();
  }

  private paintHeld(): void {
    this.keys.querySelectorAll<HTMLElement>('.roll-key').forEach((k) => {
      const n = Number(k.dataset.note);
      k.classList.toggle('held', this.held.has(n) || this.own.has(n));
    });
  }

  /** draw everything again from the track (an edit here or elsewhere, undo, the arming) */
  render(): void {
    const m = this.ops.track();
    if (!m) return;
    this.nameEl.textContent = this.ops.label();
    const plays = this.ops.plays();
    this.playsEl.textContent = plays.length ? `→ ${plays.join(', ')}` : '→ nothing yet';
    const armed = this.ops.armed(), rec = this.ops.recording();
    this.armBtn.classList.toggle('on', armed);
    this.armBtn.setAttribute('aria-pressed', String(armed));
    this.recBtn.classList.toggle('on', rec);
    this.recBtn.setAttribute('aria-pressed', String(rec));
    this.el.classList.toggle('armed', armed);
    this.lenEl.textContent = `length ${this.len} · rate ${STEPS_RATES[clamp(Math.round(m.params.rate ?? 4), 0, STEPS_RATES.length - 1)]}`;
    const drums = this.ops.drums();
    this.foldBtn.hidden = !!drums;
    if (!this.centred && this.grid.clientHeight > 0) this.centre();
    const sw = this.sw, rows = this.rows, rh = this.rh, list = this.list;
    if (!list) this.top = clamp(this.top, rows - 1, 127);
    this.el.classList.toggle('drums', !!drums);
    this.el.classList.toggle('listed', !!list);
    this.grid.style.setProperty('--rh', `${rh}px`);
    // the keyboard down the side (a Drum map's rows: their names and notes; folded: every key with its name)
    const keys: HTMLElement[] = [];
    for (let r = 0; r < rows; r++) {
      if (!list && this.top - r < 0) break;
      const n = this.noteAt(r);
      const k = document.createElement('div');
      k.style.top = `${r * rh}px`;
      k.style.height = `${rh}px`;
      k.dataset.note = String(n);
      k.dataset.name = this.pitchName(n);
      if (drums) {
        k.className = 'roll-key drum';
        const nm = document.createElement('b');
        nm.textContent = drums[r].name;
        const no = document.createElement('span');
        no.textContent = NOTE_NAMES[n];
        k.append(nm, no);
      } else {
        k.className = 'roll-key' + (BLACK.has(n % 12) ? ' black' : '');
        if (n % 12 === 0 || list) k.textContent = NOTE_NAMES[n];
      }
      keys.push(k);
    }
    this.keys.replaceChildren(...keys);
    this.paintHeld();
    this.paintRows(rows);
    this.paintRuler();
    this.past.style.left = `${this.len * sw}px`;
    this.past.hidden = this.len >= STEPS_MAX;
    this.markerEl.style.left = `${this.marker * sw}px`;
    // the notes
    const ns = this.notes;
    this.sel = new Set([...this.sel].filter((s) => ns.some((n) => id(n) === s)));
    this.notesEl.replaceChildren(...ns.filter((n) => { const r = this.rowOf(n.note); return r >= 0 && r < rows; }).map((n) => {
      const d = document.createElement('div');
      d.className = 'roll-note' + (this.sel.has(id(n)) ? ' sel' : '') + (n.at >= this.len ? ' past' : '');
      d.style.left = `${n.at * sw + 1}px`;
      d.style.top = `${this.rowOf(n.note) * rh + 1}px`;
      d.style.height = `${rh - 2}px`;
      d.style.width = `${Math.max(3, n.len * sw - 2)}px`;
      d.style.setProperty('--vel', String(n.vel / 127));
      d.title = this.describe(n);
      return d;
    }));
    // the velocity lane: a bar per note at its start
    this.velLane.replaceChildren(...ns.map((n) => {
      const b = document.createElement('i');
      b.className = 'roll-vbar' + (this.sel.has(id(n)) ? ' sel' : '');
      b.style.left = `${n.at * sw + 2}px`;
      b.style.height = `${(n.vel / 127) * 100}%`;
      return b;
    }));
    this.placePlayhead();
  }

  /** the black keys' rows (darker) and a line under every C behind the notes; the step, beat and bar lines as the grid's
   * background */
  private paintRows(rows: number): void {
    this.grid.querySelectorAll('.roll-row').forEach((r) => r.remove());
    const strips: HTMLElement[] = [];
    const list = this.list, rh = this.rh;
    for (let r = 0; r < rows; r++) {
      const n = this.noteAt(r);
      if (!list && this.top - r < 0) break;
      if (list ? r % 2 === 0 : !BLACK.has(n % 12) && n % 12 !== 0) continue;
      const s = document.createElement('div');
      s.className = 'roll-row' + (list || BLACK.has(n % 12) ? ' black' : ' octave');
      s.style.top = `${r * rh}px`;
      s.style.height = `${rh}px`;
      strips.push(s);
    }
    this.grid.prepend(...strips);
    this.grid.style.backgroundImage = [
      `repeating-linear-gradient(90deg, var(--roll-bar) 0 1px, transparent 1px ${16 * this.sw}px)`,
      `repeating-linear-gradient(90deg, var(--roll-beat) 0 1px, transparent 1px ${4 * this.sw}px)`,
      `repeating-linear-gradient(90deg, var(--roll-step) 0 1px, transparent 1px ${this.sw}px)`,
    ].join(', ');
  }

  /** the ruler: bar numbers (16 steps a bar) and beats, the length marker */
  private paintRuler(): void {
    const sw = this.sw, out: HTMLElement[] = [];
    for (let k = 0; k < STEPS_MAX; k += 4) {
      const t = document.createElement('span');
      t.className = k % 16 === 0 ? 'roll-bar-no' : 'roll-beat-no';
      t.style.left = `${k * sw}px`;
      t.textContent = k % 16 === 0 ? String(k / 16 + 1) : `${Math.floor(k / 16) + 1}.${(k % 16) / 4 + 1}`;
      out.push(t);
    }
    const lenMark = document.createElement('span');
    lenMark.className = 'roll-len-mark';
    lenMark.style.left = `${this.len * sw}px`;
    lenMark.title = `length ${this.len}: drag`;
    const fill = document.createElement('span');
    fill.className = 'roll-len-fill';
    fill.style.width = `${this.len * sw}px`;
    this.ruler.replaceChildren(fill, ...out, lenMark);
  }

  private describe(n: StepNote): string {
    return `step ${n.at + 1} · ${this.pitchName(n.note)} · ${n.len} step${n.len > 1 ? 's' : ''} · vel ${n.vel}${n.chance ? ` · ${n.chance} %` : ''}`;
  }

  /** a note by what its row says: a Drum map row's name, else the pitch */
  private pitchName(note: number): string {
    const d = this.ops.drums()?.find((x) => x.note === note);
    return d ? `${d.name} (${NOTE_NAMES[note]})` : NOTE_NAMES[note];
  }

  /** the step, row and note under a pointer (unclamped step; the row clamped to the ones there are) */
  private at(e: { clientX: number; clientY: number }): { k: number; row: number; note: number; x: number; y: number } {
    const r = this.grid.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const [lo, hi] = this.rowRange;
    const row = clamp(Math.floor(y / this.rh), lo, hi);
    return { k: Math.floor(x / this.sw), row, note: this.noteAt(row), x, y };
  }

  /** the note under a pointer (its start step and row), and whether the pointer is on its right / left edge */
  private hit(e: { clientX: number; clientY: number }): { n: StepNote; end: boolean; start: boolean } | null {
    const { row, x, y } = this.at(e);
    if (y < 0 || y >= this.rows * this.rh) return null;
    const n = this.notes.find((q) => this.rowOf(q.note) === row && x >= q.at * this.sw && x < (q.at + q.len) * this.sw);
    if (!n) return null;
    const x0 = n.at * this.sw, x1 = (n.at + n.len) * this.sw, edges = x1 - x0 >= 3 * EDGE;
    return { n, end: x >= x1 - EDGE, start: edges && x < x0 + EDGE };
  }

  private hover(e: PointerEvent): void {
    if (e.buttons) return;
    const h = this.hit(e);
    const { k, note } = this.at(e);
    this.grid.style.cursor = this.draw ? (h ? 'not-allowed' : 'cell') : h?.end || h?.start ? 'ew-resize' : e.metaKey && h ? 'ns-resize' : h ? 'grab' : 'default';
    this.infoEl.textContent = h ? this.describe(h.n) : k >= 0 && k < STEPS_MAX ? `step ${k + 1} · ${this.pitchName(note)}` : '';
  }

  private write(ns: StepNote[]): void {
    this.ops.notes(fixNotes(ns));
    this.render();
  }

  private picked(): StepNote[] {
    return this.notes.filter((n) => this.sel.has(id(n)));
  }

  /** a press-and-drag on the grid: draw mode paints / removes; else select, move, copy, resize, velocity or a band */
  private gridDown(e: PointerEvent): void {
    if (e.button !== 0 && e.button !== 2) return;
    e.preventDefault();
    this.el.focus({ preventScroll: true });
    try { this.grid.setPointerCapture(e.pointerId); } catch { /* (a synthetic pointer) */ }
    this.frozen = this.fold ? this.list : null;
    const end = this.ops.begin();
    const up = (move: (ev: PointerEvent) => void, done?: () => void): void => {
      this.grid.onpointermove = move;
      this.grid.onpointerup = this.grid.onpointercancel = () => {
        this.grid.onpointermove = this.grid.onpointerup = this.grid.onpointercancel = null;
        done?.();
        end();
        this.frozen = null;
        this.render();
      };
    };
    const h = this.hit(e);
    const start = this.at(e);
    // right-click: removes the note under it
    if (e.button === 2) {
      if (h) {
        this.sel.delete(id(h.n));
        this.write(this.notes.filter((n) => n !== h.n));
      }
      return up(() => {});
    }
    if (this.draw) return this.paint(e, h, up);
    if (!h) {
      if (start.k >= 0 && start.k < STEPS_MAX) this.marker = start.k;
      return this.rubberBand(e, up);
    }
    // a click on a note selects it (Shift: adds / takes away; a press on a note already selected keeps the selection)
    const was = this.sel.has(id(h.n));
    if (e.shiftKey) {
      if (was) this.sel.delete(id(h.n));
      else this.sel.add(id(h.n));
      this.render();
      if (was) return up(() => {});
    } else if (!was) {
      this.sel = new Set([id(h.n)]);
      this.render();
    }
    this.vel = h.n.vel;
    this.newLen = h.n.len;
    const moving = this.picked();
    if (e.metaKey || e.ctrlKey) return this.velDrag(e, moving, up);
    if (h.end || h.start) return this.resizeDrag(h.n, h.end, moving, up);
    this.moveDrag(h.n, start, moving, e.altKey, up);
  }

  /** move the selection (Option held at the press: a copy, the originals stay); it sounds the note under the pointer */
  private moveDrag(lead: StepNote, start: { k: number; row: number }, moving: StepNote[], copy: boolean, up: (move: (ev: PointerEvent) => void, done?: () => void) => void): void {
    const others = copy ? this.notes : this.notes.filter((n) => !moving.includes(n));
    const minAt = Math.min(...moving.map((n) => n.at)), maxAt = Math.max(...moving.map((n) => n.at));
    // (rows, not pitches: a Drum map's rows are not in pitch order; a note whose row is not shown stays)
    const listed = !!this.list;
    const rowsOf = moving.map((n) => this.rowOf(n.note)).filter((r) => r >= 0 || !listed);
    const [rlo, rhi] = this.rowRange;
    const top = Math.min(...rowsOf), bottom = Math.max(...rowsOf);
    let last = { dk: 0, dr: 0 };
    this.ops.play(lead.note, lead.vel);
    let sounding = lead.note;
    const shift = (n: StepNote, dr: number): number => { const r = this.rowOf(n.note); return r < 0 && listed ? n.note : this.noteAt(r + dr); };
    up((ev) => {
      const p = this.at(ev);
      const dk = clamp(p.k - start.k, -minAt, STEPS_MAX - 1 - maxAt);
      const dr = clamp(p.row - start.row, rlo - top, rhi - bottom);
      if (dk === last.dk && dr === last.dr) return;
      last = { dk, dr };
      const moved = moving.map((n) => ({ ...n, at: n.at + dk, note: shift(n, dr) }));
      this.sel = new Set(moved.map(id));
      if (shift(lead, dr) !== sounding) {
        this.ops.play(sounding, 0);
        sounding = shift(lead, dr);
        this.ops.play(sounding, lead.vel);
      }
      this.write(over(moved, others));
    }, () => this.ops.play(sounding, 0));
  }

  /** a selected note's right edge: every selected note's length by the same steps; its left edge: their starts (ends stay) */
  private resizeDrag(lead: StepNote, right: boolean, moving: StepNote[], up: (move: (ev: PointerEvent) => void, done?: () => void) => void): void {
    const others = this.notes.filter((n) => !moving.includes(n));
    const k0 = right ? lead.at + lead.len - 1 : lead.at;
    up((ev) => {
      const d = this.at(ev).k - k0;
      const changed = moving.map((n) => {
        if (right) return { ...n, len: clamp(n.len + d, 1, STEPS_MAX) };
        const end = n.at + n.len, at = clamp(n.at + d, Math.max(0, end - STEPS_MAX), Math.min(STEPS_MAX - 1, end - 1));
        return { ...n, at, len: end - at };
      });
      this.sel = new Set(changed.map(id));
      this.newLen = changed.find((n) => n.note === lead.note)?.len ?? this.newLen;
      this.infoEl.textContent = right ? `length ${clamp(lead.len + d, 1, STEPS_MAX)}` : `start ${clamp(lead.at + d, Math.max(0, lead.at + lead.len - STEPS_MAX), Math.min(STEPS_MAX - 1, lead.at + lead.len - 1)) + 1}`;
      this.write(over(changed, others));
    });
  }

  /** Cmd-drag on a note: the selection's velocities up / down, each by the same amount */
  private velDrag(e: PointerEvent, moving: StepNote[], up: (move: (ev: PointerEvent) => void, done?: () => void) => void): void {
    const y0 = e.clientY;
    up((ev) => {
      const d = Math.round((y0 - ev.clientY) / VEL_PX);
      const changed = moving.map((n) => ({ ...n, vel: clamp(n.vel + d, 1, 127) }));
      this.vel = changed[0]?.vel ?? this.vel;
      this.infoEl.textContent = `vel ${this.vel}${changed.length > 1 ? ` (${changed.length} notes)` : ''}`;
      this.write(over(changed, this.notes.filter((n) => !moving.includes(n))));
    });
  }

  /** draw mode: a press on a note removes it (a drag removes along); on the empty grid it paints a note at the length last
   * used, a drag one per step under the pointer */
  private paint(e: PointerEvent, h: { n: StepNote } | null, up: (move: (ev: PointerEvent) => void, done?: () => void) => void): void {
    if (h) {
      const erase = (ev: PointerEvent): void => {
        const q = this.hit(ev);
        if (q) this.write(this.notes.filter((n) => n !== q.n));
      };
      erase(e);
      return up(erase);
    }
    let sounding = -1;
    const put = (ev: PointerEvent): void => {
      const p = this.at(ev);
      if (p.k < 0 || p.k >= STEPS_MAX || this.hit(ev)) return;
      const n: StepNote = { at: p.k, len: this.newLen, note: p.note, vel: this.vel };
      if (this.notes.some((q) => same(q, n))) return;
      this.write([...this.notes, n]);
      if (sounding >= 0) this.ops.play(sounding, 0);
      sounding = n.note;
      this.ops.play(n.note, n.vel);
    };
    put(e);
    up(put, () => { if (sounding >= 0) this.ops.play(sounding, 0); });
  }

  /** a double click: a note removed, or one added on the empty spot (selected, at the length and velocity last used) */
  private gridDouble(e: MouseEvent): void {
    if (this.draw) return;
    const h = this.hit(e);
    const end = this.ops.begin();
    if (h) {
      this.sel.delete(id(h.n));
      this.write(this.notes.filter((n) => !same(n, h.n)));
    } else {
      const p = this.at(e);
      if (p.k >= 0 && p.k < STEPS_MAX && p.y >= 0 && p.y < this.rows * this.rh) {
        const n: StepNote = { at: p.k, len: this.newLen, note: p.note, vel: this.vel };
        this.sel = new Set([id(n)]);
        this.write(over([n], this.notes));
        this.ops.play(n.note, n.vel);
        setTimeout(() => this.ops.play(n.note, 0), 200);
      }
    }
    end();
  }

  /** a press on the empty grid: a band; the notes it touches are the selection (Shift adds to it); a click clears it */
  private rubberBand(e: PointerEvent, up: (move: (ev: PointerEvent) => void, done?: () => void) => void): void {
    const r = this.grid.getBoundingClientRect();
    const x0 = e.clientX - r.left, y0 = e.clientY - r.top;
    const keep = e.shiftKey ? new Set(this.sel) : new Set<string>();
    this.sel = new Set(keep);
    this.render();
    up((ev) => {
      const x1 = ev.clientX - r.left, y1 = ev.clientY - r.top;
      if (this.band.hidden && Math.abs(x1 - x0) + Math.abs(y1 - y0) < 4) return;
      this.band.hidden = false;
      const [l, rr] = [Math.min(x0, x1), Math.max(x0, x1)], [t, b] = [Math.min(y0, y1), Math.max(y0, y1)];
      Object.assign(this.band.style, { left: `${l}px`, top: `${t}px`, width: `${rr - l}px`, height: `${b - t}px` });
      this.sel = new Set(keep);
      for (const n of this.notes) {
        const row = this.rowOf(n.note);
        if (row < 0 && this.list) continue;
        const nx0 = n.at * this.sw, nx1 = (n.at + n.len) * this.sw, ny0 = row * this.rh, ny1 = ny0 + this.rh;
        if (nx1 > l && nx0 < rr && ny1 > t && ny0 < b) this.sel.add(id(n));
      }
      this.render();
    }, () => (this.band.hidden = true));
  }

  /** the side keyboard: a press plays the key into the track's instrument (it lights), a drag down the keys plays along */
  private keyDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    e.preventDefault();
    this.el.focus({ preventScroll: true });
    try { this.keys.setPointerCapture(e.pointerId); } catch { /* (a synthetic pointer) */ }
    let note = this.at(e).note;
    const on = (n: number): void => { this.own.add(n); this.ops.play(n, this.vel); this.paintHeld(); };
    const off = (n: number): void => { this.own.delete(n); this.ops.play(n, 0); this.paintHeld(); };
    on(note);
    this.keys.onpointermove = (ev) => {
      const n = this.at(ev).note;
      if (n === note) return;
      off(note);
      note = n;
      on(note);
    };
    this.keys.onpointerup = this.keys.onpointercancel = () => {
      this.keys.onpointermove = this.keys.onpointerup = this.keys.onpointercancel = null;
      off(note);
    };
  }

  /** the pointer over the keyboard: that key shows its name (and the header says it) */
  private hovered: HTMLElement | null = null;
  private keyHover(e: PointerEvent | null): void {
    const k = e ? this.keys.querySelector<HTMLElement>(`.roll-key[data-note="${this.at(e).note}"]`) : null;
    if (k === this.hovered) return;
    this.hovered?.classList.remove('hover');
    this.hovered = k;
    k?.classList.add('hover');
    if (k) this.infoEl.textContent = k.dataset.name ?? '';
  }

  /** the velocity lane: the pointer's height is the velocity of the notes starting on the step under it */
  private velDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    e.preventDefault();
    this.el.focus({ preventScroll: true });
    try { this.velLane.setPointerCapture(e.pointerId); } catch { /* (a synthetic pointer) */ }
    const end = this.ops.begin();
    const set = (ev: PointerEvent): void => {
      const r = this.velLane.getBoundingClientRect();
      const k = Math.floor((ev.clientX - r.left) / this.sw);
      const v = clamp(Math.round(((r.bottom - ev.clientY) / Math.max(1, r.height)) * 127), 1, 127);
      const there = this.notes.filter((n) => n.at === k);
      const which = there.some((n) => this.sel.has(id(n))) ? there.filter((n) => this.sel.has(id(n))) : there;
      if (!which.length || which.every((n) => n.vel === v)) return;
      this.vel = v;
      this.infoEl.textContent = `step ${k + 1} · vel ${v}`;
      this.write(this.notes.map((n) => (which.includes(n) ? { ...n, vel: v } : n)));
    };
    set(e);
    this.velLane.onpointermove = set;
    this.velLane.onpointerup = this.velLane.onpointercancel = () => {
      this.velLane.onpointermove = this.velLane.onpointerup = this.velLane.onpointercancel = null;
      end();
    };
  }

  /** the ruler: a press or drag sets the track's length to the step boundary nearest the pointer */
  private rulerDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    e.preventDefault();
    this.el.focus({ preventScroll: true });
    try { this.ruler.setPointerCapture(e.pointerId); } catch { /* (a synthetic pointer) */ }
    const set = (ev: PointerEvent): void => {
      const r = this.ruler.getBoundingClientRect();
      const n = clamp(Math.round((ev.clientX - r.left) / this.sw), 1, STEPS_MAX);
      if (n === this.len) return;
      this.ops.len(n);
      this.infoEl.textContent = `length ${n}`;
      this.render();
    };
    set(e);
    this.ruler.onpointermove = set;
    this.ruler.onpointerup = this.ruler.onpointercancel = () => {
      this.ruler.onpointermove = this.ruler.onpointerup = this.ruler.onpointercancel = null;
    };
  }

  private wheel(e: WheelEvent): void {
    e.preventDefault();
    if (this.list) return; // (a Drum map's rows, the folded ones: all in view)
    const d = Math.sign(e.deltaY) * Math.max(1, Math.round(Math.abs(e.deltaY) / 40));
    this.top = clamp(this.top - d, this.rows - 1, 127);
    this.render();
  }

  /** the drawer's grip: drag its height (kept per browser) */
  private resize(e: PointerEvent): void {
    e.preventDefault();
    const y0 = e.clientY, h0 = this.el.offsetHeight;
    const host = this.el.parentElement;
    const move = (ev: PointerEvent): void => {
      const max = (host?.clientHeight ?? 800) - 80;
      this.el.style.height = `${clamp(h0 + y0 - ev.clientY, ROLL_H_MIN, max)}px`;
    };
    const stop = (): void => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', stop);
      try { localStorage.setItem(ROLL_H, String(this.el.offsetHeight)); } catch { /* (no storage) */ }
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', stop);
  }

  /** one undo step of notes */
  private edit(ns: StepNote[]): void {
    const end = this.ops.begin();
    this.write(ns);
    end();
  }

  /** the view follows notes moved out of it */
  private follow(ns: StepNote[]): void {
    if (this.list || !ns.length) return;
    const hi = Math.max(...ns.map((n) => n.note)), lo = Math.min(...ns.map((n) => n.note));
    if (hi > this.top) this.top = Math.min(127, hi + 1);
    else if (lo <= this.top - this.rows) this.top = lo + this.rows - 2;
  }

  /** a key while the focus is in the roll (main.ts's key handler asks first): true when it was the roll's. The roll keeps
   * Delete, Backspace and the arrows even with nothing selected, so they never reach the canvas (a card, a nudge). */
  key(k: string, shift: boolean, mod: boolean, alt = false): boolean {
    if (k === 'Escape') {
      if (this.sel.size) {
        this.sel.clear();
        this.render();
      } else this.ops.close();
      return true;
    }
    const lower = k.toLowerCase();
    const picked = this.picked();
    const rest = this.notes.filter((n) => !this.sel.has(id(n)));
    if (mod) {
      if (lower === 'a') {
        this.sel = new Set(this.notes.map(id));
        this.render();
        return true;
      }
      if (lower === 'c' || lower === 'x') {
        if (!picked.length) return true;
        const at0 = Math.min(...picked.map((n) => n.at));
        this.clip = picked.map((n) => ({ ...n, at: n.at - at0 }));
        this.marker = Math.min(STEPS_MAX - 1, Math.max(...picked.map((n) => n.at + n.len)));
        if (lower === 'x') {
          this.sel.clear();
          this.edit(rest);
        }
        this.infoEl.textContent = `${picked.length} note${picked.length > 1 ? 's' : ''} ${lower === 'x' ? 'cut' : 'copied'}`;
        return true;
      }
      if (lower === 'v') {
        if (!this.clip.length) return true;
        const span = Math.max(...this.clip.map((n) => n.at + n.len));
        const at = clamp(this.marker, 0, STEPS_MAX - 1);
        const pasted = this.clip.filter((n) => at + n.at < STEPS_MAX).map((n) => ({ ...n, at: at + n.at }));
        this.sel = new Set(pasted.map(id));
        this.marker = Math.min(STEPS_MAX - 1, at + span);
        this.follow(pasted);
        this.edit(over(pasted, this.notes));
        return true;
      }
      if (lower === 'd') {
        if (!picked.length) return true;
        const a = Math.min(...picked.map((n) => n.at)), b = Math.max(...picked.map((n) => n.at + n.len));
        const copy = picked.filter((n) => n.at + (b - a) < STEPS_MAX).map((n) => ({ ...n, at: n.at + (b - a) }));
        if (!copy.length) return true;
        this.sel = new Set(copy.map(id));
        this.edit(over(copy, this.notes));
        return true;
      }
      return false; // (Cmd-Z and the rest: the editor's)
    }
    if (alt) return false;
    if (lower === 'b') {
      this.setDraw(!this.draw);
      return true;
    }
    if (k === 'Delete' || k === 'Backspace') {
      if (picked.length) {
        this.sel.clear();
        this.edit(rest);
      }
      return true;
    }
    const dk = k === 'ArrowLeft' ? -1 : k === 'ArrowRight' ? 1 : 0;
    const up = k === 'ArrowUp' ? 1 : k === 'ArrowDown' ? -1 : 0;
    if (!dk && !up) return false;
    if (!picked.length) {
      // (nothing selected: up / down scroll the pitches; the keys stay the roll's)
      if (up && !this.list) {
        this.top = clamp(this.top + up * (shift ? 12 : 1), this.rows - 1, 127);
        this.render();
      }
      return true;
    }
    if (dk && shift) {
      // Shift + left / right: every selected note a step shorter / longer
      const changed = picked.map((n) => ({ ...n, len: clamp(n.len + dk, 1, STEPS_MAX) }));
      this.newLen = changed[0].len;
      this.edit(over(changed, rest));
      return true;
    }
    // a step, a semitone (Shift: an octave), or on listed rows (a Drum map's, folded) a row
    const list = this.list;
    const to = (n: StepNote): number => {
      if (!list) return n.note + up * (shift ? 12 : 1);
      const r = this.rowOf(n.note);
      return r < 0 ? n.note : r - up < 0 || r - up >= list.length ? -1 : this.noteAt(r - up);
    };
    if (picked.some((n) => n.at + dk < 0 || n.at + dk >= STEPS_MAX || to(n) < 0 || to(n) > 127)) return true;
    const moved = picked.map((n) => ({ ...n, at: n.at + dk, note: to(n) }));
    this.sel = new Set(moved.map(id));
    this.follow(moved);
    if (up) {
      this.ops.play(moved[0].note, moved[0].vel);
      setTimeout(() => this.ops.play(moved[0].note, 0), 150);
    }
    this.edit(over(moved, rest));
    return true;
  }
}
