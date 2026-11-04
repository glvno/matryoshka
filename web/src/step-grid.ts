// SPDX-License-Identifier: GPL-3.0-only
// A Steps module's grid on its card (#83): every step up to its length in rows of 16 (the FM-1 shows 16 at a time on its
// white keys), its name for the FM-1's SEQ page and a mute switch. The track holds notes (#133, track.ts); the grid shows
// and edits them as steps (stepView / setStep / setStepValue): a step is on when notes start there, tied when a note
// started before goes on through it. Three lanes (#93), picked in the head:
//   steps: a click switches a step on / off, Shift- or Alt-click its accent (full velocity), Ctrl / Cmd-click ties it to
//          the note before (#128: the note goes on through it), a vertical drag sets its chance (5 % steps);
//   note:  a vertical drag sets the step's note (a chord moves as one; a semitone per NOTE_PX, Shift an octave; an off
//          step gets a note), double click C4;
//   vel:   press and sweep across the steps to draw their velocities (the height in the cell), double click the default.
// The step playing is outlined (Engine.stepsView through the worklet). The editor owns the patch and the undo history:
// the grid only reports through `ops`. `arm` (#134) arms the track: Main's keys go into it and through to what it plays
// (the editor holds which track is armed: one at a time, not saved, no undo step).
// REC (#127, #135; the editor holds it, on the armed track: `rec` arms the track too, Shift+R) puts the grid in cursor entry
// (the note lane, a cursor on the first step or the one clicked). With the transport stopped every key held when the first
// is let go (the note keys, a MIDI controller, the on-screen keys: recordNote / recordOff) becomes the cursor's step (a
// chord, its velocities, one step long) and the cursor moves on; Backspace a rest (its notes go), Enter a tie, Left / Right
// move the cursor, Escape or `rec` again stops (recordKey). With it running the engine records what is played (live
// overdub: Engine.setRec, the editor's recorded).
// P-locks (#524, #519 Q11): a step with locks shows a dot under it. Clicking the dot, or right-clicking any step, opens the
// step's locks: each locked row with its value to edit or delete, and a row of the track's device to lock (at its normal
// value, to edit from there).
import { NOTE_NAMES } from './modules';
import { STEPS_MAX, TRACK_NAME_MAX, trackName, type ModuleInst, type ParamDef } from './patch';
import { locksAt, setChord, setLock, setStep, setStepValue, STEP_NOTE, STEP_VEL, stepView, type StepLock, type StepNote, type StepView } from './track';

/** a row of the track's device a step can lock (#524): its module's parameter, its label ("filter cutoff"), its definition
 * and its normal value now */
export interface LockRow { module: number; param: string; label: string; pd: ParamDef; value: number }

export interface StepGridOps {
  /** the track's new notes (one undo step per click; a drag is wrapped in begin / its result) */
  notes(n: StepNote[] | undefined): void;
  begin(): () => void;
  /** the track's name (an empty string removes it) */
  name(s: string): void;
  mute(on: boolean): void;
  /** arm / disarm the track (#134), and whether it is armed */
  arm(on: boolean): void;
  armed(): boolean;
  /** REC on / off (#135: it arms the track too), and whether it is on */
  rec(on: boolean): void;
  recording(): boolean;
  /** open / close the piano roll on this track (#136) */
  roll(): void;
  /** the rows of the device the track plays (#524: what a step can lock), and the shown pattern's new locks (an undo step) */
  lockRows(): LockRow[];
  locks(l: StepLock[] | undefined): void;
}

export interface StepGrid {
  el: HTMLElement;
  /** the step playing (-1: none) and whether the track is muted, as the engine reports them */
  show(pos: number, mute: boolean): void;
  /** a step changed elsewhere (the FM-1's SEQ page) */
  refresh(): void;
  /** the track was armed or disarmed (#134); `by` names the armed devices it is armed with instead (#418: the track in
   * front of an armed instrument), an empty string none */
  armed(on: boolean, by?: string): void;
  /** REC went on or off (#135): cursor entry starts on the first step, or stops */
  rec(on: boolean): void;
  /** the roll is open on this track, or not */
  rolled(on: boolean): void;
}

