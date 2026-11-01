// SPDX-License-Identifier: GPL-3.0-only
// The global tempo (D-907): FM-1 & MIDI > Tempo is Global (as made: one tempo every patch plays at; opening or sending
// a patch and loading a device preset leave it) or Patch (each patch plays its own, Main's `tempo`). Each patch keeps its
// own tempo either way; Global only sets it aside. The browser engine (engine.ts tempoGlobal), MIDI clock out and the
// FM-1 tab play it; Main's tempo row shows and edits it. While an FM-1 is connected the setting is the FM-1's (protocol.ts
// TEMPO / TEMPO_NOW, firmware/src/tempo_glo.h), else this browser keeps it. MIDI clock in overrides both (D-452).
import { TEMPO_MAX, TEMPO_MIN } from './modules';
import type { Patch } from './patch';

export type TempoMode = 'global' | 'patch';
export interface TempoSetting { mode: TempoMode; bpm: number }
/** where a change came from: the editor (its row, its toggle, the knobs), the FM-1 (TEMPO_NOW), the FM-1 tab */
export type TempoSource = 'editor' | 'device' | 'emu';

export const TEMPO_KEY = 'matryoshka.tempo';
const DEFAULT_BPM = 120;

/** a tempo as the engines play it: whole bpm, 20..300 */
export const clampBpm = (v: number): number => Math.min(TEMPO_MAX, Math.max(TEMPO_MIN, Math.round(Number.isFinite(v) ? v : DEFAULT_BPM)));
/** the patch's own tempo (Main's; 120 without one) */
export const patchTempo = (patch: Patch): number => clampBpm(patch.modules.find((m) => m.type === 'fm1')?.params.tempo ?? DEFAULT_BPM);
/** the tempo the patch plays at under the setting */
export const tempoNow = (s: TempoSetting, patch: Patch): number => (s.mode === 'global' ? s.bpm : patchTempo(patch));

/** the stored setting; none stored (the first visit): Global, at `first` (the open patch's tempo) */
export function readTempo(raw: string | null, first: number): TempoSetting {
  try {
    const v = JSON.parse(raw ?? 'null');
    if (v && typeof v === 'object' && (v.mode === 'global' || v.mode === 'patch') && Number.isFinite(v.bpm))
      return { mode: v.mode, bpm: clampBpm(v.bpm) };
  } catch {
    /* unreadable: as made */
  }
  return { mode: 'global', bpm: clampBpm(first) };
}

type Listener = (s: TempoSetting, from: TempoSource, was: TempoSetting) => void;

/** the setting, one per page */
export class Tempo {
  private s: TempoSetting = { mode: 'global', bpm: DEFAULT_BPM };
  private listeners: Listener[] = [];

  get mode(): TempoMode { return this.s.mode; }
  get bpm(): number { return this.s.bpm; }
  get global(): boolean { return this.s.mode === 'global'; }
  get setting(): TempoSetting { return { ...this.s }; }

  /** a change (only what is given); listeners hear it when something changed */
  set(next: Partial<TempoSetting>, from: TempoSource = 'editor'): void {
    const was = this.s;
    const s: TempoSetting = { mode: next.mode ?? was.mode, bpm: next.bpm === undefined ? was.bpm : clampBpm(next.bpm) };
    if (s.mode === was.mode && s.bpm === was.bpm) return;
    this.s = s;
    for (const l of this.listeners) l(this.setting, from, was);
  }

  listen(l: Listener): () => void {
    this.listeners.push(l);
    return () => { this.listeners = this.listeners.filter((x) => x !== l); };
  }
}

/** the page's setting (main.ts loads it from the browser's storage and wires it up) */
export const tempo = new Tempo();

/** Main's `tempo` parameter shows and sets the global tempo while it is global (the editor's rows and knobs) */
export const isGlobalTempo = (moduleType: string | undefined, param: string): boolean => moduleType === 'fm1' && param === 'tempo' && tempo.global;
