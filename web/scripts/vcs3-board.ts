// SPDX-License-Identifier: GPL-3.0-only
// Briefcase 3's pin board (D-1052): the EMS VCS3's 16 x 16 pin matrix (VCS3 Users Manual, EMS London: the matrix board)
// on 16 Matrix modules of 4 x 4 pins each, beside the Briefcase 3 assembly (scripts/gen-assemblies.ts). Every source is a
// row (an output of the assembly, `rowLabel`), every input a column (an input of the assembly, `columnLabel`; columns L
// and M are the decay's and the reverb mix's parameter inputs, which an assembly shows as their card rows instead). A pin
// is named column then row, as the manual names it ("H13": the ring modulator into the filter). A tile holds four
// columns' pins of four rows: its inputs are the rows, its outputs the columns, and the four tiles of one column group sum
// at the column's input, as the VCS3's resistor pins do.
// The tiles are top-level modules, so an engine preset of Briefcase 3 does not hold the pins (the owner accepted this,
// D-1052). Their order in the patch decides which cable of a feedback loop the engines run one block late (patch.ts
// processingOrder): the column groups AENP, BCKO, DFGH, IJLM in that order, each tile's columns in the order listed, the
// tiles after the assembly, render the factory patch sample for sample as Briefcase 3 XL did (vcs3-board.test.ts).
import { DEFS, matrixPin } from '../src/modules';
import { addModule, connect, type Patch } from '../src/patch';
import type { AssemblyInst } from '../src/assembly';

export const LETTERS = 'ABCDEFGHIJKLMNOP';
/** the rows, 1..16: the manual's sources (row 9, input amplifier 2, needs audio input: the Briefcase 3 assembly has no
 * output for it) */
export const ROWS = [
  'osc 1 sine', 'osc 1 ramp', 'osc 2 square', 'osc 2 triangle', 'osc 3 square', 'osc 3 triangle', 'noise', 'input 1',
  'input 2', 'filter', 'trapezoid', 'env signal', 'ring mod', 'reverb', 'stick x', 'stick y',
];
/** the columns, A..P: A meter (the scope), B and C the output amplifiers, D the envelope shaper's input, E and F the ring
 * modulator's, G the reverb's, H the filter's; I, J, K the oscillators' frequencies, L the decay, M the reverb mix, N the
 * filter's frequency, O and P the output levels */
export const COLUMNS = [
  'meter', 'output 1', 'output 2', 'envelope', 'ring A', 'ring B', 'reverb', 'filter',
  'osc 1 freq', 'osc 2 freq', 'osc 3 freq', 'decay', 'reverb mix', 'filter freq', 'out 1 level', 'out 2 level',
];
/** the columns that reach a parameter input: the card row whose parameter they move (the row's module's p1) */
export const COLUMN_ROWS: Record<string, string> = { L: 'decay', M: 'mix' };
/** the assembly's output of row n (1..16) and its input of column c ('A'..'P') */
export const rowLabel = (n: number): string => `${n} ${ROWS[n - 1]}`;
export const columnLabel = (c: string): string => `${c} ${COLUMNS[LETTERS.indexOf(c)]}`;
/** the tiles' column groups, in the order the tiles come in the patch (each tile: these four columns, as its outputs 1..4) */
export const TILE_COLUMNS = ['AENP', 'BCKO', 'DFGH', 'IJLM'];
/** the classic patch (the pins set when Briefcase 3 loads): oscillator 1 (both outputs), oscillator 2's square, the ring
 * modulator and the noise into the filter (H1 H2 H3 H13 H7), the filter into the envelope shaper (D10), its signal into
 * the reverb (G12), the reverb into both outputs (B14 C14) and the meter (A14); the ring modulator multiplies oscillator
 * 1's ramp by oscillator 2's square (E2 F3); the keys into oscillators 1 and 2 and the filter (I8 J8 N8), oscillator 3's
 * triangle into oscillator 1 and the filter (I6 N6), the trapezoid into the filter (N11); the joystick's x into the filter
 * (N15) and its y into oscillator 1 (I16), so a MIDI controller's X-Y pad learned onto x and y moves the sound (#1067); at
 * the stick's centre, 0, they add nothing, so the patch loads sounding as before. A pin is a level, -1..1. */
