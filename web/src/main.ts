// SPDX-License-Identifier: GPL-3.0-only
import { CPU, CPU_WARN } from './cpu';
import { setupPopoverPositioning } from './popover';
import { AudioHost } from './audio';
import type { HostMsg } from './worklet';
import { chipState, DeviceLink, deviceIndex, syncOnConnect, type ChipState, type DeviceEvent } from './device';
import { Fm1View } from './fm1-view';
import { Editor, ZOOM_MAX, ZOOM_MIN } from './editor';
import { ScopeScreens } from './scope-view';
import { EnvScreens } from './env-view';
import { addToBank, bankPatches, buildBankTab } from './bank';
import { isSaved, onSavedChange, putBackSaved, removeSaved, restoreSaved, savedPatches, savePatch as keepPatch, unsavedChanges } from './saved';
import { showToast, showUndo } from './toast';
import { popMenu, type MenuItem } from './menu';
import { initStatusline, pinStatus } from './statusline';
import { buildAssembliesTab, storeAssembly, storeTutorialAssembly } from './assemblies';
import { AssemblyBrowser } from './browser';
import { searchCommands, type Command } from './commands';
import { buildFlashTab } from './flasher';
import { attachKeyboard, attachMidi, isTextEntry } from './input';
import { Piano } from './piano';
import { sliderJack } from './slider-jack';
import { PANEL_BUTTONS } from './modules';
import { switches } from './buttons';
import { Fm1Mirror } from './mirror';
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
import { decodeShare, encodeShare, shareCodeOf } from './share';
import { buildCommunityShelf } from './community';
import { ShareSheet } from './share-sheet';
import { fileStem, savePatchCard } from './patch-card';
import { starterPatch } from './starter';
import { recordKey, recordNote, recordOff } from './step-grid';
import { Tutorial } from './tutorial/tutorial';
import { synthLink } from './tutorial/link';
import { PRESETS } from './presets';
import { inlineWordmarks } from './brand';
import { clipText, parseClip, type Clip } from './clipboard';
import { addableModules, assemblyShelves, openableByValue, openableGroups } from './catalog';
import { binaryPage, deviceBudget, editorPage, encodePatch, POLY_ROW, POLY_ROW_PARAMS, toQ16 } from './patchbin';
import { ALLOC, deviceView } from './poly';
import { AboutCard } from './about';
import { demoPatch } from './demo';
import { renamedKey } from './storage-key';
import { currentTheme, onThemeChange, setTheme, themeChoice, toggleTheme } from './theme';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const STORE = renamedKey('matryoshka.patch', 'modular-1.patch');

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

let currentTab = 'patch';
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
const live = (): boolean => device.connected && $<HTMLInputElement>('dev-live').checked && fitsDevice;
let uploadTimer = 0;
let uploading = false;
let dirty = false;
const devStatus = (s: string): void => {
  $('dev-status').textContent = s;
  syncChip();
};
/** the FM-1 chip in the status line (#152, #171): not connected, synced, not synced, or the patch too big to sync. A click
 *  while not synced offers Live sync (offerSync); otherwise it opens FM-1 & MIDI. Every connect and disconnect reports
 *  through devStatus, and Live, the budget and the dialog's choice call it too; Release MIDI reloads the page. */
