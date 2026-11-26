// SPDX-License-Identifier: GPL-3.0-only
// The FM-1's own keys in sandbox mode (docs/ledger/link-and-midi.md D-467): the FM-1 does not hold the patch, so it sends
// its keys as plain notes (docs/ledger/device-ui.md D-232), and the editor plays them as the FM-1 plays its keys. While
// the keys reach a Harmonizer, its Side layout (docs/ledger/modules.md D-781, #1053): the FM-1's seven lowest keys are its
// chord buttons at any octave, every other key a root (under the split too). Else (docs/ledger/steps.md D-520) while the
// keys reach a Drum map, black keys 1..8 play the first 8 of the rows of every Drum map they reach (drum-rows.ts) at any
// octave, the white keys nothing, or their own note when the first map repeats its rows (D-430). The FM-1 in sandbox mode
// does not hold the patch, so it has no banks of rows: its OCT stays the octave. This is firmware/src/panel.c panel_key,
// engine.c eng_keys_harm and eng_keys_rows on the editor's patch. No DOM here: main.ts wires it.
import { armView, keepArmed, type DeviceKey } from './arm';
import { HARM_INV_KEYS, HARM_ZONE } from './harmonizer';
import { keyReach } from './key-routing';
import { DEFS } from './modules';
import type { ModuleDef, ModuleInst, Patch } from './patch';
import { drumRowList, trackDrumMaps, type DrumRow } from './drum-rows';
import { trackDrumMap } from './poly';
import type { HostMsg } from './worklet';

/** the FM-1's lowest key (F3) at octave 0, and its keybed's 27 keys */
const KEY0 = 53;
const KEYS = 27;
/** a key's place among the black keys from F#3 (firmware/src/seq_ui.c seq_black), -1 a white key */
const BLACK = [-1, 0, -1, 1, -1, 2, -1, -1, 3, -1, 4, -1];
export const blackKey = (n: number): number => (n >= 0 && n < KEYS && BLACK[n % 12] >= 0 ? Math.floor(n / 12) * 5 + BLACK[n % 12] : -1);

/** the Drum maps the FM-1's keys reach (engine.c keys_maps): of what hears Main's keys (the armed set, else what is cabled
 * to them) at least one Drum map, on the keys or behind a track, and nothing that plays them as notes (a Voicing, the
 * shared keyboard with Main's pitch / gate / velocity cabled, an Arpeggiator on Main's keys, a track into no Drum map).
 * The first such map in module order, every one, and the armed view they are in; null none */
function keysDrum(p: Patch, armed: Iterable<DeviceKey>, defs: Record<string, ModuleDef>): { map: ModuleInst; maps: ModuleInst[]; view: Patch } | null {
  const list = keepArmed(p, armed, defs);
  const v = armView(p, list, defs);
  const main = v.modules.find((m) => m.type === 'fm1');
  if (!main) return null;
  if (!list.length && v.cables.some((c) => c.from.module === main.id && ['pitch', 'gate', 'vel'].includes(c.from.port))) return null;
  const heard = new Set(v.cables.filter((c) => c.from.module === main.id && c.from.port === 'keys').map((c) => c.to.module));
  let map: ModuleInst | null = null;
  const maps: ModuleInst[] = [];
  for (const m of v.modules) {
    if (!heard.has(m.id)) continue;
    if (m.type === 'alloc' || m.type === 'arp' || m.type === 'harm') return null;
    const d = m.type === 'drummap' ? m : m.type === 'steps' ? trackDrumMap(v, m.id) : null;
    if (m.type === 'steps' && !d) return null;
    if (m.type === 'drummap') maps.push(m);
    if (m.type === 'steps') maps.push(...trackDrumMaps(v, m.id));
    map ??= d;
  }
  return map && { map, maps, view: v };
}

/** the Drum map the FM-1's keys reach (engine.c eng_keys_drummap): the first in module order, null none */
export function keysDrumMap(p: Patch, armed: Iterable<DeviceKey> = [], defs: Record<string, ModuleDef> = DEFS): ModuleInst | null {
  return keysDrum(p, armed, defs)?.map ?? null;
}

