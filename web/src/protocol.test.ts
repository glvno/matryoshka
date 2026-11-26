// SPDX-License-Identifier: GPL-3.0-only
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { editorSkips, parsePeak, parseScreen, testKeyFrame, testScreenFrame, testTurnFrame, fm1Ascii, parseInfo, parseSandbox, SANDBOX_BYTES, SANDBOX_EXT_BYTES, sandboxFrame, sandboxPayload, type SandboxPage, chunkFrames, CMD, commitFrame, crc16, devicePresetName, frame, LIVE_MS, liveFrame, MAP_CMD, pack7, paramFrame, parse, parseMapNow, parsePresetData, parsePresetEntry, parsePresetStored, parseSlot, presetPutFrame, slotEraseFrame, slotFrame, slotInfoFrame, unpack7 } from './protocol';
import { FEATURE25_TRACK_CARD, FEATURE_PADS, PADS_CMD, padsClearAllFrame, padsOnFrame, padsReadFrame, padsSetFrame, parsePadsNow, withPad } from './protocol';
import { decodePaletteEntry, encodePaletteEntry, FEATURE_PALETTE, hasPaletteFeature, PALETTE, PALETTE_DEVS, paletteEntryGetFrame, paletteGetFrame, paletteGoFrame, paletteHash, paletteNameFrame, paletteOrderFrame, palettePutFrame, parsePaletteEntry, parsePaletteNow, type PaletteEntry } from './protocol';

