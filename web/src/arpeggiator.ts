// SPDX-License-Identifier: GPL-3.0-only
// The Arpeggiator module's note logic (keys in -> keys out), the same in the firmware (engine.c arp_*): it takes the keys
// on their way from the Main module to a Voice allocator and hands that allocator one note at a time. It runs at the
// start of every block, before the modules (block-quantized: a step lands on a block boundary, 2.9 ms at most late),
// from the engine's 24 ppqn clock (the Main module's tempo, or MIDI clock) at its rate, or, when something is cabled into
// its clk input, one step per block that saw a rising edge there. With rate patched and no clock, its positive block
// average is a continuous frequency in Hz; zero pauses. Inputs are read as the last block left them.
//
// The bar rates (#1010): one pass of the pattern fills ½, 1, 2 or 4 bars of the global time signature (#1011), whatever
// the keys held. A pass has notes x octaves steps (up-down: its turnaround notes once, 2 x that - 2), each at its exact
// share of the pass, counted on the clock's phase (its ticks and the part of a tick since), so five notes in a bar stay
// even; a step plays at the start of the block its time falls in, as every step does. While the transport runs the passes
// start on its bar lines (a key pressed in a pass plays the step whose share it falls in at once); stopped, the first key
// starts them. The chord a pass plays is the one held as it started: a change takes effect at the next pass.
//
// Swing (#1012, as Steps' swing): every second step (of a pass with the bar rates) starts late by (swing - 50) / 50 of a
// step; a step ends the note before it either way.

export const ARP_MODES = ['up', 'down', 'up-down', 'random', 'as played'];
/** the clock rates (Steps shares them, track.ts STEPS_RATES) */
export const ARP_RATES = ['1/4', '1/4T', '1/8', '1/8T', '1/16', '1/16T', '1/32'];
/** 24 ppqn ticks per step of each clock rate */
export const ARP_RATE_TICKS = [24, 16, 12, 8, 6, 4, 3];
/** the bar rates (#1010), after the clock rates: a pass of the pattern fills this many half bars */
export const ARP_FIT = ['1/2 bar', '1 bar', '2 bars', '4 bars'];
export const ARP_FIT_HALVES = [1, 2, 4, 8];
/** the `rate` parameter's choices */
export const ARP_RATE_CHOICES = [...ARP_RATES, ...ARP_FIT];
/** keys the arpeggiator holds at most (the oldest goes) */
export const ARP_HELD = 16;
/** the engines' clock: ticks per quarter note */
export const PPQN = 24;

export interface ArpKey {
  note: number;
  vel: number;
  /** the key is down now (a latched key that was let go: false) */
  down: boolean;
}

export interface ArpState {
  /** the keys, in the order they were pressed */
  held: ArpKey[];
  /** steps played since the arpeggio started (with a bar rate: the step of the pass) */
  pos: number;
  /** the note sounding now, -1: none */
  cur: number;
  /** samples since the last step, and between the last two (the gate length is a share of it) */
  since: number;
  interval: number;
  /** the clock tick of the next step (its own clock) */
  next: number;
  running: boolean;
  /** Fraction of a continuous-rate cycle, in unsigned 32-bit turns. */
  ratePhase: number;
  /** the random mode's generator */
  seed: number;
  /** swing: a step waiting to start (`pend`, the step it plays), `wait` samples after its time; the sounding note started
   *  `late` samples after its step */
  pend: boolean;
  pendPos: number;
  wait: number;
  late: number;
  /** the bar rates: they ran in the last block (`fit`), aligned to the transport (`fitRun`); the pass's keys (`cyc`) and
   *  steps, its next step, its number since the transport started, and where a pass started while stopped (ticks and the
   *  clock's phase in the tick) */
  fit: boolean;
  fitRun: boolean;
  cyc: ArpKey[];
  steps: number;
  j: number;
  cycle: number;
  oTicks: number;
  oFrac: number;
}

export interface ArpParams {
  mode: number;
  rate: number;
  octaves: number;
  gate: number;
  latch: number;
  /** % (50 straight) */
  swing: number;
}

/** the engine's clock as an arpeggiator reads it, after this block's ticks */
export interface ArpClock {
  /** the clock's ticks so far */
  ticks: number;
  /** the part of the next tick gone by, of `whole`: the tempo's accumulator, or with MIDI clock the samples since its last
   *  tick over a measured tick (whole - 1 at most) */
  frac: number;
  whole: number;
  /** samples a tick: the tempo's, or as measured between MIDI clock ticks */
  tickLen: number;
  bpm: number;
  sr: number;
  /** the transport runs, and the ticks when it last started */
  run: boolean;
  runTicks: number;
  /** a bar of the global time signature, in ticks */
  bar: number;
}

