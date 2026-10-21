// SPDX-License-Identifier: GPL-3.0-only
// Following a connected FM-1's panel (#120): its MIDI in, whatever firmware it runs. The firmware is told by M-VAVE's
// identity handshake (flasher/fm1ota.js) or picked by hand; its profile (fm1-profiles.ts) turns each message into panel
// inputs for the page (main.ts runs them through the firmware UI's copy and the editor). A listener of its own on the
// port: the editor's Live link (device.ts) and a MIDI keyboard may use the same one.

import { Updater } from './flasher/fm1ota.js';
import { PROFILES, firmwareOf, type Firmware, type PanelInput, type Profile } from './fm1-profiles';

const PORT = /fm-?1|felucca|matryoshka|modular|sloop|baud/i;

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

  /** find the FM-1 and start following it; `firmware`: the user's choice, else what its identity says. Throws with a
   * readable message when there is no FM-1 or its firmware is not known (then it has to be picked) */
  async follow(firmware?: Firmware): Promise<Profile> {
    if (!navigator.requestMIDIAccess) throw new Error('Web MIDI is not available in this browser (use Chrome or Edge)');
    this.stop();
    const access = await navigator.requestMIDIAccess({ sysex: true });
    let id: string | null = null;
    let name: string | null = null;
    try {
      const dev = await new Updater(access).find();
      if (dev) {
        id = dev.id.text;
        name = dev.name;
        dev.link.close();
      }
    } catch { /* no answer to the handshake: by port name only */ }
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
