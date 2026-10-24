// SPDX-License-Identifier: GPL-3.0-only
// MIDI clock out: the editor as the clock for FM-1s (or any other MIDI device). While it is on, the ticked MIDI outputs get
// MIDI clock, 24 a quarter note at Main's tempo, all the time (so a device follows the tempo before it starts), and Start /
// Stop with the editor's Play. Every clock is sent ahead with its own timestamp (Web MIDI times it), so the timer only has
// to come round every few tens of milliseconds; a worker's timer (clock-tick.ts) keeps it coming while the tab is in the
// background, where the page's own timers slow to once a second.
import { TEMPO_MAX, TEMPO_MIN } from './modules';

const TEMPO_DEFAULT = 120; // (engine.ts: Main's tempo when a patch has none)

export interface ClockPort {
  readonly id: string;
  readonly name?: string | null;
  readonly state?: string;
  send(data: number[], timestamp?: number): void;
}

const CLOCK = 0xf8, START = 0xfa, STOP = 0xfc;
/** how far ahead clocks are sent (ms): the timer's period plus room for the page being busy (a patch loading, a redraw); a
 * tempo change is heard this much later */
export const LOOKAHEAD = 300;
/** a timer later than this (a laptop waking, a frozen tab) restarts the clock from now instead of sending the missed ones */
const LATE = 1000;

/** the outputs ticked when the user chose nothing for them: an FM-1 (not its update loader) */
export const isFm1Out = (name: string | null | undefined): boolean => /fm-?1|matryoshka/i.test(name ?? '') && !/ota-/i.test(name ?? '');

/** milliseconds between two clocks at `bpm` (whole bpm, clamped as the engines clamp Main's tempo) */
export const clockPeriod = (bpm: number): number => {
  const b = Math.min(TEMPO_MAX, Math.max(TEMPO_MIN, Math.round(Number.isFinite(bpm) ? bpm : TEMPO_DEFAULT)));
  return 60000 / (b * 24);
};

/** port names for the list: the same name twice (two FM-1s) gets " 2", " 3" in the order the browser lists them */
export function portLabels(ports: readonly ClockPort[]): Map<string, string> {
  const seen = new Map<string, number>(), out = new Map<string, string>();
  for (const p of ports) {
    const name = p.name || 'MIDI output';
    const n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    out.set(p.id, n === 1 ? name : `${name} ${n}`);
  }
  return out;
}

export class ClockOut {
  private ports: ClockPort[] = [];
  private next = 0;          // when the next clock goes out (performance.now() ms)
  private on = false;

  /** `bpm`: Main's tempo, read at every clock (a tempo change is heard at once); `now`: performance.now */
  constructor(private bpm: () => number, private now: () => number = () => performance.now()) {}

  get running(): boolean { return this.on; }

  /** the ports that get clock and Start / Stop (a port the browser lost is skipped) */
  setPorts(ports: readonly ClockPort[]): void { this.ports = [...ports]; }

  /** clock on or off; on, the first clock goes out now */
  enable(on: boolean): void {
    if (on === this.on) return;
    this.on = on;
    if (on) {
      this.next = this.now();
      this.pump();
    }
  }

  /** the editor's Play: Start or Stop, now, to every ticked port (also while the clock is off: nothing then) */
  transport(run: boolean): void {
    if (this.on) this.send([run ? START : STOP], this.now());
  }

  /** the timer: send every clock due before now + LOOKAHEAD */
  pump(): void {
    if (!this.on) return;
    const now = this.now();
    if (now - this.next > LATE) this.next = now;
    while (this.next < now + LOOKAHEAD) {
      this.send([CLOCK], Math.max(this.next, now));
      this.next += clockPeriod(this.bpm());
    }
  }

  private send(data: number[], at: number): void {
    for (const p of this.ports) {
      if (p.state === 'disconnected') continue;
      try {
        p.send(data, at);
      } catch {
        /* a port that went away between two timers: skipped until the list is built again */
      }
    }
  }
}
