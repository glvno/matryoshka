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
//   02 SLOT_GET slot u8, offset u16, mode u8 (absent: 0)   device answers SLOT_DATA (69): from offset, mode 0 the slot's
//                                                    patch binary as stored (pattern 1, songs and links, links not
//                                                    resolved), mode 1 the patch with every linked pattern inside and no
//                                                    links, as firmware before 1.26 reads it (offset 0 borrows the running
//                                                    patch, which the FM-1 takes back after the last chunk, another
//                                                    command or 2 s: read the chunks back to back) (INFO byte 25 bit 2)
//   10 CHUNK    seq u8, offset u16, total u16, data  a piece of the binary patch (patchbin.ts), in order; ACK each
//   11 COMMIT   total u16, crc16 u16                 check the assembled patch and switch to it; ACK
//   12 STORE    -                                    write the current patch to flash; ACK
//   13 SLOT     slot u8, name 20 bytes (ASCII, zero padded), total u16, crc16 u16   the uploaded chunks into preset slot n (0..31) of the
//                                                    flash bank, without loading them; ACK (3 = not a valid patch)
//   14 SLOT_ERASE  slot u8                           empty a slot; ACK
//   15 SLOT_INFO   slot u8                           device answers SLOT_INFO (42)
//   1C MAP      count u8, then per MIDI mapping source u8, module u8, param u8, low u8, high u8 (patchbin.ts mapRecord;
//                                                    source: CC 0..119, 127 pitch bend, 128 + n note n)
//                                                    the running patch's MIDI learn mappings (#1067, feature bit 28), all
//                                                    of them, in place of its own; no reply
//   1D PADS     -                                    read the global pad map (#1067 follow-up, feature bit 29); answers PADS_NOW
//               row u8 (0..23), note u8              that drum row's outside pad: note 0..127, 0xFF none; a note another
//                                                    row holds leaves that row (one pad per row, one row per pad)
//               FE                                   clear every row
//               FD, on u8                            PAD MAP off (0) or on (1)
//                                                    every form answers PADS_NOW
//   1E PALETTE  op u8, …                             the palette (#1196, feature bit 31; ENTRY bytes: encodePaletteEntry):
//               00 GET                               answers PALETTE_NOW; from then on the FM-1 sends it unasked too
//               01 ENTRY_GET, pos u8                 answers PALETTE_ENTRY
//               02 PUT, pos u8, ENTRY (none: empty)  ACK (seq = pos; 8 = the slot does not hold that name), then PALETTE_NOW
//               03 ORDER, from[8]                    new position i takes old position from[i] (0xFF empty); ACK, PALETTE_NOW
//               04 GO, pos u8 (0xFF cancel)          switch (stopped: at once, playing: at the bar line); ACK (seq = pos;
//                                                    6 empty, 8 MISSING, 5 sandbox; aux 0 now, 1 waiting, 2 cancelled)
//               05 NAME, name[20]                    the name of the patch uploaded under Live, for a hold-save; no reply
//   1F FONT     op u8, then                          the font area (#602, INFO byte 20 bit 0; firmware/src/font_area.c):
//               1                                    BEGIN: its header erased (the FM-1 draws the small type until COMMIT)
//               2, sector u8, offset u16, 1..256 bytes   WRITE inside one page (offset 0 of sectors 1.. erases it first)
//               3, sector u8                         SUM: answers FONT_SUM
//               4, the image's 64-byte header        COMMIT: only this firmware's font, its CRC-32 checked first
//                                                    BEGIN, WRITE, COMMIT answer ACK (command 1F, op, status, sector)
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
//   2A TRACK    module u8, n u8, n u32 LE words, [pattern u8]   a Steps module's notes, all of them (track.ts noteWords,
//                                                    sorted, at most TRACK_NOTES_MAX), of that pattern (0-based; format 48,
//                                                    without it: the one the track plays); no reply. Feature bit 5.
//   36 PATTERN  pattern u8, song u8                  the patch's pattern (0-based) and the song playing (0 none): each track
//                                                    takes them at the end of its pass (stopped: at once), into the running
//                                                    patch; no reply. Format 48 (INFO's highest readable format)
//   37 SONG     song u8 (0-based), n u8, n (pattern u8, shift i8)   a song's entries, into the running patch; no reply.
//                                                    Format 48
//   38 TEMPO    mode u8 (0 global, 1 patch), bpm u16 (0: the global tempo stays), meter u8   GLO > PANEL > TEMPO, the global
//                                                    tempo (D-907, tempo.ts) and the time signature (#1011, modules.ts METERS
//                                                    index); no reply. Feature bit 16. Firmware before #1011 takes the first
//                                                    3 bytes and ignores the 4th, so the editor always sends it
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
//   3B PATS     (none)                               the FM-1's pattern store (#901, feature bit 25): one PAT (5B) per entry, the
//                                                    user's in id order (firmware before 1.26: then its read-only factory ones)
//   3C PAT_GET  id u16, offset u16                   device answers PAT_DATA (5C): the payload from offset, 256 bytes at most
//   3D PAT_PUT  id u16 (0 new), total u16, offset u16, name 16 bytes, then up to 256 payload bytes (pattern-store.ts)
//                                                    the chunks gather on the FM-1 (offset 0 starts a put); each chunk but the
//                                                    last answers PAT_STORED with id 0xFFFF, the last stores it and answers
//                                                    PAT_STORED with its id. A rename is a put of the same id and payload.
//                                                    total bit 15 in every chunk (PAT_KEPT, a new entry, #1202 P1): store it
//                                                    as a kept copy, which the FM-1 never frees and never writes over; the
//                                                    low 15 bits are the total. Firmware before 1.26 refuses it (S_RANGE)
//   3E PAT_DEL  id u16, force u8                     delete it; PAT_STORED. Without force, an id the bank's patches link
//                                                    answers S_USED with how many slots link it
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
//   55 TEMPO_NOW  mode u8 (0 global, 1 patch), bpm u16 (0: not known yet), meter u8   after INFO (the answer to HELLO), and
//                                                    unasked when the FM-1 changed the setting, the global tempo (its menu, PLAY
//                                                    held + PRESET, Main's tempo row while global) or TIME SIG. Feature bit 16.
//                                                    Firmware before #1011 sends 3 bytes (it plays 4/4)
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
//   5B PAT      k u16, count u16 (0: no entries, nothing follows), id u16, len u16, hash u32, layout u32, tracks u8, flags u8
//               (bit0 read-only, which no 1.26 entry is; bit1 a kept copy, INFO byte 25 bit 2), name 16 bytes   one entry of
//                                                    the pattern store (an answer to PATS)
//   5C PAT_DATA  id u16, total u16 (0xFFFF: no such id), offset u16, then the payload's bytes from offset (256 at most)
//   5D PAT_STORED  id u16 (0xFFFF: a chunk taken), status u8 (PAT_STATUS), count u8 (with S_USED: the slots that link it)
//   5E PAT_LINK_NOW  pattern u8, id u16 (0 none), hash u32   unasked: the running patch's link of that pattern changed on
//                                                    the FM-1 (its SEQ page loaded, saved or saved as new; SAVE wrote it)
//   63 MAP_NOW  count u8, then the mappings as MAP has them, then optionally src u8, k u8, k CC numbers
//                                                    unasked: the running patch's MIDI learn mappings after a learn or a
//                                                    clear on the FM-1 (GLO > MIDI 3/4, HOME + SEL, #1067, feature bit
//                                                    28). The tail follows only a learn during which the same input also
//                                                    sent fixed-job CCs (16..19, 1, 2, 22, 64, 65): the learned source
//                                                    byte and those CCs, the "also sent" warning; older firmware sends none
//   64 PADS_NOW  on u8, then 24 note bytes (0xFF none)   the global pad map: PAD MAP on, and per drum row 1..24 the MIDI note
//                                                    of the outside pad that plays it (feature bit 29). The answer to every
//                                                    PADS (the editor reads it after connect), and unasked when the map
//                                                    changes on the FM-1 (a learn, a clear, PAD MAP turned)
//   65 PATTERN_OP  op u8, from u8, to u8, hash u32   unasked (feature bit 30, #1177, #1178): the FM-1's SEQ page ran a
//                                                    pattern command, which the editor runs on its patch too (pattern-ops.ts):
//                                                    op 1 pattern `from` of every track copied to `to` (SEQ held + SAVE), op 2
//                                                    every pattern and song cleared (SEQ held + HOME); hash 0 for both; op
//                                                    4 pattern `from` of every track doubled (SEQ held + OCT+, D-838), to 0.
//                                                    Op 3 is retired (the editor ignores it)
//   66 PALETTE_NOW  version u8 (1), cur u8, next u8 (0xFF none), flags u8 (bit0 edited), seq u16, then 8 × {state u8 (0
//                                                    empty, 1 ok, 2 missing), slot u8, pattern u8, hash u16 (the entry's
//                                                    CRC-16), len u16 (the slot's binary now), name[20]}: the answer to GET,
//                                                    and unasked after any change once the editor sent GET
//   67 PALETTE_ENTRY  pos u8, then the ENTRY bytes (none: empty)   the answer to ENTRY_GET
//   68 FONT_SUM  sector u8, ok u8, CRC-16 u16          the CRC-16 of a sector of the font area (#602): the install skips one
//                                                    that holds its bytes already
//   69 SLOT_DATA  slot u8, total u16, offset u16, then the slot's binary from offset (256 bytes at most): the answer to
//                                                    SLOT_GET. total 0xFFFF: the slot is empty, out of range or unreadable;
//                                                    mode 1 only: 0xFFFE the patch with every pattern inside passes 3,840
//                                                    bytes, 0xFFFD the running patch has unsaved edits, the editor's Live
//                                                    holds it or a palette switch waits, 0xFFFC the transport runs
//   41 INFO     version, max modules, max cables, flags (bit0 flash ok, bit1 patch loaded, bit2 MENU > MIDI OUT on: with
//               feature bit 8, bit3 GLO > SYSTEM > EDITOR at IGNORE: with feature bit 19, #702), delay lines, [features: bit1 TRANSPORT, bit2 MUTE, bit4 FOCUS / PARAM_NOW / FOCUS_NOW,
//               bit5 TRACK / TRACK_NOW, bit6 LIVE, bit7 presets], [features 8..15: bit8 sandbox mode, bit9 the device
//               test mode, bit10 TEST_PEAK reads before MASTER, bits11..15 read patch formats35..39],
//               [minimum readable patch format, maximum readable patch format], [firmware major, minor, patch:
//               0.0.0 a dev or CI build; #216, absent from firmware before 1.8],
//               [features 16..23: bit16 TEMPO / TEMPO_NOW, bit17 a preset carries up to 176 values, bit18 KEYS_NOW /
//               GUIDE_NOW, bit19 flags bit3 says EDITOR, bit20 ARMS, bit21 ARMS wide, bit22 DEVICE_SETTINGS, bit23 PATTERN_ORIGIN],
//               [byte13 allocation rule: 0 separate signal buffers, 1 physical lifetime buffers; unknown/missing means 0],
//               [features 24..31: bit24 FX presets, bit25 the pattern store is on, bit28 MAP / MAP_NOW, bit29 PADS / PADS_NOW, bit30 PATTERN_OP, bit31 PALETTE],
//               [byte15 the bank's slots (absent: 64; 60 with the pattern store before 1.26; 48 from 1.26, or 60 on a 1.26
//               FM-1 that kept the older layout because it holds more than 48 patches)],
//               [bytes16..19 the pattern store's bytes free and in all, u16 LE each],
//               [byte20 the font area (#602): bit0 the firmware reads its type's larger sizes from it (FONT), bit1 the FM-1
//               has that font, bit2 an install began and did not commit, bit3 no room for it yet (the bank holds more than
//               48 patches: FONT BEGIN answers status 10); bytes21..24 the font's id, u32 LE],
//               [byte25 features from 1.26 on: bit0 a card holding its Steps track is that track's device (#1202 K2),
//               bit1 every pattern 2..64 lives in the pattern store (#1202: SAVE stores and links them, the editor sends
//               them as stored entries), bit2 SLOT_GET and PAT's kept flag (#1202 G8)]. Also unasked
//               after a LIVE when MIDI OUT changed since the editor last heard (feature bit 8), and when EDITOR changed after
//               a HELLO (feature bit 19)
//   40 ACK      command, seq, status, aux            status 0 ok, 1 bad offset/size, 2 CRC, 3 load error (aux = code),
//                                                    4 flash error, 5 unknown command, 6 nothing to store

