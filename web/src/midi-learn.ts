// SPDX-License-Identifier: GPL-3.0-only
// MIDI learn (#1067): a MIDI controller's CC, pitch bend or note moves one card row. The bindings live in the patch
// (Patch.midiLearn), so they are saved, shared and undone with it, and the FM-1's binary carries the ones on its pages
// (patchbin.ts mapRecord), so the FM-1 plays them without the editor (firmware/src/midi_learn.c, which learns too).
// Messages from an FM-1 are never learned and never redirected (main.ts): its knobs and keys keep their meaning.
import { NOTE_NAMES, type ModuleDef, type ParamDef, type Patch } from './patch';
import type { HostMsg } from './worklet';

/** a learned note as the patch's JSON holds it: `note:36` (0..127) */
export type NoteSource = `note:${number}`;
/** what moves a row: a control change number (0..119), pitch bend or a note */
export type LearnSource = number | 'bend' | NoteSource;
/** one learned source and the row it moves (a module's parameter: a card row names one). `lo`, `hi`: where the source's
 *  lowest and highest value land in the row's range, 0..1 (0 and 1 when left out; lo above hi turns it round) */
export interface MidiBinding {
  src: LearnSource;
  module: number;
  param: string;
  lo?: number;
  hi?: number;
}
/** the most bindings a patch holds (patchbin.ts MAPS_MAX, the FM-1's ENG_MAPS_MAX) */
export const MIDI_LEARN_MAX = 16;
/** a row of the patch: a module's parameter */
export interface LearnRow {
  module: number;
  param: string;
}

/** the CCs that press Main's patch buttons (input.ts editorCc: 80..86, one per PANEL_BUTTONS entry) */
export const BUTTON_CC = 80;
export const BUTTON_CCS = 7;

/** can this CC be learned? Not 80..86, the patch buttons, and not 120..127, the channel mode messages (123 is panic) */
export const learnableCc = (n: number): boolean =>
  Number.isInteger(n) && n >= 0 && n < 120 && !(n >= BUTTON_CC && n < BUTTON_CC + BUTTON_CCS);

export const noteSource = (n: number): NoteSource => `note:${n}`;

/** a note source's note (0..127), else null */
export function sourceNote(src: unknown): number | null {
  if (typeof src !== 'string' || !/^note:(0|[1-9][0-9]{0,2})$/.test(src)) return null;
  const n = Number(src.slice(5));
  return n <= 127 ? n : null;
}

const isSource = (src: unknown): src is LearnSource =>
  src === 'bend' || (typeof src === 'number' && learnableCc(src)) || sourceNote(src) !== null;

/** a message as a learnable source, its position (0..1) and its raw value: a CC's value over 127; pitch bend with its
 *  centre at 0.5 and its ends at 0 and 1 (input.ts sends it as -1 .. 8191/8192); a note-on's velocity over 127. `off`: a
 *  note-off (a note-on of velocity 0 too), which moves nothing */
export function sourceOf(msg: HostMsg): { src: LearnSource; u: number; raw: number; off?: true } | null {
  if (msg.t === 'cc') return learnableCc(msg.n) ? { src: msg.n, u: Math.min(1, Math.max(0, msg.v / 127)), raw: msg.v } : null;
  if (msg.t === 'on' || msg.t === 'off') {
    if (!Number.isInteger(msg.note) || msg.note < 0 || msg.note > 127) return null;
    const vel = msg.t === 'on' ? Math.round(Math.min(1, Math.max(0, msg.vel)) * 127) : 0;
    return vel ? { src: noteSource(msg.note), u: vel / 127, raw: vel } : { src: noteSource(msg.note), u: 0, raw: 0, off: true };
  }
  if (msg.t !== 'bend') return null;
  const v = Math.min(1, Math.max(-1, msg.v));
  return { src: 'bend', u: Math.min(1, v < 0 ? (v + 1) / 2 : 0.5 + (v * 8192) / 8191 / 2), raw: Math.round(v * 8192) };
}

