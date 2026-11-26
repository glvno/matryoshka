// SPDX-License-Identifier: GPL-3.0-only
import { bufferAllocation, type BufferAllocation } from './signal-buffers';
import { FEATURE_PATTERN_ORIGINS, PatternOrigins, type OriginUpdate } from './pattern-origin';
// The FM-1 as a Web MIDI SysEx peer: patch upload, store, live parameters (wire format: protocol.ts).
import { DEFS } from './modules';
import type { Patch, Range } from './patch';
import { patternName, READ_ONLY_ID, type SongEntry, type StepNote } from './track';
import { DEVICE, deviceSection, encodePatch, FLAG_LINKS, FLAG_PATTERN_ORIGINS, FLAG_RACK, FORMAT_1_27, FORMAT_RACK, layout, mapRecord, patternOneSpills, toQ16, VERSION, type BudgetStore, type LinkStore } from './patchbin';
import { FNV0, fnv, PAYLOAD_MAX, storePlan, withLinks } from './pattern-store';
import { deviceView } from './poly';
import type { HostMsg } from './worklet';

/** a module's index on the FM-1: its place in the patch's device form (poly.ts deviceView: editor-only modules such as
 * the Scope are not there, so the editor's order is not the device's); -1 when the device does not have it */
export const deviceIndex = (patch: Patch, moduleId: number): number => deviceView(patch, true).patch.modules.findIndex((m) => m.id === moduleId);
/** The module indices and poly groups installed on the FM-1. A value edit can change these through compilation. */
export function deviceLayoutKey(patch: Patch): string {
  const view = deviceView(patch, true);
  return JSON.stringify([view.patch.modules.map((m) => [m.id, m.type]), view.groups.map((g) => [g.key, [...g.modules], g.src])]);
}
import { FEATURE_DEVICE_SETTINGS, deviceSettingsFrame, parseDeviceSettings, type DeviceSettings, FEATURE_MASTER_EQ, MASTER_EQ, masterEqFrame, parseMasterEq, type MasterEq, armsFrame, parseArmsNow, FEATURE_WIDE_ARMS, editorSkips, FEATURE_ARMS, FEATURE_LONG_PRESETS, FEATURE_PANEL_REPORT, parseKeysNow, parseGuideNow, type KeysNow, type PanelState, PRESET_VALUES_MAX, PRESET_VALUES_OLD, FEATURE_TEMPO, parseTempoNow, tempoFrame, RIG_STRUCTURE, sandboxFrame, FEATURE_SANDBOX, type SandboxPage, devicePresetName, parsePresetData, parsePresetEntry, parsePresetStored, presetDelFrame, presetGetFrame, presetPutFrame, presetsFrame, type DevicePresetEntry, muteFrame, trackFrames, parseTrack, parseLocksNow, type RawLock, patternFrame, songFrame, parsePatternNow, parseSongNow, focusFrame, liveFrame, transportFrame, attFrame, bypassFrame, chunkFrames, CMD, parseSlot, rangeFrame, slotEraseFrame, slotFrame, slotInfoFrame, slotCount, type SlotInfo, commitFrame, helloFrame, paramFrame, parse, parseAck, parseInfo, STATUS_TEXT, storeFrame, type Ack, type Info } from './protocol';
import { FEATURE_PATTERN_STORE, FEATURE25_PATTERNS_STORED, FEATURE25_TRACK_CARD, parseLinkNow, parsePatEntry, parsePatStored, PAT_FULL, PAT_MISSING, PAT_OK, PAT_RANGE, PAT_STATUS, PAT_USED, patDelFrame, patPutFrames, patsFrame, readStoredPattern, type PatListItem, type StoredPatternEntry } from './protocol';
import { holdsTrackCard } from './pages';
import './device-shown';   // (what the FM-1 shows, for the device compile pass)
import { FEATURE5_FORMAT_67, FEATURE5_FX_DRAWERS, FEATURE_FACTORY, FEATURE_FX_PRESETS, FEATURE_MAP, MAP_CMD, mapFrame, parseMapNow, type FactoryInfo, type MapEntry } from './protocol';
import { FEATURE_PADS, PADS_CMD, padsClearAllFrame, padsOnFrame, padsReadFrame, padsSetFrame, parsePadsNow, parsePatternOp, PATTERN_OP, type PadMap } from './protocol';
import { hasPaletteFeature, PAL_STATUS, PALETTE, paletteEntryGetFrame, paletteGetFrame, paletteGoFrame, paletteNameFrame, paletteOrderFrame, palettePutFrame, parsePaletteEntry, parsePaletteNow, type PaletteEntry, type PaletteNow } from './protocol';
import { FEATURE25_SLOT_GET, readSlotBinary, SLOT_STORED } from './protocol';
import { factoryInfo, installFactory } from './factory-content';
import { installFont } from './font-content';
import { drawerPresetInfo, fxPresetInfo } from './fx-preset-format';
import { autoPick, fm1Label, NOT_CHOSEN, readFm1Id, rememberedFm1, rememberFm1, suggested, type Fm1Choice, type Fm1Id } from './fm1-choice';

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
/** the FM-1 a patch goes to (its pattern store as `store`) has every factory entry the patch links (#923): firmware
 *  without them, or an FM-1 without a store, would need the patterns inline, more than a patch holds, so the editor
 *  refuses with UPDATE_TO_SYNC instead */
export function holdsFactoryLinks(patch: Patch, store: LinkStore): boolean {
  const links = Object.values(patch.modules.find((m) => m.type === 'fm1')?.seq?.links ?? {}).filter((l) => l.id >= READ_ONLY_ID);
  return store === 'assume' || links.every((l) => typeof store === 'object' && store.get(l.id) === l.hash);
}
/** the FM-1 plays this patch's devices as the editor shows them: a card that holds its own Steps track (the 808 and 909
 *  Kits, D-1062) needs firmware with INFO byte 25 bit 0, else its P-lock pages and environment row miss the track, so the
 *  editor refuses with UPDATE_FOR_TRACK_CARD; every other patch goes to any firmware it syncs with */
export const takesTrackCards = (info: Info | null, patch: Patch): boolean =>
  !!info && (info.features25 & FEATURE25_TRACK_CARD) !== 0 || !holdsTrackCard(patch, DEFS);
export const UPDATE_FOR_TRACK_CARD = 'This patch has a card that holds its own sequencer track (as the 808 and 909 Kits do), which this FM-1\'s firmware does not show as the track: update the FM-1 to send it.';
/** what a send to the FM-1 did (DeviceLink.upload, uploadSlot): the binary it sent, and the patterns (0-based) that went
 *  inside it because the pattern store of an FM-1 that stores every pattern had no room for them (#1202) */
export interface Sent { bin: Uint8Array; inline: number[] }
/** what the editor says when the FM-1's pattern store had no room for some patterns of patch `name` (Sent.inline) */
export const storeFullText = (name: string, inline: readonly number[]): string =>
  `The FM-1's pattern store has no room for ${inline.map((p) => patternName(p)).join(', ')} of "${name}": ${inline.length === 1 ? 'it goes' : 'they go'} inside the patch.`;
/** a patch the FM-1 cannot take as it is (a send refused before anything of it was written to a slot): a bank send goes on
 *  with the next patch */
