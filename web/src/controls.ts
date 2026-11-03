// SPDX-License-Identifier: GPL-3.0-only
// The FM-1's controls, defined once (#553). Every row is one control in one or more states of the FM-1: its gesture, the
// words the controls sheet shows for it, where it shows and in what order, and what it does (its effect). Everything that
// tells a person about the FM-1's controls is made from this table:
//   - the controls sheet (OCT- + OCT+, help_ui.c): `npm run export-defs` writes firmware/src/controls.h, help_rows reads it;
//   - firmware/test/panel_test.c (controls_test.h) drives each row's gesture in its state and checks its effect, so a
//     handler that no longer does what its row says fails the test.
// A row's condition (`when`) names a C function `hc_<name>` in help_ui.c; export-defs checks that it is there.
// The input handlers (panel.c, seq_ui.c, menu.c) do not read this table (#552 moves them onto it later, page by page).

/** the states the controls sheet knows (help_ui.c HS_*, in that order): its first tab is named after the one the FM-1 is in */
export const HELP_STATES = ['device', 'env', 'drum', 'roll', 'live', 'song', 'menu', 'sandbox', 'step'] as const;
export type HelpState = (typeof HELP_STATES)[number];
/** a state's name on the sheet's tab */
export const HELP_STATE_NAME: Record<HelpState, string> = {
  device: 'DEVICE', env: 'ENVIRONMENT', drum: 'DRUM STEPS', roll: 'PIANO ROLL', live: 'LIVE TAKE', song: 'SONG', menu: 'SETTINGS',
  sandbox: 'SANDBOX', step: 'STEP RECORD',
};

/** the panel's buttons by matrix id (M-VAVE's order, panel.c; the same as fm1-ui.ts BUTTONS). OCT: either OCT button */
export const BUTTON_ID = { 'OCT-': 0, 'OCT+': 1, FX: 2, SEL: 3, ENV: 4, LFO: 5, EDIT: 6, GLO: 7, HOME: 8, SAVE: 9, ARP: 10, SEQ: 11, PLAY: 12, REC: 13, OCT: 1 } as const;
export type Button = keyof typeof BUTTON_ID;
/** the encoders by their index in panel.c panel_encoders (K1..K4 are 2..5) */
export const ENCODER_ID = { SELECT: 0, ALGO: 1, PRESET: 6 } as const;
export type Encoder = keyof typeof ENCODER_ID;

/** one control a gesture uses */
export type Part =
  | { button: Button }
  | { encoder: Encoder }
  | { knobs: '1' | '2' | '3' | '4' | '1234' }           // K1..K4: the ones named
  | { key: 'white' | 'black' | 'any' | 'keys' | 'chord'; n?: number };   // a white key, a black key (n: black key n), any
                                                        // key, the keys played, keys pressed together
/** what is done: `do` while `hold` is held. Several parts in `do` are alternatives (either one), or with `join: 'list'`
 * a list of buttons that all do the same. `how`: tap (a short press), held (kept down while the keys play), hold 2 s.
 * `where`: where on the screen it applies ("on END") */
export interface Gesture {
  hold?: Button | 'step';
  do: Part[];
  join?: 'or' | 'list';
  how?: 'tap' | 'held' | 'hold 2 s';
  where?: string;
}

/** what a row's gesture changes, as panel_test checks it (firmware/test/controls_test.h ctl_effect) */
export const EFFECTS = [
  'transport', 'record', 'save', 'back', 'menu', 'env', 'seq', 'octave', 'tempo', 'patch', 'store', 'arm', 'mute',
  'focus', 'device_page', 'list_back', 'list_page', 'preset', 'param', 'fine',
  'step', 'row', 'roll_view', 'roll_pitch', 'jump', 'track', 'pattern', 'accent', 'tie', 'step_record', 'step_record_at',
  'velocity', 'chance', 'pitch', 'lock_page', 'lock', 'song_page', 'clear', 'steps_page', 'keys_octave',
  'write', 'chord', 'rest', 'cursor', 'back_clear', 'live', 'end',
  'take', 'take_accent',
  'entry', 'entry_pattern', 'add_entry', 'dup_entry', 'transpose', 'song_play', 'song', 'delete_entry', 'back_steps',
  'tab', 'scroll', 'set', 'save_close', 'run_row',
  'editor',
] as const;
export type Effect = (typeof EFFECTS)[number];

/** the conditions a row can show under (help_ui.c hc_<name>); '!name': when it is false */
export const CONDITIONS = ['list', 'dev_presets', 'dev_store', 'dev_keys', 'long_track', 'tracks', 'menu_guide', 'menu_page', 'menu_system', 'roll'] as const;
export type Condition = (typeof CONDITIONS)[number];

