// SPDX-License-Identifier: GPL-3.0-only
import { beforeEach, describe, expect, it } from 'vitest';
import { ENGINE_SHELF, FACTORY } from './assemblies';
import { insertAssembly, type AssemblyDef } from './assembly';
import { assemblyShelves, SHELVES } from './catalog';
import { searchCommands, type Command } from './commands';
import { defIsEngine, defIsStereo, feedsOutput, instIsEngine, wireEngine, wiredText } from './engines';
import { DEFS } from './modules';
import { connect, newPatch } from './patch';

const mem = new Map<string, string>();
beforeEach(() => {
  mem.clear();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
  };
});

const ENGINES = [
  '8 Lire', 'Algo Four', 'basic poly', 'Briefcase 3', 'Canvas', 'Cassia 1', 'drift poly', 'drum kit', 'Elvira 2', 'Expander S', 'Hera 6', 'Io 4', 'Meridian 8', 'mono lead', 'Monolith D',
  'Oracle V', 'Perun 4', 'Sallen 20', 'Scrounge', 'Silver Box', 'Spokes 6', 'supersaw stack', 'Vernon 100', 'Wanderer',
];
const named = (name: string): AssemblyDef => FACTORY.find((d) => d.name === name)!;

/** a user's assembly of an allocator and one more module, the allocator's input and the other's output exposed */
const mine = (type: string, inPort: string, inType = 'alloc'): AssemblyDef => ({
  format: 'matryoshka-assembly', version: 1, name: 'mine',
  modules: [{ id: 1, type: inType, x: 0, y: 0, params: {} }, { id: 2, type, x: 0, y: 0, params: {} }],
  cables: [], params: [],
  inputs: [{ module: 1, port: inPort, label: inPort }],
  outputs: [{ module: 2, port: 'out', label: 'out' }],
} as AssemblyDef);

describe('engines (#159)', () => {
  it('are exactly the assemblies whose keys reach a voicing and that make audio (ADR 0001)', () => {
    expect(FACTORY.filter((d) => defIsEngine(d)).map((d) => d.name)).toEqual(ENGINES);
    expect(defIsEngine(mine('vca', 'keys'))).toBe(true); // a user's own qualifies: kinds, not names
    expect(defIsEngine(mine('lfo', 'keys'))).toBe(false); // keys in, control out
    expect(defIsEngine(mine('vca', 'pitch', 'osc'))).toBe(false); // pitch in
    expect(defIsEngine(named('pluck'))).toBe(false); // pitch + gate: a voice, not an engine
    expect(defIsEngine(mine('vca', 'keys', 'drummap'))).toBe(true); // mapped voicing
    expect(defIsEngine(mine('vca', 'keys', 'steps'))).toBe(false); // keys in, but nothing voices them
    // keys through an Arpeggiator into a Voicing still count
    const arp = mine('vca', 'keys', 'arp');
    arp.modules.push({ id: 3, type: 'alloc', x: 0, y: 0, params: {} } as AssemblyDef['modules'][number]);
    expect(defIsEngine(arp)).toBe(false);
    arp.cables.push({ from: { module: 1, port: 'keys' }, to: { module: 3, port: 'keys' } });
    expect(defIsEngine(arp)).toBe(true);
    expect(['Hera 6', 'Io 4', 'Expander S', 'supersaw stack'].every((n) => defIsStereo(named(n)))).toBe(true);
    expect(defIsStereo(named('Oracle V'))).toBe(false);
  });

  it('sit on the Engines shelf, first; Voices keeps the rest; the drum kit is on Engines and Drums', () => {
    expect(SHELVES[1]).toBe(ENGINE_SHELF); // after Your library
    const on = (shelf: string): string[] => assemblyShelves().filter((a) => a.shelf === shelf).map((a) => a.def.name);
    expect(on(ENGINE_SHELF)).toEqual(ENGINES);
    expect(on('Voices').length).toBeGreaterThan(0);
    for (const n of on('Voices')) expect(defIsEngine(named(n)), n).toBe(false);
    expect(on('Drums')).toContain('drum kit');
    expect(on('Drums')).toContain('Scrounge');
    expect(on('Drums')).toContain('Meridian 8');
    expect(on('Drums')).toContain('Perun 4');
    expect(on('Drums')).toContain('Spokes 6');
    expect(new Set(assemblyShelves().map((a) => a.def))).toEqual(new Set(FACTORY)); // every one somewhere
  });

  it('come up when the palette is asked for "engine"', () => {
    const cmd = (label: string, tags: string[]): Command => ({ kind: 'assembly', label, tags, run: () => {} });
    const list = [cmd('Hera 6', ['assembly', 'engine', 'Engines']), cmd('pluck', ['assembly', 'Voices']), { kind: 'command', label: 'New patch', run: () => {} }];
    expect(searchCommands(list, 'engine').map((c) => c.label)).toEqual(['Hera 6']);
    expect(searchCommands(list, 'engines').map((c) => c.label)).toEqual(['Hera 6']);
  });

  it('come wired: keys from Main, audio into a free Output', () => {
    const p = newPatch(DEFS);
    expect(feedsOutput(p)).toBe(false);
    const a = insertAssembly(p, DEFS, named('Hera 6'), 0, 400);
    expect(instIsEngine(p, a)).toBe(true);
    const w = wireEngine(p, a);
    expect(w).toEqual({ keys: true, out: 2 });
    const main = p.modules.find((m) => m.type === 'fm1')!;
    const out = p.modules.find((m) => m.type === 'output')!;
    expect(p.cables.some((c) => c.from.module === main.id && c.from.port === 'keys')).toBe(true);
    expect(p.cables.filter((c) => c.to.module === out.id).map((c) => c.to.port).sort()).toEqual(['l', 'r']);
    expect(wiredText('Hera 6', w)).toContain('Output (l, r)');

    // a second engine: the Output is fed, so only its keys are cabled; Main's keys feed both allocators
    const b = insertAssembly(p, DEFS, named('Oracle V'), 0, 900);
    const before = p.cables.filter((c) => c.to.module === out.id).length;
    expect(wireEngine(p, b)).toEqual({ keys: true, out: 0 });
    expect(p.cables.filter((c) => c.to.module === out.id).length).toBe(before);
    expect(p.cables.filter((c) => c.from.module === main.id && c.from.port === 'keys').length).toBe(2);
  });

  it('a mono engine goes into l; a non-engine is not wired', () => {
    const p = newPatch(DEFS);
    const out = p.modules.find((m) => m.type === 'output')!;
    const a = insertAssembly(p, DEFS, named('Oracle V'), 0, 400);
    expect(wireEngine(p, a)).toEqual({ keys: true, out: 1 });
    expect(p.cables.filter((c) => c.to.module === out.id).map((c) => c.to.port)).toEqual(['l']);
    const q = newPatch(DEFS);
    const n = q.cables.length;
    expect(wireEngine(q, insertAssembly(q, DEFS, named('pluck'), 0, 400))).toEqual({ keys: false, out: 0 });
    expect(q.cables.length).toBe(n + named('pluck').cables.length);
  });

  it('an Output fed by anything counts as fed', () => {
    const p = newPatch(DEFS);
    const osc = insertAssembly(p, DEFS, named('pluck'), 0, 400);
    const o = osc.outputs[0];
    connect(p, DEFS, { module: o.module, port: o.port }, { module: p.modules.find((m) => m.type === 'output')!.id, port: 'r' });
    expect(feedsOutput(p)).toBe(true);
    expect(wireEngine(p, insertAssembly(p, DEFS, named('Hera 6'), 0, 900)).out).toBe(0);
  });
});
