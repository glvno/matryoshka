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

const ROOT = resolve(__dirname, '../..');
const WASM = resolve(ROOT, 'web/public/fm1-ui.wasm');
const SRC = ['firmware/wasm/fm1_ui.c', 'firmware/test/host_ui.h', 'firmware/src/panel.c', 'firmware/src/poly_edit.h', 'firmware/src/pages_ui.c', 'firmware/src/ui.c', 'firmware/src/engine.c', 'firmware/src/presets.h'];

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
  it('keeps Cassia playable after rapid turns request more voices than fit, without sending rejected values', async () => {
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
    expect(values).toEqual([3 << 16, 4 << 16]);
    ui.encoder(ENCODERS.k1 + k, -5);
    ui.encoder(ENCODERS.k1 + k, -5);
    expect(values.slice(-2)).toEqual([3 << 16, 2 << 16]);
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
    const patch = FM1_PRESETS['Oracle V']();
    const track = deviceView(patch, true).patch.modules.findIndex((m) => m.type === 'steps');
    expect(ui.load(encodePatch(patch), 'ORACLE V')).toBe(0);
    ui.tick(1000);
    const home = ui.page;
    ui.button(BUTTONS.seq, true);   // (the FM-1's SEQ held, mirrored; its black key mutes the track there: MUTE_NOW)
    ui.mute(track, true);
    ui.button(BUTTONS.seq, false);
    ui.tick(1100);
    expect(ui.page).toBe(home);
    ui.button(BUTTONS.seq, true);   // the SEQ page: the first black key is the first track's
    ui.button(BUTTONS.seq, false);
    expect(ui.page).not.toBe(home);
    const key = (ms: number): number => { ui.tick(ms); return ui.lights().keys.lit >> 1 & 1; };
    expect([key(2000), key(2200)].sort()).toEqual([0, 1]);   // muted: it blinks (200 ms)
    ui.mute(track, false);
    expect([key(2400), key(2600)]).toEqual([1, 1]);          // the selected track, playing: steady
  }, 120_000);
  it('the panel drives it: SELECT / ALGO move the focus (and say so), K1 sets a parameter, HOME goes back along the trail', async () => {
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
    tap(BUTTONS.home, 12_000);                 // nothing to go back to: the page stays
    expect([ui.page, ui.focusDevice, ui.focusPage]).toEqual([0, 2, 1]);
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