export const arpInit = (): ArpState => ({
  held: [], pos: 0, cur: -1, since: 0, interval: 0, next: 0, running: false, ratePhase: 0, seed: 0x2545f491,
  pend: false, pendPos: 0, wait: 0, late: 0, fit: false, fitRun: false, cyc: [], steps: 1, j: 0, cycle: 0, oTicks: 0, oFrac: 0,
});

const q16 = (v: number): number => Math.round(v * 65536);
const latched = (p: ArpParams): boolean => q16(p.latch) >= 32768;
const modeOf = (p: ArpParams): number => Math.min(ARP_MODES.length - 1, Math.max(0, Math.round(p.mode)));
const octavesOf = (p: ArpParams): number => Math.min(4, Math.max(1, Math.round(p.octaves)));

export function arpKeyOn(s: ArpState, note: number, vel: number, p: ArpParams): void {
  if (latched(p) && !s.held.some((k) => k.down)) s.held = []; // a new chord after all keys were let go replaces the latched one
  s.held = s.held.filter((k) => k.note !== note);
  if (s.held.length >= ARP_HELD) s.held.shift();
  s.held.push({ note, vel, down: true });
}

export function arpKeyOff(s: ArpState, note: number, p: ArpParams): void {
  for (const k of s.held) if (k.note === note) k.down = false;
  if (!latched(p)) s.held = s.held.filter((k) => k.note !== note);
}

/** a key leaves the held keys even when latched (a Harmonizer's RETRIG ended its note: engine.c arp_key_drop) */
export function arpKeyDrop(s: ArpState, note: number): void {
  s.held = s.held.filter((k) => k.note !== note);
}

export function arpClear(s: ArpState): void {
  s.held = [];
}

/** the samples of `ticks` clock ticks at `bpm` (the length of a step before two steps have been measured) */
export const stepSamples = (ticks: number, bpm: number, sr: number): number => Math.floor((ticks * 60 * sr) / (PPQN * bpm));

/** the steps of one pass over `keys` (the bar rates): notes x octaves (those up to 127), up-down's turnaround once */
export function arpSteps(keys: readonly ArpKey[], p: ArpParams): number {
  let len = 0;
  for (let o = 0; o < octavesOf(p); o++) for (const k of keys) if (k.note + 12 * o <= 127) len++;
  return modeOf(p) === 2 && len > 2 ? 2 * len - 2 : Math.max(1, len);
}

/** the note of step `pos` of `keys` and its velocity (mode, octaves); null when nothing is held */
export function arpNote(s: ArpState, p: ArpParams, keys: readonly ArpKey[] = s.held): { note: number; vel: number } | null {
  if (!keys.length) return null;
  const mode = modeOf(p);
  const oct = octavesOf(p);
  const base = mode === 4 ? keys : [...keys].sort((a, b) => a.note - b.note);
  const list: ArpKey[] = [];
  for (let o = 0; o < oct; o++) for (const k of base) if (k.note + 12 * o <= 127) list.push({ note: k.note + 12 * o, vel: k.vel, down: k.down });
  if (!list.length) return null;
  let i: number;
  if (mode === 1) {
    i = list.length - 1 - (s.pos % list.length);
  } else if (mode === 2 && list.length > 2) {
    const cycle = 2 * list.length - 2; // up, then down without repeating the ends
    const k = s.pos % cycle;
    i = k < list.length ? k : cycle - k;
  } else if (mode === 3) {
    s.seed = (Math.imul(s.seed, 1664525) + 1013904223) >>> 0;
    i = (s.seed >>> 16) % list.length;
  } else {
    i = s.pos % list.length;
  }
  return list[i];
}

/**
 * One block of `n` samples. `c`: the engine's clock after this block's ticks; `clk`: what is cabled into the clk input (as
 * the last block left it), null when nothing is; on / off: hand a note to the allocator(s) this arpeggiator feeds. A
 * patched rateCv overrides the rate, but not a patched clk.
 */
