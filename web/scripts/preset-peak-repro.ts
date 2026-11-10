// SPDX-License-Identifier: GPL-3.0-only
// Reproduce #833's final-output clipping at saved reference gain and the exact audition phrase.
import { readFileSync } from 'node:fs';
import { renderPlay } from '../src/headroom';
import { DEVICE_SR } from '../src/modules';
import type { Patch } from '../src/patch';
for (const file of process.argv.slice(2)) {
  const p = JSON.parse(readFileSync(file, 'utf8')) as Patch;
  const play = (patch: Patch) => renderPlay({ label: 'reference phrase', patch, notes: [], run: false, phrase: true }, 16);
  const normal = play(p);
  const q = structuredClone(p);
  q.modules.find((m) => m.type === 'output')!.params.level /= 16;
  const diagnostic = play(q);
  let peak = 0, at = 0, clipped = 0, difference = 0;
  for (let c = 0; c < 2; c++) for (let i = 0; i < normal[c].length; i++) {
    const raw = diagnostic[c][i] * 16;
    if (Math.abs(raw) > peak) { peak = Math.abs(raw); at = i; }
    if (Math.abs(raw) > 1) clipped++;
    difference = Math.max(difference, Math.abs(normal[c][i] - Math.max(-1, Math.min(1, raw))));
  }
  console.log(JSON.stringify({ file, sampleRate: DEVICE_SR, seconds: 16, peak, second: at / DEVICE_SR, clippedChannelSamples: clipped,
    maxDifferenceFromFinalClamp: difference, referenceOutput: p.modules.find((m) => m.type === 'output')!.params.level,
    signalStage: 'final Output; diagnostic attenuation16x before final clamp restored afterward',
    events: '36@0s2s vel100/127;60@3s2s vel100/127;84@6s1s vel0.5;48,55,60,63,67,70,67,63 every0.35s from8s duration0.25s alternating1/0.55;chord48,55,60@12s1s vel100/127;tail through16s' }));
}