export interface ControlRow {
  id: string;
  gesture: Gesture;
  /** the sheet's description (after the gesture); '' none. `{list}`: the Page button whose list shows, as the top bar
   * names it (help_ui.c help_fill; in the editor's and the README's words LIST_WORDS) */
  does: string;
  /** the sheet's description on the tab of the states named, where it differs from `does` */
  doesIn?: Partial<Record<HelpState, string>>;
  /** its words off the sheet (the editor's help, the button editor, the README) where `does` leans on the sheet around
   * it ("^ but at step n/16"); else `does` */
  plain?: string;
  /** a grey line on the sheet before the row ("in the editor:") */
  heading?: string;
  /** the state tabs it shows on, each with its order there (lower first) */
  sheet?: Partial<Record<HelpState, number>>;
  /** the EVERYWHERE tab: the states whose EVERYWHERE tab lists it, each with its order there */
  everywhere?: Partial<Record<HelpState, number>>;
  /** false: the sheet leaves it out, because another row there does the same and is more universal (D-916). `sheet` and
   * `everywhere` still say where it works: panel_test drives it there, and the editor's help and the README list it */
  listed?: false;
  /** shown only when this condition holds */
  when?: Condition | `!${Condition}`;
  effect: Effect;
  /** its words in a hint line on an FM-1 page (HINTS): the control's name, then a short word ("WHITE step") */
  hint?: string;
  /** what it does, at length, for the editor's help (else `does`) */
  help?: string;
}

/** the patch buttons with a job in the loaded patch (help_ui.c help_patch_rows): made from the patch, not this table; this
 * is only where they go on the sheet */
export const PATCH_BUTTONS = { id: 'patch-buttons', sheet: { device: 100 } as Partial<Record<HelpState, number>> };

const ALL: readonly HelpState[] = HELP_STATES;
/** the same order in each state named */
const at = (order: number, states: readonly HelpState[]): Partial<Record<HelpState, number>> => Object.fromEntries(states.map((s) => [s, order]));
const but = (...out: HelpState[]): HelpState[] => ALL.filter((s) => !out.includes(s));
const SEQ_STATES: HelpState[] = ['drum', 'roll', 'live', 'song', 'step'];

const B = (button: Button): Part => ({ button });
const E = (encoder: Encoder): Part => ({ encoder });
const K = (knobs: '1' | '2' | '3' | '4' | '1234'): Part => ({ knobs });
const WHITE: Part = { key: 'white' };
const BLACK: Part = { key: 'black' };
const ANY_KEY: Part = { key: 'any' };

