// SPDX-License-Identifier: GPL-3.0-only
import type { AssemblyInst } from './assembly';
import { migratePatchParts, migrateVoicing } from './poly';
import { migrateKnobs } from './knob-migrate';
import { fixNotes, fixPatterns, fixSeq, migrateSteps, type Pattern, type SeqState, type StepNote } from './track';
// Patch data model, shared by the editor, the WebAudio engine and (later) the firmware encoder.

/** keys: the held keys from Main to a Voice allocator (only into a keys input) */
export type SignalKind = 'audio' | 'control' | 'gate' | 'keys';

export interface PortDef {
  name: string;
  kind: SignalKind;
  /** shown in the editor instead of `name` */
  label?: string;
  /** set on the two parameter inputs `p1` and `p2` (1 or 2) */
  pin?: 1 | 2;
}

/** What can change a module's parameters: its two parameter inputs and the four FM-1 knobs. */
export type Source = 'p1' | 'p2' | 'k1' | 'k2' | 'k3' | 'k4';
export const SOURCES: Source[] = ['p1', 'p2', 'k1', 'k2', 'k3', 'k4'];

export interface ParamDef {
  name: string;
  /** Dedicated signal input controlling this value; also exposed on the editor's slider thumb. */
  input?: string;
  /** with `input`: the value the module settles on with a steady signal `cv` on that input (the editor's knob ticks) */
  rest?: (params: Record<string, number>, cv: number) => number;
  min: number;
  /** the top of the range the FM-1 has too: the knobs, modulation, macro ranges and the synced delay's note lengths span min..max */
  max: number;
  /** a browser-only stretch: the browser's engine takes values up to this (the card's slider reaches it). A value past
   * `max` is a browser-only ability: the patch is over the FM-1 budget (patchbin.ts browserOnly). Linear parameters only. */
  browserMax?: number;
  /** a stretch both engines take, past `max` (defs.h ptop): the card's slider, a typed value and the FM-1's knobs reach it,
   * while the parameter inputs, macro ranges and the morph keep moving over min..max, so patches made before the stretch
   * play the same (the Steps rates 1/2 and 1/64, swing to 80 %). A base past max stays past it under modulation, and a
   * morph with a side past max moves linearly. MIDI CC knobs span every choice of a choice list, else min..max. Linear
   * parameters only. */
  top?: number;
  default: number;
  step?: number;
  unit?: string;
  /** names for integer-valued choice params (waveform etc.) */
  choices?: string[];
  /** logarithmic: the range is covered in equal ratios (a filter cutoff in octaves). Modulation and the knobs move the value in
   * that space: a fraction of the range is a fraction of the octaves. */
  log?: boolean;
  /** with `log`: the position is the square root of the octave fraction (an inverse logarithmic bend: the low end gets more of the knob / slider travel) */
  bend?: boolean;
  /** an on/off switch (0 or 1): a check box in the editor, OFF / ON on the LCD */
  toggle?: boolean;
  /** while the toggle parameter `when` is on, the value is shown as `text(value)` instead of the number (the synced delay time as a note length) */
  altText?: { when: string; text: (v: number, params: Record<string, number>) => string };
  /** not a value: a display (the Scope's screen); it has no slider and goes on an assembly card like a parameter */
  screen?: true;
  /** set from its module's screen (the Scope's hover toolbar), never a row of a card nor promoted */
  onScreen?: true;
  /** the patch format (patchbin.ts VERSION) that appended this parameter to a type that existed before it. A binary of an
   * older format holds the type's parameters of its own format; the FM-1 reads it that way and gives this one its default
   * (engine.c eng_npar, defs.h psince). Only on the last parameters of a type, never decreasing. */
  since?: number;
}

/** position of a value in its range, 0..1 (logarithmic for log parameters) */
export function toUnit(pd: ParamDef, v: number): number {
  const x = Math.min(pd.max, Math.max(pd.min, v));
  if (!pd.log) return (x - pd.min) / (pd.max - pd.min);
  const t = Math.log(x / pd.min) / Math.log(pd.max / pd.min);
  return pd.bend ? Math.sqrt(t) : t;
}

export function fromUnit(pd: ParamDef, u: number): number {
  const x = Math.min(1, Math.max(0, u));
  if (!pd.log) return pd.min + x * (pd.max - pd.min);
  return pd.min * Math.pow(pd.max / pd.min, pd.bend ? x * x : x);
}

/** the most a parameter takes in the browser: its browser-only stretch (browserMax), its stretch (top) or its max */
export const topOf = (pd: ParamDef): number => pd.browserMax ?? pd.top ?? pd.max;

/** a parameter's base value moved by `mod` of its range (mean of a parameter input x attenuverter), clamped to the range; a
 * base past max (a stretch, browserMax or top) is clamped to the stretch instead, so modulation does not pull it back to max */
export function modulate(pd: ParamDef, base: number, mod: number): number {
  if (!pd.log) return Math.min(base > pd.max ? topOf(pd) : pd.max, Math.max(pd.min, base + mod * (pd.max - pd.min)));
  return fromUnit(pd, toUnit(pd, base) + mod);
}

/** a parameter's position in its range without the slider's bend (octaves for a log parameter): the space macro ranges and the morph move in */
export function paramUnit(pd: ParamDef, v: number): number {
  const x = Math.min(pd.max, Math.max(pd.min, v));
  return pd.log ? Math.log(x / pd.min) / Math.log(pd.max / pd.min) : (x - pd.min) / (pd.max - pd.min);
}

export function paramValue(pd: ParamDef, u: number): number {
  const x = Math.min(1, Math.max(0, u));
  return pd.log ? pd.min * Math.pow(pd.max / pd.min, x) : pd.min + x * (pd.max - pd.min);
}

