// SPDX-License-Identifier: GPL-3.0-only
// AudioWorklet wrapper around Engine.
import { Engine } from './engine';
import type { Patch } from './patch';
import { ViewStream, type ViewData } from './scope-stream';

declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, ctor: new () => AudioWorkletProcessor): void;

export type HostMsg =
  | { t: 'patch'; patch: Patch; revision?: number }
  | { t: 'values' }
  | { t: 'param'; id: number; name: string; value: number }
  | { t: 'att'; id: number; index: number; value: number }
  | { t: 'bypass'; id: number; on: boolean }
  | { t: 'range'; id: number; index: number; name: string; range: [number, number] | null }
  | { t: 'transport'; on: boolean }
  | { t: 'button'; i: number; on: boolean }
  | { t: 'probe'; key: string; id: number; port: string }
  | { t: 'unprobe'; key: string }
  | { t: 'watch'; key: string; id: number; port: string }
  | { t: 'unwatch'; key: string }
  /** a Scope module's screen: per input the outputs cabled into it (summed), and its window in samples */
  | { t: 'view'; key: string; chans: { id: number; port: string }[][]; samples: number }
  | { t: 'unview'; key: string }
  /** an envelope display: its copies' stage and level (Engine.envStates), sent with the probes */
  | { t: 'envwatch'; key: string; id: number }
  | { t: 'unenvwatch'; key: string }
  | { t: 'on'; note: number; vel: number; ch?: number }
  | { t: 'off'; note: number; ch?: number }
  | { t: 'clock' }
  | { t: 'clockrun'; on: boolean }
  | { t: 'bend'; v: number }
  | { t: 'cc'; n: number; v: number }
  | { t: 'at'; v: number }
  | { t: 'panic' };

/** blocks without MIDI clock after which it no longer drives the clock (about half a second) */
const CLOCK_GONE = Math.round((0.5 * sampleRate) / 128);
/** samples a probe keeps (about 85 ms at 48 kHz: a few cycles of a bass note, a whole envelope attack) */
const PROBE_LEN = 4096;
/** blocks between two probe messages: 12 x 128 = 1536 samples, about 32 ms */
const PROBE_EVERY = 12;

