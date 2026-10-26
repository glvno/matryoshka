// SPDX-License-Identifier: GPL-3.0-only
// The shape of an envelope module (ADSR, Env L/R) on its card or an assembly card, Serum style: the curve the module's own
// code makes (run here offline: gate held through the sustain, then released), laid out with each segment as wide as
// the square root of its time (a short attack stays visible next to a long release) and the sustain in a fixed slot; a dot
// per copy that sounds (one per voice in a poly assembly, the newest held one brightest) streamed from the audio thread
// while the shape is on screen; the live (modulated) values draw the curve, the settings a faint outline while they
// differ; its corners drag the times (sideways) and levels (up / down).
import { ADSR_LONG, env8End, env8Sus, ENV8_HOLD, IMPLS } from './modules';
import type { ModuleInst } from './patch';
import type { HostMsg } from './worklet';

/** how an envelope's stages map to its parameters (for its settings: the eight-step envelope's depend on sus and end) */
interface Spec {
  /** the stage that holds while the gate is up */
  sustain: number;
  /** the stage the gate's fall starts, if any (none: the gate only starts the envelope); with holdLast the sustain slot
   * goes after the last moving stage */
  release?: number;
  holdLast?: boolean;
  /** the time parameter of each moving stage, in the order they run (release last) */
  times: [number, string][];
  /** the stage a finished one goes on to while the gate stays up */
  next(stage: number): number;
  /** the corners: where each segment ends, which parameter its x drags (a time) and its y (a level), if any */
  corners: { stage: number; x: string; y?: string }[];
}
const SPECS: Record<string, (p: Record<string, number>) => Spec> = {
  adsr: () => ({
    sustain: 3, release: 4, times: [[1, 'a'], [2, 'd'], [4, 'r']], next: (st) => st + 1,
    corners: [{ stage: 1, x: 'a' }, { stage: 2, x: 'd', y: 's' }, { stage: 4, x: 'r' }],
  }),
  env: (p) => {
    const shot = (p.shot ?? 0) >= 0.5; // one-shot: no sustain, the release follows the last segment
    return {
      sustain: 4, release: shot ? undefined : 5, times: [[1, 'r1'], [2, 'r2'], [3, 'r3'], [5, 'r4']], next: (st) => (st === 3 ? (shot ? 5 : 4) : st + 1),
      corners: [{ stage: 1, x: 'r1', y: 'l1' }, { stage: 2, x: 'r2', y: 'l2' }, { stage: 3, x: 'r3', y: 'l3' }, { stage: 5, x: 'r4', y: 'l4' }],
    };
  },
  // steps 1..end; the sustain slot after step sus (the gate's fall starts the next), at the end when sus = end, none when off
  env8: (p) => {
    const end = env8End(p.end ?? 3);
    const hs = env8Sus(Math.round(p.sus ?? 2), end);
    const steps = Array.from({ length: end }, (_, i) => i + 1);
    return {
      sustain: ENV8_HOLD, release: hs && hs < end ? hs + 1 : undefined, holdLast: hs === end,
      times: steps.map((k) => [k, `r${k}`]), next: (st) => (st === hs ? ENV8_HOLD : st + 1),
      corners: steps.map((k) => ({ stage: k, x: `r${k}`, y: `l${k}` })),
    };
  },
};
/** the module types that draw an envelope's shape */
export const ENV_TYPES = Object.keys(SPECS);
/** an envelope's stages for these settings */
export const envSpec = (type: string, p: Record<string, number>): Spec => SPECS[type](p);

/** the share of the width the sustain slot takes, and the narrowest a moving segment gets */
const SUSTAIN_W = 0.16;
const MIN_W = 0.05;
/** samples the offline run takes per moving segment */
const SEG_SAMPLES = 240;

export interface Segment {
  stage: number;
  /** its time parameter and value (s); the sustain slot has none */
  time?: { name: string; value: number };
  x0: number;
  x1: number;
  /** the level along it, sampled evenly from x0 to x1 */
  ys: number[];
}