/** the macro range of pin `s` on parameter `name`: the pin's value 0..1 lands between these two unit positions instead of adding to the base */
export type Range = [number, number];
export const rangeOf = (m: ModuleInst, s: 'p1' | 'p2', name: string): Range | undefined => m.range?.[s]?.[name];

export interface ModuleDef {
  type: string;
  label: string;
  inputs: PortDef[];
  outputs: PortDef[];
  params: ParamDef[];
  /** the module has the two parameter inputs p1, p2 (attenuverters) and the source matrix: every module but the FM-1 panel (the input) and the output */
  paramInputs?: boolean;
  /** the input a bypassed module passes to all of its outputs; default: the input called `in`, or none (the outputs are silent) */
  thru?: string;
  /**
   * Displays (the Scope's screen, an envelope's shape): editor-only entries a card draws and an assembly card can show
   * like a parameter (ParamRef.param names one), but not parameters: no value, never in `params`, so the engines, the
   * binary format and the firmware never see them.
   */
  views?: ParamDef[];
  /** bytes the module's binary record carries after its parameters and pins (patchbin.ts): a Steps module's name and pattern */
  data?: number;
}

/** a parameter or a display of a module type, by name (what a ParamRef can name) */
export const rowDef = (def: ModuleDef, name: string): ParamDef | undefined => def.params.find((q) => q.name === name) ?? def.views?.find((q) => q.name === name);

/** the input a bypassed module of this definition passes through, undefined when it mutes instead */
export const thruInput = (def: ModuleDef): string | undefined => def.thru ?? (def.inputs.some((p) => p.name === 'in') ? 'in' : undefined);

export interface Endpoint {
  module: number;
  port: string;
}

export interface Cable {
  from: Endpoint; // an output
  to: Endpoint; // an input
}

export interface ModuleInst {
  id: number;
  type: string;
  x: number;
  y: number;
  params: Record<string, number>;
  /** attenuverters of the parameter inputs p1 and p2, -1..1 (only on modules with paramInputs) */
  att?: [number, number];
  /** the matrix: the parameters each source controls. p1 / p2 add (input mean x attenuverter x range) to them, k1..k4 are
   * the FM-1 knobs, which nudge them while the module is selected on the device (only on modules with paramInputs) */
  map?: Record<Source, string[]>;
  /** bypassed: the module does not run; its outputs carry its through input (thruInput) or silence. Not on the panel or the output. */
  bypass?: boolean;
  /** Additional additive routes from side inputs to parameters; p1/p2 keep their existing map/depth/ranges. */
  inputMap?: Record<string, string[]>;
  /** the B side of a morph: the same parameters as `params`, taken from another patch of the same structure (setMorphTarget); the
   * Main module's `morph` (plus its morph input) fades every parameter from `params` to these. Not on the Main module. */
  paramsB?: Record<string, number>;
  /** macro ranges: for a parameter that p1 / p2 controls (map), the input's value 0..1 lands between these two positions of the
   * parameter's range (0..1, octaves for a log parameter; paramUnit) instead of adding to the base value */
  range?: { p1?: Record<string, [number, number]>; p2?: Record<string, [number, number]> };
  /** the Main module only: what the patch makes of the FM-1's panel (#60): which of its buttons (PANEL_BUTTONS) switch on and
   * off instead of acting while held, the switched ones that are on, and labels for K1..K6 and the buttons (the device's
   * player screen and legend show them; at most PANEL_LABEL_MAX characters of the LCD's font) */
  panel?: MainPanel;
  /** a Steps module only: its track name (at most TRACK_NAME_MAX characters of the LCD's font; the device shows STEPS n
   * without one) and its notes (#133, track.ts: start step, length, note, velocity, chance; sorted, absent while there
   * are none). Patches from before #133 carry `steps` (a byte per step, stepByte) and the lanes `notes` / `vels` (a number
   * per step) instead: fixTrack turns them into notes. */
  name?: string;
  notes?: StepNote[];
  /** a Steps module only: its patterns 2..PATTERNS_MAX (track.ts Pattern; null: it has none of that number, which then
   * plays its pattern 1); absent while there are none */
  patterns?: (Pattern | null)[];
  /** the Main module only: the patch's selected pattern and its songs (track.ts SeqState); absent while pattern 1 is
   * selected, no song plays and there are no songs */
  seq?: SeqState;
  /** a Drum map only (#137): its rows' names (DRUM_ROWS, at most TRACK_NAME_MAX characters each; '' = the default name;
   * editor only: the roll shows them as its rows) */
  names?: string[];
}

export interface MainPanel {
  /** PRESS: the buttons that switch on / off instead of acting while held */
  toggle?: string[];
  /** the switched ones that are on (a Toggle's: its target bypassed) */
  on?: string[];
  labels?: Record<string, string>;
  /** what each button does (#116, buttons.ts): absent = Gate (a patch from before the kinds); Nothing and Toggle (`bypass`) are listed */
  kinds?: Record<string, 'nothing' | 'bypass' | 'page'>;
  /** a Toggle's target: a module or an assembly (by id) */
  targets?: Record<string, { module: number } | { asm: number }>;
  /** a Page button's list (#117): device pages by the editor's device key and page index (pages.ts), in order */
  pages?: Record<string, { device: string; page: number }[]>;
}

/** a new patch's panel: every button that has an editor starts as Nothing (no implicit roles, #116); GLO stays as it is (#118) */
export const NEW_PANEL = (): MainPanel => ({ kinds: Object.fromEntries(['fx', 'scl', 'env', 'lfo', 'edit', 'arp'].map((b) => [b, 'nothing' as const])) });

/** the controls a panel label can name: the patch buttons (patchbin.ts writes the labels in this order). The knobs have
 * none any more: they show the names of the rows they turn (pages.ts). */
