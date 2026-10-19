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
import { PRESETS } from './presets';
import { buildFm1Wasm } from '../scripts/fm1-wasm.mjs';

const ROOT = resolve(__dirname, '../..');
const WASM = resolve(ROOT, 'web/public/fm1-ui.wasm');
const SRC = ['firmware/wasm/fm1_ui.c', 'firmware/test/host_ui.h', 'firmware/src/panel.c', 'firmware/src/pages_ui.c', 'firmware/src/ui.c', 'firmware/src/engine.c', 'firmware/src/presets.h'];

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
  it('draws a device page pixel for pixel as the host preview of the same firmware', async () => {
    const ui = await Fm1Ui.create(bytes);
    const name = Object.keys(PRESETS)[0];
    expect(ui.load(encodePatch(PRESETS[name]()), name.toUpperCase(), { slot: 0 })).toBe(0);
    ui.focus(0, 4);
    const rgba = ui.rgba();
    const want = preview(['0', '0:4', '0']);
    let off = 0;
    for (let i = 0; i < 240 * 240; i++)
      if (rgba[4 * i] !== want[3 * i] || rgba[4 * i + 1] !== want[3 * i + 1] || rgba[4 * i + 2] !== want[3 * i + 2]) off++;
    expect(off).toBe(0);
  }, 120_000);

  it('the panel drives it: SELECT / ALGO move the focus (and say so), K1 sets a parameter, HOME goes back along the trail', async () => {
    const focus: [number, number][] = [];
    const params: number[][] = [];
    const ui = await Fm1Ui.create(bytes, { focus: (d, g) => focus.push([d, g]), param: (m, p, v) => params.push([m, p, v]) });
    const kit = Object.keys(PRESETS).find((n) => /808/.test(n))!;
    expect(ui.load(encodePatch(PRESETS[kit]()), '808 KIT')).toBe(0);
    ui.tick(10_000);
    ui.encoder(ENCODERS.select, 1);
    ui.encoder(ENCODERS.algo, 1);
    expect([ui.focusDevice, ui.focusPage]).toEqual([1, 1]);
    expect(focus.at(-1)).toEqual([1, 1]);
    ui.takeDirty();
    ui.encoder(ENCODERS.k1, 3);
    expect(params.length).toBe(1);
    expect(ui.takeDirty()).toBe(true);
    ui.tick(12_000);
    const tap = (id: number, at: number): void => { ui.tick(at); ui.button(id, true); ui.tick(at + 50); ui.button(id, false); ui.tick(at + 100); };
    tap(BUTTONS.home, 12_000);                 // nothing to go back to: the page stays
    expect([ui.page, ui.focusDevice, ui.focusPage]).toEqual([0, 1, 1]);
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
});