export const CONTROLS: ControlRow[] = [
  // ---- EVERYWHERE: each button's job everywhere, then the combinations, but what the state's tab lists or gives another
  // job (D-246)
  { id: 'play', gesture: { do: [B('PLAY')] }, does: 'start / stop', everywhere: at(10, ALL), effect: 'transport',
    help: 'the transport: Main’s run output and clock (on release; while the controls sheet shows too)' },
  { id: 'rec', gesture: { do: [B('REC')] }, does: 'record', everywhere: at(20, but('sandbox', 'drum', 'roll', 'step')), effect: 'record',
    help: 'the same on every page but the SEQ page, and it never changes the page. Stopped: the transport starts and recording begins. Running: recording begins. Again: recording stops, the transport goes on. PLAY stops both. What records is the armed Steps tracks, over the notes already there; with none armed the bar says REC: NO TRACK ARMED' },
  { id: 'save', gesture: { do: [B('SAVE')] }, does: 'save patch', everywhere: at(30, but('menu', 'sandbox')), effect: 'save',
    help: 'the patch into its slot, with the panel settings' },
  { id: 'home', gesture: { do: [B('HOME')] }, does: 'back', everywhere: at(5, but('sandbox')), effect: 'back',
    help: 'back one step, on release: on a device page to its device’s first page, then to the patch’s home page (its first device); out of the SEQ, SONG and environment pages, back where you were. Held alone it does nothing' },
  { id: 'glo', gesture: { do: [B('GLO')] }, does: 'settings', everywhere: at(50, but('menu')), effect: 'menu',
    help: 'the settings menu, in tabs: MIDI (MIDI channel, clock in, MIDI out, clock out), PANEL (LEDs, knob acceleration, count-in, TEMPO: GLOBAL or PATCH), SYSTEM (update mode, factory reset, quick start), INFO (version, CPU, bank slots, battery) and GUIDE (the ideas behind the FM-1)' },
  { id: 'env', gesture: { do: [B('ENV')] }, does: 'environment', everywhere: at(60, but('env', 'sandbox')), effect: 'env',
    help: 'the environment: every device from Main to the Output, each Steps track followed by what it plays (from the menu too)' },
  { id: 'seq', gesture: { do: [B('SEQ')] }, does: 'steps page', everywhere: at(70, but(...SEQ_STATES, 'sandbox')), effect: 'seq',
    help: 'the SEQ page: from a Steps track’s device page that track, else the track shown last' },
  { id: 'seq-back', gesture: { do: [B('SEQ')] }, does: 'back', everywhere: at(70, ['drum', 'roll', 'live', 'song']), listed: false, effect: 'back', hint: 'SEQ back',
    help: 'out of the SEQ or SONG page, back where you were' },
  { id: 'octave', gesture: { do: [B('OCT-'), B('OCT+')] }, does: 'octave', sheet: { step: 90 }, everywhere: at(80, but('drum', 'roll', 'menu', 'step')), effect: 'octave', hint: 'OCT octave',
    help: 'the keys’ octave, up to three either way, on release: pressing both opens the controls sheet and changes neither' },
  { id: 'tempo', gesture: { hold: 'PLAY', do: [E('PRESET')] }, does: 'tempo', everywhere: at(90, ALL), effect: 'tempo',
    help: 'the tempo, 1 bpm a click (the global one while TEMPO is GLOBAL; in sandbox mode the browser’s); PLAY’s release then neither starts nor stops' },
  { id: 'patch', gesture: { hold: 'HOME', do: [E('PRESET')] }, does: 'patches', everywhere: at(100, but('menu', 'sandbox')), effect: 'patch',
    help: 'the patches in the bank (an empty bank says BANK EMPTY); HOME’s release then goes nowhere' },
  { id: 'store', gesture: { hold: 'ENV', do: [B('SAVE')] }, does: 'save device preset', doesIn: { env: "save row's preset" }, when: 'dev_store', sheet: { device: 90, env: 60 }, everywhere: at(110, but('device', 'env', 'sandbox')), effect: 'store',
    help: 'the device in focus’s values as its preset (an assembly)' },
  { id: 'arm', gesture: { hold: 'REC', do: [BLACK] }, does: 'arm a track', when: 'tracks', everywhere: at(120, but('sandbox')), effect: 'arm',
    help: 'black key n: track n into the armed devices or out (any page)' },
  { id: 'mute', gesture: { hold: 'SEQ', do: [BLACK] }, does: 'mute a track', when: 'tracks', everywhere: at(130, but('sandbox')), effect: 'mute',
    help: 'black key n: mutes track n, or unmutes it (any page)' },

  // ---- DEVICE: a device page
  { id: 'list-home', gesture: { do: [B('HOME')] }, does: "leave {list}'s pages", when: 'list', sheet: { device: 10 }, effect: 'list_back',
    help: 'a Page button’s list showing: leaves it, back to the page shown before the button’s first press (a Page button’s press: the next page of its list; held: its first page while it is down)' },
  { id: 'devices', gesture: { do: [E('SELECT')] }, does: "this patch's devices", sheet: { device: 80 }, effect: 'focus',
    help: 'the device in focus: every top-level module or assembly with card rows, Main, each Steps track and the Output (a Page button’s list showing: it closes too)' },
  { id: 'list-pages', gesture: { do: [E('ALGO')] }, does: "{list}'s pages", when: 'list', sheet: { device: 20 }, effect: 'list_page' },
  { id: 'device-pages', gesture: { do: [E('ALGO')] }, does: "this device's pages", when: '!list', sheet: { device: 60 }, effect: 'device_page',
    help: 'the device’s pages of four rows (a Matrix: a page per output, OUT 1..OUT 4, each drawn as the whole grid with its column framed)' },
  { id: 'device-presets', gesture: { do: [E('PRESET')] }, does: "this device's presets", when: 'dev_presets', sheet: { device: 70 }, effect: 'preset',
    help: 'the focused device’s presets, loaded as it turns (a module on its own has none)' },
  { id: 'adjust', gesture: { do: [K('1234')] }, does: 'adjust values', sheet: { device: 30 }, effect: 'param',
    help: 'the four rows of the page in focus (on a Matrix’s page: the framed column’s pins, in 1..in 4)' },
  { id: 'fine', gesture: { hold: 'HOME', do: [K('1234')] }, does: 'fine adjust', sheet: { device: 40 }, effect: 'fine',
    help: 'fine turns: the least step of the row' },
  { id: 'arm-device', gesture: { do: [B('SEL')] }, does: 'arm this device', when: 'dev_keys', sheet: { device: 50 }, effect: 'arm',
    help: 'arms the device on screen, so the keys play it, and disarms the others; on a device already armed it takes it out. A device with no keys input says NOTHING HERE TAKES KEYS, one whose keys input no cable reaches NO KEYS REACH THIS DEVICE. Nothing armed: Main’s cables decide what the keys play (KEYS WIRED)' },

  // ---- ENVIRONMENT: one row per device
  { id: 'env-rows', gesture: { do: [E('SELECT')] }, does: 'device row', sheet: { env: 10 }, effect: 'focus' },
  // the owner's "device's pg.1 params" (2026-11-03) is 1 px wider than the sheet (export-defs refuses it): these words
  // until they choose others
  { id: 'env-first-page', gesture: { do: [K('1234')] }, does: "row's first page", sheet: { env: 40 }, effect: 'param' },
  { id: 'env-presets', gesture: { do: [E('PRESET')] }, does: "row device's preset", when: 'dev_presets', sheet: { env: 30 }, effect: 'preset' },
  { id: 'env-presets-algo', gesture: { do: [E('ALGO')] }, does: "row device's preset", when: 'dev_presets', sheet: { env: 50 }, listed: false, effect: 'preset' },
  { id: 'env-arm', gesture: { do: [B('SEL')] }, does: 'arm / disarm device', when: 'dev_keys', sheet: { env: 20 }, effect: 'arm',
    help: 'the row’s device into the armed devices or out (several at once: a layer or a split)' },

  // ---- the SEQ page: a drum grid (DRUM STEPS) and a melodic track's piano roll (PIANO ROLL)
  { id: 'step', gesture: { do: [WHITE] }, does: 'toggle rowstep n', plain: 'step on / off', sheet: { drum: 20, roll: 40 }, effect: 'step', hint: 'WHITE step',
    help: 'the selected row’s hit or pitch on that step' },
  { id: 'row-key', gesture: { do: [BLACK] }, does: 'select note row 1-8', doesIn: { drum: 'pick a row' }, sheet: { drum: 10, roll: 30 }, effect: 'row', hint: 'BLACK row',
    help: 'black keys 1..8: the rows (on the roll the 8 pitches shown, black key 1 the bottom one); a drum row sounds while held, and while REC records it records the hit into the nearest step' },
  { id: 'row-select', gesture: { do: [E('SELECT')] }, does: 'pick a row', sheet: { drum: 130 }, listed: false, effect: 'row', hint: 'SELECT row',
    help: 'the row, silently' },
  { id: 'roll-view', gesture: { do: [E('SELECT')] }, does: 'next 8-pitch page', sheet: { roll: 70, live: 30 }, effect: 'roll_view', hint: 'SELECT view',
    help: 'the next or previous 8 pitches; the bar names the pitches shown' },
  { id: 'roll-pitch', gesture: { hold: 'SEL', do: [E('SELECT')] }, does: 'shift page up/down', plain: 'the view a pitch up / down', sheet: { roll: 80 }, effect: 'roll_pitch' },
  { id: 'pen', gesture: { hold: 'SEL', do: [ANY_KEY] }, does: 'jump to pitch', when: 'roll', sheet: { roll: 90, step: 80 }, effect: 'jump', hint: 'SEL+KEY pen',
    help: 'the view jumps to that key’s pitch, which is selected and sounds; in step record nothing is written' },
  { id: 'steps-page', gesture: { do: [B('OCT-'), B('OCT+')] }, does: 'next/prev 16 steps', when: 'long_track', sheet: { drum: 90, roll: 160 }, effect: 'steps_page', hint: 'OCT 17+',
    help: 'a track of more than 16 steps: the next or previous 16' },
  { id: 'track', gesture: { do: [E('ALGO')] }, does: 'track', sheet: { drum: 140, roll: 180, live: 40 }, effect: 'track', hint: 'ALGO track',
    help: 'the track shown, which the page arms' },
  { id: 'pattern', gesture: { do: [E('PRESET')] }, does: 'pattern', sheet: { drum: 60, roll: 190, live: 50 }, effect: 'pattern',
    help: 'the patch’s pattern, 1..64: running, each track takes it at the end of its pass; stopped, at once. A track without that pattern plays its first' },
  { id: 'accent', gesture: { hold: 'FX', do: [WHITE] }, does: 'accent', sheet: { drum: 30, roll: 100 }, effect: 'accent', hint: 'FX acc' },
  { id: 'tie', gesture: { hold: 'LFO', do: [WHITE] }, does: 'tie', sheet: { drum: 100, roll: 50 }, effect: 'tie',
    help: 'the note held on through that step (again: untie)' },
  { id: 'step-record', gesture: { do: [B('REC')] }, does: 'toggle step record', sheet: { drum: 40, roll: 10 }, effect: 'step_record',
    help: 'stopped: step record from the first step shown; running, REC records as everywhere' },
  { id: 'step-record-there', gesture: { hold: 'REC', do: [WHITE] }, does: '^ but at step n/16', doesIn: { drum: '^ but at step N/16' }, plain: 'step record from that step', sheet: { drum: 50, roll: 20 }, effect: 'step_record_at',
    help: 'step record from that step (running too; during a live take it ends the take)' },
  { id: 'held-pitch', gesture: { hold: 'step', do: [K('1')] }, does: 'pitch', sheet: { roll: 110 }, effect: 'pitch', hint: 'K1 note' },
  { id: 'held-velocity', gesture: { hold: 'step', do: [K('2')] }, does: 'velocity', sheet: { drum: 110, roll: 120 }, effect: 'velocity', hint: 'K2 vel' },
  { id: 'held-chance-select', gesture: { hold: 'step', do: [E('SELECT')] }, does: 'chance', sheet: { drum: 120 }, effect: 'chance', hint: 'SELECT chance' },
  { id: 'held-chance', gesture: { hold: 'step', do: [K('3')] }, does: 'chance', sheet: { roll: 130 }, effect: 'chance', hint: 'K3 chance' },
  { id: 'lock-pages', gesture: { hold: 'step', do: [E('ALGO')] }, does: 'p-lock pages', sheet: { drum: 150, roll: 140 }, effect: 'lock_page', hint: 'ALGO lock',
    help: 'P-locks: pages through the device the track plays (its first stop is the step’s note, velocity and chance)' },
  { id: 'lock-rows', gesture: { hold: 'step', do: [K('1234')] }, does: 'p-lock rows', sheet: { drum: 160, roll: 150 }, effect: 'lock', hint: 'K1-K4 lock',
    help: 'on a lock page: that page’s rows locked on the held step; turned back to the row’s normal value, the lock goes' },
  { id: 'keys-octave', gesture: { hold: 'FX', do: [B('OCT')] }, does: "keys' octave", sheet: { roll: 170 }, effect: 'keys_octave' },
  { id: 'song-page', gesture: { do: [B('SEL')], how: 'tap' }, does: 'structure song', sheet: { drum: 70, roll: 60 }, effect: 'song_page', hint: 'SEL song',
    help: 'the SONG page (not after SEL held as the pen)' },
  { id: 'clear', gesture: { hold: 'SEQ', do: [B('REC')] }, does: 'clear track', sheet: { drum: 80, roll: 200 }, effect: 'clear', hint: 'SEQ+REC clear',
    help: 'the bar asks first; REC again within 3 s, SEQ still held, clears the selected track' },

  // ---- STEP RECORD (#532, D-804)
  { id: 'sr-keys', gesture: { do: [{ key: 'keys' }] }, does: 'play, let go: write', sheet: { step: 20 }, effect: 'write', hint: 'KEYS note',
    help: 'a note or a chord: letting go of the last key writes it on the cursor’s step and moves on one (on a drum grid black keys 1..8 write their rows)' },
  { id: 'sr-chord', gesture: { do: [{ key: 'chord' }] }, does: 'one chord', sheet: { step: 30 }, effect: 'chord' },
  { id: 'sr-rest', gesture: { do: [B('LFO')] }, does: 'rest, keys held: tie', sheet: { step: 40 }, effect: 'rest', hint: 'LFO rest/tie' },
  { id: 'sr-accent', gesture: { do: [B('FX')], how: 'held' }, does: 'accent', sheet: { step: 50 }, effect: 'accent', hint: 'FX acc' },
  { id: 'sr-cursor', gesture: { do: [K('4')] }, does: 'move cursor', sheet: { step: 60 }, effect: 'cursor', hint: 'K4 move',
    help: 'the cursor, nothing written; past the last step it wraps to step 1' },
  { id: 'sr-back', gesture: { do: [{ key: 'black', n: 10 }] }, does: 'back, clear step', sheet: { step: 70 }, effect: 'back_clear', hint: 'BLACK 10 del' },
  { id: 'sr-live', gesture: { do: [B('PLAY')] }, does: 'play, record live', sheet: { step: 100 }, effect: 'live',
    help: 'the transport starts and step record goes on as a live take' },
  { id: 'sr-end', gesture: { do: [B('REC')] }, does: 'end step record', sheet: { step: 10 }, effect: 'end', hint: 'REC done',
    help: 'step record ends, the page stays (SEQ too)' },

  // ---- LIVE TAKE: REC records the armed melodic track while the transport runs, on its SEQ page
  { id: 'take', gesture: { do: [{ key: 'keys' }] }, does: 'record notes', sheet: { live: 10 }, effect: 'take', hint: 'KEYS record',
    help: 'all 27 keys play the track and record their own pitch into the nearest step' },
  { id: 'take-accent', gesture: { do: [B('FX')], how: 'held' }, does: 'accented notes', sheet: { live: 20 }, effect: 'take_accent', hint: 'FX acc' },

  // ---- SONG (#375, D-541)
  { id: 'song-entry', gesture: { do: [E('SELECT')] }, does: 'pick entry', sheet: { song: 20 }, effect: 'entry', hint: 'SELECT entry',
    help: 'the entry (a pattern and a shift per row)' },
  { id: 'song-pattern', gesture: { do: [K('1')] }, does: "entry's pattern", sheet: { song: 30 }, effect: 'entry_pattern', hint: 'K1 pat' },
  { id: 'song-add', gesture: { do: [K('1')], where: 'on END' }, does: 'add entry', sheet: { song: 40 }, effect: 'add_entry' },
  { id: 'song-dup', gesture: { hold: 'FX', do: [K('1')] }, does: 'duplicate entry', sheet: { song: 50 }, effect: 'dup_entry', hint: 'FX+K1 copy',
    help: 'a copy of the entry inserted before it' },
  { id: 'song-shift', gesture: { do: [K('2')] }, does: 'transpose entry', sheet: { song: 60 }, effect: 'transpose', hint: 'K2 shift',
    help: 'the entry’s shift, −12..+12 (never on a drum track)' },
  { id: 'song-play', gesture: { do: [K('4')] }, does: 'song on / off', sheet: { song: 70 }, effect: 'song_play',
    help: 'right: the song plays; left: the pattern again' },
  { id: 'song-sel', gesture: { do: [E('ALGO')] }, does: 'song 1-8', sheet: { song: 80 }, effect: 'song', hint: 'ALGO song' },
  { id: 'song-preset', gesture: { do: [E('PRESET')] }, does: 'selected pattern', sheet: { song: 90 }, effect: 'pattern', hint: 'PRESET pat' },
  { id: 'song-delete', gesture: { hold: 'SEQ', do: [B('REC')] }, does: 'delete entry', sheet: { song: 100 }, effect: 'delete_entry', hint: 'SEQ+REC del',
    help: 'asked first: REC again within 3 s deletes the entry' },
  { id: 'song-back', gesture: { do: [B('SEL')] }, does: 'back to steps', sheet: { song: 10 }, listed: false, effect: 'back_steps', hint: 'SEL back' },

  // ---- SETTINGS: the menu (GLO)
  { id: 'menu-tab', gesture: { do: [E('ALGO')] }, does: 'tab', sheet: { menu: 20 }, effect: 'tab', hint: 'ALGO tab' },
  { id: 'menu-scroll', gesture: { do: [E('SELECT')] }, does: 'scroll', when: 'menu_guide', sheet: { menu: 30 }, effect: 'scroll', hint: 'SELECT scroll',
    help: 'the GUIDE tab: its text' },
  { id: 'menu-set', gesture: { do: [K('1234')] }, does: 'set', when: 'menu_page', sheet: { menu: 40 }, effect: 'set', hint: 'K1-K4 set',
    help: 'MIDI, PANEL and SYSTEM: the settings, which act at once' },
  { id: 'menu-patches', gesture: { do: [E('PRESET')] }, does: 'patches', sheet: { menu: 60 }, effect: 'patch' },
  { id: 'menu-save', gesture: { do: [B('SAVE')] }, does: 'save, close', sheet: { menu: 10 }, effect: 'save_close', hint: 'SAVE close',
    help: 'saves (the settings too) and closes the menu' },
  { id: 'menu-back', gesture: { do: [B('GLO'), B('HOME')] }, does: 'back', sheet: { menu: 70 }, listed: false, effect: 'back', hint: 'GLO/HOME back',
    help: 'closes the menu, back where you were' },
  { id: 'menu-run', gesture: { do: [B('GLO')], how: 'hold 2 s' }, does: 'run armed row', when: 'menu_system', sheet: { menu: 50 }, effect: 'run_row',
    help: 'SYSTEM: UPDATE MODE and FACTORY RESET run only after their knob is turned right (armed for 5 s)' },

  // ---- SANDBOX: the editor's page; its own buttons go to the editor
  { id: 'sb-devices', gesture: { do: [E('SELECT')] }, does: 'devices', sheet: { sandbox: 10 }, effect: 'editor' },
  { id: 'sb-pages', gesture: { do: [E('ALGO')] }, does: 'device pages', sheet: { sandbox: 20 }, effect: 'editor' },
  { id: 'sb-adjust', gesture: { do: [K('1234')] }, does: 'adjust values', sheet: { sandbox: 30 }, effect: 'editor',
    help: 'the editor’s rows, from the positions it sent (nothing before its first page)' },
  { id: 'sb-buttons', gesture: { do: [B('SEQ'), B('ENV'), B('REC'), B('SAVE'), B('SEL')], join: 'list' }, does: '', heading: 'in the editor:', sheet: { sandbox: 40 }, effect: 'editor',
    help: 'their work is done in the editor; the FM-1 says so (SANDBOX: SEQ IN EDITOR)' },
];

