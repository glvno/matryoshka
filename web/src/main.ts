// SPDX-License-Identifier: GPL-3.0-only
// first of all: at the pages.dev address with no data, site-move.ts sends the visitor on to matryoshka.lol and stops
// everything else; then migrate.ts notes which storage keys the page found before anything here writes one
import './site-move';
import { addUserPreset, exportPresets, importPresets } from './device-presets';
import { armedFromMask, armMask } from './arm';
import './factory-presets'; // the factory engines' presets (#193)
import { applyImport, backupFile, backupKeys, collectKeys, importSummary, receiveMigration } from './migrate';
import { moveOffer, onPagesDev } from './move-offer';
import { CPU, CPU_WARN } from './cpu';
import { setupPopoverPositioning } from './popover';
import { AudioHost } from './audio';
import type { HostMsg } from './worklet';
import { chipState, DeviceLink, deviceIndex, liveSync, sandboxChip, syncLine, syncOnConnect, syncsWith, syncUpdateNotice, type ChipState, type DeviceEvent } from './device';
import { SITE_URL } from './site';
import { sandboxKey, sandboxPage, sandboxStep } from './sandbox-mode';
import { LIVE_MS, slotLabel } from './protocol';
import { Fm1View } from './fm1-view';
import { Editor, ZOOM_MAX, ZOOM_MIN } from './editor';
import { ScopeScreens } from './scope-view';
import { EnvScreens } from './env-view';
import { addToBank, bankPatches, buildPatchesSection, type LibrarySection as LibraryPane } from './bank';
import { buildPresetsSection } from './library-presets';
import { buildCommunitySection } from './library-community';
import { isSaved, onSavedChange, putBackSaved, removeSaved, restoreSaved, savedPatches, savePatch as keepPatch, unsavedChanges } from './saved';
import { showAction, showToast, showUndo } from './toast';
import { popMenu, type MenuItem } from './menu';
import { initStatusline, pinStatus } from './statusline';
import { buildAssembliesSection, storeAssembly, storeTutorialAssembly } from './assemblies';
import { AssemblyBrowser } from './browser';
import { searchCommands, type Command } from './commands';
import { buildFlashTab } from './flasher';
import { attachKeyboard, attachMidi, followOctave, isTextEntry } from './input';
import { Piano } from './piano';
import { sliderJack } from './slider-jack';
import { PANEL_BUTTONS } from './modules';
import { switches } from './buttons';
import { Fm1Mirror, identifyFm1, installOffer } from './mirror';
import { BUTTONS, ENCODERS } from './fm1-ui';
import type { Firmware, PanelInput } from './fm1-profiles';
import { longName, moduleName } from './labels';
import { DeckControls } from './deck';
import { releaseFocusAfterPointer } from './focus';
import { DEFS } from './modules';
import { newPatch, trackLabel, validatePatch, type Patch, type SideKey } from './patch';
import { diffCount, diffLines, diffPatches } from './diff';
import { loadLibrary, summary } from './assemblies';
import type { AssemblyDef } from './assembly';
import { defIsEngine, feedsOutput } from './engines';
import { EngineStart } from './engine-start';
import { encodeShare, handOut, isShareLink, openShareLink, shareCodeOf } from './share';
import { addedTitles, loadCommunity, onAddedChange, unlinkSaved } from './community';
import { chipEl, sandboxCardDue, sandboxWords, showSandboxCard, type Chip } from './sandbox';
import { ShareSheet } from './share-sheet';
import { fileStem, savePatchCard } from './patch-card';
import { starterPatch } from './starter';
import { recordKey, recordNote, recordOff } from './step-grid';
import { Tutorial } from './tutorial/tutorial';
import { synthLink } from './tutorial/link';
import { factoryShape, PRESETS, shapeOf } from './presets';
import { inlineWordmarks } from './brand';
import { clipText, parseClip, type Clip } from './clipboard';
import { addableModules, assemblyShelves, openableByValue, openableGroups } from './catalog';
import { binaryPage, browserOnly, deviceBudget, editorPage, encodePatch, overText, POLY_ROW, POLY_ROW_PARAMS, toQ16 } from './patchbin';
import { ALLOC, deviceView } from './poly';
import { AboutCard } from './about';
import { whatsNew } from './whats-new';
import { demoPatch } from './demo';
import { renamedKey } from './storage-key';
import { ClockOut, isFm1Out, portLabels } from './clock-out';
import { currentTheme, onThemeChange, setTheme, themeChoice, toggleTheme } from './theme';
import { installLabel } from './version';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const STORE = renamedKey('matryoshka.patch', 'modular-1.patch');
/** the address's fragment as the page opened (a share link's #p=, stripped once loaded): the reload after an import opens it again */
const openedHash = location.hash;

function loadSaved(): Patch | null {
  try {
    const s = localStorage.getItem(STORE);
    return s ? validatePatch(JSON.parse(s), DEFS) : null;
  } catch {
    return null;
  }
}

function save(p: Patch): void {
  try {
    localStorage.setItem(STORE, JSON.stringify(p));
  } catch {
    /* private mode or storage blocked: the patch just isn't remembered */
  }
}

const host = new AudioHost();
const status = $('audio-status');
host.onError = (m) => (status.textContent = m); // the worklet says "audio: …" itself

/** 'patch' in the PATCH and EMU views (the patch's own: the shortcuts and the keys act on it), 'library' in LIBRARY */
let currentTab: 'patch' | 'library' = 'patch';
let saveTimer = 0;
/** set while a patch from a link is loaded: it must not replace the remembered patch until the user acts */
let suppressSave = false;
const queueSave = (p: Patch): void => {
  if (suppressSave) return;
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => save(p), 300);
};

const device = new DeviceLink();
/** the patch fits the FM-1 (deviceBudget); one that does not plays only in the browser and is never sent */
let fitsDevice = true;
/** Live sync is on (setLive: the connect dialog, the chip, FM-1 & MIDI's Sync / Stop syncing) */
let liveOn = false;
const live = (): boolean => liveSync.syncs(device.connected, liveOn, fitsDevice);
/** the FM-1 plays the editor's patch as uploaded (set by an upload; an FM-1 without LIVE, #185, may load a slot of its own
 * under it, which clears it) */
let onEditorPatch = false;
/** Live with an FM-1 on the editor's patch that reports its knobs and pages exactly (PARAM_NOW / FOCUS_NOW, feature bit 4):
 * a knob turn names its module and parameter, so it cannot land on another row (#185); otherwise (Live off, another firmware)
 * the mirror's K1..K4 positions turn the rows of the editor's page in focus */
const exactKnobs = (): boolean => live() && onEditorPatch && device.hasPages;
// while Live is on, the FM-1 holds PRESET and program change (LIVE, #185; it lapses 5 s after the last); with the patch over
// the budget too, paused (#200): nothing is sent, but PRESET still waits and the FM-1 says why
const sayLive = (): void => {
  const f = liveSync.frame(device.connected, liveOn, fitsDevice);
  if (f) device.live(f.paused);
};
window.setInterval(sayLive, LIVE_MS);
/** sandbox mode: the patch is a sandbox patch while Live is on (LIVE paused): the FM-1 is its controller. The editor
 *  follows its panel (the mirror, as Follow its panel does) and sends it the page in focus (SANDBOX) whenever that page or
 *  a row's value changed; a 1.3 FM-1 mutes itself and draws it */
const sandboxOn = (): boolean => liveSync.sandbox(device.connected, liveOn, fitsDevice);
/** sandbox mode as last seen (sandboxCheck), whether it started following the FM-1 (it stops it again), the page last sent */
let sandboxWas = false;
let sandboxFollows = false;
let sandboxSent = '';
function sandboxCheck(): void {
  const on = sandboxOn();
  if (on === sandboxWas) return;
  sandboxWas = on;
  sandboxSent = '';
  if (on) {
    // SANDBOX pages are discarded until LIVE paused arrives. Send the mode first, including on a fresh connection.
    device.live(true);
    if (!mirror.following) {
      sandboxFollows = true;
      void followFm1('matryoshka');
    }
    setPlaying(liveSync.sandboxRuns(device.running, editor.playing));   // (one transport: a sequence the FM-1 played goes on here)
    sandboxSend();
    return;
  }
  if (sandboxFollows && mirror.following) unfollowFm1('sandbox mode ended: not following the FM-1');
  sandboxFollows = false;
}
/** the page in focus to the FM-1, when it differs from the last one sent (checked every SANDBOX_MS while in sandbox mode) */
function sandboxSend(): void {
  if (!sandboxOn() || !device.hasSandbox) return;
  const pg = sandboxPage(editor.patch, editor.devices, editor.focus);
  const key = sandboxKey(pg);
  if (key === sandboxSent) return;
  sandboxSent = key;
  device.sandboxPage(pg);
}
const SANDBOX_MS = 80;
window.setInterval(sandboxSend, SANDBOX_MS);
let uploadTimer = 0;
let uploading = false;
let dirty = false;
const devStatus = (s: string): void => {
  $('dev-status').textContent = s;
  syncChip();
};
/** the FM-1 chip in the status line (#152, #171): not connected, synced, not synced, or the patch too big to sync. A click
 *  while not synced offers Live sync (offerSync); otherwise it opens FM-1 & MIDI. Every connect and disconnect reports
 *  through devStatus, and Live, the budget and the dialog's choice call it too; Release MIDI reloads the page. FM-1 & MIDI's
 *  sync line (#180) shows the same state, with Sync or Stop syncing. */
const fm1Chip = $<HTMLButtonElement>('fm1-chip');
const fm1State = (): ChipState => chipState(device.connected, liveOn, fitsDevice);
/** Connect FM-1 over the canvas: connects (connectFm1, as FM-1 & MIDI's Connect); connected, it says so and opens FM-1 & MIDI */
const fm1Connect = $<HTMLButtonElement>('fm1-connect');
const syncChip = (): void => {
  const s = fm1State();
  for (const el of [fm1Chip, fm1Connect]) {
    el.classList.toggle('on', s === 'synced');
    el.classList.toggle('idle', s === 'not synced');
    el.classList.toggle('over', s === 'patch too big to sync');
    el.classList.toggle('sandbox', s === 'sandbox controller');
  }
  fm1Connect.classList.toggle('connected', device.connected);
  fm1Connect.querySelector('.fm1-connect-text')!.textContent = device.connected ? 'FM-1 connected' : 'Connect FM-1';
  fm1Connect.title = device.connected ? `FM-1 ${s}: FM-1 & MIDI (send, store, sync, follow its panel)` : 'Connect the FM-1 over USB MIDI';
  fm1Chip.querySelector('.sl-chip-text')!.textContent = `FM-1 \u00b7 ${s}`;
  const does = s === 'not synced' ? 'sync with the FM-1' : 'open FM-1 & MIDI';
  fm1Chip.setAttribute('aria-label', `FM-1 ${s}: ${does}`);
  fm1Chip.title = s === 'not synced' ? 'Sync with the FM-1: it plays the editor\'s patch, and changes on either side follow the other'
    : s === 'patch too big to sync' ? 'The patch is over the FM-1 budget: it plays here only (the budget beside says what is over). FM-1 & MIDI'
    : 'FM-1 & MIDI: connect, send, store, follow its panel';
  if (s === 'sandbox controller') {   // (sandbox mode: the FM-1 drives the browser's patch)
    const c = sandboxChip({ hasSandbox: device.hasSandbox, midiOut: device.info?.midiOut ?? null });
    fm1Chip.querySelector('.sl-chip-text')!.textContent = c.text;
    fm1Chip.setAttribute('aria-label', `${c.text}: open FM-1 & MIDI`);
    fm1Chip.title = fm1Connect.title = c.title;
  }
  const line = syncLine(s);
  $('dev-sync-text').textContent = line.text;
  const btn = $<HTMLButtonElement>('dev-sync-btn');
  btn.hidden = $('dev-sync-sep').hidden = !line.action;
  btn.textContent = line.action === 'stop' ? 'Stop syncing' : 'Sync';
  btn.title = line.action === 'stop' ? 'The FM-1 keeps the patch it has; edits here stay in the browser'
    : s === 'patch too big to sync' ? 'The FM-1 becomes this sandbox patch\'s controller: the browser plays it. Once the patch fits, the FM-1 plays it and changes on either side follow the other'
    : 'The FM-1 plays the editor\'s patch, and changes on either side follow the other';
  sandboxCheck();
};
fm1Chip.onclick = () => {
  if (fm1State() === 'not synced') offerSync(true);
  else $<HTMLDialogElement>('device-bar').showModal();
};
fm1Connect.onclick = async () => {
  if (device.connected) return $<HTMLDialogElement>('device-bar').showModal();
  await toastResult(connectFm1)();   // a refusal goes to FM-1 & MIDI's status, which is closed: shown in a toast too
  if (!device.connected) void offerInstall();
};
/** Connect FM-1 got no answer from Matryoshka: the FM-1 is asked who it is (M-VAVE's identity handshake, as the Install
 *  panel asks), and one on other firmware, or waiting in its update loader, gets Install Matryoshka in a toast */
