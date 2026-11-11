// SPDX-License-Identifier: GPL-3.0-only
// Whole-kit sound selector around the existing 909 voices. No DSP modules or cables change.
import { makeAssembly, parentOf } from '../src/assembly';
import type { Patch } from '../src/patch';
export function kitCard(p: Patch): void {
  const existing = p.assemblies?.find((a) => a.name === '909 kit');
  const children = (p.assemblies ?? []).filter((a) => (existing ? existing.children?.includes(a.id) : !parentOf(p, a.id)) && ['kick', 'snare', 'hihat', 'Macros', 'perc'].includes(a.name));
  const mix = p.modules.find((m) => m.type === 'mixer' && p.cables.some((c) => c.from.module === m.id && p.modules.some((o) => o.type === 'output' && o.id === c.to.module)))!;
  const card = existing ?? makeAssembly(p, [mix.id], '909 kit', children.map((a) => a.id));
  card.params = children.flatMap((a) => a.params.map((r, i) => ({ ...r, ...(i === 0 ? { head: a.label.toLowerCase() } : {}),
    label: a.params.slice(0, i).some((x) => x.label === r.label) ? `${r.label} 2` : r.label })));
  card.params.push(...['kick', 'snare', 'hats and perc'].map((label, i) => ({ module: mix.id, param: `l${i + 1}`, ...(i === 0 ? { head: 'mix' } : {}), label })));
}
