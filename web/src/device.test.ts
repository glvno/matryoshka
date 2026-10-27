// SPDX-License-Identifier: GPL-3.0-only
// Connecting the FM-1 syncs by default (#171): the decision on connect and the chip's state; Live over the budget (#200).
import { describe, expect, it } from 'vitest';
import { chipState, liveSync, sandboxChip, SANDBOX_HOVER, sameBinary, syncLine, syncOnConnect, syncsWith, syncUpdateNotice, transportOf } from './device';
import { DEFS } from './modules';
import { addModule, connect, newPatch, removeModule } from './patch';
import { deviceBudget, encodePatch, VERSION } from './patchbin';
import { FM1_PRESETS } from './presets';
import { liveFrame, parse } from './protocol';
import { subtractiveSaw } from './test-patches';

const names = Object.keys(FM1_PRESETS);
const a = encodePatch(FM1_PRESETS[names[0]]());
const b = encodePatch(FM1_PRESETS[names[1]]());

describe('syncOnConnect', () => {
  it('syncs without asking when the FM-1 already holds the same patch', () => {
    expect(syncOnConnect({ fits: true, declined: false, editorBin: a, deviceBin: a.slice() })).toBe('sync');
  });
  it('asks when the FM-1 holds another patch, or when its patch cannot be read', () => {
    expect(syncOnConnect({ fits: true, declined: false, editorBin: a, deviceBin: b })).toBe('ask');
    expect(syncOnConnect({ fits: true, declined: false, editorBin: a, deviceBin: null })).toBe('ask');
  });
  it('does not ask again after Not now in this visit, and stays off', () => {
    expect(syncOnConnect({ fits: true, declined: true, editorBin: a, deviceBin: b })).toBe('off');
    expect(syncOnConnect({ fits: true, declined: true, editorBin: a, deviceBin: null })).toBe('off');
  });
  it('offers a sandbox patch too (Sync makes the FM-1 its controller), and never syncs it unasked', () => {
    expect(syncOnConnect({ fits: false, declined: false, editorBin: a, deviceBin: a })).toBe('ask');
    expect(syncOnConnect({ fits: false, declined: false, editorBin: new Uint8Array(), deviceBin: null })).toBe('ask');
    expect(syncOnConnect({ fits: false, declined: true, editorBin: a, deviceBin: null })).toBe('off');
  });
});

describe('sameBinary', () => {
  it('ignores the layout: moving cards does not change the binary', () => {
    const p = FM1_PRESETS[names[0]]();
    const q = structuredClone(p);
    for (const m of q.modules) { m.x += 40; m.y += 20; }
    expect(sameBinary(encodePatch(p), encodePatch(q))).toBe(true);
  });
  it('tells patches apart, and an unknown side is never the same', () => {
    expect(sameBinary(a, b)).toBe(false);
    expect(sameBinary(encodePatch(newPatch(DEFS)), null)).toBe(false);
  });
});

describe('chipState', () => {
  it('names each state', () => {
    expect(chipState(false, true, true)).toBe('not connected');
    expect(chipState(true, true, true)).toBe('synced');
    expect(chipState(true, false, true)).toBe('not synced');
    expect(chipState(true, false, false)).toBe('patch too big to sync');
    expect(chipState(true, true, false)).toBe('sandbox controller');
    expect(chipState(false, true, false)).toBe('not connected');
  });
});

describe('syncLine', () => {
  it('shows what the chip shows, with Sync or Stop syncing while connected (Sync on a sandbox patch: sandbox mode)', () => {
    expect(syncLine(chipState(true, true, true))).toEqual({ text: 'Synced with the FM-1', action: 'stop' });
    expect(syncLine(chipState(true, false, true))).toEqual({ text: 'Not synced', action: 'sync' });
    expect(syncLine(chipState(true, true, false))).toEqual({ text: 'Sandbox controller: the browser plays, the FM-1 drives it', action: 'stop' });
    expect(syncLine(chipState(true, false, false))).toEqual({ text: 'Sandbox patch, not synced: Sync makes the FM-1 its controller', action: 'sync' });
    expect(syncLine(chipState(false, true, true))).toEqual({ text: 'Not connected', action: null });
  });
});

