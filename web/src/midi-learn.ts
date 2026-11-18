// SPDX-License-Identifier: GPL-3.0-only
// MIDI learn (#1067): a MIDI controller's CC or pitch bend moves one card row. Editor only: the bindings live in the patch
// (Patch.midiLearn), so they are saved, shared and undone with it, and the FM-1's binary never carries them (patchbin.ts
// reads no such field). Messages from an FM-1 are never learned and never redirected (main.ts): its knobs keep their meaning.
import type { ModuleDef, Patch } from './patch';
import type { HostMsg } from './worklet';

/** what moves a row: a control change number (0..119) or pitch bend */
export type LearnSource = number | 'bend';
/** one learned source and the row it moves (a module's parameter: a card row names one) */
export interface MidiBinding {
  src: LearnSource;
  module: number;
  param: string;
}
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

const isSource = (src: unknown): src is LearnSource => src === 'bend' || (typeof src === 'number' && learnableCc(src));

/** a message as a learnable source, its position (0..1) and its raw value: a CC's value over 127; pitch bend with its
 *  centre at 0.5 and its ends at 0 and 1 (input.ts sends it as -1 .. 8191/8192) */
export function sourceOf(msg: HostMsg): { src: LearnSource; u: number; raw: number } | null {
  if (msg.t === 'cc') return learnableCc(msg.n) ? { src: msg.n, u: Math.min(1, Math.max(0, msg.v / 127)), raw: msg.v } : null;
  if (msg.t !== 'bend') return null;
  const v = Math.min(1, Math.max(-1, msg.v));
  return { src: 'bend', u: Math.min(1, v < 0 ? (v + 1) / 2 : 0.5 + (v * 8192) / 8191 / 2), raw: Math.round(v * 8192) };
}

export const sourceName = (src: LearnSource): string => (src === 'bend' ? 'pitch bend' : `CC ${src}`);

/** what a source does in the editor while no row has learned it (input.ts editorCc, engine.ts cc / bend), else null */
export function sourceJob(src: LearnSource): string | null {
  if (src === 'bend') return 'Main’s pitch bend';
  const jobs: Record<number, string> = { 1: 'Main’s mod wheel', 2: 'Main’s breath', 22: 'Main’s morph', 64: 'Main’s sustain', 65: 'Main’s foot' };
  if (src >= 16 && src <= 19) return `Main’s K${src - 15}`;
  return jobs[src] ?? null;
}

/** the bindings from JSON made valid: a learnable source and a parameter of a module in the patch. One row per source and
 *  one source per row: a later entry replaces an earlier one, as learning again does */
export function fixMidiLearn(raw: unknown, modules: { id: number; type: string }[], defs: Record<string, ModuleDef>): MidiBinding[] {
  if (!Array.isArray(raw)) return [];
  let out: MidiBinding[] = [];
  for (const b of raw as Partial<MidiBinding>[]) {
    if (!b || typeof b !== 'object' || !isSource(b.src) || typeof b.param !== 'string') continue;
    const m = modules.find((x) => x.id === b.module);
    if (!m || !defs[m.type]?.params.some((q) => q.name === b.param && !q.screen)) continue;
    out = out.filter((x) => x.src !== b.src && !(x.module === m.id && x.param === b.param));
    out.push({ src: b.src, module: m.id, param: b.param });
  }
  return out;
}

const sameRow = (b: LearnRow, r: LearnRow): boolean => b.module === r.module && b.param === r.param;

const keep = (p: Patch, list: MidiBinding[]): void => {
  if (list.length) p.midiLearn = list;
  else delete p.midiLearn;
};

/** bind a source to a row: the source leaves any other row, and the row any other source */
export function bindRow(p: Patch, b: MidiBinding): void {
  keep(p, [...(p.midiLearn ?? []).filter((x) => x.src !== b.src && !sameRow(x, b)), { src: b.src, module: b.module, param: b.param }]);
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
 *  once, a pad's touch switch (127 on touch, 0 on release) never does. A switch row takes a button: two values */
export const LEARN_VALUES = 3;
export const LEARN_VALUES_SWITCH = 2;
/** a learned source moves its row at most this often (ms); the latest value is applied after the gap */
export const MOVE_GAP_MS = 25;

export interface LearnHost {
  patch(): Patch;
  /** move a row to position u (0..1) of its range, as a knob does (Editor.setRowAt): an edit, one undo step per gesture */
  setRow(module: number, param: string, u: number): void;
  /** learn found the row's source: bind it (an undo step) */
  learned(b: MidiBinding): void;
  /** learn started on a row, or stopped (null) */
  waiting(row: LearnRow | null): void;
  now?(): number;
}

/**
 * The learn wait and the learned moves. `take` hears every message from a MIDI controller (never an FM-1). While a row
 * waits, every CC and pitch bend goes to the wait, and the first source to send enough different values is bound. Then
 * a bound source moves its row, throttled, and does nothing else.
 */
export class MidiLearn {
  private target: (LearnRow & { need: number }) | null = null;
  private seen = new Map<LearnSource, Set<number>>();
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
    this.host.waiting(this.waitingRow);
  }

  /** stop waiting; false when nothing waited */
  cancel(): boolean {
    if (!this.target) return false;
    this.target = null;
    this.seen.clear();
    this.host.waiting(null);
    return true;
  }

  /** a message from a MIDI controller: true when learn took it (it then does nothing else) */
  take(msg: HostMsg): boolean {
    const s = sourceOf(msg);
    if (!s) return false;
    if (this.target) {
      const vals = this.seen.get(s.src) ?? new Set<number>();
      vals.add(s.raw);
      this.seen.set(s.src, vals);
      if (vals.size < this.target.need) return true;
      const row = this.target;
      this.target = null;
      this.seen.clear();
      this.host.waiting(null);
      if (this.host.patch().modules.some((m) => m.id === row.module)) this.host.learned({ src: s.src, module: row.module, param: row.param });
      return true;
    }
    if (!liveBinding(this.host.patch(), s.src)) return false;
    this.move(s.src, s.u);
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
      if (b) this.host.setRow(b.module, b.param, m.u);
    };
    const wait = m.at + MOVE_GAP_MS - now;
    if (wait <= 0) run();
    else m.timer = window.setTimeout(run, wait);
  }
}
