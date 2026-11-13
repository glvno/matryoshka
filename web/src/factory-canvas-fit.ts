// SPDX-License-Identifier: GPL-3.0-only
import type { Patch } from './patch';

/**
 * Display-caption fitting only. Every position, jack, knob, module and cable stays intact.
 * Standard captions abbreviate pressure/sequencer/envelope/random1. The explicit
 * short form also abbreviates the nine selector legends for the added-Delay candidate.
 * Full source names remain on source-output jacks and section headings.
 */
export function fitCanvasFactory(source: Patch, captions: 'standard' | 'short' = 'standard'): Patch {
  if (source.name !== 'Canvas') throw new Error(`Unsupported Canvas fitting source: ${source.name}`);
  const p = structuredClone(source);
  const original = ['main', 'pressure', 'sequencer', 'envelope', 'pulser', 'random 1', 'mod cv', 'patch'];
  const compact = ['main', 'PRESS', 'SEQ', 'ENV', 'pulser', 'RND1', 'mod cv', 'patch'];
  const short = ['MN', 'PRS', 'SQ', 'EG', 'PUL', 'R1', 'CV', 'PT'];
  const rows = (p.assemblies ?? []).flatMap(a => a.params);
  for (const id of [68, 70, 71, 72, 73, 74, 76, 78, 79]) {
    const selector = p.modules.find(m => m.id === id);
    const matches = rows.filter(r => r.module === id && r.param === 'pos');
    const names = matches[0]?.names;
    if (selector?.type !== 'select' || (selector.params.count ?? 8) !== 8 || matches.length !== 1
      || names?.length !== 8 || names.some((name, i) => name !== original[i] && name !== compact[i] && name !== short[i])) {
      throw new Error(`Canvas fitting needs all eight original patch-field choices on selector ${id}`);
    }
    matches[0].names = [...(captions === 'short' ? short : compact)];
  }
  return p;
}
