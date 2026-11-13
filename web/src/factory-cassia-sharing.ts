// SPDX-License-Identifier: GPL-3.0-only
import { reconcile } from './assembly';
import { DEFS } from './modules';
import type { Patch } from './patch';

/**
 * Four-note Cassia with phrase-shared DCO/DCW time contours and local DCAs.
 * An overlapping note joins the current pitch/brightness curve; only the last
 * held key starts its release. Touch, vibrato delay, ring/noise multiplication
 * and amplitude/release remain per note. This is an editable measurement graph,
 * not an implicit rewrite of Cassia patches or their control presets.
 */
export function sharedCassiaContours(source: Patch): Patch {
  if (source.name !== 'Cassia 1') {
    throw new Error(`Unsupported shared-contour factory engine: ${source.name}`);
  }
  const p = structuredClone(source);
  const voice = p.assemblies!.find(a => a.id === 1 && a.poly)!;
  const root = p.assemblies!.find(a => a.id === 2 && a.children?.includes(voice.id))!;
  // Keep the allocator's gate cables: outside the voice group they sum, so the
  // shared contours attack on the first held note and release on the last.
  const shared = [20, 21, 40, 41, 27, 29, 31, 50, 10, 17, 18, 19];
  voice.modules = voice.modules.filter(id => !shared.includes(id));
  root.modules.push(...shared);
  // Line selection now receives the already amplitude-shaped line sums once.
  // Its g3 also selects shared waveform/DCO/DCW controls and the LOCAL DCA32.
  // Never move the ring multiplier or either DCA across this summing boundary.
  reconcile(p, voice, DEFS);
  reconcile(p, root, DEFS);
  p.name = 'Cassia 1 Shared Contours';
  root.name = p.name;
  root.label = p.name;
  voice.label = 'per-note DCA / touch';
  p.notes = 'SHARED DCO/DCW CONTOURS / PER-NOTE DCA. Overlapping notes join the current pitch and brightness curves; releasing one note does not start its own DCO/DCW release. First held key attacks, last released key releases. Both lines remain programmable; DCA release, touch, vibrato delay and ring/noise stay per note. Four playable voices and Chorus retained.';
  return p;
}
