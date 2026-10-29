// scratch: SEQ page, many steps a second; then how long until the main loop answers / the screen settles
import { chromium } from 'playwright-core';
import { rigPage, startEditor, survey } from './rig-link.mjs';
const PATCH = process.argv[2] ?? 'ELVIRA 2', RATE = Number(process.argv[3] ?? 20), N = Number(process.argv[4] ?? 40), PLAY = process.argv[5] !== 'stop';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const u32 = (b) => Array.from({ length: Math.floor(b.length / 4) }, (_, i) => (b[4 * i] | b[4 * i + 1] << 8 | b[4 * i + 2] << 16 | b[4 * i + 3] << 24) >>> 0);
const editor = await startEditor();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const ctx = await browser.newContext();
  await ctx.grantPermissions(['midi', 'midi-sysex'], { origin: new URL(editor.url).origin });
  const page = await rigPage(ctx, editor.url);
  const s = await survey(page);
  await page.evaluate((x) => window.__rig.pick(x), s.rig);
  const ev = (f, a) => page.evaluate(([f, a]) => window.__rig[f](...a), [f, a]);
  const shows = async (t) => (await ev('screen', [])).texts.some((x) => x.s.includes(t));
  for (let i = 0; i < 6 && (await ev('screen', [])).page !== 0; i++) { await ev('tap', [8]); await sleep(300); }
  let found = await shows(PATCH);
  for (let i = 0; i < 64 && !found; i++) { await ev('turn', [6, 1]); await sleep(400); found = await shows(PATCH); }
  if (!found) throw new Error('no ' + PATCH);
  await sleep(1000);
  if (PLAY) { await ev('tap', [12]); await sleep(1000); }
  await ev('tap', [11]); await sleep(800);
  const scr = await ev('screen', []);
  console.log('SEQ page texts:', scr.texts.map((x) => x.s).join(' | '));
  await ev('diag', [127]); await ev('diag', [120]);
  const gap = 1000 / RATE, t0 = performance.now();
  for (let i = 0; i < N; i++) {
    const k = 14 + (i * 7) % 16, at = t0 + i * gap;
    while (performance.now() < at) await sleep(1);
    page.evaluate(([k]) => window.__rig.key(k, true), [k]);
    await sleep(Math.min(25, gap / 2));
    page.evaluate(([k]) => window.__rig.key(k, false), [k]);
  }
  const sent = performance.now() - t0;
  // the main loop's answer time: screen requests until they come back quickly
  const lat = [];
  for (let i = 0; i < 12; i++) { const t = performance.now(); await ev('screen', []); lat.push(Math.round(performance.now() - t)); }
  const c = u32(await ev('diag', [127]));
  const L = u32(await ev('diag', [121])), W = u32(await ev('diag', [122])), Nn = u32(await ev('diag', [123]));
  console.log(`${N} steps at ${RATE}/s sent in ${sent.toFixed(0)} ms; screen answers after: ${lat.join(', ')} ms`);
  console.log(`CPU ${c[0]} %, longest ISR ${c[1]}/${c[2]} us, overload ${c[3]}; draws last ${L.map((x) => (x / 1000).toFixed(1)).join('/')} worst ${W.map((x) => (x / 1000).toFixed(1)).join('/')} n ${Nn.join('/')}`);
  if (PLAY) await ev('tap', [12]);
} finally { await browser.close(); editor.stop?.(); process.exit(0); }
