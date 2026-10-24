// SPDX-License-Identifier: GPL-3.0-only
// The XLs gen-xl.ts writes, in this order (the browser lists each after its FM-1 version whatever the order here). To add
// one: write scripts/xl/<slug>.ts exporting `xl` (xl.ts), import it here and add it to the list, then run
// `npx vite-node scripts/gen-xl.ts` from web/ and commit web/presets/xl/<slug>.json.
import type { Xl } from './xl';
import { xl as lire } from './8-lire';
import { xl as elvira } from './elvira-2';

export const XLS: Xl[] = [
  lire,
  elvira,
];
