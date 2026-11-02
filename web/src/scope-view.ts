// SPDX-License-Identifier: GPL-3.0-only
// The screens of Scope modules (modules.ts `scope`), on their cards or on an assembly card. A screen streams from the
// audio thread (worklet.ts `view`) only while it is on screen, the tab is visible and audio runs; what is cabled into its
// inputs a and b is drawn in the signal kinds' colours: a short window triggered on a's rising crossing through the
// middle of its range (free running without one), a long window rolling, or the spectrum. Both inputs share one scale
// (fixed ±1 / ±4, or auto-range), drawn as labelled gridlines with the time per division; a readout under the screen
// gives each input's lowest and highest value and where it comes from with that output's range (#518).
import type { HostMsg } from './worklet';
import type { ViewData } from './scope-stream';
import { AutoRange, extent, perDivision, scopeNum, scopeScale, spectrum, type ScopeScale } from './scope';
import { SCOPE_MODES, SCOPE_SCALES } from './modules';
import { voiceToken } from './voice-colors';
import type { ModuleInst } from './patch';

/** windows up to this long (ms) trigger; longer ones roll */
const TRIGGER_MS = 100;
/** samples the spectrum is taken over (scope.ts spectrum uses the last 2048) */
const SPECTRUM_SAMPLES = 2048;

/** a screen as the editor drew it: the Scope module, the element to draw in, per input the outputs cabled into it */
export interface ScreenSpec {
  m: ModuleInst;
  el: HTMLElement;
  chans: { id: number; port: string; kind: string; label?: string; range?: () => string }[][];
}

interface Screen extends ScreenSpec {
  key: string;
  canvas: HTMLCanvasElement;
  visible: boolean;
  /** the stream asked for (its message as JSON), '' when none */
  sent: string;
  data: ViewData[] | null;
  /** per input its voices' histories (#54), while the module's `voices` is on and the input's sources run per voice */
  voices: (ViewData[] | null)[] | null;
  sr: number;
  /** the auto-range's scale, kept between frames (#518) */
  auto: AutoRange;
  /** the readout under the screen, when it last changed and what it says */
  readEl: HTMLElement;
  readAt: number;
  readText: string;
}

export class ScopeScreens {
  private screens = new Map<string, Screen>();
  private io: IntersectionObserver;
  private raf = 0;

