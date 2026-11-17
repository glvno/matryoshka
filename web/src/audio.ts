// SPDX-License-Identifier: GPL-3.0-only
import workletUrl from './worklet.ts?worker&url';
import type { Patch } from './patch';
import type { HostMsg } from './worklet';
import type { ParameterValues } from './engine';
import type { ViewData } from './scope-stream';
import type { StepNote } from './track';
import type { PatternView } from './engine';
import type { Fm1Op } from './fm1-engine';
import { Fm1Bridge } from './fm1-engine-host';

/** the engine heard (#941): the browser's (engine.ts) or the FM-1's (engine.c as WebAssembly, fm1-engine.ts) */
export type EngineKind = 'browser' | 'fm1';
import type { ListenSource } from './listen';

export class AudioHost {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private gain: GainNode | null = null;
  muted = false;
  /** the output level, 0..1 (the FM-1 tab's MASTER knob; square law as the device's pot) */
  master = 1;
  mute(on: boolean): void {
    this.muted = on;
    this.onState();
    this.applyGain();
  }
  setMaster(v: number): void {
    this.master = Math.min(1, Math.max(0, v));
    this.applyGain();
  }
  private applyGain(): void {
    if (this.gain && this.ctx) this.gain.gain.setTargetAtTime(this.muted ? 0 : this.master * this.master, this.ctx.currentTime, 0.01);
  }
  private ready: Promise<void> | null = null;
  private early: HostMsg[] = [];
  private pending: Patch | null = null;
  private revision = 0;
  private valuesPending = false;
  private latestValues: ParameterValues | null = null;
  private frame = 0;
  /** the audio went on or off (running and not muted): the deck's Audio on / Panic button follows it */
  onState: () => void = () => {};
  onValues: (values: ParameterValues | null) => void = () => {};
  onError: (msg: string) => void = () => {};
  /** a watched output's mean over the last two blocks (a sidebar slider's source, by key) */
  onWatch: (key: string, v: number) => void = () => {};
  /** a Scope screen's latest histories, one per input (scope-stream.ts); `voices`: per input its voices' histories (#54), or null */
  onView: (key: string, chans: ViewData[], sr: number, voices: (ViewData[] | null)[] | null) => void = () => {};
  /** where the Steps modules are (Engine.stepsView), when that changes */
  onSteps: (view: { id: number; pos: number; mute: boolean }[], pats?: PatternView) => void = () => {};
  /** the transport started or stopped in the engine (play once's own start and stop, #632; also an echo of transport()) */
  onRun: (on: boolean) => void = () => {};
  /** notes a Steps track recorded live (#135, Engine.takeRecorded) */
  onRecorded: (took: { id: number; loop: number; note: StepNote }[]) => void = () => {};
  onEntry: (e: { id: number; token: number; note: number; notes: number[]; vel: number; down: boolean }) => void = () => {};
  /** an envelope display's copies (Engine.envStates) */
  onEnv: (key: string, states: { stage: number; v: number; newest: boolean }[] | null) => void = () => {};
  /** a test phrase played once is over (#945) */
  onPhraseEnd: () => void = () => {};
  /** a chunk of the Output's recording (#946): left and right at `sampleRate`; `last`: the recording stopped with it */
  onRecording: (chunk: [Float32Array, Float32Array], last: boolean) => void = () => {};

  /** the engine's sample rate (the audio device's), 0 before the audio starts */
  get sampleRate(): number {
    return this.ctx?.sampleRate ?? 0;
  }
  /** the Output's loudness (#940): the mean squares of the K-weighted 100 ms steps the engine rendered (loudness.ts KMeter) */
  onLoud: (steps: number[]) => void = () => {};

  /** the FM-1 engine loaded the patch (null) or why it could not (it is silent then) */
  onFm1: (error: string | null) => void = () => {};

  /** the engine heard; the FM-1 engine, once chosen, runs on beside the browser engine (so a switch keeps time) */
  engine: EngineKind = 'browser';
  private fm1Bytes: ArrayBuffer | null = null;
  private fm1Started = false;
  private readonly fm1 = new Fm1Bridge();
  private fm1Timer = 0;
  private fm1Queued = false;
  /** why the last binary could not be made (encodePatch threw), for the load's answer */
  private fm1Why: string | null = null;

