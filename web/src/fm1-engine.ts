// SPDX-License-Identifier: GPL-3.0-only
// The FM-1 engine in the browser (#941): firmware/src/engine.c, fixed point, compiled to WebAssembly
// (firmware/wasm/fm1_engine.c, public/fm1-engine.wasm), run in the AudioWorklet beside the browser engine (worklet.ts).
// It renders at the FM-1's rate and is resampled to the AudioContext's. It takes what the FM-1 takes: the binary the device
// link would send (fm1-engine-host.ts makes it and the module-index messages), and notes, the transport, the tempo, the
// clock and the performance controls quantized as they arrive over MIDI (midi_input.h).
import { Resampler } from './resample';
import type { HostMsg } from './worklet';

interface Exports {
  memory: WebAssembly.Memory;
  fm1e_bin(): number;
  fm1e_bin_max(): number;
  fm1e_words(): number;
  fm1e_words_max(): number;
  fm1e_l(): number;
  fm1e_r(): number;
  fm1e_rate(): number;
  fm1e_load(len: number): number;
  fm1e_render(n: number): void;
  fm1e_param(mod: number, par: number, v: number): void;
  fm1e_att(mod: number, input: number, v: number): void;
  fm1e_note(note: number, vel: number, on: number, ch: number, root: number): void;
  fm1e_panic(): void;
  fm1e_ctl(which: number, q16: number): void;
  fm1e_morph(q16: number): void;
  fm1e_button(b: number, on: number): void;
  fm1e_chord(b: number, down: number, track: number): void;
  fm1e_transport(on: number): void;
  fm1e_transport_at(ticks: number, wait: number): void;
  fm1e_running(): number;
  fm1e_once(): void;
  fm1e_count_in(bars: number): void;
  fm1e_tempo(bpm: number): void;
  fm1e_meter(m: number): void;
  fm1e_clock_tick(): void;
  fm1e_clock_external(on: number): void;
  fm1e_pattern(p: number): void;
  fm1e_song(s: number): void;
  fm1e_fill(on: number): void;
  fm1e_mute(mod: number, on: number): void;
  fm1e_track(mod: number, pat: number, n: number): number;
  fm1e_thru(mod: number, note: number, vel: number): void;
  fm1e_arm(...w: number[]): void;   // 8 words (ENG_MSET_WORDS, patch.ts ARM_WORDS)
}

/** what the page sends the FM-1 engine by module index in the binary, as the device link does (fm1-engine-host.ts) */
export type Fm1Op =
  | { op: 'load'; bin: Uint8Array }
  | { op: 'param'; mod: number; par: number; v: number }
  | { op: 'att'; mod: number; input: number; v: number }
  | { op: 'mute'; mod: number; on: boolean }
  /** pat -1: the pattern the track plays */
  | { op: 'track'; mod: number; pat: number; words: number[] }
  | { op: 'thru'; mod: number; note: number; vel: number }
  | { op: 'arm'; words: number[] };

/** engine.h ENG_CTL_* */
const CTL_BEND = 0, CTL_MOD = 1, CTL_AT = 2, CTL_BREATH = 3, CTL_SUSTAIN = 4, CTL_FOOT = 5;

/** a 0..1 level as a 7-bit MIDI value reaches the FM-1, then Q16 as midi_input.h makes it */
const midiQ16 = (v7: number): number => Math.floor((Math.max(0, Math.min(127, Math.round(v7))) * 65536) / 127);
/** a note's velocity (0..1) as the device link sends it (DeviceLink.note: 1..127) */
const velQ16 = (vel: number): number => midiQ16(Math.max(1, Math.round(vel * 127)));

export class Fm1Engine {
  private readonly x: Exports;
  private readonly rs: Resampler;
  /** the engine's rate (ENG_SR) */
  readonly rate: number;

  constructor(module: WebAssembly.Module, outRate: number) {
    this.x = new WebAssembly.Instance(module, {}).exports as unknown as Exports;
    this.rate = this.x.fm1e_rate();
    this.rs = new Resampler(this.rate, outRate, (l, r) => this.block(l, r));
  }

  /** one block at the engine's rate, Q16 to float (full scale 1.0, the browser engine's) */
  private block(l: Float32Array, r: Float32Array): number {
    const n = l.length;
    this.x.fm1e_render(n);
    const il = new Int32Array(this.x.memory.buffer, this.x.fm1e_l(), n);
    const ir = new Int32Array(this.x.memory.buffer, this.x.fm1e_r(), n);
    for (let i = 0; i < n; i++) {
      l[i] = il[i] / 65536;
      r[i] = ir[i] / 65536;
    }
    return n;
  }

