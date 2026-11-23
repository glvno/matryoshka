// SPDX-License-Identifier: GPL-3.0-only
// The floor sweep (#969, tools/floor_test.sh): every module type with an input it can ring from (`in` / `exc`, or a gate
// for the String and the envelopes), struck once (a 1 ms pulse at 0.5 into that input, the gate held 0.5 s), then left
// silent for 10 s; at its defaults and at a long-ring setting (feedback, resonance, decay near their tops, damping off).
// EXTRA adds settings that take other code paths of one module (the Delay's ping-pong, lower rate, swell and Tape loops at
// a time short enough to ring out within the 10 s; the Reverb's fixed taps and full damping; the resonant filters at a low
// cutoff, with drive and in the Ladder's other modes), and the factory FX drawer (the master FX bus it replaced) with one
// effect on at a time (its wrapper, m_fx, around the same kernels).
// Writes build/floor/NAME.{m1p,ev,f32} (the reference output of web/src/engine.ts); host_test with HOST_TEST_FLOOR=1 then
// says whether the C engine's last second holds a floor the reference does not. Run from web/: npx vite-node scripts/floor-kits.ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { Engine } from '../src/engine';
import { encodePatch } from '../src/patchbin';
import { DEFS, DEVICE_SR } from '../src/modules';
import { addModule, connect, newPatch, type ModuleInst, type Patch } from '../src/patch';
import { withFxBus } from '../src/factory-bank';
import { convertLegacyBus } from '../src/fx-drawer';
import { fxBusOf, type FxStageKind } from '../src/fx-legacy';

const OUT = new URL('../../build/floor/', import.meta.url);
mkdirSync(OUT, { recursive: true });
const SR = DEVICE_SR, HOLD = 128 * 172, END = HOLD + SR * 10;
/** types with no ring to judge: the patch's frame, note and pattern sources, and the holds that keep a value on purpose */
const SKIP = ['fm1', 'output', 'part', 'alloc', 'scope', 'steps', 'drummap', 'harm', 'arp', 'seq', 'macro', 'sh', 'quant', 'shreg'];
/** the long-ring setting of a parameter, from its range */
const LONG: Record<string, (lo: number, hi: number) => number> = {
  fb: (lo, hi) => hi * 0.98, feedback: (lo, hi) => hi * 0.98, regen: (lo, hi) => hi * 0.98, res: (lo, hi) => hi * 0.97,
  decay: (lo, hi) => hi, size: (lo, hi) => hi * 0.95, damp: (lo) => lo,
};
const DELAY_FAST = { time: 20, fb: 0.95 * 0.98 };
/** other code paths of a module: its type, parameters and (when not its first) the output played */
const EXTRA: Record<string, [string, Record<string, number>, string?]> = {
  'delay-fast': ['delay', DELAY_FAST],
  'delay-pingpong': ['delay', { ...DELAY_FAST, pingpong: 1 }],
  'delay-22k': ['delay', { ...DELAY_FAST, rate: 1 }],
  'delay-swell': ['delay', { time: 20, fb: 0.4, swell: 1 }],
  'delay-tape': ['delay', { ...DELAY_FAST, tape: 1 }],
  'reverb-damp': ['reverb', { size: 0.95, damp: 1, mod: 0 }],
  // the resonant filters, where a ring was held at other cutoffs and in other modes too (#969): a low cutoff at the band
  // pass (the high resonance's own output), the Multimode filter's drive, the Ladder's modes
  'filter-low': ['filter', { cutoff: 60, res: 0.995 }, 'bp'],
  'filter-drive': ['filter', { res: 0.97, drive: 3 }],
  'ladder-low': ['ladder', { cutoff: 60, res: 0.97 }],
  'ladder-diode': ['ladder', { res: 0.97, diode: 1 }],
  'ladder-stsat': ['ladder', { res: 0.97, drive: 3, stsat: 1 }],
};
/** the master FX bus stages, one at a time, at a long ring */
const FX: Record<FxStageKind, Record<string, number>> = {
  drive: {},
  chorus: {},
  delay: { ...DELAY_FAST, mix: 0.5 },
  reverb: { size: 0.95, damp: 0, mix: 1 },
};
const names: string[] = [];

