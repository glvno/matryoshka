// SPDX-License-Identifier: GPL-3.0-only
// Computer-keyboard and Web MIDI note input.
import type { AudioHost } from './audio';
import { OCTAVE_MAX, OCTAVE_MIN } from './patch';

/** the note keys, C up to D# a bit more than an octave above; key i plays `keyBase(octave) + i` */
export const KEYS = 'awsedftgyhujkolp';
export { OCTAVE_MIN, OCTAVE_MAX };
export const keyBase = (octave: number): number => 60 + octave * 12;
const NON_TYPING_INPUTS = new Set(['range', 'checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'color']);

/** Text editing owns letter keys; merely focusing a synth control does not. */
export function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.tagName === 'TEXTAREA' ||
    (target.tagName === 'INPUT' && !NON_TYPING_INPUTS.has((target as HTMLInputElement).type));
}

export interface NoteKeys {
  octave(): number;
  /** move the note keys by `d` octaves (clamped); held notes keep sounding until their key is released */
  shift(d: number): void;
  /** go to an octave (clamped), as when a patch opens; held notes keep sounding until their key is released */
  set(octave: number): void;
}

export function attachKeyboard(host: Pick<AudioHost, 'send'>, isActive: () => boolean, onOctave: (octave: number) => void = () => {}): NoteKeys {
  let octave = 0;
  const set = (to: number): void => {
    const o = Math.max(OCTAVE_MIN, Math.min(OCTAVE_MAX, Math.round(to)));
    if (o !== octave) (octave = o), onOctave(o);
  };
  const shift = (d: number): void => set(octave + d);
  const down = new Map<string, number>();
  window.addEventListener('keydown', (e) => {
    if (!isActive() || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || isTextEntry(e.target)) return;
    // An expanded native dropdown still owns its keyboard navigation/typeahead.
    if (e.target instanceof HTMLElement && e.target.tagName === 'SELECT' && e.target.matches(':open')) return;
    const k = e.key.toLowerCase();
    const i = KEYS.indexOf(k);
    if (i < 0 && k !== 'z' && k !== 'x') return;
    // Also consume repeats: otherwise holding F starts native select typeahead.
    e.preventDefault();
    if (e.repeat) return;
    if (k === 'z') shift(-1);
    else if (k === 'x') shift(1);
    if (i >= 0 && !down.has(k)) {
      const note = keyBase(octave) + i;
      down.set(k, note);
      host.send({ t: 'on', note, vel: 0.8 });
    }
  });
  window.addEventListener('keyup', (e) => {
    const k = e.key.toLowerCase();
    const note = down.get(k);
    if (note !== undefined) {
      down.delete(k);
      host.send({ t: 'off', note });
    }
  });
  window.addEventListener('blur', () => {
    for (const note of down.values()) host.send({ t: 'off', note });
    down.clear();
  });
  return { octave: () => octave, shift, set };
}

/** a followed FM-1's button through its panel logic (`drive`): when that moved the panel's octave (OCT- / OCT+, not on
 * the SEQ page), the note keys and their display move by as much */
export function followOctave(keys: Pick<NoteKeys, 'shift'>, panelOctave: () => number, drive: () => void): void {
  const before = panelOctave();
  drive();
  const d = panelOctave() - before;
  if (d) keys.shift(d);
}

/**
 * Asks for Web MIDI and plays from every input. Resolves to a switch (off: incoming messages are ignored and the notes
 * MIDI holds are released; the access itself stays until the page reloads), or null when MIDI could not be had.
 * `inputs` hears the number of inputs as it changes; `skip` names an input to ignore for now (an FM-1 whose panel the
 * mirror follows: its keys, knobs and buttons come in through the mirror, and here they would arrive twice).
 */
export async function attachMidi(
  host: Pick<AudioHost, 'send'>,
  status: (s: string) => void,
  inputs?: (n: number) => void,
  skip: (port: MIDIInput) => boolean = () => false,
): Promise<((on: boolean) => void) | null> {
  if (!navigator.requestMIDIAccess) {
    status('Web MIDI is not available in this browser');
    return null;
  }
  let access: MIDIAccess;
  try {
    access = await navigator.requestMIDIAccess();
  } catch (e) {
    status(`MIDI access denied: ${e}`);
    return null;
  }
  let on = true;
  const held = new Set<number>();
  const message = (ev: MIDIMessageEvent): void => {
    if (!on || skip(ev.target as MIDIInput)) return;
    const [s, a, b] = ev.data ?? [];
    if (s === 0xf8) return void host.send({ t: 'clock' });
    if (s === 0xfa || s === 0xfb || s === 0xfc) return void host.send({ t: 'clockrun', on: s !== 0xfc });
    const cmd = s & 0xf0, ch = (s & 0x0f) + 1; // the channel: a Voice allocator can take one only
    if (cmd === 0x90 && b > 0) {
      held.add(a | (ch << 7));
      host.send({ t: 'on', note: a, vel: b / 127, ch });
    } else if (cmd === 0x80 || (cmd === 0x90 && b === 0)) {
      held.delete(a | (ch << 7));
      host.send({ t: 'off', note: a, ch });
    } else if (cmd === 0xb0 && a === 123) host.send({ t: 'panic' });
    else if (cmd === 0xb0) host.send({ t: 'cc', n: a, v: b }); // CC 1 = mod wheel, 16..19 = the Main module's knobs
    else if (cmd === 0xe0) host.send({ t: 'bend', v: (((b << 7) | a) - 8192) / 8192 });
    else if (cmd === 0xd0) host.send({ t: 'at', v: a / 127 });
  };
  const hook = (): void => {
    for (const input of access.inputs.values()) input.onmidimessage = message;
    status(`${access.inputs.size} MIDI input(s)`);
    inputs?.(access.inputs.size);
  };
  access.onstatechange = hook;
  hook();
  return (next) => {
    on = next;
    if (on) return hook();
    for (const k of held) host.send({ t: 'off', note: k & 127, ch: k >> 7 });
    held.clear();
  };
}
