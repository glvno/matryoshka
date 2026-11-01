// SPDX-License-Identifier: GPL-3.0-only
// #485: Cassia 1's presets have 118 values. The link carries up to 176 (feature bit 17, D-476); older firmware is refused
// one longer than 88. A preset the FM-1 stored before 1.8.2 has 88: it loads the rows it has (D-858).
import { describe, expect, it } from 'vitest';
import { applyPreset, currentValues, matchesPreset, presetsOf, shortBy, shortPresetText } from './device-presets';
import { DeviceLink, PRESET_NEEDS_UPDATE } from './device';
import { instIsEngine } from './engines';
import './factory-presets';
import type { Patch } from './patch';
import { CMD, FEATURE_LONG_PRESETS, parse, parsePresetData, presetPutFrame } from './protocol';
import { FM1_PRESETS } from './presets';

const cassia = (): Patch => FM1_PRESETS['Cassia 1']();
const card = (p: Patch) => p.assemblies!.find((a) => instIsEngine(p, a) && a.params.some((r) => r.label === 'wave 2'))!;

describe('presets longer than 88 values (#485)', () => {
  it('a Cassia 1 preset is 118 values, and PRESET_PUT carries them all', () => {
    const p = cassia();
    const pr = presetsOf(p, card(p)).find((x) => x.name === 'PD Bass')!;
    expect(pr.values.length).toBe(118);
    const put = parse(presetPutFrame(pr.structure, pr.name, pr.values))!;
    expect(put.cmd).toBe(CMD.presetPut);
    expect(put.payload[20]).toBe(118);
    const back = parsePresetData({ cmd: CMD.presetData, payload: put.payload })!;
    expect(back.values!.map((v) => Math.round(v * 65536))).toEqual(pr.values.map((v) => Math.round(v * 65536)));
    expect(() => presetPutFrame(pr.structure, pr.name, new Array(177).fill(0))).toThrow();
  });

  it('older firmware (no feature bit 17) is refused a preset of more than 88 values before anything is sent; 88 still go', async () => {
    const sent: Uint8Array[] = [];
    const link = new DeviceLink();
    const l = link as unknown as { info: { features: number }; out: { send(f: Uint8Array): void } };
    l.info = { features: 128 };
    l.out = { send: (f) => void sent.push(f) };
    expect(link.presetFits(88)).toBe(true);
    expect(link.presetFits(118)).toBe(false);
    await expect(link.putPreset('12345678', 'Long', new Array(118).fill(0))).rejects.toThrow(PRESET_NEEDS_UPDATE);
    expect(sent.length).toBe(0);
    l.info = { features: 128 | FEATURE_LONG_PRESETS };
    expect(link.presetFits(176)).toBe(true);
    expect(link.presetFits(177)).toBe(false);
  });

  it('a preset stored with 88 of its 118 values loads those rows in order; the other 30 keep theirs', () => {
    const p = cassia();
    const a = card(p);
    const list = presetsOf(p, a);
    const full = list.find((x) => x.name === 'Glass Bell')!;
    applyPreset(p, a, list.find((x) => x.name === 'PD Bass')!);
    const before = currentValues(p, a);
    const short = { ...full, name: 'OLD BELL', values: full.values.slice(0, 88) };
    expect(shortBy(p, a, short)).toBe(30);
    expect(shortBy(p, a, full)).toBe(0);
    expect(applyPreset(p, a, short)).toBe(true);
    const now = currentValues(p, a);
    const clampedFull = (() => { const q = cassia(); applyPreset(q, card(q), full); return currentValues(q, card(q)); })();
    expect(now.slice(0, 88)).toEqual(clampedFull.slice(0, 88));
    expect(now.slice(88)).toEqual(before.slice(88));
    expect(a.preset).toBe('OLD BELL');
    expect(applyPreset(p, a, { ...full, values: [...full.values, 0] })).toBe(false);   // (more values than rows: not this card)
    expect(matchesPreset(p, a)).toBe(false);   // (not in the list: no match)
  });

  it('says what a short preset is and what to do', () => {
    expect(shortPresetText('Cassia 1', 30, 118)).toBe("Stored before 1.8.2: 30 of Cassia 1's 118 rows are missing and keep their current values. To keep it, adjust and store it again, which saves all 118 rows. To start over, load a factory Cassia 1 preset and store it under this name, which replaces this one.");
  });
});
