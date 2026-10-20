// SPDX-License-Identifier: GPL-3.0-only
// The piano roll (#136, design A of the #132 canvas): a drawer over the canvas, above the dock, full width, for one Steps
// track. All 64 steps in one row across, a keyboard down the side (the wheel scrolls through the pitches; a click on a key
// plays it into the track's instrument), a velocity lane under the notes, the playhead, the steps past `len` dimmed. A
// track whose keys go into a Drum map (#137) shows the map's rows instead of the keyboard: their names and notes.
// Tools: Draw (a press on an empty spot puts a note there, one step long, a drag sets its length; a drag on a note moves
// it, on its right end changes its length; Alt- or right-click removes one), Select (a rubber band; a drag moves the
// selection; arrows move it a step / a semitone, Shift: an octave; Delete / Backspace removes it), Erase (a click or a
// sweep removes). Every press-to-release is one undo step. The header carries the track's name, what it plays, ARM and
// REC (as on the card), its length and rate, the tools, what the pointer is over, and the close button. The editor owns
// the patch: the roll reads the track through `ops.track()` and writes through `ops.notes`.
import { ARP_RATES } from './arpeggiator';
import { NOTE_NAMES } from './modules';
import type { ModuleInst } from './patch';
import { fixNotes, STEP_VEL, STEPS_MAX, type StepNote } from './track';

export interface RollOps {
  /** the track as it is now (null: it is gone) and its label */
  track(): ModuleInst | null;
  label(): string;
  /** what it plays (poly.ts trackTargets) */
  plays(): string[];
  /** the rows of the Drum map its keys go into (#137: the roll shows them instead of a keyboard), or null */
  drums(): { name: string; note: number }[] | null;
  /** the track's new notes (inside begin / its result: one undo step) */
  notes(n: StepNote[] | undefined): void;
  begin(): () => void;
  /** a note into the track's instrument (vel 0: let go), to hear it */
  play(note: number, vel: number): void;
  arm(on: boolean): void;
  armed(): boolean;
  rec(on: boolean): void;
  recording(): boolean;
  close(): void;
}

type Tool = 'draw' | 'select' | 'erase';
const TOOLS: Tool[] = ['draw', 'select', 'erase'];

/** px per pitch row, of the keyboard's width, of a note's right end that changes its length */
const RH = 12;
const KEYS_W = 56;
const EDGE = 6;
const BLACK = new Set([1, 3, 6, 8, 10]);
/** the drawer's height (px) when nothing was set; the user's own is kept per browser */
const ROLL_H = 'modular-1.roll-h';
const ROLL_H_MIN = 200;

const id = (n: StepNote): string => `${n.at}:${n.note}`;
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

export class PianoRoll {
  readonly el: HTMLElement;
  private tool: Tool = 'draw';
  /** the highest pitch shown (the top row) */
  private top = 84;
  private sel = new Set<string>();
  private pos = -1;
  /** the velocity a new note gets: the last one drawn or set */
  private vel = STEP_VEL;
  private head: HTMLElement;
  private nameEl: HTMLElement;
  private playsEl: HTMLElement;
  private armBtn: HTMLButtonElement;
  private recBtn: HTMLButtonElement;
  private infoEl: HTMLElement;
  private lenEl: HTMLElement;
  private toolBtns: HTMLButtonElement[];
  private keys: HTMLElement;
  private grid: HTMLElement;
  private notesEl: HTMLElement;
  private past: HTMLElement;
  private playhead: HTMLElement;
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

