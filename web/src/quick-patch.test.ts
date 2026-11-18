// SPDX-License-Identifier: GPL-3.0-only
// Quick patch (#1091): search ranking, the port Enter takes for each kind of signal, the typed chain, following cables,
// blueprints. The editor's own step (one undo step per chain) is in quick-patch-editor.test.ts.
import { describe, expect, it } from 'vitest';
import { FACTORY } from './assemblies';
import { insertAssembly } from './assembly';
import { addableModules } from './catalog';
import { moduleKeywords } from './labels';
import { DEFS } from './modules';
import { addModule, connect, newPatch, type Patch } from './patch';
import {
  besideSpot, buildChain, cardPorts, cardTitle, chainText, defaultPort, farEnds, GAP, loadBlueprints, matchPorts, parseChain, portCables,
  rankPorts, removeBlueprint, saveBlueprint, search, Trail, type Card, type Catalog, type Place, type QPort,
} from './quick-patch';

const catalog = (blueprints: Catalog['blueprints'] = []): Catalog => ({
  modules: addableModules(DEFS).map((m) => ({ type: m.type, name: m.name, keywords: moduleKeywords(m.type, m.def.label) })),
  assemblies: FACTORY.map((def) => ({ def, shelf: 'factory', keywords: def.blurb ?? '' })),
  blueprints,
});
const mod = (p: Patch, type: string, x = 0, y = 0): Card => ({ kind: 'module', id: addModule(p, DEFS[type], x, y).id });
const port = (p: Patch, c: Card, name: string, dir: 'in' | 'out'): QPort => cardPorts(p, DEFS, c).find((q) => q.name === name && q.dir === dir)!;
const cabled = (p: Patch, c: Card) => (q: QPort): boolean => portCables(p, DEFS, c, q).length > 0;
const outputOf = (p: Patch): Card => ({ kind: 'module', id: p.modules.find((m) => m.type === 'output')!.id });
/** a placer for tests: beside the anchor, clear of the cards placed so far; the first at the origin */
const placer = (p: Patch): Place => {
  const taken: { x: number; y: number; w: number; h: number }[] = p.modules.filter((m) => m.type !== 'fm1').map((m) => ({ x: m.x, y: m.y, w: 260, h: 300 }));
  return (size, anchor, side) => {
    const at = anchor ? besideSpot(anchor, side, size, taken) : { x: 20, y: 400 };
    taken.push({ ...at, ...size });
    return at;
  };
};
const rectOf = (p: Patch) => (c: Card) => {
  const m = c.kind === 'module' ? p.modules.find((x) => x.id === c.id) : null;
  return m && m.type !== 'fm1' ? { x: m.x, y: m.y, w: 260, h: 300 } : null;
};
const cableList = (p: Patch): string[] => p.cables.map((c) => {
  const t = (id: number): string => p.modules.find((m) => m.id === id)!.type;
  return `${t(c.from.module)}.${c.from.port}>${t(c.to.module)}.${c.to.port}`;
}).sort();

describe('search', () => {
  it('offers the card in the patch before a new one: out finds the Output there is', () => {
    const p = newPatch(DEFS);
    const hits = search(p, DEFS, catalog(), 'out');
    expect(hits[0]).toMatchObject({ kind: 'card', label: 'Output' });
  });
  it('finds modules by name, tag and search words, the common one first on a tie', () => {
    const p = newPatch(DEFS);
    const top = (q: string): string => { const h = search(p, DEFS, catalog(), q)[0]; return h.kind === 'module' ? h.type : `${h.kind}:${h.label}`; };
    expect(top('lfo')).toBe('lfo');
    expect(top('multi')).toBe('filter');
    expect(top('mm')).toBe('filter');
    expect(top('multimode')).toBe('filter');
    expect(top('filt')).toBe('filter');
    expect(top('vca')).toBe('vca');
    expect(top('adsr')).toBe('adsr');
    expect(top('VCF')).toBe('filter');
  });
  it('a leading + offers only new ones', () => {
    const p = newPatch(DEFS);
    const hits = search(p, DEFS, catalog(), '+out');
    expect(hits.every((h) => h.kind !== 'card')).toBe(true);
  });
  it('finds assemblies by name and blueprints by name', () => {
    const p = newPatch(DEFS);
    const cat = catalog([{ name: 'lfo-filter-vca', chain: '+lfo.out > +filter.cv' }]);
    expect(search(p, DEFS, cat, 'briefcase 3')[0]).toMatchObject({ kind: 'assembly', label: 'Briefcase 3' });
    expect(search(p, DEFS, cat, 'lfo-filter-vca')[0]).toMatchObject({ kind: 'blueprint' });
  });
});

