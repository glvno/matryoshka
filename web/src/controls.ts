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
  | { key: 'white' | 'black' | 'any' | 'keys' | 'chord' | 'top'; n?: number };   // a white key, a black key (n: black key
                                                        // n), any key, the keys played, keys pressed together, the three highest keys
/** what is done: `do` while `hold` is held. Several parts in `do` are alternatives (either one), or with `join: 'list'`
 * a list of buttons that all do the same, or with `join: 'together'` buttons all pressed together. `how`: tap (a short
 * press), held (kept down while the keys play), hold 1 s, hold 2 s.
 * `where`: where on the screen it applies ("on END"). `first`: a button pressed and let go before (ENV then SEL: SEL on
 * the page ENV opens) */
export interface Gesture {
  first?: Button;
  hold?: Button | 'step';
  do: Part[];
  join?: 'or' | 'list' | 'together';
  how?: 'tap' | 'held' | 'hold 1 s' | 'hold 2 s';
  where?: string;
}

/** what a row's gesture changes, as panel_test checks it (firmware/test/controls_test.h ctl_effect) */
export const EFFECTS = [
  'transport', 'play_once', 'record', 'save', 'back', 'menu', 'env', 'seq', 'octave', 'tempo', 'patch', 'store', 'arm', 'mute',
  'focus', 'device_page', 'list_back', 'list_page', 'preset', 'param', 'fine',
  'step', 'row', 'roll_view', 'roll_pitch', 'jump', 'track', 'pattern', 'accent', 'tie', 'step_record', 'step_record_at',
  'velocity', 'chance', 'pitch', 'lock_page', 'lock', 'song_page', 'clear', 'steps_page', 'keys_octave',
  'write', 'chord', 'rest', 'cursor', 'back_clear', 'live', 'end',
  'take', 'take_accent', 'drone', 'play_notes', 'preview',
  'entry', 'entry_pattern', 'add_entry', 'dup_entry', 'transpose', 'song_play', 'song', 'delete_entry', 'back_steps',
  'tab', 'scroll', 'set', 'save_close', 'run_row',
  'editor', 'analog_out', 'chord_button', 'fx_open',
  'pattern_new', 'pattern_load', 'condition', 'fill', 'ratchet', 'micro', 'drum_bank', 'learn_row', 'learn_mode', 'learn_end',
  'pattern_copy', 'clear_all', 'pattern_browse', 'pattern_double', 'palette_go', 'palette_save', 'pattern_halve', 'fx_switch',
] as const;
export type Effect = (typeof EFFECTS)[number];

/** the conditions a row can show under (help_ui.c hc_<name>); '!name': when it is false */
export const CONDITIONS = ['list', 'dev_presets', 'dev_store', 'dev_keys', 'long_track', 'tracks', 'menu_guide', 'menu_page', 'menu_system', 'roll', 'harm', 'roll_preview', 'roll_silent', 'fx_rack', 'pattern_store', 'oct_banks', 'drum_banks', 'learning', 'fx_effect', 'harm_inv'] as const;
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
  /** what it does in plain words for the editor's controls strip (#554, D-957), about 3 to 9 words with no width limit,
   * where the sheet's own words are cut short for its small screen (else `plain`, then `does`); set from STRIP below */
  strip?: string;
  /** the strip's words on the tab of the states named, where they differ from `strip` */
  stripIn?: Partial<Record<HelpState, string>>;
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
const TOP_KEYS: Part = { key: 'top' };

