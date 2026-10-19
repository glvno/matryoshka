// SPDX-License-Identifier: GPL-3.0-only
// The editor's FM-1 tab (#110): the FM-1's front panel, laid out as the device is, around the real firmware UI as
// WebAssembly (fm1-ui.ts). The geometry is the one fm1-emu's fm1-live draws (after Felucca's controls diagram, in a
// 1280 x 820 panel): MASTER / SELECT / PRESETS / ALGORITHM top left with OCT- / OCT+ under them, the screen in the
// middle, KNOB1..4 and two rows of six buttons on the right, the 27 pill keys (F3..G5) across the bottom. Encoders turn
// by drag, wheel or arrows; a button is held while pressed (Shift-click latches it down, for chords such as PLAY +
// PRESET); the keys play notes. No editor knowledge here: main.ts wires the events.
import { BUTTONS, ENCODERS, Fm1Ui, type Fm1Events } from './fm1-ui';

/** keep a pointer's moves and release on el (a pointer that is already gone cannot be captured: then without) */
const capture = (el: Element, id: number): void => { try { el.setPointerCapture(id); } catch { /* gone */ } };

/** the panel's size in its own units; everything below is placed in them */
const PW = 1280;
const PH = 820;
/** px of vertical drag per encoder click */
const DRAG_STEP = 8;

/** encoders: label, fm1w_encoder number, centre, radius */
const ENCS: { label: string; n: number; x: number; y: number; r: number }[] = [
  { label: 'Select', n: ENCODERS.select, x: 250, y: 135, r: 44 },
  { label: 'Presets', n: ENCODERS.preset, x: 110, y: 295, r: 44 },
  { label: 'Algorithm', n: ENCODERS.algo, x: 250, y: 295, r: 44 },
  { label: 'Knob1', n: ENCODERS.k1, x: 935, y: 120, r: 36 },
  { label: 'Knob2', n: ENCODERS.k2, x: 1027, y: 120, r: 36 },
  { label: 'Knob3', n: ENCODERS.k3, x: 1119, y: 120, r: 36 },
  { label: 'Knob4', n: ENCODERS.k4, x: 1211, y: 120, r: 36 },
];
const MASTER = { x: 110, y: 135, r: 44 };
/** buttons: label, matrix id, box */
const BTNS: { label: string; id: number; x: number; y: number; w: number; h: number }[] = [
  { label: 'Oct-', id: BUTTONS.octDown, x: 62, y: 398, w: 112, h: 44 },
  { label: 'Oct+', id: BUTTONS.octUp, x: 186, y: 398, w: 112, h: 44 },
  ...([
    [['FX', BUTTONS.fx], ['SCL', BUTTONS.scl], ['ENV', BUTTONS.env], ['LFO', BUTTONS.lfo], ['EDIT', BUTTONS.edit], ['GLO', BUTTONS.glo]],
    [['HOME', BUTTONS.home], ['SAVE', BUTTONS.save], ['ARP', BUTTONS.arp], ['SEQ', BUTTONS.seq], ['PLAY', BUTTONS.play], ['REC', BUTTONS.rec]],
  ] as [string, number][][]).flatMap((row, r) => row.map(([label, id], i) => ({ label, id, x: 906 + i * 58, y: 232 + r * 76, w: 50, h: 64 }))),
];
/** the 27 keys F3..G5 (key n = F3 + n semitones): whites in a row, blacks above the gaps */
const KEYS: { k: number; x: number; y: number; w: number; h: number; black: boolean }[] = (() => {
  const kw = 62, gap = 11, x0 = 61;
  const whites = [0, 2, 4, 6, 7, 9, 11, 12, 14, 16, 18, 19, 21, 23, 24, 26];
  const blacks: [number, number][] = [[1, 0], [3, 1], [5, 2], [8, 4], [10, 5], [13, 7], [15, 8], [17, 9], [20, 11], [22, 12], [25, 14]];
  return [
    ...whites.map((k, i) => ({ k, x: x0 + i * (kw + gap), y: 680, w: kw, h: 106, black: false })),
    ...blacks.map(([k, after]) => ({ k, x: x0 + (after + 1) * (kw + gap) - gap / 2 - kw / 2, y: 574, w: kw, h: 94, black: true })),
  ];
})();

