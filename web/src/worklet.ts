// SPDX-License-Identifier: GPL-3.0-only
// AudioWorklet wrapper around Engine, and the FM-1 engine beside it (#941, fm1-engine.ts): once the page sends its
// WebAssembly module both run on every block and take the same messages, and the output is one or the other (a short
// crossfade between them), so the two can be compared while playing. The displays (Scope screens, slider sources,
// envelope dots, Steps playheads, live values) always show the browser engine.
import { Engine } from './engine';
import { Fm1Engine, type Fm1Op } from './fm1-engine';
import type { Patch, Range } from './patch';
import type { SongEntry, StepNote } from './track';
import { DISPLAY_EVERY, ViewStream, VoiceStreams, voiceSums, type ViewData } from './scope-stream';
import { PhrasePlayer, type Phrase } from './phrases';
import { ListenMix, type ListenSource } from './listen';
import { KMeter } from './loudness';
import { meterOf } from './modules';

declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, ctor: new () => AudioWorkletProcessor): void;

export type HostMsg =
  /** `fresh`: every voice let go and every module started from rest first (a snapshot switch: no tail rings on, D-970) */
  | { t: 'patch'; patch: Patch; revision?: number; fresh?: boolean }
  | { t: 'values' }
  | { t: 'param'; id: number; name: string; value: number }
  | { t: 'att'; id: number; index: number; value: number }
  | { t: 'bypass'; id: number; on: boolean }
  | { t: 'range'; id: number; index: number; name: string; range: Range | null }
  | { t: 'transport'; on: boolean }
  /** play once (#632, Engine.playOnce): a bar counted in with a click, the pattern or song once, then it stops */
  | { t: 'once' }
  | { t: 'cin'; bars: number }
  /** the global tempo (D-907), null: each patch its own */
  | { t: 'tempo'; bpm: number | null }
  /** the global time signature (#1011): an index into METERS (modules.ts) */
  | { t: 'meter'; meter: number }
  | { t: 'button'; i: number; on: boolean }
  /** a Steps module's notes edited (#133), a Steps module muted */
  | { t: 'track'; id: number; notes: StepNote[] | undefined; pat?: number }
  | { t: 'pattern'; p: number }
  | { t: 'song'; n: number }
  | { t: 'songs'; songs: SongEntry[][] }
  | { t: 'mute'; id: number; on: boolean }
  /** FILL held or let go (#674: the notes with a FILL trig condition play while it is held) */
  | { t: 'fill'; on: boolean }
  /** the armed devices (#190, `m<id>` / `a<id>`): only they hear Main's keys; none: the cables decide */
  | { t: 'arm'; devices: string[] }
  /** live recording on a Steps track (#135) */
  | { t: 'rec'; id: number; on: boolean }
  /** a note into a Steps track's keys in, to hear its instrument (the roll, #136; vel 1..127, 0: let go) */
  | { t: 'thru'; id: number; note: number; vel: number }
  /** voices: also each voice of a module that runs once per voice (#54), sent as `voices` beside `data` */
  | { t: 'watch'; key: string; id: number; port: string }
  | { t: 'unwatch'; key: string }
  /** a Scope module's screen: per input the outputs cabled into it (summed), and its window in samples; `output`: its one
   *  input is what is heard instead (the Output scope, #1029: either engine, or the signal listened to; left and right averaged) */
  | { t: 'view'; key: string; chans: { id: number; port: string }[][]; samples: number; voices?: boolean; output?: boolean }
  | { t: 'unview'; key: string }
  /** an envelope display: its copies' stage and level (Engine.envStates), sent about 30 times a second */
  | { t: 'envwatch'; key: string; id: number }
  | { t: 'unenvwatch'; key: string }
  /** listen to these outputs on their own instead of the Output (#939, listen.ts); null: the Output again */
  | { t: 'listen'; srcs: ListenSource[] | null }
  | { t: 'on'; note: number; vel: number; ch?: number; root?: boolean }
  | { t: 'off'; note: number; ch?: number; root?: boolean }
  | { t: 'entry'; id: number; token: number; note: number; vel: number; down: boolean; ch?: number; root?: boolean }
  | { t: 'chord'; button: number; down: boolean; track?: number }
  | { t: 'clock' }
  /** MIDI Start / Continue / Stop; top: from the top (Start), or `at` clock ticks into the song (Continue after a Song
   * Position: input.ts, #870, #596) */
  | { t: 'clockrun'; on: boolean; top?: boolean; at?: number }
  /** pitch bend, a control change, channel aftertouch, all notes off: `ch` the MIDI channel a controller sent it on (1..16),
   *  which the engines do not filter on (one set of performance controls) and Live sends on to the FM-1 as it came (#1155) */
  | { t: 'bend'; v: number; ch?: number }
  | { t: 'cc'; n: number; v: number; ch?: number }
  /** a test phrase (#945, phrases.ts) played into the keys, block-exact; another replaces it, null stops it */
  | { t: 'phrase'; phrase: Phrase | null; loop?: boolean }
  /** record the engine's output (#946) and send it back in chunks (`rec`), the last one when it stops */
  | { t: 'record'; on: boolean }
  | { t: 'at'; v: number; ch?: number }
  | { t: 'panic'; ch?: number }
  /** the FM-1 engine's WebAssembly (public/fm1-engine.wasm): compiled here (a compiled module does not cross into an
   * AudioWorklet), it starts beside the browser engine */
  | { t: 'fm1wasm'; bytes: ArrayBuffer }
  /** a message for the FM-1 engine by module index (fm1-engine-host.ts); a load is answered with { fm1load: its error, 0 none } */
  | { t: 'fm1'; o: Fm1Op }
  /** which engine is heard: the FM-1 engine (on) or the browser engine */
  | { t: 'fm1use'; on: boolean };

