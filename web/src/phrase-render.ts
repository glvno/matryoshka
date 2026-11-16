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
}

/** blocks rendered between two yields (about 0.75 s of sound) */
const SLICE = 256;
const BLOCK = 128;

export async function renderPhrase(patch: Patch, phrase: Phrase, setup: RenderSetup = {}): Promise<[Float32Array, Float32Array]> {
  const sr = setup.sr ?? WAV_RATE;
  const engine = new Engine(sr);
  engine.load(structuredClone(patch));
  engine.tempoGlobal = setup.tempo ?? null;
  if (setup.armed?.length) engine.arm([...setup.armed]);
  const player = new PhrasePlayer(phrase, false, sr);
  const frames = PhrasePlayer.frames(phrase, sr);
  const left = new Float32Array(frames), right = new Float32Array(frames);
  const bl = new Float32Array(BLOCK), br = new Float32Array(BLOCK);
  const on = (note: number, vel: number): void => engine.noteOn(note, vel);
  const off = (note: number): void => engine.noteOff(note);
  for (let at = 0, blocks = 0; at < frames; at += BLOCK) {
    const n = Math.min(BLOCK, frames - at);
    player.block(n, on, off);
    engine.render(bl, br);
    left.set(bl.subarray(0, n), at);
    right.set(br.subarray(0, n), at);
    if (setup.yieldEvery && ++blocks % SLICE === 0) await setup.yieldEvery();
  }
  return [left, right];
}
