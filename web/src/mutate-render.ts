// SPDX-License-Identifier: GPL-3.0-only
// Make candidates with a category, by ear (#1033, layer 3). About OVERSAMPLE times as many candidates as asked for are made
// (Mutate's role rows already steered: mutate.ts), and each is rendered offline in the browser with the test phrase
// (phrase-render.ts), one at a time. Its sound is measured at once and dropped: a round keeps only a few numbers per
// candidate (its loudness contour and brightness, then one fit), for the round in flight, and never stores sound anywhere
// (no browser storage, no cache, no file). A candidate whose sound fits the category's profile joins the strip as it
// passes; when fewer than asked pass, the best of the rest fill the round.
import type { Profile, Span } from './mutate';
import type { Patch } from './patch';
import type { Phrase } from './phrases';

/** a round makes up to this many times the candidates asked for */
export const OVERSAMPLE = 4;
/** a candidate whose fit (fitScore) is at most this passes: half an octave out in all, as the measures are rough */
export const PASS = 0.5;

/** what a render measures, on the phrase's first note: the loudness contour and the brightness (the sound's mean frequency,
 *  weighted by power, in Hz). The attack is twice the time to half the peak (a reverb that builds up after a quick attack
 *  moves the peak, not the half). The decay and the release are in the profile's terms, the time to come 99 % of the way,
 *  from the time to come three quarters of it (×ln 100 / ln 4; an effect's quiet tail does not count). The sustain is a
 *  share of the peak; the decay is read only when the level falls to half the peak or below. A time the render ends
 *  before is a least value (`decayAtLeast`, `releaseAtLeast`); a stage the phrase does not let sound is absent. */
export interface Shape { attack?: number; decay?: number; decayAtLeast?: boolean; sustain?: number; release?: number; releaseAtLeast?: boolean; brightness?: number; silent?: boolean }

/** the loudness is followed in windows this long (seconds) */
const WINDOW = 0.005;
/** the peak, decay, sustain and release read the loudness averaged over this many windows either side (a click at the
 *  start is no peak) */
const SMOOTH = 3;
/** quieter than this peak counts as silent */
const SILENT = 1e-4;
/** from the time to come three quarters of the way to the time to come 99 % of it, for an exponential fall */
const TO_99 = Math.log(100) / Math.log(4);
/** the shortest attack a render can tell apart (its windows and smoothing): a shorter one is measured at most this */
export const ATTACK_FLOOR = 0.025;
/** how far the measured sustain may lie outside the profile's and still count as inside: the loudness follows the
 *  filter too, so a held note's level is not the loudness envelope's alone */
export const SUSTAIN_SLACK = 0.15;

/** measure a render of `phrase` (left and right at `sr`) */
export function measureShape(l: Float32Array, r: Float32Array, sr: number, phrase: Phrase): Shape {
  const notes = [...phrase.notes].sort((a, b) => a.at - b.at);
  if (!notes.length) return { silent: true };
  const on = notes[0].at, off = on + Math.max(...notes.filter((x) => x.at === on).map((x) => x.len));
  const next = notes.find((x) => x.at > on)?.at ?? l.length / sr;
  const hop = Math.max(1, Math.round(WINDOW * sr)), count = Math.floor(l.length / hop);
  const env = new Float32Array(count);
  for (let w = 0; w < count; w++) {
    let sum = 0;
    for (let i = w * hop; i < (w + 1) * hop; i++) {
      const x = (l[i] + r[i]) / 2;
      sum += x * x;
    }
    env[w] = Math.sqrt(sum / hop);
  }
  const smooth = new Float32Array(count);
  for (let w = 0; w < count; w++) {
    let sum = 0, n = 0;
    for (let k = Math.max(0, w - SMOOTH); k <= Math.min(count - 1, w + SMOOTH); k++) (sum += env[k]), n++;
    smooth[w] = sum / n;
  }
  const at = (t: number): number => Math.min(count, Math.max(0, Math.round(t / WINDOW)));
  const held = Math.min(off, next);
  const [w0, w1] = [at(on), Math.max(at(on) + 1, at(held))];
  let peak = 0, pw = w0;
  for (let w = w0; w < w1; w++) if (smooth[w] > peak) (peak = smooth[w]), (pw = w);
  if (peak < SILENT) return { silent: true };
  const out: Shape = {};
  let w = w0;
  while (w < pw && env[w] < 0.5 * peak) w++;
  out.attack = Math.max(0.001, 2 * (w - w0) * WINDOW);
  // sustain: the mean level over the last tenth of the hold, when the hold is long enough to settle; the decay only when
  // the level falls to half the peak or below
  if (held - on >= 0.3) {
    const s0 = at(held - (held - on) / 10);
    let sum = 0;
    for (let k = s0; k < w1; k++) sum += smooth[k];
    out.sustain = sum / Math.max(1, w1 - s0) / peak;
    const goal = out.sustain + (1 - out.sustain) * 0.25;
    let d = pw;
    while (d < w1 && smooth[d] / peak > goal) d++;
    if (out.sustain <= 0.5) {
      out.decay = TO_99 * Math.max(0.001, (d - pw) * WINDOW);
      if (d >= w1) out.decayAtLeast = true;
    }
  }
  // release: from the note's end to a tenth of its level then, when the phrase leaves a gap after it
  if (off < next) {
    const [r0, r1] = [at(off), at(next)];
    const from = smooth[Math.min(count - 1, r0)];
    if (from >= SILENT) {
      let k = r0;
      while (k < r1 && smooth[k] > from * 0.25) k++;
      out.release = TO_99 * Math.max(0.001, (k - r0) * WINDOW);
      if (k >= r1) out.releaseAtLeast = true;
    }
  }
  // brightness: sr / 2π times the ratio of the slope's power to the sound's, over the hold
  let pow = 0, slope = 0;
  for (let i = Math.max(1, w0 * hop); i < w1 * hop; i++) {
    const x = (l[i] + r[i]) / 2, dx = x - (l[i - 1] + r[i - 1]) / 2;
    pow += x * x;
    slope += dx * dx;
  }
  if (pow > 0) out.brightness = (sr / (2 * Math.PI)) * Math.sqrt(slope / pow);
  return out;
}

