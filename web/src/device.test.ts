// SPDX-License-Identifier: GPL-3.0-only
// Connecting the FM-1 syncs by default (#171): the decision on connect and the chip's state; Live over the budget (#200).
import { describe, expect, it } from 'vitest';
import { chipState, liveSync, sameBinary, syncLine, syncOnConnect } from './device';
import { DEFS } from './modules';
import { addModule, connect, newPatch, removeModule } from './patch';
import { deviceBudget, encodePatch } from './patchbin';
import { PRESETS } from './presets';
import { liveFrame, parse } from './protocol';
import { subtractiveSaw } from './test-patches';

const names = Object.keys(PRESETS);
const a = encodePatch(PRESETS[names[0]]());
const b = encodePatch(PRESETS[names[1]]());

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
  it('never offers a patch that does not fit', () => {
    expect(syncOnConnect({ fits: false, declined: false, editorBin: a, deviceBin: a })).toBe('too-big');
    expect(syncOnConnect({ fits: false, declined: true, editorBin: a, deviceBin: null })).toBe('too-big');
  });
});

describe('sameBinary', () => {
  it('ignores the layout: moving cards does not change the binary', () => {
    const p = PRESETS[names[0]]();
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
    expect(chipState(true, true, false)).toBe('patch too big to sync');
  });
});

describe('syncLine', () => {
  it('shows what the chip shows, with Sync or Stop syncing only while connected and the patch fits', () => {
    expect(syncLine(chipState(true, true, true))).toEqual({ text: 'Synced with the FM-1', action: 'stop' });
    expect(syncLine(chipState(true, false, true))).toEqual({ text: 'Not synced', action: 'sync' });
    expect(syncLine(chipState(true, true, false))).toEqual({ text: 'Patch too big to sync', action: null });
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
    expect(chipState(true, true, fits1)).toBe('patch too big to sync');
    expect(liveSync.pausesNow(true, true, fits1, fits1)).toBe(false); // still over: no second at-once LIVE
    removeModule(p, reverbs[1]);
    const fits2 = deviceBudget(p).fits;                          // back under
    expect(fits2).toBe(true);
    expect(liveSync.pausesNow(true, true, fits1, fits2)).toBe(false);
    expect(said(true, true, fits2)).toEqual([]);                 // LIVE without paused: resumed
    expect(liveSync.syncs(true, true, fits2)).toBe(true);        // the edit's upload sends the patch again
    expect(chipState(true, true, fits2)).toBe('synced');
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