export const PANEL_LABEL_KEYS = ['fx', 'scl', 'env', 'lfo', 'edit', 'glo', 'arp'];
/** the panel buttons with a fixed role on the FM-1 (GLO its own page #199, SEL one level deeper and ENV the environment
 * #197): never a Toggle or Page button, never switching; their jacks still go high while they are held */
export const FIXED_BUTTONS = new Set(['glo', 'scl', 'env']);
export const PANEL_LABEL_MAX = 10;
/** the most pages a Page button's list holds */
export const PAGE_LIST_MAX = 16;
/** a label as the LCD can draw it: capitals, digits, space and its few signs */
export const panelLabel = (s: unknown, max = PANEL_LABEL_MAX): string => String(s ?? '').toUpperCase().replace(/[^A-Z0-9 +%&>=()?!#*<,_'.:\/-]/g, '').slice(0, max).trim();

/** the step byte of patterns saved before #133 (format 30 and older; track.ts migrateSteps reads them): bit 0 = on, bit 1
 * = accent, bits 2..6 = the chance code c (it plays with a chance of 100 - 5 c percent, c 0..19), bit 7 = tie (the note
 * sounding goes on through the step) */
export const TRACK_NAME_MAX = 8;
/** a Drum map's rows (#137, modules.ts drummap) */
export const DRUM_ROWS = 8;
export const trackName = (s: unknown): string => panelLabel(s, TRACK_NAME_MAX);
/** a Steps module as the editor and the FM-1 name it: its name, else STEPS n (n counts the patch's Steps modules) */
export function trackLabel(p: Patch, id: number): string {
  const tracks = p.modules.filter((m) => m.type === 'steps');
  const m = tracks.find((x) => x.id === id);
  return m?.name || `STEPS ${tracks.indexOf(m!) + 1}`;
}
export interface Step { on: boolean; accent: boolean; chance: number; tie?: boolean }
export const stepOf = (b: number | undefined): Step => ({ on: !!((b ?? 0) & 1), accent: !!((b ?? 0) & 2), chance: 100 - 5 * Math.min(19, ((b ?? 0) >> 2) & 31), tie: !!((b ?? 0) & 0x80) });
export const stepByte = (s: Step): number => (s.on ? 1 : 0) | (s.accent ? 2 : 0) | (Math.min(19, Math.max(0, Math.round((100 - s.chance) / 5))) << 2) | (s.tie ? 0x80 : 0);

/** a module's Steps data (name, notes) made valid in place, a pattern from before #133 turned into notes, a Drum map's row
 * names; other modules lose those fields */
export function fixTrack(m: ModuleInst): void {
  if (m.type === 'drummap' && Array.isArray(m.names)) {
    const names = Array.from({ length: DRUM_ROWS }, (_, r) => trackName(m.names![r] ?? ''));
    if (names.some((n) => n)) m.names = names;
    else delete m.names;
  } else delete m.names;
  const old = m as ModuleInst & { steps?: unknown; vels?: unknown };
  const legacy = Array.isArray(old.steps) || (Array.isArray(old.notes) && old.notes.some((n) => typeof n !== 'object'));
  const notes = m.type !== 'steps' ? undefined : legacy ? migrateSteps(old.steps, old.notes, old.vels) : fixNotes(m.notes);
  delete old.steps;
  delete old.vels;
  if (m.type !== 'steps') {
    delete m.name;
    delete m.notes;
    delete m.patterns;
    return;
  }
  const patterns = fixPatterns(m.patterns);
  if (patterns) m.patterns = patterns;
  else delete m.patterns;
  const name = trackName(m.name);
  if (name) m.name = name;
  else delete m.name;
  if (notes) m.notes = notes;
  else delete m.notes;
}

/** a Main module's panel settings from anything: known names only, labels as the LCD draws them; undefined when empty */
export function fixPanel(raw: unknown): MainPanel | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const buttons = PANEL_LABEL_KEYS;
  const names = (v: unknown): string[] => (Array.isArray(v) ? [...new Set(v.filter((x): x is string => buttons.includes(x)))] : []);
  const kinds: Record<string, 'nothing' | 'bypass' | 'page'> = {};
  if (r.kinds && typeof r.kinds === 'object')
    for (const [k, v] of Object.entries(r.kinds as Record<string, unknown>)) if (buttons.includes(k) && !FIXED_BUTTONS.has(k) && (v === 'nothing' || v === 'bypass' || v === 'page')) kinds[k] = v;
  const pages: Record<string, { device: string; page: number }[]> = {};
  if (r.pages && typeof r.pages === 'object')
    for (const [k, v] of Object.entries(r.pages as Record<string, unknown>)) {
      if (kinds[k] !== 'page' || !Array.isArray(v)) continue;
      const list = v.filter((x): x is { device: string; page: number } => !!x && typeof x.device === 'string' && Number.isInteger(x.page) && x.page >= 0)
        .map((x) => ({ device: x.device, page: x.page })).slice(0, PAGE_LIST_MAX);
      if (list.length) pages[k] = list;
    }
  const targets: Record<string, { module: number } | { asm: number }> = {};
  if (r.targets && typeof r.targets === 'object')
    for (const [k, v] of Object.entries(r.targets as Record<string, unknown>)) {
      const t = v as { module?: unknown; asm?: unknown } | null;
      if (kinds[k] !== 'bypass' || !t || typeof t !== 'object') continue;
      if (Number.isInteger(t.module)) targets[k] = { module: t.module as number };
      else if (Number.isInteger(t.asm)) targets[k] = { asm: t.asm as number };
    }
  const toggle = names(r.toggle).filter((b) => !FIXED_BUTTONS.has(b) && kinds[b] !== 'nothing' && kinds[b] !== 'page');   // only Gates and Toggles have PRESS (GLO, SEL, ENV are fixed)
  const on = names(r.on).filter((b) => toggle.includes(b));
  const labels: Record<string, string> = {};
  if (r.labels && typeof r.labels === 'object')
    for (const [k, v] of Object.entries(r.labels as Record<string, unknown>)) if (PANEL_LABEL_KEYS.includes(k) && panelLabel(v)) labels[k] = panelLabel(v);
  const out: MainPanel = {};
  if (toggle.length) out.toggle = toggle;
  if (on.length) out.on = on;
  if (Object.keys(labels).length) out.labels = labels;
  if (Object.keys(kinds).length) out.kinds = kinds;
  if (Object.keys(targets).length) out.targets = targets;
  if (Object.keys(pages).length) out.pages = pages;
  return Object.keys(out).length ? out : undefined;
}

export interface Patch {
  version: 2;
  name: string;
  modules: ModuleInst[];
  cables: Cable[];
  /** groups of modules shown as one card (an editor-only overlay, see assembly.ts); the engine and the FM-1 ignore it */
  assemblies?: AssemblyInst[];
  /** the name of the patch the B side (paramsB) was taken from, for display */
  morphName?: string;
  /** outputs patched into the sidebar's sliders (an editor-only toy; the engine, the encoder and the FM-1 ignore them): one
   * sways the cables (its signal adds to the cable slack), one moves the zoom */
  slackFrom?: Endpoint;
  zoomFrom?: Endpoint;
  /** (legacy) the firmware arpeggiator's settings before the Arpeggiator module (#58): validatePatch keeps only its tempo,
   * as the Main module's tempo, and drops the rest */
  arp?: { bpm?: number };
  /** the computer keyboard's octave (Z / X, the octave buttons) when the patch was last played, so a bass patch opens low;
   * absent = 0. Editor only: the engine, the encoder and the FM-1 ignore it */
  octave?: number;
  /** where the canvas was looked at: the user's zoom and the scroll position of the view's top left in unzoomed layout
   * pixels (Editor.restoreView / stampView). Editor only */
  view?: { zoom: number; x: number; y: number };
  /** what the patch is about, in the author's words (the share sheet's "What's going on"; at most NOTES_MAX characters).
   * Editor only, like the name: it travels in a link and a .json file; the binary format and the FM-1 ignore it */
  notes?: string;
}

/** the longest Patch.notes kept */
export const NOTES_MAX = 500;

/** the computer keyboard's octave range (Patch.octave, input.ts) */
export const OCTAVE_MIN = -3, OCTAVE_MAX = 3;

/** do two patches have the same structure (modules of the same types in the same order, the same cables), so that one can be the B side of the other? */
export function sameStructure(a: Patch, b: Patch): boolean {
  if (a.modules.length !== b.modules.length || a.cables.length !== b.cables.length) return false;
  if (a.modules.some((m, i) => m.type !== b.modules[i].type)) return false;
  const key = (p: Patch): string => {
    const idx = new Map(p.modules.map((m, i) => [m.id, i]));
    return p.cables
      .map((c) => `${idx.get(c.from.module)}:${c.from.port}>${idx.get(c.to.module)}:${c.to.port}`)
      .sort()
      .join(' ');
  };
  return key(a) === key(b);
}

/** take patch b's parameters as the B side of p (same structure required); the Main module's own parameters are not morphed */
export function setMorphTarget(p: Patch, b: Patch, defs: Record<string, ModuleDef>): void {
  if (!sameStructure(p, b)) throw new Error('the B patch must have the same modules and cables');
  p.modules.forEach((m, i) => {
    if (m.type === 'fm1') return;
    const out: Record<string, number> = {};
    for (const pd of defs[m.type].params) out[pd.name] = b.modules[i].params[pd.name] ?? pd.default;
    m.paramsB = out;
  });
  p.morphName = b.name;
}

export function clearMorph(p: Patch): void {
  for (const m of p.modules) delete m.paramsB;
  delete p.morphName;
}

export const hasMorph = (p: Patch): boolean => p.modules.some((m) => m.paramsB);

/** a parameter between its A and B values at morph position t (0..1): linearly, or in octaves for a log parameter (without the
 * slider's bend: the midpoint of 200 and 3200 Hz is 800 Hz); a choice or switch snaps at 0.5 */
export function morphValue(pd: ParamDef, a: number, b: number, t: number): number {
  if (pd.choices || pd.toggle) return t < 0.5 ? a : b;
  if (!pd.log && Math.max(a, b) > pd.max) return a + (b - a) * t; // (a stretch, browserMax or top: past the range paramUnit clamps to)
  return paramValue(pd, paramUnit(pd, a) + (paramUnit(pd, b) - paramUnit(pd, a)) * t);
}

/** the FM-1's module limit per patch (ENG_MAX_MODULES): the budget meter counts against it, the editor does not stop at it */
export const MAX_MODULES = 64;

/**
 * How a poly group plays (poly.ts polyGroups / deviceView; the engines' and the binary's form): the settings of the Voice
 * allocator that drives it plus the flaws of its voice cards. assign / legato / priority index ASSIGN_MODES / LEGATO_MODES /
 * PRIORITIES. In a patch these live on the allocator module (its parameters) and on the poly assembly (PolyCards).
 */
export interface PolyCfg {
  /** 1 .. EDITOR_MAX_PARTS (the FM-1 plays up to MAX_PARTS) */
  parts: number;
  /** 0 rotate, 1 lowest free, 2 reuse (a free part whose last note was the key), 3 rotate with reset after all keys lift */
  assign: number;
  /** 0 auto (legato with one part; a stolen part restarts its envelopes), 1 off (always restart), 2 on (never) */
  legato: number;
  /** which held notes sound when there are more than parts: 0 last, 1 low, 2 high */
  priority: number;
  /** the selected unison voices play the one note the priority picks */
  unison?: boolean;
  /** voices stacked in unison; absent or zero: all poly voices, otherwise capped by parts */
  unisonParts?: number;
  /** distribute the unison pool evenly over the held notes (Jupiter-4 UNISON II) */
  unisonShare?: boolean;
  /** false: ignore new notes when all polyphonic voices are held; absent: steal by priority */
  steal?: boolean;
  /**
   * Each part's own flaws, set by hand (an analog polysynth's voice cards are never quite alike): flaws[i] is part i's,
   * a missing entry is FLAW_NONE. Kept for every part number up to EDITOR_MAX_PARTS, so fewer parts and back keeps them.
   */
  flaws?: PartFlaw[];
  /** the MIDI channel whose keys the group takes, 1..16; absent: the device's channel (all in the browser) */
  channel?: number;
  /** the lowest / highest key it takes (MIDI note numbers); absent: 0 / 127 */
  low?: number;
  high?: number;
}

/** does a group take this key: in its range, and (direct keys only, `ch` given) on its channel or, with none set, on the
 * device's (`device` 0 = every channel). Both engines: engine.ts noteOn, engine.c eng_note_on. */
export function takesKey(cfg: PolyCfg, note: number, ch?: number, device = 0): boolean {
  if (note < (cfg.low ?? 0) || note > (cfg.high ?? 127)) return false;
  if (ch === undefined) return true;
  return cfg.channel ? cfg.channel === ch : !device || device === ch;
}

/**
 * One part's flaws, all integers (the binary stores them as bytes, patchbin.ts). The engines apply them per part:
 * detune and drift move the Part module's pitch; bright moves the cutoff of every filter / ladder inside, env scales the
 * times of every ADSR / envelope inside, level scales the gain of every VCA inside (FLAW_TARGETS).
 */
export interface PartFlaw {
  /** cents, -50 .. 50 */
  detune: number;
  /** 0 .. 100 %: a slow random wander of the pitch, up to +-DRIFT_CENTS at 100 */
  drift: number;
  /** semitones on the filter cutoffs, -24 .. 24 */
  bright: number;
  /** % on the envelope times, -50 .. 50 (+50 = half as long again) */
  env: number;
  /** % of the VCA gain, 0 .. 100 */
  level: number;
}
export const FLAW_NONE: PartFlaw = { detune: 0, drift: 0, bright: 0, env: 0, level: 100 };
export const FLAW_RANGE: Record<keyof PartFlaw, [number, number]> = { detune: [-50, 50], drift: [0, 100], bright: [-24, 24], env: [-50, 50], level: [0, 100] };
export const FLAW_KEYS = Object.keys(FLAW_NONE) as (keyof PartFlaw)[];
/** the pitch wander of a part at drift 100 %, in cents either way */
export const DRIFT_CENTS = 20;
/** the parameters each flaw moves, by module type (engine.ts applyFlaws, engine.c apply_flaws) */
export const FLAW_TARGETS: Record<'bright' | 'env' | 'level', Record<string, string[]>> = {
  bright: { filter: ['cutoff'], ladder: ['cutoff'] },
  env: { adsr: ['a', 'd', 'r'], env: ['r1', 'r2', 'r3', 'r4'], env8: ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8'] },
  level: { vca: ['gain'] },
};
/** the FM-1's part limit (POLY_MAX_PARTS in defs.h); the editor and the browser engine go up to EDITOR_MAX_PARTS */
export const MAX_PARTS = 8;
export const EDITOR_MAX_PARTS = 16;
export const POLY_DEFAULT: PolyCfg = { parts: 4, assign: 0, legato: 0, priority: 0 };

/** a poly assembly's own settings (AssemblyInst.poly): the flaws of its voice cards. How many cards run and how notes reach
 * them is the Voice allocator's that feeds it (poly.ts allocatorOf). */
export interface PolyCards {
  flaws?: PartFlaw[];
}

/** a poly assembly's settings from a file: the flaws (an old file's parts / assign / legato / priority go to its allocator,
 * poly.ts migrateParts, before this runs) */
export function fixCards(raw: unknown): PolyCards {
  const flaws = fixFlaws((raw && typeof raw === 'object' ? raw : {}) && (raw as Record<string, unknown>).flaws);
  return flaws ? { flaws } : {};
}

/** the group settings of an allocator module (its parameters) and the cards it drives */
export function polyCfg(alloc: ModuleInst, cards: PolyCards = {}): PolyCfg {
  const int = (k: string, lo: number, hi: number, d: number): number => {
    const v = Math.round(Number(alloc.params[k]));
    return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d;
  };
  const cfg: PolyCfg = { parts: int('voices', 1, EDITOR_MAX_PARTS, POLY_DEFAULT.parts), assign: int('assign', 0, 3, 0), legato: int('legato', 0, 2, 0), priority: int('priority', 0, 2, 0) };
  if (!int('steal', 0, 1, 1)) cfg.steal = false;
  const unison = int('unison', 0, 2, 0);
  if (unison) cfg.unison = true;
  if (unison === 2) cfg.unisonShare = true;
  const stack = int('stack', 0, EDITOR_MAX_PARTS, 0);
  if (stack) cfg.unisonParts = stack;
  const ch = int('channel', 0, 16, 0), low = int('low', 0, 127, 0), high = int('high', 0, 127, 127);
  if (ch) cfg.channel = ch;
  if (low) cfg.low = low;
  if (high < 127) cfg.high = high;
  if (cards.flaws) cfg.flaws = cards.flaws;
  return cfg;
}

/** part i's flaws (FLAW_NONE when it has none) */
export const flawOf = (cfg: { flaws?: PartFlaw[] }, i: number): PartFlaw => cfg.flaws?.[i] ?? FLAW_NONE;
export const isFlawless = (f: PartFlaw): boolean => FLAW_KEYS.every((k) => f[k] === FLAW_NONE[k]);

/** flaws from a file, every field an integer in range; trailing flawless parts are dropped, none at all = undefined */
export function fixFlaws(raw: unknown): PartFlaw[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out = raw.slice(0, EDITOR_MAX_PARTS).map((e): PartFlaw => {
    const r = (e && typeof e === 'object' ? e : {}) as Record<string, unknown>;
    const f = { ...FLAW_NONE };
    for (const k of FLAW_KEYS) {
      const v = Math.round(Number(r[k]));
      if (Number.isFinite(v)) f[k] = Math.max(FLAW_RANGE[k][0], Math.min(FLAW_RANGE[k][1], v));
    }
    return f;
  });
  while (out.length && isFlawless(out[out.length - 1])) out.pop();
  return out.length ? out : undefined;
}

/** a poly setting from a file or an older editor, every field in range (an old `unit` is dropped) */
export function fixPoly(raw: unknown): PolyCfg {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const int = (k: 'parts' | 'assign' | 'legato' | 'priority', lo: number, hi: number): number => {
    const v = Math.round(Number(r[k]));
    return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : POLY_DEFAULT[k];
  };
  const cfg: PolyCfg = { parts: int('parts', 1, EDITOR_MAX_PARTS), assign: int('assign', 0, 2), legato: int('legato', 0, 2), priority: int('priority', 0, 2) };
  const flaws = fixFlaws(r.flaws);
  if (flaws) cfg.flaws = flaws;
  return cfg;
}

export function emptyPatch(name = 'init'): Patch {
  return { version: 2, name, modules: [], cables: [] };
}

/** what the editor's "New patch" opens: the Main panel at the top left and the Output at the right, nothing wired (grid of assembly.ts) */
export function newPatch(defs: Record<string, ModuleDef>, name = 'init'): Patch {
  const p = emptyPatch(name);
  addModule(p, defs.fm1, 20, 20).panel = NEW_PANEL();
  addModule(p, defs.output, 20 + 3 * 270, 20);
  return p;
}

/** give a patch its Main module if it has none (the editor keeps one in the dock, always). Returns whether it added one. */
export function ensureMain(p: Patch, defs: Record<string, ModuleDef>): boolean {
  if (p.modules.some((m) => m.type === 'fm1')) return false;
  addModule(p, defs.fm1, 20, 20).panel = NEW_PANEL();
  return true;
}

/** modules that run once even inside a poly assembly: their inputs sum the parts (big state, or the end of the chain) */
export { STEPS_MAX, STEP_NOTE, STEP_VEL } from './track';

export const SHARED_TYPES = new Set(['delay', 'reverb', 'chorus', 'grain', 'output', 'arp', 'steps', 'drummap']);
/** module types the editor shows but the engines and the FM-1 never run: poly.ts deviceView drops them and their cables */
export const EDITOR_ONLY = new Set(['scope']);

export function nextId(p: Patch): number {
  return p.modules.reduce((m, x) => Math.max(m, x.id), 0) + 1;
}

export function defaultParams(def: ModuleDef): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of def.params) out[p.name] = p.default;
  return out;
}

