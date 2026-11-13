// SPDX-License-Identifier: GPL-3.0-only
import { reconcile } from './assembly';
import { DEFS } from './modules';
import { addModule, type Patch } from './patch';

/**
 * Measurement-only shared operator contours, with eight local oscillator banks.
 * These are deliberately coupled variants, not the original Algo Four sound:
 * shared EGs follow first-held/last-released gates, including their PM depth.
 * Their carrier outputs additionally follow each note's operator 1 envelope.
 * Never put those guards in the modulation paths: that changes the algorithms.
 */
export function sharedAlgoContours(source: Patch, operators: '4' | '3+4' = '3+4'): Patch {
  if (source.name !== 'Algo Four') {
    throw new Error(`Unsupported shared-contour factory engine: ${source.name}`);
  }
  const p = structuredClone(source);
  const voice = p.assemblies!.find(a => a.poly)!;
  const root = p.assemblies!.find(a => a.children?.includes(voice.id))!;
  const shared = operators === '4' ? [16] : [12, 16];
  voice.modules = voice.modules.filter(id => !shared.includes(id));
  for (const id of shared) if (!root.modules.includes(id)) root.modules.push(id);

  for (const op of operators === '4' ? [4] : [3, 4]) {
    const selector = op === 3 ? 24 : 25;
    const heard = p.modules.find(m => m.id === selector)!;
    const guard = addModule(p, DEFS.vca, heard.x, heard.y + 560);
    guard.name = `op ${op} local carrier guard`;
    guard.params.gain = 1;
    voice.modules.push(guard.id);

    // Change only the heard sum. Operator VCAs and every PM feed stay local and
    // untouched; operator 1 and operator 2 keep their original amplitude paths.
    for (const cable of p.cables) {
      if (cable.from.module === selector && cable.from.port === 'out'
        && cable.to.module === 26 && cable.to.port === 'in1') {
        cable.from.module = guard.id;
      }
    }
    p.cables.push(
      { from: { module: selector, port: 'out' }, to: { module: guard.id, port: 'in' } },
      { from: { module: 4, port: 'env' }, to: { module: guard.id, port: 'cv' } },
    );
    for (const output of voice.outputs) {
      if (output.module === selector && output.port === 'out') output.module = guard.id;
      for (const alias of output.also ?? []) {
        if (alias.module === selector && alias.port === 'out') alias.module = guard.id;
      }
    }
  }

  // Original allocator gate cables now sum outside the group: overlapping notes
  // join the contour in progress; releasing a non-final key does not release it.
  // Root EG rows still address the same modules. Reconciliation removes only the
  // departed EGs' duplicate rows/jacks from the local voice card.
  p.name = `${source.name} shared Op ${operators}`;
  root.name = root.label = p.name;
  voice.label = 'local operators / Op1 guard';
  p.notes = `MEASUREMENT ONLY: shared Op ${operators} contours, eight voices, all eight algorithms. `
    + 'First held key attacks; last released key releases. Overlaps enter the phrase in progress, including PM depth. '
    + 'Shared carriers also follow local Op1 amplitude: sustain/release bounded by Op1. '
    + `Deliberate coupling, NOT original voice sound. Fewer EG copies, ${operators === '4' ? 8 : 16} new audio-rate VCAs. No measured CPU win; both variants need measurement.`;
  reconcile(p, voice, DEFS);
  reconcile(p, root, DEFS);
  return p;
}
