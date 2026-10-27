// SPDX-License-Identifier: GPL-3.0-only
// The LCD's draw times on the test rig (#291; the owner's benchmark, 2026-10-24). Run from web/:
//   npm run rig:bench [-- --patch NAME] [--rounds N]
// With the registered rig the ONLY FM-1 connected (as `npm run rig -- check` shows it), over the device test mode: back
// to the device page, PRESET to the patch NAME (default: the one it is on), the draw times zeroed (DIAG page 120), then
// ALGO through the device's pages, SELECT through the devices and back, K1..K4 a few clicks each way, GLO open and
// closed (the device page drawn whole) and PRESET one on and back, N rounds; then the times the firmware kept (DIAG pages
// 121..123, firmware/src/ui.c ui_time_diag): the last and the worst of each kind of draw, in ms, and how many.
// A firmware without the draw times answers short: the script says so. The same script on two builds (main before a
// change and the change) compares them.
import { chromium } from 'playwright-core';
import { rigPage, startEditor, survey } from './rig-link.mjs';

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const PATCH = opt('--patch');
const ROUNDS = Number(opt('--rounds') ?? 3);
const ENC = { select: 0, algo: 1, k1: 2, preset: 6 };
const B = { glo: 7, home: 8 };
const NAMES = ['whole device page', 'top bar / header', 'knob click (its bars)', 'page reached (SELECT / ALGO / PRESET)',
  'PRESET toast shown', 'toast gone (page put back)'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const u32 = (b) => Array.from({ length: Math.floor(b.length / 4) }, (_, i) => (b[4 * i] | b[4 * i + 1] << 8 | b[4 * i + 2] << 16 | b[4 * i + 3] << 24) >>> 0);

const editor = await startEditor();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
let code = 0;
try {
  const context = await browser.newContext();
  await context.grantPermissions(['midi', 'midi-sysex'], { origin: new URL(editor.url).origin });
  const page = await rigPage(context, editor.url);
  const s = await survey(page);
  if (!s.rig || s.ports !== 1 || s.pairs.length !== 1)
    throw new Error(`the rig must be the only FM-1 connected (npm run rig -- check): ${s.ports} FM-1 port(s), ${s.pairs.length} answered,`
      + ` ${s.rig ? 'the rig among them' : 'none of them the registered rig'}; nothing was driven`);
  await page.evaluate((x) => window.__rig.pick(x), s.rig);
  const rig = {
    turn: (e, c) => page.evaluate(([a, b]) => window.__rig.turn(a, b), [e, c]),
    tap: (id, hold = 80) => page.evaluate(([a, b]) => window.__rig.tap(a, b), [id, hold]),
    screen: () => page.evaluate(() => window.__rig.screen()),
    diag: (n) => page.evaluate((x) => window.__rig.diag(x), n),
  };
  const shows = async (t) => (await rig.screen()).texts.some((x) => x.s.includes(t));
  for (let i = 0; i < 6 && (await rig.screen()).page !== 0; i++) {   // back to the device page
    await rig.tap(B.home);
    await sleep(300);
  }
  if ((await rig.screen()).page !== 0) throw new Error('the rig did not come back to its device page with HOME');
  if (PATCH) {
    let found = await shows(PATCH);
    for (let i = 0; i < 64 && !found; i++) {
      await rig.turn(ENC.preset, 1);
      await sleep(400);
      found = await shows(PATCH);
    }
    if (!found) throw new Error(`no patch named ${PATCH} in the rig's bank`);
    await sleep(1500);
  }
  if (process.env.BENCH_PLAY) { await rig.tap(12); await sleep(1500); }
  await rig.diag(127);
  const reset = await rig.diag(120);
  if (!reset.length) throw new Error('this firmware does not keep draw times (DIAG page 120): install a build that has them');
  console.log(`rig ${s.rig.name}, firmware ${s.rig.info?.version ?? '?'}; ${ROUNDS} round(s) on ${PATCH ?? 'the patch it is on'}`);
  for (let r = 0; r < ROUNDS; r++) {
    for (let i = 0; i < 8; i++) { await rig.turn(ENC.algo, 1); await sleep(350); }
    await sleep(800);
    for (let i = 0; i < 4; i++) { await rig.turn(ENC.select, 1); await sleep(350); }
    for (let i = 0; i < 4; i++) { await rig.turn(ENC.select, -1); await sleep(350); }
    await sleep(800);
    for (let k = 0; k < 4; k++) {
      for (const c of [1, 1, 1, 1, 1, -1, -1, -1, -1, -1]) { await rig.turn(ENC.k1 + k, c); await sleep(150); }
    }
    await rig.tap(B.glo); await sleep(500);
    await rig.tap(B.glo); await sleep(500);
    await rig.turn(ENC.preset, 1); await sleep(1600);
    await rig.turn(ENC.preset, -1); await sleep(1600);
  }
  { const c = u32(await rig.diag(127)); console.log(`CPU now ${c[0]} %, longest audio ISR ${c[1]} us of budget ${c[2]} us, overload mute ${c[3]}, halves ${c[4]}, shed ${c[7]}`); }
  const L = u32(await rig.diag(121)), W = u32(await rig.diag(122)), N = u32(await rig.diag(123));
  console.log(`${'draw'.padEnd(40)} ${'last ms'.padStart(8)} ${'worst ms'.padStart(9)} ${'count'.padStart(6)}`);
  NAMES.slice(0, L.length).forEach((name, i) =>
    console.log(`${name.padEnd(40)} ${(L[i] / 1000).toFixed(1).padStart(8)} ${(W[i] / 1000).toFixed(1).padStart(9)} ${String(N[i]).padStart(6)}`));
} catch (e) {
  console.error(e.message ?? e);
  code = 1;
} finally {
  await browser.close();
  editor.stop();
}
process.exit(code);