async function offerInstall(): Promise<void> {
  const text = installOffer(await identifyFm1());
  if (!text) return;
  devStatus(text);   // (FM-1 & MIDI's Connect: its status line)
  showAction(text, 'Install Matryoshka', openInstall, 12000);
}
syncChip();
device.onStatus = (msg) => {
  devStatus(msg);
  if (!device.connected) libraryDeviceChanged();   // (it went away)
};
// the FM-1 on its own (#65): while Live is on, its knobs and patch buttons move the editor's, and the status line follows its slot
let fromDevice = false;
/** the change comes from the FM-1 tab's emulator (fm1-view.ts): not sent back to it, but on to a Live FM-1 */
let fromEmu = false;
let deviceSlot: { slot: number; name: string } | null = null;
device.onEvent = (e) => {
  if (e.kind === 'info') return syncChip();   // (MENU > MIDI OUT changed: the chip says so in sandbox mode)
  if (e.kind === 'slot') {
    if (!device.hasLive) onEditorPatch = false;   // (an FM-1 that takes LIVE loads no slot under Live: this is SAVE or a boot)
    deviceSlot = { slot: e.slot, name: e.name };
    devStatus(`FM-1 plays slot ${slotLabel(e.slot)} ${e.name}`);
    return;
  }
  // the panel itself (knobs, buttons, the focus) comes in as plain MIDI through the mirror (#120, fm1-profiles.ts), whatever
  // firmware runs; the FM-1's PARAM_NOW / FOCUS_NOW only while it plays the editor's patch under Live (exactKnobs, #185)
  if (e.kind === 'cc') return;
  if (e.kind === 'param' || e.kind === 'focus') {
    if (!exactKnobs()) return;
    if (e.kind === 'focus') emu.ui?.focus(e.device, e.page);   // (the mirror's copy of the panel logic too)
    fromDevice = true;
    try { fm1Event(e, 'device'); } finally { fromDevice = false; }
    return;
  }
  if (e.kind === 'presetStored') {   // a preset stored on the FM-1 (#195): under Live it comes into the editor's library
    if (!live()) return;
    void device.getPreset(e.structure, e.name).then((v) => {
      const as = v && addUserPreset(e.structure, e.name, v);
      if (!as) return;
      editor.rebuild();
      devStatus(`preset "${as}" stored on the FM-1: now in your presets too`);
    }).catch(() => {});
    return;
  }
  if (!live()) return;
  fm1Event(e, 'device');
};
/** what an FM-1 did on its panel, the real one over USB or the emulated one: the editor follows */
function fm1Event(e: DeviceEvent, from: 'device' | 'emu'): void {
  const mark = (on: boolean): void => { if (from === 'device') fromDevice = on; else fromEmu = on; };
  if (e.kind === 'slot') return;
  if (e.kind === 'track' || e.kind === 'mute') {   // the FM-1's SEQ page (#83, #133): a track edited or recorded, a track muted
    const id = deviceView(editor.patch, true).patch.modules[e.module]?.id;   // (the compiled form the FM-1 got, as deviceIndex)
    if (id === undefined) return;
    mark(true);
    try {
      if (e.kind === 'track') editor.trackFromDevice(id, e.notes, e.pat);
      else {
        host.send({ t: 'mute', id, on: e.on });
        if (from === 'device') emu.ui?.mute(e.module, e.on);   // (the emulator's black key lights follow the FM-1's mute)
      }
    } finally { mark(false); }
    return;
  }
  if (e.kind === 'pattern' || e.kind === 'song') {   // PRESET on the SEQ page, the SONG page (#375): the editor follows
    mark(true);
    try {
      if (e.kind === 'pattern') editor.patternFromDevice(e.pattern, e.song);
      else editor.songFromDevice(e.song, e.entries);
    } finally { mark(false); }
    return;
  }
  if (e.kind === 'param') {   // K1..K4 turned on a device page of the FM-1 tab's emulator
    const m = deviceView(editor.patch, true).patch.modules[e.module];
    // a poly group's setting is the Voice allocator's parameter (the allocator's Part has its id: patchbin.ts rowParam)
    const name = m && (e.param & POLY_ROW ? POLY_ROW_PARAMS[e.param & 0x7f] : DEFS[m.type].params[e.param]?.name);
    if (!m || !name) return;
    mark(true);                              // (not sent back: the FM-1 already has it)
    try { editor.setParam(m.id, name, e.param & POLY_ROW ? Math.round(e.value) : e.value); } finally { mark(false); }
    return;
  }
  if (e.kind === 'focus') {   // the emulator (or the FM-1 it follows) shows another device page: the knobs follow
    const f = editorPage(editor.patch, e.device, e.page);
    if (f) editor.focusFrom(f);
  }
}
/** upload the current patch; changes made meanwhile cause one more upload */
async function sendPatch(): Promise<boolean> {
  if (!fitsDevice) {
    devStatus('over the FM-1 budget: not sent (the FM-1 budget in the status line says what is over)');
    return false;
  }
  if (uploading) {
    dirty = true; // the upload under way sends it
    return true;
  }
  uploading = true;
  try {
    do {
      dirty = false;
      devStatus('sending patch…');
      await device.upload(editor.patch);
      onEditorPatch = true;
      baseline = JSON.stringify(editor.patch);
      devStatus('patch on the FM-1');
      const at = editor.focus && binaryPage(editor.patch, editor.focus.device, editor.focus.page);
      if (at) device.focus(at[0], at[1]);   // the FM-1 opens on the page the knobs edit here
    } while (dirty);
  } catch (e) {
    devStatus(`${(e as Error).message}`);
    return false;
  } finally {
    uploading = false;
  }
  return true;
}
const queueUpload = (): void => {
  clearTimeout(uploadTimer);
  uploadTimer = window.setTimeout(() => void sendPatch(), 150);
};
// ---- Live sync is the default on connect (#171): a patch that fits is offered (Sync / Not now), Not now holds for the visit
const SYNC_DECLINED = 'matryoshka.sync-declined';
const syncDeclined = (): boolean => {
  try {
    return sessionStorage.getItem(SYNC_DECLINED) === '1';
  } catch {
    return false; // storage blocked: every connect asks
  }
};
const declineSync = (on: boolean): void => {
  try {
    if (on) sessionStorage.setItem(SYNC_DECLINED, '1');
    else sessionStorage.removeItem(SYNC_DECLINED);
  } catch {
    /* storage blocked: Not now is not remembered */
  }
};
/** Live sync on or off: the one switch for the connect dialog, the chip and FM-1 & MIDI's sync line (on: the FM-1 gets the
 *  editor's patch) */
function setLive(on: boolean): void {
  if (on && device.connected && !syncsWith(device.info)) return sayUpdate();
  liveOn = on;
  syncChip();
  if (!on) return;
  sayLive();
  declineSync(false);
  if (fitsDevice) void sendPatch();   // (a sandbox patch is not sent: the FM-1 becomes its controller)
}
/** Incompatible patch formats: Live stays off, and the toast offers the matching update. */
function sayUpdate(): void {
  liveOn = false;
  const notice = syncUpdateNotice(device.info);
  devStatus(notice.message);
  showAction(notice.message, notice.label, notice.target === 'editor'
    ? () => { window.open(SITE_URL, '_blank', 'noopener'); } : openInstall, 12000);
}
const syncAsk = $<HTMLDialogElement>('sync-ask');
syncAsk.onclose = () => {
  if (syncAsk.returnValue === 'sync') return setLive(true);
  declineSync(true); // Not now, Esc: off, and a reconnect in this visit does not ask again
  setLive(false);
  devStatus('Live sync is off: the FM-1 chip in the status line, or Sync here, turns it on');
};
/**
 * Connecting the FM-1 (`asked`: or a click on the chip) offers Live sync (syncOnConnect). Already on, a reconnect sends the
 * patch again (the FM-1 may have restarted). The FM-1's own patch is not read: the protocol reads a slot's name and length
 * (SLOT_INFO), not its patch, so nothing can be compared or opened and it always asks.
 */
function offerSync(asked = false): void {
  if (!device.connected) return syncChip();
  if (!syncsWith(device.info)) return sayUpdate();
  if (liveOn && !asked) {
    if (fitsDevice) void sendPatch();
    return syncChip();
  }
  const d = syncOnConnect({ fits: fitsDevice, declined: !asked && syncDeclined(), editorBin: fitsDevice ? encodePatch(editor.patch) : new Uint8Array(), deviceBin: null });
  if (d === 'sync') return setLive(true);
  if (d === 'ask' && !syncAsk.open) {
    const name = editor.patch.name.trim() || 'Untitled';
    $('sync-ask-text').textContent = fitsDevice ? `The editor's patch "${name}" will play on the FM-1, and changes on either side follow the other.`
      : `"${name}" is a sandbox patch: the browser plays it, and the FM-1 becomes its controller (its keys, knobs and pages drive it here).`;
    syncAsk.returnValue = '';
    syncAsk.showModal();
  }
  syncChip();
}
/** the on-screen keyboard plays through the sink like the letter keys; Z / X and its buttons share the octave */
const piano = new Piano($('piano'), {
  on: (note, vel) => sink.send({ t: 'on', note, vel }),
  off: (note) => sink.send({ t: 'off', note }),
  shift: (d) => noteKeys.shift(d),
});
/** the wheels: pitch bend and CC 1, shown in the dock under Main's bend and modulation jacks (the editor places them) */
const hands = new DeckControls(document.createElement('div'), {
  bend: (v) => sink.send({ t: 'bend', v }),
  mod: (v) => sink.send({ t: 'cc', n: 1, v: v * 127 }),
});
/** notes go to the browser engine and, with Live on, to the FM-1 */
const sink = {
  send(msg: HostMsg): void {
    // CC 16..19 from a MIDI controller turn Main's knobs: the rows of the device page in focus
    if (msg.t === 'cc' && msg.n >= 16 && msg.n <= 19) return editor.turnKnob(msg.n - 16, msg.v / 127);
    if (msg.t === 'on') host.mute(false);
    // a Steps card's step entry (#127, #135: a chord when the first key is let go); it sounds too. Running, the engine
    // records instead (live overdub)
    if (msg.t === 'on' && currentTab === 'patch' && !editor.playing) recordNote(msg.note, msg.vel);
    if (msg.t === 'off' && currentTab === 'patch') recordOff(msg.note);
    if (msg.t === 'on' || msg.t === 'off') editor.rollHeld(msg.note, msg.t === 'on');   // (the roll's keys light, the #136 follow-up)
    if (emuKeys(msg)) return;
    host.send(msg);
    piano.track(msg);
    hands.track(msg);
    if (msg.t === 'on') tutorial.noteOn();
    if (live() && !fromDevice) {   // (what the FM-1 played itself is not sent back)
      // (the keys of an armed device stay here: the FM-1 does not take the editor's arm yet, #139 / #191)
      if (!editor.armedSet.size) device.note(msg as { t: string; note?: number; vel?: number });
      if (msg.t === 'bend') device.bend(msg.v);
      else if (msg.t === 'cc') device.cc(msg.n, msg.v);
    }
  },
};
/** what the armed devices play (Editor onArm), for the status line */
let armPlays: string[] = [];
/** the status line while devices are armed (#134, #190) or a track records (#135): what the keys play and what REC does now */
function showArmed(): void {
  const id = editor.armedTrack;
  if (!editor.armedSet.size) return pinStatus(null, 'arm');
  if (id === null || editor.armedSet.size > 1 && !editor.recOn) {
    const list = armPlays.length ? armPlays.join(', ') : 'nothing yet';
    return pinStatus({ tag: `Armed: ${editor.armedSet.size}`, text: `Main’s keys play ${list}; only armed devices hear them.${id === null ? '' : ' Shift+R records on the armed track.'} ARM again to disarm.` }, 'arm');
  }
  const name = trackLabel(editor.patch, id);
  const hear = armPlays.length ? `heard through ${armPlays.join(', ')}` : 'which plays nothing yet: cable its keys out (or trig / pitch) to an instrument';
  if (!editor.recOn) return pinStatus({ tag: `Armed: ${name}`, text: `Main’s keys play ${name}, ${hear}. Shift+R records; ARM again gives Main its keys back.` }, 'arm');
  pinStatus({ tag: `Rec: ${name}`, text: editor.playing
    ? `live: play along, notes land on the nearest step; each pass overdubs and is one undo step. Shift+R stops.`
    : `step entry: play a note or a chord into the cursor’s step; Backspace a rest, Enter a tie, ← → move. Shift+R or Esc stops.` }, 'arm');
}
// the demo video's script (web/dev/demo) plays its riff through the sink as the keys do, also while a dialog is open
// (the letter keys stop then); the dev server only
if (import.meta.env.DEV) (window as unknown as { __notes?: typeof sink }).__notes = sink;