    const head = (this.head = document.createElement('div'));
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
      b.onclick = on;
      return b;
    };
    this.armBtn = btn('arm', 'roll-arm', 'ARM: Main’s keys play into this track and through to its instrument', () => this.ops.arm(!this.ops.armed()));
    this.recBtn = btn('● rec', 'roll-rec', 'REC (Shift+R): stopped, step entry on the card’s cursor; running, play along (each pass overdubs, one undo step)', () => this.ops.rec(!this.ops.recording()));
    this.lenEl = document.createElement('span');
    this.lenEl.className = 'roll-len';
    const tools = document.createElement('span');
    tools.className = 'roll-tools';
    tools.setAttribute('role', 'group');
    const tips: Record<Tool, string> = {
      draw: 'Draw: press to put a note, drag for its length; drag a note to move it, its right end to lengthen it; Alt- or right-click removes',
      select: 'Select: drag a band round notes; drag them to move; arrows move a step / a semitone (Shift: an octave); Delete removes',
      erase: 'Erase: click or sweep over notes to remove them',
    };
    this.toolBtns = TOOLS.map((t) => btn(t, 'roll-tool', tips[t], () => this.setTool(t)));
    tools.append(...this.toolBtns);
    this.infoEl = document.createElement('span');
    this.infoEl.className = 'roll-info';
    const close = btn('×', 'roll-close', 'close the roll (Esc)', () => this.ops.close());
    close.setAttribute('aria-label', 'Close the roll');
    head.append(grip, this.nameEl, this.playsEl, this.armBtn, this.recBtn, this.lenEl, tools, this.infoEl, close);

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
    this.band = document.createElement('div');
    this.band.className = 'roll-band';
    this.band.hidden = true;
    this.grid.append(this.notesEl, this.past, this.playhead, this.band);
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
    el.append(head, body, vel);

    this.grid.addEventListener('pointerdown', (e) => this.gridDown(e));
    this.grid.addEventListener('pointermove', (e) => this.hover(e));
    this.grid.addEventListener('contextmenu', (e) => e.preventDefault());
    this.grid.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    this.keys.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    this.keys.addEventListener('pointerdown', (e) => this.keyDown(e));
    this.velLane.addEventListener('pointerdown', (e) => this.velDown(e));
    new ResizeObserver(() => this.render()).observe(this.grid);
    this.setTool('draw');
  }

  private get notes(): StepNote[] {
    return this.ops.track()?.notes ?? [];
  }
  private get len(): number {
    return clamp(Math.round(this.ops.track()?.params.len ?? 16), 1, STEPS_MAX);
  }
  /** px per step, rows shown */
  private get sw(): number {
    return Math.max(1, this.grid.clientWidth) / STEPS_MAX;
  }
  private get rows(): number {
    const d = this.ops.drums();
    return d ? d.length : Math.max(1, Math.ceil(this.grid.clientHeight / RH));
  }
  /** px per row: a pitch's, or a Drum map row's (the map's rows fill the height) */
  private get rh(): number {
    const d = this.ops.drums();
    return d ? clamp(Math.floor(this.grid.clientHeight / d.length), 14, 48) : RH;
  }
  /** the row a note is drawn on (the top row 0; may be out of view; a drum note not in the map: -1) and the note of a row */
  private rowOf(note: number): number {
    const d = this.ops.drums();
    return d ? d.findIndex((x) => x.note === note) : this.top - note;
  }
  private noteAt(row: number): number {
    const d = this.ops.drums();
    return d ? d[clamp(row, 0, d.length - 1)].note : clamp(this.top - row, 0, 127);
  }
  /** the rows a note may move to */
  private get rowRange(): [number, number] {
    const d = this.ops.drums();
    return d ? [0, d.length - 1] : [this.top - 127, this.top];
  }

  /** the pitches in view round the track's notes (C4 for an empty track), once the grid has its size */
  private centred = false;
  private centre(): void {
    const ns = this.notes.map((n) => n.note);
    const mid = ns.length ? Math.round((Math.min(...ns) + Math.max(...ns)) / 2) : 60;
    this.top = clamp(mid + Math.floor(this.rows / 2), this.rows - 1, 127);
    this.centred = true;
  }

  private setTool(t: Tool): void {
    this.tool = t;
    this.el.dataset.tool = t;
    this.toolBtns.forEach((b, i) => {
      b.classList.toggle('on', TOOLS[i] === t);
      b.setAttribute('aria-pressed', String(TOOLS[i] === t));
    });
    if (t !== 'select') this.sel.clear();
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
    this.lenEl.textContent = `length ${this.len} · rate ${ARP_RATES[clamp(Math.round(m.params.rate ?? 4), 0, ARP_RATES.length - 1)]}`;
    if (!this.centred && this.grid.clientHeight > 0) this.centre();
    const sw = this.sw, rows = this.rows, rh = this.rh, drums = this.ops.drums();
    if (!drums) this.top = clamp(this.top, rows - 1, 127);
    this.el.classList.toggle('drums', !!drums);
    this.grid.style.setProperty('--rh', `${rh}px`);
    // the keyboard down the side (a Drum map's rows: their names and notes), the rows behind the notes
    const keys: HTMLElement[] = [];
    for (let r = 0; r < rows; r++) {
      const n = this.noteAt(r);
      if (!drums && this.top - r < 0) break;
      const k = document.createElement('div');
      k.style.top = `${r * rh}px`;
      if (drums) {
        k.className = 'roll-key drum';
        k.style.height = `${rh}px`;
        const nm = document.createElement('b');
        nm.textContent = drums[r].name;
        const no = document.createElement('span');
        no.textContent = NOTE_NAMES[n];
        k.append(nm, no);
      } else {
        k.className = 'roll-key' + (BLACK.has(n % 12) ? ' black' : '');
        if (n % 12 === 0) k.textContent = NOTE_NAMES[n];
      }
      keys.push(k);
    }
    this.keys.replaceChildren(...keys);
    this.paintRows(rows);
    this.past.style.left = `${this.len * sw}px`;
    this.past.hidden = this.len >= STEPS_MAX;
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
    const drums = !!this.ops.drums(), rh = this.rh;
    for (let r = 0; r < rows; r++) {
      const n = this.top - r;
      if (!drums && n < 0) break;
      if (drums ? r % 2 === 0 : !BLACK.has(n % 12) && n % 12 !== 0) continue;
      const s = document.createElement('div');
      s.className = 'roll-row' + (drums || BLACK.has(n % 12) ? ' black' : ' octave');
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

  private describe(n: StepNote): string {
    return `step ${n.at + 1} · ${this.pitchName(n.note)} · ${n.len} step${n.len > 1 ? 's' : ''} · vel ${n.vel}${n.chance ? ` · ${n.chance} %` : ''}`;
  }

  /** a note by what its row says: a Drum map row's name, else the pitch */
  private pitchName(note: number): string {
    const d = this.ops.drums()?.find((x) => x.note === note);
    return d ? `${d.name} (${NOTE_NAMES[note]})` : NOTE_NAMES[note];
  }

  /** the step, row and note under a pointer (unclamped step; the row clamped to the ones there are) */
  private at(e: { clientX: number; clientY: number }): { k: number; row: number; note: number; x: number } {
    const r = this.grid.getBoundingClientRect();
    const x = e.clientX - r.left;
    const [lo, hi] = this.rowRange;
    const row = clamp(Math.floor((e.clientY - r.top) / this.rh), lo, hi);
    return { k: Math.floor(x / this.sw), row, note: this.noteAt(row), x };
  }

  /** the note under a pointer (its start step and row), and whether the pointer is on its right end */
  private hit(e: { clientX: number; clientY: number }): { n: StepNote; end: boolean } | null {
    const { row, x } = this.at(e);
    const n = this.notes.find((q) => this.rowOf(q.note) === row && x >= q.at * this.sw && x < (q.at + q.len) * this.sw);
    return n ? { n, end: x >= (n.at + n.len) * this.sw - EDGE } : null;
  }

  private hover(e: PointerEvent): void {
    if (e.buttons) return;
    const h = this.hit(e);
    const { k, note } = this.at(e);
    this.grid.style.cursor = this.tool === 'erase' ? 'not-allowed' : h?.end && this.tool === 'draw' ? 'ew-resize' : h ? 'grab' : this.tool === 'select' ? 'crosshair' : 'cell';
    this.infoEl.textContent = h ? this.describe(h.n) : k >= 0 && k < STEPS_MAX ? `step ${k + 1} · ${this.pitchName(note)}` : '';
  }

  private write(ns: StepNote[]): void {
    this.ops.notes(fixNotes(ns));
    this.render();
  }

  /** a press-and-drag on the grid by the tool in use (Alt / the right button erase in Draw) */
  private gridDown(e: PointerEvent): void {
    if (e.button !== 0 && e.button !== 2) return;
    e.preventDefault();
    this.el.focus({ preventScroll: true });
    try { this.grid.setPointerCapture(e.pointerId); } catch { /* (a synthetic pointer) */ }
    const end = this.ops.begin();
    const up = (move: (ev: PointerEvent) => void, done?: () => void): void => {
      this.grid.onpointermove = move;
      this.grid.onpointerup = this.grid.onpointercancel = () => {
        this.grid.onpointermove = this.grid.onpointerup = this.grid.onpointercancel = null;
        done?.();
        end();
        this.render();
      };
    };
    if (this.tool === 'erase' || (this.tool === 'draw' && (e.button === 2 || e.altKey))) {
      const erase = (ev: PointerEvent): void => {
        const h = this.hit(ev);
        if (h) this.write(this.notes.filter((n) => n !== h.n));
      };
      erase(e);
      return up(erase);
    }
    if (e.button !== 0) return up(() => {});
    const h = this.hit(e);
    const start = this.at(e);
    if (this.tool === 'select' && !h) return this.rubberBand(e, up);
    if (h && h.end && this.tool === 'draw') {
      // lengthen / shorten the note from its right end
      const n0 = h.n;
      return up((ev) => {
        const len = clamp(this.at(ev).k - n0.at + 1, 1, STEPS_MAX - n0.at);
        this.write(this.notes.map((n) => (n.at === n0.at && n.note === n0.note ? { ...n, len } : n)));
      });
    }
    if (h) {
      // move the note (Draw), or the selection it is in (Select: a press on another note selects it alone)
      if (this.tool === 'select' && !this.sel.has(id(h.n))) this.sel = new Set([id(h.n)]);
      const moving = this.tool === 'select' ? this.notes.filter((n) => this.sel.has(id(n))) : [h.n];
      const others = this.notes.filter((n) => !moving.includes(n));
      const minAt = Math.min(...moving.map((n) => n.at)), maxEnd = Math.max(...moving.map((n) => n.at + n.len));
      // (rows, not pitches: a Drum map's rows are not in pitch order; a note whose row is not shown stays)
      const rowsOf = moving.map((n) => this.rowOf(n.note)).filter((r) => r >= 0 || !this.ops.drums());
      const [rlo, rhi] = this.rowRange;
      const top = Math.min(...rowsOf), bottom = Math.max(...rowsOf);
      this.vel = h.n.vel;
      let last = { dk: 0, dr: 0 };
      this.ops.play(h.n.note, h.n.vel);
      let sounding = h.n.note;
      const shift = (n: StepNote, dr: number): number => { const r = this.rowOf(n.note); return r < 0 && this.ops.drums() ? n.note : this.noteAt(r + dr); };
      return up((ev) => {
        const p = this.at(ev);
        const dk = clamp(p.k - start.k, -minAt, STEPS_MAX - maxEnd);
        const dr = clamp(p.row - start.row, rlo - top, rhi - bottom);
        if (dk === last.dk && dr === last.dr) return;
        last = { dk, dr };
        const moved = moving.map((n) => ({ ...n, at: n.at + dk, note: shift(n, dr) }));
        if (this.tool === 'select') this.sel = new Set(moved.map(id));
        if (shift(h.n, dr) !== sounding) {
          this.ops.play(sounding, 0);
          sounding = shift(h.n, dr);
          this.ops.play(sounding, h.n.vel);
        }
        this.write([...moved, ...others.filter((o) => !moved.some((n) => n.at === o.at && n.note === o.note))]);
      }, () => this.ops.play(sounding, 0));
    }
    // Draw on an empty spot: a note one step long, a drag sets its length
    if (start.k < 0 || start.k >= STEPS_MAX) return up(() => {});
    const n0: StepNote = { at: start.k, len: 1, note: start.note, vel: this.vel };
    this.write([...this.notes, n0]);
    this.ops.play(n0.note, n0.vel);
    up((ev) => {
      const len = clamp(this.at(ev).k - n0.at + 1, 1, STEPS_MAX - n0.at);
      this.write(this.notes.map((n) => (n.at === n0.at && n.note === n0.note ? { ...n, len } : n)));
    }, () => this.ops.play(n0.note, 0));
  }

  /** Select on an empty spot: a band; the notes it touches are the selection (Shift adds to it) */
  private rubberBand(e: PointerEvent, up: (move: (ev: PointerEvent) => void, done?: () => void) => void): void {
    const r = this.grid.getBoundingClientRect();
    const x0 = e.clientX - r.left, y0 = e.clientY - r.top;
    const keep = e.shiftKey ? new Set(this.sel) : new Set<string>();
    this.sel = new Set(keep);
    this.render();
    this.band.hidden = false;
    up((ev) => {
      const x1 = ev.clientX - r.left, y1 = ev.clientY - r.top;
      const [l, rr] = [Math.min(x0, x1), Math.max(x0, x1)], [t, b] = [Math.min(y0, y1), Math.max(y0, y1)];
      Object.assign(this.band.style, { left: `${l}px`, top: `${t}px`, width: `${rr - l}px`, height: `${b - t}px` });
      this.sel = new Set(keep);
      for (const n of this.notes) {
        const row = this.rowOf(n.note);
        if (row < 0 && this.ops.drums()) continue;
        const nx0 = n.at * this.sw, nx1 = (n.at + n.len) * this.sw, ny0 = row * this.rh, ny1 = ny0 + this.rh;
        if (nx1 > l && nx0 < rr && ny1 > t && ny0 < b) this.sel.add(id(n));
      }
      this.render();
    }, () => (this.band.hidden = true));
  }

  /** the side keyboard: a press plays the key into the track's instrument, a drag down the keys plays along */
  private keyDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    e.preventDefault();
    try { this.keys.setPointerCapture(e.pointerId); } catch { /* (a synthetic pointer) */ }
    let note = this.at(e).note;
    this.ops.play(note, this.vel);
    this.keys.onpointermove = (ev) => {
      const n = this.at(ev).note;
      if (n === note) return;
      this.ops.play(note, 0);
      note = n;
      this.ops.play(note, this.vel);
    };
    this.keys.onpointerup = this.keys.onpointercancel = () => {
      this.keys.onpointermove = this.keys.onpointerup = this.keys.onpointercancel = null;
      this.ops.play(note, 0);
    };
  }

  /** the velocity lane: the pointer's height is the velocity of the notes starting on the step under it */
  private velDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    e.preventDefault();
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

  private wheel(e: WheelEvent): void {
    e.preventDefault();
    if (this.ops.drums()) return; // (a Drum map's rows all fit)
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
      const max = (host?.clientHeight ?? 800) - 40;
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

  /** a key while the roll has the focus (main.ts's key handler asks first): true when it was the roll's */
  key(k: string, shift: boolean, mod: boolean): boolean {
    if (k === 'Escape') {
      if (this.sel.size) {
        this.sel.clear();
        this.render();
      } else this.ops.close();
      return true;
    }
    if (mod && k.toLowerCase() === 'a') {
      this.setTool('select');
      this.sel = new Set(this.notes.map(id));
      this.render();
      return true;
    }
    if (mod) return false;
    const picked = this.notes.filter((n) => this.sel.has(id(n)));
    if (!picked.length) return false;
    const rest = this.notes.filter((n) => !this.sel.has(id(n)));
    if (k === 'Delete' || k === 'Backspace') {
      const end = this.ops.begin();
      this.sel.clear();
      this.write(rest);
      end();
      return true;
    }
    const dk = k === 'ArrowLeft' ? -1 : k === 'ArrowRight' ? 1 : 0;
    const up = k === 'ArrowUp' ? 1 : k === 'ArrowDown' ? -1 : 0;
    if (!dk && !up) return false;
    // a semitone (Shift: an octave), or on a Drum map's rows a row
    const drums = this.ops.drums();
    const to = (n: StepNote): number => {
      if (!drums) return n.note + up * (shift ? 12 : 1);
      const r = this.rowOf(n.note);
      return r < 0 ? n.note : r - up < 0 || r - up >= drums.length ? -1 : this.noteAt(r - up);
    };
    if (picked.some((n) => n.at + dk < 0 || n.at + n.len + dk > STEPS_MAX || to(n) < 0 || to(n) > 127)) return true;
    const moved = picked.map((n) => ({ ...n, at: n.at + dk, note: to(n) }));
    this.sel = new Set(moved.map(id));
    // (the view follows notes moved out of it)
    const hi = Math.max(...moved.map((n) => n.note)), lo = Math.min(...moved.map((n) => n.note));
    if (drums) { /* (every row is in view) */ } else if (hi > this.top) this.top = Math.min(127, hi + 1);
    else if (lo <= this.top - this.rows) this.top = lo + this.rows - 2;
    const end = this.ops.begin();
    this.write([...moved, ...rest.filter((o) => !moved.some((n) => n.at === o.at && n.note === o.note))]);
    end();
    return true;
  }
}