type Lane = 'steps' | 'note' | 'vel';

/** the grid in cursor entry (#127, #135): its module, the cursor, and what the newest grid of that module does with a note
 * played, a note let go or a key */
let entry: { id: number; k: number; note(note: number, vel: number): void; off(note: number): void; key(key: string): boolean; stop(): void } | null = null;
/** a note played while a grid is in cursor entry: it joins the chord for the cursor's step; false when none is */
export function recordNote(note: number, vel: number): boolean {
  if (!entry) return false;
  entry.note(note, vel);
  return true;
}
/** a note let go while a grid is in cursor entry: the first let go writes the chord */
export function recordOff(note: number): void {
  entry?.off(note);
}
/** a key while a grid is in cursor entry (Backspace, Enter, Left, Right, Escape): true when it was the grid's */
export const recordKey = (key: string): boolean => !!entry?.key(key);
/** stop cursor entry (another patch loaded, REC off) */
export function stopEntry(): void {
  const a = entry;
  entry = null;
  a?.stop();
}
const LANES: Lane[] = ['steps', 'note', 'vel'];
/** the locks list open (#524): its track and step, kept over the editor's rebuilds (an edit there rebuilds the card) */
let lockOpen: { id: number; k: number } | null = null;
/** the lane each grid shows, by module id (kept over the editor's rebuilds, not saved) */
const laneOf = new Map<number, Lane>();

const ROW = 16;
/** px of vertical drag per 5 % of chance, per semitone */
const DRAG_PX = 4;
const NOTE_PX = 6;

const view = (m: ModuleInst, k: number): StepView => stepView(m.notes, k);
const noteOf = (m: ModuleInst, k: number): number => view(m, k).note;
const velOf = (m: ModuleInst, k: number): number => view(m, k).vel;