describe('Live over the FM-1 budget (#200)', () => {
  // main.ts each LIVE_MS and on a budget change: the LIVE frame sayLive sends (null: none), and whether edits go out (live())
  const said = (connected: boolean, on: boolean, fits: boolean): number[] | null => {
    const f = liveSync.frame(connected, on, fits);
    return f && parse(liveFrame(f.paused))!.payload;
  };

  it('pauses Live while the patch is over the budget and resumes once it fits', () => {
    const p = subtractiveSaw();
    const out = p.modules.find((m) => m.type === 'output')!;
    const fits0 = deviceBudget(p).fits;
    expect(fits0).toBe(true);
    expect(said(true, true, fits0)).toEqual([]);                 // Live, the patch fits: plain LIVE, edits sent
    expect(liveSync.syncs(true, true, fits0)).toBe(true);
    const reverbs = [0, 1].map(() => {
      const r = addModule(p, DEFS.reverb, 0, 0);
      connect(p, DEFS, { module: r.id, port: 'out' }, { module: out.id, port: 'l' });
      return r.id;
    });
    const fits1 = deviceBudget(p).fits;                          // two reverbs: over the budget
    expect(fits1).toBe(false);
    expect(liveSync.pausesNow(true, true, fits0, fits1)).toBe(true); // the FM-1 is told at once
    expect(said(true, true, fits1)).toEqual([1]);                // and every LIVE_MS after: paused, PRESET still held
    expect(liveSync.syncs(true, true, fits1)).toBe(false);       // nothing is uploaded
    expect(chipState(true, true, fits1)).toBe('sandbox controller');   // sandbox mode: the FM-1 drives the browser's patch
    expect(liveSync.sandbox(true, true, fits1)).toBe(true);
    expect(liveSync.pausesNow(true, true, fits1, fits1)).toBe(false); // still over: no second at-once LIVE
    removeModule(p, reverbs[1]);
    const fits2 = deviceBudget(p).fits;                          // back under
    expect(fits2).toBe(true);
    expect(liveSync.pausesNow(true, true, fits1, fits2)).toBe(false);
    expect(said(true, true, fits2)).toEqual([]);                 // LIVE without paused: resumed
    expect(liveSync.syncs(true, true, fits2)).toBe(true);        // the edit's upload sends the patch again
    expect(chipState(true, true, fits2)).toBe('synced');
    expect(liveSync.sandbox(true, true, fits2)).toBe(false);     // sandbox mode ends
  });

  it('says nothing with Live off or not connected, over the budget or not', () => {
    for (const fits of [true, false]) {
      expect(said(true, false, fits)).toBeNull();
      expect(said(false, true, fits)).toBeNull();
      expect(liveSync.syncs(false, true, fits)).toBe(false);
    }
    expect(liveSync.pausesNow(true, false, true, false)).toBe(false);
    expect(liveSync.pausesNow(false, true, true, false)).toBe(false);
  });
});

describe('sandbox mode (the FM-1 as a sandbox patch\'s controller)', () => {
  it('is on only connected, with Live on and the patch over the budget', () => {
    expect(liveSync.sandbox(true, true, false)).toBe(true);
    expect(liveSync.sandbox(true, false, false)).toBe(false);
    expect(liveSync.sandbox(false, true, false)).toBe(false);
    expect(liveSync.sandbox(true, true, true)).toBe(false);
  });

  it('labels the chip SANDBOX CONTROLLER, and says how to turn MIDI OUT on when the FM-1 reports it off', () => {
    expect(sandboxChip({ hasSandbox: true, midiOut: true })).toEqual({ text: 'FM-1 \u00b7 SANDBOX CONTROLLER', title: SANDBOX_HOVER, midiOff: false });
    const off = sandboxChip({ hasSandbox: true, midiOut: false });
    expect(off.text).toBe('FM-1 \u00b7 turn on MIDI OUT (GLO, K3) to control the sandbox');
    expect(off.midiOff).toBe(true);
    expect(off.title.startsWith(SANDBOX_HOVER)).toBe(true);
  });

  it('keeps one transport: the editor\'s PLAY reaches the FM-1 in sandbox mode, and either one running runs both', () => {
    expect(liveSync.transports(true, true)).toBe(true);
    expect(liveSync.transports(true, false)).toBe(false);
    expect(liveSync.transports(false, true)).toBe(false);
    expect(liveSync.sandboxRuns(true, false)).toBe(true);   // (the FM-1's sequence was playing: the browser's goes on)
    expect(liveSync.sandboxRuns(false, true)).toBe(true);
    expect(liveSync.sandboxRuns(false, false)).toBe(false);
  });

  it('hears the FM-1\'s PLAY as MIDI Start / Continue / Stop', () => {
    expect(transportOf([0xfa])).toBe(true);
    expect(transportOf([0xfb])).toBe(true);
    expect(transportOf([0xfc])).toBe(false);
    expect(transportOf([0xf8])).toBe(null);
    expect(transportOf([0xb0, 89, 127])).toBe(null);
  });

  it('asks for the 1.3 firmware when the FM-1 has no sandbox mode (it keeps its sound)', () => {
    const old = sandboxChip({ hasSandbox: false, midiOut: null });
    expect(old.text).toBe('FM-1 \u00b7 SANDBOX CONTROLLER');
    expect(old.title).toBe(`${SANDBOX_HOVER} Update the FM-1 to 1.3 to mute it and show the page.`);
  });
});

