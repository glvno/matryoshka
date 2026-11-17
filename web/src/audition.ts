// SPDX-License-Identifier: GPL-3.0-only
// The Listen block at the top of the Sound design sidebar (#1048; once the deck's Phrase group): a test phrase (#945) on
// a chosen root, once or looped, played from its round button or Q; My take, the last run of notes the user played, as a
// phrase; the phrase rendered to a WAV file and the Output recorded to one (#946). The block never changes height: the
// second line holds WAV, Rec (a timer and Save while it records) and a status that fades back. The choice and My take
// are this browser's, not the patch's.
import type { HostMsg } from './worklet';
import type { Patch } from './patch';
import { NOTE_NAMES } from './modules';
import { popMenu, type MenuItem } from './menu';
import { PHRASES, ROOT_OCTAVES, TakeRecorder, drumNotes, makePhrase, rootNote, takePhrase, type Phrase, type PhraseKind, type PhraseNote } from './phrases';
import { WAV_RATE, encodeWav, joinChunks, wavName } from './wav';
import type { RenderSetup } from './phrase-render';

export interface PhraseChoice {
  kind: PhraseKind;
  /** 0 (C) .. 11 (B) */
  pitch: number;
  octave: number;
  loop: boolean;
}

export const DEFAULT_CHOICE: PhraseChoice = { kind: 'held', pitch: 0, octave: 4, loop: false };
const STORE = 'matryoshka.phrase';
/** My take's notes (PhraseNote[]) */
const TAKE_STORE = 'matryoshka.take';
/** each phrase in one line, in the phrase menu (the mockup's words, #1048) */
const HINTS: Record<PhraseKind, string> = { held: 'attack, sustain, release', staccato: 'eight short notes', chord: 'a major triad, held', sweep: 'four octaves', drums: 'two bars on the kit', take: 'what you played last' };
/** how long the status after a WAV stays before it fades (ms) */
const STATUS_MS = 5000;
/** a recording stops by itself after ten minutes (about 230 MB at 48 kHz) and is saved */
export const REC_MAX_SECONDS = 600;

export interface AuditionHost {
  send(msg: HostMsg): void;
  /** the audio on (the click or key is the gesture the browser wants) */
  start(): Promise<void>;
  sampleRate(): number;
  patch(): Patch;
  /** the patch's file stem (patch-card.ts fileStem) */
  stem(): string;
  armed(): string[];
  /** the global tempo (D-907), null: the patch's own */
  tempo(): number | null;
  status(text: string): void;
  /** the block's state changed (playing, recording): the sidebar's rail shows play too */
  changed?(): void;
  download(bytes: Uint8Array, name: string): void;
  render(patch: Patch, phrase: Phrase, setup: { armed: string[]; tempo: number | null } & Pick<RenderSetup, 'seconds' | 'quiet'>): Promise<[Float32Array, Float32Array]>;
  resample(left: Float32Array, right: Float32Array, from: number): Promise<[Float32Array, Float32Array]>;
  now(): Date;
  /** seconds on a steady clock (performance.now): the takes' timing */
  clock(): number;
}

/** the stored choice, or the default; anything out of range falls back field by field */
export function loadChoice(raw: string | null): PhraseChoice {
  let v: Partial<PhraseChoice> = {};
  try {
    v = raw ? (JSON.parse(raw) as Partial<PhraseChoice>) : {};
  } catch {
    /* not ours: the default */
  }
  return {
    kind: PHRASES.some((p) => p.kind === v.kind) || v.kind === 'take' ? v.kind! : DEFAULT_CHOICE.kind,
    pitch: Number.isInteger(v.pitch) && v.pitch! >= 0 && v.pitch! < 12 ? v.pitch! : DEFAULT_CHOICE.pitch,
    octave: (ROOT_OCTAVES as readonly number[]).includes(v.octave!) ? v.octave! : DEFAULT_CHOICE.octave,
    loop: typeof v.loop === 'boolean' ? v.loop : DEFAULT_CHOICE.loop,
  };
}

/** My take as stored, or null when it is missing or not understood */
export function loadTake(raw: string | null): PhraseNote[] | null {
  try {
    const v = raw ? (JSON.parse(raw) as unknown) : null;
    const ok = (n: PhraseNote): boolean => [n.at, n.len, n.vel].every(Number.isFinite) && n.at >= 0 && n.len >= 0 && Number.isInteger(n.note) && n.note >= 0 && n.note < 128;
    return Array.isArray(v) && v.length && v.every(ok) ? (v as PhraseNote[]) : null;
  } catch {
    return null;
  }
}