  constructor(private send: (msg: HostMsg) => void, private running: () => boolean) {
    this.io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const s = [...this.screens.values()].find((x) => x.el === e.target);
        if (s) s.visible = e.isIntersecting;
      }
      this.tick();
    });
    document.addEventListener('visibilitychange', () => this.tick());
  }

  /** the screens the editor drew this time (after every rebuild): streams follow them */
  sync(specs: ScreenSpec[]): void {
    const next = new Map<string, Screen>();
    for (const spec of specs) {
      const key = `scope:${spec.m.id}`;
      const old = this.screens.get(key);
      const canvas = document.createElement('canvas');
      spec.el.append(canvas);
      const readEl = document.createElement('div');
      readEl.className = 'scope-readout';
      spec.el.after(readEl);
      if (old && old.el !== spec.el) this.io.unobserve(old.el);
      this.io.observe(spec.el);
      next.set(key, { ...spec, key, canvas, visible: old?.el === spec.el ? old.visible : false, sent: old?.sent ?? '', data: old?.data ?? null, voices: old?.voices ?? null, sr: old?.sr ?? 48000, auto: old?.auto ?? new AutoRange(), readEl, readAt: 0, readText: '' });
    }
    for (const [key, s] of this.screens)
      if (!next.has(key)) {
        this.io.unobserve(s.el);
        if (s.sent) this.send({ t: 'unview', key });
      }
    this.screens = next;
    this.tick();
  }

  /** a stream's latest history from the audio thread */
  receive(key: string, chans: ViewData[], sr: number, voices: (ViewData[] | null)[] | null = null): void {
    const s = this.screens.get(key);
    if (!s) return;
    s.data = chans;
    s.voices = perVoice(s.m) ? voices : null;
    s.sr = sr;
    this.schedule();
  }

  /** audio started or stopped */
  state(): void {
    this.tick();
  }

  /** ask for, change or drop each screen's stream; the time / mode the module has now (a slider moves without a rebuild) */
  private tick(): void {
    const on = this.running() && !document.hidden;
    for (const s of this.screens.values()) {
      const want = on && s.visible && s.chans.some((c) => c.length) ? JSON.stringify(this.message(s)) : '';
      if (want === s.sent) continue;
      if (want) this.send(JSON.parse(want) as HostMsg);
      else this.send({ t: 'unview', key: s.key });
      s.sent = want;
      if (!want) {
        s.data = null;
        s.voices = null;
      }
    }
    this.schedule();
  }

  private message(s: Screen): HostMsg {
    const spectrumMode = SCOPE_MODES[Math.round(s.m.params.mode ?? 0)] === 'spectrum';
    const samples = spectrumMode ? SPECTRUM_SAMPLES : Math.round(((s.m.params.time ?? 16) / 1000) * s.sr);
    const msg: HostMsg = { t: 'view', key: s.key, chans: s.chans.map((c) => c.map(({ id, port }) => ({ id, port }))), samples };
    if (perVoice(s.m)) msg.voices = true;
    return msg;
  }

  private schedule(): void {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      // a slider may have changed time / mode since: the stream follows on the next frame
      if ([...this.screens.values()].some((s) => s.sent && s.sent !== JSON.stringify(this.message(s)))) this.tick();
      for (const s of this.screens.values()) if (s.visible) this.draw(s);
    });
  }

  private draw(s: Screen): void {
    const cv = s.canvas;
    const W = cv.clientWidth, H = cv.clientHeight;
    const g = cv.getContext('2d');
    if (!g || !W || !H) return;
    const dpr = window.devicePixelRatio || 1;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
      cv.width = Math.round(W * dpr);
      cv.height = Math.round(H * dpr);
    }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const style = getComputedStyle(cv);
    const token = (name: string): string => style.getPropertyValue(name).trim();
    const empty = (text: string): void => {
      g.strokeStyle = token('--line');
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(0, H / 2);
      g.lineTo(W, H / 2);
      g.stroke();
      g.fillStyle = token('--muted');
      g.font = '10px system-ui, sans-serif';
      g.textAlign = 'center';
      g.fillText(text, W / 2, H / 2 - 4);
      this.readout(s, null);
    };
    if (!s.chans.some((c) => c.length)) return empty('cable a signal into a or b');
    if (!s.data) return empty(this.running() ? '' : 'audio off');
    const spectrumMode = SCOPE_MODES[Math.round(s.m.params.mode ?? 0)] === 'spectrum';
    const ms = s.m.params.time ?? 16;
    const samples = Math.round((ms / 1000) * s.sr);
    // the trigger: a's rising crossing through the middle of its range, the latest one that leaves a whole window
    let start = -1;
    const a = s.data[0];
    if (!spectrumMode && a && 'raw' in a && s.chans[0].length && samples <= (TRIGGER_MS / 1000) * s.sr) start = trigger(a.raw, samples);
    const windowOf = (raw: Float32Array): Float32Array => {
      const len = Math.min(samples, raw.length);
      const from = start >= 0 ? start : raw.length - len;
      return raw.subarray(from, from + len);
    };
    const shown = (d: ViewData): ArrayLike<number>[] => ('raw' in d ? [windowOf(d.raw)] : [d.min, d.max]);
    // per input: its traces (per voice: the sum / newest held faint, then one thin trace per voice in its colour)
    const inputs = [...s.data.entries()].map(([i, d]) => {
      const kind = s.chans[i]?.[0]?.kind;
      const voices = s.voices?.[i]?.filter((v) => ('raw' in v) === ('raw' in d));
      const colour = kind ? token(`--${kind}`) : '';
      const traces: { d: ViewData; colour: string; width: number; alpha: number }[] = voices?.length
        ? [{ d, colour, width: 1.5, alpha: 0.3 }, ...voices.map((v, k) => ({ d: v, colour: token(voiceToken(k)), width: 1, alpha: 0.95 }))]
        : [{ d, colour, width: 1.5, alpha: 1 }];
      return { i, d, kind, voices, traces, own: extent(...shown(d)), all: extent(...traces.flatMap((t) => shown(t.d))) };
    }).filter((x) => x.kind);
    this.readout(s, inputs.map(({ i, own }) => ({ i, ...own })));
    // one scale for both inputs, so the gridlines read for each (#518)
    const lo = Math.min(...inputs.map((x) => x.all.lo)), hi = Math.max(...inputs.map((x) => x.all.hi));
    const choice = SCOPE_SCALES[Math.round(s.m.params.scale ?? 0)] ?? 'auto';
    const scale: ScopeScale = spectrumMode ? DB_SCALE : choice === 'auto' ? s.auto.next(lo, hi, performance.now()) : scopeScale(choice, lo, hi);
    if (spectrumMode || choice !== 'auto') s.auto.reset();
    const PAD = 4;
    const yOf = (v: number): number => H - PAD - ((v - scale.lo) / (scale.hi - scale.lo)) * (H - 2 * PAD);
    // the gridlines and their labels (#518): values up the left, the time (or frequency) along the bottom
    g.lineWidth = 1;
    g.font = '9px system-ui, sans-serif';
    g.textBaseline = 'middle';
    g.textAlign = 'left';
    const grid = token('--line'), label = token('--muted');
    if (spectrumMode) {
      const fmin = 20, fmax = s.sr / 2;
      for (const f of [100, 1000, 10000]) {
        const x = Math.round((Math.log(f / fmin) / Math.log(fmax / fmin)) * W) + 0.5;
        g.strokeStyle = grid;
        g.globalAlpha = 0.5;
        g.beginPath();
        g.moveTo(x, 0);
        g.lineTo(x, H);
        g.stroke();
        g.globalAlpha = 1;
        g.fillStyle = label;
        g.fillText(f >= 1000 ? `${f / 1000}k` : String(f), x + 2, H - 6);
      }
    } else
      for (let k = 1; k < DIVISIONS; k++) {
        const x = Math.round((k / DIVISIONS) * W) + 0.5;
        g.strokeStyle = grid;
        g.globalAlpha = 0.35;
        g.beginPath();
        g.moveTo(x, 0);
        g.lineTo(x, H);
        g.stroke();
      }
    g.globalAlpha = 1;
    for (const v of scale.lines) {
      const y = Math.round(yOf(v)) + 0.5;
      g.strokeStyle = grid;
      g.globalAlpha = v === 0 ? 1 : 0.6;
      g.setLineDash(v === 0 ? [] : [2, 3]);
      g.beginPath();
      g.moveTo(0, y);
      g.lineTo(W, y);
      g.stroke();
      g.setLineDash([]);
      g.globalAlpha = 1;
      g.fillStyle = label;
      const text = spectrumMode ? `${scopeNum(v)} dB` : scopeNum(v);
      g.fillText(text, 3, Math.min(H - 5, Math.max(5, y)));
    }
    g.textAlign = 'right';
    g.fillStyle = label;
    const axis = spectrumMode ? `20 Hz–${Math.round(s.sr / 2000)} kHz` : `${perDivision(ms, DIVISIONS)}${choice === 'auto' ? ' · auto' : ''}`;
    g.fillText(axis, W - 3, H - 6);
    // b first, so a (the trigger's input) is drawn over it
    for (const { i, d, voices, traces } of [...inputs].reverse()) {
      const plot = (d: ViewData): void => {
        if (spectrumMode) {
          if (!('raw' in d)) return;
          const sp = spectrum(d.raw);
          const n = sp.length, fmin = 20, fmax = s.sr / 2;
          for (let x = 0; x < W; x++) {
            const bin = Math.min(n - 1, Math.round(((fmin * Math.pow(fmax / fmin, x / W)) / fmax) * (n - 1)));
            const y = yOf(Math.max(DB_SCALE.lo, Math.min(DB_SCALE.hi, sp[bin])));
            if (x) g.lineTo(x, y);
            else g.moveTo(x, y);
          }
        } else if ('raw' in d) {
          const view = windowOf(d.raw);
          const len = view.length;
          for (let x = 0; x < W; x++) {
            const y = yOf(view[Math.floor((x / W) * len)]);
            if (x) g.lineTo(x, y);
            else g.moveTo(x, y);
          }
        } else {
          // rolling: one column per min / max pair, the newest at the right
          const n = d.min.length;
          for (let x = 0; x < W; x++) {
            const k = Math.floor((x / W) * n);
            g.moveTo(x + 0.5, yOf(d.max[k]));
            g.lineTo(x + 0.5, yOf(d.min[k]) + 0.5);
          }
        }
      };
      g.save();
      g.beginPath();
      g.rect(0, 0, W, H);
      g.clip();
      g.setLineDash(voices?.length && i > 0 && 'raw' in d ? [3, 2] : []); // a rolling window's columns stay solid
      for (const t of traces) {
        g.strokeStyle = t.colour;
        g.lineWidth = t.width;
        g.globalAlpha = t.alpha;
        g.beginPath();
        plot(t.d);
        g.stroke();
      }
      g.restore();
    }
  }

  /** the readout under a screen (#518): per input its lowest and highest value in the window and their distance, then
   *  where it comes from and that output's range; refreshed a few times a second so it can be read. null: nothing to say */
  private readout(s: Screen, rows: { i: number; lo: number; hi: number }[] | null): void {
    const now = performance.now();
    if (rows && now - s.readAt < READOUT_MS) return;
    s.readAt = rows ? now : 0;
    const lines = readoutLines(s.chans, rows);
    const text = JSON.stringify(lines);
    if (text === s.readText) return;
    s.readText = text;
    s.readEl.replaceChildren(...lines.map((l) => {
      const row = document.createElement('div');
      row.className = `scope-read ${l.kind}`;
      const name = document.createElement('b');
      name.textContent = l.input;
      const value = document.createElement('span');
      value.className = 'scope-value';
      value.textContent = l.value;
      const src = document.createElement('span');
      src.className = 'scope-src';
      src.textContent = l.range ? `${l.from}: ${l.range}` : l.from;
      row.title = `${l.input}: the lowest..highest value in the window, and the distance between them (peak to peak). From ${l.from}${l.range ? `, range ${l.range}` : ''}`;
      row.append(name, value, src);
      return row;
    }));
  }
}