/** a hint line on an FM-1 page (FONT_S): its rows' hints in order, two spaces apart, after `lead`; an item's `text`
 * stands for the rows named (two rows in one: "BLACK/SELECT row"); `width`: the line's field in pixels. export-defs
 * writes each as HINT_<ID> into controls.h and refuses a line wider than its field */
export interface HintLine { id: string; lead?: string; items: (string | { row: string | string[]; text: string })[]; width: number }
export const HINTS: HintLine[] = [
  // the SEQ page's line under the grid (seq_ui.c seq_grid_draw)
  { id: 'step_record', items: ['sr-keys', 'sr-rest', 'sr-cursor', 'sr-end'], width: 228 },
  { id: 'live', items: ['take', 'roll-view', 'octave', 'take-accent'], width: 228 },
  { id: 'held_lock', lead: 'HELD:', items: [{ row: 'lock-rows', text: 'K1-K4 lock  back to value: off' }, { row: 'lock-pages', text: 'ALGO' }], width: 228 },
  { id: 'held_drum', lead: 'HELD:', items: ['held-velocity', 'held-chance-select', 'lock-pages'], width: 228 },
  { id: 'held_roll', lead: 'HELD:', items: ['held-pitch', 'held-velocity', 'held-chance', 'lock-pages'], width: 228 },
  { id: 'drum_rec_long', items: [{ row: 'row-key', text: 'BLACK rec' }, 'row-select', 'step', 'steps-page'], width: 228 },
  { id: 'drum_rec', items: [{ row: 'row-key', text: 'BLACK rec' }, 'row-select', 'step', 'accent'], width: 228 },
  { id: 'drum_long', items: [{ row: ['row-key', 'row-select'], text: 'BLACK/SELECT row' }, 'step', 'accent', 'steps-page'], width: 228 },
  { id: 'drum', items: ['row-key', 'step', 'accent', 'song-page'], width: 228 },
  { id: 'roll_long', items: ['row-key', 'pen', 'step', 'steps-page'], width: 228 },
  { id: 'roll', items: ['row-key', 'pen', 'step', 'song-page'], width: 228 },
  { id: 'no_track', items: ['seq-back'], width: 224 },
  // the SONG page's two lines (seq_ui.c song_draw)
  { id: 'song_1', items: ['song-entry', 'song-pattern', 'song-shift', 'song-dup'], width: 224 },
  { id: 'song_2', items: ['song-sel', 'song-preset', 'song-delete', 'song-back'], width: 228 },
  // the menu's line: its settings tabs (pages_ui.c menu_chips), INFO and GUIDE (menu.c menu_draw)
  { id: 'menu_page', items: ['menu-tab', 'menu-set', 'menu-back'], width: 226 },
  { id: 'menu_info', items: ['menu-tab', 'menu-back'], width: 226 },
  { id: 'menu_guide', items: ['menu-scroll', 'menu-tab', 'menu-back'], width: 226 },
];
/** the parts the SEQ page's track line adds where they fit (seq_ui.c), each alone: HINT_ROW_<ROW> */
export const HINT_ROWS = ['sr-accent', 'sr-back', 'track', 'clear'];