export class PatchRefused extends Error {}
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
/** an update loader's port (FM-1_700's "Felucca Update", M-VAVE's ota-...): it never answers HELLO */
const LOADER = /ota-|felucca update/i;

/** one input and one output that may be the FM-1; `named`: its name says FM-1 */
export interface LinkCandidate { inp: MIDIInput; out: MIDIOutput; named: boolean }

/**
 * The in / out pairs Connect FM-1 says HELLO to, in order (#187). An input and an output of one USB MIDI device share
 * its name, so ports pair by name. The pairs named like an FM-1 (Matryoshka, Felucca, FM-1...) come first. Every other
 * pair follows, because macOS keeps the name it first saw for a USB id at a USB socket: an FM-1 that ran Felucca, or
 * another device with the same test id 1209:0001, shows under that old name, and so does a device renamed in Audio MIDI
 * Setup. HELLO is a SysEx frame under the non-commercial id 7D, which other gear ignores. Left out: disconnected ports,
 * an update loader, and Apple's own ports (the IAC bus, network sessions: a DAW could record what goes there). With no
 * same-named pair, an FM-1-named input and output pair as before.
 */
export function linkCandidates(inputs: Iterable<MIDIInput>, outputs: Iterable<MIDIOutput>): LinkCandidate[] {
  const live = <T extends MIDIPort>(ps: Iterable<T>): T[] => [...ps].filter((p) => p.state !== 'disconnected' && !LOADER.test(p.name ?? ''));
  const ins = live(inputs), outs = live(outputs);
  const pairs: LinkCandidate[] = [];
  for (const inp of ins) {
    const named = NAME.test(inp.name ?? '');
    if (!named && /^apple/i.test(inp.manufacturer ?? '')) continue;
    const out = outs.find((o) => (o.name ?? '') === (inp.name ?? '') && !pairs.some((p) => p.out === o));
    if (out) pairs.push({ inp, out, named });
  }
  if (!pairs.some((p) => p.named)) {
    const inp = ins.find((p) => NAME.test(p.name ?? '')), out = outs.find((p) => NAME.test(p.name ?? ''));
    if (inp && out) pairs.push({ inp, out, named: true });
  }
  return [...pairs.filter((p) => p.named), ...pairs.filter((p) => !p.named)];
}

/** Connect FM-1's message when no port answered HELLO (`tried`: some pair was asked), with the ports it saw, so the user
 *  can tell what the computer calls the FM-1 */
export function notFound(inputs: Iterable<MIDIPort>, outputs: Iterable<MIDIPort>, tried: boolean): string {
  const names = [...new Set([...inputs, ...outputs].filter((p) => p.state !== 'disconnected').map((p) => p.name || '(no name)'))];
  const seen = names.length ? `MIDI ports: ${names.join(', ')}` : 'the browser sees no MIDI ports';
  return tried
    ? `No FM-1 answered as Matryoshka (${seen}). Is it running the Matryoshka firmware? Just after an install, wait until it shows its pages, then connect again`
    : `FM-1 not found (${seen}). Is it connected by USB and switched on?`;
}

/** Connect FM-1's message when every FM-1 that answered is set to ignore the editor (GLO > SYSTEM > EDITOR at IGNORE,
 *  #702): never a silent "no FM-1 found", and how to undo it */
export function ignoredFound(n: number): string {
  return `${n === 1 ? 'An FM-1 is' : `${n} FM-1s are`} set to ignore the editor, so it leaves ${n === 1 ? 'it' : 'them'} alone: on ${n === 1 ? 'it' : 'one'}, GLO \u203a SYSTEM \u203a EDITOR to ALLOW, then connect again`;
}
/** the FM-1 the editor is linked to was set to ignore the editor (an INFO nobody asked for, #702): the editor lets go */
export const IGNORED_NOW = 'The FM-1 was set to ignore the editor, so the editor let go of it: on it, GLO \u203a SYSTEM \u203a EDITOR to ALLOW, then connect again';

/** Connect FM-1's message when the browser would not open Web MIDI with SysEx */
export function sysexRefused(e: unknown): string {
  const name = (e as { name?: string } | null)?.name;
  return name === 'NotAllowedError' || name === 'SecurityError'
    ? 'This browser blocks SysEx for this site, and the FM-1 link needs it: allow MIDI devices in the site settings (the icon left of the address), reload the page and connect again'
    : `Web MIDI did not open: ${(e as Error | null)?.message ?? String(e)}`;
}
const ACK_TIMEOUT = 700;
const FLASH_TIMEOUT = 2500; // a flash sector erase and program
const TRIES = 3;

/** what the FM-1 does on its own (#65, #83): a knob or patch button as MIDI CC, the slot it plays now, a step edited or a
 * track muted on its SEQ page (`module`: the module's device index, deviceIndex) */
export type DeviceEvent =
  | { kind: 'origins'; update: OriginUpdate }
  | { kind: 'cc'; n: number; v: number }
  | { kind: 'slot'; slot: number; name: string }
  | { kind: 'track'; module: number; notes: StepNote[]; pat: number }
  /** a track's P-locks of pattern `pat` after an edit on the SEQ page (LOCKS_NOW, #524; device-form indices) */
  | { kind: 'locks'; module: number; pat: number; locks: RawLock[] }
  /** the patch's pattern / song chosen on the FM-1 (PATTERN_NOW, format 48), a song edited there (SONG_NOW) */
  | { kind: 'pattern'; pattern: number; song: number }
  | { kind: 'song'; song: number; entries: SongEntry[] }
  | { kind: 'mute'; module: number; on: boolean }
  /** the armed set after it changed on the FM-1 (ARMS_NOW, #191): a mask over the module indices of the patch it plays,
   *  ARM_WORDS words (#721) */
  | { kind: 'arms'; words: number[] }
  | { kind: 'param'; module: number; param: number; value: number }
  | { kind: 'focus'; device: number; page: number }
  /** a preset stored on the FM-1 (#195, ENV held + SAVE) */
  | { kind: 'presetStored'; structure: string; name: string }
  /** an INFO nobody asked for: MENU > MIDI OUT changed under Live (feature bit 8; `info` has it) */
  | { kind: 'info' }
  /** GLO > PANEL > TEMPO, the global tempo and TIME SIG as the FM-1 has them (TEMPO_NOW, D-907, #1011): after HELLO, and
   *  when they change there; bpm 0: not known yet; meter (a METERS index) only from firmware that has it */
  | { kind: 'tempo'; global: boolean; bpm: number; meter?: number }
  /** a key edge the FM-1's panel took (KEYS_NOW, #549, feature bit 18) */
  | ({ kind: 'keys' } & KeysNow)
  /** the FM-1's panel state (GUIDE_NOW, #549, #554, feature bit 18): after HELLO and whenever it changed */
  | { kind: 'guide'; state: PanelState }
  /** the running patch's link of pattern `pattern` changed on the FM-1 (PAT_LINK_NOW, #901): the stored id (0 none) and its
   *  payload hash */
  | { kind: 'link'; pattern: number; id: number; hash: number }
  /** the FM-1's SEQ page ran a pattern command (PATTERN_OP, #1177, #1178): op 1 pattern `from` copied to `to`, op 2
   *  everything cleared, op 4 pattern `from` doubled, op 5 halved; the editor runs it on its patch too */
  | { kind: 'patternOp'; op: number; from: number; to: number; hash: number }
  /** the running patch's MIDI learn mappings after a learn or a clear on the FM-1 (MAP_NOW, #1067; device-form indices),
   *  with the "also sent" warning of a learn there (null none) */
  | { kind: 'maps'; maps: MapEntry[]; also: { src: number; ccs: number[] } | null }
  /** the global pad map as the FM-1 has it (PADS_NOW, feature bit 29): the answer to every PADS (connect reads it), and
   *  after a change on the FM-1 (a learn, a clear, PAD MAP turned) */
  | ({ kind: 'pads' } & PadMap)
  /** the FM-1's palette (PALETTE_NOW, #1196, feature bit 31): the answer to GET, and unasked after every change there
   *  once the editor sent GET (a switch queued or done, a hold-save, PUT / ORDER, a slot gone MISSING) */
  | { kind: 'palette'; now: PaletteNow }
  /** a PALETTE_ENTRY nobody waited for (the answer to an ENTRY_GET that timed out) */
  | { kind: 'paletteEntry'; pos: number; entry: PaletteEntry | null };