describe('syncsWith', () => {
  const info = (features: number) => ({ version: 1, maxModules: 64, maxCables: 128, flashOk: true, patchLoaded: true, delays: 4, features, midiOut: null });
  it('holds back firmware that does not report support for current patch format: it refuses every patch the editor sends', () => {
    expect(syncsWith(info(246 | (63 << 8)))).toBe(false); // unreleased format 37 builds
    expect(syncsWith(info(246 | (127 << 8)))).toBe(false); // unreleased format 38 builds
    expect(syncsWith(info(54))).toBe(false);    // 1.0.0
    expect(syncsWith(info(118))).toBe(false);   // 1.1.0
    expect(syncsWith(info(246))).toBe(false);           // 1.2.0 (format 34)
    expect(syncsWith(info(246 | (31 << 8)))).toBe(false); // unreleased format 36 builds
    expect(syncsWith(info(246 | (15 << 8)))).toBe(false); // unreleased format 35 builds
    expect(syncsWith(info(246 | (7 << 8)))).toBe(false); // 1.3.0 .. 1.4 (format 34)
  });
  it('uses the reported inclusive range instead of the legacy feature bits', () => {
    const base = info(0);
    expect(syncsWith({ ...base, patchFormats: { min: 31, max: VERSION } })).toBe(true);
    expect(syncsWith({ ...base, patchFormats: { min: VERSION, max: VERSION } })).toBe(true);
    expect(syncsWith({ ...base, patchFormats: { min: 31, max: 200 } })).toBe(true);
    expect(syncsWith({ ...base, patchFormats: { min: 31, max: VERSION - 1 } })).toBe(false);
    const legacy = info(246 | (255 << 8));
    expect(syncsWith({ ...legacy, patchFormats: { min: 31, max: 38 } })).toBe(false);
    expect(syncsWith({ ...legacy, patchFormats: { min: VERSION + 1, max: 200 } })).toBe(false);
    expect(syncsWith({ ...legacy, patchFormats: { min: VERSION + 1, max: 38 } })).toBe(false);
  });
  it('offers the matching update when either side is too old', () => {
    const oldFirmware = { ...info(0), patchFormats: { min: 31, max: 38 } };
    expect(syncUpdateNotice(oldFirmware)).toMatchObject({ target: 'firmware', label: 'Update the FM-1' });
    expect(syncUpdateNotice(info(246))).toMatchObject({ target: 'firmware' });
    const newFirmware = { ...info(65526), patchFormats: { min: VERSION + 1, max: 200 } };
    expect(syncUpdateNotice(newFirmware)).toMatchObject({ target: 'editor', label: 'Open current editor' });
    expect(syncUpdateNotice(newFirmware).message).toContain('editor is older');
  });
  it('holds back legacy format 39 firmware, but not an FM-1 unheard from yet', () => {
    expect(syncsWith(info(246 | (255 << 8)))).toBe(false); // format 39 predates the current writer
    expect(syncsWith(null)).toBe(true);
  });
});
