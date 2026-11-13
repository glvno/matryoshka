// SPDX-License-Identifier: GPL-3.0-only
// SysEx protocol between the editor and the Matryoshka firmware (firmware/src/proto.c). Pure functions.
//
//   F0 7D 4D 31 <cmd> <payload packed to 7-bit> F7
//
// 7D = non-commercial manufacturer id, 4D 31 = "M1". The payload is a byte string packed LSB first, 7 bits per
// wire byte (the same packing as Felucca's update protocol); n bytes take ceil(8 n / 7) wire bytes.
//
// host -> device
//   01 HELLO    -                                    device answers INFO
//   10 CHUNK    seq u8, offset u16, total u16, data  a piece of the binary patch (patchbin.ts), in order; ACK each
//   11 COMMIT   total u16, crc16 u16                 check the assembled patch and switch to it; ACK
//   12 STORE    -                                    write the current patch to flash; ACK
//   13 SLOT     slot u8, name 20 bytes (ASCII, zero padded), total u16, crc16 u16   the uploaded chunks into preset slot n (0..31) of the
//                                                    flash bank, without loading them; ACK (3 = not a valid patch)
//   14 SLOT_ERASE  slot u8                           empty a slot; ACK
//   15 SLOT_INFO   slot u8                           device answers SLOT_INFO (42)
//   20 PARAM    module u8, param u8, value i32       live parameter change (Q16.16), no reply
//   21 ATT      module u8, input u8 (0 p1, 1 p2), value i32   live attenuverter change (Q16.16, -2..2), no reply
//   22 BYPASS   module u8, on u8 (0/1)               bypass a module (its outputs carry its through input or silence), no reply
//   23 RANGE    module u8, pin u8 (0 p1, 1 p2), param u8, on u8, low u8, high u8   a macro range of the pin on the parameter
//                                                    (ends 0..255 of the range, patchbin.ts), on 0 removes it, on bit 1
//                                                    reads the pin's -1..1 across the ends (bipolar, #526); no reply
//   25 TRANSPORT  run u8 (0 stop, 1 run)            the transport (PLAY: the Main module's run output and clock); no reply.
//                                                    Offered by firmware whose INFO has feature bit 1. (24 was the arpeggiator's
//                                                    settings until the Arpeggiator module replaced it: feature bit 0, retired.)
//   26 STEP, 28 STEPVAL: a step's byte, a step's note / velocity (feature bits 2 and 3), retired with patch format 31 (#133)
//   27 MUTE     module u8, on u8                     mute / unmute a Steps module (not saved); no reply. Feature bit 2.
//   2A TRACK    module u8, n u8, n u32 LE notes, [pattern u8]   a Steps module's notes, all of them (track.ts noteWord,
//                                                    sorted, at most TRACK_NOTES_MAX), of that pattern (0-based; format 48,
//                                                    without it: the one the track plays); no reply. Feature bit 5.
//   36 PATTERN  pattern u8, song u8                  the patch's pattern (0-based) and the song playing (0 none): each track
//                                                    takes them at the end of its pass (stopped: at once), into the running
//                                                    patch; no reply. Format 48 (INFO's highest readable format)
//   37 SONG     song u8 (0-based), n u8, n (pattern u8, shift i8)   a song's entries, into the running patch; no reply.
//                                                    Format 48
//   38 TEMPO    mode u8 (0 global, 1 patch), bpm u16 (0: the global tempo stays)   GLO > PANEL > TEMPO and the global
//                                                    tempo (D-907, tempo.ts); no reply. Feature bit 16
//   39 ARMS     ARM_WORDS u32 (2 before feature bit 21)   the editor's armed set (#191), a mask over the module indices of
//                                                    the patch it sent (arm.ts armMask; word k: modules 32k..32k+31): the FM-1
//                                                    arms the same, so its panel's keys and the editor's notes play the same
//                                                    devices; no reply, no ARMS_NOW back. Feature bit 20; the four words of
//                                                    modules 0..127: feature bit 21 (#721), older firmware reads the first two
//   29 FOCUS    device u8, page u8                   show this device page (indices into the binary's device pages section,
//                                                    pages.ts) and put it on K1..K4; no reply. Feature bit 4.
//   2C LIVE     [paused u8]                          every LIVE_MS while the editor's Live is on: the FM-1 plays the
//                                                    editor's patch, so PRESET and program change load no slot until
//                                                    5 s after the last one; no reply. Feature bit 6. paused 1 (#200): the
//                                                    editor's patch is a sandbox patch (over the FM-1's budget) and not
//                                                    sent: PRESET waits still. With feature bit 8 it is sandbox mode: the
//                                                    FM-1 mutes its own sound and shows the editor's page (SANDBOX); older
//                                                    firmware says EDITOR PATCH TOO BIG
//   31 SANDBOX  rows u8, index u8, count u8, patch 20, device 12, page 16, 4 x (label 12, value 10, unit 6, position u8,
//               steps u8), then devices u8, device u8, groups u8, group u8, pages u8, page u8 (the header's dashes and
//               bars: counts and places from 0), tempo u16 (bpm, 0 none), flags u8 (bit0 unsaved edits), armed u32 (bit d:
//               device d)                            the editor's device page in sandbox mode, sent when it changes; no reply.
//                                                    Firmware before 1.8 reads the fields up to the rows only (D-468)
//                                                    rows: bit k row k is there; index / count: the page among its device's;
//                                                    page: its title as the FM-1's chips show it; position 0..255 of the
//                                                    row's range; steps 0 continuous, n: n choices. Names zero padded
//                                                    ASCII. Feature bit 8 (firmware/src/sandbox_msg.h)
//   2D PRESETS  (none)                               the FM-1's user presets (#195): one PRESET (4C) per preset. Feature bit 7.
//   2E PRESET_GET  structure u32, name 16 bytes      device answers PRESET_DATA (4D)
//   2F PRESET_PUT  structure u32, name 16 bytes, n u8, n i32 values (Q16, canonical row order)   store it (over one of
//                                                    that structure and name); ACK (7 = full). n at most 176 with
//                                                    feature bit 17 (two store slots, #485), else 88
//   30 PRESET_DEL  structure u32, name 16 bytes      delete it; ACK (8 = no such preset)
//   32 TEST_KEY    id u8, down u8                    the device test mode (#291, feature bit 9; the editor never sends it):
//                                                    a panel key held / let go as a hand would (0..13 the buttons, 14..40 the
//                                                    keys from F3); ACK (seq = id; 1 = no such key). For 10 s after a test
//                                                    key or turn the FM-1 refuses UPDATE MODE and FACTORY RESET
//   33 TEST_TURN   encoder u8, clicks i8             an encoder turned (0 SELECT, 1 ALGO, 2..5 K1..K4, 6 PRESET); ACK
//   34 TEST_SCREEN (none)                            device answers SCREEN (50): the head, then one per text on the LCD
//   35 TEST_PEAK   (none)                            device answers PEAK (51): the output's peak since the last TEST_PEAK
// device -> host
//   42 SLOT    slot u8, used u8 (0/1), length u16, name 20 bytes
//   43 SLOT_NOW  slot u8, name 20 bytes                unasked: the slot the FM-1 plays now (a patch from its panel, program
//                                                    change, boot or SAVE). Its knobs and patch buttons arrive as USB MIDI CC
//                                                    (16..21, 80..86) when MENU > MIDI OUT is on.
//   44 STEP, 46 STEPVAL: retired with format 31 (#133)
//   45 MUTE     module u8, on u8                      unasked: a track muted / unmuted on the FM-1 (SEQ held + a black key)
//   49 TRACK_NOW  module u8, n u8, n u32 LE notes, [pattern u8]   unasked: a track's notes after an edit on the FM-1's SEQ
//                                                    page (a step, its values, a hit recorded with REC), of that pattern
//                                                    (format 48: the one the track plays)
//   52 PATTERN_NOW  pattern u8, song u8               unasked: the patch's pattern / song as the FM-1 chose them (PRESET on
//                                                    the SEQ page, the SONG page's K4 / ALGO)
//   53 SONG_NOW  song u8, n u8, n (pattern u8, shift i8)   unasked: a song's entries after an edit on the SONG page
//   54 ARMS_NOW  ARM_WORDS u32 (2 before feature bit 21)   unasked: the armed set after it changed on the FM-1 (#191: SEL,
//                                                    REC held + a black key, the SEQ page; a slot loaded from the panel sends 0,
//                                                    wired): a mask over the module indices of the patch the FM-1 plays (arm.ts
//                                                    armedFromMask). The editor follows (an editor before #721 reads the first
//                                                    two words); older firmware never sends it
//   55 TEMPO_NOW  mode u8 (0 global, 1 patch), bpm u16 (0: not known yet)   after INFO (the answer to HELLO), and unasked
//                                                    when the FM-1 changed the setting or the global tempo (its menu, PLAY
//                                                    held + PRESET, Main's tempo row while global). Feature bit 16
//   57 KEYS_NOW  key u8 (0 = F3; bit 7 pressed), keys u32 (held after it, bit n key n), held u16 (the buttons held then,
//               matrix ids)                       unasked (#549, feature bit 18): every key edge the FM-1's panel takes,
//                                                    while MENU > MIDI OUT is on and the editor said HELLO since power-on.
//                                                    The editor's copy of the panel logic takes the same edge
//   58 GUIDE_NOW  state u8 (controls.ts HELP_STATES), page u8, flags u8 (bit0 step record, bit1 a live take, bit2 REC
//               records, bit3 sandbox mode, bit4 the controls sheet shows, bit5 the quick start, bit6 the sheet's
//               EVERYWHERE tab, bit7 a step held), device u8, device page u8, track u8, menu tab u8, held u16 (buttons),
//               conditions u16 (bit c: controls.ts CONDITIONS[c - 1] holds), sheet row u8, octave i8, step record's
//               cursor u8                         unasked (#549, #554, feature bit 18): the panel's state after HELLO and
//                                                    whenever it changed (firmware/src/help_ui.c guide_state)
//   47 PARAM_NOW  module u8, param u8, value i32      unasked: a parameter turned on the FM-1 (K1..K4 on a device page)
//   48 FOCUS_NOW  device u8, page u8                  unasked: the device page the FM-1 shows now (SELECT / ALGO / HOME)
//   4C PRESET   index u8, count u8, structure u32, name 16 bytes, n u8   one of the FM-1's user presets (count 0: none)
//   4D PRESET_DATA  structure u32, name 16 bytes, n u8 (0xFF: none), n i32 values (n up to 176 with feature bit 17)
//   4E PRESET_STORED  structure u32, name 16 bytes  unasked: a preset stored on the FM-1 (ENV held + SAVE)
//   50 SCREEN   k u8 = 0xFF, count u8, page u8, flags u8 (bit0 sandbox mode, bit1 the boot screen), [buttons u16: Main's
//               patch buttons as their jacks stand, bit 0 FX .. bit 6 ARP; #368, absent from older firmware]; then k = 0..count-1:
//               x u8, y u8, w u8, h u8, n u8, n characters   a text on the LCD and its box (firmware/src/screen_text.h)
//   51 PEAK     peak u16 (16 bit, before MASTER: as at its default), flags u8 (bit0 the engine runs, bit1 the sound is muted:
//               sandbox mode, bit2 MASTER is all the way down)
//   5A PATTERN_ORIGIN module u8, pattern u8, identity u32 LE (unsigned). INFO bit 23 gates reliance.
//      Ordinary records: module 0..127 must map to a transmitted Steps module; pattern 0..63; identity 0 clears.
//      Module 255: pattern 0 begins a snapshot, pattern 1 ends it; u32 holds the same expected record count (0..1024)
//      in both delimiters. A completed count-zero snapshot clears all origins. Duplicate owners, invalid fields,
//      truncation, count mismatch or interrupted snapshots discard all pending/previous ownership. Patch switches,
//      queued uploads and reconnects invalidate it too; uploads accept a new snapshot only after COMMIT succeeds.
//      HELLO and successful COMMIT send a complete snapshot. Panel factory/USER selections emit changed records.
//   41 INFO     version, max modules, max cables, flags (bit0 flash ok, bit1 patch loaded, bit2 MENU > MIDI OUT on: with
//               feature bit 8, bit3 GLO > SYSTEM > EDITOR at IGNORE: with feature bit 19, #702), delay lines, [features: bit1 TRANSPORT, bit2 MUTE, bit4 FOCUS / PARAM_NOW / FOCUS_NOW,
//               bit5 TRACK / TRACK_NOW, bit6 LIVE, bit7 presets], [features 8..15: bit8 sandbox mode, bit9 the device
//               test mode, bit10 TEST_PEAK reads before MASTER, bits11..15 read patch formats35..39],
//               [minimum readable patch format, maximum readable patch format], [firmware major, minor, patch:
//               0.0.0 a dev or CI build; #216, absent from firmware before 1.8],
//               [features 16..23: bit16 TEMPO / TEMPO_NOW, bit17 a preset carries up to 176 values, bit18 KEYS_NOW /
//               GUIDE_NOW, bit19 flags bit3 says EDITOR, bit20 ARMS, bit21 ARMS wide, bit22 DEVICE_SETTINGS, bit23 PATTERN_ORIGIN],
//               [byte13 allocation rule: 0 separate signal buffers, 1 physical lifetime buffers; unknown/missing means 0]. Also unasked
//               after a LIVE when MIDI OUT changed since the editor last heard (feature bit 8), and when EDITOR changed after
//               a HELLO (feature bit 19)
//   40 ACK      command, seq, status, aux            status 0 ok, 1 bad offset/size, 2 CRC, 3 load error (aux = code),
//                                                    4 flash error, 5 unknown command, 6 nothing to store

