// SPDX-License-Identifier: GPL-3.0-only
// The shelf uses the same ordinary-module graph and defaults as factory master inserts.
import { toDef, type AssemblyDef, type PortRef } from '../src/assembly';
import { fxBusOf, withFxBus } from '../src/fx-bus';
import { DEFS } from '../src/modules';
import { addModule, connect, newPatch } from '../src/patch';

export function masterFxDef(): AssemblyDef {
  const source = newPatch(DEFS, 'Master FX definition');
  const output = source.modules.find((m) => m.type === 'output')!;
  for (const [i, port] of ['l', 'r'].entries()) {
    const input = addModule(source, DEFS.macro, 0, i * 560);
    connect(source, DEFS, { module: input.id, port: 'out' }, { module: output.id, port });
  }
  const p = withFxBus(source);
  const bus = fxBusOf(p)!;
  const root = p.assemblies!.find((a) => a.id === bus.assembly)!;
  root.name = 'master FX';
  root.inputs.forEach((r, i) => { r.label = i ? 'right' : 'left'; });
  // A visible stereo jack carries the dry channel and the shared mono-wet return as ordinary cables.
  root.outputs = ['l', 'r'].map((port, i): PortRef => {
    const ends = p.cables.filter((c) => c.to.module === output.id && c.to.port === port).map((c) => c.from);
    return { ...ends[0], label: i ? 'right' : 'left', ...(ends.length > 1 ? { also: ends.slice(1) } : {}) };
  });
  return { ...toDef(p, root), category: 'Effects' };
}