export const CONTROLS: ControlRow[] = [
  // ---- EVERYWHERE: each button's job everywhere, then the combinations, but what the state's tab lists or gives another
  // job (D-246)
  { id: 'play', gesture: { do: [B('PLAY')] }, does: 'start / stop', everywhere: at(10, ALL), effect: 'transport',
    help: 'the transport: Main’s run output and clock (on release; while the controls sheet shows too). On the SONG page, while its song plays, it starts from the cursor’s entry and sends Song Position and Continue' },
  { id: 'rec', gesture: { do: [B('REC')] }, does: 'record', everywhere: at(20, but('sandbox', 'drum', 'roll', 'step')), effect: 'record',
    help: 'the same on every page but the SEQ page, and it never changes the page. Stopped: the transport starts and recording begins. Running: recording begins. Again: recording stops, the transport goes on. PLAY stops both. What records is the armed Steps tracks, over the notes already there; with none armed the bar says REC: NO TRACK ARMED' },
  { id: 'save', gesture: { do: [B('SAVE')] }, does: 'save patch', everywhere: at(30, but('menu', 'sandbox')), effect: 'save',
    help: 'the patch into its slot, with the panel settings' },
  { id: 'home', gesture: { do: [B('HOME')] }, does: 'back', everywhere: at(5, but('sandbox')), effect: 'back',
    help: 'back one step, on release: on a device page to its device’s first page, then to the patch’s home page (its first device); out of the SEQ, SONG and environment pages, back where you were. Held alone a moment it shows the palette’s eight positions until it is let go, and its release then goes nowhere' },
  { id: 'glo', gesture: { do: [B('GLO')] }, does: 'settings', everywhere: at(50, but('menu')), effect: 'menu',
    help: 'the settings menu, in tabs: MIDI (MIDI channel, clock in, MIDI out: the panel’s controls, clock out; ALGO again for its second page, TRANSPORT IN: Start, Continue, Stop and Song Position followed, and TRANSPORT OUT: PLAY’s sent, each ON as made, and CLOCK IN DELAY: 0 to 200 ms, 0 as made, the FM-1 follows the clock and transport it receives that much later, for a host whose clock runs ahead of its own audio, such as Reel at about 70 ms), PANEL (LEDs, knob acceleration, count-in with a click on each beat, TEMPO: GLOBAL or PATCH, with the tempo playing, or EXT while MIDI clock sets it; ALGO again for its second page, TIME SIG: 2/4 .. 12/8, 4/4 as made, the bar that play once and REC count in and the arpeggiator’s bar rates fill), SYSTEM (update mode, factory reset, quick start, OUTPUT: STEREO, MONO, the sum of both sides on both, for headphones or a stereo input, or MONO L, the sum on the left only and the right silent, for one mono cable into a recorder; ALGO again for its second page, EDITOR: ALLOW, or IGNORE, so the editor and its Install panel leave this FM-1 alone, and 3.5MM OUT: ON, or OFF, the speaker and the headphone jack silent while USB audio plays on, and USB RETURN: the level of playback from a phone or computer in your headphones, separate from MASTER; SAVE keeps it), EQ (the master EQ on the speaker and the headphone jack, for every patch: LOW, a shelf at 120 Hz, MID, a bell at MID FREQ, and HIGH, a shelf at 8 kHz, each ±12 dB in half decibels, and MID FREQ, 100 Hz to 8 kHz; flat as made, kept without SAVE, USB audio left as it is; a band off 0 dB costs CPU on every patch, about 3.5 % for the first and 1.3 % for each one after it, so the heaviest patches with every effect on may drop a voice with all three bands in use), INFO (version, CPU, bank slots, battery, device name) and GUIDE (the ideas behind the FM-1)' },
  { id: 'env', gesture: { do: [B('ENV')] }, does: 'environment', everywhere: at(60, but('env', 'sandbox')), effect: 'env',
    help: 'the environment: every device from Main to the Output, each Steps track followed by what it plays (from the menu too)' },
  { id: 'seq', gesture: { do: [B('SEQ')] }, does: 'steps page', everywhere: at(70, but(...SEQ_STATES, 'sandbox')), effect: 'seq',
    help: 'the SEQ page: from a Steps track’s device page that track, else the track shown last' },
  { id: 'seq-back', gesture: { do: [B('SEQ')] }, does: 'back', everywhere: at(70, ['drum', 'roll', 'live', 'song']), listed: false, effect: 'back', hint: 'SEQ back',
    help: 'out of the SEQ or SONG page, back where you were' },
  { id: 'octave', gesture: { do: [B('OCT-'), B('OCT+')] }, does: 'octave', when: '!oct_banks', sheet: { step: 90 }, everywhere: at(80, but('drum', 'menu', 'step')), effect: 'octave', hint: 'OCT octave',
    help: 'the keys’ octave, up to three either way, on release: pressing both opens the controls sheet and changes neither' },
  { id: 'drum-bank', gesture: { do: [B('OCT-'), B('OCT+')] }, does: 'next/prev 8 rows', when: 'oct_banks', everywhere: at(80, ['device', 'env']), effect: 'drum_bank',
    help: 'while the keys reach a drum track with more than 8 rows (the rows of every Drum map it plays, as one list), the next or previous 8 of them: black keys 1..8 play that bank of rows, the footer shows ROWS 1-8, ROWS 9-16 or ROWS 17-24 in the octave’s place, and the bar names the bank and its first rows' },
  { id: 'tempo', gesture: { hold: 'PLAY', do: [E('PRESET')] }, does: 'tempo', everywhere: at(90, ALL), effect: 'tempo',
    help: 'the tempo, 1 bpm a click (the global one while TEMPO is GLOBAL; in sandbox mode the browser’s); PLAY’s release then neither starts nor stops' },
  { id: 'patch', gesture: { hold: 'HOME', do: [E('PRESET')] }, does: 'patches', everywhere: at(100, but('menu', 'sandbox')), effect: 'patch',
    help: 'the patches in the bank (an empty bank says BANK EMPTY; while the editor’s Live is on the patch stays, EDITOR LIVE: PATCH STAYS); HOME’s release then goes nowhere' },
  { id: 'palette', gesture: { hold: 'HOME', do: [BLACK], how: 'tap' }, does: 'palette 1-8', plain: 'switch to palette entry 1..8', everywhere: at(102, but('sandbox')), effect: 'palette_go',
    help: 'black key n: the palette’s entry n, its patch with every device’s preset and its pattern; stopped at once, while playing at the next bar line (the bar says NEXT: 3 and the name until then; the same key again cancels). An empty position says PALETTE 3 EMPTY: HOLD KEY, a missing patch PALETTE 3: MISSING. While HOME is held the keys play nothing, and HOME held alone a moment shows the palette. In sandbox mode the editor’s patch stays (SANDBOX: PATCH STAYS)' },
  { id: 'palette-save', gesture: { hold: 'HOME', do: [BLACK], how: 'hold 1 s' }, does: 'save to palette', plain: 'save the sound to palette position 1..8', everywhere: at(103, but('sandbox')), effect: 'palette_save',
    help: 'black key n held 1 s: the sound playing into palette position n (its patch, every device’s preset, the pattern), over what was there; an edited patch is saved into its slot first, a patch from the editor into the first empty slot. The bar says SAVED TO PALETTE 3; the key’s release then does nothing' },
  { id: 'store', gesture: { hold: 'ENV', do: [B('SAVE')] }, does: 'save device preset', doesIn: { env: "save row's preset" }, when: 'dev_store', sheet: { device: 90, env: 60 }, everywhere: at(110, but('device', 'env', 'sandbox')), effect: 'store',
    help: 'the device in focus’s values as its preset (an assembly)' },
  { id: 'arm', gesture: { hold: 'REC', do: [BLACK] }, does: 'arm / disarm track', when: 'tracks', everywhere: at(120, but('sandbox')), effect: 'arm',
    help: 'black key n: track n into the armed devices or out (any page)' },
  { id: 'mute', gesture: { hold: 'SEQ', do: [BLACK] }, does: 'mute a track', when: 'tracks', everywhere: at(130, but('sandbox')), effect: 'mute',
    help: 'black key n: mutes track n, or unmutes it (any page)' },
  { id: 'play-once', gesture: { hold: 'SEQ', do: [B('PLAY')] }, does: 'count in, play once', when: 'tracks', everywhere: at(135, but('sandbox')), effect: 'play_once',
    help: 'play once, for recording a whole take into a recorder: stopped, one bar is counted in with a click on each beat (on the speaker and the jacks, not on USB audio), then the pattern or the song plays once and the transport stops by itself. Running or counting in: it stops, as PLAY' },
  { id: 'fill', gesture: { hold: 'SEQ', do: [B('FX')] }, does: 'fill while FX held', plain: 'FILL while FX is held', when: 'tracks', everywhere: at(137, but('sandbox')), effect: 'fill',
    help: 'FILL (#674): while FX stays down, the notes with a FILL trig condition play and the NOT FILL ones rest; let FX go and the pattern is as before. SEQ may be let go once FX is down; FX is no accent then and does nothing of its own' },
  { id: 'out-35mm', gesture: { do: [B('HOME'), B('OCT-'), B('OCT+')], join: 'together', how: 'hold 2 s' }, does: '3.5mm', plain: '3.5MM OUT on / off', everywhere: at(140, ALL), effect: 'analog_out',
    help: 'GLO › SYSTEM › 3.5MM OUT on or off. OFF silences the speaker and the headphone jack, so they stay quiet while a computer records the FM-1 over USB audio, which plays on at the volume knob’s level; a red speaker with an X shows left of the battery while it is off. The three held together for 2 s; the screen then says 3.5MM OUT OFF or 3.5MM OUT ON. SAVE keeps it, as the other settings' },

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
  { id: 'adjust', gesture: { do: [K('1234')] }, does: 'adjust values', when: '!learning', sheet: { device: 30 }, effect: 'param',
    help: 'the four rows of the page in focus (on a Matrix’s page: the framed column’s pins, in 1..in 4)' },
  { id: 'learn-row', gesture: { do: [K('1234')] }, does: 'pick row to learn', when: 'learning', sheet: { device: 31 }, effect: 'learn_row',
    help: 'MIDI learn mode: the knob’s row waits for a MIDI control and does not move; the first control to send three different values (two for a switch), or the first note played, moves it from then on and does nothing else in this patch. That ends learn mode, as do HOME, another patch or 30 s without a step' },
  { id: 'learn-mode', gesture: { hold: 'HOME', do: [B('SEL')] }, does: 'MIDI learn', when: '!learning', sheet: { device: 45 }, effect: 'learn_mode',
    help: 'MIDI learn mode, on a device page or the environment: turn the knob of the row to learn, then move a control on a MIDI controller. While the keys reach a drum kit, a black key picks its drum row instead and the next pad hit on the controller plays that row from then on, in every patch (GLO > MIDI 4/4); learn mode then waits for the next row’s pad. Neither HOME’s release nor SEL’s does its own job. GLO > MIDI 3/4 lists and clears the mappings, and its LEARN turned right starts learn mode too' },
  { id: 'learn-end', gesture: { do: [B('HOME')] }, does: 'end learn', when: 'learning', sheet: { device: 46 }, effect: 'learn_end',
    help: 'leaves MIDI learn mode (LEARN OFF, or PADS: 3 LEARNED after pads); the page stays. HOME + SEL again does the same' },
  { id: 'fine', gesture: { hold: 'HOME', do: [K('1234')] }, does: 'fine adjust', sheet: { device: 40 }, effect: 'fine',
    help: 'fine turns: the least step of the row' },
  { id: 'arm-device', gesture: { do: [B('SEL')] }, does: 'arm only this', when: 'dev_keys', sheet: { device: 50 }, effect: 'arm',
    help: 'arms the device on screen, so the keys play it, and disarms the others; on a device already armed it takes it out. A device with no keys input says NOTHING HERE TAKES KEYS, one whose keys input no cable reaches NO KEYS REACH THIS DEVICE. Nothing armed: Main’s cables decide what the keys play (KEYS WIRED). On the page of an effect SEL switches the effect instead: one in an FX drawer, or one on the canvas that takes no keys' },
  { id: 'fx-switch', gesture: { do: [B('SEL')] }, does: 'effect on / off', when: 'fx_effect', sheet: { device: 51 }, effect: 'fx_switch',
    help: 'on the page of an effect: that effect on or off, as its ⏻ in the editor; the bar says DRIVE ON or DRIVE OFF. The effect is one in an FX drawer, or one on the canvas that takes no keys: an effect card dragged out of a drawer, or a single effect module such as a Delay or a Filter. A Delay or a Reverb in a drawer, or dragged out of one, rings out as it goes off. A Toggle on the effect or its drawer follows, and SAVE keeps the switch. An effect the FM-1 runs by plain bypass (one of more than 8 modules) says SWITCH IT WITH A TOGGLE, and so does a card on the canvas made only of effect modules that came from no drawer: the patch does not list which of its modules its ⏻ switches (one you switched off yourself stays off), so the FM-1 leaves it to a Toggle' },
  { id: 'arm-several', gesture: { first: 'ENV', do: [B('SEL')] }, does: 'arm several', when: 'dev_keys', sheet: { device: 55 }, effect: 'arm',
    help: 'on the environment page (ENV), SEL adds the row’s device to the armed devices or drops it, so the keys play several at once (a layer or a split)' },
  // (the keys reach a Harmonizer, #598: its Side layout, the seven lowest keys its chord buttons)
  { id: 'chord-quality', gesture: { do: [BLACK] }, does: '1-3 maj min dim', plain: 'chord buttons maj, min, dim', when: 'harm', sheet: { device: 24, roll: 24, step: 24 }, effect: 'chord_button',
    help: 'with the keys on a Harmonizer: black keys 1..3 are its chord buttons maj, min and dim, at any octave (held with others, the one pressed last wins); every key from C up plays that chord on its root. With no button held (and none latched) a key plays the card’s chord, or itself. A chord held meanwhile keeps its notes; its RETRIG row ALL or DIFF changes it at once (#1329)' },
  { id: 'chord-add', gesture: { do: [WHITE] }, does: '1-4 sus2 sus4 7 9', plain: 'chord buttons sus2, sus4, 7, 9', when: 'harm', sheet: { device: 26, roll: 26, step: 26 }, effect: 'chord_button',
    help: 'with the keys on a Harmonizer: white keys 1..4 add to the chord: sus2 and sus4 (beside maj, min or dim an added 2nd or 4th), 7 (the minor seventh) and 9; pressed together the buttons combine. Its LOCK row on: the buttons pressed together stay latched until chord buttons are pressed again (the only latched one alone again lets go); a latched inversion stays' },
  { id: 'chord-inversion', gesture: { do: [TOP_KEYS] }, does: 'inversions 1 2 3', plain: 'inversion keys 1st, 2nd, 3rd', when: 'harm_inv', sheet: { device: 27, roll: 27, step: 27 }, effect: 'chord_button',
    help: 'with the keys on a Harmonizer whose INVKEYS row is on (#1311): the three highest keys, F, F♯ and G at the right edge, play the 1st, 2nd and 3rd inversion at any octave, in place of its VOICING row (held together, the one pressed last wins). Its LOCK row on: the inversion stays latched, apart from the chord buttons, until another inversion key replaces it; its key alone again lets it go (root position, or the VOICING row). MIDI out sends them as their keys over the split (F5, F♯5, G5 over C4). Its row off: they play notes' },

  // ---- ENVIRONMENT: one row per device
  { id: 'env-rows', gesture: { do: [E('SELECT')] }, does: 'device row', sheet: { env: 10 }, effect: 'focus' },
  { id: 'env-first-page', gesture: { do: [K('1234')] }, does: 'device pg.1 params', sheet: { env: 40 }, effect: 'param' },
  { id: 'env-presets', gesture: { do: [E('PRESET')] }, does: "row device's preset", when: 'dev_presets', sheet: { env: 30 }, effect: 'preset' },
  { id: 'env-presets-algo', gesture: { do: [E('ALGO')] }, does: "row device's preset", when: 'dev_presets', sheet: { env: 50 }, listed: false, effect: 'preset' },
  { id: 'env-arm', gesture: { do: [B('SEL')] }, does: 'add / drop row', when: 'dev_keys', sheet: { env: 20 }, effect: 'arm',
    help: 'the row’s device into the armed devices or out (several at once: a layer or a split)' },

  // ---- FX: a patch with an FX rack (an effect or an FX drawer) keeps FX for its effects on device pages and the
  // environment, its own FX button job shadowed (D-946: FX keeps its SEQ and SONG jobs)
  { id: 'fx-open', gesture: { do: [B('FX')] }, does: 'first effect', when: 'fx_rack', sheet: { device: 95, env: 65 }, effect: 'fx_open',
    help: 'the first page of the first effect in the FX drawer of the instrument on show (an effect’s page counts as its instrument’s), else of the armed instrument, else of the Output drawer; with none the bar says NO FX IN THE RACK. Effects are ordinary devices right after their instrument: SELECT walks them in their order, K1-K4 edit them, ALGO turns their pages. FX again goes back. A patch with no effect keeps its own FX button job; with none either, FX says NO FX IN THE RACK' },

  // ---- the SEQ page: a drum grid (DRUM STEPS) and a melodic track's piano roll (PIANO ROLL)
  { id: 'roll-keys', gesture: { do: [ANY_KEY] }, does: 'play notes', sheet: { roll: 30 }, effect: 'play_notes', hint: 'KEYS play',
    strip: 'play each key’s own note without changing the pattern',
    help: 'keys play their own pitch, except the seven Side chord buttons on a Harmonizer path; outside step record, notes are recorded only while REC and the transport run' },
  { id: 'step', gesture: { do: [WHITE] }, does: 'toggle rowstep n', plain: 'step on / off', sheet: { drum: 20 }, effect: 'step', hint: 'WHITE step',
    help: 'the selected drum row’s hit on that step' },
  { id: 'row-key', gesture: { do: [BLACK] }, does: 'pick a row', sheet: { drum: 10 }, effect: 'row', hint: 'BLACK row',
    help: 'black keys 1..8 pick the drum rows shown and sound them while held; while REC records, the hit goes into the nearest step' },
  { id: 'row-select', gesture: { do: [E('SELECT')] }, does: 'pick a row', sheet: { drum: 130 }, listed: false, effect: 'row', hint: 'SELECT row',
    help: 'the row, silently' },
  { id: 'roll-view', gesture: { do: [E('SELECT')] }, does: 'next 8-pitch page', sheet: { roll: 70, live: 30 }, effect: 'roll_view', hint: 'SELECT view',
    help: 'the next or previous 8 pitches; the bar names the pitches shown' },
  { id: 'roll-pitch', gesture: { hold: 'SEL', do: [E('SELECT')] }, does: 'shift page up/down', plain: 'the view a pitch up / down', sheet: { roll: 80 }, effect: 'roll_pitch' },
  { id: 'pen', gesture: { hold: 'SEL', do: [ANY_KEY] }, does: 'jump to pitch', when: 'roll', sheet: { roll: 90, step: 80 }, effect: 'jump', hint: 'SEL+KEY view',
    help: 'the view jumps to that key’s pitch; in step record this writes nothing and sounds only when note preview is on' },
  { id: 'steps-page', gesture: { do: [B('OCT-'), B('OCT+')] }, does: 'next/prev 16 steps', when: 'long_track', sheet: { drum: 90 }, effect: 'steps_page', hint: 'OCT 17+',
    help: 'a track of more than 16 steps: the next or previous 16' },
  { id: 'drum-bank-seq', gesture: { hold: 'SEL', do: [B('OCT-'), B('OCT+')] }, does: 'other 8 rows', plain: 'the next or previous 8 drum rows', when: 'drum_banks', sheet: { drum: 92, step: 92 }, effect: 'drum_bank',
    help: 'a drum track with more than 8 rows: the grid shows the next or previous 8, with their names, and black keys 1..8 pick, sound and write those rows; the footer shows ROWS 1-8, ROWS 9-16 or ROWS 17-24' },
  { id: 'track', gesture: { do: [E('ALGO')] }, does: 'track', sheet: { drum: 140, roll: 180, live: 40 }, effect: 'track', hint: 'ALGO track',
    help: 'the track shown, which the page arms' },
  { id: 'pattern', gesture: { do: [E('PRESET')] }, does: 'pattern', sheet: { drum: 60, roll: 190, live: 50 }, effect: 'pattern',
    help: 'the patch’s pattern, 1..64: running, each track takes it at the end of its pass; stopped, at once. A track without that pattern plays its first' },
  { id: 'accent', gesture: { hold: 'FX', do: [WHITE] }, does: 'accent', sheet: { drum: 30 }, effect: 'accent', hint: 'FX acc' },
  { id: 'tie', gesture: { hold: 'LFO', do: [WHITE] }, does: 'tie', sheet: { drum: 100 }, effect: 'tie',
    help: 'the note held on through that step (again: untie). With no note of the row before that step, the tie wraps round the loop: the row’s last note goes on across the loop’s end to it, and on the note’s own step it becomes a drone that never starts again (again: one step)' },
  { id: 'row-drone', gesture: { hold: 'LFO', do: [B('FX')] }, does: 'row drone', sheet: { drum: 105 }, effect: 'drone',
    help: 'the selected row as one drone: its first note holds for as long as the pattern plays, and the row’s other notes go (again: one step; an empty row says NOTHING TO DRONE). Not in step record, where LFO is the rest / tie' },
  { id: 'step-record', gesture: { do: [B('REC')] }, does: 'toggle step record', sheet: { drum: 40, roll: 10 }, effect: 'step_record',
    help: 'stopped: step record from the first step shown; running, REC records as everywhere' },
  { id: 'step-record-there', gesture: { hold: 'REC', do: [WHITE] }, does: '^ but at step n/16', doesIn: { drum: '^ but at step N/16' }, plain: 'step record from that step', sheet: { drum: 50, roll: 20 }, effect: 'step_record_at',
    help: 'step record from that step (running too; during a live take it ends the take)' },
  { id: 'held-velocity', gesture: { hold: 'step', do: [K('2')] }, does: 'velocity', sheet: { drum: 110 }, effect: 'velocity', hint: 'K2 vel' },
  { id: 'held-chance-select', gesture: { hold: 'step', do: [E('SELECT')] }, does: 'chance', sheet: { drum: 120 }, effect: 'chance', hint: 'SELECT chance' },
  { id: 'held-cond', gesture: { hold: 'step', do: [K('4')] }, does: 'trig condition', sheet: { drum: 125 }, effect: 'condition', hint: 'K4 cond',
    help: 'the selected row’s note on the held step plays only when its trig condition holds (the roll: the note of the selected pitch): one click a step through OFF, FILL, NOT FILL, PRE, NOT PRE, NEI, NOT NEI, 1ST, NOT 1ST, 1:2 .. 8:8 (pass A of every B), NOT 1:2 .. NOT 8:8. A condition takes the chance’s place; the bar names it (COND 3:4) and the cell gets a blue corner' },
  { id: 'held-ratchet', gesture: { hold: 'step', do: [E('PRESET')] }, does: 'ratchet', sheet: { drum: 126 }, effect: 'ratchet', hint: 'PRESET ratchet',
    help: 'the selected row’s note on the held step plays 1 to 5 times inside its step, evenly spaced, each hit the gate of its slice (the roll: the note of the selected pitch); one click one more or one fewer. The bar names it (RATCHET X3, at one RATCHET OFF) and the cell is cut into as many slices' },
  { id: 'held-micro', gesture: { hold: 'step', do: [B('OCT-'), B('OCT+')] }, does: 'microtiming', plain: 'micro timing', sheet: { drum: 127 }, effect: 'micro', hint: 'OCT micro',
    help: 'micro timing: the selected row’s note on the held step plays 1/24 of a step earlier (OCT-) or later (OCT+) a press, up to 23/24 either way (the roll: the note of the selected pitch). An early note on a pass’s first step plays at the end of the pass before when the pattern plays again. The bar names it (MICRO +5/24, MICRO OFF) and the cell gets a lilac foot, left early, right late' },
  { id: 'lock-pages', gesture: { hold: 'step', do: [E('ALGO')] }, does: 'p-lock pages', sheet: { drum: 150 }, effect: 'lock_page', hint: 'ALGO lock',
    help: 'P-locks: pages through the device the track plays, one stop a click: first the step’s note on the grid (K2 velocity, SELECT chance), then each of the device’s pages, shown as the device page shows it, its bars at the held step’s values. Letting the step go returns to the grid at the steps and row it showed' },
  { id: 'lock-rows', gesture: { hold: 'step', do: [K('1234')] }, does: 'p-lock rows', sheet: { drum: 160 }, effect: 'lock', hint: 'K1-K4 lock',
    help: 'on a device page’s stop: that page’s rows locked on the held step, each bar showing the lock’s value; turned back to the row’s normal value, the lock goes. SELECT stays the chance, PRESET the ratchet and OCT the micro timing there' },
  { id: 'song-page', gesture: { do: [B('SEL')], how: 'tap' }, does: 'structure song', sheet: { drum: 70, roll: 60 }, effect: 'song_page', hint: 'SEL song',
    help: 'the SONG page (not after SEL held as the pen)' },
  // (the pattern store, #901: patterns kept apart from the patches, which link them)
  { id: 'pattern-new', gesture: { hold: 'FX', do: [B('SAVE')] }, does: 'keep pattern copy', when: 'pattern_store', sheet: { drum: 74, roll: 64 }, effect: 'pattern_new',
    help: 'a copy of the selected pattern into the pattern store as a new entry named after the patch and the pattern (SCROUNGE P3), kept: no patch links it, the FM-1 never deletes it and SAVE never writes over it; the pattern’s own link stays (SAVE puts the patterns into the store). The bar says KEPT AS and the name, PATTERN STORE FULL when there is no room' },
  { id: 'pattern-load', gesture: { hold: 'SEL', do: [E('PRESET')] }, does: 'load stored pattern', when: 'pattern_store', sheet: { drum: 76, roll: 66 }, effect: 'pattern_load',
    help: 'steps through the pattern store in its order, each click loading the next entry into the selected pattern, which links it (pattern 1 gets a copy). The bar names it (P3: SCROUNGE P3); its P-locks load only into a patch of the layout they were saved in, else the bar says LOCKS LEFT OUT: OTHER LAYOUT' },
  // (the pattern commands, #1177 and #1178: the editor's copy and clear all, D-544)
  { id: 'pattern-copy', gesture: { hold: 'SEQ', do: [B('SAVE')] }, does: 'copy pattern', sheet: { drum: 78, roll: 68 }, effect: 'pattern_copy',
    help: 'the selected pattern of every track (notes, P-locks, its own length and rate) to the first empty number after it, round from P02 when there is none after it; the copy is selected and linked to nothing. The bar says P03 COPIED TO P04, ALL 64 PATTERNS USED when no number is empty, P03 EMPTY: NOT COPIED when it has no notes, PATCH FULL: NOT COPIED when the patch has no room' },
  { id: 'clear', gesture: { hold: 'SEQ', do: [B('REC')] }, does: 'clear track', sheet: { drum: 80, roll: 200 }, effect: 'clear', hint: 'SEQ+REC clear',
    help: 'the bar asks first; REC again within 3 s, SEQ still held, clears the selected track' },
  { id: 'clear-all', gesture: { hold: 'SEQ', do: [B('HOME')] }, does: 'clear all patterns', sheet: { drum: 82, roll: 202 }, effect: 'clear_all',
    help: 'the bar asks first (CLEAR ALL? HOME AGAIN); HOME again within 3 s, SEQ still held, clears every pattern of every track (1 to 64, their links and P-locks) and every song: pattern 1 stays, empty and selected (PATTERNS + SONGS CLEARED). The pattern store keeps its patterns' },
  // (the stored patterns' browser, #1202 G8)
  { id: 'pattern-browse', gesture: { hold: 'SEQ', do: [B('SEL')] }, does: 'stored patterns', when: 'pattern_store', sheet: { drum: 84, roll: 204 }, effect: 'pattern_browse', hint: 'SEQ+SEL load a pattern',
    help: 'the pattern store’s entries as a list in place of the steps, named as the store names them (909 KIT P03; KEPT after a kept copy), from the one the selected pattern links, with the pattern they load into and the place in the list (LOAD INTO P03  3/12). PRESET moves through them; SEL loads the one shown into the selected pattern, which links it (pattern 1 gets a copy), and closes the list; HOME closes it without loading. Any other button, a key or another knob closes it without loading and does its own job. NO STORED PATTERNS when the store is empty' },
  // (the double, D-838: the editor's ×2)
  { id: 'pattern-double', gesture: { hold: 'SEQ', do: [B('OCT+')] }, does: 'double pattern', sheet: { drum: 79, roll: 69 }, effect: 'pattern_double',
    help: 'the selected pattern of every track twice as long (16 steps become 32), its steps copied into the new half: notes, ties, velocities, chance, conditions, ratchets, micro timing and P-locks, so it plays the same twice; again doubles it again, up to 64 steps. Pattern 1 doubles the track’s length (its other patterns keep theirs). While playing it goes on in the first half. The bar says DOUBLED: 32 STEPS (the longest track); nothing changes when a track would pass 64 steps (64 STEPS MAX: NOT DOUBLED), a pattern 256 notes or the patch 1536 (TOO MANY NOTES TO DOUBLE), a pattern 64 P-locks or the patch 256 (TOO MANY P-LOCKS TO DOUBLE), or the patch its bytes (PATCH FULL: NOT DOUBLED)' },
  // (the halve, D-841: the editor's ÷2)
  { id: 'pattern-halve', gesture: { hold: 'SEQ', do: [B('OCT-')] }, does: 'halve pattern', sheet: { drum: 79.5, roll: 69.5 }, effect: 'pattern_halve',
    help: 'the selected pattern of every track half as long, rounded down (16 steps become 8, 15 become 7), down to 1 step. Its notes and P-locks stay as they are: those past the new end wait unplayed, as when LAST STEP shortens the track, and play again if LAST STEP lengthens it (a double copies the first half over them instead). Pattern 1 halves the track’s length (its other patterns keep theirs). The bar says HALVED: 8 STEPS (the longest track); nothing changes when a track is at 1 step (1 STEP MIN: NOT HALVED), when a track that lacks the pattern would take a copy of its pattern 1 past the patch’s 1536 notes (TOO MANY NOTES TO HALVE) or 256 P-locks (TOO MANY P-LOCKS TO HALVE), or the patch its bytes (PATCH FULL: NOT HALVED)' },

  // ---- STEP RECORD (#532, D-804)
  { id: 'sr-keys', gesture: { do: [{ key: 'keys' }] }, does: 'play, let go: write', sheet: { step: 20 }, effect: 'write', hint: 'KEYS note',
    help: 'a note or a chord: Side buttons on a Harmonizer path shape the next root without entering notes; letting go of the last note key writes it on the cursor’s step and moves on one (on a drum grid black keys 1..8 write their rows)' },
  { id: 'sr-preview-off', gesture: { hold: 'SEL', do: [B('FX')] }, does: 'preview off', when: 'roll_preview', sheet: { step: 35 }, effect: 'preview',
    strip: 'hear or silence notes as you enter them',
    help: 'piano roll only: toggle hearing notes during step record; starts on at power-on. SILENT means notes are still written but do not sound until playback' },
  { id: 'sr-preview-on', gesture: { hold: 'SEL', do: [B('FX')] }, does: 'preview on', when: 'roll_silent', sheet: { step: 35 }, effect: 'preview',
    strip: 'hear or silence notes as you enter them',
    help: 'piano roll only: toggle hearing notes during step record; starts on at power-on. SILENT means notes are still written but do not sound until playback' },
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
  { id: 'take-accent', gesture: { do: [B('FX')], how: 'held' }, does: 'accented notes', sheet: { roll: 100, live: 20 }, effect: 'take_accent', hint: 'FX acc' },

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
    help: 'MIDI, PANEL, SYSTEM and EQ: the settings, which act at once' },
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

