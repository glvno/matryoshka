// scratch: step entry + paging with the sequencer running; ack latency per key (a hung main loop answers late)
import { chromium } from 'playwright-core';
import { rigPage, startEditor, survey } from './rig-link.mjs';
const PATCH = process.argv[2] ?? 'ELVIRA 2';
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
  await sleep(1500);
  await ev('tap', [12]); await sleep(1500);            // PLAY
  const timed = async (f, a) => { const t = performance.now(); await ev(f, a); return performance.now() - t; };
  const stats = (xs) => { xs.sort((a, b) => a - b); return `median ${xs[xs.length >> 1].toFixed(0)} ms, worst ${xs[xs.length - 1].toFixed(0)} ms (n ${xs.length})`; };
  for (const k of [14, 18, 21, 25]) await ev('key', [k, true]);   // a held chord: voices sound
  await sleep(800);
  console.log('peak with chord', JSON.stringify(await ev('peak', [])));
  await ev('diag', [127]);
  // paging while running
  const pg = [];
  for (let r = 0; r < 3; r++) for (const c of [1, 1, 1, -1, -1, -1]) { pg.push(await timed('turn', [1, c])); await sleep(150); }
  for (let r = 0; r < 2; r++) for (const c of [1, -1]) { pg.push(await timed('turn', [0, c])); await sleep(150); }
  let c = u32(await ev('diag', [127]));
  console.log('peak after paging', JSON.stringify(await ev('peak', [])));
  for (const k of [14, 18, 21, 25]) await ev('key', [k, false]);
  console.log(`paging: ack ${stats(pg)}; CPU ${c[0]} %, longest ISR ${c[1]}/${c[2]} us, overload ${c[3]}`);
  // step entry on the SEQ page
  await ev('tap', [11]); await sleep(800);
  const st = [];
  for (let i = 0; i < 24; i++) { const k = 14 + (i * 5) % 16; const t = performance.now(); await ev('key', [k, true]); await sleep(40); await ev('key', [k, false]); st.push(performance.now() - t - 40); await sleep(60); }
  const t0 = performance.now(); await ev('screen', []); const scr = performance.now() - t0;
  c = u32(await ev('diag', [127]));
  console.log(`steps: key ack ${stats(st)}; screen read after ${scr.toFixed(0)} ms; CPU ${c[0]} %, longest ISR ${c[1]}/${c[2]} us, overload ${c[3]}`);
  const p = await ev('peak', []); console.log('peak', JSON.stringify(p));
  await ev('tap', [12]); await sleep(300);
  // undo the steps: leave it to the reinstall / the owner
} finally { await browser.close(); editor.stop?.(); process.exit(0); }
