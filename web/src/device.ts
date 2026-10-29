// SPDX-License-Identifier: GPL-3.0-only
// The FM-1 as a Web MIDI SysEx peer: patch upload, store, live parameters (wire format: protocol.ts).
import { DEFS } from './modules';
import type { Patch } from './patch';
import type { SongEntry, StepNote } from './track';
import { encodePatch, toQ16, VERSION } from './patchbin';
import { deviceView } from './poly';

/** a module's index on the FM-1: its place in the patch's device form (poly.ts deviceView: editor-only modules such as
 * the Scope are not there, so the editor's order is not the device's); -1 when the device does not have it */
export const deviceIndex = (patch: Patch, moduleId: number): number => deviceView(patch, true).patch.modules.findIndex((m) => m.id === moduleId);
import { RIG_STRUCTURE, sandboxFrame, FEATURE_SANDBOX, type SandboxPage, devicePresetName, parsePresetData, parsePresetEntry, parsePresetStored, presetDelFrame, presetGetFrame, presetPutFrame, presetsFrame, type DevicePresetEntry, muteFrame, trackFrame, parseTrack, patternFrame, songFrame, parsePatternNow, parseSongNow, focusFrame, liveFrame, transportFrame, attFrame, bypassFrame, chunkFrames, CMD, parseSlot, rangeFrame, slotEraseFrame, slotFrame, slotInfoFrame, SLOTS, type SlotInfo, commitFrame, helloFrame, paramFrame, parse, parseAck, parseInfo, STATUS_TEXT, storeFrame, type Ack, type Info } from './protocol';

/** what connecting the FM-1 does with Live sync (#171): `sync` turns it on without asking, `ask` offers Sync / Not now,
 *  `off` leaves it off (Not now was chosen in this visit) */
export type ConnectSync = 'sync' | 'ask' | 'off';

