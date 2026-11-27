// SPDX-License-Identifier: GPL-3.0-only
// The DX7's own SysEx files (#1338): a single voice (VCED, format 0: F0 43 0n 00 01 1B, 155 bytes, checksum, F7) and a
// 32-voice bank (VMEM, format 9: F0 43 0n 09 20 00, 32 x 128 packed bytes, checksum, F7), as a DX7, Dexed and the voice
// libraries write them. The module keeps packed voices (dx7-voice.ts); a single voice goes through msfa's unpacked form.
import { DX7_UNPACKED, DX7_VOICE, dx7Pack, dx7Unpack } from './dx7';
import { canonicalVoice } from './dx7-voice';

const VCED = 155;
const BANK = 32;
/** the DX7's checksum: the low 7 bits of minus the data's sum */
const checksum = (d: ArrayLike<number>): number => {
  let s = 0;
  for (let i = 0; i < d.length; i++) s += d[i];
  return -s & 0x7f;
};

/** what a SysEx file held: its packed voices (1 or 32), and whether every checksum matched (a mismatch is read anyway, as
 *  Dexed does, and said) */
export interface Dx7Sysex { voices: Uint8Array[]; bank: boolean; checksumOk: boolean }

/**
 * The DX7 voices in a SysEx file: the first single voice or bank message in it (any MIDI channel), null when there is
 * none. Every voice comes back put right (canonicalVoice: values in the DX7's range, unused bits clear).
 */
export function parseDx7Sysex(bytes: ArrayLike<number>): Dx7Sysex | null {
  for (let i = 0; i + 6 <= bytes.length; i++) {
    if (bytes[i] !== 0xf0 || bytes[i + 1] !== 0x43 || (bytes[i + 2] & 0xf0) !== 0) continue;
    const f = bytes[i + 3], hi = bytes[i + 4], lo = bytes[i + 5], n = (hi << 7) | lo, at = i + 6;
    if (at + n + 2 > bytes.length) continue;
    const data = Array.from({ length: n }, (_, k) => bytes[at + k] & 0x7f);
    const ok = checksum(data) === (bytes[at + n] & 0x7f);
    if (f === 0 && n === VCED) {
      const u = new Uint8Array(DX7_UNPACKED);
      u.set(data);
      u[155] = 0x3f;
      return { voices: [canonicalVoice(dx7Pack(u))], bank: false, checksumOk: ok };
    }
    if (f === 9 && n === BANK * DX7_VOICE)
      return { voices: Array.from({ length: BANK }, (_, v) => canonicalVoice(data.slice(v * DX7_VOICE, (v + 1) * DX7_VOICE))), bank: true, checksumOk: ok };
  }
  return null;
}

/** a single voice dump of a packed voice (channel 1) */
export function singleSysex(packed: ArrayLike<number>): Uint8Array {
  const d = Array.from(dx7Unpack(canonicalVoice(packed)).subarray(0, VCED));
  return Uint8Array.from([0xf0, 0x43, 0x00, 0x00, 0x01, 0x1b, ...d, checksum(d), 0xf7]);
}

/** a 32-voice bank dump (channel 1); fewer voices are filled up with `fill` (the init voice, as a DX7's empty slot) */
export function bankSysex(voices: readonly ArrayLike<number>[], fill: ArrayLike<number>): Uint8Array {
  const d: number[] = [];
  for (let v = 0; v < BANK; v++) d.push(...canonicalVoice(voices[v] ?? fill));
  return Uint8Array.from([0xf0, 0x43, 0x00, 0x09, 0x20, 0x00, ...d, checksum(d), 0xf7]);
}
