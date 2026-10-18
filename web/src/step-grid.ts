// SPDX-License-Identifier: GPL-3.0-only
// A Steps module's grid on its card (#83): every step up to its length in rows of 16 (the FM-1 shows 16 at a time on its
// white keys), its name for the FM-1's SEQ page and a mute switch. A click switches a step on / off, Shift- or Alt-click
// its accent, a vertical drag sets its chance (5 % steps); the step playing is outlined (Engine.stepsView through the
// worklet). The editor owns the patch and the undo history: the grid only reports through `ops`.
import { STEPS_MAX, stepByte, stepOf, TRACK_NAME_MAX, trackName, type ModuleInst } from './patch';

export interface StepGridOps {
  /** a step's new byte (one undo step per click; a chance drag is wrapped in begin / its result) */
  set(k: number, b: number): void;
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

const ROW = 16;
/** px of vertical drag per 5 % of chance */
const DRAG_PX = 4;

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
  const mute = document.createElement('button');
  mute.type = 'button';
  mute.className = 'steps-mute';
  mute.textContent = 'mute';
  mute.title = 'mute the track (not saved; on the FM-1: SEQ held + its black key)';
  let muted = false;
  mute.onclick = () => ops.mute(!muted);
  head.append(name, mute);
  const rows = document.createElement('div');
  rows.className = 'steps-rows';
  el.append(head, rows);

  const len = (): number => Math.min(STEPS_MAX, Math.max(1, Math.round(m.params.len ?? 16)));
  let cells: HTMLElement[] = [];
  let shownPos = -1;
  const paint = (k: number): void => {
    const c = cells[k];
    if (!c) return;
    const s = stepOf(m.steps?.[k]);
    c.classList.toggle('on', s.on);
    c.classList.toggle('acc', s.on && s.accent);
    c.style.setProperty('--chance', String(s.on ? s.chance / 100 : 0));
    c.title = `step ${k + 1}${s.on ? `${s.accent ? ', accented' : ''}${s.chance < 100 ? `, ${s.chance} %` : ''}` : ': off'}\nclick: on / off, Shift-click: accent, drag up / down: chance`;
  };
  const write = (k: number, s: ReturnType<typeof stepOf>): void => {
    ops.set(k, stepByte(s));
    paint(k);
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
        const fill = document.createElement('i');
        c.append(fill);
        if (k < n) cellInput(c, k);
        row.append(c);
        cells.push(c);
        paint(k);
      }
      rows.append(row);
    }
    shownPos = -1;
  };
  const cellInput = (c: HTMLElement, k: number): void => {
    c.onpointerdown = (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation(); // (not a card drag)
      const y0 = e.clientY;
      const start = stepOf(m.steps?.[k]);
      let end: (() => void) | null = null;
      c.setPointerCapture(e.pointerId);
      c.onpointermove = (ev) => {
        const d = Math.round((y0 - ev.clientY) / DRAG_PX);
        if (!end && Math.abs(y0 - ev.clientY) < DRAG_PX) return;
        end ??= ops.begin();
        write(k, { on: true, accent: start.accent, chance: Math.max(5, Math.min(100, (start.on ? start.chance : 100) + 5 * d)) });
      };
      c.onpointerup = (ev) => {
        c.onpointermove = c.onpointerup = null;
        if (end) return end();
        const s = stepOf(m.steps?.[k]);
        if (ev.shiftKey || ev.altKey) write(k, s.on ? { ...s, accent: !s.accent } : { on: true, accent: true, chance: s.chance });
        else write(k, s.on ? { on: false, accent: false, chance: s.chance } : { ...s, on: true });
      };
    };
  };
  build();
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
      else for (let k = 0; k < cells.length; k++) paint(k);
      if (document.activeElement !== name) name.value = m.name ?? '';
    },
  };
}
