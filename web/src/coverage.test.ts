import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CORE, INTERFACE, groupCoverage, isCoverageStats } from './coverage';

describe('test coverage figures', () => {
  it('groups the files and weighs them by lines', () => {
    const s = groupCoverage({
      '/x/web/src/engine.ts': { lines: { total: 100, covered: 90 } },
      '/x/web/src/patch.ts': { lines: { total: 300, covered: 300 } },
      '/x/web/src/editor.ts': { lines: { total: 200, covered: 20 } },
      '/x/web/src/fuzzy.ts': { lines: { total: 50, covered: 0 } },
      total: { lines: { total: 650, covered: 410 } },
    }, '2026-10-17');
    expect(s.core).toEqual({ pct: 97.5, lines: 400 });
    expect(s.interface).toEqual({ pct: 10, lines: 200 });
    expect(isCoverageStats(s)).toBe(true);
  });

  it('every listed file exists and none is in both groups', () => {
    for (const f of [...CORE, ...INTERFACE]) expect(existsSync(new URL(f, import.meta.url)), f).toBe(true);
    expect(CORE.filter((f) => INTERFACE.includes(f))).toEqual([]);
  });
});
