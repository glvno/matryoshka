// SPDX-License-Identifier: GPL-3.0-only
// The factory patches' and examples' canvas as Tidy lays it out (D-1446, D-1458): a headless editor on a running dev server
// opens each, presses Tidy (the cards' real sizes and jacks are the browser's) and factory/layout.json gets where each
// top-level card went (src/factory-layout.ts applies it). The layout is the patch's FM-1 page order too, so run it after a
// factory patch or an example changes (factory-layout.test.ts says when), then the factory steps (CLAUDE.md):
//   npm run dev -- --port 5391        (another terminal; never the owner's 5173)
//   npx vite-node scripts/factory-layout.ts http://127.0.0.1:5391/
import { writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { layoutCards, type FactoryLayout } from '../src/factory-layout';
import type { Patch } from '../src/patch';
import { PRESETS } from '../src/presets';

const url = process.argv[2];
if (!url) throw new Error('usage: npx vite-node scripts/factory-layout.ts <dev server url>');
type Hooks = { open: (name: string) => boolean; patchJson: () => string };
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on('pageerror', (e) => console.log('page error', e.message));
await page.goto(url);
await page.waitForFunction(() => !!(window as unknown as { __m1test?: Hooks }).__m1test, null, { timeout: 60000 });
const layout: Record<string, FactoryLayout> = {};
for (const name of Object.keys(PRESETS)) {
  if (!(await page.evaluate((n) => (window as unknown as { __m1test: Hooks }).__m1test.open(n), name))) throw new Error(`${name}: the editor does not list it`);
  await page.waitForTimeout(800);
  await page.click('#tidy-btn');
  await page.waitForTimeout(400);
  const p = JSON.parse(await page.evaluate(() => (window as unknown as { __m1test: Hooks }).__m1test.patchJson())) as Patch;
  const cards = layoutCards(p);
  const l: FactoryLayout = { m: {}, a: {} };
  for (const id of cards.m) { const m = p.modules.find((x) => x.id === id)!; l.m[id] = [m.x, m.y]; }
  for (const id of cards.a) { const a = p.assemblies!.find((x) => x.id === id)!; l.a[id] = [a.x, a.y]; }
  layout[name] = l;
  console.log(`${name}: ${cards.m.length} cards, ${cards.a.length} assemblies`);
}
await browser.close();
writeFileSync(new URL('../factory/layout.json', import.meta.url), `${JSON.stringify(layout, null, 1)}\n`);
