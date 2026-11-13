// SPDX-License-Identifier: GPL-3.0-only
import { reconcile, type AssemblyInst } from './assembly';
import { sharedFilterFactory } from './factory-paraphony';
import { DEFS } from './modules';
import { addModule, type Cable, type ModuleInst, type Patch } from './patch';

/**
 * Measurement-only shared filter AND shared amplitude, retaining the source's
 * playable allocator. Notes joining a held phrase have no independent amplitude
 * attack; releasing one while another is held cuts that pitch immediately.
 * On the last release the last sounding membership is retained for the common
 * release/hold. A new phrase replaces that membership before audio is summed.
 * Ordinary track-mode S&H starts at zero and reads the current Part gate and the
 * processed-key allocator in the same sample; no delayed last-off pulse is used.
 */
export function sharedArticulationFactory(source: Patch): Patch {
  const p = sharedFilterFactory(source);
  const voice = p.assemblies!.find(a => a.poly)!;
  const root = p.assemblies!.find(a => a.children?.includes(voice.id))!;
  const key = p.modules.find(m => m.name === 'shared key control')!;
  const module = (id: number): ModuleInst => p.modules.find(m => m.id === id)!;
  const remove = (match: (c: Cable) => boolean): void => { p.cables = p.cables.filter(c => !match(c)); };
  const wire = (from: number, out: string, to: number, input: string): void => {
    p.cables.push({ from: { module: from, port: out }, to: { module: to, port: input } });
  };
  const fresh = (type: string, name: string, owner: AssemblyInst = root): ModuleInst => {
    const m = addModule(p, DEFS[type], root.x + 320, root.y + 560);
    m.name = name;
    owner.modules.push(m.id);
    return m;
  };
  const move = (...ids: number[]): void => {
    voice.modules = voice.modules.filter(id => !ids.includes(id));
    for (const id of ids) if (!root.modules.includes(id)) root.modules.push(id);
  };
  const drop = (id: number): void => {
    p.modules = p.modules.filter(m => m.id !== id);
    remove(c => c.from.module === id || c.to.module === id);
    for (const a of p.assemblies!) a.modules = a.modules.filter(member => member !== id);
  };
  const copy = (id: number, name: string): ModuleInst => {
    const original = module(id);
    const m = fresh(original.type, name);
    Object.assign(m, structuredClone(original), { id: m.id, name, x: m.x, y: m.y });
    for (const c of [...p.cables]) if (c.to.module === id && c.to.port !== 'in' && c.to.port !== 'cv' && c.to.port !== 'gate') {
      wire(c.from.module, c.from.port, m.id, c.to.port);
    }
    return m;
  };
  const sharedGate = (allocator: number, targets: number[]): void => {
    for (const c of p.cables) if (c.from.module === allocator && c.from.port === 'gate' && targets.includes(c.to.module)) {
      c.from.module = key.id;
    }
  };

  const allocator = source.name === 'Oracle V' ? 6 : source.name === 'Hera 4' ? 7 : source.name === 'Expander S' ? 4 : 2;
  const localAmp = module(source.name === 'Oracle V' ? 15 : source.name === 'Io 4' ? 48 : 12);
  const originalAmp = structuredClone(localAmp);
  const mask = fresh('sh', 'phrase membership', voice);
  mask.params.mode = 1;
  wire(allocator, 'gate', mask.id, 'in');
  wire(key.id, 'gate', mask.id, 'clock');
  let membership = mask;

  // This is also a real group-boundary output of every mask. A latched one must
  // not become an idle/skipped voice merely because its oscillator is currently
  // silent: it must clear on the FIRST sample of a new phrase, even after edits.
  // Boolean presence avoids changing gain with chord size and prevents an unused
  // pitch from opening the common amp. Expander's intentional drone bypasses it.
  const presence = fresh('logic', 'phrase membership present');
  wire(mask.id, 'out', presence.id, 'a');
  const control = fresh('vca', 'shared amplitude control');
  wire(presence.id, 'or', control.id, 'cv');

  if (source.name === 'Oracle V') {
    move(14, 39, 42);
    module(14).name = 'shared amplitude envelope';
    sharedGate(6, [14]);
    for (const c of p.cables) if (c.from.module === 6 && c.from.port === 'vel' && c.to.module === 39) c.from.module = key.id;
    wire(42, 'out', control.id, 'in');
    // Poly-mod products remain per pitch, but membership rather than the now
    // shared amplitude contour excludes inactive oscillators from the CV sum.
    const polyMod = p.modules.find(m => m.name === 'active poly-mod sum')!;
    remove(c => c.to.module === polyMod.id && c.to.port === 'cv');
    wire(mask.id, 'out', polyMod.id, 'cv');
  } else if (source.name === 'Hera 4') {
    // Hera has one envelope for filter and amplitude, with no oscillator EG
    // modulation. Reuse it once rather than retain a dead per-note envelope or
    // two identical shared contours. Preserve the original hold + ENV/GATE path.
    const filterEnv = p.modules.find(m => m.name === 'shared filter envelope')!;
    const filterHold = p.modules.find(m => m.name === 'shared filter hold')!;
    for (const row of root.params) {
      if (row.module === filterEnv.id) row.module = 11;
      if (row.also) row.also = row.also.filter(t => t.module !== filterEnv.id);
    }
    drop(filterEnv.id);
    drop(filterHold.id);
    move(11, 41, 42);
    module(11).name = 'shared amplitude envelope';
    sharedGate(7, [11, 41]);
    wire(11, 'env', 33, 'in');
    wire(42, 'out', control.id, 'in');
  } else if (source.name === 'Expander S') {
    // Both original EGs remain audible oscillator modulation sources. Only the
    // amplitude copy and its selector move to the shared section.
    const env = copy(11, 'shared amplitude envelope');
    wire(key.id, 'gate', env.id, 'gate');
    for (const row of root.params) if (row.module === 11) {
      if (row.param === 'view') row.module = env.id;
      else row.also = [...(row.also ?? []), { module: env.id, param: row.param }];
    }
    if (!root.params.some(r => r.module === 11 && r.param === 'long')) {
      root.params.push({ module: 11, param: 'long', label: 'amp long', also: [{ module: env.id, param: 'long' }] });
    }
    move(25);
    remove(c => c.to.module === 25 && c.to.port === 'in1');
    wire(env.id, 'env', 25, 'in1');
    // Preserve literal VCA ON: all oscillator cards free-run, even without keys.
    // Its existing selector's gate output follows knob, morph and cable control;
    // use that rather than create a second independently editable mode control.
    membership = fresh('select', 'member or drone', voice);
    Object.assign(membership.params, { count: 2, pos: 1, v2: 1 });
    wire(mask.id, 'out', membership.id, 'in1');
    wire(25, 'g2', membership.id, 'pos');
    wire(25, 'g2', presence.id, 'b');
    wire(25, 'out', control.id, 'in');
  } else {
    const filterHold = p.modules.find(m => m.name === 'shared filter hold')!;
    drop(filterHold.id);
    move(47, 49);
    module(47).name = 'shared amplitude envelope';
    sharedGate(2, [49]);
    // Original shared hold logic uses the amplitude EG to avoid self-starting
    // from the HOLD switch; both filter and amplitude must hear the same gate.
    wire(49, 'or', 44, 'gate');
    wire(47, 'env', control.id, 'in');
  }

  const sharedAmp = (name: string): ModuleInst => {
    const m = fresh('vca', name);
    Object.assign(m, structuredClone(originalAmp), { id: m.id, name, x: m.x, y: m.y });
    for (const c of [...p.cables]) if (c.to.module === localAmp.id && c.to.port !== 'in' && c.to.port !== 'cv') {
      wire(c.from.module, c.from.port, m.id, c.to.port);
    }
    wire(control.id, 'out', m.id, 'cv');
    return m;
  };
  const left = sharedAmp(source.name === 'Expander S' ? 'shared amplitude left' : 'shared amplitude');
  const right = source.name === 'Expander S' ? sharedAmp('shared amplitude right') : left;
  // The former local audio VCA now ONLY gates membership. Move all its editable
  // gain/morph/modulation state to the post-filter shared amp, not the mask gate.
  remove(c => c.to.module === localAmp.id && c.to.port !== 'in');
  localAmp.params = { gain: 1 };
  delete localAmp.paramsB;
  delete localAmp.map;
  delete localAmp.att;
  delete localAmp.range;
  delete localAmp.inputMap;
  delete localAmp.bypass;
  localAmp.name = 'member audio';
  wire(membership.id, 'out', localAmp.id, 'cv');
  for (const row of root.params) {
    if (row.module === localAmp.id) {
      row.module = left.id;
      if (right !== left) row.also = [...(row.also ?? []), { module: right.id, param: row.param }];
    }
    for (const t of row.also ?? []) if (t.module === localAmp.id) t.module = left.id;
  }
  for (const head of root.heads ?? []) if (head.module === localAmp.id) head.module = left.id;
  // Do not expose the membership VCA as a second, differently functioning level.
  voice.params = voice.params.filter(row => row.module !== localAmp.id);

  const insert = (filter: number, port: string, amp: ModuleInst, downstream: number[]): void => {
    for (const c of p.cables) if (c.from.module === filter && c.from.port === port && downstream.includes(c.to.module)) {
      c.from = { module: amp.id, port: 'out' };
    }
    for (const out of root.outputs) if (out.module === filter && out.port === port) {
      out.module = amp.id; out.port = 'out';
    }
    wire(filter, port, amp.id, 'in');
  };
  if (source.name === 'Oracle V') insert(13, 'lp24', left, [65, 17]);
  else if (source.name === 'Hera 4') insert(10, 'lp24', left, [18]);
  else if (source.name === 'Expander S') {
    const bp = p.modules.find(m => m.name === 'shared right bandpass')!;
    insert(23, 'out', left, [30, 15]);
    insert(bp.id, 'out', right, [30]);
  } else insert(43, 'lp24', left, [55]);

  root.label = `${source.name} SHARED AMP`;
  root.name = root.label;
  voice.label = 'pitched members';
  p.name = root.label;
  p.notes = 'MEASUREMENT ONLY: shared filter and amplitude articulation. First held processed key attacks; overlapping notes join without an independent amp attack and lose their pitch immediately on release. Last-note membership sustains through common hold/release; a new phrase clears stale pitches. Original playable voice count and per-pitch oscillator modulation retained. Hold/pedal sustains the common phrase, not independently released overlapping notes. No CPU saving or hardware qualification claimed.'
    + (source.name === 'Expander S' ? ' Stereo and literal VCA ON free-running drone retained; drone mode intentionally bypasses note membership and release termination.' : '');
  reconcile(p, voice, DEFS);
  reconcile(p, root, DEFS);
  return p;
}
