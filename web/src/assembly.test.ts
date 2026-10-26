// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { deviceBudget } from './patchbin';
import {
  stripPatchIO,
  bypassAssembly,
  addChild,
  addMember,
  allModules,
  boundary,
  childProblem,
  depthOf,
  freeSpot,
  freeSpotNear,
  hiddenAssemblies,
  mergePorts,
  moveAssembly,
  parentOf,
  removeChild,
  targetsOf,
  unmergePort,
  deleteAssembly,
  exposePort,
  findRef,
  fixAssemblies,
  hiddenModules,
  hidePort,
  insertAssembly,
  makeAssembly,
  promote,
  reconcileAll,
  removeMember,
  toDef,
  ungroup,
  overlapping,
  tileMembers,
  validateAssemblyDef,
  demote,
  keepParams,
  moveRef,
  pickRows,
  pickState,
  keyRange,
  paramColumns,
  setColumnBreak,
  setHeading,
  setSpan,
  spanPlan,
  type ParamRef,
  type SpanBlock,
} from './assembly';
import { CATEGORIES, categoryOf, FACTORY } from './assemblies';
import { newPatch } from './patch';
import { Engine } from './engine';
import { DEFS } from './modules';
import { longName } from './labels';
import { addModule, connect, emptyPatch, removeModule, validatePatch, type Patch } from './patch';
import { encodePatch } from './patchbin';
import { engineBytes } from './test-bin';
import { PRESETS } from './presets';

/** panel -> osc -> vca -> output, with an envelope on the vca: the modules of a 1-operator voice */
function voice(): { p: Patch; kb: number; osc: number; env: number; vca: number; out: number } {
  const p = emptyPatch('v');
  const kb = addModule(p, DEFS.fm1, 0, 0).id;
  const osc = addModule(p, DEFS.osc, 100, 0).id;
  const env = addModule(p, DEFS.adsr, 100, 300).id;
  const vca = addModule(p, DEFS.vca, 400, 0).id;
  const out = addModule(p, DEFS.output, 700, 0).id;
  const c = (a: number, ap: string, b: number, bp: string): void => {
    expect(connect(p, DEFS, { module: a, port: ap }, { module: b, port: bp })).toBe(true);
  };
  c(kb, 'pitch', osc, 'pitch');
  c(kb, 'gate', env, 'gate');
  c(osc, 'out', vca, 'in');
  c(env, 'env', vca, 'cv');
  c(vca, 'out', out, 'l');
  return { p, kb, osc, env, vca, out };
}

const render = (p: Patch, frames = 4096, note = 60): Float32Array => {
  const e = new Engine(48000);
  e.load(p);
  e.noteOn(note);
  const l = new Float32Array(frames);
  e.render(l, new Float32Array(frames));
  return l;
};

