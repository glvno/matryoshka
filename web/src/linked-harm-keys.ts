// SPDX-License-Identifier: GPL-3.0-only
// The keys of an FM-1 under Live, while they reach a Harmonizer (#1053, docs/ledger/editor.md D-643, docs/ledger/modules.md
// D-781). The FM-1 plays its seven lowest keys as the chord buttons and its other keys as roots, and its MIDI out sends a
// chord button as the key under the Harmonizer's split and a root as its own note (firmware/src/panel.c panel_key). A
// root that lands under the split (the FM-1 an octave down) then reads as a chord button, so the browser engine cannot
// play those notes as the FM-1 does. While the keys reach a Harmonizer, it plays what the editor's copy of the FM-1's
// panel logic played for the key the FM-1 reported (KEYS_NOW) instead, and the FM-1's notes play nothing. Each note-on is
// decided when it comes; what ends it follows that decision. No DOM here: main.ts wires it.
import type { HostMsg } from './worklet';

/** what a message starts or ends: a note, a chord button, a note into a track; null neither */
function voice(m: HostMsg): { id: string; on: boolean } | null {
  if (m.t === 'on' || m.t === 'off') return { id: `n${m.note}`, on: m.t === 'on' };
  if (m.t === 'chord') return { id: `c${m.button}:${m.track ?? -1}`, on: m.down };
  if (m.t === 'thru') return { id: `t${m.id}:${m.note}`, on: m.vel > 0 };
  return null;
}

export class LinkedHarmKeys {
  /** the FM-1's notes held now that played nothing */
  private dropped = new Set<number>();
  /** what the copy played that has not ended yet */
  private copied = new Set<string>();

  /** one of the FM-1's notes; `harm`: its keys reach a Harmonizer now. What the browser engine plays for it */
  note(m: HostMsg, harm: boolean): HostMsg[] {
    if (m.t === 'panic') { this.dropped.clear(); this.copied.clear(); }
    if (m.t === 'on' && harm) { this.dropped.add(m.note); return []; }
    if (m.t === 'on') this.dropped.delete(m.note);
    return m.t === 'off' && this.dropped.delete(m.note) ? [] : [m];
  }

  /** what the copy of the panel logic played for a key the FM-1 reported; `harm` as for `note`. What the browser engine
   *  plays of it: all of it while the keys reach a Harmonizer, else only the ends of what it played before */
  copy(plays: HostMsg[], harm: boolean): HostMsg[] {
    return plays.filter((m) => {
      const v = voice(m);
      if (!v) return false;
      if (!v.on) return this.copied.delete(v.id);
      if (harm) this.copied.add(v.id);
      return harm;
    });
  }
}