import { meterOf } from './modules';
import { ARM_WORDS, type Range } from './patch';
import { noteWords, PATTERNS_MAX, SHIFT_MAX, SONG_LEN_MAX, SONGS_MAX, TRACK_NOTES_MAX, wordsNotes, type SongEntry, type StepNote } from './track';

export const PREFIX = [0x7d, 0x4d, 0x31];
export const CMD = { hello: 0x01, chunk: 0x10, commit: 0x11, store: 0x12, param: 0x20, att: 0x21, bypass: 0x22, range: 0x23, transport: 0x25, mute: 0x27, focus: 0x29, track: 0x2a, diag: 0x2b, live: 0x2c, slot: 0x13, slotErase: 0x14, slotInfo: 0x15, ack: 0x40, info: 0x41, slotReply: 0x42, slotNow: 0x43, muteNow: 0x45, paramNow: 0x47, focusNow: 0x48, trackNow: 0x49, diagReply: 0x4b, presets: 0x2d, presetGet: 0x2e, presetPut: 0x2f, presetDel: 0x30, sandbox: 0x31, preset: 0x4c, presetData: 0x4d, presetStored: 0x4e, testKey: 0x32, testTurn: 0x33, testScreen: 0x34, testPeak: 0x35, screen: 0x50, peak: 0x51, pattern: 0x36, song: 0x37, patternNow: 0x52, songNow: 0x53, armsNow: 0x54, arms: 0x39, tempo: 0x38, tempoNow: 0x55, locksNow: 0x56, keysNow: 0x57, guideNow: 0x58, deviceSettings: 0x3a, deviceSettingsReply: 0x59, originNow: 0x5a, pats: 0x3b, pat: 0x5b, patGet: 0x3c, patData: 0x5c, patPut: 0x3d, patStored: 0x5d, patDel: 0x3e, patLinkNow: 0x5e, slotGet: 0x02, slotData: 0x69 } as const; // diag: bring-up diagnostics (tools/m1_link.py diag; the editor does not use it)
export const PROTO_VERSION = 1;
export const CHUNK_BYTES = 384;
export const STATUS_TEXT = ['ok', 'bad offset or size', 'checksum mismatch', 'the firmware refused the patch', 'flash error', 'unknown command', 'nothing to store', 'the preset store is full', 'no such preset', 'still in use', 'the bank holds more than 48 patches'];

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

