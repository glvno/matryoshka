// SPDX-License-Identifier: GPL-3.0-only
// The owner's device check of release 1.10 as scenarios: every step of it that needs no ears, no hands and no power switch,
// run by scripts/emu-scenarios.mjs after its own scenarios, on the emulator (npm run emu:scenarios) and on the test rig
// (npm run device:scenarios). What stays with the owner: the analog output by ear (OUTPUT in headphones, MONO L into a
// recorder), playing Io 4 / Hera 6 / Cassia 1 by hand to judge their feel, and every step across a power cycle.
//
// Each scenario names the check's section and steps it covers ("1.1" = section 1, step 1 of the 40-step page). The test
// patches are built in check-fixtures.mjs and kept in the editor's Your patches, as the owner keeps them. What the FM-1
// plays is read three ways: TEST_PEAK (the loudest sample, before MASTER), the screen's texts (TEST_SCREEN), and a
// recording (audio-capture.mjs): the emulator's I2S output, or on the rig its USB audio recorded on this Mac. USB audio is
// taken before GLO > SYSTEM > OUTPUT's mix (firmware/src/audio.c), so OUTPUT's MONO and MONO L are measured on the
// emulator only; on the rig those checks are skipped, not failed, and the owner hears them.
import { correlation, dropouts, hz, onset, peakOf, rmsOf, toneLevel, toneProfile } from './audio-capture.mjs';
import { FIXTURES, NOTE, oldPatch } from './check-fixtures.mjs';

/** the scenarios' names, in the order they run (scripts/emu-scenarios.mjs lists them for --only and --list) */
export const CHECK_SCENARIOS = ['checkOutput', 'checkVerona', 'checkRowDrone', 'checkLiveDrone', 'checkDelays', 'checkNoKeys', 'checkStore',
  'checkOldPattern', 'checkTeach', 'checkDualCore', 'checkUsbLevel'];

