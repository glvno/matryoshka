// SPDX-License-Identifier: GPL-3.0-only
// #549 (D-482): the editor's copy of a followed FM-1's panel logic is compared with the FM-1's GUIDE_NOW only once the
// reports and inputs have settled. The FM-1 here is the panel logic as WebAssembly too, with its links' timing: a
// button's MIDI at once, KEYS_NOW at once, GUIDE_NOW after the page an input led to is drawn (REDRAW_MS).
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { BUTTONS, Fm1Ui } from './fm1-ui';
import { encodePatch } from './patchbin';
import { FM1_PRESETS } from './presets';
import { panelOffBy, type PanelState } from './protocol';
import { PanelAlign } from './panel-align';
import { buildFm1Wasm } from '../scripts/fm1-wasm.mjs';

const WASM = resolve(__dirname, '../public/fm1-ui.wasm');
let bytes: Uint8Array<ArrayBuffer>;
beforeAll(() => {
  if (!existsSync(WASM)) buildFm1Wasm(WASM);
  bytes = new Uint8Array(readFileSync(WASM));
}, 120_000);
afterEach(() => { vi.useRealTimers(); });

/** how long after an input that changed the page the FM-1's GUIDE_NOW for it comes (its loop draws the page first) */
const REDRAW_MS = 60;

/** the FM-1 and the editor's copy, wired as main.ts wires them; `inputs`: whether a panel input restarts the wait */
async function rig(name: string, inputs: boolean) {
  const make = async (): Promise<Fm1Ui> => {
    const u = await Fm1Ui.create(bytes);
    expect(u.load(encodePatch(FM1_PRESETS[name]()), name.toUpperCase())).toBe(0);
    return u;
  };
  const fm1 = await make(), copy = await make();
  const t0 = Date.now();
  const now = (): number => Date.now() - t0 + 1000;
  let fm1Panel: PanelState | null = null;
  const pages: number[] = [];
  const seen = (): void => { if (pages[pages.length - 1] !== copy.page) pages.push(copy.page); };
  const align = new PanelAlign(() => {
    copy.tick(now());
    if (fm1Panel && panelOffBy(copy.guide()!, fm1Panel).length) copy.align(fm1Panel);
    seen();
  });
  const settle = (): void => { if (inputs && fm1Panel) align.soon(); };
  // the FM-1's GUIDE_NOW: when its state changed (bytes 9 and 10 aside, as main.c guide_poll)
  const sig = (g: PanelState): string => g.raw.filter((_, i) => i !== 9 && i !== 10).join();
  let last = sig(fm1.guide()!);
  const report = (): void => {
    const g = fm1.guide()!;
    if (sig(g) === last) return;
    const paged = g.page !== JSON.parse(`[${last}]`)[1];
    last = sig(g);
    setTimeout(() => { fm1Panel = g; align.soon(); }, paged ? REDRAW_MS : 1);
  };
  let keys = 0;
  const button = (id: number, down: boolean): void => {
    fm1.tick(now());
    fm1.button(id, down);
    setTimeout(() => {                              // its MIDI (main.ts mirrorInput, fm1-view.ts drive)
      copy.tick(now());
      const h = copy.held;
      if (h === null || ((h >> id) & 1) !== (down ? 1 : 0)) copy.button(id, down);
      seen();
      settle();
    }, 1);
    report();
  };
  const key = (n: number, down: boolean): void => {
    fm1.tick(now());
    keys = down ? keys | 1 << n : keys & ~(1 << n);
    fm1.keys(keys);
    const [k, held] = [keys, fm1.held! & 0x3fff];
    setTimeout(() => {                              // KEYS_NOW (main.ts, fm1-view.ts keysNow)
      copy.tick(now());
      const was = (copy.held ?? 0) & 0x3fff;
      for (let id = 0; id < 14; id++) if (((was ^ held) >> id) & 1) copy.button(id, ((held >> id) & 1) === 1);
      copy.keys(k);
      seen();
      settle();
    }, 1);
    report();
  };
  return { fm1, copy, pages, button, key };
}

describe('the copy of a followed FM-1 compared with its GUIDE_NOW (#549)', () => {
  // the owner's 1.9.0 device check: 8 LIRE's drum grid, SEL held + a white key (a hit, not the pen), SEL let go about a
  // quarter of a second after the key: the SONG page on the FM-1, and the copy went SEQ, SONG, SEQ, SONG
  for (const inputs of [false, true]) {
    it(`8 LIRE, SEL + a white key, SEL let go just before the wait after the key's report ends (${inputs ? 'inputs restart the wait: SEQ, SONG' : 'reports alone: the copy flickers'})`, async () => {
      vi.useFakeTimers();
      const r = await rig('8 Lire', inputs);
      const at = async (ms: number, f: () => void): Promise<void> => { await vi.advanceTimersByTimeAsync(ms); f(); };
      await at(0, () => r.button(BUTTONS.seq, true));
      await at(100, () => r.button(BUTTONS.seq, false));
      await at(900, () => r.button(BUTTONS.scl, true));
      await at(300, () => r.key(0, true));
      await at(120, () => r.key(0, false));
      await at(250 - 20, () => r.button(BUTTONS.scl, false));   // (inside REDRAW_MS of the end of the key's wait)
      await vi.advanceTimersByTimeAsync(1000);
      expect(r.fm1.page).toBe(11);                    // the FM-1: the SONG page (a hit is not the pen, D-541)
      expect(r.copy.page).toBe(11);
      expect(r.pages.slice(1)).toEqual(inputs ? [8, 11] : [8, 11, 8, 11]);
    }, 30_000);
  }
  it('Silver Box\'s roll: SEL + a key (the pen) keeps both on the SEQ page', async () => {
    vi.useFakeTimers();
    const r = await rig('Silver Box', true);
    const at = async (ms: number, f: () => void): Promise<void> => { await vi.advanceTimersByTimeAsync(ms); f(); };
    await at(0, () => r.button(BUTTONS.seq, true));
    await at(100, () => r.button(BUTTONS.seq, false));
    await at(900, () => r.button(BUTTONS.scl, true));
    await at(300, () => r.key(0, true));
    await at(120, () => r.key(0, false));
    await at(230, () => r.button(BUTTONS.scl, false));
    await vi.advanceTimersByTimeAsync(1000);
    expect([r.fm1.page, r.copy.page]).toEqual([8, 8]);
    expect(r.pages.slice(1)).toEqual([8]);
  }, 30_000);
});
