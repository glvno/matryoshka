// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
// @ts-ignore untyped JS module
import { Updater } from './flasher/fm1ota.js';
import { TARGET_KEY, rememberTarget, rememberedTarget, targetGuard } from './mvave-target';

const mem = () => {
  const m = new Map<string, string>();
  return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
};

describe('which M-VAVE package a cut-off install was writing (#183)', () => {
  it('is remembered and forgotten', () => {
    const s = mem();
    expect(rememberedTarget(s)).toBeNull();
    rememberTarget('open', s);
    expect(s.m.get(TARGET_KEY)).toBe('open');
    expect(rememberedTarget(s)).toBe('open');
    rememberTarget(null, s);
    expect(rememberedTarget(s)).toBeNull();
  });

  it("M-VAVE's loader is finished only with the package it started with", () => {
    const s = mem();
    rememberTarget('open', s);
    expect(() => targetGuard('v15', true, s)('ota-FM-1_015')).toThrow(expect.objectContaining({ code: 'wrongtarget' }));
    expect(() => targetGuard('open', false, s)('ota-FM-1_015')).not.toThrow();
  });

  it('without a memory it asks, and goes ahead once the person says they know', () => {
    const s = mem();
    expect(() => targetGuard('v15', false, s)('ota-FM-1_015')).toThrow(expect.objectContaining({ code: 'whichtarget' }));
    expect(rememberedTarget(s)).toBeNull();
    expect(() => targetGuard('v15', true, s)('ota-FM-1_015')).not.toThrow();
    expect(rememberedTarget(s)).toBe('v15');
  });

  it('other loaders are not its business (loaderFits refuses them first)', () => {
    const s = mem();
    rememberTarget('open', s);
    expect(() => targetGuard('v15', false, s)('ota-FM-1_700')).not.toThrow();
  });

  it("a resume in M-VAVE's loader sends nothing when the guard refuses", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const up: any = new Updater({ inputs: new Map(), outputs: new Map() });
    let closed = false, written = false;
    up.find = async () => ({ link: { close: () => (closed = true) }, id: { text: 'ota-FM-1_015', model: 'ota-FM-1' } });
    up.write = async () => ((written = true), { finished: true });
    const s = mem();
    rememberTarget('v15', s);
    await expect(up.resume(new Uint8Array(8), () => {}, 'FM-1_8000014', targetGuard('open', true, s))).rejects.toMatchObject({ code: 'wrongtarget' });
    expect({ closed, written }).toEqual({ closed: true, written: false });
  });
});
