// SPDX-License-Identifier: GPL-3.0-only
// An FM-1 under Live playing into a Harmonizer (#1053, D-643, D-781): its notes cannot tell a root under the split from a
// chord button, so the browser engine plays what the copy of its panel logic played for the keys it reported
import { describe, expect, it } from 'vitest';
import { LinkedHarmKeys } from './linked-harm-keys';
import { panelPlay } from './emu-keys';
import { Engine } from './engine';
import { PRESETS } from './presets';
import type { HostMsg } from './worklet';

describe('the linked FM-1\'s keys on a Harmonizer (#1053)', () => {
  it('plays the FM-1\'s notes while the keys reach no Harmonizer, and the copy\'s plays while they do', () => {
    const k = new LinkedHarmKeys();
    const root = panelPlay({ note: 60, vel: 65536, on: true }, (i) => i);
    expect(k.note({ t: 'on', note: 60, vel: 1 }, false)).toEqual([{ t: 'on', note: 60, vel: 1 }]);
    expect(k.copy([root], false)).toEqual([]);
    expect(k.note({ t: 'off', note: 60 }, false)).toEqual([{ t: 'off', note: 60 }]);
    // a chord button (kind 2) and a root under the split, an octave down: both read 54 on the FM-1's MIDI out
    const button = panelPlay({ note: 1, vel: 65536, on: true, kind: 2 }, (i) => i);
    expect(k.note({ t: 'on', note: 54, vel: 0.8 }, true)).toEqual([]);
    expect(k.copy([button], true)).toEqual([{ t: 'chord', button: 1, down: true }]);
    expect(k.note({ t: 'on', note: 54, vel: 0.8 }, true)).toEqual([]);
    const under = panelPlay({ note: 54, vel: 65536, on: true }, (i) => i);
    expect(k.copy([under], true)).toEqual([{ t: 'on', note: 54, vel: 1, root: true }]);
    expect(k.note({ t: 'off', note: 54 }, true)).toEqual([]);
    expect(k.copy([panelPlay({ note: 54, vel: 0, on: false }, (i) => i)], true)).toEqual([{ t: 'off', note: 54, root: true }]);
    expect(k.copy([panelPlay({ note: 1, vel: 0, on: false, kind: 2 }, (i) => i)], true)).toEqual([{ t: 'chord', button: 1, down: false }]);
  });

  it('ends what each side started when the Harmonizer is switched while a key is held', () => {
    const k = new LinkedHarmKeys();
    expect(k.note({ t: 'on', note: 62, vel: 1 }, false)).toEqual([{ t: 'on', note: 62, vel: 1 }]);
    expect(k.note({ t: 'off', note: 62 }, true)).toEqual([{ t: 'off', note: 62 }]);   // (played as it came: its end too)
    expect(k.note({ t: 'on', note: 64, vel: 1 }, true)).toEqual([]);
    expect(k.copy([{ t: 'chord', button: 3, down: true }], true)).toHaveLength(1);
    expect(k.note({ t: 'off', note: 64 }, false)).toEqual([]);                         // (it played nothing: nor its end)
    expect(k.copy([{ t: 'chord', button: 3, down: false }], false)).toEqual([{ t: 'chord', button: 3, down: false }]);
    expect(k.copy([{ t: 'chord', button: 3, down: false }], false)).toEqual([]);
  });

  it('the browser engine plays the FM-1\'s chord an octave down, the root under the split', () => {
    const p = PRESETS['Monolith D']();
    delete p.modules.find((m) => m.type === 'harm')!.bypass;
    p.modules.find((m) => m.type === 'alloc')!.params.voices = 4;
    const e = new Engine(44100);
    e.load(p);
    const k = new LinkedHarmKeys();
    const play = (ms: HostMsg[]): void => {
      for (const m of ms) {
        if (m.t === 'chord') e.chordButton(m.button, m.down);
        else if (m.t === 'on') e.noteOn(m.note, m.vel, m.ch, m.root);
        else if (m.t === 'off') e.noteOff(m.note, m.ch, m.root);
      }
    };
    // at octave -1, key 2 (maj) sends 54 and key 14 (G3) sends 55: both under the split; each note first, its KEYS_NOW after
    play(k.note({ t: 'on', note: 54, vel: 0.8 }, true));
    play(k.copy([panelPlay({ note: 1, vel: 65536, on: true, kind: 2 }, (i) => i)], true));
    play(k.note({ t: 'on', note: 55, vel: 0.8 }, true));
    play(k.copy([panelPlay({ note: 55, vel: 65536, on: true }, (i) => i)], true));
    for (let i = 0; i < 4; i++) e.render(new Float32Array(128), new Float32Array(128));
    expect(e.voiceNotes().filter((v) => v.on).map((v) => v.note).sort((a, b) => a - b)).toEqual([55, 59, 62]);
  });
});
