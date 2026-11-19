// SPDX-License-Identifier: GPL-3.0-only
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CMD, FEATURE_FACTORY, FEATURE_MASTER_EQ, MASTER_EQ, MASTER_EQ_DB, MASTER_EQ_FREQ_DEFAULT, MASTER_EQ_FREQS, masterEqFrame, masterEqHz, parse, parseMasterEq } from './protocol';
import { masterEqCostText, masterEqFreqText, masterEqGainText } from './master-eq';
import { cpuEstimate, masterEqUse } from './cpu';
import { FM1_PRESETS } from './presets';

const header = readFileSync(new URL('../../firmware/src/master_eq.h', import.meta.url), 'utf8');
const proto = readFileSync(new URL('../../firmware/src/proto.c', import.meta.url), 'utf8');
const define = (src: string, name: string): number => Number(new RegExp(`#define ${name} (\\d+)u?`).exec(src)![1]);

describe('the master EQ over the link (#1107)', () => {
  it('says what the firmware says: its ranges, MID FREQ as made, the command and feature bit', () => {
    expect(define(header, 'MEQ_GAIN_MAX')).toBe(2 * MASTER_EQ_DB);
    expect(define(header, 'MEQ_FREQS')).toBe(MASTER_EQ_FREQS);
    expect(define(header, 'MEQ_FREQ_DEFAULT')).toBe(MASTER_EQ_FREQ_DEFAULT);
    expect(proto).toMatch(/C_MASTER_EQ = 0x1B, R_MASTER_EQ = 0x62/);
    expect(define(proto, 'M1_FEATURES4') & (FEATURE_MASTER_EQ >>> 24)).toBeTruthy();
    expect(FEATURE_MASTER_EQ).toBe(FEATURE_FACTORY * 2);
    expect(Object.values(CMD)).not.toContain(MASTER_EQ.cmd);
    expect(Object.values(CMD)).not.toContain(MASTER_EQ.reply);
  });
  it('reads with an empty frame and sets with four bytes: gains in half decibels, two’s complement', () => {
    expect(parse(masterEqFrame())!.payload).toEqual([]);
    const p = parse(masterEqFrame({ low: -3, mid: 0, high: 2.5, freq: 26 }))!;
    expect(p.cmd).toBe(MASTER_EQ.cmd);
    expect(p.payload).toEqual([0xfa, 0, 5, 26]);
    expect(parseMasterEq({ cmd: MASTER_EQ.reply, payload: [0, ...p.payload] })).toEqual({ low: -3, mid: 0, high: 2.5, freq: 26 });
    expect(parseMasterEq({ cmd: MASTER_EQ.reply, payload: [0, 24, 0xe8, 0, 0] })).toEqual({ low: 12, mid: -12, high: 0, freq: 0 });
  });
  it('refuses what the FM-1 would: past ±12 dB, between half decibels, MID FREQ past 8 kHz; and a refusal or a short answer', () => {
    for (const low of [12.5, -12.5, 0.25, NaN]) expect(() => masterEqFrame({ low, mid: 0, high: 0, freq: 0 })).toThrow();
    for (const freq of [-1, MASTER_EQ_FREQS, 1.5]) expect(() => masterEqFrame({ low: 0, mid: 0, high: 0, freq })).toThrow();
    expect(() => parseMasterEq({ cmd: MASTER_EQ.reply, payload: [1, 0, 0, 0, 20] })).toThrow('could not use');
    expect(() => parseMasterEq({ cmd: MASTER_EQ.reply, payload: [0] })).toThrow('incomplete');
  });
  it('shows MID FREQ and the gains as the FM-1 does', () => {
    expect(masterEqHz(0)).toBe(100);
    expect(masterEqFreqText(0)).toBe('100 Hz');
    expect(masterEqFreqText(6)).toBe('200 Hz');
    expect(masterEqFreqText(MASTER_EQ_FREQ_DEFAULT)).toBe('1.0 kHz');
    expect(masterEqFreqText(MASTER_EQ_FREQS - 1)).toBe('8.1 kHz');
    expect(masterEqGainText(0)).toBe('0 dB');
    expect(masterEqGainText(1.5)).toBe('+1.5 dB');
    expect(masterEqGainText(-12)).toBe('−12.0 dB');
  });
  it('costs what the emulator measured, only with a band on, and stays out of a patch’s own estimate (D-938)', () => {
    expect(masterEqUse(0)).toBe(0);
    expect(masterEqUse(1)).toBeCloseTo(0.036, 3);
    expect(masterEqUse(3) - masterEqUse(2)).toBeCloseTo(0.0134, 3);
    expect(masterEqCostText([0, 0, 0])).toMatch(/no CPU/);
    expect(masterEqCostText([-3, 0, 2])).toBe('With 2 bands on, the master EQ uses about 5.0 % of the FM-1’s CPU, on top of every patch’s own load.');
    const p = FM1_PRESETS['909 Kit']();
    expect(cpuEstimate(p).use).toBe(cpuEstimate(structuredClone(p)).use);   // (the patch carries nothing of it)
  });
});
