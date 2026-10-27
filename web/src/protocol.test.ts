// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { parsePeak, parseScreen, testKeyFrame, testScreenFrame, testTurnFrame, fm1Ascii, parseInfo, parseSandbox, SANDBOX_BYTES, sandboxFrame, sandboxPayload, type SandboxPage, chunkFrames, CMD, commitFrame, crc16, devicePresetName, frame, LIVE_MS, liveFrame, pack7, paramFrame, parse, parsePresetData, parsePresetEntry, parsePresetStored, parseSlot, presetPutFrame, slotEraseFrame, slotFrame, slotInfoFrame, unpack7 } from './protocol';

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

  it('SANDBOX carries the page in fixed fields and parses back', () => {
    const f = sandboxFrame(page);
    const p = parse(f)!;
    expect(p.cmd).toBe(CMD.sandbox);
    expect(p.cmd).toBe(0x31);
    expect(p.payload.length).toBe(SANDBOX_BYTES);
    expect(SANDBOX_BYTES).toBe(171);   // (firmware/src/sandbox_msg.h SB_BYTES)
    expect(f.length).toBe(202);   // small (a CHUNK is up to 445 bytes): a page on every change is cheap
    const back = parseSandbox(p.payload)!;
    expect(back).toEqual({ ...page, rows: [{ ...page.rows[0]!, pos: 150 / 255 }, { ...page.rows[1]!, value: '-12' }, page.rows[2], null] });
    expect(sandboxPayload(page)[0]).toBe(0b0111);
    expect(parseSandbox(p.payload.slice(0, -1))).toBeNull();
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
