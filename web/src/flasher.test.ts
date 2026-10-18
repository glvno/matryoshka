// SPDX-License-Identifier: GPL-3.0-only
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// @ts-ignore untyped JS module
import { STOCK_V15_SHA256, validateStockPackage } from './flasher/fm1pkg.js';
// @ts-ignore untyped JS module
import { Updater, loaderFits } from './flasher/fm1ota.js';

const stock = (): Uint8Array => new Uint8Array(readFileSync(new URL('../public/firmware/FM-1_015.fwsc', import.meta.url)));

describe('bundled stock firmware', () => {
  it('is the unmodified official V15 the Return to stock button sends', async () => {
    const v = await validateStockPackage(stock());
    expect(v.product).toBe('FM-1_015');
    expect(v.sha256).toBe(STOCK_V15_SHA256);
  });

  it('a changed byte is refused', async () => {
    const raw = stock();
    raw[5000] ^= 1;
    await expect(validateStockPackage(raw)).rejects.toThrow();
  });

  it('ships with its notice naming the checksum', () => {
    const notice = readFileSync(new URL('../public/firmware/NOTICE-FM-1_015.txt', import.meta.url), 'utf8');
    expect(notice).toContain(STOCK_V15_SHA256);
    expect(notice).toContain('Apache License, Version 2.0');
  });
});

describe('finishing an interrupted write (resume)', () => {
  it('M-VAVE\'s loader only gets the official V15, Felucca-type loaders everything else', () => {
    expect(loaderFits('ota-FM-1_015', 'FM-1_015')).toBe(true);
    expect(loaderFits('ota-FM-1_015', 'FM-1_800')).toBe(false); // it would write our flash head
    expect(loaderFits('ota-FM-1_015', 'FM-1_910')).toBe(false);
    expect(loaderFits('ota-FM-1_800', 'FM-1_800')).toBe(true);
    expect(loaderFits('ota-FM-1_800', 'FM-1_910')).toBe(true); // our loader reports 800 in release builds too
    expect(loaderFits('ota-FM-1_900', 'FM-1_800')).toBe(true); // Felucca's loader
    expect(loaderFits('ota-FM-1_800', 'FM-1_015')).toBe(false);
    expect(loaderFits('ota-FM-1_8123456', 'FM-1_800')).toBe(false); // M-VAVE Official Open
    expect(loaderFits('ota-FM1C_0123456789abcdef', 'FM-1_800')).toBe(false);
  });

  const parked = (text: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const up: any = new Updater({ inputs: new Map(), outputs: new Map() });
    let closed = false, written = false;
    up.find = async () => ({ link: { close: () => (closed = true) }, id: { text, model: text.split('_')[0] } });
    up.write = async () => ((written = true), { finished: true });
    up.waitFor = async () => ({ link: { close() {} }, id: { text: 'FM-1_015', model: 'FM-1' } });
    return { up, state: () => ({ closed, written }) };
  };

  it('refuses to give our package to M-VAVE\'s loader, sending nothing', async () => {
    const { up, state } = parked('ota-FM-1_015');
    await expect(up.resume(new Uint8Array(8), () => {}, 'FM-1_800')).rejects.toMatchObject({ code: 'otherloader', detail: 'ota-FM-1_015' });
    expect(state()).toEqual({ closed: true, written: false });
  });

  it('finishes a cut-off return to stock in M-VAVE\'s loader', async () => {
    const { up, state } = parked('ota-FM-1_015');
    expect(await up.resume(new Uint8Array(8), () => {}, 'FM-1_015')).toBe(true);
    expect(state().written).toBe(true);
  });

  it('refuses to give the V15 to our loader', async () => {
    const { up, state } = parked('ota-FM-1_800');
    await expect(up.resume(new Uint8Array(8), () => {}, 'FM-1_015')).rejects.toMatchObject({ code: 'otherloader' });
    expect(state().written).toBe(false);
  });
});
