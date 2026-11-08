// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { editorSkips, parsePeak, parseScreen, testKeyFrame, testScreenFrame, testTurnFrame, fm1Ascii, parseInfo, parseSandbox, SANDBOX_BYTES, SANDBOX_EXT_BYTES, sandboxFrame, sandboxPayload, type SandboxPage, chunkFrames, CMD, commitFrame, crc16, devicePresetName, frame, LIVE_MS, liveFrame, pack7, paramFrame, parse, parsePresetData, parsePresetEntry, parsePresetStored, parseSlot, presetPutFrame, slotEraseFrame, slotFrame, slotInfoFrame, unpack7 } from './protocol';

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
    expect(SANDBOX_BYTES).toBe(171);   // (firmware/src/sandbox_msg.h SB_BYTES)
    expect(SANDBOX_EXT_BYTES).toBe(13);   // (SB_EXT_BYTES)
    expect(f.length).toBe(217);   // small (a CHUNK is up to 445 bytes): a page on every change is cheap
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

  it('ARMS (#191): the editor\'s armed set as proto.c reads it (u32 LE words), feature bit 20; four words with bit 21 (#721)', async () => {
    const { armsFrame, FEATURE_ARMS, FEATURE_WIDE_ARMS, parseArmsNow } = await import('./protocol');
    const p = parse(armsFrame([0x80000005, 0x00000101]))!;
    expect(p.cmd).toBe(0x39);
    expect(p.payload).toEqual([5, 0, 0, 0x80, 1, 1, 0, 0]);
    expect(parse(armsFrame([0, 0]))!.payload).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(parse(armsFrame([5, 0, 1, 0x80000000]))!.payload).toEqual([5, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0x80]);
    expect(FEATURE_ARMS).toBe(1 << 20);
    expect(FEATURE_WIDE_ARMS).toBe(1 << 21);
    const info = parseInfo(parse(frame(CMD.info, [1, 64, 255, 1, 8, 246, 255, 31, 51, 0, 0, 0, 31]))!)!;
    expect(info.features & FEATURE_ARMS).toBeTruthy();
    expect(info.features & FEATURE_WIDE_ARMS).toBeFalsy();
    const wide = parseInfo(parse(frame(CMD.info, [1, 128, 255, 1, 8, 246, 255, 31, 51, 0, 0, 0, 63]))!)!;
    expect(wide.features & FEATURE_WIDE_ARMS).toBeTruthy();
    expect(wide.maxModules).toBe(128);
    // ARMS_NOW: two words from older firmware (the rest 0), four since #721, too short: nothing
    expect(parseArmsNow([5, 0, 0, 0x80, 1, 1, 0, 0])).toEqual([0x80000005, 0x101, 0, 0]);
    expect(parseArmsNow([5, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0x80])).toEqual([5, 0, 1, 0x80000000]);
    expect(parseArmsNow([5, 0, 0, 0, 0, 0, 0])).toBeNull();
  });

  it('INFO: the firmware version in bytes 9..11 (#216)', () => {
    const info = parseInfo(parse(frame(CMD.info, [1, 64, 255, 7, 8, 246, 255, 31, 48, 1, 8, 0]))!)!;
    expect(info).toMatchObject({ patchFormats: { min: 31, max: 48 }, firmware: { major: 1, minor: 8, patch: 0 } });
    expect(parseInfo(parse(frame(CMD.info, [1, 64, 255, 7, 8, 246, 255, 31, 48, 0, 0, 0]))!)!.firmware).toEqual({ major: 0, minor: 0, patch: 0 });
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
    expect(parsePeak(parse(frame(CMD.peak, [1234 & 255, 1234 >> 8, 3]))!)).toEqual({ peak: 1234, running: true, muted: true, masterDown: false });
    expect(parsePeak(parse(frame(CMD.peak, [0, 0, 5]))!)).toEqual({ peak: 0, running: true, muted: false, masterDown: true });
  });
});

describe('patterns and songs on the wire (#375, format 48)', () => {
  it('TRACK names its pattern; TRACK_NOW without one is pattern 1', async () => {
    const { trackFrame, parseTrack } = await import('./protocol');
    const notes = [{ at: 0, len: 2, note: 60, vel: 127 }, { at: 4, len: 1, note: 67, vel: 100 }];
    const p = parse(trackFrame(3, notes, 5))!;
    expect(p.cmd).toBe(CMD.track);
    expect(p.payload.length).toBe(2 + 8 + 1);
    expect(parseTrack(p.payload)).toEqual({ module: 3, notes, pat: 5 });
    expect(parseTrack(parse(trackFrame(3, notes))!.payload)).toEqual({ module: 3, notes, pat: 0 });
  });
  it('LOCKS_NOW (#524): a track\'s locks of a pattern, 7 bytes each', async () => {
    const { parseLocksNow } = await import('./protocol');
    const v = Math.round(-1.5 * 65536) >>> 0;
    const p = parse(frame(CMD.locksNow, [4, 2, 2, 0, 7, 1, 0, 0, 0x64, 0, 5, 9, 3, v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, v >>> 24]))!;
    expect(parseLocksNow(p.payload)).toEqual({ module: 4, pat: 2, locks: [{ at: 0, module: 7, param: 1, value: 100 }, { at: 5, module: 9, param: 3, value: -1.5 }] });
    expect(parseLocksNow([4, 2, 2, 0, 7])).toBeNull();
  });
  it('KEYS_NOW and GUIDE_NOW (#549): a key edge with the keys and buttons held; the panel state, compared', async () => {
    const { parseKeysNow, parseGuideNow, panelOffBy, FEATURE_PANEL_REPORT } = await import('./protocol');
    expect(FEATURE_PANEL_REPORT).toBe(1 << 18);
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