  /** the engine heard. The FM-1 engine's WebAssembly (public/fm1-engine.wasm) is fetched the first time; throws when it
   *  cannot be (the browser engine stays) */
  async setEngine(kind: EngineKind): Promise<void> {
    if (kind === 'fm1' && !this.fm1Bytes) {
      try {
        const res = await fetch(`${import.meta.env.BASE_URL}fm1-engine.wasm`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const bytes = await res.arrayBuffer();
        if (!WebAssembly.validate(bytes)) throw new Error('not WebAssembly');
        this.fm1Bytes = bytes;
      } catch (e) {
        throw new Error(`the FM-1 engine did not load (${e instanceof Error ? e.message : String(e)})`);
      }
    }
    this.engine = kind;
    this.startFm1();
    this.node?.port.postMessage({ t: 'fm1use', on: kind === 'fm1' } satisfies HostMsg);
  }

  /** the FM-1 engine into the worklet (once both exist), with the patch */
  private startFm1(): void {
    if (!this.node || !this.fm1Bytes || this.fm1Started) return;
    this.fm1Started = true;
    this.node.port.postMessage({ t: 'fm1wasm', bytes: this.fm1Bytes } satisfies HostMsg);   // (a copy: kept for a restart)
    this.fm1Load();
  }

  /** the patch into the FM-1 engine again, as the device link sends it after an edit it has no message for */
  private fm1Load(): void {
    clearTimeout(this.fm1Timer);
    this.fm1Queued = false;
    if (!this.fm1Started || !this.pending || !this.node) return;
    let o: Fm1Op;
    try {
      o = this.fm1.load(this.pending);
      this.fm1Why = null;
    } catch (e) {
      this.fm1Why = e instanceof Error ? e.message : String(e);
      o = { op: 'load', bin: new Uint8Array() };   // (it goes silent: no stale patch plays on)
    }
    this.node.port.postMessage({ t: 'fm1', o } satisfies HostMsg);
  }

  /** a reload soon (edits in a row, a drag: one load) */
  private fm1Queue(ms: number): void {
    if (!this.fm1Started) return;
    clearTimeout(this.fm1Timer);
    this.fm1Queued = true;
    this.fm1Timer = window.setTimeout(() => this.fm1Load(), ms);
  }

  get running(): boolean {
    return this.ctx?.state === 'running';
  }

  async start(): Promise<void> {
    this.mute(false);
    if (!this.ctx) {
      const ctx = new AudioContext({ latencyHint: 'interactive' });
      this.ctx = ctx;
      this.ready = this.prepare(ctx);
    }
    // Resume immediately within the trusted gesture, even if the worklet is still loading.
    const resumed = this.ctx.resume();
    await this.ready;
    await resumed;
    this.watchValues();
    this.onState();
  }

  private async prepare(ctx: AudioContext): Promise<void> {
    try {
      await ctx.audioWorklet.addModule(workletUrl);
      const node = new AudioWorkletNode(ctx, 'matryoshka', { numberOfInputs: 0, outputChannelCount: [2] });
      node.port.onmessage = (ev) => {
        if (ev.data?.error) {
          this.latestValues = null; this.onValues(null); this.onError(ev.data.error);
        } else if (typeof ev.data?.watch === 'string') {
          this.onWatch(ev.data.watch, ev.data.v);
        } else if (Array.isArray(ev.data?.steps)) {
          this.onSteps(ev.data.steps, ev.data.pats);
        } else if (typeof ev.data?.run === 'boolean') {
          this.transportOn = ev.data.run;
          this.onRun(ev.data.run);
        } else if (ev.data?.entry) {
          this.onEntry(ev.data.entry);
        } else if (Array.isArray(ev.data?.recorded)) {
          this.onRecorded(ev.data.recorded);
        } else if (ev.data?.phrase === false) {
          this.onPhraseEnd();
        } else if (Array.isArray(ev.data?.rec)) {
          this.onRecording(ev.data.rec, !!ev.data.last);
        } else if (typeof ev.data?.env === 'string') {
          this.onEnv(ev.data.env, ev.data.states);
        } else if (Array.isArray(ev.data?.loud)) {
          this.onLoud(ev.data.loud);
        } else if (typeof ev.data?.view === 'string') {
          this.onView(ev.data.view, ev.data.chans, ev.data.sr, ev.data.voices ?? null);
        }
        else if (ev.data?.values) {
          this.valuesPending = false;
          if (ev.data.revision === this.revision) this.latestValues = ev.data.values;
        }
        else if (typeof ev.data?.fm1load === 'number') {
          this.onFm1(ev.data.fm1load === 0 ? null : this.fm1Why ?? `the FM-1 engine cannot play this patch (error ${ev.data.fm1load})`);
        } else if (typeof ev.data?.fm1error === 'string') {
          this.fm1Started = false;   // (the worklet dropped it; a switch starts it again)
          this.onFm1(`the FM-1 engine stopped: ${ev.data.fm1error}`);
        }
      };
      this.gain = ctx.createGain();
      this.gain.gain.value = this.muted ? 0 : this.master * this.master;
      node.connect(this.gain);
      this.gain.connect(ctx.destination);
      this.node = node;
      ctx.onstatechange = () => { this.watchValues(); this.onState(); };
      if (this.pending) this.send({ t: 'patch', patch: this.pending, revision: this.revision });
      this.send({ t: 'transport', on: this.transportOn });
      this.send({ t: 'tempo', bpm: this.tempoOn });
      if (this.listenOn) this.send({ t: 'listen', srcs: this.listenOn });
      for (const msg of this.early) this.send(msg);
      this.early = [];
      for (const msg of this.watches.values()) node.port.postMessage(msg);
      this.startFm1();
      if (this.engine === 'fm1') node.port.postMessage({ t: 'fm1use', on: true } satisfies HostMsg);
    } catch (error) {
      void ctx.close(); this.ctx = null; this.ready = null; this.early = [];
      throw error;
    }
  }

  /** At most one request in flight; hidden tabs and suspended audio do no display work. */
  private watchValues(): void {
    cancelAnimationFrame(this.frame);
    if (!this.running) {
      this.latestValues = null;
      this.valuesPending = false;
      this.onValues(null);
      return;
    }
    this.frame = requestAnimationFrame(() => {
      if (!document.hidden) {
        if (this.latestValues) {
          this.onValues(this.latestValues);
          this.latestValues = null;
        }
        if (!this.valuesPending) {
          this.valuesPending = true;
          this.send({ t: 'values' });
        }
      }
      this.watchValues();
    });
  }

  /** Last patch is replayed when the context starts. */
  setPatch(patch: Patch): void {
    this.pending = patch;
    this.revision++;
    this.latestValues = null;
    this.onValues(null);
    this.send({ t: 'patch', patch, revision: this.revision });
    this.fm1Queue(30);
  }

  /** the transport (the deck's Play, Space): the Main module's run output and clock; kept for when the worklet starts */
  private transportOn = false;
  transport(on: boolean): void {
    this.transportOn = on;
    this.send({ t: 'transport', on });
  }

  /** play once (#632, Engine.playOnce): the transport stops, a bar is counted in with a click, then the pattern or song
   * plays once and the transport stops by itself (onRun follows it) */
  playOnce(): void {
    this.transportOn = false;
    this.send({ t: 'once' });
  }

  /** REC's count-in click (D-803, Engine.countIn): `bars` bars of clicks from the transport's start or the next bar line; 0 none */
  countIn(bars: number): void {
    this.send({ t: 'cin', bars });
  }

  /** the global tempo (D-907, tempo.ts): every patch plays at it, null: each its own; kept for when the worklet starts */
  private tempoOn: number | null = null;
  tempo(bpm: number | null): void {
    this.tempoOn = bpm;
    this.send({ t: 'tempo', bpm });
  }

  /** the outputs listened to instead of the Output (#939, listen.ts), null: the Output; kept for when the worklet starts */
  private listenOn: ListenSource[] | null = null;
  listen(srcs: ListenSource[] | null): void {
    this.listenOn = srcs;
    this.send({ t: 'listen', srcs });
  }

  /** the standing watches (sidebar slider sources), sent again once the worklet exists: a watch asked for before audio started
   * would otherwise be lost */
  private watches = new Map<string, HostMsg>();

  /** the engine's output (before the master gain) into an analyser, made at the first ask; null before the audio runs.
   *  The scenarios (scripts/emu-scenarios.mjs, the dev server's __m1test) read the browser's level from it */
  private analyser: AnalyserNode | null = null;
  meter(): AnalyserNode | null {
    if (!this.analyser && this.ctx && this.node) {
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.node.connect(this.analyser);
    }
    return this.analyser;
  }

  send(msg: HostMsg): void {
    if (msg.t === 'watch' || msg.t === 'view' || msg.t === 'envwatch') this.watches.set(msg.key, msg);
    else if (msg.t === 'unwatch' || msg.t === 'unview' || msg.t === 'unenvwatch') this.watches.delete(msg.key);
    if (this.node) this.node.port.postMessage(msg);
    else if (this.ctx && !['patch', 'transport', 'tempo', 'listen'].includes(msg.t)) this.early.push(msg);
    if (this.node && this.fm1Started && this.pending && !this.fm1Queued) {
      // (a reload on its way takes the edit with the rest of the patch: the indices may be about to change)
      const ops = this.fm1.translate(this.pending, msg);
      if (ops === 'reload') this.fm1Queue(60);
      else for (const o of ops) this.node.port.postMessage({ t: 'fm1', o } satisfies HostMsg);
    }
  }
}
