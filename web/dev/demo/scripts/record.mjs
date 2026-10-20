// One continuous take of the editor for the demo video: the riff (../riffs/vernon.mid) played on the computer keyboard
// while a scripted pointer goes through the shots. Writes public/take/: frames (JPEG, timestamped), audio.webm (the
// app's own output, recorded inside the page) and take.json (the frame times, the shots and where the camera looks).
// Needs the dev server (npm run dev in web/) on http://localhost:5173. Then: node scripts/make-take.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, box, W, H } from './setup.mjs';
import { rig } from './rig.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, '../public/take');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'frames'), { recursive: true });

// ---- the riff: note on / off times in ms at the demo tempo, from its first note
const BPM = 97;
/** the kick's envelope onto the cutoff: how far each hit pulls it down */
const DEPTH = -0.32;
function readMidi(file) {
  const d = fs.readFileSync(file);
  const div = d.readUInt16BE(12);
  let i = 14;
  const notes = [];
  const vlq = () => { let v = 0, c; do { c = d[i++]; v = (v << 7) | (c & 0x7f); } while (c & 0x80); return v; };
  while (i < d.length) {
    const end = i + 8 + d.readUInt32BE(i + 4);
    i += 8;
    let tick = 0, st = 0;
    const on = new Map();
    while (i < end) {
      tick += vlq();
      const c = d[i];
      if (c === 0xff) { i += 2; const l = vlq(); i += l; continue; }
      if (c === 0xf0 || c === 0xf7) { i++; const l = vlq(); i += l; continue; }
      if (c & 0x80) { st = c; i++; }
      const hi = st & 0xf0;
      if (hi === 0xc0 || hi === 0xd0) { i++; continue; }
      const a = d[i], v = d[i + 1];
      i += 2;
      if (hi === 0x90 && v > 0) on.set(a, tick);
      else if ((hi === 0x80 || hi === 0x90) && on.has(a)) { notes.push({ t: on.get(a), len: tick - on.get(a), n: a }); on.delete(a); }
    }
    i = end;
  }
  return { div, notes: notes.sort((a, b) => a.t - b.t) };
}
const { div, notes } = readMidi(path.join(here, '../../riffs/vernon.mid'));
const msPerTick = 60000 / BPM / div;
const first = notes[0].t;
const bar = 4 * div;
const loopTicks = Math.ceil((Math.max(...notes.map((n) => n.t + n.len)) - first) / bar) * bar;
// an octave down, as the note keys play it in this patch (octave -1)
const riff = notes.map((n) => ({ at: (n.t - first) * msPerTick, len: Math.max(30, n.len * msPerTick - 8), note: n.n - 12 }));
const loopMs = loopTicks * msPerTick;

const { browser, page } = await open();
const BAR = 4 * 60000 / BPM;
// the drums, off, with their tracks filled, right of Vernon (rig.mjs)
await rig(page, { kick: { x: 1000, y: 40 }, ks: { x: 1000, y: 360 }, hats: { x: 1400, y: 40 }, hs: { x: 1400, y: 360 } });

// ---- a visible pointer (headless Chrome draws none) and a ring on each press
await page.evaluate(() => {
  const c = document.createElement('div');
  c.id = 'demo-cursor';
  c.innerHTML = '<svg width="34" height="40" viewBox="0 0 17 20"><path d="M1.5 1.5 L1.5 15.5 L5.2 12 L8 18.2 L10.6 17.1 L7.9 11 L13 11 Z" fill="#fff7e8" stroke="#171f21" stroke-width="1.3" stroke-linejoin="round"/></svg>';
  Object.assign(c.style, { position: 'fixed', left: '0', top: '0', zIndex: '2147483647', pointerEvents: 'none', transform: 'translate(-3px,-3px)', filter: 'drop-shadow(0 2px 3px rgba(0,0,0,.45))' });
  document.body.append(c);
  const ring = (x, y) => {
    const r = document.createElement('div');
    Object.assign(r.style, { position: 'fixed', left: `${x - 18}px`, top: `${y - 18}px`, width: '36px', height: '36px', borderRadius: '50%', border: '3px solid #79c7c1', zIndex: '2147483646', pointerEvents: 'none', transition: 'transform .45s ease-out, opacity .45s ease-out', opacity: '.9' });
    document.body.append(r);
    requestAnimationFrame(() => requestAnimationFrame(() => { r.style.transform = 'scale(1.7)'; r.style.opacity = '0'; }));
    setTimeout(() => r.remove(), 600);
  };
  addEventListener('mousemove', (e) => { c.style.left = `${e.clientX}px`; c.style.top = `${e.clientY}px`; }, true);
  addEventListener('mousedown', (e) => ring(e.clientX, e.clientY), true);
});