/** the most slots a bank has: an FM-1 whose pattern store is on has fewer (INFO byte 15, slotCount) */
export const SLOTS_MAX = 64;
/** the bank of firmware 1.26 (#1202, G3): 48 slots. The offline copy of the bank takes no more new entries than this */
export const BANK_SLOTS = 48;
/** the slots of the FM-1's bank (INFO byte 15: 48 from 1.26, 60 with the pattern store before it or on a 1.26 FM-1 that
 *  kept that layout, #901, #1202); firmware that does not say has SLOTS_MAX */
export const slotCount = (info: Info | null): number => info?.slots ?? SLOTS_MAX;
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
/** SLOT_GET's modes: the binary as stored, or with every linked pattern inside and no links (what firmware before 1.26 reads) */
export const SLOT_STORED = 0, SLOT_INLINE = 1;
export const slotGetFrame = (slot: number, offset: number, mode = SLOT_STORED): Uint8Array => frame(CMD.slotGet, [slot, offset & 0xff, (offset >> 8) & 0xff, mode]);
/** why a SLOT_GET sends no binary, by SLOT_DATA's total: the slot is empty (or unreadable), and with SLOT_INLINE the patch
 *  is too big with every pattern inside, the FM-1's running patch is edited (or Live holds it, or a palette switch waits),
 *  or its transport runs */
export type SlotRefusal = 'empty' | 'too big' | 'edited' | 'running';
const SLOT_REFUSALS: Record<number, SlotRefusal> = { 0xffff: 'empty', 0xfffe: 'too big', 0xfffd: 'edited', 0xfffc: 'running' };
/** a SLOT_DATA: the slot, the binary's whole length (or why there is none), the offset and the bytes from it */
export function parseSlotData(p: Parsed): { slot: number; total: number | SlotRefusal; offset: number; bytes: number[] } | null {
  const x = p.payload;
  if (p.cmd !== CMD.slotData || x.length < 5) return null;
  const total = x[1] | (x[2] << 8);
  return { slot: x[0], total: SLOT_REFUSALS[total] ?? total, offset: x[3] | (x[4] << 8), bytes: x.slice(5) };
}
/** a slot's patch binary (`mode`: SLOT_STORED or SLOT_INLINE), read with SLOT_GET in pieces over `ask` (a request that
 *  resends until an answer matches), the chunks back to back; or why the FM-1 sends none. Firmware with FEATURE25_SLOT_GET
 *  only */
export async function readSlotBinary(ask: (frame: Uint8Array, match: (p: Parsed | null) => boolean) => Promise<Parsed>, slot: number, mode = SLOT_STORED): Promise<Uint8Array | SlotRefusal> {
  const out: number[] = [];
  let total = Infinity;
  while (out.length < total) {
    const at = out.length;
    const d = parseSlotData(await ask(slotGetFrame(slot, at, mode), (x) => { const r = x && parseSlotData(x); return !!r && r.slot === slot && (typeof r.total === 'string' || r.offset === at); }))!;
    if (typeof d.total === 'string') return d.total;
    if (!d.bytes.length && at < d.total) throw new Error(`the FM-1 sent slot ${slotLabel(slot)} short`);
    total = d.total;
    out.push(...d.bytes);
  }
  return Uint8Array.from(out.slice(0, total));
}

export const attFrame = (module: number, input: number, q16: number): Uint8Array => {
  const v = q16 | 0;
  return frame(CMD.att, [module, input, v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff]);
};

export const bypassFrame = (module: number, on: boolean): Uint8Array => frame(CMD.bypass, [module, on ? 1 : 0]);
/** a Steps module's notes (all of them, as words: noteWords), of pattern `pat` (0-based; format 48: absent, the one the
 * track plays) */
