// shared by probe / record: a fresh Chromium on the dev server with the demo's patch (Vernon 100 at 97 bpm, ARP free)
import { chromium } from 'playwright';
export const W = 2560, H = 1440;
export async function open(url = 'http://localhost:5173/') {
  const browser = await chromium.launch({ channel: 'chromium', args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1, colorScheme: 'dark' });
  await page.addInitScript(() => { try { localStorage.setItem('matryoshka.tutorial-offer-off', '1'); } catch {} });
  // the app's output also into a MediaStream, recorded by __rec / __stop (the live sound, in step with the screen)
  await page.addInitScript(() => {
    const orig = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function (dest, ...rest) {
      const r = orig.call(this, dest, ...rest);
      if (dest === this.context.destination) orig.call(this, (window.__tap ??= this.context.createMediaStreamDestination()));
      return r;
    };
    window.__rec = () => {
      const chunks = [];
      const rec = new MediaRecorder(window.__tap.stream, { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 320000 });
      rec.ondataavailable = (e) => chunks.push(e.data);
      window.__stop = () => new Promise((res) => {
        rec.onstop = async () => {
          const buf = new Uint8Array(await new Blob(chunks).arrayBuffer());
          let s = '';
          for (let i = 0; i < buf.length; i += 32768) s += String.fromCharCode(...buf.subarray(i, i + 32768));
          res(btoa(s));
        };
        rec.stop();
      });
      rec.start();
      return Date.now();
    };
  });
  await page.goto(url);
  await page.waitForTimeout(1200);
  await page.evaluate(async () => {
    const { PRESETS } = await import('/src/presets.ts');
    const { setKind } = await import('/src/buttons.ts');
    const p = PRESETS['Vernon 100']();
    p.modules.find((m) => m.type === 'fm1').params.tempo = 97;
    setKind(p, 'arp', 'nothing');
    p.cables = p.cables.filter((c) => !(c.from.port === 'arp' && p.modules.find((m) => m.id === c.from.module)?.type === 'fm1'));
    localStorage.setItem('matryoshka.patch', JSON.stringify(p));
  });
  await page.reload();
  await page.waitForTimeout(1500);
  await zoom(page);
  return { browser, page };
}
/** the canvas at 125 %: the cards fill the 2560 px view (the slider is a position, searched for the figure) */
export async function zoom(page) {
  await page.evaluate(() => {
    const input = document.getElementById('zoom-input');
    const out = document.getElementById('zoom-out');
    const set = (v) => { input.value = String(v); input.dispatchEvent(new Event('input', { bubbles: true })); return parseFloat(out.textContent); };
    let lo = 0, hi = 1;
    for (let i = 0; i < 30; i++) { const m = (lo + hi) / 2; if (set(m) < 125) lo = m; else hi = m; }
    set(hi);
    document.getElementById('canvas').scrollTo(0, 0);   // (zooming scrolls about the middle: back to the top left)
  });
  await page.waitForTimeout(300);
}
export const box = async (loc) => {
  const b = await loc.boundingBox({ timeout: 8000 }).catch(async (e) => {
    // a target that is not there: the page as it was, for finding out why
    await loc.page().screenshot({ path: '/tmp/demo-fail.png' }).catch(() => {});
    throw e;
  });
  if (!b) throw new Error('no box');
  return { x: b.x + b.width / 2, y: b.y + b.height / 2, b };
};
