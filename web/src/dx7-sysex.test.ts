// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { bankSysex, parseDx7Sysex, singleSysex } from './dx7-sysex';
import { DX7_INIT_VOICE, voiceName } from './dx7-voice';

const named = (name: string, alg: number): Uint8Array => {
  const b = DX7_INIT_VOICE.slice();
  b[110] = alg;
  b.set([...name.padEnd(10)].map((c) => c.charCodeAt(0)), 118);
  return b;
};

describe('DX7 SysEx (#1338)', () => {
  it('writes and reads a single voice dump (VCED, 163 bytes, checksum)', () => {
    const v = named('BRASS   1', 21);
    const s = singleSysex(v);
    expect(s.length).toBe(163);
    expect([...s.subarray(0, 6)]).toEqual([0xf0, 0x43, 0, 0, 1, 0x1b]);
    expect(s[162]).toBe(0xf7);
    const r = parseDx7Sysex(s)!;
    expect(r.bank).toBe(false);
    expect(r.checksumOk).toBe(true);
    expect([...r.voices[0]]).toEqual([...v]);
  });

  it('writes and reads a 32-voice bank (VMEM, 4104 bytes), filling the empty slots, on any channel', () => {
    const s = bankSysex([named('ONE', 0), named('TWO', 31)], DX7_INIT_VOICE);
    expect(s.length).toBe(4104);
    s[2] = 0x05;   // (channel 6)
    const r = parseDx7Sysex(s)!;
    expect(r.bank).toBe(true);
    expect(r.voices.length).toBe(32);
    expect(r.voices.map(voiceName).slice(0, 3)).toEqual(['ONE', 'TWO', 'INIT VOICE']);
    expect(r.voices[1][110]).toBe(31);
  });

  it('reads a voice with a wrong checksum and says so; finds nothing in other data', () => {
    const s = singleSysex(DX7_INIT_VOICE);
    s[161] ^= 1;
    expect(parseDx7Sysex(s)!.checksumOk).toBe(false);
    expect(parseDx7Sysex([0xf0, 0x41, 0x10, 0x42, 0xf7])).toBeNull();
  });
});