export function trackFrame(module: number, notes: readonly StepNote[] | undefined, pat?: number): Uint8Array {
  const w = noteWords(notes).slice(0, TRACK_NOTES_MAX);
  return frame(CMD.track, [module, w.length, ...w.flatMap((x) => [x & 0xff, (x >>> 8) & 0xff, (x >>> 16) & 0xff, x >>> 24]), ...(pat === undefined ? [] : [pat & 0xff])]);
}
/** a TRACK / TRACK_NOW payload's notes and pattern (absent: an older firmware's, the track's only one: 0) */
export function parseTrack(payload: number[]): { module: number; notes: StepNote[]; pat: number } | null {
  if (payload.length < 2 || payload.length < 2 + 4 * payload[1]) return null;
  const notes = wordsNotes(Array.from({ length: payload[1] }, (_, j) => (payload[2 + 4 * j] | (payload[3 + 4 * j] << 8) | (payload[4 + 4 * j] << 16) | (payload[5 + 4 * j] << 24)) >>> 0));
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
/** GLO > PANEL > TEMPO (global: true), the global tempo (whole bpm; 0 leaves it) and the time signature (a METERS index,
 *  #1011) */
export const tempoFrame = (global: boolean, bpm: number, meter: number): Uint8Array => {
  const b = Math.max(0, Math.min(0xffff, Math.round(bpm)));
  return frame(CMD.tempo, [global ? 0 : 1, b & 0xff, b >> 8, meterOf(meter)]);
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
/** a TEMPO_NOW payload: the FM-1's setting and global tempo (bpm 0: not known yet), and its time signature when the
 *  firmware sends one (#1011; older firmware: none, the editor keeps its own) */
export const parseTempoNow = (payload: number[]): { global: boolean; bpm: number; meter?: number } | null =>
  payload.length < 3 ? null : payload.length >= 4 ? { global: payload[0] === 0, bpm: payload[1] | (payload[2] << 8), meter: meterOf(payload[3]) }
    : { global: payload[0] === 0, bpm: payload[1] | (payload[2] << 8) };
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
  /** the bank's slots (INFO byte 15, #901); absent from firmware before the pattern store: SLOTS_MAX */
  slots?: number;
  /** the pattern store's payload bytes free and in all (INFO bytes 16..19, #901); absent before it */
  store?: { free: number; total: number };
  /** the font area (INFO bytes 20..24, #602): the font this firmware needs (`id`, the image's CRC-32), whether the FM-1
   *  has it, whether an install began and did not commit, and whether it has no room for it yet (`blocked`: the bank
   *  holds more than 48 patches, whose sectors the font needs); absent from firmware with its type compiled in (1.25 and
   *  older) */
  font?: { valid: boolean; writing: boolean; blocked: boolean; id: number };
  /** INFO byte 25, the feature bits from 1.26 on (bytes 20..24 are the font area's, #1203): FEATURE25_TRACK_CARD,
   *  FEATURE25_PATTERNS_STORED; 0 from firmware that sends fewer bytes */
  features25: number;
}
/** INFO byte 25 bit 0 (#1202 K2, D-1062): a top-level card with a Steps track inside is that track's device (SEQ, the
 *  environment, P-locks, SEL); the editor sends a patch with such a card only to firmware with it (pages.ts holdsTrackCard) */
export const FEATURE25_TRACK_CARD = 1;
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
/** INFO feature bit 25 (byte 14 bit 1, #901): the pattern store is on (PATS, PAT_GET, PAT_PUT, PAT_DEL, PAT_LINK_NOW and
 *  format 59's links section) */
export const FEATURE_PATTERN_STORE = 1 << 25;
/** INFO byte 25 bit 1 (Info.features25; 1.26, #1202): every pattern 2..64 lives in the pattern store. SAVE on the FM-1
 *  stores and links each one with content, the editor sends each as a stored entry (device.ts) and counts only pattern 1,
 *  the songs and the links against the patch's bytes (patchbin.ts LinkStore 'every') */
export const FEATURE25_PATTERNS_STORED = 2;
/** INFO byte 25 bit 2 (1.26, #1202 G8): SLOT_GET reads a slot's binary back, and PAT's flags bit 1 marks a kept copy (the
 *  Flash tab's backup before older firmware takes every slot and kept copy from the FM-1 itself) */
export const FEATURE25_SLOT_GET = 4;
/** INFO feature bit 26 (byte 14 bit 2, #915, D-490): the factory region's commands (firmware/src/factory.c) */
export const FEATURE_FACTORY = 1 << 26;
/** INFO feature bit 27 (byte 14 bit 3, #1107): MASTER_EQ, the FM-1's master EQ (GLO › EQ) over the link */
export const FEATURE_MASTER_EQ = 1 << 27;
/** MASTER_EQ and its answer (firmware/src/proto.c C_MASTER_EQ, main.c m1_master_eq) */
export const MASTER_EQ = { cmd: 0x1b, reply: 0x62 } as const;
/** the master EQ's gains go to ±this many decibels in half-decibel steps; MID FREQ is one of MASTER_EQ_FREQS sixths of an
 *  octave from 100 Hz (firmware/src/master_eq.h MEQ_GAIN_MAX, MEQ_FREQS) */
export const MASTER_EQ_DB = 12;
export const MASTER_EQ_FREQS = 39;
/** MID FREQ's default: 1 kHz (master_eq.h MEQ_FREQ_DEFAULT) */
export const MASTER_EQ_FREQ_DEFAULT = 20;
/** the master EQ: LOW, MID and HIGH in decibels (half-decibel steps), MID FREQ as its index (masterEqHz) */
export interface MasterEq { low: number; mid: number; high: number; freq: number }
/** MID FREQ's index in Hz: 100 × 2^(index / 6) */
export const masterEqHz = (i: number): number => 100 * 2 ** (i / 6);
/** MASTER_EQ: empty reads; the four bytes (gains in half decibels, two's complement) set */
export function masterEqFrame(eq?: MasterEq): Uint8Array {
  if (!eq) return frame(MASTER_EQ.cmd);
  const half = [eq.low, eq.mid, eq.high].map((db) => {
    const h = db * 2;
    if (!Number.isInteger(h) || Math.abs(h) > 2 * MASTER_EQ_DB) throw new Error(`A master EQ gain goes from -${MASTER_EQ_DB} to +${MASTER_EQ_DB} dB in half-decibel steps.`);
    return h & 0xff;
  });
  if (!Number.isInteger(eq.freq) || eq.freq < 0 || eq.freq >= MASTER_EQ_FREQS) throw new Error('MID FREQ goes from 100 Hz to 8 kHz.');
  return frame(MASTER_EQ.cmd, [...half, eq.freq]);
}
/** MASTER_EQ's answer: status (0 ok, 1 refused), then the master EQ as it is */
export function parseMasterEq(p: Parsed | null): MasterEq {
  if (p?.cmd !== MASTER_EQ.reply || p.payload.length !== 5) throw new Error('The FM-1 sent an incomplete master EQ reply.');
  if (p.payload[0]) throw new Error('The FM-1 could not use that master EQ setting.');
  const db = (b: number): number => ((b << 24) >> 24) / 2;
  return { low: db(p.payload[1]), mid: db(p.payload[2]), high: db(p.payload[3]), freq: p.payload[4] };
}
/** INFO feature bit 28 (byte 14 bit 4, #1067): MIDI learn on the FM-1, MAP and MAP_NOW (firmware/src/midi_learn.c) */
export const FEATURE_MAP = 1 << 28;
/** MIDI learn's command and report (#1067) */
export const MAP_CMD = { map: 0x1c, mapNow: 0x63 } as const;
/** MAP: the running patch's mappings, the section patchbin.ts mapRecord writes ([] none) */
export const mapFrame = (record: number[]): Uint8Array => frame(MAP_CMD.map, record.length ? record : [0]);
/** a MIDI mapping in device form (source byte: patchbin.ts mapSource; module and parameter indices; ends 0..255) */
export interface MapEntry { src: number; module: number; param: number; lo: number; hi: number }
/** a MAP_NOW payload: the mappings, and the "also sent" tail when there is one (the learned source byte and the fixed-job
 *  CCs its input also sent during the learn) */
export function parseMapNow(payload: number[]): { maps: MapEntry[]; also: { src: number; ccs: number[] } | null } | null {
  const n = payload[0];
  if (n === undefined || payload.length < 1 + 5 * n) return null;
  const maps = Array.from({ length: n }, (_, i) => {
    const [src, module, param, lo, hi] = payload.slice(1 + 5 * i, 6 + 5 * i);
    return { src, module, param, lo, hi };
  });
  const at = 1 + 5 * n, k = payload[at + 1];
  return { maps, also: k && payload.length >= at + 2 + k ? { src: payload[at], ccs: payload.slice(at + 2, at + 2 + k) } : null };
}
/** INFO feature bit 29 (byte 14 bit 5, #1067 follow-up): the global pad map, PADS and PADS_NOW */
export const FEATURE_PADS = 1 << 29;
/** the global pad map's command and report */
export const PADS_CMD = { pads: 0x1d, padsNow: 0x64 } as const;
/** the drum rows the pad map holds a pad for (the rows the FM-1's keys reach, 1..24) */
export const PAD_ROWS = 24;
/** PADS with nothing: read the map */
export const padsReadFrame = (): Uint8Array => frame(PADS_CMD.pads, []);
/** PADS: row 0..23's pad, a MIDI note 0..127, null none */
export const padsSetFrame = (row: number, note: number | null): Uint8Array => frame(PADS_CMD.pads, [row & 0xff, note === null ? 0xff : note & 0x7f]);
/** PADS: clear every row */
export const padsClearAllFrame = (): Uint8Array => frame(PADS_CMD.pads, [0xfe]);
/** PADS: PAD MAP off or on */
export const padsOnFrame = (on: boolean): Uint8Array => frame(PADS_CMD.pads, [0xfd, on ? 1 : 0]);
/** the global pad map: PAD MAP on, and per drum row the pad's MIDI note (null none) */
export interface PadMap { on: boolean; notes: (number | null)[] }
/** a PADS_NOW payload, null when short */
export function parsePadsNow(payload: number[]): PadMap | null {
  if (payload.length < 1 + PAD_ROWS) return null;
  return { on: payload[0] !== 0, notes: payload.slice(1, 1 + PAD_ROWS).map((n) => (n > 127 ? null : n)) };
}
/** INFO feature bit 30 (byte 14 bit 6, #1177, #1178): the FM-1 reports the SEQ page's pattern commands (PATTERN_OP) */
export const FEATURE_PATTERN_OP = 1 << 30;
/** PATTERN_OP's id and ops */
export const PATTERN_OP = { report: 0x65, copy: 1, clearAll: 2, double: 4 } as const;
/** a PATTERN_OP payload, null when short */
export function parsePatternOp(payload: number[]): { op: number; from: number; to: number; hash: number } | null {
  if (payload.length < 7) return null;
  return { op: payload[0], from: payload[1], to: payload[2], hash: (payload[3] | (payload[4] << 8) | (payload[5] << 16) | (payload[6] << 24)) >>> 0 };
}
/** the notes once row `row` takes `note` (null clears it), as the FM-1 does it: a row that held that note lets go of it */
export function withPad(notes: readonly (number | null)[], row: number, note: number | null): (number | null)[] {
  return notes.map((n, i) => (i === row ? note : note !== null && n === note ? null : n));
}
/** the factory region's commands and answers (#915, D-490) */
export const FACT = { begin: 0x16, write: 0x17, sum: 0x18, read: 0x19, commit: 0x1a, info: 0x3f, infoReply: 0x5f, sumReply: 0x60, dataReply: 0x61 } as const;
export const FACT_SIZE = 18 * 0x1000;
export const FACT_HEADER = 64;
/** FACT_INFO: the region's state (0 none: the firmware tier alone plays, 1 valid, 2 newer than the firmware reads, 3
 *  damaged), the layout the firmware reads, the region header's layout, format, content version, factory set, body length
 *  and patches, flags (writing; the tier alone plays), the region's size, the newest patch format the firmware plays, the
 *  firmware tier's content version and patches, the factory patches in all (the tier and the region merged) */
export interface FactoryInfo {
  state: number; reads: number; layout: number; format: number; version: number; set: number; len: number; patches: number;
  writing: boolean; tierOnly: boolean; size: number; plays: number; tierVersion: number; tierPatches: number; merged: number;
}
export function parseFactoryInfo(p: Parsed): FactoryInfo | null {
  const b = p.payload;
  if (p.cmd !== FACT.infoReply || b.length < 26) return null;
  const u16 = (i: number): number => b[i] | b[i + 1] << 8, u32 = (i: number): number => (u16(i) | u16(i + 2) << 16) >>> 0;
  return {
    state: b[0], reads: b[1], layout: b[2], format: b[3], version: u16(4), set: u32(6), len: u32(10), patches: u16(14),
    writing: !!(b[16] & 1), tierOnly: !!(b[16] & 2), size: u32(17), plays: b[21], tierVersion: u16(22), tierPatches: b[24], merged: b[25],
  };
}
export const factBeginFrame = (): Uint8Array => frame(FACT.begin);
export const factInfoFrame = (): Uint8Array => frame(FACT.info);
export const factSumFrame = (sector: number): Uint8Array => frame(FACT.sum, [sector]);
/** n bytes (1..256) at offset `off` of sector `sector`, inside one page: offset 0 erases the sector first */
export const factWriteFrame = (sector: number, off: number, bytes: ArrayLike<number>): Uint8Array =>
  frame(FACT.write, [sector, off & 0xff, off >> 8, ...Array.from(bytes)]);
export const factReadFrame = (off: number, n: number): Uint8Array => frame(FACT.read, [off & 0xff, off >> 8 & 0xff, off >> 16 & 0xff, off >>> 24, n]);
export const factCommitFrame = (image: Uint8Array): Uint8Array => frame(FACT.commit, image.subarray(0, FACT_HEADER));
/** the font area's command, its ops and its SUM answer (#602, firmware/src/font_area.c); the image's header is 64 bytes */
export const FONT = { cmd: 0x1f, sumReply: 0x68, begin: 1, write: 2, sum: 3, commit: 4 } as const;
export const fontBeginFrame = (): Uint8Array => frame(FONT.cmd, [FONT.begin]);
export const fontSumFrame = (sector: number): Uint8Array => frame(FONT.cmd, [FONT.sum, sector]);
/** n bytes (1..256) at offset `off` of the image's sector `sector`, inside one page: offset 0 erases the sector first */
export const fontWriteFrame = (sector: number, off: number, bytes: ArrayLike<number>): Uint8Array =>
  frame(FONT.cmd, [FONT.write, sector, off & 0xff, off >> 8, ...Array.from(bytes)]);
export const fontCommitFrame = (image: Uint8Array): Uint8Array => frame(FONT.cmd, [FONT.commit, ...image.subarray(0, FACT_HEADER)]);
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
    features25: p.payload[25] ?? 0,
    ...(p.payload.length >= 14 ? { bufferAllocation: p.payload[13] } : {}),
    midiOut: features & FEATURE_SANDBOX ? !!(p.payload[3] & 4) : null,
    editorIgnored: !!(features & FEATURE_EDITOR_SETTING) && !!(p.payload[3] & INFO_EDITOR_IGNORE),
    ...(p.payload.length >= 9 ? { patchFormats: { min: p.payload[7], max: p.payload[8] } } : {}),
    ...(p.payload.length >= 12 ? { firmware: { major: p.payload[9], minor: p.payload[10], patch: p.payload[11] } } : {}),
    ...(p.payload.length >= 16 && p.payload[15] ? { slots: p.payload[15] } : {}),
    ...(p.payload.length >= 20 ? { store: { free: p.payload[16] | (p.payload[17] << 8), total: p.payload[18] | (p.payload[19] << 8) } } : {}),
    ...(p.payload.length >= 25 && p.payload[20] & 1 ? { font: { valid: !!(p.payload[20] & 2), writing: !!(p.payload[20] & 4),
      blocked: !!(p.payload[20] & 8), id: (p.payload[21] | p.payload[22] << 8 | p.payload[23] << 16 | p.payload[24] << 24) >>> 0 } } : {}) };
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

