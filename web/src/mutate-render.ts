// SPDX-License-Identifier: GPL-3.0-only
// Generate with a category, by ear (#1033, layer 3). About OVERSAMPLE times as many candidates as asked for are made
// (Mutate's role rows already steered: mutate.ts), and each is rendered offline in the browser with the probe (one note
// held, then let go: never the test phrase, D-996; phrase-render.ts), one at a time. Its sound is measured at once and
// dropped: a round keeps only a few numbers per candidate (its loudness contour and brightness, then one fit), for the
// round in flight, and never stores sound anywhere (no browser storage, no cache, no file). A candidate whose sound fits
// the category's profile joins the list as it passes; when fewer than asked pass, the best of the rest fill the round.
import { keysOf } from './levels';
import type { Profile, Span } from './mutate';
import type { Patch } from './patch';
import { PHRASE_VEL, type Phrase } from './phrases';

/** a round makes up to this many times the candidates asked for */
export const OVERSAMPLE = 4;
/** a candidate whose fit (fitScore) is at most this passes: half an octave out in all, as the measures are rough */
export const PASS = 0.5;

/** the probe's note is held this long (seconds) from the start, then let go */
export const PROBE_HOLD = 1;
/** the probe renders this long at most (seconds): the hold, then as long again for the release */
export const PROBE_SECONDS = 2;
/** after the release the render stops once the sound stays this far under its peak (60 dB) */
export const PROBE_QUIET = 1e-3;

/** the probe a patch is measured with, the same whatever the test phrase: one note, velocity 100, held PROBE_HOLD. The
 *  note is C3, or for an engine whose keys reach a Drum map and no Voicing (a drum engine) that Drum map's first row's
 *  note, as levels.ts plays it */
export function probePhrase(p: Patch): Phrase {
  return { kind: 'held', notes: [{ at: 0, len: PROBE_HOLD, note: keysOf(p).key[0], vel: PHRASE_VEL }], length: PROBE_SECONDS };
}

/** how phrase-render.ts renders the probe: PROBE_SECONDS at most, stopping once the release has fallen 60 dB */
export const PROBE_RENDER = { seconds: PROBE_SECONDS, quiet: { after: PROBE_HOLD, below: PROBE_QUIET } } as const;

/** what a render of the probe measures: the loudness contour and the brightness (the sound's mean frequency, weighted by
 *  power, in Hz). The attack is twice the time to half the peak (a reverb that builds up after a quick attack moves the
 *  peak, not the half). The decay and the release are in the profile's terms, the time to come 99 % of the way, from the
 *  time to come three quarters of it (×ln 100 / ln 4; an effect's quiet tail does not count). The sustain is a share of
 *  the peak; the decay is read only when the level falls to half the peak or below. A value the probe's window cuts off
 *  is a least value (`attackAtLeast`, `decayAtLeast`, `releaseAtLeast`): an attack still rising at the end of the hold is
 *  at least the hold, a release not 90 % down at the end at least the time after the release. */
export interface Shape {
  attack?: number;
  attackAtLeast?: boolean;
  decay?: number;
  decayAtLeast?: boolean;
  sustain?: number;
  release?: number;
  releaseAtLeast?: boolean;
  brightness?: number;
  silent?: boolean;
}

/** the loudness is followed in windows this long (seconds) */
const WINDOW = 0.005;
/** the peak, decay, sustain and release read the loudness averaged over this many windows either side (a click at the
 *  start is no peak) */
const SMOOTH = 3;
/** quieter than this peak counts as silent */
const SILENT = 1e-4;
/** from the time to come three quarters of the way to the time to come 99 % of it, for an exponential fall */
const TO_99 = Math.log(100) / Math.log(4);
/** the sustain is the level over this last part of the hold (seconds) */
const SUSTAIN_SPAN = 0.1;
/** an attack is still rising at the end of the hold when its peak lies in this last part of it (seconds) and the level
 *  SUSTAIN_SPAN before the end is under RISING of the peak */
const RISING_SPAN = 0.05;
const RISING = 0.95;
/** the shortest attack a render can tell apart (its windows and smoothing): a shorter one is measured at most this */
export const ATTACK_FLOOR = 0.025;
/** how far the measured sustain may lie outside the profile's and still count as inside: the loudness follows the
 *  filter too, so a held note's level is not the loudness envelope's alone */