import { ARM_WORDS, type Range } from './patch';
import { noteWord, PATTERNS_MAX, SHIFT_MAX, SONG_LEN_MAX, SONGS_MAX, TRACK_NOTES_MAX, wordNote, type SongEntry, type StepNote } from './track';

export const PREFIX = [0x7d, 0x4d, 0x31];
export const CMD = { hello: 0x01, chunk: 0x10, commit: 0x11, store: 0x12, param: 0x20, att: 0x21, bypass: 0x22, range: 0x23, transport: 0x25, mute: 0x27, focus: 0x29, track: 0x2a, diag: 0x2b, live: 0x2c, slot: 0x13, slotErase: 0x14, slotInfo: 0x15, ack: 0x40, info: 0x41, slotReply: 0x42, slotNow: 0x43, muteNow: 0x45, paramNow: 0x47, focusNow: 0x48, trackNow: 0x49, diagReply: 0x4b, presets: 0x2d, presetGet: 0x2e, presetPut: 0x2f, presetDel: 0x30, sandbox: 0x31, preset: 0x4c, presetData: 0x4d, presetStored: 0x4e, testKey: 0x32, testTurn: 0x33, testScreen: 0x34, testPeak: 0x35, screen: 0x50, peak: 0x51, pattern: 0x36, song: 0x37, patternNow: 0x52, songNow: 0x53, armsNow: 0x54, arms: 0x39, tempo: 0x38, tempoNow: 0x55, locksNow: 0x56, keysNow: 0x57, guideNow: 0x58, deviceSettings: 0x3a, deviceSettingsReply: 0x59, originNow: 0x5a } as const; // diag: bring-up diagnostics (tools/m1_link.py diag; the editor does not use it)
export const PROTO_VERSION = 1;
export const CHUNK_BYTES = 384;
export const STATUS_TEXT = ['ok', 'bad offset or size', 'checksum mismatch', 'the firmware refused the patch', 'flash error', 'unknown command', 'nothing to store', 'the preset store is full', 'no such preset'];