/**
 * The shape of an envelope with these parameter values, x and y in 0..1: the module's own process() run per segment at a
 * rate that gives each segment SEG_SAMPLES samples (stopping at its time, as a decay that only nears its target).
 */
export function envShape(type: string, p: Record<string, number>): Segment[] {
  const spec = envSpec(type, p);
  const impl = IMPLS[type];
  const moving = spec.times.map(([st]) => st);
  const timeOf = new Map(spec.times);
  const raw: { stage: number; ys: number[]; time: number }[] = [];
  let state = impl.init(48000);
  const gate = new Float32Array(1);
  const out = new Float32Array(1);
  const run = (stage: number, sr: number, max: number): number[] => {
    const ys: number[] = [];
    const c = { sr, n: 1, inp: { gate }, out: { env: out }, connected: { gate: true }, p, voice: null as never };
    for (let i = 0; i < max; i++) {
      impl.process(c, state);
      ys.push(out[0]);
      if ((state as { stage: number }).stage !== stage) break;
    }
    return ys;
  };
  let level = 0;
  gate[0] = 1;
  for (const stage of moving) {
    const time = p[timeOf.get(stage)!] ?? 0.01;
    // (the ADSR's `long` stretches its decay and release: the segment runs at the rate of the time it plays)
    const sr = SEG_SAMPLES / Math.max(time * (type === 'adsr' && stage !== 1 && (p.long ?? 0) >= 0.5 ? ADSR_LONG : 1), 1e-4);
    if (stage === spec.release) {
      // the sustain slot first: the level the held gate rests at
      raw.push({ stage: spec.sustain, ys: [level, level], time: 0 });
      gate[0] = 0;
    }
    // a segment whose start is already its end (a level equal to the one before) still gets its slot
    if ((state as { stage: number }).stage !== stage && stage !== spec.release && raw.length) {
      raw.push({ stage, ys: [level, level], time });
      continue;
    }
    // the first sample with the gate up (or down) starts the stage; keep the state across segments at their own rates
    const ys = [level, ...run(stage, sr, SEG_SAMPLES + 1)];
    level = ys[ys.length - 1];
    raw.push({ stage, ys, time });
    // a stage that ran out its time without reaching its target: move the state on by hand so the next one starts
    if ((state as { stage: number }).stage === stage && stage !== spec.release) {
      state = { ...(state as object), stage: spec.next(stage) } as typeof state;
      (state as { v: number }).v = level;
      if ('t' in (state as object)) (state as { t: number }).t = 0;
    }
  }
  if (spec.holdLast) raw.push({ stage: spec.sustain, ys: [level, level], time: 0 });
  // widths: sqrt of the time, at least MIN_W, the sustain slot fixed
  const moves = raw.filter((r) => r.stage !== spec.sustain);
  const weights = moves.map((r) => Math.sqrt(Math.max(r.time, 1e-4)));
  const sum = weights.reduce((a, b) => a + b, 0) || 1;
  const free = 1 - (raw.length > moves.length ? SUSTAIN_W : 0) - MIN_W * moves.length;
  let x = 0;
  let k = 0;
  return raw.map((r) => {
    const w = r.stage === spec.sustain ? SUSTAIN_W : MIN_W + (free * weights[k++]) / sum;
    const seg: Segment = { stage: r.stage, x0: x, x1: x + w, ys: r.ys };
    if (r.stage !== spec.sustain) seg.time = { name: timeOf.get(r.stage)!, value: r.time };
    x += w;
    return seg;
  });
}

/** where a copy at this stage and level sits on the shape (x 0..1), or null when it is idle */
export function dotX(segs: Segment[], stage: number, v: number): number | null {
  const seg = segs.find((s) => s.stage === stage);
  if (!seg) return null;
  if (seg.ys.length < 3) return seg.x0;
  let best = 0;
  for (let i = 1; i < seg.ys.length; i++) if (Math.abs(seg.ys[i] - v) < Math.abs(seg.ys[best] - v)) best = i;
  return seg.x0 + ((seg.x1 - seg.x0) * best) / (seg.ys.length - 1);
}

