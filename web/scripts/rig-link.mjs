// SPDX-License-Identifier: GPL-3.0-only
// The test rig (#291), shared by scripts/rig.mjs and scripts/emu-scenarios.mjs --device: the dev server, Chrome, the
// rig's page (/__rig, dev/rig-client.ts), and which connected FM-1 is the registered rig.
// The rig is the FM-1 that carries the mark scripts/rig.mjs register wrote (a preset of RIG_STRUCTURE whose values are
// random); the Mac keeps the same values in ~/.config/matryoshka/rig.json. An FM-1 without that mark is never driven.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const RIG_FILE = process.env.MATRYOSHKA_RIG_FILE ?? join(homedir(), '.config/matryoshka/rig.json');

/** the registered rig's mark ({ values, registered }), or null */
export function loadRig() {
  if (!existsSync(RIG_FILE)) return null;
  try {
    const r = JSON.parse(readFileSync(RIG_FILE, 'utf8'));
    return Array.isArray(r.values) && r.values.length === 4 ? r : null;
  } catch {
    return null;
  }
}
export function saveRig(values) {
  mkdirSync(dirname(RIG_FILE), { recursive: true });
  writeFileSync(RIG_FILE, JSON.stringify({ values, registered: new Date().toISOString() }, null, 1) + '\n');
}
/** four random values for a new mark (whole numbers: they go as Q16 and come back exactly) */
export const newMark = () => Array.from({ length: 4 }, () => 1 + Math.floor(Math.random() * 30000));
export const sameMark = (a, b) => !!a && !!b && a.length === b.length && a.every((v, i) => Math.round(v) === Math.round(b[i]));

const freePort = () => new Promise((res) => {
  const s = createServer();
  s.listen(0, '::1', () => { const p = s.address().port; s.close(() => res(p)); });
});

/** a dev server of this checkout on a free port (never 5173): { url, stop } */
export async function startEditor() {
  const port = await freePort();
  const vite = spawn('npx', ['vite', '--port', String(port), '--strictPort', '--host', '::1'], { cwd: join(ROOT, 'web'), stdio: ['ignore', 'pipe', 'inherit'] });
  process.on('exit', () => { try { vite.kill(); } catch { /* gone */ } });   // (however the script ends)
  for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) if (!process.listenerCount(s)) process.on(s, () => process.exit(130));
  await new Promise((res) => vite.stdout.on('data', (d) => { if (/ready in|Local:/.test(String(d))) res(); }));
  return { url: `http://[::1]:${port}/`, stop: () => vite.kill() };
}

/** the rig's page in this browser context */
export async function rigPage(context, url) {
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log(`  rig page error: ${e.message}`));
  await page.goto(new URL('__rig', url).href);
  await page.waitForFunction(() => document.title === 'rig ready', null, { timeout: 20000 });
  return page;
}

/** the connected FM-1s (HELLO only) and which of them is the rig: { pairs, rig, ports } */
export async function survey(page) {
  const ports = await page.evaluate(() => window.__rig.ports());
  const pairs = await page.evaluate(() => window.__rig.pairs());
  const want = loadRig()?.values;
  let rig = null, rigs = 0;
  for (const p of pairs) {
    const mark = await page.evaluate((x) => window.__rig.markOf(x), p);
    p.mark = mark;
    if (want && sameMark(mark, want)) {
      rig = p;
      rigs++;
    }
  }
  if (rigs > 1) throw new Error('two connected FM-1s carry the rig\'s mark: register the rig again with only it connected');
  return { pairs, rig, ports };
}

/** the rig, picked on the page; refuses unless the registered rig is connected and has the device test mode */
export async function pickRig(page) {
  if (!loadRig()) throw new Error(`no rig registered (${RIG_FILE}): connect the rig alone and run npm run rig -- register`);
  const s = await survey(page);
  if (!s.rig) throw new Error(`the registered rig is not connected (${s.pairs.length} other FM-1${s.pairs.length === 1 ? '' : 's'} answered; none was driven)`);
  await page.evaluate((x) => window.__rig.pick(x), s.rig);
  return s;
}
