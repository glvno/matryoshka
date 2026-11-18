// SPDX-License-Identifier: GPL-3.0-only
// Quiet load (#1086): every FM-1 factory patch, and every factory preset of each of its devices (the engines and the
// master FX bus), is silent until a key is played or PLAY runs. A patch is loaded, or a preset switched to from a silent
// preset of the same device, with no keys held and the transport stopped; the output must stay below QUIET_DB peak for
// SECONDS. The browser engine (engine.ts) and the FM-1's own engine (engine.c as wasm, fm1-engine.ts) both play it.
// quiet-load.test.ts runs it in CI; scripts/quiet-listen.ts renders the before / after files for listening.
import { applyPreset, presetsOf, type Preset } from '../src/device-presets';
import { Engine } from '../src/engine';
import { factoryPresets } from '../src/factory-presets';
import { Fm1Engine } from '../src/fm1-engine';
import { Fm1Bridge } from '../src/fm1-engine-host';
import { DEFS, DEVICE_SR } from '../src/modules';
import { devicesOf } from '../src/pages';
import type { AssemblyInst, Patch } from '../src/patch';
import { FM1_PRESETS } from '../src/presets';
import type { HostMsg } from '../src/worklet';

/** the loudest a quiet load may be, in dBFS sample peak (a DC offset counts: its step at load is a click). -70 dBFS is
 *  the loudness measurement's own floor (BS.1770's absolute gate, levels.ts) and 52 dB under the factory loudness target
 *  of -18 LUFS. A sound that waits for a key or PLAY loads in digital silence in both engines (the engines' fixed point
 *  has no noise floor to allow for), so the margin costs nothing; the faintest leak the audit found (a closed lopass
 *  gate's offset, -32 dBFS) is far over it. A switch on the FM-1 starts from silence: the patch loads fresh, and a preset
 *  switch here starts from a preset of the same device that loads silent, so no earlier tail is measured. */
export const QUIET_DB = -70;
/** how long each case is heard, from the load or the switch */
export const SECONDS = 3;
/** how long the preset a switch starts from runs first */
const LEAD = 1;
const BLOCK = 128;

/** the engines a case plays through */
export type EngineKind = 'browser' | 'fm1';

export interface QuietCase {
  /** the factory patch (its bank name) */
  patch: string;
  /** the device whose preset is loaded; undefined: the patch as it loads */
  device?: string;
  preset?: string;
  /** the preset of the same device the switch starts from (the first one that loads silent) */
  from?: string;
}

export interface QuietResult extends QuietCase {
  engine: EngineKind;
  how: 'load' | 'switch';
  /** peak in dBFS over SECONDS, -Infinity for digital silence */
  peak: number;
}

/** a renderer the cases share: the browser engine or the FM-1 engine, both at the FM-1's rate */
interface Player {
  load(p: Patch): void;
  /** the messages the editor sends for a live edit (a preset switch on the device takes the same rows) */
  send(p: Patch, m: HostMsg): void;
  render(l: Float32Array, r: Float32Array): void;
}

function browserPlayer(): Player {
  let e = new Engine(DEVICE_SR);
  return {
    load(p) { e = new Engine(DEVICE_SR); e.load(p); },
    send(_p, m) {
      if (m.t === 'param') e.setParam(m.id, m.name, m.value);
      else if (m.t === 'bypass') e.setBypass(m.id, m.on);
      else if (m.t === 'track') e.setTrack(m.id, m.notes, m.pat);
    },
    render(l, r) { e.render(l, r); },
  };
}

function fm1Player(module: WebAssembly.Module): Player {
  let e = new Fm1Engine(module, DEVICE_SR);
  let bridge = new Fm1Bridge();
  return {
    load(p) {
      e = new Fm1Engine(module, DEVICE_SR);
      bridge = new Fm1Bridge();
      if (e.apply(bridge.load(p)) !== 0) throw new Error(`${p.name}: the FM-1 engine does not load it`);
    },
    send(p, m) {
      const ops = bridge.translate(p, m);
      if (ops === 'reload') { if (e.apply(bridge.load(p)) !== 0) throw new Error(`${p.name}: the FM-1 engine does not load it`); return; }
      for (const o of ops) e.apply(o);
    },
    render(l, r) { e.render(l, r); },
  };
}