export const PINS: Record<string, number> = {
  H1: 1, H2: 1, H3: 1, H7: 1, H13: 1, D10: 1, G12: 1, B14: 1, C14: 1, E2: 1, F3: 1, A14: 1,
  I8: 1, J8: 1, I6: 0.03, N8: 1, N6: 0.125, N11: 0.3125, N15: 0.5, I16: 0.25,
};

export interface Tile { columns: string; rows: number[]; name: string }
/** the 16 tiles in patch order: column group by column group, rows 1-4, 5-8, 9-12, 13-16. Each is named by its columns
 * and rows, as the FM-1 shows the device ("AENP 5-8"). The names take 156 bytes for the 16 (a name costs its length and a
 * byte): Briefcase 3's effects rack has no drive to make room for them (the owner, D-1052). */
export const TILES: Tile[] = TILE_COLUMNS.flatMap((columns) => [0, 1, 2, 3].map((rb) => {
  const rows = [1, 2, 3, 4].map((k) => rb * 4 + k);
  return { columns, rows, name: `${columns} ${rows[0]}-${rows[3]}` };
}));
/** the tile parameter of a pin ("H13") */
export function pinAt(pin: string): { tile: number; param: string } {
  const c = pin[0], n = Number(pin.slice(1));
  const tile = TILES.findIndex((t) => t.columns.includes(c) && t.rows.includes(n));
  if (tile < 0) throw new Error(`no pin ${pin}`);
  return { tile, param: matrixPin(TILES[tile].rows.indexOf(n) + 1, TILES[tile].columns.indexOf(c) + 1) };
}

/** the 16 tiles beside a Briefcase 3 assembly `a` of patch `p`, appended to its modules, cabled to the assembly's rows and
 * columns, their pins at `pins` (unlisted: 0); returns the tiles' module ids in order */
export function addBoard(p: Patch, a: AssemblyInst, pins: Record<string, number> = PINS, at: { x: number; y: number } = { x: 0, y: 0 }): number[] {
  const wire = (from: { module: number; port: string }, to: { module: number; port: string }): void => {
    if (!connect(p, DEFS, { module: from.module, port: from.port }, { module: to.module, port: to.port })) throw new Error(`${p.name}: bad cable ${from.module}.${from.port} -> ${to.module}.${to.port}`);
  };
  const dests = (c: string): { module: number; port: string }[] => {
    if (COLUMN_ROWS[c]) {
      const r = a.params.find((q) => q.label === COLUMN_ROWS[c]);
      if (!r) throw new Error(`${p.name}: no row ${COLUMN_ROWS[c]}`);
      return [{ module: r.module, port: 'p1' }];
    }
    const r = a.inputs.find((q) => q.label === columnLabel(c));
    if (!r) throw new Error(`${p.name}: no input ${columnLabel(c)}`);
    return [r, ...(r.also ?? [])];
  };
  for (const pin of Object.keys(pins)) pinAt(pin);
  return TILES.map((t, k) => {
    const m = addModule(p, DEFS.matrix, at.x + Math.floor(k / 4) * 380, at.y + (k % 4) * 300);
    m.name = t.name;
    t.rows.forEach((n, i) => t.columns.split('').forEach((c, o) => (m.params[matrixPin(i + 1, o + 1)] = pins[`${c}${n}`] ?? 0)));
    t.rows.forEach((n, i) => {
      const s = a.outputs.find((r) => r.label === rowLabel(n));
      if (s) wire(s, { module: m.id, port: `in${i + 1}` });
    });
    t.columns.split('').forEach((c, o) => {
      for (const d of dests(c)) wire({ module: m.id, port: `out${o + 1}` }, d);
    });
    return m.id;
  });
}
