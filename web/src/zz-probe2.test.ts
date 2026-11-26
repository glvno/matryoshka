import { it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseBinary } from './zz-bp';
it('probe', () => {
  const bin = new Uint8Array(readFileSync('/Users/mg/projects/music/fm1/modular-1/build/release-1.28.0/prep/mono125.bin'));
  const b = parseBinary(bin);
  console.log(b && b.modules.map((m) => m.type).join(' '));
});
