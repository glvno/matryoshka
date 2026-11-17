// SPDX-License-Identifier: GPL-3.0-only
// @vitest-environment jsdom
// The deck's test phrase group (#945) and its WAV export and recording (#946).
import { describe, expect, it, vi } from 'vitest';
import { Audition, DEFAULT_CHOICE, REC_MAX_SECONDS, loadChoice, peakText, phraseTitle, type AuditionHost } from './audition';
import type { HostMsg } from './worklet';
import { PRESETS } from './presets';
import { renderPhrase } from './phrase-render';
import { PHRASE_TAIL, PhrasePlayer, makePhrase } from './phrases';
import { WAV_RATE } from './wav';
import { PROBE_RENDER, probePhrase } from './mutate-render';

function setup(store: Record<string, string> = {}) {
  const clock = { t: 100 };
  const sent: HostMsg[] = [];
  const statuses: string[] = [];
  const downloads: { bytes: Uint8Array; name: string }[] = [];
  const patch = PRESETS['808 Kit']();
  const host: AuditionHost = {
    send: (m) => sent.push(m),
    start: vi.fn(async () => {}),
    sampleRate: () => 48000,
    patch: () => patch,
    stem: () => '808_Kit',
    armed: () => ['m3'],
    tempo: () => 90,
    status: (t) => statuses.push(t),
    download: (bytes, name) => downloads.push({ bytes, name }),
    render: vi.fn(async () => [new Float32Array([0.5, -0.25]), new Float32Array([0.1, 0.1])] as [Float32Array, Float32Array]),
    resample: vi.fn(async (l: Float32Array, r: Float32Array) => [l, r] as [Float32Array, Float32Array]),
    now: () => new Date(2026, 10, 16, 14, 30),
    clock: () => clock.t,
  };
  const storage = { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; } };
  return { a: new Audition(host, storage), host, sent, statuses, downloads, store, clock };
}
const phrases = (sent: HostMsg[]) => sent.filter((m): m is Extract<HostMsg, { t: 'phrase' }> => m.t === 'phrase');

describe('the choice', () => {
  it('is remembered in this browser, and anything not understood falls back field by field', () => {
    expect(loadChoice(null)).toEqual(DEFAULT_CHOICE);
    expect(loadChoice('{"kind":"chord","pitch":14,"octave":6,"loop":"yes"}')).toEqual({ ...DEFAULT_CHOICE, kind: 'chord', octave: 6 });
    expect(loadChoice('not json')).toEqual(DEFAULT_CHOICE);
    const { a, store } = setup();
    a.choose({ kind: 'sweep', pitch: 9, octave: 3 });
    expect(setup(store).a.choice).toEqual({ kind: 'sweep', pitch: 9, octave: 3, loop: false });
  });

  it('names the phrase with its root; the drum pattern has none', () => {
    expect(phraseTitle({ kind: 'chord', pitch: 1, octave: 4, loop: false })).toBe('Chord C#4');
    expect(phraseTitle({ kind: 'drums', pitch: 1, octave: 4, loop: false })).toBe('Drum pattern');
  });
});

describe('playing', () => {
  it('the button (and Q) starts the audio, sends the phrase, and stops it again', async () => {
    const { a, host, sent } = setup();
    a.toggle();
    await vi.waitFor(() => expect(phrases(sent)).toHaveLength(1));
    expect(host.start).toHaveBeenCalled();
    expect(phrases(sent)[0]).toEqual({ t: 'phrase', phrase: makePhrase('held', 60), loop: false });
    expect(a.el.querySelector('.ph-play')!.getAttribute('aria-pressed')).toBe('true');
    a.toggle();
    expect(phrases(sent)[1]).toEqual({ t: 'phrase', phrase: null });
    expect(a.playing).toBe(false);
  });

  it('a change while it plays starts it again with the change; stopped, nothing is sent', async () => {
    const { a, sent } = setup();
    a.choose({ octave: 2 });
    expect(phrases(sent)).toHaveLength(0);
    await a.play();
    a.choose({ loop: true });
    expect(phrases(sent).at(-1)).toMatchObject({ loop: true, phrase: { notes: [{ note: 36 }] } });
  });

  it('restart (an A/B flip) sends the phrase from the top only while one plays', async () => {
    const { a, sent } = setup();
    a.restart();
    expect(phrases(sent)).toHaveLength(0);
    await a.play();
    a.restart();
    expect(phrases(sent)).toHaveLength(2);
    expect(phrases(sent)[1]).toEqual(phrases(sent)[0]);
  });

  it('the drum pattern plays the patch’s Drum map rows and greys the root', async () => {
    const { a, sent } = setup();
    a.choose({ kind: 'drums' });
    expect((a.el.querySelector('.ph-pitch') as HTMLSelectElement).disabled).toBe(true);
    await a.play();
    expect(phrases(sent)[0].phrase!.kind).toBe('drums');
  });

  it('a phrase played once that ends puts the button back', async () => {
    const { a } = setup();
    await a.play();
    a.ended();
    expect(a.el.querySelector('.ph-play')!.textContent).toBe('▶ Phrase');
  });
});