describe('the port Enter takes', () => {
  it('holding nothing: the first free output (the Multimode\'s lp24, the LFO\'s out)', () => {
    const p = newPatch(DEFS);
    const f = mod(p, 'filter');
    expect(defaultPort(cardPorts(p, DEFS, f), null, cabled(p, f))?.name).toBe('lp24');
    const l = mod(p, 'lfo');
    expect(defaultPort(cardPorts(p, DEFS, l), null, cabled(p, l))?.name).toBe('out');
  });
  it('holding a control signal: cv, then the other control inputs, thumbs last', () => {
    const p = newPatch(DEFS);
    const l = mod(p, 'lfo'), f = mod(p, 'filter'), o = mod(p, 'osc');
    const held = port(p, l, 'out', 'out');
    expect(defaultPort(cardPorts(p, DEFS, f), held, cabled(p, f))?.name).toBe('cv');
    expect(defaultPort(cardPorts(p, DEFS, o), held, cabled(p, o))?.name).toBe('pitch');
    const ranked = rankPorts(cardPorts(p, DEFS, f), held, cabled(p, f));
    // the lit control jacks, then the thumbs (all control), then the audio input
    expect(ranked.slice(0, 2).map((q) => q.name)).toEqual(['cv', 'morph']);
    expect(ranked.at(-1)?.name).toBe('in');
  });
  it('holding audio: in, and the Output\'s l (also when l already has a cable: they add up)', () => {
    const p = newPatch(DEFS);
    const f = mod(p, 'filter'), v = mod(p, 'vca'), out = outputOf(p);
    const held = port(p, f, 'lp24', 'out');
    expect(defaultPort(cardPorts(p, DEFS, v), held, cabled(p, v))?.name).toBe('in');
    expect(defaultPort(cardPorts(p, DEFS, out), held, cabled(p, out))?.name).toBe('l');
    connect(p, DEFS, { module: v.id, port: 'out' }, { module: out.id, port: 'l' });
    expect(defaultPort(cardPorts(p, DEFS, out), held, cabled(p, out))?.name).toBe('l');
  });
  it('holding a gate: gate inputs; keys only meet keys', () => {
    const p = newPatch(DEFS);
    const a = mod(p, 'adsr');
    const main: Card = { kind: 'module', id: p.modules.find((m) => m.type === 'fm1')!.id };
    expect(defaultPort(cardPorts(p, DEFS, a), port(p, main, 'gate', 'out'), cabled(p, a))?.name).toBe('gate');
    expect(defaultPort(cardPorts(p, DEFS, a), port(p, main, 'keys', 'out'), cabled(p, a))).toBeNull();
  });
  it('holding an input: the card\'s first output of its kind', () => {
    const p = newPatch(DEFS);
    const f = mod(p, 'filter'), a = mod(p, 'adsr');
    expect(defaultPort(cardPorts(p, DEFS, a), port(p, f, 'cv', 'in'), cabled(p, a))?.name).toBe('env');
  });
  it('a typed prefix picks a port: lp → lp24, cut → cutoff', () => {
    const p = newPatch(DEFS);
    const f = mod(p, 'filter');
    const ports = cardPorts(p, DEFS, f);
    expect(matchPorts(ports, 'lp')[0].name).toBe('lp24');
    expect(matchPorts(ports, 'cut')[0].name).toBe('cutoff');
    expect(matchPorts(ports, 'cv')[0].name).toBe('cv');
  });
  it('a large assembly lists every port: Briefcase 3 has 15 in and 17 out', () => {
    const p = newPatch(DEFS);
    const def = FACTORY.find((d) => d.name === 'Briefcase 3')!;
    const a = insertAssembly(p, DEFS, def, 0, 0);
    const ports = cardPorts(p, DEFS, { kind: 'assembly', id: a.id });
    expect(ports.filter((q) => q.dir === 'out')).toHaveLength(def.outputs.length);
    expect(ports.filter((q) => q.dir === 'in' && !q.param)).toHaveLength(def.inputs.length);
  });
});

