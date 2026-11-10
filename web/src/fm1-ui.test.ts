import { addModule, connect } from './patch';
// SPDX-License-Identifier: GPL-3.0-only
// The FM-1's UI as WebAssembly (fm1-ui.ts, firmware/wasm/fm1_ui.c) against the host preview of the same firmware
// (tools/ui_preview.sh): the same patch and page must give the same framebuffer, and the panel must drive it.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { BUTTONS, ENCODERS, Fm1Ui } from './fm1-ui';
import { encodePatch } from './patchbin';
import { deviceView } from './poly';
import { PROFILES } from './fm1-profiles';
import { FM1_PRESETS } from './presets';
import { DEFS } from './modules';
import { devicesOf } from './pages';
import { buildFm1Wasm } from '../scripts/fm1-wasm.mjs';
import { panelOffBy } from './protocol';

const ROOT = resolve(__dirname, '../..');
const WASM = resolve(ROOT, 'web/public/fm1-ui.wasm');
const SRC = ['firmware/wasm/fm1_ui.c', 'firmware/test/host_ui.h', 'firmware/src/panel.c', 'firmware/src/poly_edit.h', 'firmware/src/pages_ui.c', 'firmware/src/seq_ui.c', 'firmware/src/ui.c', 'firmware/src/engine.c', 'firmware/src/presets.h', 'firmware/src/help_ui.c'];

/** the preview's framebuffer (RGB565 from its PPM's 8-bit channels, as it wrote them) */
function preview(args: string[]): Uint8Array {
  execFileSync(resolve(ROOT, 'tools/ui_preview.sh'), [resolve(tmpdir(), 'fm1-ui-test.png'), ...args], { cwd: ROOT, stdio: 'pipe' });
  const ppm = readFileSync(resolve(ROOT, 'build/ui_preview.ppm'));
  return ppm.subarray(ppm.length - 240 * 240 * 3);
}

let bytes: Uint8Array<ArrayBuffer>;
beforeAll(() => {
  const stale = !existsSync(WASM) || SRC.some((f) => statSync(resolve(ROOT, f)).mtimeMs > statSync(WASM).mtimeMs);
  if (stale) buildFm1Wasm(WASM);
  bytes = new Uint8Array(readFileSync(WASM));
}, 120_000);