/** blocks without MIDI clock after which it no longer drives the clock (about half a second) */
const CLOCK_GONE = Math.round((0.5 * sampleRate) / 128);
/** frames in one chunk of a recording sent to the page (about a third of a second) */
const REC_CHUNK = 16384;
/** the crossfade between the engines' outputs when the page switches, in seconds */
const SWITCH_FADE = 0.02;

class ModularProcessor extends AudioWorkletProcessor {
  private engine = new Engine(sampleRate);
  /** blocks since the last MIDI clock tick: after half a second without one the Main module's tempo drives the clock again,
   * unless the transport runs on MIDI clock: then it waits for the clock (a stalled host, #870; clock_in.h the same) */
  private sinceClock = Infinity;
  private failed = false;
  private revision = 0;
  private valuesRequested = false;
  private displayBlocks = 0;
  /** outputs patched into the editor's sidebar sliders (Patch.slackFrom, zoomFrom) by key: their mean over two blocks, sent
   * about 170 times a second */
  private watched = new Map<string, { id: number; port: string; sum: number; n: number }>();
  /** Scope screens on show: their inputs' histories (scope-stream.ts), sent about 30 times a second */
  private views = new Map<string, { chans: { id: number; port: string }[][]; samples: number; streams: ViewStream[]; voices: VoiceStreams[] | null; output: boolean }>();
  private viewSum = new Float32Array(128);
  /** the per-voice sums of a Scope input fed by several outputs (voiceSums) */
  private voiceScratch: Float32Array[] = [];
  /** envelope displays on show: module id by key */
  private envs = new Map<string, number>();
  /** the Steps modules' places as last sent (the editor's grids draw the playhead), blocks since */
  private stepsSent = '';
  /** the transport as last told to the page (play once starts and stops it of itself) */
  private runSent = false;
  private stepsBlocks = 0;
  /** the test phrase playing (#945): into both engines (the FM-1 engine's notes as they reach the FM-1, fm1-engine.ts) */
  private phrase: PhrasePlayer | null = null;
  private phraseOn = (note: number, vel: number): void => (this.engine.noteOn(note, vel), this.fm1?.hear({ t: 'on', note, vel }));
  private phraseOff = (note: number): void => (this.engine.noteOff(note), this.fm1?.hear({ t: 'off', note }));
  /** the recording (#946): the chunk being filled and how far */
  private rec: [Float32Array, Float32Array] | null = null;
  private recAt = 0;
  /** the FM-1 engine (#941), once the page sent its WebAssembly and it compiled; heard while useFm1, through a crossfade
   * (mix 0 the browser engine .. 1 the FM-1 engine) */
  private fm1: Fm1Engine | null = null;
  /** its messages while it compiles (null: not compiling) */
  private fm1Waiting: Fm1Op[] | null = null;
  private useFm1 = false;
  private mix = 0;
  private fm1L = new Float32Array(128);
  private fm1R = new Float32Array(128);
  /** the FM-1 engine from its compiled module: what the page set before (the transport, the tempo, the clock), then the
   *  messages that came while it compiled (the patch's load among them sets the patch buttons, as the patch has them) */
  private startFm1(module: WebAssembly.Module): void {
    const waiting = this.fm1Waiting ?? [];
    this.fm1Waiting = null;
    try {
      this.fm1 = new Fm1Engine(module, sampleRate);
    } catch (e) {
      this.port.postMessage({ fm1error: String(e) });   // (the browser engine plays on)
      return;
    }
    this.fm1.hear({ t: 'transport', on: this.engine.transportRunning });
    this.fm1.hear({ t: 'tempo', bpm: this.engine.tempoGlobal });
    this.fm1.hear({ t: 'meter', meter: this.engine.meter });
    if (this.sinceClock <= CLOCK_GONE) this.fm1.clockExternal(true);
    for (const o of waiting) this.applyFm1(o);
  }
  private applyFm1(o: Fm1Op): void {
    const err = this.fm1?.apply(o) ?? -1;
    if (o.op === 'load') this.port.postMessage({ fm1load: err });
  }
  /** the signal listened to instead of the Output (#939) */
  private listen = new ListenMix(sampleRate);
  /** the Output's loudness (#940): K-weighted 100 ms steps of what the engine renders, before any listened signal */
  private meter = new KMeter(sampleRate);
  constructor() {
    super();
    this.port.onmessage = (ev: MessageEvent<HostMsg>) => {
      const m = ev.data;
      try {
        if (m.t === 'fm1wasm') {
          this.fm1 = null;
          this.fm1Waiting = [];
          // (compiled off the audio thread; the browser engine plays on meanwhile)
          WebAssembly.compile(m.bytes).then((module) => this.startFm1(module), (e: unknown) => {
            this.fm1Waiting = null;
            this.port.postMessage({ fm1error: String(e) });
          });
          return;
        }
        if (m.t === 'fm1') {
          if (this.fm1Waiting) this.fm1Waiting.push(m.o);
          else this.applyFm1(m.o);
          return;
        }
        if (m.t === 'fm1use') {
          this.useFm1 = m.on;
          return;
        }
        if (m.t === 'patch') {
          this.engine.load(m.patch, false, !!m.fresh);
          for (const v of this.views.values()) {
            v.streams = v.chans.map(() => new ViewStream(v.samples));
            v.voices &&= v.chans.map(() => new VoiceStreams(v.samples));
          }
          this.displayBlocks = 0;
          this.revision = m.revision ?? 0;
          this.failed = false;
        }
        else if (m.t === 'values') this.valuesRequested = true;
        else if (m.t === 'param') this.engine.setParam(m.id, m.name, m.value);
        else if (m.t === 'att') this.engine.setAtt(m.id, m.index, m.value);
        else if (m.t === 'bypass') this.engine.setBypass(m.id, m.on);
        else if (m.t === 'range') this.engine.setRange(m.id, m.index, m.name, m.range);
        else if (m.t === 'watch') this.watched.set(m.key, { id: m.id, port: m.port, sum: 0, n: 0 });
        else if (m.t === 'unwatch') this.watched.delete(m.key);
        else if (m.t === 'view') this.views.set(m.key, { chans: m.chans, samples: m.samples, streams: m.chans.map(() => new ViewStream(m.samples)), voices: m.voices ? m.chans.map(() => new VoiceStreams(m.samples)) : null, output: !!m.output });
        else if (m.t === 'unview') this.views.delete(m.key);
        else if (m.t === 'envwatch') this.envs.set(m.key, m.id);
        else if (m.t === 'unenvwatch') this.envs.delete(m.key);
        else if (m.t === 'listen') this.listen.set(m.srcs);
        else if (m.t === 'transport') this.engine.transport(m.on);
        else if (m.t === 'once') this.engine.playOnce();
        else if (m.t === 'cin') this.engine.countIn(m.bars);
        else if (m.t === 'tempo') this.engine.tempoGlobal = m.bpm;
        else if (m.t === 'meter') this.engine.meter = meterOf(m.meter);
        else if (m.t === 'button') this.engine.setButton(m.i, m.on);
        else if (m.t === 'track') this.engine.setTrack(m.id, m.notes, m.pat);
        else if (m.t === 'pattern') this.engine.setPattern(m.p);
        else if (m.t === 'song') this.engine.setSong(m.n);
        else if (m.t === 'songs') this.engine.setSongs(m.songs);
        else if (m.t === 'mute') this.engine.setMute(m.id, m.on);
        else if (m.t === 'fill') this.engine.setFill(m.on);
        else if (m.t === 'arm') this.engine.arm(m.devices);
        else if (m.t === 'rec') this.engine.setRec(m.id, m.on);
        else if (m.t === 'thru') this.engine.thru(m.id, m.note, m.vel);
        else if (m.t === 'entry') {
          const notes = this.engine.entryNotes(m.id, m.note, m.down, m.root);
          this.port.postMessage({ entry: { ...m, notes } });
          if (!notes.length) return;
          this.fm1?.hear(m, notes.length);
          if (m.down) this.engine.noteOn(m.note, m.vel, m.ch, m.root);
          else this.engine.noteOff(m.note, m.ch, m.root);
        }
        else if (m.t === 'chord') this.engine.chordButton(m.button, m.down, m.track);
        else if (m.t === 'on') this.engine.noteOn(m.note, m.vel, m.ch, m.root);
        else if (m.t === 'off') this.engine.noteOff(m.note, m.ch, m.root);
        else if (m.t === 'clock') {                   // MIDI clock: it drives the clock while it comes in
          if (this.sinceClock > CLOCK_GONE) {
            this.engine.clockExternal(true);
            this.fm1?.clockExternal(true);
          }
          this.sinceClock = 0;
          this.engine.clockTick();
        } else if (m.t === 'clockrun') {              // MIDI Start / Continue / Stop
          if (m.top) this.engine.transportTop(m.at ?? 0);
          else this.engine.transport(m.on);
        }
        else if (m.t === 'bend') this.engine.bend(m.v);
        else if (m.t === 'cc') this.engine.cc(m.n, m.v);
        else if (m.t === 'at') this.engine.aftertouch(m.v);
        else if (m.t === 'phrase') {
          this.phrase?.release(this.phraseOff);
          this.phrase = m.phrase ? new PhrasePlayer(m.phrase, !!m.loop, sampleRate) : null;
        }
        else if (m.t === 'record') {
          if (m.on && !this.rec) (this.rec = [new Float32Array(REC_CHUNK), new Float32Array(REC_CHUNK)]), (this.recAt = 0);
          else if (!m.on && this.rec) this.sendRec(true);
        }
        else if (m.t === 'panic') this.engine.allNotesOff();
        if (m.t !== 'entry') this.fm1?.hear(m);   // (the FM-1 engine: the messages without a module index)
      } catch (e) {
        this.port.postMessage({ error: String(e) });
      }
    };
  }
  private sendDisplays(): void {
    if (++this.displayBlocks < DISPLAY_EVERY) return;
    this.displayBlocks = 0;
    for (const [key, v] of this.views) {
      const chans: ViewData[] = v.streams.map((s) => s.data());
      const voices = v.voices?.map((s) => s.data()) ?? null;
      const bufs = [...chans, ...(voices ?? []).flatMap((x) => x ?? [])].flatMap((c) => ('raw' in c ? [c.raw.buffer] : [c.min.buffer, c.max.buffer]));
      this.port.postMessage({ view: key, chans, voices, sr: sampleRate }, bufs);
    }
    for (const [key, id] of this.envs) this.port.postMessage({ env: key, states: this.engine.envStates(id) });
  }