// ---- the pattern store (#901, feature bit 25): stored patterns by id (pattern-store.ts has the payload)

/** one entry of the store as PAT lists it: id, payload bytes, payload hash, layout fingerprint (0: no locks), tracks,
 *  read-only (a factory pattern, which only firmware before 1.26 lists), kept (a kept copy, which no patch links and the
 *  FM-1 never frees: FEATURE25_SLOT_GET firmware says so), name */
export interface StoredPatternEntry { id: number; len: number; hash: number; layout: number; tracks: number; readOnly: boolean; kept: boolean; name: string }
/** PAT_STORED's statuses (proto.c S_*) and what they mean for a stored pattern */
export const PAT_OK = 0, PAT_RANGE = 1, PAT_FLASH = 4, PAT_FULL = 7, PAT_MISSING = 8, PAT_USED = 9;
export const PAT_STATUS: Record<number, string> = { [PAT_OK]: 'ok', [PAT_RANGE]: 'refused (a read-only pattern, or out of range)', [PAT_FLASH]: 'flash error', [PAT_FULL]: 'the pattern store is full', [PAT_MISSING]: 'no such pattern', [PAT_USED]: 'patches use it' };
/** the payload bytes one PAT_GET / PAT_PUT carries at most */
export const PAT_CHUNK = 256;
const u16le = (v: number): number[] => [v & 0xff, (v >> 8) & 0xff];
const u32at = (p: number[], at: number): number => (p[at] | (p[at + 1] << 8) | (p[at + 2] << 16) | (p[at + 3] << 24)) >>> 0;
export const patsFrame = (): Uint8Array => frame(CMD.pats);
export const patGetFrame = (id: number, offset: number): Uint8Array => frame(CMD.patGet, [...u16le(id), ...u16le(offset)]);
/** total's bit 15 in PAT_PUT (#1202 P1): a new entry kept as a copy (Keep a copy, FX+SAVE on the FM-1), never freed by the
 *  FM-1's cleanup of unlinked entries and never written over by SAVE. Only for an FM-1 that stores every pattern
 *  (FEATURE25_PATTERNS_STORED): older firmware refuses it */