/** the default matrix: p1 and p2 control the first two parameters, knob n the n-th. A parameter appended to its type later
 * (`since`) never joins it, so a module whose patch has no matrix routes as it did (a Pulse's p2 stays unrouted, not `inf`) */
export function defaultMap(def: ModuleDef): Record<Source, string[]> {
  const ps = def.params.filter((q) => q.since === undefined);
  const at = (i: number): string[] => (ps[i] ? [ps[i].name] : []);
  return { p1: at(0), p2: at(1), k1: at(0), k2: at(1), k3: at(2), k4: at(3) };
}

/** Validate additional side-input destinations. A dedicated input (ParamDef.input) is always linked to its parameter: the
 * `disabledInputs` list of older patches (format 17) is dropped, so such a patch gets its built-in routing back. */
export function fixInputRoutes(m: ModuleInst, def: ModuleDef): void {
  delete (m as { disabledInputs?: unknown }).disabledInputs;
  const routes: Record<string, string[]> = {};
  for (const port of def.inputs) {
    if (port.name === 'p1' || port.name === 'p2') continue;
    const names = m.inputMap?.[port.name];
    if (!Array.isArray(names)) continue;
    const targets = [...new Set(names.filter((name) => def.params.some((pd) => pd.name === name && pd.input !== port.name)))];
    if (targets.length) routes[port.name] = targets;
  }
  if (Object.keys(routes).length) m.inputMap = routes;
  else delete m.inputMap;
}