/** sandbox_msg.h's SB_* sizes, its #define expressions evaluated in order */
const SB: Record<string, number> = {};
for (const [, name, expr] of readFileSync(new URL('../../firmware/src/sandbox_msg.h', import.meta.url), 'utf8').matchAll(/^#define (SB_\w+) ([^/\n]+)/gm)) {
  SB[name] = Number(new Function(`return ${expr.replace(/(\d+)u\b/g, '$1').replace(/SB_\w+/g, (n) => String(SB[n]))}`)());
}

describe('SysEx protocol', () => {
  it('packs and unpacks every length without loss and with 7-bit bytes only', () => {
    for (let n = 0; n < 40; n++) {
      const b = Array.from({ length: n }, (_, i) => (i * 37 + 200) & 0xff);
      const p = pack7(b);
      expect(p.every((x) => x < 0x80)).toBe(true);
      expect(p.length).toBe(Math.ceil((8 * n) / 7));
      expect(unpack7(p)).toEqual(b);
    }
  });

  it('crc16 matches the CCITT-FALSE check value', () => {
    expect(crc16(Array.from('123456789', (c) => c.charCodeAt(0)))).toBe(0x29b1);
  });

  it('frames parse back and carry only 7-bit bytes between F0 and F7', () => {
    const f = frame(CMD.param, [1, 2, 255, 0, 128, 7]);
    expect(f[0]).toBe(0xf0);
    expect(f[f.length - 1]).toBe(0xf7);
    expect(Array.from(f.slice(1, -1)).every((x) => x < 0x80)).toBe(true);
    expect(parse(f)).toEqual({ cmd: CMD.param, payload: [1, 2, 255, 0, 128, 7] });
    expect(parse(Uint8Array.from([0xf0, 0x7d, 0x00, 0xf7]))).toBeNull();
  });

  it('splits a patch into in-order chunks that fit the firmware frame buffer (640 bytes)', () => {
    const patch = Uint8Array.from({ length: 1500 }, (_, i) => i & 0xff);
    const fr = chunkFrames(patch);
    expect(fr.length).toBe(4);
    let got: number[] = [];
    for (const f of fr) {
      expect(f.length - 2).toBeLessThanOrEqual(640);
      const p = parse(f)!;
      expect(p.cmd).toBe(CMD.chunk);
      expect(p.payload[1] | (p.payload[2] << 8)).toBe(got.length);
      expect(p.payload[3] | (p.payload[4] << 8)).toBe(1500);
      got = got.concat(p.payload.slice(5));
    }
    expect(got).toEqual(Array.from(patch));
    expect(parse(commitFrame(patch))!.payload).toEqual([1500 & 0xff, 1500 >> 8, crc16(patch) & 0xff, crc16(patch) >> 8]);
  });

  it('encodes parameter values as signed Q16.16 little endian', () => {
    expect(parse(paramFrame(3, 1, -65536))!.payload).toEqual([3, 1, 0, 0, 0xff, 0xff]);
  });

  it('LIVE (#185): no payload, often enough for the FM-1 to hold it (its LIVE_HOLD_MS is 5 s)', () => {
    const p = parse(liveFrame())!;
    expect(p.cmd).toBe(0x2c);
    expect(p.payload).toEqual([]);
    expect(LIVE_MS * 2).toBeLessThan(5000); // (a lost one does not let PRESET go)
  });

  it('builds the preset bank commands', () => {
    const patch = Uint8Array.from({ length: 200 }, (_, i) => i);
    const p = parse(slotFrame(5, '303 Acid', patch))!;
    expect(p.cmd).toBe(CMD.slot);
    expect(p.payload[0]).toBe(5);
    expect(String.fromCharCode(...p.payload.slice(1, 9))).toBe('303 Acid');
    expect(p.payload.slice(9, 21).every((x) => x === 0)).toBe(true); // zero padded to 20 bytes
    expect(p.payload.slice(21)).toEqual([200, 0, crc16(patch) & 0xff, crc16(patch) >> 8]);
    expect(parse(slotEraseFrame(7))!.payload).toEqual([7]);
    expect(parse(slotInfoFrame(31))!.payload).toEqual([31]);
    const reply = frame(CMD.slotReply, [5, 1, 200, 0, ...Array.from('KICK', (c) => c.charCodeAt(0)), ...new Array(16).fill(0)]);
    expect(parseSlot(parse(reply)!)).toEqual({ slot: 5, used: true, length: 200, name: 'KICK' });
  });
});

describe('presets on the FM-1 (#195)', () => {
  it('PRESET_PUT carries the key and Q16 values; PRESET_DATA and PRESET come back as the editor keeps them', () => {
    const put = parse(presetPutFrame('12345678', 'Glass', [1, -0.5, 6]))!;
    expect(put.cmd).toBe(CMD.presetPut);
    expect(put.payload.slice(0, 4)).toEqual([0x78, 0x56, 0x34, 0x12]);
    expect(String.fromCharCode(...put.payload.slice(4, 9))).toBe('Glass');
    expect(put.payload[20]).toBe(3);
    const data = { cmd: CMD.presetData, payload: [...put.payload.slice(0, 20), 3, ...put.payload.slice(21)] };
    expect(parsePresetData(data)).toEqual({ structure: '12345678', name: 'Glass', values: [1, -0.5, 6] });
    expect(parsePresetData({ cmd: CMD.presetData, payload: [...put.payload.slice(0, 20), 0xff] })!.values).toBeNull();
    expect(parsePresetEntry({ cmd: CMD.preset, payload: [0, 2, ...put.payload.slice(0, 20), 3] })).toEqual({ index: 0, count: 2, structure: '12345678', name: 'Glass', n: 3 });
    expect(parsePresetStored({ cmd: CMD.presetStored, payload: put.payload.slice(0, 20) })).toEqual({ structure: '12345678', name: 'Glass' });
    expect(devicePresetName('a name longer than sixteen')).toBe('a name longer th');
  });
});

describe('LIVE paused (#200)', () => {
  it('carries a paused byte when the editor\'s patch is over the budget, none otherwise', () => {
    expect(parse(liveFrame())!.payload).toEqual([]);
    expect(parse(liveFrame(true))!.payload).toEqual([1]);
  });
});

describe('sandbox mode on the wire', () => {
  const page: SandboxPage = {
    patch: 'Sol 29N XL', device: 'Sol filter', page: 'FILTER 1/2', index: 2, count: 5,
    rows: [{ label: 'Cutoff', value: '2.40', unit: 'kHz', pos: 150 / 255, steps: 0 }, { label: 'Res', value: '\u221212', unit: 'dB', pos: 1, steps: 0 },
      { label: 'Wave', value: 'SAW', unit: '', pos: 0, steps: 4 }, null],
  };

  const more = { place: { devices: 5, device: 2, groups: 3, group: 1, pages: 2, page: 0 }, tempo: 300, unsaved: true, armed: 0x80000005 };

  it('SANDBOX carries the page in fixed fields and parses back', () => {
    const f = sandboxFrame({ ...page, ...more });
    const p = parse(f)!;
    expect(p.cmd).toBe(CMD.sandbox);
    expect(p.cmd).toBe(0x31);
    expect(p.payload.length).toBe(SANDBOX_BYTES + SANDBOX_EXT_BYTES);
    expect(SANDBOX_BYTES).toBe(SB.SB_BYTES);
    expect(SANDBOX_EXT_BYTES).toBe(SB.SB_EXT_BYTES);
    const back = parseSandbox(p.payload)!;
    expect(back).toEqual({ ...page, ...more, rows: [{ ...page.rows[0]!, pos: 150 / 255 }, { ...page.rows[1]!, value: '-12' }, page.rows[2], null] });
    expect(sandboxPayload(page)[0]).toBe(0b0111);
    expect(parseSandbox(p.payload.slice(0, SANDBOX_BYTES - 1))).toBeNull();
  });

  it('the fields after the rows: as sandbox_msg.h reads them; a page without them (an older editor) parses as before', () => {
    const e = sandboxPayload({ ...page, ...more }).slice(SANDBOX_BYTES);
    expect(e).toEqual([5, 2, 3, 1, 2, 0, 300 & 0xff, 300 >> 8, 1, 5, 0, 0, 0x80]);
    expect(sandboxPayload(page).slice(SANDBOX_BYTES)).toEqual(new Array(13).fill(0));   // (none given: zeros)
    const old = parseSandbox(sandboxPayload(page).slice(0, SANDBOX_BYTES))!;
    expect(old).toEqual({ ...page, rows: [{ ...page.rows[0]!, pos: 150 / 255 }, { ...page.rows[1]!, value: '-12' }, page.rows[2], null] });
    expect(old.place).toBeUndefined();
  });

  it('cuts names to their fields and keeps to the FM-1\'s ASCII', () => {
    const long = sandboxPayload({ ...page, patch: 'A very long patch name indeed', device: 'Oscillators \u00b7 two' });
    const back = parseSandbox(long)!;
    expect(back.patch).toBe('A very long patch na');
    expect(back.device).toBe('Oscillators ');
    expect(fm1Ascii('\u22121.5 \u00b5s \u00d72 \u2019a\u2019 \u00e9')).toBe("-1.5 us x2 'a' ");
  });

  it('INFO: feature bits 8..15 in byte 6, MIDI OUT in flag bit 2 only with feature bit 8', () => {
    const info = (payload: number[]) => parseInfo({ cmd: CMD.info, payload })!;
    expect(info([1, 64, 255, 1 | 4, 8, 246, 1])).toMatchObject({ features: 246 | 256, midiOut: true, flashOk: true });
    expect(info([1, 64, 255, 1, 8, 246, 1]).midiOut).toBe(false);
    expect(info([1, 64, 255, 1 | 4, 8, 246]).midiOut).toBeNull();   // 1.2 firmware: it does not say
    expect(info([1, 64, 255, 1, 8, 246]).features).toBe(246);
    expect(info([1, 64, 255, 1, 8, 246, 255]).patchFormats).toBeUndefined();
    const extended = parseInfo(parse(frame(CMD.info, [1, 64, 255, 7, 8, 246, 255, 31, 200]))!)!;
    expect(extended).toMatchObject({ patchFormats: { min: 31, max: 200 }, features: 65526, midiOut: true });
    expect(extended.firmware).toBeUndefined();   // firmware before 1.8: its identity says major and minor
  });

  it('INFO: GLO > SYSTEM > EDITOR at IGNORE in flag bit 3, only with feature bit 19 (#702)', () => {
    const info = (flags: number, f3: number) => parseInfo(parse(frame(CMD.info, [1, 64, 255, flags, 8, 246, 255, 31, 48, 1, 11, 0, f3]))!)!;
    expect(info(1 | 8, 15).editorIgnored).toBe(true);
    expect(info(1, 15).editorIgnored).toBe(false);
    expect(info(1 | 8, 7).editorIgnored).toBe(false);   // (no feature bit 19: firmware without the setting counts as ALLOW)
    expect(parseInfo(parse(frame(CMD.info, [1, 64, 255, 15, 8, 246, 255]))!)!.editorIgnored).toBe(false);
    expect(editorSkips(info(1 | 8, 15), false)).toBe(true);
    expect(editorSkips(info(1 | 8, 15), true)).toBe(false);   // (the test tools' page: the rig is set to IGNORE)
    expect(editorSkips(null, false)).toBe(false);
  });

  it('ARMS (#191): the editor\'s armed set as proto.c reads it (u32 LE words), feature bit 20; four words with bit 21 (#721), eight with INFO byte 25 bit 4 (#1286)', async () => {
    const { armsFrame, FEATURE_ARMS, FEATURE_WIDE_ARMS, FEATURE5_FORMAT_67, parseArmsNow } = await import('./protocol');
    const p = parse(armsFrame([0x80000005, 0x00000101]))!;
    expect(p.cmd).toBe(0x39);
    expect(p.payload).toEqual([5, 0, 0, 0x80, 1, 1, 0, 0]);
    expect(parse(armsFrame([0, 0]))!.payload).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(parse(armsFrame([5, 0, 1, 0x80000000]))!.payload).toEqual([5, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0x80]);
    const info = parseInfo(parse(frame(CMD.info, [1, 64, 255, 1, 8, 246, 255, 31, 51, 0, 0, 0, 31]))!)!;
    expect(info.features & FEATURE_ARMS).toBeTruthy();
    expect(info.features & FEATURE_WIDE_ARMS).toBeFalsy();
    const wide = parseInfo(parse(frame(CMD.info, [1, 128, 255, 1, 8, 246, 255, 31, 51, 0, 0, 0, 63]))!)!;
    expect(wide.features & FEATURE_WIDE_ARMS).toBeTruthy();
    expect(wide.maxModules).toBe(128);
    const f67 = parseInfo(parse(frame(CMD.info, [1, 254, 255, 1, 8, 246, 255, 31, 67, 0, 0, 0, 63, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 16]))!)!;
    expect(f67.features25 & FEATURE5_FORMAT_67).toBeTruthy();
    expect(f67.maxModules).toBe(254);
    expect(f67.patchFormats).toEqual({ min: 31, max: 67 });
    // ARMS_NOW: two words from older firmware (the rest 0), four since #721, eight since #1286, too short: nothing
    expect(parseArmsNow([5, 0, 0, 0x80, 1, 1, 0, 0])).toEqual([0x80000005, 0x101, 0, 0, 0, 0, 0, 0]);
    expect(parseArmsNow([5, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0x80])).toEqual([5, 0, 1, 0x80000000, 0, 0, 0, 0]);
    expect(parseArmsNow([...new Array(28).fill(0), 0, 0, 0, 0x80])).toEqual([0, 0, 0, 0, 0, 0, 0, 0x80000000]);
    expect(parseArmsNow([5, 0, 0, 0, 0, 0, 0])).toBeNull();
  });

  it('INFO: the firmware version in bytes 9..11 (#216)', () => {
    const info = parseInfo(parse(frame(CMD.info, [1, 64, 255, 7, 8, 246, 255, 31, 48, 1, 8, 0]))!)!;
    expect(info).toMatchObject({ patchFormats: { min: 31, max: 48 }, firmware: { major: 1, minor: 8, patch: 0 } });
    expect(parseInfo(parse(frame(CMD.info, [1, 64, 255, 7, 8, 246, 255, 31, 48, 0, 0, 0]))!)!.firmware).toEqual({ major: 0, minor: 0, patch: 0 });
  });
  it('INFO: byte 25, the feature bits from 1.26 on (bytes 20..24 the font area\'s); 0 from firmware that sends 20 bytes (#1202 K2)', () => {
    const head = [1, 128, 255, 7, 255, 246, 255, 31, 65, 1, 26, 0, 255, 0, 125, 60, 0, 0, 0, 0];
    expect(parseInfo(parse(frame(CMD.info, head))!)!.features25).toBe(0);
    expect(parseInfo(parse(frame(CMD.info, [...head, 0, 0, 0, 0, 0, FEATURE25_TRACK_CARD]))!)!.features25 & FEATURE25_TRACK_CARD).toBe(FEATURE25_TRACK_CARD);
  });
});

describe('the device test mode on the wire (#291)', () => {
  it('builds TEST_KEY / TEST_TURN as proto.c reads them (a negative turn as i8)', () => {
    expect(Array.from(testKeyFrame(10, true))).toEqual([0xf0, 0x7d, 0x4d, 0x31, 0x32, ...pack7([10, 1]), 0xf7]);
    expect(unpack7(Array.from(testTurnFrame(6, -2)).slice(5, -1))).toEqual([6, 0xfe]);
    expect(unpack7(Array.from(testTurnFrame(2, 500)).slice(5, -1))).toEqual([2, 127]);
    expect(Array.from(testScreenFrame())).toEqual([0xf0, 0x7d, 0x4d, 0x31, 0x34, 0xf7]);
  });
  it('reads SCREEN (the head, a text) and PEAK', () => {
    const head = parse(frame(CMD.screen, [0xff, 2, 0, 1]))!;
    expect(parseScreen(head)).toEqual({ head: { count: 2, page: 0, sandbox: true, booting: false } });
    expect(parseScreen(parse(frame(CMD.screen, [0xff, 2, 8, 0, 8, 1]))!)).toEqual({ head: { count: 2, page: 8, sandbox: false, booting: false, buttons: 0x108 } });
    const t = parse(frame(CMD.screen, [1, 11, 20, 60, 11, 13, ...Array.from('BROWSER PLAYS', (c) => c.charCodeAt(0))]))!;
    expect(parseScreen(t)).toEqual({ k: 1, text: { x: 11, y: 20, w: 60, h: 11, s: 'BROWSER PLAYS' } });
    expect(parseScreen(parse(frame(CMD.screen, [1, 11, 20, 60, 11, 13, 65]))!)).toBeNull();
    expect(parsePeak(parse(frame(CMD.peak, [1234 & 255, 1234 >> 8, 3]))!)).toEqual({ peak: 1234, running: true, muted: true, masterDown: false, usbFixed: false });
    expect(parsePeak(parse(frame(CMD.peak, [0, 0, 5]))!)).toEqual({ peak: 0, running: true, muted: false, masterDown: true, usbFixed: false });
    expect(parsePeak(parse(frame(CMD.peak, [0, 0, 13]))!)).toEqual({ peak: 0, running: true, muted: false, masterDown: true, usbFixed: true });   // (#1170)
  });
});

describe('patterns and songs on the wire (#375, format 48)', () => {
  it('TRACK names its pattern; TRACK_NOW without one is pattern 1', async () => {
    const { trackFrames, parseTrack } = await import('./protocol');
    const notes = [{ at: 0, len: 2, note: 60, vel: 127 }, { at: 4, len: 1, note: 67, vel: 100 }];
    const p = parse(trackFrames(3, notes, 5)[0])!;
    expect(p.cmd).toBe(CMD.track);
    expect(p.payload.length).toBe(2 + 8 + 1);
    expect(parseTrack(p.payload)).toEqual({ module: 3, notes, pat: 5, more: false });
    expect(parseTrack(parse(trackFrames(3, notes)[0])!.payload)).toEqual({ module: 3, notes, pat: 0, more: false });
  });
  it('a pattern past 128 words goes in frames, each after the first marked (#1292)', async () => {
    const { trackFrames, parseTrack, TRACK_FRAME_WORDS } = await import('./protocol');
    const notes = Array.from({ length: 200 }, (_, k) => ({ at: k % 64, len: 1, note: 30 + Math.floor(k / 64), vel: 100 }));
    const fs = trackFrames(3, notes, 2).map((f) => parseTrack(parse(f)!.payload)!);
    expect(fs.map((f) => [f.notes.length, f.more, f.pat])).toEqual([[TRACK_FRAME_WORDS, false, 2], [200 - TRACK_FRAME_WORDS, true, 2]]);
    expect(fs.flatMap((f) => f.notes)).toEqual(notes);
  });
  it('LOCKS_NOW (#524): a track\'s locks of a pattern, 7 bytes each', async () => {
    const { parseLocksNow } = await import('./protocol');
    const v = Math.round(-1.5 * 65536) >>> 0;
    const p = parse(frame(CMD.locksNow, [4, 2, 2, 0, 7, 1, 0, 0, 0x64, 0, 5, 9, 3, v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, v >>> 24]))!;
    expect(parseLocksNow(p.payload)).toEqual({ module: 4, pat: 2, locks: [{ at: 0, module: 7, param: 1, value: 100 }, { at: 5, module: 9, param: 3, value: -1.5 }] });
    expect(parseLocksNow([4, 2, 2, 0, 7])).toBeNull();
  });
  it('KEYS_NOW and GUIDE_NOW (#549): a key edge with the keys and buttons held; the panel state, compared', async () => {
    const { parseKeysNow, parseGuideNow, panelOffBy } = await import('./protocol');
    const k = parse(frame(CMD.keysNow, [0x80 | 4, 0x10, 0, 0, 0, 1 << 3, 0]))!;
    expect(parseKeysNow(k.payload)).toEqual({ key: 4, down: true, keys: 0x10, held: 8 });
    expect(parseKeysNow([4, 0, 0])).toBeNull();
    const raw = [8, 8, 1 | 16 | 128, 2, 1, 1, 0, 0x08, 0x20, 0x00, 0x04, 3, 0xff, 2];
    const g = parseGuideNow(parse(frame(CMD.guideNow, raw))!.payload)!;
    expect(g).toMatchObject({ state: 8, page: 8, stepRecord: true, liveTake: false, sheet: true, stepHeld: true, device: 2, devicePage: 1, track: 1,
      held: 0x2008, conditions: 0x400, sheetRow: 3, octave: -1, cursor: 2 });
    expect(g.raw).toEqual(raw);
    expect(parseGuideNow(raw.slice(0, 13))).toBeNull();
    expect(panelOffBy(g, g)).toEqual([]);
    const copy = parseGuideNow([8, 11, 0, 5, 0, 1, 0, 0, 0, 0, 0, 0, 0xff, 0])!;
    expect(panelOffBy(copy, g)).toEqual(['page', 'step record', 'sheet', 'held']);
    // a device page: the focus counts; the track and the cursor do not
    const dev = parseGuideNow([0, 0, 0, 2, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0])!;
    expect(panelOffBy(parseGuideNow([0, 0, 0, 2, 0, 3, 0, 0, 0, 0, 0, 0, 0, 5])!, dev)).toEqual(['focus']);
  });
  it('PATTERN, SONG and their unasked replies', async () => {
    const { patternFrame, songFrame, parsePatternNow, parseSongNow } = await import('./protocol');
    expect(parse(patternFrame(7, 2))).toEqual({ cmd: CMD.pattern, payload: [7, 2] });
    const entries = [{ pat: 0, shift: 0 }, { pat: 3, shift: -7 }, { pat: 63, shift: 12 }];
    const s = parse(songFrame(4, entries))!;
    expect(s.cmd).toBe(CMD.song);
    expect(s.payload).toEqual([4, 3, 0, 0, 3, 0xf9, 63, 12]);
    expect(parseSongNow(s.payload)).toEqual({ song: 4, entries });
    expect(parsePatternNow([9, 1])).toEqual({ pattern: 9, song: 1 });
    expect(parseSongNow([8, 0])).toBeNull();
    expect(parseSongNow([0, 2, 1, 1])).toBeNull();
  });
});

describe('MIDI learn on the wire (#1067)', () => {
  const wire = (payload: number[]): number[] => parse(frame(MAP_CMD.mapNow, payload))!.payload;
  it('MAP_NOW without the tail, as older firmware sends it, and with a note mapping (128 + n)', () => {
    expect(parseMapNow(wire([2, 1, 3, 4, 0, 255, 164, 5, 6, 51, 204]))).toEqual({
      maps: [{ src: 1, module: 3, param: 4, lo: 0, hi: 255 }, { src: 164, module: 5, param: 6, lo: 51, hi: 204 }], also: null });
    expect(parseMapNow(wire([0]))).toEqual({ maps: [], also: null });
    expect(parseMapNow([2, 1, 3, 4, 0])).toBeNull();
  });
  it('MAP_NOW with the "also sent" tail: the learned source byte, then the count and the fixed-job CCs', () => {
    expect(parseMapNow(wire([1, 74, 3, 4, 0, 255, 74, 2, 16, 64]))).toEqual({ maps: [{ src: 74, module: 3, param: 4, lo: 0, hi: 255 }], also: { src: 74, ccs: [16, 64] } });
    expect(parseMapNow(wire([1, 164, 3, 4, 0, 255, 164, 1, 22]))?.also).toEqual({ src: 164, ccs: [22] });
    expect(parseMapNow([1, 74, 3, 4, 0, 255, 74, 3, 16])?.also).toBeNull();   // (a cut tail: the mappings still count)
    expect(parseMapNow([1, 74, 3, 4, 0, 255, 74, 0])?.also).toBeNull();
  });
});

describe('the global pad map on the wire (PADS, PADS_NOW)', () => {
  const sent = (f: Uint8Array): [number, number[]] => { const p = parse(f)!; return [p.cmd, p.payload]; };
  it('INFO feature bit 29 is byte 14 bit 5', () => {
    expect(FEATURE_PADS).toBe(1 << 29);
    expect(parseInfo({ cmd: CMD.info, payload: [1, 64, 255, 3, 1, 0, 1, 48, 48, 0, 0, 0, 0, 0, 0x20] })!.features & FEATURE_PADS).toBe(FEATURE_PADS);
  });
  it('PADS: an empty read, a row set or cleared, every row cleared, PAD MAP turned', () => {
    expect(sent(padsReadFrame())).toEqual([0x1d, []]);
    expect(sent(padsSetFrame(0, 36))).toEqual([0x1d, [0, 36]]);
    expect(sent(padsSetFrame(23, null))).toEqual([0x1d, [23, 0xff]]);
    expect(sent(padsClearAllFrame())).toEqual([0x1d, [0xfe]]);
    expect(sent(padsOnFrame(false))).toEqual([0x1d, [0xfd, 0]]);
    expect(sent(padsOnFrame(true))).toEqual([0x1d, [0xfd, 1]]);
    expect(PADS_CMD).toEqual({ pads: 0x1d, padsNow: 0x64 });
  });
  it('PADS_NOW: PAD MAP, then 24 notes (0xFF none); a short payload is none', () => {
    const notes = Array.from({ length: 24 }, (_, i) => (i % 3 ? 0xff : 36 + i));
    const wire = parse(frame(PADS_CMD.padsNow, [1, ...notes]))!.payload;
    const m = parsePadsNow(wire)!;
    expect(m.on).toBe(true);
    expect(m.notes).toHaveLength(24);
    expect(m.notes.slice(0, 4)).toEqual([36, null, null, 39]);
    expect(parsePadsNow([0, ...notes])!.on).toBe(false);
    expect(parsePadsNow([1, ...notes.slice(1)])).toBeNull();
    expect(parsePadsNow([])).toBeNull();
  });
  it('one pad per row and one row per pad: a note another row holds leaves that row', () => {
    expect(withPad([36, 38, null], 2, 36)).toEqual([null, 38, 36]);
    expect(withPad([36, 38, null], 1, null)).toEqual([36, null, null]);
  });
});

// the palette's link (#1196): build/palette/spec.md §5's shared vectors, which the firmware's tests assert too
describe('the palette on the wire (#1196)', () => {
  const hex = (s: string): number[] => s.split(' ').map((h) => parseInt(h, 16));
  const MONOLITH: PaletteEntry = { slot: 0, pattern: 2, name: 'MONOLITH D', devices: [{ dev: 0, structure: 0x12345678, pstructure: 0x12345678, name: 'WARM1' }] };
  const MONOLITH_BYTES = hex('00 02 4D 4F 4E 4F 4C 49 54 48 20 44 00 00 00 00 00 00 00 00 00 00 01 00 78 56 34 12 78 56 34 12 05 57 41 52 4D 31');
  const KIT: PaletteEntry = { slot: 16, pattern: 0, name: '808 KIT', devices: [] };
  const KIT_BYTES = hex('10 00 38 30 38 20 4B 49 54 00 00 00 00 00 00 00 00 00 00 00 00 00 00');
  it('encodes and decodes the shared entries byte for byte, with their hashes', () => {
    expect(crc16(Array.from('123456789', (c) => c.charCodeAt(0)))).toBe(0x29b1);
    expect(encodePaletteEntry(MONOLITH)).toEqual(MONOLITH_BYTES);
    expect(MONOLITH_BYTES).toHaveLength(38);
    expect(paletteHash(MONOLITH)).toBe(0x9b74);
    expect(decodePaletteEntry(MONOLITH_BYTES)).toEqual(MONOLITH);
    expect(encodePaletteEntry(KIT)).toEqual(KIT_BYTES);
    expect(KIT_BYTES).toHaveLength(23);
    expect(paletteHash(KIT)).toBe(0x3659);
    expect(decodePaletteEntry(KIT_BYTES)).toEqual(KIT);
  });
  it('refuses a malformed entry, and cuts a long preset name and too many devices', () => {
    expect(decodePaletteEntry(KIT_BYTES.slice(0, 22))).toBeNull();
    expect(decodePaletteEntry([...MONOLITH_BYTES.slice(0, 32), 0])).toBeNull();   // (a name of no characters)
    expect(decodePaletteEntry(MONOLITH_BYTES.slice(0, 37))).toBeNull();
    const many = { ...KIT, devices: Array.from({ length: 14 }, (_, dev) => ({ dev, structure: 1, pstructure: 0, name: 'A VERY LONG PRESET NAME' })) };
    const e = decodePaletteEntry(encodePaletteEntry(many))!;
    expect(e.devices).toHaveLength(PALETTE_DEVS);
    expect(e.devices[0].name).toBe('A VERY LONG PRES');
  });
  it('builds the six ops as the contract has them', () => {
    expect(parse(paletteGetFrame())).toEqual({ cmd: 0x1e, payload: [0] });
    expect(parse(paletteEntryGetFrame(3))).toEqual({ cmd: 0x1e, payload: [1, 3] });
    expect(parse(palettePutFrame(4, KIT))).toEqual({ cmd: 0x1e, payload: [2, 4, ...KIT_BYTES] });
    expect(parse(palettePutFrame(4, null))).toEqual({ cmd: 0x1e, payload: [2, 4] });
    expect(parse(paletteOrderFrame([1, 0, 2, null, 4, 5, 6, 7]))).toEqual({ cmd: 0x1e, payload: [3, 1, 0, 2, 0xff, 4, 5, 6, 7] });
    expect(() => paletteOrderFrame([0, 1])).toThrow();
    expect(parse(paletteGoFrame(2))).toEqual({ cmd: 0x1e, payload: [4, 2] });
    expect(parse(paletteGoFrame(null))).toEqual({ cmd: 0x1e, payload: [4, 0xff] });
    const n = parse(paletteNameFrame('MY PAD'))!;
    expect(n.payload).toEqual([5, ...Array.from('MY PAD', (c) => c.charCodeAt(0)), ...new Array(14).fill(0)]);
    expect(PALETTE).toMatchObject({ cmd: 0x1e, now: 0x66, entry: 0x67 });
  });
  it('reads PALETTE_NOW: 222 bytes, none as 0xFF, and PALETTE_ENTRY', () => {
    const pos = (state: number, slot: number, hash: number, len: number, name: string): number[] =>
      [state, slot, 1, hash & 0xff, hash >> 8, len & 0xff, len >> 8, ...Array.from({ length: 20 }, (_, i) => name.charCodeAt(i) || 0)];
    const payload = [1, 2, 0xff, 1, 0x34, 0x12, pos(1, 0, 0x9b74, 2758, 'MONOLITH D'), pos(2, 16, 0x3659, 0, '808 KIT'), ...Array.from({ length: 6 }, () => pos(0, 0, 0, 0, ''))].flat();
    expect(payload).toHaveLength(222);
    const now = parsePaletteNow(payload)!;
    expect(now).toMatchObject({ version: 1, cur: 2, next: null, edited: true, seq: 0x1234 });
    expect(now.positions[0]).toEqual({ state: 1, slot: 0, pattern: 1, hash: 0x9b74, len: 2758, name: 'MONOLITH D' });
    expect(now.positions[1].state).toBe(2);
    expect(now.positions[7].state).toBe(0);
    expect(parsePaletteNow(payload.slice(0, 221))).toBeNull();
    expect(parsePaletteNow([2, ...payload.slice(1)])).toBeNull();
    expect(parsePaletteEntry([5, ...KIT_BYTES])).toEqual({ pos: 5, entry: KIT });
    expect(parsePaletteEntry([5])).toEqual({ pos: 5, entry: null });
    expect(parsePaletteEntry([8])).toBeNull();
  });
  it('reads feature bit 31 though it makes the feature word negative', () => {
    const info = parseInfo({ cmd: CMD.info, payload: [1, 64, 255, 3, 1, 0, 0, 48, 60, 1, 26, 0, 0, 1, 0x80] })!;
    expect(info.features).toBeLessThan(0);
    expect(hasPaletteFeature(info.features)).toBe(true);
    expect(info.features & FEATURE_PALETTE).not.toBe(0);
    expect(hasPaletteFeature(parseInfo({ cmd: CMD.info, payload: [1, 64, 255, 3, 1, 0, 0, 48, 60, 1, 25, 0, 0, 1, 0x40] })!.features)).toBe(false);
  });
});
