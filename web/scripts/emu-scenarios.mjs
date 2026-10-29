// SPDX-License-Identifier: GPL-3.0-only
// The device checks that cross the editor link, scripted (#290): the real editor (this checkout's dev server, in Chrome)
// against our firmware on the emulated FM-1, whose USB MIDI is a virtual MIDI port (`m1emu serve`, docs/EMULATOR.md).
//   npm run emu:scenarios [-- FIRMWARE] [--only NAME,..] [--headed] [--keep]
// FIRMWARE: an M1_EMU_MIDI=1 build (matryoshka-emu.bin). Without one: the `matryoshka-emu-midi` artifact of the firmware
// CI run of this checkout's commit, else its branch, else main (needs gh). --url: an editor already running (default: a
// dev server of this checkout on a free port). --headed shows Chrome.
// Chrome sees only the emulator's port (the page's Web MIDI is filtered), so a real FM-1 plugged in is never touched.
// Results, LCD snapshots and page screenshots go to build/emu/scenarios/. Exit code 1 when a check fails.
//
// The same scenarios on the test rig, a real FM-1 (the device test mode, #291; npm run device:scenarios):
//   npm run device:scenarios [-- --install RUN] [--only NAME,..] [--headed]
// drives the registered rig (scripts/rig.mjs) over the editor link: its panel (TEST_KEY / TEST_TURN), its screen as text
// (TEST_SCREEN) and its output's peak (TEST_PEAK). The page sees only the rig's ports; another FM-1 connected is asked
// HELLO and PRESET_GET (to tell it from the rig) and nothing else. --install RUN first installs that firmware CI run on
// the rig, after the gate of D-120 (emu:smoke and these scenarios in the emulator, on that run's builds) passed, and only
// when the rig is the one FM-1 connected (the installer takes the first FM-1 it finds). --via-emu: the device path against
// the emulator (m1emu serve), to check the runner itself without a rig. --port NAME: the rig's page looks only at that
// MIDI port (an emulator serving as a registered rig, to check the rig's path). Results go to build/device/scenarios/.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { download, smoke, smokeState } from './branch-firmware.mjs';
import { loadRig, pickRig, rigPage, survey } from './rig-link.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const REPO = 'glvno/matryoshka';
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const given = args.find((a, i) => !a.startsWith('--') && !['--only', '--install', '--url', '--port'].includes(args[i - 1]));
const DEVICE = flag('--device') || flag('--via-emu');   // the device test mode's path (a rig, or the emulator through it)
const REAL = flag('--device') && !flag('--via-emu');    // a real FM-1: the registered rig
const OUT = join(ROOT, DEVICE ? 'build/device/scenarios' : 'build/emu/scenarios');
const only = opt('--only')?.split(',');
const PORT_NAME = `FM-1 (emu ${process.pid})`;

// panel ids (web/src/fm1-ui.ts BUTTONS, fm1-emu's key matrix): 14.. the note keys from F3
const B = { octDown: 0, octUp: 1, fx: 2, scl: 3, env: 4, lfo: 5, edit: 6, glo: 7, home: 8, save: 9, arp: 10, seq: 11, play: 12, rec: 13 };
const C4 = 14 + 7;
const BLACK = [15, 17, 19, 22, 24, 27, 29, 31];   // F#3 .. A#4's black keys: a drum grid's rows 1..8
const WHITE = [14, 16, 18, 20, 21, 23, 25, 26, 28, 30, 32, 33, 35, 37, 38, 40];   // F3 .. G5's white keys: steps 1..16 on the grid
const ENC = { select: 0, algo: 1, k1: 2, k4: 5, preset: 6 };
const QUIET = 64;
const LOUD = 1000;

