// SPDX-License-Identifier: GPL-3.0-only
// The Arpeggiator module's note logic (keys in -> keys out), the same in the firmware (engine.c arp_*): it takes the keys
// on their way from the Main module to a Voice allocator and hands that allocator one note at a time. It runs at the
// start of every block, before the modules (block-quantized: a step lands on a block boundary, 2.9 ms at most late),
// from the engine's 24 ppqn clock (the Main module's tempo, or MIDI clock) at its rate, or, when something is cabled into
// its clk input, one step per block that saw a rising edge there. With rate patched and no clock, its positive block
// average is a continuous frequency in Hz; zero pauses. Inputs are read as the last block left them.

export const ARP_MODES = ['up', 'down', 'up-down', 'random', 'as played'];
export const ARP_RATES = ['1/4', '1/4T', '1/8', '1/8T', '1/16', '1/16T', '1/32'];
/** 24 ppqn ticks per step of each rate */
export const ARP_RATE_TICKS = [24, 16, 12, 8, 6, 4, 3];
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
  /** steps played since the arpeggio started */
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
}

export interface ArpParams {
  mode: number;
  rate: number;
  octaves: number;
  gate: number;
  latch: number;
}

export const arpInit = (): ArpState => ({ held: [], pos: 0, cur: -1, since: 0, interval: 0, next: 0, running: false, ratePhase: 0, seed: 0x2545f491 });

const q16 = (v: number): number => Math.round(v * 65536);
const latched = (p: ArpParams): boolean => q16(p.latch) >= 32768;

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

export function arpClear(s: ArpState): void {
  s.held = [];
}

/** the samples of `ticks` clock ticks at `bpm` (the length of a step before two steps have been measured) */
export const stepSamples = (ticks: number, bpm: number, sr: number): number => Math.floor((ticks * 60 * sr) / (PPQN * bpm));

/** the note of step `pos` and its velocity (mode, octaves); null when nothing is held */
export function arpNote(s: ArpState, p: ArpParams): { note: number; vel: number } | null {
  if (!s.held.length) return null;
  const mode = Math.min(ARP_MODES.length - 1, Math.max(0, Math.round(p.mode)));
  const oct = Math.min(4, Math.max(1, Math.round(p.octaves)));
  const base = mode === 4 ? s.held : [...s.held].sort((a, b) => a.note - b.note);
  const list: ArpKey[] = [];
  for (let o = 0; o < oct; o++) for (const k of base) if (k.note + 12 * o <= 127) list.push({ note: k.note + 12 * o, vel: k.vel, down: k.down });
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
 * One block of `n` samples. `ticks`: the engine's clock count now; `clk`: what is cabled into the clk input (as the last
 * block left it), null when nothing is; `bpm`: the tempo (the first step's length); on / off: hand a note to the
 * allocator(s) this arpeggiator feeds. A patched rateCv overrides tempo, but not a patched clk.
 */
export function arpBlock(
  s: ArpState, p: ArpParams, n: number, ticks: number, clk: Float32Array | null, clkPrev: { hi: boolean }, bpm: number, sr: number,
  on: (note: number, vel: number) => void, off: (note: number) => void, rateCv: Float32Array | null = null,
): void {
  const rate = ARP_RATE_TICKS[Math.min(ARP_RATES.length - 1, Math.max(0, Math.round(p.rate)))];
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
    period = Math.floor(sr * 65536 / hz);
    if (s.running) {
      const phase = s.ratePhase + Math.floor(hz * 65536 / sr) * n;
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
  let step = false;
  if (!s.running) {
    s.running = true;
    step = true;
    s.pos = 0;
    s.next = ticks + rate;
    s.interval = continuous ? period : stepSamples(rate, bpm, sr);
    s.ratePhase = 0;
    s.since = 0;
  } else if (clk ? edge : continuous ? rateEdge : ((ticks - s.next) | 0) >= 0) {
    step = true;
    if (!clk && !continuous) {
      s.next = (s.next + rate) >>> 0;
      if (((ticks - s.next) | 0) >= 0) s.next = (ticks + rate) >>> 0; // fell behind (a tempo jump): from now
    }
    if (!continuous && s.since > 0) s.interval = s.since;
    s.since = 0;
  }
  if (step) {
    const x = arpNote(s, p)!;
    s.pos = (s.pos + 1) >>> 0;
    if (s.cur >= 0) off(s.cur);
    on(x.note, x.vel);
    s.cur = x.note;
  } else if (s.cur >= 0 && s.since >= Math.floor((s.interval * q16(p.gate)) / 65536)) {
    off(s.cur);
    s.cur = -1;
  }
  s.since += n;
}
