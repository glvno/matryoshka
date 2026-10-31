// SPDX-License-Identifier: GPL-3.0-only
// The Emulator view's keys (emu-keys.ts) on the real firmware UI as WebAssembly (#467): the panel's keys sound what the
// FM-1 plays for them (D-520: black keys 1..8 play a Drum map's rows 1..8, also with `repeat` on, D-430), MIDI notes their
// own note number.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { EmuKeys, keyBits, type EmuPanel } from './emu-keys';
import { Fm1Ui } from './fm1-ui';
import { DRUM_MAP_DEFAULT, drumRowsOf } from './modules';
import { encodePatch } from './patchbin';
import { deviceView } from './poly';
import { FM1_PRESETS } from './presets';
import type { HostMsg } from './worklet';
import { buildFm1Wasm } from '../scripts/fm1-wasm.mjs';

const ROOT = resolve(__dirname, '../..');
const WASM = resolve(ROOT, 'web/public/fm1-ui.wasm');
const SRC = ['firmware/wasm/fm1_ui.c', 'firmware/test/host_ui.h', 'firmware/src/panel.c', 'firmware/src/pages_ui.c', 'firmware/src/seq_ui.c', 'firmware/src/ui.c', 'firmware/src/engine.c', 'firmware/src/presets.h'];

let bytes: Uint8Array<ArrayBuffer>;
beforeAll(() => {
  const stale = !existsSync(WASM) || SRC.some((f) => statSync(resolve(ROOT, f)).mtimeMs > statSync(WASM).mtimeMs);
  if (stale) buildFm1Wasm(WASM);
  bytes = new Uint8Array(readFileSync(WASM));
}, 120_000);

/** the Emulator view as EmuKeys sees it (fm1-view.ts Fm1View, without the DOM), on a factory patch */
async function panelOn(name: string): Promise<{ keys: EmuKeys; ui: Fm1Ui; rows: number[]; repeat: boolean }> {
  const patch = FM1_PRESETS[name]();
  const ui = await Fm1Ui.create(bytes);
  expect(ui.load(encodePatch(patch), name.toUpperCase())).toBe(0);
  const view: EmuPanel = { shown: true, ui, keys: (notes) => ui.keys(keyBits(notes, ui.octave)) };
  // (the Drum map the keys reach: the first in the FM-1's module order, poly.test.ts trackDrumMap)
  const map = deviceView(patch, true).patch.modules.find((m) => m.type === 'drummap')!;
  const rows = DRUM_MAP_DEFAULT.map((d, r) => Math.round(map.params[`n${r + 1}`] ?? d.note));
  return { keys: new EmuKeys(view), ui, rows, repeat: Math.round(map.params.repeat ?? 0) >= 1 };
}

/** black key b (0-based, from the lowest) of the 27 keys from F3: F#3 G#3 A#3 C#4 D#4 F#4 ... */
const BLACK = [1, 3, 5, 8, 10, 13, 15, 17, 20, 22, 25];
const on = (note: number): HostMsg => ({ t: 'on', note, vel: 0.8 });
const off = (note: number): HostMsg => ({ t: 'off', note });

describe('the Emulator view plays the keys as the FM-1 does (#467)', () => {
  for (const name of ['8 Lire', 'Elvira 2']) {
    it(`${name}: black keys 1..8 sound rows 1..8 at every octave, a MIDI note its own note`, async () => {
      const { keys, ui, rows, repeat } = await panelOn(name);
      expect(repeat, name).toBe(true);   // (the case of the issue: D-430's repeat would pick another row)
      for (const oct of [0, -2]) {
        while (ui.octave > oct) ui.button(0, true), ui.button(0, false);   // OCT-
        expect(ui.octave).toBe(oct);
        const base = 53 + 12 * oct;
        let differs = 0;
        for (let b = 0; b < 8; b++) {
          const note = base + BLACK[b];
          expect(keys.route(on(note), true), `${name} octave ${oct} black key ${b + 1}`).toEqual([{ t: 'on', note: rows[b], vel: 0.8 }]);
          expect(keys.route(off(note), true)).toEqual([off(rows[b])]);
          // (the key's own note, as the browser engine played it before: the repeat's row, often another one)
          if (!(drumRowsOf(rows, note) >> b & 1)) differs++;
        }
        expect(differs, `${name} octave ${oct}`).toBeGreaterThan(0);
      }
      // a MIDI note (not the panel's keys) plays its own note number (D-520), on the keybed or not
      const midi = 53 + 12 * ui.octave + BLACK[0];
      expect(keys.route(on(midi))).toEqual([on(midi)]);
      expect(keys.route(off(midi))).toEqual([off(midi)]);
    }, 30_000);
  }

  it('a white key plays its own note on a repeating Drum map; a key off the keybed and other messages pass as they are', async () => {
    const { keys, ui } = await panelOn('8 Lire');
    const white = 53 + 12 * ui.octave;   // F3
    expect(keys.route(on(white), true)).toEqual([on(white)]);
    expect(keys.route(off(white), true)).toEqual([off(white)]);
    const below = white - 1;
    expect(keys.route(on(below), true)).toEqual([on(below)]);
    expect(keys.route(off(below), true)).toEqual([off(below)]);
    const bend: HostMsg = { t: 'bend', v: 0.5 };
    expect(keys.route(bend, true)).toEqual([bend]);
  }, 30_000);

  it('plays a key as it is while the view is hidden', async () => {
    const ui = await Fm1Ui.create(bytes);
    let shown = false;
    const keys = new EmuKeys({ get shown() { return shown; }, ui, keys: (n) => ui.keys(keyBits(n, ui.octave)) });
    expect(keys.route(on(54), true)).toEqual([on(54)]);
    shown = true;
    expect(keys.route(on(56), true).length).toBe(1);
    shown = false;
    expect(keys.route(off(56), true).length).toBe(1);   // (held when the view was left: still let go, so it ends)
  }, 30_000);
});