export const PAT_KEPT = 0x8000;
/** a payload as PAT_PUT chunks (`id` 0: a new entry; `kept`: as a kept copy, every chunk with PAT_KEPT); an empty payload
 *  is one chunk with nothing in it */
export function patPutFrames(id: number, name: string, payload: ArrayLike<number>, kept = false): Uint8Array[] {
  const key = Array.from({ length: 16 }, (_, i) => (name.charCodeAt(i) >= 32 && name.charCodeAt(i) < 127 ? name.charCodeAt(i) : 0));
  const total = payload.length | (kept ? PAT_KEPT : 0);
  const out: Uint8Array[] = [];
  for (let off = 0; off < payload.length || !out.length; off += PAT_CHUNK)
    out.push(frame(CMD.patPut, [...u16le(id), ...u16le(total), ...u16le(off), ...key, ...Array.from(payload).slice(off, off + PAT_CHUNK)]));
  return out;
}
export const patDelFrame = (id: number, force: boolean): Uint8Array => frame(CMD.patDel, [...u16le(id), force ? 1 : 0]);
/** a PAT: its place in the list, the list's length (count 0: the store is empty) and its entry (none then) */
export interface PatListItem { k: number; count: number; entry: StoredPatternEntry | null }
export function parsePatEntry(p: Parsed): PatListItem | null {
  const x = p.payload;
  if (p.cmd !== CMD.pat || x.length < 4) return null;
  const k = x[0] | (x[1] << 8), count = x[2] | (x[3] << 8);
  if (!count) return { k, count, entry: null };
  if (x.length < 34) return null;
  return { k, count, entry: { id: x[4] | (x[5] << 8), len: x[6] | (x[7] << 8), hash: u32at(x, 8), layout: u32at(x, 12), tracks: x[16], readOnly: !!(x[17] & 1), kept: !!(x[17] & 2),
    name: String.fromCharCode(...x.slice(18, 34).filter((c) => c >= 32 && c < 127)).trim() } };
}
/** a PAT_DATA: the id, the payload's whole length (null: no such id), the offset and the bytes from it */
export function parsePatData(p: Parsed): { id: number; total: number | null; offset: number; bytes: number[] } | null {
  const x = p.payload;
  if (p.cmd !== CMD.patData || x.length < 6) return null;
  const total = x[2] | (x[3] << 8);
  return { id: x[0] | (x[1] << 8), total: total === 0xffff ? null : total, offset: x[4] | (x[5] << 8), bytes: x.slice(6) };
}
/** a stored pattern's payload, read with PAT_GET in pieces over `ask` (a request that resends until an answer matches);
 *  null when the FM-1 has no such id. The editor link (device.ts) and the Install panel's link both read this way */