describe('the WAV', () => {
  it('renders the phrase with the armed devices and the global tempo, and names the file after the patch and phrase', async () => {
    const { a, host, downloads, statuses } = setup();
    a.choose({ kind: 'chord', pitch: 0, octave: 4 });
    await a.exportPhrase();
    expect(host.render).toHaveBeenCalledWith(host.patch(), makePhrase('chord', 60), { armed: ['m3'], tempo: 90 });
    expect(downloads[0].name).toBe('808_Kit_Chord-C4_2026-11-16_1430.wav');
    expect(statuses.at(-1)).toContain('peak −6.0 dBFS');
  });

  it('records the Output in chunks and saves them as one file when stopped', async () => {
    const { a, host, sent, downloads } = setup();
    await a.toggleRecord();
    expect(sent.at(-1)).toEqual({ t: 'record', on: true });
    await a.recorded([new Float32Array([0.1, 0.2]), new Float32Array([0.3, 0.4])], false);
    void a.toggleRecord();
    expect(sent.at(-1)).toEqual({ t: 'record', on: false });
    await a.recorded([new Float32Array([0.5]), new Float32Array([0.6])], true);
    expect(host.resample).toHaveBeenCalledWith(new Float32Array([0.1, 0.2, 0.5]), new Float32Array([0.3, 0.4, 0.6]), 48000);
    expect(downloads[0].name).toBe('808_Kit_recording_2026-11-16_1430.wav');
    expect(a.recording).toBe(false);
  });

  it('a recording stops by itself at the limit', async () => {
    const { a, sent } = setup();
    await a.toggleRecord();
    await a.recorded([new Float32Array(REC_MAX_SECONDS * 48000), new Float32Array(REC_MAX_SECONDS * 48000)], false);
    expect(sent.at(-1)).toEqual({ t: 'record', on: false });
  });

  it('peaks read in dB of full scale', () => {
    expect(peakText(new Float32Array([0.5]), new Float32Array([-1]))).toBe('peak 0.0 dBFS');
    expect(peakText(new Float32Array([2]), new Float32Array([0]))).toBe('peak 6.0 dBFS');
    expect(peakText(new Float32Array(4), new Float32Array(4))).toBe('silent');
  });
});