/** the controls strip's words for each row (ControlRow `strip`; a record: `stripIn` by state, `_` for the others), from
 * michael glaviano's mockup of 2026-11-03, checked against each row's `help`. Kept apart from the rows so the sheet's
 * words above stay easy to read */
const STRIP: Record<string, string | ({ _: string } & Partial<Record<HelpState, string>>)> = {
  // everywhere
  home: 'go back one step', play: 'start or stop playback', rec: 'record what the keys play into the armed tracks',
  save: 'save the patch, with its settings', glo: 'open settings: MIDI, panel, system, info, guide',
  env: 'see every device in the patch, Main to Output', seq: 'open the step sequencer', 'seq-back': 'leave the steps page, back where you were',
  octave: "shift the keys' octave", tempo: 'change the tempo, 1 bpm per click', patch: "step through the bank's patches",
  store: { _: "save this device's values as a preset", env: "save this row's device as a preset" },
  arm: 'arm or disarm track n for the keys', mute: 'mute or unmute track n',
  'play-once': 'count in a bar, play the pattern or song once, stop', fill: 'hold FX with SEQ to play the fill notes',
  'out-35mm': 'turn the speaker and headphone jack off or on (USB audio plays on)',
  palette: 'switch to palette entry n (at the next bar while playing)', 'palette-save': 'save the sound to palette position n',
  // a device page
  'list-home': "leave {list}'s pages, back where you were", 'list-pages': "flip through {list}'s pages",
  adjust: 'turn the four values on this page', fine: 'turn a value in its smallest steps',
  'arm-device': 'play only this device from the keys (again: stop)',
  'arm-several': 'open the environment to arm several devices at once (a layer)', 'device-pages': "flip through this device's pages",
  'device-presets': "load this device's presets as you turn", devices: 'move to the next or previous device in the patch',
  'chord-quality': 'hold to play maj, min or dim chords from one key', 'chord-add': 'hold to add sus2, sus4, a 7th or a 9th to the chord',
  // the environment
  'env-rows': 'move up and down the device list', 'env-arm': "play this row's device from the keys (several at once: layer)",
  'env-presets': "load presets for this row's device", 'env-presets-algo': "load presets for this row's device",
  'env-first-page': "edit the first page of this row's device",
  // the SEQ page
  'row-key': { _: 'pick one of the 8 pitches on screen', drum: 'pick a drum sound (it plays while held)' },
  step: { _: 'turn the selected pitch on or off at that step', drum: 'turn the selected sound on or off at that step' },
  'row-select': 'pick a drum sound, silently', accent: 'accent that step (play it louder)',
  'step-record': 'write notes one step at a time, from the first step shown', 'step-record-there': 'step record starting from that step',
  pattern: 'change pattern (1..64; running: at the end of the pass)', 'song-page': 'arrange patterns into a song',
  'pattern-new': 'keep a copy of this pattern in the pattern store',
  'pattern-load': 'load stored patterns into this pattern as you turn',
  clear: 'clear the whole track (press REC again to confirm)', 'steps-page': 'show the next or previous 16 steps',
  'pattern-copy': 'copy this pattern to the next empty number', 'clear-all': 'clear every pattern and song (press HOME again to confirm)',
  'pattern-browse': 'pick a stored pattern from a list and load it',
  'drum-bank': 'play the next or previous 8 drum sounds from the black keys', 'drum-bank-seq': 'show the next or previous 8 drum sounds',
  tie: 'tie the note on through that step (on its own step: a drone)', 'row-drone': 'make the selected row one long held note (a drone)', 'held-pitch': "change this step's pitch", 'held-velocity': "change this step's velocity",
  'held-chance': 'change the chance this step plays', 'held-chance-select': 'change the chance this step plays', 'held-cond': 'choose when this step plays: FILL, 1ST, every Nth pass',
  'held-ratchet': 'repeat this step 2 to 5 times inside the step', 'held-micro': 'push this step a little earlier or later',
  track: 'pick which track to edit (the keys play it)', 'lock-pages': 'pick a device page to lock values on this step',
  'lock-rows': 'lock these values on this step only (P-lock)', 'roll-view': 'show the next or previous 8 pitches',
  'roll-pitch': 'scroll the view one pitch', pen: "jump the view to that key's pitch", 'keys-octave': "move the keys' octave instead of the grid",
  // step record
  'sr-end': 'stop step recording', 'sr-keys': 'play a note; letting go writes it and moves on', 'sr-chord': 'press keys together to write a chord',
  'sr-rest': 'write a rest (with keys held: tie the note on)', 'sr-accent': 'accent the notes you write',
  'sr-cursor': 'move the cursor without writing', 'sr-back': 'go back a step and clear it', 'sr-live': 'start playback and keep recording live',
  // a live take
  take: 'play the keys to record notes into the track', 'take-accent': 'record accented notes',
  // the SONG page
  'song-entry': 'pick a song entry', 'song-pattern': 'set which pattern the entry plays', 'song-add': 'add an entry at the end',
  'song-dup': 'insert a copy of the entry before it', 'song-shift': 'transpose the entry (−12..+12)', 'song-play': 'play the song, or loop the pattern',
  'song-sel': 'pick one of 8 songs', 'song-preset': 'change the selected pattern', 'song-delete': 'delete the entry (press REC again to confirm)',
  'song-back': 'back to the steps page',
  // the settings menu
  'menu-save': 'save settings and close', 'menu-tab': 'next or previous settings tab', 'menu-scroll': 'scroll the GUIDE text',
  'menu-set': 'change the four settings on this tab', 'menu-run': 'run an update or factory reset that is armed',
  'menu-patches': "step through the bank's patches", 'menu-back': 'close the settings, back where you were',
  // sandbox mode
  'sb-devices': "move through the editor's devices", 'sb-pages': "flip through the editor's pages", 'sb-adjust': "turn the editor's values",
  'sb-buttons': 'these work in the editor while sandboxed',
};
for (const r of CONTROLS) {
  const w = STRIP[r.id];
  if (typeof w === 'string') r.strip = w;
  else if (w) {
    const { _, ...by } = w;
    r.strip = _;
    r.stripIn = by;
  }
}

