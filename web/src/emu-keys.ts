// SPDX-License-Identifier: GPL-3.0-only
// The editor's notes while the Emulator view shows (#110, #467): they are the emulated FM-1's keys. The panel's own
// keys (the pill keys, the computer keyboard, the on-screen keyboard) sound what the firmware UI plays for them, as the
// FM-1 does: with the keys reaching a Drum map, black keys 1..8 play its rows 1..8 (D-520), a white key nothing or its
// own note (D-430). A MIDI note, or one the FM-1 the editor follows played, keeps its note number (D-520: MIDI notes
// play their note's row); it lights the key and enters steps on the SEQ page. No DOM here: main.ts wires it.
import type { KeyPlay } from './fm1-ui';
import type { HostMsg } from './worklet';

/** the 27 keys from F3 (MIDI 53) at the panel's octave held now, as bits (bit 0 = F3); notes off the keybed are left out */
export function keyBits(notes: Iterable<number>, octave: number): number {
  let bits = 0;
  for (const n of notes) {
    const k = n - 53 - 12 * octave;
    if (k >= 0 && k < 27) bits |= 1 << k;
  }
  return bits;
}

/** what EmuKeys needs of the Emulator view (fm1-view.ts Fm1View) */
export interface EmuPanel {
  readonly shown: boolean;
  /** null until the firmware UI has loaded; page 8 = the SEQ page */
  readonly ui: { readonly page: number; readonly octave: number } | null;
  /** the notes held now, as the 27 keys: what the keys that changed played (fm1-ui.ts Fm1Ui.keys) */
  keys(notes: Iterable<number>): KeyPlay[];
}

/** the SEQ page (firmware/src/ui.c PAGE_SEQ) */
const PAGE_SEQ = 8;

export class EmuKeys {
  /** the notes held on the emulated keys (by any source) */
  private held = new Set<number>();
  /** MIDI notes the SEQ page took as steps: their release is used up too */
  private swallowed = new Set<number>();
  /** the panel's keys pressed through the firmware UI: their release sounds what it lets go */
  private panel = new Set<number>();

  constructor(private emu: EmuPanel) {}

  /** a message on its way to the browser engine; `fromPanel`: one of the panel's keys (not MIDI). Returns what to play
   * in its place: the message itself, what the firmware UI played for a panel key (the row of a Drum map, a key's own
   * note), or nothing (a key the FM-1 leaves silent, the SEQ page's steps) */
  route(msg: HostMsg, fromPanel = false): HostMsg[] {
    if (msg.t === 'panic') { this.held.clear(); this.swallowed.clear(); this.panel.clear(); }
    if (msg.t !== 'on' && msg.t !== 'off') return [msg];
    const ui = this.emu.ui;
    const note = msg.note;
    // (a key let go after the view was left: the firmware UI still lets it go, so its note ends)
    if (!ui || !(this.emu.shown || (msg.t === 'off' && this.held.has(note)))) return [msg];
    const onKeybed = keyBits([note], ui.octave) !== 0;
    if (msg.t === 'on') this.held.add(note);
    else this.held.delete(note);
    const played = this.emu.keys(this.held);
    if (msg.t === 'on' ? fromPanel && onKeybed : this.panel.has(note)) {
      if (msg.t === 'on') this.panel.add(note);
      else this.panel.delete(note);
      return played.map((p): HostMsg => p.on && msg.t === 'on' ? { t: 'on', note: p.note, vel: msg.vel } : { t: 'off', note: p.note });
    }
    if (msg.t === 'on' && ui.page === PAGE_SEQ) { this.swallowed.add(note); return []; }
    if (msg.t === 'off' && this.swallowed.delete(note)) return [];
    return [msg];
  }
}