export interface EnvSpec {
  m: ModuleInst;
  el: HTMLElement;
}

interface Screen extends EnvSpec {
  key: string;
  canvas: HTMLCanvasElement;
  visible: boolean;
  sent: boolean;
  states: { stage: number; v: number; newest: boolean }[] | null;
  /** the live (modulated) values, newest held copy's; null: the settings */
  live: Record<string, number> | null;
  hoverX: number | null;
}

/** what the editor gives an envelope display to change the patch: a parameter, and an undo step around a drag */
export interface EnvEdits {
  set(id: number, name: string, v: number): void;
  begin(): () => void;
  limits(type: string, name: string): { min: number; max: number; def: number };
}

/** the inset of the curve inside its canvas (px): room for the corners' handles */
const PAD = 5;

export class EnvScreens {
  private screens = new Map<string, Screen>();
  private io: IntersectionObserver;
  private raf = 0;

  constructor(private send: (msg: HostMsg) => void, private running: () => boolean, private edits: EnvEdits) {
    this.io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const s = [...this.screens.values()].find((x) => x.el === e.target);
        if (s) s.visible = e.isIntersecting;
      }
      this.tick();
    });
    document.addEventListener('visibilitychange', () => this.tick());
  }

  sync(specs: EnvSpec[]): void {
    const next = new Map<string, Screen>();
    for (const spec of specs) {
      const key = `env:${spec.m.id}`;
      const old = this.screens.get(key);
      const canvas = document.createElement('canvas');
      spec.el.append(canvas);
      if (old && old.el !== spec.el) this.io.unobserve(old.el);
      this.io.observe(spec.el);
      const s: Screen = { ...spec, key, canvas, visible: old?.el === spec.el ? old.visible : false, sent: old?.sent ?? false, states: old?.states ?? null, live: old?.live ?? null, hoverX: null };
      this.attach(s);
      next.set(key, s);
    }
    for (const [key, s] of this.screens)
      if (!next.has(key)) {
        this.io.unobserve(s.el);
        if (s.sent) this.send({ t: 'unenvwatch', key });
      }
    this.screens = next;
    this.tick();
  }

  receive(key: string, states: Screen['states']): void {
    const s = this.screens.get(key);
    if (!s) return;
    s.states = states;
    this.schedule();
  }

  /** the engine's live parameter values (Engine.parameterValues), or null when audio is off */
  values(values: { id: number; params: Record<string, number> }[] | null): void {
    for (const s of this.screens.values()) s.live = values?.find((v) => v.id === s.m.id)?.params ?? null;
    this.schedule();
  }

  state(): void {
    this.tick();
  }

  /** a parameter changed outside (a slider): redraw */
  changed(): void {
    this.schedule();
  }

  private tick(): void {
    const on = this.running() && !document.hidden;
    for (const s of this.screens.values()) {
      const want = on && s.visible;
      if (want !== s.sent) this.send(want ? { t: 'envwatch', key: s.key, id: s.m.id } : { t: 'unenvwatch', key: s.key });
      s.sent = want;
      if (!want) s.states = null;
    }
    this.schedule();
  }

  private schedule(): void {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      for (const s of this.screens.values()) if (s.visible) this.draw(s);
    });
  }

  /** the values the curve is drawn with: live while audio runs, else the settings */
  private shown(s: Screen): Record<string, number> {
    return { ...s.m.params, ...(s.live ?? {}) };
  }

  /** the corners in canvas px of a shape */
  private corners(s: Screen, segs: Segment[], W: number, H: number): { x: number; y: number; x_: string; y_?: string }[] {
    const spec = envSpec(s.m.type, this.shown(s));
    return spec.corners.flatMap((c) => {
      const seg = segs.find((g) => g.stage === c.stage);
      if (!seg) return [];
      return [{ x: PAD + seg.x1 * (W - 2 * PAD), y: PAD + (1 - seg.ys[seg.ys.length - 1]) * (H - 2 * PAD), x_: c.x, y_: c.y }];
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
    const color = (name: string): string => style.getPropertyValue(name).trim();
    const X = (x: number): number => PAD + x * (W - 2 * PAD);
    const Y = (y: number): number => PAD + (1 - y) * (H - 2 * PAD);
    const path = (segs: Segment[]): void => {
      g.beginPath();
      let first = true;
      for (const seg of segs)
        seg.ys.forEach((y, i) => {
          const x = X(seg.x0 + ((seg.x1 - seg.x0) * i) / Math.max(1, seg.ys.length - 1));
          if (first) g.moveTo(x, Y(y));
          else g.lineTo(x, Y(y));
          first = false;
        });
    };
    const base = envShape(s.m.type, s.m.params);
    const shown = this.shown(s);
    const spec = envSpec(s.m.type, shown);
    const modulated = s.live && spec.corners.some((c) =>
      Math.abs((shown[c.x] ?? 0) - (s.m.params[c.x] ?? 0)) > 1e-6 || (c.y && Math.abs((shown[c.y] ?? 0) - (s.m.params[c.y] ?? 0)) > 1e-6));
    const segs = modulated ? envShape(s.m.type, shown) : base;
    // segment dividers, the sustain slot shaded
    g.fillStyle = color('--line');
    for (const seg of segs) {
      if (seg.stage === spec.sustain) {
        g.globalAlpha = 0.35;
        g.fillRect(X(seg.x0), PAD, X(seg.x1) - X(seg.x0), H - 2 * PAD);
        g.globalAlpha = 1;
      }
      g.fillRect(Math.round(X(seg.x1)), PAD, 1, H - 2 * PAD);
    }
    // the settings' outline while modulated
    if (modulated) {
      g.strokeStyle = color('--muted');
      g.setLineDash([2, 3]);
      g.lineWidth = 1;
      path(base);
      g.stroke();
      g.setLineDash([]);
    }
    // the curve, filled under
    const ink = color('--control');
    path(segs);
    g.lineWidth = 1.5;
    g.strokeStyle = ink;
    g.stroke();
    g.lineTo(X(segs[segs.length - 1]?.x1 ?? 1), Y(0));
    g.lineTo(X(0), Y(0));
    g.closePath();
    g.globalAlpha = 0.14;
    g.fillStyle = ink;
    g.fill();
    g.globalAlpha = 1;
    // the corners (handles), stronger under the pointer
    for (const c of this.corners(s, segs, W, H)) {
      g.beginPath();
      g.arc(c.x, c.y, 3, 0, Math.PI * 2);
      g.fillStyle = color('--panel');
      g.fill();
      g.lineWidth = 1.5;
      g.strokeStyle = ink;
      g.stroke();
    }
    // the copies that sound: older ones faint, the newest held one bright
    for (const st of (s.states ?? []).filter((x) => x.stage !== 0).sort((a, b) => Number(a.newest) - Number(b.newest))) {
      const x = dotX(segs, st.stage, st.v);
      if (x === null) continue;
      g.beginPath();
      g.arc(X(x), Y(st.v), st.newest ? 4 : 3, 0, Math.PI * 2);
      g.globalAlpha = st.newest ? 1 : 0.45;
      g.fillStyle = color('--accent');
      g.fill();
      g.globalAlpha = 1;
    }
    // the hovered segment's time
    if (s.hoverX !== null) {
      const seg = segs.find((x) => s.hoverX! >= X(x.x0) && s.hoverX! < X(x.x1));
      const text = seg?.time ? `${seg.time.name.toUpperCase()} ${fmtTime(seg.time.value)}` : seg ? 'SUSTAIN' : '';
      if (text) {
        g.font = "600 10px 'Barlow Condensed', system-ui, sans-serif";
        g.fillStyle = color('--ink');
        g.textAlign = 'right';
        g.fillText(text, W - 6, 12);
      }
    }
  }

  /** hover (the segment's time) and drags on the corners: x drags the time on a log scale, y the level; Shift finer; double-click resets */
  private attach(s: Screen): void {
    const cv = s.canvas;
    const at = (e: PointerEvent | MouseEvent): { x: number; y: number } => {
      const r = cv.getBoundingClientRect();
      // the canvas may be drawn scaled (canvas zoom): back to its own px
      return { x: ((e.clientX - r.left) * cv.clientWidth) / r.width, y: ((e.clientY - r.top) * cv.clientHeight) / r.height };
    };
    const nearest = (e: PointerEvent | MouseEvent): ReturnType<EnvScreens['corners']>[number] | null => {
      const p = at(e);
      const segs = envShape(s.m.type, s.m.params);
      let best: ReturnType<EnvScreens['corners']>[number] | null = null;
      let d = 10;
      for (const c of this.corners(s, segs, cv.clientWidth, cv.clientHeight)) {
        const dd = Math.hypot(c.x - p.x, c.y - p.y);
        if (dd < d) { d = dd; best = c; }
      }
      return best;
    };
    cv.addEventListener('pointermove', (e) => {
      s.hoverX = at(e).x;
      cv.style.cursor = nearest(e) ? 'grab' : '';
      this.schedule();
    });
    cv.addEventListener('pointerleave', () => { s.hoverX = null; this.schedule(); });
    cv.addEventListener('dblclick', (e) => {
      const c = nearest(e);
      if (!c) return;
      const commit = this.edits.begin();
      for (const name of [c.x_, c.y_]) if (name) this.edits.set(s.m.id, name, this.edits.limits(s.m.type, name).def);
      commit();
      this.schedule();
    });
    cv.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const c = nearest(e);
      if (!c) return;
      e.preventDefault();
      e.stopPropagation();
      cv.setPointerCapture(e.pointerId);
      const commit = this.edits.begin();
      const start = at(e);
      const t0 = s.m.params[c.x_];
      const l0 = c.y_ ? s.m.params[c.y_] : 0;
      const tl = this.edits.limits(s.m.type, c.x_);
      const ll = c.y_ ? this.edits.limits(s.m.type, c.y_) : null;
      const h = cv.clientHeight - 2 * PAD;
      cv.style.cursor = 'grabbing';
      const move = (ev: PointerEvent): void => {
        const p = at(ev);
        const fine = ev.shiftKey ? 0.2 : 1;
        // sideways: a doubling of the time per 40 px; up / down: the level, the full height = 0..1
        const t = Math.min(tl.max, Math.max(tl.min, t0 * Math.pow(2, ((p.x - start.x) * fine) / 40)));
        this.edits.set(s.m.id, c.x_, Number(t.toPrecision(3)));
        if (c.y_ && ll) {
          const l = Math.min(ll.max, Math.max(ll.min, l0 - ((p.y - start.y) * fine) / h));
          this.edits.set(s.m.id, c.y_, Math.round(l * 100) / 100);
        }
        this.schedule();
      };
      const up = (): void => {
        cv.removeEventListener('pointermove', move);
        cv.removeEventListener('pointerup', up);
        cv.removeEventListener('pointercancel', up);
        cv.style.cursor = '';
        commit();
      };
      cv.addEventListener('pointermove', move);
      cv.addEventListener('pointerup', up);
      cv.addEventListener('pointercancel', up);
    });
  }
}

/** a time for the hover label: ms below a second */
function fmtTime(t: number): string {
  return t < 1 ? `${Number((t * 1000).toPrecision(3))} ms` : `${Number(t.toPrecision(3))} s`;
}
