// SPDX-License-Identifier: GPL-3.0-only
// The editor's FM-1 tab (#110): a flat drawing of the FM-1's panel around the real firmware UI as WebAssembly (fm1-ui.ts):
// the LCD at 2x from its framebuffer, the encoders (drag or scroll), the button grid with its LEDs (click or hold;
// Shift-click latches a button down, for chords such as PLAY + PRESET or SEQ + a key). The keys are the deck's keyboard
// (main.ts hands the held notes to `keys`). No editor knowledge here: main.ts wires the events.
import { BUTTONS, ENCODERS, Fm1Ui, type Fm1Events } from './fm1-ui';

/** keep a pointer's moves and release on el (a pointer that is already gone cannot be captured: then without) */
const capture = (el: Element, id: number): void => { try { el.setPointerCapture(id); } catch { /* gone */ } };

/** px of vertical drag per encoder click */
const DRAG_STEP = 8;

const ENC_LAYOUT: { n: number; label: string; knob?: number }[] = [
  { n: ENCODERS.select, label: 'Select' },
  { n: ENCODERS.algo, label: 'Algo' },
  { n: ENCODERS.preset, label: 'Preset' },
  { n: ENCODERS.k1, label: 'K1', knob: 1 },
  { n: ENCODERS.k2, label: 'K2', knob: 2 },
  { n: ENCODERS.k3, label: 'K3', knob: 3 },
  { n: ENCODERS.k4, label: 'K4', knob: 4 },
];
/** the buttons in rows as the panel groups them: navigation, the patch's buttons, the transport and sequencer */
const BUTTON_ROWS: { id: number; label: string }[][] = [
  [{ id: BUTTONS.octDown, label: 'Oct −' }, { id: BUTTONS.octUp, label: 'Oct +' }, { id: BUTTONS.home, label: 'Home' }, { id: BUTTONS.save, label: 'Save' }],
  [{ id: BUTTONS.fx, label: 'FX' }, { id: BUTTONS.scl, label: 'SCL' }, { id: BUTTONS.env, label: 'ENV' }, { id: BUTTONS.lfo, label: 'LFO' }],
  [{ id: BUTTONS.edit, label: 'Edit' }, { id: BUTTONS.glo, label: 'GLO' }, { id: BUTTONS.arp, label: 'ARP' }],
  [{ id: BUTTONS.seq, label: 'SEQ' }, { id: BUTTONS.rec, label: 'REC' }, { id: BUTTONS.play, label: 'Play' }],
];

export class Fm1View {
  ui: Fm1Ui | null = null;
  private loading: Promise<Fm1Ui | null> | null = null;
  private frame = 0;
  private t0 = performance.now();
  private ctx: CanvasRenderingContext2D;
  private img = new ImageData(240, 240);
  private leds = new Map<number, HTMLElement>();
  private latched = new Set<number>();
  private held = new Set<number>();
  private dials = new Map<number, { el: HTMLElement; turns: number }>();
  private note: HTMLElement;
  /** called once the module is up (the page then loads the patch into it) */
  onReady: (ui: Fm1Ui) => void = () => {};

  constructor(private el: HTMLElement, private wasmUrl: string, private events: Fm1Events) {
    el.classList.add('fm1-view');
    const panel = document.createElement('div');
    panel.className = 'fm1-panel';
    const lcd = document.createElement('canvas');
    lcd.className = 'fm1-lcd';
    lcd.width = lcd.height = 240;
    lcd.setAttribute('role', 'img');
    lcd.setAttribute('aria-label', 'FM-1 display');
    this.ctx = lcd.getContext('2d')!;
    const screen = document.createElement('div');
    screen.className = 'fm1-screen';
    this.note = document.createElement('p');
    this.note.className = 'fm1-note';
    this.note.hidden = true;
    screen.append(lcd, this.note);
    const controls = document.createElement('div');
    controls.className = 'fm1-controls';
    const encs = document.createElement('div');
    encs.className = 'fm1-encoders';
    for (const e of ENC_LAYOUT) encs.append(this.encoder(e.n, e.label, e.knob));
    const btns = document.createElement('div');
    btns.className = 'fm1-buttons';
    for (const row of BUTTON_ROWS) {
      const r = document.createElement('div');
      r.className = 'fm1-brow';
      for (const b of row) r.append(this.button(b.id, b.label));
      btns.append(r);
    }
    const hint = document.createElement('p');
    hint.className = 'fm1-hint';
    hint.textContent = 'Drag or scroll an encoder · Shift-click a button to hold it · the keyboard below is the FM-1’s keys';
    controls.append(encs, btns, hint);
    panel.append(screen, controls);
    el.append(panel);
  }

  /** start (the module loads on the first show) and draw every frame while shown */
  async show(): Promise<void> {
    this.el.hidden = false;
    const ui = await this.ensure();
    if (!ui || this.el.hidden) return;
    const step = (): void => {
      if (this.el.hidden) return;
      ui.tick(performance.now() - this.t0);
      if (ui.takeDirty()) this.paint();
      this.paintLeds();
      this.frame = requestAnimationFrame(step);
    };
    cancelAnimationFrame(this.frame);
    this.paint();
    step();
  }

  hide(): void {
    this.el.hidden = true;
    cancelAnimationFrame(this.frame);
    for (const id of [...this.latched]) this.release(id);
  }

