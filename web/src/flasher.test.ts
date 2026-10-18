// SPDX-License-Identifier: GPL-3.0-only
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// @ts-ignore untyped JS module
import { STOCK_V15_SHA256, validateStockPackage } from './flasher/fm1pkg.js';

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