/** att and map for a module that has parameter inputs, filled in or repaired */
export function fixMatrix(m: ModuleInst, def: ModuleDef): void {
  if (!def.paramInputs) {
    delete m.att;
    delete m.map;
    return;
  }
  const a = Array.isArray(m.att) ? m.att : [1, 1];
  m.att = [0, 1].map((i) => Math.max(-1, Math.min(1, Number.isFinite(Number(a[i])) ? Number(a[i]) : 1))) as [number, number];
  const names = new Set(def.params.map((q) => q.name));
  const dm = defaultMap(def);
  const map = {} as Record<Source, string[]>;
  for (const s of SOURCES) map[s] = Array.isArray(m.map?.[s]) ? m.map![s].filter((n) => names.has(n)) : dm[s];
  m.map = map;
  // macro ranges: only on parameters the pin controls, both ends 0..1
  if (m.range && typeof m.range === 'object') {
    const out: NonNullable<ModuleInst['range']> = {};
    for (const s of ['p1', 'p2'] as const) {
      const r = m.range[s];
      if (!r || typeof r !== 'object') continue;
      for (const name of map[s]) {
        const v = r[name];
        if (!Array.isArray(v) || v.length !== 2 || !v.every((x) => Number.isFinite(Number(x)))) continue;
        (out[s] ??= {})[name] = [Math.min(1, Math.max(0, Number(v[0]))), Math.min(1, Math.max(0, Number(v[1])))];
      }
    }
    if (Object.keys(out).length) m.range = out;
    else delete m.range;
  } else delete m.range;
}

