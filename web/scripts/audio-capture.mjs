// SPDX-License-Identifier: GPL-3.0-only
// What the scenarios hear as a recording (scripts/device-check.mjs): the emulated FM-1's I2S output (m1emu serve `wav`) or
// the rig's USB audio, recorded on this Mac with AVAudioEngine (tools/fm1_rec.swift; the FM-1 shows up as an input named
// "Matryoshka", 16 bit 44.1 kHz stereo), read back as two channels of floats, and
// the measures the checks take of it.
//
// The two are not the same signal (firmware/src/audio.c): the I2S words get the GLO > SYSTEM > OUTPUT mix (MONO, MONO L),
// USB audio takes each half before that mix and stays stereo. So a check of OUTPUT's mix reads the emulator's I2S; the
// rig's USB audio proves what both sides carry in STEREO, the echoes, the drones and the dropouts.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** a WAV file's channels as floats (-1..1): PCM of 16, 24 or 32 bits, or 32-bit float. a header without sizes (0 or
 *  0xFFFFFFFF, as a writer still running leaves it): the data then runs to the file's end */
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

/** the recorder (tools/fm1_rec.swift, AVAudioEngine), built into build/ when missing or older than its source; null without
 *  swiftc (Xcode's command line tools). ffmpeg's avfoundation input is not used to record: it delivered about a third of the
 *  FM-1's buffers (9.2 s of a 30 s capture, 2026-11-06), spliced together, which no timing check survives */
function recorder() {
  const root = new URL('../../', import.meta.url).pathname, src = `${root}tools/fm1_rec.swift`, bin = `${root}build/fm1_rec`;
  if (existsSync(bin) && statSync(bin).mtimeMs >= statSync(src).mtimeMs) return bin;
  const r = spawnSync('swiftc', ['-O', src, '-o', bin], { encoding: 'utf8' });
  return r.status === 0 ? bin : null;
}

/**
 * Start recording input `name` ("Matryoshka" = the FM-1's USB audio, its USB product string whatever name macOS keeps for
 * its MIDI port) into `file`, a 16-bit WAV. Resolves once samples are flowing and the stream's start-up silence is over, so
 * what is done after it is in the recording; `stop()` ends it and gives the channels with `flow` (how much audio came in how
 * long), or { stalled, why } when less than 80 % of the samples the time holds came. { why } (a skip, D-140) when there is
 * no recorder, no such input or more than one; { stalled, why } when the input sends nothing for 8 s.
 */
export async function startCapture(file, name = 'Matryoshka', warmMs = 1500) {
  const bin = recorder();
  if (!bin) return { why: 'no recorder: tools/fm1_rec.swift needs swiftc (xcode-select --install)' };
  const p = spawn(bin, [name, file], { stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = [];
  let wake = null;
  createInterface({ input: p.stdout }).on('line', (l) => { lines.push(l); wake?.(); });
  let err = '';
  p.stderr.on('data', (d) => { err += d; });
  const exited = new Promise((res) => p.on('exit', (c) => { res(c); wake?.(); }));
  const t0 = Date.now();
  while (!lines.some((l) => l.startsWith('rec ') || l.startsWith('error'))) {
    if (p.exitCode !== null || Date.now() - t0 > 8000) {
      try { p.kill(); } catch { /* gone */ }
      const e = lines.find((l) => l.startsWith('error'));
      return e ? { why: e.slice(6) } : { stalled: true, why: `"${name}" sent no audio in 8 s (its USB audio stream is not running)${err ? `: ${err.trim().split('\n').pop()}` : ''}` };
    }
    await Promise.race([new Promise((r) => { wake = r; }), sleep(100)]);
  }
  const e = lines.find((l) => l.startsWith('error'));
  if (e) { try { p.kill(); } catch { /* gone */ } return { why: e.slice(6) }; }
  // (the FM-1 sends silence for about 1.5 s after the Mac opens its USB audio: what happens in that time would be lost)
  await sleep(warmMs);
  return {
    async stop() {
      // (what the FM-1 played last is still on its way through USB and CoreAudio's buffers)
      await sleep(800);
      try { p.stdin.write('q\n'); p.stdin.end(); } catch { /* gone */ }
      const t = setTimeout(() => p.kill('SIGINT'), 3000);
      await exited;
      clearTimeout(t);
      const m = lines.map((l) => /^frames (\d+) seconds ([\d.]+)$/.exec(l)).find(Boolean);
      if (!m) return { stalled: true, why: `the recorder ended without its count${err ? `: ${err.trim().split('\n').pop()}` : ''}` };
      const a = parseWav(readFileSync(file)), got = Number(m[1]) / a.rate, took = Number(m[2]);
      const flow = `${got.toFixed(2)} s of audio came in ${took.toFixed(2)} s`;
      if (got < 0.8 * took) return { stalled: true, why: `"${name}" stalled: ${flow}` };
      return Object.assign(a, { flow });
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