export const SUSTAIN_SLACK = 0.15;

/** measure a render of the probe (left and right at `sr`; it may end early, once the release has fallen 60 dB) */
export function measureProbe(l: Float32Array, r: Float32Array, sr: number): Shape {
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
  const w1 = Math.max(1, at(PROBE_HOLD));
  let peak = 0, pw = 0;
  for (let w = 0; w < w1; w++) if (smooth[w] > peak) (peak = smooth[w]), (pw = w);
  if (peak < SILENT) return { silent: true };
  const out: Shape = {};
  const s0 = at(PROBE_HOLD - SUSTAIN_SPAN);
  if (pw >= at(PROBE_HOLD - RISING_SPAN) && smooth[s0] < RISING * peak) [out.attack, out.attackAtLeast] = [PROBE_HOLD, true];
  else {
    let w = 0;
    while (w < pw && env[w] < 0.5 * peak) w++;
    out.attack = Math.max(0.001, 2 * w * WINDOW);
  }
  // sustain: the mean level over the hold's last SUSTAIN_SPAN; the decay only when the level falls to half the peak or below
  let sum = 0;
  for (let k = s0; k < w1; k++) sum += smooth[k];
  out.sustain = sum / Math.max(1, w1 - s0) / peak;
  if (out.sustain <= 0.5 && !out.attackAtLeast) {
    const goal = out.sustain + (1 - out.sustain) * 0.25;
    let d = pw;
    while (d < w1 && smooth[d] / peak > goal) d++;
    out.decay = TO_99 * Math.max(0.001, (d - pw) * WINDOW);
    if (d >= w1) out.decayAtLeast = true;
  }
  // release: from the note's end, three quarters of the way down to its level then; not 90 % down by the end, at least the
  // time the probe gives it
  const from = smooth[Math.min(count - 1, w1)];
  if (w1 < count && from >= SILENT) {
    let k = w1;
    while (k < count && smooth[k] > from * 0.25) k++;
    let down = k;
    while (down < count && smooth[down] > from * 0.1) down++;
    if (down >= count) [out.release, out.releaseAtLeast] = [PROBE_SECONDS - PROBE_HOLD, true];
    else out.release = TO_99 * Math.max(0.001, (k - w1) * WINDOW);
  }
  // brightness: sr / 2π times the ratio of the slope's power to the sound's, over the hold
  let pow = 0, slope = 0;
  for (let i = 1; i < w1 * hop; i++) {
    const x = (l[i] + r[i]) / 2, dx = x - (l[i - 1] + r[i - 1]) / 2;
    pow += x * x;
    slope += dx * dx;
  }
  if (pow > 0) out.brightness = (sr / (2 * Math.PI)) * Math.sqrt(slope / pow);
  return out;
}

/** how far `x` lies outside `span`, in octaves (times) */
const octavesOut = (x: number, [lo, hi]: Span): number => Math.max(0, Math.log2(lo / x), Math.log2(x / hi));
/** how far a time lies outside `span`, in octaves; a least value only counts when it is past the top, so it fits a range
 *  that reaches past it */
const timeOut = (x: number, atLeast: boolean | undefined, span: Span): number => (atLeast ? Math.max(0, Math.log2(x / span[1])) : octavesOut(x, span));

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
  if (s.attack !== undefined) score += timeOut(s.attack, s.attackAtLeast, [amp.a[0], Math.max(amp.a[1], ATTACK_FLOOR)]);
  if (s.decay !== undefined) score += timeOut(s.decay, s.decayAtLeast, amp.d);
  if (s.sustain !== undefined) score += 4 * Math.max(0, amp.s[0] - SUSTAIN_SLACK - s.sustain, s.sustain - amp.s[1] - SUSTAIN_SLACK);
  if (s.release !== undefined) score += timeOut(s.release, s.releaseAtLeast, amp.r);
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
  /** a render of a patch's probe (probePhrase, rendered as PROBE_RENDER says: phrase-render.ts) */
  render: (p: Patch) => Promise<[Float32Array, Float32Array]>;
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
  const parent = measureProbe(...(await o.render(o.parent)), o.sr);
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
    const fit = fitScore(measureProbe(...(await o.render(p)), o.sr), o.profile, parent);
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