/** the readout's lines (#518): per cabled input its name, the lowest..highest value and peak to peak ('–' before any
 *  data), its sources' names and, for a single source, that output's range */
export function readoutLines(chans: ScreenSpec['chans'], rows: { i: number; lo: number; hi: number }[] | null): { input: string; kind: string; value: string; from: string; range: string }[] {
  const out: { input: string; kind: string; value: string; from: string; range: string }[] = [];
  chans.forEach((c, i) => {
    if (!c.length) return;
    const row = rows?.find((r) => r.i === i);
    const value = row && Number.isFinite(row.lo) ? `${scopeNum(row.lo)}..${scopeNum(row.hi)}  p-p ${scopeNum(row.hi - row.lo)}` : '–';
    out.push({ input: i ? 'b' : 'a', kind: c[0].kind, value, from: c.map((x) => x.label ?? x.port).join(' + '), range: c.length === 1 ? c[0].range?.() ?? '' : '' });
  });
  return out;
}

/** the spectrum's scale: dB, gridlines every 24 dB */
const DB_SCALE: ScopeScale = { lo: -96, hi: 0, lines: [-96, -72, -48, -24, 0] };
/** a waveform window's divisions along the time axis */
const DIVISIONS = 10;
/** how often the readout under a screen changes (ms): slow enough to read */
const READOUT_MS = 150;

/** a Scope draws each voice of a per-voice source as its own trace (its `voices` switch, #54) */
const perVoice = (m: ModuleInst): boolean => Math.round(m.params.voices ?? 0) === 1;

/** the start of the window: the latest rising crossing through the middle of the signal's range that leaves `len` samples after it, else -1 */
export function trigger(d: Float32Array, len: number): number {
  let lo = Infinity, hi = -Infinity;
  for (const v of d) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (!(hi - lo > 1e-6)) return -1;
  const mid = (lo + hi) / 2;
  for (let i = d.length - len; i >= 1; i--) if (d[i - 1] < mid && d[i] >= mid) return i;
  return -1;
}

