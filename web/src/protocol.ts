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
//   21 ATT      module u8, input u8 (0 p1, 1 p2), value i32   live attenuverter change (Q16.16, -1..1), no reply
//   22 BYPASS   module u8, on u8 (0/1)               bypass a module (its outputs carry its through input or silence), no reply
//   23 RANGE    module u8, pin u8 (0 p1, 1 p2), param u8, on u8, low u8, high u8   a macro range of the pin on the parameter
//                                                    (ends 0..255 of the range, patchbin.ts), on 0 removes it; no reply
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
//               steps u8)                            the editor's device page in sandbox mode, sent when it changes; no reply.
//                                                    rows: bit k row k is there; index / count: the page among its device's;
//                                                    page: its title as the FM-1's chips show it; position 0..255 of the
//                                                    row's range; steps 0 continuous, n: n choices. Names zero padded
//                                                    ASCII. Feature bit 8 (firmware/src/sandbox_msg.h)
//   2D PRESETS  (none)                               the FM-1's user presets (#195): one PRESET (4C) per preset. Feature bit 7.
//   2E PRESET_GET  structure u32, name 16 bytes      device answers PRESET_DATA (4D)
//   2F PRESET_PUT  structure u32, name 16 bytes, n u8, n i32 values (Q16, canonical row order)   store it (over one of
//                                                    that structure and name); ACK (7 = full)
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
//   47 PARAM_NOW  module u8, param u8, value i32      unasked: a parameter turned on the FM-1 (K1..K4 on a device page)
//   48 FOCUS_NOW  device u8, page u8                  unasked: the device page the FM-1 shows now (SELECT / ALGO / HOME)
//   4C PRESET   index u8, count u8, structure u32, name 16 bytes, n u8   one of the FM-1's user presets (count 0: none)
//   4D PRESET_DATA  structure u32, name 16 bytes, n u8 (0xFF: none), n i32 values
//   4E PRESET_STORED  structure u32, name 16 bytes  unasked: a preset stored on the FM-1 (ENV held + SAVE)
//   50 SCREEN   k u8 = 0xFF, count u8, page u8, flags u8 (bit0 sandbox mode, bit1 the boot screen); then k = 0..count-1:
//               x u8, y u8, w u8, h u8, n u8, n characters   a text on the LCD and its box (firmware/src/screen_text.h)
//   51 PEAK     peak u16 (16 bit, before MASTER: as at its default), flags u8 (bit0 the engine runs, bit1 the sound is muted:
//               sandbox mode, bit2 MASTER is all the way down)
//   41 INFO     version, max modules, max cables, flags (bit0 flash ok, bit1 patch loaded, bit2 MENU > MIDI OUT on: with
//               feature bit 8), delay lines, [features: bit1 TRANSPORT, bit2 MUTE, bit4 FOCUS / PARAM_NOW / FOCUS_NOW,
//               bit5 TRACK / TRACK_NOW, bit6 LIVE, bit7 presets], [features 8..15: bit8 sandbox mode, bit9 the device
//               test mode, bit10 TEST_PEAK reads before MASTER, bits11..15 read patch formats35..39],
//               [minimum readable patch format, maximum readable patch format]. Also unasked
//               after a LIVE when MIDI OUT changed since the editor last heard (feature bit 8)
//   40 ACK      command, seq, status, aux            status 0 ok, 1 bad offset/size, 2 CRC, 3 load error (aux = code),
//                                                    4 flash error, 5 unknown command, 6 nothing to store

import { noteWord, PATTERNS_MAX, SHIFT_MAX, SONG_LEN_MAX, SONGS_MAX, TRACK_NOTES_MAX, wordNote, type SongEntry, type StepNote } from './track';