let refreshAssemblies: () => void = () => {};
/** the factory patches and the Patches page's own copies (the morph picker keeps those of the same structure; the palette loads any) */
// A/B is off for 1.0 (#103): nothing sets this, so Snapshot B is not offered as a B side until A/B returns
let snapshotCandidates: () => { name: string; patch: Patch }[] = () => [];
/** (`like`: only a factory patch of its shape is built, presets.ts shapeOf; the others could not be of its structure) */
const patchCandidates = (like?: Patch): { name: string; patch: Patch }[] => {
  const seen = new Set<string>();
  const out: { name: string; patch: Patch }[] = [];
  const shape = like && shapeOf(like);
  const wanted = (name: string): boolean => !shape || factoryShape(name) === shape;
  for (const c of [...snapshotCandidates(), ...savedPatches(), ...bankPatches(wanted), ...Object.entries(PRESETS).filter(([name]) => wanted(name)).map(([name, make]) => ({ name, patch: make() }))])
    if (!seen.has(c.name)) {
      seen.add(c.name);
      out.push(c);
    }
  return out;
};
// Scope modules' screens: they stream while on screen and audio runs
const screens = new ScopeScreens((msg) => host.send(msg), () => host.running && !host.muted);
host.onView = (key, chans, sr, voices) => screens.receive(key, chans, sr, voices);
// envelope shapes: drags edit through the editor (made below; used only after it exists)
const envs = new EnvScreens((msg) => host.send(msg), () => host.running && !host.muted, {
  set: (id, name, v) => editor.setParam(id, name, v),
  begin: () => editor.beginEdit(),
  limits: (type, name) => { const pd = DEFS[type].params.find((q) => q.name === name)!; return { min: pd.min, max: pd.max, def: pd.default }; },
});
host.onEnv = (key, states) => envs.receive(key, states);
host.onSteps = (view, pats) => editor.showSteps(view, pats);
host.onRecorded = (took) => editor.recorded(took);
/** the sidebar's sliders whose thumbs are jacks (cable slack, zoom): see sideSlider below; filled once the editor exists */
const sides = new Map<SideKey, SideSlider>();
/** the zoom slider's setting (the user's zoom; a source adds to it) */
let zoomBase = 1;
/** the computer keyboard's octave (noteKeys), mirrored here because the editor's events run before noteKeys exists */
let keyOctave = 0;
/** the patch remembers the keyboard's octave (Patch.octave); undo / redo bring back older snapshots, so stamp it again */
const stampOctave = (p: Patch): boolean => {
  if ((p.octave ?? 0) === keyOctave) return false;
  if (keyOctave) p.octave = keyOctave;
  else delete p.octave;
  return true;
};
// the FM-1 tab's emulator (see "the FM-1 tab" below): made before the editor, whose first events reach it
/** the note each pill key started (the octave may change while it is held) */
const pillNote = new Map<number, number>();
/** the MASTER knob's level, kept per browser; it sets the output only while the FM-1 tab shows */
const MASTER_KEY = 'matryoshka.fm1-master';
const emuMaster = ((): number => { try { const v = Number(localStorage.getItem(MASTER_KEY)); return localStorage.getItem(MASTER_KEY) !== null && v >= 0 && v <= 1 ? v : 1; } catch { return 1; } })();
let emuLevel = emuMaster;
const emu = new Fm1View($('fm1-view'), `${import.meta.env.BASE_URL}fm1-ui.wasm`, {
  focus: (d, g) => fm1Event({ kind: 'focus', device: d, page: g }, 'emu'),
  param: (m, p, v) => fm1Event({ kind: 'param', module: m, param: p, value: v / 65536 }, 'emu'),
  preset: (d) => stepOpenList(d),
  save: () => saveCurrent(),
  transport: (run) => {
    fromEmu = true;
    try { setPlaying(run); } finally { fromEmu = false; }
  },
  track: (m, notes, pat) => fm1Event({ kind: 'track', module: m, notes, pat }, 'emu'),
  pattern: (p, song) => fm1Event({ kind: 'pattern', pattern: p, song }, 'emu'),
  song: (k, entries) => fm1Event({ kind: 'song', song: k, entries }, 'emu'),
  mute: (m, on) => fm1Event({ kind: 'mute', module: m, on }, 'emu'),
  // REC held + a black key on the emulated FM-1 (#139): the editor arms the same track, so the keys the page plays (the
  // emulator's MIDI out) go through it as they do on the device
  arms: (lo, hi) => editor.setArmed(armedFromMask(editor.patch, lo, hi)),
  key: (k, down) => {                        // a pill key: the note at the emulated octave, through the sink (it sounds, and the emulator hears it)
    if (down) {
      const note = 53 + k + 12 * emu.octave;
      if (note < 0 || note > 127) return;
      pillNote.set(k, note);
      sink.send({ t: 'on', note, vel: 0.8 });
    } else {
      const note = pillNote.get(k);
      pillNote.delete(k);
      if (note !== undefined) sink.send({ t: 'off', note });
    }
  },
  master: (v) => { emuLevel = v; host.setMaster(v); try { localStorage.setItem(MASTER_KEY, String(v)); } catch { /* private mode */ } },
  used: () => { if (!host.running) void startAudio(); },
}, emuMaster);
emu.onReady = () => emuLoad();
/** another patch opened (the emulator's focus starts at its first device) */
let emuFresh = true;
/** the name of the last patch the emulated FM-1 took (a refused one leaves it showing) */
let emuLoaded = '';
let emuTimer = 0;
const emuHeld = new Set<number>();
const emuSwallowed = new Set<number>();
const editor = new Editor($('canvas'), loadSaved() ?? starterPatch(), {
  onStructure(p) {
    stampOctave(p);
    $<HTMLInputElement>('patch-name').value = p.name;
    syncSides();
    host.setPatch(p);
    queueSave(p);
    showBudget();
    if (live()) queueUpload();
    queueEmu();
  },
  onAtt(id, index, value) {
    host.send({ t: 'att', id, index, value });
    queueEmu();
    queueSave(editor.patch);
    if (live() && !uploading) device.att(editor.patch, id, index, value);
    else if (live()) dirty = true;
  },
  onParam(id, name, value) {
    host.send({ t: 'param', id, name, value });
    envs.changed();
    if (name === 'len') editor.refreshSteps(id);   // (a Steps module's grid follows its length)
    queueSave(editor.patch);
    if (editor.patch.modules.find((m) => m.id === id)?.type === ALLOC) {
      // a Voice allocator's setting changes the poly groups: the FM-1 takes the whole patch again
      showBudget();
      if (live() && !fromDevice) queueUpload();   // (from the FM-1: it changed its group itself)
      queueEmu();
      return;
    }
    // a parameter with a browser-only stretch (the Delay's time past 520 ms) can take the patch over the FM-1 budget or
    // back under it: the budget first, so Live pauses before the value would go out (and sends the patch again once it fits)
    const pd = DEFS[editor.patch.modules.find((m) => m.id === id)?.type ?? '']?.params.find((q) => q.name === name);
    if (pd?.browserMax !== undefined && (browserOnly(editor.patch).length > 0) === fitsDevice) {
      const was = fitsDevice;
      showBudget();
      if (!was && fitsDevice && live() && !fromDevice) queueUpload();
    }
    if (!fromEmu) emuParam(id, name, value);
    if (fromDevice) return;
    if (live() && !uploading) device.param(editor.patch, id, name, value);
    else if (live()) dirty = true;
  },
  onTrack(id, notes, pat) {
    host.send({ t: 'track', id, notes, pat });
    if (!fromEmu) queueEmu();
    queueSave(editor.patch);
    if (fromDevice) return;
    if (live() && !uploading) device.track(editor.patch, id, notes, pat);
    else if (live()) dirty = true;
  },
  onPattern(pattern, song) {   // (#375) the patch's pattern / song: each track takes it at the end of its pass
    host.send({ t: 'pattern', p: pattern });
    host.send({ t: 'song', n: song });
    if (!fromEmu) queueEmu();
    queueSave(editor.patch);
    if (fromDevice) return;
    if (live() && !uploading) device.pattern(pattern, song);
    else if (live()) dirty = true;
  },
  onSong(k, entries) {
    host.send({ t: 'songs', songs: editor.songs() });
    if (!fromEmu) queueEmu();
    queueSave(editor.patch);
    if (fromDevice) return;
    if (live() && !uploading) device.song(k, entries);
    else if (live()) dirty = true;
  },
  onArm(armed, plays) {
    host.send({ t: 'arm', devices: armed });
    emuArm();
    armPlays = plays;
    showArmed();
  },
  onRec(id, on) {
    host.send({ t: 'rec', id, on });
    showArmed();
  },
  onThru(id, note, vel) {
    host.mute(false);
    host.send({ t: 'thru', id, note, vel });
  },
  onMute(id, on) {
    host.send({ t: 'mute', id, on });
    if (live() && !uploading) device.mute(editor.patch, id, on);
  },
  onBypass(id, on) {
    host.send({ t: 'bypass', id, on });
    queueEmu();
    tutorial.bypassed();
    queueSave(editor.patch);
    if (live() && !uploading) device.bypass(editor.patch, id, on);
    else if (live()) dirty = true;
  },
  onRange(id, index, name, range) {
    host.send({ t: 'range', id, index, name, range });
    queueEmu();
    queueSave(editor.patch);
    if (live() && !uploading) device.range(editor.patch, id, index, name, range);
    else if (live()) dirty = true;
  },
  onTransport(on) {
    setPlaying(on);
  },
  onFocus(key, page) {
    const at = live() || emu.ui ? binaryPage(editor.patch, key, page) : null;
    if (at && live()) device.focus(at[0], at[1]);
    if (at && !fromEmu) emu.ui?.focus(at[0], at[1]);
  },
  onButton(i, on) {
    host.send({ t: 'button', i, on });
    // the FM-1 takes CC 80..86 as presses (127) and releases (0) of its patch buttons: a switch is one press
    if (!live() || fromDevice) return;
    const toggles = switches(editor.patch.modules.find((m) => m.type === 'fm1')?.panel, PANEL_BUTTONS[i]);
    if (toggles) { device.cc(80 + i, 127); device.cc(80 + i, 0); }
    else device.cc(80 + i, on ? 127 : 0);
  },
  onScreens(list, envList) {
    screens.sync(list);
    envs.sync(envList);
  },
  onLayout(p) {
    queueSave(p);
    syncSides();
  },
  onError(msg) {
    status.textContent = msg;
  },
  onSaveAssembly(def) {
    // a name already in the library is replaced at once, with Undo (#218: no confirm for what the browser keeps)
    const { result, undo } = storeAssembly(def);
    status.textContent = `"${def.name}" ${result === 'replaced' ? 'replaced in' : 'saved to'} the assembly library`;
    if (result === 'replaced') showUndo(`"${def.name}" replaced in your assemblies`, () => { undo(); refreshAssemblies(); tutorial.refresh(); });
    refreshAssemblies();
    tutorial.saved(def);
    tutorial.refresh();
  },
  onLoad(p) {
    emuFresh = true;
    noteKeys.set(p.octave ?? 0); // a patch opens in the octave it was last played in
  },
  onHistory(kind) {
    if (kind === 'undo') tutorial.undone();
    else tutorial.redone();
  },
  morphCandidates: patchCandidates,
}, $('dock'));
// the wheels stand beside the keyboard, each under its output's jack; the octave buttons under the dock's outputs
editor.wheelHost = $('wheels');
editor.dockWheels = hands.wheels;
editor.dockOctave = piano.octaveControls;
// the transport's Play switch, under the tempo in Main's clock column (kept across redraws; the id is the tutorial's target)
const arpBtn = document.createElement('button');
arpBtn.id = 'arp-btn';
arpBtn.type = 'button';
arpBtn.textContent = 'Play';
arpBtn.title = 'Transport: Main\u2019s run output and its clock (Space)';
arpBtn.setAttribute('aria-label', 'Transport play');
arpBtn.setAttribute('aria-pressed', 'false');
editor.dockPlay = arpBtn;
initStatusline($('statusline'));
editor.rebuild();
showBudget();
host.setPatch(editor.patch);
const tutorial = new Tutorial({
  editor,
  audioOn: () => host.running && !host.muted,
  mute: (on) => host.mute(on),
  startAudio: () => startAudio(),
  preview: (p) => host.setPatch(p ?? editor.patch),
  load: (p) => { sink.send({ t: 'panic' }); loadNamed(p, { quiet: true }); },
  note: (on, note = 60, vel = 0.8) => sink.send(on ? { t: 'on', note, vel } : { t: 'off', note }),
  library: loadLibrary,
  saveAssembly: (def) => {
    storeTutorialAssembly(def);
    refreshAssemblies();
    status.textContent = `"${def.name}" saved to the assembly library`;
  },
  snapshot: (side) => takeSnapshot(side),
  flipAB: () => flipAB(),
  share: () => sharePatch(),
  arpPlay: (on) => setPlaying(on),
  bypass: (id, on) => { const m = editor.patch.modules.find((m) => m.id === id); if (!m) return; if (on) m.bypass = true; else delete m.bypass; host.send({ t: 'bypass', id, on }); tutorial.bypassed(); editor.rebuild(); queueSave(editor.patch); },
  bankSave: addToBank,
  rename: (name) => { editor.patch.name = name; nameInput.value = name; queueSave(editor.patch); },
  status: (msg) => { status.textContent = msg; },
});
editor.onZoom = (z, live) => {
  if (live) return;
  zoomBase = z;          // the user's zoom is the zoom slider's setting
  if (!editor.restoring) tutorial.zoomed(); // a patch opening at its own zoom is not a zoom gesture
  showSide('zoomFrom');
};
host.onValues = (values) => {
  editor.showParameterValues(values);
  envs.values(values);
};

// Sidebar
setupPopoverPositioning();
const presetSel = $<HTMLSelectElement>('preset');
/** the Open picker: Your patches (rebuilt on every save, and when a community patch is added or removed) and the factory
 *  patches (catalog.ts), each row with its chip, FM-1 · NN % or SANDBOX. Where the browser draws a select's options itself
 *  (appearance: base-select) the chip is a pill at the row's end; elsewhere the row reads "name — chip". Working a chip
 *  out costs the patch's whole FM-1 budget, so the rows are listed at once and their chips are worked out after, a few at a
 *  time while the page is idle, and every one still missing the moment the picker is focused or pressed (before it opens) */
let chipsDue: { slot: HTMLSpanElement; chip: () => Chip }[] = [];
const drawChip = ({ slot, chip }: { slot: HTMLSpanElement; chip: () => Chip }): void => slot.replaceWith(chipEl(chip()));
const chipsNow = (): void => { const due = chipsDue; chipsDue = []; due.forEach(drawChip); };
let chipsQueued = false;
const chipsWhenIdle = (): void => {
  if (chipsQueued || !chipsDue.length) return;
  chipsQueued = true;
  const step = (deadline?: IdleDeadline): void => {
    chipsQueued = false;
    do { const next = chipsDue.shift(); if (next) drawChip(next); } while (chipsDue.length && deadline && deadline.timeRemaining() > 4);
    chipsWhenIdle();
  };
  if ('requestIdleCallback' in window) requestIdleCallback(step, { timeout: 4000 });
  else setTimeout(step, 50);
};
presetSel.addEventListener('focus', chipsNow);
presetSel.addEventListener('pointerdown', chipsNow);
const fillPicker = (): void => {
  chipsDue = [];
  presetSel.replaceChildren(
    new Option('Open a patch…', ''),
    ...openableGroups().map(({ label, items }) => {
      const g = document.createElement('optgroup');
      g.label = label;
      g.append(...items.map((o) => {
        const opt = new Option('', o.value);
        const name = document.createElement('span');
        name.className = 'o-name';
        name.textContent = `${o.xl ? '└ ' : ''}${o.name}`;
        if (o.author) {
          const by = document.createElement('span');
          by.className = 'o-by';
          by.textContent = ` · ${o.author}`;
          name.append(by);
        }
        const sep = document.createElement('span');
        sep.className = 'o-sep';
        sep.textContent = ' — ';
        const slot = document.createElement('span');
        chipsDue.push({ slot, chip: o.chip });
        opt.append(name, sep, slot);
        return opt;
      }));
      return g;
    }),
  );
  if (document.activeElement === presetSel) chipsNow();
  else chipsWhenIdle();
};
fillPicker();
onSavedChange(() => { unlinkSaved(savedPatches().map((e) => e.name)); fillPicker(); });
onAddedChange(fillPicker);
void inlineWordmarks(); // the sidebar's wordmark in the theme's colours
presetSel.onchange = () => {
  const o = openableByValue(presetSel.value);
  if (o) { loadNamed(o.load(), { from: o.from }); closeSidebar(); }
  presetSel.value = '';
};
/** delete one of Your patches at once, with an Undo toast instead of a question (Library rows, the trash icon) */
function deleteSaved(name: string): void {
  const gone = removeSaved(name);
  if (!gone) return;
  showUndo(`"${name}" deleted from Your patches`, () => {
    status.textContent = restoreSaved(gone) ? `"${name}" is back in Your patches` : `"${name}" was saved again since: the deleted copy was not put back`;
  });
}
const nameInput = $<HTMLInputElement>('patch-name');
nameInput.value = editor.patch.name;
nameInput.oninput = () => {
  editor.patch.name = nameInput.value;
  queueSave(editor.patch);
};
const saveBtn = $<HTMLButtonElement>('save-patch-btn');
/** keep the open patch in Your patches (saved.ts) under its name */
const saveCurrent = (): void => {
  if (!editor.patch.name.trim()) {
    nameInput.focus();
    status.textContent = 'name the patch first, then save';
    return;
  }
  const { msg, ok, replaced } = keepPatch(editor.patch);
  status.textContent = msg;
  // a save over another patch of that name offers Undo; over the copy the patch was opened from it is the expected save (#148)
  const before = openedFrom;
  if (replaced && replaced.name !== openedFrom) {
    showUndo(`"${replaced.name}" replaced in Your patches`, () => {
      openedFrom = before;
      status.textContent = putBackSaved(replaced) ? `the earlier "${replaced.name}" is back in Your patches` : `"${replaced.name}" could not be put back: the browser refused the storage`;
    });
  }
  if (ok) openedFrom = editor.patch.name.trim();
  saveBtn.classList.add('saved');
  setTimeout(() => saveBtn.classList.remove('saved'), 900);
};
saveBtn.onclick = saveCurrent;
$('share-patch-btn').onclick = () => shareSheet.open();
// the patch menu (#152): the PATCH panel's ⋯ (beside New patch) and the mobile bar's Patch ⋯ reach what moves a patch in or out of the
// browser without the palette. Its results also show in a toast: the status line is narrow on a phone, and the FM-1
// answers in the FM-1 & MIDI dialog (#dev-status), which is closed.
const toastResult = (run: () => unknown) => async (): Promise<void> => {
  const records: MutationRecord[] = [];
  const seen = new MutationObserver((r) => records.push(...r));
  for (const el of [status, $('dev-status')]) seen.observe(el, { childList: true, characterData: true, subtree: true });
  try {
    await run();
  } finally {
    records.push(...seen.takeRecords());
    seen.disconnect();
    const last = records.at(-1)?.target;
    const text = last?.textContent?.trim();
    if (text) showToast(text);
  }
};
const patchMenu = (): MenuItem[] => {
  const name = editor.patch.name.trim();
  const items: MenuItem[] = [
    { text: 'Share\u2026', run: () => shareSheet.open() },
    { text: 'Save as .json', run: () => savePatch() },
    { text: 'Load .json\u2026', run: () => $('load-file').click() },
    { text: 'Store to an FM-1 slot\u2026', run: toastResult(() => storeToSlot()) },
    { text: 'FM-1 & MIDI settings\u2026', run: () => $<HTMLDialogElement>('device-bar').showModal(), rule: true },
  ];
  // only while the open patch's name is one of Your patches; the open patch stays open
  if (name && isSaved(name)) items.push({ text: 'Delete from Your patches', run: () => deleteSaved(name), danger: true, rule: true });
  return items;
};
for (const id of ['patch-menu-btn', 'mobile-patch-menu']) {
  const btn = $<HTMLButtonElement>(id);
  btn.onclick = () => popMenu(patchMenu(), btn);
}
/** the FM-1 budget meter at the right of the status line: memory (the fullest limit) and CPU as bars; open, a card above the deck with every limit and the costliest modules */
/** a meter row: name, bar, percent; `near` / `over` colour it */
function meterRow(row: Element, name: string, frac: number, text: string): void {
  row.classList.toggle('over', frac > 1);
  row.classList.toggle('near', frac <= 1 && frac > CPU_WARN);
  row.querySelector('.budget-name')!.textContent = name;
  (row.querySelector('.budget-bar > span') as HTMLElement).style.width = `${Math.min(100, Math.round(frac * 100))}%`;
  row.querySelector('.budget-pct')!.textContent = text;
}

/** a line of the open meter: name, a small bar, the figure; `warn`: colour it when nearly full (not a one-slot line: the patch's one
 * delay fills it, which is fine) */