/** a source's name: `CC 1`, `pitch bend`, `NOTE C2` (note 36: C4 = 60, the FM-1 shows the same) */
export function sourceName(src: LearnSource): string {
  if (src === 'bend') return 'pitch bend';
  const n = sourceNote(src);
  return n === null ? `CC ${src}` : `NOTE ${NOTE_NAMES[n]}`;
}

/** a row a button or a note flips: a toggle or a two-way choice (it learns from two values, a note toggles it) */
export const switchRow = (pd: ParamDef): boolean => !!pd.toggle || pd.choices?.length === 2;

/** the CCs with a fixed job and the words the "also sent" warning gives them (the FM-1's MAP_NOW tail names the same) */
const FIXED_JOBS: Record<number, string> = { 1: 'mod wheel', 2: 'breath', 16: 'turns K1', 17: 'turns K2', 18: 'turns K3', 19: 'turns K4', 22: 'morph', 64: 'sustain', 65: 'foot' };

/** the "also sent" warning for fixed-job CCs heard from the learned control's input during a learn: `CC 16 also sent:
 *  turns K1`, one per CC; '' for none (CCs without a fixed job are left out) */
export const alsoSentText = (ccs: number[]): string =>
  ccs.filter((n) => FIXED_JOBS[n]).map((n) => `CC ${n} also sent: ${FIXED_JOBS[n]}`).join('; ');

/** what a source does in the editor while no row has learned it (input.ts editorCc, engine.ts cc / bend), else null (a
 *  note plays itself: the editor says so in its own words) */
export function sourceJob(src: LearnSource): string | null {
  if (src === 'bend') return 'Main’s pitch bend';
  if (typeof src !== 'number') return null;
  const jobs: Record<number, string> = { 1: 'Main’s mod wheel', 2: 'Main’s breath', 22: 'Main’s morph', 64: 'Main’s sustain', 65: 'Main’s foot' };
  if (src >= 16 && src <= 19) return `Main’s K${src - 15}`;
  return jobs[src] ?? null;
}

/** the bindings from JSON made valid: a learnable source and a parameter of a module in the patch. One row per source and
 *  one source per row: a later entry replaces an earlier one, as learning again does */
export function fixMidiLearn(raw: unknown, modules: { id: number; type: string }[], defs: Record<string, ModuleDef>): MidiBinding[] {
  if (!Array.isArray(raw)) return [];
  let out: MidiBinding[] = [];
  const end = (x: unknown): number | undefined => (typeof x === 'number' && Number.isFinite(x) ? rangeEnd(x) : undefined);
  for (const b of raw as Partial<MidiBinding>[]) {
    if (!b || typeof b !== 'object' || !isSource(b.src) || typeof b.param !== 'string') continue;
    const m = modules.find((x) => x.id === b.module);
    if (!m || !defs[m.type]?.params.some((q) => q.name === b.param && !q.screen)) continue;
    out = out.filter((x) => x.src !== b.src && !(x.module === m.id && x.param === b.param));
    const lo = end(b.lo), hi = end(b.hi);
    out.push({ src: b.src, module: m.id, param: b.param, ...(lo !== undefined && lo !== 0 ? { lo } : {}), ...(hi !== undefined && hi !== 1 ? { hi } : {}) });
  }
  return out.slice(0, MIDI_LEARN_MAX);
}

const sameRow = (b: LearnRow, r: LearnRow): boolean => b.module === r.module && b.param === r.param;

const keep = (p: Patch, list: MidiBinding[]): void => {
  if (list.length) p.midiLearn = list;
  else delete p.midiLearn;
};

/** bind a source to a row over its whole range: the source leaves any other row, and the row any other source. False
 *  when the patch already holds MIDI_LEARN_MAX others */
export function bindRow(p: Patch, b: MidiBinding): boolean {
  const rest = (p.midiLearn ?? []).filter((x) => x.src !== b.src && !sameRow(x, b));
  if (rest.length >= MIDI_LEARN_MAX) return false;
  keep(p, [...rest, { src: b.src, module: b.module, param: b.param }]);
  return true;
}