let pointer = { x: W * 0.55, y: H * 0.5 };
await page.mouse.move(pointer.x, pointer.y);

// ---- the recording
const cdp = await page.context().newCDPSession(page);
const frames = [];
cdp.on('Page.screencastFrame', (f) => {
  const n = frames.length;
  frames.push(f.metadata.timestamp * 1000);
  fs.writeFileSync(path.join(OUT, 'frames', `${String(n).padStart(5, '0')}.jpg`), Buffer.from(f.data, 'base64'));
  cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
});
await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, everyNthFrame: 1 });
await page.waitForTimeout(300);
const t0 = await page.evaluate(() => window.__rec());
const now = () => Date.now() - t0;
const shots = [];
const shot = (name, rect, zoom = 1) => { shots.push({ t: now(), name, rect, zoom }); console.log(`${(now() / 1000).toFixed(1)}s ${name}`); };
const wait = (ms) => page.waitForTimeout(ms);

// the riff, once through, scheduled in the page through the note input the keys use (main.ts __notes, the dev server's;
// the letter keys stop while a dialog is open). __riffOne: its first note, the 1 every bar counts from
const R = await page.evaluate(({ riff }) => {
  const send = (type, note) => window.__notes.send(type === 'keydown' ? { t: 'on', note, vel: 0.8 } : { t: 'off', note });
  const start = performance.now() + 400;
  window.__riffOne = start;
  for (const n of riff) {
    setTimeout(() => send('keydown', n.note), start + n.at - performance.now());
    setTimeout(() => send('keyup', n.note), start + n.at + n.len - performance.now());
  }
  return start;
}, { riff });
/** wait until `lead` ms before page time t */
const until = async (t, lead = 0) => { const d = await page.evaluate((x) => x - performance.now(), t); if (d - lead > 0) await wait(d - lead); else if (lead) console.log(`LATE by ${(lead - d).toFixed(0)} ms`); };
/** page time of the riff's bar n (0: its first note) */
const barAt = (n) => R + n * BAR;