/** a hint line on an FM-1 page (FONT_S): its rows' hints in order, two spaces apart, after `lead`; an item's `text`
 * stands for the rows named (two rows in one: "BLACK/SELECT row"); `width`: the line's field in pixels. export-defs
 * writes each as HINT_<ID> into controls.h and refuses a line wider than its field */
export interface HintLine { id: string; lead?: string; items: (string | { row: string | string[]; text: string })[]; width: number }
export const HINTS: HintLine[] = [
  // the SEQ page's line under the grid (seq_ui.c seq_grid_draw)
  // (#582 p7: LFO's two jobs apart, the tie with a key held; K4's move left to the sheet for the room)
  { id: 'step_record', items: ['sr-keys', { row: 'sr-rest', text: 'LFO rest  KEY+LFO tie' }, 'sr-end'], width: 228 },
  { id: 'step_silent', items: [{ row: 'sr-keys', text: 'SILENT' }, { row: 'sr-rest', text: 'LFO rest  KEY+LFO tie' }, 'sr-end'], width: 228 },
  { id: 'live', items: ['take', 'roll-view', 'octave', 'take-accent'], width: 228 },
  { id: 'held_drum', lead: 'HELD:', items: ['held-velocity', 'held-chance-select', 'lock-pages'], width: 228 },
  { id: 'drum_rec_long', items: [{ row: 'row-key', text: 'BLACK rec' }, 'row-select', 'step', 'steps-page'], width: 228 },
  { id: 'drum_rec', items: [{ row: 'row-key', text: 'BLACK rec' }, 'row-select', 'step', 'accent'], width: 228 },
  { id: 'drum_long', items: [{ row: ['row-key', 'row-select'], text: 'BLACK/SELECT row' }, 'step', 'accent', 'steps-page'], width: 228 },
  { id: 'drum', items: ['row-key', 'step', 'accent', 'song-page'], width: 228 },
  { id: 'roll', items: ['roll-keys', 'roll-view', 'octave', 'song-page'], width: 228 },
  // (a patch without a note in any pattern while the store holds patterns, #1202 G8: how to fill it)
  { id: 'empty', lead: 'EMPTY ', items: ['pattern-browse'], width: 228 },
  // (the stored patterns' browser, seq_ui.c seq_br_draw)
  { id: 'browse', items: [{ row: 'pattern-browse', text: 'PRESET choose  SEL load  HOME cancel' }], width: 228 },
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
      case 'top': return 'm:TOP 3';
      default: return 't:keys together';
    }
  };
  const out: string[] = [];
  if (g.first) out.push(`k:${g.first}`, 't:then');
  if (g.how === 'hold 2 s' && g.join !== 'together') out.push('t:hold');   // (buttons together: joined by "+", then 2 s)
  if (g.hold === 'step') out.push('t:hold step +');
  else if (g.hold) out.push(`k:${g.hold}`, 't:+');
  out.push(g.do.map(part).join(g.join === 'list' ? '|' : g.join === 'together' ? '|t:+|' : '|t:/|'));
  if (g.how === 'tap') out.push('t:tap');
  if (g.how === 'held') out.push('t:held');
  if (g.how === 'hold 1 s') out.push('t:1 s');
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
/** a row's words on the editor's controls strip (in a state's tab: its `stripIn` words): `strip`, else its words off the
 * sheet (plainDoes), `{list}` as LIST_WORDS */