function budgetLine(name: string, frac: number, figure: string, title = '', warn = true): HTMLElement {
  const row = document.createElement('div');
  row.className = 'budget-item' + (frac > 1 ? ' over' : warn && frac > CPU_WARN ? ' near' : '');
  row.title = title;
  const n = document.createElement('span');
  n.textContent = name;
  const bar = document.createElement('span');
  bar.className = 'budget-mini';
  const fill = document.createElement('span');
  fill.style.width = `${Math.min(100, Math.round(frac * 100))}%`;
  bar.append(fill);
  const f = document.createElement('span');
  f.textContent = figure;
  row.append(n, bar, f);
  return row;
}

function showBudget(): void {
  const b = deviceBudget(editor.patch);
  const was = fitsDevice;
  fitsDevice = b.fits;
  syncChip();
  const el = $('budget');
  el.classList.toggle('over', !b.fits);
  const memOver = b.over.filter((i) => i.key !== 'cpu' && i.key !== 'browser');
  const fullest = memOver[0] ?? b.fullest;
  const [mem, cpu] = el.querySelectorAll('.budget-row');
  meterRow(mem, 'MEM', memOver.length ? 1.01 : b.memory, memOver.length ? 'over' : `${Math.round(b.memory * 100)} %`);
  meterRow(cpu, 'CPU', b.cpu.use, `${Math.round(b.cpu.use * 100)} %`);
  el.querySelector('summary')!.title = b.fits
    ? `Fits the FM-1. Memory: the fullest limit (${fullest?.label ?? 'none'}) is ${Math.round(b.memory * 100)} % used. CPU: about ${Math.round(b.cpu.use * 100)} % of the audio time, an estimate. Open for the details.`
    : `Over the FM-1 budget (${b.over.map((i) => i.label).join(', ')}): it plays here in the browser, the FM-1 cannot ${b.over.some((i) => i.key === 'cpu') ? 'keep up with' : 'load'} it.`;
  const list = el.querySelector('.budget-list')!;
  const head = (text: string): HTMLElement => {
    const h = document.createElement('div');
    h.className = 'budget-head';
    h.textContent = text;
    return h;
  };
  const block = CPU.cyclesPerUs * CPU.blockUs;
  const costly = b.cpu.modules.slice(0, 6).map((m) => {
    const mod = editor.patch.modules.find((x) => x.id === m.id)!;
    const name = moduleName(m.type, DEFS[m.type].label) + (m.copies > 1 ? ` ×${m.copies}` : '');
    const line = budgetLine(name, m.cycles / block, `${(100 * m.cycles / block).toFixed(1)} %`, 'Select it');
    line.classList.add('pick');
    line.addEventListener('click', () => editor.reveal(mod.id));
    return line;
  });
  list.replaceChildren(
    head('Memory'),
    ...b.items.filter((i) => i.used > 0).map((i) => budgetLine(i.label, i.used / i.max, `${i.used} / ${i.max}`, '', i.max > 1)),
    head('CPU, estimated'),
    ...costly,
    ...(b.over.some((i) => i.key === 'browser') ? [head('Browser only'), ...b.over.filter((i) => i.key === 'browser').map((i) => budgetLine(i.label, 1.01, 'over', '', false))] : []),
  );
  const note = document.createElement('p');
  note.className = 'muted';
  note.textContent = b.fits
    ? 'The CPU figure is an estimate: counted on a model of the FM-1\'s processor, calibrated on the factory patches measured on the FM-1. Treat anything above 80 % as tight.'
    : 'A sandbox patch: it plays here in the browser with no FM-1 limits. It goes to the FM-1 once it fits under the bars; Library > Patches marks it SANDBOX.';
  list.append(note);
  showSandbox(b);
  if (was && !b.fits && device.connected) devStatus('over the FM-1 budget: Live paused until the patch fits');
  requestAnimationFrame(placeBudget);
}
// a sandbox patch (over the FM-1 budget, sandbox.ts): the status line's gold SANDBOX pill and its plain words; the first
// time in this browser the "No limits here" card shows, afterwards the pill opens it
function sandboxCard(): void {
  showSandboxCard({ costs: () => { ($('budget') as HTMLDetailsElement).open = true; } });
}
function showSandbox(b: ReturnType<typeof deviceBudget>): void {
  const pill = $<HTMLButtonElement>('sandbox-pill');
  pill.hidden = b.fits;
  pill.onclick = sandboxCard;
  pinStatus(b.fits ? null : { tag: '', text: sandboxWords(b), more: { label: 'What sandbox means', run: sandboxCard } });
  // after this turn, so a card the page load shows (the tutorial's welcome, what's new) is up first: the sandbox card does
  // not go over another card, and waits for the next sandbox patch
  if (!b.fits && sandboxCardDue()) setTimeout(() => { if (sandboxCardDue() && !document.querySelector('.tutorial-offer')) sandboxCard(); });
}
// the open budget is a card above the status line, over the meter; a
// click elsewhere or Escape closes it
const budgetEl = $('budget') as HTMLDetailsElement;
function placeBudget(): void {
  const budgetEl = $('budget') as HTMLDetailsElement;
  if (!budgetEl.open) return;
  const list = budgetEl.querySelector<HTMLElement>('.budget-list')!;
  const r = budgetEl.getBoundingClientRect();
  list.style.left = `${Math.max(8, Math.min(innerWidth - list.offsetWidth - 8, r.left + r.width / 2 - list.offsetWidth / 2))}px`;
}
budgetEl.addEventListener('toggle', placeBudget);
addEventListener('resize', placeBudget);
document.addEventListener('pointerdown', (e) => {
  if (budgetEl.open && !budgetEl.contains(e.target as Node)) budgetEl.open = false;
});
addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && budgetEl.open) budgetEl.open = false;
}, true);
const browser = new AssemblyBrowser((d) => { toPatch(); editor.insert(d); });

// ---- diff against the baseline (the patch as last loaded, uploaded or stored) and A / B
let baseline = JSON.stringify(editor.patch);
const setBaseline = (): void => {
  baseline = JSON.stringify(editor.patch);
};
const diffPanel = $('diff');
const showDiff = (): void => {
  const d = diffPatches(JSON.parse(baseline) as Patch, editor.patch, DEFS);
  const lines = diffLines(d);
  diffPanel.replaceChildren();
  const h = document.createElement('h3');
  h.textContent = lines.length ? `${lines.length} change${lines.length === 1 ? '' : 's'} since the last load / upload` : 'no changes since the last load / upload';
  const x = document.createElement('button');
  x.textContent = '×';
  x.onclick = () => (diffPanel.hidden = true);
  h.append(x);
  const ul = document.createElement('ul');
  const cls = (s: string): string => (s.startsWith('+') ? 'add' : s.startsWith('−') ? 'rm' : s.includes(' → ') && !s.includes(':') ? 'o' : 'p');
  for (const s of lines) {
    const li = document.createElement('li');
    li.className = cls(s);
    li.textContent = s;
    ul.append(li);
  }
  diffPanel.append(h, ul);
  diffPanel.hidden = false;
};
// A/B is off for 1.0 (#103): only the tutorial host still calls these; #103 restores the palette rows and Alt+B
const takeSnapshot = (side: 'A' | 'B'): void => {
  editor.takeSnapshot(side);
  editor.rebuild();
  status.textContent = `${side} = this patch`;
};
const flipAB = (): void => {
  if (editor.toggleAB()) {
    tutorial.flipped();
    status.textContent = `${editor.side}${diffCount(diffPatches(JSON.parse(editor.snapshots[editor.side === 'A' ? 'B' : 'A']!) as Patch, editor.patch, DEFS)) ? '' : ' (same as the other side)'}`;
    queueSave(editor.patch);
  } else status.textContent = 'set A and B first';
};

// ---- the command palette: modules, assemblies, patches
const palette = $<HTMLDialogElement>('palette');
const palInput = $<HTMLInputElement>('palette-input');
const palList = $('palette-list');
const inPatch = (run: () => void): (() => void) => () => { toPatch(); run(); };
const commands = (): Command[] => {
  const assembly = (d: AssemblyDef, shelf: string): Command => ({
    kind: 'assembly', tags: ['assembly', ...(defIsEngine(d) ? ['engine'] : []), shelf], label: d.name, detail: d.blurb ? `${d.blurb} · ${shelf}` : shelf, keywords: `insert ${d.blurb ?? ''} ${summary(d)}`,
    run: () => editor.insert(d),
  });
  return [
    { kind: 'command', label: 'Save patch', keywords: 'keep store your patches', run: saveCurrent },
    { kind: 'command', label: 'Save patch as .json', keywords: 'export download file', run: savePatch },
    { kind: 'command', label: 'Load patch from .json', keywords: 'import open file', run: () => $('load-file').click() },
    { kind: 'command', label: 'Export presets as .json', detail: 'your presets library', keywords: 'download file backup library device', run: () => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([JSON.stringify(exportPresets(), null, 1)], { type: 'application/json' }));
      a.download = 'matryoshka-presets.json';
      a.click();
      URL.revokeObjectURL(a.href);
    } },
    { kind: 'command', label: 'Import presets from .json', keywords: 'load file library device', run: () => $('load-file').click() },
    { kind: 'command', label: 'Save browser backup', detail: 'everything this browser keeps here, as .json', keywords: 'export download file backup patches bank library settings move', run: saveBrowserBackup },
    { kind: 'command', label: 'Import browser backup', detail: 'a backup .json', keywords: 'restore migrate moved glvno github pages patches bank library', run: () => $('load-file').click() },
    ...(onPagesDev() ? [{ kind: 'command' as const, label: 'Move to matryoshka.lol', detail: 'your patches, bank, library and settings', keywords: 'migrate moved address domain pages.dev bring', run: () => move.open() }] : []),
    { kind: 'command', label: 'Share patch\u2026', keywords: 'link copy url clipboard reddit post card notes', run: () => shareSheet.open() },
    { kind: 'command', label: 'Save patch card (PNG)', keywords: 'image picture share post export download', run: () => void saveCard() },
    { kind: 'command', label: 'Tutorial', keywords: 'learn help starter tour chapters course', run: () => { toPatch(); tutorial.open(); } },
    { kind: 'command', label: 'New patch', keywords: 'engine start empty', run: () => startNew() },
    { kind: 'command', label: 'Undo', detail: 'Ctrl/Cmd+Z', run: inPatch(() => editor.undo()) },
    { kind: 'command', label: 'Redo', detail: 'Shift+Ctrl/Cmd+Z', run: inPatch(() => editor.redo()) },
    { kind: 'command', label: 'Make assembly from the selection', detail: 'Ctrl/Cmd+G', run: inPatch(() => editor.makeAssembly()) },
    { kind: 'command', label: 'Browse assembly library', run: () => browser.open() },
    { kind: 'command', label: 'Select all', detail: 'Ctrl/Cmd+A', keywords: 'everything modules assemblies', run: inPatch(() => editor.selectAll()) },
    { kind: 'command', label: 'Duplicate selection', detail: 'Ctrl/Cmd+D', run: inPatch(() => editor.duplicateSelected()) },
    { kind: 'command', label: 'Copy selection', detail: 'Ctrl/Cmd+C', keywords: 'clipboard', run: inPatch(() => copySelection()) },
    { kind: 'command', label: 'Cut selection', detail: 'Ctrl/Cmd+X', keywords: 'clipboard', run: inPatch(() => copySelection() && editor.removeSelected()) },
    { kind: 'command', label: 'Paste', detail: 'Ctrl/Cmd+V', keywords: 'clipboard', run: inPatch(() => void pasteFromPalette()) },
    { kind: 'command', label: 'Delete selection', detail: 'Delete', run: inPatch(() => editor.removeSelected()) },
    { kind: 'command', label: 'Bypass selection', detail: 'B', run: inPatch(() => editor.bypassSelected()) },
    { kind: 'command', label: 'Show changes since last load / upload', keywords: 'diff', run: inPatch(showDiff) },
    { kind: 'command', label: 'Start audio', keywords: 'sound browser', run: () => void startAudio() },
    { kind: 'command', label: 'Panic: stop all notes', keywords: 'silence stuck', run: panic },
    { kind: 'command', label: 'FM-1 & MIDI settings', keywords: 'connect send store sync hardware keyboard release', run: () => $<HTMLDialogElement>('device-bar').showModal() },
    { kind: 'command', label: 'Install firmware', keywords: 'flash update hardware matryoshka return stock official v15', run: () => openInstall() },
    { kind: 'command', label: 'About Matryoshka', keywords: 'credits support ko-fi donate ai usage transparency', run: () => void about.open() },
    { kind: 'command', label: 'Keyboard shortcuts', keywords: 'help', detail: '?', run: () => help.showModal() },
    { kind: 'command', label: currentTheme() === 'dark' ? 'Theme: light' : 'Theme: dark', keywords: 'theme dark light mode colours colors night day appearance', run: () => toggleTheme() },
    ...(themeChoice() ? [{ kind: 'command' as const, label: 'Theme: follow the system', keywords: 'theme dark light mode auto os appearance', run: () => setTheme(null) }] : []),
    { kind: 'command', label: 'Browse community patches', keywords: 'community shared players reddit add library others', run: () => setLibrarySection('community') },
    { kind: 'command', label: 'Open the demo patch', keywords: 'demo example song listen play showcase', run: () => openDemo() },
    { kind: 'command', label: 'Collapse / expand the sidebar', keywords: 'hide show side panel rail more room', detail: 'Ctrl/Cmd+B', run: () => toggleSidebarCollapsed() },
    { kind: 'command', label: 'Expand all assemblies', keywords: 'open frames nested show inside', run: inPatch(() => editor.setAllOpen(true)) },
    { kind: 'command', label: 'Collapse all assemblies', keywords: 'close frames nested cards fold', run: inPatch(() => editor.setAllOpen(false)) },
    { kind: 'command', label: 'Tidy up the canvas', keywords: 'clean up arrange align layout grid', run: inPatch(() => editor.tidyUp()) },
    { kind: 'command', label: 'Cable slack: none', keywords: 'slack sag tight straight', run: inPatch(() => setSlack(0)) },
    { kind: 'command', label: 'Cable slack: half', keywords: 'slack sag droop hang loose', run: inPatch(() => setSlack(0.5)) },
    { kind: 'command', label: 'Cable slack: full', keywords: 'slack sag droop hang heavy', run: inPatch(() => setSlack(1)) },
    ...(editor.patch.slackFrom ? [{ kind: 'command' as const, label: 'Cable slack: unplug its input', keywords: 'slack sway modulate', run: inPatch(() => editor.setSideSource('slackFrom', null)) }] : []),
    ...(editor.patch.zoomFrom ? [{ kind: 'command' as const, label: 'Zoom: unplug its input', keywords: 'zoom modulate', run: inPatch(() => editor.setSideSource('zoomFrom', null)) }] : []),
    { kind: 'command', label: 'Fit patch to screen', keywords: 'zoom view', run: inPatch(() => editor.zoomToFit()) },
    { kind: 'command', label: 'Store to an FM-1 slot\u2026', keywords: 'bank flash save device', run: () => void storeToSlot() },
    { kind: 'command', label: 'Reset canvas scale', keywords: 'zoom 100%', run: inPatch(() => editor.setZoom(1)) },
    // the same lists as + Add module, the assembly browser and the Open picker (catalog.ts)
    ...addableModules(DEFS).map((m) => ({ kind: 'add module', tags: ['module'], label: m.name, keywords: m.def.label, run: () => editor.add(m.type) })),
    ...assemblyShelves().filter((a, i, all) => all.findIndex((b) => b.def === a.def) === i).map((a) => assembly(a.def, a.shelf)), // the drum kit once
    ...openableGroups().flatMap((g) => g.items.map((o) => ({ kind: 'load patch', label: o.author ? `${o.name} · ${o.author}` : o.name, detail: g.label, run: () => loadNamed(o.load(), { from: o.from }) }))),
  ];
};
/**
 * Open a patch in the editor (every load of the user's goes through here). `from`: the Your patches name it came from;
 * `once`: it cannot be opened again as it is (a share link, an Undo's patch); `stay`: keep the current tab; `quiet`: no
 * Undo (the tutorial, the lesson editor, an Undo itself). A load over a patch with unsaved changes offers Undo (#148).
 */
