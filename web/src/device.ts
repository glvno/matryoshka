// SPDX-License-Identifier: GPL-3.0-only
// The FM-1 as a Web MIDI SysEx peer: patch upload, store, live parameters (wire format: protocol.ts).
import { DEFS } from './modules';
import type { Patch } from './patch';
import { encodePatch, toQ16 } from './patchbin';
import { deviceView } from './poly';

/** a module's index on the FM-1: its place in the patch's device form (poly.ts deviceView: editor-only modules such as
 * the Scope are not there, so the editor's order is not the device's); -1 when the device does not have it */
export const deviceIndex = (patch: Patch, moduleId: number): number => deviceView(patch).patch.modules.findIndex((m) => m.id === moduleId);
import { muteFrame, stepFrame, transportFrame, attFrame, bypassFrame, chunkFrames, CMD, parseSlot, rangeFrame, slotEraseFrame, slotFrame, slotInfoFrame, SLOTS, type SlotInfo, commitFrame, helloFrame, paramFrame, parse, parseAck, parseInfo, STATUS_TEXT, storeFrame, type Ack, type Info } from './protocol';

const NAME = /felucca|fm-?1|modular/i;
const ACK_TIMEOUT = 700;
const FLASH_TIMEOUT = 2500; // a flash sector erase and program
const TRIES = 3;

/** what the FM-1 does on its own (#65, #83): a knob or patch button as MIDI CC, the slot it plays now, a step edited or a
 * track muted on its SEQ page (`module`: the module's device index, deviceIndex) */
export type DeviceEvent =
  | { kind: 'cc'; n: number; v: number }
  | { kind: 'slot'; slot: number; name: string }
  | { kind: 'step'; module: number; step: number; b: number }
  | { kind: 'mute'; module: number; on: boolean };

export class DeviceLink {
  private out: MIDIOutput | null = null;
  private inp: MIDIInput | null = null;
  private waiter: { match: (p: ReturnType<typeof parse>) => boolean; done: (p: NonNullable<ReturnType<typeof parse>>) => void } | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private paramQueue = new Map<string, [number, number, number]>();
  private paramTimer = 0;
  info: Info | null = null;
  onStatus: (s: string) => void = () => {};
  /** what the FM-1 does on its own (#65): a knob or patch button as MIDI CC, the slot it plays now */
  onEvent: (e: DeviceEvent) => void = () => {};

  get connected(): boolean {
    return !!this.out && this.out.state === 'connected';
  }

  async connect(): Promise<Info> {
    if (!navigator.requestMIDIAccess) throw new Error('Web MIDI is not available in this browser (use Chrome or Edge)');
    if (this.inp) this.inp.onmidimessage = null; // a reconnect: let go of the old port
    const access = await navigator.requestMIDIAccess({ sysex: true });
    const pick = <T extends MIDIPort>(ports: Iterable<T>): T | null => [...ports].find((p) => NAME.test(p.name ?? '') && !/ota-/i.test(p.name ?? '')) ?? null;
    this.out = pick(access.outputs.values());
    this.inp = pick(access.inputs.values());
    if (!this.out || !this.inp) throw new Error('FM-1 not found. Is it connected and running the Matryoshka firmware?');
    this.inp.onmidimessage = (ev) => {
      if (ev.data && ev.data.length === 3 && (ev.data[0] & 0xf0) === 0xb0) return this.onEvent({ kind: 'cc', n: ev.data[1], v: ev.data[2] });
      const p = ev.data ? parse(ev.data) : null;
      if (p?.cmd === CMD.slotNow && p.payload.length >= 1) {
        const name = String.fromCharCode(...p.payload.slice(1, 21).filter((c) => c)).trim();
        return this.onEvent({ kind: 'slot', slot: p.payload[0], name });
      }
      if (p?.cmd === CMD.stepNow && p.payload.length >= 3) return this.onEvent({ kind: 'step', module: p.payload[0], step: p.payload[1], b: p.payload[2] });
      if (p?.cmd === CMD.muteNow && p.payload.length >= 2) return this.onEvent({ kind: 'mute', module: p.payload[0], on: !!p.payload[1] });
      if (p && this.waiter?.match(p)) {
        const w = this.waiter;
        this.waiter = null;
        w.done(p);
      }
    };
    access.onstatechange = () => {
      if (this.out?.state !== 'connected') this.onStatus('FM-1 disconnected');
    };
    return this.hello();
  }