/** how far `x` lies outside `span`, in octaves (times) */
const octavesOut = (x: number, [lo, hi]: Span): number => Math.max(0, Math.log2(lo / x), Math.log2(x / hi));

/**
 * How far a measured sound lies from a category's profile: 0 when everything measured is inside. Each loudness stage adds
 * the octaves its time lies outside the profile's loudness envelope range (a least value only when it is past the top),
 * the sustain four times the share it lies outside, and the brightness half the octaves it moved from `parent`'s outside
 * the profile's cutoff range. A silent sound fits nothing (Infinity).
 */
export function fitScore(s: Shape, profile: Profile, parent?: Shape): number {
  if (s.silent) return Infinity;
  const amp = profile.amp;
  let score = 0;
  if (s.attack !== undefined) score += octavesOut(s.attack, [amp.a[0], Math.max(amp.a[1], ATTACK_FLOOR)]);
  if (s.decay !== undefined) score += s.decayAtLeast ? Math.max(0, Math.log2(s.decay / amp.d[1])) : octavesOut(s.decay, amp.d);
  if (s.sustain !== undefined) score += 4 * Math.max(0, amp.s[0] - SUSTAIN_SLACK - s.sustain, s.sustain - amp.s[1] - SUSTAIN_SLACK);
  if (s.release !== undefined) score += s.releaseAtLeast ? Math.max(0, Math.log2(s.release / amp.r[1])) : octavesOut(s.release, amp.r);
  if (s.brightness && parent?.brightness) {
    const moved = Math.log2(s.brightness / parent.brightness);
    score += 0.5 * Math.max(0, profile.cutoff[0] - moved, moved - profile.cutoff[1]);
  }
  return score;
}

export interface FilterRound {
  /** how many candidates the round keeps */
  n: number;
  profile: Profile;
  /** the patch the candidates come from: its brightness is what theirs moves from */
  parent: Patch;
  /** one more candidate (null: it moved nothing) */
  next: () => Patch | null;
  /** a render of a patch with the test phrase (phrase-render.ts) */
  render: (p: Patch) => Promise<[Float32Array, Float32Array]>;
  phrase: Phrase;
  sr: number;
  /** a candidate the round keeps, as it passes (or, at the end, as it fills the round) */
  keep: (p: Patch, fit: number) => void;
  /** after each candidate: how many were rendered, of how many at most, and how many passed */
  progress?: (rendered: number, of: number, passed: number) => void;
  /** true: stop now (the patch on screen changed under the round) */
  cancelled?: () => boolean;
}

/** run a round: candidates rendered and measured one at a time, each kept as it passes, then the best of the rest until
 *  `n` are kept; how many passed, were rendered, and filled the round */
export async function filterRound(o: FilterRound): Promise<{ passed: number; rendered: number; filled: number }> {
  const parent = measureShape(...(await o.render(o.parent)), o.sr, o.phrase);
  const rest: { patch: Patch; fit: number }[] = [];
  const most = o.n * OVERSAMPLE;
  let passed = 0, rendered = 0;
  for (let misses = 0; passed < o.n && rendered < most && misses < most && !o.cancelled?.();) {
    const p = o.next();
    if (!p) {
      misses++;
      continue;
    }
    // (the render lives only inside this call: its numbers are kept, the sound is not)
    const fit = fitScore(measureShape(...(await o.render(p)), o.sr, o.phrase), o.profile, parent);
    rendered++;
    if (o.cancelled?.()) break;
    if (fit <= PASS) {
      o.keep(p, fit);
      passed++;
    } else rest.push({ patch: p, fit });
    o.progress?.(rendered, most, passed);
  }
  rest.sort((a, b) => a.fit - b.fit);
  let filled = 0;
  for (const c of rest) {
    if (passed + filled >= o.n || o.cancelled?.()) break;
    o.keep(c.patch, c.fit);
    filled++;
  }
  return { passed, rendered, filled };
}