class ModularProcessor extends AudioWorkletProcessor {
  private engine = new Engine(sampleRate);
  /** blocks since the last MIDI clock tick: after half a second without one the Main module's tempo drives the clock again */
  private sinceClock = Infinity;
  private failed = false;
  private revision = 0;
  private valuesRequested = false;
  /** scope probes: the last PROBE_LEN samples of an output, sent to the host about 30 times a second */
  private probes = new Map<string, { id: number; port: string; ring: Float32Array; w: number }>();
  private probeBlocks = 0;
  /** outputs patched into the editor's sidebar sliders (Patch.slackFrom, zoomFrom) by key: their mean over two blocks, sent
   * about 170 times a second */
  private watched = new Map<string, { id: number; port: string; sum: number; n: number }>();
  /** Scope screens on show: their inputs' histories (scope-stream.ts), sent with the probes */
  private views = new Map<string, { chans: { id: number; port: string }[][]; samples: number; streams: ViewStream[] }>();
  private viewSum = new Float32Array(128);
  /** envelope displays on show: module id by key */
  private envs = new Map<string, number>();
  constructor() {
    super();
    this.port.onmessage = (ev: MessageEvent<HostMsg>) => {
      const m = ev.data;
      try {
        if (m.t === 'patch') {
          this.engine.load(m.patch);
          for (const p of this.probes.values()) { p.ring.fill(0); p.w = 0; }
          for (const v of this.views.values()) v.streams = v.chans.map(() => new ViewStream(v.samples));
          this.probeBlocks = 0;
          this.revision = m.revision ?? 0;
          this.failed = false;
        }
        else if (m.t === 'values') this.valuesRequested = true;
        else if (m.t === 'param') this.engine.setParam(m.id, m.name, m.value);
        else if (m.t === 'att') this.engine.setAtt(m.id, m.index, m.value);
        else if (m.t === 'bypass') this.engine.setBypass(m.id, m.on);
        else if (m.t === 'range') this.engine.setRange(m.id, m.index, m.name, m.range);
        else if (m.t === 'probe') this.probes.set(m.key, { id: m.id, port: m.port, ring: new Float32Array(PROBE_LEN), w: 0 });
        else if (m.t === 'unprobe') this.probes.delete(m.key);
        else if (m.t === 'watch') this.watched.set(m.key, { id: m.id, port: m.port, sum: 0, n: 0 });
        else if (m.t === 'unwatch') this.watched.delete(m.key);
        else if (m.t === 'view') this.views.set(m.key, { chans: m.chans, samples: m.samples, streams: m.chans.map(() => new ViewStream(m.samples)) });
        else if (m.t === 'unview') this.views.delete(m.key);
        else if (m.t === 'envwatch') this.envs.set(m.key, m.id);
        else if (m.t === 'unenvwatch') this.envs.delete(m.key);
        else if (m.t === 'transport') this.engine.transport(m.on);
        else if (m.t === 'button') this.engine.setButton(m.i, m.on);
        else if (m.t === 'on') this.engine.noteOn(m.note, m.vel, m.ch);
        else if (m.t === 'off') this.engine.noteOff(m.note, m.ch);
        else if (m.t === 'clock') {                   // MIDI clock: it drives the clock while it comes in
          if (this.sinceClock > CLOCK_GONE) this.engine.clockExternal(true);
          this.sinceClock = 0;
          this.engine.clockTick();
        } else if (m.t === 'clockrun') this.engine.transport(m.on);   // MIDI Start / Continue / Stop
        else if (m.t === 'bend') this.engine.bend(m.v);
        else if (m.t === 'cc') this.engine.cc(m.n, m.v);
        else if (m.t === 'at') this.engine.aftertouch(m.v);
        else if (m.t === 'panic') this.engine.allNotesOff();
      } catch (e) {
        this.port.postMessage({ error: String(e) });
      }
    };
  }
  private feedProbes(n: number, outputs: Float32Array[]): void {
    for (const p of this.probes.values()) {
      const src = this.engine.probe(p.id, p.port);
      for (let i = 0; i < n; i++) {
        p.ring[p.w] = src?.[i] ?? 0;
        if (++p.w === PROBE_LEN) p.w = 0;
      }
    }
    if (++this.probeBlocks < PROBE_EVERY) return;
    this.probeBlocks = 0;
    for (const [key, p] of this.probes) {
      const data = new Float32Array(PROBE_LEN); // oldest first
      data.set(p.ring.subarray(p.w));
      data.set(p.ring.subarray(0, p.w), PROBE_LEN - p.w);
      this.port.postMessage({ probe: key, data, sr: sampleRate, revision: this.revision }, [data.buffer]);
    }
    for (const [key, v] of this.views) {
      const chans: ViewData[] = v.streams.map((s) => s.data());
      const bufs = chans.flatMap((c) => ('raw' in c ? [c.raw.buffer] : [c.min.buffer, c.max.buffer]));
      this.port.postMessage({ view: key, chans, sr: sampleRate }, bufs);
    }
    for (const [key, id] of this.envs) this.port.postMessage({ env: key, states: this.engine.envStates(id) });
  }

  /** each Scope input: the sum of what is cabled into it (as Engine.probe sees each output) */
  private feedViews(n: number): void {
    if (this.viewSum.length < n) this.viewSum = new Float32Array(n);
    const sum = this.viewSum;
    for (const v of this.views.values())
      v.chans.forEach((srcs, i) => {
        if (srcs.length === 1) return v.streams[i].push(this.engine.probe(srcs[0].id, srcs[0].port), n);
        sum.fill(0, 0, n);
        for (const s of srcs) {
          const b = this.engine.probe(s.id, s.port);
          if (b) for (let k = 0; k < n; k++) sum[k] += b[k];
        }
        v.streams[i].push(srcs.length ? sum : null, n);
      });
  }

  private feedWatch(n: number): void {
    for (const [key, w] of this.watched) {
      const src = this.engine.probe(w.id, w.port);
      for (let i = 0; i < n; i++) w.sum += src?.[i] ?? 0;
      w.n += n;
      if (w.n < 256) continue;
      this.port.postMessage({ watch: key, v: w.sum / w.n });
      w.sum = 0;
      w.n = 0;
    }
  }

  process(_in: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0];
    try {
      if (this.sinceClock <= CLOCK_GONE && ++this.sinceClock > CLOCK_GONE) this.engine.clockExternal(false);
      this.engine.render(out[0], out[1] ?? out[0]);
      if (this.views.size) this.feedViews(out[0].length);
      if (this.probes.size || this.views.size || this.envs.size) this.feedProbes(out[0].length, out);
      if (this.watched.size) this.feedWatch(out[0].length);
      if (this.valuesRequested) {
        this.valuesRequested = false;
        this.port.postMessage({ values: this.engine.parameterValues(), revision: this.revision });
      }
    } catch (e) {
      if (!this.failed) this.port.postMessage({ error: `engine: ${e}` });
      this.failed = true; // stay silent instead of throwing in the audio thread on every block
      out[0].fill(0);
      out[1]?.fill(0);
    }
    return true;
  }
}
registerProcessor('modular-1', ModularProcessor as never);
