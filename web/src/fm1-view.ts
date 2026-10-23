// SPDX-License-Identifier: GPL-3.0-only
// The editor's Emulator view (EMU, #110): the FM-1's front panel, laid out as the device is, around the real firmware UI as
// WebAssembly (fm1-ui.ts). The geometry is the one fm1-emu's fm1-live draws (after Felucca's controls diagram, in a
// 1280 x 820 panel), made shorter: the left section (MASTER / SELECT / PRESETS / ALGORITHM, OCT- / OCT+ under them) as
// tall as the right one, the screen in the middle a little shorter with the wordmark under it (so 1280 x 678), KNOB1..4 and two rows of six buttons on the right, the 27 pill keys (F3..G5) across the bottom. Encoders turn
// by drag, wheel or arrows; a button is held while pressed (Shift-click latches it down, for chords such as PLAY +
// PRESET); the keys play notes. No editor knowledge here: main.ts wires the events.
import { inlineWordmarks, logoHtml } from './brand';
import { BUTTONS, ENCODERS, Fm1Ui, type Fm1Events } from './fm1-ui';

/** keep a pointer's moves and release on el (a pointer that is already gone cannot be captured: then without) */
const capture = (el: Element, id: number): void => { try { el.setPointerCapture(id); } catch { /* gone */ } };

/** the panel's size in its own units; everything below is placed in them */
const PW = 1280;
const PH = 678;
/** px of vertical drag per encoder click */
const DRAG_STEP = 8;