export const PREFIX = [0x7d, 0x4d, 0x31];
export const CMD = { hello: 0x01, chunk: 0x10, commit: 0x11, store: 0x12, param: 0x20, att: 0x21, bypass: 0x22, range: 0x23, transport: 0x25, mute: 0x27, focus: 0x29, track: 0x2a, diag: 0x2b, live: 0x2c, slot: 0x13, slotErase: 0x14, slotInfo: 0x15, ack: 0x40, info: 0x41, slotReply: 0x42, slotNow: 0x43, muteNow: 0x45, paramNow: 0x47, focusNow: 0x48, trackNow: 0x49, diagReply: 0x4b, presets: 0x2d, presetGet: 0x2e, presetPut: 0x2f, presetDel: 0x30, sandbox: 0x31, preset: 0x4c, presetData: 0x4d, presetStored: 0x4e, testKey: 0x32, testTurn: 0x33, testScreen: 0x34, testPeak: 0x35, screen: 0x50, peak: 0x51, pattern: 0x36, song: 0x37, patternNow: 0x52, songNow: 0x53 } as const; // diag: bring-up diagnostics (tools/m1_link.py diag; the editor does not use it)
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
/** the arpeggiator's settings, and its transport (null = leave it) */
export const transportFrame = (run: boolean): Uint8Array => frame(CMD.transport, [run ? 1 : 0]);
export const liveFrame = (paused = false): Uint8Array => frame(CMD.live, paused ? [1] : []);
/** how often the editor says LIVE (the FM-1 holds it 5 s: firmware main.c LIVE_HOLD_MS) */
export const LIVE_MS = 2000;
/** a macro range of pin 0 / 1 on parameter `param`: ends 0..1, or null to remove it */
export const rangeFrame = (module: number, pin: number, param: number, range: [number, number] | null): Uint8Array =>
  frame(CMD.range, [module, pin, param, range ? 1 : 0, range ? Math.round(range[0] * 255) : 0, range ? Math.round(range[1] * 255) : 0]);

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
  /** Inclusive binary patch format range; absent from older firmware, whose feature bits describe compatibility. */
  patchFormats?: { min: number; max: number };
  /** MENU > MIDI OUT is on (the FM-1's panel reaches the editor); null: the firmware does not say (no feature bit 8) */
  midiOut: boolean | null;
}
export interface Ack {
  cmd: number;
  seq: number;
  status: number;
  aux: number;
}
export const FEATURE_SANDBOX = 256;
export function parseInfo(p: Parsed): Info | null {
  if (p.cmd !== CMD.info || p.payload.length < 5) return null;
  const features = (p.payload[5] ?? 0) | ((p.payload[6] ?? 0) << 8);
  return { version: p.payload[0], maxModules: p.payload[1], maxCables: p.payload[2], flashOk: !!(p.payload[3] & 1), patchLoaded: !!(p.payload[3] & 2), delays: p.payload[4], features,
    midiOut: features & FEATURE_SANDBOX ? !!(p.payload[3] & 4) : null,
    ...(p.payload.length >= 9 ? { patchFormats: { min: p.payload[7], max: p.payload[8] } } : {}) };
}
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
/** values as the editor keeps them (real numbers), sent as Q16 */
export const presetPutFrame = (structure: string, name: string, values: number[]): Uint8Array =>
  frame(CMD.presetPut, [...presetKey(structure, name), Math.min(values.length, 88), ...values.slice(0, 88).flatMap((v) => i32(Math.round(v * 65536)))]);
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
/** the page: the patch, the device, the page's title, its place among the device's pages; four rows, null where none */
export interface SandboxPage { patch: string; device: string; page: string; index: number; count: number; rows: (SandboxRow | null)[] }
/** the fields' widths in bytes */
export const SANDBOX_FIELDS = { patch: 20, device: 12, page: 16, label: 12, value: 10, unit: 6 } as const;
const SANDBOX_ROW_BYTES = SANDBOX_FIELDS.label + SANDBOX_FIELDS.value + SANDBOX_FIELDS.unit + 2;
export const SANDBOX_BYTES = 3 + SANDBOX_FIELDS.patch + SANDBOX_FIELDS.device + SANDBOX_FIELDS.page + 4 * SANDBOX_ROW_BYTES;
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
  ];
}
export const sandboxFrame = (pg: SandboxPage): Uint8Array => frame(CMD.sandbox, sandboxPayload(pg));
/** a SANDBOX payload back (positions to the nearest 1/255); null when it is short */
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
  return { patch, device, page, index: payload[1], count: payload[2], rows };
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
export interface ScreenHead { count: number; page: number; sandbox: boolean; booting: boolean }
/** a SCREEN frame: the head (k 0xFF) or text k */
export function parseScreen(p: Parsed): { head: ScreenHead } | { k: number; text: ScreenText } | null {
  if (p.cmd !== CMD.screen || p.payload.length < 1) return null;
  const d = p.payload;
  if (d[0] === 0xff) return d.length >= 4 ? { head: { count: d[1], page: d[2], sandbox: !!(d[3] & 1), booting: !!(d[3] & 2) } } : null;
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
