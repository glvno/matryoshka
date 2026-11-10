// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { CMD, deviceSettingsFrame, parse, parseDeviceSettings } from './protocol';
describe('FM-1 device settings', () => {
  it('round trips a padded ASCII name and independent return level', () => {
    const p = parse(deviceSettingsFrame({ name: ' STAGE ', returnLevel: 73 }))!;
    expect(p.cmd).toBe(CMD.deviceSettings);
    expect(p.payload).toEqual([...Array.from('STAGE', (c) => c.charCodeAt(0)), ...Array(11).fill(0), 73]);
    expect(parseDeviceSettings({ cmd: CMD.deviceSettingsReply, payload: [0, ...p.payload, ...Array.from({ length: 16 }, (_, i) => i)] })).toEqual({ name: 'STAGE', returnLevel: 73, serial: '000102030405060708090A0B0C0D0E0F' });
  });
  it('rejects names or levels the firmware cannot persist', () => {
    for (const name of ['12345678901234567', 'café', 'A\0B', 'A\nB']) expect(() => deviceSettingsFrame({ name, returnLevel: 50 })).toThrow();
    for (const returnLevel of [-1, 101, 50.1, NaN]) expect(() => deviceSettingsFrame({ name: 'STAGE', returnLevel })).toThrow();
    expect(parse(deviceSettingsFrame())!.payload).toEqual([]);
    expect(parse(deviceSettingsFrame({ name: '', returnLevel: 0 }))!.payload).toEqual(Array(17).fill(0));
  });
  it('reports write errors and truncated responses instead of claiming success', () => {
    expect(() => parseDeviceSettings({ cmd: CMD.deviceSettingsReply, payload: [6, ...Array(33).fill(0)] })).toThrow('could not save');
    expect(() => parseDeviceSettings({ cmd: CMD.deviceSettingsReply, payload: [0] })).toThrow('incomplete');
  });
});
