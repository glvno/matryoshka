// SPDX-License-Identifier: GPL-3.0-only
// npm run record [-- NAME] [--device NAME] [--dir DIR]: records the FM-1's USB audio on this Mac to a stereo WAV,
// ~/Music/Matryoshka/YYYY-MM-DD-HHMMSS[-NAME].wav, until you press q (or Ctrl+C). Uses ffmpeg's avfoundation input
// (brew install ffmpeg); the FM-1 shows up as an input named "Matryoshka" (--device for another name).
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
const device = opt('--device') ?? 'Matryoshka';
const dir = opt('--dir') ?? join(homedir(), 'Music', 'Matryoshka');
const name = args.find((a) => !a.startsWith('--'));

if (spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).error) {
  console.error('ffmpeg not found: brew install ffmpeg');
  process.exit(1);
}
const list = spawnSync('ffmpeg', ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', ''], { encoding: 'utf8' }).stderr;
const inputs = list.split('audio devices:')[1] ?? '';
if (!inputs.includes(`] ${device}\n`)) {
  console.error(`no audio input named "${device}": is the FM-1 plugged in by USB? Inputs:\n${inputs.replace(/\[AVFoundation[^\]]*\] /g, '  ').trim()}`);
  process.exit(1);
}

mkdirSync(dir, { recursive: true });
const d = new Date(), p = (n) => String(n).padStart(2, '0');
const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
const file = join(dir, `${stamp}${name ? `-${name.replace(/[^\w.-]+/g, '-')}` : ''}.wav`);
console.log(`recording "${device}" to ${file}: press q to stop`);
const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-stats', '-f', 'avfoundation', '-i', `:${device}`, '-ac', '2', '-c:a', 'pcm_s24le', file],
  { stdio: 'inherit' });
ff.on('exit', (code) => { console.log(code === 0 || code === 255 ? `saved ${file}` : `ffmpeg stopped (${code})`); process.exit(code === 255 ? 0 : code ?? 1); });
