// SPDX-License-Identifier: GPL-3.0-only
// Several FM-1s on one computer (D-965): Connect FM-1 tells them apart, lets the user choose, remembers the choice by
// serial and never takes the test rig on its own; the Install panel installs only on the chosen one.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeviceLink, ignoredFound } from './device';
import { autoPick, CHOOSE_FIRST, CHOSEN_MISSING, fm1Label, installPlan, LOADER_AMONG_SEVERAL, NOT_CHOSEN, suggested, type Fm1Id, type FoundFm1 } from './fm1-choice';
import { CMD } from './protocol';
import { commands, fakeAccess, fakeFm1, type FakeFm1 } from './test-fm1s';

const HOME = '0123456789ABCDEF0123456789AB0001', STAGE = '0123456789ABCDEF0123456789AB0002', RIG = '0123456789ABCDEF0123456789AB7E57';
const KEY = 'matryoshka.fm1-choice';

describe('Connect FM-1 with several FM-1s (D-965)', () => {
  const g = globalThis as unknown as { navigator: { requestMIDIAccess?: unknown } };
  let store: Map<string, string>;
  let saved: unknown;
  beforeEach(() => {
    store = new Map();
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) });
    vi.stubGlobal('window', globalThis);
    saved = g.navigator.requestMIDIAccess;
  });
  afterEach(() => {
    g.navigator.requestMIDIAccess = saved;
    vi.unstubAllGlobals();
  });
  /** connects `link` with these FM-1s on USB; `chooser` answers "Which FM-1?" and records what it was offered */
  const connect = (link: DeviceLink, fm1s: FakeFm1[], o: { ask?: boolean } = {}) => {
    g.navigator.requestMIDIAccess = async () => fakeAccess(...fm1s);
    return link.connect(o);
  };
  const chooser = (answer: number | null) => {
    const offered: { labels: string[]; first: number }[] = [];
    return { offered, choose: async (found: Fm1Id[], first: number) => (offered.push({ labels: found.map(fm1Label), first }), answer) };
  };
  const reads = new Set<number>([CMD.hello, CMD.deviceSettings, CMD.presetGet]);

  it('one FM-1: linked as before, without asking, and named in the status line', async () => {
    const home = fakeFm1('h', { name: 'HOME', serial: HOME });
    const link = new DeviceLink(), c = chooser(0);
    link.choose = c.choose;
    await connect(link, [home]);
    expect(c.offered).toEqual([]);
    expect(link.input).toBe(home.i);
    expect(link.identity).toMatchObject({ name: 'HOME', serial: HOME, rig: false, count: 1 });
    expect(fm1Label(link.identity!)).toBe('FM-1 HOME');
    expect(store.size).toBe(0);   // (nothing to remember with one FM-1)
  });

  it('two FM-1s with names: the user chooses, the editor links that one and remembers it by serial', async () => {
    const home = fakeFm1('h', { name: 'HOME', serial: HOME }), stage = fakeFm1('s', { name: 'STAGE', serial: STAGE });
    const link = new DeviceLink(), c = chooser(1);
    link.choose = c.choose;
    await connect(link, [home, stage]);
    expect(c.offered).toEqual([{ labels: ['FM-1 HOME', 'FM-1 STAGE'], first: 0 }]);
    expect(link.input).toBe(stage.i);
    expect(link.identity).toMatchObject({ name: 'STAGE', count: 2 });
    expect(store.get(KEY)).toBe(STAGE);
    expect(home.i.onmidimessage).toBeNull();                       // (let go of)
    expect(commands(home.o).every((cmd) => reads.has(cmd))).toBe(true);   // (only asked who it is)
    expect(link.choice).toMatchObject({ serial: STAGE, inputId: 's', linked: true });
  });

  it('a remembered FM-1 is linked straight away; Choose FM-1… asks again', async () => {
    store.set(KEY, STAGE);
    const home = fakeFm1('h', { name: 'HOME', serial: HOME }), stage = fakeFm1('s', { name: 'STAGE', serial: STAGE });
    const link = new DeviceLink(), c = chooser(0);
    link.choose = c.choose;
    await connect(link, [home, stage]);
    expect(c.offered).toEqual([]);
    expect(link.input).toBe(stage.i);
    await connect(link, [home, stage], { ask: true });
    expect(c.offered).toEqual([{ labels: ['FM-1 HOME', 'FM-1 STAGE'], first: 1 }]);   // (the remembered one offered first)
    expect(link.input).toBe(home.i);
    expect(store.get(KEY)).toBe(HOME);
  });

  it('Cancel on Choose FM-1… keeps the FM-1 linked before; with none linked, Connect says so and links nothing', async () => {
    store.set(KEY, STAGE);
    const home = fakeFm1('h', { serial: HOME }), stage = fakeFm1('s', { serial: STAGE });
    const link = new DeviceLink();
    link.choose = chooser(null).choose;
    await connect(link, [home, stage]);
    await connect(link, [home, stage], { ask: true });
    expect(link.input).toBe(stage.i);
    expect(store.get(KEY)).toBe(STAGE);
    const fresh = new DeviceLink();
    fresh.choose = chooser(null).choose;
    await expect(connect(fresh, [home, stage], { ask: true })).rejects.toThrow(NOT_CHOSEN);
    expect(fresh.connected).toBe(false);
    await expect(connect(new DeviceLink(), [home, stage], { ask: true })).rejects.toThrow(NOT_CHOSEN);   // (no chooser: none)
  });

  it('the test rig beside another FM-1 is labelled, offered last, and never linked without asking', async () => {
    store.set(KEY, RIG);   // (even a remembered rig is asked about)
    const rig = fakeFm1('r', { serial: RIG, rig: true }), home = fakeFm1('h', { serial: HOME });
    const link = new DeviceLink(), c = chooser(0);
    link.choose = c.choose;
    await connect(link, [rig, home]);
    expect(c.offered).toEqual([{ labels: ['Test rig', 'FM-1 \u2026AB0001'], first: 1 }]);
    expect(link.input).toBe(rig.i);                 // (chosen by the user)
    expect(link.identity?.rig).toBe(true);
    expect(store.has(KEY)).toBe(false);             // (a rig is never remembered: the next connect asks again)
  });

  it('older firmware without device settings: told apart by port order, the choice not remembered', async () => {
    store.set(KEY, STAGE);
    const one = fakeFm1('a', { features: 0 }), two = fakeFm1('b', { features: 0 });
    const link = new DeviceLink(), c = chooser(1);
    link.choose = c.choose;
    await connect(link, [one, two]);
    expect(c.offered).toEqual([{ labels: ['FM-1 #1', 'FM-1 #2'], first: 0 }]);
    expect(link.input).toBe(two.i);
    expect(link.identity).toMatchObject({ name: null, serial: null });
    expect(store.has(KEY)).toBe(false);
    expect(commands(one.o)).toEqual([CMD.hello]);   // (nothing asked that it does not have)
  });

  it('an FM-1 set to ignore the editor does not count (#702): the other is linked without asking', async () => {
    const ign = fakeFm1('i', { serial: RIG, ignore: true }), home = fakeFm1('h', { serial: HOME });
    const link = new DeviceLink(), c = chooser(0);
    link.choose = c.choose;
    await connect(link, [ign, home]);
    expect(c.offered).toEqual([]);
    expect(link.input).toBe(home.i);
    expect(commands(ign.o)).toEqual([CMD.hello]);
    const err = await connect(new DeviceLink(), [ign]).catch((e: Error) => e);
    expect((err as Error).message).toBe(ignoredFound(1));
  });

  it('pairs two same-named FM-1s\' ports in order, not one output for both', async () => {
    const one = fakeFm1('a', { serial: HOME }), two = fakeFm1('b', { serial: STAGE });
    const link = new DeviceLink(), c = chooser(1);
    link.choose = c.choose;
    await connect(link, [one, two]);
    expect(link.output).toBe(two.o);
  });

  it('what an FM-1 sends after HELLO reaches the editor only from the one linked', async () => {
    const home = fakeFm1('h', { serial: HOME }), stage = fakeFm1('s', { serial: STAGE });
    const link = new DeviceLink(), seen: string[] = [];
    link.choose = async () => 1;
    // (each FM-1 sends a CC as it takes HELLO, before its answer: the editor hears it only from STAGE, once it is linked)
    for (const [f, n] of [[home, 1], [stage, 2]] as const) {
      const send = f.o.send;
      f.o.send = (d) => {
        send(d);
        if (d[4] === CMD.hello) f.i.onmidimessage?.({ data: Uint8Array.from([0xb0, 20, n]) });
      };
    }
    link.onEvent = (e) => void (e.kind === 'cc' && seen.push(`cc${e.v}`));
    await connect(link, [home, stage]);
    expect(seen).toEqual(['cc2']);
  });
});