const fm1Chip = $<HTMLButtonElement>('fm1-chip');
const fm1State = (): ChipState => chipState(device.connected, $<HTMLInputElement>('dev-live').checked, fitsDevice);
const syncChip = (): void => {
  const s = fm1State();
  fm1Chip.classList.toggle('on', s === 'synced');
  fm1Chip.classList.toggle('idle', s === 'not synced');
  fm1Chip.classList.toggle('over', s === 'patch too big to sync');
  fm1Chip.querySelector('.sl-chip-text')!.textContent = `FM-1 \u00b7 ${s}`;
  const does = s === 'not synced' ? 'sync with the FM-1' : 'open FM-1 & MIDI';
  fm1Chip.setAttribute('aria-label', `FM-1 ${s}: ${does}`);
  fm1Chip.title = s === 'not synced' ? 'Sync with the FM-1: it plays the editor\'s patch, and changes on either side follow the other'
    : s === 'patch too big to sync' ? 'The patch is over the FM-1 budget: it plays here only (the budget beside says what is over). FM-1 & MIDI'
    : 'FM-1 & MIDI: connect, send, store, follow its panel';
};
fm1Chip.onclick = () => {
  if (fm1State() === 'not synced') offerSync(true);
  else $<HTMLDialogElement>('device-bar').showModal();
};
syncChip();
device.onStatus = devStatus;
// the FM-1 on its own (#65): while Live is on, its knobs and patch buttons move the editor's, and the status line follows its slot
let fromDevice = false;
/** the change comes from the FM-1 tab's emulator (fm1-view.ts): not sent back to it, but on to a Live FM-1 */
let fromEmu = false;
let deviceSlot: { slot: number; name: string } | null = null;
device.onEvent = (e) => {
  if (e.kind === 'slot') {
    deviceSlot = { slot: e.slot, name: e.name };
    devStatus(`FM-1 plays slot ${String(e.slot + 1).padStart(2, '0')} ${e.name}`);
    return;
  }
  // the panel itself (knobs, buttons, the focus) comes in as plain MIDI through the mirror (#120, fm1-profiles.ts), whatever
  // firmware runs: the FM-1's PARAM_NOW / FOCUS_NOW and its CC here are not used
  if (e.kind === 'param' || e.kind === 'focus' || e.kind === 'cc') return;
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
      if (e.kind === 'track') editor.trackFromDevice(id, e.notes);
      else host.send({ t: 'mute', id, on: e.on });
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
/** Live sync on or off, as the checkbox in FM-1 & MIDI does it (on: the FM-1 gets the editor's patch) */
function setLive(on: boolean): void {
  $<HTMLInputElement>('dev-live').checked = on;
  syncChip();
  if (!on) return;
  declineSync(false);
  void sendPatch();
}
const syncAsk = $<HTMLDialogElement>('sync-ask');
syncAsk.onclose = () => {
  if (syncAsk.returnValue === 'sync') return setLive(true);
  declineSync(true); // Not now, Esc: off, and a reconnect in this visit does not ask again
  setLive(false);
  devStatus('Live sync is off: the FM-1 chip in the status line turns it on');
};
/**
 * Connecting the FM-1 (`asked`: or a click on the chip) offers Live sync (syncOnConnect). Already on, a reconnect sends the
 * patch again (the FM-1 may have restarted). The FM-1's own patch is not read: the protocol reads a slot's name and length
 * (SLOT_INFO), not its patch, so nothing can be compared or opened and it always asks.
 */
function offerSync(asked = false): void {
  if (!device.connected) return syncChip();
  if ($<HTMLInputElement>('dev-live').checked && !asked) {
    if (fitsDevice) void sendPatch();
    return syncChip();
  }
  const d = syncOnConnect({ fits: fitsDevice, declined: !asked && syncDeclined(), editorBin: fitsDevice ? encodePatch(editor.patch) : new Uint8Array(), deviceBin: null });
  if (d === 'sync') return setLive(true);
  if (d === 'ask' && !syncAsk.open) {
    $('sync-ask-text').textContent = `The editor's patch "${editor.patch.name.trim() || 'Untitled'}" will play on the FM-1, and changes on either side follow the other.`;
    syncAsk.returnValue = '';
    syncAsk.showModal();
  }
  if (d === 'too-big') devStatus('over the FM-1 budget: Live sync stays off until the patch fits');
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
      // (an armed track's keys stay here: the FM-1 does not arm, #139)
      if (editor.armedTrack === null) device.note(msg as { t: string; note?: number; vel?: number });
      if (msg.t === 'bend') device.bend(msg.v);
      else if (msg.t === 'cc') device.cc(msg.n, msg.v);
    }
  },
};
/** what the armed track plays (Editor onArm), for the status line */
let armPlays: string[] = [];
/** the status line while a track is armed (#134) or recording (#135): what the keys play and what REC does now */
function showArmed(): void {
  const id = editor.armedTrack;
  if (id === null) return pinStatus(null, 'arm');
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
const patchCandidates = (): { name: string; patch: Patch }[] => {
  const seen = new Set<string>();
  const out: { name: string; patch: Patch }[] = [];
  for (const c of [...snapshotCandidates(), ...savedPatches(), ...bankPatches(), ...Object.entries(PRESETS).map(([name, make]) => ({ name, patch: make() }))])
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
host.onSteps = (view) => editor.showSteps(view);
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
  track: (m, notes) => fm1Event({ kind: 'track', module: m, notes }, 'emu'),
  mute: (m, on) => fm1Event({ kind: 'mute', module: m, on }, 'emu'),
  // REC held + a black key on the emulated FM-1 (#139): the editor arms the same track, so the keys the page plays (the
  // emulator's MIDI out) go through it as they do on the device
  arm: (m) => editor.armTrack(m < 0 ? null : deviceView(editor.patch, true).patch.modules[m]?.id ?? null),
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
    if (!fromEmu) emuParam(id, name, value);
    if (fromDevice) return;
    if (live() && !uploading) device.param(editor.patch, id, name, value);
    else if (live()) dirty = true;
  },
  onTrack(id, notes) {
    host.send({ t: 'track', id, notes });
    if (!fromEmu) queueEmu();
    queueSave(editor.patch);
    if (fromDevice) return;
    if (live() && !uploading) device.track(editor.patch, id, notes);
    else if (live()) dirty = true;
  },
  onArm(id, plays) {
    host.send({ t: 'arm', id });
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
    const r = storeAssembly(def);
    status.textContent = r === 'cancelled' ? 'not saved' : `"${def.name}" ${r === 'replaced' ? 'replaced in' : 'saved to'} the assembly library`;
    refreshAssemblies();
    if (r !== 'cancelled') tutorial.saved(def);
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
/** the Open picker: the user's saved patches (rebuilt on every save), the examples, the tutorial chapters' ends (catalog.ts) */
const fillPicker = (): void => {
  presetSel.replaceChildren(
    new Option('Open a patch…', ''),
    ...openableGroups().map(({ label, items }) => {
      const g = document.createElement('optgroup');
      g.label = label;
      g.append(...items.map((o) => new Option(o.name, o.value)));
      return g;
    }),
  );
};
fillPicker();
onSavedChange(fillPicker);
void inlineWordmarks(); // the sidebar's wordmark in the theme's colours
presetSel.onchange = () => {
  const o = openableByValue(presetSel.value);
  if (o) { loadNamed(o.load(), { from: o.value.startsWith('saved:') ? o.name : undefined }); closeSidebar(); }
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
// the patch menu (#152): the PATCH header's ⋯ and the mobile bar's Patch ⋯ reach what moves a patch in or out of the
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
  const memOver = b.over.filter((i) => i.key !== 'cpu');
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
  );
  const note = document.createElement('p');
  note.className = 'muted';
  note.textContent = b.fits
    ? 'The CPU figure is an estimate: counted on a model of the FM-1\'s processor, calibrated on the factory patches measured on the FM-1. Treat anything above 80 % as tight.'
    : 'Plays in the browser. The FM-1 cannot run it: Send, Store and Live stay off, and the Library keeps it under "Over budget".';
  list.append(note);
  pinStatus(b.fits ? null : { tag: 'Too much for the FM-1', text: `${b.over.map((i) => i.key === 'cpu' ? `CPU ${i.used} %` : `${i.used} ${i.label} of ${i.max}`).join(', ')}. It plays here; click the budget for what costs most.` });
  if (was && !b.fits && device.connected) devStatus('over the FM-1 budget: Live paused until the patch fits');
  requestAnimationFrame(placeBudget);
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
const browser = new AssemblyBrowser((d) => { switchTab('patch'); editor.insert(d); });

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
const inPatch = (run: () => void): (() => void) => () => { switchTab('patch'); run(); };
const commands = (): Command[] => {
  const assembly = (d: AssemblyDef, shelf: string): Command => ({
    kind: 'assembly', tags: ['assembly', ...(defIsEngine(d) ? ['engine'] : []), shelf], label: d.name, detail: shelf, keywords: `insert ${summary(d)}`,
    run: () => editor.insert(d),
  });
  return [
    { kind: 'command', label: 'Save patch', keywords: 'keep store your patches', run: saveCurrent },
    { kind: 'command', label: 'Save patch as .json', keywords: 'export download file', run: savePatch },
    { kind: 'command', label: 'Load patch from .json', keywords: 'import open file', run: () => $('load-file').click() },
    { kind: 'command', label: 'Share patch\u2026', keywords: 'link copy url clipboard reddit post card notes', run: () => shareSheet.open() },
    { kind: 'command', label: 'Save patch card (PNG)', keywords: 'image picture share post export download', run: () => void saveCard() },
    { kind: 'command', label: 'Tutorial', keywords: 'learn help starter tour chapters course', run: () => { switchTab('patch'); tutorial.open(); } },
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
    { kind: 'command', label: 'Flash firmware', keywords: 'install update hardware', run: () => switchTab('flash') },
    { kind: 'command', label: 'About Matryoshka', keywords: 'credits support ko-fi donate ai usage transparency', run: () => void about.open() },
    { kind: 'command', label: 'Keyboard shortcuts', keywords: 'help', detail: '?', run: () => help.showModal() },
    { kind: 'command', label: currentTheme() === 'dark' ? 'Theme: light' : 'Theme: dark', keywords: 'theme dark light mode colours colors night day appearance', run: () => toggleTheme() },
    ...(themeChoice() ? [{ kind: 'command' as const, label: 'Theme: follow the system', keywords: 'theme dark light mode auto os appearance', run: () => setTheme(null) }] : []),
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
    ...openableGroups().flatMap((g) => g.items.map((o) => ({ kind: 'load patch', label: o.name, detail: g.label, run: () => loadNamed(o.load(), { from: g.label === 'Your patches' ? o.name : undefined }) }))),
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
  if (!o.stay) switchTab('patch');
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
  if (c.kind !== 'command') switchTab('patch');
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
$('add-btn').onclick = () => openPalette('module');
$('add-assembly-btn').onclick = () => openPalette('assembly');
$('tidy-btn').onclick = () => editor.tidyUp();
$('fit-btn').onclick = () => editor.zoomToFit();
$('expand-all-btn').onclick = () => editor.setAllOpen(true);
$('collapse-all-btn').onclick = () => editor.setAllOpen(false);
$('tour-btn').onclick = () => { switchTab('patch'); tutorial.open(); };
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
  if (currentTab !== 'patch') return;
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
  else if (e.shiftKey && !mod && !e.altKey && k.toLowerCase() === 'r') {   // REC on the armed track (#135)
    if (!editor.toggleRec()) status.textContent = 'Shift+R records on the armed track: ARM a Steps track first';
    done = true;
  }
  else if (k === 'Escape') (editor.cancelArm(), editor.endPick(), (diffPanel.hidden = true), (done = true));
  else if (k === 'Delete' || k === 'Backspace') done = editor.removeSelected();
  else if (mod && k.toLowerCase() === 'a') (editor.selectAll(), (done = true));
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
  if (currentTab !== 'patch' || isTextEntry(t) || t?.tagName === 'SELECT' || document.querySelector('dialog[open], [popover]:popover-open')) return false;
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
// PLAY in the dock's button block and Space are one switch: the transport (Main's run output and clock)
function syncPlayBtn(): void {
  arpBtn.setAttribute('aria-pressed', String(editor.playing));
}
function setPlaying(on: boolean): void {
  if (on) host.mute(false);
  editor.playing = on;
  host.transport(on);
  if (live()) device.transport(on);
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
  const over = b.over.map((i) => i.key === 'cpu' ? `CPU ${i.used} %` : `${i.used} ${i.label} (the FM-1 holds ${i.max})`).join(', ');
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
  const id = editor.armedTrack;
  emu.ui?.arm(id === null ? -1 : deviceView(editor.patch, true).patch.modules.findIndex((m) => m.id === id));
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
/** the emulated PRESET knob: the next / previous entry of the Open list's Your patches and Examples (not Community) */
function stepOpenList(d: number): void {
  const list = openableGroups().filter((g) => g.label !== 'Tutorial' && g.label !== 'Community').flatMap((g) => g.items.map((o) => ({ ...o, mine: g.label === 'Your patches' })));
  if (!list.length || !d) return;
  const i = list.findIndex((o) => o.name === editor.patch.name);
  const next = list[(((i < 0 ? (d > 0 ? -1 : 0) : i) + d) % list.length + list.length) % list.length];
  loadNamed(next.load(), { from: next.mine ? next.name : undefined, stay: true });
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
// the Patch | FM-1 switch over the canvas
const viewBtns = [...document.querySelectorAll<HTMLButtonElement>('#view-switch [data-view]')];
function setView(v: 'patch' | 'fm1'): void {
  for (const b of viewBtns) b.setAttribute('aria-selected', String(b.dataset.view === v));
  $('canvas').hidden = v !== 'patch';
  $('help-btn').hidden = v !== 'patch';
  // the FM-1 is its own instrument: its panel has the keys and knobs, so the Main dock, the wheels and the keyboard go
  document.querySelector('.workspace')!.classList.toggle('fm1-mode', v === 'fm1');
  host.setMaster(v === 'fm1' ? emuLevel : 1);
  if (v === 'fm1') void emu.show();
  else emu.hide();
}
for (const b of viewBtns) b.onclick = () => setView(b.dataset.view as 'patch' | 'fm1');

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

// FM-1 link
$('dev-btn').onclick = async () => {
  try {
    const info = await device.connect();
    devStatus(`FM-1 connected (protocol ${info.version}, up to ${info.maxModules} modules, flash ${info.flashOk ? 'ok' : 'not available'})`);
    for (const id of ['dev-live', 'dev-send', 'dev-store']) $<HTMLInputElement>(id).disabled = false;
    $('dev-btn').textContent = 'Reconnect';
    if (!mirror.following) void followFm1('matryoshka');   // it runs Matryoshka (it answered HELLO): its panel drives the page
    offerSync();
  } catch (e) {
    devStatus((e as Error).message);
  }
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
      case 'knob': editor.turnKnob(i.k, i.u); break;
      case 'master': emu.setMaster(i.v); host.setMaster(i.v); break;
      case 'transport': setPlaying(i.run); break;
      case 'enc':
        if (i.n === ENCODERS.preset && live()) break;          // (with Live the FM-1 plays the editor's patch: its slots are its own)
        emu.drive(i);
        break;
      case 'button': {
        const b = PANEL_OF_ID.get(i.id);
        emu.drive(i);
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
$('mirror-btn').onclick = () => {
  if (mirror.following) {
    mirror.stop();
    emu.following(null, null);
    $('mirror-btn').textContent = 'Follow its panel';
    devStatus('not following the FM-1');
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
    if (was.used && !window.confirm(`FM-1 slot ${String(n).padStart(2, '0')} holds "${was.name}". Replace it with "${editor.patch.name}"?`)) return devStatus('nothing stored');
    await device.uploadSlot(n - 1, editor.patch.name.toUpperCase().slice(0, 20), editor.patch);
    devStatus(`"${editor.patch.name}" stored into FM-1 slot ${String(n).padStart(2, '0')}`);
  } catch (e) {
    devStatus((e as Error).message);
  }
}
$('dev-live').onchange = () => setLive($<HTMLInputElement>('dev-live').checked);
$('dev-store').onclick = async () => {
  try {
    if (!(await sendPatch())) return;
    await device.store();
    setBaseline();
    devStatus(`stored into the FM-1's slot ${deviceSlot ? String(deviceSlot.slot + 1).padStart(2, '0') : ''} (the one it plays; it opens it at the next start)`);
  } catch (e) {
    devStatus((e as Error).message);
  }
};

/** copy the link without the sheet (the tutorial's host); a patch too big for a link is not copied */
const sharePatch = async (): Promise<void> => {
  try {
    const s = await encodeShare(editor.patch);
    if (s.tooLong) {
      status.textContent = `too big for a link (${s.length} characters without the layout): Save as .json and share the file`;
      return;
    }
    await navigator.clipboard.writeText(s.link);
    status.textContent = `link copied (${s.length} characters${s.layout ? '' : '; too long with the layout: the cards open on a grid'})`;
    tutorial.shared();
  } catch (e) {
    status.textContent = `share failed: ${(e as Error).message}`;
  }
};
// a link with a patch in its fragment: load it (it is not saved over the remembered patch until something is changed)
const loadFromHash = (): void => {
  const shared = shareCodeOf(location.href);
  if (!shared) return;
  void decodeShare(shared, DEFS)
    .then((p) => {
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

// the share sheet (#165): the ⋯ menu's Share… and the palette
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
    loadNamed(validatePatch(JSON.parse(await f.text()), DEFS));
  } catch (err) {
    status.textContent = `load failed: ${(err as Error).message}`;
    showToast(status.textContent);
  }
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
// Web MIDI is only asked for on request: while a page holds MIDI access, Chromium's ALSA backend tracks every MIDI port on the
// system and aborts the whole browser (SIGILL in midi::MidiManager::SetInputPortState) when the ports change, for example when
// the FM-1 re-enumerates after a reset or a firmware update.
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
// MIDI is on by default (the browser asks once), unless the user switched it off. Not on Linux: there Chromium's ALSA
// backend crashes the browser when ports change while a page holds MIDI access (see above), so it waits for the button.
const midiOffChosen = ((): boolean => {
  try {
    return localStorage.getItem(MIDI_OFF) === '1';
  } catch {
    return false;
  }
})();
if (!midiOffChosen && !/Linux/.test(navigator.userAgent) && 'requestMIDIAccess' in navigator) {
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
sidebar.querySelector<HTMLElement>('.brand')!.addEventListener('click', () => {
  if (sidebar.parentElement!.classList.contains('side-collapsed')) setSidebarCollapsed(false);
});
try {
  if (localStorage.getItem(SIDEBAR_COLLAPSED)) setSidebarCollapsed(true);
} catch {
  /* storage blocked: start expanded */
}

// tabs
// the Community patches card goes first, above Your patches (#157). Post yours opens the share sheet (#165)
buildCommunityShelf($('tab-library'), {
  open: (p) => loadNamed(p, { once: true }),
  post: () => shareSheet.open(), // the share sheet: Copy link, Post to Reddit, Submit to the Community shelf
  loaded: fillPicker,
});
const refreshBank = buildBankTab($('tab-library'), device, () => editor.patch, (msg) => {
  devStatus(msg);
  for (const id of ['dev-live', 'dev-send', 'dev-store']) $<HTMLInputElement>(id).disabled = false;
  offerSync();
}, (p, from) => loadNamed(p, { from }), deleteSaved);
refreshAssemblies = buildAssembliesTab($('tab-library'), {
  insert(def) {
    document.querySelector<HTMLButtonElement>('#tabs button[data-tab="patch"]')?.click();
    editor.insert(def);
  },
  status(msg) {
    status.textContent = msg;
  },
});
buildFlashTab($('tab-flash'));
const about = new AboutCard($<HTMLDialogElement>('about'));
$('about-heart').onclick = () => void about.open();
const switchTab = (name: string): void => {
  currentTab = name;
  closeSidebar();
  for (const button of document.querySelectorAll<HTMLButtonElement>('#tabs button')) {
    const active = button.dataset.tab === name;
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active || (name !== 'patch' && name !== 'library' && button.dataset.tab === 'patch') ? 0 : -1;
  }
  for (const tab of document.querySelectorAll<HTMLElement>('.tab')) tab.hidden = tab.id !== `tab-${name}`;
  document.querySelector<HTMLElement>('.patch-controls')!.hidden = name !== 'patch';
  editor.positionSideCables();
  if (name === 'patch') requestAnimationFrame(() => editor.drawCables());
  if (name === 'library') refreshBank();
};
for (const b of document.querySelectorAll<HTMLButtonElement>('#tabs button')) {
  b.onkeydown = (e) => {
    if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const tabs = [...document.querySelectorAll<HTMLButtonElement>('#tabs button')];
    const index = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (tabs.indexOf(b) + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length;
    tabs[index].click(); tabs[index].focus();
  };
  b.onclick = () => switchTab(b.dataset.tab!);
}

// open the tab named in the address (#library, #flash; the old #presets and #assemblies open the Library; #about opens the About card)
{
  const h = location.hash.slice(1);
  const tab = h === 'presets' || h === 'assemblies' ? 'library' : h;
  if (['patch', 'library', 'flash'].includes(tab)) switchTab(tab);
  if (tab === 'about') void about.open();
}


if (currentTab === 'patch' && !shareCodeOf(location.href)) tutorial.welcome();
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