describe('the typed chain', () => {
  it('reads statements, ports, + and #n', () => {
    const r = parseChain('lfo.out > multimode.cv; +lfo#2 > vca\nbp mine');
    expect(r).toEqual({ statements: [
      { kind: 'chain', items: [{ name: 'lfo', fresh: false, tag: 'lfo#1', port: 'out' }, { name: 'multimode', fresh: false, tag: 'multimode#1', port: 'cv' }] },
      { kind: 'chain', items: [{ name: 'lfo', fresh: true, tag: 'lfo#2' }, { name: 'vca', fresh: false, tag: 'vca#1' }] },
      { kind: 'blueprint', name: 'mine' },
    ] });
  });
  it('says what is wrong', () => {
    expect(parseChain('lfo')).toMatchObject({ error: expect.stringContaining('put > between') });
    expect(parseChain('lfo > ')).toMatchObject({ error: expect.stringContaining('missing') });
    expect(parseChain('lfo. > vca')).toMatchObject({ error: expect.stringContaining('port name is missing') });
  });
  it('builds the reference chain from one pasted line, into the Output there is', () => {
    const p = newPatch(DEFS);
    const parsed = parseChain('lfo.out > multimode.cv; multimode.lp > vca.in > output.in');
    if ('error' in parsed) throw new Error(parsed.error);
    const built = buildChain(p, DEFS, parsed.statements, catalog(), placer(p), rectOf(p));
    expect(cableList(p)).toEqual(['filter.lp24>vca.in', 'lfo.out>filter.cv', 'vca.out>output.l']);
    expect(built.fresh).toHaveLength(3);
    // laid out by signal flow: each card left of the one it feeds, ending at the Output
    const x = (t: string): number => p.modules.find((m) => m.type === t)!.x;
    expect(x('lfo')).toBeLessThan(x('filter'));
    expect(x('filter')).toBeLessThan(x('vca'));
    expect(x('vca')).toBeLessThan(x('output'));
  });
  it('names unknown modules and ports', () => {
    const p = newPatch(DEFS);
    const run = (text: string): void => {
      const parsed = parseChain(text);
      if ('error' in parsed) throw new Error(parsed.error);
      buildChain(p, DEFS, parsed.statements, catalog(), placer(p), rectOf(p));
    };
    expect(() => run('zzqx > vca')).toThrow('no module, assembly or card called "zzqx"');
    expect(() => run('lfo.nope > vca')).toThrow('LFO has no output "nope". Its outputs: out, pulse');
    expect(() => run('lfo > vca.zz')).toThrow(/VCA has no input "zz"/);
  });
  it('a second card of a type: #2', () => {
    const p = newPatch(DEFS);
    const parsed = parseChain('+lfo > vca.cv; +lfo#2 > vca.gain');
    if ('error' in parsed) throw new Error(parsed.error);
    buildChain(p, DEFS, parsed.statements, catalog(), placer(p), rectOf(p));
    expect(p.modules.filter((m) => m.type === 'lfo')).toHaveLength(2);
    expect(p.modules.filter((m) => m.type === 'vca')).toHaveLength(1);
  });
  it('writes a chain back as a line that builds it again', () => {
    const p = newPatch(DEFS);
    const parsed = parseChain('lfo.out > multimode.cv; multimode.lp > vca.in > output.in');
    if ('error' in parsed) throw new Error(parsed.error);
    const built = buildChain(p, DEFS, parsed.statements, catalog(), placer(p), rectOf(p));
    expect(chainText(p, DEFS, built.links, built.fresh)).toBe('+lfo.out > +filter.cv > +vca.in > output.l');
  });
});