describe('the Install panel\'s target among several FM-1s (D-965)', () => {
  const fm1 = (id: string, o: Partial<FoundFm1> = {}): FoundFm1 => ({ inputId: id, outputId: id.toUpperCase(), loader: false, ignored: false, serial: null, text: 'FM-1_7011100', label: id, ...o });
  const home = fm1('h', { serial: HOME }), stage = fm1('s', { serial: STAGE });
  it('one FM-1 or none: as before', () => {
    expect(installPlan([], null)).toEqual({ avoid: [], target: null, others: [] });
    expect(installPlan([home], null)).toEqual({ avoid: [], target: null, others: [] });
    expect(installPlan([fm1('l', { loader: true })], null)).toEqual({ avoid: [], target: null, others: [] });   // (a cut-off install alone is finished)
  });
  it('two and none chosen: nothing is installed', () => {
    expect(installPlan([home, stage], null)).toEqual({ refuse: CHOOSE_FIRST(2) });
    expect(installPlan([home, stage], { serial: RIG, inputId: null, label: 'x', linked: false })).toEqual({ refuse: CHOOSE_FIRST(2) });
  });
  it('the remembered one, and every other FM-1\'s ports kept out of the install', () => {
    expect(installPlan([home, stage], { serial: STAGE, inputId: null, label: 'x', linked: false })).toEqual({ avoid: ['h', 'H'], target: stage, others: [home] });
  });
  it('the linked one, by serial or (older firmware) by its port, and only it', () => {
    expect(installPlan([home, stage], { serial: HOME, inputId: 'h', label: 'x', linked: true })).toMatchObject({ target: home, avoid: ['s', 'S'] });
    const old = [fm1('a'), fm1('b')];
    expect(installPlan(old, { serial: null, inputId: 'b', label: 'FM-1 #2', linked: true })).toMatchObject({ target: old[1], avoid: ['a', 'A'] });
    expect(installPlan([home], { serial: null, inputId: 'z', label: 'FM-1 X', linked: true })).toEqual({ refuse: CHOSEN_MISSING('FM-1 X') });
  });
  it('an FM-1 in update mode beside another is never written to', () => {
    const loader = fm1('l', { loader: true });
    expect(installPlan([loader, home], null)).toEqual({ refuse: LOADER_AMONG_SEVERAL });
    expect(installPlan([loader, home], { serial: HOME, inputId: 'h', label: 'x', linked: true })).toEqual({ refuse: LOADER_AMONG_SEVERAL });
  });
  it('one set to ignore the editor beside another: the other, as before (#702)', () => {
    const ign = fm1('i', { ignored: true });
    expect(installPlan([ign, home], null)).toEqual({ avoid: ['i', 'I'], target: home, others: [ign] });
    expect(installPlan([ign, fm1('j', { ignored: true })], null)).toEqual({ avoid: [], target: null, others: [] });
  });
});

describe('autoPick / suggested', () => {
  const id = (serial: string | null, rig = false): Fm1Id => ({ name: null, serial, rig, index: 0, count: 2, port: '', portId: '', firmware: '' });
  it('takes only the remembered FM-1, never the rig', () => {
    expect(autoPick([id(HOME)], null)).toBe(0);
    expect(autoPick([id(HOME), id(STAGE)], STAGE)).toBe(1);
    expect(autoPick([id(HOME), id(STAGE)], STAGE, true)).toBeNull();
    expect(autoPick([id(RIG, true), id(HOME)], RIG)).toBeNull();
    expect(suggested([id(RIG, true), id(HOME)], null)).toBe(1);
    expect(suggested([id(RIG, true), id(RIG, true)], null)).toBe(0);
  });
});