/** where two JSON values differ: paths with the two values, at most `n` */
function diff(a, b, path = '', out = [], n = 6) {
  if (out.length >= n) return out;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    if (a !== b) out.push(`${path || '.'}: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
    return out;
  }
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diff(a[k], b[k], `${path}.${k}`, out, n);
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** child processes (the dev server, m1emu serve): killed however this script ends, so none is left running */
const children = [];
const own = (c) => { children.push(c); return c; };
process.on('exit', () => { for (const c of children) try { c.kill(); } catch { /* gone */ } });
for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(s, () => process.exit(130));

function firmware() {
  if (given) return resolve(process.cwd(), given);
  // the CI build of this checkout's commit, else the newest of its branch, else the newest of main
  const dir = join(ROOT, 'build/emu/bridge/ci');
  const git = (a) => (spawnSync('git', a, { cwd: ROOT, encoding: 'utf8' }).stdout ?? '').trim();
  const tries = [['--commit', git(['rev-parse', 'HEAD'])], ['--branch', git(['rev-parse', '--abbrev-ref', 'HEAD'])], ['--branch', 'main']]
    .filter(([, v]) => v && v !== 'HEAD');
  for (const [f, v] of tries) {
    const id = spawnSync('gh', ['run', 'list', '-R', REPO, '--workflow', 'firmware', f, v, '--status', 'success', '-L', '1',
      '--json', 'databaseId', '--jq', '.[0].databaseId'], { encoding: 'utf8' });
    if (id.status !== 0 || !id.stdout.trim()) continue;
    rmSync(dir, { recursive: true, force: true });  // gh run download refuses to overwrite
    mkdirSync(dir, { recursive: true });
    spawnSync('gh', ['run', 'download', id.stdout.trim(), '-R', REPO, '-n', 'matryoshka-emu-midi', '-D', dir], { stdio: 'inherit' });
    if (existsSync(join(dir, 'matryoshka-emu.bin'))) {
      console.log(`firmware: CI run ${id.stdout.trim()} (${f.slice(2)} ${v}), artifact matryoshka-emu-midi`);
      return join(dir, 'matryoshka-emu.bin');
    }
  }
  throw new Error('no M1_EMU_MIDI firmware: pass a matryoshka-emu.bin (CI artifact matryoshka-emu-midi; needs gh to fetch it)');
}

function buildEmu() {
  const isa = spawnSync('tools/emu/isa_fix.sh', { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  if (isa.status !== 0) throw new Error('tools/emu/isa_fix.sh failed');
  const r = spawnSync('cargo', ['build', '--release', '--quiet', '--manifest-path', 'tools/emu/Cargo.toml', '--config', isa.stdout.trim()],
    { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) throw new Error('cargo build of tools/emu failed');
  return join(ROOT, 'tools/emu/target/release/m1emu');
}

const freePort = () => new Promise((res) => {
  const s = createServer();
  s.listen(0, '::1', () => { const p = s.address().port; s.close(() => res(p)); });
});

/** what both targets do with these (Emu's own, RigTarget's through the device test mode) */
class Target {
  /** press and let go; resolves once the key is up again (a press of a key still held would be no press) */
  async tap(id, hold = 80) { await this.press(id, hold); await sleep(hold + 120); }
  /** the loudest output while `id` (a note key) is held for `ms` */
  async notePeak(id = C4, ms = 400) {
    const m = await this.mark();
    await this.key(id, true);
    await sleep(ms);
    const p = await this.peak(m);
    await this.key(id, false);
    await sleep(150);
    return p;
  }
  /** wait up to `ms` for `s` on the LCD */
  /** the output's peak in `n` windows of about `ms` each: [ms since the first window began, peak] per window (#368: how long
   *  a note sounds; the rig's windows are a round trip longer, hence the times) */
  async windows(n, ms) {
    const out = [];
    const t0 = Date.now();
    await this.mark();
    for (let i = 0; i < n; i++) {
      await sleep(ms);
      out.push([Date.now() - t0, await this.peak()]);
    }
    return out;
  }
  async waitText(s, ms = 3000) {
    const t = Date.now();
    do {
      if (await this.text(s)) return true;
      await sleep(100);
    } while (Date.now() - t < ms);
    return false;
  }
}

/** a real FM-1 (or the emulator) over the editor link's device test mode (#291): the rig's page (dev/rig-client.ts) */
class RigTarget extends Target {
  constructor(page) { super(); this.page = page; }
  press(id, hold) { return this.page.evaluate(([i, h]) => window.__rig.tap(i, h), [id, hold]); }
  key(id, down) { return this.page.evaluate(([i, d]) => window.__rig.key(i, d), [id, down]); }
  turn(enc, clicks) { return this.page.evaluate(([e, c]) => window.__rig.turn(e, c), [enc, clicks]); }
  screen() { return this.page.evaluate(() => window.__rig.screen()); }
  async text(s) { return (await this.screen()).texts.some((t) => t.s.includes(s.trim()) && (s === s.trim() || `${t.s} `.includes(s))); }
  async mark() { await this.page.evaluate(() => window.__rig.peak()); return 0; }   // (reads and so resets the peak)
  async peak() { return (await this.page.evaluate(() => window.__rig.peak())).peak; }
  async snap(name) { writeFileSync(join(OUT, `${name}.json`), JSON.stringify(await this.screen(), null, 1)); }
  quit() {}
  /** back to the device page from wherever the FM-1 was left (the menu, GLO, SEQ, the environment, a preset list): HOME taps,
   *  one step back each, reading the screen between; false after `tries` */
  async home(tries = 6, bootMs = 20000) {
    const t0 = Date.now();
    for (let i = 0; ; ) {
      const h = await this.screen();
      if (h.booting) {                              // (the boot screen: wait, it is no wrong page)
        if (Date.now() - t0 > bootMs) return false;
        await sleep(500);
        continue;
      }
      if (h.page === 0) return true;
      if (i++ >= tries) return false;
      await this.tap(B.home);
      await sleep(300);
    }
  }
}

/** m1emu serve: one command line out, one answer line back (serve.rs) */
class Emu extends Target {
  constructor(bin, fw) {
    super();
    this.proc = own(spawn(bin, ['serve', fw, '--name', PORT_NAME], { cwd: ROOT, stdio: ['pipe', 'pipe', 'inherit'] }));
    this.waiting = [];
    this.ready = new Promise((res, rej) => {
      this.proc.on('exit', (c) => rej(new Error(`m1emu exited (${c})`)));
      createInterface({ input: this.proc.stdout }).on('line', (l) => {
        if (l.startsWith('# ')) {
          console.log(`  emu ${l.slice(2)}`);
          if (l.startsWith('# ready')) res();
          return;
        }
        this.waiting.shift()?.(l);
      });
    });
  }
  cmd(line) {
    return new Promise((res) => { this.waiting.push(res); this.proc.stdin.write(line + '\n'); });
  }
  press(id, hold) { return this.cmd(`tap ${id} ${hold}`); }
  key(id, down) { return this.cmd(`key ${id} ${down ? 1 : 0}`); }
  turn(enc, clicks) { return this.cmd(`turn ${enc} ${clicks}`); }
  async text(s) { return (await this.cmd(`text ${s}`)) === 'text 1'; }
  async mark() { return Number((await this.cmd('mark')).split(' ')[1]); }
  async peak(m) { return Number((await this.cmd(`peak ${m}`)).split(' ')[1]); }
  snap(name) { return this.cmd(`snap ${join(OUT, `${name}.png`)}`); }
  /** emulated time (the checks below count in it: the interpreter runs slower than the wall clock) */
  async ms() { return Number((await this.cmd('ms')).split(' ')[1]); }
  /** let `ms` emulated ms pass */
  wait(ms) { return this.cmd(`wait ${ms}`); }
  /** (Target's, in emulated ms: exact windows) */
  async windows(n, ms) {
    const out = [];
    let m = await this.mark();
    for (let i = 0; i < n; i++) {
      await this.wait(ms);
      out.push([(i + 1) * ms, await this.peak(m)]);
      m = await this.mark();
    }
    return out;
  }
  /** the emulated ms until `s` is on the LCD, null if not within `ms` */
  async until(ms, s) { const [, seen, n] = (await this.cmd(`until ${ms} ${s}`)).split(' '); return seen === '1' ? Number(n) : null; }
  /** a host that takes nothing from the FM-1 (a computer where no app reads its MIDI, #375), or one that reads again */
  deaf(on) { return this.cmd(`deaf ${on ? 1 : 0}`); }
  quit() { try { this.proc.stdin.write('quit\n'); } catch { /* gone */ } }
}

// ---- the page: only the emulator's MIDI ports, a dev hook (main.ts __m1test)
const FILTER_MIDI = (only) => {
  const orig = navigator.requestMIDIAccess?.bind(navigator);
  if (!orig) return;
  navigator.requestMIDIAccess = async (o) => {
    const a = await orig(o);
    if (only.except && location.pathname === only.except) return a;   // (the rig's page tells the rig from other FM-1s itself)
    const keep = (m) => new Map([...m].filter(([, p]) => (only.ids ? only.ids.includes(p.id) : p.name === only.name)));
    window.__midiLog = window.__midiLog ?? [];
    window.__midiLogged = window.__midiLogged ?? new Set();
    for (const p of keep(a.inputs).values()) {
      if (window.__midiLogged.has(p.id)) continue;
      window.__midiLogged.add(p.id);
      p.addEventListener('midimessage', (e) => { if (e.data[0] === 0xb0) window.__midiLog.push([Math.round(performance.now()), ...e.data]); });
    }
    // what the editor sends: the protocol's command bytes (F0 7D 4D 31 CMD ..), for the reports
    window.__sent = window.__sent ?? [];
    for (const p of keep(a.outputs).values()) {
      if (p.__wrapped) continue;
      const send = p.send.bind(p);
      p.send = (d, t) => { if (d[0] === 0xf0 && d[1] === 0x7d) window.__sent.push([Math.round(performance.now()), d[4], d.length, Array.from(d.slice(5, 9))]); return send(d, t); };
      p.__wrapped = true;
    }
    return new Proxy(a, {
      get(t, k) {
        if (k === 'inputs') return keep(t.inputs);
        if (k === 'outputs') return keep(t.outputs);
        const v = Reflect.get(t, k, t);
        return typeof v === 'function' ? v.bind(t) : v;
      },
      set(t, k, v) { return Reflect.set(t, k, v, t); },
    });
  };
};

const results = [];
async function check(name, ok, detail = '') {
  results.push({ name, status: ok ? 'pass' : 'fail', ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
}
/** a check that hears the FM-1. It needs MASTER up only on a rig whose TEST_PEAK reads after MASTER (firmware without INFO
 *  feature bit 10): there a silent result is skipped, not failed, since a knob left down is no fault (the owner's rule:
 *  the run never stops for the volume) */
let masterMatters = false;
async function loudCheck(name, p, ok, detail) {
  if (!ok && masterMatters && p < QUIET) {
    results.push({ name, status: 'skip', ok: true, skipped: true, reason: 'MASTER down', detail });
    console.log(`SKIP ${name}: MASTER down? (this firmware reads its peak after MASTER) ${detail}`);
    return;
  }
  await check(name, ok, detail);
}
const until = async (f, ms = 3000) => {
  const t = Date.now();
  do {
    const v = await f();
    if (v) return v;
    await sleep(100);
  } while (Date.now() - t < ms);
  return f();
};

const PY = join(ROOT, 'build/venv/bin/python');   // fm1_install.py's (mido + python-rtmidi; npm run flash -- --info sets it up)

async function launch(url) {
  const browser = await chromium.launch({ channel: 'chrome', headless: !flag('--headed'), args: ['--autoplay-policy=no-user-gesture-required'] });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await context.grantPermissions(['midi', 'midi-sysex'], { origin: new URL(url).origin });
  return { browser, context };
}

/** --install RUN: that firmware CI run onto the rig, once the gate (D-120) passed on its builds and the rig is the one
 *  FM-1 connected (fm1_install.py takes the first FM-1 that answers) */
async function installOnRig(run, url) {
  console.log(`-- install: firmware CI run ${run} on the rig`);
  const dir = await download(run);
  if (smokeState(dir) !== 'passed') {
    console.log('emu:smoke on its build (about two minutes)');
    if (!(await smoke(dir))) throw new Error(`the gate: emu:smoke failed on run ${run} (${dir}/smoke.log): nothing installed`);
  }
  const emuDir = join(dir, 'emu-midi');
  if (!existsSync(join(emuDir, 'matryoshka-emu.bin'))) {
    mkdirSync(emuDir, { recursive: true });
    spawnSync('gh', ['run', 'download', String(run), '-R', REPO, '-n', 'matryoshka-emu-midi', '-D', emuDir], { stdio: 'inherit' });
  }
  if (!existsSync(join(emuDir, 'matryoshka-emu.bin'))) throw new Error(`run ${run} has no matryoshka-emu-midi artifact: no gate, nothing installed`);
  console.log('emu:scenarios on its M1_EMU_MIDI build (about four minutes)');
  if (spawnSync('node', [fileURLToPath(import.meta.url), join(emuDir, 'matryoshka-emu.bin')], { cwd: join(ROOT, 'web'), stdio: 'inherit' }).status !== 0)
    throw new Error(`the gate: emu:scenarios failed on run ${run}: nothing installed`);
  // the gate's own emulator ("FM-1 (emu …)") can outlive its run by a moment: wait for its port to go, so it is not counted as
  // a second FM-1 (the first try on the owner's rig was refused for it); a real second FM-1 still refuses the install below
  const emuPorts = () => spawnSync(PY, ['-c', 'import mido; print(sum("(emu " in n for n in mido.get_input_names()))'], { encoding: 'utf8' }).stdout.trim();
  if (!existsSync(PY)) throw new Error('build/venv is missing: run npm run flash -- --info once (it sets it up)');
  for (let t = Date.now(); emuPorts() !== '0' && Date.now() - t < 15000; ) await sleep(500);
  const { browser, context } = await launch(url);
  try {
    const s = await survey(await rigPage(context, url));
    if (!s.rig) throw new Error('the registered rig is not connected: nothing installed');
    if (s.ports !== 1 || s.pairs.length !== 1) throw new Error(`${s.ports} FM-1 ports are connected: the rig must be the only FM-1 for an install (unplug the other): nothing installed`);
  } finally {
    await browser.close();
  }
  if (!existsSync(PY)) throw new Error('build/venv is missing: run npm run flash -- --info once (it sets it up)');
  console.log(`installing ${join(dir, 'matryoshka.fwsc')} on the rig`);
  if (spawnSync(PY, [join(ROOT, 'tools/fm1_install.py'), join(dir, 'matryoshka.fwsc'), '--yes'], { cwd: ROOT, stdio: 'inherit' }).status !== 0)
    throw new Error('fm1_install.py failed (the rig stays in update mode until an install finishes: run it again)');
  await sleep(4000);   // (its restart)
}

async function main() {
  if (flag('--install') && !REAL) throw new Error('--install is for the rig: npm run device:scenarios -- --install RUN');
  if (REAL && !loadRig()) throw new Error('no rig registered: connect the rig alone and run npm run rig -- register');
  const fw = REAL ? null : firmware();
  if (fw) console.log(`firmware: ${fw}`);
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const m1emu = REAL ? null : buildEmu();
  // the editor's copy of the panel logic (the FM-1 tab, following the FM-1): built from this checkout, not committed
  if (spawnSync('npm', ['run', '-s', 'fm1-wasm'], { cwd: join(ROOT, 'web'), stdio: 'inherit' }).status !== 0) throw new Error('npm run fm1-wasm failed');

  let url = opt('--url');
  let vite;
  if (!url) {
    const port = await freePort();
    vite = own(spawn('npx', ['vite', '--port', String(port), '--strictPort', '--host', '::1'], { cwd: join(ROOT, 'web'), stdio: ['ignore', 'pipe', 'inherit'] }));
    url = `http://[::1]:${port}/`;
    await new Promise((res) => vite.stdout.on('data', (d) => { if (/ready in|Local:/.test(String(d))) res(); }));
  }
  console.log(`editor: ${url}`);
  if (flag('--install')) {
    try {
      await installOnRig(opt('--install'), url);
    } catch (e) {
      vite?.kill();
      throw e;
    }
  }

  let emuProc = null;
  if (!REAL) {
    emuProc = new Emu(m1emu, fw);
    await emuProc.ready;
    await sleep(1500);   // the boot screen, then the device page
  }

  const { browser, context } = await launch(url);
  process.on('exit', () => { try { browser.process()?.kill(); } catch { /* gone */ } });
  let emu = emuProc;
  if (DEVICE) {
    if (!REAL || opt('--port')) await context.addInitScript(FILTER_MIDI, { name: REAL ? opt('--port') : PORT_NAME });
    const rp = await rigPage(context, url);
    let pair;
    if (REAL) {
      const s = await pickRig(rp);
      pair = s.rig;
      console.log(`rig: ${pair.name} (firmware ${pair.info?.version ?? '?'}), ${s.pairs.length - 1} other FM-1${s.pairs.length === 2 ? '' : 's'} left alone`);
      masterMatters = !((pair.info?.features ?? 0) & 1024);   // (protocol.ts FEATURE_PEAK_PRE)
      await context.addInitScript(FILTER_MIDI, { ids: [pair.inId, pair.outId], except: '/__rig' });
    } else {
      [pair] = await rp.evaluate(() => window.__rig.pairs());
      if (!pair) throw new Error('the emulated FM-1 did not answer on its port');
      await rp.evaluate((x) => window.__rig.pick(x), pair);
    }
    emu = new RigTarget(rp);
    // a known start: the device page (the owner's rig was once left on HOME held's SYSTEM page, and every check failed)
    if (!(await emu.home())) { const h = await emu.screen(); throw new Error(`the FM-1 did not come back to its device page with HOME (screen page ${h.page}${h.booting ? ', still booting' : ''}): bring it there by hand and run again`); }
    // MASTER does not matter to the checks (TEST_PEAK reads before it), but say so when nothing can be heard
    if ((await rp.evaluate(() => window.__rig.peak())).masterDown) console.log('  note: MASTER is all the way down: the checks do not depend on it, but you will hear nothing');
  } else {
    await context.addInitScript(FILTER_MIDI, { name: PORT_NAME });
  }
  let page = await context.newPage();
  page.on('pageerror', (e) => console.log(`  page error: ${e.message}`));
  const T = () => page.evaluate(() => window.__m1test.state());
  const open = (name) => page.evaluate((n) => window.__m1test.open(n), name);
  const patchJson = () => page.evaluate(() => window.__m1test.patchJson());
  const shot = (n) => page.screenshot({ path: join(OUT, `${n}-page.png`) }).catch(() => {});
  async function load() {
    await page.goto(url);
    await page.waitForFunction(() => !!window.__m1test, null, { timeout: 20000 });
    await page.keyboard.press('Escape');   // a welcome card or dialog of a first visit
    await sleep(300);
  }
  async function connect(sync = true) {
    await page.evaluate(() => document.getElementById('fm1-connect')?.click());
    const asked = await until(async () => (await T()).syncAsk || (await T()).live, 4000);
    if (sync && (await T()).syncAsk) await page.click('#sync-ask button[value="sync"]');
    await sleep(500);
    return asked;
  }


  // ---- #368: ties on the SEQ page (a drum track's grid and the piano roll), read back through the link (TRACK_NOW: the
  // editor's copy of the track), heard through the peak, and Main's LFO jack through TEST_SCREEN's head (DEVICE only)
  const trackNotes = async () => JSON.parse(await patchJson()).modules.find((m) => m.type === 'steps')?.notes ?? [];
  const noteAt = (ns, at, note) => ns.find((n) => n.at === at && (note === undefined || n.note === note));
  const fmt = (ns) => ns.map((n) => `${n.note}@${n.at}x${n.len}`).join(' ') || 'none';
  /** the editor's copy of the track until `f` holds of it (the FM-1's TRACK_NOW arrived), else the last read */
  const notesUntil = async (f, ms = 3000) => (await until(async () => { const ns = await trackNotes(); return f(ns) ? ns : null; }, ms)) ?? (await trackNotes());
  /** a patch opened in the editor and on the FM-1 (synced), the FM-1 on its device page */
  async function openSynced(name) {
    if (!(await open(name))) return false;
    await sleep(600);
    const s = await until(async () => { const x = await T(); return !x.sandbox && x.live && x.chip === 'synced' && x.status === 'patch on the FM-1'; }, 10000);
    return !!s && (await emu.waitText('= OCT =', 6000));
  }
  /** the SEQ page, its selected track cleared (SEQ held + REC, REC again), so the steps measured are the only ones */
  async function seqCleared() {
    await emu.tap(B.seq, 120);
    const shown = await emu.waitText('ALGO: TRACK', 3000);
    await emu.key(B.seq, true);
    await sleep(150);
    await emu.tap(B.rec);
    await sleep(200);
    await emu.tap(B.rec);
    await sleep(200);
    await emu.key(B.seq, false);
    await sleep(300);
    return shown && (await notesUntil((ns) => !ns.length)).length === 0;
  }
  /** LFO held + the white keys of `steps` (0-based); Main's patch buttons as TEST_SCREEN says while LFO is held (DEVICE) */
  async function lfoKeys(steps) {
    await emu.key(B.lfo, true);
    await sleep(150);
    for (const k of steps) await emu.tap(WHITE[k]);
    const buttons = DEVICE ? (await emu.screen()).buttons : undefined;
    await emu.key(B.lfo, false);
    await sleep(200);
    return buttons;
  }
  /** a pass and a bit with the transport running: the peak in windows of 25 ms (one step of 1/16 at 120 BPM = 125 ms) */
  async function passProfile() {
    await emu.tap(B.play);
    await sleep(300);
    const w = await emu.windows(100, 25);
    await emu.tap(B.play);
    await sleep(600);
    return w;
  }
  /** the hit in a profile: its onset (the window with the biggest rise that the next two windows keep at least half of:
   *  the rig's TEST_PEAK now and then gives one window about a hit's level out of nowhere, 4 in some 3,600 reads over three
   *  runs, never the emulator), its peak (that window or the next: an attack can span two) and how much of it the windows
   *  of the next `ms` keep at least (their lowest / the peak): a voice held by its gate keeps about all of it, one let go
   *  decays */
  function hold(w, ms = 300) {
    let i = 1;
    const rise = (k) => (k + 2 < w.length && w[k + 1][1] * 2 >= w[k][1] && w[k + 2][1] * 2 >= w[k][1] ? w[k][1] - w[k - 1][1] : -Infinity);
    for (let k = 2; k < w.length; k++) if (rise(k) > rise(i)) i = k;
    const top = Math.max(w[i][1], w[i + 1]?.[1] ?? 0);
    const after = w.filter((x) => x[0] > w[i + 1]?.[0] && x[0] <= w[i][0] + ms).map((x) => x[1]);
    const low = after.length ? Math.min(...after) : 0;
    return { at: w[i][0], top, low, kept: top ? +(low / top).toFixed(2) : 0 };
  }
  const prof = (w) => w.map((x) => x[1]).join(',');
  const LFO_BIT = 1 << 3;
  /** a 4-step note on step 1 back to one step, as D-531 says (2026-10-28): LFO + step 2 (inside it) ends it there, LFO +
   *  step 2 again (its last step) makes it one step, LFO + step 1 (its own step, nothing before) is NOTHING TO TIE */
  async function untie(tag, note) {
    await lfoKeys([1]);
    let ns = await notesUntil((x) => noteAt(x, 0, note)?.len === 2);
    await check(`${tag}: LFO + step 2, inside the tie: it ends there (2 steps)`, noteAt(ns, 0, note)?.len === 2 && ns.length === 1, fmt(ns));
    await lfoKeys([1]);
    ns = await notesUntil((x) => noteAt(x, 0, note)?.len === 1);
    await check(`${tag}: LFO + step 2 again, its last step: one step`, noteAt(ns, 0, note)?.len === 1 && ns.length === 1, fmt(ns));
    await emu.key(B.lfo, true);
    await sleep(150);
    await emu.tap(WHITE[0]);
    const said = await emu.waitText('NOTHING TO TIE', 1500);
    await emu.key(B.lfo, false);
    await sleep(300);
    ns = await trackNotes();
    await check(`${tag}: LFO + step 1, the hit's own step with nothing before it: NOTHING TO TIE, no change`, said && noteAt(ns, 0, note)?.len === 1 && ns.length === 1, fmt(ns));
  }   // Main's patch buttons: FX SCL ENV LFO EDIT GLO ARP (engine.h ENG_PANEL_BUTTONS)

  /** a drum track's grid (D-531 as of 2026-10-28): a hit on step 1 of row `row`, LFO + step 4 ties it through step 4 in one
   *  press, heard; LFO + step 2 (inside it) ends it there, LFO + step 2 again (its last step) makes it one step, heard again
   *  at the same place; LFO + step 1 (its own step, nothing before it) is NOTHING TO TIE; tied again and cut by a plain
   *  white key on step 3. `sustains`: the row's voice holds
   *  while its gate is up (8 Lire's plates), else a one-shot whose sound must not change (the 808 Kit) */
  async function drumTie(tag, name, row, sustains) {
    await check(`${tag}: ${name} opens, synced`, await openSynced(name));
    await check(`${tag}: the SEQ page, the track cleared`, await seqCleared(), fmt(await trackNotes()));
    await emu.tap(BLACK[row]);
    await sleep(200);
    await emu.tap(WHITE[0]);
    let ns = await notesUntil((x) => x.length === 1);
    const note = ns[0]?.note;
    await check(`${tag}: a hit on step 1 of row ${row + 1}`, ns.length === 1 && ns[0].at === 0 && ns[0].len === 1, fmt(ns));
    const untiedW = await passProfile();
    const buttons = await lfoKeys([3]);
    ns = await notesUntil((x) => noteAt(x, 0, note)?.len === 4);
    await check(`${tag}: LFO + step 4: the hit tied through it in one press (4 steps)`, noteAt(ns, 0, note)?.len === 4 && ns.length === 1, fmt(ns));
    if (DEVICE) await check(`${tag}: LFO held on the SEQ page: Main's LFO jack stays down`, buttons !== undefined && !(buttons & LFO_BIT), `buttons ${buttons}`);
    const tiedW = await passProfile();
    await untie(tag, note);
    const againW = await passProfile();
    const u = hold(untiedW), t = hold(tiedW), a = hold(againW);
    console.log(`  ${tag} peaks per 25 ms, untied: ${prof(untiedW)}`);
    console.log(`  ${tag} tied (4 steps): ${prof(tiedW)}`);
    console.log(`  ${tag} untied again: ${prof(againW)}`);
    const detail = `the hit's peak, the lowest in the 300 ms after it, kept: untied ${u.top} ${u.low} ${u.kept}, tied ${t.top} ${t.low} ${t.kept}, untied again ${a.top} ${a.low} ${a.kept}`;
    if (sustains) {
      await loudCheck(`${tag}: tied, the voice holds through the tied steps (keeps 90 % and more, above ${QUIET})`, t.top, t.kept >= 0.9 && t.low > QUIET, detail);
      await loudCheck(`${tag}: untied, it decays at the same place (keeps under 85 %)`, u.top, u.kept < 0.85 && a.kept < 0.85, detail);
    } else {
      const near = (x, y, tol) => Math.abs(x - y) <= tol * Math.max(x, y);
      await loudCheck(`${tag}: a one-shot sounds the same tied (peak within 15 %, kept within 0.1)`, t.top,
        t.top > LOUD && near(t.top, u.top, 0.15) && near(a.top, u.top, 0.15) && Math.abs(t.kept - u.kept) <= 0.1 && Math.abs(a.kept - u.kept) <= 0.1, detail);
    }
    await lfoKeys([3]);
    await emu.tap(WHITE[2]);
    ns = await notesUntil((x) => noteAt(x, 2, note) !== undefined);
    await check(`${tag}: a plain white key on step 3, which the tie runs through: the tie cut before it, a hit there`,
      noteAt(ns, 0, note)?.len === 2 && noteAt(ns, 2, note)?.len === 1 && ns.length === 2, fmt(ns));
    await emu.tap(B.seq, 120);
    await emu.waitText('= OCT =', 3000);
  }

  const scenarios = {
    async connect() {
      await load();
      await open('Init');
      await connect();
      const s = (await until(async () => { const x = await T(); return x.live ? x : null; })) ?? (await T());
      await emu.snap('connect-0');
      await check('connect: the editor finds the emulated FM-1', s.connected, s.status ?? '');
      await check('connect: Sync turns Live on', s.live && s.chip === 'synced', `chip ${s.chip}`);
      await until(async () => !/sending/i.test((await T()).status ?? ''), 8000);
      await check('connect: the FM-1 shows its device page', await emu.waitText('= OCT =', 6000));
      const p = await emu.notePeak();
      await loudCheck('connect: the FM-1 plays Init from a key', p, p > LOUD, `peak ${p}`);
      await emu.snap('connect');
    },
    async patterns() {   // #375: a pattern or song chosen on the FM-1 reaches the editor, the editor's reaches the FM-1
      await open('Silver Box');
      await until(async () => { const x = await T(); return !x.sandbox && x.live; });
      await until(async () => !/sending/i.test((await T()).status ?? ''), 8000);
      const seqOf = async () => JSON.parse(await patchJson()).modules.find((m) => m.type === 'fm1')?.seq ?? {};
      await emu.tap(B.seq);
      await check('patterns: the SEQ bar shows P01', await emu.waitText('P01', 3000));
      await emu.turn(ENC.preset, 1);
      await check('patterns: PRESET on the SEQ page: the editor follows (pattern 2)', !!(await until(async () => (await seqOf()).pattern === 1, 3000)), JSON.stringify(await seqOf()));
      await page.keyboard.press(']');
      await check('patterns: ] in the editor: the FM-1 plays pattern 3', await emu.waitText('P03', 3000));
      await emu.snap('patterns');
      await emu.tap(B.scl);
      await check('patterns: SEL tapped opens the SONG page with the demo song', await emu.waitText('SONG 1', 3000));
      await emu.turn(ENC.k4, 1);
      await check('patterns: K4 right: the editor plays song 1 too', !!(await until(async () => (await seqOf()).song === 1, 3000)), JSON.stringify(await seqOf()));
      await emu.tap(B.play);
      await sleep(400);
      const m = await emu.mark();
      await sleep(1500);
      const p = await emu.peak(m);
      await loudCheck('patterns: PLAY plays the song on the FM-1', p, p > LOUD, `peak ${p}`);
      await emu.tap(B.play);
      await emu.turn(ENC.k4, -1);
      await check('patterns: K4 left: the editor plays the pattern again', !!(await until(async () => !(await seqOf()).song, 3000)));
      await emu.tap(B.scl);
      await emu.tap(B.seq);
      await shot('patterns');
    },
    async sandbox() {
      await page.evaluate(() => window.__sent.splice(0));
      await open('Hera 6 XL');
      const s = await until(async () => { const x = await T(); return x.sandbox ? x : null; });
      await check('sandbox: over budget with Live on is sandbox mode', !!s?.sandbox, `chip ${(await T()).chip}`);
      const shown = await emu.waitText('BROWSER PLAYS');
      const sent = await page.evaluate(() => window.__sent.slice());
      const pauseAt = sent.findIndex((x) => x[1] === 0x2c && x[3][0] === 1);
      const pageAt = sent.findIndex((x) => x[1] === 0x31);
      await check('sandbox: pause precedes the page', pauseAt >= 0 && pageAt > pauseAt, `sent ${sent.map((x) => x[1].toString(16)).join(' ')}`);
      await check('sandbox: the FM-1 shows the sandbox page', shown);
      await check('sandbox: its first page names the editor patch', await emu.waitText('HERA 6 XL'));
      await emu.snap('sandbox');
      const p = await emu.notePeak();
      await check('sandbox: the FM-1 is silent under a key', p < QUIET, `peak ${p}`);
      await check('sandbox: the editor follows the FM-1', (await T()).following);
      await shot('sandbox');
    },
    async arp() {
      const before = await patchJson();
      await emu.tap(B.arp);
      const changed = await until(async () => (await patchJson()) !== before, 1500);
      await sleep(700);
      await emu.tap(B.arp);
      const mid = await patchJson();
      const back = await until(async () => (await patchJson()) === before, 3000);
      if (changed && !back) console.log(`  ARP 1: ${diff(JSON.parse(before), JSON.parse(mid)).join('; ')}\n  ARP 2: ${diff(JSON.parse(mid), JSON.parse(await patchJson())).join('; ')}`);
      if (!changed) return check('sandbox: ARP (skipped: ARP changes nothing in this patch)', true);
      await check('sandbox: ARP toggles on, and off again', changed && back, `first press ${changed ? 'changed the patch' : 'changed nothing'}, second ${back ? 'undid it' : 'did not undo it'}`);
    },
    async arpQuick() {   // a quick second press, as a hand does it (300 ms apart)
      await page.evaluate(() => { window.__midiLog.splice(0); window.__m1test.inputs(); });
      const before = await patchJson();
      await emu.tap(B.arp);
      await sleep(100);
      await emu.tap(B.arp);
      await sleep(1500);
      const after = await patchJson();
      const log = await page.evaluate(() => window.__midiLog.splice(0).filter((x) => x[2] === 86));
      await check('sandbox: ARP pressed twice quickly ends where it began', after === before, after === before ? '' : `${diff(JSON.parse(before), JSON.parse(after)).join('; ')} (CC 86 seen: ${log.map((x) => `${x[3]}@${x[0]}`).join(' ')})`);
      if (after !== before) { await emu.tap(B.arp); await sleep(1500); }
    },
    async oct() {
      const o0 = (await T()).octave;
      await emu.tap(B.octUp);
      const up = await until(async () => (await T()).octave === o0 + 1, 1500);
      await emu.tap(B.octDown);
      const down = await until(async () => (await T()).octave === o0, 1500);
      await check('sandbox: OCT+ / OCT- move the editor\'s octave', !!up && !!down, `from ${o0}: after OCT+ ${up ? o0 + 1 : 'unchanged'}, then ${(await T()).octave}`);
    },
    async preset() {
      const name = (await T()).patch;
      await emu.turn(ENC.preset, 1);
      await check('sandbox: PRESET says SANDBOX: NO PRESET', await emu.waitText('SANDBOX: NO PRESET', 1500));
      await emu.snap('preset');
      await sleep(300);
      await check('sandbox: PRESET leaves the editor\'s patch', (await T()).patch === name);
    },
    async leave() {
      await open('Init');
      const s = await until(async () => { const x = await T(); return !x.sandbox && x.live ? x : null; });
      await check('leave: under budget again, synced', !!s, `chip ${(await T()).chip}`);
      await check('leave: the FM-1 shows its device page', await emu.waitText('= OCT ='));
      await sleep(500);
      const p = await emu.notePeak();
      await loudCheck('leave: the FM-1 sounds again', p, p > LOUD, `peak ${p}`);
    },
    async reconnect() {
      await open('Hera 6 XL');
      await until(async () => (await T()).sandbox);
      await sleep(1500);   // (the open patch is saved for the next visit)
      await page.close();   // the tab goes: the FM-1 plays its own patch again after about 5 s
      const own = await emu.waitText('= OCT =', 9000);
      await check('reconnect: the tab closed, the FM-1 leaves sandbox mode', own);
      page = await context.newPage();
      page.on('pageerror', (e) => console.log(`  page error: ${e.message}`));
      await load();
      const s0 = await T();
      await check('reconnect: the editor reopens on the sandbox patch', s0.patch === 'Hera 6 XL' && !s0.fits, s0.patch);
      const asked = await connect();
      await check('reconnect: connecting offers Sync', !!asked);
      const s = await until(async () => { const x = await T(); return x.sandbox ? x : null; });
      await check('reconnect: Sync starts sandbox mode', !!s?.sandbox, `chip ${(await T()).chip}`);
      await check('reconnect: the FM-1 shows the sandbox page', await emu.waitText('BROWSER PLAYS'));
      await shot('reconnect');
    },
    async switchPlaying() {   // the owner's 1.3 session: Elvira 2 running, then Elvira 2 XL opened
      await open('Elvira 2');
      await until(async () => { const x = await T(); return !x.sandbox && x.live; });
      await until(async () => !/sending/i.test((await T()).status ?? ''), 8000);
      await emu.waitText('= OCT =', 6000);
      await emu.tap(B.play);
      // its PATTERN is empty: a held key sounds while the transport runs (the first of these keys that does, and stays held)
      let held = -1, p = 0;
      for (const k of [C4, C4 + 1, C4 + 2, C4 + 3, C4 + 4, C4 + 5, C4 - 2, C4 - 4]) {
        await emu.key(k, true);
        await sleep(300);
        const m = await emu.mark();
        await sleep(700);
        p = await emu.peak(m);
        if (p > LOUD) { held = k; break; }
        await emu.key(k, false);
      }
      await emu.snap('switch-0');
      const s0 = await T();
      await loudCheck('switch: Elvira 2 runs and sounds on the FM-1', s0.deviceRunning ? p : LOUD, p > LOUD && s0.deviceRunning, `peak ${p}${held >= 0 ? ` (key ${held})` : ''}, running ${s0.deviceRunning}`);
      await page.evaluate(() => window.__sent.splice(0));
      const t0 = Date.now();
      await open('Elvira 2 XL');
      const s = await until(async () => { const x = await T(); return x.sandbox ? x : null; }, 2000);
      await check('switch: Elvira 2 XL mid-sequence is sandbox mode', !!s?.sandbox);
      const shown = await emu.waitText('BROWSER PLAYS', 6000);
      const took = Date.now() - t0;
      const sent = await page.evaluate(() => window.__sent.splice(0));
      const cmds = [...new Set(sent.map((x) => x[1].toString(16)))].join(' ');
      let afterHome = '';
      if (!shown) {
        await emu.snap('switch-stuck');
        await emu.tap(B.home);
        afterHome = (await emu.waitText('BROWSER PLAYS', 3000)) ? '; after HOME it shows' : '; not even after HOME';
      }
      await check('switch: the FM-1 shows the sandbox page without HOME', shown, `${shown ? `after ${took} ms` : 'not within 6 s'}; the editor sent commands ${cmds}${afterHome}`);
      await emu.snap('switch');
      const m2 = await emu.mark();
      await sleep(800);
      const p2 = await emu.peak(m2);
      await check('switch: the FM-1 goes silent', p2 < QUIET, `peak ${p2}`);
      const s2 = await T();
      await check('switch: the browser\'s transport runs on', s2.playing, `playing ${s2.playing}`);
      await shot('switch');
      if (held >= 0) await emu.key(held, false);
      await emu.tap(B.play);   // stop
    },
    async tieLire() { await drumTie('tie lire', '8 Lire', 0, true); },
    async tieElvira() { await drumTie('tie elvira', 'Elvira 2', 0, true); },
    async tie808() {
      await drumTie('tie 808', '808 Kit', 0, false);
      if (DEVICE) {   // (the check above means something: LFO off the SEQ page is Main's jack, and TEST_SCREEN shows it)
        await emu.key(B.lfo, true);
        await sleep(200);
        const b = (await emu.screen()).buttons;
        await emu.key(B.lfo, false);
        await sleep(200);
        await check('tie 808: LFO held on the device page: Main\'s LFO jack up (TEST_SCREEN sees the jacks)', b !== undefined && !!(b & LFO_BIT), `buttons ${b}`);
      }
    },
    async drumHold() {   // #368 (the owner, 2026-10-28): a black key on a drum track's grid sounds while held; REC running records it
      await check('hold: 8 Lire opens, synced', await openSynced('8 Lire'));
      await check('hold: the SEQ page, the track cleared', await seqCleared(), fmt(await trackNotes()));
      // stopped: row 1's plate while black key 1 is held (about 600 ms), then let go
      await emu.windows(4, 25);                     // (quiet first)
      await emu.key(BLACK[0], true);
      const held = await emu.windows(24, 25);
      await emu.key(BLACK[0], false);
      const gone = await emu.windows(20, 25);
      const top = Math.max(held[0][1], held[1][1]), heldLow = Math.min(...held.slice(2).map((x) => x[1]));
      const heldMax = Math.max(...held.map((x) => x[1])), late = gone[gone.length - 1][1];
      console.log(`  hold peaks per 25 ms, held: ${prof(held)}; let go: ${prof(gone)}`);
      const d = `held: peak ${top}, lowest after it ${heldLow} (kept ${top ? (heldLow / top).toFixed(2) : 0}), loudest ${heldMax}; 500 ms after letting go: ${late}`;
      await loudCheck('hold: stopped, a held black key sounds its row as long as it is held (keeps 90 %)', top, top > LOUD && heldLow >= 0.9 * top, d);
      await loudCheck('hold: let go, it decays (500 ms on: under half the held level)', top, late < heldMax / 2, d);
      let ns = await trackNotes();
      await check('hold: stopped, nothing recorded', ns.length === 0, fmt(ns));
      // REC (the SEQ page armed this drum track; stopped, REC starts the transport and records it, #395): black key 2
      // held about four steps
      await emu.tap(B.rec);
      await sleep(400);
      await emu.key(BLACK[1], true);
      await sleep(450);
      await emu.key(BLACK[1], false);
      ns = await notesUntil((x) => x.length >= 1);
      const rec = ns.find((x) => x.note === 55);
      await check('hold: REC on, running: a black key held about 450 ms records one note on its row, 3 to 5 steps long (125 ms a step)',
        ns.length === 1 && !!rec && rec.len >= 3 && rec.len <= 5, fmt(ns));
      // step write while REC plays: a white key on the selected row, the one black key 2 picked (#395)
      await emu.tap(WHITE[12]);
      ns = await notesUntil((x) => noteAt(x, 12, 55) !== undefined);
      await check('hold: step write while REC plays: a white key places a step on the row the black key picked', noteAt(ns, 12, 55)?.len === 1 && ns.length === 2, fmt(ns));
      await emu.tap(B.play);                        // PLAY stops the transport and the recording
      await sleep(300);
      await emu.tap(B.seq, 120);
      await emu.waitText('= OCT =', 3000);
    },
    async tieRoll() {   // the piano roll (#241) keeps its tie: Silver Box's PATTERN, pattern 1 (empty)
      await check('tie roll: Silver Box opens, synced', await openSynced('Silver Box'));
      await check('tie roll: the SEQ page, the track cleared', await seqCleared(), fmt(await trackNotes()));
      await emu.tap(WHITE[0]);
      let ns = await notesUntil((x) => x.length === 1);
      const note = ns[0]?.note;
      await check('tie roll: a note on step 1', ns.length === 1 && ns[0].at === 0 && ns[0].len === 1, fmt(ns));
      await lfoKeys([3]);
      ns = await notesUntil((x) => noteAt(x, 0, note)?.len === 4);
      await check('tie roll: LFO + step 4: tied through it in one press (4 steps)', noteAt(ns, 0, note)?.len === 4 && ns.length === 1, fmt(ns));
      await untie('tie roll', note);
      await lfoKeys([3]);
      await emu.tap(WHITE[2]);
      ns = await notesUntil((x) => noteAt(x, 2, note) !== undefined);
      await check('tie roll: a plain white key on a tied step: the tie cut, a note there', noteAt(ns, 0, note)?.len === 2 && noteAt(ns, 2, note)?.len === 1, fmt(ns));
      await emu.tap(B.seq, 120);
      await emu.waitText('= OCT =', 3000);
    },
    // #375: on a computer where no app reads the FM-1's MIDI, every message the FM-1 sends unasked (TRACK_NOW after a
    // step, PARAM_NOW after a knob) found the SysEx ring full and waited 200 ms: entering steps by hand stalled the panel
    // for seconds. The browser always read, so no scenario saw it: here m1emu stops taking the FM-1's packets (the same
    // ota_wire_send path), steps are entered at a hand's pace, and SEQ must still close the page at once. Times are
    // emulated ms (the interpreter runs slower than the wall clock).
    async deafHost() {
      if (DEVICE) return console.log('  (skipped: the deaf host is the emulator\'s, m1emu deaf)');
      await check('deaf: the 808 Kit opens', await open('808 Kit'));
      await sleep(600);                             // (the upload starts 150 ms after the change; deaf before it ends, it stalls)
      const sent = await until(async () => { const x = await T(); return x.live && x.chip === 'synced' && x.status === 'patch on the FM-1'; }, 10000);
      await check('deaf: the editor sent it, synced', !!sent && (await emu.waitText('= OCT =', 6000)), `chip ${(await T()).chip}, ${(await T()).status}`);
      await emu.deaf(true);
      await emu.press(B.seq, 120);
      await check('deaf: SEQ opens the drum grid', (await emu.until(3000, 'ALGO: TRACK')) !== null);
      await emu.wait(300);
      const t0 = await emu.ms();
      for (let i = 0; i < 30; i++) {                // steps 1..16 switched, then 1..14 back: a TRACK_NOW each, nobody taking them
        await emu.press(WHITE[i % 16], 40);
        await emu.wait(60);
      }
      const took = (await emu.ms()) - t0;
      await emu.snap('deaf-steps');
      await emu.press(B.seq, 120);
      const back = await emu.until(3000, '= OCT =');
      await check('deaf: 30 steps entered with no app reading the FM-1, the panel keeps up', back !== null && back <= 400,
        `SEQ closed the page ${back === null ? 'not within 3000' : `after ${back}`} emulated ms (a reading host: about 140; the 30 steps took ${took} ms)`);
      await emu.deaf(false);
      await emu.wait(300);
      await emu.press(B.seq, 120);
      await emu.until(3000, 'ALGO: TRACK');
      await emu.wait(300);
      const before = await patchJson();
      await emu.press(WHITE[0], 40);                // a step: its TRACK_NOW reaches the editor again
      const followed = await until(async () => (await patchJson()) !== before, 3000);
      await check('deaf: read again, the editor follows a step entered on the FM-1', !!followed);
      await emu.wait(200);
      await emu.press(WHITE[0], 40);                // (the step back)
      await emu.wait(200);
      await emu.press(B.seq, 120);
      await emu.until(3000, '= OCT =');
      await open('Init');
      await sleep(600);
      const s = await until(async () => { const x = await T(); return x.live && x.chip === 'synced' && x.status === 'patch on the FM-1'; }, 10000);
      await check('deaf: the editor syncs a patch to the FM-1 again', !!s && (await emu.waitText('= OCT =', 4000)), `chip ${(await T()).chip}, ${(await T()).status}`);
      await emu.snap('deaf-after');
    },
    // #387 (the owner, 2026-10-28): on the piano roll the black keys pick the rows on screen, black key 1 the bottom one,
    // not the tracks. Spokes 6's TONE (the owner's report: ALGO to TONE lit black key 2, to CHORD black key 3), read back
    // through the link (TRACK_NOW: the editor's copy of the tracks) and heard through the peak
    async rollBlack() {
      const KEY = [1, 3, 5, 8, 10, 13, 15, 17, 20, 22, 25].map((n) => 14 + n);   // the black keys, F#3 up
      const tracks = async () => Object.fromEntries(JSON.parse(await patchJson()).modules.filter((m) => m.type === 'steps').map((m) => [m.name, m.notes]));
      const fmt = (ns) => (ns ?? []).map((n) => `${n.note}@${n.at}x${n.len}`).join(' ') || 'none';
      const added = (was, now) => (now ?? []).filter((n) => !(was ?? []).some((o) => o.at === n.at && o.note === n.note));
      await check('roll black: Spokes 6 opens', await open('Spokes 6'));
      await sleep(600);
      const s = await until(async () => { const x = await T(); return x.live && x.chip === 'synced' && x.status === 'patch on the FM-1'; }, 10000);
      await check('roll black: synced, the device page', !!s && (await emu.waitText('= OCT =', 6000)), `chip ${(await T()).chip}, ${(await T()).status}`);
      await emu.tap(B.seq, 120);
      await check('roll black: SEQ opens the drum grid', await emu.waitText('ALGO: TRACK', 3000));
      let tone = false;
      for (let i = 0; i < 3 && !tone; i++) {        // ALGO a track a click, to TONE (the 2nd of 3)
        await emu.turn(ENC.algo, 1);
        tone = await emu.waitText('TONE ARM P', 1500);
      }
      await check('roll black: ALGO: the TONE track\'s roll', tone);
      const t0 = await tracks();
      const m = await emu.mark();                   // black key 1 held, stopped: its row (the bottom pitch) heard
      await emu.key(KEY[0], true);
      await sleep(400);
      const p = await emu.peak(m);
      await emu.key(KEY[0], false);
      await sleep(300);
      await loudCheck('roll black: stopped, black key 1 sounds its row', p, p > LOUD, `peak ${p}`);
      await check('roll black: black key 1 keeps the TONE track (it picked a track before)', (await emu.text('TONE ARM P')) && !(await emu.text('CHORD')));
      await emu.tap(WHITE[13]);                     // a white key: a note on step 14 at black key 1's row
      const t1 = await until(async () => { const x = await tracks(); return added(t0.TONE, x.TONE).length === 1 ? x : null; }, 3000) ?? (await tracks());
      const low = added(t0.TONE, t1.TONE)[0];
      await check('roll black: then a white key writes on TONE, not on another track', !!low && low.at === 13 && fmt(t1.CHORD) === fmt(t0.CHORD) && fmt(t1.DRUMS) === fmt(t0.DRUMS), fmt(added(t0.TONE, t1.TONE)));
      await emu.tap(KEY[7]);                        // black key 8: the top row, 7 semitones up
      await emu.tap(WHITE[14]);
      const t2 = await until(async () => { const x = await tracks(); return added(t1.TONE, x.TONE).length === 1 ? x : null; }, 3000) ?? (await tracks());
      const high = added(t1.TONE, t2.TONE)[0];
      await check('roll black: black key 8 is the top row: 7 semitones over black key 1\'s', !!low && !!high && high.at === 14 && high.note === low.note + 7, `${fmt([low])} then ${fmt([high])}`);
      await emu.tap(KEY[8]);                        // black key 9: nothing (8 rows), still TONE, still the top row
      await emu.tap(WHITE[14]);                     // (the top row's note on step 15 off again)
      await emu.tap(KEY[0]);
      await emu.tap(WHITE[13]);                     // (and the bottom row's on step 14)
      const t3 = await until(async () => { const x = await tracks(); return fmt(x.TONE) === fmt(t0.TONE) ? x : null; }, 3000) ?? (await tracks());
      await check('roll black: black key 9 changes nothing; both notes off again (the track as it was)', fmt(t3.TONE) === fmt(t0.TONE) && (await emu.text('TONE ARM P')), fmt(added(t0.TONE, t3.TONE)));
      await emu.snap('roll-black');
      await emu.tap(B.seq, 120);
      await emu.waitText('= OCT =', 3000);
    },
    // #395 (the owner, 2026-10-28): SEL arms the device in focus and disarms the rest, SEL on environment rows adds and
    // removes them, the last one out leaves the keys WIRED, and the SEQ page arms the track it shows. The link does not
    // carry the armed set (D-516): read from the FM-1's screen, heard through the peak
    async arming() {
      await check('arming: the 808 Kit opens, synced', await openSynced('808 Kit'));
      await check('arming: a patch loads with nothing armed: the footer says KEYS WIRED', await emu.waitText('KEYS WIRED', 3000));
      await emu.tap(B.scl);                         // the home device, the Drum map: its keys come through DRUMS (#395)
      await check('arming: SEL on a device fed through a track arms it with the track', await emu.waitText('DRUM MAP ARMED', 1500));
      await sleep(1300);
      await emu.turn(ENC.select, 1);                // the next device, an instrument of the kit: its voices take no keys
      await sleep(300);
      await emu.tap(B.scl);
      await check('arming: SEL on a device that takes no keys says so', await emu.waitText('NOTHING HERE TAKES KEYS', 1500));
      await emu.turn(ENC.select, -1);
      await sleep(1300);
      await emu.tap(B.seq, 120);
      await check('arming: the SEQ page arms the track it shows', await emu.waitText('DRUMS ARM', 3000));
      await emu.tap(B.seq, 120);
      await check('arming: back on the device page, the footer names the armed track', await emu.waitText('ARM DRUMS', 3000));
      const m = await emu.mark();                   // armed: black key 1 plays the kick through DRUMS
      await emu.key(BLACK[0], true);
      await sleep(300);
      await emu.key(BLACK[0], false);
      const p = await emu.peak(m);
      await loudCheck('arming: DRUMS armed, black key 1 plays the kick', p, p > LOUD, `peak ${p}`);
      await sleep(1000);
      await emu.tap(B.env, 120);
      await check('arming: ENV opens the environment', await emu.waitText('ENVIRONMENT', 3000));
      await emu.turn(ENC.select, -1);               // the Drum map's row, then DRUMS'
      await sleep(300);
      await emu.tap(B.scl);
      await check('arming: SEL on the last armed row: disarmed, the keys WIRED', await emu.waitText('KEYS WIRED', 1500));
      await sleep(1300);
      await emu.tap(B.rec);                         // REC is global (#395): it runs here too, nothing armed records
      await check('arming: REC on the environment with the keys wired: REC runs, says nothing records, the page stays',
        (await emu.waitText('REC: NO TRACK ARMED', 1500)) && (await emu.waitText('ENVIRONMENT', 2500)));   // (the bar's message, then the page's bar)
      await emu.tap(B.play);                        // (PLAY stops it all)
      await sleep(1300);
      await emu.tap(B.scl);
      await check('arming: SEL on the row again: armed', await emu.waitText('DRUMS ARMED', 1500));
      await emu.snap('arming-env');
      await emu.tap(B.env, 120);
      await emu.waitText('= OCT =', 3000);
      // an instrument whose keys come through its track and Arpeggiator (every factory instrument; the owner, 2026-10-28):
      // SEL on its first page arms it, and the keys play it; the Arpeggiator alone takes no keys
      await check('arming: Vernon 100 opens, synced', await openSynced('Vernon 100'));
      await emu.tap(B.scl);
      await check('arming: SEL on Vernon 100\'s first page arms it', await emu.waitText('VERNON 100 ARMED', 1500));
      await sleep(1300);
      const v = await emu.mark();
      await emu.key(WHITE[7], true);
      await sleep(300);
      await emu.key(WHITE[7], false);
      const vp = await emu.peak(v);
      await loudCheck('arming: Vernon 100 armed, a white key plays it', vp, vp > LOUD, `peak ${vp}`);
      await sleep(1000);
      await emu.tap(B.scl);                         // SEL is a toggle (D-239): armed, it takes it out
      await check('arming: SEL again on its page disarms it, the keys WIRED', await emu.waitText('KEYS WIRED', 1500));
      await sleep(1300);
      await emu.turn(ENC.select, -1);               // the device before: the Arpeggiator
      await sleep(300);
      await emu.tap(B.scl);
      await check('arming: SEL on the Arpeggiator alone: nothing here takes keys', await emu.waitText('NOTHING HERE TAKES KEYS', 1500));
      await emu.snap('arming-instrument');
    },
  };

  try {
    for (const [name, run] of Object.entries(scenarios)) {
      if (only && !only.includes(name)) continue;
      console.log(`-- ${name}`);
      try {
        await run();
      } catch (e) {
        await check(`${name}: ran to the end`, false, e.message.split('\n')[0]);
        await shot(`${name}-error`);
      }
    }
  } finally {
    writeFileSync(join(OUT, 'results.json'), JSON.stringify(results, null, 1));
    // the stack paint nobody reached (#273, serve.rs `stacks`): how deep the firmware's stacks went in these scenarios
    if (emuProc instanceof Emu) console.log(`  emu ${await Promise.race([emuProc.cmd('stacks'), new Promise((r) => setTimeout(() => r('stacks: no answer'), 3000))])}`);
    if (!flag('--keep')) {
      await browser.close().catch(() => {});
      emuProc?.quit();
      vite?.kill();
    }
  }
  const failed = results.filter((r) => !r.ok), skipped = results.filter((r) => r.skipped);
  const passed = results.length - failed.length - skipped.length;
  console.log(`\n${passed} of ${results.length} checks passed${skipped.length ? `, ${skipped.length} skipped (${skipped.map((f) => `${f.name}: ${f.reason}`).join('; ')})` : ''}${failed.length ? `; failed: ${failed.map((f) => f.name).join('; ')}` : ''}`);
  process.exit(failed.length ? 1 : 0);   // (a skip is no failure)
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