describe('following cables', () => {
  it('lists every far end of a port with several cables, and the trail goes back and forth', () => {
    const p = newPatch(DEFS);
    const l = mod(p, 'lfo'), f = mod(p, 'filter'), v = mod(p, 'vca'), o = mod(p, 'osc');
    connect(p, DEFS, { module: l.id, port: 'out' }, { module: f.id, port: 'cv' });
    connect(p, DEFS, { module: l.id, port: 'out' }, { module: v.id, port: 'cv' });
    connect(p, DEFS, { module: l.id, port: 'out' }, { module: o.id, port: 'pitch' });
    const ends = farEnds(p, DEFS, l, port(p, l, 'out', 'out'));
    expect(ends.map((e) => `${e.title}.${e.port}`)).toEqual(['Multimode filter.cv', 'VCA.cv', 'Oscillator.pitch']);
    // from the far end back along the cable
    expect(farEnds(p, DEFS, v, port(p, v, 'cv', 'in')).map((e) => e.title)).toEqual(['LFO']);
    const trail = new Trail();
    trail.push(l);
    trail.push(ends[1].card);
    trail.push(f);
    expect(cardTitle(p, DEFS, trail.go(trail.at - 1)!)).toBe('VCA');
    expect(cardTitle(p, DEFS, trail.go(trail.at - 1)!)).toBe('LFO');
    expect(trail.canBack).toBe(false);
    expect(trail.go(trail.at - 1)).toBeNull();
    expect(cardTitle(p, DEFS, trail.go(trail.at + 1)!)).toBe('VCA');
    trail.push(o);   // going somewhere new drops what was ahead
    expect(trail.canForward).toBe(false);
    expect(trail.items.map((c) => cardTitle(p, DEFS, c))).toEqual(['LFO', 'VCA', 'Oscillator']);
  });
  it('a thumb\'s cables are the ones that reach its parameter', () => {
    const p = newPatch(DEFS);
    const l = mod(p, 'lfo'), f = mod(p, 'filter');
    const parsed = parseChain('lfo > multimode.res');
    if ('error' in parsed) throw new Error(parsed.error);
    buildChain(p, DEFS, parsed.statements, catalog(), placer(p), rectOf(p));
    expect(farEnds(p, DEFS, f, port(p, f, 'res', 'in')).map((e) => e.card)).toEqual([l]);
  });
});

describe('blueprints', () => {
  const memory = (): Storage => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) } as unknown as Storage;
  };
  it('keep a chain under a name and stamp it into another patch', () => {
    const store = memory();
    const p = newPatch(DEFS);
    const parsed = parseChain('lfo.out > multimode.cv; multimode.lp > vca.in > output.in');
    if ('error' in parsed) throw new Error(parsed.error);
    const built = buildChain(p, DEFS, parsed.statements, catalog(), placer(p), rectOf(p));
    saveBlueprint('lfo-filter-vca', chainText(p, DEFS, built.links, built.fresh), store);
    const list = loadBlueprints(store);
    expect(list.map((b) => b.name)).toEqual(['lfo-filter-vca']);
    const q = newPatch(DEFS);
    const stamp = parseChain('bp lfo-filter-vca');
    if ('error' in stamp) throw new Error(stamp.error);
    const again = buildChain(q, DEFS, stamp.statements, catalog(list), placer(q), rectOf(q));
    expect(cableList(q)).toEqual(cableList(p));
    expect(again.fresh).toHaveLength(3);
    // stamped twice: new cards again, into the same Output
    buildChain(q, DEFS, stamp.statements, catalog(list), placer(q), rectOf(q));
    expect(q.modules.filter((m) => m.type === 'vca')).toHaveLength(2);
    expect(q.modules.filter((m) => m.type === 'output')).toHaveLength(1);
    expect(removeBlueprint('lfo-filter-vca', store)).toBe(true);
    expect(loadBlueprints(store)).toEqual([]);
  });
  it('an unknown blueprint is named', () => {
    const p = newPatch(DEFS);
    const stamp = parseChain('bp nope');
    if ('error' in stamp) throw new Error(stamp.error);
    expect(() => buildChain(p, DEFS, stamp.statements, catalog(), placer(p), rectOf(p))).toThrow('no blueprint "nope"');
  });
});

describe('where a new card goes', () => {
  it('beside its anchor, on its row or the nearest free row below', () => {
    const anchor = { x: 0, y: 0, w: 200, h: 200 };
    expect(besideSpot(anchor, 'right', { w: 200, h: 100 }, [])).toEqual({ x: 200 + GAP, y: 0 });
    expect(besideSpot(anchor, 'left', { w: 200, h: 100 }, [])).toEqual({ x: -200 - GAP, y: 0 });
    const spot = besideSpot(anchor, 'right', { w: 200, h: 100 }, [{ x: 200 + GAP, y: 0, w: 200, h: 100 }]);
    expect(spot).toEqual({ x: 200 + GAP, y: 120 });
  });
});
