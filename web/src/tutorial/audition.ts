// SPDX-License-Identifier: GPL-3.0-only

/** Owns only tutorial notes and timers. Every stop also cancels audio-unlock work still in flight. */
export class Audition {
  private notes = new Set<number>();
  private generation = 0;
  constructor(private send: (on: boolean, note: number, vel?: number) => void, private unlock: () => Promise<void>) {}
  stop(): void {
    this.generation++;
    for (const note of this.notes) this.send(false, note);
    this.notes.clear();
  }
  /** holds C4 (`note`) or a C major triad (`chord`) until stopped */
  async play(mode: 'note' | 'chord'): Promise<void> {
    this.stop();
    const generation = this.generation;
    await this.unlock();
    if (generation !== this.generation) return;
    for (const n of mode === 'note' ? [60] : [60, 64, 67]) {
      this.notes.add(n);
      this.send(true, n);
    }
  }
}