export function arpBlock(
  s: ArpState, p: ArpParams, n: number, c: ArpClock, clk: Float32Array | null, clkPrev: { hi: boolean },
  on: (note: number, vel: number) => void, off: (note: number) => void, rateCv: Float32Array | null = null,
): void {
  const r = Math.min(ARP_RATE_CHOICES.length - 1, Math.max(0, Math.round(p.rate)));
  const fitI = r - ARP_RATES.length;
  if (!latched(p)) s.held = s.held.filter((k) => k.down); // latch turned off: the keys let go meanwhile go
  const continuous = !clk && rateCv !== null;
  let hz = 0, period = 0, rateEdge = false;
  if (continuous) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += rateCv![i];
    hz = Math.trunc(sum * 65536 / n);
    if (hz <= 0) {
      if (s.cur >= 0) off(s.cur);
      s.cur = -1; s.running = false; s.ratePhase = 0;
      return;
    }
    hz = Math.min(80 * 65536, Math.max(1311, hz)); // positive rate: 0.02..80 Hz
    period = Math.floor(c.sr * 65536 / hz);
    if (s.running) {
      const phase = s.ratePhase + Math.floor(hz * 65536 / c.sr) * n;
      rateEdge = phase >= 4294967296;
      s.ratePhase = phase >>> 0;
    }
    s.interval = period;
  }
  let edge = false;
  if (clk) {
    for (let i = 0; i < n; i++) {
      const hi = clk[i] > 0.5;
      if (hi && !clkPrev.hi) edge = true;
      clkPrev.hi = hi;
    }
  }
  if (!s.held.length) {
    if (s.cur >= 0) off(s.cur);
    s.cur = -1;
    s.running = false;
    return;
  }
  const fit = fitI >= 0 && !clk && !continuous;
  const cycTicks = fitI >= 0 ? (c.bar * ARP_FIT_HALVES[fitI]) / 2 : 0;
  // a clock rate's ticks; a bar rate's under clk or rate (the first step's length): a step of a pass of the keys now
  const rate = fitI < 0 ? ARP_RATE_TICKS[r] : Math.max(1, Math.floor(cycTicks / arpSteps(s.held, p)));
  let step = false, at = s.pos;
  const started = !s.running; // (a key that starts it plays at once, swing or not)
  if (fit) {
    const whole = c.whole, C = cycTicks * whole;
    let pos: number, fresh = !s.running || !s.fit;
    if (c.run) { // the passes from the transport's start: on its bar lines
      const t = (c.ticks - c.runTicks) >>> 0, k = Math.floor(t / cycTicks);
      pos = (t - k * cycTicks) * whole + c.frac;
      if (k !== s.cycle || !s.fitRun) fresh = true;
      s.cycle = k;
    } else {
      if (fresh) { // (stopped: from this key)
        s.oTicks = c.ticks;
        s.oFrac = c.frac;
      } else if (s.fitRun) { // (the transport stopped: the pass goes on where it is)
        s.oTicks = (c.runTicks + s.cycle * cycTicks) >>> 0;
        s.oFrac = 0;
      }
      pos = Math.max(0, ((c.ticks - s.oTicks) >>> 0) * whole + c.frac - s.oFrac);
      while (pos >= C) {
        pos -= C;
        s.oTicks = (s.oTicks + cycTicks) >>> 0;
        fresh = true;
      }
    }
    if (fresh) { // a pass starts: its keys and steps
      s.cyc = s.held.map((k) => ({ ...k }));
      s.steps = arpSteps(s.cyc, p);
      s.j = 0;
    }
    const due = Math.min(s.steps - 1, Math.floor((pos * s.steps) / C)); // the step whose share of the pass has come
    if (!s.running) {
      s.running = true;
      s.since = 0;
      s.pend = false;
    }
    if (due >= s.j) {
      step = true;
      at = due;
      s.j = due + 1;
    }
    s.interval = Math.floor((cycTicks * c.tickLen) / s.steps);
    s.fit = true;
    s.fitRun = c.run;
  } else {
    s.fit = false;
    if (!s.running) {
      s.running = true;
      step = true;
      s.pos = 0;
      at = 0;
      s.next = c.ticks + rate;
      s.interval = continuous ? period : stepSamples(rate, c.bpm, c.sr);
      s.ratePhase = 0;
      s.since = 0;
      s.pend = false;
    } else if (clk ? edge : continuous ? rateEdge : ((c.ticks - s.next) | 0) >= 0) {
      step = true;
      if (!clk && !continuous) {
        s.next = (s.next + rate) >>> 0;
        if (((c.ticks - s.next) | 0) >= 0) s.next = (c.ticks + rate) >>> 0; // fell behind (a tempo jump): from now
      }
      if (!continuous && s.since > 0) s.interval = s.since;
    }
  }
  const fire = (k: number): void => {
    const keys = fit ? s.cyc : s.held;
    s.pos = k;
    const x = arpNote(s, p, keys);
    s.pos = (k + 1) >>> 0;
    s.pend = false;
    s.late = s.since;
    if (!x) return;
    on(x.note, x.vel);
    s.cur = x.note;
  };
  if (step) {
    s.since = 0;
    s.late = 0;
    if (s.cur >= 0) off(s.cur);
    s.cur = -1;
    const swing = q16(p.swing) - 50 * 65536;
    // the step's length the swing is a share of: the clock rate's, the pass's share, the clk or rate input's period
    const sl = fit || clk || continuous ? s.interval : rate * c.tickLen;
    const d = !started && at & 1 && swing > 0 && sl > 0 ? Math.floor((swing * sl) / (50 * 65536)) : 0;
    if (d > 0) {
      s.pend = true;
      s.pendPos = at;
      s.wait = d;
    } else fire(at);
  } else if (s.pend && s.since >= s.wait) {
    fire(s.pendPos);
  } else if (s.cur >= 0 && s.since >= s.late + Math.floor((s.interval * q16(p.gate)) / 65536)) {
    off(s.cur);
    s.cur = -1;
  }
  s.since += n;
}