/** encoders: label, fm1w_encoder number, centre, radius */
const ENCS: { label: string; n: number; x: number; y: number; r: number }[] = [
  { label: 'Select', n: ENCODERS.select, x: 250, y: 120, r: 36 },
  { label: 'Presets', n: ENCODERS.preset, x: 110, y: 248, r: 36 },
  { label: 'Algorithm', n: ENCODERS.algo, x: 250, y: 248, r: 36 },
  { label: 'Knob1', n: ENCODERS.k1, x: 935, y: 120, r: 36 },
  { label: 'Knob2', n: ENCODERS.k2, x: 1027, y: 120, r: 36 },
  { label: 'Knob3', n: ENCODERS.k3, x: 1119, y: 120, r: 36 },
  { label: 'Knob4', n: ENCODERS.k4, x: 1211, y: 120, r: 36 },
];
const MASTER = { x: 110, y: 120, r: 36 };
/** buttons: label, matrix id, box */
const BTNS: { label: string; id: number; x: number; y: number; w: number; h: number }[] = [
  { label: 'Oct-', id: BUTTONS.octDown, x: 62, y: 328, w: 112, h: 44 },
  { label: 'Oct+', id: BUTTONS.octUp, x: 186, y: 328, w: 112, h: 44 },
  ...([
    [['FX', BUTTONS.fx], ['SEL', BUTTONS.scl], ['ENV', BUTTONS.env], ['LFO', BUTTONS.lfo], ['EDIT', BUTTONS.edit], ['GLO', BUTTONS.glo]],
    [['HOME', BUTTONS.home], ['SAVE', BUTTONS.save], ['ARP', BUTTONS.arp], ['SEQ', BUTTONS.seq], ['PLAY', BUTTONS.play], ['REC', BUTTONS.rec]],
  ] as [string, number][][]).flatMap((row, r) => row.map(([label, id], i) => ({ label, id, x: 906 + i * 58, y: 232 + r * 76, w: 50, h: 64 }))),
];
/** the 27 keys F3..G5 (key n = F3 + n semitones): whites in a row, blacks above the gaps */
const KEYS: { k: number; x: number; y: number; w: number; h: number; black: boolean }[] = (() => {
  const kw = 62, gap = 11, x0 = 61;
  const whites = [0, 2, 4, 6, 7, 9, 11, 12, 14, 16, 18, 19, 21, 23, 24, 26];
  const blacks: [number, number][] = [[1, 0], [3, 1], [5, 2], [8, 4], [10, 5], [13, 7], [15, 8], [17, 9], [20, 11], [22, 12], [25, 14]];
  return [
    ...whites.map((k, i) => ({ k, x: x0 + i * (kw + gap), y: 538, w: kw, h: 106, black: false })),
    ...blacks.map(([k, after]) => ({ k, x: x0 + (after + 1) * (kw + gap) - gap / 2 - kw / 2, y: 432, w: kw, h: 94, black: true })),
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

/** a patch the FM-1 cannot run as it is (design: FM-1 view, a patch that doesn't fit): a card over the device until
 * dismissed, then a chip above it that brings the card back. `warn`: over the budget, loaded anyway; `error`: past the
 * firmware's own limits, the view keeps the last patch it could load */
export interface Fm1Notice {
  level: 'warn' | 'error';
  title: string;
  body: string;
  /** the chip's text once the card is dismissed */
  chip: string;
  /** the card's main button (it dismisses the card) */
  action: string;
  /** a second button: what costs most (the budget's list) */
  more?: () => void;
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
  private alert: HTMLElement;
  private chip: HTMLButtonElement;
  /** the level of a notice the user dismissed: it stays a chip until the patch fits again (or gets worse) */
  private dismissed: Fm1Notice['level'] | null = null;
  /** the encoders by number and the MASTER pot (following an FM-1: they turn with it, #120) */
  private encEls = new Map<number, { el: HTMLElement; turns: number }>();
  private potSet: ((v: number) => void) | null = null;
  private potEl: HTMLElement | null = null;
  private follow: HTMLElement;
  private farHeld = new Set<number>();
  private farTimer = 0;
  /** called once the module is up (the page then loads the patch into it) */
  onReady: (ui: Fm1Ui) => void = () => {};

  constructor(private el: HTMLElement, private wasmUrl: string, private host: Fm1ViewHost, master = 1) {
    el.classList.add('fm1-view');
    const body = div('fm1-body', el);
    body.addEventListener('pointerdown', () => this.host.used?.(), { capture: true });
    // the doll: a coral shell, an ivory face with the logo under the left section, a gold band over the keybed
    place(div('fm1-face', body), 20, 20, 1240, 380);
    const logo = place(div('fm1-logo-wrap', body), 22, 32, 336, 336);
    logo.innerHTML = logoHtml('fm1-logo');
    place(div('fm1-band', body), 20, 404, 1240, 6);
    place(div('fm1-tray', body), 50, 318, 260, 64);
    place(div('fm1-tray', body), 896, 222, 360, 160);
    place(div('fm1-tray fm1-keybed', body), 34, 420, 1212, 236);
    place(div('fm1-transport', body), 1134, 302, 112, 72);
    const bezel = place(div('fm1-bezel', body), 478, 54, 250, 250);
    const lcd = document.createElement('canvas');
    lcd.className = 'fm1-lcd';
    lcd.width = lcd.height = 240;
    lcd.setAttribute('role', 'img');
    lcd.setAttribute('aria-label', 'FM-1 display');
    lcd.style.left = `${(10 / 250) * 100}%`;
    lcd.style.top = `${(10 / 250) * 100}%`;
    lcd.style.width = lcd.style.height = `${(230 / 250) * 100}%`;
    bezel.append(lcd);
    this.ctx = lcd.getContext('2d')!;
    this.note = div('fm1-note', bezel);
    this.note.hidden = true;
    const mark = place(div('fm1-wordmark', body), 453, 334, 300, 36);
    mark.innerHTML = '<img class="brand-mark" src="./brand/wordmark.svg" alt="Matryoshka">';
    void inlineWordmarks(mark);
    for (const e of ENCS) this.encoder(body, e.label, e.n, e.x, e.y, e.r);
    this.pot(body, master);
    for (const b of BTNS) this.button(body, b.label, b.id, b.x, b.y, b.w, b.h);
    for (const k of KEYS) this.key(body, k.k, k.x, k.y, k.w, k.h, k.black);
    this.alert = div('fm1-alert', body);
    this.alert.hidden = true;
    this.chip = document.createElement('button');
    this.chip.type = 'button';
    this.chip.className = 'fm1-chip';
    this.chip.hidden = true;
    this.chip.addEventListener('click', () => { this.dismissed = null; this.alert.hidden = false; this.chip.hidden = true; });
    el.insertBefore(this.chip, body);
    const hint = div('fm1-hint', el);
    hint.textContent = 'Drag or scroll an encoder · Shift-click a button to hold it down · the computer keyboard plays the keys too';
    // "Mirroring your FM-1": over the panel, while a connected FM-1 drives it
    this.follow = document.createElement('p');
    this.follow.className = 'fm1-follow';
    this.follow.hidden = true;
    el.insertBefore(this.follow, this.chip);
  }

  /** the module, loaded if it is not yet (following an FM-1 needs it while this tab is hidden too) */
  ready(): Promise<Fm1Ui | null> { return this.ensure(); }

  /**
   * A connected FM-1's control (#120), through Matryoshka's panel logic: a button by matrix id, an encoder's clicks. The
   * controls here move with it. The module's clock is brought up to now first (a HOME hold, a Page button's hold).
   */
  drive(i: { t: 'button'; id: number; down: boolean } | { t: 'enc'; n: number; clicks: number }): void {
    const ui = this.ui;
    if (!ui) return;
    ui.tick(performance.now() - this.t0);
    if (i.t === 'button') {
      this.btnEls.get(i.id)?.classList.toggle('down', i.down);
      ui.button(i.id, i.down);
      // a held button needs the clock running (HOME held = the menu, a Page button's hold) while this tab is hidden too
      if (i.down) this.farHeld.add(i.id);
      else this.farHeld.delete(i.id);
      if (this.farHeld.size && !this.farTimer) this.farTimer = window.setInterval(() => { ui.tick(performance.now() - this.t0); if (!this.farHeld.size) { clearInterval(this.farTimer); this.farTimer = 0; } }, 40);
    } else {
      ui.encoder(i.n, i.clicks);
      const e = this.encEls.get(i.n);
      if (e) { e.turns += i.clicks; e.el.style.setProperty('--turn', `${e.turns * 18}deg`); }
    }
    if (this.shown && ui.takeDirty()) this.paint();
  }

  /** MASTER moved on the FM-1: the pot here follows (the level is the page's, main.ts) */
  setMaster(v: number): void { this.potSet?.(v); }

  /** following an FM-1 (#120): its firmware named, the controls it does not report greyed; null: not following */
  following(name: string | null, reports: ReadonlySet<string> | null): void {
    this.follow.hidden = !name;
    this.follow.textContent = name ? 'Mirroring your FM-1' : '';
    this.follow.title = name ? `Following the FM-1's panel (${name}): greyed controls are not sent over MIDI by that firmware` : '';
    const grey = (el: HTMLElement | null | undefined, c: string): void => { el?.classList.toggle('unreported', !!reports && !reports.has(c)); };
    for (const [id, el] of this.btnEls) grey(el, `b${id}`);
    const ENC_NAME: Record<number, string> = { [ENCODERS.select]: 'select', [ENCODERS.algo]: 'algo', [ENCODERS.preset]: 'preset', [ENCODERS.k1]: 'k1', [ENCODERS.k2]: 'k2', [ENCODERS.k3]: 'k3', [ENCODERS.k4]: 'k4' };
    for (const [n, e] of this.encEls) grey(e.el, ENC_NAME[n]);
    grey(this.potEl, 'master');
    for (const el of this.keyEls.values()) grey(el, 'keys');
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

  /** the patch does not fit (a card, or the chip once dismissed), or null: it fits */
  notice(n: Fm1Notice | null): void {
    if (!n) {
      this.dismissed = null;
      this.alert.hidden = this.chip.hidden = true;
      return;
    }
    if (this.dismissed !== n.level) this.dismissed = null;
    this.alert.className = `fm1-alert ${n.level}`;
    this.chip.className = `fm1-chip ${n.level}`;
    this.chip.textContent = n.chip;
    this.chip.title = `${n.title}: show why`;
    const card = document.createElement('div');
    card.className = 'fm1-alert-card';
    card.setAttribute('role', 'alertdialog');
    card.setAttribute('aria-label', n.title);
    const head = document.createElement('div');
    head.className = 'fm1-alert-head';
    const h = document.createElement('strong');
    h.textContent = n.title;
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'fm1-alert-close';
    close.textContent = '×';
    close.setAttribute('aria-label', 'Dismiss');
    head.append(h, close);
    const p = document.createElement('p');
    p.textContent = n.body;
    const row = document.createElement('div');
    row.className = 'fm1-alert-row';
    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'fm1-alert-go';
    go.textContent = n.action;
    row.append(go);
    if (n.more) {
      const more = document.createElement('button');
      more.type = 'button';
      more.textContent = 'What costs most';
      more.addEventListener('click', () => n.more?.());
      row.append(more);
    }
    const dismiss = (): void => { this.dismissed = n.level; this.alert.hidden = true; this.chip.hidden = false; };
    close.addEventListener('click', dismiss);
    go.addEventListener('click', dismiss);
    card.append(head, p, row);
    this.alert.replaceChildren(card);
    this.alert.hidden = this.dismissed === n.level;
    this.chip.hidden = !this.alert.hidden;
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

  /** the lights, as X0X's emulator shows them: classes on the buttons and keys */
  private paintLeds(): void {
    if (!this.ui) return;
    const { buttons: b, keys: k } = this.ui.lights();
    for (const [id, el] of this.btnEls) {
      el.classList.toggle('lit', (b.lit >> id & 1) !== 0);
      el.classList.toggle('dim', (b.dim >> id & 1) !== 0);
      el.classList.toggle('breath', (b.breath >> id & 1) !== 0);
    }
    for (const [n, el] of this.keyEls) {
      el.classList.toggle('lit', (k.lit >> n & 1) !== 0);
      el.classList.toggle('mid', (k.mid >> n & 1) !== 0);
      el.classList.toggle('dim', (k.dim >> n & 1) !== 0);
    }
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
    const d = this.dial(body, label, x, y, r, (clicks) => {
      if (!clicks || !this.ui) return;
      this.ui.encoder(n, clicks);
      const e = this.encEls.get(n)!;
      e.turns += clicks;
      d.style.setProperty('--turn', `${e.turns * 18}deg`);
    });
    this.encEls.set(n, { el: d, turns: 0 });
    d.setAttribute('aria-label', `${label} encoder`);
    const k = ([ENCODERS.k1, ENCODERS.k2, ENCODERS.k3, ENCODERS.k4] as number[]).indexOf(n);
    if (k >= 0) d.classList.add(`k${k + 1}`);     /* K1..K4 in their colours, as on the LCD and the editor */
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
    this.potEl = d;
    this.potSet = (x) => { v = Math.min(1, Math.max(0, x)); show(); };
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