/** a range end as the FM-1's binary holds it: 0..1 in steps of 1/255 */
export const rangeEnd = (x: number): number => Math.round(Math.min(1, Math.max(0, x)) * 255) / 255;

/** where a row's source lands in its range: lo for its lowest value, hi for its highest (0..1); false without a binding */
export function setLearnRange(p: Patch, r: LearnRow, lo: number, hi: number): boolean {
  const b = p.midiLearn?.find((x) => sameRow(x, r));
  if (!b) return false;
  lo = rangeEnd(lo);
  hi = rangeEnd(hi);
  if (lo) b.lo = lo;
  else delete b.lo;
  if (hi !== 1) b.hi = hi;
  else delete b.hi;
  return true;
}

/** forget a row's source; false when it had none */
export function unbindRow(p: Patch, r: LearnRow): boolean {
  const list = p.midiLearn ?? [];
  if (!list.some((x) => sameRow(x, r))) return false;
  keep(p, list.filter((x) => !sameRow(x, r)));
  return true;
}

/** forget a source; false when no row had it */
export function unbindSource(p: Patch, src: LearnSource): boolean {
  const list = p.midiLearn ?? [];
  if (!list.some((x) => x.src === src)) return false;
  keep(p, list.filter((x) => x.src !== src));
  return true;
}

export const bindingOfRow = (p: Patch, r: LearnRow): MidiBinding | undefined => p.midiLearn?.find((x) => sameRow(x, r));

/** the binding a source drives now: none while its module is gone (it is deleted, until an undo brings it back), so the
 *  source does its old job meanwhile */
export const liveBinding = (p: Patch, src: LearnSource): MidiBinding | undefined => {
  const b = p.midiLearn?.find((x) => x.src === src);
  return b && p.modules.some((m) => m.id === b.module) ? b : undefined;
};

/** different values a source sends before learn takes it: a knob, a fader, a pad's axis or the bend wheel gets there at
 *  once, a pad's touch switch (127 on touch, 0 on release) never does. A switch row takes a button: two values. A note-on
 *  is learned at once */
export const LEARN_VALUES = 3;
export const LEARN_VALUES_SWITCH = 2;
/** a learned source moves its row at most this often (ms); the latest value is applied after the gap */
export const MOVE_GAP_MS = 25;

/** where a binding puts its row for a source at u (0..1): between its ends (the FM-1 the same: midi_learn.c map_midi) */
const between = (b: MidiBinding, u: number): number => (b.lo ?? 0) + ((b.hi ?? 1) - (b.lo ?? 0)) * u;

export interface LearnHost {
  patch(): Patch;
  /** move a row to position u (0..1) of its range, as a knob does (Editor.setRowAt): an edit, one undo step per gesture */
  setRow(module: number, param: string, u: number): void;
  /** a switch row's position now (0..1 of its range; switchRow), null for any other row: a learned note flips it */
  switchAt(module: number, param: string): number | null;
  /** learn found the row's source: bind it (an undo step). `also`: the fixed-job CCs (alsoSentText) the same input sent
   *  while the row waited, which the control may send beside its own */
  learned(b: MidiBinding, also: number[]): void;
  /** learn started on a row, or stopped (null) */
  waiting(row: LearnRow | null): void;
  now?(): number;
}

/**
 * The learn wait and the learned moves. `take` hears every message from a MIDI controller (never an FM-1). While a row
 * waits, every CC, pitch bend and note-on goes to the wait: a note-on is bound at once, else the first source to send
 * enough different values. Then a bound source moves its row, throttled, and does nothing else: a bound note flips a
 * switch row to its farther end, else puts its row at its velocity between the ends; its note-off does nothing.
 */
export class MidiLearn {
  private target: (LearnRow & { need: number }) | null = null;
  private seen = new Map<LearnSource, Set<number>>();
  /** the fixed-job CCs each input sent while the row waited (the "also sent" warning) */
  private heard = new Map<unknown, Set<number>>();
  private moves = new Map<LearnSource, { at: number; u: number; timer: number }>();