/** place el on the panel by its box in panel units */
function place(el: HTMLElement, x: number, y: number, w: number, h: number): HTMLElement {
  el.style.left = `${(x / PW) * 100}%`;
  el.style.top = `${(y / PH) * 100}%`;
  el.style.width = `${(w / PW) * 100}%`;
  el.style.height = `${(h / PH) * 100}%`;
  return el;
}
function div(cls: string, parent: HTMLElement, text?: string): HTMLElement {
  const d = document.createElement('div');
  d.className = cls;
  if (text) d.textContent = text;
  parent.append(d);
  return d;
}

export interface Fm1ViewHost extends Fm1Events {
  /** a pill key pressed / let go: key n = F3 + n semitones (the page plays it at the emulated octave) */
  key?(k: number, down: boolean): void;
  /** the MASTER knob, 0..1 */
  master?(v: number): void;
  /** the first press on the panel (the page starts its audio) */
  used?(): void;
}

export class Fm1View {
  ui: Fm1Ui | null = null;
  private loading: Promise<Fm1Ui | null> | null = null;
  private frame = 0;
  private t0 = performance.now();
  private ctx: CanvasRenderingContext2D;
  private img = new ImageData(240, 240);
  private btnEls = new Map<number, HTMLElement>();
  private keyEls = new Map<number, HTMLElement>();
  private latched = new Set<number>();
  private held = new Set<number>();
  private note: HTMLElement;
  /** called once the module is up (the page then loads the patch into it) */
  onReady: (ui: Fm1Ui) => void = () => {};

  constructor(private el: HTMLElement, private wasmUrl: string, private host: Fm1ViewHost, master = 1) {
    el.classList.add('fm1-view');
    const body = div('fm1-body', el);
    body.addEventListener('pointerdown', () => this.host.used?.(), { capture: true });
    place(div('fm1-tray', body), 50, 388, 260, 64);
    place(div('fm1-tray', body), 896, 222, 360, 160);
    place(div('fm1-tray fm1-keybed', body), 34, 562, 1212, 236);
    place(div('fm1-transport', body), 1134, 302, 112, 72);
    const bezel = place(div('fm1-bezel', body), 352, 24, 516, 516);
    const lcd = document.createElement('canvas');
    lcd.className = 'fm1-lcd';
    lcd.width = lcd.height = 240;
    lcd.setAttribute('role', 'img');
    lcd.setAttribute('aria-label', 'FM-1 display');
    lcd.style.left = `${(18 / 516) * 100}%`;
    lcd.style.top = `${(18 / 516) * 100}%`;
    lcd.style.width = lcd.style.height = `${(480 / 516) * 100}%`;
    bezel.append(lcd);
    this.ctx = lcd.getContext('2d')!;
    this.note = div('fm1-note', bezel);
    this.note.hidden = true;
    place(div('fm1-silk fm1-name', body, 'FM-1 · Matryoshka'), 352, 546, 516, 14);
    for (const e of ENCS) this.encoder(body, e.label, e.n, e.x, e.y, e.r);
    this.pot(body, master);
    for (const b of BTNS) this.button(body, b.label, b.id, b.x, b.y, b.w, b.h);
    for (const k of KEYS) this.key(body, k.k, k.x, k.y, k.w, k.h, k.black);
    const hint = div('fm1-hint', el);
    hint.textContent = 'Drag or scroll an encoder · Shift-click a button to hold it down · the computer keyboard plays the keys too';
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
    for (const id of [...this.held]) this.release(id);
  }

  get shown(): boolean { return !this.el.hidden; }

  /** a message over the screen (over budget, a load error), or none */
  message(text: string | null): void {
    this.note.hidden = !text;
    this.note.textContent = text ?? '';
  }

  /** the notes held now (the computer keyboard's, the pill keys'): the FM-1's 27 keys from F3 at its octave; the
   * pill keys show which are down */
  keys(notes: Iterable<number>): void {
    const ui = this.ui;
    if (!ui) return;
    let bits = 0;
    for (const n of notes) {
      const k = n - 53 - 12 * ui.octave;
      if (k >= 0 && k < 27) bits |= 1 << k;
    }
    for (const [k, el] of this.keyEls) el.classList.toggle('down', (bits >> k & 1) !== 0);
    ui.keys(bits);
  }

  /** the emulated octave (the page plays the pill keys at it) */
  get octave(): number { return this.ui?.octave ?? 0; }