/** the rows of every Drum map the FM-1's keys reach, as one list (engine.c eng_keys_rows); [] none */
export function keysDrumRows(p: Patch, armed: Iterable<DeviceKey> = [], defs: Record<string, ModuleDef> = DEFS): DrumRow[] {
  const k = keysDrum(p, armed, defs);
  return k ? drumRowList(k.view, k.maps) : [];
}

/** the Harmonizer the FM-1's keys reach (engine.c eng_keys_harm): one that hears Main's keys (the armed set, else what is
 * cabled to them, through a track or not), is not bypassed and plays a Voicing. The first in module order, null none */
export function keysHarm(p: Patch, armed: Iterable<DeviceKey> = [], defs: Record<string, ModuleDef> = DEFS): ModuleInst | null {
  const v = armView(p, keepArmed(p, armed, defs), defs);
  const main = v.modules.find((m) => m.type === 'fm1');
  if (!main) return null;
  const heard = keyReach(v, main.id);
  const type = new Map(v.modules.map((m) => [m.id, m.type]));
  return v.modules.find((m) => m.type === 'harm' && !m.bypass && heard.has(m.id) && [...keyReach(v, m.id)].some((id) => type.get(id) === 'alloc')) ?? null;
}

/** what a key of the FM-1 plays while the keys reach `map` (the first Drum map) and these rows: black keys 1..8 the first 8
 * rows (sandbox mode has no banks), its own note when the map repeats its rows, or nothing */
export function drumKeyNote(map: ModuleInst, rows: readonly DrumRow[], note: number, octave: number): number | null {
  const b = blackKey(note - KEY0 - 12 * octave);
  if (b >= 0 && b < 8 && b < rows.length) return rows[b].note;
  return Math.round(map.params.repeat ?? 0) >= 1 ? note : null;
}

/** the FM-1's key notes in sandbox mode: each note-on turned into what the FM-1 would play for its key (a note, a
 * Harmonizer's root or chord button, nothing), and its note-off ending that */
export class SandboxKeys {
  /** what ends what each key note held now plays */
  private playing = new Map<number, HostMsg[]>();

  /** a key note this holds (its note-off must come here, also after sandbox mode ended) */
  holds(note: number): boolean { return this.playing.has(note); }

  /** `p`, `armed`: the editor's patch and armed devices; `octave`: the FM-1's */
  route(msg: HostMsg, p: Patch, armed: Iterable<DeviceKey>, octave: number): HostMsg[] {
    if (msg.t === 'panic') this.playing.clear();
    if (msg.t === 'off') {
      const off = this.playing.get(msg.note);
      if (!off) return [msg];
      this.playing.delete(msg.note);
      return off;
    }
    if (msg.t !== 'on') return [msg];
    const key = msg.note - KEY0 - 12 * octave;
    const harm = keysHarm(p, armed);
    if (harm) {
      // the seven lowest keys its chord buttons, the three highest its inversion keys while its row is on (panel.c chord_button_of)
      const inv = Math.round(harm.params.invkeys ?? 0) === 1 && key >= KEYS - HARM_INV_KEYS && key < KEYS;
      const button = key >= 0 && key < HARM_ZONE ? key : inv ? key - (KEYS - HARM_INV_KEYS) + HARM_ZONE : -1;
      this.playing.set(msg.note, [button >= 0 ? { t: 'chord', button, down: false } : { t: 'off', note: msg.note, root: true }]);
      return [button >= 0 ? { t: 'chord', button, down: true } : { ...msg, root: true }];
    }
    const map = keysDrumMap(p, armed);
    const n = map ? drumKeyNote(map, keysDrumRows(p, armed), msg.note, octave) : msg.note;
    this.playing.set(msg.note, n === null ? [] : [{ t: 'off', note: n }]);
    return n === null ? [] : [{ ...msg, note: n }];
  }
}