export const stripDoes = (r: ControlRow, state?: HelpState): string =>
  ((state && r.stripIn?.[state]) ?? r.strip ?? plainDoes(r, state)).replace(LIST_MARK, LIST_WORDS);

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
  long_track: 'a track of more than 16 steps', tracks: 'a patch with Steps tracks', menu_guide: 'the GUIDE tab', menu_page: 'the MIDI, PANEL, SYSTEM and EQ tabs',
  menu_system: 'the SYSTEM tab', roll: 'a melodic track', harm: 'the keys on a Harmonizer: the seven lowest keys',
  harm_inv: 'the keys on a Harmonizer with its INVKEYS row on: the three highest keys',
  roll_preview: 'a melodic track with note preview on', roll_silent: 'a melodic track with note preview off',
  fx_rack: 'a patch with an effect or an FX drawer', pattern_store: 'while the pattern store is on',
  oct_banks: 'the keys on a drum track of more than 8 rows', drum_banks: 'a drum track of more than 8 rows',
  learning: 'while MIDI learn mode waits for a knob or a drum key (HOME + SEL)', fx_effect: 'an effect, in an FX drawer or on the canvas',
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
      case 'top': return 'the three highest keys';
      default: return 'keys together';
    }
  };
  let t = g.do.map(part).join(g.join === 'list' ? ', ' : g.join === 'together' ? ' + ' : ' / ');
  if (g.how === 'tap') t += ' tapped';
  if (g.how === 'held') t += ' held + the keys';
  if (g.how === 'hold 1 s') t += ' held 1 s';
  if (g.how === 'hold 2 s') t += ' held 2 s';
  if (g.hold) t = `${g.hold === 'step' ? 'a held step' : `${g.hold} held`} + ${t}`;
  if (g.where) t += ` ${g.where}`;
  if (g.first) t = `${g.first} then ${t}`;
  return t;
}
/** where a row applies, in words ('' everywhere it is listed) */
const whenText = (r: ControlRow): string => (r.when && !r.when.startsWith('!') ? ` (${CONDITION_TEXT[r.when as Condition]})` : '');
/** a row's words for the editor: what it does, at length, and where it applies */
export const rowHelp = (r: ControlRow): string => (r.help ?? plainDoes(r)) + whenText(r);

