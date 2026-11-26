import { it, vi } from 'vitest';
vi.mock('./bin-parse', async () => await import('./zz-bp'));
import { readFileSync } from 'node:fs';
import { parseBinary } from './bin-parse';
import { readFromFm1 } from './patch-reader';
import { encodePatch } from './patchbin';
import { browserLibrary, shippedLibrary, patchDefs } from './assembly-match';
import { FM1_PRESETS } from './presets';
it('probe', () => {
  const bin = new Uint8Array(readFileSync('/Users/mg/projects/music/fm1/modular-1/build/release-1.28.0/prep/mono125.bin'));
  const b = parseBinary(bin)!;
  console.log('VER', b.version, 'bus', b.bus, 'nmod', b.modules.length, b.modules.map((m) => m.type).join(' '));
  for (const [lib, library] of [['shipped+factory', [...shippedLibrary(), ...Object.values(FM1_PRESETS).flatMap((mk) => patchDefs(mk()))]], ['browser', browserLibrary()]] as const) {
  const r = readFromFm1(bin, { name: 'Monolith D', library: library as any });
  if (!r) { console.log('NULL'); return; }
  console.log('LIB', lib, 'dev', r.devices, 'rec', r.recognised, 'exact', r.exact);
  console.log('ASM', JSON.stringify(r.patch.assemblies?.map((a: any) => ({ n: a.name, d: a.drawer, k: Object.keys(a) }))));
  console.log('MODS', r.patch.modules.map((m) => m.type).join(' '));
  const enc = encodePatch(r.patch, true);
  const again = parseBinary(enc)!;
  console.log('AGAIN ver', again.version, 'bus', again.bus, 'rack', JSON.stringify(again.rack));
  const t = (x: unknown) => JSON.stringify(x, (_k, v) => (v instanceof Map ? [...v] : v));
  for (const k of Object.keys(b)) { const s = t((b as any)[k]) === t((again as any)[k]); console.log('SEC', k, s, s ? '' : t((b as any)[k]).slice(0, 300) + ' || ' + t((again as any)[k]).slice(0, 300)); }
  }
});
