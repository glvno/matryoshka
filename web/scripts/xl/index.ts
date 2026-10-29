// SPDX-License-Identifier: GPL-3.0-only
// The XLs gen-xl.ts writes, in this order (the browser lists each after its FM-1 version whatever the order here). To add
// one: write scripts/xl/<slug>.ts exporting `xl` (xl.ts), import it here and add it to the list, then run
// `npx vite-node scripts/gen-xl.ts` from web/ and commit web/presets/xl/<slug>.json.
import type { Xl } from './xl';
import { xl as lire } from './8-lire';
import { xl as elvira } from './elvira-2';
import { xl as oracleV } from './oracle-v';
import { xl as hera6 } from './hera-6';
import { xl as expanderS } from './expander-s';
import { xl as meridian8 } from './meridian-8';
import { xl as algoFour } from './algo-four';
import { xl as perun4 } from './perun-4';
import { xl as kit808 } from './808-kit';
import { xl as kit909 } from './909-kit';
import { xl as spokes6 } from './spokes-6';
import { xl as wanderer } from './wanderer';
import { xl as canvas } from './canvas';
import { xl as briefcase3 } from './briefcase-3';

export const XLS: Xl[] = [
  lire,
  elvira,
  oracleV,
  hera6,
  expanderS,
  meridian8,
  algoFour,
  perun4,
  kit808,
  kit909,
  spokes6,
  wanderer,
  canvas,
  briefcase3,
];