/** "Chord C4", "Drum pattern", "My take" */
export function phraseTitle(c: PhraseChoice): string {
  if (c.kind === 'take') return 'My take';
  const label = PHRASES.find((p) => p.kind === c.kind)!.label;
  return c.kind === 'drums' ? label : `${label} ${NOTE_NAMES[rootNote(c.pitch, c.octave)]}`;
}

/** the loudest sample of either channel, in dB of full scale, to one decimal ("−3.2 dBFS"; "silent") */
export function peakText(left: Float32Array, right: Float32Array): string {
  let peak = 0;
  for (const ch of [left, right]) for (let i = 0; i < ch.length; i++) peak = Math.max(peak, Math.abs(ch[i]));
  return peak ? `peak ${(20 * Math.log10(peak)).toFixed(1).replace('-', '−')} dBFS` : 'silent';
}

export class Audition {
  readonly el: HTMLElement;
  choice: PhraseChoice;
  playing = false;
  recording = false;
  private exporting = false;
  private chunks: [Float32Array[], Float32Array[]] = [[], []];
  private recFrames = 0;
  /** the notes the user plays, as the latest take (main.ts feeds it the keys, the on-screen keys and MIDI in) */
  readonly takes = new TakeRecorder();
  /** My take, kept in this browser; null: none made yet */
  myTake: PhraseNote[] | null;
  private playBtn: HTMLButtonElement;
  private loopBtn: HTMLButtonElement;
  private wavBtn: HTMLButtonElement;
  private recBtn: HTMLButtonElement;
  private kindBtn: HTMLButtonElement;
  private rootSel: HTMLSelectElement;
  private statusEl: HTMLElement;
  private statusTimer: ReturnType<typeof setTimeout> | undefined;
  private recStart = 0;
  private recTimer: ReturnType<typeof setInterval> | undefined;