const ease = (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
/** move the pointer along `at(k)` (k 0..1, eased) for `ms` of wall time: paced by the clock, not by step counts */
async function along(at, ms) {
  const t = Date.now();
  for (;;) {
    const k = Math.min(1, (Date.now() - t) / ms);
    const p = at(ease(k));
    await page.mouse.move(p.x, p.y);
    pointer = p;
    if (k >= 1) return;
    await wait(8);
  }
}
const glide = (x, y, ms = 700) => { const f = { ...pointer }; return along((e) => ({ x: f.x + (x - f.x) * e, y: f.y + (y - f.y) * e }), ms); };
async function clickAt(p, ms = 700) { await glide(p.x, p.y, ms); await wait(120); await page.mouse.down(); await wait(90); await page.mouse.up(); }
/** press at a, move to b in `ms`, let go; the approach and the pauses scale with it (a quick drag is quick throughout) */
async function drag(a, b, ms = 900) {
  const pause = Math.min(150, ms / 5);
  await glide(a.x, a.y, Math.min(600, ms)); await wait(pause); await page.mouse.down();
  await along((e) => ({ x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e }), ms);
  await wait(pause); await page.mouse.up();
}
/** press at p and move up by `dy` and back down to where it started (a knob turned and returned), in `ms` */
async function sweep(p, dy, ms) {
  await glide(p.x, p.y, 800); await wait(120); await page.mouse.down();
  await along((e) => ({ x: p.x, y: p.y - dy * Math.sin(Math.PI * e) }), ms);
  await wait(100); await page.mouse.up();
}
const rectOf = async (loc) => (await box(loc)).b;
const union = (...rs) => { const x = Math.min(...rs.map((r) => r.x)), y = Math.min(...rs.map((r) => r.y)); return { x, y, width: Math.max(...rs.map((r) => r.x + r.width)) - x, height: Math.max(...rs.map((r) => r.y + r.height)) - y }; };
const FULL = { x: 0, y: 0, width: W, height: H };

// 0: the panel; the transport starts with the riff (the drum tracks count from its first note; the brand fades over this)
shot('panel', FULL);
await page.evaluate(() => document.activeElement?.blur?.());
await until(R, 8);
await page.keyboard.press('Space');

// 1: four bars to bring the kick in: its track onto its gate, its envelope onto Vernon's cutoff (the depth below zero the
// moment the cable lands, so the beat ducks the synth), then its switch on, on bar 5's 1
const card = (re) => page.locator('#modules > .module').filter({ hasText: re }).first();
const kickCard = card(/kick/i), hatsCard = card(/hats/i);
const tracks = page.locator('#modules > .module').filter({ has: page.locator('.step') });
const [ks, hs] = (await Promise.all([0, 1].map(async (i) => ({ t: tracks.nth(i), x: (await box(tracks.nth(i))).x })))).sort((p, q) => p.x - q.x).map((o) => o.t);
const cutRow = page.locator('.param.bar[data-mod="10"][data-param="cutoff"]').first();
const cutJack = await box(cutRow.locator('.slider-port').first());
shot('kick', union(cutJack.b, await rectOf(kickCard), await rectOf(ks)), 1.0);
await wait(1600);
await drag(await box(ks.locator('.dot[data-port="trig"][data-dir="out"]')), await box(kickCard.locator('.dot[data-port="gate"]').first()), 800);
await wait(300);
const envOut = await box(kickCard.locator('.dot[data-port="env"][data-dir="out"]').first());
await glide(envOut.x, envOut.y, 550); await wait(120); await page.mouse.down();
// (the thumb rides on the cutoff's live value, which Vernon's own envelope moves: found again on the way and at the drop)
const thumb = cutRow.locator('.slider-port').first();
let to = await box(thumb);
await along((e) => ({ x: envOut.x + (to.x - envOut.x) * e, y: envOut.y + (to.y - envOut.y) * e }), 850);
to = await box(thumb);
await glide(to.x, to.y, 120);
to = await box(thumb);
await page.mouse.move(to.x, to.y);
await wait(40);
await page.mouse.up();
await page.evaluate(async (depth) => {
  document.querySelector('.param.bar[data-mod="10"][data-param="cutoff"] summary').click();
  for (let i = 0; i < 60; i++) {
    const d = document.querySelector('.routing-controls:popover-open input[type=range]');
    if (d) { d.value = String(depth); d.dispatchEvent(new Event('input', { bubbles: true })); d.dispatchEvent(new Event('change', { bubbles: true })); return; }
    await new Promise((r) => requestAnimationFrame(r));
  }
}, DEPTH);
console.log('depth', await page.locator('.routing-controls:popover-open input[type=range]').first().evaluate((e) => e.value, null, { timeout: 3000 }).catch(async (e) => { await page.screenshot({ path: '/tmp/demo-fail.png' }); throw e; }));
await wait(1200);
await page.keyboard.press('Escape');
const kp = await box(kickCard.locator('button[title^="kick on / off"]').first());
await glide(kp.x, kp.y, 700);
await until(barAt(4), 130);
await page.mouse.down(); await wait(50); await page.mouse.up();

// 2: four bars for the hats: the cutoff swept under the ducking, then their track onto their gate, on on bar 9's 1
// a row picked on the panel puts its page on K1..K4; K1 swept (the kick ducking it)
const cutoffRow = page.locator('.param.bar[data-mod="10"][data-param="cutoff"]').first();
const rowBox = await box(cutoffRow);
// (pressed on its thumb: a press elsewhere on the bar would also jump the value there)
await clickAt(await box(cutoffRow.locator('.slider-port').first()), 800);
await wait(500);
const k = page.locator('.deck-knob .dial');
const k1 = await box(k.first());
shot('knobs', union(rowBox.b, await rectOf(page.locator('.dock-knobs').first())), 1.0);
await wait(300);
await sweep(k1, 55, 2200);
await wait(300);

shot('hats', union(await rectOf(kickCard), await rectOf(hatsCard), await rectOf(hs)), 1.0);
await wait(400);
await drag(await box(hs.locator('.dot[data-port="trig"][data-dir="out"]')), await box(hatsCard.locator('.port').filter({ hasText: /^\s*gate/i }).locator('.dot').first()), 700);
const hp = await box(hatsCard.locator('button[title^="hats on / off"]').first());
await glide(hp.x, hp.y, 700);
await until(barAt(8), 130);
await page.mouse.down(); await wait(50); await page.mouse.up();
shot('groove', FULL);
await wait(700);

// 1: the doll opens: Vernon 100, then the voice inside it
const chev = page.locator('button.chev');
await clickAt(await box(chev.first()));
await wait(500);
const asmRect = await rectOf(page.locator('.frame').first()).catch(() => FULL);
shot('open', asmRect, 1.15);
await wait(1000);
const voiceChev = chev.nth(1);
const vb = await box(voiceChev);
shot('voice', { x: vb.x - 60, y: vb.y - 40, width: 900, height: 520 }, 1.33);
await clickAt(vb, 900);
await wait(1100);
// opened, the voice lies over its neighbours: Tidy packs the cards
shot('tidy', FULL);
await clickAt(await box(page.getByRole('button', { name: 'Tidy' })), 1000);
await wait(1000);

// 2: a cable that runs behind a card: hovered, it glows through
const spot = await page.evaluate(() => {
  const cards = [...document.querySelectorAll('#modules .module')].map((m) => m.getBoundingClientRect());
  const inside = (x, y, pad = 0) => cards.some((r) => x > r.left - pad && x < r.right + pad && y > r.top - pad && y < r.bottom + pad);
  let best = null;
  for (const p of document.querySelectorAll('#cables path.cable')) {
    if (p.classList.contains('keys')) continue;
    const L = p.getTotalLength(), m = p.getScreenCTM();
    if (!m || L < 200) continue;
    let behind = 0, free = null;
    for (let t = 0.04; t < 0.96; t += 0.02) {
      const q = p.getPointAtLength(L * t), x = q.x * m.a + m.e, y = q.y * m.d + m.f;
      if (inside(x, y)) behind++;
      else if (!free && !inside(x, y, 14) && document.elementFromPoint(x, y) === p) free = { x, y };
    }
    const r = p.getBoundingClientRect();
    if (free && behind > 4 && (!best || behind > best.behind)) best = { behind, free, rect: { x: r.x, y: r.y, width: r.width, height: r.height } };
  }
  return best;
});
if (spot) {
  shot('glow', spot.rect, 1.2);
  await glide(spot.free.x, spot.free.y, 1100);
  await wait(2000);
}

// 4: the doll closes back to its panel
await clickAt(await box(chev.nth(1)), 800);
await wait(500);
await clickAt(await box(chev.first()), 900);
shot('panel2', FULL);
await wait(900);

// 8: + ARP: one click puts an arpeggiator in
const arpBtn = page.locator('.panel-btn[data-button="arp"]');
const ab = await box(arpBtn);
shot('arp-btn', { x: ab.x - 420, y: ab.y - 260, width: 840, height: 400 }, 1.33);
await clickAt(ab, 1000);
await wait(900);
const arpCard = page.locator('#modules .module').filter({ hasText: 'Arpeggiator' }).first();
const arpRect = await rectOf(arpCard).catch(() => FULL);
shot('arp', union(arpRect, ab.b, await rectOf(page.locator('#modules > *').first())), 1.0);
await wait(2800);

// 7: the FM-1 view: the same patch on the device's own screen
await page.evaluate(() => document.querySelector('.toast')?.remove());   // (a locator click would jump the pointer)
const fm1 = page.locator('#view-switch [data-view="fm1"]');
await clickAt(await box(fm1), 900);
const body = await rectOf(page.locator('.fm1-body'));
shot('fm1', body, 1.33);
await wait(1000);
const dial = page.locator('.fm1-dial.k1').first();
const db = await box(dial);
shot('fm1-knob', { x: body.x + body.width * 0.3, y: body.y, width: body.width * 0.7, height: body.height * 0.75 }, 1.33);
await sweep(db, 45, 2400);
await wait(1100);
await clickAt(await box(page.locator('#view-switch [data-view="patch"]')), 900);
shot('back', FULL);
await wait(1200);

// out: the pointer leaves, the riff plays on under the brand
await glide(W * 0.62, H * 0.4, 900);
shot('end', FULL);
console.log(`riff ends in ${((R + loopMs - (await page.evaluate(() => performance.now()))) / 1000).toFixed(1)} s`);
await until(R + loopMs + 1200);
const b64 = await page.evaluate(() => window.__stop());
await cdp.send('Page.stopScreencast');
fs.writeFileSync(path.join(OUT, 'audio.webm'), Buffer.from(b64, 'base64'));
const end = now();
fs.writeFileSync(path.join(OUT, 'take.json'), JSON.stringify({ width: W, height: H, end, frames: frames.map((t) => t - t0), shots }, null, 1));
console.log(`take: ${(end / 1000).toFixed(1)} s, ${frames.length} frames (${(frames.length / (end / 1000)).toFixed(1)} fps)`);
await browser.close();
