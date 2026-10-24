// SPDX-License-Identifier: GPL-3.0-only
// Following a connected FM-1's panel (#120): its MIDI in, whatever firmware it runs. The firmware is told by M-VAVE's
// identity handshake (flasher/fm1ota.js) or picked by hand; its profile (fm1-profiles.ts) turns each message into panel
// inputs for the page (main.ts runs them through the firmware UI's copy and the editor). A listener of its own on the
// port: the editor's Live link (device.ts) and a MIDI keyboard may use the same one.

import { Updater } from './flasher/fm1ota.js';
import { firmwareKind } from './felucca-store';
import { PROFILES, firmwareOf, type Firmware, type PanelInput, type Profile } from './fm1-profiles';

const PORT = /fm-?1|felucca|matryoshka|modular|sloop|baud/i;

/** the port names an FM-1 shows on USB MIDI, whatever firmware runs (the Install panel's list, flasher/fm1ota.js) */
const ANY_FM1 = /fm-?1|felucca|matryoshka|modular|ota|composite|sinco|usb-midi/i;

/** who the FM-1 on USB MIDI is, by M-VAVE's identity handshake (as the Install panel asks): its identity, whether that is
 *  an update loader, and its port. `text` is null when a port that looks like an FM-1 is there but nothing answers the
 *  handshake (still starting, or a firmware that does not answer it); null when there is no such port */
export async function identifyFm1(access?: MIDIAccess): Promise<{ text: string | null; loader: boolean; port: string } | null> {
  try {
    const midi = access ?? await navigator.requestMIDIAccess({ sysex: true });
    const dev = await new Updater(midi).find();
    if (dev) {
      dev.link.close();
      return { text: dev.id.text, loader: /^ota-/i.test(dev.id.model), port: dev.name };
    }
    const port = [...midi.inputs.values()].find((p) => p.state !== 'disconnected' && ANY_FM1.test(p.name ?? ''));
    return port ? { text: null, loader: false, port: port.name ?? '' } : null;
  } catch {
    return null;
  }
}

/** what Connect FM-1 says when Matryoshka did not answer, with Install Matryoshka beside it; null: nothing to offer (no
 *  FM-1 on USB, the connect error says so, or it runs Matryoshka after all) */
export function installOffer(id: Awaited<ReturnType<typeof identifyFm1>>): string | null {
  if (!id) return null;
  if (id.loader) return `The FM-1 waits in its update loader (${id.text}): an install was not finished`;
  if (id.text === null) return `An FM-1 is on USB MIDI (${id.port}) but does not answer as Matryoshka: it runs other firmware, or is still starting`;
  const kind = firmwareKind(id.text);
  if (kind === 'matryoshka') return null;
  const what = kind === 'stock' ? `M-VAVE's official firmware (${id.text})` : kind === 'felucca' ? `Felucca (${id.text})` : id.text;
  return `This FM-1 runs ${what}, not Matryoshka`;
}

export class Fm1Mirror {
  profile: Profile | null = null;
  identity: string | null = null;
  port: string | null = null;
  private input: MIDIInput | null = null;
  private listener = (ev: Event): void => {
    const data = (ev as MIDIMessageEvent).data;
    if (!data || !this.profile) return;
    for (const i of this.profile.translate(data)) this.onInput(i);
  };
  onInput: (i: PanelInput) => void = () => {};

  get following(): boolean { return !!this.input && this.input.state !== 'disconnected' && !!this.profile; }

  /** whether `port` is the input being followed (another MIDIAccess's object for the same port has the same id) */
  follows(port: MIDIPort | null | undefined): boolean { return this.following && !!port && port.id === this.input!.id; }

  /** find the FM-1 and start following it; `firmware`: the user's choice, else what its identity says. Throws with a
   * readable message when there is no FM-1 or its firmware is not known (then it has to be picked) */
  async follow(firmware?: Firmware): Promise<Profile> {
    if (!navigator.requestMIDIAccess) throw new Error('Web MIDI is not available in this browser (use Chrome or Edge)');
    this.stop();
    const access = await navigator.requestMIDIAccess({ sysex: true });
    const found = await identifyFm1(access);   // (no answer to the handshake: by port name only)
    const id = found?.text ?? null;
    const name = found?.text ? found.port : null;
    const input = [...access.inputs.values()].find((p) => (name ? p.name === name : PORT.test(p.name ?? '')) && !/ota-/i.test(p.name ?? '') && p.state !== 'disconnected');
    if (!input) throw new Error('no FM-1 found among the MIDI inputs');
    const fw = firmware ?? firmwareOf(id);
    if (!fw) throw new Error(`${input.name}${id ? ` (${id})` : ''}: which firmware does it run? Pick it in the list`);
    this.identity = id;
    this.port = input.name ?? null;
    this.profile = PROFILES[fw];
    this.input = input;
    input.addEventListener('midimessage', this.listener);
    return this.profile;
  }

  stop(): void {
    this.input?.removeEventListener('midimessage', this.listener);
    this.input = null;
    this.profile = null;
  }
}
