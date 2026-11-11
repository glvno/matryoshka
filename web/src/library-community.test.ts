// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { passes } from './library-community';
import { chipOfEntry, type CommunityPatch } from './community';
import { recoveredLines } from './test-buffer-budget';

describe('Community allocation capability', () => {
  it('uses the same rule for filters and chips, including when a connection changes', () => {
    const c: CommunityPatch = { entry: { title: 'Recovered memory fixture', author: 'test', licence: 'CC-BY-SA-4.0', source: '', code: '', added: '2026-11-10' }, patch: recoveredLines() };
    for (const rule of [0, 1, 0, 1] as const) {
      expect(passes(c, 'fm1', [], rule)).toBe(rule === 1);
      expect(passes(c, 'sandbox', [], rule)).toBe(rule === 0);
      expect(chipOfEntry(c, rule).fits).toBe(rule === 1);
    }
  });
});