  constructor(private host: AuditionHost, private storage: Pick<Storage, 'getItem' | 'setItem'> | null = null) {
    let raw: string | null = null;
    try {
      raw = storage?.getItem(STORE) ?? null;
    } catch {
      /* storage blocked: the default */
    }
    this.choice = loadChoice(raw);
    let takeRaw: string | null = null;
    try {
      takeRaw = storage?.getItem(TAKE_STORE) ?? null;
    } catch {
      /* storage blocked: no take */
    }
    this.myTake = loadTake(takeRaw);
    if (this.choice.kind === 'take' && !this.myTake) this.choice.kind = DEFAULT_CHOICE.kind;
    const el = document.createElement('div');
    el.className = 'listen';
    el.setAttribute('role', 'group');
    el.setAttribute('aria-label', 'Listen: the same notes for every candidate');
    const make = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text = '', title = ''): HTMLElementTagNameMap[K] => {
      const e = document.createElement(tag);
      e.className = cls;
      e.textContent = text;
      if (title) e.title = title;
      if (e instanceof HTMLButtonElement) e.type = 'button';
      return e;
    };
    const lab = make('div', 'listen-lab');
    lab.append(make('span', 'listen-title', 'Listen'), make('span', 'listen-why', 'the same notes for every candidate', 'The test phrase: the same notes, at 120 bpm and velocity 100, for every candidate you compare'));
    this.playBtn = make('button', 'ph-play', '▶', 'Play the test phrase (Q); again: stop');
    this.kindBtn = make('button', 'ph-kind', '', 'Which test phrase: the same notes at 120 bpm and velocity 100 every time, or My take, what you played last');
    this.kindBtn.setAttribute('aria-haspopup', 'menu');
    this.rootSel = make('select', 'ph-root', '', 'The phrase’s root note (C4: middle C)');
    this.rootSel.setAttribute('aria-label', 'Root note');
    for (const o of ROOT_OCTAVES) for (let i = 0; i < 12; i++) this.rootSel.append(new Option(NOTE_NAMES[rootNote(i, o)], `${o}:${i}`));
    this.loopBtn = make('button', 'ph-loop', '⟲', 'Loop: play the phrase again and again until stopped');
    this.loopBtn.append(make('span', 'ph-word', ' Loop'));
    const line1 = make('div', 'listen-ctl');
    line1.append(this.playBtn, this.kindBtn, this.rootSel, this.loopBtn);
    this.wavBtn = make('button', 'ph-wav', '⤓ WAV', 'Render the test phrase played once to a WAV file (44.1 kHz stereo, nothing limited or normalized)');
    this.recBtn = make('button', 'ph-rec', '', 'Record the Output to a WAV file while you play; again: stop and save');
    this.statusEl = make('span', 'ph-status');
    this.statusEl.setAttribute('aria-live', 'polite');
    const line2 = make('div', 'listen-ctl2');
    line2.append(this.wavBtn, this.recBtn, this.statusEl);
    el.append(lab, line1, line2);
    this.playBtn.onclick = () => this.toggle();
    this.loopBtn.onclick = () => this.choose({ loop: !this.choice.loop });
    this.kindBtn.onclick = () => popMenu(this.phraseMenu(), this.kindBtn);
    this.rootSel.onchange = () => {
      const [octave, pitch] = this.rootSel.value.split(':').map(Number);
      this.choose({ pitch, octave });
    };
    this.wavBtn.onclick = () => void this.exportPhrase();
    this.recBtn.onclick = () => void this.toggleRecord();
    this.el = el;
    this.show();
  }

  /** the phrase menu: each phrase with its one-line hint, My take under a rule, then Use my last take (an action) */
  phraseMenu(): MenuItem[] {
    const mark = (kind: PhraseKind, label: string): string => `${this.choice.kind === kind ? '✓ ' : ''}${label}`;
    return [
      ...PHRASES.map((p): MenuItem => ({ text: mark(p.kind, p.label), key: HINTS[p.kind], run: () => this.choose({ kind: p.kind }) })),
      { text: mark('take', this.myTake ? 'My take' : 'My take (none yet)'), key: HINTS.take, rule: true, run: () => this.choose({ kind: 'take' }) },
      { text: '↺ Use my last take', run: () => this.useTake() },
    ];
  }

  /** something the block says on its second line, fading back after a while (the status line says it too) */
  private say(text: string): void {
    this.host.status(text);
    this.statusEl.textContent = text;
    this.statusEl.title = text;
    this.statusEl.classList.add('on');
    clearTimeout(this.statusTimer);
    this.statusTimer = setTimeout(() => this.statusEl.classList.remove('on'), STATUS_MS);
  }

  private show(): void {
    const c = this.choice;
    this.playBtn.textContent = this.playing ? '■' : '▶';
    this.playBtn.setAttribute('aria-label', this.playing ? 'Stop the test phrase (Q)' : 'Play the test phrase (Q)');
    this.playBtn.setAttribute('aria-pressed', String(this.playing));
    this.loopBtn.setAttribute('aria-pressed', String(c.loop));
    this.kindBtn.textContent = `${c.kind === 'take' ? 'My take' : PHRASES.find((p) => p.kind === c.kind)!.label} ▾`;
    this.rootSel.value = `${c.octave}:${c.pitch}`;
    // (the drum pattern plays the Drum map's rows, My take its own notes, as played)
    this.rootSel.disabled = c.kind === 'drums' || c.kind === 'take';
    this.wavBtn.disabled = this.exporting;
    const s = Math.floor((Date.now() - this.recStart) / 1000);
    this.recBtn.replaceChildren(Object.assign(document.createElement('span'), { className: 'ph-dot' }), this.recording ? 'Save' : 'Rec');
    if (this.recording) this.recBtn.append(Object.assign(document.createElement('span'), { className: 'ph-time', textContent: `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` }));
    this.recBtn.setAttribute('aria-pressed', String(this.recording));
    this.el.classList.toggle('recording', this.recording);
    this.host.changed?.();
  }

  /** the phrase chosen now, on the patch open now (the drum pattern takes its first Drum map's notes) */
  phrase(): Phrase {
    const c = this.choice;
    return c.kind === 'take' ? takePhrase(this.myTake!) : makePhrase(c.kind, rootNote(c.pitch, c.octave), drumNotes(this.host.patch()));
  }

  /** `phrase` played once by `p` instead of the patch open, rendered offline as the WAV export renders it (or as `how`
   *  says: its length, an early stop), in memory only: Generate measures a candidate's probe by it and drops the sound
   *  (mutate-render.ts) */
  renderWith(p: Patch, phrase: Phrase, how: Pick<RenderSetup, 'seconds' | 'quiet'> = {}): Promise<[Float32Array, Float32Array]> {
    return this.host.render(p, phrase, { ...how, armed: this.host.armed(), tempo: this.host.tempo() });
  }

  /** a note the user played, for the takes */
  played(msg: HostMsg): void {
    if (msg.t === 'on') this.takes.on(msg.note, msg.vel, this.host.clock());
    else if (msg.t === 'off') this.takes.off(msg.note, this.host.clock());
  }

  /** My take from the latest take (it replaces the one before, kept in this browser), and chosen as the phrase */
  useTake(): void {
    const notes = this.takes.take(this.host.clock());
    if (!notes) {
      this.show();   // (the menu goes back to the phrase it showed)
      this.host.status('no take yet: play something on the keys, the on-screen keyboard or a MIDI keyboard, then use it');
      return;
    }
    this.myTake = notes;
    try {
      this.storage?.setItem(TAKE_STORE, JSON.stringify(notes));
    } catch {
      /* storage blocked: kept until the page reloads */
    }
    this.choose({ kind: 'take' });
    const p = takePhrase(notes);
    this.host.status(`My take: ${notes.length} note${notes.length === 1 ? '' : 's'}, ${p.length.toFixed(1)} s; ▶ or Q plays it as played`);
  }

  /** change the choice (remembered in this browser); a playing phrase starts again with it. My take before there is one
   *  is no change */
  choose(change: Partial<PhraseChoice>): void {
    if (change.kind === 'take' && !this.myTake) return this.show();
    this.choice = { ...this.choice, ...change };
    try {
      this.storage?.setItem(STORE, JSON.stringify(this.choice));
    } catch {
      /* storage blocked: kept until the page reloads */
    }
    this.show();
    if (this.playing) this.send();
  }

  private send(): void {
    this.host.send({ t: 'phrase', phrase: this.phrase(), loop: this.choice.loop });
    this.host.status(`test phrase: ${phraseTitle(this.choice)}${this.choice.loop ? ', looping (Q stops)' : ''}`);
  }

  async play(): Promise<void> {
    await this.host.start();
    this.playing = true;
    this.show();
    this.send();
  }

  stop(): void {
    if (!this.playing) return;
    this.playing = false;
    this.host.send({ t: 'phrase', phrase: null });
    this.show();
  }

  /** the phrase button and Q */
  toggle(): void {
    if (this.playing) {
      this.stop();
      this.host.status('test phrase stopped');
    } else void this.play();
  }

  /** a playing phrase from its first note (a snapshot switch: each version hears the same notes from the top) */
  restart(): void {
    if (this.playing) this.send();
  }

  /** the audio thread says a phrase played once is over */
  ended(): void {
    this.playing = false;
    this.show();
  }

  /** the phrase played once, rendered offline at 44.1 kHz, as a WAV download */
  async exportPhrase(): Promise<void> {
    if (this.exporting) return;
    this.exporting = true;
    this.show();
    const title = phraseTitle(this.choice);
    try {
      this.host.status(`rendering ${title} to WAV…`);
      const [l, r] = await this.host.render(this.host.patch(), this.phrase(), { armed: this.host.armed(), tempo: this.host.tempo() });
      const name = wavName(this.host.stem(), title.replace(/\s+/g, '-'), this.host.now());
      this.host.download(encodeWav(l, r, WAV_RATE), name);
      this.say(`saved ${name}: ${(l.length / WAV_RATE).toFixed(1)} s, 44.1 kHz stereo, ${peakText(l, r)}`);
    } catch (e) {
      this.say(`the WAV could not be rendered: ${(e as Error).message}`);
    } finally {
      this.exporting = false;
      this.show();
    }
  }

  /** record the Output: the first press starts, the second stops and saves */
  async toggleRecord(): Promise<void> {
    if (this.recording) {
      this.host.send({ t: 'record', on: false });
      return;
    }
    await this.host.start();
    this.chunks = [[], []];
    this.recFrames = 0;
    this.recording = true;
    this.recStart = Date.now();
    this.recTimer = setInterval(() => this.show(), 1000);
    this.host.send({ t: 'record', on: true });
    this.host.status('recording the Output: play, then Save to save the WAV');
    this.show();
  }

  /** a chunk of the recording from the audio thread; the last one saves the file */
  async recorded(chunk: [Float32Array, Float32Array], last: boolean): Promise<void> {
    if (!this.recording) return;
    this.chunks[0].push(chunk[0]);
    this.chunks[1].push(chunk[1]);
    this.recFrames += chunk[0].length;
    const sr = this.host.sampleRate();
    if (!last) {
      if (this.recFrames >= REC_MAX_SECONDS * sr) this.host.send({ t: 'record', on: false });
      return;
    }
    this.recording = false;
    clearInterval(this.recTimer);
    this.show();
    const [l, r] = await this.host.resample(joinChunks(this.chunks[0]), joinChunks(this.chunks[1]), sr);
    this.chunks = [[], []];
    const name = wavName(this.host.stem(), 'recording', this.host.now());
    this.host.download(encodeWav(l, r, WAV_RATE), name);
    this.say(`saved ${name}: ${(l.length / WAV_RATE).toFixed(1)} s, 44.1 kHz stereo, ${peakText(l, r)}`);
  }
}