/** what the editor says when older firmware cannot store a preset whole (more than 88 values, D-476) */
export const PRESET_NEEDS_UPDATE = 'Update the FM-1 to store this preset on it';

export class DeviceLink {
  private origins = new PatternOrigins();
  invalidateOrigins(): void { this.origins.suspend(); }
  reconcileOrigins(): void {
    const records = this.origins.snapshot();
    this.onEvent({ kind: 'origins', update: records ? { kind: 'snapshot', records } : { kind: 'reset' } });
  }

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
  /** PATS's answers, one frame each, while listPatterns waits for them */
  private collectingPatterns: ((e: PatListItem) => void) | null = null;
  /** what the FM-1's pattern store holds (#901): each user entry's payload hash by id, as listPatterns last read it and the
   *  link's own changes since; null: not read since it connected */
  private stored: Map<number, number> | null = null;
  /** the last TRACK_NOW: what a frame with TRACK_MORE adds to (#1292) */
  private trackPart: { module: number; pat: number; notes: StepNote[] } | null = null;
  /** the payload lengths of the entries `stored` holds, where known (a link the FM-1 reports gives none) */
  private storedLen = new Map<number, number>();
  onStatus: (s: string) => void = () => {};
  /** what the FM-1 does on its own (#65): a knob or patch button as MIDI CC, the slot it plays now */
  onEvent: (e: DeviceEvent) => void = () => {};

  get connected(): boolean {
    return !!this.out && !!this.inp && this.out.state === 'connected' && this.inp.state === 'connected';
  }

  /** Capability belongs to this connection; unknown/absent/disconnected is conservative. */
  get bufferAllocation(): BufferAllocation { return this.connected ? bufferAllocation(this.info?.bufferAllocation) : 0; }

  /** the MIDI input the link listens on (the panel follower listens there too, whatever the port is named) */
  get input(): MIDIInput | null {
    return this.inp;
  }
  /** the MIDI output the link sends on */
  get output(): MIDIOutput | null {
    return this.out;
  }

  /** the FM-1 linked now, told apart from any other (D-965): its name, serial, the rig's mark, how many FM-1s answered;
   *  null while not connected */
  identity: Fm1Id | null = null;
  /** asks the user which FM-1 to link when several answered and none is remembered (main.ts's chooser): the index chosen,
   *  or null for none. Without it Connect links none of them. `first`: the one to offer first */
  choose: ((found: Fm1Id[], first: number) => Promise<number | null>) | null = null;

  /** the FM-1 the user chose, for the Install panel (D-965): the linked one, else the one remembered in this browser */
  get choice(): Fm1Choice | null {
    if (this.connected && this.identity) return { serial: this.identity.serial, inputId: this.inp!.id, label: fm1Label(this.identity), linked: true };
    const serial = rememberedFm1();
    return serial ? { serial, inputId: null, label: fm1Label({ name: null, serial, rig: false, index: 0, count: 1 }), linked: false } : null;
  }

  /**
   * Connect FM-1 (#187, #702, D-965). Every pair named like an FM-1 is asked HELLO, and only when none answers, every other
   * pair once. One FM-1 that answered is linked. Of several, the one remembered by serial is, unless `ask`; else the user
   * chooses (`choose`), and Cancel keeps the FM-1 linked before, if any. What an FM-1 sends after HELLO reaches the editor
   * only from the one linked: it is asked again.
   */
  async connect(o: { ask?: boolean } = {}): Promise<Info> {
    const before = this.connected ? this.inp?.id : undefined;
    this.detach(); // reconnect never inherits the previous device capability
    if (!navigator.requestMIDIAccess) throw new Error('Web MIDI is not available in this browser (use Chrome or Edge)');
    let access: MIDIAccess;
    try {
      access = await navigator.requestMIDIAccess({ sysex: true });
    } catch (e) {
      throw new Error(sysexRefused(e));
    }
    access.onstatechange = () => {
      if (this.out && !this.connected) { this.info = null; this.origins.reset(); this.onStatus('FM-1 disconnected'); }
    };
    const inputs = [...access.inputs.values()], outputs = [...access.outputs.values()];
    // the ports named like an FM-1 first; then, as macOS may show it under another name (#187), every other in / out pair
    const pairs = linkCandidates(inputs, outputs);
    const found: { c: LinkCandidate; info: Info }[] = [];
    const ids: Fm1Id[] = [];
    let ignored = 0;   // FM-1s set to ignore the editor (#702): skipped, and said
    const events = this.onEvent;
    this.onEvent = () => {};
    try {
      for (const c of pairs) {
        if (!c.named && found.length) break;   // (an FM-1-named pair answered: the other pairs are not asked)
        this.attach(c.inp, c.out);
        try {
          const info = await this.hello(c.named ? TRIES : 1);
          if (editorSkips(info)) ignored++;
          else found.push({ c, info });
        } catch {
          /* no answer: the next pair */
        }
        this.detach();
      }
      if (!found.length) throw new Error(ignored ? ignoredFound(ignored) : notFound(inputs, outputs, pairs.length > 0));
      if (found.length > 1)
        for (const [i, f] of found.entries()) {
          this.attach(f.c.inp, f.c.out);
          this.info = f.info;
          ids.push(await this.identify(i, found.length));
          this.detach();
        }
    } finally {
      this.onEvent = events;
    }
    let pick: number | null = 0;
    if (found.length > 1) {
      const remembered = rememberedFm1();
      pick = autoPick(ids, remembered, o.ask);
      if (pick === null) {
        const chosen = this.choose ? await this.choose(ids, suggested(ids, remembered)) : null;
        const kept = before ? ids.findIndex((d) => d.portId === before) : -1;
        if (chosen !== null && ids[chosen]) {
          pick = chosen;
          rememberFm1(ids[chosen]);
        } else if (kept >= 0) pick = kept;
        else throw new Error(NOT_CHOSEN);
      }
    }
    const { c } = found[pick];
    this.attach(c.inp, c.out);
    let info: Info;
    try {
      info = await this.hello(c.named ? TRIES : 1);
    } catch (e) {
      this.detach();
      throw e;
    }
    if (editorSkips(info)) {
      this.detach();
      throw new Error(ignoredFound(1));
    }
    this.identity = ids[pick] ?? await this.identify(0, 1);
    if (this.hasPads) this.out!.send(padsReadFrame());   // (the FM-1 does not send its map after HELLO: read it; a 'pads' event)
    return info;
  }

