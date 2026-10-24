// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { DEFS } from './modules';
import { addModule, emptyPatch } from './patch';
import { devicesOf } from './pages';
import { sandboxKey, sandboxPage, sandboxStep } from './sandbox-mode';

describe('sandboxPage (the page the FM-1 draws in sandbox mode)', () => {
  const patch = () => {
    const p = emptyPatch();
    p.name = 'Big One';
    const f = addModule(p, DEFS.filter, 300, 20);
    return { p, f };
  };

  it('is the page in focus: the device, the page title as the FM-1 shows it, its place, four rows', () => {
    const { p, f } = patch();
    const devices = devicesOf(p, DEFS);
    const dev = devices.find((d) => d.module === f.id)!;
    const pg = sandboxPage(p, devices, { device: dev.key, page: 0 });
    expect(pg.patch).toBe('Big One');
    expect(pg.device).toBe(dev.name);
    expect(pg.page).toBe('PAGE' + (dev.pages.length > 1 ? ` 1/${dev.pages[0].parts}` : ''));
    expect(pg.index).toBe(0);
    expect(pg.count).toBe(dev.pages.length);
    expect(pg.rows).toHaveLength(4);
    const rows = dev.pages[0].rows;
    rows.forEach((r, k) => expect(pg.rows[k]?.label).toBe(r.label));
    for (let k = rows.length; k < 4; k++) expect(pg.rows[k]).toBeNull();
  });

  it('gives each row its value as the dock shows it, its position in the range and its choices', () => {
    const { p, f } = patch();
    const devices = devicesOf(p, DEFS);
    const dev = devices.find((d) => d.module === f.id)!;
    const at = (pred: (param: string) => boolean) => dev.pages.flatMap((g, i) => g.rows.map((r, k) => ({ r, i, k }))).find((x) => pred(x.r.param));
    const cutoff = at((n) => n === 'cutoff')!;
    f.params.cutoff = 2400;
    const row = sandboxPage(p, devices, { device: dev.key, page: cutoff.i }).rows[cutoff.k]!;
    expect(row).toMatchObject({ value: '2.4', unit: 'kHz', steps: 0 });
    expect(row.pos).toBeGreaterThan(0);
    expect(row.pos).toBeLessThan(1);
    const choice = at((n) => !!DEFS.filter.params.find((q) => q.name === n)?.choices);
    if (choice) {
      const pd = DEFS.filter.params.find((q) => q.name === choice.r.param)!;
      const c = sandboxPage(p, devices, { device: dev.key, page: choice.i }).rows[choice.k]!;
      expect(c.steps).toBe(pd.choices!.length);
      expect(c.unit).toBe('');
    }
  });

  it('changes its key when a value changes, not otherwise; a patch with no page gives the name alone', () => {
    const { p, f } = patch();
    const devices = devicesOf(p, DEFS);
    const dev = devices.find((d) => d.module === f.id)!;
    const a = sandboxKey(sandboxPage(p, devices, { device: dev.key, page: 0 }));
    expect(sandboxKey(sandboxPage(p, devices, { device: dev.key, page: 0 }))).toBe(a);
    const r = dev.pages[0].rows[0];
    f.params[r.param] = DEFS.filter.params.find((q) => q.name === r.param)!.max;
    expect(sandboxKey(sandboxPage(p, devices, { device: dev.key, page: 0 }))).not.toBe(a);
    expect(sandboxPage(p, [], null)).toEqual({ patch: 'Big One', device: '', page: '', index: 0, count: 0, rows: [null, null, null, null] });
  });
});

describe('sandboxStep (SELECT / ALGO from the FM-1 in sandbox mode)', () => {
  const devs = [
    { key: 'm1', name: 'Main', pages: [{ name: 'Main', part: 0, parts: 1, rows: [] }] },
    { key: 'm2', name: 'Filter', pages: [0, 1, 2].map((i) => ({ name: 'Filter', part: i, parts: 3, rows: [] })) },
  ];
  it('SELECT steps the devices, wrapping, onto their first page', () => {
    expect(sandboxStep(devs, { device: 'm1', page: 0 }, true, 1)).toEqual({ device: 'm2', page: 0 });
    expect(sandboxStep(devs, { device: 'm2', page: 2 }, true, 1)).toEqual({ device: 'm1', page: 0 });
    expect(sandboxStep(devs, { device: 'm1', page: 0 }, true, -1)).toEqual({ device: 'm2', page: 0 });
  });
  it('ALGO steps the pages of the device in focus, wrapping; nothing to step: null', () => {
    expect(sandboxStep(devs, { device: 'm2', page: 2 }, false, 1)).toEqual({ device: 'm2', page: 0 });
    expect(sandboxStep(devs, { device: 'm2', page: 0 }, false, -1)).toEqual({ device: 'm2', page: 2 });
    expect(sandboxStep([], null, true, 1)).toBeNull();
    expect(sandboxStep(devs, { device: 'm1', page: 0 }, false, 0)).toBeNull();
  });
});