export async function readStoredPattern(ask: (frame: Uint8Array, match: (p: Parsed | null) => boolean) => Promise<Parsed>, id: number): Promise<Uint8Array | null> {
  const out: number[] = [];
  let total = Infinity;
  while (out.length < total) {
    const at = out.length;
    const d = parsePatData(await ask(patGetFrame(id, at), (x) => { const r = x && parsePatData(x); return !!r && r.id === id && (r.total === null || r.offset === at); }))!;
    if (d.total === null) return null;
    if (!d.bytes.length && at < d.total) throw new Error('the FM-1 sent the pattern short');
    total = d.total;
    out.push(...d.bytes);
  }
  return Uint8Array.from(out.slice(0, total));
}
export const parsePatStored = (p: Parsed): { id: number; status: number; count: number } | null =>
  p.cmd === CMD.patStored && p.payload.length >= 4 ? { id: p.payload[0] | (p.payload[1] << 8), status: p.payload[2], count: p.payload[3] } : null;
/** a PAT_LINK_NOW payload: the pattern index, the stored id it links now (0 none) and its payload hash */
export const parseLinkNow = (payload: number[]): { pattern: number; id: number; hash: number } | null =>
  payload.length >= 7 ? { pattern: payload[0], id: payload[1] | (payload[2] << 8), hash: u32at(payload, 3) } : null;

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
/** PEAK: the loudest sample since the last read and its flags; `usbFixed`: USB audio at the device test mode's fixed
 *  level, not MASTER's (#1170, DIAG page 100; false from a firmware before it) */
export const parsePeak = (p: Parsed): { peak: number; running: boolean; muted: boolean; masterDown: boolean; usbFixed: boolean } | null =>
  p.cmd === CMD.peak && p.payload.length >= 3
    ? { peak: p.payload[0] | (p.payload[1] << 8), running: !!(p.payload[2] & 1), muted: !!(p.payload[2] & 2), masterDown: !!(p.payload[2] & 4), usbFixed: !!(p.payload[2] & 8) }
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
/** the bytes of a GUIDE_NOW (firmware/src/help_ui.c GUIDE_BYTES): 15 since MIDI learn's condition (#1067), 14 before */
export const GUIDE_BYTES = 15;
const GUIDE_BYTES_OLD = 14;
/** the FM-1's panel state (GUIDE_NOW), or the FM-1 tab's copy's (fm1-ui.ts Fm1Ui.guide): the same bytes. `state` indexes
 *  controls.ts HELP_STATES; `conditions` bit c is controls.ts CONDITIONS[c - 1]; `raw` the bytes as sent */
