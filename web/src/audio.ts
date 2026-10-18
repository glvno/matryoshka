// SPDX-License-Identifier: GPL-3.0-only
import workletUrl from './worklet.ts?worker&url';
import type { Patch } from './patch';
import type { HostMsg } from './worklet';
import type { ParameterValues } from './engine';
import type { ViewData } from './scope-stream';

export class AudioHost {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private gain: GainNode | null = null;
  muted = false;
  mute(on: boolean): void {
    this.muted = on;
    this.onState();
    if (this.gain && this.ctx) this.gain.gain.setTargetAtTime(on ? 0 : 1, this.ctx.currentTime, 0.01);
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
  /** a scope probe's latest samples (oldest first) */
  onProbe: (key: string, data: Float32Array, sr: number) => void = () => {};
  /** a watched output's mean over the last two blocks (a sidebar slider's source, by key) */
  onWatch: (key: string, v: number) => void = () => {};
  /** a Scope screen's latest histories, one per input (scope-stream.ts) */
  onView: (key: string, chans: ViewData[], sr: number) => void = () => {};
  /** an envelope display's copies (Engine.envStates) */
  onEnv: (key: string, states: { stage: number; v: number; newest: boolean }[] | null) => void = () => {};

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
      const node = new AudioWorkletNode(ctx, 'modular-1', { numberOfInputs: 0, outputChannelCount: [2] });
      node.port.onmessage = (ev) => {
        if (ev.data?.error) {
          this.latestValues = null; this.onValues(null); this.onError(ev.data.error);
        } else if (typeof ev.data?.watch === 'string') {
          this.onWatch(ev.data.watch, ev.data.v);
        } else if (typeof ev.data?.env === 'string') {
          this.onEnv(ev.data.env, ev.data.states);
        } else if (typeof ev.data?.view === 'string') {
          this.onView(ev.data.view, ev.data.chans, ev.data.sr);
        } else if (ev.data?.probe) {
          if (ev.data.revision === this.revision) this.onProbe(ev.data.probe, ev.data.data, ev.data.sr);
        }
        else if (ev.data?.values) {
          this.valuesPending = false;
          if (ev.data.revision === this.revision) this.latestValues = ev.data.values;
        }
      };
      this.gain = ctx.createGain();
      this.gain.gain.value = this.muted ? 0 : 1;
      node.connect(this.gain);
      this.gain.connect(ctx.destination);
      this.node = node;
      ctx.onstatechange = () => { this.watchValues(); this.onState(); };
      if (this.pending) this.send({ t: 'patch', patch: this.pending, revision: this.revision });
      this.send({ t: 'transport', on: this.transportOn });
      for (const msg of this.early) this.send(msg);
      this.early = [];
      for (const msg of this.watches.values()) node.port.postMessage(msg);
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
  }

  /** the transport (the deck's Play, Space): the Main module's run output and clock; kept for when the worklet starts */
  private transportOn = false;
  transport(on: boolean): void {
    this.transportOn = on;
    this.send({ t: 'transport', on });
  }

  /** the standing watches (sidebar slider sources), sent again once the worklet exists: a watch asked for before audio started
   * would otherwise be lost */
  private watches = new Map<string, HostMsg>();

  send(msg: HostMsg): void {
    if (msg.t === 'watch' || msg.t === 'view' || msg.t === 'envwatch') this.watches.set(msg.key, msg);
    else if (msg.t === 'unwatch' || msg.t === 'unview' || msg.t === 'unenvwatch') this.watches.delete(msg.key);
    if (this.node) this.node.port.postMessage(msg);
    else if (this.ctx && !['patch', 'transport'].includes(msg.t)) this.early.push(msg);
  }
}