/** a hint line's text */
export function hintText(h: HintLine): string {
  const rows = new Map(CONTROLS.map((r) => [r.id, r]));
  const items = h.items.map((it) => {
    for (const id of typeof it === 'string' ? [it] : [it.row].flat()) if (!rows.has(id)) throw new Error(`controls: hint ${h.id} names no row ${id}`);
    if (typeof it !== 'string') return it.text;
    const t = rows.get(it)!.hint;
    if (!t) throw new Error(`controls: hint ${h.id}: the row ${it} has no hint`);
    return t;
  });
  return h.lead ? `${h.lead} ${items.join('  ')}` : items.join('  ');
}

/** a gesture in the sheet's row spec (help_ui.c: parts separated by '|': k: a button, n: a grey knob, c: K1..K4, w: a
 * white key, b: a black key, t: grey words, m: bright words) */
export function gestureSpec(g: Gesture): string {
  const part = (p: Part): string => {
    if ('button' in p) return `k:${p.button}`;
    if ('encoder' in p) return `n:${p.encoder}`;
    if ('knobs' in p) return `c:${p.knobs}`;
    switch (p.key) {
      case 'white': return 'w:';
      case 'black': return p.n ? `b:${p.n}` : 'b:';
      case 'any': return 'm:ANY KEY';
      case 'keys': return 'm:KEYS';
      default: return 't:keys together';
    }
  };
  const out: string[] = [];
  if (g.how === 'hold 2 s') out.push('t:hold');
  if (g.hold === 'step') out.push('t:hold step +');
  else if (g.hold) out.push(`k:${g.hold}`, 't:+');
  out.push(g.do.map(part).join(g.join === 'list' ? '|' : '|t:/|'));
  if (g.how === 'tap') out.push('t:tap');
  if (g.how === 'held') out.push('t:held');
  if (g.how === 'hold 2 s') out.push('t:2 s');
  if (g.where) out.push(`t:${g.where}`);
  return out.join('|');
}
/** `{list}` in a row's words: the Page button whose list shows (help_ui.c fills in the top bar's name for it) */
export const LIST_MARK = '{list}';
/** `{list}` where no button is known (the editor's help, the README) */
export const LIST_WORDS = 'the Page button';
/** a row's words on the sheet in a state's tab (`doesIn`), else `does` */
export const sheetDoes = (r: ControlRow, state?: HelpState): string => (state && r.doesIn?.[state]) ?? r.does;
/** a row's line on the sheet (in a state's tab, its `doesIn` words): its gesture, '~' and what it does */
export const rowSpec = (r: ControlRow, state?: HelpState): string => {
  const d = sheetDoes(r, state);
  return gestureSpec(r.gesture) + (d ? `~${d}` : '');
};
/** a row's words off the sheet (the editor, the README) with no button known: `plain`, else its sheet words in that
 * state, `{list}` as LIST_WORDS */