  private ensure(): Promise<Fm1Ui | null> {
    this.loading ??= (async () => {
      try {
        const res = await fetch(this.wasmUrl);
        if (!res.ok) throw new Error(`${res.status}`);
        this.ui = await Fm1Ui.create(await res.arrayBuffer(), this.host);
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
    for (const [id, el] of this.btnEls) el.classList.toggle('lit', (on >> id & 1) !== 0);
  }

  /** a knob's look and its drag / wheel / arrow handling; turn(clicks) is told every move */
  private dial(body: HTMLElement, label: string, x: number, y: number, r: number, turn: (clicks: number) => void): HTMLElement {
    const d = place(div('fm1-dial', body), x - r, y - r, 2 * r, 2 * r);
    d.tabIndex = 0;
    d.setAttribute('role', 'slider');
    d.setAttribute('aria-label', label);
    place(div('fm1-silk', body, label), x - 80, y - r - 26, 160, 16);
    d.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      capture(d, e.pointerId);
      let last = e.clientY;
      const move = (m: PointerEvent): void => {
        const c = Math.trunc((last - m.clientY) / DRAG_STEP);
        if (c) { last -= c * DRAG_STEP; turn(c); }
      };
      const up = (): void => { d.removeEventListener('pointermove', move); d.removeEventListener('pointerup', up); d.removeEventListener('pointercancel', up); };
      d.addEventListener('pointermove', move);
      d.addEventListener('pointerup', up);
      d.addEventListener('pointercancel', up);
    });
    d.addEventListener('wheel', (e) => {
      e.preventDefault();
      turn(e.deltaY < 0 ? 1 : e.deltaY > 0 ? -1 : 0);
    }, { passive: false });
    d.addEventListener('keydown', (e) => {
      const c = e.key === 'ArrowUp' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowDown' || e.key === 'ArrowLeft' ? -1 : 0;
      if (!c) return;
      e.preventDefault();
      e.stopPropagation();
      turn(c * (e.shiftKey ? 5 : 1));
    });
    return d;
  }

  private encoder(body: HTMLElement, label: string, n: number, x: number, y: number, r: number): void {
    let turns = 0;
    const d = this.dial(body, label, x, y, r, (clicks) => {
      if (!clicks || !this.ui) return;
      this.ui.encoder(n, clicks);
      turns += clicks;
      d.style.setProperty('--turn', `${turns * 18}deg`);
    });
    d.setAttribute('aria-label', `${label} encoder`);
  }

  /** MASTER: a pot, -135..135 degrees (the output level) */
  private pot(body: HTMLElement, v0: number): void {
    let v = v0;
    const show = (): void => { d.style.setProperty('--turn', `${-135 + 270 * v}deg`); d.setAttribute('aria-valuenow', String(Math.round(v * 100))); };
    const d = this.dial(body, 'Master', MASTER.x, MASTER.y, MASTER.r, (clicks) => {
      v = Math.min(1, Math.max(0, v + clicks * 0.03));
      show();
      this.host.master?.(v);
    });
    d.classList.add('pot');
    show();
  }

  private press(id: number): void {
    if (this.held.has(id)) return;
    this.held.add(id);
    this.btnEls.get(id)?.classList.add('down');
    this.ui?.button(id, true);
  }
  private release(id: number): void {
    this.latched.delete(id);
    const b = this.btnEls.get(id);
    b?.classList.remove('latched', 'down');
    if (!this.held.delete(id)) return;
    this.ui?.button(id, false);
  }

  private button(body: HTMLElement, label: string, id: number, x: number, y: number, w: number, h: number): void {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'fm1-btn' + (id === BUTTONS.play ? ' play' : '');
    b.textContent = label;
    b.title = `${label} (Shift-click: hold it down)`;
    place(b, x, y, w, h);
    body.append(b);
    this.btnEls.set(id, b);
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
  }

  private key(body: HTMLElement, k: number, x: number, y: number, w: number, h: number, black: boolean): void {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'fm1-key' + (black ? ' black' : '');
    b.setAttribute('aria-label', `key ${k + 1}`);
    b.tabIndex = -1;
    place(b, x, y, w, h);
    body.append(b);
    this.keyEls.set(k, b);
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      capture(b, e.pointerId);
      this.host.key?.(k, true);
      const up = (): void => { b.removeEventListener('pointerup', up); b.removeEventListener('pointercancel', up); this.host.key?.(k, false); };
      b.addEventListener('pointerup', up);
      b.addEventListener('pointercancel', up);
    });
  }
}