/** the FM-1's binary holds the same patch as the editor's (encodePatch has no layout in it) */
export const sameBinary = (a: Uint8Array | null, b: Uint8Array | null): boolean => !!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * The choice on connect (#171). Not now holds for the visit; with the FM-1's current slot known to hold the editor's patch
 * (`deviceBin`, null when it cannot be read) nothing is lost, so it syncs without asking; anything else asks. A sandbox
 * patch (one that does not fit) always asks: Sync makes the FM-1 its controller (sandbox mode), and nothing is sent.
 */
export function syncOnConnect(o: { fits: boolean; declined: boolean; editorBin: Uint8Array; deviceBin: Uint8Array | null }): ConnectSync {
  if (o.declined) return 'off';
  return o.fits && sameBinary(o.editorBin, o.deviceBin) ? 'sync' : 'ask';
}

/** the FM-1 chip's state (#152, #171): a sandbox patch (over the budget) with Live on is sandbox mode, the FM-1 its
 *  controller; with Live off it is too big to sync */
export type ChipState = 'not connected' | 'synced' | 'not synced' | 'patch too big to sync' | 'sandbox controller';
export const chipState = (connected: boolean, live: boolean, fits: boolean): ChipState =>
  !connected ? 'not connected' : !fits ? (live ? 'sandbox controller' : 'patch too big to sync') : live ? 'synced' : 'not synced';
/** the editor's Live (#185, #200), what main.ts does each LIVE_MS, on Sync and on a budget change, kept pure for the tests */
export const liveSync = {
  /** edits and uploads go to the FM-1: connected, Live on and the patch within its budget */
  syncs: (connected: boolean, live: boolean, fits: boolean): boolean => connected && live && fits,
  /** the LIVE to send (every LIVE_MS, and when Live turns on): null = none (not connected, Live off); paused = the patch is over
   *  the budget, so it is not sent, but the FM-1 still holds PRESET and says EDITOR PATCH TOO BIG */
  frame: (connected: boolean, live: boolean, fits: boolean): { paused: boolean } | null =>
    connected && live ? { paused: !fits } : null,
  /** a budget change that pauses Live: say so at once (LIVE paused), not only at the next LIVE_MS */
  pausesNow: (connected: boolean, live: boolean, was: boolean, fits: boolean): boolean => was && !fits && connected && live,
  /** sandbox mode: Live paused because the patch is a sandbox patch; the editor follows the FM-1's panel and sends it its
   *  page (SANDBOX), and the FM-1 (feature bit 8) mutes itself */
  sandbox: (connected: boolean, live: boolean, fits: boolean): boolean => connected && live && !fits,
  /** the editor's PLAY (and Space) starts and stops the FM-1's transport too: Live on, in sandbox mode as well, so the FM-1's
   *  PLAY and its steps stay in step with the browser's */
  transports: (connected: boolean, live: boolean): boolean => connected && live,
  /** sandbox mode began: the transport both run from now (the FM-1's as last heard, its Start / Stop, and the editor's), so
   *  a sequence the FM-1 was playing goes on in the browser and the FM-1's steps do not run on, silent, on their own */
  sandboxRuns: (fm1Runs: boolean, editorPlays: boolean): boolean => fm1Runs || editorPlays,
};
/** a MIDI Start or Continue (true), Stop (false), or neither (null): the FM-1's PLAY as it goes out (panel.c play_toggle) */
export const transportOf = (data: ArrayLike<number> | null | undefined): boolean | null =>
  !data || data.length !== 1 ? null : data[0] === 0xfa || data[0] === 0xfb ? true : data[0] === 0xfc ? false : null;
/** Last legacy format capability bit: firmware with bit 15 reads formats 31..39. New firmware reports the range
 *  directly in INFO, so later format changes need no additional feature bits. Keep this bit for older editors. */
export const FEATURE_SYNC = 32768;
/** the FM-1 can play the editor's patches (an FM-1 not heard from yet is not held back) */
export const syncsWith = (info: Info | null): boolean => {
  if (!info) return true;
  const range = info.patchFormats ?? { min: 31, max: info.features & FEATURE_SYNC ? 39 : 0 };
  return range.min <= VERSION && VERSION <= range.max;
};
export const UPDATE_TO_SYNC = 'This FM-1 runs older Matryoshka firmware that cannot play the editor\'s patches: update it to sync.';
/** The remedy for an incompatible peer: a writer below the readable range needs a newer editor. */
export const syncUpdateNotice = (info: Info | null): { message: string; label: string; target: 'editor' | 'firmware' } =>
  info?.patchFormats && VERSION < info.patchFormats.min
    ? { message: 'This editor is older than the firmware on your FM-1. Open the current editor to sync.', label: 'Open current editor', target: 'editor' }
    : { message: UPDATE_TO_SYNC, label: 'Update the FM-1', target: 'firmware' };
/** the hover of the chip in sandbox mode */
export const SANDBOX_HOVER = 'Your patch is a sandbox patch, so the FM-1 plays it as a controller: the browser makes the sound. It syncs normally again once the patch fits.';
/**
 * The FM-1 chip in sandbox mode: its text and hover. An FM-1 that reports MENU > MIDI OUT off (INFO, feature bit 8) sends
 * nothing to follow, so the chip says how to turn it on. Firmware without sandbox mode keeps its own sound and shows
 * EDITOR PATCH TOO BIG; its panel is followed all the same.
 */
export function sandboxChip(o: { hasSandbox: boolean; midiOut: boolean | null }): { text: string; title: string; midiOff: boolean } {
  if (o.midiOut === false)
    return { text: 'FM-1 \u00b7 turn on MIDI OUT (GLO, K3) to control the sandbox', midiOff: true,
      title: `${SANDBOX_HOVER} Its MIDI OUT is off, so its keys and knobs reach nothing here: GLO, then K3, turns it on.` };
  return { text: 'FM-1 \u00b7 SANDBOX CONTROLLER', midiOff: false,
    title: o.hasSandbox ? SANDBOX_HOVER : `${SANDBOX_HOVER} Update the FM-1 to 1.3 to mute it and show the page.` };
}
/** FM-1 & MIDI's sync line (#180), what the chip shows: its text and its button (`sync` turns Live on, `stop` off; none
 *  while not connected or while the patch does not fit) */
export const syncLine = (s: ChipState): { text: string; action: 'sync' | 'stop' | null } =>
  s === 'synced' ? { text: 'Synced with the FM-1', action: 'stop' }
  : s === 'not synced' ? { text: 'Not synced', action: 'sync' }
  : s === 'sandbox controller' ? { text: 'Sandbox controller: the browser plays, the FM-1 drives it', action: 'stop' }
  : s === 'patch too big to sync' ? { text: 'Sandbox patch, not synced: Sync makes the FM-1 its controller', action: 'sync' }
  : { text: 'Not connected', action: null };

const NAME = /felucca|fm-?1|matryoshka|modular/i;
const ACK_TIMEOUT = 700;
const FLASH_TIMEOUT = 2500; // a flash sector erase and program
const TRIES = 3;

/** what the FM-1 does on its own (#65, #83): a knob or patch button as MIDI CC, the slot it plays now, a step edited or a
 * track muted on its SEQ page (`module`: the module's device index, deviceIndex) */
export type DeviceEvent =
  | { kind: 'cc'; n: number; v: number }
  | { kind: 'slot'; slot: number; name: string }
  | { kind: 'track'; module: number; notes: StepNote[]; pat: number }
  /** the patch's pattern / song chosen on the FM-1 (PATTERN_NOW, format 48), a song edited there (SONG_NOW) */
  | { kind: 'pattern'; pattern: number; song: number }
  | { kind: 'song'; song: number; entries: SongEntry[] }
  | { kind: 'mute'; module: number; on: boolean }
  | { kind: 'param'; module: number; param: number; value: number }
  | { kind: 'focus'; device: number; page: number }
  /** a preset stored on the FM-1 (#195, ENV held + SAVE) */
  | { kind: 'presetStored'; structure: string; name: string }
  /** an INFO nobody asked for: MENU > MIDI OUT changed under Live (feature bit 8; `info` has it) */
  | { kind: 'info' };

export class DeviceLink {
  private out: MIDIOutput | null = null;
  private inp: MIDIInput | null = null;
  private waiter: { match: (p: ReturnType<typeof parse>) => boolean; done: (p: NonNullable<ReturnType<typeof parse>>) => void } | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private paramQueue = new Map<string, [number, number, number]>();
  private paramTimer = 0;
  info: Info | null = null;
  /** the FM-1's transport runs, as its last Start / Stop said or the editor last set it (transport) */
  running = false;
  /** PRESETS's answers, one frame each, while listPresets waits for them */
  private collecting: ((e: DevicePresetEntry) => void) | null = null;
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
    this.running = false;
    this.inp.onmidimessage = (ev) => {
      const run = transportOf(ev.data);
      if (run !== null) {
        this.running = run;
        return;
      }
      if (ev.data && ev.data.length === 3 && (ev.data[0] & 0xf0) === 0xb0) return this.onEvent({ kind: 'cc', n: ev.data[1], v: ev.data[2] });
      const p = ev.data ? parse(ev.data) : null;
      if (p?.cmd === CMD.slotNow && p.payload.length >= 1) {
        const name = String.fromCharCode(...p.payload.slice(1, 21).filter((c) => c)).trim();
        return this.onEvent({ kind: 'slot', slot: p.payload[0], name });
      }
      const t = p?.cmd === CMD.trackNow ? parseTrack(p.payload) : null;
      if (t) return this.onEvent({ kind: 'track', ...t });
      const pn = p?.cmd === CMD.patternNow ? parsePatternNow(p.payload) : null;
      if (pn) return this.onEvent({ kind: 'pattern', ...pn });
      const sn = p?.cmd === CMD.songNow ? parseSongNow(p.payload) : null;
      if (sn) return this.onEvent({ kind: 'song', ...sn });
      if (p?.cmd === CMD.muteNow && p.payload.length >= 2) return this.onEvent({ kind: 'mute', module: p.payload[0], on: !!p.payload[1] });
      if (p?.cmd === CMD.paramNow && p.payload.length >= 6) {
        const v = new DataView(Uint8Array.from(p.payload.slice(2, 6)).buffer).getInt32(0, true) / 65536;
        return this.onEvent({ kind: 'param', module: p.payload[0], param: p.payload[1], value: v });
      }
      if (p?.cmd === CMD.focusNow && p.payload.length >= 2) return this.onEvent({ kind: 'focus', device: p.payload[0], page: p.payload[1] });
      const stored = p ? parsePresetStored(p) : null;
      if (stored) return this.onEvent({ kind: 'presetStored', ...stored });
      const entry = p && this.collecting ? parsePresetEntry(p) : null;
      if (entry && this.collecting) return this.collecting(entry);
      if (p && this.waiter?.match(p)) {
        const w = this.waiter;
        this.waiter = null;
        w.done(p);
        return;
      }
      const info = p?.cmd === CMD.info ? parseInfo(p) : null;
      if (info) {   // unasked (sandbox mode's MIDI OUT flag)
        this.info = info;
        this.onEvent({ kind: 'info' });
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
    this.running = run;
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

  /** the firmware keeps presets (#195, INFO feature bit 7) */
  get hasPresets(): boolean {
    return !!(this.info && this.info.features & 128);
  }

  /** the FM-1's user presets (name, structure, how many values) */
  listPresets(): Promise<DevicePresetEntry[]> {
    return this.serial(() => new Promise<DevicePresetEntry[]>((resolve, reject) => {
      const got: DevicePresetEntry[] = [];
      const t = window.setTimeout(() => { this.collecting = null; reject(new Error('no answer from the FM-1')); }, ACK_TIMEOUT * TRIES);
      this.collecting = (e) => {
        if (e.count) got[e.index] = e;
        if (!e.count || got.filter(Boolean).length >= e.count) {
          clearTimeout(t);
          this.collecting = null;
          resolve(got.filter((e) => e && e.structure !== RIG_STRUCTURE));   // (the test rig's mark, #291: not a preset)
        }
      };
      this.out!.send(presetsFrame());
    }));
  }

  /** one of the FM-1's presets' values (real numbers, canonical row order); null: it has none of that name */
  getPreset(structure: string, name: string): Promise<number[] | null> {
    return this.serial(async () => {
      const key = devicePresetName(name);
      const p = await this.request(presetGetFrame(structure, name), (x) => !!x && x.cmd === CMD.presetData && parsePresetData(x)?.name === key);
      return parsePresetData(p)?.values ?? null;
    });
  }

  putPreset(structure: string, name: string, values: number[]): Promise<void> {
    return this.serial(async () => { await this.ackFor(presetPutFrame(structure, name, values), CMD.presetPut, undefined, FLASH_TIMEOUT); });
  }

  deletePreset(structure: string, name: string): Promise<void> {
    return this.serial(async () => { await this.ackFor(presetDelFrame(structure, name), CMD.presetDel, undefined, FLASH_TIMEOUT); });
  }

  /** the firmware takes MUTE (INFO feature bit 2) */
  get hasSteps(): boolean {
    return !!(this.info && this.info.features & 4);
  }

  /** the firmware takes TRACK (INFO feature bit 5, patch format 31) */
  get hasTracks(): boolean {
    return !!(this.info && this.info.features & 32);
  }

  /** the firmware reads format 48: patterns and songs (TRACK with a pattern, PATTERN, SONG) */
  get hasPatterns(): boolean {
    return (this.info?.patchFormats?.max ?? 0) >= 48;
  }

  /** a Steps module's notes, all of them (#133), of pattern `pat` (0-based; format 48) */
  track(patch: Patch, moduleId: number, notes: readonly StepNote[] | undefined, pat = 0): void {
    if (!this.connected || !this.hasTracks) return;
    const mi = deviceIndex(patch, moduleId);
    if (mi >= 0 && this.hasPatterns) this.out!.send(trackFrame(mi, notes, pat));
    else if (mi >= 0 && !pat) this.out!.send(trackFrame(mi, notes));
  }

  /** the patch's pattern and the song playing (format 48) */
  pattern(pattern: number, song: number): void {
    if (this.connected && this.hasPatterns) this.out!.send(patternFrame(pattern, song));
  }

  /** a song's entries (format 48) */
  song(s: number, entries: readonly SongEntry[]): void {
    if (this.connected && this.hasPatterns) this.out!.send(songFrame(s, entries));
  }

  /** a Steps module muted / unmuted (not part of the patch) */
  mute(patch: Patch, moduleId: number, on: boolean): void {
    if (!this.connected || !this.hasSteps) return;
    const mi = deviceIndex(patch, moduleId);
    if (mi >= 0) this.out!.send(muteFrame(mi, on));
  }

  /** the firmware takes FOCUS and reports its knobs and pages (INFO feature bit 4) */
  get hasPages(): boolean {
    return !!(this.info && this.info.features & 16);
  }

  /** the firmware takes LIVE (INFO feature bit 6): PRESET and program change wait while the editor drives it */
  get hasLive(): boolean {
    return !!(this.info && this.info.features & 64);
  }

  /** the editor's Live is on (sent every LIVE_MS); paused: its patch is over the FM-1's budget, not sent (#200) */
  live(paused = false): void {
    if (!this.connected || !this.hasLive) return;
    this.out!.send(liveFrame(paused));
  }

  /** the firmware has sandbox mode (INFO feature bit 8): LIVE paused mutes it, and it draws SANDBOX pages */
  get hasSandbox(): boolean {
    return !!(this.info && this.info.features & FEATURE_SANDBOX);
  }

  /** the editor's page in sandbox mode (the caller sends it when it changed) */
  sandboxPage(pg: SandboxPage): void {
    if (!this.connected || !this.hasSandbox) return;
    this.out!.send(sandboxFrame(pg));
  }

  /** show a device page on the FM-1 (indices into the binary's device pages section) */
  focus(device: number, page: number): void {
    if (!this.connected || !this.hasPages || device < 0) return;
    this.out!.send(focusFrame(device, page));
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