export const plainDoes = (r: ControlRow, state?: HelpState): string => (r.plain ?? sheetDoes(r, state)).replace(LIST_MARK, LIST_WORDS);
/** a row's words with no button known (in a state's tab: its `doesIn` words), `{list}` as LIST_WORDS */
export const doesText = (r: ControlRow, state?: HelpState): string => sheetDoes(r, state).replace(LIST_MARK, LIST_WORDS);

/** the rows of one tab of one state in order (`patch-buttons` where the patch's buttons go): those the sheet lists, or
 * with `all` the rows `listed: false` keeps off it too */
export function sheetRows(state: HelpState, tab: 'state' | 'everywhere', all = false): (ControlRow | typeof PATCH_BUTTONS)[] {
  const place = (r: { sheet?: Partial<Record<HelpState, number>>; everywhere?: Partial<Record<HelpState, number>> }): number | undefined =>
    tab === 'state' ? r.sheet?.[state] : r.everywhere?.[state];
  const rows: (ControlRow | typeof PATCH_BUTTONS)[] = [...CONTROLS, PATCH_BUTTONS];
  return rows.filter((r) => place(r) !== undefined && (all || !('listed' in r) || r.listed !== false)).sort((a, b) => place(a)! - place(b)!);
}

// ---- the editor's and the README's words for the table

