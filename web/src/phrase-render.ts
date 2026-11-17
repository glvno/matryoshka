// SPDX-License-Identifier: GPL-3.0-only
// A test phrase rendered offline (#946): a fresh browser engine at 44.1 kHz plays the patch with the phrase once, then its
// tail, through the PhrasePlayer the live phrase uses. The editor's state that changes what the keys play or how fast
// time runs goes with it: the armed devices and the global tempo.
import { Engine } from './engine';
import type { Patch } from './patch';
import { PhrasePlayer, type Phrase } from './phrases';
import { WAV_RATE } from './wav';

export interface RenderSetup {
  /** the armed devices (Engine.arm), empty: the cables decide */
  armed?: readonly string[];
  /** the global tempo (D-907), null: the patch's own */
  tempo?: number | null;
  sr?: number;
  /** called between slices so the page stays responsive (the editor awaits a frame); absent: one go */
  yieldEvery?: () => Promise<void>;
  /** render this long (seconds) instead of the phrase and its tail */
  seconds?: number;
  /** stop early once, after `after` seconds, the sound has stayed `below` times its peak before then (a ratio) for
   *  QUIET_SPAN: what is rendered so far is returned */
  quiet?: { after: number; below: number };
}

/** blocks rendered between two yields (about 0.75 s of sound) */
const SLICE = 256;
const BLOCK = 128;
/** how long the sound stays quiet before a render with `quiet` stops (seconds): long enough that a measure's smoothing
 *  (mutate-render.ts, 35 ms) ends on silence */
const QUIET_SPAN = 0.05;

export async function renderPhrase(patch: Patch, phrase: Phrase, setup: RenderSetup = {}): Promise<[Float32Array, Float32Array]> {
  const sr = setup.sr ?? WAV_RATE;
  const engine = new Engine(sr);
  engine.load(structuredClone(patch));
  engine.tempoGlobal = setup.tempo ?? null;
  if (setup.armed?.length) engine.arm([...setup.armed]);
  const player = new PhrasePlayer(phrase, false, sr);
  const frames = setup.seconds === undefined ? PhrasePlayer.frames(phrase, sr) : Math.round(setup.seconds * sr);
  const left = new Float32Array(frames), right = new Float32Array(frames);
  const bl = new Float32Array(BLOCK), br = new Float32Array(BLOCK);
  const on = (note: number, vel: number): void => engine.noteOn(note, vel);
  const off = (note: number): void => engine.noteOff(note);
  // (with `quiet`: the peak before `after`, and the last frame after it that was not quiet)
  const after = setup.quiet ? Math.round(setup.quiet.after * sr) : Infinity, span = Math.round(QUIET_SPAN * sr);
  let peak = 0, loud = after;
  for (let at = 0, blocks = 0; at < frames; at += BLOCK) {
    const n = Math.min(BLOCK, frames - at);
    player.block(n, on, off);
    engine.render(bl, br);
    left.set(bl.subarray(0, n), at);
    right.set(br.subarray(0, n), at);
    if (setup.quiet) {
      for (let i = 0; i < n; i++) {
        const x = Math.abs(bl[i] + br[i]) / 2;
        if (at + i < after) peak = Math.max(peak, x);
        else if (x > peak * setup.quiet.below) loud = at + i;
      }
      if (at + n - loud >= span) return [left.subarray(0, at + n), right.subarray(0, at + n)];
    }
    if (setup.yieldEvery && ++blocks % SLICE === 0) await setup.yieldEvery();
  }
  return [left, right];
}
