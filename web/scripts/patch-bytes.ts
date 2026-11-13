// SPDX-License-Identifier: GPL-3.0-only
// Every factory and community patch's FM-1 bytes (the room kept for preset names included, patchbin.ts layout): in the
// lowest older format that holds it (baseFormat) and with counted records (format 51, #667), and the format it is written in.
//   npx vite-node scripts/patch-bytes.ts            a table
import { PRESETS } from '../src/presets';
import { communityEntries } from '../src/community';
import { decodeShare } from '../src/share';
import { DEFS } from '../src/modules';
import { DEVICE, layout } from '../src/patchbin';
import type { Patch } from '../src/patch';

const rows: string[] = [];
let saved = 0, n = 0;
function measure(name: string, kind: string, p: Patch): void {
  const l = layout(p);
  const d = l.base.bytes - l.counted;
  saved += d;
  n++;
  const fit = (b: number): string => (b <= DEVICE.bytes ? '' : ' (over)');
  rows.push(`| ${name} | ${kind} | ${l.base.bytes}${fit(l.base.bytes)} (${l.base.v}) | ${l.counted}${fit(l.counted)} | ${d} | ${l.v} |`);
}
for (const [name, make] of Object.entries(PRESETS)) measure(name, 'factory', make());
for (const e of communityEntries()) {
  try {
    measure(e.title, 'community', await decodeShare(e.code, DEFS));
  } catch (err) {
    console.error(e.title, String(err));
  }
}
console.log('| Patch | Kind | Bytes before (format) | Counted (51) | Saved | Written in |\n|---|---|---|---|---|---|');
console.log(rows.join('\n'));
console.log(`\n${n} patches, ${saved} bytes saved in all, ${Math.round(saved / n)} on average`);
