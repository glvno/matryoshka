// SPDX-License-Identifier: GPL-3.0-only
// Verona Drum 1 XL (#613): the whole Vermona DRM1 MKIV (its user manual: vermona.com, drm1mk4_manual_web_en.pdf, "Sound
// Generation" and "The instrument channels", pages 10 to 18; "MIDI Functions", pages 19 and 20). All eight instrument
// channels, each with every knob of its panel and its own signal flow (scripts/verona-voices.ts says what each knob
// does): KICK, DRUM 1, DRUM 2, MULTI, SNARE, HI HAT 1, HI HAT 2, CLAP. Every channel has its PAN and VOLUME, and MASTER
// is the overall volume (an Offset into the two output VCAs). Each channel has its own noise source; NOISE COLOR is on
// the clap, as on the original.
// The Drum map's eight rows are the eight TRIG buttons, in the panel's order, on the white keys from F3 as on every
// factory kit. A hi-hat's row plays it open or closed by its TRIG switch (the original's TRIG button mode, held for a
// second to change it); a second Drum map plays the closed hi-hats of both channels whatever TRIG says, as the
// original's second MIDI note per hi-hat does (rows HH 1 CL and HH 2 CL, on G4 and A4). PATTERN (a Steps track, D-330)
// plays the first map, CLOSED the second; Main's keys go into both, so the keyboard plays all ten.
// The FM-1 version (web/presets/NN-verona-drum-1.json) leaves out Drum 2 and Hi Hat 2 (each the same as its pair), PAN, the
// closed-hat notes, NOISE COLOR (its six channels share one white noise) and MASTER.
// Not here (D-347): the TRIG buttons (the keys and the rows play the channels), the individual outputs and inserts and
// the trigger inputs (jacks), MIDI learn and the trigger modes (the Drum map's notes are its rows' settings).
import { DEFS } from '../../src/modules';
import { addModule, type Patch } from '../../src/patch';
import { fixNotes, patternNotes, type StepNote } from '../../src/track';
import { assembliesOf } from '../../src/assembly';
import { mod, players, wire } from '../factory-build';
import { around, define, KIT_NOTES, matchLevel, type Built } from './def';
import { clap, drum, hihat, kick, multi, ownNoise, snare, TRIG_NAMES, type Voice } from '../verona-voices';
import type { Xl } from './xl';

const NOTES = 'The whole Vermona DRM1 MKIV: all eight channels with every knob, PAN and VOLUME each, MASTER. The rows ' +
  'are the TRIG buttons; a hi-hat row plays open or closed by its TRIG switch, and the CLOSED track plays both hi-hats ' +
  'closed (the original\'s second MIDI note per hi-hat).';

/** the channels: heading, Drum map row name, pan */
const CHANNELS: [string, string, number][] = [
  ['kick', 'KICK', 0], ['drum 1', 'DRUM 1', -0.35], ['drum 2', 'DRUM 2', 0.35], ['multi', 'MULTI', 0.25],
  ['snare', 'SNARE', 0], ['hi hat 1', 'HI HAT 1', -0.2], ['hi hat 2', 'HI HAT 2', 0.3], ['clap', 'CLAP', 0.1],
];

/** PATTERN's 16 steps per row (X an accent), CLOSED's for the closed hi-hats */
export const PATTERN: Record<number, string> = {
  1: 'X...x...X...x.x.',
  2: '..........x.....',
  3: '.............x..',
  4: '...x.......x....',
  5: '....X.......X...',
  6: 'x.x.x.x.x.x.x.xx',
  7: '..x...x...x...x.',
  8: '....x.......x..x',
};