  constructor(private host: LearnHost) {}

  /** the row waiting for its source */
  get waitingRow(): LearnRow | null {
    return this.target && { module: this.target.module, param: this.target.param };
  }

  /** wait for a source for this row (`switchRow`: a toggle or a two-way choice, which a button may drive) */
  start(row: LearnRow, switchRow = false): void {
    this.target = { module: row.module, param: row.param, need: switchRow ? LEARN_VALUES_SWITCH : LEARN_VALUES };
    this.seen.clear();
    this.heard.clear();
    this.host.waiting(this.waitingRow);
  }

  /** stop waiting; false when nothing waited */
  cancel(): boolean {
    if (!this.target) return false;
    this.target = null;
    this.seen.clear();
    this.heard.clear();
    this.host.waiting(null);
    return true;
  }

  /** a message from a MIDI controller (`from`: its input): true when learn took it (it then does nothing else) */
  take(msg: HostMsg, from?: unknown): boolean {
    const s = sourceOf(msg);
    if (!s) return false;
    const p = this.host.patch();
    if (this.target && !s.off) {
      if (typeof s.src === 'number' && FIXED_JOBS[s.src]) {
        const ccs = this.heard.get(from) ?? new Set<number>();
        this.heard.set(from, ccs.add(s.src));
      }
      if (sourceNote(s.src) === null) {
        const vals = this.seen.get(s.src) ?? new Set<number>();
        vals.add(s.raw);
        this.seen.set(s.src, vals);
        if (vals.size < this.target.need) return true;
      }
      const row = this.target;
      // (a CC another row learned does that row's job, not its fixed one)
      const also = [...(this.heard.get(from) ?? [])].filter((n) => n !== s.src && !liveBinding(p, n)).sort((a, b) => a - b);
      this.cancel();
      if (p.modules.some((m) => m.id === row.module)) this.host.learned({ src: s.src, module: row.module, param: row.param }, also);
      return true;
    }
    const b = liveBinding(p, s.src);
    if (!b) return false;
    if (s.off) return true;
    if (sourceNote(s.src) === null) return this.move(s.src, s.u), true;
    // a note: a switch row goes to the end farther from where it is (hi on a tie), as the FM-1's midi_learn.c does
    const at = this.host.switchAt(b.module, b.param);
    const lo = b.lo ?? 0, hi = b.hi ?? 1;
    this.host.setRow(b.module, b.param, at === null ? between(b, s.u) : Math.abs(hi - at) >= Math.abs(lo - at) ? hi : lo);
    return true;
  }

  /** at most one move per MOVE_GAP_MS for each source: the first at once, the latest after the gap */
  private move(src: LearnSource, u: number): void {
    const now = this.host.now?.() ?? performance.now();
    const m = this.moves.get(src) ?? { at: -Infinity, u, timer: 0 };
    this.moves.set(src, m);
    m.u = u;
    if (m.timer) return;
    const run = (): void => {
      m.timer = 0;
      m.at = this.host.now?.() ?? performance.now();
      const b = liveBinding(this.host.patch(), src);
      if (b) this.host.setRow(b.module, b.param, between(b, m.u));
    };
    const wait = m.at + MOVE_GAP_MS - now;
    if (wait <= 0) run();
    else m.timer = window.setTimeout(run, wait);
  }
}

/** the MIDI controllers' messages through learn first (main.ts, attachMidi's host): what learn takes reaches nothing else
 *  (`next`: the sink, so a learned CC, bend or note never reaches the keys, the engines or the FM-1). An FM-1's messages
 *  (`fm1`) never go to learn, nor a message without its input */
export const learnFirst = <I>(learn: Pick<MidiLearn, 'take'>, fm1: (from: I) => boolean, next: (msg: HostMsg) => void) =>
  (msg: HostMsg, from?: I): void => {
    if (from && !fm1(from) && learn.take(msg, from)) return;
    next(msg);
  };