export function stepGrid(m: ModuleInst, index: number, ops: StepGridOps): StepGrid {
  const el = document.createElement('div');
  el.className = 'steps-screen';
  const head = document.createElement('div');
  head.className = 'steps-head';
  const name = document.createElement('input');
  name.className = 'steps-name';
  name.maxLength = TRACK_NAME_MAX;
  name.placeholder = `STEPS ${index + 1}`;
  name.value = m.name ?? '';
  name.title = 'the track’s name on the FM-1’s SEQ page (8 characters)';
  name.spellcheck = false;
  name.onkeydown = (e) => {
    e.stopPropagation(); // (typing is not the app's shortcuts)
    if (e.key === 'Enter') name.blur();
  };
  name.onchange = () => {
    const v = trackName(name.value);
    name.value = v;
    ops.name(v);
  };
  const lanes = document.createElement('div');
  lanes.className = 'steps-lanes';
  lanes.setAttribute('role', 'group');
  const laneBtns = LANES.map((l) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = l;
    b.title = { steps: 'on / off, accent, chance', note: 'each step’s note (the pitch output)', vel: 'each step’s velocity (the vel output)' }[l];
    b.onclick = () => setLane(l);
    lanes.append(b);
    return b;
  });
  const mute = document.createElement('button');
  mute.type = 'button';
  mute.className = 'steps-mute';
  mute.textContent = 'mute';
  mute.title = 'mute the track (not saved; on the FM-1: SEQ held + its black key)';
  let muted = false;
  mute.onclick = () => ops.mute(!muted);
  const rec = document.createElement('button');
  rec.type = 'button';
  rec.className = 'steps-rec';
  rec.textContent = 'rec';
  rec.title = 'REC (Shift+R; it arms the track): stopped, play a note or a chord into the cursor’s step (Backspace a rest, Enter a tie, ← → move, Esc stops); running, play along: each pass overdubs, one undo step per pass';
  rec.onclick = () => ops.rec(!ops.recording());
  const arm = document.createElement('button');
  arm.type = 'button';
  arm.className = 'steps-arm arm-dot';
  arm.setAttribute('aria-label', 'Arm the track');
  arm.title = 'ARM: Main’s keys play into this track and through to what it plays, so you hear its instrument (with any other armed device; not saved)';
  arm.onclick = () => ops.arm(!ops.armed());
  const armHint = arm.title;
  const showArm = (on: boolean, by = ''): void => {
    const via = !on && !!by;
    arm.classList.toggle('on', on);
    arm.classList.toggle('with', via);
    arm.setAttribute('aria-pressed', via ? 'mixed' : String(on));
    arm.title = via ? `Armed with ${by}: Main’s keys go through this track to it. ARM arms the track on its own too` : armHint;
    el.classList.toggle('armed', on);
    el.classList.toggle('armed-with', via);
  };
  const roll = document.createElement('button');
  roll.type = 'button';
  roll.className = 'steps-roll';
  roll.textContent = 'roll';
  roll.title = 'ROLL: the piano roll for this track, over the canvas (all 64 steps, chords, lengths, velocities)';
  roll.onclick = () => ops.roll();
  const acts = document.createElement('span');
  acts.className = 'steps-acts';
  acts.append(roll, arm, rec, mute);
  head.append(name, lanes, acts);
  const rows = document.createElement('div');
  rows.className = 'steps-rows';
  /** what a note / velocity drag is setting, under the grid */
  const readout = document.createElement('div');
  readout.className = 'steps-readout';
  el.append(head, rows, readout);

  let lane: Lane = laneOf.get(m.id) ?? 'steps';
  const len = (): number => Math.min(STEPS_MAX, Math.max(1, Math.round(m.params.len ?? 16)));
  let cells: HTMLElement[] = [];
  let builtLen = 0; // the length the cells were built for: their past marks and click handlers follow it
  let shownPos = -1;
  /** the notes the note lane spans (at least an octave, around the notes the track uses) */
  const span = (): [number, number] => {
    const used = (m.notes ?? []).filter((n) => n.at < len()).map((n) => n.note);
    if (!used.length) used.push(STEP_NOTE);
    let lo = Math.min(...used), hi = Math.max(...used);
    if (hi - lo < 12) {
      const pad = 12 - (hi - lo);
      lo -= Math.floor(pad / 2);
      hi += Math.ceil(pad / 2);
    }
    return [lo, hi];
  };
  const tip = (k: number): string => {
    const s = view(m, k);
    const chord = (m.notes ?? []).filter((n) => n.at === k).map((n) => NOTE_NAMES[n.note]);
    const what = s.tie ? ': tied (the note before goes on)' : s.on ? `${s.accent ? ', accented' : ''}${s.chance < 100 ? `, ${s.chance} %` : ''}` : ': off';
    const vals = s.on ? ` · ${chord.join(' ')}, velocity ${s.vel}` : '';
    const how = { steps: 'click: on / off, Shift-click: accent, Ctrl / Cmd-click: tie, drag up / down: chance', note: 'drag up / down: note (Shift: octaves), double click: C4', vel: 'press and sweep: velocity, double click: default' }[lane];
    return `step ${k + 1}${what}${vals}\n${how}`;
  };
  const paint = (k: number, sp?: [number, number]): void => {
    const c = cells[k];
    if (!c) return;
    const s = view(m, k);
    c.classList.toggle('on', s.on);
    c.classList.toggle('acc', s.on && s.accent);
    c.classList.toggle('tie', s.tie);
    let v = s.on ? s.chance / 100 : 0;
    if (lane === 'vel') v = s.on ? s.vel / 127 : 0;
    c.style.setProperty('--chance', String(v));
    if (lane === 'note' && s.on) {
      const [lo, hi] = sp ?? span();
      c.style.setProperty('--note', String((s.note - lo) / Math.max(1, hi - lo)));
      c.firstElementChild!.textContent = NOTE_NAMES[s.note].replace(/-?\d+$/, '') + ((m.notes ?? []).filter((n) => n.at === k).length > 1 ? '+' : '');
    } else {
      c.style.removeProperty('--note');
      c.firstElementChild!.textContent = '';
    }
    const locked = locksAt(m.locks, k).length;
    c.classList.toggle('locked', locked > 0);
    c.title = tip(k) + (locked ? `\n${locked} P-lock${locked > 1 ? 's' : ''}: click the dot to edit` : '\nright-click: P-locks');
  };
  const paintAll = (): void => {
    const sp = lane === 'note' ? span() : undefined;
    for (let k = 0; k < cells.length; k++) paint(k, sp);
  };
  /** a step edited as a step (setStep): every step is repainted (a tie or an untie changes the steps around it) */
  const write = (k: number, s: { on: boolean; accent: boolean; chance: number; tie?: boolean }): void => {
    ops.notes(setStep(m.notes, k, s));
    paintAll();
  };
  const writeValue = (k: number, note: number, vel: number): void => {
    ops.notes(setStepValue(m.notes, k, note, vel));
  };
  const setLane = (l: Lane): void => {
    lane = l;
    laneOf.set(m.id, l);
    el.dataset.lane = l;
    laneBtns.forEach((b, i) => {
      b.classList.toggle('on', LANES[i] === l);
      b.setAttribute('aria-pressed', String(LANES[i] === l));
    });
    readout.textContent = '';
    paintAll();
  };
  const build = (): void => {
    const n = len();
    builtLen = n;
    const shown = Math.ceil(n / ROW) * ROW;
    rows.replaceChildren();
    cells = [];
    for (let r = 0; r < shown / ROW; r++) {
      const row = document.createElement('div');
      row.className = 'steps-row';
      for (let i = 0; i < ROW; i++) {
        const k = r * ROW + i;
        const c = document.createElement('div');
        c.className = 'step' + (i % 4 === 0 ? ' beat' : '') + (k >= n ? ' past' : '');
        c.dataset.k = String(k);
        const label = document.createElement('b');
        const fill = document.createElement('i');
        const dot = document.createElement('u');
        dot.className = 'lock-dot';
        c.append(label, fill, dot);
        if (k < n) cellInput(c, k);
        row.append(c);
        cells.push(c);
      }
      rows.append(row);
    }
    paintAll();
    shownPos = -1;
    if (entry?.id === m.id) cells[entry.k]?.classList.add('cursor');
  };
  /** the step under a pointer (sweeping across the velocity lane), -1 outside */
  const stepAt = (x: number, y: number): number => {
    const c = (document.elementFromPoint(x, y) as HTMLElement | null)?.closest<HTMLElement>('.step');
    const k = c && rows.contains(c) ? Number(c.dataset.k) : -1;
    return k >= 0 && k < len() ? k : -1;
  };
  const velAt = (c: HTMLElement, y: number): number => {
    const r = c.getBoundingClientRect();
    return Math.max(1, Math.min(127, Math.round(((r.bottom - 2 - y) / Math.max(1, r.height - 4)) * 127)));
  };
  /** the open locks list (#524): its step, or -1 */
  let pop: HTMLElement | null = null;
  let popK = -1;
  const closeLocks = (): void => {
    if (pop) lockOpen = null;
    pop?.remove();
    pop = null;
    popK = -1;
    document.removeEventListener('pointerdown', outside, true);
  };
  const outside = (e: Event): void => {
    if (pop && !pop.contains(e.target as Node)) closeLocks();
  };
  /** the value control of a row: a choice list, else a number within its range */
  const valueInput = (r: LockRow, v: number, set: (v: number) => void): HTMLElement => {
    if (r.pd.choices) {
      const sel = document.createElement('select');
      r.pd.choices.forEach((name, i) => sel.append(new Option(name, String(i), false, Math.round(v) === i)));
      sel.onchange = () => set(Number(sel.value));
      return sel;
    }
    const inp = document.createElement('input');
    inp.type = 'number';
    inp.min = String(r.pd.min);
    inp.max = String(r.pd.top ?? r.pd.max);
    inp.step = String(r.pd.step ?? 0.01);
    inp.value = String(Math.round(v * 1000) / 1000);
    inp.onkeydown = (e) => e.stopPropagation(); // (typing is not the app's shortcuts)
    inp.onchange = () => { const x = Number(inp.value); if (Number.isFinite(x)) set(Math.min(r.pd.top ?? r.pd.max, Math.max(r.pd.min, x))); };
    return inp;
  };
  /** step k's locks, under its cell: each locked row (its value, × removes it), then a row to lock */
  const openLocks = (k: number): void => {
    closeLocks();
    const lrows = ops.lockRows();
    const box = document.createElement('div');
    box.className = 'lock-pop';
    box.onpointerdown = (e) => e.stopPropagation(); // (not a card drag)
    const draw = (): void => {
      box.replaceChildren();
      const h = document.createElement('div');
      h.className = 'lock-head';
      h.textContent = `step ${k + 1}: P-locks`;
      const x = document.createElement('button');
      x.type = 'button';
      x.textContent = '×';
      x.title = 'close';
      x.onclick = closeLocks;
      h.append(x);
      box.append(h);
      const mine = locksAt(m.locks, k);
      const put = (r: { module: number; param: string }, v: number | null): void => {
        ops.locks(setLock(m.locks, k, r.module, r.param, v));
        paint(k);
        draw();
      };
      for (const l of mine) {
        const r = lrows.find((x) => x.module === l.module && x.param === l.param);
        const line = document.createElement('div');
        line.className = 'lock-row';
        const name = document.createElement('span');
        name.textContent = r?.label ?? `${l.param} (no longer on the device)`;
        const del = document.createElement('button');
        del.type = 'button';
        del.textContent = '×';
        del.title = 'remove this lock: the step plays the normal value';
        del.onclick = () => put(l, null);
        line.append(name, r ? valueInput(r, l.value, (v) => put(l, v)) : document.createElement('span'), del);
        box.append(line);
      }
      const free = lrows.filter((r) => !mine.some((l) => l.module === r.module && l.param === r.param));
      if (!lrows.length) {
        const why = document.createElement('div');
        why.className = 'lock-none';
        why.textContent = 'This track plays no device: cable it into an instrument to lock its rows.';
        box.append(why);
      } else if (free.length && mine.length < 64) {
        const add = document.createElement('div');
        add.className = 'lock-row lock-add';
        const sel = document.createElement('select');
        sel.append(new Option('lock a row…', ''));
        free.forEach((r, i) => sel.append(new Option(r.label, String(i))));
        sel.onchange = () => { const r = free[Number(sel.value)]; if (r) put(r, r.value); };
        add.append(sel);
        box.append(add);
      }
    };
    draw();
    const c = cells[k];
    box.style.left = `${c.offsetLeft}px`;
    box.style.top = `${c.offsetTop + c.offsetHeight + 4}px`;
    rows.parentElement?.append(box);
    pop = box;
    popK = k;
    lockOpen = { id: m.id, k };
    document.addEventListener('pointerdown', outside, true);
  };
  const cellInput = (c: HTMLElement, k: number): void => {
    c.oncontextmenu = (e) => {
      e.preventDefault();
      e.stopPropagation();
      openLocks(k);
    };
    (c.querySelector('.lock-dot') as HTMLElement).onpointerdown = (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation(); // (not the step's click)
      if (popK === k) closeLocks();
      else openLocks(k);
    };
    c.ondblclick = (e) => {
      if (lane === 'steps') return;
      e.preventDefault();
      e.stopPropagation();
      if (!view(m, k).on) return;
      if (lane === 'note') writeValue(k, STEP_NOTE, velOf(m, k));
      else writeValue(k, noteOf(m, k), STEP_VEL);
      paintAll();
    };
    c.onpointerdown = (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation(); // (not a card drag)
      if (entry?.id === m.id) return move(k); // cursor entry: a click puts the cursor there
      c.setPointerCapture(e.pointerId);
      if (lane === 'vel') return velSweep(c, k, e);
      if (lane === 'note') return noteDrag(c, k, e);
      const y0 = e.clientY;
      const start = view(m, k);
      let end: (() => void) | null = null;
      c.onpointermove = (ev) => {
        const d = Math.round((y0 - ev.clientY) / DRAG_PX);
        if (!end && Math.abs(y0 - ev.clientY) < DRAG_PX) return;
        end ??= ops.begin();
        write(k, { on: true, accent: start.accent, chance: Math.max(5, Math.min(100, (start.on ? start.chance : 100) + 5 * d)), tie: false });
      };
      c.onpointerup = (ev) => {
        c.onpointermove = c.onpointerup = null;
        if (end) return end();
        const s = view(m, k);
        if (ev.metaKey || ev.ctrlKey) write(k, { ...s, tie: !s.tie });
        else if (s.tie) write(k, { ...s, tie: false });
        else if (ev.shiftKey || ev.altKey) write(k, s.on ? { ...s, accent: !s.accent } : { on: true, accent: true, chance: s.chance });
        else write(k, s.on ? { on: false, accent: false, chance: s.chance } : { ...s, on: true });
      };
    };
  };
  /** note lane: a vertical drag moves the step's note (relative, a semitone per NOTE_PX; Shift: octaves) */
  const noteDrag = (c: HTMLElement, k: number, e: PointerEvent): void => {
    const start = noteOf(m, k);
    const sp = span(); // (the lane's scale stays put while dragging)
    let y0 = e.clientY;
    let base = start;
    let fine = e.shiftKey;
    let end: (() => void) | null = null;
    readout.textContent = `step ${k + 1}: ${NOTE_NAMES[start]}`;
    c.onpointermove = (ev) => {
      if (ev.shiftKey !== fine) {   // (switching the step size mid-drag starts from where the note is)
        fine = ev.shiftKey;
        base = noteOf(m, k);
        y0 = ev.clientY;
      }
      const d = Math.round((y0 - ev.clientY) / NOTE_PX);
      const note = Math.max(0, Math.min(127, base + (fine ? 12 : 1) * d));
      if (note === noteOf(m, k)) return;
      end ??= ops.begin();
      writeValue(k, note, velOf(m, k));
      const wide: [number, number] = [Math.min(sp[0], note), Math.max(sp[1], note)];
      paint(k, wide);
      readout.textContent = `step ${k + 1}: ${NOTE_NAMES[note]}`;
    };
    c.onpointerup = () => {
      c.onpointermove = c.onpointerup = null;
      end?.();
      paintAll();
    };
  };
  /** velocity lane: the pointer's height in a cell is its velocity; sweeping draws across the steps (one undo step) */
  const velSweep = (c: HTMLElement, k: number, e: PointerEvent): void => {
    const end = ops.begin();
    const put = (j: number, y: number): void => {
      if (!view(m, j).on) return; // (an off step has no velocity)
      const v = velAt(cells[j], y);
      if (v !== velOf(m, j)) writeValue(j, noteOf(m, j), v);
      paint(j);
      readout.textContent = `step ${j + 1}: velocity ${v}`;
    };
    put(k, e.clientY);
    let x0 = e.clientX, y0 = e.clientY;
    c.onpointermove = (ev) => {   // (every step the pointer crossed since the last event, at the height along the way)
      const n = Math.max(1, Math.ceil(Math.hypot(ev.clientX - x0, ev.clientY - y0) / 4));
      for (let i = 1; i <= n; i++) {
        const x = x0 + ((ev.clientX - x0) * i) / n, y = y0 + ((ev.clientY - y0) * i) / n;
        const j = stepAt(x, y);
        if (j >= 0) put(j, y);
      }
      x0 = ev.clientX;
      y0 = ev.clientY;
    };
    c.onpointerup = () => {
      c.onpointermove = c.onpointerup = null;
      end();
    };
  };
  /** cursor entry: the cursor's step and the key / note handlers, kept on the module across the editor's rebuilds */
  const showRec = (): void => {
    const on = entry?.id === m.id;
    rec.classList.toggle('on', on);
    rec.setAttribute('aria-pressed', String(on));
    cells.forEach((c, k) => c.classList.toggle('cursor', on && k === entry!.k));
  };
  const move = (k: number): void => {
    if (!entry) return;
    entry.k = ((k % len()) + len()) % len();
    showRec();
    readout.textContent = `rec: step ${entry.k + 1}`;
  };
  const startRec = (k: number): void => {
    stopEntry();
    /** the keys down now, and the chord they make: every key held when the first is let go (velocities 1..127) */
    const down = new Set<number>();
    let chord = new Map<number, number>();
    entry = {
      id: m.id,
      k: Math.min(k, len() - 1),
      note: (note, vel) => {
        if (!down.size) chord = new Map();
        down.add(note);
        chord.set(note, Math.max(1, Math.min(127, Math.round(vel * 127))));
      },
      off: (note) => {
        if (!down.delete(note) || !chord.size) return;
        const at = entry!.k;
        ops.notes(setChord(m.notes, at, [...chord].map(([n, v]) => ({ note: n, vel: v }))));
        chord = new Map(); // (the keys still down were in it; a key played now starts the next chord)
        paintAll();
        move(at + 1);
      },
      key: (key) => {
        if (!entry) return false;
        const at = entry.k;
        if (key === 'Backspace' || key === 'Delete') write(at, { on: false, accent: false, chance: 100 });
        else if (key === 'Enter') write(at, { ...view(m, at), tie: true });
        else if (key === 'ArrowLeft' || key === 'ArrowRight') return move(at + (key === 'ArrowRight' ? 1 : -1)), true;
        else if (key === 'Escape') return ops.rec(false), true;
        else return false;
        move(at + 1);
        return true;
      },
      stop: () => {
        readout.textContent = '';
        showRec();
      },
    };
    if (lane !== 'note') setLane('note');
    move(entry.k);
  };
  build();
  setLane(lane);
  showArm(ops.armed());
  if (lockOpen?.id === m.id) { const k = lockOpen.k; requestAnimationFrame(() => { if (el.isConnected && k < len()) openLocks(k); }); }
  if (entry?.id === m.id) startRec(entry.k); // (a rebuilt card picks the entry up where it was)
  else if (ops.recording()) startRec(0);
  return {
    el,
    show(pos, isMuted) {
      if (pos !== shownPos) {
        cells[shownPos]?.classList.remove('play');
        cells[pos]?.classList.add('play');
        shownPos = pos;
      }
      if (isMuted !== muted) {
        muted = isMuted;
        mute.classList.toggle('on', muted);
        mute.setAttribute('aria-pressed', String(muted));
        el.classList.toggle('muted', muted);
      }
    },
    refresh() {
      if (builtLen !== len()) build(); // not only a new row: 16 -> 13 greys 14..16, 13 -> 16 makes them clickable
      else paintAll();
      if (pop && popK >= 0) openLocks(popK);
      if (document.activeElement !== name) name.value = m.name ?? '';
    },
    armed: showArm,
    rolled(on) {
      roll.classList.toggle('on', on);
      roll.setAttribute('aria-pressed', String(on));
    },
    rec(on) {
      if (on && entry?.id !== m.id) startRec(0);
      else if (!on && entry?.id === m.id) stopEntry();
    },
  };
}
