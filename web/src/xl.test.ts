// SPDX-License-Identifier: GPL-3.0-only
// The XLs' home (docs/ledger/patches-and-presets.md D-338): web/presets/xl, written by scripts/gen-xl.ts from
// scripts/xl/index.ts, listed in the browser after their FM-1 versions, never part of what goes to the FM-1. The XL here is
// a placeholder built only in this test: none ships with it.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFS } from './modules';
import { addModule, connect, type Patch } from './patch';
import { FM1_PRESETS, isXl, PRESETS, withXls, XL_PRESETS, xlBase } from './presets';
import { buildXls, xlFile, type Xl } from '../scripts/xl/xl';

/** the placeholder: Init with a 1.2 s Delay after it (browser only, so a sandbox patch) */
const initXl: Xl = {
  base: 'Init',
  build(p: Patch): Patch {
    const out = p.modules.find((m) => m.type === 'output')!;
    const from = p.cables.find((c) => c.to.module === out.id)!.from;
    p.cables = p.cables.filter((c) => c.to.module !== out.id);
    const dly = addModule(p, DEFS.delay, 1600, 20);
    Object.assign(dly.params, { time: 1200, fb: 0.5, mix: 0.4 });
    connect(p, DEFS, from, { module: dly.id, port: 'in' });
    connect(p, DEFS, { module: dly.id, port: 'out' }, { module: out.id, port: 'l' });
    connect(p, DEFS, { module: dly.id, port: 'r' }, { module: out.id, port: 'r' });
    return p;
  },
};

describe('XLs', () => {
  it('names an XL after its FM-1 version', () => {
    expect(xlBase('Algo Four XL')).toBe('Algo Four');
    expect(xlBase('Algo Four')).toBeUndefined();
    expect(xlFile('Algo Four XL')).toBe('algo-four-xl.json');
  });

  it('builds an XL from its FM-1 version, named "<base> XL", whatever the FM-1 budget says', () => {
    const [x] = buildXls([initXl], FM1_PRESETS);
    expect(x.patch.name).toBe('Init XL');
    expect(x.patch.modules.some((m) => m.type === 'delay')).toBe(true);
    expect(x.budget.fits).toBe(false); // a sandbox patch: allowed
    expect(x.budget.over.map((i) => i.label)).toContain('Delay over 520 ms: browser only');
    expect(() => buildXls([{ ...initXl, base: 'No Such Patch' }], FM1_PRESETS)).toThrow(/no FM-1 factory patch/);
    expect(() => buildXls([initXl, initXl], FM1_PRESETS)).toThrow(/two XLs/);
    // an XL that fits the FM-1 is allowed too
    const [fits] = buildXls([{ base: 'Init', build: (p) => p }], FM1_PRESETS);
    expect(fits.budget.fits).toBe(true);
  });

  it('lists each XL right after its FM-1 version in the browser, and an orphan last', () => {
    const fm1 = ['Oracle V', 'Init', 'Algo Four'].map((name) => ({ ...FM1_PRESETS.Init(), name }));
    const xl = (name: string): Patch => ({ ...FM1_PRESETS.Init(), name });
    const order = withXls(fm1, [xl('Algo Four XL'), xl('Gone XL'), xl('Oracle V XL')]).map((p) => p.name);
    expect(order).toEqual(['Oracle V', 'Oracle V XL', 'Init', 'Algo Four', 'Algo Four XL', 'Gone XL']);
  });

  it('gives every shipped XL a Steps track and an Arpeggiator after it, on the keys (the kitchen sink)', () => {
    for (const [name, make] of Object.entries(XL_PRESETS)) {
      const p = make();
      const type = (id: number): string | undefined => p.modules.find((m) => m.id === id)?.type;
      const keys = p.cables.filter((c) => c.from.port === 'keys' && c.to.port === 'keys');
      expect(keys.some((c) => type(c.from.module) === 'steps' && type(c.to.module) === 'arp'), name).toBe(true);
      expect(keys.some((c) => type(c.from.module) === 'arp'), name).toBe(true);
    }
  });
  it('keeps the shipped XLs out of everything that goes to the FM-1', () => {
    const fm1 = Object.keys(FM1_PRESETS);
    const xls = Object.keys(XL_PRESETS);
    for (const name of xls) {
      expect(isXl(name)).toBe(true);
      expect(fm1, name).not.toContain(name);
      expect(fm1, name).toContain(xlBase(name));
      const names = Object.keys(PRESETS);
      expect(names.indexOf(name), name).toBeGreaterThan(names.indexOf(xlBase(name)!));
    }
    for (const name of fm1) expect(isXl(name)).toBe(false);
    expect(Object.keys(PRESETS).filter((n) => !isXl(n))).toEqual(fm1);
    // presets.h (export-defs) holds the FM-1's factory patches only
    const h = readFileSync(new URL('../../firmware/src/presets.h', import.meta.url), 'utf8');
    expect(Number(/#define N_PRESETS (\d+)/.exec(h)![1])).toBe(fm1.length);
    for (const name of xls) expect(h).not.toContain(`"${name.toUpperCase()}"`);
  });
});
