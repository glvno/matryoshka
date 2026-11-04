// SPDX-License-Identifier: GPL-3.0-only
// When the editor compares its copy of a followed FM-1's panel logic (the Emu view) with the FM-1's own state (GUIDE_NOW,
// #549, D-482): a quarter of a second after the last report or panel input, whichever came last.

/** how long after the last GUIDE_NOW, button MIDI or KEYS_NOW the copy is compared with the FM-1's state */
export const ALIGN_MS = 250;

/**
 * The comparison waits for the last of the FM-1's GUIDE_NOW and the panel inputs the copy took (a button's MIDI, a turn,
 * KEYS_NOW). The FM-1 sends GUIDE_NOW after it has drawn the page an input led to, while the button's MIDI leaves at
 * once: a page change (SEL let go on the SEQ page: the SONG page) reaches the copy as MIDI tens of milliseconds before
 * the GUIDE_NOW that reports it. A comparison timed from the GUIDE_NOW before it alone could fall in that gap and put
 * the copy back on the page it had just rightly left (#549: SEQ, SONG, SEQ, SONG).
 */
export class PanelAlign {
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(private readonly compare: () => void, private readonly ms = ALIGN_MS) {}
  /** a GUIDE_NOW came, or the copy took one of the FM-1's panel inputs: the comparison waits ms from now */
  soon(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = undefined; this.compare(); }, this.ms);
  }
}
