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
  'focus', 'device_page', 'leave_list', 'list_page', 'preset', 'param', 'fine',
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
  /** the sheet's description (after the gesture); '' none */
  does: string;
  /** a grey line on the sheet before the row ("in the editor:") */
  heading?: string;
  /** the state tabs it shows on, each with its order there (lower first) */
  sheet?: Partial<Record<HelpState, number>>;
  /** the EVERYWHERE tab: the states whose EVERYWHERE tab lists it, each with its order there */
  everywhere?: Partial<Record<HelpState, number>>;
  /** shown only when this condition holds */
  when?: Condition | `!${Condition}`;
  effect: Effect;
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
  { id: 'play', gesture: { do: [B('PLAY')] }, does: 'start / stop', everywhere: at(10, ALL), effect: 'transport' },
  { id: 'rec', gesture: { do: [B('REC')] }, does: 'record', everywhere: at(20, but('sandbox', 'drum', 'roll', 'step')), effect: 'record' },
  { id: 'save', gesture: { do: [B('SAVE')] }, does: 'save patch', everywhere: at(30, but('menu', 'sandbox')), effect: 'save' },
  { id: 'home', gesture: { do: [B('HOME')] }, does: 'back', everywhere: at(40, but('sandbox')), effect: 'back' },
  { id: 'glo', gesture: { do: [B('GLO')] }, does: 'settings', everywhere: at(50, but('menu')), effect: 'menu' },
  { id: 'env', gesture: { do: [B('ENV')] }, does: 'environment', everywhere: at(60, but('env', 'sandbox')), effect: 'env' },
  { id: 'seq', gesture: { do: [B('SEQ')] }, does: 'steps page', everywhere: at(70, but(...SEQ_STATES, 'sandbox')), effect: 'seq' },
  { id: 'octave', gesture: { do: [B('OCT-'), B('OCT+')] }, does: 'octave', sheet: { step: 80 }, everywhere: at(80, but('drum', 'roll', 'menu', 'step')), effect: 'octave' },
  { id: 'tempo', gesture: { hold: 'PLAY', do: [E('PRESET')] }, does: 'tempo', everywhere: at(90, ALL), effect: 'tempo' },
  { id: 'patch', gesture: { hold: 'HOME', do: [E('PRESET')] }, does: 'patches', everywhere: at(100, but('menu', 'sandbox')), effect: 'patch' },
  { id: 'store', gesture: { hold: 'ENV', do: [B('SAVE')] }, does: 'save device preset', when: 'dev_store', sheet: { device: 90, env: 60 }, everywhere: at(110, but('device', 'env', 'sandbox')), effect: 'store' },
  { id: 'arm', gesture: { hold: 'REC', do: [BLACK] }, does: 'arm a track', when: 'tracks', everywhere: at(120, but('sandbox')), effect: 'arm' },
  { id: 'mute', gesture: { hold: 'SEQ', do: [BLACK] }, does: 'mute a track', when: 'tracks', everywhere: at(130, but('sandbox')), effect: 'mute' },

  // ---- DEVICE: a device page
  { id: 'list-leave', gesture: { do: [E('SELECT')] }, does: 'leave the list', when: 'list', sheet: { device: 10 }, effect: 'leave_list' },
  { id: 'devices', gesture: { do: [E('SELECT')] }, does: 'devices', when: '!list', sheet: { device: 11 }, effect: 'focus' },
  { id: 'list-pages', gesture: { do: [E('ALGO')] }, does: "the list's pages", when: 'list', sheet: { device: 20 }, effect: 'list_page' },
  { id: 'device-pages', gesture: { do: [E('ALGO')] }, does: 'device pages', when: '!list', sheet: { device: 21 }, effect: 'device_page' },
  { id: 'device-presets', gesture: { do: [E('PRESET')] }, does: 'device presets', when: 'dev_presets', sheet: { device: 30 }, effect: 'preset' },
  { id: 'adjust', gesture: { do: [K('1234')] }, does: 'adjust values', sheet: { device: 40 }, effect: 'param' },
  { id: 'fine', gesture: { hold: 'HOME', do: [K('1234')] }, does: 'fine adjust', sheet: { device: 50 }, effect: 'fine' },
  { id: 'arm-device', gesture: { do: [B('SEL')] }, does: 'arm this device', when: 'dev_keys', sheet: { device: 60 }, effect: 'arm' },

  // ---- ENVIRONMENT: one row per device
  { id: 'env-rows', gesture: { do: [E('SELECT')] }, does: 'device rows', sheet: { env: 10 }, effect: 'focus' },
  { id: 'env-first-page', gesture: { do: [K('1234')] }, does: "row's first page", sheet: { env: 20 }, effect: 'param' },
  { id: 'env-presets', gesture: { do: [E('PRESET')] }, does: "row's presets", when: 'dev_presets', sheet: { env: 30 }, effect: 'preset' },
  { id: 'env-presets-algo', gesture: { do: [E('ALGO')] }, does: "row's presets", when: 'dev_presets', sheet: { env: 40 }, effect: 'preset' },
  { id: 'env-arm', gesture: { do: [B('SEL')] }, does: 'arm / disarm row', when: 'dev_keys', sheet: { env: 50 }, effect: 'arm' },

  // ---- the SEQ page: a drum grid (DRUM STEPS) and a melodic track's piano roll (PIANO ROLL)
  { id: 'step', gesture: { do: [WHITE] }, does: 'step on / off', sheet: { drum: 10, roll: 10 }, effect: 'step' },
  { id: 'row-key', gesture: { do: [BLACK] }, does: 'pick a row', sheet: { drum: 20, roll: 20 }, effect: 'row' },
  { id: 'row-select', gesture: { do: [E('SELECT')] }, does: 'pick a row', sheet: { drum: 30 }, effect: 'row' },
  { id: 'roll-view', gesture: { do: [E('SELECT')] }, does: '8 pitches up / down', sheet: { roll: 30, live: 30 }, effect: 'roll_view' },
  { id: 'roll-pitch', gesture: { hold: 'SEL', do: [E('SELECT')] }, does: 'a pitch up / down', sheet: { roll: 40 }, effect: 'roll_pitch' },
  { id: 'pen', gesture: { hold: 'SEL', do: [ANY_KEY] }, does: 'jump to pitch', when: 'roll', sheet: { roll: 50, step: 70 }, effect: 'jump' },
  { id: 'steps-page', gesture: { do: [B('OCT-'), B('OCT+')] }, does: 'steps 17+', when: 'long_track', sheet: { drum: 40, roll: 150 }, effect: 'steps_page' },
  { id: 'track', gesture: { do: [E('ALGO')] }, does: 'track', sheet: { drum: 50, roll: 170, live: 40 }, effect: 'track' },
  { id: 'pattern', gesture: { do: [E('PRESET')] }, does: 'pattern', sheet: { drum: 60, roll: 180, live: 50 }, effect: 'pattern' },
  { id: 'accent', gesture: { hold: 'FX', do: [WHITE] }, does: 'accent', sheet: { drum: 70, roll: 60 }, effect: 'accent' },
  { id: 'tie', gesture: { hold: 'LFO', do: [WHITE] }, does: 'tie', sheet: { drum: 80, roll: 70 }, effect: 'tie' },
  { id: 'step-record', gesture: { do: [B('REC')] }, does: 'step record', sheet: { drum: 90, roll: 80 }, effect: 'step_record' },
  { id: 'step-record-there', gesture: { hold: 'REC', do: [WHITE] }, does: 'step record there', sheet: { drum: 100, roll: 90 }, effect: 'step_record_at' },
  { id: 'held-pitch', gesture: { hold: 'step', do: [K('1')] }, does: 'pitch', sheet: { roll: 100 }, effect: 'pitch' },
  { id: 'held-velocity', gesture: { hold: 'step', do: [K('2')] }, does: 'velocity', sheet: { drum: 110, roll: 110 }, effect: 'velocity' },
  { id: 'held-chance-select', gesture: { hold: 'step', do: [E('SELECT')] }, does: 'chance', sheet: { drum: 120 }, effect: 'chance' },
  { id: 'held-chance', gesture: { hold: 'step', do: [K('3')] }, does: 'chance', sheet: { roll: 120 }, effect: 'chance' },
  { id: 'lock-pages', gesture: { hold: 'step', do: [E('ALGO')] }, does: 'lock pages', sheet: { drum: 130, roll: 130 }, effect: 'lock_page' },
  { id: 'lock-rows', gesture: { hold: 'step', do: [K('1234')] }, does: 'lock rows', sheet: { drum: 140, roll: 140 }, effect: 'lock' },
  { id: 'keys-octave', gesture: { hold: 'FX', do: [B('OCT')] }, does: "keys' octave", sheet: { roll: 160 }, effect: 'keys_octave' },
  { id: 'song-page', gesture: { do: [B('SEL')], how: 'tap' }, does: 'song', sheet: { drum: 150, roll: 190 }, effect: 'song_page' },
  { id: 'clear', gesture: { hold: 'SEQ', do: [B('REC')] }, does: 'clear track', sheet: { drum: 160, roll: 200 }, effect: 'clear' },

  // ---- STEP RECORD (#532, D-804)
  { id: 'sr-keys', gesture: { do: [{ key: 'keys' }] }, does: 'play, let go: write', sheet: { step: 10 }, effect: 'write' },
  { id: 'sr-chord', gesture: { do: [{ key: 'chord' }] }, does: 'one chord', sheet: { step: 20 }, effect: 'chord' },
  { id: 'sr-rest', gesture: { do: [B('LFO')] }, does: 'rest, keys held: tie', sheet: { step: 30 }, effect: 'rest' },
  { id: 'sr-accent', gesture: { do: [B('FX')], how: 'held' }, does: 'accent', sheet: { step: 40 }, effect: 'accent' },
  { id: 'sr-cursor', gesture: { do: [K('4')] }, does: 'move cursor', sheet: { step: 50 }, effect: 'cursor' },
  { id: 'sr-back', gesture: { do: [{ key: 'black', n: 10 }] }, does: 'back, clear step', sheet: { step: 60 }, effect: 'back_clear' },
  { id: 'sr-live', gesture: { do: [B('PLAY')] }, does: 'play, record live', sheet: { step: 90 }, effect: 'live' },
  { id: 'sr-end', gesture: { do: [B('REC'), B('HOME')] }, does: 'end step record', sheet: { step: 100 }, effect: 'end' },

  // ---- LIVE TAKE: REC records the armed melodic track while the transport runs, on its SEQ page
  { id: 'take', gesture: { do: [{ key: 'keys' }] }, does: 'record notes', sheet: { live: 10 }, effect: 'take' },
  { id: 'take-accent', gesture: { do: [B('FX')], how: 'held' }, does: 'accented notes', sheet: { live: 20 }, effect: 'take_accent' },

  // ---- SONG (#375, D-541)
  { id: 'song-entry', gesture: { do: [E('SELECT')] }, does: 'pick entry', sheet: { song: 10 }, effect: 'entry' },
  { id: 'song-pattern', gesture: { do: [K('1')] }, does: "entry's pattern", sheet: { song: 20 }, effect: 'entry_pattern' },
  { id: 'song-add', gesture: { do: [K('1')], where: 'on END' }, does: 'add entry', sheet: { song: 30 }, effect: 'add_entry' },
  { id: 'song-dup', gesture: { hold: 'FX', do: [K('1')] }, does: 'duplicate entry', sheet: { song: 40 }, effect: 'dup_entry' },
  { id: 'song-shift', gesture: { do: [K('2')] }, does: 'transpose entry', sheet: { song: 50 }, effect: 'transpose' },
  { id: 'song-play', gesture: { do: [K('4')] }, does: 'song on / off', sheet: { song: 60 }, effect: 'song_play' },
  { id: 'song-sel', gesture: { do: [E('ALGO')] }, does: 'song 1-8', sheet: { song: 70 }, effect: 'song' },
  { id: 'song-preset', gesture: { do: [E('PRESET')] }, does: 'selected pattern', sheet: { song: 80 }, effect: 'pattern' },
  { id: 'song-delete', gesture: { hold: 'SEQ', do: [B('REC')] }, does: 'delete entry', sheet: { song: 90 }, effect: 'delete_entry' },
  { id: 'song-back', gesture: { do: [B('SEL')] }, does: 'back to steps', sheet: { song: 100 }, effect: 'back_steps' },

  // ---- SETTINGS: the menu (GLO)
  { id: 'menu-tab', gesture: { do: [E('ALGO')] }, does: 'tab', sheet: { menu: 10 }, effect: 'tab' },
  { id: 'menu-scroll', gesture: { do: [E('SELECT')] }, does: 'scroll', when: 'menu_guide', sheet: { menu: 20 }, effect: 'scroll' },
  { id: 'menu-set', gesture: { do: [K('1234')] }, does: 'set', when: 'menu_page', sheet: { menu: 30 }, effect: 'set' },
  { id: 'menu-patches', gesture: { do: [E('PRESET')] }, does: 'patches', sheet: { menu: 40 }, effect: 'patch' },
  { id: 'menu-save', gesture: { do: [B('SAVE')] }, does: 'save, close', sheet: { menu: 50 }, effect: 'save_close' },
  { id: 'menu-run', gesture: { do: [B('GLO')], how: 'hold 2 s' }, does: 'run armed row', when: 'menu_system', sheet: { menu: 60 }, effect: 'run_row' },

  // ---- SANDBOX: the editor's page; its own buttons go to the editor
  { id: 'sb-devices', gesture: { do: [E('SELECT')] }, does: 'devices', sheet: { sandbox: 10 }, effect: 'editor' },
  { id: 'sb-pages', gesture: { do: [E('ALGO')] }, does: 'device pages', sheet: { sandbox: 20 }, effect: 'editor' },
  { id: 'sb-adjust', gesture: { do: [K('1234')] }, does: 'adjust values', sheet: { sandbox: 30 }, effect: 'editor' },
  { id: 'sb-buttons', gesture: { do: [B('SEQ'), B('ENV'), B('REC'), B('SAVE'), B('SEL')], join: 'list' }, does: '', heading: 'in the editor:', sheet: { sandbox: 40 }, effect: 'editor' },
];

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
/** a row's line on the sheet: its gesture, '~' and what it does */
export const rowSpec = (r: ControlRow): string => gestureSpec(r.gesture) + (r.does ? `~${r.does}` : '');

/** the rows of one tab of one state in order (`patch-buttons` where the patch's buttons go) */
export function sheetRows(state: HelpState, tab: 'state' | 'everywhere'): (ControlRow | typeof PATCH_BUTTONS)[] {
  const place = (r: { sheet?: Partial<Record<HelpState, number>>; everywhere?: Partial<Record<HelpState, number>> }): number | undefined =>
    tab === 'state' ? r.sheet?.[state] : r.everywhere?.[state];
  const all: (ControlRow | typeof PATCH_BUTTONS)[] = [...CONTROLS, PATCH_BUTTONS];
  return all.filter((r) => place(r) !== undefined).sort((a, b) => place(a)! - place(b)!);
}