  private request(frame: Uint8Array, match: (p: ReturnType<typeof parse>) => boolean, timeout = ACK_TIMEOUT): Promise<NonNullable<ReturnType<typeof parse>>> {
    return new Promise((resolve, reject) => {
      let tries = 0;
      const attempt = (): void => {
        tries++;
        const t = window.setTimeout(() => {
          this.waiter = null;
          if (tries < TRIES) attempt();
          else reject(new Error('no answer from the FM-1'));
        }, timeout);
        this.waiter = {
          match,
          done: (p) => {
            clearTimeout(t);
            resolve(p);
          },
        };
        this.out!.send(frame);
      };
      attempt();
    });
  }

  async hello(): Promise<Info> {
    const p = await this.request(helloFrame(), (x) => x?.cmd === CMD.info);
    this.info = parseInfo(p);
    if (!this.info) throw new Error('unexpected answer to HELLO');
    return this.info;
  }

  private async ackFor(frame: Uint8Array, cmd: number, seq?: number, timeout = ACK_TIMEOUT): Promise<Ack> {
    const p = await this.request(frame, (x) => x?.cmd === CMD.ack && x.payload[0] === cmd && (seq === undefined || x.payload[1] === seq), timeout);
    const a = parseAck(p)!;
    if (a.status) throw new Error(`FM-1: ${STATUS_TEXT[a.status] ?? `error ${a.status}`}${a.aux ? ` (${a.aux})` : ''}`);
    return a;
  }

  /** Upload and switch to the patch. Calls are serialised. */
  upload(patch: Patch): Promise<void> {
    const run = async (): Promise<void> => {
      const bin = encodePatch(patch);
      await this.sendChunks(bin);
      await this.ackFor(commitFrame(bin), CMD.commit);
    };
    return this.serial(run);
  }

  /** the firmware takes the TRANSPORT command (INFO feature bit 1) */
  get hasTransport(): boolean {
    return !!(this.info && this.info.features & 2);
  }

  /** the transport (PLAY) */
  transport(run: boolean): void {
    if (!this.connected || !this.hasTransport) return;
    this.out!.send(transportFrame(run));
  }

  private async sendChunks(bin: Uint8Array): Promise<void> {
    const frames = chunkFrames(bin);
    for (let i = 0; i < frames.length; i++) await this.ackFor(frames[i], CMD.chunk, i & 0x7f);
  }

  /** Put a patch into patch slot 0..31 of the FM-1's bank (flash); it is not loaded. */
  uploadSlot(slot: number, name: string, patch: Patch): Promise<void> {
    return this.serial(async () => {
      const bin = encodePatch(patch);
      await this.sendChunks(bin);
      await this.ackFor(slotFrame(slot, name, bin), CMD.slot, slot, FLASH_TIMEOUT);
    });
  }

  eraseSlot(slot: number): Promise<void> {
    return this.serial(async () => {
      await this.ackFor(slotEraseFrame(slot), CMD.slotErase, slot, FLASH_TIMEOUT);
    });
  }

  readSlot(slot: number): Promise<SlotInfo> {
    return this.serial(async () => {
      const p = await this.request(slotInfoFrame(slot), (x) => x?.cmd === CMD.slotReply && x.payload[0] === slot);
      const s = parseSlot(p);
      if (!s) throw new Error('unexpected answer to SLOT_INFO');
      return s;
    });
  }

  /** all 64 slots of the bank */
  async readBank(): Promise<SlotInfo[]> {
    const out: SlotInfo[] = [];
    for (let s = 0; s < SLOTS; s++) out.push(await this.readSlot(s));
    return out;
  }

  store(): Promise<void> {
    return this.serial(async () => {
      await this.ackFor(storeFrame(), CMD.store);
    });
  }