const loadNamed = (p: Patch, o: { from?: string; once?: boolean; stay?: boolean; quiet?: boolean } = {}): void => {
  const prev = structuredClone(editor.patch);
  const prevFrom = openedFrom;
  const chained = loadUndo?.open() && loadUndo.loaded === asLoaded(prev) ? loadUndo : null;
  const losing = !chained && losesWork(prev);
  if (!o.stay) toPatch();
  editor.setPatch(p);
  setBaseline();
  nameInput.value = editor.patch.name;
  openedFrom = o.from ?? '';
  lastLoad = { patch: asLoaded(editor.patch), reopen: !o.once };
  loadUndo = null;
  if (!feedsOutput(editor.patch)) status.textContent = 'Nothing makes sound yet. Add an engine, then play a key.';
  if (o.quiet || !(chained || losing)) return;
  const back = chained ?? { prev, prevFrom };
  const name = back.prev.name.trim() || 'Untitled';
  const open = showUndo(`Opened "${editor.patch.name}". "${name}" was not saved`, () => {
    loadNamed(back.prev, { from: back.prevFrom, once: true, stay: o.stay, quiet: true });
    status.textContent = `"${name}" is back`;
  });
  loadUndo = { prev: back.prev, prevFrom: back.prevFrom, loaded: lastLoad.patch, open };
};
/** the Your patches name the open patch was opened from (or last saved as): saving over that copy offers no Undo (#148) */
let openedFrom = unsavedChanges(editor.patch, savedPatches()) ? '' : editor.patch.name.trim();
/** the last load that offered an Undo: the patch before it, and what it put in the editor. A load right after it (the
 *  PRESET knob turning on) keeps offering the patch before the first, while the toast shows and nothing was edited */
let loadUndo: { prev: Patch; prevFrom: string; loaded: string; open: () => boolean } | null = null;
/** the open patch as it was loaded, and whether it can be opened again (all but a share link and an Undo's patch): left
 *  unedited, a load over it loses nothing */
let lastLoad: { patch: string; reopen: boolean } | null = null;
const asLoaded = (p: Patch): string => JSON.stringify({ ...p, view: undefined, octave: undefined });
/** a load over `p` would lose work: it has unsaved changes, and is not an unedited patch that can be opened again */
const losesWork = (p: Patch): boolean => unsavedChanges(p, savedPatches()) && !(lastLoad?.reopen && lastLoad.patch === asLoaded(p));
let palSel = 0;
let palItems: Command[] = [];
const palRender = (): void => {
  const q = palInput.value.trim().toLowerCase();
  palItems = q ? searchCommands(commands(), q) : commands().filter((c) => c.kind === 'command');
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-query]')) button.setAttribute('aria-pressed', String(button.dataset.query === q));
  palSel = Math.min(palSel, Math.max(0, palItems.length - 1));
  palList.replaceChildren(
    ...palItems.map((c, i) => {
      const li = document.createElement('li');
      li.className = i === palSel ? 'sel' : '';
      li.id = `command-${i}`;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(i === palSel));
      const k = document.createElement('span');
      k.className = 'k';
      k.textContent = c.kind;
      if (c.kind !== 'command') li.append(k);
      li.append(c.label);
      if (c.detail) {
        const detail = document.createElement('span');
        detail.className = 'detail';
        detail.textContent = c.detail;
        li.append(detail);
      }
      li.onclick = () => palRun(c);
      return li;
    }),
  );
  if (!palItems.length) {
    const empty = document.createElement('li');
    empty.className = 'muted';
    empty.textContent = 'No matches. Try a module name or an action like “save”.';
    palList.append(empty);
  }
  if (palItems.length) palInput.setAttribute('aria-activedescendant', `command-${palSel}`);
  else palInput.removeAttribute('aria-activedescendant');
  palList.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
};
const palRun = (c: Command): void => {
  palette.close();
  if (c.kind !== 'command') toPatch();
  c.run();
};
/** a prefilled query ends in a space, the caret after it, so typing straight away narrows it instead of extending its last word */
const prefill = (query: string): void => {
  palInput.value = query ? `${query} ` : '';
  palSel = 0;
  palRender();
  palInput.focus();
  palInput.setSelectionRange(palInput.value.length, palInput.value.length);
};
const openPalette = (query = ''): void => {
  closeSidebar();
  palette.showModal();
  prefill(query);
};
palInput.oninput = () => {
  palSel = 0;
  palRender();
};
palInput.onkeydown = (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    palSel = (palSel + (e.key === 'ArrowDown' ? 1 : palItems.length - 1)) % Math.max(1, palItems.length);
    palRender();
    e.preventDefault();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (palItems[palSel]) palRun(palItems[palSel]);
  }
  e.stopPropagation();
};
$('palette-btn').onclick = () => openPalette();
// New patch: outside the tutorial, "Start with an engine" first (#160; the tutorial's steps expect a bare Main + Output)
const emptyNew = (): void => { loadNamed(newPatch(DEFS)); tutorial.newPatchPressed(); };
const engineStart = new EngineStart($<HTMLDialogElement>('engine-start'), {
  pick(def) { loadNamed(newPatch(DEFS)); editor.insert(def); tutorial.newPatchPressed(); },
  empty: emptyNew,
  openPicker() {
    // the Open picker is in the sidebar: expand it (wide) or slide it in (phone)
    if (sidebar.parentElement!.classList.contains('side-collapsed')) setSidebarCollapsed(false);
    if (compactWorkspace.matches) setSidebarOpen(true);
    presetSel.focus();
    try { presetSel.showPicker(); } catch { /* not allowed here: focused is enough */ }
  },
});
const startNew = (): void => (tutorial.active ? emptyNew() : engineStart.open());
$('new-patch-btn').onclick = () => { closeSidebar(); startNew(); };
// the sidebar is the same in every view: + Module, + Assembly and the Canvas panel go to the canvas first
const onCanvas = (run: () => void) => (): void => {
  if (currentView !== 'patch') setView('patch');
  run();
};
$('add-btn').onclick = onCanvas(() => openPalette('module'));
$('add-assembly-btn').onclick = onCanvas(() => openPalette('assembly'));
$('tidy-btn').onclick = onCanvas(() => editor.tidyUp());
$('fit-btn').onclick = onCanvas(() => editor.zoomToFit());
$('expand-all-btn').onclick = onCanvas(() => editor.setAllOpen(true));
$('collapse-all-btn').onclick = onCanvas(() => editor.setAllOpen(false));
$('tour-btn').onclick = () => { toPatch(); tutorial.open(); };
// Get started > Install names the firmware it installs: "Install v1.2" (version.ts installLabel)
$('install-btn').textContent = installLabel();
$('install-btn').onclick = () => openInstall();
/** the demo patch, with the audio and the transport started (the click is the gesture the browser wants; its drums
 * and the drone's pump are Steps tracks, which play while the transport runs) */
const openDemo = (): void => { loadNamed(demoPatch()); closeSidebar(); void startAudio().then(() => setPlaying(true)); };
$('demo-btn').onclick = openDemo;
$('mobile-commands').onclick = () => openPalette();
$('palette-close').onclick = () => palette.close();
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-query]')) button.onclick = () => prefill(button.dataset.query!);
const help = $<HTMLDialogElement>('help');
$('help-btn').onclick = () => help.showModal();

