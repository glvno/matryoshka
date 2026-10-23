// SPDX-License-Identifier: GPL-3.0-only
// A connected FM-1 drives the web app through plain MIDI, whatever firmware it runs (#120). The firmware is told by
// M-VAVE's identity handshake (flasher/fm1ota.js: FM-1_015 stock, FM-1_8xx M-VAVE Open, FM-1_9XY Felucca or Sloop (the
// same identity), FM-1_7XY ours) or picked by hand; a profile per firmware turns its messages into panel inputs, which the
// page runs through Matryoshka's own panel logic (the firmware UI's WebAssembly copy, fm1-ui.ts) and the editor. What each
// firmware sends: the 2026-10-19 survey in the old session log (`git show 057c70d:docs/NOTES.md`) and Matryoshka's map in docs/ARCHITECTURE.md "MIDI out map".

import { BUTTONS, ENCODERS } from './fm1-ui';

export type Firmware = 'matryoshka' | 'mvave' | 'felucca' | 'baudgirl';

/** what one MIDI message means on the panel */
export type PanelInput =
  | { t: 'button'; id: number; down: boolean }          // a button by matrix id (fm1-ui.ts BUTTONS)
  | { t: 'enc'; n: number; clicks: number }             // an encoder turned (fm1-ui.ts ENCODERS)
  | { t: 'knob'; k: number; u: number }                 // K1..K4 at a position of its row's range, 0..1
  | { t: 'note'; note: number; vel: number; on: boolean }
  | { t: 'master'; v: number }                          // MASTER, 0..1
  | { t: 'mod'; v: number }                             // the modulation wheel (CC 1), 0..1
  | { t: 'transport'; run: boolean };

/** a panel control a profile can report (for the FM-1 tab: the others are greyed) */
export type Control = 'keys' | 'master' | 'select' | 'algo' | 'preset' | 'k1' | 'k2' | 'k3' | 'k4' | `b${number}`;

export interface Profile {
  firmware: Firmware;
  name: string;
  /** the controls this firmware reports over MIDI */
  reports: ReadonlySet<Control>;
  translate(data: ArrayLike<number>): PanelInput[];
}

/** the firmware an identity string names, null when it is none of these (Baud Girl has no known identity: by hand) */
export function firmwareOf(identity: string | null | undefined): Firmware | null {
  const m = /^FM-1_(\d)(\d\d)$/.exec(identity ?? '');
  if (!m) return null;
  return m[1] === '7' ? 'matryoshka' : m[1] === '9' ? 'felucca' : m[1] === '8' || m[1] === '0' ? 'mvave' : null;
}

const notes = (d: ArrayLike<number>): PanelInput[] => {
  const st = d[0] & 0xf0;
  if ((st === 0x90 || st === 0x80) && d.length >= 3) return [{ t: 'note', note: d[1], vel: d[2] / 127, on: st === 0x90 && d[2] > 0 }];
  return [];
};
const cc = (d: ArrayLike<number>): [number, number] | null => ((d[0] & 0xf0) === 0xb0 && d.length >= 3 ? [d[1], d[2]] : null);
/** a relative CC (two's complement: 1..63 up, 127..65 down) as clicks */
export const relClicks = (v: number): number => (v >= 64 ? v - 128 : v);

/** Matryoshka's MIDI out (#115): firmware/src/panel.c BTN_CC (matrix id -> CC), ENC_CC, CC 7 */
const BTN_CC = [92, 93, 80, 81, 82, 83, 84, 85, 87, 88, 86, 89, 91, 90];
const ALL_BUTTONS = Object.values(BUTTONS).map((id) => `b${id}` as Control);

const matryoshka: Profile = {
  firmware: 'matryoshka',
  name: 'Matryoshka',
  reports: new Set<Control>(['keys', 'master', 'select', 'algo', 'preset', 'k1', 'k2', 'k3', 'k4', ...ALL_BUTTONS]),
  translate(d) {
    const c = cc(d);
    if (!c) return notes(d);   // (Start / Stop come with PLAY's own CC: not twice)
    const [n, v] = c;
    const id = BTN_CC.indexOf(n);
    if (id >= 0) return [{ t: 'button', id, down: v >= 64 }];
    if (n === 20) return [{ t: 'enc', n: ENCODERS.select, clicks: relClicks(v) }];
    if (n === 21) return [{ t: 'enc', n: ENCODERS.algo, clicks: relClicks(v) }];
    if (n === 23) return [{ t: 'enc', n: ENCODERS.preset, clicks: relClicks(v) }];
    if (n >= 16 && n <= 19) return [{ t: 'knob', k: n - 16, u: v / 127 }];
    if (n === 7) return [{ t: 'master', v: v / 127 }];
    return [];
  },
};

/** M-VAVE's own firmware (Open V14 source; stock V15 assumed the same): the keys only */
const mvave: Profile = { firmware: 'mvave', name: 'M-VAVE', reports: new Set<Control>(['keys']), translate: notes };

/** Felucca, and Sloop (the same identity): keys, CC 1 from SELECT in Felucca's MODW mode, Sloop's Start / Stop */
const felucca: Profile = {
  firmware: 'felucca',
  name: 'Felucca / Sloop',
  reports: new Set<Control>(['keys']),
  translate(d) {
    if (d[0] === 0xfa || d[0] === 0xfb) return [{ t: 'transport', run: true }];
    if (d[0] === 0xfc) return [{ t: 'transport', run: false }];
    const c = cc(d);
    if (c?.[0] === 1) return [{ t: 'mod', v: c[1] / 127 }];
    return notes(d);
  },
};

/** Baud Girl: keys, K1..K4 as CC 74 / 71 / 73 / 72 in its CC knob bank */
const BAUD_KNOBS = [74, 71, 73, 72];
const baudgirl: Profile = {
  firmware: 'baudgirl',
  name: 'Baud Girl',
  reports: new Set<Control>(['keys', 'k1', 'k2', 'k3', 'k4']),
  translate(d) {
    const c = cc(d);
    const k = c ? BAUD_KNOBS.indexOf(c[0]) : -1;
    if (c && k >= 0) return [{ t: 'knob', k, u: c[1] / 127 }];
    return notes(d);
  },
};

export const PROFILES: Record<Firmware, Profile> = { matryoshka, mvave, felucca, baudgirl };