describe('assemblies', () => {
  it('groups a selection, exposing the ports with outside cables, and hides the members', () => {
    const { p, osc, env, vca } = voice();
    const a = makeAssembly(p, [osc, env, vca], 'operator');
    expect(a.label).toBe('operator');
    expect(a.inputs.map((r) => `${r.module}.${r.port}=${r.label}`)).toEqual([`${osc}.pitch=pitch`, `${env}.gate=gate`]);
    expect(a.outputs).toEqual([{ module: vca, port: 'out', label: 'out' }]);
    expect(hiddenModules(p)).toEqual(new Set([osc, env, vca]));
    expect(p.modules).toHaveLength(5); // the patch is still flat
    expect(p.cables).toHaveLength(5);
    const b = makeAssembly(voice().p, [2, 3, 4], 'operator');
    expect(b.label).toBe('operator'); // labels are unique per patch, not globally
  });

  it('refuses the panel, the output, modules already grouped and an empty selection', () => {
    const { p, kb, osc, env, vca, out } = voice();
    expect(() => makeAssembly(p, [kb, osc])).toThrow(/Main panel/);
    expect(() => makeAssembly(p, [vca, out])).toThrow(/Output/);
    expect(() => makeAssembly(p, [])).toThrow(/select/);
    makeAssembly(p, [osc]);
    expect(() => makeAssembly(p, [osc, env])).toThrow(/already in/);
  });

  it('groups assemblies alone into a new one, at top level or inside their parent', () => {
    const { p, osc, env, vca } = voice();
    const a = makeAssembly(p, [osc], 'a');
    const b = makeAssembly(p, [env], 'b');
    const c = makeAssembly(p, [], 'pair', [a.id, b.id]);
    expect(c.modules).toEqual([]);
    expect(c.children).toEqual([a.id, b.id]);
    expect(parentOf(p, a.id)).toBe(c);
    expect(allModules(p, c).sort()).toEqual([osc, env].sort());
    const q = voice().p;
    const outer = makeAssembly(q, [osc, env, vca], 'voice');
    const x = makeAssembly(q, [osc], 'x');
    const y = makeAssembly(q, [env], 'y');
    expect(parentOf(q, x.id)).toBe(outer);
    const pair = makeAssembly(q, [], 'pair', [x.id, y.id]);
    expect(parentOf(q, pair.id)).toBe(outer);
    expect(outer.children).toEqual([pair.id]);
    expect(pair.children).toEqual([x.id, y.id]);
  });

  it('a row or jack shown from a nested assembly keeps the label that assembly gave it', () => {
    const { p, osc, env } = voice();
    const a = makeAssembly(p, [osc], 'a');
    const b = makeAssembly(p, [env], 'b');
    promote(a, osc, 'coarse');
    a.params.find((r) => r.param === 'coarse')!.label = 'hold pitch';
    findRef(b, 'out', env, 'env')!.label = 'contour';
    const outer = makeAssembly(p, [], 'pair', [a.id, b.id]);
    promote(outer, osc, 'coarse', p);
    expect(outer.params.find((r) => r.param === 'coarse')!.label).toBe('hold pitch');
    // the envelope's cable to the VCA crosses both frames: the outer jack comes from reconcile
    expect(findRef(outer, 'out', env, 'env')!.label).toBe('contour');
    // a row picked straight from a member module still takes the parameter's name
    const q = voice();
    const c = makeAssembly(q.p, [q.osc], 'c');
    promote(c, q.osc, 'coarse', q.p);
    expect(c.params.find((r) => r.param === 'coarse')!.label).toBe('coarse');
  });

  it('a row promoted from a nested assembly goes under "<its label> <its page there>", in one block per heading', () => {
    const { p, osc, env } = voice();
    const lire = makeAssembly(p, [osc], 'Lire');
    const elv = makeAssembly(p, [env], 'Elvira');
    lire.params = [
      { module: osc, param: 'wave', label: 'shape' },
      { module: osc, param: 'coarse', label: 'hold', head: '1-4' },
      { module: osc, param: 'fine', label: 'hold', head: '5-8' },
      { module: osc, param: 'pw', label: 'width' },
    ];
    elv.params = [{ module: env, param: 'a', label: 'attack', head: 'voice 1' }];
    const top = makeAssembly(p, [], 'pair', [lire.id, elv.id]);
    promote(top, osc, 'fine', p);
    promote(top, env, 'a', p);
    promote(top, osc, 'pw', p);      // joins "Lire 5-8", before the Elvira block
    promote(top, osc, 'coarse', p);  // "hold" again, under its own heading: no "hold 2"
    promote(top, osc, 'wave', p);    // above Lire's first heading: just "Lire"
    expect(top.params.map((r) => [r.label, r.head])).toEqual([
      ['hold', 'Lire 5-8'], ['width', undefined], ['attack', 'Elvira voice 1'], ['hold', 'Lire 1-4'], ['shape', 'Lire'],
    ]);
    // one more level up, the names stack
    const { p: q, osc: o2 } = voice();
    const inner = makeAssembly(q, [o2], 'Lire');
    inner.params = [{ module: o2, param: 'fine', label: 'hold', head: '5-8' }];
    const mid = makeAssembly(q, [], 'Pair', [inner.id]);
    promote(mid, o2, 'fine', q);
    const outer = makeAssembly(q, [], 'Top', [mid.id]);
    promote(outer, o2, 'fine', q);
    expect(outer.params).toEqual([{ module: o2, param: 'fine', label: 'hold', head: 'Pair Lire 5-8' }]);
  });

  it('the group switch bypasses every member and restores their own switches', () => {
    const p = emptyPatch();
    addModule(p, DEFS.fm1, 0, 0);
    const osc = addModule(p, DEFS.osc, 0, 0);
    const flt = addModule(p, DEFS.filter, 0, 0);
    const dly = addModule(p, DEFS.delay, 0, 0);
    connect(p, DEFS, { module: osc.id, port: 'out' }, { module: flt.id, port: 'in' });
    connect(p, DEFS, { module: flt.id, port: 'lp24' }, { module: dly.id, port: 'in' });
    const a = makeAssembly(p, [flt.id, dly.id], 'fx');
    dly.bypass = true; // off on its own
    expect(bypassAssembly(p, a, true).sort()).toEqual([flt.id]);
    expect(a.bypass).toBe(true);
    expect(a.kept).toEqual([dly.id]);
    expect(flt.bypass).toBe(true);
    expect(dly.bypass).toBe(true);
    const def = toDef(p, a); // a saved definition carries the members' own switches, not the group's
    expect(def.modules.map((m) => !!m.bypass)).toEqual([false, true]);
    expect(bypassAssembly(p, a, false)).toEqual([flt.id]);
    expect(a.bypass).toBeUndefined();
    expect(a.kept).toBeUndefined();
    expect(flt.bypass).toBeUndefined();
    expect(dly.bypass).toBe(true);
    expect(validatePatch(JSON.parse(JSON.stringify(p)), DEFS).modules.filter((m) => m.bypass).length).toBe(1);
  });

  it('a switched-off group stays switched off through save and load, and comes back on afterwards', () => {
    const p = emptyPatch();
    addModule(p, DEFS.fm1, 0, 0);
    const osc = addModule(p, DEFS.osc, 0, 0);
    const flt = addModule(p, DEFS.filter, 0, 0);
    const dly = addModule(p, DEFS.delay, 0, 0);
    connect(p, DEFS, { module: osc.id, port: 'out' }, { module: flt.id, port: 'in' });
    connect(p, DEFS, { module: flt.id, port: 'lp24' }, { module: dly.id, port: 'in' });
    makeAssembly(p, [flt.id, dly.id], 'fx');
    dly.bypass = true; // off on its own
    bypassAssembly(p, p.assemblies![0], true);
    const q = validatePatch(JSON.parse(JSON.stringify(p)), DEFS);
    expect(fixAssemblies(q, DEFS)).toEqual([]); // what the editor runs on every patch it opens
    const a = q.assemblies![0];
    expect(a.bypass).toBe(true); // the card's switch still reads off: it was lost on load, which left the members stuck off
    expect(a.kept).toEqual([dly.id]);
    bypassAssembly(q, a, false);
    expect(q.modules.find((m) => m.id === flt.id)!.bypass).toBeUndefined();
    expect(q.modules.find((m) => m.id === dly.id)!.bypass).toBe(true);
  });

  it('does not change the sound or the binary beyond the device pages: engine and FM-1 see the flat patch', () => {
    const { p, osc, env, vca } = voice();
    const before = render(p);
    const bin = engineBytes(p);
    makeAssembly(p, [osc, env, vca], 'operator');
    expect(render(p)).toEqual(before);
    expect(engineBytes(p)).toEqual(bin);
    const json = JSON.parse(JSON.stringify(p)) as Patch;
    expect(json.assemblies).toHaveLength(1);
    // an editor without assemblies: validatePatch keeps the field, the modules are plain
    expect(validatePatch(json, DEFS).modules).toHaveLength(5);
  });

  it('exposes and hides ports, promotes parameters, and keeps labels unique', () => {
    const { p, osc, env, vca } = voice();
    const a = makeAssembly(p, [osc, env, vca], 'operator');
    exposePort(a, 'in', osc, 'pm');
    exposePort(a, 'in', osc, 'pm'); // twice is once
    expect(a.inputs.map((r) => r.label)).toEqual(['pitch', 'gate', 'pm']);
    expect(() => hidePort(p, a, 'in', osc, 'pitch')).toThrow(/cable from outside/);
    hidePort(p, a, 'in', osc, 'pm');
    expect(a.inputs).toHaveLength(2);
    promote(a, osc, 'level');
    promote(a, vca, 'gain');
    a.params[1].label = 'level';
    reconcileAll(p, DEFS);
    expect(a.params.map((r) => r.label)).toEqual(['level', 'level']); // labels are the user's: not renamed behind their back
    promote(a, env, 'a');
    expect(a.params[2].label).toBe('a');
  });

  it('follows the patch: a new outside cable exposes its port, a removed member leaves, an empty assembly goes', () => {
    const { p, kb, osc, env, vca } = voice();
    const a = makeAssembly(p, [osc, env, vca], 'operator');
    connect(p, DEFS, { module: kb, port: 'vel' }, { module: vca, port: 'p1' });
    reconcileAll(p, DEFS);
    // a routed pin is never a card input: the parameters it feeds are promoted, and the cable shows on their sliders
    const routed = p.modules.find((m) => m.id === vca)!.map!.p1;
    expect(routed.length).toBeGreaterThan(0);
    expect(a.inputs.some((r) => r.module === vca && r.port === 'p1')).toBe(false);
    for (const param of routed) expect(a.params).toContainEqual({ module: vca, param, label: longName('vca', param) });
    removeModule(p, vca);
    reconcileAll(p, DEFS);
    expect(a.modules).toEqual([osc, env]);
    expect(a.outputs).toEqual([]); // the vca's out is gone; the osc's out now leaves the assembly? no: the cable went with the vca
    removeModule(p, osc);
    removeModule(p, env);
    expect(reconcileAll(p, DEFS)).toEqual(['operator']);
    expect(p.assemblies).toBeUndefined();
  });

  it('adds and removes members, recomputing the boundary', () => {
    const { p, osc, env, vca } = voice();
    const a = makeAssembly(p, [osc, env], 'pair');
    expect(a.outputs.map((r) => r.port)).toEqual(['out', 'env']);
    addMember(p, a, vca);
    expect(a.outputs).toEqual([{ module: vca, port: 'out', label: 'out' }]); // osc.out and env.env are inside now
    removeMember(p, a, env);
    expect(a.inputs.map((r) => `${r.module}.${r.port}`)).toEqual([`${osc}.pitch`, `${vca}.cv`]);
    expect(boundary(p, [osc, vca]).outputs).toEqual([{ module: vca, port: 'out' }]);
    removeMember(p, a, osc);
    removeMember(p, a, vca);
    expect(p.assemblies).toBeUndefined();
  });

  it('ungroup keeps the modules, delete removes them with their cables', () => {
    const { p, osc, env, vca } = voice();
    const a = makeAssembly(p, [osc, env, vca], 'operator');
    ungroup(p, a.id);
    expect(p.assemblies).toBeUndefined();
    expect(p.modules).toHaveLength(5);
    const b = makeAssembly(p, [osc, env, vca], 'operator');
    deleteAssembly(p, b.id);
    expect(p.modules.map((m) => m.type)).toEqual(['fm1', 'output']);
    expect(p.cables).toEqual([]);
  });

  it('keeps macro ranges and their sound through save and repeated insertion', () => {
    const { p, osc, env, vca } = voice();
    const macro = addModule(p, DEFS.macro, 0, 0);
    macro.params.value = 0.25;
    const amp = p.modules.find(m => m.id === vca)!;
    amp.map!.p1 = ['gain'];
    amp.range = { p1: { gain: [0.1, 0.5] } };
    connect(p, DEFS, { module: macro.id, port: 'out' }, { module: vca, port: 'p1' });
    const a = makeAssembly(p, [osc, env, vca, macro.id], 'ranged voice');
    const def = validateAssemblyDef(JSON.parse(JSON.stringify(toDef(p, a))), DEFS);
    const q = emptyPatch();
    const main = addModule(q, DEFS.fm1, 0, 0);
    const output = addModule(q, DEFS.output, 0, 0);
    const b = insertAssembly(q, DEFS, def, 0, 0);
    for (const r of b.inputs) {
      if (r.port === 'pitch' || r.port === 'gate')
        connect(q, DEFS, { module: main.id, port: r.port }, r);
    }
    connect(q, DEFS, b.outputs[0], { module: output.id, port: 'l' });
    const inserted = q.modules.find(m => m.type === 'vca')!;
    expect(inserted.range).toEqual(amp.range);
    expect(render(q)).toEqual(render(p));
    const again = insertAssembly(q, DEFS, def, 600, 0);
    const second = q.modules.find(m => again.modules.includes(m.id) && m.type === 'vca')!;
    inserted.range!.p1!.gain[0] = 0.4;
    expect(second.range).toEqual(amp.range);
    expect(def.modules.find(m => m.type === 'vca')!.range).toEqual(amp.range);
  });

  it('saves to a definition with local ids and no knob assignments, and inserts it with fresh ids', () => {
    const { p, kb, osc, env, vca, out } = voice();
    const a = makeAssembly(p, [osc, env, vca], 'operator');
    exposePort(a, 'in', osc, 'pm');
    promote(a, osc, 'coarse');
    a.params[0].label = 'ratio';
    p.modules.find((m) => m.id === osc)!.map!.k1 = ['coarse'];
    p.modules.find((m) => m.id === osc)!.params.coarse = 12;
    const def = validateAssemblyDef(JSON.parse(JSON.stringify(toDef(p, a))), DEFS);
    expect(def.modules.map((m) => m.id)).toEqual([1, 2, 3]);
    expect(def.modules[0].map!.k1).toEqual([]);
    expect(def.modules[0].map!.p1).toEqual(['wave']); // p1 / p2 are kept
    expect(Math.min(...def.modules.map((m) => m.x))).toBe(0);
    expect(def.cables).toHaveLength(2); // osc->vca, env->vca; the outside ones are not part of it
    expect(def.inputs.map((r) => r.label)).toEqual(['pitch', 'gate', 'pm']);
    expect(def.params).toEqual([{ module: 1, param: 'coarse', label: 'ratio' }]);

    const q = emptyPatch('q');
    const kb2 = addModule(q, DEFS.fm1, 0, 0).id;
    const b = insertAssembly(q, DEFS, def, 300, 40);
    expect(q.modules).toHaveLength(4);
    expect(b.modules.every((id) => id > kb2)).toBe(true);
    expect(q.modules.find((m) => m.type === 'osc')!.params.coarse).toBe(12);
    expect(q.modules.find((m) => m.type === 'osc')!.x).toBe(300);
    expect(b.inputs.map((r) => r.label)).toEqual(['pitch', 'gate', 'pm']);
    expect(b.open).toBe(false);
    // wiring the container: cables go to the inner ports
    expect(connect(q, DEFS, { module: kb2, port: 'pitch' }, { module: b.inputs[0].module, port: b.inputs[0].port })).toBe(true);
    const c = insertAssembly(q, DEFS, def, 600, 40);
    expect(c.label).toBe('operator 2');
    expect(q.modules).toHaveLength(7);
    void kb;
    void out;
  });

  it('inserts past the FM-1 module limit (the budget meter counts it, the editor does not stop)', () => {
    const def = FACTORY.find((d) => d.name === 'voice')!;
    const p = emptyPatch();
    const out = addModule(p, DEFS.output, 0, 0);
    for (let i = 0; i < 13; i++) {
      const a = insertAssembly(p, DEFS, def, 0, 0);
      const o = a.outputs.find((r) => r.label === 'out')!;
      connect(p, DEFS, { module: o.module, port: o.port }, { module: out.id, port: 'l' }); // wired: unwired modules are never sent (device-compile.ts)
    }
    expect(p.modules).toHaveLength(66);
    expect(deviceBudget(p).over.map((i) => i.key)).toContain('modules');
  });

  it('a new patch is Main and Output, unwired, on the grid; the model still allows a bare patch', () => {
    const p = newPatch(DEFS);
    expect(p.modules.map((m) => m.type)).toEqual(['fm1', 'output']);
    expect(p.cables).toEqual([]);
    expect(p.modules[1].x).toBeGreaterThan(p.modules[0].x + 500);
    expect(emptyPatch().modules).toEqual([]);
  });

  it('a file saved under the upstream format name (modular-1-assembly) still loads, as a matryoshka-assembly', () => {
    const { p, osc, vca } = voice();
    const raw = { format: 'modular-1-assembly', version: 1, name: 'old', modules: p.modules.filter((m) => m.id === osc || m.id === vca).map((m) => ({ ...m })),
      cables: [], inputs: [], outputs: [{ label: 'out', module: vca, port: 'out' }], params: [] };
    expect(validateAssemblyDef(raw, DEFS).format).toBe('matryoshka-assembly');
    expect(() => validateAssemblyDef({ ...raw, format: 'something-else' }, DEFS)).toThrow('not a Matryoshka assembly');
  });

  it('a definition with the Main panel or the Output loses them on load (their cables, ports and parameters too)', () => {
    const { p, kb, osc, env, vca, out } = voice();
    const raw = {
      format: 'matryoshka-assembly',
      version: 1,
      name: 'with io',
      modules: p.modules.map((m) => ({ ...m })),
      cables: p.cables.map((c) => ({ ...c })),
      inputs: [{ label: 'gate', module: env, port: 'gate' }, { label: 'pitch', module: kb, port: 'pitch' }],
      outputs: [{ label: 'out', module: vca, port: 'out' }, { label: 'l', module: out, port: 'l' }],
      params: [{ label: 'cut', module: osc, param: 'level' }, { label: 'vol', module: out, param: 'level' }],
    };
    expect(stripPatchIO(JSON.parse(JSON.stringify(raw))) as number).toBe(2);
    const d = validateAssemblyDef(JSON.parse(JSON.stringify(raw)), DEFS);
    expect(d.modules.map((m) => m.type)).not.toContain('fm1');
    expect(d.modules.map((m) => m.type)).not.toContain('output');
    expect(d.cables.every((c) => c.from.module !== kb && c.to.module !== out)).toBe(true);
    expect(d.inputs.map((r) => r.label)).toEqual(['gate']);
    expect(d.outputs.map((r) => r.label)).toEqual(['out']);
    expect(d.params.map((r) => r.label)).toEqual(['cut']);
    expect(() => validateAssemblyDef({ format: 'matryoshka-assembly', version: 1, name: 'io only', modules: [{ id: 1, type: 'fm1', x: 0, y: 0, params: {} }], cables: [], inputs: [], outputs: [], params: [] }, DEFS)).toThrow(/at least one module/);
  });

  it('every factory assembly sits on one of the browser shelves', () => {
    for (const d of FACTORY) expect((CATEGORIES as readonly string[]).includes(d.category ?? ''), d.name).toBe(true);
    expect(categoryOf({ ...FACTORY[0], category: undefined })).toBe(CATEGORIES[CATEGORIES.length - 1]);
    expect(FACTORY.filter((d) => categoryOf(d) === 'Drums').map((d) => d.name)).toContain('kick');
  });

  it('ships factory assemblies that load, insert and play', () => {
    expect(FACTORY.map((d) => d.name)).toEqual([
      '8 Lire', 'adsr operator', 'Algo Four', 'auto pan', 'barber pole', 'basic poly', 'boom kick', 'bowed glass', 'bowed string', 'Briefcase 3', 'Canvas', 'Cassia 1', 'clap', 'clock', 'cloud', 'cowbell', 'drift poly', 'drum kit', 'echo', 'Elvira 2', 'Expander S', 'filter voice', 'fm pair', 'gamelan', 'glass bell', 'hats', 'Hera 6', 'hihat', 'Io 4', 'kalimba', 'kick', 'marimba', 'Meridian 8', 'mono lead', 'Monolith D', 'noise voice', 'operator', 'Oracle V', 'Perun 4', 'pluck', 'rain', 'random melody', 'resonator bank', 'reverse pad', 'rim', 'Sallen 20', 'Scrounge', 'shimmer', 'sidechain pump', 'Silver Box', 'slicer', 'snare', 'Spokes 6', 'stack voice', 'step sequencer', 'stutter', 'sub bass', 'supersaw stack', 'tabla', 'talking filter', 'time smear', 'tom', 'Vernon 100', 'vibrato', 'voice', 'vowel voice', 'Wanderer', 'wavetable pad',
    ]);
    for (const d of FACTORY) {
      expect(d.modules.every((m) => m.map === undefined || ['k1', 'k2', 'k3', 'k4'].every((k) => m.map![k as 'k1'].length === 0)), d.name).toBe(true);
      expect(d.inputs.length + d.outputs.length, d.name).toBeGreaterThan(0);
      expect(d.params.length, d.name).toBeGreaterThan(0);
      expect(new Set(d.inputs.map((r) => r.label)).size, d.name).toBe(d.inputs.length); // no duplicate jack labels: the gates are merged
    }
    // every assembly with a pitch or gate input and an audio output plays from the panel; the others put out a moving signal
    for (const d of FACTORY) {
      const p = emptyPatch('f');
      const kb = addModule(p, DEFS.fm1, 0, 0).id;
      const out = addModule(p, DEFS.output, 0, 0).id;
      p.modules[1].params.level = 1;
      const a = insertAssembly(p, DEFS, d, 0, 0);
      const inp = (label: string) => a.inputs.find((r) => r.label === label);
      const feed = (from: string, label: string): void => {
        const r = inp(label);
        if (r) for (const t of targetsOf(r)) expect(connect(p, DEFS, { module: kb, port: from }, t), `${d.name} ${label}`).toBe(true);
      };
      feed('pitch', 'pitch');
      feed('gate', 'gate');
      feed('keys', 'keys');
      if (inp('in')) {
        // a held key is a steady signal to pan / smear / shift: at a quarter, so a dense granular cloud of it stays below the clamp
        const sc = addModule(p, DEFS.scale, 0, 0);
        sc.params.gain = 0.25;
        connect(p, DEFS, { module: kb, port: 'gate' }, { module: sc.id, port: 'in' });
        for (const t of targetsOf(inp('in')!)) expect(connect(p, DEFS, { module: sc.id, port: 'out' }, t), `${d.name} in`).toBe(true);
      }
      const o = a.outputs.find((r) => ['out', 'l', 'pitch', 'clock'].includes(r.label))!;
      expect(connect(p, DEFS, o, { module: out, port: 'l' }), d.name).toBe(true);
      const l = render(p, 24000, d.name === 'drum kit' ? 36 : d.name === 'Perun 4' || d.name === 'Spokes 6' ? 53 : 60); // (the kit's kick is General MIDI's 36; Perun 4's four voices and Spokes 6's drums are F3..B3)
      if (inp('gate') || inp('keys') || o.label !== 'out') expect(Math.max(...Array.from(l).map(Math.abs)), d.name).toBeGreaterThan(0.05);
      // all of them: a finite output, nothing stuck at the clamp
      expect(l.every((v) => Number.isFinite(v)), d.name).toBe(true);
      if (o.label === 'out' || o.label === 'l') expect(l.filter((v) => Math.abs(v) >= 1).length, d.name).toBeLessThan(l.length / 20); // a clock is a square at +-1 by design
    }
  }, 30_000); // renders every factory assembly: slow under coverage on the CI runner

  it('keeps a Steps track\'s name and notes through a definition', () => {
    const p = emptyPatch('t');
    const st = addModule(p, DEFS.steps, 0, 0);
    st.name = 'BASS';
    st.notes = [{ at: 0, len: 3, note: 40, vel: 77 }, { at: 0, len: 1, note: 47, vel: 77, chance: 35 }];
    const a = makeAssembly(p, [st.id], 'track');
    const again = insertAssembly(p, DEFS, validateAssemblyDef(JSON.parse(JSON.stringify(toDef(p, a))), DEFS), 2000, 0);
    const copy = p.modules.find((m) => again.modules.includes(m.id) && m.type === 'steps')!;
    expect([copy.name, copy.notes]).toEqual(['BASS', st.notes]);
  });

  it('the drum kit (#137): keys into a Drum map; its row names go through a definition; a Steps track plays it on PLAY', () => {
    const kit = FACTORY.find((d) => d.name === 'drum kit')!;
    const p = emptyPatch('f');
    addModule(p, DEFS.fm1, 0, 0);
    const out = addModule(p, DEFS.output, 0, 0).id;
    const a = insertAssembly(p, DEFS, kit, 0, 0);
    const map = p.modules.find((m) => m.type === 'drummap')!;
    expect(a.inputs.map((r) => r.label)).toEqual(['keys']);
    map.names = ['BOOM', '', '', '', '', '', '', ''];
    const again = insertAssembly(p, DEFS, validateAssemblyDef(JSON.parse(JSON.stringify(toDef(p, a))), DEFS), 2000, 0);
    expect(p.modules.find((m) => again.modules.includes(m.id) && m.type === 'drummap')!.names).toEqual(map.names);
    const st = addModule(p, DEFS.steps, 0, 0);
    st.notes = [{ at: 0, len: 1, note: 36, vel: 100 }, { at: 4, len: 1, note: 38, vel: 100 }, { at: 2, len: 1, note: 42, vel: 100 }];
    for (const t of targetsOf(a.inputs[0])) expect(connect(p, DEFS, { module: st.id, port: 'keys' }, t)).toBe(true);
    expect(connect(p, DEFS, a.outputs.find((r) => r.label === 'out')!, { module: out, port: 'l' })).toBe(true);
    const e = new Engine(48000);
    e.load(p);
    const quiet = new Float32Array(9600);
    e.render(quiet, new Float32Array(9600));
    expect(Math.max(...Array.from(quiet).map(Math.abs))).toBe(0); // (nothing until PLAY)
    e.transport(true);
    const l = new Float32Array(48000);
    e.render(l, new Float32Array(48000));
    expect(Math.max(...Array.from(l).map(Math.abs))).toBeGreaterThan(0.05);
  });

  it('the drum kit follows each note\'s velocity: half the velocity, half the level', () => {
    const kit = FACTORY.find((d) => d.name === 'drum kit')!;
    const peak = (vel: number): number => {
      const p = emptyPatch('v');
      addModule(p, DEFS.fm1, 0, 0);
      const out = addModule(p, DEFS.output, 0, 0).id;
      const a = insertAssembly(p, DEFS, kit, 0, 0);
      const st = addModule(p, DEFS.steps, 0, 0);
      st.notes = [{ at: 0, len: 1, note: 36, vel }];
      for (const t of targetsOf(a.inputs[0])) connect(p, DEFS, { module: st.id, port: 'keys' }, t);
      connect(p, DEFS, a.outputs.find((r) => r.label === 'out')!, { module: out, port: 'l' });
      const e = new Engine(48000);
      e.load(p);
      e.transport(true);
      const l = new Float32Array(24000);
      e.render(l, new Float32Array(l.length));
      return Math.max(...Array.from(l).map(Math.abs));
    };
    expect(peak(50) / peak(100)).toBeCloseTo(50 / 100, 2);
    const vca = kit.modules.filter((m) => m.type === 'vca' && kit.cables.some((c) => c.to.module === m.id && c.to.port === 'cv' && /^v\d$/.test(c.from.port)));
    expect(vca).toHaveLength(7);
  });

  it('rejects bad definitions', () => {
    expect(() => validateAssemblyDef({ format: 'x' }, DEFS)).toThrow(/not a Matryoshka assembly/);
    const base = FACTORY[0];
    expect(() => validateAssemblyDef({ ...base, modules: [{ id: 1, type: 'fm1', x: 0, y: 0, params: {} }], cables: [] }, DEFS)).toThrow(/at least one module/) /* the Main panel is stripped, nothing is left */;
    expect(() => validateAssemblyDef({ ...base, inputs: [{ module: 1, port: 'nope' }] }, DEFS)).toThrow(/does not exist/);
    expect(() => validateAssemblyDef({ ...base, params: [{ module: 1, param: 'nope' }] }, DEFS)).toThrow(/does not exist/);
  });

  it('drops an inconsistent overlay on load and keeps the modules', () => {
    const { p, osc, env, vca } = voice();
    makeAssembly(p, [osc, env, vca], 'operator');
    const raw = JSON.parse(JSON.stringify(p)) as Patch;
    raw.assemblies!.push({ ...raw.assemblies![0], id: 2, label: 'ghost', modules: [99] });
    raw.assemblies!.push({ ...raw.assemblies![0], id: 3, label: 'twice', modules: [osc] });
    const q = validatePatch(raw, DEFS);
    const msgs = fixAssemblies(q, DEFS);
    expect(msgs).toEqual(['assembly "ghost" dropped: module 99 is missing', `assembly "twice" dropped: module ${osc} is in two assemblies`]);
    expect(q.assemblies).toHaveLength(1);
    expect(q.modules).toHaveLength(5);
    // no overlay at all is fine, and so is every factory preset
    for (const make of Object.values(PRESETS)) expect(fixAssemblies(make(), DEFS)).toEqual([]);
  });

  it('tiles stacked members when they would open on top of each other; factory assemblies are laid out', () => {
    const { p, osc, env, vca } = voice();
    const a = makeAssembly(p, [osc, env, vca], 'operator');
    expect(overlapping(p, a)).toBe(false);
    for (const m of p.modules) if (a.modules.includes(m.id)) m.x = m.y = 50;
    expect(overlapping(p, a)).toBe(true);
    tileMembers(p, a);
    expect(overlapping(p, a)).toBe(false);
    expect(p.modules.filter((m) => a.modules.includes(m.id)).map((m) => [m.x, m.y])).toEqual([[50, 50], [370, 50], [690, 50]]);
    for (const d of FACTORY) {
      const q = emptyPatch();
      expect(overlapping(q, insertAssembly(q, DEFS, d, 0, 0))).toBe(false);
    }
  });

  // ---- merged ports, placement, nesting

  /** panel, two envelopes on one VCA, output */
  function twoEnv(): { p: Patch; kb: number; e1: number; e2: number; vca: number; osc: number } {
    const p = emptyPatch('t');
    const kb = addModule(p, DEFS.fm1, 0, 0).id;
    const osc = addModule(p, DEFS.osc, 300, 0).id;
    const e1 = addModule(p, DEFS.adsr, 300, 300).id;
    const e2 = addModule(p, DEFS.adsr, 600, 300).id;
    const vca = addModule(p, DEFS.vca, 600, 0).id;
    const c = (a: number, ap: string, b: number, bp: string): void => {
      expect(connect(p, DEFS, { module: a, port: ap }, { module: b, port: bp })).toBe(true);
    };
    c(kb, 'pitch', osc, 'pitch');
    c(osc, 'out', vca, 'in');
    c(e1, 'env', vca, 'cv');
    c(e2, 'env', vca, 'p1');
    return { p, kb, e1, e2, vca, osc };
  }

  it('merges two exposed inputs into one jack, keeps it through save / insert, and splits it again', () => {
    const { p, kb, e1, e2, vca, osc } = twoEnv();
    const a = makeAssembly(p, [osc, e1, e2, vca], 'voice');
    exposePort(a, 'in', e1, 'gate');
    exposePort(a, 'in', e2, 'gate');
    expect(a.inputs.map((r) => r.label)).toEqual(['pitch', 'gate', 'gate 2']);
    mergePorts(p, a, DEFS, { module: e1, port: 'gate' }, { module: e2, port: 'gate' });
    expect(a.inputs.map((r) => r.label)).toEqual(['pitch', 'gate']);
    expect(targetsOf(a.inputs[1])).toEqual([{ module: e1, port: 'gate' }, { module: e2, port: 'gate' }]);
    // a different kind cannot merge
    expect(() => mergePorts(p, a, DEFS, { module: osc, port: 'pitch' }, { module: e1, port: 'gate' })).toThrow(/cannot merge/);
    // a cable to every target: the group stays one port, and it cannot be hidden while wired
    for (const t of targetsOf(a.inputs[1])) connect(p, DEFS, { module: kb, port: 'gate' }, t);
    reconcileAll(p, DEFS);
    expect(a.inputs).toHaveLength(2);
    expect(() => hidePort(p, a, 'in', e2, 'gate')).toThrow(/cable from outside/);
    // save and insert carry the merge, with remapped ids
    const def = validateAssemblyDef(JSON.parse(JSON.stringify(toDef(p, a))), DEFS);
    expect(def.inputs[1].also).toEqual([{ module: 3, port: 'gate' }]);
    const q = emptyPatch('q');
    const b = insertAssembly(q, DEFS, def, 0, 0);
    const ts = targetsOf(b.inputs[1]);
    expect(ts).toHaveLength(2);
    expect(ts.every((t) => q.modules.some((m) => m.id === t.module && m.type === 'adsr'))).toBe(true);
    // split
    unmergePort(b, ts[0].module, 'gate');
    expect(b.inputs.map((r) => r.label)).toEqual(['pitch', 'gate', 'gate 2']);
    expect(b.inputs[1].also).toBeUndefined();
    // a member leaving takes its target out of the group; the group survives
    mergePorts(q, b, DEFS, ts[0], ts[1]);
    removeMember(q, b, ts[1].module);
    expect(b.inputs.find((r) => r.label === 'gate')!.also).toBeUndefined();
    // the factory voice has one merged gate
    const voiceDef = FACTORY.find((d) => d.name === 'voice')!;
    expect(voiceDef.inputs.map((r) => r.label)).toEqual(['pitch', 'gate']);
    expect(voiceDef.params.some((r) => r.param === 'cutoff')).toBe(true); // its "cutoff cv" pin became the cutoff slider
    expect(voiceDef.inputs[1].also).toHaveLength(1);
  });

  it('finds the first free grid cell for an inserted card', () => {
    expect(freeSpot([], 250, 540)).toEqual({ x: 20, y: 20 });
    const row = [0, 1, 2, 3].map((i) => ({ x: 20 + 320 * i, y: 20, w: 300, h: 300 }));
    expect(freeSpot(row, 250, 540)).toEqual({ x: 20, y: 580 });
    expect(freeSpot(row.slice(0, 2), 250, 540)).toEqual({ x: 660, y: 20 });
    // a card sitting off the grid blocks the cells it touches
    expect(freeSpot([{ x: 100, y: 100, w: 300, h: 300 }], 250, 540)).toEqual({ x: 660, y: 20 });
  });

  it('places a new card in view, nearest the origin, else the nearest cell outside (#175)', () => {
    const view = { x: 1000, y: 1500, w: 1300, h: 850 };
    const centre = { x: 1650, y: 1925 };
    // an empty view: the cell whose centre is nearest the view's, wholly inside it
    const a = freeSpotNear([], 300, 540, view, centre);
    expect(a).toEqual({ x: 1620, y: 1700 });
    // near the cursor instead
    expect(freeSpotNear([], 300, 540, view, { x: 2200, y: 1600 })).toEqual({ x: 1940, y: 1560 });
    // that cell taken: the next nearest, still in view and clear of the card
    const b = freeSpotNear([{ ...a, w: 300, h: 400 }], 300, 540, view, centre);
    expect(b.x === a.x && b.y === a.y).toBe(false);
    expect(b.x >= view.x && b.x + 300 <= view.x + view.w && b.y >= view.y && b.y + 540 <= view.y + view.h).toBe(true);
    // a full view: the free cell that needs the least scrolling (just right of it), on the grid
    const full = [{ x: view.x - 50, y: view.y - 50, w: view.w + 100, h: view.h + 100 }];
    const c = freeSpotNear(full, 300, 540, view, centre);
    expect((c.x - 20) % 320).toBe(0);
    expect((c.y - 20) % 140).toBe(0);
    expect(full.some((o) => o.x < c.x + 300 && o.x + o.w > c.x && o.y < c.y + 540 && o.y + o.h > c.y)).toBe(false);
    expect(c).toEqual({ x: 2580, y: 1700 });
    // a view shorter than the card: the cell whose top left lines up best with it
    expect(freeSpotNear([], 300, 540, { x: 0, y: 0, w: 1000, h: 300 }, { x: 500, y: 150 })).toEqual({ x: 340, y: 20 });
  });

  it('nests: a selection inside an expanded assembly becomes a child, with members, boundary and hiding through the levels', () => {
    const { p, kb, e1, e2, vca, osc } = twoEnv();
    const outer = makeAssembly(p, [osc, e1, e2, vca], 'voice');
    outer.open = true;
    const inner = makeAssembly(p, [e1, e2], 'envs');
    expect(parentOf(p, inner.id)).toBe(outer);
    expect(outer.modules).toEqual([osc, vca]);
    expect(outer.children).toEqual([inner.id]);
    expect(allModules(p, outer).sort()).toEqual([osc, e1, e2, vca].sort());
    expect(depthOf(p, inner)).toBe(2);
    // the child's boundary: both env outputs leave it (into the vca); the outer's boundary is unchanged
    expect(inner.outputs.map((r) => `${r.module}.${r.port}`)).toEqual([`${e1}.env`, `${e2}.env`]);
    expect(outer.outputs).toEqual([]);
    expect(outer.inputs.map((r) => r.port)).toEqual(['pitch']);
    // the parent may only show what the child exposes
    exposePort(outer, 'in', e1, 'gate');
    reconcileAll(p, DEFS);
    expect(outer.inputs.map((r) => r.port)).toEqual(['pitch']);
    exposePort(inner, 'in', e1, 'gate');
    exposePort(outer, 'in', e1, 'gate');
    reconcileAll(p, DEFS);
    expect(outer.inputs.map((r) => r.port)).toEqual(['pitch', 'gate']);
    // an outside cable to a deep module exposes it on both levels
    connect(p, DEFS, { module: kb, port: 'gate' }, { module: e2, port: 'gate' });
    reconcileAll(p, DEFS);
    expect(outer.inputs.map((r) => `${r.module}.${r.port}`)).toContain(`${e2}.gate`);
    expect(inner.inputs.map((r) => `${r.module}.${r.port}`)).toContain(`${e2}.gate`);
    // hiding: a collapsed parent hides everything, an expanded parent with a collapsed child hides the child's modules
    outer.open = false;
    expect(hiddenModules(p)).toEqual(new Set([osc, e1, e2, vca]));
    expect(hiddenAssemblies(p)).toEqual(new Set([inner.id]));
    outer.open = true;
    expect(hiddenModules(p)).toEqual(new Set([e1, e2]));
    expect(hiddenAssemblies(p).size).toBe(0);
    // cycles and double parents are refused; nesting has no depth limit
    expect(childProblem(p, inner, outer.id)).toMatch(/already inside/);
    expect(childProblem(p, outer, outer.id)).toMatch(/itself/);
    const third = makeAssembly(p, [vca], 'amp');
    expect(parentOf(p, third.id)).toBe(outer);
    expect(() => makeAssembly(p, [e1], 'deep')).not.toThrow(); // level 3
    expect(() => makeAssembly(p, [e1], 'deeper')).not.toThrow(); // level 4
    expect(() => addChild(p, third, inner.id)).not.toThrow();
  });

  it('nests by addChild / removeChild, moves, saves and inserts the tree, and ungroup / delete keep the children', () => {
    const { p, kb, e1, e2, vca, osc } = twoEnv();
    const envs = makeAssembly(p, [e1, e2], 'envs');
    const voice = makeAssembly(p, [osc, vca], 'voice');
    expect(voice.inputs.map((r) => r.port)).toEqual(['pitch', 'cv']);
    expect(voice.params.length).toBeGreaterThan(0); // the osc's p1 cable shows on a promoted slider
    addChild(p, voice, envs.id);
    expect(voice.children).toEqual([envs.id]);
    expect(voice.inputs.map((r) => r.port)).toEqual(['pitch']); // cv and p1 are fed from inside now
    expect(() => addChild(p, envs, voice.id)).toThrow(/already inside/);
    // moving the parent moves the child and its modules
    const before = p.modules.map((m) => [m.x, m.y]);
    moveAssembly(p, voice, 10, 20);
    expect([envs.x, envs.y]).toEqual([310, 320]);
    p.modules.forEach((m, i) => {
      if (m.id !== kb) expect([m.x, m.y]).toEqual([before[i][0] + 10, before[i][1] + 20]);
    });
    // save: nested assemblies with local ids
    exposePort(envs, 'in', e1, 'gate', [{ module: e2, port: 'gate' }]);
    exposePort(voice, 'in', e1, 'gate', envs.inputs[0].also);
    promote(envs, e1, 'a');
    promote(voice, e1, 'a');
    const def = validateAssemblyDef(JSON.parse(JSON.stringify(toDef(p, voice))), DEFS);
    expect(def.modules).toHaveLength(4);
    expect(def.assemblies).toHaveLength(1);
    expect(def.children).toEqual([1]);
    expect(def.assemblies![0].modules.sort()).toEqual([3, 4]);
    expect(def.inputs.find((r) => r.port === 'gate')!.also).toEqual([{ module: 4, port: 'gate' }]);
    expect(def.params).toContainEqual({ module: 3, param: 'a', label: 'a' }); // besides the routed pins' promoted sliders
    // insert: fresh ids, the tree rebuilt
    const q = emptyPatch('q');
    addModule(q, DEFS.fm1, 0, 0);
    const v2 = insertAssembly(q, DEFS, def, 300, 0);
    expect(q.assemblies).toHaveLength(2);
    const child = parentOf(q, q.assemblies!.find((a) => a.name === 'envs')!.id);
    expect(child).toBe(v2);
    expect(v2.inputs.map((r) => r.port)).toEqual(['pitch', 'gate']);
    expect(v2.params).toHaveLength(def.params.length);
    expect(hiddenModules(q).size).toBe(4);
    // a second insert gets unique labels for the nested one too
    insertAssembly(q, DEFS, def, 600, 0);
    expect(q.assemblies!.map((a) => a.label).sort()).toEqual(['envs', 'envs 2', 'voice', 'voice 2']);
    // a bad tree is refused
    expect(() => validateAssemblyDef({ ...def, children: [7] }, DEFS)).toThrow(/does not exist/);
    expect(() => validateAssemblyDef({ ...def, children: [] }, DEFS)).toThrow(/in no assembly/);
    // removeChild frees the child; ungroup of a parent hands its members to the grandparent; delete keeps children
    removeChild(p, voice, envs.id);
    expect(parentOf(p, envs.id)).toBeUndefined();
    expect(voice.inputs.map((r) => r.port)).toEqual(['pitch', 'cv']);
    addChild(p, voice, envs.id);
    const amp = makeAssembly(p, [vca], 'amp'); // child of voice
    ungroup(p, voice.id);
    expect(p.assemblies!.map((a) => a.name).sort()).toEqual(['amp', 'envs']);
    expect(parentOf(p, amp.id)).toBeUndefined();
    const v3 = makeAssembly(p, [osc], 'voice');
    addChild(p, v3, envs.id);
    deleteAssembly(p, v3.id);
    expect(p.modules.some((m) => m.id === osc)).toBe(false);
    expect(p.assemblies!.some((a) => a.id === envs.id)).toBe(true);
    expect(allModules(p, envs)).toEqual([e1, e2]);
  });

  it('repairs a bad nesting on load: missing children, two parents, loops and depth', () => {
    const { p, e1, e2, vca, osc } = twoEnv();
    const envs = makeAssembly(p, [e1, e2], 'envs');
    const voice = makeAssembly(p, [osc, vca], 'voice');
    addChild(p, voice, envs.id);
    const raw = JSON.parse(JSON.stringify(p)) as Patch;
    const ok = validatePatch(JSON.parse(JSON.stringify(raw)), DEFS);
    expect(fixAssemblies(ok, DEFS)).toEqual([]);
    expect(parentOf(ok, envs.id)!.id).toBe(voice.id);
    const loop = JSON.parse(JSON.stringify(raw)) as Patch;
    loop.assemblies!.find((a) => a.id === envs.id)!.children = [voice.id];
    const msgs = fixAssemblies(validatePatch(loop, DEFS), DEFS);
    expect(msgs.join(' ')).toMatch(/loop undone/);
    const missing = JSON.parse(JSON.stringify(raw)) as Patch;
    missing.assemblies!.find((a) => a.id === voice.id)!.children = [99];
    expect(fixAssemblies(validatePatch(missing, DEFS), DEFS).join(' ')).toMatch(/missing/);
  });
});

