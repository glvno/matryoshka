// SPDX-License-Identifier: GPL-3.0-only
// The FM-1's own keys in sandbox mode (docs/ledger/link-and-midi.md D-467): the FM-1 does not hold the patch, so it sends
// its keys as plain notes (docs/ledger/device-ui.md D-232), and the editor plays them as the FM-1 plays its keys
// (docs/ledger/steps.md D-520): while the keys reach a Drum map, black keys 1..8 play its rows 1..8 at any octave, the
// white keys nothing, or their own note when the map repeats its rows (D-430). This is firmware/src/panel.c panel_key and
// engine.c eng_keys_drummap on the editor's patch. No DOM here: main.ts wires it.
import { armView, keepArmed, type DeviceKey } from './arm';
import { DEFS } from './modules';
import type { ModuleDef, ModuleInst, Patch } from './patch';
import { trackDrumMap } from './poly';
import type { HostMsg } from './worklet';

/** the FM-1's lowest key (F3) at octave 0, and its keybed's 27 keys */
const KEY0 = 53;
const KEYS = 27;
/** a key's place among the black keys from F#3 (firmware/src/seq_ui.c seq_black), -1 a white key */
const BLACK = [-1, 0, -1, 1, -1, 2, -1, -1, 3, -1, 4, -1];
export const blackKey = (n: number): number => (n >= 0 && n < KEYS && BLACK[n % 12] >= 0 ? Math.floor(n / 12) * 5 + BLACK[n % 12] : -1);

/** the Drum map the FM-1's keys reach (engine.c eng_keys_drummap): of what hears Main's keys (the armed set, else what is
 * cabled to them) at least one Drum map, on the keys or behind a track, and nothing that plays them as notes (a Voicing,
 * the shared keyboard with Main's pitch / gate / velocity cabled, an Arpeggiator on Main's keys, a track into no Drum
 * map). The first such map in module order, null none */
export function keysDrumMap(p: Patch, armed: Iterable<DeviceKey> = [], defs: Record<string, ModuleDef> = DEFS): ModuleInst | null {
  const list = keepArmed(p, armed, defs);
  const v = armView(p, list, defs);
  const main = v.modules.find((m) => m.type === 'fm1');
  if (!main) return null;
  if (!list.length && v.cables.some((c) => c.from.module === main.id && ['pitch', 'gate', 'vel'].includes(c.from.port))) return null;
  const heard = new Set(v.cables.filter((c) => c.from.module === main.id && c.from.port === 'keys').map((c) => c.to.module));
  let map: ModuleInst | null = null;
  for (const m of v.modules) {
    if (!heard.has(m.id)) continue;
    if (m.type === 'alloc' || m.type === 'arp') return null;
    const d = m.type === 'drummap' ? m : m.type === 'steps' ? trackDrumMap(v, m.id) : null;
    if (m.type === 'steps' && !d) return null;
    map ??= d;
  }
  return map;
}

/** what a key of the FM-1 plays while the keys reach `map`: a row's note (black keys 1..8), its own note (the map repeats
 * its rows), or nothing */
export function drumKeyNote(map: ModuleInst, note: number, octave: number): number | null {
  const b = blackKey(note - KEY0 - 12 * octave);
  if (b >= 0 && b < 8) return Math.max(0, Math.min(127, Math.round(map.params[`n${b + 1}`] ?? note)));
  return Math.round(map.params.repeat ?? 0) >= 1 ? note : null;
}

/** the FM-1's key notes in sandbox mode: each note-on turned into what the FM-1 would play for its key, and its note-off
 * ending that */
export class SandboxKeys {
  /** what each key note held now plays (null: nothing) */
  private playing = new Map<number, number | null>();

  /** a key note this holds (its note-off must come here, also after sandbox mode ended) */
  holds(note: number): boolean { return this.playing.has(note); }

  /** `p`, `armed`: the editor's patch and armed devices; `octave`: the FM-1's */
  route(msg: HostMsg, p: Patch, armed: Iterable<DeviceKey>, octave: number): HostMsg[] {
    if (msg.t === 'panic') this.playing.clear();
    if (msg.t === 'off') {
      if (!this.playing.has(msg.note)) return [msg];
      const n = this.playing.get(msg.note)!;
      this.playing.delete(msg.note);
      return n === null ? [] : [{ t: 'off', note: n }];
    }
    if (msg.t !== 'on') return [msg];
    const map = keysDrumMap(p, armed);
    const n = map ? drumKeyNote(map, msg.note, octave) : msg.note;
    this.playing.set(msg.note, n);
    return n === null ? [] : [{ ...msg, note: n }];
  }
}