export interface PanelState {
  state: number; page: number; stepRecord: boolean; liveTake: boolean; recording: boolean; sandbox: boolean;
  sheet: boolean; quickStart: boolean; everywhere: boolean; stepHeld: boolean;
  device: number; devicePage: number; track: number; menuTab: number; held: number; conditions: number;
  sheetRow: number; octave: number; cursor: number; raw: number[];
}
export function parseGuideNow(payload: ArrayLike<number>): PanelState | null {
  if (payload.length < GUIDE_BYTES_OLD) return null;
  const p = Array.from(payload).slice(0, GUIDE_BYTES);
  const f = p[2];
  return {
    state: p[0], page: p[1], stepRecord: !!(f & 1), liveTake: !!(f & 2), recording: !!(f & 4), sandbox: !!(f & 8),
    sheet: !!(f & 16), quickStart: !!(f & 32), everywhere: !!(f & 64), stepHeld: !!(f & 128),
    device: p[3], devicePage: p[4], track: p[5], menuTab: p[6], held: p[7] | (p[8] << 8), conditions: p[9] | (p[10] << 8) | ((p[14] ?? 0) << 16),
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

// ---- the palette (#1196, feature bit 31): 8 entries, each a bank slot checked by name, its devices' presets and a pattern

/** INFO feature bit 31 (byte 14 bit 7): the FM-1 keeps a palette (PALETTE, PALETTE_NOW, PALETTE_ENTRY). It is the sign
 *  bit: `features` is then negative, so test it with `hasPaletteFeature`, not `> 0` */
export const FEATURE_PALETTE = 1 << 31;
export const hasPaletteFeature = (features: number): boolean => ((features >>> 31) & 1) === 1;
/** the palette's command and replies, and PALETTE's ops */
export const PALETTE = { cmd: 0x1e, now: 0x66, entry: 0x67, get: 0, entryGet: 1, put: 2, order: 3, go: 4, name: 5 } as const;
/** the palette's positions */
export const PALETTE_SIZE = 8;
/** the devices with a preset one entry keeps at most (the FM-1's PAL_DEVS) */
export const PALETTE_DEVS = 12;
/** ACK statuses for PALETTE (proto.c S_*) and what they mean there */
export const PAL_OK = 0, PAL_RANGE = 1, PAL_FLASH = 4, PAL_REFUSED = 5, PAL_EMPTY = 6, PAL_MISSING = 8;
export const PAL_STATUS: Record<number, string> = {
  [PAL_OK]: 'ok', [PAL_RANGE]: 'refused (a bad position or entry)', [PAL_FLASH]: 'flash error', [PAL_REFUSED]: 'refused in sandbox mode',
  [PAL_EMPTY]: 'that position is empty', [PAL_MISSING]: 'that slot no longer holds the patch',
};
/** GO's ACK aux: switched at once (stopped), waiting for the bar line, the waiting switch cancelled */
export const PAL_GO_NOW = 0, PAL_GO_WAITING = 1, PAL_GO_CANCELLED = 2;
/** one device's preset in an entry: the device's index in the patch's device extras, its structure and the preset's
 *  namespace (0: not known, the FM-1 looks it up by name), and the preset's name (1..16 characters) */
export interface PaletteDevice { dev: number; structure: number; pstructure: number; name: string }
/** an entry: the slot (0..63), the pattern (0-based), the slot's patch name when saved, and the devices' presets */
export interface PaletteEntry { slot: number; pattern: number; name: string; devices: PaletteDevice[] }
/** a position as PALETTE_NOW lists it: 0 empty, 1 ok, 2 missing; hash: CRC-16 of the entry's bytes; len: the slot's
 *  binary length now (0 when missing or empty), for D-605 matching */
export interface PalettePos { state: 0 | 1 | 2; slot: number; pattern: number; hash: number; len: number; name: string }
/** PALETTE_NOW: the position playing and the one waiting for the bar line (null none), the running patch edited, the
 *  record's sequence number, the 8 positions */
export interface PaletteNow { version: number; cur: number | null; next: number | null; edited: boolean; seq: number; positions: PalettePos[] }

const nameBytes = (s: string, n: number): number[] =>
  Array.from({ length: n }, (_, i) => { const c = s.charCodeAt(i); return c >= 32 && c < 127 ? c : 0; });
const readName = (p: ArrayLike<number>, at: number, n: number): string => {
  const out: number[] = [];
  for (let i = 0; i < n && p[at + i]; i++) out.push(p[at + i]);
  return String.fromCharCode(...out.filter((c) => c >= 32 && c < 127));
};
const u32le = (v: number): number[] => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];

/** an entry's bytes, the same in the FM-1's flash and on the link: slot, pattern, name[20], ndev, then per device dev u8,
 *  structure u32, pstructure u32, nl u8, name[nl]. The name is written as given (callers pass deviceName); a preset name
 *  is cut to 16 printable characters, and devices past PALETTE_DEVS or without a name are left out */
export function encodePaletteEntry(e: PaletteEntry): number[] {
  const devs = e.devices.map((d) => ({ ...d, name: devicePresetName(d.name) })).filter((d) => d.name).slice(0, PALETTE_DEVS);
  const out = [e.slot & 0xff, e.pattern & 0xff, ...nameBytes(e.name, NAME_BYTES), devs.length];
  for (const d of devs) out.push(d.dev & 0xff, ...u32le(d.structure), ...u32le(d.pstructure), d.name.length, ...nameBytes(d.name, d.name.length));
  return out;
}
/** the entry from its bytes, null when malformed (short, too many devices, a name length out of 1..16) */
export function decodePaletteEntry(bytes: ArrayLike<number>): PaletteEntry | null {
  const b = Array.from(bytes);
  if (b.length < 23) return null;
  const n = b[22];
  if (n > PALETTE_DEVS) return null;
  const devices: PaletteDevice[] = [];
  let at = 23;
  for (let k = 0; k < n; k++) {
    if (at + 10 > b.length) return null;
    const nl = b[at + 9];
    if (nl < 1 || nl > PRESET_NAME_BYTES || at + 10 + nl > b.length) return null;
    devices.push({ dev: b[at], structure: u32at(b, at + 1), pstructure: u32at(b, at + 5), name: readName(b, at + 10, nl) });
    at += 10 + nl;
  }
  return { slot: b[0], pattern: b[1], name: readName(b, 2, NAME_BYTES), devices };
}
/** PALETTE_NOW's hash of an entry: CRC-16/CCITT-FALSE of its bytes */
export const paletteHash = (e: PaletteEntry): number => crc16(encodePaletteEntry(e));

export const paletteGetFrame = (): Uint8Array => frame(PALETTE.cmd, [PALETTE.get]);
export const paletteEntryGetFrame = (pos: number): Uint8Array => frame(PALETTE.cmd, [PALETTE.entryGet, pos]);
/** PUT: position `pos` takes the entry, or empties (null) */
export const palettePutFrame = (pos: number, e: PaletteEntry | null): Uint8Array =>
  frame(PALETTE.cmd, [PALETTE.put, pos, ...(e ? encodePaletteEntry(e) : [])]);
/** ORDER: new position i takes old position from[i] (null: empty) */
export function paletteOrderFrame(from: readonly (number | null)[]): Uint8Array {
  if (from.length !== PALETTE_SIZE) throw new Error(`ORDER takes ${PALETTE_SIZE} positions`);
  return frame(PALETTE.cmd, [PALETTE.order, ...from.map((f) => (f === null ? 0xff : f))]);
}
/** GO: switch to position `pos`, or cancel a waiting switch (null) */
export const paletteGoFrame = (pos: number | null): Uint8Array => frame(PALETTE.cmd, [PALETTE.go, pos === null ? 0xff : pos]);
/** NAME: the name of the patch the editor runs under Live (callers pass deviceName) */
export const paletteNameFrame = (name: string): Uint8Array => frame(PALETTE.cmd, [PALETTE.name, ...nameBytes(name, NAME_BYTES)]);

/** a PALETTE_NOW payload, null when short or of another version */
export function parsePaletteNow(p: number[]): PaletteNow | null {
  if (p.length < 6 + PALETTE_SIZE * 27 || p[0] !== 1) return null;
  const positions: PalettePos[] = [];
  for (let i = 0; i < PALETTE_SIZE; i++) {
    const at = 6 + i * 27;
    positions.push({ state: (p[at] <= 2 ? p[at] : 0) as 0 | 1 | 2, slot: p[at + 1], pattern: p[at + 2], hash: p[at + 3] | (p[at + 4] << 8), len: p[at + 5] | (p[at + 6] << 8), name: readName(p, at + 7, NAME_BYTES) });
  }
  const pos = (v: number): number | null => (v < PALETTE_SIZE ? v : null);
  return { version: p[0], cur: pos(p[1]), next: pos(p[2]), edited: !!(p[3] & 1), seq: p[4] | (p[5] << 8), positions };
}
/** a PALETTE_ENTRY payload: the position and its entry (null empty); null when malformed */
export function parsePaletteEntry(p: number[]): { pos: number; entry: PaletteEntry | null } | null {
  if (p.length < 1 || p[0] >= PALETTE_SIZE) return null;
  if (p.length === 1) return { pos: p[0], entry: null };
  const entry = decodePaletteEntry(p.slice(1));
  return entry ? { pos: p[0], entry } : null;
}