/** `h`: what emu-scenarios.mjs's scenarios use (the target, the editor's page, the checks) */
export function checkScenarios(h) {
  const { emu, T, open, patchJson, openSynced, check, loudCheck, skip, until, trackNotes, notesUntil, fmt, noteAt, shot, B, BLACK, WHITE, ENC,
    C4, QUIET, LOUD, DEVICE, REAL } = h;
  const page = () => h.page;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const db = (x) => (x > 0 ? (20 * Math.log10(x)).toFixed(1) : '-inf');
  const r2 = (x) => +x.toFixed(2);
  /** -60 dB: the least a recorded sound must have (the rig's USB audio comes after MASTER, so the checks compare levels
   *  within a recording rather than against fixed ones) */
  const FLOOR = 1e-3;
  const top2 = (a) => Math.max(peakOf(a.l), peakOf(a.r));

  /** a test patch kept in Your patches and opened from the Open picker, synced to the FM-1 */
  async function fixture(make) {
    const p = make();
    if (!(await page().evaluate((j) => window.__m1test.save(j), JSON.stringify(p)))) return null;
    return (await openSynced(p.name)) ? p : null;
  }
  /** a factory patch opened and synced (openSynced), checked with what the editor's link said when it was not */
  async function opens(name, label) {
    const ok = await openSynced(name);
    const x = await T();
    await check(label, ok, ok ? '' : `editor: ${x.status}, chip ${x.chip}, sandbox ${x.sandbox}, loads ${x.loads}/${x.uploadedLoad}; FM-1: ${(await emu.texts()).slice(0, 4).join(' | ')}`);
    return ok;
  }
  /** the editor's copy of a track's notes, by the track's name */
  const notesOf = async (name = 'PATTERN') => JSON.parse(await patchJson()).modules.find((m) => m.type === 'steps' && m.name === name)?.notes ?? [];
  /** a module's parameters in the editor, by its name */
  const paramsOf = async (name) => JSON.parse(await patchJson()).modules.find((m) => m.name === name)?.params ?? {};

  /** what the FM-1 played while `during` ran: { rate, l, r } or { why } (no recording on this target, or one that cannot
   *  prove anything: D-140). The rig's USB audio comes after MASTER, TEST_PEAK before it (as at its default): with the knob
   *  far down the recording is more than 26 dB under what TEST_PEAK heard, below the USB audio's own noise, and is not used */
  async function recorded(name, during) {
    const m = await emu.mark();
    const r = await emu.record(name);
    if (r.why) {
      await during();
      await streams(r);
      return { why: r.why };
    }
    try {
      await during();
    } catch (e) {
      await r.stop().catch(() => {});
      throw e;
    }
    const a = await r.stop();
    await streams(a);
    if (a.why) return a;
    const p = await emu.peak(m), got = top2(a) * 32768;
    if (REAL && p > LOUD && got < p / 20)
      return { why: `MASTER is low: the USB audio's loudest is ${db(got / p)} dB under TEST_PEAK's (at MASTER's default), too far into its noise (D-140)` };
    a.testPeak = p;   // (TEST_PEAK over the recording, as at MASTER's default: USB LEVEL's checks compare with it)
    return a;
  }
  /** the rig's USB audio is a shipped feature: a stream the FM-1 opened and then stopped feeding (or never fed) is a failure,
   *  with its USB audio counters (DIAG 125: on, starts, packets, frames, rate sets, bus resets, lowest fill, USB frame; 126:
   *  underruns, overruns, missed, stalls, rate nudges up / down, fill low / high), and the checks that needed the recording
   *  are skipped (D-140). The first recording that flows passes it once; no recorder or no single FM-1 input stays a skip */
  let flowed = false;
  async function streams(a) {
    if (!REAL) return;
    if (a.stalled) {
      const c = `DIAG 125 ${JSON.stringify(await emu.diagWords(125).catch(() => null))}, 126 ${JSON.stringify(await emu.diagWords(126).catch(() => null))}`;
      await check('USB audio streams: the FM-1 feeds the stream the Mac opened', false, `${a.why}; ${c}`);
    } else if (a.flow && !flowed) {
      flowed = true;
      await check('USB audio streams: the FM-1 feeds the stream the Mac opened', true, a.flow);
    }
  }
  /** a check that needs a recording: skipped (with the reason) when the target has none */
  async function heard(name, a, ok, detail) {
    if (a.why) return skip(name, a.why);
    return check(name, ok, detail);
  }

  /** GLO's menu is up: its tab strip shows (MIDI PANEL SYSTEM INFO GUIDE; the INFO tab has no MENU header) */
  const inMenu = async () => { const t = await emu.texts(); return t.includes('PANEL') && t.includes('GUIDE'); };
  /** GLO's menu on the tab whose rows show `row` (ALGO steps the tabs: MIDI, PANEL, SYSTEM, INFO, GUIDE) */
  async function menuTab(row) {
    if (!(await inMenu())) {
      await emu.tap(B.glo);
      await emu.waitFor(inMenu, 3000);
    }
    for (let i = 0; i < 6 && !(await emu.text(row)); i++) {
      await emu.turn(ENC.algo, 1);
      await emu.elapse(300);
    }
    return emu.text(row);
  }
  async function menuClose() {
    if (await inMenu()) {
      await emu.tap(B.glo);
      await emu.waitFor(async () => !(await inMenu()), 3000);
    }
  }
  /** the OUTPUT row's value on GLO > SYSTEM */
  const outputIs = async () => (await emu.texts()).find((t) => ['STEREO', 'MONO', 'MONO L'].includes(t));
  /** K4 on GLO > SYSTEM (the OUTPUT row) by `clicks`, then the row's value */
  async function output(clicks) {
    await emu.turn(ENC.k4, clicks);
    await emu.elapse(400);
    return outputIs();
  }
  /** OUTPUT back to STEREO and the menu closed, whatever a check left (the setting is not saved: SAVE is never pressed) */
  async function stereoAgain() {
    if (!(await menuTab('OUTPUT'))) return;
    for (let i = 0; i < 3 && (await outputIs()) !== 'STEREO'; i++) await output(-1);
    await menuClose();
  }

  /** the peak in windows of `ms` while `events` ([ms from the start, action]) happen at their times: [ms, peak] each.
   *  The emulator's times are its own (exact), the rig's are when each answer came */
  async function timeline(events, n, ms) {
    const out = [];
    const t0 = Date.now();
    out.fired = [];                                 // (when each event went out, on the same clock)
    let m = await emu.mark(), k = 0;
    for (let i = 0; i < n; i++) {
      const at = DEVICE ? Date.now() - t0 : i * ms;
      while (k < events.length && events[k][0] <= at) { out.fired.push(at); await events[k++][1](); }
      await emu.elapse(ms);
      out.push([DEVICE ? Date.now() - t0 : (i + 1) * ms, await emu.peak(m)]);
      m = await emu.mark();
    }
    while (k < events.length) { out.fired.push(Infinity); await events[k++][1](); }
    return out;
  }
  /** the loudest window in [from, to) ms of a timeline */
  const most = (w, from, to) => Math.max(0, ...w.filter((x) => x[0] > from && x[0] <= to).map((x) => x[1]));
  const prof = (w) => w.map((x) => x[1]).join(',');

  /** HOME held + PRESET: `clicks` patches on (the FM-1's bank, with Live off; with Live on the editor's patch stays) */
  async function presetPatch(clicks) {
    await emu.key(B.home, true);
    await emu.elapse(150);
    await emu.turn(ENC.preset, clicks);
    await emu.elapse(150);
    await emu.key(B.home, false);
    await emu.elapse(400);
  }
  /** HOME held + PRESET a click at a time until the patch named `name` plays (its name in the top bar), at most 64; with
   *  `slot`, until the FM-1 says it plays that slot (SLOT_NOW), since a bank may hold another patch of that name */
  async function presetTo(name, slot = -1) {
    for (let i = 0; i < 65; i++) {
      await presetPatch(1);
      if (await emu.waitFor(async () => (await emu.texts()).some((t) => t.includes(name)), 600)
        && (slot < 0 || (await until(async () => (await T()).slot === slot, 1000)))) return true;
    }
    return false;
  }
  /** Live sync on or off (FM-1 & MIDI's sync line, as the owner turns it off: Stop syncing) */
  async function live(on) {
    if ((await T()).live === on) return true;
    await page().evaluate(() => document.getElementById('dev-sync-btn')?.click());
    if (on && (await until(async () => (await T()).syncAsk, 1500))) await page().click('#sync-ask button[value="sync"]');
    return !!(await until(async () => (await T()).live === on && (!on || (await T()).chip === 'synced'), 6000));
  }
  /** the bank's first empty slot (0-based), -1 when every slot is used */
  const firstEmpty = async () => (await page().evaluate(() => window.__m1test.slots())).findIndex((s) => !s.used);

  /** a drone heard holding: the level of `note`'s pitch in 200 ms windows of a recording (Goertzel; 200 ms tell it from a
   *  note two semitones away), from the first window at 80 % of its loudest: the lowest of the rest and the biggest rise
   *  from one window to the next (a new attack) */
  function droneHeld(a, note) {
    const ch = rmsOf(a.l) >= rmsOf(a.r) ? a.l : a.r;
    const p = toneProfile(ch, a.rate, hz(note), 200);
    const top = Math.max(0, ...p), from = p.findIndex((x) => x >= 0.8 * top);
    const rest = p.slice(from);
    const low = rest.length ? Math.min(...rest) : 0;
    const rise = Math.max(1, ...rest.slice(1).map((x, i) => x / Math.max(1e-9, rest[i])));
    return { top, low, kept: top ? r2(low / top) : 0, rise: r2(rise), windows: p.map((x) => +(x * 1000).toFixed(1)).join(',') };
  }

  /** a level row's value on GLO > SYSTEM 2/2 (USB LEVEL: KNOB, -24 DB .. 0 DB) */
  const levelOf = async (row) => {
    const t = (await emu.screen()).texts;
    const y = t.find((x) => x.s === row)?.y;
    return t.find((x) => Math.abs(x.y - (y ?? -99)) <= 14 && /^(KNOB|-?\d+ DB)$/.test(x.s))?.s;
  };
  /** turn knob `k` (ENC index) a click at a time until the row reads `want`, at most 9 clicks */
  async function levelTo(k, row, want) {
    for (let i = 0; i < 9 && (await levelOf(row)) !== want; i++) {
      await emu.turn(k, want === 'KNOB' ? -1 : 1);
      await emu.elapse(300);
    }
    return levelOf(row);
  }

  return {
    // ---- 1. OUTPUT: STEREO, MONO, MONO L (D-918, D-919), steps 1.1..1.5
    // ---- USB LEVEL (#600): what goes to the computer, apart from MASTER. The emulator has no USB audio: there the analog
    // output (its I2S) must stay as it was; on the rig the USB recording must sit at the fixed level whatever MASTER is
    async checkUsbLevel() {
      const K2 = ENC.k2;
      try {
        await check('usb level: T110 MONO L R opens, synced', !!(await fixture(FIXTURES.monoLR)));
        await check('usb level: GLO > SYSTEM 2/2, its second row USB LEVEL reads KNOB', (await menuTab('USB LEVEL')) && (await levelOf('USB LEVEL')) === 'KNOB', `${await levelOf('USB LEVEL')}`);
        await menuClose();
        const held = (tag) => recorded(`usb-level-${tag}`, async () => { await emu.key(C4, true); await emu.elapse(700); await emu.key(C4, false); await emu.elapse(200); });
        const knob = REAL ? null : await held('knob');
        const at = async (want) => {
          const v = (await menuTab('USB LEVEL')) && (await levelTo(K2, 'USB LEVEL', want));
          await check(`usb level: K2 to ${want}`, v === want, `${v}`);
          await menuClose();
          return held(want.replace(' ', ''));
        };
        const lo = await at('-12 DB');
        if (!REAL) {
          await skip('usb level: the computer records -12 DB under MASTER at its top', 'the emulator has no USB audio: the rig\'s recording proves it');
          const k = knob.why ? 0 : rmsOf(knob.l), f = lo.why ? 0 : rmsOf(lo.l);
          await heard('usb level: the analog output stays at MASTER\'s level (the I2S output, within 0.3 dB)', lo, k > FLOOR && Math.abs(20 * Math.log10(f / k)) <= 0.3, `KNOB ${db(k)} dB, -12 DB ${db(f)} dB`);
        } else {
          // TEST_PEAK reads as if MASTER sat at its default (Q12 2048): -12 DB is Q12 1027, so the recording's loudest is
          // about 6 dB under it, -6 DB (2049) level with it, wherever the knob is
          const rel = (a) => (a.why || !a.testPeak ? NaN : 20 * Math.log10((top2(a) * 32768) / a.testPeak));
          const mid = await at('-6 DB');
          await heard('usb level: -12 DB: the computer records 6 dB under TEST_PEAK, wherever MASTER is (within 1.5 dB)', lo, Math.abs(rel(lo) + 6) <= 1.5, `${rel(lo).toFixed(1)} dB`);
          await heard('usb level: -6 DB: level with TEST_PEAK (within 1.5 dB), 6 dB over -12 DB', mid, Math.abs(rel(mid)) <= 1.5 && Math.abs(rel(mid) - rel(lo) - 6) <= 1, `${rel(mid).toFixed(1)} dB`);
        }
      } finally {
        if (await menuTab('USB LEVEL')) await levelTo(K2, 'USB LEVEL', 'KNOB');
        await check('usb level: back to KNOB', (await levelOf('USB LEVEL')) === 'KNOB', `${await levelOf('USB LEVEL')}`);
        await menuClose();
      }
    },
    async checkOutput() {
      try {
        await check('1.1 output: T110 MONO L R opens, synced', !!(await fixture(FIXTURES.monoLR)));
        await check('1.1 output: GLO > SYSTEM, its fourth row OUTPUT reads STEREO', (await menuTab('OUTPUT')) && (await outputIs()) === 'STEREO', `${await outputIs()}`);
        /** a key held 700 ms: the recording, and the saw's fundamental (C4) and the sine's (C5) on each side */
        const held = async (tag) => {
          const a = await recorded(`output-${tag}`, async () => { await emu.key(C4, true); await emu.elapse(700); await emu.key(C4, false); await emu.elapse(200); });
          if (a.why) return { a };
          const n = Math.round(a.rate * 0.4), at = Math.max(0, onset(a, 0.2 * top2(a))) + Math.round(a.rate * 0.15);
          const lv = (x, f) => (at + n <= x.length ? toneLevel(x, a.rate, f, at, n) : 0);
          const f0 = hz(60), f1 = hz(72);
          return { a, l0: lv(a.l, f0), l1: lv(a.l, f1), r0: lv(a.r, f0), r1: lv(a.r, f1), lr: rmsOf(a.l), rr: rmsOf(a.r), corr: correlation(a.l, a.r) };
        };
        const say = (x) => (x.a.why ? x.a.why : `left C4 ${db(x.l0)} dB C5 ${db(x.l1)} dB, right C4 ${db(x.r0)} dB C5 ${db(x.r1)} dB, correlation ${r2(x.corr)}`);
        const st = await held('stereo');
        await heard('1.1 output: STEREO, a key held: the saw on the left, the sine an octave up on the right (both sides sound)', st.a,
          st.l0 > FLOOR && st.r1 > 0.1 * st.l0 && st.r0 < 0.1 * st.l0, say(st));
        await check('1.2 output: K4 right: MONO', (await output(1)) === 'MONO', `${await outputIs()}`);
        const mo = await held('mono');
        if (REAL) await skip('1.2 output: MONO, both sounds on both sides, each a bit quieter', 'the rig\'s USB audio is taken before OUTPUT\'s mix (audio.c): the emulator\'s I2S proves it, the owner hears it');
        else await heard('1.2 output: MONO, both sounds on both sides, each a bit quieter (the I2S output)', mo.a,
          mo.corr > 0.999 && mo.l0 > 0.3 * st.l0 && mo.l0 < 0.7 * st.l0 && mo.l1 > 0.3 * st.r1 && mo.r0 > 0.3 * st.l0, say(mo));
        await check('1.3 output: K4 right: MONO L', (await output(1)) === 'MONO L', `${await outputIs()}`);
        const ml = await held('mono-l');
        if (REAL) await skip('1.3 output: MONO L, both sounds on the left, the right silent', 'the rig\'s USB audio is taken before OUTPUT\'s mix (audio.c): the emulator\'s I2S proves it, the owner hears it');
        else await heard('1.3 output: MONO L, both sounds on the left, the right silent (the I2S output)', ml.a,
          ml.l0 > 0.3 * st.l0 && ml.l1 > 0.3 * st.r1 && ml.rr < 1e-4, `${say(ml)}, right RMS ${db(ml.rr)} dB`);
        await check('1.3 output: K4 right again: stays MONO L (the end)', (await output(1)) === 'MONO L', `${await outputIs()}`);
        await check('1.4 output: K4 left twice: STEREO', (await output(-1)) === 'MONO' && (await output(-1)) === 'STEREO', `${await outputIs()}`);
        await menuClose();
        // Meridian 8 with the transport running: each side's level in 50 ms windows where it plays
        await check('1.4 output: Meridian 8 opens, synced', await openSynced('Meridian 8'));
        const kit = async (tag) => {
          await emu.tap(B.play);
          await emu.elapse(300);
          const a = await recorded(`output-meridian-${tag}`, () => emu.elapse(2400));
          await emu.tap(B.play);
          await emu.elapse(500);
          return a;
        };
        const balance = (a) => {
          const n = Math.round(a.rate * 0.05), w = [], loud = [];
          for (let i = 0; i + n <= a.l.length; i += n) w.push([rmsOf(a.l, i, i + n), rmsOf(a.r, i, i + n)]);
          const most = Math.max(0, ...w.map(([l, r]) => Math.max(l, r)));
          for (const [l, r] of w) if (Math.max(l, r) > Math.max(FLOOR, most / 10)) loud.push(Math.abs(20 * Math.log10(Math.max(l, 1e-9) / Math.max(r, 1e-9))));
          return { windows: loud.length, even: loud.length ? loud.filter((x) => x <= 3).length / loud.length : 0, worst: r2(Math.max(0, ...loud)) };
        };
        const ks = await kit('stereo');
        const bs = ks.why ? null : balance(ks);
        await heard('1.4 output: STEREO, Meridian 8 sits in both ears (in nine of ten loud 50 ms windows the sides within 3 dB)', ks,
          !!bs && bs.windows >= 10 && bs.even >= 0.9, bs ? `${bs.windows} loud windows, ${Math.round(bs.even * 100)} % within 3 dB, worst ${bs.worst} dB` : '');
        await check('1.5 output: GLO > SYSTEM, K4 right: MONO', (await menuTab('OUTPUT')) && (await output(1)) === 'MONO', `${await outputIs()}`);
        await menuClose();
        const km = await kit('mono');
        if (REAL) await skip('1.5 output: MONO, Meridian 8 as loud as in STEREO', 'the rig\'s USB audio is taken before OUTPUT\'s mix (audio.c): the emulator\'s I2S proves it');
        else {
          const s = ks.why ? 0 : (rmsOf(ks.l) + rmsOf(ks.r)) / 2, m = km.why ? 0 : rmsOf(km.l);
          await heard('1.5 output: MONO, Meridian 8 as loud as in STEREO (RMS within 1.5 dB; it was 6 dB lower)', km,
            s > 0.005 && Math.abs(20 * Math.log10(m / s)) <= 1.5, `STEREO ${db(s)} dB a side, MONO ${db(m)} dB`);
        }
        await check('1.5 output: K4 left: STEREO', (await menuTab('OUTPUT')) && (await output(-1)) === 'STEREO', `${await outputIs()}`);
      } finally {
        await stereoAgain();
      }
    },

    // ---- 2. Verona Drum 1 (D-862, D-864, D-866, D-863), steps 2.1..2.5
    async checkVerona() {
      await check('2.1 verona: Verona Drum 1 opens, synced', await openSynced('Verona Drum 1'));
      let found = await emu.shows('VERONA DRUM1');
      for (let i = 0; i < 8 && !found; i++) {
        await emu.turn(ENC.select, 1);
        found = await emu.waitShows('VERONA DRUM1', 600);
      }
      await check('2.1 verona: SELECT to its device: the header reads VERONA DRUM1 (12 characters)', found, (await emu.texts()).slice(0, 4).join(' | '));
      const m = await emu.mark();
      await emu.key(WHITE[4], true);
      await emu.elapse(300);
      const said = await emu.waitText('DRUMS: BLACK KEYS 1-8', 1500);
      await emu.key(WHITE[4], false);
      const p = await emu.peak(m);
      await check('2.2 verona: a white key on its device page: nothing plays, the bar says DRUMS: BLACK KEYS 1-8', said && p < QUIET, `peak ${p}`);
      await emu.elapse(1600);
      // the hats: black key 5 HH OPEN, 6 HH CLOSE; the peak in 25 ms windows from the first press
      const [OPEN, CLOSE] = [BLACK[4], BLACK[5]];
      const down = (k) => () => emu.key(k, true), up = (k) => () => emu.key(k, false);
      const alone = await timeline([[0, down(OPEN)], [80, up(OPEN)]], 28, 25);
      await emu.elapse(800);
      const held = await timeline([[0, down(OPEN)], [100, down(CLOSE)], [180, up(CLOSE)], [500, up(OPEN)]], 28, 25);
      await emu.elapse(800);
      const tapped = await timeline([[0, down(OPEN)], [80, up(OPEN)], [120, down(CLOSE)], [200, up(CLOSE)]], 28, 25);
      await emu.elapse(800);
      console.log(`  verona open hat alone: ${prof(alone)}\n  open held, close pressed at ${held.fired[1]} ms: ${prof(held)}\n  open tapped, close at ${tapped.fired[2]} ms: ${prof(tapped)}`);
      // the open hat alone rings about 300 ms; a close cuts it: from 75 to 175 ms after the close's press (its own hit is
      // over by then) the open hat alone, at the same time from its press, is still well up
      const top = most(alone, 0, 150);
      const cut = (w, i) => { const t = w.fired[i]; return { was: most(alone, t + 75, t + 175), now: most(w, t + 75, t + 175) }; };
      const ch = cut(held, 1), ct = cut(tapped, 2);
      await loudCheck('2.3 verona: stopped, HH OPEN held and HH CLOSE pressed: the open hat\'s tail is cut (75..175 ms after the close, under a third of the open hat alone)', top,
        top > LOUD / 2 && ch.was > QUIET && ch.now < ch.was / 3, `open alone: peak ${top}, then ${ch.was}; held + close: ${ch.now}`);
      await loudCheck('2.3 verona: HH OPEN tapped, then HH CLOSE right after: cut too', top,
        top > LOUD / 2 && ct.was > QUIET && ct.now < ct.was / 3, `${ct.now} against ${ct.was}`);
      // #657: the other order, HH CLOSE held, then HH OPEN: the open hat plays, and rings on once both are let go (from the
      // release on, as loud as the open hat alone at the same time from its hit, not cut)
      const other = await timeline([[0, down(CLOSE)], [150, down(OPEN)], [270, up(OPEN)], [290, up(CLOSE)]], 32, 25);
      await emu.elapse(800);
      const [, tOpen, , tGo] = other.fired, after = tGo - tOpen;
      console.log(`  close held, open pressed at ${tOpen} ms, both let go at ${tGo} ms: ${prof(other)}`);
      const hit = most(other, tOpen, tOpen + 125), ring = most(other, tGo, tGo + 100), ref = most(alone, after, after + 100);
      await loudCheck('2.4 verona: HH CLOSE held, HH OPEN pressed: the open hat plays (its peak at least half of its own) (#657)', hit,
        hit >= top / 2 && hit > LOUD, `open's peak ${hit}, alone ${top}`);
      await loudCheck('2.4 verona: let go of both: its tail rings out (the 100 ms after, at least half of the open hat alone that long after its hit)', hit,
        ref > QUIET && ring >= ref / 2, `tail ${ring}, alone ${ref} (${after} ms after the hit)`);
      // 2.5: the XL in sandbox mode: the browser plays it from the FM-1's keys (the level of the editor's own output)
      await page().evaluate(() => window.__m1test.level());
      await open('Verona Drum 1 XL');
      const sb = await until(async () => (await T()).sandbox, 4000);
      await check('2.5 verona: Verona Drum 1 XL: the FM-1 goes to sandbox mode', !!sb && (await emu.waitSandboxPage(6000)));
      await emu.elapse(1500);
      const level = () => page().evaluate(() => window.__m1test.level());
      /** the browser's output while key `k` is held 150 ms and 250 ms after ({ peak, energy }); the wall clock, the browser's
       *  own (the key reaches it over MIDI) */
      const browserHit = async (k) => {
        await level();
        await emu.key(k, true);
        await sleep(150);
        await emu.key(k, false);
        await sleep(400);
        return (await level()) ?? { peak: -1, energy: 0 };
      };
      const rows = [];
      for (const k of BLACK) rows.push(await browserHit(k));
      const whites = [];
      for (const k of [WHITE[0], WHITE[4], WHITE[8]]) whites.push(await browserHit(k));
      await check('2.5 verona: black keys 1..8 each play (the browser\'s output; KICK .. CLAP by ear is the owner\'s)', rows.every((x) => x.peak > 0.02), rows.map((x) => x.peak.toFixed(3)).join(' '));
      await check('2.5 verona: the white keys play nothing', whites.every((x) => x.peak >= 0 && x.peak < 0.005), whites.map((x) => x.peak.toFixed(4)).join(' '));
      // black key 6 (HI HAT 1) held and 7 (HI HAT 2) pressed: both play (D-866: each row's Pulse makes a new edge, so 7's hit
      // is not lost while 6 is down): the 300 ms from 7's press hold about the energy of 7 alone
      const window300 = async (first, second) => {
        if (first) await emu.key(first, true);
        await sleep(100);
        await level();
        await emu.key(second, true);
        await sleep(150);
        await emu.key(second, false);
        await sleep(150);
        const v = (await level()) ?? { peak: -1, energy: 0 };
        if (first) await emu.key(first, false);
        await sleep(400);
        return v.energy;
      };
      const seven = await window300(0, BLACK[6]), both = await window300(BLACK[5], BLACK[6]);
      await check('2.5 verona: black key 6 held and 7 pressed: both hats play (7\'s hit is not lost: at least 70 % of the energy of 7 alone)',
        rows[5].peak > 0.02 && seven > 0 && both >= 0.7 * seven, `6 alone peak ${rows[5].peak.toFixed(3)}; energy of 7 alone ${seven.toFixed(2)}, 6 held + 7 ${both.toFixed(2)}`);
      await shot('check-verona-xl');
    },

    // ---- 3. row drones (D-819), steps 3.1..3.4
    async checkRowDrone() {
      await check('3.1 row drone: T110 DRONE opens, synced', !!(await fixture(FIXTURES.drone)));
      await emu.tap(B.seq, 120);
      await check('3.1 row drone: SEQ: the roll on the page C3-G3', (await emu.waitText('ALGO track', 3000)) && (await emu.waitText('C3-G3', 2000)));
      await emu.tap(BLACK[4]);                       // black key 5: row E3
      await emu.elapse(300);
      await emu.key(B.lfo, true);
      await emu.elapse(150);
      await emu.tap(B.fx);
      const said = await emu.waitText('DRONE', 1500);
      await emu.key(B.lfo, false);
      await emu.elapse(300);
      let ns = await notesUntil((x) => noteAt(x, 4, NOTE.E3)?.wrap === true);
      await check('3.2 row drone: LFO held + FX: DRONE; E3 left only on step 5, a drone; step 11\'s E3 gone; the other rows as they were',
        said && noteAt(ns, 4, NOTE.E3)?.wrap === true && noteAt(ns, 4, NOTE.E3)?.len === 64 && !noteAt(ns, 10, NOTE.E3)
        && noteAt(ns, 0, NOTE.C3)?.len === 16 && !!noteAt(ns, 8, NOTE.G3) && !!noteAt(ns, 12, NOTE.D3) && ns.length === 4, fmt(ns));
      await emu.snap('check-row-drone');
      await emu.tap(B.play);
      await emu.elapse(200);
      const a = await recorded('row-drone', () => emu.elapse(4600));
      await emu.tap(B.play);
      await emu.elapse(500);
      const d = a.why ? null : droneHeld(a, NOTE.E3);
      if (d) console.log(`  E3's level per 200 ms (x1000): ${d.windows}`);
      await heard('3.2 row drone: PLAY: E3 holds over the loop, no new attack at its end (E3\'s level keeps 70 %, no rise over 1.3x)', a,
        !!d && d.top > FLOOR && d.kept >= 0.7 && d.rise <= 1.3, d ? `E3 ${db(d.top)} dB, kept ${d.kept}, biggest rise ${d.rise}x` : '');
      await emu.key(B.lfo, true);
      await emu.elapse(150);
      await emu.tap(B.fx);
      const off = await emu.waitText('DRONE OFF', 1500);
      await emu.key(B.lfo, false);
      await emu.elapse(300);
      ns = await notesUntil((x) => noteAt(x, 4, NOTE.E3)?.len === 1);
      await check('3.3 row drone: LFO held + FX again: DRONE OFF, E3 one step on step 5, step 11\'s E3 does not come back',
        off && noteAt(ns, 4, NOTE.E3)?.len === 1 && !noteAt(ns, 4, NOTE.E3)?.wrap && !noteAt(ns, 10, NOTE.E3) && ns.length === 4, fmt(ns));
      await emu.tap(BLACK[1]);                       // black key 2: row C#3, empty
      await emu.elapse(300);
      await emu.key(B.lfo, true);
      await emu.elapse(150);
      await emu.tap(B.fx);
      const none = await emu.waitText('NOTHING TO DRONE', 1500);
      await emu.key(B.lfo, false);
      await emu.elapse(300);
      ns = await trackNotes();
      await check('3.4 row drone: an empty row (C#3), LFO held + FX: NOTHING TO DRONE, nothing changes', none && ns.length === 4, fmt(ns));
      await emu.tap(B.seq, 120);
      await emu.waitOwnPage(3000);
    },

    // ---- 3. the live take's drone (D-819, #582), steps 3.5..3.7
    async checkLiveDrone() {
      await check('3.5 live drone: T111 LIVE DRONE opens, synced', !!(await fixture(FIXTURES.liveDrone)));
      await emu.tap(B.seq, 120);
      await emu.waitText('ALGO track', 3000);
      await emu.tap(B.rec);
      await check('3.5 live drone: REC, stopped: step record, the bar starts with STEP 1/16, the hint reads LFO rest  KEY+LFO tie (TEST_SCREEN sends its first 31 characters)',
        (await emu.waitText('STEP 1/16', 3000)) && (await emu.text('LFO rest  KEY+LFO')), (await emu.texts()).join(' | '));
      await emu.key(B.fx, true);
      await emu.elapse(150);
      await emu.tap(B.lfo);
      const step2 = await emu.waitText('STEP 2/16', 1500), drone = await emu.text('DRONE');
      await emu.key(B.fx, false);
      await emu.elapse(300);
      await check('3.5 live drone: FX held + LFO: no DRONE (LFO is the rest there), the bar moves to STEP 2/16', step2 && !drone);
      await emu.tap(B.rec);
      await check('3.5 live drone: REC: step record ends', (await emu.waitText('ALGO track', 2000)) && !(await emu.text('STEP ')));
      const before = await notesOf();
      await emu.tap(B.play);
      await emu.elapse(300);
      await emu.tap(B.rec);
      await check('3.6 live drone: PLAY, then REC: recording', await emu.waitText('PATTERN REC', 3000));
      const D4 = WHITE[5];
      await emu.key(D4, true);
      await emu.elapse(3000);                        // (about 3 s: the loop is 2 s at 120 BPM)
      await emu.key(D4, false);
      await emu.elapse(300);
      await emu.tap(B.rec);
      await emu.elapse(500);
      const ns = await notesUntil((x) => x.some((n) => n.note !== NOTE.C4 && n.wrap), 4000);
      const took = ns.find((n) => n.note !== NOTE.C4);
      await check('3.6 live drone: REC off, the transport goes on; the key held past the loop is a drone on its step',
        !!took && took.wrap === true && took.len === 64 && ns.filter((n) => n.note === NOTE.C4).length === before.length && (await T()).deviceRunning,
        `${fmt(ns)}; ${(await T()).deviceRunning ? 'running' : 'stopped'}`);
      const a = await recorded('live-drone', () => emu.elapse(4400));
      const d = a.why || !took ? null : droneHeld(a, took.note);
      if (d) console.log(`  its level per 200 ms (x1000): ${d.windows}`);
      await heard('3.6 live drone: it holds, with no new attack each loop (its pitch keeps 70 %, no rise over 1.3x)', a,
        !!d && d.top > FLOOR && d.kept >= 0.7 && d.rise <= 1.3, d ? `${db(d.top)} dB, kept ${d.kept}, biggest rise ${d.rise}x` : 'no note');
      // the editor's roll draws it on across the track (roll.ts: a drone's note is drawn to the track's end, class drone)
      // (its track's ROLL button, on its step grid: the patch has one track)
      const rollBtn = () => page().evaluate(() => { const b = [...document.querySelectorAll('button.steps-roll')].find((x) => x.offsetParent); b?.click(); return !!b; });
      const opened = await rollBtn();
      // (a drone is drawn from its step to the track's end and again from its first step up to it: its pieces span the
      // track's 16 steps, a step being as wide as a one-step note)
      const drawn = opened ? await until(() => page().evaluate(() => {
        const d = [...document.querySelectorAll('.roll-note.drone')], one = document.querySelector('.roll-note:not(.drone)');
        const w = (e) => e.getBoundingClientRect().width + 2;
        return d.length ? { pieces: d.length, steps: one ? Math.round(d.reduce((s, e) => s + w(e), 0) / w(one)) : null } : null;
      }), 2000) : null;
      await check('3.6 live drone: the editor\'s roll draws it as a drone, on across the track (its pieces span the 16 steps)',
        !!drawn && (drawn.steps === 16 || (drawn.steps === null && drawn.pieces >= 1)), opened ? JSON.stringify(drawn) : 'no ROLL button on the track\'s step grid');
      await shot('check-live-drone-roll');
      if (opened) await rollBtn();
      const g = await recorded('live-drone-stop', async () => { await emu.elapse(400); await emu.tap(B.play); await emu.elapse(1600); });
      if (!g.why) {
        const n = Math.round(g.rate * 0.2), before400 = rmsOf(g.l, 0, n) + rmsOf(g.r, 0, n), end = rmsOf(g.l, g.l.length - n) + rmsOf(g.r, g.r.length - n);
        await heard('3.7 live drone: PLAY (stop): it releases (the last 200 ms under a tenth of the playing level)', g, before400 > FLOOR && end < before400 / 10, `${db(before400)} dB playing, ${db(end)} dB at the end`);
      } else await heard('3.7 live drone: PLAY (stop): it releases', g, false, '');
      await emu.tap(B.seq, 120);
      await check('3.7 live drone: SEQ to leave the page: the page armed the track, the bar says PATTERN STAYS ARMED', await emu.waitText('PATTERN STAYS ARMED', 2000));
      await emu.waitOwnPage(3000);
    },

    // ---- 4. effect memory and the Delay's length (D-375, D-376), steps 4.1..4.5
    async checkDelays() {
      const p = FIXTURES.twoDelays();
      await page().evaluate((j) => window.__m1test.save(j), JSON.stringify(p));
      const chip = await page().evaluate((n) => window.__m1test.chip(n), p.name);
      await check('4.1 delays: the Open picker shows T111 TWO DELAYS as FM-1, not SANDBOX', /^FM-1/.test(chip ?? ''), chip ?? 'not listed');
      await check('4.1 delays: it opens, synced (1.9 refused a second Delay)', await openSynced(p.name));
      /** one note: the echoes' levels, each side, against its level just before the echo is due (the pluck has gone by then) */
      const echoes = async (tag) => {
        const a = await recorded(`delays-${tag}`, async () => { await emu.key(C4, true); await emu.elapse(100); await emu.key(C4, false); await emu.elapse(1700); });
        if (a.why) return { a };
        const dry = top2(a), at = onset(a, 0.2 * dry), ms = (t) => at + Math.round((a.rate * t) / 1000);
        const lv = (x, t0, t1) => rmsOf(x, Math.min(x.length, ms(t0)), Math.min(x.length, ms(t1)));
        return { a, at, dry, l300: lv(a.l, 290, 400), r300: lv(a.r, 290, 400), rPre: lv(a.r, 220, 285), l1200: lv(a.l, 1190, 1300), lPre: lv(a.l, 1000, 1180), r1200: lv(a.r, 1190, 1300) };
      };
      const say = (e) => (e.a.why ? '' : `right ${db(e.rPre)} -> ${db(e.r300)} dB at 300 ms (left ${db(e.l300)}), left ${db(e.lPre)} -> ${db(e.l1200)} dB at 1200 ms (right ${db(e.r1200)})`);
      const both = (e) => e.at >= 0 && e.r300 > 4 * e.rPre && e.r300 > 0.05 * e.dry && e.l300 < e.r300 / 3 && e.l1200 > 4 * e.lPre && e.l1200 > 0.05 * e.dry && e.r1200 < e.l1200 / 3;
      const e1 = await echoes('first');
      await heard('4.1 delays: one note: a short echo right (300 ms), a long one left (1200 ms)', e1.a, !e1.a.why && both(e1), say(e1));
      // the FM-1's LONG pages: LENGTH is set in the editor, TIME stops at the length
      let found = false;
      for (let i = 0; i < 8 && !found; i++) { await emu.turn(ENC.select, 1); found = await emu.waitText('LONG', 600); }
      // (the page's number is drawn as dashes under the header, not text: page 2 is the one whose fourth row is LENGTH)
      let pg = await emu.shows('LENGTH');
      for (let i = 0; i < 3 && !pg; i++) { await emu.turn(ENC.algo, 1); pg = await emu.waitShows('LENGTH', 600); }
      await emu.turn(ENC.k4, 3);
      const set = await emu.waitText('SET IN THE EDITOR', 1500);
      await emu.elapse(1300);
      await emu.turn(ENC.k4, -3);
      await emu.elapse(600);
      await check('4.2 delays: SELECT to LONG, ALGO to LONG 2/2, K4 (LENGTH) either way: SET IN THE EDITOR, the length stays 1200',
        found && pg && set && (await paramsOf('LONG')).length === 1200, `LONG ${found}, its page 2 (LENGTH) ${pg}, the bar's message ${set}, length ${(await paramsOf('LONG')).length}; ${(await emu.texts()).slice(0, 6).join(' | ')}`);
      pg = await emu.shows('FB');                     // (page 1: TIME, FB, MIX, SYNC; page 2's NOTE row reads TIME)
      for (let i = 0; i < 3 && !pg; i++) { await emu.turn(ENC.algo, -1); pg = await emu.waitShows('FB', 600); }
      await emu.turn(ENC.k1, 6);
      await emu.elapse(800);
      const t = (await paramsOf('LONG')).time;
      await check('4.3 delays: ALGO to LONG 1/2, K1 (TIME) right: it stops at 1200 (its length)', pg && t === 1200 && (await emu.text('1200')), `its page 1 (TIME, FB ..) ${pg}, time ${t}; ${(await emu.texts()).slice(0, 6).join(' | ')}`);
      // the budget's effect memory lines
      await page().click('#budget summary');
      const lines = await until(() => page().evaluate(() => {
        const items = [...document.querySelectorAll('#budget .budget-item')].map((e) => e.textContent.replace(/\s+/g, ' ').trim());
        return items.some((x) => x.startsWith('Effect memory')) ? items : null;
      }), 2000) ?? [];
      const mem = lines.find((x) => x.startsWith('Effect memory')) ?? '';
      const under = lines.slice(lines.indexOf(mem) + 1, lines.indexOf(mem) + 3);
      await check('4.4 delays: the FM-1 budget: Effect memory 129 / 190 KB, a line under it for LONG and one for SHORT',
        mem === 'Effect memory129 / 190 KB' && under.some((x) => /^Delay LONG/.test(x)) && under.some((x) => /^Delay SHORT/.test(x)), [mem, ...under].join(' | '));
      const shortId = JSON.parse(await patchJson()).modules.find((m) => m.name === 'SHORT')?.id;
      await page().evaluate(() => [...document.querySelectorAll('#budget .budget-item.pick')].find((e) => /Delay SHORT/.test(e.textContent))?.click());
      const sel = await until(async () => (await T()).selected.includes(shortId), 2000);
      await check('4.4 delays: a click on SHORT\'s line selects its card', !!sel, `selected ${JSON.stringify((await T()).selected)}, SHORT is ${shortId}`);
      await page().keyboard.press('Escape');
      // drag SHORT's length row to its top: it stops at 700 ms and says why; the FM-1 loads the patch again
      await page().evaluate(() => window.__sent.splice(0));
      // (a card the page shows over the canvas, the tutorial's offer, would take the drag)
      await page().evaluate(() => {
        // (cards over the canvas: the tutorial's offer, the sandbox card a sandbox patch earlier showed)
        for (const c of document.querySelectorAll('.tutorial-offer')) [...c.querySelectorAll('button')].find((b) => /not now|got it/i.test(b.textContent))?.click();
        document.querySelector('.toast .toast-close')?.click();   // (an Undo toast of the patch opened)
      });
      const row = page().locator(`.module[data-id="${shortId}"] input[aria-label="Delay length"]`);
      await row.scrollIntoViewIfNeeded();
      const box = await row.boundingBox();
      if (box) {
        await page().mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page().mouse.down();
        await page().mouse.move(box.x + box.width + 300, box.y + box.height / 2, { steps: 12 });
        await page().mouse.up();
      }
      // (the drag must reach the row: what is under the pointer is said when it did not)
      const pointed = box ? await page().evaluate(([x, y]) => { const e = document.elementFromPoint(x, y); return e ? `${e.tagName.toLowerCase()}.${[...e.classList].join('.')}` : 'nothing'; }, [box.x + box.width / 2, box.y + box.height / 2]) : 'no row';
      await shot('check-delays-drag');
      const toast = await until(() => page().evaluate(() => { const t = document.querySelector('.toast span')?.textContent ?? ''; return /^Effect memory/.test(t) ? t : ''; }), 2000);
      const len = (await paramsOf('SHORT')).length;
      await check('4.5 delays: SHORT\'s length dragged to its top stops at 700 ms, a note says the memory is full and why',
        len === 700 && /^Effect memory full: \d+ of 190 KB used\. Shorten the other Delay\. This Delay stops at 700 ms\.$/.test(toast), `length ${len}; "${toast}"; under the pointer: ${pointed}`);
      const up = await until(async () => {
        const x = await T();
        return x.status === 'patch on the FM-1' && x.chip === 'synced' && (await page().evaluate(() => window.__sent.some((f) => f[1] === 0x10 || f[1] === 0x11))) ? x : null;
      }, 8000);
      await check('4.5 delays: the FM-1 loads the patch again', !!up, `${(await T()).status}`);
      await emu.waitOwnPage(6000);
      await emu.elapse(500);
      const e2 = await echoes('after');
      await heard('4.5 delays: both echoes play after it', e2.a, !e2.a.why && both(e2), say(e2));
    },

    // ---- 5. an engine no keys reach (D-905, D-295, #633), steps 5.1, 5.2
    async checkNoKeys() {
      await check('5.1 no keys: T111 NO KEYS opens, synced', !!(await fixture(FIXTURES.noKeys)));
      const dot = await page().evaluate(() => {
        const d = document.querySelector('.arm-dot.no-keys');
        return d ? { style: getComputedStyle(d, '::before').borderTopStyle, title: d.title } : null;
      });
      await check('5.1 no keys: the engine\'s ARM dot is dashed', !!dot && /dashed/.test(dot.style), JSON.stringify(dot));
      await page().evaluate(() => document.querySelector('.arm-dot.no-keys')?.click());
      await sleep(400);
      await check('5.1 no keys: a click on it arms nothing', (await T()).armed.length === 0, JSON.stringify((await T()).armed));
      let found = await emu.text('BASIC POLY');
      for (let i = 0; i < 6 && !found; i++) { await emu.turn(ENC.select, 1); found = await emu.waitText('BASIC POLY', 600); }
      await emu.tap(B.scl);
      await check('5.2 no keys: SELECT to basic poly, SEL: NO KEYS REACH THIS DEVICE', found && (await emu.waitText('NO KEYS REACH THIS DEVICE', 1500)));
      await emu.elapse(600);
      await check('5.2 no keys: nothing is armed, in the editor either', (await T()).armed.length === 0 && (await emu.waitText('KEYS WIRED', 3000)));
      const p = await emu.notePeak();
      await check('5.2 no keys: the keys play nothing', p < QUIET, `peak ${p}`);
    },

    // ---- 6. the store dialog and format 50 (D-959, D-297, D-461), steps 6.1..6.4
    async checkStore() {
      const p = await fixture(FIXTURES.droneStored);
      await check('6.1 store: T110 DRONE STORED (C3 a drone; format 50) opens, synced', !!p && (await notesOf()).some((n) => n.note === NOTE.C3 && n.wrap && n.len === 64));
      const heldDrone = async (tag) => {
        await emu.tap(B.play);
        await emu.elapse(300);
        const w = await emu.windows(100, 25);
        await emu.tap(B.play);
        await emu.elapse(600);
        const all = w.filter((x) => !x[2]).map((x) => x[1]);
        const top = all.length ? Math.max(...all) : 0, v = all.slice(Math.max(0, all.findIndex((x) => x >= 0.8 * top)));
        const low = v.length ? Math.min(...v) : 0;
        console.log(`  ${tag} peaks per 25 ms: ${prof(w)}`);
        return { top, low, ok: top > LOUD && low >= 0.8 * top };
      };
      let d = await heldDrone('store, before');
      await loudCheck('6.1 store: PLAY: C3 holds through the loop point (every window after its attack keeps 80 %)', d.top, d.ok, `peak ${d.top}, lowest ${d.low}`);
      // the store dialog: its 64 slots, a used one says what it holds (Replace), the first empty one Store
      await page().keyboard.press('/');
      await page().waitForSelector('#palette[open]', { timeout: 2000 });
      await page().fill('#palette-input', 'Store to an FM-1 slot');
      await page().keyboard.press('Enter');
      const shown = await page().waitForSelector('#store-slot[open]', { timeout: 15000 * h.SLACK }).then(() => true, () => false);
      const dlg = () => page().evaluate(() => {
        const sel = document.getElementById('store-slot-list');
        return { texts: [...sel.options].map((o) => o.textContent), value: sel.value, note: document.getElementById('store-slot-note').textContent, button: document.getElementById('store-slot-go').textContent };
      });
      const pick = (v) => page().evaluate((x) => { const s = document.getElementById('store-slot-list'); s.value = String(x); s.dispatchEvent(new Event('change')); }, v);
      const d0 = shown ? await dlg() : { texts: [] };
      const empty = d0.texts.findIndex((x) => / {2}EMPTY$/.test(x)), used = d0.texts.findIndex((x) => !/ {2}EMPTY$/.test(x));
      await check('6.2 store: "Store to an FM-1 slot…": the 64 slots, each with its patch\'s name or EMPTY, the first empty one chosen',
        shown && d0.texts.length === 64 && (empty < 0 || (Number(d0.value) === empty && d0.button === 'Store')), `${d0.texts.length} slots, chosen ${d0.value}, first empty ${empty}`);
      let slot = -1;
      if (shown && used >= 0) {
        await pick(used);
        const d1 = await dlg();
        await check('6.2 store: a used slot says what it holds, the button reads Replace', /holds ".+": storing replaces it with "T110 DRONE STORED"\./.test(d1.note) && d1.button === 'Replace', `"${d1.note}" ${d1.button}`);
      }
      if (shown && empty >= 0) {
        await pick(empty);
        const d2 = await dlg();
        await page().click('#store-slot-go');
        slot = empty;
        const stored = await until(async () => /stored into FM-1 slot/.test((await T()).status ?? ''), 8000);
        const s = await page().evaluate((n) => window.__m1test.slots().then((x) => x[n]), slot);
        await check(`6.2 store: the first empty slot again (${slot + 1}): Store stores it there`, d2.button === 'Store' && !!stored && s?.used && s.name === 'T110 DRONE STORED',
          `${(await T()).status}; slot ${slot + 1}: ${JSON.stringify(s)}`);
      } else if (shown) {
        await page().keyboard.press('Escape');
        await skip('6.2 store: Store into the first empty slot', 'the FM-1\'s bank has no empty slot');
      }
      try {
        await presetPatch(1);
        const stays = await emu.waitText('EDITOR LIVE: PATCH STAYS', 1500);
        await check('6.3 store: with Live on, HOME held + PRESET: the patch stays, the bar says EDITOR LIVE: PATCH STAYS', stays && (await T()).patch === 'T110 DRONE STORED');
        await emu.elapse(1600);
        await check('6.3 store: Live off in the editor (Stop syncing)', await live(false));
        await emu.elapse(5000);
        if (slot < 0) return skip('6.4 store: the stored slot plays its drone', 'nothing was stored');
        await presetPatch(1);
        await emu.elapse(800);
        const back = await presetTo('T110 DRONE', slot);   // (by its slot: the bank may hold the owner's own copies)
        await check('6.4 store: HOME held + PRESET to another patch and back to the slot stored', back, (await emu.texts()).slice(0, 3).join(' | '));
        await emu.tap(B.seq, 120);
        await emu.waitText('ALGO track', 3000);
        d = await heldDrone('store, from its slot');
        await loudCheck('6.4 store: SEQ, PLAY: C3 is still a drone (it holds through the loop point)', d.top, d.ok, `peak ${d.top}, lowest ${d.low}`);
        await emu.snap('check-store-slot');
        await emu.tap(B.seq, 120);
        await emu.waitOwnPage(3000);
      } finally {
        if (slot >= 0) await page().evaluate((n) => window.__m1test.eraseSlot(n), slot).catch((e) => console.log(`  note: slot ${slot + 1} not emptied: ${e.message}`));
        await live(true);
      }
    },

    // ---- 6. a patch with a pattern stored on 1.9 plays as it did (D-297), step 6.5: Silver Box's bytes as 1.9.1 wrote them
    // into the bank (format 48, with its patterns section) in a slot of its own, against today's Silver Box from the editor.
    // Its pattern 1 is empty: PRESET on the SEQ page picks pattern 2, which has notes, as a hand would
    async checkOldPattern() {
      const old = oldPatch();
      const pass = async (tag) => {
        await emu.tap(B.seq, 120);
        await emu.waitText('ALGO track', 3000);
        await emu.turn(ENC.preset, 1);
        const p2 = await emu.waitText('P02', 2000);
        await emu.tap(B.play);
        await emu.elapse(200);
        const w = await emu.windows(80, 25);
        const run = (await T()).deviceRunning;
        await emu.tap(B.play);
        await emu.elapse(600);
        await emu.tap(B.seq, 120);
        await emu.waitOwnPage(3000);
        console.log(`  ${tag}, pattern 2, peaks per 25 ms: ${prof(w)}`);
        return { p2, run, top: Math.max(0, ...w.map((x) => x[1])), loud: w.filter((x) => x[1] > LOUD).length };
      };
      await check('6.5 old pattern: Silver Box opens, synced', await openSynced(old.factory));
      const now = await pass('today\'s Silver Box');
      const slot = await firstEmpty();
      if (slot < 0) return skip('6.5 old pattern: a 1.9 patch from the bank', 'the FM-1\'s bank has no empty slot');
      try {
        await page().evaluate(([n, name, b]) => window.__m1test.storeBin(n, name, b), [slot, old.name, old.bytes]);
        const s = await page().evaluate((n) => window.__m1test.slots().then((x) => x[n]), slot);
        await check(`6.5 old pattern: Silver Box as 1.9.1 stored it (format ${old.format}) in slot ${slot + 1}`, s?.used && s.name === old.name, JSON.stringify(s));
        await check('6.5 old pattern: Live off', await live(false));
        await emu.elapse(1000);
        await check('6.5 old pattern: HOME held + PRESET to it', await presetTo(old.name, slot), (await emu.texts()).slice(0, 3).join(' | '));
        const then = await pass('1.9.1\'s Silver Box from the bank');
        await loudCheck('6.5 old pattern: SEQ, its pattern 2, PLAY: it plays as today\'s Silver Box does (running, its loudest within 20 %, as many loud windows within a third)', then.top,
          then.p2 && then.run && then.top > LOUD && Math.abs(then.top - now.top) <= 0.2 * now.top && Math.abs(then.loud - now.loud) <= Math.max(3, now.loud / 3),
          `from the bank: P02 ${then.p2}, running ${then.run}, peak ${then.top}, ${then.loud} loud windows; today's: P02 ${now.p2}, peak ${now.top}, ${now.loud}`);
      } finally {
        await page().evaluate((n) => window.__m1test.eraseSlot(n), slot).catch((e) => console.log(`  note: slot ${slot + 1} not emptied: ${e.message}`));
        await live(true);
      }
    },

    // ---- 7. the FM-1 teaches itself (#582, D-247, D-917), steps 7.1..7.3, with Live off as on the page
    async checkTeach() {
      const running = async () => (await T()).deviceRunning;   // (the FM-1's MIDI Start / Stop, which the editor hears with Live off too)
      /** REC held alone a moment: the bar's ARM: hint; then, REC still held, the black key `pick(hint)` chooses (a black key
       *  with REC held arms, and REC's release then starts nothing: REC let go alone would start recording) */
      const recHeld = async (pick) => {
        await emu.key(B.rec, true);
        await emu.elapse(800);
        const hint = (await emu.texts()).find((t) => t.startsWith('ARM:')) ?? '';
        await emu.tap(BLACK[pick(hint)]);
        await emu.elapse(200);
        await emu.key(B.rec, false);
        await emu.elapse(600);
        return hint;
      };
      const parse = (hint) => /^ARM: 1 DRUMS(\*?) 2 PATTERN(\*?)$/.exec(hint);
      try {
        await check('7 teach: Live off', await live(false));
        await emu.elapse(1000);
        // PRESET a click at a time: the message shows once <7PH has loaded
        let at = false, said = false;
        for (let i = 0; i < 65 && !at; i++) {
          await presetPatch(1);
          at = await emu.waitFor(async () => (await emu.texts()).some((t) => /<7PH/.test(t)), 600);
          if (at) said = await emu.waitText('2 SOUNDS: ENV THEN SEL', 1500);
        }
        await check('7.1 teach: HOME held + PRESET to <7PH: the bar says 2 SOUNDS: ENV THEN SEL', at && said, (await emu.texts()).slice(0, 3).join(' | '));
        await emu.elapse(2200);
        // (a patch PRESET loads has nothing armed: the first hint marks none, and black key 1 arms DRUMS first, so the next
        // REC held finds one armed, as on the page)
        let m = null;
        let hint = await recHeld((x) => { m = parse(x); return m && m[1] ? 1 : 0; });
        await check('7.2 teach: REC held alone a moment: ARM: 1 DRUMS 2 PATTERN, a * after each armed one', !!m, `"${hint}"`);
        let first = true;
        if (m && !m[1] && !m[2]) {
          await emu.elapse(1500);
          hint = await recHeld((x) => { m = parse(x); return 1; });
          first = false;
          await check('7.2 teach: REC held again: DRUMS (black key 1 armed it) has its *', !!m && m[1] === '*' && !m[2], `"${hint}"`);
        }
        const info = (await emu.texts()).find((t) => /^ARM \w+ \+1$/.test(t)) ?? '';
        await check(`7.2 teach: still holding REC, the black key of the one not armed${first ? '' : ' (PATTERN)'}, then let go: it records nothing (the transport stays stopped), the info line reads ARM .. +1`,
          !!info && !(await running()), `"${info}"; ${(await running()) ? 'running' : 'stopped'}`);
        await emu.elapse(1500);
        await emu.key(B.play, true);
        await emu.elapse(800);
        const tempo = (await emu.texts()).find((t) => /^TEMPO \d+: TURN PRESET$/.test(t)) ?? '';
        await emu.turn(ENC.preset, 1);
        await emu.elapse(300);
        await emu.turn(ENC.preset, -1);
        await emu.elapse(300);
        await emu.key(B.play, false);
        await emu.elapse(600);
        await check('7.3 teach: PLAY held alone a moment: TEMPO n: TURN PRESET; PRESET right and back, let go: the transport does not start',
          !!tempo && !(await running()), `"${tempo}"; ${(await running()) ? 'running' : 'stopped'}`);
      } finally {
        for (const k of [B.rec, B.play]) await emu.key(k, false);
        if ((await T()).deviceRunning) await emu.tap(B.play);
        await live(true);
      }
    },

    // ---- 8. dual core (#271, D-380), steps 8.1, 8.2, 8.4 (playing them by hand for a minute and the boot are the owner's)
    async checkDualCore() {
      await check('8.1 dual core: GLO, ALGO to INFO: PROCESSOR reads 2 CORES', (await menuTab('PROCESSOR')) && (await emu.shows('2 CORES')), (await emu.texts()).filter((t) => /CORE/.test(t)).join(' '));
      await menuClose();
      /** the INFO tab's CPU row (the % after the label CPU, on its line) */
      const cpuRow = async () => {
        const s = await emu.screen();
        const lab = s.texts.find((t) => t.s === 'CPU');
        const v = lab && s.texts.find((t) => t !== lab && Math.abs(t.y - lab.y) <= 3 && /^\d+%$/.test(t.s));
        return v ? Number(v.s.slice(0, -1)) : null;
      };
      const CHORDS = [0, 4, 7, 11, 12, 16, 19, 23].map((n) => 14 + n);   // two 4-note chords, F3 and F4 major sevenths
      for (const name of ['Io 4', 'Hera 6', 'Cassia 1']) {
        await opens(name, `8.${name === 'Io 4' ? 2 : 4} dual core: ${name} opens, synced`);
        await menuTab('PROCESSOR');
        await emu.diagWords(119);                       // (zeroes the guard's windows)
        const [half0, , late0] = await emu.diagWords(119);
        // the CPU row read with the keys held 2.5 s and no recording (the rig streams USB audio only while one runs, which
        // costs it more), then 2 s recorded with them still held, and let go
        for (const k of CHORDS) { await emu.key(k, true); await emu.elapse(30); }
        await emu.elapse(2500);
        const cpu = await cpuRow(), cpuWhy = cpu === null ? (await emu.texts()).join(' | ') : '';
        const a = await recorded(`dual-${name.replace(/\W+/g, '-')}`, async () => {
          await emu.elapse(2000);
          for (const k of CHORDS) await emu.key(k, false);
          await emu.elapse(300);
        });
        for (const k of CHORDS) await emu.key(k, false);
        const [half1, , late1, , , , shed] = await emu.diagWords(119);
        const d127 = await emu.diagWords(127);
        await menuClose();
        const loud = a.why ? 0 : Math.max(rmsOf(a.l), rmsOf(a.r));
        const gaps = a.why ? [] : dropouts(a);
        const step = name === 'Io 4' ? '8.2' : '8.4';
        await heard(`${step} dual core: ${name}, 8 keys held: it sounds, no dropout in the recording`, a, loud > FLOOR && gaps.length === 0,
          `RMS ${db(loud)} dB, ${gaps.length} dropouts${gaps.length ? ` (${gaps.slice(0, 4).map((g) => `${g[1]} ms at ${g[0]}`).join(', ')})` : ''}`);
        await check(`${step} dual core: ${name}, 8 keys held: nothing shed, no overload (DIAG 119 / 127)`, shed === 0 && d127[3] === 0 && d127[7] === 0,
          `shed ${shed}, overload ${d127[3]}, late halves ${late1 - late0} of ${half1 - half0}`);
        if (REAL) await check(`${step} dual core: ${name}, 8 keys held: the INFO tab's CPU row well under 80 %`, cpu !== null && cpu < 80, `CPU ${cpu} %`);
        else console.log(`  ${name}: the CPU row read ${cpu} % with 8 keys held (the emulator's timing is no measure: the rig checks it)${cpu === null ? `; the screen: ${cpuWhy}` : ''}`);
      }
      for (const name of ['Monolith D', 'Simple FM']) {
        await opens(name, `8.4 dual core: ${name} opens, synced`);
        const p = await emu.notePeak(C4, 500);
        await loudCheck(`8.4 dual core: ${name} (no poly: the second core idles) sounds`, p, p > LOUD, `peak ${p}`);
      }
    },
  };
}
