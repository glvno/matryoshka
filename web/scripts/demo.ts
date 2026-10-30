// SPDX-License-Identifier: GPL-3.0-only
// The preset demo (web/demo/README.md): every FM-1 factory patch's presets on the editor's Emulator view (EMU), in a
// headed Chrome window sized for a screen recording, under two minutes by default.
//   npm run demo [-- --song NAME] [--notes N] [--seconds S | --tempo BPM] [--drum-seconds S] [--init] [--only A,B]
//                [--skip A,B] [--url URL] [--size WxH] [--dry-run] [--headless] [--shots]
// Patches played from the keys come first: each patch is opened, then the PRESET encoder steps its engine's factory
// presets, and each preset plays the next N notes of the song through the panel's keys. Patches that play from a pattern
// (pattern 1 of a Steps track has notes: the drum machines and kits) come last: PLAY runs the pattern and PRESET steps
// the presets, each for --drum-seconds. The page's Web MIDI sees no ports, so no FM-1 is ever reached; nothing is stored.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { parentOf } from '../src/assembly';
import { presetsOf } from '../src/device-presets';
import { instIsEngine } from '../src/engines';
import '../src/factory-presets';
import { binaryPage } from '../src/patchbin';
import { FM1_PRESETS } from '../src/presets';

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = resolve(WEB, '..');
const OUT = join(ROOT, 'build/demo');
const args = process.argv.slice(2);
const flag = (n: string): boolean => args.includes(n);
const opt = (n: string): string | undefined => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const num = (n: string, d: number): number => { const v = opt(n); if (v === undefined) return d; const x = Number(v); if (!Number.isFinite(x) || x <= 0) throw new Error(`${n} takes a positive number`); return x; };
const list = (n: string): string[] | undefined => opt(n)?.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

const SONG = opt('--song') ?? 'moonlight';
const NOTES = Math.round(num('--notes', 3));
const SECONDS = num('--seconds', 117);
const TEMPO = opt('--tempo') ? num('--tempo', 0) : undefined;
const DRUM_S = num('--drum-seconds', 1.5);
const INIT = flag('--init');
const ONLY = list('--only');
const SKIP = list('--skip') ?? [];
const [W, H] = (opt('--size') ?? '1600x900').split('x').map(Number);
/** ms a patch gets to load and show its name before its first preset */
const LOAD_MS = 500;
/** ms a PRESET click gets before the first note (the wheel turn, the engine taking the preset, the check) */
const PRESET_MS = 100;