describe('the FM-1 UI as WebAssembly', () => {
  it('keeps Cassia playable after rapid turns of its voices row, past its top', async () => {
    const patch = FM1_PRESETS['Cassia 1']();
    const values: number[] = [];
    const ui = await Fm1Ui.create(bytes, { param: (_m, p, v) => { if (p === 0x80) values.push(v); } });
    expect(ui.load(encodePatch(patch), 'CASSIA 1')).toBe(0);
    const devices = devicesOf(patch, DEFS);
    const d = devices.findIndex(d => d.pages.some(p => p.rows.some(r => r.param === 'voices')));
    expect(d).toBeGreaterThanOrEqual(0);
    const p = devices[d].pages.findIndex(p => p.rows.some(r => r.param === 'voices'));
    const k = devices[d].pages[p].rows.findIndex(r => r.param === 'voices');
    ui.focus(d, p);
    for (let i = 0; i < 20; i++) {
      ui.tick(1000 + i * 10);
      ui.encoder(ENCODERS.k1 + k, 5);
    }
    // (#649: the memory holds Cassia's eight voices; the voices row's top is four, what the CPU estimate holds with the
    // CZ-1 functions of #658 under the 90 % bar (D-870) since #781, and where it starts: the row's top in the binary,
    // gen-presets voiceTops)
    expect([...new Set(values)]).toEqual([4].map((v) => v << 16));
    for (let i = 0; i < 4; i++) ui.encoder(ENCODERS.k1 + k, -5);   /* (one step a turn: 3, 2, 1, then held at 1) */
    expect(values.slice(-2)).toEqual([1 << 16, 1 << 16]);
  }, 30_000);

  it('draws a device page pixel for pixel as the host preview of the same firmware', async () => {
    const ui = await Fm1Ui.create(bytes);
    const name = Object.keys(FM1_PRESETS)[0];
    expect(ui.load(encodePatch(FM1_PRESETS[name]()), name.toUpperCase(), { slot: 0 })).toBe(0);
    ui.focus(1, 4); // (device 0 is Main: #196)
    const rgba = ui.rgba();
    const want = preview(['0', '1:4', '0']);
    let off = 0;
    for (let i = 0; i < 240 * 240; i++)
      if (rgba[4 * i] !== want[3 * i] || rgba[4 * i + 1] !== want[3 * i + 1] || rgba[4 * i + 2] !== want[3 * i + 2]) off++;
    expect(off).toBe(0);
  }, 120_000);

  it('a track muted on the FM-1 it follows blinks its black key; SEQ held there does not switch the page on its release', async () => {
    const ui = await Fm1Ui.create(bytes);
    const patch = FM1_PRESETS['808 Kit']();
    const track = deviceView(patch, true).patch.modules.findIndex((m) => m.type === 'steps');
    expect(ui.load(encodePatch(patch), '808 KIT')).toBe(0);
    ui.tick(1000);
    const home = ui.page;
    ui.button(BUTTONS.seq, true);   // (the FM-1's SEQ held, mirrored; its black key mutes the track there: MUTE_NOW)
    ui.mute(track, true);
    ui.button(BUTTONS.seq, false);
    ui.tick(1100);
    expect(ui.page).toBe(home);
    ui.button(BUTTONS.seq, true);   // the SEQ page: its roll's selected row is on a black key (#387)
    ui.button(BUTTONS.seq, false);
    expect(ui.page).not.toBe(home);
    const BLACK = [1, 3, 5, 8, 10, 13, 15, 17, 20, 22, 25].reduce((m, n) => m | 1 << n, 0);
    const key = (ms: number): number => { ui.tick(ms); return ui.lights().keys.lit & BLACK; };
    const [a, b] = [key(2000), key(2200)];
    const row = a | b;
    expect(Math.min(a, b)).toBe(0);                          // muted: the selected row's key blinks (200 ms)
    expect(row && !(row & row - 1)).toBeTruthy();            // (one key)
    ui.mute(track, false);
    expect([key(2400), key(2600)]).toEqual([row, row]);      // playing: steady
  }, 120_000);
  it('step record (#532): REC held + a white key, a chord, a tie of the key still held, a rest; the editor gets the notes', async () => {
    let notes: { at: number; len: number; note: number; vel: number }[] = [];
    const ui = await Fm1Ui.create(bytes, { track: (_m, ns) => { notes = ns.map(({ at, len, note, vel }) => ({ at, len, note, vel })); } });
    expect(ui.load(encodePatch(FM1_PRESETS['Silver Box']()), 'SILVER BOX')).toBe(0);
    ui.tick(1000);
    const tap = (id: number, at: number): void => { ui.tick(at); ui.button(id, true); ui.tick(at + 50); ui.button(id, false); ui.tick(at + 100); };
    tap(BUTTONS.seq, 1200);                       // the SEQ page: PATTERN's roll
    expect(ui.page).toBe(8);
    const [STEP1, C4, E4, G4, D4] = [0, 7, 11, 14, 9].map((n) => 1 << n);
    ui.button(BUTTONS.rec, true);                 // REC held + step 1's white key: step record there (D-804)
    ui.keys(STEP1);
    ui.button(BUTTONS.rec, false);                // (REC's release then does nothing)
    ui.keys(0);
    expect(notes).toEqual([]);                    // (started: nothing written, step 1 not switched)
    const played = ui.keys(C4 | E4 | G4);         // a chord: each key sounds as it goes down
    expect(played.filter((p) => p.on).length).toBe(3);
    ui.keys(C4);                                  // E4, G4 let go; C4 held
    tap(BUTTONS.lfo, 1500);                       // the tie: C4 on through step 2, the cursor there
    ui.keys(C4 | D4);                             // D4 added on step 2
    ui.keys(C4);
    ui.keys(0);                                   // the last key let go: written, the cursor on step 3
    tap(BUTTONS.lfo, 1800);                       // a rest on step 3
    ui.keys(E4);
    ui.keys(0);                                   // E4 on step 4
    const sorted = [...notes].sort((a, b) => a.at - b.at || a.note - b.note);
    expect(sorted).toEqual([
      { at: 0, len: 2, note: 60, vel: 100 }, { at: 0, len: 1, note: 64, vel: 100 }, { at: 0, len: 1, note: 67, vel: 100 },
      { at: 1, len: 1, note: 62, vel: 100 }, { at: 3, len: 1, note: 64, vel: 100 },
    ]);
    tap(BUTTONS.home, 2000);                      // HOME: step record ends, the page stays
    expect(ui.page).toBe(8);
    tap(BUTTONS.rec, 2200);                       // REC tapped, stopped: step record again, on the page's first step (1),
    ui.keys(G4);                                  // not the cursor's last (5): G4 replaces step 1's chord
    ui.keys(0);
    expect(notes.filter((n) => n.at === 0)).toEqual([{ at: 0, len: 1, note: 67, vel: 100 }]);
    expect(notes.some((n) => n.at === 4)).toBe(false);
    tap(BUTTONS.rec, 2400);                       // REC again: it ends
    ui.keys(G4);
    ui.keys(0);
    expect(notes.length).toBe(3);                 // playing after step record leaves the pattern unchanged
  }, 30_000);
  it.each([true, false])('captures a Side chord after Harmonizer with preview %s', async preview => {
    const patch = FM1_PRESETS['Silver Box']();
    const main = patch.modules.find(m => m.type === 'fm1')!;
    const track = patch.modules.find(m => m.type === 'steps')!;
    delete track.notes;
    const h = addModule(patch, DEFS.harm, 0, 0);
    h.params.type = 1;
    patch.cables = patch.cables.filter(c => !(c.to.module === track.id && c.to.port === 'keys'));
    expect(connect(patch, DEFS, { module: main.id, port: 'keys' }, { module: h.id, port: 'keys' })).toBe(true);
    expect(connect(patch, DEFS, { module: h.id, port: 'keys' }, { module: track.id, port: 'keys' })).toBe(true);
    let notes: { at: number; note: number }[] = [];
    const ui = await Fm1Ui.create(bytes, { track: (_id, n) => { notes = n; } });
    expect(ui.load(encodePatch(patch), 'HARM CAPTURE')).toBe(0); ui.tick(1000);
    let time = 1000;
    const button = (id: number, down: boolean) => { ui.tick(time += 60); return ui.button(id, down); };
    const tap = (id: number) => { button(id, true); button(id, false); };
    tap(BUTTONS.seq); tap(BUTTONS.rec);
    if (!preview) { button(BUTTONS.scl, true); tap(BUTTONS.fx); button(BUTTONS.scl, false); }
    const control = ui.keys(1 << 3);
    expect(control).toEqual([expect.objectContaining({ kind: 3, note: 3, on: true })]);
    const played = ui.keys((1 << 3) | (1 << 7));
    expect(played.filter(p => p.on).map(p => p.note)).toEqual(preview ? [60,63,67] : []);
    expect(played.every(p => p.kind === 1)).toBe(true); // direct track audition, never harmonized twice
    ui.keys(1 << 7); expect(notes).toEqual([]); // a control release never commits
    ui.keys(0);
    expect(notes.map(n => [n.at,n.note])).toEqual([[0,60],[0,63],[0,67]]);
  });

  it('piano keys play outside recording; step preview can be silent and recover a missed toggle', async () => {
    let notes: { at: number; len: number; note: number; vel: number }[] = [];
    const patch = FM1_PRESETS['Silver Box']();
    const ui = await Fm1Ui.create(bytes, { track: (_m, n) => { notes = n; } });
    const copy = await Fm1Ui.create(bytes);
    for (const u of [ui, copy]) { expect(u.load(encodePatch(patch), 'SILVER BOX')).toBe(0); u.tick(1000); }
    let time = 1000;
    const button = (id: number, down: boolean) => { ui.tick(time += 60); return ui.button(id, down); };
    const tap = (id: number) => { button(id, true); button(id, false); };
    tap(BUTTONS.seq);
    for (let key = 0; key < 27; key++) {
      expect(ui.keys(1 << key)).toEqual([{ note: 53 + key, vel: Math.floor(100 * 65536 / 127), on: true }]);
      expect(ui.keys(0)).toEqual([{ note: 53 + key, vel: 0, on: false }]);
    }
    expect(notes).toEqual([]);
    tap(BUTTONS.rec);
    expect(ui.guide()!.stepRecord).toBe(true);
    expect(ui.keys(1 << 7).some(p => p.note === 60 && p.on)).toBe(true);
    button(BUTTONS.scl, true);
    expect(button(BUTTONS.fx, true)).toEqual([expect.objectContaining({ note: 60, vel: 0, on: false, kind: 1 })]);
    button(BUTTONS.fx, false);
    button(BUTTONS.scl, false);
    expect(ui.keys(0)).toEqual([]);
    expect(notes).toEqual([{ at: 0, len: 1, note: 60, vel: 100 }]);
    expect(ui.keys((1 << 11) | (1 << 14))).toEqual([]);
    expect(ui.keys(0)).toEqual([]);
    expect(notes).toEqual([{ at: 0, len: 1, note: 60, vel: 100 }, { at: 1, len: 1, note: 64, vel: 100 }, { at: 1, len: 1, note: 67, vel: 100 }]);
    expect(panelOffBy(copy.guide()!, ui.guide()!)).toContain('note preview');
    copy.align(ui.guide()!);
    expect(panelOffBy(copy.guide()!, ui.guide()!)).toEqual([]);
    expect(copy.keys(1 << 9)).toEqual([]);
    copy.keys(0);
    button(BUTTONS.scl, true); tap(BUTTONS.fx); button(BUTTONS.scl, false);
    expect(ui.keys(1 << 9).some(p => p.note === 62 && p.on)).toBe(true);
    ui.keys(0);
    tap(BUTTONS.rec);
    expect(ui.guide()!.stepRecord).toBe(false);
    const recorded = [...notes];
    ui.keys(1 << 4); ui.keys(0);
    expect(notes).toEqual(recorded);
  }, 30_000);

  it('#549: a copy that replays the FM-1\'s buttons and keys stays where the FM-1 is; one that gets no keys is put back by its state', async () => {
    // the FM-1 (every input) and two copies of its panel logic following it: one given the buttons and the reported keys
    // (KEYS_NOW), one the buttons only (older firmware: the SEQ page's keys send no MIDI)
    const make = async (): Promise<Fm1Ui> => {
      const u = await Fm1Ui.create(bytes);
      expect(u.load(encodePatch(FM1_PRESETS['Silver Box']()), 'SILVER BOX')).toBe(0);
      u.tick(1000);
      return u;
    };
    const fm1 = await make(), keyed = await make(), plain = await make();
    let t = 1000;
    const all = [fm1, keyed, plain];
    const button = (id: number, down: boolean): void => { t += 60; for (const u of all) { u.tick(t); u.button(id, down); } };
    const keys = (bits: number): void => { t += 60; for (const u of [fm1, keyed]) { u.tick(t); u.keys(bits); } };
    const tap = (id: number): void => { button(id, true); button(id, false); };
    const off = (u: Fm1Ui): string[] => panelOffBy(u.guide()!, fm1.guide()!);
    tap(BUTTONS.seq);                               // the SEQ page: PATTERN's roll
    expect(fm1.page).toBe(8);
    button(BUTTONS.scl, true);                      // SEL held + a key: the pen (the view moves), SEL's release opens nothing
    keys(1 << 0);
    keys(0);
    button(BUTTONS.scl, false);
    expect(fm1.page).toBe(8);
    expect(off(keyed)).toEqual([]);
    expect(off(plain)).toEqual(['page']);           // (it took SEL as tapped: the SONG page)
    plain.align(fm1.guide()!);
    expect(off(plain)).toEqual([]);
    button(BUTTONS.rec, true);                      // REC held + step 3's white key: step record from step 3
    keys(1 << 4);
    button(BUTTONS.rec, false);
    keys(0);
    expect(fm1.guide()!.stepRecord && fm1.guide()!.cursor === 2).toBe(true);
    expect(off(keyed)).toEqual([]);
    expect(off(plain)).toContain('step record');
    plain.align(fm1.guide()!);
    expect(off(plain)).toEqual([]);
    tap(BUTTONS.rec);                               // REC: step record ends on all three
    expect(off(keyed)).toEqual([]);
    expect(off(plain)).toEqual([]);
    expect(fm1.guide()!.raw).toEqual(keyed.guide()!.raw);
  }, 30_000);

  it('P-locks (#524) on drums: a held step + ALGO + K1 locks the device\'s first row on it; the editor gets the locks', async () => {
    let got: { module: number; pat: number; locks: { at: number; module: number; param: number; value: number }[] } | null = null;
    const ui = await Fm1Ui.create(bytes, { locks: (module, pat, locks) => { got = { module, pat, locks }; } });
    expect(ui.load(encodePatch(FM1_PRESETS['808 Kit']()), '808 KIT')).toBe(0);
    ui.tick(1000);
    const tap = (id: number, at: number): void => { ui.tick(at); ui.button(id, true); ui.tick(at + 50); ui.button(id, false); ui.tick(at + 100); };
    tap(BUTTONS.seq, 1200);                       // the SEQ page: PATTERN's roll
    ui.keys(1 << 4);                              // step 3 held
    ui.encoder(1, 1);                             // ALGO: the Silver Box's first page
    ui.encoder(2, 2);                             // K1: its first row locked on step 3
    ui.keys(0);
    expect(got).not.toBeNull();
    expect(got!.pat).toBe(0);
    expect(got!.locks.length).toBe(1);
    expect(got!.locks[0].at).toBe(2);
  }, 30_000);
  it('the panel drives it: SELECT / ALGO move the focus (and say so), K1 sets a parameter, HOME goes to the device\'s first page, then back along the trail', async () => {
    const focus: [number, number][] = [];
    const params: number[][] = [];
    const ui = await Fm1Ui.create(bytes, { focus: (d, g) => focus.push([d, g]), param: (m, p, v) => params.push([m, p, v]) });
    const kit = Object.keys(FM1_PRESETS).find((n) => /808/.test(n))!;
    expect(ui.load(encodePatch(FM1_PRESETS[kit]()), '808 KIT')).toBe(0);
    ui.tick(10_000);
    expect([ui.focusDevice, ui.focusPage]).toEqual([2, 0]); // the home device (#196): the Drum map, after Main and the track
    ui.encoder(ENCODERS.algo, 1);
    ui.encoder(ENCODERS.select, 1);
    ui.encoder(ENCODERS.algo, 1);
    expect([ui.focusDevice, ui.focusPage]).toEqual([3, 1]); // (the 808 kit card: its snare drum page)
    ui.encoder(ENCODERS.select, -1);
    ui.encoder(ENCODERS.algo, 1);
    expect([ui.focusDevice, ui.focusPage]).toEqual([2, 1]);
    expect(focus.at(-1)).toEqual([2, 1]);
    ui.takeDirty();
    ui.encoder(ENCODERS.k1, 3);
    expect(params.length).toBe(1);
    expect(ui.takeDirty()).toBe(true);
    ui.tick(12_000);
    const tap = (id: number, at: number): void => { ui.tick(at); ui.button(id, true); ui.tick(at + 50); ui.button(id, false); ui.tick(at + 100); };
    tap(BUTTONS.home, 12_000);                 // HOME on a device's second page: its first page, the editor told (#391)
    expect([ui.page, ui.focusDevice, ui.focusPage]).toEqual([0, 2, 0]);
    expect(focus.at(-1)).toEqual([2, 0]);
    tap(BUTTONS.home, 12_300);                 // on the patch's home page: nothing
    expect([ui.page, ui.focusDevice, ui.focusPage]).toEqual([0, 2, 0]);
    tap(BUTTONS.seq, 13_000);                  // the SEQ page, HOME back
    expect(ui.page).toBe(8);
    tap(BUTTONS.home, 13_500);
    expect(ui.page).toBe(0);
    tap(BUTTONS.seq, 13_700);                  // the SEQ page: the kick's steps light their keys
    expect(ui.page).toBe(8);
    expect(ui.lights().keys.lit).not.toBe(0);
    expect(ui.lights().keys.lit & 1).toBe(1);  // (the kick on step 1: the first white key, F3)
    tap(BUTTONS.seq, 13_900);
    expect(ui.lights().buttons.lit & (1 << BUTTONS.play)).not.toBe(0);     // stopped: PLAY's red LED
    tap(BUTTONS.play, 14_000);
    expect(ui.lights().buttons.breath & (1 << BUTTONS.play)).not.toBe(0);  // running: the green one breathes
  }, 30_000);

  it('a Matryoshka FM-1\'s MIDI out, fed back through its profile, does what its panel did (#120)', async () => {
    const focus: [number, number][] = [];
    const ui = await Fm1Ui.create(bytes, { focus: (d, g) => focus.push([d, g]) });
    const kit = Object.keys(FM1_PRESETS).find((n) => /808/.test(n))!;
    expect(ui.load(encodePatch(FM1_PRESETS[kit]()), '808 KIT')).toBe(0);
    let t = 10_000;
    // recorded from the panel: SELECT +1, ALGO +1 (CC 20 / 21), SEQ pressed and let go (CC 89), HOME pressed and let go (CC 87)
    const recorded = [[0xb0, 20, 1], [0xb0, 21, 1], [0xb0, 89, 127], [0xb0, 89, 0], [0xb0, 87, 127], [0xb0, 87, 0]];
    const pages: number[] = [];
    for (const m of recorded)
      for (const i of PROFILES.matryoshka.translate(m)) {
        ui.tick((t += 60));
        if (i.t === 'button') ui.button(i.id, i.down);
        else if (i.t === 'enc') ui.encoder(i.n, i.clicks);
        ui.tick((t += 60));
        pages.push(ui.page);
      }
    expect(focus).toEqual([[3, 0], [3, 1]]); // SELECT from the home device (2) to the 808 kit card, ALGO its next page
    expect(pages).toEqual([0, 0, 0, 8, 8, 0]);              // SEQ opens on its release, HOME goes back
  }, 30_000);
});