describe('assembly layout metadata', () => {
  it('round-trips collapsed and expanded sizes through patch and nested library files without changing firmware bytes', () => {
    const { p, osc, env, vca } = voice();
    const root = makeAssembly(p, [osc, env, vca], 'Voice');
    const child = makeAssembly(p, [osc], 'Source');
    const before = encodePatch(p);
    root.size = { width: 360, height: 240 }; root.frameSize = { width: 980, height: 720 };
    child.size = { width: 280, height: 180 }; child.frameSize = { width: 360, height: 640 };
    const restored = validatePatch(JSON.parse(JSON.stringify(p)), DEFS);
    fixAssemblies(restored, DEFS);
    expect(restored.assemblies?.map(a => [a.size, a.frameSize])).toEqual(p.assemblies?.map(a => [a.size, a.frameSize]));
    expect(encodePatch(p)).toEqual(before);
    const def = validateAssemblyDef(JSON.parse(JSON.stringify(toDef(p, root))), DEFS);
    const next = emptyPatch(); const inserted = insertAssembly(next, DEFS, def, 0, 0);
    expect(inserted.size).toEqual(root.size); expect(inserted.frameSize).toEqual(root.frameSize);
    expect(next.assemblies?.find(a => a.id !== inserted.id)?.size).toEqual(child.size);
  });
  it('drops invalid dimensions and bounds extreme imports', () => {
    const { p, osc } = voice(); const a = makeAssembly(p, [osc], 'Source');
    a.size = { width: -1, height: 90 }; a.frameSize = { width: 1e9, height: 1 };
    const restored = validatePatch(JSON.parse(JSON.stringify(p)), DEFS);
    fixAssemblies(restored, DEFS);
    expect(restored.assemblies?.[0].size).toBeUndefined();
    expect(restored.assemblies?.[0].frameSize).toEqual({ width: 4000, height: 80 });
  });
});