// ---- the song: web/demo/songs/<name>.json
const SEMI: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const ACC: Record<string, number> = { '': 0, '#': 1, '##': 2, x: 2, b: -1, bb: -2 };
function midi(p: string | number): number {
  if (typeof p === 'number') return p;
  const m = /^([A-Ga-g])(##|#|x|bb|b)?(-?\d)$/.exec(p.trim());
  if (!m) throw new Error(`song ${SONG}: "${p}" is no note name (C#3, Db3, E#1; C4 = MIDI 60)`);
  return 12 * (Number(m[3]) + 1) + SEMI[m[1].toUpperCase()] + ACC[m[2] ?? ''];
}
interface Ev { notes: number[]; beats: number }
const songFile = join(WEB, 'demo/songs', `${SONG}.json`);
if (!existsSync(songFile)) {
  const have = readdirSync(join(WEB, 'demo/songs')).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
  throw new Error(`no song ${SONG} (web/demo/songs/${SONG}.json); there are: ${have.join(', ')}`);
}
const song = JSON.parse(readFileSync(songFile, 'utf8')) as { title?: string; tempo?: number; notes: [string | number | (string | number)[], number][] };
const EVENTS: Ev[] = song.notes.map(([p, beats]) => ({ notes: [...new Set((Array.isArray(p) ? p : [p]).map(midi))], beats }));
if (!EVENTS.length) throw new Error(`song ${SONG} has no notes`);

// the keybed: 27 keys from F3 (MIDI 53) at the panel's octave (-3..3, OCT- / OCT+). The octave that holds most of the
// song's notes; a note outside it is played an octave (or more) in, as a pianist with 27 keys would
const all = EVENTS.flatMap((e) => e.notes);
const OCT = [-3, -2, -1, 0, 1, 2, 3].map((o) => ({ o, n: all.filter((x) => x >= 53 + 12 * o && x <= 79 + 12 * o).length })).sort((a, b) => b.n - a.n || Math.abs(a.o) - Math.abs(b.o))[0].o;
const LO = 53 + 12 * OCT;
let folded = 0;
const KEYED = EVENTS.map((e) => ({
  beats: e.beats,
  keys: [...new Set(e.notes.map((n) => {
    let x = n;
    while (x < LO) x += 12;
    while (x > LO + 26) x -= 12;
    if (x !== n) folded++;
    return x - LO;
  }))],
}));

// ---- the plan: which patches, which presets, in what order (from the patches themselves, as the FM-1 has them)
interface Item { name: string; engine: string | null; device: number; presets: (string | null)[]; why: string }
const keyboard: Item[] = [];
const drums: Item[] = [];
const left: string[] = [];
for (const [name, make] of Object.entries(FM1_PRESETS)) {
  if (ONLY && !ONLY.includes(name.toLowerCase())) continue;
  if (SKIP.includes(name.toLowerCase())) continue;
  const p = make();
  // a patch plays from its pattern when the pattern its Steps track plays on PLAY (pattern 1) has notes
  const pattern = p.modules.some((m) => m.type === 'steps' && (m.notes?.length ?? 0) > 0);
  // its engine: the first top-level engine assembly with factory presets (the device the FM-1's PRESET steps)
  const eng = (p.assemblies ?? []).filter((a) => a && !parentOf(p, a.id) && instIsEngine(p, a))
    .map((a) => ({ a, presets: presetsOf(p, a).filter((x) => x.factory).map((x) => x.name) }))
    .find((x) => x.presets.length);
  const presets = (eng?.presets ?? []).filter((x) => INIT || x !== 'Init');
  const item: Item = { name, engine: eng?.a.label ?? null, device: eng ? binaryPage(p, `a${eng.a.id}`, 0)?.[0] ?? -1 : -1, presets, why: pattern ? 'pattern' : 'keys' };
  if (pattern) drums.push({ ...item, presets: presets.length ? presets : [null] });
  else if (presets.length) keyboard.push(item);
  else left.push(name);
}
if (!keyboard.length && !drums.length) throw new Error('no patch to demo (check --only / --skip)');

const kbPresets = keyboard.reduce((s, i) => s + i.presets.length, 0);
const drumSteps = drums.reduce((s, i) => s + i.presets.length, 0);
// the notes each keyboard preset plays: the song goes on across presets (and patches), from the top again at its end
let cursor = 0;
const take = (): typeof KEYED => Array.from({ length: NOTES }, () => KEYED[cursor++ % KEYED.length]);
const steps = keyboard.map((i) => i.presets.map((name) => ({ name, events: take() })));
const nNotes = steps.flat().reduce((s, x) => s + x.events.length, 0);
const beats = steps.flat().reduce((s, x) => s + x.events.reduce((t, e) => t + e.beats, 0), 0);
const fixedS = ((keyboard.length + drums.length) * LOAD_MS + kbPresets * PRESET_MS) / 1000 + drumSteps * DRUM_S;
// how long a note sounds: by default every note the same (the time left, over the notes played), so each preset is heard
// as long as the next; --rhythm keeps the song's lengths, scaled to fit; --tempo plays them at that tempo
const RHYTHM = flag('--rhythm') || !!TEMPO;
const beatS = TEMPO ? 60 / TEMPO : (SECONDS - fixedS) / Math.max(1e-9, beats);
const evenS = (SECONDS - fixedS) / Math.max(1, nNotes);
const noteS = (e: { beats: number }): number => (RHYTHM ? e.beats * beatS : evenS);
const lens = steps.flat().flatMap((x) => x.events.map(noteS));
if (nNotes && !(Math.min(...lens) > 0.02)) throw new Error(`${SECONDS} s leave no time for the notes (loads, clicks and patterns take ${fixedS.toFixed(1)} s): raise --seconds, lower --drum-seconds, or use --only`);
const kbS = lens.reduce((s, x) => s + x, 0);
const totalS = fixedS + kbS;
const mmss = (s: number): string => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
const r3 = (x: number): number => Math.round(x * 1000) / 1000;

console.log(`song: ${song.title ?? SONG} (${EVENTS.length} entries, ${r3(EVENTS.reduce((s, e) => s + e.beats, 0))} beats)`);
console.log(`keys: octave ${OCT >= 0 ? '+' : ''}${OCT} (F${3 + OCT}..G${5 + OCT})${folded ? `, ${folded} note${folded === 1 ? '' : 's'} played an octave in` : ''}`);
console.log(`\nplayed from the keys: ${keyboard.length} patches, ${kbPresets} presets${INIT ? ' (Init included)' : ' (Init skipped)'}, ${NOTES} notes each`);
for (const i of keyboard) console.log(`  ${i.name.padEnd(16)} ${i.presets.join(', ')}`);
console.log(`\nfrom a pattern (PLAY): ${drums.length} patches, ${drumSteps} steps of ${DRUM_S} s`);
for (const i of drums) console.log(`  ${i.name.padEnd(16)} ${i.presets.map((x) => x ?? '(as it comes: no presets)').join(', ')}`);
if (left.length) console.log(`\nleft out (no factory presets, played from the keys): ${left.join(', ')}`);
const ms = (s: number): string => `${(s * 1000).toFixed(0)} ms`;
if (nNotes) console.log(`\nnote length: ${RHYTHM ? `the song's, a beat ${ms(beatS)} (${(60 / beatS).toFixed(0)} bpm${TEMPO ? ', --tempo' : `, to fit ${SECONDS} s`}): ${ms(Math.min(...lens))}..${ms(Math.max(...lens))}` : `${ms(evenS)} every note (to fit ${SECONDS} s)`}, ${ms(kbS / Math.max(1, kbPresets))} a preset`);
console.log(`time: keys ${kbS.toFixed(1)} s + pattern ${(drumSteps * DRUM_S).toFixed(1)} s + loads and clicks ${(fixedS - drumSteps * DRUM_S).toFixed(1)} s = ${totalS.toFixed(1)} s (${mmss(totalS)})${totalS > SECONDS + 0.5 ? `  OVER the ${SECONDS} s budget` : ''}`);
if (flag('--dry-run')) process.exit(0);

// ---- the browser
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const children: ChildProcess[] = [];
process.on('exit', () => { for (const c of children) try { c.kill(); } catch { /* gone */ } });
// (Ctrl-C mid-run: the storage goes back first)
for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(s, () => void (cleanup?.() ?? Promise.resolve()).catch(() => {}).finally(() => process.exit(130)));
const freePort = (): Promise<number> => new Promise((res) => {
  const s = createServer();
  s.listen(0, '::1', () => { const a = s.address(); const p = typeof a === 'object' && a ? a.port : 0; s.close(() => res(p)); });
});
const answers = async (u: string): Promise<boolean> => {
  try { return (await fetch(u, { signal: AbortSignal.timeout(1500) })).ok; } catch { return false; }
};

/** the page's Web MIDI: no ports at all (a connected FM-1 is never seen, so nothing reaches it) */
const NO_MIDI = (): void => {
  const none = { inputs: new Map(), outputs: new Map(), sysexEnabled: true, onstatechange: null, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false };
  Object.defineProperty(Navigator.prototype, 'requestMIDIAccess', { configurable: true, value: () => Promise.resolve(none) });
};
/** the output's peak: an analyser on whatever feeds the speakers (after MASTER), read and reset by __demoPeak() */
const TAP = (): void => {
  const connect = AudioNode.prototype.connect as (this: AudioNode, ...a: unknown[]) => unknown;
  (AudioNode.prototype as unknown as { connect: unknown }).connect = function (this: AudioNode & { tapped?: true }, ...a: unknown[]) {
    const r = connect.apply(this, a);
    if (a[0] instanceof AudioDestinationNode && !this.tapped) {
      this.tapped = true;
      const an = this.context.createAnalyser();
      an.fftSize = 2048;
      connect.call(this, an);
      const buf = new Float32Array(2048);
      let peak = 0;
      setInterval(() => { an.getFloatTimeDomainData(buf); for (const v of buf) peak = Math.max(peak, Math.abs(v)); }, 20);
      (window as unknown as { __demoPeak: () => number }).__demoPeak = () => { const p = peak; peak = 0; return p; };
    }
    return r;
  };
};
/** the Emulator view alone, filling the window: no sidebar, status line, deck, switch or hint, and no "Over the FM-1
 *  budget" card over the panel (a factory patch near the budget can show one: it still plays) */
const CLEAN = `
#fm1-view { position: fixed !important; inset: 0 !important; z-index: 2147483000 !important; overflow: hidden !important; }
#fm1-view .fm1-hint, #fm1-view .fm1-follow, #fm1-view .fm1-chip, #fm1-view .fm1-alert { display: none !important; }
.sidebar, .mobile-bar, .tutorial-offer, #view-switch, #library-tabs, #fm1-connect, .statusline, .deck, .dock-wrap, #wheels, .help-btn, .side-collapse { visibility: hidden !important; }
#fm1-view .fm1-body { width: min(94vw, calc(94vh * 1280 / 678)) !important; }
`;

async function main(): Promise<void> {
  let url = opt('--url');
  if (!url) {
    url = 'http://[::1]:5173/';
    if (!(await answers(url))) {
      // no dev server on 5173: one of this checkout on a free port (never a second one on 5173)
      const port = await freePort();
      if (!existsSync(join(WEB, 'public/fm1-ui.wasm')) && spawnSync('npm', ['run', '-s', 'fm1-wasm'], { cwd: WEB, stdio: 'inherit' }).status !== 0)
        throw new Error('npm run fm1-wasm failed (the Emulator view needs public/fm1-ui.wasm)');
      const vite = spawn('npx', ['vite', '--port', String(port), '--strictPort', '--host', '::1'], { cwd: WEB, stdio: ['ignore', 'pipe', 'inherit'] });
      children.push(vite);
      url = `http://[::1]:${port}/`;
      await new Promise<void>((res) => vite.stdout!.on('data', (d) => { if (/ready in|Local:/.test(String(d))) res(); }));
      console.log(`\nno dev server answered on [::1]:5173: started one of this checkout on ${url}`);
    }
  }
  if (!url.endsWith('/')) url += '/';
  if (!(await answers(`${url}fm1-ui.wasm`))) throw new Error(`${url}fm1-ui.wasm is missing: run npm run fm1-wasm in that server's web/`);
  console.log(`editor: ${url}`);
  mkdirSync(OUT, { recursive: true });
  if (flag('--shots')) for (const f of readdirSync(OUT)) if (f.endsWith('.png')) rmSync(join(OUT, f));   // (the last run's)

  const headless = flag('--headless');
  const browser = await chromium.launch({ channel: 'chrome', headless, ignoreDefaultArgs: ['--enable-automation'], args: ['--autoplay-policy=no-user-gesture-required', `--window-size=${W},${H + 88}`] });
  const context = await browser.newContext({ viewport: { width: W, height: H } });
  await context.addInitScript(NO_MIDI);
  await context.addInitScript(TAP);
  // this origin's storage as it was before the page's first script: put back exactly when the demo ends, however it ends
  // (opening patches writes the open patch; a sandbox patch marks its card seen)
  // (kept in this tab's sessionStorage, so a reload of the page, say by the dev server, keeps the first one)
  await context.addInitScript(() => {
    const w = window as unknown as { __demoBefore?: Record<string, string> };
    const kept = sessionStorage.getItem('matryoshka-demo.before');
    w.__demoBefore = kept ? JSON.parse(kept) : Object.fromEntries(Object.keys(localStorage).map((k) => [k, localStorage.getItem(k)!]));
    if (!kept) sessionStorage.setItem('matryoshka-demo.before', JSON.stringify(w.__demoBefore));
  });
  const page = await context.newPage();
  cleanup = async () => {
    const back = await page.evaluate(() => {
      const b = (window as unknown as { __demoBefore?: Record<string, string> }).__demoBefore;
      if (!b) return null;
      const changed = Object.keys(localStorage).filter((k) => localStorage.getItem(k) !== (b[k] ?? null));
      for (const k of Object.keys(localStorage)) if (!(k in b)) localStorage.removeItem(k);
      for (const [k, v] of Object.entries(b)) localStorage.setItem(k, v);
      return changed;
    }).catch(() => null);
    console.log(back ? `storage: ${back.length ? `put back ${back.join(', ')}` : 'unchanged'}` : 'warning: could not put this origin\'s storage back');
    await browser.close();
  };
  page.on('pageerror', (e) => console.log(`  page error: ${e.message}`));
  await page.goto(`${url}#emu`);
  await page.waitForFunction(() => !!(window as unknown as { __m1test?: unknown }).__m1test, null, { timeout: 30000 });
  await page.keyboard.press('Escape');   // a welcome card or dialog of a first visit
  await page.addStyleTag({ content: CLEAN });
  const call = <R>(f: string, ...a: unknown[]): Promise<R> => page.evaluate(([f, a]) => {
    const t = (window as unknown as { __m1test: Record<string, (...x: unknown[]) => unknown> }).__m1test;
    if (typeof t[f as string] !== 'function') throw new Error(`the page has no __m1test.${f as string}: is it a dev server of a checkout with the demo hook?`);
    return t[f as string](...(a as unknown[]));
  }, [f, a] as const) as Promise<R>;
  type EmuState = { loaded: string; device: number; page: number; octave: number };
  const emuState = (): Promise<EmuState> => call<EmuState>('emu');
  await page.waitForFunction(() => document.querySelector('.fm1-lcd') !== null, null, { timeout: 15000 });
  for (let t = Date.now(); (await emuState()).device < 0 && Date.now() - t < 15000; ) await sleep(100);

  // The controls: the panel's own elements and handlers, as a person's input reaches them. Encoders get wheel events
  // (fm1-view.ts: one click each), keys pointer events (two at once for a dyad, which one mouse cannot do), buttons real
  // clicks. A preset's whole step (the PRESET click, the check, its notes, the peak) is one call into the page, timed
  // there against the plan's clock (Date.now() is the same clock on both sides): a busy page costs no round trips.
  const button = (label: string): Promise<void> =>
    page.locator('.fm1-btn', { hasText: new RegExp(`^${label.replace(/[+-]/g, '\\$&')}$`) }).click({ delay: 60 });
  type Now = { name: string; off: number; rows: number } | null;
  interface Step { clicks: number; engine: string | null; want: string | null; notesAt: number; end: number; notes: { keys: number[]; ms: number }[] }
  const step = (s: Step): Promise<{ now: Now; peak: number; k: number }> => page.evaluate(async (s) => {
    const w = window as unknown as { __m1test: { presetNow(l: string): Now }; __demoPeak?: () => number };
    const until = (t: number): Promise<void> => new Promise((r) => setTimeout(r, Math.max(0, t - Date.now())));
    const wheel = (label: string, clicks: number): void => {
      const d = document.querySelector(`#fm1-view [aria-label="${label} encoder"]`);
      for (let i = 0; i < Math.abs(clicks); i++) d?.dispatchEvent(new WheelEvent('wheel', { deltaY: clicks > 0 ? -100 : 100, bubbles: true, cancelable: true }));
    };
    const key = (k: number, type: string): void => {
      document.querySelector(`#fm1-view .fm1-key[aria-label="key ${k + 1}"]`)
        ?.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 100 + k, pointerType: 'touch', isPrimary: false }));
    };
    wheel('Presets', s.clicks);
    let now = s.engine ? w.__m1test.presetNow(s.engine) : null;
    // (a patch whose values matched no preset as it came: the first click lands on Init, one more goes on)
    if (s.want && s.want !== 'Init' && now?.name === 'Init' && !now.off) { wheel('Presets', 1); now = w.__m1test.presetNow(s.engine!); }
    await until(s.notesAt);
    // late (a slow page): the notes are shortened so that the step still ends on time, by half at most
    const len = s.notes.reduce((t, e) => t + e.ms, 0);
    const k = len ? Math.min(1, Math.max(0.5, (s.end - Date.now()) / len)) : 1;
    let t = Date.now();
    for (const e of s.notes) {
      t += e.ms * k;
      for (const n of e.keys) key(n, 'pointerdown');
      await until(t - Math.min(40, e.ms * k * 0.1));
      for (const n of e.keys) key(n, 'pointerup');
      await until(t);
    }
    await until(s.end);
    return { now, peak: w.__demoPeak?.() ?? -1, k };
  }, s);

  // the audio starts with the first press on the panel (as for a person): a click on the screen's bezel
  await page.locator('.fm1-bezel').click();
  for (let t = Date.now(); !(await page.evaluate(() => typeof (window as unknown as { __demoPeak?: unknown }).__demoPeak === 'function')) && Date.now() - t < 5000; ) await sleep(100);
  const peak = (): Promise<number> => page.evaluate(() => (window as unknown as { __demoPeak?: () => number }).__demoPeak?.() ?? -1);
  // the octave the song needs
  const oct0 = (await emuState()).octave;
  for (let i = oct0; i > OCT; i--) { await button('Oct-'); await sleep(150); }
  for (let i = oct0; i < OCT; i++) { await button('Oct+'); await sleep(150); }
  if ((await emuState()).octave !== OCT) console.log(`  warning: the panel is at octave ${(await emuState()).octave}, not ${OCT}`);
  await sleep(900);   // (the OCTAVE message ends)

  const open = async (it: Item): Promise<void> => {
    if (!(await call<boolean>('openFactory', it.name))) throw new Error(`the page has no factory patch ${it.name}`);
    const want = it.name.toUpperCase();
    for (let t = Date.now(); (await emuState()).loaded !== want && Date.now() - t < 5000; ) await sleep(30);
    if ((await emuState()).loaded !== want) console.log(`  warning: the emulated FM-1 did not take ${it.name}`);
    // the engine's device in focus (a fresh patch starts on its first instrument, which is it in every factory patch)
    for (let i = 0; i < 8 && it.device >= 0; i++) {
      const d = (await emuState()).device;
      if (d === it.device) break;
      await page.evaluate(([n]) => {
        const e = document.querySelector('#fm1-view [aria-label="Select encoder"]');
        for (let j = 0; j < Math.abs(n); j++) e?.dispatchEvent(new WheelEvent('wheel', { deltaY: n > 0 ? -100 : 100, bubbles: true, cancelable: true }));
      }, [it.device - d]);
      await sleep(80);
    }
    await peak();   // (from here on: this patch's)
  };
  const says = (want: string, now: Now): string => (now?.name === want && !now.off ? '' : now ? `  (the engine is nearest ${now.name}: ${now.off} of its ${now.rows} rows differ)` : '  (no preset matched)');

  const shots = flag('--shots');
  const report: { patch: string; preset: string; ok: boolean; peak: number }[] = [];
  const t0 = Date.now();
  let at = 0;   // the plan's clock, ms from t0
  const until = async (ms: number): Promise<void> => { const w = t0 + ms - Date.now(); if (w > 0) await sleep(w); };
  let shotN = 0;
  const shot = (name: string, at: number): void => {
    const n = ++shotN;
    setTimeout(() => void page.screenshot({ path: join(OUT, `${String(n).padStart(2, '0')}-${name.replace(/[^\w-]+/g, '_')}.png`) }).catch(() => {}), Math.max(0, at - Date.now()));
  };
  const stamp = (): string => `${((Date.now() - t0) / 1000).toFixed(1).padStart(6)} s`;

  console.log(`\nplaying (${mmss(totalS)} planned)`);
  for (const [n, it] of keyboard.entries()) {
    await open(it);
    at += LOAD_MS;
    await until(at);
    for (const [j, s] of steps[n].entries()) {
      const notes = s.events.map((e) => ({ keys: e.keys, ms: noteS(e) * 1000 }));
      const len = notes.reduce((t, e) => t + e.ms, 0);
      const notesAt = t0 + at + PRESET_MS;
      if (shots && j === 1) shot(`${it.name}-${s.name}`, notesAt + notes[0].ms / 2);
      const r = await step({ clicks: 1, engine: it.engine, want: s.name, notesAt, end: notesAt + len, notes });
      at += PRESET_MS + len;
      report.push({ patch: it.name, preset: s.name!, ok: r.now?.name === s.name && !r.now.off, peak: r.peak });
      console.log(`  ${stamp()}  ${it.name} > ${s.name}${says(s.name!, r.now)}  peak ${r.peak.toFixed(3)}${r.k < 0.9 ? `  (notes at ${(r.k * 100).toFixed(0)} %: late)` : ''}`);
    }
  }
  for (const it of drums) {
    await open(it);
    at += LOAD_MS;
    await until(at);
    await button('PLAY');
    for (const [j, name] of it.presets.entries()) {
      if (shots && j === 0) shot(`${it.name}-${name ?? 'pattern'}`, t0 + at + DRUM_S * 500);
      const r = await step({ clicks: name ? 1 : 0, engine: name ? it.engine : null, want: name, notesAt: 0, end: t0 + at + DRUM_S * 1000, notes: [] });
      at += DRUM_S * 1000;
      report.push({ patch: it.name, preset: name ?? '(pattern)', ok: !name || (r.now?.name === name && !r.now.off), peak: r.peak });
      console.log(`  ${stamp()}  ${it.name} > ${name ?? '(its pattern)'}${name ? says(name, r.now) : ''}  peak ${r.peak.toFixed(3)}`);
    }
    await button('PLAY');   // stop before the next patch
  }
  const took = (Date.now() - t0) / 1000;
  const silent = report.filter((r) => r.peak >= 0 && r.peak < 0.002);
  const wrong = report.filter((r) => !r.ok);
  console.log(`\ndone: ${took.toFixed(1)} s played, ${totalS.toFixed(1)} s planned (${(took - totalS >= 0 ? '+' : '') + (took - totalS).toFixed(1)} s)`);
  console.log(`${report.length} steps; silent: ${silent.length ? silent.map((r) => `${r.patch} > ${r.preset}`).join(', ') : 'none'}; preset not confirmed in the editor: ${wrong.length ? wrong.map((r) => `${r.patch} > ${r.preset}`).join(', ') : 'none'}`);
  if (shots) console.log(`screenshots: ${OUT}`);
  await sleep(1200);
}

/** puts the origin's storage back and closes the browser (set once the page is open) */
let cleanup: (() => Promise<void>) | null = null;
main().then(
  async () => { await cleanup?.(); process.exit(0); },
  async (e: Error) => { console.error(`demo: ${e.message}`); await cleanup?.().catch(() => {}); process.exit(1); },
);
