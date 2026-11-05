// SPDX-License-Identifier: GPL-3.0-only
// What the scenarios hear as a recording (scripts/device-check.mjs): the emulated FM-1's I2S output (m1emu serve `wav`) or
// the rig's USB audio, recorded on this Mac with ffmpeg's avfoundation input (the FM-1 shows up as an input named
// "Matryoshka", 16 bit 44.1 kHz stereo), read back as two channels of floats, and
// the measures the checks take of it.
//
// The two are not the same signal (firmware/src/audio.c): the I2S words get the GLO > SYSTEM > OUTPUT mix (MONO, MONO L),
// USB audio takes each half before that mix and stays stereo. So a check of OUTPUT's mix reads the emulator's I2S; the
// rig's USB audio proves what both sides carry in STEREO, the echoes, the drones and the dropouts.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** a WAV file's channels as floats (-1..1): PCM of 16, 24 or 32 bits, or 32-bit float. ffmpeg's header may hold no sizes
 *  while it writes (0 or 0xFFFFFFFF): the data then runs to the file's end */
export function parseWav(buf) {
  const u32 = (o) => buf.readUInt32LE(o), u16 = (o) => buf.readUInt16LE(o);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAV file');
  let fmt = null, at = 12;
  while (at + 8 <= buf.length) {
    const id = buf.toString('ascii', at, at + 4);
    let size = u32(at + 4);
    if (id === 'fmt ') {
      let tag = u16(at + 8);
      if (tag === 0xfffe) tag = u16(at + 32);   // (WAVE_FORMAT_EXTENSIBLE: the sub-format's tag)
      fmt = { tag, ch: u16(at + 10), rate: u32(at + 12), bits: u16(at + 22) };
    } else if (id === 'data') {
      if (!fmt) throw new Error('WAV data before its format');
      if (!size || size === 0xffffffff || at + 8 + size > buf.length) size = buf.length - at - 8;
      const bytes = fmt.bits / 8, frames = Math.floor(size / (bytes * fmt.ch));
      const chans = Array.from({ length: fmt.ch }, () => new Float32Array(frames));
      for (let i = 0; i < frames; i++)
        for (let c = 0; c < fmt.ch; c++) {
          const o = at + 8 + (i * fmt.ch + c) * bytes;
          chans[c][i] = fmt.tag === 3 ? buf.readFloatLE(o)
            : fmt.bits === 16 ? buf.readInt16LE(o) / 32768
            : fmt.bits === 24 ? buf.readIntLE(o, 3) / 8388608
            : buf.readInt32LE(o) / 2147483648;
        }
      return { rate: fmt.rate, l: chans[0], r: chans[1] ?? chans[0] };
    }
    at += 8 + size + (size & 1);
  }
  throw new Error('WAV without data');
}

/** the audio inputs avfoundation lists on this Mac */
export function audioInputs() {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', ''], { encoding: 'utf8' });
  if (r.error) return null;   // (no ffmpeg)
  const part = r.stderr.split('audio devices:')[1] ?? '';
  return [...part.matchAll(/\] \[(\d+)\] (.+)$/gm)].map((m) => ({ index: Number(m[1]), name: m[2].trim() }));
}

/**
 * Start recording input `name` (avfoundation, "Matryoshka" = the FM-1's USB audio) into `file`, a 16-bit stereo WAV.
 * Resolves once samples are flowing (the file grows past its header), so what is done after it is in the recording;
 * `stop()` ends it and gives the channels. null when there is no ffmpeg, no such input, or more than one input of that name
 * (two FM-1s: which one is the rig is not known), with the reason in `why`.
 */
export async function startCapture(file, name = 'Matryoshka') {
  const ins = audioInputs();
  if (!ins) return { why: 'no ffmpeg (brew install ffmpeg)' };
  const same = ins.filter((i) => i.name === name);
  if (same.length !== 1) return { why: same.length ? `${same.length} audio inputs named "${name}" (more than one FM-1)` : `no audio input named "${name}"` };
  const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'avfoundation', '-i', `:${same[0].index}`, '-ac', '2', '-c:a', 'pcm_s16le', file],
    { stdio: ['pipe', 'ignore', 'pipe'] });
  let err = '';
  ff.stderr.on('data', (d) => { err += d; });
  const done = new Promise((res) => ff.on('exit', (c) => res(c)));
  const t0 = Date.now();
  // (header 44 bytes, then 4 bytes a frame: 0.1 s in)
  while (!(existsSync(file) && statSync(file).size > 44 + 17640)) {
    if (ff.exitCode !== null || Date.now() - t0 > 8000) {
      try { ff.kill(); } catch { /* gone */ }
      return { why: `ffmpeg did not record "${name}"${err ? `: ${err.trim().split('\n').pop()}` : ''}` };
    }
    await sleep(50);
  }
  return {
    async stop() {
      try { ff.stdin.write('q'); } catch { /* gone */ }
      const t = setTimeout(() => ff.kill('SIGINT'), 3000);
      await done;
      clearTimeout(t);
      return parseWav(readFileSync(file));
    },
  };
}