export function addModule(p: Patch, def: ModuleDef, x: number, y: number): ModuleInst {
  const m: ModuleInst = { id: nextId(p), type: def.type, x, y, params: defaultParams(def) };
  fixMatrix(m, def);
  p.modules.push(m);
  return m;
}

export function removeModule(p: Patch, id: number): void {
  p.modules = p.modules.filter((m) => m.id !== id);
  p.cables = p.cables.filter((c) => c.from.module !== id && c.to.module !== id);
  for (const k of SIDE_KEYS) if (p[k]?.module === id) delete p[k];
}

/** Connect an output to an input. Several cables into one input are summed. Returns false if rejected. */
export function connect(p: Patch, defs: Record<string, ModuleDef>, from: Endpoint, to: Endpoint): boolean {
  const mf = p.modules.find((m) => m.id === from.module);
  const mt = p.modules.find((m) => m.id === to.module);
  if (!mf || !mt || mf.id === mt.id) return false;
  if (!defs[mf.type]?.outputs.some((o) => o.name === from.port)) return false;
  if (!defs[mt.type]?.inputs.some((i) => i.name === to.port)) return false;
  if (p.cables.some((c) => sameEnd(c.from, from) && sameEnd(c.to, to))) return false;
  if (!kindsFit(defs, mf.type, from.port, mt.type, to.port)) return false;
  p.cables.push({ from: { ...from }, to: { ...to } });
  return true;
}

