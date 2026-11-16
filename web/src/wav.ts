// SPDX-License-Identifier: GPL-3.0-only
// The patch's sound as a WAV file (#946): a test phrase rendered offline (phrase-render.ts) or the Output recorded while
// playing (worklet.ts `record`). 44.1 kHz stereo 32-bit float, the engine's samples as they are: no limiting, no
// normalizing, no dither, so a peak past full scale stays in the file.

export const WAV_RATE = 44100;

/** a stereo 32-bit float WAV of `left` / `right` at `sr` */
export function encodeWav(left: Float32Array, right: Float32Array, sr = WAV_RATE): Uint8Array {
  const frames = Math.min(left.length, right.length);
  const out = new Uint8Array(44 + frames * 8);
  const v = new DataView(out.buffer);
  const text = (at: number, s: string): void => { for (let i = 0; i < s.length; i++) out[at + i] = s.charCodeAt(i); };
  text(0, 'RIFF'); v.setUint32(4, out.length - 8, true); text(8, 'WAVE');
  text(12, 'fmt '); v.setUint32(16, 16, true);
  v.setUint16(20, 3, true);           // IEEE float
  v.setUint16(22, 2, true);           // stereo
  v.setUint32(24, sr, true); v.setUint32(28, sr * 8, true);
  v.setUint16(32, 8, true); v.setUint16(34, 32, true);
  text(36, 'data'); v.setUint32(40, frames * 8, true);
  for (let i = 0; i < frames; i++) {
    v.setFloat32(44 + i * 8, left[i], true);
    v.setFloat32(48 + i * 8, right[i], true);
  }
  return out;
}

/** "<stem>_<what>_YYYY-MM-DD_HHMM.wav" in local time; `stem` is the patch's file stem (patch-card.ts fileStem), as its
 *  .json and .png take */
export function wavName(stem: string, what: string, at: Date): string {
  const two = (n: number): string => String(n).padStart(2, '0');
  return `${stem}_${what}_${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}_${two(at.getHours())}${two(at.getMinutes())}.wav`;
}

/** joins recorded chunks into one channel */
export function joinChunks(chunks: readonly Float32Array[]): Float32Array {
  const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) (out.set(c, at), (at += c.length));
  return out;
}

/** `left` / `right` from `from` Hz to `to` Hz through the browser's own resampler (an OfflineAudioContext), in float: a
 *  recording at the audio device's rate becomes a 44.1 kHz file without clipping */
export async function resample(left: Float32Array, right: Float32Array, from: number, to = WAV_RATE): Promise<[Float32Array, Float32Array]> {
  if (from === to || !left.length) return [left, right];
  const ctx = new OfflineAudioContext(2, Math.max(1, Math.round(left.length * to / from)), to);
  const buf = ctx.createBuffer(2, left.length, from);
  buf.copyToChannel(left as Float32Array<ArrayBuffer>, 0);
  buf.copyToChannel(right as Float32Array<ArrayBuffer>, 1);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.start();
  const out = await ctx.startRendering();
  return [out.getChannelData(0), out.getChannelData(1)];
}
