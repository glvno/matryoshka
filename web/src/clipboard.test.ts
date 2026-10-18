// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { assembliesOf, makeAssembly, toDef } from './assembly';
import { clipText, copyItems, parseClip, pasteClip } from './clipboard';
import { DEFS } from './modules';
import { addModule, connect, emptyPatch, validatePatch, type Patch } from './patch';

/** Main -> osc -> filter -> vca -> output, an ADSR on the vca, the filter grouped in an assembly with a nested LFO card */
function patch(): { p: Patch; kb: number; osc: number; flt: number; lfo: number; env: number; vca: number; out: number; outer: number; inner: number } {
  const p = emptyPatch('clip');
  const kb = addModule(p, DEFS.fm1, 0, 0).id;
  const osc = addModule(p, DEFS.osc, 100, 0).id;
  const flt = addModule(p, DEFS.filter, 400, 0).id;
  const lfo = addModule(p, DEFS.lfo, 400, 300).id;
  const env = addModule(p, DEFS.adsr, 700, 300).id;
  const vca = addModule(p, DEFS.vca, 700, 0).id;
  const out = addModule(p, DEFS.output, 1000, 0).id;
  const c = (a: number, ap: string, b: number, bp: string): void => void expect(connect(p, DEFS, { module: a, port: ap }, { module: b, port: bp })).toBe(true);
  c(kb, 'pitch', osc, 'pitch');
  c(osc, 'out', flt, 'in');
  c(lfo, 'out', flt, 'cv');
  c(flt, 'lp12', vca, 'in');
  c(kb, 'gate', env, 'gate');
  c(env, 'env', vca, 'cv');
  c(vca, 'out', out, 'l');
  p.modules.find((m) => m.id === flt)!.params.cutoff = 777;
  p.modules.find((m) => m.id === vca)!.bypass = true;
  const inner = makeAssembly(p, [lfo], 'wobble').id;
  const outer = makeAssembly(p, [flt], 'tone');
  outer.children = [inner];
  return { p, kb, osc, flt, lfo, env, vca, out, outer: outer.id, inner };
}

describe('copy and paste (#92)', () => {
  it('carries modules, a nested assembly and the cables among them; cables to the rest stay behind', () => {
    const { p, osc, vca, outer } = patch();
    const clip = copyItems(p, [osc, vca], [outer])!;
    const back = parseClip(clipText(clip), DEFS)!; // through the system clipboard's text
    expect(back).not.toBeNull();
    const q = patch().p;
    const before = { mods: q.modules.length, asms: assembliesOf(q).length, cables: q.cables.length };
    const got = pasteClip(q, DEFS, back, back.x + 40, back.y + 40);
    expect(got.modules).toHaveLength(2); // osc + vca loose
    expect(got.assemblies).toHaveLength(1); // the tone assembly, with its nested wobble card
    expect(q.modules.length).toBe(before.mods + 4); // osc, vca, filter, lfo
    expect(assembliesOf(q).length).toBe(before.asms + 2);
    // osc -> filter, lfo -> filter, filter -> vca copied; pitch from Main, the ADSR's cv and vca -> output were not
    expect(q.cables.length).toBe(before.cables + 3);
    const tone = assembliesOf(q).find((a) => a.id === got.assemblies[0])!;
    expect(tone.name).toBe('tone');
    expect(tone.children).toHaveLength(1);
    const fresh = q.modules.filter((m) => !patch().p.modules.some((o) => o.id === m.id));
    expect(fresh.find((m) => m.type === 'filter')!.params.cutoff).toBe(777);
    expect(fresh.find((m) => m.type === 'vca')!.bypass).toBe(true);
    expect(() => validatePatch(JSON.parse(JSON.stringify(q)), DEFS)).not.toThrow();
  });

  it('lands offset from where it was copied, in the same layout', () => {
    const { p, osc, vca } = patch();
    const clip = copyItems(p, [osc, vca], [])!;
    expect([clip.x, clip.y]).toEqual([100, 0]);
    const got = pasteClip(p, DEFS, clip, clip.x + 32, clip.y + 32);
    const [a, b] = got.modules.map((id) => p.modules.find((m) => m.id === id)!);
    expect([a.x, a.y, b.x, b.y]).toEqual([132, 32, 732, 32]);
  });

  it('leaves Main and the Output out, as an assembly does', () => {
    const { p, kb, out } = patch();
    expect(copyItems(p, [kb, out], [])).toBeNull();
  });

  it('pastes into another patch with fresh ids', () => {
    const { p, osc } = patch();
    const clip = copyItems(p, [osc], [])!;
    const q = emptyPatch('other');
    addModule(q, DEFS.osc, 0, 0);
    const got = pasteClip(q, DEFS, clip, 0, 200);
    expect(new Set(q.modules.map((m) => m.id)).size).toBe(q.modules.length);
    expect(got.modules).toHaveLength(1);
  });

  it('refuses text that is not a clip', () => {
    expect(parseClip('hello', DEFS)).toBeNull();
    expect(parseClip('{"format":"matryoshka-clip","version":1,"x":0,"y":0,"def":{}}', DEFS)).toBeNull();
    const { p, outer } = patch();
    expect(parseClip(JSON.stringify(toDef(p, assembliesOf(p).find((a) => a.id === outer)!)), DEFS)).toBeNull(); // a library file
  });
});