/** the 1 ms strike (0.5) on Main's gate, added to p; its output module */
function strike(p: Patch, main: ModuleInst): ModuleInst {
  const pl = addModule(p, DEFS.pulse, 0, 0), hit = addModule(p, DEFS.scale, 0, 0);
  pl.params.time = 0.001;
  Object.assign(hit.params, { gain: 0.5, offset: 0 });
  connect(p, DEFS, { module: main.id, port: 'gate' }, { module: pl.id, port: 'trig' });
  connect(p, DEFS, { module: pl.id, port: 'out' }, { module: hit.id, port: 'in' });
  return hit;
}

function render(name: string, p: Patch): void {
  const e = new Engine(SR);
  e.load(p);
  const st = new Float32Array(END * 2);
  const seg = (from: number, to: number): void => {
    const a = new Float32Array(to - from), b = new Float32Array(to - from);
    e.render(a, b);
    for (let i = 0; i < to - from; i++) { st[2 * (from + i)] = a[i]; st[2 * (from + i) + 1] = b[i]; }
  };
  e.noteOn(60, 1, 1);
  seg(0, HOLD);
  e.noteOff(60, 1);
  seg(HOLD, END);
  writeFileSync(new URL(`${name}.f32`, OUT), new Uint8Array(st.buffer));
  writeFileSync(new URL(`${name}.m1p`, OUT), encodePatch(p, true));
  writeFileSync(new URL(`${name}.ev`, OUT), `0 on 60 127 1\n${HOLD} off 60 1\n${END} end\n`);
  names.push(name);
}

/** one module, its params set, struck through `in` / `exc` or its gate, its `outPort` (else its first output) into both
 * sides of the Output */
function moduleKit(name: string, type: string, set: (m: ModuleInst) => void, outPort?: string): void {
  const def = DEFS[type];
  const p = newPatch(DEFS, name);
  const main = p.modules.find((m) => m.type === 'fm1')!, out = p.modules.find((m) => m.type === 'output')!;
  const m = addModule(p, def, 300, 0);
  set(m);
  const inp = def.inputs.find((i) => i.name === 'in' || i.name === 'exc');
  if (inp) connect(p, DEFS, { module: strike(p, main).id, port: 'out' }, { module: m.id, port: inp.name });
  if (def.inputs.some((i) => i.name === 'gate')) connect(p, DEFS, { module: main.id, port: 'gate' }, { module: m.id, port: 'gate' });
  if (def.inputs.some((i) => i.name === 'pitch')) connect(p, DEFS, { module: main.id, port: 'pitch' }, { module: m.id, port: 'pitch' });
  for (const port of ['l', 'r']) connect(p, DEFS, { module: m.id, port: outPort ?? def.outputs[0].name }, { module: out.id, port });
  render(name, p);
}

for (const [type, def] of Object.entries(DEFS)) {
  if (SKIP.includes(type) || !def.outputs.length) continue;
  if (!def.inputs.some((i) => i.name === 'in' || i.name === 'exc' || i.name === 'gate')) continue;
  moduleKit(`${type}-def`, type, () => {});
  if (def.params.some((q) => LONG[q.name]))
    moduleKit(`${type}-long`, type, (m) => { for (const q of def.params) if (LONG[q.name]) m.params[q.name] = LONG[q.name](q.min, q.max); });
}
for (const [name, [type, params, outPort]] of Object.entries(EXTRA)) moduleKit(name, type, (m) => Object.assign(m.params, params), outPort);
for (const [kind, params] of Object.entries(FX) as [FxStageKind, Record<string, number>][]) {
  const p0 = newPatch(DEFS, `fxbus-${kind}`);
  const main = p0.modules.find((m) => m.type === 'fm1')!, out = p0.modules.find((m) => m.type === 'output')!, hit = strike(p0, main);
  for (const port of ['l', 'r']) connect(p0, DEFS, { module: hit.id, port: 'out' }, { module: out.id, port });
  const p = withFxBus(p0);
  const stage = fxBusOf(p, DEFS)!.stages.find((s) => s.kind === kind)!;
  p.assemblies!.find((a) => a.id === stage.assembly)!.bypass = false;
  for (const id of [...stage.helpers, ...stage.targets]) p.modules.find((m) => m.id === id)!.bypass = false;
  for (const id of stage.targets) Object.assign(p.modules.find((m) => m.id === id)!.params, params);
  render(`fxbus-${kind}`, convertLegacyBus(p));
}
console.log(`${names.length} floor kits in build/floor/`);