// ---- measures

/** the loudest |sample| */
export const peakOf = (x, from = 0, to = x.length) => { let m = 0; for (let i = from; i < to; i++) { const a = Math.abs(x[i]); if (a > m) m = a; } return m; };
/** the RMS of x[from..to) */
export function rmsOf(x, from = 0, to = x.length) {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i] * x[i];
  return to > from ? Math.sqrt(s / (to - from)) : 0;
}
/** the RMS in windows of `ms` */
export function rmsWindows(x, rate, ms) {
  const n = Math.max(1, Math.round((rate * ms) / 1000)), out = [];
  for (let i = 0; i + n <= x.length; i += n) out.push(rmsOf(x, i, i + n));
  return out;
}
/** the level of frequency `f` (Hz) in x[from..from+n), as the amplitude of a sine of that frequency would read (Goertzel,
 *  Hann window) */
export function toneLevel(x, rate, f, from, n) {
  const w = (2 * Math.PI * f) / rate, c = 2 * Math.cos(w);
  let s1 = 0, s2 = 0, wsum = 0;
  for (let i = 0; i < n; i++) {
    const h = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    wsum += h;
    const s0 = x[from + i] * h + c * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  const re = s1 - s2 * Math.cos(w), im = s2 * Math.sin(w);
  return (2 * Math.sqrt(re * re + im * im)) / wsum;
}
/** the level of `f` in windows of `ms` (each `ms` long, every `ms`) */
export function toneProfile(x, rate, f, ms) {
  const n = Math.round((rate * ms) / 1000), out = [];
  for (let i = 0; i + n <= x.length; i += n) out.push(toneLevel(x, rate, f, i, n));
  return out;
}
/** a note's frequency (A4 = 440 Hz) */
export const hz = (note) => 440 * 2 ** ((note - 69) / 12);
/** zero crossings a second, from the loudest part (above a tenth of the peak): about twice the pitch of a plain wave */
export function crossings(x, rate) {
  const top = peakOf(x);
  let n = 0, len = 0;
  for (let i = 1; i < x.length; i++) {
    if (Math.abs(x[i]) < top / 10 && Math.abs(x[i - 1]) < top / 10) continue;
    len++;
    if ((x[i] >= 0) !== (x[i - 1] >= 0)) n++;
  }
  return len ? (n * rate) / len : 0;
}
/** the correlation of two channels over their loud part (1: the same signal, 0: unrelated) */
export function correlation(a, b) {
  let ab = 0, aa = 0, bb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) { ab += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i]; }
  return aa && bb ? ab / Math.sqrt(aa * bb) : 0;
}
/**
 * Dropouts while something sounds: runs of at least `minMs` of samples at the floor (|x| <= 2 LSB of 16 bit on both
 * channels) with sound (RMS above `loud`) in the 20 ms on either side. A sustained chord has no such run; a buffer the
 * FM-1 did not fill in time has one. Each as [start ms, length ms]
 */
export function dropouts({ rate, l, r }, { minMs = 1, loud = 0.01 } = {}) {
  const floor = 2 / 32768, need = Math.max(2, Math.round((rate * minMs) / 1000)), side = Math.round(rate * 0.02), out = [];
  let run = 0;
  for (let i = 0; i <= l.length; i++) {
    const quiet = i < l.length && Math.abs(l[i]) <= floor && Math.abs(r[i]) <= floor;
    if (quiet) { run++; continue; }
    if (run >= need) {
      const a = i - run;
      if (a - side >= 0 && i + side <= l.length && rmsOf(l, a - side, a) + rmsOf(r, a - side, a) > loud && rmsOf(l, i, i + side) + rmsOf(r, i, i + side) > loud)
        out.push([+((a * 1000) / rate).toFixed(1), +((run * 1000) / rate).toFixed(2)]);
    }
    run = 0;
  }
  return out;
}
/** the first sample from `from` on where the louder channel passes `level`, or -1 */
export function onset({ l, r }, level, from = 0) {
  for (let i = from; i < l.length; i++) if (Math.abs(l[i]) >= level || Math.abs(r[i]) >= level) return i;
  return -1;
}