/** a state in a sentence: where the FM-1 is */
export const HELP_STATE_TITLE: Record<HelpState, string> = {
  device: 'on a device page', env: 'on the environment (ENV)', drum: 'on the SEQ page of a drum track', roll: 'on the SEQ page of a melodic track (the piano roll)',
  live: 'in a live take (REC on the SEQ page while running)', song: 'on the SONG page (SEL tapped on the SEQ page)', menu: 'in the settings menu (GLO)',
  sandbox: 'in sandbox mode (the editor’s patch over budget under Live)', step: 'in step record (REC on the SEQ page while stopped)',
};
/** a condition in words: where the row applies */
export const CONDITION_TEXT: Record<Condition, string> = {
  list: 'while a Page button’s list shows', dev_presets: 'a device with presets', dev_store: 'an assembly', dev_keys: 'a device that takes keys',
  long_track: 'a track of more than 16 steps', tracks: 'a patch with Steps tracks', menu_guide: 'the GUIDE tab', menu_page: 'the MIDI, PANEL and SYSTEM tabs',
  menu_system: 'the SYSTEM tab', roll: 'a melodic track',
};

/** a gesture in words: "HOME held + PRESET", "a held step + K2", "OCT- / OCT+" */
export function gestureText(g: Gesture): string {
  const part = (p: Part): string => {
    if ('button' in p) return p.button === 'OCT' ? 'OCT- / OCT+' : p.button;
    if ('encoder' in p) return p.encoder;
    if ('knobs' in p) return p.knobs === '1234' ? 'K1..K4' : `K${p.knobs}`;
    switch (p.key) {
      case 'white': return 'a white key';
      case 'black': return p.n ? `black key ${p.n}` : 'a black key';
      case 'any': return 'any key';
      case 'keys': return 'the keys';
      default: return 'keys together';
    }
  };
  let t = g.do.map(part).join(g.join === 'list' ? ', ' : ' / ');
  if (g.how === 'tap') t += ' tapped';
  if (g.how === 'held') t += ' held + the keys';
  if (g.how === 'hold 2 s') t += ' held 2 s';
  if (g.hold) t = `${g.hold === 'step' ? 'a held step' : `${g.hold} held`} + ${t}`;
  if (g.where) t += ` ${g.where}`;
  return t;
}
/** where a row applies, in words ('' everywhere it is listed) */
const whenText = (r: ControlRow): string => (r.when && !r.when.startsWith('!') ? ` (${CONDITION_TEXT[r.when as Condition]})` : '');
/** a row's words for the editor: what it does, at length, and where it applies */
export const rowHelp = (r: ControlRow): string => (r.help ?? plainDoes(r)) + whenText(r);

