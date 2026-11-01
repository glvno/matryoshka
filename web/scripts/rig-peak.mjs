// SPDX-License-Identifier: GPL-3.0-only
// The test rig's TEST_PEAK, surveyed (#385): reads the output's peak in windows of 25 ms, as the scenarios' profiles do.
// It counts the long windows (a read that got no answer and was asked again 2 s later: its answer covers the whole 2 s)
// and the loud windows their neighbours do not explain, with every window and without the long ones. Run from web/, the
// rig connected (take the rig's lock first when other sessions share it):
//   node scripts/rig-peak.mjs [--patch NAME] [--reads N] [--play] [--key] [--raw]
// --patch: the patch to open first (PRESET knob, by name on the screen). --play: the transport runs (the patch's own
// tracks). --key: a chord is held (a steady level). Without either: nothing plays, so any window above 64 is an outlier.
// --raw: the MIDI the page sent and received is kept and printed around each long window and outlier.
// --link (#486): the FM-1's link counters (DIAG 117 / 118) before and after, beside the frames the page sent and got: where
// an unanswered request was lost (never reached the FM-1, reached it and no answer was sent, or the answer was lost on the way).
// --params N (#486): N PARAM frames before each read (to a module no patch has: they change nothing), unanswered as the
// editor's are; with --link the FM-1's count of editor frames handled says whether any was lost.
import { chromium } from 'playwright-core';
import { pickRig, rigPage, startEditor } from './rig-link.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const flag = (n) => args.includes(n);
const PATCH = opt('--patch');
const READS = Number(opt('--reads', 2000));
const MS = Number(opt('--ms', 25));
const PARAMS = Number(opt('--params', 0));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const QUIET = 64;