  /** n frames at the AudioContext's rate */
  render(l: Float32Array, r: Float32Array, n = l.length): void {
    this.rs.pull(l, r, n);
  }

  get running(): boolean {
    return this.x.fm1e_running() !== 0;
  }

  /** a module-index message; a load returns eng_load's result (0: it plays), the rest 0 */
  apply(o: Fm1Op): number {
    const x = this.x;
    switch (o.op) {
      case 'load': {
        if (o.bin.length > x.fm1e_bin_max()) return -1;
        new Uint8Array(x.memory.buffer, x.fm1e_bin(), o.bin.length).set(o.bin);
        return x.fm1e_load(o.bin.length);
      }
      case 'param': x.fm1e_param(o.mod, o.par, o.v | 0); break;
      case 'att': x.fm1e_att(o.mod, o.input, o.v | 0); break;
      case 'mute': x.fm1e_mute(o.mod, o.on ? 1 : 0); break;
      case 'track': {
        const n = Math.min(o.words.length, x.fm1e_words_max());
        new Uint32Array(x.memory.buffer, x.fm1e_words(), n).set(o.words.slice(0, n));
        x.fm1e_track(o.mod, o.pat, n);
        break;
      }
      case 'thru': x.fm1e_thru(o.mod, o.note, o.vel); break;
      case 'arm': x.fm1e_arm(...Array.from({ length: 8 }, (_, i) => (o.words[i] ?? 0) >>> 0)); break;
    }
    return 0;
  }

  /** a message the browser engine takes too that needs no module index; `notes`: an entry's notes (worklet.ts) */
  hear(m: HostMsg, entryNotes?: number): void {
    const x = this.x;
    switch (m.t) {
      case 'on': x.fm1e_note(m.note, velQ16(m.vel), 1, m.ch ?? 1, m.root ? 1 : 0); break;
      case 'off': x.fm1e_note(m.note, 0, 0, m.ch ?? 1, m.root ? 1 : 0); break;
      case 'entry':
        if (entryNotes) x.fm1e_note(m.note, m.down ? velQ16(m.vel) : 0, m.down ? 1 : 0, m.ch ?? 1, m.root ? 1 : 0);
        break;
      case 'chord': x.fm1e_chord(m.button, m.down ? 1 : 0, m.track ?? -1); break;
      case 'panic': x.fm1e_panic(); break;
      case 'transport': x.fm1e_transport(m.on ? 1 : 0); break;
      case 'clockrun': if (m.top) x.fm1e_transport_at(m.at ?? 0, 1); else x.fm1e_transport(m.on ? 1 : 0); break;
      case 'once': x.fm1e_once(); break;
      case 'cin': x.fm1e_count_in(m.bars); break;
      case 'tempo': x.fm1e_tempo(m.bpm === null ? 0 : Math.round(m.bpm)); break;
      case 'meter': x.fm1e_meter(m.meter); break;
      case 'button': x.fm1e_button(m.i, m.on ? 1 : 0); break;
      case 'pattern': x.fm1e_pattern(m.p); break;
      case 'song': x.fm1e_song(m.n); break;
      case 'fill': x.fm1e_fill(m.on ? 1 : 0); break;
      case 'clock': x.fm1e_clock_tick(); break;
      case 'bend': {   // (14 bits, as DeviceLink.bend sends it and midi_input.h reads it)
        const v14 = Math.max(0, Math.min(16383, Math.round(8192 + m.v * 8192)));
        x.fm1e_ctl(CTL_BEND, (v14 - 8192) << 3);
        break;
      }
      case 'at': x.fm1e_ctl(CTL_AT, midiQ16(m.v * 127)); break;
      case 'cc':
        if (m.n === 1) x.fm1e_ctl(CTL_MOD, midiQ16(m.v));
        else if (m.n === 2) x.fm1e_ctl(CTL_BREATH, midiQ16(m.v));
        else if (m.n === 64) x.fm1e_ctl(CTL_SUSTAIN, midiQ16(m.v));
        else if (m.n === 65) x.fm1e_ctl(CTL_FOOT, midiQ16(m.v));
        else if (m.n === 22) x.fm1e_morph(midiQ16(m.v));
        break;
      default: break;
    }
  }

  /** MIDI clock drives the clock (on) or the Main module's tempo does again (off) */
  clockExternal(on: boolean): void {
    this.x.fm1e_clock_external(on ? 1 : 0);
  }
}