/** what the FM-1 does that is no single control, for the editor's help: the sheet, the quick start, the keys */
export const FM1_NOTES: { keys: string; text: string }[] = [
  { keys: 'OCT- + OCT+', text: 'the controls sheet: what the controls do where the FM-1 is now (its tab) and everywhere (EVERYWHERE), made from the same table as this list. ALGO switches the tab, SELECT scrolls, HOME closes it; the note keys and PLAY still work, the other controls do nothing meanwhile' },
  { keys: 'quick start', text: 'the card after power-on: HOME closes it, OCT- + OCT+ opens the controls sheet instead, HOME + SAVE turns it off for good (GLO › SYSTEM › QUICK START or FACTORY RESET turns it on again)' },
  { keys: 'FX, LFO, EDIT, ARP', text: 'patch buttons: the patch decides what each does (a gate, a Toggle that bypasses a module or assembly, or a list of device pages); the sheet lists each by its job in the loaded patch. On the SEQ and SONG pages FX and LFO have the jobs below' },
  { keys: 'the keys', text: 'they play what is armed (SEL, REC held + a black key, the SEQ page arms the track it shows); nothing armed, Main’s cables decide (KEYS WIRED). While the keys reach a Drum map, black keys 1..8 play its rows on every page' },
  { keys: 'SAVE held at power-on', text: 'safe mode: the fallback patch, nothing read from flash' },
];

/** an EVERYWHERE row listed in only a few states: which (" (on the SEQ and SONG pages)"), else '' */
export function onlyIn(r: ControlRow): string {
  const s = Object.keys(r.everywhere ?? {}) as HelpState[];
  return s.length && s.length <= 4 ? ` (${s.map((x) => HELP_STATE_NAME[x].toLowerCase()).join(', ')})` : '';
}
/** the rows of a state's tab in the sheet's order, without the patch buttons, with those the sheet leaves out */
export const stateRows = (s: HelpState): ControlRow[] => sheetRows(s, 'state', true).filter((r): r is ControlRow => 'gesture' in r);
/** the rows any EVERYWHERE tab lists, each once, in their order */
export function everywhereRows(): ControlRow[] {
  const first = (r: ControlRow): number => Math.min(...Object.values(r.everywhere ?? {}));
  return CONTROLS.filter((r) => r.everywhere).sort((a, b) => first(a) - first(b));
}

/** what a fixed button does (modules.ts FIXED_DOES: the dock and the button editor): its rows, and the states' tabs that
 * list them */
export function fixedDoes(b: Button): string {
  const mine = (p: Part): boolean => 'button' in p && p.button === b;
  return CONTROLS.filter((r) => r.gesture.join !== 'list' && (r.gesture.hold === b || r.gesture.do.some(mine))).map((r) => {
    const g = r.gesture;
    const how = g.hold === b ? `held + ${gestureText({ ...g, hold: undefined })}: ` : g.how === 'hold 2 s' ? 'held 2 s: '
      : g.how === 'tap' ? 'tapped: ' : g.hold ? `with ${g.hold === 'step' ? 'a held step' : `${g.hold} held`}: ` : '';
    const where = Object.keys(r.sheet ?? {}).map((s) => HELP_STATE_NAME[s as HelpState].toLowerCase());
    return `${how}${plainDoes(r)}${where.length ? ` (${where.join(', ')})` : ''}`;
  }).join('; ');
}

export const README_START = '<!-- controls: generated from web/src/controls.ts by `npm run export-defs`; edit the table, not this list -->';
export const README_END = '<!-- controls: end -->';
/** the README's list of the FM-1's controls, between README_START and README_END (export-defs writes it, a test checks it) */
export function readmeControls(): string {
  const line = (r: ControlRow, s?: HelpState): string => `**${gestureText(r.gesture)}** ${plainDoes(r, s) || 'go to the editor'}${whenText(r)}`;
  const L = [README_START, '', `* **Everywhere:** ${everywhereRows().map((r) => line(r) + onlyIn(r)).join(' · ')}`];
  for (const s of HELP_STATES) L.push(`* **${HELP_STATE_TITLE[s][0].toUpperCase()}${HELP_STATE_TITLE[s].slice(1)}:** ${stateRows(s).map((r) => line(r, s)).join(' · ')}`);
  L.push('', README_END);
  return L.join('\n');
}
