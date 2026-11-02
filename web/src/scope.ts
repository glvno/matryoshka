// SPDX-License-Identifier: GPL-3.0-only
// The FFT behind the Scope module's spectrum view (scope-view.ts).
const FFT_N = 2048;

/** in-place radix-2 FFT of re / im (length a power of two) */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

/** the magnitude spectrum (dB, 0 = full scale sine) of the last FFT_N samples, Hann windowed; bins 0..N/2 */
export function spectrum(data: Float32Array): Float32Array {
  const re = new Float64Array(FFT_N), im = new Float64Array(FFT_N);
  const off = Math.max(0, data.length - FFT_N);
  for (let i = 0; i < FFT_N; i++) re[i] = (data[off + i] ?? 0) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FFT_N));
  fft(re, im);
  const out = new Float32Array(FFT_N / 2 + 1);
  for (let i = 0; i <= FFT_N / 2; i++) out[i] = 20 * Math.log10(Math.hypot(re[i], im[i]) / (FFT_N / 4) + 1e-9); // a full-scale sine reads 0 dB
  return out;
}

// ---- the screen's scale (#518): labelled gridlines, a fixed or automatic range, the time per division

/** a scale the screen draws in: the bottom and top values and the values its gridlines are at (lo first) */
export interface ScopeScale {
  lo: number;
  hi: number;
  lines: number[];
}

/** the smallest of 1, 2, 2.5, 5 × 10^k at or above x (x > 0) */
export function niceStep(x: number): number {
  const p = Math.pow(10, Math.floor(Math.log10(x)));
  for (const m of [1, 2, 2.5, 5]) if (m * p >= x * (1 - 1e-9)) return m * p;
  return 10 * p;
}

/** gridlines from lo to hi every `step` */
const linesOf = (lo: number, hi: number, step: number): number[] => {
  const out: number[] = [];
  for (let k = Math.round(lo / step); k * step <= hi + step * 1e-6; k++) out.push(Number((k * step).toPrecision(6)) || 0);
  return out;
};

/** a fixed scale of ±a, gridlines every a / 2 */
export const fixedScale = (a: number): ScopeScale => ({ lo: -a, hi: a, lines: linesOf(-a, a, a / 2) });

/**
 * The scale `auto` picks for traces spanning lo..hi: about four divisions of a 1-2-2.5-5 step, with gridlines on the
 * step. A signal on both sides of 0 gets a scale even around 0 (audio, an LFO); one on one side keeps 0 in sight while
 * it is within its own span of 0 (an envelope: 0..1); one far from 0 is fitted alone (a pitch around 3 octaves up).
 * Nothing to measure (no finite values, or a flat 0) gives ±1.
 */
export function autoScale(lo: number, hi: number): ScopeScale {
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo) return fixedScale(1);
  if (hi - lo < 1e-9) {
    if (Math.abs(hi) < 1e-9) return fixedScale(1);
    // a constant: from 0 to it
    lo = Math.min(0, lo);
    hi = Math.max(0, hi);
  }
  const even = lo < 0 && hi > 0;
  if (even) [lo, hi] = [-Math.max(-lo, hi), Math.max(-lo, hi)];
  else if (lo >= 0 && lo <= hi - lo) lo = 0;
  else if (hi <= 0 && -hi <= hi - lo) hi = 0;
  // the step that fits closest, then the one nearest four divisions
  let best: ScopeScale | null = null;
  for (const n of [2, 3, 4, 5, 6]) {
    const step = niceStep((hi - lo) / n);
    const fix = (v: number): number => Number(v.toPrecision(12)) || 0;
    const a = fix(Math.floor(lo / step + 1e-9) * step);
    const b = fix(Math.max(a + step, Math.ceil(hi / step - 1e-9) * step));
    const s = even ? { lo: -Math.max(-a, b), hi: Math.max(-a, b), lines: [] as number[] } : { lo: a, hi: b, lines: [] as number[] };
    s.lines = linesOf(s.lo, s.hi, step);
    const worse = (x: ScopeScale, y: ScopeScale): boolean => {
      const dx = x.hi - x.lo, dy = y.hi - y.lo;
      return dx > dy * (1 + 1e-9) || (Math.abs(dx - dy) <= dy * 1e-9 && Math.abs(x.lines.length - 5) > Math.abs(y.lines.length - 5));
    };
    if (!best || worse(best, s)) best = s;
  }
  return best!;
}

/** the scale for a `scale` choice (modules.ts SCOPE_SCALES): auto fits lo..hi, the others are fixed */
export function scopeScale(choice: string, lo: number, hi: number): ScopeScale {
  if (choice === '±1') return fixedScale(1);
  if (choice === '±4') return fixedScale(4);
  return autoScale(lo, hi);
}

/** how long `auto` keeps a scale the traces have shrunk inside, before it fits them closer (ms) */
export const AUTO_HOLD_MS = 1000;

/**
 * Auto-range that does not twitch: a scale the traces outgrow is replaced at once, one they have shrunk inside is kept
 * for AUTO_HOLD_MS before it fits them closer.
 */
export class AutoRange {
  private scale: ScopeScale | null = null;
  private since = -1;

  next(lo: number, hi: number, now: number): ScopeScale {
    const want = autoScale(lo, hi);
    const cur = this.scale;
    if (!cur || want.lo < cur.lo || want.hi > cur.hi) {
      this.scale = want;
      this.since = -1;
    } else if (want.lo !== cur.lo || want.hi !== cur.hi) {
      if (this.since < 0) this.since = now;
      else if (now - this.since >= AUTO_HOLD_MS) {
        this.scale = want;
        this.since = -1;
      }
    } else this.since = -1;
    return this.scale ?? want;
  }

  reset(): void {
    this.scale = null;
    this.since = -1;
  }
}

/** the time per division of a window `ms` long over `divs` divisions, as the screen labels it ("1.6 ms/div", "0.2 s/div") */
export function perDivision(ms: number, divs = 10): string {
  const d = ms / divs;
  const n = (v: number): string => String(Number(v.toPrecision(3)));
  return d >= 1000 ? `${n(d / 1000)} s/div` : d >= 1 ? `${n(d)} ms/div` : `${n(d * 1000)} µs/div`;
}

/** a value as a gridline's label or the readout shows it: up to three significant digits, a real minus sign */
export function scopeNum(v: number): string {
  if (Math.abs(v) < 1e-9) return '0';
  const s = String(Number(v.toPrecision(3)));
  return s.startsWith('-') ? `−${s.slice(1)}` : s;
}

/** the lowest and highest finite values of some arrays (Infinity / -Infinity when none) */
export function extent(...arrays: ArrayLike<number>[]): { lo: number; hi: number } {
  let lo = Infinity, hi = -Infinity;
  for (const a of arrays)
    for (let i = 0; i < a.length; i++) {
      const v = a[i];
      if (!Number.isFinite(v)) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  return { lo, hi };
}