/** peak in dBFS of `seconds` of the player */
function peakOf(play: Player, seconds: number): number {
  const l = new Float32Array(BLOCK), r = new Float32Array(BLOCK);
  let m = 0;
  for (let n = Math.round(seconds * DEVICE_SR); n > 0; n -= BLOCK) {
    play.render(l, r);
    for (let i = 0; i < BLOCK; i++) m = Math.max(m, Math.abs(l[i]), Math.abs(r[i]));
  }
  return 20 * Math.log10(m);
}

/** the live messages that take patch `a` to patch `b` (the same modules): changed parameters, bypasses and tracks */
function edits(a: Patch, b: Patch): HostMsg[] {
  const out: HostMsg[] = [];
  for (const mb of b.modules) {
    const ma = a.modules.find((m) => m.id === mb.id);
    if (!ma) continue;
    for (const [name, value] of Object.entries(mb.params)) if (ma.params[name] !== value) out.push({ t: 'param', id: mb.id, name, value });
    if (!!ma.bypass !== !!mb.bypass) out.push({ t: 'bypass', id: mb.id, on: !!mb.bypass });
    if (mb.type === 'steps' && JSON.stringify(ma.notes ?? []) !== JSON.stringify(mb.notes ?? [])) out.push({ t: 'track', id: mb.id, notes: mb.notes });
  }
  return out;
}

/** a factory patch's devices with factory presets: the assembly and its presets in the order the FM-1 steps them */
export function presetDevices(p: Patch): { device: string; asm: AssemblyInst; presets: Preset[] }[] {
  return devicesOf(p, DEFS).flatMap((d) => {
    const asm = p.assemblies?.find((a) => a.id === d.asm);
    const presets = asm ? presetsOf(p, asm).filter((x) => x.factory) : [];
    return asm && presets.length ? [{ device: d.name, asm, presets }] : [];
  });
}

/** `base` with `preset` loaded on its assembly `asmId` (as the FM-1's PRESET on that device: card rows and pattern) */
export function withPreset(base: Patch, asmId: number, preset: Preset): Patch {
  const p = structuredClone(base);
  if (!applyPreset(p, p.assemblies!.find((a) => a.id === asmId)!, preset)) throw new Error(`${base.name}: ${preset.name} does not load`);
  return p;
}

/** the factory patches by bank name, built as the bank ships them */
export function factoryPatches(): { name: string; patch: Patch }[] {
  factoryPresets();
  return Object.entries(FM1_PRESETS).map(([name, make]) => ({ name, patch: make() }));
}

/** every case of one patch through one engine: the patch's load, each preset's load, and each preset's switch from the
 *  first preset of its device that loads silent (the first preset when none does) */
export function auditPatch(name: string, base: Patch, engine: EngineKind, wasm?: WebAssembly.Module): QuietResult[] {
  const play = engine === 'fm1' ? fm1Player(wasm!) : browserPlayer();
  const results: QuietResult[] = [];
  play.load(base);
  results.push({ patch: name, engine, how: 'load', peak: peakOf(play, SECONDS) });
  for (const { device, asm, presets } of presetDevices(base)) {
    const loaded = presets.map((preset) => {
      const p = withPreset(base, asm.id, preset);
      play.load(p);
      const r: QuietResult = { patch: name, device, preset: preset.name, engine, how: 'load', peak: peakOf(play, SECONDS) };
      results.push(r);
      return { preset, p, quiet: r.peak < QUIET_DB };
    });
    const from = loaded.find((x) => x.quiet) ?? loaded[0];
    for (const to of loaded) {
      if (to === from) continue;
      play.load(from.p);
      peakOf(play, LEAD);
      for (const m of edits(from.p, to.p)) play.send(to.p, m);
      results.push({ patch: name, device, preset: to.preset.name, from: from.preset.name, engine, how: 'switch', peak: peakOf(play, SECONDS) });
    }
  }
  return results;
}

/** a result as one line: the case, the engine and the level */
export const caseLine = (r: QuietResult): string =>
  `${r.patch}${r.device ? ` / ${r.device}: ${r.preset}` : ''}${r.how === 'switch' ? ` (switched from ${r.from})` : ' (load)'} [${r.engine}] ${Number.isFinite(r.peak) ? r.peak.toFixed(1) : '-inf'} dBFS`;