// A pointer interaction gives focus back to the page, so Space / arrows / Delete reach the shortcuts below, not the control.
releaseFocusAfterPointer();
// ---- keyboard shortcuts (off while typing in a field; the note keyboard in input.ts gets what is left)
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && sidebar.classList.contains('open') && !document.querySelector('dialog[open]')) {
    closeSidebar(); e.preventDefault(); e.stopImmediatePropagation(); return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k' && !document.querySelector('dialog[open]')) {
    e.preventDefault(); e.stopImmediatePropagation(); openPalette(); return;
  }
  if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'b' && !compactWorkspace.matches && !document.querySelector('dialog[open]')) {
    e.preventDefault(); e.stopImmediatePropagation(); toggleSidebarCollapsed(); return;
  }
  if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 's' && currentTab === 'patch' && !document.querySelector('dialog[open]')) {
    e.preventDefault(); e.stopImmediatePropagation(); saveCurrent(); return;
  }
  if (currentTab !== 'patch' || installOpen()) return;   // (not over the Install panel)
  const t = e.target as HTMLElement | null;
  const typing = isTextEntry(t) || t?.tagName === 'SELECT';
  if (document.querySelector('dialog[open], [popover]:popover-open') || typing) return;
  if (t?.closest('[role=menu]')) return; // an open menu's keys are its own (Escape closes it: menu.ts)
  // a control keeps Space and Enter; tabs, sliders and radios keep the arrows too, a button or a dock picker passes them on (#154)
  const control = t?.closest('button, summary, [role=tab], [role=slider], input, select');
  if (control && [' ', 'Enter'].includes(e.key)) return;
  if (t?.closest('[role=tab], [role=slider], input[type=range], input[type=radio], .resize-handle') && e.key.startsWith('Arrow')) return;
  const mod = e.metaKey || e.ctrlKey;
  const k = e.key;
  let done = editor.rollKey(e) || (!mod && !e.altKey && recordKey(k)); // the piano roll's keys (#136); a Steps card's step entry: rest, tie, cursor, stop (#127)
  if (done) {
    e.preventDefault();
    e.stopImmediatePropagation();
    return;
  }
  if (k === '/' || (mod && k.toLowerCase() === 'k')) (openPalette(), (done = true));
  else if (k === '?') (help.showModal(), (done = true));
  else if ((k === '[' || k === ']') && !mod && !e.altKey) (editor.selectPattern(editor.pattern + (k === ']' ? 1 : -1)), (done = true));   // the patch's pattern (#375)
  else if (e.shiftKey && !mod && !e.altKey && k.toLowerCase() === 'r') {   // REC on the armed track (#135)
    if (!editor.toggleRec()) status.textContent = 'Shift+R records on the armed track: ARM a Steps track first';
    done = true;
  }
  // in pick / arrange mode Esc clears the row selection first, a second Esc ends the mode (#186)
  else if (k === 'Escape') (editor.cancelArm(), editor.clearRows() || editor.endPick(), (diffPanel.hidden = true), (done = true));
  else if (k === 'Delete' || k === 'Backspace') done = editor.deleteRows() || editor.removeSelected();
  else if (mod && k.toLowerCase() === 'a') (editor.selectAllRows() || editor.selectAll(), (done = true));
  else if ((k === ' ' || k === 'Enter') && !mod && !e.altKey && editor.applyRows()) done = true; // pick mode: show / hide the selected rows
  else if (mod && k.toLowerCase() === 'd') done = editor.duplicateSelected();
  else if (e.altKey && k.toLowerCase() === 'b') done = true; // A/B is off for 1.0 (#103): Alt+B does nothing, not even a bypass
  else if (!mod && k.toLowerCase() === 'b') done = editor.bypassSelected();
  else if (mod && k.toLowerCase() === 'g') (editor.makeAssembly(), (done = true)); // plain G is a note key
  else if (k === ' ') {
    togglePlaying();
    done = true;
  } else if (k.startsWith('Arrow')) {
    const d = e.shiftKey ? 100 : 10;
    done = editor.nudgeSelected(k === 'ArrowLeft' ? -d : k === 'ArrowRight' ? d : 0, k === 'ArrowUp' ? -d : k === 'ArrowDown' ? d : 0);
    // nothing selected: Left / Right pick the device on Main's knobs (the FM-1's SELECT), Up / Down its page (ALGO) (#154)
    if (!done && !mod && (k === 'ArrowLeft' || k === 'ArrowRight')) done = editor.stepDevice(k === 'ArrowRight' ? 1 : -1);
    else if (!done && !mod && (k === 'ArrowUp' || k === 'ArrowDown')) done = editor.stepPage(k === 'ArrowDown' ? 1 : -1);
  } else if (!mod && !e.altKey && KNOB_KEYS.includes(k)) {
    heldKnob = KNOB_KEYS.indexOf(k);
    done = true;
  }
  if (done) {
    e.preventDefault();
    e.stopImmediatePropagation();
  }
}, true);
// Hold 1..4 and turn the wheel: K1..K4 of the page on Main's knobs. The wheel's delta is gathered into notches (a hundredth
// of the row's range each), so a trackpad's small steps add up the same way as a mouse wheel's clicks.
const KNOB_KEYS = ['1', '2', '3', '4'];
const WHEEL_NOTCH = 40;
let heldKnob = -1;
let knobWheel = 0;
document.addEventListener('keyup', (e) => {
  if (KNOB_KEYS.indexOf(e.key) === heldKnob) (heldKnob = -1), (knobWheel = 0);
}, true);
window.addEventListener('blur', () => (heldKnob = -1));
window.addEventListener('wheel', (e) => {
  if (heldKnob < 0 || currentTab !== 'patch' || e.ctrlKey || e.metaKey) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  knobWheel -= e.deltaMode === WheelEvent.DOM_DELTA_LINE ? e.deltaY * WHEEL_NOTCH / 3 : e.deltaY;
  const notches = Math.trunc(knobWheel / WHEEL_NOTCH);
  if (!notches) return;
  knobWheel -= notches * WHEEL_NOTCH;
  editor.nudgeKnob(heldKnob, notches);
}, { capture: true, passive: false });
// Copy / cut / paste of the selection (clipboard.ts, #92): through the browser's copy / paste events, which reach the system
// clipboard without a permission prompt; a clip is JSON, so it survives switching patches or tabs. `lastClip` is the in-app
// fallback when the system clipboard is out of reach (the palette's Paste, a browser that refuses). Text fields, an open
// dialog, a text selection on the page and the other tabs keep the browser's own copy and paste.
let lastClip: Clip | null = null;
const clipboardIsOurs = (e: Event): boolean => {
  const t = e.target as HTMLElement | null;
  if (currentTab !== 'patch' || installOpen() || isTextEntry(t) || t?.tagName === 'SELECT' || document.querySelector('dialog[open], [popover]:popover-open')) return false;
  const sel = window.getSelection();
  return !sel || sel.isCollapsed;
};
/** copy the selection: false when there is nothing to copy (Main and the Output are never copied) */
function copySelection(clipboardData?: DataTransfer | null): boolean {
  const clip = editor.copySelection();
  if (!clip) {
    status.textContent = 'nothing to copy: select modules or assemblies (Main and the Output are not copied)';
    return false;
  }
  lastClip = clip;
  if (clipboardData) clipboardData.setData('text/plain', clipText(clip));
  else void navigator.clipboard?.writeText(clipText(clip)).catch(() => {});
  const n = clip.def.modules.length;
  status.textContent = `copied ${n} module${n === 1 ? '' : 's'}${clip.def.assemblies?.length ? ` in ${clip.def.assemblies.length} assembl${clip.def.assemblies.length === 1 ? 'y' : 'ies'}` : ''}`;
  return true;
}
function pasteText(text: string | null): void {
  const clip = text ? parseClip(text, DEFS) : null;
  if (text && !clip) return; // something else is on the clipboard: not ours to paste
  const use = clip ?? lastClip;
  if (!use) return void (status.textContent = 'nothing to paste: copy modules or assemblies first');
  if (editor.paste(use)) status.textContent = 'pasted: the pasted items are selected';
}
document.addEventListener('copy', (e) => {
  if (clipboardIsOurs(e) && copySelection(e.clipboardData)) e.preventDefault();
});
document.addEventListener('cut', (e) => {
  if (clipboardIsOurs(e) && copySelection(e.clipboardData)) (editor.removeSelected(), e.preventDefault());
});
document.addEventListener('paste', (e) => {
  if (!clipboardIsOurs(e)) return;
  e.preventDefault();
  pasteText(e.clipboardData?.getData('text/plain') ?? null);
});
/** the palette's Paste: no paste event there, so ask the clipboard (the browser may ask the user), else the in-app copy */
async function pasteFromPalette(): Promise<void> {
  let text: string | null = null;
  try {
    text = (await navigator.clipboard?.readText()) ?? null;
  } catch {
    /* refused or not supported: the in-app copy */
  }
  pasteText(text && parseClip(text, DEFS) ? text : null);
}
// The sidebar's cable slack and zoom sliders: a card's value bar (sliderJack) each, and (the easter egg) their thumbs are
// jacks. An output dropped on one (Editor.setSideSource: Patch.slackFrom / zoomFrom) moves it: the worklet sends that
// output's mean (watch), which adds to the slider's setting in its unit (0..1). As on a card the thumb and value show the
// live position, a tick the setting, a knob's tick where that knob rests it; a drag moves the setting by the thumb's travel.
// A right-click on the bar or a click on its cable unplugs it.
interface SideSlider {
  bar: ReturnType<typeof sliderJack>;
  row: HTMLElement;
  /** the source's latest value, and whether the thumb is being dragged (it shows the pointer then, not the live value) */
  live: number;
  dragging: boolean;
  watching: string;
  /** the setting in the slider's unit, 0..1, and setting it */
  base(): number;
  setBase(u: number): void;
  /** apply the live position (setting + source) */
  apply(u: number, modulated: boolean): void;
  text(u: number): string;
  name: string;
}
const SLACK = 'matryoshka.cable-slack';
const clamp01 = (u: number): number => Math.min(1, Math.max(0, u));
// zoom in the slider's unit: octaves of its range, like the wheel and pinch
const zoomUnit = (z: number): number => Math.log(z / ZOOM_MIN) / Math.log(ZOOM_MAX / ZOOM_MIN);
const unitZoom = (u: number): number => ZOOM_MIN * Math.pow(ZOOM_MAX / ZOOM_MIN, clamp01(u));
zoomBase = editor.zoom;
function setSlack(v: number): void {
  editor.setSlack(v);
  showSide('slackFrom');
  try {
    localStorage.setItem(SLACK, String(editor.slack));
  } catch {
    /* storage blocked: the slack lasts until the page is reloaded */
  }
}
function sideSlider(key: SideKey, rowId: string, s: Omit<SideSlider, 'bar' | 'row' | 'live' | 'dragging' | 'watching'>): void {
  const row = $(rowId);
  const input = row.querySelector('input')!;
  const bar = sliderJack(input, () => {});
  row.append(bar.element);
  row.dataset.side = key;
  editor.sideThumbs.set(key, bar.jack);
  const side: SideSlider = { ...s, bar, row, live: 0, dragging: false, watching: '' };
  sides.set(key, side);
  input.addEventListener('input', () => {
    side.setBase(clamp01(Number(input.value) - (editor.patch[key] ? side.live : 0)));
    showSide(key);
  });
  // click-to-connect: with an output armed (a click on it), a press on the slider patches it instead of dragging
  row.addEventListener('pointerdown', (e) => {
    if (!editor.connectArmedToSide(key)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  }, true);
  row.addEventListener('pointerdown', () => (side.dragging = true), true);
  input.addEventListener('change', () => {
    side.dragging = false;
    showSide(key);
  });
  row.addEventListener('contextmenu', (e) => {
    if (!editor.patch[key]) return;
    e.preventDefault();
    editor.setSideSource(key, null);
  });
}
function showSide(key: SideKey): void {
  const side = sides.get(key);
  if (!side) return;
  const input = side.row.querySelector('input')!;
  const from = editor.patch[key];
  const m = from && editor.patch.modules.find((x) => x.id === from.module);
  const base = side.base();
  const u = clamp01(base + (m ? side.live : 0));
  if (!side.dragging) input.value = String(u);
  side.bar.update();
  side.bar.setBase(m ? base : null);
  side.bar.jack.classList.toggle('connected', !!m);
  side.row.classList.toggle('automated', !!m);
  side.row.querySelector('output')!.textContent = side.text(u);
  side.row.title = m
    ? `${side.name}: moved by ${moduleName(m.type, DEFS[m.type].label)} ${longName(m.type, from!.port)}. Right-click (or click its cable) to unplug.`
    : `${side.name}. Its thumb is a jack: drop a cable from any output on it and that signal moves it.`;
}
/** watch the patched outputs (and stop watching unplugged ones) */
function syncSides(): void {
  for (const [key, side] of sides) {
    const from = editor.patch[key];
    const want = from ? `${from.module}:${from.port}` : '';
    if (want !== side.watching) {
      side.watching = want;
      side.live = 0;
      side.apply(side.base(), false);
      host.send(from ? { t: 'watch', key, id: from.module, port: from.port } : { t: 'unwatch', key });
    }
    showSide(key);
  }
}
// the worklet reports a watched output every 256 samples; the sliders and what they move follow once per frame
let watchFrame = 0;
const watchDirty = new Set<SideKey>();
host.onWatch = (key, v) => {
  const side = sides.get(key as SideKey);
  if (!side || !editor.patch[key as SideKey]) return;
  side.live = v;
  watchDirty.add(key as SideKey);
  watchFrame ||= requestAnimationFrame(() => {
    watchFrame = 0;
    for (const k of watchDirty) {
      const s = sides.get(k);
      if (!s || !editor.patch[k]) continue;
      s.apply(clamp01(s.base() + s.live), true);
      showSide(k);
    }
    watchDirty.clear();
  });
};
sideSlider('slackFrom', 'slack-bar', {
  name: 'Cable slack',
  base: () => editor.slack,
  setBase: (u) => setSlack(u),
  // the editor adds the source to the setting itself (Editor.sway)
  apply: (_u, modulated) => editor.modulateSlack(modulated ? sides.get('slackFrom')!.live : 0),
  text: (u) => `${Math.round(u * 100)} %`,
});
sideSlider('zoomFrom', 'zoom-bar', {
  name: 'Zoom',
  base: () => zoomUnit(zoomBase),
  setBase: (u) => {
    zoomBase = unitZoom(u);
    if (!editor.patch.zoomFrom) editor.zoomAround(zoomBase);
  },
  apply: (u, modulated) => editor.zoomAround(modulated ? unitZoom(u) : zoomBase, modulated),
  text: (u) => `${Math.round(unitZoom(u) * 100)} %`,
});
// the sidebar scrolls and the window resizes under the source cables (they are drawn over the whole window)
$('workspace-sidebar').addEventListener('scroll', () => editor.positionSideCables(), { passive: true });
addEventListener('resize', () => editor.positionSideCables());
syncSides();
try {
  const v = Number(localStorage.getItem(SLACK) ?? 0);
  if (v > 0) setSlack(v);
} catch {
  /* storage blocked: no slack */
}
function panic(): void {
  tutorial.stop();
  host.mute(true);
  sink.send({ t: 'panic' });
}
/** MIDI clock out (FM-1 & MIDI, wired below): clock at Main's tempo to the ticked outputs, Start / Stop with Play */
const clockOut = new ClockOut(() => editor.patch.modules.find((m) => m.type === 'fm1')?.params.tempo ?? 120);
// PLAY in the dock's button block and Space are one switch: the transport (Main's run output and clock)
function syncPlayBtn(): void {
  arpBtn.setAttribute('aria-pressed', String(editor.playing));
}
function setPlaying(on: boolean): void {
  if (on) host.mute(false);
  editor.playing = on;
  host.transport(on);
  if (liveSync.transports(device.connected, liveOn)) device.transport(on);   // (sandbox mode too: the FM-1's PLAY in step)
  clockOut.transport(on);
  if (!fromEmu) emu.ui?.transport(on);
  syncPlayBtn();
  showArmed(); // (REC: step entry stopped, live running)
}
function togglePlaying(): void {
  setPlaying(!editor.playing);
  status.textContent = editor.playing ? 'transport running' : 'transport stopped';
}
arpBtn.onclick = togglePlaying;

// ---- the FM-1 tab (#110): the real firmware UI as WebAssembly (fm1-ui.ts, fm1-view.ts) in place of the canvas. Its
// panel drives the editor as a Live FM-1 does (fm1Event), the editor's edits go to it; the browser engine plays.
/** the editor's patch into the emulator, its transport and focus as here */
function emuLoad(): void {
  const ui = emu.ui;
  if (!ui) return;
  // a patch over the budget still loads here (the emulator has the firmware's tables, not its timing): a notice says so
  // and the view stays usable; past the tables themselves the firmware refuses it and the last patch stays
  const b = deviceBudget(editor.patch);
  const over = b.over.map((i) => i.key === 'cpu' || i.key === 'browser' ? overText(i) : `${i.used} ${i.label} (the FM-1 holds ${i.max})`).join(', ');
  let err = 0;
  try {
    err = ui.load(encodePatch(editor.patch, true), editor.patch.name.toUpperCase(), { fresh: emuFresh });
  } catch {
    err = -1;
  }
  emuFresh = false;
  const more = (): void => { budgetEl.open = true; };
  if (err) {
    emu.notice({ level: 'error', title: 'The FM-1 can’t hold this patch',
      body: `${over || `The firmware refused it (error ${err})`}. ${emuLoaded ? `The view shows ${emuLoaded}, the last patch it could load,` : 'The view has no patch'} until this one fits.`,
      chip: emuLoaded ? `Showing ${emuLoaded} · this patch is too big` : 'This patch is too big for the FM-1', action: emuLoaded ? `Show ${emuLoaded}` : 'OK', more });
  } else {
    emuLoaded = editor.patch.name.toUpperCase();
    emu.notice(b.fits ? null : { level: 'warn', title: 'Over the FM-1 budget',
      body: `${over}. It plays here, but it would ${b.over.some((i) => i.key === 'cpu') ? 'drop out' : 'not load'} on the device and will not upload until it fits.`,
      chip: `Over budget · ${over} · won’t upload`, action: 'Use the FM-1 view anyway', more });
  }
  ui.transport(editor.playing);
  emuArm();                                  // (a load disarms the emulator's engine)
  const at = editor.focus && binaryPage(editor.patch, editor.focus.device, editor.focus.page);
  if (at) ui.focus(at[0], at[1]);
}
/** the emulated FM-1 arms the editor's armed track (#139), so its REC records into it */
function emuArm(): void {
  emu.ui?.armMask(...armMask(editor.patch, editor.armedSet));
}
function queueEmu(): void {
  if (!emu.ui) return;
  clearTimeout(emuTimer);
  emuTimer = window.setTimeout(emuLoad, 120);
}
/** a parameter set in the editor: the emulator's engine takes it at once (as a Live FM-1 does) */
function emuParam(id: number, name: string, value: number): void {
  if (!emu.ui) return;
  const m = editor.patch.modules.find((x) => x.id === id);
  const mi = m ? deviceIndex(editor.patch, id) : -1;
  const pi = m ? DEFS[m.type].params.findIndex((q) => q.name === name) : -1;
  if (mi >= 0 && pi >= 0) emu.ui.param(mi, pi, toQ16(value));
}
/** the emulated PRESET knob: the next / previous entry of the Open list (Your patches, then the factory patches), stepping
 *  over sandbox patches as the FM-1's PRESET does: they never go into its bank */
function stepOpenList(d: number): void {
  if (!d) return;
  const list = openableGroups().flatMap((g) => g.items).filter((o) => o.chip().fits);
  if (!list.length) return;
  const i = list.findIndex((o) => o.name === editor.patch.name);
  const next = list[(((i < 0 ? (d > 0 ? -1 : 0) : i) + d) % list.length + list.length) % list.length];
  loadNamed(next.load(), { from: next.from, stay: true });
  status.textContent = `FM-1: ${next.name}`;
}
/** the keyboard's notes are the emulated FM-1's keys while its tab shows; on its SEQ page they enter steps and do not
 * sound (as on the device). True: the message is used up */
function emuKeys(msg: HostMsg): boolean {
  if (msg.t === 'panic') { emuHeld.clear(); emuSwallowed.clear(); }
  if (!emu.shown || !emu.ui || (msg.t !== 'on' && msg.t !== 'off')) return false;
  const note = (msg as { note: number }).note;
  if (msg.t === 'on') emuHeld.add(note);
  else emuHeld.delete(note);
  emu.keys(emuHeld);
  if (msg.t === 'on' && emu.ui.page === 8) { emuSwallowed.add(note); return true; }
  if (msg.t === 'off' && emuSwallowed.delete(note)) return true;
  return false;
}
// the PATCH | EMU | LIBRARY switch over the main area (#218): the primary navigation; the sidebar shows the view's panels
type View = 'patch' | 'emu' | 'library';
let currentView: View = 'patch';
const viewBtns = [...document.querySelectorAll<HTMLButtonElement>('#view-switch [data-view]')];
const workspace = document.querySelector<HTMLElement>('.workspace')!;
function setView(v: View): void {
  if (installOpen()) closeInstall(); // any view navigation closes the Install panel; a running install keeps going (and its guard)
  currentView = v;
  if (v !== 'patch') tutorial.closeWelcome?.(); // the welcome card is PATCH's: leaving PATCH closes it for this visit
  currentTab = v === 'library' ? 'library' : 'patch';
  closeSidebar();
  for (const b of viewBtns) {
    b.setAttribute('aria-selected', String(b.dataset.view === v));
    b.tabIndex = b.dataset.view === v ? 0 : -1;
  }
  $('tab-patch').hidden = v === 'library';
  $('tab-library').hidden = v !== 'library';
  $('canvas').hidden = v !== 'patch';
  $('help-btn').hidden = v !== 'patch';
  // the sidebar is the same in every view; LIBRARY's sections are tabs under the switch
  $('library-tabs').hidden = v !== 'library';
  // the FM-1 is its own instrument: its panel has the keys and knobs, so the Main dock, the wheels and the keyboard go;
  // LIBRARY plays nothing, so they go there too. Audio on / Panic and MIDI stay
  workspace.classList.toggle('fm1-mode', v === 'emu');
  workspace.classList.toggle('library-mode', v === 'library');
  host.setMaster(v === 'emu' ? emuLevel : 1);
  if (v === 'emu') void emu.show();
  else emu.hide();
  editor.positionSideCables();
  if (v === 'patch') requestAnimationFrame(() => editor.drawCables());
  if (v === 'library') showLibrarySection();
  showAddress();
}
/** the address follows the view (#218), replaced, not pushed: PATCH has no fragment, EMU #emu, LIBRARY #library (Patches),
 *  #assemblies, #presets or #community. A replaceState fires no hashchange, so openFromAddress does not run again. A fragment that is
 *  not a view's (a share link's #p= being opened) is left alone */
const VIEW_HASHES = ['', '#patch', '#emu', '#fm1', '#library', '#presets', '#assemblies', '#community', '#flash', '#about'];
function showAddress(): void {
  if (!VIEW_HASHES.includes(location.hash)) return;
  const want = currentView === 'emu' ? '#emu' : currentView === 'library' ? (librarySection === 'patches' ? '#library' : `#${librarySection}`) : '';
  if (location.hash !== want) history.replaceState(history.state, '', location.pathname + location.search + want);
}
for (const b of viewBtns) {
  b.onclick = () => setView(b.dataset.view as View);
  b.onkeydown = (e) => {
    if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    e.stopPropagation();
    const i = viewBtns.indexOf(b), n = viewBtns.length;
    const next = viewBtns[e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : (i + (e.key === 'ArrowRight' ? 1 : n - 1)) % n];
    next.click();
    next.focus();
  };
}
/** back to the patch from LIBRARY (an open, an insert, a canvas command); PATCH and EMU stay as they are */
function toPatch(): void {
  closeSidebar();
  if (currentView === 'library') setView('patch');
}

// LIBRARY's sections (#218): Patches, Assemblies, Presets, Community as tabs under the switch, the last one remembered per browser; one shows
// at a time (bank.ts, assemblies.ts, library-presets.ts build them below). Entering one rereads it, and reads the FM-1
// when one is connected
type LibrarySection = 'patches' | 'assemblies' | 'presets' | 'community';
const LIBRARY_SECTION = 'matryoshka.library-section';
const isSection = (v: unknown): v is LibrarySection => v === 'patches' || v === 'assemblies' || v === 'presets' || v === 'community';
let librarySection: LibrarySection = (() => {
  try {
    const v = localStorage.getItem(LIBRARY_SECTION);
    return isSection(v) ? v : 'patches';
  } catch {
    return 'patches'; // storage blocked: Patches every time
  }
})();
const sectionBtns = [...document.querySelectorAll<HTMLButtonElement>('#library-tabs [data-section]')];
const sectionEls: Record<LibrarySection, HTMLElement> = { patches: $('lib-patches'), assemblies: $('lib-assemblies'), presets: $('lib-presets'), community: $('lib-community') };
/** the sections' panes with an FM-1 column (set when they are built, below) */
const libraryPanes: Partial<Record<LibrarySection, LibraryPane>> = {};
function showLibrarySection(): void {
  for (const b of sectionBtns) b.setAttribute('aria-current', String(b.dataset.section === librarySection));
  for (const [k, el] of Object.entries(sectionEls)) el.hidden = k !== librarySection;
  $('tab-library').scrollTop = 0;
  if (librarySection === 'assemblies') refreshAssemblies();
  libraryPanes[librarySection]?.enter();
}
/** an FM-1 connected or went away: the Library's FM-1 columns follow (the one on screen reads the FM-1 now) */
function libraryDeviceChanged(): void {
  for (const [k, pane] of Object.entries(libraryPanes)) pane.deviceChanged(currentView === 'library' && k === librarySection);
}
function setLibrarySection(section: LibrarySection): void {
  librarySection = section;
  try {
    localStorage.setItem(LIBRARY_SECTION, section);
  } catch {
    /* storage blocked: remembered until the page is reloaded */
  }
  if (currentView === 'library') {
    if (installOpen()) closeInstall();
    showLibrarySection();
    showAddress();
  } else setView('library');
}
for (const b of sectionBtns) b.onclick = () => setLibrarySection(b.dataset.section as LibrarySection);

// the Install panel (#218): the firmware install page over the main area, not a view. Get started > Install firmware,
// the palette, #flash and Connect FM-1 (an FM-1 on other firmware) open it; Close hides it, and an install keeps running
// (the flasher's keep-this-tab-open guard stays armed until it ends)
const installPanel = $('flash-view');
function installOpen(): boolean { return !$('flash-view').hidden; }
function openInstall(): void {
  closeSidebar();
  installPanel.hidden = false;
  workspace.classList.add('flash-mode');
  $('install-close').focus();
}
function closeInstall(): void {
  installPanel.hidden = true;
  workspace.classList.remove('flash-mode');
  if (location.hash === '#flash') history.replaceState(history.state, '', location.pathname + location.search);
}
$('install-close').onclick = closeInstall;
installPanel.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !document.querySelector('dialog[open]')) { e.stopPropagation(); closeInstall(); }
});

