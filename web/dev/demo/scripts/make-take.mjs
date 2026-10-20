// The take (record.mjs) as media Remotion plays: the timestamped frames as a constant 30 fps video from the moment the
// audio recorder started (take.mp4), the audio as WAV (take.wav). Uses ffmpeg from PATH.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../public/take');
const take = JSON.parse(fs.readFileSync(path.join(DIR, 'take.json'), 'utf8'));
// (frames that arrived after the take ended are left out)
const names = fs.readdirSync(path.join(DIR, 'frames')).filter((f) => f.endsWith('.jpg')).sort().slice(0, take.frames.length);
if (names.length !== take.frames.length) throw new Error(`${names.length} frames on disk, ${take.frames.length} in take.json`);

// the concat list: each frame held until the next one; the frame showing at t = 0 starts the video
let start = take.frames.findLastIndex((t) => t <= 0);
if (start < 0) start = 0;
const lines = ['ffconcat version 1.0'];
for (let i = start; i < names.length; i++) {
  const from = Math.max(0, take.frames[i]);
  const to = i + 1 < names.length ? take.frames[i + 1] : take.end;
  if (to <= from) continue;
  lines.push(`file 'frames/${names[i]}'`, `duration ${((to - from) / 1000).toFixed(6)}`);
}
lines.push(`file 'frames/${names.at(-1)}'`);
fs.writeFileSync(path.join(DIR, 'frames.txt'), lines.join('\n') + '\n');

execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', path.join(DIR, 'frames.txt'),
  '-vf', 'fps=30', '-c:v', 'libx264', '-preset', 'slow', '-crf', '12', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
  path.join(DIR, 'take.mp4')], { stdio: 'inherit' });
execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', path.join(DIR, 'audio.webm'), '-ar', '48000', '-ac', '2', path.join(DIR, 'take.wav')], { stdio: 'inherit' });
const dur = (f) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path.join(DIR, f)]).toString());
console.log(`take.mp4 ${dur('take.mp4').toFixed(2)} s, take.wav ${dur('take.wav').toFixed(2)} s, take ${(take.end / 1000).toFixed(2)} s`);
