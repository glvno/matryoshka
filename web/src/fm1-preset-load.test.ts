// SPDX-License-Identifier: GPL-3.0-only
// A preset loaded on the FM-1 (PRESET on a device page: pages_ui.c dp_load, run here as the FM-1's UI in WebAssembly)
// must leave the patch as the editor's load of the same preset does (device-presets.ts applyPreset), for every factory
// preset of every factory patch's engines (#464). The FM-1's side reaches the patch as the editor's Emulator view takes
// it: each parameter the firmware says it set (Q16), through the editor's own rule for the parameters a row also sets.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { tiedTo } from './assembly';
import { applyPreset, presetsOf, stepPreset } from './device-presets';
import './factory-presets';
import { ENCODERS, Fm1Ui } from './fm1-ui';
import { DEFS } from './modules';
import { devicesOf } from './pages';
import { topOf, type Patch } from './patch';
import { encodePatch, POLY_ROW, POLY_ROW_PARAMS } from './patchbin';
import { deviceView } from './poly';
import { FM1_PRESETS } from './presets';
import { buildFm1Wasm } from '../scripts/fm1-wasm.mjs';

const ROOT = resolve(__dirname, '../..');
const WASM = resolve(ROOT, 'web/public/fm1-ui.wasm');
const SRC = ['firmware/wasm/fm1_ui.c', 'firmware/test/host_ui.h', 'firmware/src/panel.c', 'firmware/src/poly_edit.h', 'firmware/src/pages_ui.c', 'firmware/src/seq_ui.c', 'firmware/src/ui.c', 'firmware/src/engine.c', 'firmware/src/presets.h', 'firmware/src/defs.h'];

let bytes: Uint8Array<ArrayBuffer>;
beforeAll(() => {
  const stale = !existsSync(WASM) || SRC.some((f) => statSync(resolve(ROOT, f)).mtimeMs > statSync(WASM).mtimeMs);
  if (stale) buildFm1Wasm(WASM);
  bytes = new Uint8Array(readFileSync(WASM));
}, 120_000);

/** a parameter the FM-1 set, into the patch as the editor's Emulator view sets it (main.ts fm1Event, editor.setParam and
 * its mirror into the parameters the row also sets) */
function take(p: Patch, module: number, param: number, q16: number): void {
  const m = deviceView(p, true).patch.modules[module];
  const name = m && (param & POLY_ROW ? POLY_ROW_PARAMS[param & 0x7f] : DEFS[m.type]?.params[param]?.name);
  if (!m || !name) return;
  const v = param & POLY_ROW ? Math.round(q16 / 65536) : q16 / 65536;
  const own = p.modules.find((x) => x.id === m.id);
  if (!own) return;
  own.params[name] = v;
  for (const t of tiedTo(p, m.id, name).slice(1)) {
    const tm = p.modules.find((x) => x.id === t.module);
    const pd = tm && DEFS[tm.type].params.find((q) => q.name === t.param);
    if (tm && pd) tm.params[t.param] = Math.min(topOf(pd), Math.max(pd.min, v));
  }
}

/** every parameter of the patch's modules, by module id and name */
const values = (p: Patch): Map<string, number> => new Map(p.modules.flatMap((m) => Object.entries(m.params).map(([k, v]) => [`${m.id}.${k}`, v as number] as [string, number])));
/** Q16's step, and a little more for a value the firmware rounds once more (a whole-number row, a Selector) */
const near = (a: number, b: number): boolean => Math.abs(a - b) <= 1.5 / 65536 * Math.max(1, Math.abs(b) / 1024);

describe('a preset loaded on the FM-1 (#464)', () => {
  for (const [patchName, make] of Object.entries(FM1_PRESETS)) {
    const probe = make();
    const engines = devicesOf(probe, DEFS).map((d, i) => ({ d, i })).filter(({ d }) => d.asm !== undefined)
      .filter(({ d }) => presetsOf(probe, probe.assemblies!.find((a) => a.id === d.asm)!).some((x) => x.factory));
    for (const { d, i } of engines) {
      it(`${patchName}: ${d.name} sets every row and every tied parameter as the editor does`, async () => {
        const fw = make();
        const ed = make();
        const ui = await Fm1Ui.create(bytes, { param: (m, q, v) => take(fw, m, q, v) });
        expect(ui.load(encodePatch(fw), patchName.toUpperCase())).toBe(0);
        ui.focus(i, 0);
        expect(ui.focusDevice).toBe(i);
        const asm = ed.assemblies!.find((a) => a.id === d.asm)!;
        const list = presetsOf(ed, asm);
        const diffs: string[] = [];
        for (let k = 0; k < list.length; k++) {
          const pr = stepPreset(ed, asm, 1)!;
          applyPreset(ed, asm, pr);
          ui.tick(1000 + 50 * k);
          ui.encoder(ENCODERS.preset, 1);
          const want = values(ed), got = values(fw);
          for (const [key, v] of want) {
            const g = got.get(key);
            if (g === undefined || !near(g, v)) diffs.push(`${pr.name}: ${key} FM-1 ${g} editor ${v}`);
          }
        }
        expect(list.length).toBeGreaterThan(1);
        expect(diffs).toEqual([]);
      }, 60_000);
    }
  }
});
