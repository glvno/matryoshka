// SPDX-License-Identifier: GPL-3.0-only
// The DX7 module's voice as a patch keeps it (#1338): the DX7's own 128-byte packed voice (a 32-voice bulk dump's entry),
// as 256 hex characters in ModuleInst.voice and as ModuleDef.data bytes in the binary record.
import { DX7_VOICE, dx7Clamp, dx7Pack, dx7Unpack } from './dx7';

/** the DX7's init voice, packed: algorithm 1, operator 1 at output level 99 and the others at 0, every envelope at
 * rates 99 and levels 99 99 99 0, ratios 1.00, the pitch envelope flat at 50, oscillator key sync on, "INIT VOICE" */
export const DX7_INIT_VOICE: Uint8Array = (() => {
  const b = new Uint8Array(DX7_VOICE);
  for (let op = 0; op < 6; op++) {
    const d = op * 17;
    for (let i = 0; i < 7; i++) b[d + i] = 99;
    b[d + 8] = 39;
    b[d + 12] = 7 << 3;
    b[d + 14] = op === 5 ? 99 : 0;
    b[d + 15] = 1 << 1;
  }
  for (let i = 102; i < 106; i++) b[i] = 99;
  for (let i = 106; i < 110; i++) b[i] = 50;
  b[111] = 1 << 3;
  b[112] = 35;
  b[116] = (3 << 4) | 1;
  b[117] = 24;
  b.set([...'INIT VOICE'].map((c) => c.charCodeAt(0)), 118);
  return b;
})();

/** a packed voice put right: every value in the DX7's range, the unused bits clear (unpacked, clamped, packed again) */
export function canonicalVoice(b: ArrayLike<number>): Uint8Array {
  const u = dx7Unpack(b);
  dx7Clamp(u);
  return dx7Pack(u);
}

/** a voice's bytes from ModuleInst.voice (absent or not 256 hex characters: the init voice) */
export function voiceBytes(hex: string | undefined): Uint8Array {
  if (typeof hex !== 'string' || !/^[0-9a-f]{256}$/i.test(hex)) return DX7_INIT_VOICE.slice();
  return Uint8Array.from({ length: DX7_VOICE }, (_, i) => parseInt(hex.slice(2 * i, 2 * i + 2), 16));
}

/** a voice as ModuleInst.voice keeps it, put right (canonicalVoice) */
export const voiceHex = (b: ArrayLike<number>): string => Array.from(canonicalVoice(b), (x) => x.toString(16).padStart(2, '0')).join('');

/** the voice's name, its last 10 bytes (trailing spaces dropped) */
export const voiceName = (b: ArrayLike<number>): string =>
  String.fromCharCode(...Array.from({ length: 10 }, (_, i) => b[118 + i] & 0x7f).map((c) => (c >= 32 && c < 127 ? c : 32))).trimEnd();