// the keyboard folds away, leaving the deck's buttons; remembered per browser
const KEYS_HIDDEN = 'matryoshka.keys-hidden';
const deck = $('deck');
const keysBtn = $('keys-btn');
const showKeys = (on: boolean): void => {
  deck.classList.toggle('folded', !on);
  keysBtn.setAttribute('aria-expanded', String(on));
  try {
    if (on) localStorage.removeItem(KEYS_HIDDEN);
    else localStorage.setItem(KEYS_HIDDEN, '1');
  } catch {
    /* storage blocked: the choice lasts until the page is reloaded */
  }
};
keysBtn.onclick = () => showKeys(deck.classList.contains('folded'));
// the panels that dock above the deck (tutorial, diff) keep clear of it, the Main panel and the status line at whatever height they have
{
  const dockEl = $('dock'), statusEl = $('statusline');
  const fit = new ResizeObserver(() => document.documentElement.style.setProperty('--piano-h', `${deck.offsetHeight + dockEl.offsetHeight + statusEl.offsetHeight}px`));
  fit.observe(deck);
  fit.observe(dockEl);
}
try {
  if (localStorage.getItem(KEYS_HIDDEN)) showKeys(false);
} catch {
  /* storage blocked: the keyboard starts shown */
}

// FM-1 link: FM-1 & MIDI's Connect and the Connect FM-1 button over the canvas
async function connectFm1(): Promise<void> {
  try {
    const info = await device.connect();
    devStatus(`FM-1 connected (protocol ${info.version}, up to ${info.maxModules} modules, flash ${info.flashOk ? 'ok' : 'not available'})`);
    for (const id of ['dev-send', 'dev-store']) $<HTMLInputElement>(id).disabled = false;
    $('dev-btn').textContent = 'Reconnect';
    if (!mirror.following) void followFm1('matryoshka');   // it runs Matryoshka (it answered HELLO): its panel drives the page
    offerSync();
    libraryDeviceChanged();
  } catch (e) {
    devStatus((e as Error).message);
  }
}
$('dev-btn').onclick = async () => {
  await connectFm1();
  if (!device.connected) void offerInstall();
};

// ---- following the FM-1's panel (#120): any firmware, through plain MIDI (fm1-profiles.ts, mirror.ts). Its inputs go
// through Matryoshka's panel logic (the FM-1 tab's WebAssembly copy, which tells the editor its focus and page) and the
// editor (Main's knobs, the patch buttons), and its keys play the browser engine. Nothing goes back to the FM-1.
const mirror = new Fm1Mirror();
const PANEL_OF_ID = new Map<number, number>(PANEL_BUTTONS.map((b, i) => [BUTTONS[b as keyof typeof BUTTONS], i]));
mirror.onInput = (i) => void mirrorInput(i);
async function mirrorInput(i: PanelInput): Promise<void> {
  if (i.t === 'button' || i.t === 'enc') await emu.ready();   // (the panel logic: loaded even while the FM-1 tab is hidden)
  fromDevice = true;
  try {
    switch (i.t) {
      case 'note': sink.send(i.on ? { t: 'on', note: i.note, vel: i.vel || 0.8 } : { t: 'off', note: i.note }); break;
      case 'mod': sink.send({ t: 'cc', n: 1, v: i.v * 127 }); break;
      case 'knob': if (!exactKnobs()) editor.turnKnob(i.k, i.u); break;   // (else PARAM_NOW names the row: device.onEvent)
      case 'master': emu.setMaster(i.v); host.setMaster(i.v); break;
      case 'transport': setPlaying(i.run); break;
      case 'enc':
        if (i.n === ENCODERS.preset && (live() || sandboxOn())) break;   // (with Live the FM-1 plays the editor's patch: its slots are its own)
        if (sandboxOn() && (i.n === ENCODERS.select || i.n === ENCODERS.algo)) {   // sandbox mode: the editor's own focus moves
          const f = sandboxStep(editor.devices, editor.focus, i.n === ENCODERS.select, i.clicks);
          if (f) editor.setFocus(f);
          break;
        }
        emu.drive(i);
        break;
      case 'button': {
        const b = PANEL_OF_ID.get(i.id);
        followOctave(noteKeys, () => emu.octave, () => emu.drive(i));   // (OCT- / OCT+: the editor's keys follow the FM-1's)
        if (b !== undefined) editor.pressButton(b, i.down);
        break;
      }
    }
  } finally { fromDevice = false; }
}
async function followFm1(fw?: Firmware): Promise<void> {
  try {
    const p = await mirror.follow(fw);
    emu.following(p.name, p.reports);
    $<HTMLSelectElement>('mirror-fw').value = p.firmware;
    devStatus(`following the FM-1's panel: ${p.name}${mirror.identity ? ` (${mirror.identity})` : ''}`);
    $('mirror-btn').textContent = 'Stop following';
  } catch (e) {
    emu.following(null, null);
    devStatus((e as Error).message);
  }
}
function unfollowFm1(why = 'not following the FM-1'): void {
  mirror.stop();
  emu.following(null, null);
  $('mirror-btn').textContent = 'Follow its panel';
  devStatus(why);
}
$('mirror-btn').onclick = () => {
  if (mirror.following) {
    sandboxFollows = false;   // (the user's choice: sandbox mode leaves it be)
    unfollowFm1();
    return;
  }
  const v = $<HTMLSelectElement>('mirror-fw').value;
  void followFm1((v || undefined) as Firmware | undefined);
};
$<HTMLSelectElement>('mirror-fw').onchange = () => {
  const v = $<HTMLSelectElement>('mirror-fw').value;
  if (mirror.following) void followFm1((v || undefined) as Firmware | undefined);
};
$('dev-send').onclick = () => void sendPatch();
/** the open patch into slot n of the FM-1's bank, under its name (the device does not switch to it) */
async function storeToSlot(): Promise<void> {
  if (!device.connected) return devStatus('connect the FM-1 first (FM-1 & MIDI)');
  const typed = window.prompt('Store into FM-1 slot (1-64):', String((deviceSlot?.slot ?? 0) + 1));
  const n = Math.round(Number(typed));
  if (!typed || !Number.isFinite(n) || n < 1 || n > 64) return;
  try {
    // a used slot is overwritten only when the user says so (#148); Cancel sends nothing
    const was = await device.readSlot(n - 1);
    if (was.used && !window.confirm(`FM-1 slot ${slotLabel(n - 1)} holds "${was.name}". Replace it with "${editor.patch.name}"?`)) return devStatus('nothing stored');
    await device.uploadSlot(n - 1, editor.patch.name.toUpperCase().slice(0, 20), editor.patch);
    devStatus(`"${editor.patch.name}" stored into FM-1 slot ${slotLabel(n - 1)}`);
  } catch (e) {
    devStatus((e as Error).message);
  }
}
$('dev-sync-btn').onclick = () => setLive(fm1State() === 'not synced');
$('dev-store').onclick = async () => {
  try {
    if (!(await sendPatch())) return;
    await device.store();
    setBaseline();
    devStatus(`stored into the FM-1's slot ${deviceSlot ? slotLabel(deviceSlot.slot) : ''} (the one it plays; it opens it at the next start)`);
  } catch (e) {
    devStatus((e as Error).message);
  }
};

/** copy the link without the sheet (the tutorial's host); a patch too big for a link is not copied */
const sharePatch = async (): Promise<void> => {
  try {
    const h = await handOut(await encodeShare(editor.patch));
    await navigator.clipboard.writeText(h.link);
    status.textContent = h.stored
      ? 'link copied (the patch is stored on the site)'
      : `link copied (${h.length} characters${h.layout ? '' : `; without the layout${h.fallback ? `: the site could not store the patch (${h.fallback})` : ''}`})`;
    tutorial.shared();
  } catch (e) {
    status.textContent = `share failed: ${(e as Error).message}`;
  }
};
// a link with a patch in its fragment: load it (it is not saved over the remembered patch until something is changed)
const loadFromHash = (): void => {
  if (!isShareLink(location.href)) return;
  if (!shareCodeOf(location.href)) status.textContent = 'opening the patch from the link\u2026'; // (a stored one is fetched)
  void openShareLink(location.href, DEFS)
    .then((p) => {
      if (!p) return;
      const kept = loadSaved();
      const losing = !!kept && losesWork(kept);
      suppressSave = true;
      loadNamed(p, { once: true, stay: true, quiet: true });
      suppressSave = false;
      status.textContent = `patch "${p.name}" from the link${p.notes ? `: ${p.notes}` : ''}`;
      // the remembered patch stays in storage until the first edit; with unsaved changes it is offered back at once (#148)
      if (p.notes && !(kept && losing)) showToast(`"${p.name}": ${p.notes}`);
      if (kept && losing) {
        const name = kept.name.trim() || 'Untitled';
        showUndo(`Opened "${p.name}" from the link. "${name}" was not saved`, () => {
          loadNamed(kept, { once: true, quiet: true });
          status.textContent = `"${name}" is back`;
        });
      }
      history.replaceState(null, '', location.pathname + location.search);
    })
    .catch((e: Error) => (status.textContent = `the link holds no patch: ${e.message}`));
};
loadFromHash();
window.addEventListener('hashchange', loadFromHash);