const editor = await startEditor();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
let code = 0;
try {
  const ctx = await browser.newContext();
  await ctx.grantPermissions(['midi', 'midi-sysex'], { origin: new URL(editor.url).origin });
  const page = await rigPage(ctx, editor.url);
  const s = await pickRig(page);
  const ev = (f, a = []) => page.evaluate(([f, a]) => window.__rig[f](...a), [f, a]);
  const shows = async (t) => (await ev('screen')).texts.some((x) => x.s.includes(t));
  for (let i = 0; i < 6 && (await ev('screen')).page !== 0; i++) { await ev('tap', [8]); await sleep(300); }
  if (PATCH) {
    let found = await shows(PATCH);
    for (let i = 0; i < 64 && !found; i++) { await ev('turn', [6, 1]); await sleep(400); found = await shows(PATCH); }
    if (!found) throw new Error(`no ${PATCH}`);
    await sleep(1500);
  }
  if (flag('--raw')) {
    await page.evaluate(async (inId) => {
      const a = await navigator.requestMIDIAccess({ sysex: true });
      window.__raw = [];
      a.inputs.get(inId).addEventListener('midimessage', (e) => window.__raw.push([performance.now(), Array.from(e.data)]));
      const send = MIDIOutput.prototype.send;
      MIDIOutput.prototype.send = function (d, t) { window.__raw.push([performance.now(), ['>', ...Array.from(d)]]); return send.call(this, d, t); };
    }, s.rig.inId);
  }
  const chord = [14, 18, 21, 25];
  if (flag('--play')) { await ev('tap', [12]); await sleep(500); }
  if (flag('--key')) { for (const k of chord) await ev('key', [k, true]); await sleep(500); }
  const u32s = (b) => Array.from({ length: b.length >> 2 }, (_, i) => (b[4 * i] | b[4 * i + 1] << 8 | b[4 * i + 2] << 16 | b[4 * i + 3] << 24) >>> 0);
  const link = async () => ({ in: u32s(await ev('diag', [118])), out: u32s(await ev('diag', [117])) });
  const link0 = flag('--link') ? await link() : null;
  const count0 = await page.evaluate(() => ({ ...window.__rigCount }));
  // the windows, read in the page, 500 per call: [time read (ms), peak, running, reply (ms)]
  const w = [];
  await page.evaluate(() => window.__rig.peak());
  for (let left = READS; left > 0; left -= 500) {
    w.push(...await page.evaluate(async ([n, ms, params]) => {
      const out = [];
      for (let i = 0; i < n; i++) {
        await new Promise((r) => setTimeout(r, ms));
        for (let k = 0; k < params; k++) window.__rig.noopParam();
        const t = performance.now();
        const p = await window.__rig.peak();
        out.push([t, p.peak, p.running ? 1 : 0, performance.now() - t]);
      }
      return out;
    }, [Math.min(500, left), MS, PARAMS]));
  }
  const count1 = await page.evaluate(() => ({ ...window.__rigCount }));
  const link1 = link0 ? await link() : null;
  if (flag('--key')) for (const k of chord) await ev('key', [k, false]);
  if (flag('--play')) await ev('tap', [12]);
  const raw = flag('--raw') ? await page.evaluate(() => window.__raw) : [];
  const hex = (d) => d.map((x) => (typeof x === 'string' ? x : x.toString(16).padStart(2, '0'))).join(' ');
  // a long window: from the reply before to this reply, far longer than asked (a read answered only when read again)
  const end = (k) => w[k][0] + w[k][3];
  const long = new Set([...w.keys()].filter((k) => k > 0 && end(k) - end(k - 1) > MS + 500));
  // an outlier: loud (above QUIET), and more than 3 times both neighbours (with nothing playing: anything above QUIET)
  const silent = !flag('--play') && !flag('--key');
  const outliers = (ks) => ks.filter((k, j) => {
    const v = w[k][1], a = j ? w[ks[j - 1]][1] : 0, b = j + 1 < ks.length ? w[ks[j + 1]][1] : 0;
    return silent ? v > QUIET : v > QUIET && v > 3 * a && v > 3 * b;
  });
  const all = [...w.keys()];
  const before = outliers(all), after = outliers(all.filter((k) => !long.has(k)));
  const rtt = w.map((x) => x[3]).sort((a, b) => a - b);
  const vals = w.map((x) => x[1]).sort((a, b) => a - b);
  console.log(`${w.length} windows (${PATCH ?? 'the patch as it was'}${flag('--play') ? ', running' : ''}${flag('--key') ? ', chord held' : ''}): `
    + `peak median ${vals[vals.length >> 1]}, max ${vals[vals.length - 1]}; reply ${rtt[rtt.length >> 1].toFixed(1)} ms median, ${rtt[rtt.length - 1].toFixed(1)} worst`);
  console.log(`LONG ${long.size} windows (a read answered only when asked again)`);
  console.log(`OUTLIERS every window ${before.length} (${before.filter((k) => long.has(k)).length} of them long); without the long windows ${after.length}`);
  for (const k of new Set([...long, ...before])) {
    console.log(`  window ${k}${long.has(k) ? ` (long: ${(end(k) - end(k - 1)).toFixed(0)} ms)` : ''}: ${w.slice(Math.max(0, k - 3), k + 4).map((x) => x[1]).join(',')}`);
    if (raw.length) for (const [t, d] of raw) if (t >= w[k][0] - 5 && t <= end(k) + 1) console.log(`    ${(t - w[k][0]).toFixed(1)} ms: ${hex(d)}`);
  }
  const sent = count1.sent - count0.sent, got = count1.got - count0.got;
  console.log(`page: ${sent} frames sent, ${got} answers got, ${count1.garbled - count0.garbled} garbled`);
  if (link0) {
    const d = (a, b) => b.map((v, i) => (v - a[i]) >>> 0);
    const i = d(link0.in, link1.in), o = d(link0.out, link1.out);
    // (two DIAG reads land inside the deltas: 117 before and 118 after, each a frame in and an answer out)
    console.log(`FM-1 in:  ${i[0]} packets, ${i[1]} events, ${i[2]} frames (the page sent ${sent} + 2 DIAG), ${i[3]} cut short, ${i[4]} orphan bytes, ${i[5]} not taken; the editor's handler took ${i[6]}, the update protocol ${i[7]}`);
    console.log(`FM-1 out: ${o[0]} messages sent (the page got ${got} + 2 DIAG), ${o[1]} refused (no host), ${o[2]} refused (no room), ${o[3]} packets; bus: ${o[4]} resets, ${o[5]} suspends, ${o[6]} frame stalls; now ${link1.out[7] >> 8} packets queued, flags ${link1.out[7] & 255}`);
    const lost = sent + 2 - i[6];
    console.log(lost ? `LOST ${lost} of ${sent + 2} editor frames between the page and the FM-1's handler` : `every one of the ${sent + 2} editor frames reached the FM-1's handler`);
  }
  console.log(`rig link log (timeouts, frames no request took): ${JSON.stringify(await page.evaluate(() => window.__rigLog ?? []))}`);
} catch (e) {
  console.error(e.message ?? e);
  code = 1;
} finally {
  await browser.close();
  editor.stop();
}
process.exit(code);
