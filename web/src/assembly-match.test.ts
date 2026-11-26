// SPDX-License-Identifier: GPL-3.0-only
// Rebuilding a patch read from the FM-1 with the assemblies this browser has (assembly-match.ts, D-1355): a factory card,
// a user's saved one and a nested one come back as the assemblies they were; an edited instance stays a plain card; a
// rebuild that would change the bytes is never kept.
import { describe, expect, it } from 'vitest';
import { DEFS } from './modules';
import { addModule, connect, newPatch, validatePatch, type Patch } from './patch';
import { encodePatch } from './patchbin';
import { addMember, assembliesOf, descendants, insertAssembly, makeAssembly, parentOf, promote, toDef, type AssemblyDef } from './assembly';
import { FACTORY } from './assemblies';
import { wireEngine } from './engines';
import { plainPatch, readFromFm1 } from './patch-reader';
import { parseBinary } from './bin-parse';
import { matchAssemblies } from './assembly-match';
import { structureOf } from './structure';

const same = (a: ArrayLike<number>, b: ArrayLike<number>): boolean => a.length === b.length && Array.prototype.every.call(a, (x: number, i: number) => x === b[i]);
/** a patch with factory engine `name` on the canvas, played by Main's keys into the Output */
function withEngine(name: string): Patch {
  const p = newPatch(DEFS, name);
  const a = insertAssembly(p, DEFS, FACTORY.find((d) => d.name === name)!, 300, 40);
  wireEngine(p, a);
  return p;
}
/** the top-level cards of a patch */
const cards = (p: Patch) => assembliesOf(p).filter((a) => !parentOf(p, a.id) && !a.drawer);
/** encode, read back with `library`, and the second binary */
function read(p: Patch, library: AssemblyDef[]) {
  const src = validatePatch(structuredClone(p), DEFS);
  const bin = encodePatch(src, true);
  const r = readFromFm1(bin, { name: src.name, library })!;
  return { src, bin, r, again: encodePatch(r.patch, true) };
}

describe('rebuilding the cards (D-1355)', () => {
  it('recognises a factory assembly: its card, its nested poly assembly, its layout and labels', () => {
    const def = FACTORY.find((d) => d.name === 'Oracle V')!;
    const { src, bin, r, again } = read(withEngine('Oracle V'), [def]);
    expect(r.recognised).toBe(1);
    expect(r.exact).toBe(true);
    expect(same(again, bin)).toBe(true);
    const [orig] = cards(src), [back] = cards(r.patch);
    expect(back.name).toBe('Oracle V');
    expect(back.label).toBe(orig.label);
    expect(structureOf(r.patch, back)).toBe(structureOf(src, orig));
    expect(descendants(r.patch, back).map((x) => [x.label, !!x.poly])).toEqual(descendants(src, orig).map((x) => [x.label, !!x.poly]));
    expect(back.params.map((x) => [x.label, x.head, x.col])).toEqual(orig.params.map((x) => [x.label, x.head, x.col]));
    expect(back.inputs.map((x) => x.label)).toEqual(orig.inputs.map((x) => x.label));
  });

  it('recognises nested assemblies, eight deep in 8 Lire', () => {
    const def = FACTORY.find((d) => d.name === '8 Lire')!;
    const { src, r } = read(withEngine('8 Lire'), [def]);
    expect(r.recognised).toBe(1);
    expect(r.exact).toBe(true);
    const [orig] = cards(src), [back] = cards(r.patch);
    expect(descendants(r.patch, back).length).toBe(descendants(src, orig).length);
    expect(descendants(r.patch, back).length).toBeGreaterThanOrEqual(8);
  });

  it('recognises a user\'s saved assembly, and leaves the card plain without it', () => {
    const p = newPatch(DEFS, 'mine');
    const [main, out] = p.modules;
    const osc = addModule(p, DEFS.osc, 300, 40), flt = addModule(p, DEFS.filter, 600, 40), env = addModule(p, DEFS.adsr, 300, 400), vca = addModule(p, DEFS.vca, 900, 40);
    const c = (a: number, ap: string, b: number, bp: string): void => void connect(p, DEFS, { module: a, port: ap }, { module: b, port: bp });
    c(main.id, 'pitch', osc.id, 'pitch'); c(main.id, 'gate', env.id, 'gate'); c(osc.id, 'out', flt.id, 'in'); c(flt.id, 'lp24', vca.id, 'in'); c(env.id, 'env', vca.id, 'cv'); c(vca.id, 'out', out.id, 'l');
    flt.params.cutoff = 900;
    const inner = makeAssembly(p, [env.id, vca.id], 'amp');
    promote(inner, env.id, 'a', p);
    const a = makeAssembly(p, [osc.id, flt.id], 'my voice', [inner.id]);
    a.label = 'My Voice';
    promote(a, flt.id, 'cutoff', p);
    promote(a, flt.id, 'res', p);
    a.params[0].label = 'bright';
    const def = toDef(p, a);
    const known = read(p, [def]);
    expect(known.r.recognised).toBe(1);
    expect(known.r.exact).toBe(true);
    const [back] = cards(known.r.patch);
    expect(back.name).toBe('my voice');
    expect(back.params[0].label).toBe('bright');
    expect(descendants(known.r.patch, back).map((x) => x.label)).toEqual(['amp']);
    expect(known.r.patch.modules.find((m) => m.type === 'filter')!.params.cutoff).toBe(900);   // (the instance's value, not the definition's)
    // without the definition the nesting is lost: a plain card of the same modules, the same sound
    const plain = read(p, []);
    expect(plain.r.recognised).toBe(0);
    expect(cards(plain.r.patch)).toHaveLength(1);
    expect(descendants(plain.r.patch, cards(plain.r.patch)[0])).toHaveLength(0);
    const sound = (b: Uint8Array) => { const x = parseBinary(b)!; return JSON.stringify([x.modules, x.cables, x.groups]); };
    expect(sound(plain.again)).toBe(sound(plain.bin));
  });

  it('leaves an edited instance with a module more a plain card (its structure is no definition\'s)', () => {
    const p = withEngine('Monolith D');
    const [card] = cards(p);
    const extra = addModule(p, DEFS.shape, 600, 900);
    const member = p.modules.find((m) => card.modules.includes(m.id) && m.type === 'vca')!;
    const into = p.cables.find((x) => x.from.module === member.id)!;
    p.cables = p.cables.filter((x) => x !== into);
    connect(p, DEFS, into.from, { module: extra.id, port: 'in' });
    connect(p, DEFS, { module: extra.id, port: 'out' }, into.to);
    addMember(p, card, extra.id);
    const { r, src } = read(p, [FACTORY.find((d) => d.name === 'Monolith D')!]);
    expect(r.recognised).toBe(0);
    const [back] = cards(r.patch);
    expect(back.modules.length).toBe(cards(src)[0].modules.length);
    expect(back.name).toBe(back.label);   // (a plain card is named after its device)
  });

  it('keeps no rebuild the bytes would not hold: the plain card stays', () => {
    const def = FACTORY.find((d) => d.name === 'Oracle V')!;
    const bin = encodePatch(validatePatch(withEngine('Oracle V'), DEFS), true);
    const b = parseBinary(bin)!;
    const read0 = plainPatch(b, 'x');
    const patch = validatePatch(read0.patch, DEFS), keys = read0.keys;
    const kept = matchAssemblies(patch, [...keys], b, [def], () => false);
    expect(kept.recognised).toBe(0);
    expect(kept.patch).toBe(patch);
    expect(matchAssemblies(patch, [...keys], b, [def], () => true).recognised).toBe(1);
  });
});