export function pack7(bytes: ArrayLike<number>): number[] {
  const out: number[] = [];
  let acc = 0;
  let nb = 0;
  for (let i = 0; i < bytes.length; i++) {
    acc |= (bytes[i] & 0xff) << nb;
    nb += 8;
    while (nb >= 7) {
      out.push(acc & 0x7f);
      acc >>>= 7;
      nb -= 7;
    }
  }
  if (nb > 0) out.push(acc & 0x7f);
  return out;
}

export function unpack7(septets: ArrayLike<number>): number[] {
  const out: number[] = [];
  let acc = 0;
  let nb = 0;
  for (let i = 0; i < septets.length; i++) {
    acc |= (septets[i] & 0x7f) << nb;
    nb += 7;
    if (nb >= 8) {
      out.push(acc & 0xff);
      acc >>>= 8;
      nb -= 8;
    }
  }
  return out;
}

/** CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF) */
export function crc16(data: ArrayLike<number>): number {
  let c = 0xffff;
  for (let i = 0; i < data.length; i++) {
    c ^= (data[i] & 0xff) << 8;
    for (let k = 0; k < 8; k++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff;
  }
  return c;
}

export function frame(cmd: number, payload: ArrayLike<number> = []): Uint8Array {
  return Uint8Array.from([0xf0, ...PREFIX, cmd, ...pack7(payload), 0xf7]);
}

export interface Parsed {
  cmd: number;
  payload: number[];
}

/** A complete SysEx message (F0 .. F7) of ours, or null. */
export function parse(data: ArrayLike<number>): Parsed | null {
  const n = data.length;
  if (n < 6 || data[0] !== 0xf0 || data[n - 1] !== 0xf7) return null;
  for (let i = 0; i < 3; i++) if (data[1 + i] !== PREFIX[i]) return null;
  return { cmd: data[4], payload: unpack7(Array.from(data).slice(5, n - 1)) };
}

export const helloFrame = (): Uint8Array => frame(CMD.hello);
export const storeFrame = (): Uint8Array => frame(CMD.store);
export const commitFrame = (patch: Uint8Array): Uint8Array => {
  const crc = crc16(patch);
  return frame(CMD.commit, [patch.length & 0xff, patch.length >> 8, crc & 0xff, crc >> 8]);
};
export const chunkFrames = (patch: Uint8Array, size = CHUNK_BYTES): Uint8Array[] => {
  const out: Uint8Array[] = [];
  for (let off = 0, seq = 0; off < patch.length; off += size, seq = (seq + 1) & 0x7f) {
    const part = patch.subarray(off, off + size);
    out.push(frame(CMD.chunk, [seq, off & 0xff, off >> 8, patch.length & 0xff, patch.length >> 8, ...part]));
  }
  return out;
};
export const paramFrame = (module: number, param: number, q16: number): Uint8Array => {
  const v = q16 | 0;
  return frame(CMD.param, [module, param, v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff]);
};

export const SLOTS = 64;
/** a slot as people see it: internal slot 0..63 shows as 01..64 (the protocol, the firmware and program change count from 0) */
export const slotLabel = (slot: number): string => String(slot + 1).padStart(2, '0');
export const NAME_BYTES = 20;
export const slotFrame = (slot: number, name: string, patch: Uint8Array, crc = crc16(patch)): Uint8Array => {
  const n = Array.from({ length: NAME_BYTES }, (_, i) => (name.charCodeAt(i) >= 32 && name.charCodeAt(i) < 127 ? name.charCodeAt(i) : 0));
  return frame(CMD.slot, [slot, ...n, patch.length & 0xff, patch.length >> 8, crc & 0xff, crc >> 8]);
};
export const slotEraseFrame = (slot: number): Uint8Array => frame(CMD.slotErase, [slot]);
export const slotInfoFrame = (slot: number): Uint8Array => frame(CMD.slotInfo, [slot]);
export interface SlotInfo {
  slot: number;
  used: boolean;
  length: number;
  name: string;
}
export const parseSlot = (p: Parsed): SlotInfo | null =>
  p.cmd === CMD.slotReply && p.payload.length >= 4 + NAME_BYTES
    ? { slot: p.payload[0], used: !!p.payload[1], length: p.payload[2] | (p.payload[3] << 8), name: String.fromCharCode(...p.payload.slice(4, 4 + NAME_BYTES).filter((c) => c >= 32 && c < 127)) }
    : null;

export const attFrame = (module: number, input: number, q16: number): Uint8Array => {
  const v = q16 | 0;
  return frame(CMD.att, [module, input, v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff]);
};

export const bypassFrame = (module: number, on: boolean): Uint8Array => frame(CMD.bypass, [module, on ? 1 : 0]);
/** a Steps module's notes (all of them), of pattern `pat` (0-based; format 48: absent, the one the track plays) */
export function trackFrame(module: number, notes: readonly StepNote[] | undefined, pat?: number): Uint8Array {
  const n = (notes ?? []).slice(0, TRACK_NOTES_MAX);
  return frame(CMD.track, [module, n.length, ...n.flatMap((x) => { const w = noteWord(x); return [w & 0xff, (w >>> 8) & 0xff, (w >>> 16) & 0xff, w >>> 24]; }), ...(pat === undefined ? [] : [pat & 0xff])]);
}
/** a TRACK / TRACK_NOW payload's notes and pattern (absent: an older firmware's, the track's only one: 0) */
export function parseTrack(payload: number[]): { module: number; notes: StepNote[]; pat: number } | null {
  if (payload.length < 2 || payload.length < 2 + 4 * payload[1]) return null;
  const notes = Array.from({ length: payload[1] }, (_, j) => wordNote((payload[2 + 4 * j] | (payload[3 + 4 * j] << 8) | (payload[4 + 4 * j] << 16) | (payload[5 + 4 * j] << 24)) >>> 0));
  const pat = payload.length > 2 + 4 * payload[1] ? Math.min(PATTERNS_MAX - 1, payload[2 + 4 * payload[1]]) : 0;
  return { module: payload[0], notes, pat };
}
/** a device-form lock as the FM-1 reports it (LOCKS_NOW, #524): step, module index, parameter index, value */
export interface RawLock { at: number; module: number; param: number; value: number }
/** a LOCKS_NOW payload (unasked, after a lock edit on the SEQ page): the track's module index, the pattern (0-based) and
 * that pattern's locks, 7 bytes each (step, module, parameter, i32 LE Q16 value) */
export function parseLocksNow(payload: number[]): { module: number; pat: number; locks: RawLock[] } | null {
  if (payload.length < 3 || payload.length < 3 + 7 * payload[2]) return null;
  const locks = Array.from({ length: payload[2] }, (_, j) => {
    const o = 3 + 7 * j;
    return { at: payload[o], module: payload[o + 1], param: payload[o + 2], value: (payload[o + 3] | (payload[o + 4] << 8) | (payload[o + 5] << 16) | (payload[o + 6] << 24)) / 65536 };
  });
  return { module: payload[0], pat: Math.min(PATTERNS_MAX - 1, payload[1]), locks };
}
/** the patch's pattern (0-based) and the song playing (0 none) */
export const patternFrame = (pattern: number, song: number): Uint8Array => frame(CMD.pattern, [pattern & 0xff, song & 0xff]);
/** song s's entries (0-based s) */
export const songFrame = (s: number, entries: readonly SongEntry[]): Uint8Array =>
  frame(CMD.song, [s & 0xff, Math.min(SONG_LEN_MAX, entries.length), ...entries.slice(0, SONG_LEN_MAX).flatMap((e) => [e.pat & 0xff, e.shift & 0xff])]);
/** a PATTERN_NOW payload */
export const parsePatternNow = (payload: number[]): { pattern: number; song: number } | null =>
  payload.length >= 2 ? { pattern: Math.min(PATTERNS_MAX - 1, payload[0]), song: Math.min(SONGS_MAX, payload[1]) } : null;
/** a SONG_NOW payload */
export function parseSongNow(payload: number[]): { song: number; entries: SongEntry[] } | null {
  if (payload.length < 2 || payload[0] >= SONGS_MAX || payload.length < 2 + 2 * payload[1]) return null;
  const entries = Array.from({ length: Math.min(SONG_LEN_MAX, payload[1]) }, (_, k) => ({
    pat: Math.min(PATTERNS_MAX - 1, payload[2 + 2 * k]),
    shift: Math.max(-SHIFT_MAX, Math.min(SHIFT_MAX, (payload[3 + 2 * k] << 24) >> 24)),
  }));
  return { song: payload[0], entries };
}
export const focusFrame = (device: number, page: number): Uint8Array => frame(CMD.focus, [device & 0xff, page & 0xff]);
export const muteFrame = (module: number, on: boolean): Uint8Array => frame(CMD.mute, [module, on ? 1 : 0]);
/** GLO > PANEL > TEMPO (global: true) and the global tempo (whole bpm; 0 leaves it) */
export const tempoFrame = (global: boolean, bpm: number): Uint8Array => {
  const b = Math.max(0, Math.min(0xffff, Math.round(bpm)));
  return frame(CMD.tempo, [global ? 0 : 1, b & 0xff, b >> 8]);
};
/** ARMS (#191): the editor's armed set as a module mask (arm.ts armMask), its words as u32 LE (two for firmware before
 * feature bit 21: modules 0..63; ARM_WORDS since, #721) */
export const armsFrame = (words: readonly number[]): Uint8Array =>
  frame(CMD.arms, words.flatMap((w) => [w, w >>> 8, w >>> 16, w >>> 24].map((b) => b & 0xff)));
/** an ARMS_NOW payload: its u32 LE words, ARM_WORDS of them (older firmware sends two: the rest 0); null when too short */
export const parseArmsNow = (payload: number[]): number[] | null => {
  if (payload.length < 8) return null;
  const n = payload.length >= 4 * ARM_WORDS ? ARM_WORDS : 2;
  return Array.from({ length: ARM_WORDS }, (_, k) => (k < n ? (payload[4 * k] | (payload[4 * k + 1] << 8) | (payload[4 * k + 2] << 16) | (payload[4 * k + 3] << 24)) >>> 0 : 0));
};
/** a TEMPO_NOW payload: the FM-1's setting and global tempo (bpm 0: not known yet) */
export const parseTempoNow = (payload: number[]): { global: boolean; bpm: number } | null =>
  payload.length >= 3 ? { global: payload[0] === 0, bpm: payload[1] | (payload[2] << 8) } : null;
/** the arpeggiator's settings, and its transport (null = leave it) */
export const transportFrame = (run: boolean): Uint8Array => frame(CMD.transport, [run ? 1 : 0]);
export const liveFrame = (paused = false): Uint8Array => frame(CMD.live, paused ? [1] : []);
/** how often the editor says LIVE (the FM-1 holds it 5 s: firmware main.c LIVE_HOLD_MS) */
export const LIVE_MS = 2000;
/** a macro range of pin 0 / 1 on parameter `param`: ends 0..1, or null to remove it */
export const rangeFrame = (module: number, pin: number, param: number, range: Range | null): Uint8Array =>
  frame(CMD.range, [module, pin, param, range ? (range[2] === 1 ? 3 : 1) : 0, range ? Math.round(range[0] * 255) : 0, range ? Math.round(range[1] * 255) : 0]);

export interface Info {
  version: number;
  maxModules: number;
  maxCables: number;
  flashOk: boolean;
  patchLoaded: boolean;
  delays: number;
  /** feature bits: 2 = the TRANSPORT command, 4 = MUTE, 32 = TRACK, 256 = sandbox mode (1 ARP, 8 STEPVAL are retired;
   *  STEP went with 4's meaning) */
  features: number;
  /** INFO byte 13: signal-buffer allocation rule. Missing or unknown means separate charging. */
  bufferAllocation?: number;
  /** Inclusive binary patch format range; absent from older firmware, whose feature bits describe compatibility. */
  patchFormats?: { min: number; max: number };
  /** MENU > MIDI OUT is on (the FM-1's panel reaches the editor); null: the firmware does not say (no feature bit 8) */
  midiOut: boolean | null;
  /** GLO > SYSTEM > EDITOR is at IGNORE (#702): the editor leaves this FM-1 alone. Firmware without the setting (no feature
   *  bit 19) counts as ALLOW */
  editorIgnored?: boolean;
  /** the firmware's version (INFO bytes 9..11, #216; 0.0.0 a dev or CI build); absent from firmware before 1.8, whose
   *  identity (FM-1_7XY) gives major and minor */
  firmware?: { major: number; minor: number; patch: number };
}
export interface Ack {
  cmd: number;
  seq: number;
  status: number;
  aux: number;
}
export const FEATURE_SANDBOX = 256;
/** INFO feature bit 16 (byte 12, after the firmware version): TEMPO / TEMPO_NOW, the global tempo shared (D-907) */
export const FEATURE_TEMPO = 1 << 16;
/** INFO feature bit 17: PRESET_PUT / PRESET_DATA carry up to 176 values (the FM-1 stores a longer preset in two slots, #485);
 * older firmware takes 88 */
export const FEATURE_LONG_PRESETS = 1 << 17;
/** INFO feature bit 18 (#549): the FM-1 reports the key edges its panel takes (KEYS_NOW) and its panel's state (GUIDE_NOW),
 * so the editor's copy of the panel logic stays in step; older firmware sends neither */
export const FEATURE_PANEL_REPORT = 1 << 18;
/** INFO feature bit 19 (#702): INFO's flags bit 3 says GLO > SYSTEM > EDITOR (set: IGNORE) */
export const FEATURE_EDITOR_SETTING = 1 << 19;
/** INFO feature bit 20 (#191): ARMS, the editor's armed set as the FM-1's; older firmware keeps its own */
export const FEATURE_ARMS = 1 << 20;
/** INFO feature bit 21 (#721): ARMS and ARMS_NOW carry ARM_WORDS words, modules 0..127 (INFO's module limit says 128);
 * older firmware takes and sends two, modules 0..63 */
export const FEATURE_WIDE_ARMS = 1 << 21;
/** INFO payload byte 14, bit 24: complete synth + master-FX presets (FXP1). */
export const FEATURE_FX_PRESETS = 1 << 24;
/** PARAM_NOW's parameter sentinel: logical FX kernel bypass, value 0/1 in Q16. */
export const FX_BYPASS_PARAM = 0xff;

/** INFO's flags bit 3: EDITOR at IGNORE (with feature bit 19) */
const INFO_EDITOR_IGNORE = 8;
/** a preset's values at most over the link: with feature bit 17, and before it */
export const PRESET_VALUES_MAX = 176;
export const PRESET_VALUES_OLD = 88;
export function parseInfo(p: Parsed): Info | null {
  if (p.cmd !== CMD.info || p.payload.length < 5) return null;
  const features = (p.payload[5] ?? 0) | ((p.payload[6] ?? 0) << 8) | ((p.payload[12] ?? 0) << 16) | ((p.payload[14] ?? 0) << 24);
  return { version: p.payload[0], maxModules: p.payload[1], maxCables: p.payload[2], flashOk: !!(p.payload[3] & 1), patchLoaded: !!(p.payload[3] & 2), delays: p.payload[4], features,
    ...(p.payload.length >= 14 ? { bufferAllocation: p.payload[13] } : {}),
    midiOut: features & FEATURE_SANDBOX ? !!(p.payload[3] & 4) : null,
    editorIgnored: !!(features & FEATURE_EDITOR_SETTING) && !!(p.payload[3] & INFO_EDITOR_IGNORE),
    ...(p.payload.length >= 9 ? { patchFormats: { min: p.payload[7], max: p.payload[8] } } : {}),
    ...(p.payload.length >= 12 ? { firmware: { major: p.payload[9], minor: p.payload[10], patch: p.payload[11] } } : {}) };
}
/** the test tools drive the editor's own page against the test rig, which is set to IGNORE so the site leaves it alone
 *  (#702): their page (scripts/emu-scenarios.mjs --device) sets this before it loads. Nothing else does */
export const rigTools = (): boolean => (globalThis as { __m1RigTools?: unknown }).__m1RigTools === true;
/** an FM-1 the editor and its Install panel skip (#702): it answered HELLO with GLO > SYSTEM > EDITOR at IGNORE, and this
 *  is not the test tools' page */
export const editorSkips = (info: Info | null, rig = rigTools()): boolean => !!info?.editorIgnored && !rig;
export const parseAck = (p: Parsed): Ack | null => (p.cmd === CMD.ack && p.payload.length >= 4 ? { cmd: p.payload[0], seq: p.payload[1], status: p.payload[2], aux: p.payload[3] } : null);

// ---- presets (#195): the FM-1's user presets, by structure (structure.ts, 8 hex digits) and name

/** a preset name as the FM-1 keeps it: printable ASCII, 16 characters */
export const PRESET_NAME_BYTES = 16;
export const devicePresetName = (s: string): string => s.replace(/[^\x20-\x7e]/g, '').slice(0, PRESET_NAME_BYTES).trim();
const presetKey = (structure: string, name: string): number[] => {
  const h = parseInt(structure, 16) >>> 0;
  const n = devicePresetName(name);
  return [h & 0xff, (h >>> 8) & 0xff, (h >>> 16) & 0xff, h >>> 24, ...Array.from({ length: PRESET_NAME_BYTES }, (_, i) => (i < n.length ? n.charCodeAt(i) : 0))];
};
const readKey = (p: number[], at: number): { structure: string; name: string } => ({
  structure: (((p[at] | (p[at + 1] << 8) | (p[at + 2] << 16) | (p[at + 3] << 24)) >>> 0).toString(16).padStart(8, '0')),
  name: String.fromCharCode(...p.slice(at + 4, at + 4 + PRESET_NAME_BYTES).filter((c) => c >= 32 && c < 127)),
});
const i32 = (v: number): number[] => { const x = v | 0; return [x & 0xff, (x >> 8) & 0xff, (x >> 16) & 0xff, (x >>> 24) & 0xff]; };
export const presetsFrame = (): Uint8Array => frame(CMD.presets);
export const presetGetFrame = (structure: string, name: string): Uint8Array => frame(CMD.presetGet, presetKey(structure, name));
/** values as the editor keeps them (real numbers), sent as Q16; more than PRESET_VALUES_MAX throws (DeviceLink.putPreset
 * refuses more than PRESET_VALUES_OLD to older firmware before it gets here) */
export function presetPutFrame(structure: string, name: string, values: number[]): Uint8Array {
  if (values.length > PRESET_VALUES_MAX) throw new Error(`a preset holds ${PRESET_VALUES_MAX} values at most`);
  return frame(CMD.presetPut, [...presetKey(structure, name), values.length, ...values.flatMap((v) => i32(Math.round(v * 65536)))]);
}
export const presetDelFrame = (structure: string, name: string): Uint8Array => frame(CMD.presetDel, presetKey(structure, name));
export interface DevicePresetEntry { index: number; count: number; structure: string; name: string; n: number }
export const parsePresetEntry = (p: Parsed): DevicePresetEntry | null =>
  p.cmd === CMD.preset && p.payload.length >= 23 ? { index: p.payload[0], count: p.payload[1], ...readKey(p.payload, 2), n: p.payload[22] } : null;
/** a PRESET_DATA: the values back as real numbers; null values: the FM-1 has none of that name */
export function parsePresetData(p: Parsed): { structure: string; name: string; values: number[] | null } | null {
  if (p.cmd !== CMD.presetData || p.payload.length < 21) return null;
  const key = readKey(p.payload, 0);
  const n = p.payload[20];
  if (n === 0xff) return { ...key, values: null };
  if (p.payload.length < 21 + 4 * n) return null;
  const dv = new DataView(Uint8Array.from(p.payload).buffer);
  return { ...key, values: Array.from({ length: n }, (_, k) => dv.getInt32(21 + 4 * k, true) / 65536) };
}
export const parsePresetStored = (p: Parsed): { structure: string; name: string } | null =>
  p.cmd === CMD.presetStored && p.payload.length >= 20 ? readKey(p.payload, 0) : null;

// ---- sandbox mode: the editor's device page for the FM-1 to draw (SANDBOX, firmware/src/sandbox_msg.h)

/** a row of the page: its name, its value as text and its unit apart ("2.40", "kHz"), where it sits in its range (0..1),
 *  and its choices (0: continuous) */
export interface SandboxRow { label: string; value: string; unit: string; pos: number; steps: number }
/** where the page sits, for the FM-1's device page header (D-468): the patch's devices and the one in focus, its page
 *  groups and the current one, the group's pages and the current one (places from 0) */
export interface SandboxPlace { devices: number; device: number; groups: number; group: number; pages: number; page: number }
/** the page: the patch, the device, the page's title, its place among the device's pages; four rows, null where none;
 *  then (1.8) its place for the header, the tempo the browser plays (bpm, 0 none), whether the patch has unsaved edits,
 *  and the armed devices (bit d: device d of the patch's devices) */
export interface SandboxPage {
  patch: string; device: string; page: string; index: number; count: number; rows: (SandboxRow | null)[];
  place?: SandboxPlace; tempo?: number; unsaved?: boolean; armed?: number;
}
/** the fields' widths in bytes */
export const SANDBOX_FIELDS = { patch: 20, device: 12, page: 16, label: 12, value: 10, unit: 6 } as const;
const SANDBOX_ROW_BYTES = SANDBOX_FIELDS.label + SANDBOX_FIELDS.value + SANDBOX_FIELDS.unit + 2;
/** the fields up to the rows (all a 1.3..1.7 FM-1 reads), and the ones after them (firmware/src/sandbox_msg.h SB_EXT_BYTES) */
export const SANDBOX_BYTES = 3 + SANDBOX_FIELDS.patch + SANDBOX_FIELDS.device + SANDBOX_FIELDS.page + 4 * SANDBOX_ROW_BYTES;
export const SANDBOX_EXT_BYTES = 13;
/** text as the FM-1's font has it: printable ASCII (a minus sign, a micro sign and a few others by their look-alikes) */
export const fm1Ascii = (s: string): string =>
  s.replace(/[\u2212\u2013\u2014]/g, '-').replace(/\u00b5/g, 'u').replace(/\u00d7/g, 'x').replace(/\u00b7/g, '-').replace(/[\u2018\u2019]/g, "'")
    .replace(/[^\x20-\x7e]/g, '');
const field = (s: string, n: number): number[] => {
  const t = fm1Ascii(s).slice(0, n);
  return Array.from({ length: n }, (_, i) => (i < t.length ? t.charCodeAt(i) : 0));
};
export function sandboxPayload(pg: SandboxPage): number[] {
  const F = SANDBOX_FIELDS;
  const rows = [0, 1, 2, 3].map((k) => pg.rows[k] ?? null);
  return [
    rows.reduce((m, r, k) => (r ? m | (1 << k) : m), 0), pg.index & 0xff, pg.count & 0xff,
    ...field(pg.patch, F.patch), ...field(pg.device, F.device), ...field(pg.page, F.page),
    ...rows.flatMap((r) => r
      ? [...field(r.label, F.label), ...field(r.value, F.value), ...field(r.unit, F.unit), Math.max(0, Math.min(255, Math.round(r.pos * 255))), Math.max(0, Math.min(255, r.steps | 0))]
      : new Array<number>(SANDBOX_ROW_BYTES).fill(0)),
    ...sandboxExt(pg),
  ];
}
const u8 = (n: number | undefined): number => Math.max(0, Math.min(255, Math.round(n ?? 0)));
function sandboxExt(pg: SandboxPage): number[] {
  const p = pg.place;
  const tempo = Math.max(0, Math.min(0xffff, Math.round(pg.tempo ?? 0)));
  const armed = (pg.armed ?? 0) >>> 0;
  return [u8(p?.devices), u8(p?.device), u8(p?.groups), u8(p?.group), u8(p?.pages), u8(p?.page), tempo & 0xff, tempo >> 8,
    pg.unsaved ? 1 : 0, armed & 0xff, (armed >>> 8) & 0xff, (armed >>> 16) & 0xff, armed >>> 24];
}
export const sandboxFrame = (pg: SandboxPage): Uint8Array => frame(CMD.sandbox, sandboxPayload(pg));
/** a SANDBOX payload back (positions to the nearest 1/255); null when it is short; without the fields after the rows (an
 *  older editor's) it has no place, tempo, unsaved or armed */
export function parseSandbox(payload: number[]): SandboxPage | null {
  if (payload.length < SANDBOX_BYTES) return null;
  const F = SANDBOX_FIELDS;
  let at = 3;
  const str = (n: number): string => {
    const b = payload.slice(at, at + n);
    at += n;
    const end = b.indexOf(0);
    return String.fromCharCode(...(end < 0 ? b : b.slice(0, end)));
  };
  const patch = str(F.patch), device = str(F.device), page = str(F.page);
  const rows = [0, 1, 2, 3].map((k): SandboxRow | null => {
    const label = str(F.label), value = str(F.value), unit = str(F.unit);
    const pos = payload[at] / 255, steps = payload[at + 1];
    at += 2;
    return payload[0] & (1 << k) ? { label, value, unit, pos, steps } : null;
  });
  const base = { patch, device, page, index: payload[1], count: payload[2], rows };
  if (payload.length < SANDBOX_BYTES + SANDBOX_EXT_BYTES) return base;   // (an editor before 1.8)
  const e = payload.slice(SANDBOX_BYTES);
  return { ...base, place: { devices: e[0], device: e[1], groups: e[2], group: e[3], pages: e[4], page: e[5] }, tempo: e[6] | (e[7] << 8),
    unsaved: !!(e[8] & 1), armed: (e[9] | (e[10] << 8) | (e[11] << 16) | (e[12] << 24)) >>> 0 };
}

// ---- the device test mode (#291): a script drives the FM-1's panel and reads its screen and level (scripts/device-scenarios.mjs)

export const FEATURE_TEST = 512;
/** INFO feature bit 10: TEST_PEAK reads before the MASTER knob, so where it sits changes no check (PEAK's flags bit 2: it is down) */
export const FEATURE_PEAK_PRE = 1024;
export const testKeyFrame = (id: number, down: boolean): Uint8Array => frame(CMD.testKey, [id & 0xff, down ? 1 : 0]);
export const testTurnFrame = (enc: number, clicks: number): Uint8Array => frame(CMD.testTurn, [enc & 0xff, Math.max(-128, Math.min(127, clicks | 0)) & 0xff]);
export const testScreenFrame = (): Uint8Array => frame(CMD.testScreen);
export const testPeakFrame = (): Uint8Array => frame(CMD.testPeak);
export interface ScreenText { x: number; y: number; w: number; h: number; s: string }
export interface ScreenHead { count: number; page: number; sandbox: boolean; booting: boolean; buttons?: number }
/** a SCREEN frame: the head (k 0xFF) or text k */
export function parseScreen(p: Parsed): { head: ScreenHead } | { k: number; text: ScreenText } | null {
  if (p.cmd !== CMD.screen || p.payload.length < 1) return null;
  const d = p.payload;
  if (d[0] === 0xff) return d.length >= 4 ? { head: { count: d[1], page: d[2], sandbox: !!(d[3] & 1), booting: !!(d[3] & 2), ...(d.length >= 6 ? { buttons: d[4] | (d[5] << 8) } : {}) } } : null;
  if (d.length < 6 || d.length < 6 + d[5]) return null;
  return { k: d[0], text: { x: d[1], y: d[2], w: d[3], h: d[4], s: String.fromCharCode(...d.slice(6, 6 + d[5])) } };
}
export const parsePeak = (p: Parsed): { peak: number; running: boolean; muted: boolean; masterDown: boolean } | null =>
  p.cmd === CMD.peak && p.payload.length >= 3
    ? { peak: p.payload[0] | (p.payload[1] << 8), running: !!(p.payload[2] & 1), muted: !!(p.payload[2] & 2), masterDown: !!(p.payload[2] & 4) }
    : null;
/** the test rig's mark (#291): a user preset of no structure the editor makes (scripts/rig.mjs registers it); the
 *  Library hides it */
export const RIG_STRUCTURE = '7e57417e';
export const RIG_PRESET = 'MATRYOSHKA RIG';

// ---- the panel's reports (#549, #554, feature bit 18): what the FM-1's panel took, and its state

/** a key edge the FM-1's panel took (KEYS_NOW): the key (0 = F3), pressed or let go, the keys held after it (bit n key n),
 *  the buttons held then (bit: matrix id, fm1-ui.ts BUTTONS) */
export interface KeysNow { key: number; down: boolean; keys: number; held: number }
export const parseKeysNow = (payload: number[]): KeysNow | null =>
  payload.length >= 7
    ? { key: payload[0] & 0x1f, down: !!(payload[0] & 0x80), keys: (payload[1] | (payload[2] << 8) | (payload[3] << 16) | (payload[4] << 24)) >>> 0,
        held: payload[5] | (payload[6] << 8) }
    : null;
/** the bytes of a GUIDE_NOW (firmware/src/help_ui.c GUIDE_BYTES) */
export const GUIDE_BYTES = 14;
/** the FM-1's panel state (GUIDE_NOW), or the FM-1 tab's copy's (fm1-ui.ts Fm1Ui.guide): the same bytes. `state` indexes
 *  controls.ts HELP_STATES; `conditions` bit c is controls.ts CONDITIONS[c - 1]; `raw` the bytes as sent */
export interface PanelState {
  state: number; page: number; stepRecord: boolean; liveTake: boolean; recording: boolean; sandbox: boolean;
  sheet: boolean; quickStart: boolean; everywhere: boolean; stepHeld: boolean;
  device: number; devicePage: number; track: number; menuTab: number; held: number; conditions: number;
  sheetRow: number; octave: number; cursor: number; raw: number[];
}
export function parseGuideNow(payload: ArrayLike<number>): PanelState | null {
  if (payload.length < GUIDE_BYTES) return null;
  const p = Array.from(payload).slice(0, GUIDE_BYTES);
  const f = p[2];
  return {
    state: p[0], page: p[1], stepRecord: !!(f & 1), liveTake: !!(f & 2), recording: !!(f & 4), sandbox: !!(f & 8),
    sheet: !!(f & 16), quickStart: !!(f & 32), everywhere: !!(f & 64), stepHeld: !!(f & 128),
    device: p[3], devicePage: p[4], track: p[5], menuTab: p[6], held: p[7] | (p[8] << 8), conditions: p[9] | (p[10] << 8),
    sheetRow: p[11], octave: (p[12] << 24) >> 24, cursor: p[13], raw: p,
  };
}
/** where the FM-1 tab's copy of the panel logic is not where the FM-1 is (#549): the fields it puts back with
 *  Fm1Ui.align (firmware/src/panel.c panel_align), named; [] when in step. The device page in focus counts on a device
 *  page only, the track on the SEQ page only, the cursor in step record only; REC's recording, a live take and the
 *  transport are the editor's to set (D-457), the quick start the FM-1's own */
export function panelOffBy(copy: PanelState, fm1: PanelState): string[] {
  const off: string[] = [];
  if (copy.page !== fm1.page) off.push('page');
  if (fm1.page === 0 && (copy.device !== fm1.device || copy.devicePage !== fm1.devicePage)) off.push('focus');
  if (fm1.page === 8 && copy.track !== fm1.track) off.push('track');
  if (fm1.page === 5 && copy.menuTab !== fm1.menuTab) off.push('menu tab');
  if (copy.stepRecord !== fm1.stepRecord || (fm1.stepRecord && copy.cursor !== fm1.cursor)) off.push('step record');
  // Conditions 12/13 report piano-roll note preview; older firmware sends neither.
  const preview = (1 << 12) | (1 << 13);
  if ((fm1.conditions & preview) && (copy.conditions & preview) !== (fm1.conditions & preview)) off.push('note preview');
  if (copy.sheet !== fm1.sheet || (fm1.sheet && (copy.everywhere !== fm1.everywhere || copy.sheetRow !== fm1.sheetRow))) off.push('sheet');
  if (copy.held !== fm1.held) off.push('held');
  if (copy.octave !== fm1.octave) off.push('octave');
  return off;
}
/** DEVICE_SETTINGS (feature bit 22): empty reads; name[16], level u8 writes.
 * Reply: status u8, name[16], level u8, physical serial[16]. */
export const FEATURE_DEVICE_SETTINGS = 1 << 22;
export interface DeviceSettings { name: string; returnLevel: number; serial: string }
export function deviceSettingsFrame(settings?: Pick<DeviceSettings, 'name' | 'returnLevel'>): Uint8Array {
  if (!settings) return frame(CMD.deviceSettings);
  const name = settings.name.trim();
  if (name.length > 16 || !/^[\x20-\x7e]*$/.test(name)) throw new Error('Use up to 16 letters, numbers, spaces or punctuation from an English keyboard.');
  if (!Number.isInteger(settings.returnLevel) || settings.returnLevel < 0 || settings.returnLevel > 100) throw new Error('USB return level must be between 0 and 100%.');
  const bytes = new Uint8Array(17);
  for (let i = 0; i < name.length; i++) bytes[i] = name.charCodeAt(i);
  bytes[16] = settings.returnLevel;
  return frame(CMD.deviceSettings, bytes);
}
export function parseDeviceSettings(p: Parsed | null): DeviceSettings {
  if (p?.cmd !== CMD.deviceSettingsReply || p.payload.length !== 34) throw new Error('The FM-1 sent an incomplete settings reply.');
  if (p.payload[0]) throw new Error(p.payload[0] === 1 ? 'The FM-1 could not use those settings.' : 'The FM-1 could not save its settings. Try again after it finishes starting.');
  const nameBytes = p.payload.slice(1, 17);
  if (nameBytes.some((v) => v !== 0 && (v < 32 || v > 126)) || p.payload[17] > 100) throw new Error('The FM-1 sent invalid settings.');
  return { name: String.fromCharCode(...nameBytes).replace(/\0.*$/, ''), returnLevel: p.payload[17], serial: p.payload.slice(18).map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase() };
}