// the share sheet (#165): the PATCH panel's Share (beside New patch), the ⋯ menu's Share… and the palette
const shareSheet = new ShareSheet($<HTMLDialogElement>('share-sheet'), {
  patch: () => editor.patch,
  rename: (name) => { editor.patch.name = name; nameInput.value = name; queueSave(editor.patch); },
  changed: () => queueSave(editor.patch),
  copied: () => tutorial.shared(),
  saveFile: () => savePatch(),
});
/** the patch card (#163): a PNG of the patch for a post, downloaded as <patch name>.png */
const saveCard = async (by?: string): Promise<void> => {
  try {
    await savePatchCard(editor.patch, { by });
    status.textContent = `card saved: ${fileStem(editor.patch)}.png`;
  } catch (e) {
    status.textContent = `the card could not be saved: ${(e as Error).message}`;
  }
};
const savePatch = (): void => {
  const blob = new Blob([JSON.stringify(editor.patch, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${fileStem(editor.patch)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
};
$<HTMLInputElement>('load-file').onchange = async (e) => {
  const input = e.target as HTMLInputElement;
  const f = input.files?.[0];
  input.value = '';
  if (!f) return;
  try {
    const raw = JSON.parse(await f.text()) as unknown;
    // the old address's "Download a backup" (deploy/github-pages-forward): the browser data, not a patch
    const backup = backupKeys(raw);
    const presets = backup ? null : importPresets(raw); // a preset library (#192)
    if (backup) importBrowserData(backup, 'the backup');
    else if (presets !== null) {
      editor.rebuild();
      status.textContent = `${presets} preset${presets === 1 ? '' : 's'} imported`;
      showToast(status.textContent);
    } else loadNamed(validatePatch(raw, DEFS));
  } catch (err) {
    status.textContent = `load failed: ${(err as Error).message}`;
    showToast(status.textContent);
  }
};

/** sessionStorage: the import's toast, shown after the reload */
const IMPORTED = 'matryoshka.imported';
/**
 * Browser data from the old address (migrate.ts: its hand-off, or its backup file): stored without overwriting anything
 * silently, then the page reloads so every part (the open patch, the bank, the library, the tutorial, the theme) reads it.
 * A save still pending would put the starter patch back over an imported open patch: it is cancelled.
 */
const importBrowserData = (keys: Record<string, string>, from: string): void => {
  clearTimeout(saveTimer);
  suppressSave = true;
  let text: string;
  let wrote: boolean;
  try {
    const plan = applyImport(keys);
    text = importSummary(plan, from);
    wrote = Object.keys(plan.writes).length > 0;
  } catch (e) {
    suppressSave = false;
    showToast(`The import failed: ${(e as Error).message}`);
    return;
  }
  if (!wrote) {
    suppressSave = false;
    showToast(text, 12000);
    return;
  }
  try {
    sessionStorage.setItem(IMPORTED, text);
  } catch {
    /* no toast after the reload */
  }
  if (!location.hash && openedHash) history.replaceState(history.state, '', location.pathname + location.search + openedHash);
  location.reload();
};

// audio + input
const startAudio = async (): Promise<void> => {
  try {
    await host.start();
    status.textContent = 'audio running';
  } catch (e) {
    status.textContent = `audio failed: ${e}`;
  }
};
// one button: Audio on while the audio is off (not started or silenced by a panic), Panic while it plays
const audioBtn = $('audio-btn');
const syncAudioBtn = (): void => {
  const on = host.running && !host.muted;
  audioBtn.textContent = on ? 'Panic' : 'Audio on';
  audioBtn.title = on ? 'Stop all playing notes and silence the audio' : 'Start the audio';
  audioBtn.classList.toggle('on', on);
};
host.onState = () => { syncAudioBtn(); screens.state(); envs.state(); };
syncAudioBtn();
audioBtn.onclick = () => (host.running && !host.muted ? panic() : void startAudio());
const noteKeys = attachKeyboard(sink, () => currentTab === 'patch' && !document.querySelector('dialog[open], [popover]:popover-open'), (o) => {
  keyOctave = o;
  piano.setOctave(o);
  if (stampOctave(editor.patch)) queueSave(editor.patch);
});
noteKeys.set(editor.patch.octave ?? 0);
// Web MIDI: asked for at start (below) unless the user switched it off with the MIDI button, which also switches it back on.
const midiBtn = $('midi-btn');
let midiSwitch: ((on: boolean) => void) | null = null;
let midiOn = false;
let midiInputs = 0;
/** set when the user switched MIDI off: it then stays off on the next visits until switched on again */
const MIDI_OFF = 'matryoshka.midi-off';
const showMidi = (): void => {
  midiBtn.setAttribute('aria-pressed', String(midiOn));
  midiBtn.title = midiOn
    ? `MIDI on: ${midiInputs} input${midiInputs === 1 ? '' : 's'}. Click to stop listening.`
    : 'Play from a MIDI keyboard (the browser asks for MIDI access)';
};
let midiAsking = false;
const setMidi = async (on: boolean): Promise<void> => {
  if (midiSwitch) {
    midiOn = on;
    midiSwitch(on);
    return showMidi();
  }
  if (!on || midiAsking) return;
  midiAsking = true;
  midiSwitch = await attachMidi(
    sink,
    (s) => {
      if (!host.running) status.textContent = s;
    },
    (n) => {
      midiInputs = n;
      showMidi();
    },
    (port) => mirror.follows(port),   // (the followed FM-1's panel comes in through the mirror: not twice)
  );
  midiAsking = false;
  midiOn = !!midiSwitch;
  showMidi();
};
midiBtn.onclick = () => {
  const on = !midiOn;
  try {
    if (on) localStorage.removeItem(MIDI_OFF);
    else localStorage.setItem(MIDI_OFF, '1');
  } catch {
    /* storage blocked: the choice lasts until the page is reloaded */
  }
  void setMidi(on);
};
// MIDI is on by default (the browser asks once), unless the user switched it off or denied the permission.
const midiOffChosen = ((): boolean => {
  try {
    return localStorage.getItem(MIDI_OFF) === '1';
  } catch {
    return false;
  }
})();
if (!midiOffChosen && 'requestMIDIAccess' in navigator) {
  void (async () => {
    try {
      const p = await navigator.permissions.query({ name: 'midi' as PermissionName });
      if (p.state === 'denied') return;
    } catch {
      /* no permission query for MIDI here: ask anyway */
    }
    await setMidi(true);
  })();
}
$('dev-release').onclick = () => {
  save(editor.patch); // the patch is remembered; reloading the page is what drops the MIDI access
  location.reload();
};

// MIDI clock out: on, the ticked MIDI outputs get clock at Main's tempo and Start / Stop with Play, so several FM-1s play in
// time with this page and each other. An output nobody ticked or unticked is ticked when it looks like an FM-1. The switch
// and the ticks are remembered by this browser; switched on, the clock starts again with the page.
const CLOCK_OUT = 'matryoshka.clock-out';
const clockBtn = $('clock-out-btn');
const clockList = $('clock-out-ports');
let clockAccess: MIDIAccess | null = null;
let clockTimer: Worker | number | null = null;
const clockPrefs = ((): { on: boolean; picks: Record<string, boolean> } => {
  try {
    const v = JSON.parse(localStorage.getItem(CLOCK_OUT) ?? 'null');
    if (v && typeof v === 'object') return { on: v.on === true, picks: v.picks && typeof v.picks === 'object' ? v.picks : {} };
  } catch {
    /* storage blocked or unreadable: off */
  }
  return { on: false, picks: {} };
})();
const saveClockPrefs = (): void => {
  try {
    localStorage.setItem(CLOCK_OUT, JSON.stringify(clockPrefs));
  } catch {
    /* storage blocked: the choice lasts until the page is reloaded */
  }
};
const clockPicked = (p: MIDIOutput): boolean => clockPrefs.picks[p.id] ?? isFm1Out(p.name);
function showClockPorts(): void {
  const outs = clockAccess ? [...clockAccess.outputs.values()].filter((p) => p.state !== 'disconnected') : [];
  const picked = outs.filter(clockPicked);
  const labels = portLabels(outs);
  clockOut.setPorts(picked);
  clockBtn.setAttribute('aria-pressed', String(clockOut.running));
  clockBtn.textContent = clockOut.running ? `Send MIDI clock: on, to ${picked.length} output${picked.length === 1 ? '' : 's'}` : 'Send MIDI clock: off';
  clockList.replaceChildren();
  if (clockAccess && !outs.length) {
    const none = document.createElement('span');
    none.className = 'muted';
    none.textContent = 'No MIDI outputs: plug in an FM-1.';
    clockList.append(none);
  }
  for (const p of outs) {
    const label = document.createElement('label');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = clockPicked(p);
    box.onchange = () => {
      clockPrefs.picks[p.id] = box.checked;
      saveClockPrefs();
      showClockPorts();
    };
    label.append(box, labels.get(p.id) ?? '');
    clockList.append(label);
  }
}
/** the clock's timer: a worker's (it keeps its pace in a background tab), else the page's */
function clockTimerOn(on: boolean): void {
  if (on && clockTimer === null) {
    try {
      const w = new Worker(new URL('./clock-tick.ts', import.meta.url), { type: 'module' });
      w.onmessage = () => clockOut.pump();
      clockTimer = w;
    } catch {
      clockTimer = window.setInterval(() => clockOut.pump(), 25);
    }
  } else if (!on && clockTimer !== null) {
    if (typeof clockTimer === 'number') clearInterval(clockTimer);
    else clockTimer.terminate();
    clockTimer = null;
  }
}
async function setClockOut(on: boolean): Promise<void> {
  if (on && !clockAccess) {
    if (!navigator.requestMIDIAccess) {
      devStatus('Web MIDI is not available in this browser (use Chrome or Edge)');
      return;
    }
    try {
      clockAccess = await navigator.requestMIDIAccess();
      clockAccess.addEventListener('statechange', showClockPorts);
    } catch (e) {
      devStatus(`MIDI access denied: ${e}`);
      return;
    }
  }
  clockPrefs.on = on;
  saveClockPrefs();
  showClockPorts(); // (the ports first: switched on, the first clocks go out at once)
  clockOut.enable(on);
  clockTimerOn(on);
  showClockPorts();
}
clockBtn.onclick = () => void setClockOut(!clockOut.running);
showClockPorts();
if (clockPrefs.on && 'requestMIDIAccess' in navigator) void setClockOut(true);

// The compact workspace drawer leaves the whole patch usable on small screens.
const sidebar = $('workspace-sidebar');
const sidebarToggle = $('sidebar-toggle');
const sidebarDismiss = document.querySelector<HTMLButtonElement>('.sidebar-dismiss')!;
const workspaceMain = document.querySelector<HTMLElement>('main')!;
const compactWorkspace = window.matchMedia('(max-width: 700px)');
const setSidebarOpen = (open: boolean): void => {
  if (!open && sidebar.contains(document.activeElement) && compactWorkspace.matches) sidebarToggle.focus();
  sidebar.classList.toggle('open', open);
  sidebarToggle.setAttribute('aria-expanded', String(open));
  sidebarDismiss.hidden = !open;
  workspaceMain.inert = open && compactWorkspace.matches;
};
const closeSidebar = (): void => setSidebarOpen(false);
sidebarToggle.onclick = () => setSidebarOpen(!sidebar.classList.contains('open'));
sidebarDismiss.onclick = closeSidebar;
compactWorkspace.addEventListener('change', closeSidebar);
// collapsing the sidebar (wide layouts): the canvas runs the full height, the sidebar keeps a strip beside the Main dock (logo, tabs, expand)
const SIDEBAR_COLLAPSED = 'matryoshka.sidebar-collapsed';
const collapseBtn = $('sidebar-collapse');
const setSidebarCollapsed = (on: boolean): void => {
  if (on && sidebar.contains(document.activeElement) && document.activeElement !== collapseBtn) (document.activeElement as HTMLElement).blur();
  sidebar.parentElement!.classList.toggle('side-collapsed', on);
  collapseBtn.textContent = on ? '»' : '«';
  collapseBtn.setAttribute('aria-expanded', String(!on));
  collapseBtn.title = `${on ? 'Expand' : 'Collapse'} the sidebar (Ctrl/Cmd+B)`;
  collapseBtn.setAttribute('aria-label', `${on ? 'Expand' : 'Collapse'} the sidebar`);
  try {
    if (on) localStorage.setItem(SIDEBAR_COLLAPSED, '1');
    else localStorage.removeItem(SIDEBAR_COLLAPSED);
  } catch {
    /* storage blocked: the choice lasts until the page is reloaded */
  }
  editor.positionSideCables();
};
// the theme toggle beside the collapse button: shows the theme a click switches to
const themeBtn = $('theme-btn');
const showTheme = (): void => {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  themeBtn.textContent = next === 'dark' ? '☾' : '☀';
  themeBtn.title = `${next === 'dark' ? 'Dark' : 'Light'} theme`;
  themeBtn.setAttribute('aria-label', `Switch to the ${next} theme`);
  envs.changed(); // canvases read the colour tokens when they draw
  screens.state();
  editor.positionSideCables();
};
themeBtn.onclick = toggleTheme;
onThemeChange(showTheme);
showTheme();
const toggleSidebarCollapsed = (): void => setSidebarCollapsed(!sidebar.parentElement!.classList.contains('side-collapsed'));
collapseBtn.onclick = toggleSidebarCollapsed;
sidebar.querySelector<HTMLElement>('.brand')!.addEventListener('click', (e) => {
  if (sidebar.parentElement!.classList.contains('side-collapsed')) setSidebarCollapsed(false);
  if ((e.target as Element).closest('.logo, .wordmark') && currentView !== 'patch') setView('patch');   // the logo: back to the canvas
});
try {
  if (localStorage.getItem(SIDEBAR_COLLAPSED)) setSidebarCollapsed(true);
} catch {
  /* storage blocked: start expanded */
}

// LIBRARY's sections (#218): it manages what is stored and opens nothing. Community is opt-in: its patches are decoded
// when Library > Community first shows, or now when some were added to Your patches (the Open picker, the palette and
// Library > Patches list those, once decoded)
libraryPanes.patches = buildPatchesSection($('lib-patches'), device, { remove: deleteSaved });
if (addedTitles().length) void loadCommunity().then(() => { fillPicker(); libraryPanes.patches?.refresh(); });
libraryPanes.community = buildCommunitySection($('lib-community'), { status: (msg) => { status.textContent = msg; } });
libraryPanes.presets = buildPresetsSection($('lib-presets'), device, { changed: () => editor.rebuild() });
refreshAssemblies = buildAssembliesSection($('lib-assemblies'), {
  status(msg) {
    status.textContent = msg;
  },
  changed() {
    tutorial.refresh();
  },
});
buildFlashTab($('flash-body'));
const about = new AboutCard($<HTMLDialogElement>('about'));
$('about-btn').onclick = (e) => {
  e.stopPropagation();   // under the logo, which expands the collapsed sidebar
  void about.open();
};

// the address (#218): #library opens LIBRARY on Patches, #presets, #assemblies and #community on those sections, #emu (and the old #fm1)
// EMU, #flash the Install panel, #about the About card. Other sites link here (fm1-editor.com/firmware: #flash and #fm1).
// Without one a page load opens PATCH
const openFromAddress = (): void => {
  const h = location.hash.slice(1);
  if (h === 'patch') setView('patch');
  if (h === 'library' || h === 'presets' || h === 'assemblies' || h === 'community') setLibrarySection(h === 'library' ? 'patches' : h);
  if (h === 'emu' || h === 'fm1') setView('emu');
  if (h === 'flash') openInstall();
  if (h === 'about') void about.open();
};
openFromAddress();
window.addEventListener('hashchange', openFromAddress);


// a returning visitor on a new version sees what changed, once, instead of the tutorial's welcome
if (currentView === 'patch' && !installOpen() && !isShareLink(location.href) && !whatsNew()) tutorial.welcome();
// the old address's hand-off (?migrate=1), and the toast of an import before the reload
receiveMigration((keys, origin) => importBrowserData(keys, new URL(origin).host));
/** everything the app keeps in this browser at this address, as a backup file ("Load .json" takes it) */
function saveBrowserBackup(): void {
  const file = backupFile(collectKeys(), location.origin);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' }));
  a.download = `matryoshka-backup-${file.saved.slice(0, 10)}.json`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const move = moveOffer(saveBrowserBackup);
try {
  const imported = sessionStorage.getItem(IMPORTED);
  if (imported) {
    sessionStorage.removeItem(IMPORTED);
    showToast(imported, 12000);
  }
} catch {
  /* storage blocked */
}
// Audio is enabled by default. A fresh browser may require a trusted gesture to resume it.
const unlockAudio = (): void => { if (!host.running) void startAudio(); };
window.addEventListener('pointerdown', unlockAudio, { capture: true });
window.addEventListener('keydown', unlockAudio, { capture: true });
void startAudio();

// This link and the editor's server route exist only during local development.
if (import.meta.env.DEV) {
  import.meta.hot?.on('lesson-course-saved', () => location.reload());
  // the lesson editor's live link: it checks steps against this synth and loads patches into it
  tutorial.observer = synthLink(() => ({
    patch: editor.patch, selected: [...editor.selected], arpPlay: editor.playing, audio: host.running && !host.muted,
    snapshots: { A: !!editor.snapshots.A, B: !!editor.snapshots.B }, zoom: editor.zoom, library: loadLibrary(),
  }), (p) => { sink.send({ t: 'panic' }); loadNamed(p, { quiet: true }); });
  const link = document.createElement('a');
  link.href = '/lesson-editor'; link.target = '_blank'; link.rel = 'noopener';
  link.textContent = 'Edit lessons';
  document.querySelector('.sidebar-bottom')?.append(link);
}

// the emulator scenarios (npm run emu:scenarios, docs/EMULATOR.md, #290): open a patch by name, read the editor's side of
// the link. Development server only
if (import.meta.env.DEV) {
  const inputs: unknown[] = [];   // what the followed FM-1's panel did, as the mirror read it
  const onInput = mirror.onInput;
  mirror.onInput = (i) => { inputs.push({ at: Math.round(performance.now()), ...i }); onInput(i); };
  (window as unknown as { __m1test?: unknown }).__m1test = {
    inputs: (): unknown[] => inputs.splice(0),
    open: (name: string): boolean => {
      const o = openableGroups().flatMap((g) => g.items).find((x) => x.name === name);
      if (o) loadNamed(o.load(), { from: o.from });
      return !!o;
    },
    state: () => ({
      connected: device.connected, live: liveOn, fits: fitsDevice, sandbox: sandboxOn(), chip: fm1State(), following: mirror.following,
      playing: editor.playing, deviceRunning: device.running, octave: noteKeys.octave(), focus: editor.focus, patch: editor.patch.name,
      syncAsk: syncAsk.open, status: $('dev-status').textContent,
    }),
    patchJson: (): string => JSON.stringify(editor.patch),
  };
}
