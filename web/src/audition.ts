// SPDX-License-Identifier: GPL-3.0-only
// The deck's Phrase group: a test phrase (#945) on a chosen root, once or looped, played from its button or Q; My take, the
// last run of notes the user played, as a phrase; the phrase rendered to a WAV file and the Output recorded to one (#946).
// The choice and My take are this browser's, not the patch's.
import type { HostMsg } from './worklet';
import type { Patch } from './patch';
import { NOTE_NAMES } from './modules';
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
/** the phrase menu's entry that makes My take from the last take (a command, not a phrase) */
const USE_TAKE = 'use-take';
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
  private takeOption: HTMLOptionElement;
  private playBtn: HTMLButtonElement;
  private loopBtn: HTMLButtonElement;
  private wavBtn: HTMLButtonElement;
  private recBtn: HTMLButtonElement;
  private kindSel: HTMLSelectElement;
  private pitchSel: HTMLSelectElement;
  private octaveSel: HTMLSelectElement;

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
    el.className = 'deck-phrase';
    el.setAttribute('role', 'group');
    el.setAttribute('aria-label', 'Test phrase');
    const button = (cls: string, text: string, title: string): HTMLButtonElement => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = cls;
      b.textContent = text;
      b.title = title;
      el.append(b);
      return b;
    };
    const select = (cls: string, label: string, options: [string, string][], title: string): HTMLSelectElement => {
      const s = document.createElement('select');
      s.className = cls;
      s.setAttribute('aria-label', label);
      s.title = title;
      for (const [value, text] of options) s.append(new Option(text, value));
      el.append(s);
      return s;
    };
    this.playBtn = button('ph-play', '▶ Phrase', 'Play the test phrase (Q); again: stop');
    this.kindSel = select('ph-kind', 'Test phrase', [...PHRASES.map((p): [string, string] => [p.kind, p.label]), ['take', 'My take'], [USE_TAKE, '↺ Use my last take']], 'Which test phrase: the same notes at 120 bpm and velocity 100 every time, or My take, what you played last');
    this.takeOption = this.kindSel.querySelector('option[value="take"]')!;
    this.loopBtn = button('ph-loop', 'Loop', 'Play the phrase again and again until stopped');
    this.pitchSel = select('ph-pitch', 'Root note', Array.from({ length: 12 }, (_, i) => [String(i), NOTE_NAMES[60 + i].slice(0, -1)]), 'The phrase’s root note');
    this.octaveSel = select('ph-octave', 'Root octave', ROOT_OCTAVES.map((o) => [String(o), String(o)]), 'The root’s octave (4: middle C)');
    this.wavBtn = button('ph-wav', '⤓ WAV', 'Render the test phrase played once to a WAV file (44.1 kHz stereo, nothing limited or normalized)');
    this.recBtn = button('ph-rec', '● Rec', 'Record the Output to a WAV file while you play; again: stop and save');
    this.playBtn.onclick = () => this.toggle();
    this.loopBtn.onclick = () => this.choose({ loop: !this.choice.loop });
    this.kindSel.onchange = () => (this.kindSel.value === USE_TAKE ? this.useTake() : this.choose({ kind: this.kindSel.value as PhraseKind }));
    this.pitchSel.onchange = () => this.choose({ pitch: Number(this.pitchSel.value) });
    this.octaveSel.onchange = () => this.choose({ octave: Number(this.octaveSel.value) });
    this.wavBtn.onclick = () => void this.exportPhrase();
    this.recBtn.onclick = () => void this.toggleRecord();
    this.el = el;
    this.show();
  }

  private show(): void {
    const c = this.choice;
    this.playBtn.textContent = this.playing ? '■ Stop' : '▶ Phrase';
    this.playBtn.setAttribute('aria-pressed', String(this.playing));
    this.loopBtn.setAttribute('aria-pressed', String(c.loop));
    this.kindSel.value = c.kind;
    this.takeOption.disabled = !this.myTake;
    this.takeOption.textContent = this.myTake ? 'My take' : 'My take (none yet)';
    this.pitchSel.value = String(c.pitch);
    this.octaveSel.value = String(c.octave);
    // (the drum pattern plays the Drum map's rows, My take its own notes, as played)
    this.pitchSel.disabled = this.octaveSel.disabled = c.kind === 'drums' || c.kind === 'take';
    this.wavBtn.disabled = this.exporting;
    this.recBtn.textContent = this.recording ? '■ Save' : '● Rec';
    this.recBtn.setAttribute('aria-pressed', String(this.recording));
  }

  /** the phrase chosen now, on the patch open now (the drum pattern takes its first Drum map's notes) */
  phrase(): Phrase {
    const c = this.choice;
    return c.kind === 'take' ? takePhrase(this.myTake!) : makePhrase(c.kind, rootNote(c.pitch, c.octave), drumNotes(this.host.patch()));
  }

  /** `phrase` played once by `p` instead of the patch open, rendered offline as the WAV export renders it (or as `how`
   *  says: its length, an early stop), in memory only: Make candidates measures a candidate's probe by it and drops the
   *  sound (mutate-render.ts) */
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
      this.host.status(`saved ${name}: ${(l.length / WAV_RATE).toFixed(1)} s, 44.1 kHz stereo, ${peakText(l, r)}`);
    } catch (e) {
      this.host.status(`the WAV could not be rendered: ${(e as Error).message}`);
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
    this.host.send({ t: 'record', on: true });
    this.host.status('recording the Output: play, then ● again (■ Save) to save the WAV');
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
    this.show();
    const [l, r] = await this.host.resample(joinChunks(this.chunks[0]), joinChunks(this.chunks[1]), sr);
    this.chunks = [[], []];
    const name = wavName(this.host.stem(), 'recording', this.host.now());
    this.host.download(encodeWav(l, r, WAV_RATE), name);
    this.host.status(`saved ${name}: ${(l.length / WAV_RATE).toFixed(1)} s, 44.1 kHz stereo, ${peakText(l, r)}`);
  }
}