const ENGINE: Built = define('Verona Drum 1 XL', (b) => {
  const map = b.add('drummap', 0, 0, Object.fromEntries(KIT_NOTES.map((n, r) => [`n${r + 1}`, n])));
  b.module(map).names = CHANNELS.map(([, row]) => row);
  const closed = b.add('drummap', 0, 1, { n1: 67, n2: 69, n3: 0, n4: 0, n5: 0, n6: 0, n7: 0, n8: 0 });
  b.module(closed).names = ['HH 1 CL', 'HH 2 CL', '-', '-', '-', '-', '-', '-'];
  const voices: Voice[] = [
    kick(b, 1, ownNoise),
    drum(b, 2, { coarse: -17, decay: 0.35 }),
    drum(b, 3, { coarse: -7, decay: 0.25 }),
    multi(b, 4),
    snare(b, 5, ownNoise),
    hihat(b, 6, ownNoise, { trig: 2 }),
    hihat(b, 7, ownNoise, { trig: 1, pitch: 27 }),
    clap(b, 8, ownNoise, { color: true }),
  ];
  const master = b.add('const', 10, 0, { value: 1 });
  const outL = b.add('vca', 10, 1, { gain: 1 });
  const outR = b.add('vca', 10, 2, { gain: 1 });
  b.wire(master, 'out', outL, 'cv');
  b.wire(master, 'out', outR, 'cv');
  const pans: number[] = [];
  voices.forEach((v, i) => {
    const r = i + 1;
    for (const [m, port] of v.gate) b.wire(map, `g${r}`, m, port);
    b.wire(map, `v${r}`, v.vel[0], v.vel[1]);
    const pan = b.add('pan', 1 + i, 6, { pan: CHANNELS[i][2] });
    b.wire(v.out[0], v.out[1], pan, 'in');
    b.wire(pan, 'l', outL, 'in');
    b.wire(pan, 'r', outR, 'in');
    pans.push(pan);
    b.nest(CHANNELS[i][0], 1 + i, 0, [...v.members, pan]);
  });
  // the closed hi-hats' rows
  [5, 6].forEach((i, k) => {
    const v = voices[i];
    for (const [m, port] of v.closed!) b.wire(closed, `g${k + 1}`, m, port);
    b.wire(closed, `v${k + 1}`, v.closedVel![0], v.closedVel![1]);
  });
  b.input('keys', map, 'keys');
  b.input('closed keys', closed, 'keys');
  b.output('l', outL, 'out');
  b.output('r', outR, 'out');
  voices.forEach((v, i) => {
    v.rows.forEach(([label, m, param], k) => b.param(label, m, param, k === 0 ? { head: CHANNELS[i][0], col: true } : {}));
    b.param('pan', pans[i], 'pan');
    b.param('volume', v.out[0], 'gain');
  });
  b.param('master', master, 'value', { head: 'master', col: true });
});
for (const r of ENGINE.def.params) if (r.label === 'trig') r.names = [...TRIG_NAMES];

/** a Steps track named `name` between Main's keys and the engine's input `input`, holding `rows` (row → steps) of `map` */
function track(p: Patch, name: string, y: number, input: string, rows: Record<number, string>): void {
  const main = p.modules.find((m) => m.type === 'fm1')!;
  const a = assembliesOf(p).find((x) => x.name === 'Verona Drum 1 XL')!;
  const into = a.inputs.find((r) => r.label === input)!;
  p.cables = p.cables.filter((c) => !(c.from.module === main.id && c.to.module === into.module && c.to.port === into.port));
  const st = addModule(p, DEFS.steps, 20, y);
  st.name = name;
  wire(p, main.id, 'keys', st.id, 'keys');
  wire(p, st.id, 'keys', into.module, into.port);
  const map = mod(p, into.module);
  const notes: StepNote[] = [];
  for (const [r, steps] of Object.entries(rows)) {
    const key = Math.round(map.params[`n${r}`]);
    for (const n of patternNotes(steps) ?? []) notes.push({ ...n, note: key });
  }
  st.notes = fixNotes(notes);
}

export const xl: Xl = {
  base: 'Verona Drum 1',
  build: (fm1: Patch): Patch => {
    const { p, main, a } = around('Verona Drum 1 XL', ENGINE);
    const closed = a.inputs.find((r) => r.label === 'closed keys')!;
    wire(p, main.id, 'keys', closed.module, closed.port);
    track(p, 'PATTERN', 300, 'keys', PATTERN);
    track(p, 'CLOSED', 600, 'closed keys', {});
    p.notes = NOTES;
    p.octave = -1;
    matchLevel(p, fm1, KIT_NOTES);
    return players(p, true);   // (an Arpeggiator, bypassed, between PATTERN and the Drum map, as every XL)
  },
};