describe('assembly card columns and headings', () => {
  const rows = (...xs: (string | [string, { col?: true; head?: string; span?: number }])[]): ParamRef[] =>
    xs.map((x, i) => (typeof x === 'string' ? { module: i + 1, param: x, label: x } : { module: i + 1, param: x[0], label: x[0], ...x[1] }));
  const show = (list: ParamRef[]): string[] => list.map((r) => `${r.col ? '| ' : ''}${r.head ? `[${r.head}] ` : ''}${r.label}${r.span ? ` <${r.span}>` : ''}`);
  // a card's layout as text: `c:x y` = column c's stack, `{a-b ... X ...}` = the row X across columns a..b-1 with what is above and below it
  const plan = (list: ParamRef[]): string => {
    const cols = paramColumns(list).map((c) => c.map((i) => list[i]));
    const text = (bs: SpanBlock<ParamRef>[]): string => bs.map((b) => ('col' in b
      ? `${b.col}:${b.items.map((r) => r.label).join(' ')}`
      : `{${b.from}-${b.to} ${text(b.above)}${b.above.length ? ' ' : ''}${b.band.label.toUpperCase()}${b.below.length ? ' ' : ''}${text(b.below)}}`)).join(' ');
    return text(spanPlan(cols, (r) => r.span));
  };

  it('splits the rows into columns at the breaks', () => {
    expect(paramColumns(rows('a', 'b', ['c', { col: true }], 'd', ['e', { col: true }]))).toEqual([[0, 1], [2, 3], [4]]);
    expect(paramColumns([])).toEqual([[]]);
  });

  it('a removed row hands its break and heading to the next row; the nearer heading wins; none after it, they go', () => {
    const list = rows(['a', { head: 'A' }], ['b', { col: true, head: 'B' }], 'c', ['d', { head: 'D' }], ['e', { col: true }]);
    expect(show(keepParams(list, (r) => r.label !== 'b'))).toEqual(['[A] a', '| [B] c', '[D] d', '| e']);
    expect(show(keepParams(list, (r) => r.label !== 'c'))).toEqual(['[A] a', '| [B] b', '[D] d', '| e']);
    expect(show(keepParams(list, (r) => r.label !== 'e'))).toEqual(['[A] a', '| [B] b', 'c', '[D] d']);
    expect(show(keepParams(list, (r) => r.label !== 'a'))).toEqual(['[B] b', 'c', '[D] d', '| e']); // no break on the first row
  });

  it('a spanning row cuts the columns it covers: as many rows above as it has in its own column, the rest below', () => {
    // column 0: a b S(2) c | column 1: d e f g | column 2: h
    const list = rows('a', 'b', ['s', { span: 2 }], 'c', ['d', { col: true }], 'e', 'f', 'g', ['h', { col: true }]);
    expect(plan(list)).toBe('{0-2 0:a b 1:d e S 0:c 1:f g} 2:h');
    // full width; on the first row nothing is above it
    expect(plan(rows(['s', { span: 3 }], 'a', ['b', { col: true }], ['c', { col: true }]))).toBe('{0-3 S 0:a 1:b 2:c}');
    // a covered column shorter than the rows above leaves empty space; the band starts under the tallest stack
    expect(plan(rows('a', 'b', 'c', ['s', { span: 2 }], ['d', { col: true }]))).toBe('{0-2 0:a b c 1:d S}');
    // no span, or a span of one: plain columns
    expect(plan(rows('a', ['b', { col: true }]))).toBe('0:a 1:b');
  });

  it('spans nest and sit side by side; one at the card edge or partly over another is cut short to fit', () => {
    // side by side: columns 0-1 and 2-3
    expect(plan(rows(['s', { span: 2 }], ['a', { col: true }], ['t', { col: true, span: 2 }], ['b', { col: true }]))).toBe('{0-2 S 1:a} {2-4 T 3:b}');
    // nested: the wide one first, a narrower one under it inside its group
    expect(plan(rows(['s', { span: 3 }], 'a', ['t', { col: true }], ['u', { span: 2 }], ['b', { col: true }]))).toBe('{0-3 S 0:a {1-3 1:t 2:b U}}');
    // partly over: columns 0-1 and 1-2 in the same stretch; the second is cut at the first one's edge
    expect(plan(rows(['s', { span: 2 }], ['t', { col: true, span: 2 }], ['b', { col: true }]))).toBe('{0-2 S 1:t} 2:b');
    // the same span above the first one's band is inside its group too
    expect(plan(rows('a', ['s', { span: 2 }], ['t', { col: true, span: 2 }], ['b', { col: true }]))).toBe('{0-2 0:a 1:t S} 2:b');
    // past the right edge
    expect(plan(rows('a', ['b', { col: true, span: 5 }], 'c'))).toBe('0:a 1:b c');
    // a later span in the same column as an earlier one nests in its group (cut to it)
    expect(plan(rows(['s', { span: 2 }], ['t', { span: 3 }], ['a', { col: true }], ['b', { col: true }]))).toBe('{0-2 S {0-2 T 1:a}} 2:b');
  });

  it('a span belongs to its place when a row is taken off: the next row gets it', () => {
    const list = rows('a', ['s', { span: 2 }], 't', ['b', { col: true }]);
    expect(show(keepParams(list, (r) => r.label !== 's'))).toEqual(['a', 't <2>', '| b']);
    expect(show(keepParams(list, (r) => r.label !== 'a'))).toEqual(['s <2>', 't', '| b']);
    setSpan(list, 2, 3);
    setSpan(list, 1, 1);
    expect(show(list)).toEqual(['a', 's', 't <3>', '| b']);
  });

  it('sets and clears breaks and headings; never a break on the first row', () => {
    const list = rows('a', 'b');
    setColumnBreak(list, 0, true);
    setColumnBreak(list, 1, true);
    setHeading(list, 0, '  osc  ');
    expect(show(list)).toEqual(['[osc] a', '| b']);
    setHeading(list, 0, ' ');
    setColumnBreak(list, 1, false);
    expect(show(list)).toEqual(['a', 'b']);
    expect(moveRef(['x', 'y', 'z'], 0, 2, true)).toEqual(['y', 'z', 'x']);
    expect(moveRef(['x', 'y', 'z'], 2, 0, false)).toEqual(['z', 'x', 'y']);
  });

  it('demoting a row keeps its column; the layout survives save, load and insert, and reaches the binary only as pages', () => {
    const { p, osc, env, vca } = voice();
    const a = makeAssembly(p, [osc, env, vca], 'voice');
    for (const q of ['a', 'd', 's', 'r']) promote(a, env, q);
    promote(a, vca, 'gain');
    const before = engineBytes(p);
    setHeading(a.params, 0, 'env');
    setColumnBreak(a.params, 4, true);
    setHeading(a.params, 4, 'amp');
    expect(engineBytes(p)).toEqual(before);
    const def = validateAssemblyDef(JSON.parse(JSON.stringify(toDef(p, a))), DEFS);
    expect(show(def.params)).toEqual(['[env] a', 'd', 's', 'r', '| [amp] gain']);
    const next = emptyPatch();
    const b = insertAssembly(next, DEFS, def, 0, 0);
    expect(show(b.params)).toEqual(show(def.params));
    const loaded = validatePatch(JSON.parse(JSON.stringify(next)), DEFS);
    fixAssemblies(loaded, DEFS);
    expect(show(loaded.assemblies![0].params)).toEqual(show(def.params));
    demote(a, env, 'a');
    expect(show(a.params)).toEqual(['[env] d', 's', 'r', '| [amp] gain']);
    removeModule(p, vca);
    reconcileAll(p, DEFS);
    expect(show(a.params)).toEqual(['[env] d', 's', 'r']);
  });

  it('drops malformed layout fields on load', () => {
    const def = JSON.parse(JSON.stringify(FACTORY.find((d) => d.name === 'Oracle V')!));
    def.params[0].col = true;
    def.params[1].col = 'yes';
    def.params[2].head = 42;
    def.params[3].head = 'x'.repeat(100);
    const d = validateAssemblyDef(def, DEFS);
    expect(d.params[0].col).toBeUndefined();
    expect(d.params[1].col).toBeUndefined();
    expect(d.params[2].head).toBeUndefined();
    expect(d.params[3].head).toHaveLength(40);
    def.params[4].span = 1.5;
    def.params[5].span = 3;
    def.params[6].span = 999;
    const e = validateAssemblyDef(def, DEFS);
    expect(e.params[4].span).toBeUndefined();
    expect(e.params[5].span).toBe(3);
    expect(e.params[6].span).toBe(16);
  });

  it('the factory Oracle V has three sectioned columns and its output scope across the foot', () => {
    const d = FACTORY.find((x) => x.name === 'Oracle V')!;
    expect(paramColumns(d.params).map((c) => c.length)).toEqual([13, 10, 11]);
    expect(plan(d.params)).toMatch(/^\{0-3 0:.* 1:.* 2:.* OUT\}$/);
    // the drum kit's knobs in two columns
    const kit = FACTORY.find((x) => x.name === 'drum kit')!;
    expect(plan(kit.params)).toMatch(/^0:kick tune .* 1:.*$/);
    expect(d.params.filter((r) => r.head).map((r) => r.head)).toEqual(['voice', 'osc A', 'osc B', 'mixer', 'filter', 'amp', 'mod']);
  });
});

