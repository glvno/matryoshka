// SPDX-License-Identifier: GPL-3.0-only
// The factory drum kits' card layouts (#1237): each kit card's columns and the 808 / 909 DRUMS grid's span are editor-only.
// The FM-1 sees the same pages and the same patch bytes with every `col` and `span` flag taken off the card, so a column
// break only ever falls where a page starts anyway (a headed row, or the OUT scope, which is no page of its own).
import { describe, expect, it } from 'vitest';
import { FM1_PRESETS } from './presets';
import { assembliesOf } from './assembly';
import { devicesOf } from './pages';
import { encodePatch } from './patchbin';
import { DEFS } from './modules';
import type { Patch } from './patch';

/** each kit: its card, its columns */
const KITS: [kit: string, card: string, cols: number][] = [
  ['808 Kit', '808 kit', 3],
  ['909 Kit', '909 kit', 3],
  ['Verona Drum 1', 'Verona Drum 1', 4],
  ['Scrounge', 'Scrounge', 4],
  ['Meridian 8', 'Meridian 8', 4],
];

const cardOf = (p: Patch, name: string) => assembliesOf(p).find((a) => a.name === name)!;
const flat = (p: Patch, name: string): Patch => {
  const q = structuredClone(p);
  const card = cardOf(q, name);
  card.params = card.params.map(({ col: _c, span: _s, ...r }) => r);
  return q;
};
const pages = (p: Patch): string => JSON.stringify(devicesOf(p, DEFS));
const bytes = (p: Patch): string => Array.from(encodePatch(p, true)).join(',');

describe('factory drum kit card layouts (#1237)', () => {
  for (const [kit, name, cols] of KITS) {
    it(`${kit}: ${cols} columns, the FM-1 pages and bytes as with no layout flags`, () => {
      const p = FM1_PRESETS[kit]();
      expect(1 + cardOf(p, name).params.slice(1).filter((r) => r.col).length).toBe(cols);
      expect(pages(p)).toBe(pages(flat(p, name)));
      expect(bytes(p)).toBe(bytes(flat(p, name)));
    });
  }
  it('the 808 and 909 DRUMS grid spans two columns, the longest column beside it', () => {
    for (const [kit, name] of [['808 Kit', '808 kit'], ['909 Kit', '909 kit']]) expect(cardOf(FM1_PRESETS[kit](), name).params[0].span).toBe(2);
  });
});