/** keys go only into keys inputs and those take only keys; every other kind patches anywhere */
export function kindsFit(defs: Record<string, ModuleDef>, fromType: string, fromPort: string, toType: string, toPort: string): boolean {
  const a = defs[fromType]?.outputs.find((o) => o.name === fromPort)?.kind;
  const b = defs[toType]?.inputs.find((i) => i.name === toPort)?.kind;
  return (a === 'keys') === (b === 'keys');
}

/** the patch's sidebar slider sources (see Patch.slackFrom) */
export const SIDE_KEYS = ['slackFrom', 'zoomFrom'] as const;
export type SideKey = (typeof SIDE_KEYS)[number];

/** whether a sidebar slider's source is an output that exists (removeModule and the loader drop one that does not) */
export function sideSourceOk(p: Patch, key: SideKey, defs: Record<string, ModuleDef>): boolean {
  const e = p[key];
  const m = e && p.modules.find((x) => x.id === e.module);
  return !!m && !!defs[m.type]?.outputs.some((o) => o.name === e!.port);
}

export function sameEnd(a: Endpoint, b: Endpoint): boolean {
  return a.module === b.module && a.port === b.port;
}

export function disconnect(p: Patch, cable: Cable): void {
  p.cables = p.cables.filter((c) => !(sameEnd(c.from, cable.from) && sameEnd(c.to, cable.to)));
}

/**
 * Processing order: every module after the modules that feed it. A cable that closes a loop is
 * a feedback cable and reads the producer's previous block (one block of delay).
 */
export function processingOrder(p: Patch): { order: number[]; feedback: Set<Cable> } {
  const ids = p.modules.map((m) => m.id);
  const state = new Map<number, 0 | 1 | 2>(); // 0 new, 1 on stack, 2 done
  const order: number[] = [];
  const feedback = new Set<Cable>();
  const incoming = new Map<number, Cable[]>();
  for (const c of p.cables) {
    const l = incoming.get(c.to.module) ?? [];
    l.push(c);
    incoming.set(c.to.module, l);
  }
  const visit = (id: number): void => {
    state.set(id, 1);
    for (const c of incoming.get(id) ?? []) {
      const s = state.get(c.from.module) ?? 0;
      if (s === 1) feedback.add(c);
      else if (s === 0) visit(c.from.module);
    }
    state.set(id, 2);
    order.push(id);
  };
  for (const id of ids) if ((state.get(id) ?? 0) === 0) visit(id);
  return { order, feedback };
}