  get shown(): boolean { return !this.el.hidden; }

  /** a message over the screen (over budget, a load error), or none */
  message(text: string | null): void {
    this.note.hidden = !text;
    this.note.textContent = text ?? '';
  }

  /** the notes the keyboard holds now: the FM-1's 27 keys from F3 at its octave */
  keys(notes: Iterable<number>): void {
    const ui = this.ui;
    if (!ui) return;
    let bits = 0;
    for (const n of notes) {
      const k = n - 53 - 12 * ui.octave;
      if (k >= 0 && k < 27) bits |= 1 << k;
    }
    ui.keys(bits);
  }

  private ensure(): Promise<Fm1Ui | null> {
    this.loading ??= (async () => {
      try {
        const res = await fetch(this.wasmUrl);
        if (!res.ok) throw new Error(`${res.status}`);
        this.ui = await Fm1Ui.create(await res.arrayBuffer(), this.events);
        this.onReady(this.ui);
        return this.ui;
      } catch (e) {
        this.message(`The FM-1 emulator is not built (${(e as Error).message}): run npm run fm1-wasm in web/.`);
        return null;
      }
    })();
    return this.loading;
  }

  private paint(): void {
    if (!this.ui) return;
    this.ui.rgba(this.img.data);
    this.ctx.putImageData(this.img, 0, 0);
  }

  private paintLeds(): void {
    const on = this.ui?.leds ?? 0;
    for (const [id, el] of this.leds) el.classList.toggle('lit', (on >> id & 1) !== 0);
  }

  private encoder(n: number, label: string, knob?: number): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'fm1-enc';
    const dial = document.createElement('div');
    dial.className = 'fm1-dial';
    dial.tabIndex = 0;
    dial.setAttribute('role', 'slider');
    dial.setAttribute('aria-label', `${label} encoder`);
    if (knob) dial.style.setProperty('--knob', `var(--k${knob})`);
    const cap = document.createElement('span');
    cap.className = 'fm1-enc-label';
    cap.textContent = label;
    wrap.append(dial, cap);
    const state = { el: dial, turns: 0 };
    this.dials.set(n, state);
    const turn = (clicks: number): void => {
      if (!clicks || !this.ui) return;
      this.ui.encoder(n, clicks);
      state.turns += clicks;
      dial.style.setProperty('--turn', `${state.turns * 15}deg`);
    };
    dial.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      capture(dial, e.pointerId);
      let last = e.clientY;
      const move = (m: PointerEvent): void => {
        const d = Math.trunc((last - m.clientY) / DRAG_STEP);
        if (d) { last -= d * DRAG_STEP; turn(d); }
      };
      const up = (): void => { dial.removeEventListener('pointermove', move); dial.removeEventListener('pointerup', up); dial.removeEventListener('pointercancel', up); };
      dial.addEventListener('pointermove', move);
      dial.addEventListener('pointerup', up);
      dial.addEventListener('pointercancel', up);
    });
    dial.addEventListener('wheel', (e) => {
      e.preventDefault();
      turn(e.deltaY < 0 ? 1 : e.deltaY > 0 ? -1 : 0);
    }, { passive: false });
    dial.addEventListener('keydown', (e) => {
      const d = e.key === 'ArrowUp' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowDown' || e.key === 'ArrowLeft' ? -1 : 0;
      if (!d) return;
      e.preventDefault();
      e.stopPropagation();
      turn(d * (e.shiftKey ? 5 : 1));
    });
    return wrap;
  }

  private press(id: number): void {
    if (this.held.has(id)) return;
    this.held.add(id);
    this.ui?.button(id, true);
  }
  private release(id: number): void {
    this.latched.delete(id);
    this.btnEl(id)?.classList.remove('latched');
    if (!this.held.delete(id)) return;
    this.ui?.button(id, false);
  }
  private btnEl(id: number): HTMLElement | undefined { return this.leds.get(id)?.parentElement ?? undefined; }

  private button(id: number, label: string): HTMLElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'fm1-btn';
    b.textContent = label;
    b.title = `${label} (Shift-click: hold it down)`;
    const led = document.createElement('span');
    led.className = 'fm1-led';
    led.setAttribute('aria-hidden', 'true');
    b.append(led);
    this.leds.set(id, led);
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (e.shiftKey) {                         // a latch: down until clicked again
        if (this.latched.has(id)) return this.release(id);
        this.latched.add(id);
        b.classList.add('latched');
        return this.press(id);
      }
      if (this.latched.has(id)) return this.release(id);
      capture(b, e.pointerId);
      this.press(id);
      const up = (): void => { b.removeEventListener('pointerup', up); b.removeEventListener('pointercancel', up); this.release(id); };
      b.addEventListener('pointerup', up);
      b.addEventListener('pointercancel', up);
    });
    b.addEventListener('keydown', (e) => {
      if (e.key !== ' ' && e.key !== 'Enter') return;
      e.preventDefault();
      e.stopPropagation();
      if (!e.repeat) this.press(id);
    });
    b.addEventListener('keyup', (e) => {
      if (e.key !== ' ' && e.key !== 'Enter') return;
      e.stopPropagation();
      this.release(id);
    });
    return b;
  }
}