/** what the FM-1 does that is no single control, for the editor's help: the sheet, the quick start, the keys */
export const FM1_NOTES: { keys: string; text: string }[] = [
  { keys: 'OCT- + OCT+', text: 'the controls sheet: what the controls do where the FM-1 is now (its tab) and everywhere (EVERYWHERE), made from the same table as this list. ALGO switches the tab, SELECT scrolls, HOME closes it; the note keys and PLAY still work, the other controls do nothing meanwhile' },
  { keys: 'quick start', text: 'the card after power-on: HOME closes it, OCT- + OCT+ opens the controls sheet instead, HOME + SAVE turns it off for good (GLO › SYSTEM › QUICK START or FACTORY RESET turns it on again); any other knob or button closes it and then does its job' },
  { keys: 'FX, LFO, EDIT, ARP', text: 'patch buttons: the patch normally decides what each does (a gate, a Toggle that bypasses a module or assembly, or a list of device pages). On a patch with an FX drawer, FX goes to the first effect of the instrument on show (else the armed one’s, else the Output drawer’s); the effects are ordinary device pages, and a Toggle on a drawer turns its effects on and off. The sheet lists the loaded patch’s jobs. On the SEQ and SONG pages FX and LFO keep the jobs below' },
  { keys: 'the keys', text: 'they play what is armed (SEL, REC held + a black key, the SEQ page arms the track it shows); nothing armed, Main’s cables decide (KEYS WIRED, and the environment says WIRED on the devices they reach). While the keys reach a Drum map, black keys 1..8 play its rows on every page; a drum track with more than 8 rows (several Drum maps) plays them 8 at a time, OCT picking which 8 (SEL + OCT on the SEQ page)' },
  { keys: 'SAVE held at power-on', text: 'safe mode: the fallback patch, nothing read from flash; a restart leaves it (the loading screen says HOLD SAVE: SAFE MODE)' },
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
  return CONTROLS.filter((r) => r.gesture.join !== 'list' && (r.gesture.first === b || r.gesture.hold === b || r.gesture.do.some(mine))).map((r) => {
    const g = r.gesture;
    const how = g.first === b ? `then ${gestureText({ ...g, first: undefined })}: ` : g.first ? `after ${g.first}: ` : g.hold === b ? `held + ${gestureText({ ...g, hold: undefined })}: ` : g.join === 'together' ? `${gestureText(g)}: ` : g.how === 'hold 2 s' ? 'held 2 s: '
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