/** Structural check of a patch loaded from JSON. Version 1 patches (one `<param>_cv` input per parameter) are converted, and a `midi` module becomes the FM-1 panel. Throws with a readable message. */
export function validatePatch(raw: unknown, defs: Record<string, ModuleDef>): Patch {
  const p = raw as Omit<Patch, 'version'> & { version: number };
  if (!p || (p.version !== 1 && p.version !== 2) || !Array.isArray(p.modules) || !Array.isArray(p.cables)) throw new Error('not a Matryoshka patch');
  const seen = new Set<number>();
  if (p.arp && typeof p.arp === 'object') {   // the firmware arpeggiator's settings (before #58): its tempo goes to the Main module
    const bpm = Math.round(Number((p.arp as { bpm?: unknown }).bpm));
    const main = p.modules.find((m) => m.type === 'fm1');
    if (main && Number.isFinite(bpm) && main.params?.tempo === undefined) main.params = { ...(main.params ?? {}), tempo: Math.min(300, Math.max(20, bpm)) };
  }
  delete p.arp;
  const knobLabels = { ...((p.modules.find((m) => m?.type === 'fm1')?.panel?.labels ?? {}) as Record<string, unknown>) };
  for (const m of p.modules) {
    if (m.type === 'midi') m.type = 'fm1'; // the MIDI module is gone: the FM-1 panel has the same pitch / gate / vel outputs
    const def = defs[m.type];
    if (!def) throw new Error(`unknown module type "${m.type}"`);
    if (!Number.isInteger(m.id) || seen.has(m.id)) throw new Error(`bad or duplicate module id ${m.id}`);
    seen.add(m.id);
    m.params = { ...defaultParams(def), ...(m.params ?? {}) };
    m.x = Number(m.x) || 0;
    m.y = Number(m.y) || 0;
    if (p.version === 1) {
      delete m.att;
      delete m.map;
    }
    if (m.type === 'fm1') {
      const panel = fixPanel(m.panel);
      if (panel) m.panel = panel;
      else delete m.panel;
      const seq = fixSeq(m.seq);
      if (seq) m.seq = seq;
      else delete m.seq;
    } else {
      delete m.panel;
      delete m.seq;
    }
    fixTrack(m);
    if (m.bypass && m.type !== 'fm1' && m.type !== 'output') m.bypass = true;
    else delete m.bypass;
    if (m.paramsB && typeof m.paramsB === 'object' && m.type !== 'fm1') {
      const out: Record<string, number> = {};
      for (const pd of def.params) out[pd.name] = Number.isFinite(Number(m.paramsB[pd.name])) ? Number(m.paramsB[pd.name]) : m.params[pd.name];
      m.paramsB = out;
    } else delete m.paramsB;
    fixMatrix(m, def);
    fixInputRoutes(m, def);
  }
  if (p.version === 1) {
    // a cable into `<param>_cv` becomes a cable into p1 (first such parameter of the module) or p2 (second)
    const used = new Map<number, string[]>();
    for (const c of p.cables) {
      const mt = p.modules.find((m) => m.id === c.to?.module);
      const pm = /^(.*)_cv$/.exec(c.to?.port ?? '');
      if (!mt || !pm || !defs[mt.type].params.some((q) => q.name === pm[1])) continue;
      const list = used.get(mt.id) ?? [];
      if (!list.includes(pm[1])) list.push(pm[1]);
      if (list.length > 2) throw new Error(`${mt.type} uses more than two parameter inputs: this old patch cannot be converted`);
      used.set(mt.id, list);
      const pin = list.indexOf(pm[1]) === 0 ? 'p1' : 'p2';
      mt.map![pin] = [pm[1]];
      c.to.port = pin;
    }
  }
  (p as { version: number }).version = 2;
  migrateKnobs(p as Patch, defs, knobLabels); // Main's knob outputs are gone: cables from them come from a Macros assembly
  migrateVoicing(p as Patch, defs);
  migratePatchParts(p as Patch, defs); // Part modules (before Voice allocators) become allocators
  // the SEQ and REC buttons belong to the device since #83 (the step page, live recording): cables from them go; so do
  // cables from a Steps module's acc output (#133: an accent is full velocity now)
  // each module by id, the first of an id as find() would give it (looked up per cable)
  const byId = new Map<unknown, (typeof p.modules)[number]>();
  for (const m of p.modules) if (!byId.has(m.id)) byId.set(m.id, m);
  p.cables = p.cables.filter((c) => {
    const t = byId.get(c.from?.module)?.type;
    return !(t === 'fm1' && (c.from?.port === 'seq' || c.from?.port === 'rec')) && !(t === 'steps' && c.from?.port === 'acc');
  });
  for (const c of p.cables) {
    const mf = byId.get(c.from?.module);
    if (mf?.type === 'filter' && c.from?.port === 'lp') c.from.port = 'lp12'; // the filter's 12 dB output used to be called lp
    const mt = byId.get(c.to?.module);
    if (mt?.type === 'lfo' && c.to?.port === 'sync') c.to.port = 'reset'; // the LFO's restart input used to be called sync (its tempo-sync toggle is `sync` now)
    if (!mf || !mt) throw new Error('cable to a missing module');
    if (!defs[mf.type].outputs.some((o) => o.name === c.from.port)) throw new Error(`no output "${c.from.port}" on ${mf.type}`);
    if (!defs[mt.type].inputs.some((i) => i.name === c.to.port)) throw new Error(`no input "${c.to.port}" on ${mt.type}`);
  }
  p.cables = p.cables.filter((c) => kindsFit(defs, byId.get(c.from.module)!.type, c.from.port, byId.get(c.to.module)!.type, c.to.port));
  {   // a Toggle's target that is gone: the button keeps its kind, without a target
    const main = p.modules.find((m) => m.type === 'fm1');
    const t = main?.panel?.targets;
    if (main?.panel && t) {
      for (const [b, x] of Object.entries(t))
        if ('module' in x ? !p.modules.some((m) => m.id === x.module) : !(p.assemblies ?? []).some((a) => a?.id === x.asm)) delete t[b];
      if (!Object.keys(t).length) delete main.panel.targets;
    }
  }
  p.name = String(p.name ?? 'patch');
  if (typeof p.notes !== 'string' || !p.notes.trim()) delete p.notes;
  else p.notes = p.notes.slice(0, NOTES_MAX);
  if (!hasMorph(p as Patch) || typeof p.morphName !== 'string') delete p.morphName;
  for (const k of SIDE_KEYS) if (!sideSourceOk(p as Patch, k, defs)) delete p[k];
  if (!Number.isInteger(p.octave) || p.octave === 0 || p.octave! < OCTAVE_MIN || p.octave! > OCTAVE_MAX) delete p.octave;
  const v = p.view as { zoom?: unknown; x?: unknown; y?: unknown } | undefined;
  if (v && typeof v === 'object' && [v.zoom, v.x, v.y].every((n) => typeof n === 'number' && Number.isFinite(n)) && (v.zoom as number) > 0)
    p.view = { zoom: v.zoom as number, x: Math.max(0, v.x as number), y: Math.max(0, v.y as number) };
  else delete p.view;
  return p as Patch;
}