  private backlog = 0;

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    if (this.backlog > 40) return Promise.reject(new Error('too many requests waiting for the FM-1: is it answering?'));
    this.backlog++;
    const next = this.chain.then(fn, fn).finally(() => this.backlog--);
    this.chain = next.catch(() => {});
    return next;
  }

  /** A live parameter change; the latest value per parameter is sent every 25 ms. */
  param(patch: Patch, moduleId: number, name: string, value: number): void {
    if (!this.connected) return;
    const mi = deviceIndex(patch, moduleId);
    if (mi < 0) return;
    const pi = DEFS[patch.modules.find((m) => m.id === moduleId)!.type].params.findIndex((p) => p.name === name);
    if (pi < 0) return;
    this.paramQueue.set(`${mi}.${pi}`, [mi, pi, toQ16(value)]);
    if (!this.paramTimer)
      this.paramTimer = window.setTimeout(() => {
        this.paramTimer = 0;
        const q = [...this.paramQueue.values()];
        this.paramQueue.clear();
        for (const [m, p, v] of q) this.out?.send(paramFrame(m, p, v));
      }, 25);
  }

  /** a live attenuverter change (input 0 = p1, 1 = p2) */
  att(patch: Patch, moduleId: number, index: number, value: number): void {
    if (!this.connected) return;
    const mi = deviceIndex(patch, moduleId);
    if (mi >= 0) this.out!.send(attFrame(mi, index, toQ16(value)));
  }

  /** a macro range of p1 / p2 (index 0 / 1) on a parameter, or its removal */
  range(patch: Patch, moduleId: number, index: number, name: string, range: [number, number] | null): void {
    if (!this.connected) return;
    const mi = deviceIndex(patch, moduleId);
    if (mi < 0) return;
    const pi = DEFS[patch.modules.find((m) => m.id === moduleId)!.type].params.findIndex((q) => q.name === name);
    if (pi >= 0) this.out!.send(rangeFrame(mi, index, pi, range));
  }

  /** the firmware takes STEP and MUTE (INFO feature bit 2) */
  get hasSteps(): boolean {
    return !!(this.info && this.info.features & 4);
  }

  /** a step of a Steps module (its byte, patch.ts stepByte) */
  step(patch: Patch, moduleId: number, k: number, b: number): void {
    if (!this.connected || !this.hasSteps) return;
    const mi = deviceIndex(patch, moduleId);
    if (mi >= 0) this.out!.send(stepFrame(mi, k, b));
  }

  /** a Steps module muted / unmuted (not part of the patch) */
  mute(patch: Patch, moduleId: number, on: boolean): void {
    if (!this.connected || !this.hasSteps) return;
    const mi = deviceIndex(patch, moduleId);
    if (mi >= 0) this.out!.send(muteFrame(mi, on));
  }

  /** a module's bypass switch */
  bypass(patch: Patch, moduleId: number, on: boolean): void {
    if (!this.connected) return;
    const mi = deviceIndex(patch, moduleId);
    if (mi >= 0) this.out!.send(bypassFrame(mi, on));
  }

  note(msg: { t: string; note?: number; vel?: number }): void {
    if (!this.connected) return;
    if (msg.t === 'on') this.out!.send([0x90, msg.note! & 0x7f, Math.max(1, Math.round((msg.vel ?? 1) * 127))]);
    else if (msg.t === 'off') this.out!.send([0x80, msg.note! & 0x7f, 0]);
    else if (msg.t === 'panic') this.out!.send([0xb0, 123, 0]);
  }

  /** pitch bend, -1..1 (the firmware bends ±2 semitones) */
  bend(v: number): void {
    if (!this.connected) return;
    const x = Math.max(0, Math.min(16383, Math.round(8192 + v * 8192)));
    this.out!.send([0xe0, x & 0x7f, x >> 7]);
  }

  /** a control change, value 0..127 (CC 1 = mod wheel) */
  cc(n: number, v: number): void {
    if (!this.connected) return;
    this.out!.send([0xb0, n & 0x7f, Math.max(0, Math.min(127, Math.round(v)))]);
  }
}
