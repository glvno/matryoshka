// SPDX-License-Identifier: GPL-3.0-only
// The test rig (#291), shared by scripts/rig.mjs and scripts/emu-scenarios.mjs --device: the dev server, Chrome, the
// rig's page (/__rig, dev/rig-client.ts), and which connected FM-1 is the registered rig.
// The rig is the FM-1 that carries the mark scripts/rig.mjs register wrote (a preset of RIG_STRUCTURE whose values are
// random); the Mac keeps the same values in ~/.config/matryoshka/rig.json. An FM-1 without that mark is never driven.
// register also keeps the rig's USB location there (#698, tools/fm1_usb.py): the socket it is plugged into, which the
// installer (fm1_install.py --rig) and the recorder (tools/fm1_rec.swift) use to tell it from another FM-1 of the same name.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { venvPython } from './branch-firmware.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
/** a test script's dev server: it serves the bundled firmware package, so the page's first firmware request does not start the
 *  Flash tab's own emu:smoke of this branch's CI build (dev/branch-firmware.ts), a second emulator beside the run that made
 *  its timing checks flaky (#521). Nothing here installs through the Flash tab (--install runs fm1_install.py itself). It
 *  watches no files (vite.config.ts): a change to the checkout mid-run no longer reloads the editor's page (#754) */
export const DEV_ENV = { ...process.env, MATRYOSHKA_BUNDLED_FIRMWARE: '1', MATRYOSHKA_NO_WATCH: '1' };
export const RIG_FILE = process.env.MATRYOSHKA_RIG_FILE ?? join(homedir(), '.config/matryoshka/rig.json');

/** an FM-1 as the scripts print it: the firmware's version from INFO (protocol.ts Info.firmware; 0.0.0 a dev or CI build,
 *  absent before 1.8), the link protocol apart, and the port name as a port: macOS caches a port's name, so a rig that
 *  once ran Felucca can still show "Felucca" whatever it runs now */
export function fm1Label(p) {
  const f = p.info?.firmware;
  const fw = !p.info ? 'firmware ? (no INFO)'
    : !f ? 'firmware before 1.8'
    : f.major || f.minor || f.patch ? `firmware ${f.major}.${f.minor}.${f.patch}` : 'firmware 0.0.0 (dev / CI build)';
  return `${fw}, protocol ${p.info?.version ?? '?'}, port ${p.name}`;
}

/** the registered rig's mark ({ values, registered, usbLocation? }: usbLocation "0x01130000", from 2026-11 #698), or null */
export function loadRig() {
  if (!existsSync(RIG_FILE)) return null;
  try {
    const r = JSON.parse(readFileSync(RIG_FILE, 'utf8'));
    return Array.isArray(r.values) && r.values.length === 4 ? r : null;
  } catch {
    return null;
  }
}
export function saveRig(values, usbLocation) {
  mkdirSync(dirname(RIG_FILE), { recursive: true });
  writeFileSync(RIG_FILE, JSON.stringify({ values, usbLocation, registered: new Date().toISOString() }, null, 1) + '\n');
}

/** tools/fm1_usb.py (build/venv's Python): its JSON answer, or throws with its message */
function fm1Usb(args) {
  const py = venvPython();
  if (!py) throw new Error('build/venv is missing (here and in the main checkout): run npm run flash -- --info once (it sets it up)');
  const r = spawnSync(py, [join(ROOT, 'tools/fm1_usb.py'), ...args], { encoding: 'utf8', timeout: 30000 });
  if (r.status !== 0) throw new Error(`tools/fm1_usb.py ${args[0]}: ${(r.stderr || r.error?.message || '').trim()}`);
  return JSON.parse(r.stdout);
}
/** the USB MIDI devices online, by USB location: [{ location: "0x01130000", device, inputs, outputs, fm1 }] */
export const usbDevices = () => fm1Usb(['list', '--json']);
/** the rig's mark on the FM-1 at that USB location: its values, [] (none), or null (no running Matryoshka answered) */
export const markAt = (location) => fm1Usb(['mark', '--location', location]);
/** "0x01130000" -> "1130000", as CoreAudio writes a USB location in a device's id (AppleUSBAudioEngine:..:1130000:1,2) */
export const audioLocation = (location) => parseInt(location, 16).toString(16);

/** what the rig's USB location says now: { location, ok, why }. ok: the FM-1 at the registered location carries the
 *  mark, so that socket is the rig's (an install or a recording may go there); why: else, in words */
export function rigAtLocation() {
  const rig = loadRig();
  if (!rig) return { ok: false, why: 'no rig registered' };
  if (!rig.usbLocation) return { ok: false, why: 'the rig\'s USB location is not recorded: npm run rig -- register again, with the rig alone (it keeps the mark)' };
  let mark;
  try {
    mark = markAt(rig.usbLocation);
  } catch (e) {
    return { location: rig.usbLocation, ok: false, why: e.message };
  }
  if (sameMark(mark, rig.values)) return { location: rig.usbLocation, ok: true };
  const what = mark === null ? 'no running Matryoshka answers there' : mark.length ? 'the FM-1 there carries another mark' : 'the FM-1 there has no rig mark';
  return { location: rig.usbLocation, ok: false, why: `at the rig's USB location ${rig.usbLocation} ${what}` };
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
  const vite = spawn('npx', ['vite', '--port', String(port), '--strictPort', '--host', '::1'], { cwd: join(ROOT, 'web'), stdio: ['ignore', 'pipe', 'inherit'], env: DEV_ENV });
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

/** An isolation failure stops the run, rather than continuing with another scenario. */
export class RigIsolationError extends Error {
  name = 'RigIsolationError';
}

/** Set and save EDITOR IGNORE on a picked target; INFO, not screen wording, proves isolation. */
export async function ensureRigIgnored(target, buttons, encoders, persist = false) {
  try {
    const info = await target.info();
    if (!info || !(info.features & (1 << 19)))
      throw new Error('firmware does not support EDITOR IGNORE');
    if (info.editorIgnored) {
      if (persist) {
        await target.diag(129);
        if (!(await target.info())?.editorIgnored) throw new Error('INFO no longer confirms EDITOR IGNORE');
      }
      return;
    }
    if (!(await target.home())) throw new Error('the rig did not return to its device page');
    await target.tap(buttons.glo);
    try {
      if (!(await target.waitText('ALGO tab', 3000))) throw new Error('the settings menu did not open');
      let found = false;
      for (let i = 0; i < 6; i++) {
        const { texts } = await target.screen();
        if (texts.some((t) => t.s === 'SYSTEM 2/2') && texts.some((t) => t.s === 'EDITOR')) {
          found = true;
          break;
        }
        await target.turn(encoders.algo, 1);
        await target.elapse(300);
      }
      if (!found) throw new Error('the EDITOR row on SYSTEM 2/2 did not appear');
      await target.turn(encoders.k1, 1);
      await target.elapse(300);
      if (!(await target.info())?.editorIgnored) throw new Error('INFO did not confirm EDITOR IGNORE');
      await target.diag(129); // Save only global settings, never the current patch or a slot.
    } finally {
      await target.tap(buttons.glo);
    }
    if (!(await target.info())?.editorIgnored) throw new Error('INFO no longer confirms EDITOR IGNORE');
    console.log('  rig isolation: EDITOR set to IGNORE and settings saved');
  } catch (cause) {
    throw new RigIsolationError(`rig editor isolation failed: ${cause.message}`, { cause });
  }
}
