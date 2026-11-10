// SPDX-License-Identifier: GPL-3.0-only
import { make } from './presets';

/** More logical values than physical buffers, and four effect lines that need the difference. */
export const recoveredLines = () => make('recovered lines', (add, wire) => {
  const main = add('fm1', 0, 0), osc = add('osc', 0, 0, { level: .1 }), out = add('output', 0, 0);
  wire(main, 'pitch', osc, 'pitch');
  let previous = osc;
  for (let i = 0; i < 80; i++) {
    const m = add('scale', 0, 0, { gain: 1 }); wire(previous, 'out', m, 'in'); previous = m;
  }
  for (let i = 0; i < 4; i++) {
    const m = add('delay', 0, 0, { length: 850, time: 20, mix: .1 }); wire(previous, 'out', m, 'in'); previous = m;
  }
  wire(previous, 'out', out, 'l'); wire(previous, 'out', out, 'r');
});
