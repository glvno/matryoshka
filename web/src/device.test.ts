// SPDX-License-Identifier: GPL-3.0-only
// Connecting the FM-1 syncs by default (#171): the decision on connect and the chip's state.
import { describe, expect, it } from 'vitest';
import { chipState, sameBinary, syncOnConnect } from './device';
import { DEFS } from './modules';
import { newPatch } from './patch';
import { encodePatch } from './patchbin';
import { PRESETS } from './presets';

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
