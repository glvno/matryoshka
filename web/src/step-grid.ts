// SPDX-License-Identifier: GPL-3.0-only
// A Steps module's grid on its card (#83): every step up to its length in rows of 16 (the FM-1 shows 16 at a time on its
// white keys), its name for the FM-1's SEQ page and a mute switch. Three lanes (#93), picked in the head:
//   steps: a click switches a step on / off, Shift- or Alt-click its accent, Ctrl / Cmd-click ties it to the note before
//          (#128: the note goes on through it), a vertical drag sets its chance (5 % steps);
//   note:  a vertical drag sets the step's note (a semitone per NOTE_PX, Shift an octave), double click C4;
//   vel:   press and sweep across the steps to draw their velocities (the height in the cell), double click the default.
// The step playing is outlined (Engine.stepsView through the worklet). The editor owns the patch and the undo history:
// the grid only reports through `ops`.
import { NOTE_NAMES } from './modules';
import { STEP_NOTE, STEP_VEL, STEPS_MAX, stepByte, stepOf, TRACK_NAME_MAX, trackName, type ModuleInst } from './patch';

export interface StepGridOps {
  /** a step's new byte (one undo step per click; a chance drag is wrapped in begin / its result) */
  set(k: number, b: number): void;
  /** a step's new note and velocity (one undo step, or inside begin / its result while dragging) */
  value(k: number, note: number, vel: number): void;
  begin(): () => void;
  /** the track's name (an empty string removes it) */
  name(s: string): void;
  mute(on: boolean): void;
}

export interface StepGrid {
  el: HTMLElement;
  /** the step playing (-1: none) and whether the track is muted, as the engine reports them */
  show(pos: number, mute: boolean): void;
  /** a step changed elsewhere (the FM-1's SEQ page) */
  refresh(): void;
}

type Lane = 'steps' | 'note' | 'vel';
const LANES: Lane[] = ['steps', 'note', 'vel'];
/** the lane each grid shows, by module id (kept over the editor's rebuilds, not saved) */
const laneOf = new Map<number, Lane>();

const ROW = 16;
/** px of vertical drag per 5 % of chance, per semitone */
const DRAG_PX = 4;
const NOTE_PX = 6;

const noteOf = (m: ModuleInst, k: number): number => m.notes?.[k] ?? STEP_NOTE;
const velOf = (m: ModuleInst, k: number): number => m.vels?.[k] ?? STEP_VEL;

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
  head.append(name, lanes, mute);
  const rows = document.createElement('div');
  rows.className = 'steps-rows';
  /** what a note / velocity drag is setting, under the grid */
  const readout = document.createElement('div');
  readout.className = 'steps-readout';
  el.append(head, rows, readout);

  let lane: Lane = laneOf.get(m.id) ?? 'steps';
  const len = (): number => Math.min(STEPS_MAX, Math.max(1, Math.round(m.params.len ?? 16)));
  let cells: HTMLElement[] = [];
  let shownPos = -1;
  /** the notes the note lane spans (at least an octave, around the notes the track uses) */
  const span = (): [number, number] => {
    const used = Array.from({ length: len() }, (_, k) => noteOf(m, k));
    let lo = Math.min(...used), hi = Math.max(...used);
    if (hi - lo < 12) {
      const pad = 12 - (hi - lo);
      lo -= Math.floor(pad / 2);
      hi += Math.ceil(pad / 2);
    }
    return [lo, hi];
  };
  const tip = (k: number): string => {
    const s = stepOf(m.steps?.[k]);
    const what = s.tie ? ': tied (the note before goes on)' : s.on ? `${s.accent ? ', accented' : ''}${s.chance < 100 ? `, ${s.chance} %` : ''}` : ': off';
    const vals = `${NOTE_NAMES[noteOf(m, k)]}, velocity ${velOf(m, k)}`;
    const how = { steps: 'click: on / off, Shift-click: accent, Ctrl / Cmd-click: tie, drag up / down: chance', note: 'drag up / down: note (Shift: octaves), double click: C4', vel: 'press and sweep: velocity, double click: default' }[lane];
    return `step ${k + 1}${what} · ${vals}\n${how}`;
  };
  const paint = (k: number, sp?: [number, number]): void => {
    const c = cells[k];
    if (!c) return;
    const s = stepOf(m.steps?.[k]);
    c.classList.toggle('on', s.on && !s.tie);
    c.classList.toggle('acc', s.on && s.accent && !s.tie);
    c.classList.toggle('tie', !!s.tie);
    let v = s.on ? s.chance / 100 : 0;
    if (lane === 'vel') v = velOf(m, k) / 127;
    c.style.setProperty('--chance', String(v));
    if (lane === 'note') {
      const [lo, hi] = sp ?? span();
      const n = noteOf(m, k);
      c.style.setProperty('--note', String((n - lo) / Math.max(1, hi - lo)));
      c.firstElementChild!.textContent = NOTE_NAMES[n].replace(/-?\d+$/, '');
    } else c.firstElementChild!.textContent = '';
    c.title = tip(k);
  };
  const paintAll = (): void => {
    const sp = lane === 'note' ? span() : undefined;
    for (let k = 0; k < cells.length; k++) paint(k, sp);
  };
  const write = (k: number, s: ReturnType<typeof stepOf>): void => {
    ops.set(k, stepByte(s));
    paint(k);
  };
  const writeValue = (k: number, note: number, vel: number): void => {
    ops.value(k, Math.max(0, Math.min(127, note)), Math.max(0, Math.min(127, vel)));
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
        c.append(label, fill);
        if (k < n) cellInput(c, k);
        row.append(c);
        cells.push(c);
      }
      rows.append(row);
    }
    paintAll();
    shownPos = -1;
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
  const cellInput = (c: HTMLElement, k: number): void => {
    c.ondblclick = (e) => {
      if (lane === 'steps') return;
      e.preventDefault();
      e.stopPropagation();
      if (lane === 'note') writeValue(k, STEP_NOTE, velOf(m, k));
      else writeValue(k, noteOf(m, k), STEP_VEL);
      paintAll();
    };
    c.onpointerdown = (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation(); // (not a card drag)
      c.setPointerCapture(e.pointerId);
      if (lane === 'vel') return velSweep(c, k, e);
      if (lane === 'note') return noteDrag(c, k, e);
      const y0 = e.clientY;
      const start = stepOf(m.steps?.[k]);
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
        const s = stepOf(m.steps?.[k]);
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
  build();
  setLane(lane);
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
      if (cells.length !== Math.ceil(len() / ROW) * ROW) build();
      else paintAll();
      if (document.activeElement !== name) name.value = m.name ?? '';
    },
  };
}
