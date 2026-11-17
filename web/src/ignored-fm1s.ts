// SPDX-License-Identifier: GPL-3.0-only
// The FM-1s set to leave the editor alone (GLO › SYSTEM › EDITOR at IGNORE, #702, D-484), linked or not: their MIDI plays
// nothing in the editor (#1045), so a test rig or a second FM-1 kept at IGNORE never plays this window's patch nor presses
// its buttons. Every other FM-1 plays it as any MIDI controller does. Each input and output pair named like an FM-1
// (device.ts linkCandidates, the pairs Connect FM-1 asks first) is asked HELLO when it appears; its INFO says the setting,
// and so does the INFO the FM-1 sends unasked when the setting changes after a HELLO. An FM-1 that never answers (other
// firmware, still starting) plays: unknown counts as ALLOW, as for firmware without the setting.
import { linkCandidates } from './device';
import { emulatorElsewhere, otherFm1 } from './input';
import { CMD, editorSkips, helloFrame, parse, parseInfo, rigTools } from './protocol';

/** an input whose MIDI plays nothing in the editor (input.ts attachMidi's `skip`, with the followed FM-1): while one FM-1 is
 *  linked (`linkedId`), any other (#698); the emulator's port unless it is the linked one; an FM-1 set to ignore the
 *  editor (#1045). Any other FM-1 plays and presses the patch buttons, as a MIDI controller does */
export const playsNothing = (port: Pick<MIDIPort, 'id' | 'name'>, linkedId: string | null | undefined, ignoring: Pick<IgnoredFm1s, 'has'> | null): boolean =>
  otherFm1(port, linkedId) || emulatorElsewhere(port, linkedId) || !!ignoring?.has(port);

/** HELLO is asked this many times, WAIT ms apart, until the FM-1 answers (Connect FM-1 asks as often, device.ts) */
const TRIES = 3;
const WAIT = 700;

export class IgnoredFm1s {
  private ignored = new Set<string>();
  /** the inputs listened to, by id: each was asked HELLO when it appeared */
  private heard = new Map<string, { inp: MIDIInput; listener: (ev: Event) => void }>();

  /** `quiet`: an input asked no HELLO (the linked FM-1: the link asks it, and its answers are heard here too) */
  constructor(private access: MIDIAccess, private quiet: (inp: MIDIInput) => boolean = () => false) {
    access.addEventListener('statechange', () => this.survey());
    this.survey();
  }

  /** the input is an FM-1 set to ignore the editor: its MIDI plays nothing here */
  has(port: Pick<MIDIPort, 'id'>): boolean {
    return this.ignored.has(port.id);
  }

  /** forget the ports gone, listen to the FM-1-named pairs new since, and ask them HELLO. The emulator's port is left out:
   *  it plays nothing here anyway (input.ts emulatorElsewhere), and a HELLO would reach the scenario that drives it */
  private survey(): void {
    for (const [id, h] of this.heard) {
      if (h.inp.state !== 'disconnected') continue;
      h.inp.removeEventListener('midimessage', h.listener);
      this.heard.delete(id);
      this.ignored.delete(id);
    }
    for (const { inp, out, named } of linkCandidates(this.access.inputs.values(), this.access.outputs.values())) {
      if (!named || this.heard.has(inp.id) || emulatorElsewhere(inp)) continue;
      let answered = false;
      const listener = (ev: Event): void => {
        const data = (ev as MIDIMessageEvent).data;
        const p = data && data[0] === 0xf0 ? parse(data) : null;
        const info = p?.cmd === CMD.info ? parseInfo(p) : null;
        if (!info) return;
        answered = true;
        if (editorSkips(info)) this.ignored.add(inp.id);
        else this.ignored.delete(inp.id);
      };
      inp.addEventListener('midimessage', listener);
      void inp.open?.().catch(() => {});   // (a listener alone does not open the port, as onmidimessage does)
      this.heard.set(inp.id, { inp, listener });
      if (this.quiet(inp)) continue;
      let tries = 0;
      const ask = (): void => {
        if (answered || tries++ >= TRIES || out.state === 'disconnected' || this.heard.get(inp.id)?.listener !== listener) return;
        try {
          out.send(helloFrame());
        } catch {
          return;   // (the port closed meanwhile)
        }
        setTimeout(ask, WAIT);
      };
      ask();
    }
  }
}

/** the FM-1s set to ignore the editor, watched once this site may use MIDI with SysEx (Connect FM-1 asked for it): no
 *  prompt of its own. Null without that permission or Web MIDI, and on the test tools' page, which plays the test rig at
 *  IGNORE by design (protocol.ts rigTools): then every FM-1 plays */
export async function watchIgnoredFm1s(quiet: (inp: MIDIInput) => boolean): Promise<IgnoredFm1s | null> {
  if (!navigator.requestMIDIAccess || !navigator.permissions || rigTools()) return null;
  try {
    const p = await navigator.permissions.query({ name: 'midi', sysex: true } as PermissionDescriptor);
    if (p.state !== 'granted') return null;
    return new IgnoredFm1s(await navigator.requestMIDIAccess({ sysex: true }), quiet);
  } catch {
    return null;   // (no permission query for MIDI here, or no access after all)
  }
}
