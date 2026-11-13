// SPDX-License-Identifier: GPL-3.0-only
import { reconcile, type AssemblyInst } from './assembly';
import { DEFS } from './modules';
import { addModule, type Cable, type ModuleInst, type Patch } from './patch';

/**
 * Measurement-only SHARED FILTER / POLY AMP graphs, not shared-VCA paraphony.
 * Amplitude envelopes, gate/hold logic, pitch, sync and oscillator modulation stay
 * per note. Only amplitude-shaped audio crosses into the shared filter section.
 * Its contour attacks on the first held key and releases after the last; overlapping
 * keys change its last-held pitch/velocity without restarting it. Filter saturation
 * and resonance now act on a chord, and filter tails are shared between notes.
 */
export function sharedFilterFactory(source: Patch): Patch {
  if (!['Oracle V', 'Hera 4', 'Expander S', 'Io 4'].includes(source.name)) {
    throw new Error(`Unsupported shared-filter factory engine: ${source.name}`);
  }
  const p = structuredClone(source);
  const voice = p.assemblies!.find(a => a.poly)!;
  const root = p.assemblies!.find(a => a.children?.includes(voice.id))!;
  const module = (id: number): ModuleInst => p.modules.find(m => m.id === id)!;
  const wire = (from: number, out: string, to: number, input: string): void => {
    p.cables.push({ from: { module: from, port: out }, to: { module: to, port: input } });
  };
  const remove = (match: (c: Cable) => boolean): void => { p.cables = p.cables.filter(c => !match(c)); };
  const move = (...ids: number[]): void => {
    voice.modules = voice.modules.filter(id => !ids.includes(id));
    for (const id of ids) if (!root.modules.includes(id)) root.modules.push(id);
  };
  const fresh = (type: string, name: string, owner: AssemblyInst = root): ModuleInst => {
    const m = addModule(p, DEFS[type], root.x + 320, root.y + 560);
    m.name = name;
    owner.modules.push(m.id);
    return m;
  };
  // Copy ordinary editable modules, preserving their matrix/ranges and incoming
  // parameter cables. Root row aliases keep both contours under the original rows;
  // a child must not claim ownership of the new shared targets.
  const copy = (id: number, name: string, controls = true): ModuleInst => {
    const original = module(id);
    const m = fresh(original.type, name);
    const newId = m.id;
    Object.assign(m, structuredClone(original), { id: newId, name, x: m.x, y: m.y });
    for (const c of [...p.cables]) if (c.to.module === id && (c.to.port === 'p1' || c.to.port === 'p2')) {
      wire(c.from.module, c.from.port, m.id, c.to.port);
    }
    if (controls) for (const row of root.params) if (row.module === id && row.param !== 'view') {
      row.also = [...(row.also ?? []), { module: m.id, param: row.param }];
    }
    return m;
  };
  const contour = (id: number): ModuleInst => {
    const m = copy(id, 'shared filter envelope');
    const view = root.params.find(r => r.module === id && r.param === 'view');
    if (view) view.module = m.id;
    // Long changes both time scales; do not leave the shared copy's scale hidden.
    if (!root.params.some(r => r.module === id && r.param === 'long')) {
      root.params.push({ module: id, param: 'long', label: 'env long', also: [{ module: m.id, param: 'long' }] });
    }
    return m;
  };
  const mono = (poly: number, reuse?: number): ModuleInst => {
    const m = reuse === undefined ? copy(poly, 'shared key control', false) : module(reuse);
    if (reuse === undefined) {
      const feed = p.cables.find(c => c.to.module === poly && c.to.port === 'keys')!;
      wire(feed.from.module, feed.from.port, m.id, 'keys');
    }
    Object.assign(m.params, { voices: 1, assign: 0, legato: 2, priority: 0, unison: 0, stack: 0, steal: 1 });
    m.name = 'shared key control';
    return m;
  };
  const sharedPitch = (glide: number, key: number, poly: number): ModuleInst => {
    const m = copy(glide, 'shared key pitch');
    for (const c of [...p.cables]) if (c.to.module === glide && c.to.port !== 'p1' && c.to.port !== 'p2') {
      wire(c.from.module === poly ? key : c.from.module, c.from.port, m.id, c.to.port);
    }
    return m;
  };

  if (source.name === 'Oracle V') {
    const key = mono(6);
    const env = contour(12); // original EG still drives per-note oscillator poly-mod
    move(13, 38, 40, 41);
    wire(key.id, 'gate', env.id, 'gate');
    remove(c => (c.from.module === 6 && c.to.module === 38) || (c.from.module === 12 && c.to.module === 40)
      || (c.to.module === 13 && (c.from.module === 32 || c.from.module === 37))
      || (c.from.module === 13 && c.to.module === 15) || (c.from.module === 15 && c.to.module === 65));
    wire(key.id, 'vel', 38, 'in2');
    wire(env.id, 'env', 40, 'in');
    wire(32, 'out', 15, 'in');
    wire(15, 'out', 13, 'in');
    // Audio-rate poly-mod is now the sum of active amplitude-shaped voice sources,
    // not a sum of unplayed oscillators at stale pitches. Its switch remains real.
    const polyMod = fresh('vca', 'active poly-mod sum', voice);
    wire(37, 'out', polyMod.id, 'in');
    wire(42, 'out', polyMod.id, 'cv');
    wire(polyMod.id, 'out', 13, 'cv');
    wire(13, 'lp24', 65, 'l');
    wire(13, 'lp24', 65, 'r');
    root.outputs = [{ module: 13, port: 'lp24', label: 'out' }];
    module(13).name = 'shared filter';
    const outputScope = p.cables.find(c => c.to.module === 17 && c.to.port === 'a')!;
    outputScope.from = { module: 13, port: 'lp24' };
    // The built-in track flag reads the physical keyboard, not processed keys.
    // Externalize CV depth so last-held pitch adds one octave per octave without
    // inheriting that depth (or the cutoff slider's nonlinear bend).
    const track = fresh('select', 'shared last-key tracking');
    Object.assign(track.params, { count: 2, pos: module(13).params.track + 1, v1: 0, v2: 1 });
    const pitch = fresh('vca', 'shared tracking pitch');
    const depth = fresh('scale', 'shared filter CV depth');
    depth.params.gain = module(13).params.cvamt;
    for (const c of p.cables) if (c.to.module === 13 && c.to.port === 'cv') {
      c.to = { module: depth.id, port: 'in' };
    }
    wire(depth.id, 'out', 13, 'cv');
    wire(key.id, 'pitch', pitch.id, 'in');
    wire(track.id, 'out', pitch.id, 'cv');
    wire(pitch.id, 'out', 13, 'cv');
    module(13).params.track = 0;
    module(13).params.cvamt = 1;
    for (const row of root.params) if (row.module === 13) {
      if (row.param === 'track') {
        row.module = track.id; row.param = 'pos'; row.names = ['OFF', 'ON'];
      } else if (row.param === 'cvamt') {
        row.module = depth.id; row.param = 'gain';
      }
    }
    if (!root.params.some(row => row.module === depth.id)) {
      root.params.push({ module: depth.id, param: 'gain', label: 'filter CV depth' });
    }
  } else if (source.name === 'Hera 4') {
    const key = mono(7, 43);
    const env = contour(11); // original still shapes each note's amplitude
    const hold = copy(41, 'shared filter hold', false);
    wire(key.id, 'gate', env.id, 'gate');
    wire(key.id, 'gate', hold.id, 'a');
    wire(40, 'out', hold.id, 'b');
    wire(env.id, 'env', hold.id, 'b');
    wire(hold.id, 'or', env.id, 'hold');
    remove(c => (c.to.module === 10 && c.to.port === 'in') || (c.from.module === 10 && c.to.module === 12)
      || (c.from.module === 12 && c.to.module === 18) || (c.from.module === 11 && c.to.module === 33)
      || (c.from.module === 24 && c.to.module === 37));
    wire(30, 'out', 12, 'in'); wire(9, 'out', 12, 'in');
    wire(6, 'out', 12, 'in'); wire(32, 'out', 12, 'in');
    wire(12, 'out', 10, 'in'); wire(10, 'lp24', 18, 'in');
    wire(env.id, 'env', 33, 'in');
    // Preserve portamento, bend compensation and tuning in shared key-follow too.
    const glide = sharedPitch(23, key.id, 7);
    const select = copy(24, 'shared key portamento');
    for (const c of [...p.cables]) if (c.to.module === 24 && c.to.port === 'in1') {
      wire(c.from.module === 7 ? key.id : c.from.module, c.from.port, select.id, 'in1');
    }
    wire(glide.id, 'out', select.id, 'in2');
    wire(select.id, 'out', 37, 'in');
    move(10, 33, 35, 36, 34, 37);
    module(10).name = 'shared filter';
  } else if (source.name === 'Expander S') {
    const key = mono(4);
    const env = contour(10); // original EG remains the oscillator-2 modulation source
    move(8, 24);
    wire(key.id, 'gate', env.id, 'gate');
    remove(c => c.from.module === 10 && c.to.module === 24);
    wire(env.id, 'env', 24, 'in1');
    // Pan is per voice. Sum its L/R separately, then filter each channel once.
    // Four original filters become two, not one; no stereo-collapse assumption.
    const right = copy(7, 'shared filter right');
    const mode = copy(9, 'shared right filter mode');
    const bp = copy(23, 'shared right bandpass');
    remove(c => (c.to.module === 7 && c.to.port === 'in')
      || (c.from.module === 23 && c.to.module === 12) || (c.from.module === 14 && c.to.module === 30));
    wire(5, 'out', 12, 'in'); wire(6, 'out', 12, 'in');
    wire(14, 'l', 7, 'in'); wire(14, 'r', right.id, 'in');
    wire(right.id, 'lp12', mode.id, 'a'); wire(right.id, 'hp', mode.id, 'b');
    wire(mode.id, 'out', bp.id, 'in1'); wire(right.id, 'bp', bp.id, 'in2');
    wire(23, 'out', 30, 'l'); wire(bp.id, 'out', 30, 'r');
    root.outputs = [{ module: 23, port: 'out', label: 'l' }, { module: bp.id, port: 'out', label: 'r' }];
    move(7, 9, 23);
    module(7).name = 'shared filter left';
    const outputScope = p.cables.find(c => c.to.module === 15 && c.to.port === 'a')!;
    outputScope.from = { module: 23, port: 'out' };
  } else {
    const key = mono(2, 3);
    move(43, 44, 45, 46);
    module(43).name = 'shared filter'; module(44).name = 'shared filter envelope';
    const hold = copy(49, 'shared filter hold', false);
    wire(key.id, 'gate', hold.id, 'a'); wire(7, 'out', hold.id, 'b');
    wire(44, 'env', hold.id, 'b'); wire(hold.id, 'or', 44, 'gate');
    const glide = sharedPitch(39, key.id, 2);
    remove(c => (c.from.module === 49 && c.to.module === 44) || (c.to.module === 43 && c.to.port === 'in')
      || (c.from.module === 43 && c.to.module === 48) || (c.from.module === 48 && c.to.module === 55)
      || (c.from.module === 39 && c.to.module === 46));
    wire(42, 'out', 48, 'in'); wire(41, 'out', 48, 'in'); wire(27, 'out', 48, 'in');
    wire(48, 'out', 43, 'in'); wire(43, 'lp24', 55, 'in');
    wire(glide.id, 'out', 46, 'in');
  }

  root.label = `${source.name} SF/PA`;
  root.name = root.label;
  voice.label = 'pitched voices / poly amp';
  p.name = `${source.name} SF/PA`;
  p.notes = 'SHARED FILTER / POLY AMP hybrid. Independent note amplitude and release; shared filter saturation/resonance. Filter contour: first held key attacks, last released key releases (existing hold/pedal controls still apply); key-follow uses last held processed note. Not a fully shared VCA.'
    + (source.name === 'Expander S' ? ' Stereo pan retained with two shared filters.' : '')
    + (source.name === 'Oracle V' ? ' Filter poly-mod is the amplitude-weighted sum of active voices.' : '');
  reconcile(p, voice, DEFS);
  reconcile(p, root, DEFS);
  return p;
}