describe('My take', () => {
  it('the last take becomes a phrase that plays as played, survives a reload, and greys the root', async () => {
    const { a, sent, store, clock } = setup();
    const at = (t: number): void => { clock.t = t; };
    at(100); a.played({ t: 'on', note: 50, vel: 0.3 });
    at(100.5); a.played({ t: 'off', note: 50 });
    at(110); a.played({ t: 'on', note: 62, vel: 0.9 });   // (10 s later: a new take)
    at(110.25); a.played({ t: 'on', note: 65, vel: 0.5 });
    at(110.75); a.played({ t: 'off', note: 62 });
    at(111); a.played({ t: 'off', note: 65 });
    at(120); a.useTake();
    expect(a.choice.kind).toBe('take');
    expect((a.el.querySelector('.ph-pitch') as HTMLSelectElement).disabled).toBe(true);
    await a.play();
    const p = phrases(sent).at(-1)!.phrase!;
    expect(p.notes).toEqual([{ at: 0, len: 0.75, note: 62, vel: 0.9 }, { at: 0.25, len: 0.75, note: 65, vel: 0.5 }]);
    expect(p.length).toBe(1);   // (it ends at 1 s: two beats at 120 bpm)
    const again = setup(store).a;
    expect(again.choice.kind).toBe('take');
    expect(again.phrase()).toEqual(p);
  });

  it('with nothing played, Use my last take says so and changes nothing', () => {
    const { a, statuses } = setup();
    a.useTake();
    expect(statuses.at(-1)).toMatch(/^no take yet/);
    expect(a.choice.kind).toBe('held');
    expect((a.el.querySelector('option[value="take"]') as HTMLOptionElement).disabled).toBe(true);
  });

  it('a new take replaces My take', () => {
    const { a, clock } = setup();
    a.played({ t: 'on', note: 60, vel: 1 });
    clock.t += 1; a.played({ t: 'off', note: 60 });
    a.useTake();
    clock.t += 5; a.played({ t: 'on', note: 72, vel: 1 });
    clock.t += 1; a.played({ t: 'off', note: 72 });
    a.useTake();
    expect(a.myTake!.map((n) => n.note)).toEqual([72]);
  });

  it('a take plays back the same notes in order, each within a block of its time, at its velocity', () => {
    const { a, clock } = setup();
    const played = [[0, 60, 0.4], [0.3, 64, 0.7], [0.61, 67, 1]] as const;
    for (const [t, note, vel] of played) (clock.t = 100 + t), a.played({ t: 'on', note, vel });
    clock.t = 101.5; for (const [, note] of played) a.played({ t: 'off', note });
    a.useTake();
    const ons: [number, number, number][] = [];
    const player = new PhrasePlayer(a.phrase(), false, WAV_RATE);
    for (let f = 0; f < WAV_RATE * 3; f += 128) player.block(128, (note, vel) => ons.push([f, note, vel]), () => {});
    expect(ons.map((o) => o[1])).toEqual([60, 64, 67]);
    ons.forEach(([f, , vel], i) => {
      expect(Math.abs(f / WAV_RATE - played[i][0])).toBeLessThan(128 / WAV_RATE);
      expect(vel).toBe(played[i][2]);
    });
  });
});

describe('renderPhrase', () => {
  it('plays the patch with the phrase once plus its tail at 44.1 kHz, the same every time', async () => {
    const patch = PRESETS['Basic Poly']();
    const phrase = makePhrase('staccato', 60);
    const [l, r] = await renderPhrase(patch, phrase);
    expect(l.length).toBe(Math.round((phrase.length + PHRASE_TAIL) * WAV_RATE));
    expect(r.length).toBe(l.length);
    const peak = (from: number, to: number): number => l.subarray(from * WAV_RATE, to * WAV_RATE).reduce((m, x) => Math.max(m, Math.abs(x)), 0);
    expect(peak(0, 1)).toBeGreaterThan(0.01);
    expect(peak(phrase.length + PHRASE_TAIL - 0.5, phrase.length + PHRASE_TAIL)).toBeLessThan(peak(0, 1) / 100);
    const [l2] = await renderPhrase(patch, phrase);
    expect(l2).toEqual(l);
  });
});

describe('the probe Make candidates renders (D-996)', () => {
  it('is the same whatever the test phrase, and leaves the test phrase settings alone', async () => {
    const { a, host, store } = setup();
    const patch = PRESETS['808 Kit']();
    const kinds = ['held', 'staccato', 'chord', 'sweep', 'drums'] as const;
    for (const [i, kind] of kinds.entries()) {
      a.choose({ kind, pitch: (3 * i) % 12, octave: 2 + i, loop: i % 2 === 0 });
      const before = { choice: { ...a.choice }, store: { ...store } };
      await a.renderWith(patch, probePhrase(patch), PROBE_RENDER);
      expect(a.choice).toEqual(before.choice);
      expect(store).toEqual(before.store);
    }
    const calls = vi.mocked(host.render).mock.calls;
    expect(calls.length).toBe(kinds.length);
    for (const [, phrase, how] of calls) {
      expect(phrase).toEqual(probePhrase(patch));
      expect(how).toMatchObject(PROBE_RENDER);
    }
  });
});