  /** the recorded chunk to the page (transferred); `last`: the recording ends with it */
  private sendRec(last: boolean): void {
    const [l, r] = this.rec!;
    const n = this.recAt;
    const chunk = [l.slice(0, n), r.slice(0, n)];
    this.port.postMessage({ rec: chunk, last }, chunk.map((c) => c.buffer));
    this.rec = last ? null : [new Float32Array(REC_CHUNK), new Float32Array(REC_CHUNK)];
    this.recAt = 0;
  }

  /** this block's output into the recording */
  private feedRec(left: Float32Array, right: Float32Array): void {
    for (let i = 0; i < left.length;) {
      const n = Math.min(left.length - i, REC_CHUNK - this.recAt);
      this.rec![0].set(left.subarray(i, i + n), this.recAt);
      this.rec![1].set(right.subarray(i, i + n), this.recAt);
      this.recAt += n;
      i += n;
      if (this.recAt === REC_CHUNK) this.sendRec(false);
    }
  }

  /** each Scope input: the sum of what is cabled into it (as Engine.probe sees each output); the Output scope's: what is
   *  heard this block (`left` / `right` after the engines and the listened signal) */
  private feedViews(left: Float32Array, right: Float32Array, n: number): void {
    if (this.viewSum.length < n) this.viewSum = new Float32Array(n);
    const sum = this.viewSum;
    for (const v of this.views.values()) {
      if (v.output) {
        for (let k = 0; k < n; k++) sum[k] = (left[k] + right[k]) * 0.5;
        v.streams[0].push(sum, n);
        continue;
      }
      v.chans.forEach((srcs, i) => {
        v.voices?.[i].push(voiceSums(srcs.map((s) => this.engine.probeVoices(s.id, s.port)), n, this.voiceScratch), n);
        if (srcs.length === 1) return v.streams[i].push(this.engine.probe(srcs[0].id, srcs[0].port), n);
        sum.fill(0, 0, n);
        for (const s of srcs) {
          const b = this.engine.probe(s.id, s.port);
          if (b) for (let k = 0; k < n; k++) sum[k] += b[k];
        }
        v.streams[i].push(srcs.length ? sum : null, n);
      });
    }
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

  /** the FM-1 engine's block, and while it is heard (or the crossfade runs) it in place of the browser engine's in l / r */
  private mixFm1(l: Float32Array, r: Float32Array | undefined): void {
    const n = l.length;
    if (this.fm1L.length < n) (this.fm1L = new Float32Array(n)), (this.fm1R = new Float32Array(n));
    try {
      this.fm1!.render(this.fm1L, this.fm1R, n);   // (always: its voices and sequencer keep time with the browser engine's)
    } catch (e) {
      this.port.postMessage({ fm1error: String(e) });
      this.fm1 = null;   // (the browser engine plays on)
      this.mix = 0;
      return;
    }
    const target = this.useFm1 ? 1 : 0;
    if (this.mix === 0 && target === 0) return;
    const step = 1 / (SWITCH_FADE * sampleRate);
    let m = this.mix;
    for (let i = 0; i < n; i++) {
      if (m !== target) m = target > m ? Math.min(target, m + step) : Math.max(target, m - step);
      l[i] += m * (this.fm1L[i] - l[i]);
      if (r) r[i] += m * (this.fm1R[i] - r[i]);
    }
    this.mix = m;
  }

  process(_in: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0];
    try {
      if (this.sinceClock <= CLOCK_GONE && (this.sinceClock < CLOCK_GONE || !this.engine.transportStarted) && ++this.sinceClock > CLOCK_GONE) {
        this.engine.clockExternal(false);
        this.fm1?.clockExternal(false);
      }
      if (this.phrase && !this.phrase.block(out[0].length, this.phraseOn, this.phraseOff)) {
        this.phrase = null;
        this.port.postMessage({ phrase: false });   // (a phrase played once is over: the page's Phrase button follows)
      }
      this.engine.render(out[0], out[1] ?? out[0]);
      if (this.fm1) this.mixFm1(out[0], out[1]);
      if (this.rec) this.feedRec(out[0], out[1] ?? out[0]);   // (what is heard: either engine)
      this.meter.push(out[0], out[1] ?? null, out[0].length);
      const steps = this.meter.take();
      if (steps.length) this.port.postMessage({ loud: steps });
      const heard = this.listen.sources;   // (the browser engine's signal, whichever engine is heard)
      if (heard) this.listen.process(out[0], out[1] ?? out[0], out[0].length, heard.map((s) => this.engine.probe(s.id, s.port)), this.engine.outputLevel());
      if (this.views.size) this.feedViews(out[0], out[1] ?? out[0], out[0].length);
      if (this.views.size || this.envs.size) this.sendDisplays();
      if (this.watched.size) this.feedWatch(out[0].length);
      if (this.engine.transportRunning !== this.runSent) {
        this.runSent = this.engine.transportRunning;
        this.port.postMessage({ run: this.runSent });   // (the page follows play once's start and stop, #632)
      }
      const took = this.engine.takeRecorded();
      if (took.length) this.port.postMessage({ recorded: took });   // live recording on a Steps track (#135)
      if (++this.stepsBlocks >= DISPLAY_EVERY / 2) {   // the Steps modules' playheads, about 60 times a second when they move
        this.stepsBlocks = 0;
        const v = this.engine.stepsView();
        const pats = this.engine.patternView();
        const s = JSON.stringify([v, pats]);
        if (s !== this.stepsSent) {
          this.stepsSent = s;
          this.port.postMessage({ steps: v, pats });
        }
      }
      if (this.valuesRequested) {
        this.valuesRequested = false;
        this.port.postMessage({ values: this.engine.parameterValues(), revision: this.revision });
      }
    } catch (e) {
      if (!this.failed) this.port.postMessage({ error: `audio: ${e}` });
      this.failed = true; // stay silent instead of throwing in the audio thread on every block
      out[0].fill(0);
      out[1]?.fill(0);
    }
    return true;
  }
}
registerProcessor('matryoshka', ModularProcessor as never);