  /** what tells the attached FM-1 apart (D-965, fm1-choice.ts readFm1Id), with its place among the FM-1s that answered */
  private async identify(index: number, count: number): Promise<Fm1Id> {
    const fw = this.info?.firmware;
    const id = await readFm1Id((frame, match) => this.request(frame, match), this.info?.features ?? 0);
    return { ...id, index, count, port: this.inp?.name ?? '', portId: this.inp?.id ?? '', firmware: fw ? `${fw.major}.${fw.minor}.${fw.patch}` : '' };
  }

  /** let go of the ports (an FM-1 set to ignore the editor, #702): nothing more is sent or heard */
  private detach(): void {
    if (this.inp) this.inp.onmidimessage = null;
    this.out = this.inp = null;
    this.info = null;
    this.identity = null;
    this.origins.reset();
    this.running = false;
    this.stored = null;
    this.storedLen.clear();
  }

  /** the linked FM-1 was set to ignore the editor (an INFO nobody asked for, #702): let go of it, and say so */
  release(): void {
    this.detach();
    this.onStatus(IGNORED_NOW);
  }

  /** listen on `inp` and send to `out`: the link's ports from now on */
  private attach(inp: MIDIInput, out: MIDIOutput): void {
    this.info = null;
    this.origins.resume();
    this.out = out;
    this.inp = inp;
    this.running = false;
    this.inp.onmidimessage = (ev) => {
      const run = transportOf(ev.data);
      if (run !== null) {
        this.running = run;
        return;
      }
      if (ev.data && ev.data.length === 3 && (ev.data[0] & 0xf0) === 0xb0) return this.onEvent({ kind: 'cc', n: ev.data[1], v: ev.data[2] });
      const p = ev.data ? parse(ev.data) : null;
      if (p?.cmd === CMD.originNow) {
        if (!(this.info?.features && (this.info.features & FEATURE_PATTERN_ORIGINS))) { this.origins.reset(); return; }
        return this.onEvent({ kind: 'origins', update: this.origins.receive(Uint8Array.from(p.payload)) });
      }
      if (p?.cmd === CMD.slotNow && p.payload.length >= 1) {
        this.origins.suspend();
        const name = String.fromCharCode(...p.payload.slice(1, 21).filter((c) => c)).trim();
        return this.onEvent({ kind: 'slot', slot: p.payload[0], name });
      }
      const t = p?.cmd === CMD.trackNow ? parseTrack(p.payload) : null;
      if (t) {   // (a pattern past TRACK_FRAME_WORDS comes in frames: each after the first adds to the one before, #1292)
        const was = this.trackPart, notes = t.more && was?.module === t.module && was.pat === t.pat ? [...was.notes, ...t.notes] : t.notes;
        this.trackPart = { module: t.module, pat: t.pat, notes };
        return this.onEvent({ kind: 'track', module: t.module, notes, pat: t.pat });
      }
      const lk = p?.cmd === CMD.locksNow ? parseLocksNow(p.payload) : null;
      if (lk) return this.onEvent({ kind: 'locks', ...lk });
      const pn = p?.cmd === CMD.patternNow ? parsePatternNow(p.payload) : null;
      if (pn) return this.onEvent({ kind: 'pattern', ...pn });
      const sn = p?.cmd === CMD.songNow ? parseSongNow(p.payload) : null;
      if (sn) return this.onEvent({ kind: 'song', ...sn });
      const kn = p?.cmd === CMD.keysNow ? parseKeysNow(p.payload) : null;
      if (kn) return this.onEvent({ kind: 'keys', ...kn });
      const gn = p?.cmd === CMD.guideNow ? parseGuideNow(p.payload) : null;
      if (gn) return this.onEvent({ kind: 'guide', state: gn });
      const tn = p?.cmd === CMD.tempoNow ? parseTempoNow(p.payload) : null;
      if (tn) return this.onEvent({ kind: 'tempo', ...tn });
      if (p?.cmd === CMD.muteNow && p.payload.length >= 2) return this.onEvent({ kind: 'mute', module: p.payload[0], on: !!p.payload[1] });
      const an = p?.cmd === CMD.armsNow ? parseArmsNow(p.payload) : null;
      if (an) return this.onEvent({ kind: 'arms', words: an });
      if (p?.cmd === CMD.paramNow && p.payload.length >= 6) {
        const v = new DataView(Uint8Array.from(p.payload.slice(2, 6)).buffer).getInt32(0, true) / 65536;
        return this.onEvent({ kind: 'param', module: p.payload[0], param: p.payload[1], value: v });
      }
      const mn = p?.cmd === MAP_CMD.mapNow ? parseMapNow(p.payload) : null;
      if (mn) return this.onEvent({ kind: 'maps', ...mn });
      const pd = p?.cmd === PADS_CMD.padsNow ? parsePadsNow(p.payload) : null;
      if (pd) return this.onEvent({ kind: 'pads', ...pd });
      if (p?.cmd === PALETTE.now) {
        const now = parsePaletteNow(p.payload);
        if (!now) return;
        if (this.waiter?.match(p)) {   // (the answer to GET: the reader has it, and so does the event's handler)
          const w = this.waiter;
          this.waiter = null;
          w.done(p);
        }
        return this.onEvent({ kind: 'palette', now });
      }
      const pe = p?.cmd === PALETTE.entry && !this.waiter?.match(p) ? parsePaletteEntry(p.payload) : null;
      if (pe) return this.onEvent({ kind: 'paletteEntry', ...pe });
      const po = p?.cmd === PATTERN_OP.report ? parsePatternOp(p.payload) : null;
      if (po) return this.onEvent({ kind: 'patternOp', ...po });
      if (p?.cmd === CMD.focusNow && p.payload.length >= 2) return this.onEvent({ kind: 'focus', device: p.payload[0], page: p.payload[1] });
      const stored = p ? parsePresetStored(p) : null;
      if (stored) return this.onEvent({ kind: 'presetStored', ...stored });
      const ln = p?.cmd === CMD.patLinkNow ? parseLinkNow(p.payload) : null;
      if (ln) {
        if (ln.id) {   // (the FM-1 holds that id as the link says: SAVE may have written it; its length is not said)
          this.stored?.set(ln.id, ln.hash);
          this.storedLen.delete(ln.id);
        }
        return this.onEvent({ kind: 'link', ...ln });
      }
      const pat = p && this.collectingPatterns ? parsePatEntry(p) : null;
      if (pat && this.collectingPatterns) return this.collectingPatterns(pat);
      const entry = p && this.collecting ? parsePresetEntry(p) : null;
      if (entry && this.collecting) return this.collecting(entry);
      if (p?.cmd === CMD.info) this.info = parseInfo(p);
      if (p && this.waiter?.match(p)) {
        if (p.cmd === CMD.ack && p.payload[0] === CMD.commit && p.payload[2] === 0) this.origins.resume();
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
  }

  private request(frame: Uint8Array, match: (p: ReturnType<typeof parse>) => boolean, timeout = ACK_TIMEOUT, most = TRIES): Promise<NonNullable<ReturnType<typeof parse>>> {
    return new Promise((resolve, reject) => {
      let tries = 0;
      const attempt = (): void => {
        // (the link closed meanwhile, as when the page reloads under a request: a rejection, not a TypeError on null, #754)
        if (!this.out) return reject(new Error('the FM-1 is not connected'));
        tries++;
        const t = window.setTimeout(() => {
          this.waiter = null;
          if (tries < most) attempt();
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

  /** HELLO, asked up to `tries` times */
  async hello(tries = TRIES): Promise<Info> {
    this.info = null;
    const p = await this.request(helloFrame(), (x) => x?.cmd === CMD.info, ACK_TIMEOUT, tries);
    this.info = parseInfo(p);
    if (!this.info) throw new Error('unexpected answer to HELLO');
    return this.info;
  }

  private async ackFor(frame: Uint8Array, cmd: number, seq?: number, timeout = ACK_TIMEOUT, texts: Readonly<Record<number, string>> = STATUS_TEXT, most = TRIES): Promise<Ack> {
    const p = await this.request(frame, (x) => x?.cmd === CMD.ack && x.payload[0] === cmd && (seq === undefined || x.payload[1] === seq), timeout, most);
    const a = parseAck(p)!;
    if (a.status) throw Object.assign(new Error(`FM-1: ${texts[a.status] ?? `error ${a.status}`}${a.aux ? ` (${a.aux})` : ''}`), { status: a.status });
    return a;
  }

  /** Upload and switch to the patch (`encoded`: it encoded already, for this link's pattern store as it is now: encodeFor;
   *  a patch that changed since is refused). To an FM-1 that stores every pattern 2..64 its patterns go into the store
   *  first (storeFirst). What was sent. Calls are serialised. */
  upload(patch: Patch, encoded?: Uint8Array): Promise<Sent> {
    const submitted = structuredClone(patch), bytes = encoded?.slice(), store = this.linkStore;
    this.invalidateOrigins();
    const run = async (): Promise<Sent> => {
      // Recheck inside the serial queue: the device may have changed after a caller encoded it.
      if (!takesTrackCards(this.info, submitted)) throw new Error(UPDATE_FOR_TRACK_CARD);
      const sent = this.patternsStored ? await this.storeFirst(submitted, submitted.name) : null;
      if (!sent && !holdsFactoryLinks(submitted, store)) throw new Error(UPDATE_TO_SYNC);
      const checked = sent?.bin ?? encodePatch(submitted, false, 0, this.bufferAllocation, store);
      if (bytes && !sameBinary(bytes, checked)) throw new Error('Patch changed before upload: send it again');
      await this.sendChunks(checked);
      await this.ackFor(commitFrame(checked), CMD.commit);
      return { bin: checked, inline: sent?.inline ?? [] };
    };
    return this.serial(run);
  }

  /** the binary a patch goes to this FM-1 as (upload, uploadSlot), as far as the link knows its store: what the FM-1 holds
   *  after an upload of it (upload-gate.ts). To an FM-1 that stores every pattern, a pattern no entry holds yet is written
   *  inside it, so the binary differs from the one its upload sends. Throws as encodePatch */
  encodeFor(patch: Patch): Uint8Array {
    if (!this.patternsStored) return encodePatch(patch, false, 0, this.bufferAllocation, this.linkStore);
    const known = [...(this.stored ?? [])].flatMap(([id, hash]) => {
      const len = this.storedLen.get(id);
      return len === undefined ? [] : [{ id, hash, len, layout: 0, tracks: 0, readOnly: false, kept: false, name: '' }];
    });
    return encodePatch(withLinks(patch, storePlan(patch, known, patch.name, this.spillsPatternOne && patternOneSpills(patch)).links), false, 0, this.bufferAllocation, this.linkStore);
  }

  /**
   * Before a patch goes to an FM-1 that stores every pattern 2..64 (#1202): each of its patterns with content links an entry
   * that holds it (the FM-1's list read again: entries nothing links are freed at each slot write), else goes into the
   * store as a new one (pattern-store.ts storePlan), and the binary carries pattern 1 (in the store too when the patch
   * cannot hold it and the FM-1 reads format 67, #1292), the songs and the links. A pattern
   * the store has no room for stays inside the patch (`inline`); a patch too big then is refused, saying why. The caller
   * sends this binary before it puts the next patch's patterns. Runs inside the serial queue.
   */
  private async storeFirst(patch: Patch, name: string): Promise<Sent> {
    const plan = storePlan(patch, await this.readPatterns(), name, this.spillsPatternOne && patternOneSpills(patch));
    const links = { ...plan.links };
    const inline: number[] = [];
    for (const e of plan.put) {
      const r = e.payload.length > PAYLOAD_MAX ? null : await this.putEntry(0, e.name, e.payload);
      if (r?.status === PAT_OK) {
        for (const p of e.ps) links[p] = { id: r.id, hash: e.hash };
        continue;
      }
      if (r && r.status !== PAT_FULL && r.status !== PAT_RANGE) throw new Error(`FM-1: ${PAT_STATUS[r.status] ?? `error ${r.status}`}`);
      inline.push(...e.ps);
    }
    inline.sort((a, b) => a - b);
    const linked = withLinks(patch, links);
    if (inline.length && layout(linked, undefined, 0, this.linkStore).need > DEVICE.bytes)
      throw new PatchRefused(`${storeFullText(name, inline)} With ${inline.length === 1 ? 'it' : 'them'} inside, "${name}" takes more than the FM-1's ${DEVICE.bytes} patch bytes, so it was not sent: delete stored patterns in Library > Patterns, or empty patterns of this patch.`);
    return { bin: encodePatch(linked, false, 0, this.bufferAllocation, this.linkStore), inline };
  }

  /** the firmware takes the TRANSPORT command (INFO feature bit 1) */
  get hasTransport(): boolean {
    return !!(this.info && this.info.features & 2);
  }

  /** the firmware shares the global tempo (TEMPO / TEMPO_NOW, INFO feature bit 16, D-907) */
  get hasTempo(): boolean {
    return !!(this.info && this.info.features & FEATURE_TEMPO);
  }

  /** the firmware reports its panel's key edges and state (KEYS_NOW / GUIDE_NOW, INFO feature bit 18, #549) */
  get reportsPanel(): boolean {
    return !!(this.info && this.info.features & FEATURE_PANEL_REPORT);
  }

  /** the firmware takes the editor's armed set (ARMS, INFO feature bit 20, #191) */
  get takesArms(): boolean {
    return !!(this.info && this.info.features & FEATURE_ARMS);
  }

  /** the editor's armed set (arm.ts armMask), to firmware that takes it: the FM-1 arms the same devices. Firmware before
   *  feature bit 21 takes the first two words (modules 0..63: all a patch it plays has, #721), before FEATURE5_FORMAT_67
   *  the first four (modules 0..127, #1286) */
  arms(words: readonly number[]): void {
    if (!this.connected || !this.takesArms) return;
    const n = (this.info!.features25 ?? 0) & FEATURE5_FORMAT_67 ? words.length : this.info!.features & FEATURE_WIDE_ARMS ? 4 : 2;
    this.out!.send(armsFrame(words.slice(0, n)));
  }

  /** GLO > PANEL > TEMPO, the global tempo (bpm 0: leave it) and the time signature (#1011; older firmware ignores it), to
   *  firmware that shares them */
  tempo(global: boolean, bpm: number, meter: number): void {
    if (this.connected && this.hasTempo) this.out!.send(tempoFrame(global, bpm, meter));
  }

  /** the transport (PLAY) */
  transport(run: boolean): void {
    if (!this.connected || !this.hasTransport) return;
    this.out!.send(transportFrame(run));
    this.running = run;
  }

  private async sendChunks(bin: Uint8Array): Promise<void> {
    const flags = bin[6] | bin[7] << 8;
    if ((flags & FLAG_RACK) && bin[1] >= FORMAT_RACK && (!this.info?.patchFormats || this.info.patchFormats.max < FORMAT_RACK))
      throw new Error('This patch has FX drawers or effects. Update the FM-1 firmware before sending it.');
    if (bin[1] >= FORMAT_1_27 && !((this.info?.features25 ?? 0) & FEATURE5_FORMAT_67))
      throw new Error('This patch uses release 1.27 (more than 128 modules, a module in stereo mode, a Delay, Reverb or Chorus r jack, a pattern of more than 128 notes, or pattern 1 in the pattern store). Update the FM-1 firmware before sending it.');
    if ((flags & FLAG_PATTERN_ORIGINS) && (!this.info?.patchFormats || bin[1] > this.info.patchFormats.max || !(this.info.features & FEATURE_PATTERN_ORIGINS)))
      throw new Error('This patch carries factory pattern origins. Update the FM-1 firmware before sending it; its origins cannot be removed automatically.');
    if ((flags & FLAG_LINKS) && !this.hasPatternStore) throw new Error('This patch links stored patterns, and this FM-1 has no pattern store.');
    const range = this.info?.patchFormats;
    if (range && (bin[1] < range.min || bin[1] > range.max)) throw new Error(UPDATE_TO_SYNC);
    const frames = chunkFrames(bin);
    for (let i = 0; i < frames.length; i++) await this.ackFor(frames[i], CMD.chunk, i & 0x7f);
  }

  /** Put a patch into patch slot 0..63 of the FM-1's bank (flash); it is not loaded. To an FM-1 that stores every pattern
   *  its patterns go into the store first (storeFirst, named after `name`); what was sent */
  uploadSlot(slot: number, name: string, patch: Patch): Promise<Sent> {
    const submitted = structuredClone(patch);
    return this.serial(async () => {
      if (!takesTrackCards(this.info, submitted)) throw new Error(UPDATE_FOR_TRACK_CARD);
      const sent = this.patternsStored ? await this.storeFirst(submitted, name) : null;
      if (!sent && !holdsFactoryLinks(submitted, this.linkStore)) throw new Error(UPDATE_TO_SYNC);
      const bin = sent?.bin ?? encodePatch(submitted, false, 0, this.bufferAllocation, this.linkStore);
      await this.sendChunks(bin);
      await this.ackFor(slotFrame(slot, name, bin), CMD.slot, slot, FLASH_TIMEOUT);
      return { bin, inline: sent?.inline ?? [] };
    });
  }

  /** a patch binary as it is into slot 0..63 (`uploadSlot`'s second half; the scenarios store a binary of an older format
   *  with it, as a bank written by an earlier firmware holds) */
  uploadSlotBin(slot: number, name: string, bin: Uint8Array): Promise<void> {
    return this.serial(async () => {
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

  /** the firmware sends a slot's binary back (SLOT_GET, INFO byte 25 bit 2, 1.26) */
  get readsSlots(): boolean {
    return this.connected && !!((this.info?.features25 ?? 0) & FEATURE25_SLOT_GET);
  }

  /** slot `slot`'s binary as stored (SLOT_GET, firmware that readsSlots), or null when it is empty */
  readSlotBin(slot: number): Promise<Uint8Array | null> {
    return this.serial(async () => {
      const bin = await readSlotBinary((f, m) => this.request(f, m), slot, SLOT_STORED);
      return typeof bin === 'string' ? null : bin;
    });
  }

  /** the slots of the FM-1's bank (60 with its pattern store on, else 64: INFO byte 15) */
  get bankSlots(): number {
    return slotCount(this.info);
  }

  /** every slot of the bank */
  async readBank(): Promise<SlotInfo[]> {
    const out: SlotInfo[] = [];
    for (let s = 0; s < this.bankSlots; s++) out.push(await this.readSlot(s));
    return out;
  }

  /** the FM-1's pattern store is on (INFO feature bit 25, #901) */
  get hasPatternStore(): boolean {
    return !!(this.info && this.info.features & FEATURE_PATTERN_STORE);
  }

  /** the firmware has the factory region's commands (INFO feature bit 26, #915, D-490) */
  get hasFactoryRegion(): boolean {
    return !!(this.info && this.info.features & FEATURE_FACTORY);
  }

  /** FACT_INFO: the factory region's state and version (factory-content.ts factoryOffer reads it) */
  factoryInfo(): Promise<FactoryInfo> {
    return this.serial(() => factoryInfo((f, m, t, n) => this.request(f, m, t, n)));
  }

  /** the factory region installed from `image` (factory-content.ts installFactory); `progress` in pages */
  installFactory(image: Uint8Array, progress?: (done: number, total: number) => void): Promise<void> {
    return this.serial(() => installFactory((f, m, t, n) => this.request(f, m, t, n), image, progress));
  }

  /** the screen font installed from `image` (font-content.ts installFont, #602); `progress` in pages. The commit's ACK
   *  means the FM-1 checked and took it: `info.font` says so from then on */
  async installFont(image: Uint8Array, progress?: (done: number, total: number) => void): Promise<void> {
    await this.serial(() => installFont((f, m, t, n) => this.request(f, m, t, n), image, progress));
    if (this.info?.font) this.info.font = { ...this.info.font, valid: true, writing: false };
  }

  /** the pattern store a patch sent now is written for (patchbin.ts LinkStore): what this FM-1's store holds, `unknown`
   *  before its list was read, `none` without a store; `assume` with no FM-1 (the budget's) */
  get linkStore(): LinkStore {
    if (!this.connected) return 'assume';
    return !this.hasPatternStore ? 'none' : this.stored ?? 'unknown';
  }

  /** every pattern 2..64 lives in this FM-1's pattern store (INFO byte 25 bit 1, 1.26, #1202): sends store them first, and
   *  only pattern 1, the songs and the links count against the patch's bytes */
  get patternsStored(): boolean {
    return this.connected && this.hasPatternStore && !!((this.info?.features25 ?? 0) & FEATURE25_PATTERNS_STORED);
  }

  /** this FM-1 also puts pattern 1 into its store when a patch cannot hold it (it stores every pattern and reads format 67,
   *  #1292) */
  get spillsPatternOne(): boolean {
    return this.patternsStored && !!((this.info?.features25 ?? 0) & FEATURE5_FORMAT_67);
  }

  /** the pattern store the budget counts with (patchbin.ts deviceBudget): `spill` for an FM-1 that stores every pattern and
   *  pattern 1 when the patch cannot hold it, `every` for one that stores every pattern 2..64, else `assume`, as with no
   *  FM-1 */
  get budgetStore(): BudgetStore {
    return this.spillsPatternOne ? 'spill' : this.patternsStored ? 'every' : 'assume';
  }

  /** the entries of the FM-1's pattern store (PATS: the user's; firmware before 1.26 lists its read-only factory ones after
   *  them); it also learns what the store holds for linkStore */
  listPatterns(): Promise<StoredPatternEntry[]> {
    return this.serial(() => this.readPatterns());
  }

  /** listPatterns inside the serial queue */
  private readPatterns(): Promise<StoredPatternEntry[]> {
    return new Promise<StoredPatternEntry[]>((resolve, reject) => {
      const got: StoredPatternEntry[] = [];
      // (a long list takes a while: the time runs from the last entry heard)
      const late = (): number => window.setTimeout(() => { this.collectingPatterns = null; reject(new Error('no answer from the FM-1')); }, ACK_TIMEOUT * TRIES);
      let t = late();
      this.collectingPatterns = (e) => {
        clearTimeout(t);
        if (e.entry) got[e.k] = e.entry;
        const all = got.filter(Boolean);
        if (e.count && all.length < e.count) return void (t = late());
        this.collectingPatterns = null;
        this.stored = new Map(all.map((x) => [x.id, x.hash]));   // (a factory patch links read-only entries on firmware before 1.26 too, #923)
        this.storedLen = new Map(all.map((x) => [x.id, x.len]));
        resolve(all);
      };
      this.out!.send(patsFrame());
    });
  }

  /** a stored pattern's payload (PAT_GET, in pieces); null: the FM-1 has no such id */
  getPattern(id: number): Promise<Uint8Array | null> {
    return this.serial(() => readStoredPattern((f, m) => this.request(f, m), id));
  }

  /** a payload into the FM-1's pattern store under `name`: a new entry (`id` 0) or over entry `id` (a rename: the same
   *  payload, a new name); its id. `kept`: a new entry kept as a copy (PAT_KEPT, only to an FM-1 that stores every
   *  pattern). Refused with the store's reason (full, read-only, gone) */
  putPattern(id: number, name: string, payload: Uint8Array, kept = false): Promise<number> {
    return this.serial(async () => {
      let r = await this.putEntry(id, name, payload, kept);
      // (a 1.26 FM-1 writes over a kept copy only with a kept put: a put over an id it calls missing goes again as a kept
      // put, which it refuses the same way for any other id)
      if (r.status === PAT_MISSING && id && !kept && this.patternsStored) r = await this.putEntry(id, name, payload, true);
      if (r.status !== PAT_OK) throw new Error(`FM-1: ${PAT_STATUS[r.status] ?? `error ${r.status}`}`);
      return r.id;
    });
  }

  /** putPattern inside the serial queue: the PAT_STORED of its last chunk (or of the first one refused) */
  private async putEntry(id: number, name: string, payload: Uint8Array, kept = false): Promise<{ id: number; status: number }> {
    const frames = patPutFrames(id, name, payload, kept);
    for (let i = 0; ; i++) {
      const last = i === frames.length - 1;
      // (never sent twice: a chunk again would start the put again or land after it was stored)
      const r = parsePatStored(await this.request(frames[i], (x) => x?.cmd === CMD.patStored, last ? 2 * FLASH_TIMEOUT : ACK_TIMEOUT, 1))!;
      if (r.status !== PAT_OK) return r;
      if (!last) continue;
      this.stored?.set(r.id, fnv(FNV0, payload));
      this.storedLen.set(r.id, payload.length);
      return r;
    }
  }

  /** delete a stored pattern; without `force` one the bank's patches link is kept and `used` says how many slots link it */
  deletePattern(id: number, force: boolean): Promise<{ deleted: boolean; used: number }> {
    return this.serial(async () => {
      const r = parsePatStored(await this.request(patDelFrame(id, force), (x) => x?.cmd === CMD.patStored, FLASH_TIMEOUT, 1))!;
      if (r.status === PAT_USED) return { deleted: false, used: r.count };
      if (r.status !== PAT_OK) throw new Error(`FM-1: ${PAT_STATUS[r.status] ?? `error ${r.status}`}`);
      this.stored?.delete(id);
      this.storedLen.delete(id);
      return { deleted: true, used: 0 };
    });
  }

  get takesDeviceSettings(): boolean { return !!(this.info && this.info.features & FEATURE_DEVICE_SETTINGS); }

  deviceSettings(settings?: Pick<DeviceSettings, 'name' | 'returnLevel'>): Promise<DeviceSettings> {
    return this.serial(async () => {
      if (!this.connected || !this.takesDeviceSettings) throw new Error('Connect an FM-1 with firmware that supports device names and USB playback.');
      return parseDeviceSettings(await this.request(deviceSettingsFrame(settings), (x) => x?.cmd === CMD.deviceSettingsReply));
    });
  }

  /** the FM-1 has the master EQ over the link (GLO › EQ, #1107) */
  get takesMasterEq(): boolean { return !!(this.info && this.info.features & FEATURE_MASTER_EQ); }

  /** the FM-1's master EQ: read it, or set it (it plays at once and the FM-1 keeps it, as from its menu) */
  masterEq(eq?: MasterEq): Promise<MasterEq> {
    return this.serial(async () => {
      if (!this.connected || !this.takesMasterEq) throw new Error('Connect an FM-1 with firmware that has the master EQ (GLO › EQ).');
      return parseMasterEq(await this.request(masterEqFrame(eq), (x) => x?.cmd === MASTER_EQ.reply));
    });
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
  range(patch: Patch, moduleId: number, index: number, name: string, range: Range | null): void {
    if (!this.connected) return;
    const mi = deviceIndex(patch, moduleId);
    if (mi < 0) return;
    const pi = DEFS[patch.modules.find((m) => m.id === moduleId)!.type].params.findIndex((q) => q.name === name);
    if (pi >= 0) this.out!.send(rangeFrame(mi, index, pi, range));
  }

  /** the firmware has MIDI learn (#1067, INFO feature bit 27: MAP, MAP_NOW) */
  get hasMaps(): boolean {
    return !!this.info && (this.info.features & FEATURE_MAP) !== 0;
  }

  /** the patch's MIDI learn mappings, all of them, into the FM-1's copy (MAP; the section patchbin.ts mapRecord writes) */
  maps(patch: Patch): void {
    if (!this.connected || !this.hasMaps) return;
    const dev = deviceView(patch, true).patch;
    this.out!.send(mapFrame(mapRecord(patch, dev, deviceSection(patch, dev))));
  }

  /** the firmware keeps the global pad map (INFO feature bit 29: PADS, PADS_NOW) */
  get hasPads(): boolean {
    return !!this.info && (this.info.features & FEATURE_PADS) !== 0;
  }

  /** drum row `row` (0..23) played by the pad sending MIDI note `note`, null none (PADS; the FM-1 answers PADS_NOW) */
  setPad(row: number, note: number | null): void {
    if (this.connected && this.hasPads) this.out!.send(padsSetFrame(row, note));
  }

  /** every row's pad cleared (PADS; the FM-1 answers PADS_NOW) */
  clearPads(): void {
    if (this.connected && this.hasPads) this.out!.send(padsClearAllFrame());
  }

  /** PAD MAP off or on (PADS; the FM-1 answers PADS_NOW) */
  padsOn(on: boolean): void {
    if (this.connected && this.hasPads) this.out!.send(padsOnFrame(on));
  }

  /** the firmware keeps presets (#195, INFO feature bit 7) */
  get hasPresets(): boolean {
    return !!(this.info && this.info.features & 128);
  }

  /** the firmware stores a preset of up to 176 values (two store slots, INFO feature bit 17, #485); older keeps 88 */
  get hasLongPresets(): boolean {
    return !!(this.info && this.info.features & FEATURE_LONG_PRESETS);
  }

  /** whether a preset of n values can be stored on this FM-1 (false: older firmware and more than 88: it must be updated;
   *  more than 176 never; an FX drawer preset needs firmware that reads FX drawers, INFO byte 25 bit 3) */
  presetFits(n: number, preset?: { structure: string; values: number[] }): boolean {
    if (preset && fxPresetInfo(preset) && !(this.info && this.info.features & FEATURE_FX_PRESETS)) return false;
    if (preset && drawerPresetInfo(preset) && !((this.info?.features25 ?? 0) & FEATURE5_FX_DRAWERS)) return false;
    return n <= PRESET_VALUES_OLD || (this.hasLongPresets && n <= PRESET_VALUES_MAX);
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

  /** store a preset on the FM-1; one older firmware cannot hold whole is refused before anything is sent (D-476) */
  putPreset(structure: string, name: string, values: number[]): Promise<void> {
    if (!this.presetFits(values.length, { structure, values })) return Promise.reject(new Error(PRESET_NEEDS_UPDATE));
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
    if (mi >= 0 && this.hasPatterns) for (const f of trackFrames(mi, notes, pat)) this.out!.send(f);
    else if (mi >= 0 && !pat) this.out!.send(trackFrames(mi, notes)[0]);
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

  /** the FM-1 keeps a palette (#1196, INFO feature bit 31: PALETTE, PALETTE_NOW, PALETTE_ENTRY) */
  get hasPalette(): boolean {
    return !!this.info && hasPaletteFeature(this.info.features);
  }

  /** the palette's 8 positions (GET); from now on the FM-1 also sends them unasked after every change (`palette` events) */
  readPalette(): Promise<PaletteNow> {
    return this.serial(async () => parsePaletteNow((await this.request(paletteGetFrame(), (x) => x?.cmd === PALETTE.now && !!parsePaletteNow(x.payload))).payload)!);
  }

  /** position `pos`'s entry with its devices' presets (ENTRY_GET), null when empty */
  readPaletteEntry(pos: number): Promise<PaletteEntry | null> {
    return this.serial(async () => {
      const p = await this.request(paletteEntryGetFrame(pos), (x) => x?.cmd === PALETTE.entry && x.payload[0] === pos);
      const r = parsePaletteEntry(p.payload);
      if (!r) throw new Error('unexpected answer to PALETTE ENTRY_GET');
      return r.entry;
    });
  }

  /** position `pos` takes `entry`, or empties (null): one flash write. The FM-1 refuses an entry whose slot does not hold
   *  its name now (PAL_MISSING) */
  putPaletteEntry(pos: number, entry: PaletteEntry | null): Promise<void> {
    return this.serial(async () => { await this.ackFor(palettePutFrame(pos, entry), PALETTE.cmd, pos, FLASH_TIMEOUT, PAL_STATUS); });
  }

  /** reorder and remove in one write: new position i takes old position from[i] (null empty). Sent once, never again on
   *  a lost answer (a second ORDER would move the entries again) */
  orderPalette(from: readonly (number | null)[]): Promise<void> {
    return this.serial(async () => { await this.ackFor(paletteOrderFrame(from), PALETTE.cmd, 0, FLASH_TIMEOUT, PAL_STATUS, 1); });
  }

  /** switch to position `pos` (null: cancel a waiting switch), stopped at once, playing at the next bar line. The ACK's
   *  status says why it was refused (PAL_EMPTY, PAL_MISSING, PAL_REFUSED) and its aux when it switches (PAL_GO_*).
   *  Sent once: a second GO to the same position would cancel it */
  goPalette(pos: number | null): Promise<Ack> {
    const seq = pos === null ? 0xff : pos;
    return this.serial(async () => parseAck(await this.request(paletteGoFrame(pos), (x) => x?.cmd === CMD.ack && x.payload[0] === PALETTE.cmd && x.payload[1] === seq, FLASH_TIMEOUT, 1))!);
  }

  /** the name of the patch the editor runs under Live (NAME, after each Live upload; `name` as deviceName gives it): a
   *  hold-save of it on the FM-1 names the slot it stores it into */
  sendLiveName(name: string): void {
    if (this.connected && this.hasPalette) this.out!.send(paletteNameFrame(name));
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

  /** a played message sent on to the FM-1 under Live (main.ts sink.play), on the MIDI channel it came on (#1155: a Voice
   *  allocator on its own channel, the FM-1's MIDI CHANNEL and its pad map hear it as the controller sent it); none, as
   *  the editor's own keys and wheels play, is channel 1. Notes, pitch bend (the firmware bends ±2 semitones), control
   *  changes, channel aftertouch (Main's `at` output) and all notes off (CC 123), as the FM-1 takes them on USB (D-453);
   *  poly aftertouch it does not take, and the editor has none to send. `keys` false holds the notes and all notes off
   *  back (the keys of a device armed in the editor stay there, D-802) */
  play(msg: HostMsg, keys = true): void {
    if (!this.connected) return;
    const c = ((('ch' in msg ? msg.ch : undefined) ?? 1) - 1) & 0x0f;
    const byte = (v: number): number => Math.max(0, Math.min(127, Math.round(v)));
    if (msg.t === 'bend') {
      const x = Math.max(0, Math.min(16383, Math.round(8192 + msg.v * 8192)));
      this.out!.send([0xe0 | c, x & 0x7f, x >> 7]);
    } else if (msg.t === 'cc') this.out!.send([0xb0 | c, msg.n & 0x7f, byte(msg.v)]);
    else if (msg.t === 'at') this.out!.send([0xd0 | c, byte(msg.v * 127)]);
    else if (!keys) return;
    else if (msg.t === 'on') this.out!.send([0x90 | c, msg.note & 0x7f, Math.max(1, byte(msg.vel * 127))]);
    else if (msg.t === 'off') this.out!.send([0x80 | c, msg.note & 0x7f, 0]);
    else if (msg.t === 'panic') this.out!.send([0xb0 | c, 123, 0]);
  }

  /** a control change from the editor itself, value 0..127, on channel 1 (the patch buttons' CC 80..86) */
  cc(n: number, v: number): void {
    if (!this.connected) return;
    this.out!.send([0xb0, n & 0x7f, Math.max(0, Math.min(127, Math.round(v)))]);
  }
}