describe('several rows of an assembly card at once (#186)', () => {
  type Flags = { col?: true; head?: string; group?: true; span?: number };
  const rows = (...xs: (string | [string, Flags])[]): ParamRef[] =>
    xs.map((x, i) => (typeof x === 'string' ? { module: i + 1, param: x, label: x } : { module: i + 1, param: x[0], label: x[0], ...x[1] }));
  const show = (list: ParamRef[]): string[] =>
    list.map((r) => `${r.col ? '| ' : ''}${r.group ? '/ ' : ''}${r.head ? `[${r.head}] ` : ''}${r.label}${r.span ? ` <${r.span}>` : ''}`);
  const idx = (list: ParamRef[], ...labels: string[]): number[] => labels.map((l) => list.findIndex((r) => r.label === l));

  it('pick mode: one action on several rows shows them all if any is hidden, else hides them all', () => {
    const { p, osc, env } = voice();
    const a = makeAssembly(p, [osc, env], 'v');
    a.params = [];
    const r = (module: number, param: string) => ({ module, param });
    const sel = [r(osc, 'wave'), r(env, 'a'), r(env, 'd')];
    expect(pickState(a, sel)).toBe('none');
    promote(a, env, 'a');
    expect(pickState(a, sel)).toBe('some');
    expect(pickRows(a, sel)).toBe(true);
    expect(a.params.map((x) => x.param)).toEqual(['a', 'wave', 'd']); // the shown one stays where it is
    expect(pickState(a, sel)).toBe('all');
    promote(a, osc, 'level');
    a.params[1].head = 'H';
    pickRows(a, sel);
    expect(a.params).toEqual([{ module: osc, param: 'level', label: 'level', head: 'H' }]); // the heading stays at its place
    expect(pickRows(a, [])).toBe(false);
  });

  it('a Shift-click range runs either way in reading order', () => {
    const order = ['a', 'b', 'c', 'd'];
    expect(keyRange(order, 'b', 'd')).toEqual(['b', 'c', 'd']);
    expect(keyRange(order, 'd', 'b')).toEqual(['b', 'c', 'd']);
    expect(keyRange(order, null, 'c')).toEqual(['c']);
    expect(keyRange(order, 'x', 'c')).toEqual(['c']);
    expect(keyRange(order, 'a', 'x')).toEqual([]);
  });
});
