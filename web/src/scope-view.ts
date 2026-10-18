// SPDX-License-Identifier: GPL-3.0-only
// The screens of Scope modules (modules.ts `scope`), on their cards or on an assembly card. A screen streams from the
// audio thread (worklet.ts `view`) only while it is on screen, the tab is visible and audio runs; what is cabled into its
// inputs a and b is drawn in the signal kinds' colours: a short window triggered on a's rising crossing through the
// middle of its range (free running without one), a long window rolling, or the spectrum.
import type { HostMsg } from './worklet';
import type { ViewData } from './scope-stream';
import { spectrum } from './scope';
import { SCOPE_MODES } from './modules';
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
  chans: { id: number; port: string; kind: string }[][];
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
      if (old && old.el !== spec.el) this.io.unobserve(old.el);
      this.io.observe(spec.el);
      next.set(key, { ...spec, key, canvas, visible: old?.el === spec.el ? old.visible : false, sent: old?.sent ?? '', data: old?.data ?? null, voices: old?.voices ?? null, sr: old?.sr ?? 48000 });
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
    g.strokeStyle = style.getPropertyValue('--line').trim();
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(0, H / 2);
    g.lineTo(W, H / 2);
    g.stroke();
    const empty = (text: string): void => {
      g.fillStyle = style.getPropertyValue('--muted').trim();
      g.font = '10px system-ui, sans-serif';
      g.textAlign = 'center';
      g.fillText(text, W / 2, H / 2 - 4);
    };
    if (!s.chans.some((c) => c.length)) return empty('cable a signal into a or b');
    if (!s.data) return empty(this.running() ? '' : 'audio off');
    const spectrumMode = SCOPE_MODES[Math.round(s.m.params.mode ?? 0)] === 'spectrum';
    const samples = Math.round(((s.m.params.time ?? 16) / 1000) * s.sr);
    // the trigger: a's rising crossing through the middle of its range, the latest one that leaves a whole window
    let start = -1;
    const a = s.data[0];
    if (!spectrumMode && a && 'raw' in a && s.chans[0].length && samples <= (TRIGGER_MS / 1000) * s.sr) start = trigger(a.raw, samples);
    g.lineWidth = 1.5;
    // b first, so a (the trigger's input) is drawn over it
    [...s.data.entries()].reverse().forEach(([i, d]) => {
      const kind = s.chans[i][0]?.kind;
      if (!kind) return;
      const colour = style.getPropertyValue(`--${kind}`).trim();
      // per voice: the sum / newest held trace faint, then one thin trace per voice in its colour (b's dashed)
      const voices = s.voices?.[i]?.filter((v) => ('raw' in v) === ('raw' in d));
      const traces: { d: ViewData; colour: string; width: number; alpha: number }[] = voices?.length
        ? [{ d, colour, width: 1.5, alpha: 0.3 }, ...voices.map((v, k) => ({ d: v, colour: style.getPropertyValue(voiceToken(k)).trim(), width: 1, alpha: 0.95 }))]
        : [{ d, colour, width: 1.5, alpha: 1 }];
      const windowOf = (raw: Float32Array): Float32Array => {
        const len = Math.min(samples, raw.length);
        const from = start >= 0 ? start : raw.length - len;
        return raw.subarray(from, from + len);
      };
      // one gain for all of an input's traces
      const scale = Math.max(...traces.map(({ d: t }) => ('raw' in t ? gain(windowOf(t.raw), kind) : Math.max(gain(t.min, kind), gain(t.max, kind)))));
      const plot = (d: ViewData): void => {
        if (spectrumMode) {
          if (!('raw' in d)) return;
          const sp = spectrum(d.raw);
          const n = sp.length, fmin = 20, fmax = s.sr / 2;
          for (let x = 0; x < W; x++) {
            const bin = Math.min(n - 1, Math.round(((fmin * Math.pow(fmax / fmin, x / W)) / fmax) * (n - 1)));
            const y = H - 2 - ((Math.max(-96, Math.min(0, sp[bin])) + 96) / 96) * (H - 4);
            if (x) g.lineTo(x, y);
            else g.moveTo(x, y);
          }
        } else if ('raw' in d) {
          const view = windowOf(d.raw);
          const len = view.length;
          for (let x = 0; x < W; x++) {
            const y = H / 2 - (view[Math.floor((x / W) * len)] / scale) * (H / 2 - 3);
            if (x) g.lineTo(x, y);
            else g.moveTo(x, y);
          }
        } else {
          // rolling: one column per min / max pair, the newest at the right
          const n = d.min.length;
          for (let x = 0; x < W; x++) {
            const k = Math.floor((x / W) * n);
            g.moveTo(x + 0.5, H / 2 - (d.max[k] / scale) * (H / 2 - 3));
            g.lineTo(x + 0.5, H / 2 - (d.min[k] / scale) * (H / 2 - 3) + 0.5);
          }
        }
      };
      g.setLineDash(voices?.length && i > 0 && 'raw' in d ? [3, 2] : []); // a rolling window's columns stay solid
      for (const t of traces) {
        g.strokeStyle = t.colour;
        g.lineWidth = t.width;
        g.globalAlpha = t.alpha;
        g.beginPath();
        plot(t.d);
        g.stroke();
      }
      g.globalAlpha = 1;
      g.setLineDash([]);
    });
  }
}

/** a Scope draws each voice of a per-voice source as its own trace (its `voices` switch, #54) */
const perVoice = (m: ModuleInst): boolean => Math.round(m.params.voices ?? 0) === 1;

/** automatic gain: audio fills the screen, a control signal at least ±1 (so a small cv does not look huge) */
function gain(d: Float32Array, kind: string): number {
  let amp = 1e-3;
  for (const v of d) if (Number.isFinite(v)) amp = Math.max(amp, Math.abs(v));
  return kind === 'audio' ? amp : Math.max(1, amp);
}

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

