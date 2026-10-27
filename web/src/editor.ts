// SPDX-License-Identifier: GPL-3.0-only
// Patch editor: module cards on a canvas, SVG cables, drag-to-connect, a selection, assemblies and undo.
import { resizeHandle } from './resize-handle';
import { parseValue } from './value-input';
import { isTextEntry } from './input';
import { lockOf } from './relevance';
import { isPile, tidy, tidyAssembly } from './tidy';
import { buttonLabel, DEFS, drumRowName, FIXED_DOES, PANEL_BUTTONS, rowRange } from './modules';
import { FIXED_BUTTONS } from './patch';
import { FM1_BUTTON_ROWS, buttonKind, jackColumn, tracePath } from './dock-buttons';
import { arpLitInverted, buttonLight, kindOf, pageList, setPages, switches, toggleEngaged, toggleTargets, type ButtonKind } from './buttons';
import { buttonEditor } from './button-editor';
import { arpChoices, arpFree, type ArpChoice } from './arp-button';
import { showUndo } from './toast';
import { positionPopover } from './popover';
import { parameterInputs, connectParameter, setInputRoute } from './parameter-routing';
import { parameterMenu } from './parameter-menu';
import { sliderJack } from './slider-jack';
import { devicesOf, findRow, fixFocus, groupStarts, moduleRows, NAME_MAX, pageLabel, pageTitle, PAGE_ROWS, type Device, type Page, type PageRow } from './pages';
import { cableRole } from './cable-role';
import { addBreak, fm1Name, layoutOf, moveRows, moveSection, pagesOf, removeBreak, removeHeading, removeRows, renameHeading, rowKey, setLayout, type KnobOf, type Layout, type RowSpot, type Sec } from './arrange';
import type { ParameterValues } from './engine';
import { deviceBudget, DEVICE } from './patchbin';
import { choiceName, formatValue, longName, moduleName, moduleTag } from './labels';
import { picker } from './picker';
import { selector } from './selector';
import { ALLOC, copiesOf, makeRoom, polyGroups, polyOfModule, setPoly, trackDrumMap, trackTargets } from './poly';
import { dragControl } from './deck';
import { isPin, PinsInUse, removeRoute } from './parameter-routing';
import {
  addModule,
  fromUnit,
  topOf,
  toUnit,
  connect,
  disconnect,
  removeModule,
  sameEnd,
  type Cable,
  type Endpoint,
  type SideKey,
  type ModuleDef,
  type ModuleInst,
  type Patch,
  type PortDef,
  type ParamDef,
  flawOf,
  isFlawless,
  type PolyCards,
  sameStructure,
  setMorphTarget,
  clearMorph,
  hasMorph,
  ensureMain,
  EDITOR_ONLY,
  rowDef,
  PAGE_LIST_MAX,
  panelLabel,
  trackLabel,
  trackName,
  fixTrack,
  TRACK_NAME_MAX,
  DRUM_ROWS,
} from './patch';
import { patternStrip, type PatternStrip } from './pattern-strip';
import { SongView } from './song';
import type { PatternView } from './engine';
import { fixNotes, fixPatterns, fixSeq, overdub, PATTERNS_MAX, patternOf, SONGS_MAX, type Pattern, type SeqState, type SongEntry, type StepNote } from './track';
import { defIsEngine, instIsEngine, wireEngine, wiredText, type Wired } from './engines';
import { applyPreset, deletePreset, matchesPreset, nextPresetName, presetsOf, sameName, renamePreset, stepPreset, storePreset } from './device-presets';
import { structureOf } from './structure';
import { armable, keepArmed, keysTargets, mutedCables, type DeviceKey } from './arm';
import { PianoRoll } from './roll';
import { stepGrid, stopEntry, type StepGrid } from './step-grid';
import { FlawPanel } from './flaws-panel';
import { clipText, copyItems, pasteClip, type Clip } from './clipboard';
import { GUTTER_ROOM, ribbons, type RibbonCable, type RibbonFrame } from './ribbons';
import { pinchStart, pinchStep, type Pinch } from './touch';
import type { ScreenSpec } from './scope-view';
import type { EnvSpec } from './env-view';
import { EXCLUDED_TYPES,
  addChild,
  addMember,
  allModules,
  assemblyById,
  assembliesOf,
  assemblyOf,
  childrenOf,
  deleteAssembly,
  demote,
  depthOf,
  descendants,
  exposePort,
  findRef,
  fixAssemblies,
  freeSpot,
  freeSpotNear,
  hiddenAssemblies,
  hiddenModules,
  hidePort,
  insertAssembly,
  isExposed,
  isPromoted,
  makeAssembly,
  mergePorts,
  moveAssembly,
  overlapping,
  parentOf,
  promote,
  reconcileAll,
  removeChild,
  removeMember,
  targetsOf,
  tileMembers,
  toDef,
  ungroup,
  unmergePort,
  type AssemblyDef,
  type AssemblyInst,
  type PortRef,
  type Rect,
  type Target, type ParamRef, GRID, bypassAssembly, paramColumns, moveRef, setColumnBreak, setHeading, setSpan, spanPlan, type SpanBlock,
  keepParams, pickRows, pickState, keyRange, type PickRow,
  mergeRows, rowNames, rowOf, sameRange, setRowNames, splitRow, syncTied, tiedTo, ties, type Ties, ROW_NAMES_MAX, ROW_NAME_MAX,
  copyRuns, copyStarts, setCopies, COPY_ROWS_MAX, COPIES_MAX } from './assembly';

const SVGNS = 'http://www.w3.org/2000/svg';
/** a Page button held this long shows its list's first page while it is down (panel.c PAGE_HOLD_MS) */
const PAGE_HOLD_MS = 400;

/** a dock button's kind mark (board E): Toggle a power sign, Gate a pulse */
function kindMark(kind: ButtonKind | 'main'): SVGSVGElement {
  const svg = document.createElementNS(SVGNS, 'svg') as SVGSVGElement;
  svg.setAttribute('class', `pb-mark ${kind}`);
  svg.setAttribute('viewBox', '0 0 12 12');
  svg.setAttribute('aria-hidden', 'true');
  const path = (d: string): void => { const e = document.createElementNS(SVGNS, 'path'); e.setAttribute('d', d); svg.append(e); };
  if (kind === 'main') { path('M6 1.5a4.5 4.5 0 1 1 0 9a4.5 4.5 0 1 1 0-9z'); path('M6 4.5a1.5 1.5 0 1 1 0 3a1.5 1.5 0 1 1 0-3z'); }
  else if (kind === 'bypass') { path('M6 1.5v4'); path('M3.3 3.6a4 4 0 1 0 5.4 0'); }
  else if (kind === 'page') { path('M3 1.5h6a1.5 1.5 0 0 1 1.5 1.5v6a1.5 1.5 0 0 1-1.5 1.5h-6a1.5 1.5 0 0 1-1.5-1.5v-6a1.5 1.5 0 0 1 1.5-1.5z'); path('M4 4.5h4M4 7.5h4'); }
  else path('M1 9h3V3h4v6h3');
  return svg;
}
const HISTORY = 40;
/** a logarithmic slider's value rounded to the parameter's step (a glide time to the ms, a cutoff to the Hz), not to a whole number */
function snapTo(pd: ParamDef, v: number): number {
  const step = pd.step ?? 0;
  const x = step > 0 ? Math.round(v / step) * step : v;
  return Math.min(pd.max, Math.max(pd.min, Number(x.toFixed(6))));
}

/** the frame around an expanded assembly: padding around its cards and the height of its header */
const FRAME_PAD = 12;
/** left / right: room inside the border for the inner half of the ribbons (ribbons.ts) */
const FRAME_PAD_X = 32;
const FRAME_HEAD = 30;
/** a poly assembly's frame: the settings strip under the header, and the width it needs */

export interface EditorEvents {
  /** structure changed (modules or cables): the engine needs the whole patch */
  onStructure(p: Patch): void;
  /** another patch was opened (setPatch), before its onStructure */
  onLoad?(p: Patch): void;
  /** a knob moved: cheap update */
  onParam(id: number, name: string, value: number): void;
  /** an attenuverter of a parameter input moved (index 0 = p1, 1 = p2) */
  onAtt(id: number, index: number, value: number): void;
  /** a module's bypass switch (the structure is unchanged: the engine keeps its state) */
  onBypass(id: number, on: boolean): void;
  /** a Steps module's notes changed (#133, ModuleInst.notes), of pattern `pat` (0-based, #375), a Steps module muted (not saved) */
  onTrack?(id: number, notes: StepNote[] | undefined, pat: number): void;
  /** the patch's pattern (0-based) or the song that plays (0 none) changed (#375: saved with the patch, no undo step) */
  onPattern?(pattern: number, song: number): void;
  /** song k's entries changed (0-based k) */
  onSong?(k: number, entries: SongEntry[]): void;
  onMute?(id: number, on: boolean): void;
  /** the armed Steps track changed (#134; null: none) and what it plays (poly.ts trackTargets), or its cables changed */
  /** the armed set changed (#190): the armed devices, and what each plays by name (a Steps track: what it drives) */
  onArm?(armed: DeviceKey[], plays: string[]): void;
  /** REC on the armed track went on or off (#135) */
  onRec?(id: number, on: boolean): void;
  /** a note into a Steps track's instrument, to hear it (the roll's keys and notes, #136; vel 0..127, 0: let go) */
  onThru?(id: number, note: number, vel: number): void;
  /** a macro range of p1 / p2 (index 0 / 1) on a parameter changed or was removed (null) */
  onRange(id: number, index: number, name: string, range: [number, number] | null): void;
  /** the transport (the Play switch: the Main module's run output and clock; editor state, not saved) */
  onTransport(on: boolean): void;
  /** a patch button of the Main module (PANEL_BUTTONS index) held / let go or switched */
  onButton?(i: number, on: boolean): void;
  /** the device page Main's knobs edit changed in the editor (a device key and page of devicesOf): the FM-1 can follow */
  onFocus?(device: string, page: number): void;
  /** cards were moved: positions changed, nothing the engine needs */
  onLayout(p: Patch): void;
  /** the displays drawn this time (after every rebuild): Scope screens with what is cabled into each input, envelope shapes */
  onScreens?(screens: ScreenSpec[], envs: EnvSpec[]): void;
  /** a message for the status line */
  onError(msg: string): void;
  /** "save" on an assembly: put this definition into the library */
  onSaveAssembly(def: AssemblyDef): void;
  /** undo or redo happened (the tutorial counts them) */
  onHistory?(kind: 'undo' | 'redo'): void;
  /** the patches the morph picker on the Main card offers as the B side (those of the same structure are listed) */
  morphCandidates?(like: Patch): { name: string; patch: Patch }[];
}

/** an SVG path through a cubic Bézier's four points */
/** how a cable leaves a jack: sideways, up (a docked jack) or down (a jack under a card's bottom edge) */
type CableEnd = 'side' | 'up' | 'down';
/** the straight run of a cable out of its jack at full slack, px */
const CABLE_STUB = 20;
/** the zoom's range (the wheel, pinch, fit and the sidebar's zoom slider) */
export const ZOOM_MIN = 0.3;
export const ZOOM_MAX = 2;
/** a chain of cubic Béziers: a start point, then three points per segment */
const pathOf = ([a, ...rest]: { x: number; y: number }[]): string => {
  let d = `M${a.x},${a.y}`;
  for (let i = 0; i + 2 < rest.length; i += 3) d += ` C${rest[i].x},${rest[i].y} ${rest[i + 1].x},${rest[i + 1].y} ${rest[i + 2].x},${rest[i + 2].y}`;
  return d;
};

/** how far (px) beyond the jack's sides the strip a docked cable is drawn in over the panel reaches: none, so a cable
 * that bends away (to a module below the canvas's view) shows only its straight stub above the jack */
const CLIP_HALF = 0;
/** presses closer than this belong to one gesture (a double-click's two presses) */
const TYPE_GAP_MS = 400;
/** a gesture made without a pointer (arrow keys, the wheel) ends this long after its last change */
const GESTURE_IDLE_MS = 600;
type Pt = { x: number; y: number };
/** the footprint of a new card for the free-spot search: a grid cell less its gutters */
const CARD_W = 300;
const CARD_H = 540;
/** the host's elements drawn over the canvas, which a new card is kept clear of (#175) */
const OVER_CANVAS = '.view-switch, .fm1-connect, .help-btn, #diff, .tutorial, .flaw-panel';
/** how far each paste of the same clip lands from the last (down and right) */
const PASTE_STEP = 40;
/** a collapsed assembly card's footprint width: a grid cell per column (`.module.assembly.cols` in style.css) */
const cardWidth = (params: ParamRef[]): number => {
  const n = paramColumns(params).length;
  return n > 1 ? n * GRID.x - 20 : CARD_W;
};
/** jacks on each side edge of a card; the rest hang off its bottom edge */
const EDGE_JACKS = 4;
/** an input for a card's edge layout: its row element and which port it is (a parameter's dedicated input joins its row) */
type EdgePort = { el: HTMLElement; module: number; port: string };
/** a parameter for a card's edge layout: its row, its dedicated input, a column break before it, rows above it (a heading) */
/** `gap`: a new group (FM-1 page) starts at this row within its column, drawn as a divider above it */
type EdgeParam = { el: HTMLElement; input?: Target; col?: boolean; above?: HTMLElement[]; below?: HTMLElement[]; span?: number; gap?: boolean };
/** a section of the card being arranged, as drawn: its heading, its empty box (no rows), its pages' rows and their elements */
type ArrSec = { sec: Sec; col: number; index: number; head: HTMLElement | null; empty: HTMLElement | null; pages: { rows: ParamRef[]; drawn: ParamRef[]; els: HTMLElement[] }[] };
/** Arrange mode's state for one rebuild: the card's layout tree (arrange.ts), the sections as drawn, the overlay's line */
type ArrangeCtx = { a: AssemblyInst; layout: Layout; knob: KnobOf; body: HTMLElement; secs: ArrSec[]; transient: Sec | null; line: HTMLElement | null };
/** a place an arrange drag can land: a line from x1 to x2 at y (client coordinates), and what a drop there does */
type ArrSpot = { x1: number; x2: number; y: number; act: () => void };
type Box = { left: number; top: number; right: number; bottom: number };
/** the width of a page outline's handle strip, left of its rows (px) */
const ARR_HANDLE = 14;
/** an entry of a card's menu: `key` is the shortcut shown at the right, `rule` a line above it */
type MenuItem = { text: string; run: () => void; key?: string; danger?: boolean; rule?: boolean };
/** a drop is judged by the card's header (where it is held), this far below its top */
const HEAD_Y = 15;
/** a touch held this long without moving is a long press */
const LONG_PRESS_MS = 500;

/** Main's jack captions on the dock that are shortened */
const DOCK_SHORT: Record<string, string> = { vel: 'vel', at: 'aft' };

export class Editor {
  patch: Patch;
  /** the selected modules (shift-click or a rubber band); "Make assembly" groups them, dragging one moves all */
  readonly selected = new Set<number>();
  /** the selected assemblies (collapsed cards and expanded frames): they move, duplicate and delete with the modules */
  readonly selectedAsm = new Set<number>();
  /** assemblies expanded in this session: the first expansion tidies the inside (#37) */
  private expandedOnce = new Set<number>();
  /** how far cables sag, 0 (taut, the default) .. 1: the sidebar's setting */
  slack = 0;
  /** the sidebar sliders whose thumbs are jacks (cable slack, zoom): Patch.slackFrom / zoomFrom; set by the host */
  readonly sideThumbs = new Map<SideKey, HTMLElement>();
  /** the cables from their sources to those thumbs: in their own layer over the whole window, so they cross the sidebar */
  private sideLayer: SVGSVGElement | null = null;
  /** the patch's slack source (Patch.slackFrom) as it plays: added to `slack` */
  private slackMod = 0;
  private slackFrame = 0;
  /** the sag the cables are drawn with: the setting plus the source's signal, 0 .. 1.5 */
  private get sway(): number {
    return Math.min(1.5, Math.max(0, this.slack + this.slackMod));
  }
  private modulesEl: HTMLElement;
  private svg: SVGSVGElement;
  /** the hovered cable's glow, over the cards (index.html #cable-glow) */
  private glowLayer: SVGSVGElement | null = null;
  private preview: SVGSVGElement;
  private world: HTMLElement;
  private space: HTMLElement;
  private ports = new Map<string, HTMLElement>();
  private cards = new Map<number, HTMLElement>();
  private frames = new Map<number, HTMLElement>();
  /** the collapsed assembly cards on the canvas */
  private containers = new Map<number, HTMLElement>();
  private drag: { path: SVGPathElement; cancel: () => void } | null = null;
  private sliderPorts: { m: ModuleInst; pd: ParamDef; jack: HTMLElement; ticks: (t: { knob: string; unit: number }[]) => void }[] = [];
  private cablePaths: { path: SVGPathElement; from: HTMLElement; to: HTMLElement; origin: HTMLElement; cable?: Cable }[] = [];
  private stack: string[] = [];
  private routingOpen = new Set<string>();
/** undo steps: the patch snapshot and the A / B side it belongs to (a flip is a step; undoing it goes back to that side) */
  private history: { s: string; side: 'A' | 'B' }[] = [];
  private future: { s: string; side: 'A' | 'B' }[] = [];
  private parameterDisplays: { id: number; update: (values: Record<string, number> | null) => void; el?: HTMLElement }[] = [];
  /** the patch's devices (pages.ts) and the page Main's knobs K1..K4 edit: the dock's DEVICE / PAGE pickers or a click on a
   * row choose it, the FM-1 too with Live on */
  devices: Device[] = [];
  focus: { device: string; page: number } | null = null;
  /** the dock's knob column (re-filled when the focus moves) and its dials, K1..K4 */
  private focusCol: HTMLElement | null = null;
  /** the knobs' binding jacks on the dock's top edge (the dotted wires to the focused rows start there) */
  private knobJacks: HTMLElement[] = [];
  /** the dock's button column, whose SVG holds the traces from the patch buttons to their jacks */
  private buttonCol: HTMLElement | null = null;
  private dials: HTMLElement[] = [];
  /** the dotted lines from the dials to the rows they turn, over everything */
  private bindLayer: SVGSVGElement | null = null;

  /** Display only: never write telemetry into the patch, undo history, or parameter callbacks. */
  showParameterValues(values: ParameterValues | null): void {
    if (values && (this.drag || this.armed)) return; // Keep drop targets still while patching.
    const byId = new Map(values?.map((m) => [m.id, m.params]));
    for (const display of this.parameterDisplays) display.update(byId.get(display.id) ?? null);
    this.positionCables();
  }

  /**
   * `dock`: where the Main module lives (the panel above the keyboard) instead of a card. Every patch has one Main there;
   * it cannot be removed. Cables from its jacks run off the bottom of the canvas to the panel.
   */
  constructor(private canvas: HTMLElement, patch: Patch, private ev: EditorEvents, private dock: HTMLElement | null = null) {
    this.patch = patch;
    if (dock) ensureMain(this.patch, DEFS);
    this.modulesEl = canvas.querySelector('#modules')!;
    this.svg = canvas.querySelector('#cables')! as unknown as SVGSVGElement;
    this.preview = canvas.querySelector('#patch-preview')! as unknown as SVGSVGElement;
    this.glowLayer = canvas.querySelector('#cable-glow') as unknown as SVGSVGElement | null;
    this.world = canvas.querySelector('#patch-world')!;
    this.space = canvas.querySelector('#canvas-space')!;
    this.report(fixAssemblies(this.patch, DEFS));
    new ResizeObserver(() => { this.sizeCanvas(); this.positionCables(); }).observe(canvas);
    if (dock) {
      // the docked jacks stay put while the canvas scrolls under them
      canvas.addEventListener('scroll', () => this.positionCables(), { passive: true });
      dock.addEventListener('scroll', () => this.positionCables(), { passive: true, capture: true });
      new ResizeObserver(() => this.positionCables()).observe(dock);
    }
    document.fonts.addEventListener('loadingdone', () => {
      this.layoutFrames(); this.sizeCanvas(); this.positionCables();
    });
    canvas.addEventListener('pointerdown', (e) => this.rubberBand(e));
    canvas.addEventListener('pointermove', (e) => { this.hover = e.pointerType === 'mouse' ? { x: e.clientX, y: e.clientY } : null; });
    // the mouse leaving the canvas forgets it, except for a dialog opened over it (the palette, by Ctrl/Cmd+K) or a click elsewhere
    canvas.addEventListener('pointerleave', (e) => {
      const to = e.relatedTarget instanceof Element ? e.relatedTarget : null;
      if (!(to ? to.closest('dialog[open]') : document.querySelector('dialog[open]'))) this.hover = null;
    });
    window.addEventListener('pointerdown', (e) => { if (!(e.target instanceof Node && canvas.contains(e.target))) this.hover = null; }, true);
    this.touchGestures();
    const raise = (event: Event): void => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const card = target.closest<HTMLElement>('.module, .frame');
      if (card) this.raiseCard(card);
    };
    canvas.addEventListener('pointerdown', raise, true);
    window.addEventListener('pointerdown', () => { this.pointerHeld = true; }, true);
    const release = (): void => {
      this.pointerHeld = false;
      if (this.gesture !== null) window.setTimeout(() => { if (!this.pointerHeld) this.endGesture(); }); // after the control's own pointerup
    };
    for (const type of ['pointerup', 'pointercancel'] as const) window.addEventListener(type, release, true);
    window.addEventListener('blur', release);
    canvas.addEventListener('focusin', raise);
    window.addEventListener('keydown', (e) => {
      const k = e.key.toLowerCase();
      if (!(e.metaKey || e.ctrlKey) || (k !== 'z' && !(k === 'y' && e.ctrlKey && !e.metaKey))) return;
      if (!this.canvas.checkVisibility() || document.querySelector('dialog[open], [popover]:popover-open')) return;
      const t = e.target as HTMLElement | null;
      if (t && isTextEntry(t)) return; // a text field's own undo
      e.preventDefault();
      if (e.shiftKey || k === 'y') this.redo();
      else this.undo();
    });
    this.rebuild();
    canvas.addEventListener('scroll', () => this.queueView(), { passive: true });
    this.restoreView();
  }

  setPatch(p: Patch): void {
    stopEntry(); // (step entry, the armed track and the roll belong to the patch they started in)
    this.armTrack(null);
    this.closeRoll();
    this.patch = p;
    if (this.dock) ensureMain(this.patch, DEFS);
    this.report(fixAssemblies(this.patch, DEFS));
    this.history = [];
    this.future = [];
    this.dropGesture();
    this.snapshots.A = this.snapshots.B = null;
    this.side = 'A';
    this.routingOpen.clear();
    this.stack = [];
    this.selected.clear();
    this.selectedAsm.clear();
    this.expandedOnce.clear();
    this.rebuild();
    this.untangle();
    this.restoreView();
    this.ev.onLoad?.(p);
    this.ev.onStructure(p);
  }

  // ---- the patch remembers where it was looked at (Patch.view): the user's zoom and the canvas's scroll, in layout pixels
  /** the user's zoom: a source on the zoom slider (a live zoom) moves `zoom` but is not remembered */
  private userZoom = 1;
  private viewTimer = 0;
  /** set while a patch's view is put back: the zoom that causes is not the user's gesture (the tutorial's zoom step) */
  restoring = false;

  /** a patch opens where it was last looked at; one without a view keeps the current one (and gets it on the next move) */
  private restoreView(): void {
    const v = this.patch.view;
    if (!v) return;
    clearTimeout(this.viewTimer);
    this.restoring = true;
    try {
      this.setZoom(v.zoom);
    } finally {
      this.restoring = false;
    }
    this.canvas.scrollTo(v.x * this.zoom, v.y * this.zoom);
  }

  private queueView(): void {
    clearTimeout(this.viewTimer);
    this.viewTimer = window.setTimeout(() => this.stampView(), 300);
  }

  /** write the current view into the patch, saved like a layout change (no undo step, no engine reload) */
  private stampView(): void {
    const c = this.canvas;
    const v = { zoom: this.userZoom, x: Math.round(c.scrollLeft / this.zoom), y: Math.round(c.scrollTop / this.zoom) };
    const o = this.patch.view;
    if (o && o.zoom === v.zoom && o.x === v.x && o.y === v.y) return;
    this.patch.view = v;
    this.ev.onLayout(this.patch);
  }

  private report(msgs: string[]): void {
    if (msgs.length) this.ev.onError(msgs.join('; '));
  }

  /** the mouse over the canvas (client px), for placing a new card near it; null when it is elsewhere */
  private hover: Pt | null = null;

  /** the canvas's view in patch layout pixels (what is scrolled into sight, at the zoom) */
  private viewRect(): Rect {
    const c = this.canvas, z = this.zoom;
    return { x: c.scrollLeft / z, y: c.scrollTop / z, w: c.clientWidth / z, h: c.clientHeight / z };
  }

  /** the host's controls and panels drawn over the canvas (the view switch, ?, the diff, the tutorial card), in patch layout px */
  private overlays(): Rect[] {
    const w = this.world.getBoundingClientRect(), c = this.canvas.getBoundingClientRect();
    const out: Rect[] = [];
    for (const el of document.querySelectorAll<HTMLElement>(OVER_CANVAS)) {
      const r = el.getBoundingClientRect();
      const x0 = Math.max(r.left, c.left), x1 = Math.min(r.right, c.right), y0 = Math.max(r.top, c.top), y1 = Math.min(r.bottom, c.bottom);
      if (x1 <= x0 || y1 <= y0) continue; // hidden, or beside the canvas
      out.push({ x: (x0 - w.left) / this.zoom, y: (y0 - w.top) / this.zoom, w: (x1 - x0) / this.zoom, h: (y1 - y0) / this.zoom });
    }
    return out;
  }

  /**
   * Where the next card goes (#175); `w` = its width. In view: the free grid cell nearest the mouse when it is over the
   * canvas, else nearest the view's centre, clear of every visible card, container, frame and the panels over the canvas
   * (freeSpotNear); with none free in view, the nearest one outside (`scrollToCard` then brings it in). A patch with only Main
   * and the Output (a new patch, the engine start screen) keeps the first free cell from the top left, beside the Output.
   */
  private slot(w = CARD_W): Pt {
    const rect = (el: HTMLElement): Rect => ({ x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight });
    const occupied = [...this.cards.values(), ...this.containers.values(), ...this.frames.values()].map(rect);
    // before the first layout the elements have no size: fall back to the model's positions
    if (occupied.some((r) => !r.w)) {
      const hidden = hiddenModules(this.patch);
      const hiddenAsm = hiddenAssemblies(this.patch);
      occupied.length = 0;
      for (const m of this.patch.modules) if (!hidden.has(m.id)) occupied.push({ x: m.x, y: m.y, w: CARD_W, h: CARD_H });
      for (const a of assembliesOf(this.patch)) if (!a.open && !hiddenAsm.has(a.id)) occupied.push({ x: a.x, y: a.y, w: cardWidth(a.params), h: CARD_H });
    }
    const empty = !assembliesOf(this.patch).length && this.patch.modules.every((m) => EXCLUDED_TYPES.has(m.type));
    const view = this.viewRect();
    if (empty || !view.w || !view.h) return freeSpot(occupied, w, CARD_H);
    const z = this.zoom, wr = this.world.getBoundingClientRect();
    const origin = this.hover ? { x: (this.hover.x - wr.left) / z, y: (this.hover.y - wr.top) / z } : { x: view.x + view.w / 2, y: view.y + view.h / 2 };
    return freeSpotNear([...occupied, ...this.overlays()], w, CARD_H, view, origin);
  }

  /** scroll just enough to show a new card (its element, else `fallback`), its top left first when it is larger than the view */
  private scrollToCard(el: HTMLElement | undefined, fallback: Rect): void {
    const r = el?.offsetWidth ? { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight } : fallback;
    const c = this.canvas, z = this.zoom, PAD = 12;
    const axis = (pos: number, len: number, scroll: number, size: number): number => {
      const a = (pos - PAD) * z, b = (pos + len + PAD) * z;
      if (b - a > size || a < scroll) return a;
      return b > scroll + size ? b - size : scroll;
    };
    const x = axis(r.x, r.w, c.scrollLeft, c.clientWidth), y = axis(r.y, r.h, c.scrollTop, c.clientHeight);
    if (x !== c.scrollLeft || y !== c.scrollTop) c.scrollTo(Math.max(0, x), Math.max(0, y));
  }

  add(type: string): void {
    const at = this.slot();
    let id = -1;
    if (this.change(() => {
      id = addModule(this.patch, DEFS[type], at.x, at.y).id;
    })) this.scrollToCard(this.cards.get(id), { ...at, w: CARD_W, h: CARD_H });
  }

  /** put a saved assembly into the patch; an engine comes wired to Main's keys and, while nothing feeds it, the Output (one undo step) */
  insert(def: AssemblyDef): void {
    const w = cardWidth(def.params);
    const at = this.slot(w);
    let wired: Wired | null = null;
    let id = -1;
    if (!this.change(() => {
      const a = insertAssembly(this.patch, DEFS, def, at.x, at.y);
      id = a.id;
      if (defIsEngine(def)) wired = wireEngine(this.patch, a);
    })) return;
    this.scrollToCard(this.containers.get(id) ?? this.frames.get(id), { ...at, w, h: CARD_H });
    this.ev.onError(wired ? wiredText(def.name, wired) : `"${def.name}" inserted. Knob assignments (K1..K4) are not kept: tick them in the patch.`);
  }

  /** group the selected modules into a new assembly */
  makeAssembly(): void {
    const set = this.dragSet();
    if (!set.mods.length && !set.asms.length) return this.ev.onError('select the modules first: shift-click them, or drag a box on the canvas');
    // a patch's own modules never go into a building block: they stay outside, the rest is grouped
    const ids = set.mods.filter((m) => !EXCLUDED_TYPES.has(m.type)).map((m) => m.id);
    if (!ids.length && !set.asms.length) return this.ev.onError('the Main panel and the Output stay outside an assembly: select other modules');
    const name = window.prompt('Name of the assembly', 'assembly')?.trim();
    if (!name) return;
    const kept = ids.length < set.mods.length;
    // selected assemblies become children of the new one (it may hold assemblies only)
    if (this.change(() => makeAssembly(this.patch, ids, name, set.asms.map((a) => a.id)))) {
      this.selected.clear();
      this.selectedAsm.clear();
      if (kept) this.ev.onError('Main and Output stay outside');
    }
  }

  // ---- undo
  // Snapshots of the patch. A structural change (`change`) is one step; an edit by a control (a slider drag, a switch, a
  // card drag, a run of arrow keys) is a gesture: `touch` before its first change keeps the patch as it was, and the
  // gesture becomes one step when the pointer is let go, or GESTURE_IDLE_MS after its last change without a pointer.

  /** the patch as an undo snapshot: without the view (zoom, scroll), the keyboard's octave and the name, which undo leaves alone */
  private snap(): string {
    const { view: _view, octave: _octave, name: _name, ...rest } = this.patch;
    return JSON.stringify(rest);
  }

  /** a snapshot as the patch, keeping the current view and octave */
  private revive(s: string): Patch {
    const p = JSON.parse(s) as Patch;
    p.name = this.patch.name;
    if (this.patch.view) p.view = this.patch.view;
    if (this.patch.octave !== undefined) p.octave = this.patch.octave;
    return p;
  }

  /** one undo step from `before` (a snap) to now, if anything changed; inside an open gesture the gesture's step covers it */
  private commit(before: string, side = this.side): boolean {
    if (before === this.snap()) return false;
    if (this.gesture !== null) return true;
    this.history.push({ s: before, side });
    if (this.history.length > HISTORY) this.history.shift();
    this.future = [];
    return true;
  }

  /** the patch before a discrete change (a snap): a gesture of keys or the wheel still open ends first, so the two stay
   * separate steps; a pointer gesture stays open (a drag's drop into a frame is part of the drag) */
  private mark(): string {
    if (this.gesture !== null && !this.gesturePointer) this.endGesture();
    return this.snap();
  }

  /** the patch before the open gesture's first change (null: none open) */
  private gesture: string | null = null;
  /** the open gesture began with a pointer down (it ends at the release, not on a timer) */
  private gesturePointer = false;
  private gestureTimer = 0;
  /** a pointer is down somewhere: a gesture it makes ends when it is let go */
  private pointerHeld = false;

  /** a control is about to change the patch: open a gesture, or keep the open one going */
  touch(): void {
    if (this.gesture !== null && !this.gesturePointer && this.pointerHeld) this.endGesture(); // keys, then a drag: two steps
    if (this.gesture === null) {
      this.gesture = this.snap();
      this.gesturePointer = this.pointerHeld;
    }
    window.clearTimeout(this.gestureTimer);
    if (!this.pointerHeld) this.gestureTimer = window.setTimeout(() => this.endGesture(), GESTURE_IDLE_MS);
  }

  /** close the open gesture: one undo step if it changed anything */
  endGesture(): void {
    window.clearTimeout(this.gestureTimer);
    const before = this.gesture;
    this.gesture = null;
    if (before !== null) this.commit(before);
  }

  /** drop an open gesture without a step (the patch was replaced) */
  private dropGesture(): void {
    window.clearTimeout(this.gestureTimer);
    this.gesture = null;
  }

  undo(): void {
    if (this.gesture !== null && this.pointerHeld) return; // not in the middle of a drag: it would go on moving a replaced patch
    this.endGesture();
    this.endPass(); // (a pass being recorded is a step of its own)
    const e = this.history.pop();
    if (e === undefined) return this.ev.onError('nothing to undo');
    this.future.push({ s: this.snap(), side: this.side });
    this.restore(e.s);
    this.side = e.side;
    this.ev.onHistory?.('undo');
  }

  redo(): void {
    if (this.gesture !== null && this.pointerHeld) return;
    this.endGesture();
    this.endPass(); // (a pass being recorded is a step of its own)
    const e = this.future.pop();
    if (e === undefined) return this.ev.onError('nothing to redo');
    this.history.push({ s: this.snap(), side: this.side });
    this.restore(e.s);
    this.side = e.side;
    this.ev.onHistory?.('redo');
  }

  /** a structural change from outside (the tutorial's "do it for me"): undoable like the editor's own */
  transact(fn: () => unknown): boolean {
    return this.change(fn);
  }

  /** select a module where it shows: itself, or the outermost collapsed assembly that hides it */
  reveal(id: number): void {
    let hidden: AssemblyInst | undefined;
    for (let a = assemblyOf(this.patch, id); a; a = parentOf(this.patch, a.id)) if (!a.open) hidden = a;
    if (!hidden) return this.selectOnly([id]);
    this.selected.clear();
    this.selectedAsm.clear();
    this.selectedAsm.add(hidden.id);
    this.rebuild();
  }

  /** select exactly these modules */
  selectOnly(ids: number[]): void {
    this.selected.clear();
    this.selectedAsm.clear();
    for (const id of ids) this.selected.add(id);
    this.rebuild();
  }

  private restore(s: string): void {
    this.dropGesture();
    this.patch = this.revive(s);
    if (!this.patch.slackFrom) this.slackMod = 0;
    // an assembly the undo closed again tidies on its next first expansion (its tidied layout went with the step)
    for (const a of assembliesOf(this.patch)) if (!a.open) this.expandedOnce.delete(a.id);
    this.selected.clear();
    this.selectedAsm.clear();
    this.rebuild();
    this.ev.onStructure(this.patch);
  }

  /**
   * A structural change: run it, keep the assemblies consistent, remember the previous state for undo, redraw and tell
   * the host. An error undoes the change and goes to the status line. Returns whether something changed.
   */
  private change(fn: () => unknown): boolean {
    const before = this.mark();
    try {
      fn();
    } catch (e) {
      this.patch = this.revive(before);
      this.rebuild();
      this.ev.onError(String((e as Error).message ?? e));
      if (e instanceof PinsInUse) this.flash(e.cables);
      return false;
    }
    this.report(reconcileAll(this.patch, DEFS).map((l) => `assembly "${l}" is empty and was removed`));
    syncTied(this.patch, DEFS);   // (what a card row sets follows its first: a cable, a route or a range made on it, #357)
    if (!this.commit(before)) return false;
    this.rebuild();
    this.ev.onStructure(this.patch);
    return true;
  }

  private key(id: number, port: string, dir: 'out' | 'in'): string {
    return `${id}:${dir}:${port}`;
  }

  // ---- building the canvas

  rebuild(): void {
    this.cancelArm();
    this.chips.clear();
    if (this.armedSet.size) {
      const kept = keepArmed(this.patch, this.armedSet);
      if (kept.length !== this.armedSet.size) this.setArmed(kept); // (a device went, or lost its keys input)
      else this.ev.onArm?.([...this.armedSet], this.armPlays());
    }
    if (this.roll) {
      if (this.patch.modules.some((m) => m.id === this.roll!.id && m.type === 'steps')) queueMicrotask(() => this.roll?.view.render());
      else this.closeRoll();
    }
    this.screens = [];
    this.envScreens = [];
    this.stepGrids.clear();
    this.strips.clear();
    this.parameterDisplays = [];
    this.sliderPorts = [];
    this.lockers = [];
    this.cablePaths = [];
    this.drag?.cancel();
    this.svg.replaceChildren();
    this.preview.replaceChildren();
    this.modulesEl.replaceChildren();
    this.ports.clear();
    this.cards.clear();
    this.frames.clear();
    this.containers.clear();
    const copies = copiesOf(this.patch);
    const hidden = hiddenModules(this.patch);
    const hiddenAsm = hiddenAssemblies(this.patch);
    if (this.pickAsm !== null && !assembliesOf(this.patch).some((a) => a.id === this.pickAsm && a.open && !hiddenAsm.has(a.id))) this.pickAsm = null;
    // the row selection belongs to its mode: another mode, or none, starts without one
    const rowMode = `${this.pickAsm}:${this.arrangeAsm}`;
    if (rowMode !== this.rowMode) {
      this.rowMode = rowMode;
      this.dropRows();
    }
    this.selRows = [];
    this.rowAction = null;
    // an assembly's badge: the voice count of the poly assembly it is (or is inside), else none
    const voicesOf = new Map(polyGroups(this.patch).map((g) => [g.asm.id, g.cfg.parts]));
    const perVoice = (a: AssemblyInst): number => {
      const first = allModules(this.patch, a)[0];
      const root = first === undefined ? undefined : polyOfModule(this.patch, first);
      return root ? voicesOf.get(root.id) ?? 0 : 0;
    };
    for (const id of this.selected) if (!this.patch.modules.some((m) => m.id === id) || hidden.has(id)) this.selected.delete(id);
    for (const id of this.selectedAsm) if (!assembliesOf(this.patch).some((a) => a.id === id) || hiddenAsm.has(id)) this.selectedAsm.delete(id);
    // frames of the outer assemblies first: a nested frame is drawn on top of its parent's
    const visible = assembliesOf(this.patch).filter((a) => !hiddenAsm.has(a.id));
    for (const a of [...visible].sort((u, v) => depthOf(this.patch, u) - depthOf(this.patch, v))) if (a.open) this.modulesEl.append(this.frame(a, perVoice(a)));
    this.devices = devicesOf(this.patch, DEFS);
    this.focus = fixFocus(this.devices, this.focus);
    const docked = this.docked();
    this.wheelHost?.replaceChildren();
    this.dock?.replaceChildren(...(docked ? [this.dockPanel(docked)] : []));
    for (const m of this.patch.modules) {
      if (hidden.has(m.id) || m === docked) continue;
      const a = assemblyOf(this.patch, m.id);
      this.modulesEl.append(this.card(m, DEFS[m.type], copies.get(m.id) ?? 0, a));
    }
    for (const a of visible) if (!a.open) this.modulesEl.append(this.container(a, perVoice(a), parentOf(this.patch, a.id)));
    const drawn = new Set(this.selRows.map((r) => r.key));
    for (const k of this.rowSel) if (!drawn.has(k)) this.rowSel.delete(k);
    if (!this.rowSel.size) this.rowTouch = false;
    this.showRowSel();
    this.markFocus();
    this.applyStack();
    if (this.buttonPop) this.fillButtonEditor();
    this.flawPanel?.sync();
    this.ev.onScreens?.(this.screens, this.envScreens);
    this.sizeCanvas();
    requestAnimationFrame(() => {
      this.layoutFrames();
      this.sizeCanvas();
      this.drawCables();
    });
  }

  private layerKey(el: HTMLElement): string { return el.dataset.asm ? `a${el.dataset.asm}` : `m${el.dataset.id}`; }

  private applyStack(): void {
    const elements = [...this.frames.values(), ...this.cards.values(), ...this.containers.values()];
    const keys = elements.map((el) => this.layerKey(el));
    this.stack = this.stack.filter((key) => keys.includes(key));
    this.stack = [...keys.filter((key) => !this.stack.includes(key)), ...this.stack];
    for (const el of elements) el.style.zIndex = String(2 + this.stack.indexOf(this.layerKey(el)));
  }

  private raiseCard(el: HTMLElement): void {
    let raised = [this.layerKey(el)];
    if (el.classList.contains('frame')) {
      const a = assembliesOf(this.patch).find((a) => a.id === Number(el.dataset.asm));
      if (a) raised = [raised[0], ...descendants(this.patch, a).map((child) => `a${child.id}`), ...allModules(this.patch, a).map((id) => `m${id}`)];
    }
    this.stack = [...this.stack.filter((key) => !raised.includes(key)), ...raised];
    this.applyStack();
  }

  private resizeAssembly(el: HTMLElement, a: AssemblyInst): void {
    let before = '';
    el.append(resizeHandle(`Resize ${a.label}`, () => this.zoom, {
      start: () => { before = this.mark(); this.raiseCard(el); },
      size: () => ({ width: el.offsetWidth, height: el.offsetHeight }),
      resize: (width, height) => {
        a.frameSize = { width: Math.min(4000, Math.max(236, width)), height: Math.min(4000, Math.max(80, height)) };
        this.layoutFrames(); this.sizeCanvas(); this.positionCables();
      },
      end: () => {
        if (this.commit(before)) this.ev.onLayout(this.patch);
      },
    }));
  }

  private sizeCanvas(): void {
    const elements = [...this.cards.values(), ...this.containers.values(), ...this.frames.values()];
    const w = Math.max(this.canvas.clientWidth / this.zoom, ...elements.map((el) => el.offsetLeft + el.offsetWidth + 32));
    const h = Math.max(this.canvas.clientHeight / this.zoom, ...elements.map((el) => el.offsetTop + el.offsetHeight + 32));
    this.world.style.width = `${w}px`;
    this.world.style.height = `${h}px`;
    this.space.style.width = `${Math.ceil(w * this.zoom)}px`;
    this.space.style.height = `${Math.ceil(h * this.zoom)}px`;
  }

  /** ×N on a card or assembly that runs once per part of its poly assembly */
  private badge(n: number): HTMLElement {
    const badge = document.createElement('span');
    badge.className = 'voices';
    badge.textContent = `×${n}`;
    badge.title = `runs once per voice (${n} voices)`;
    return badge;
  }

  private button(text: string, title: string, onclick: () => void, cls = 'sm'): HTMLButtonElement {
    const b = document.createElement('button');
    b.className = cls;
    b.textContent = text;
    b.title = title;
    b.setAttribute('aria-label', title);
    b.onclick = (e) => {
      e.stopPropagation();
      e.preventDefault();
      onclick();
    };
    return b;
  }

  /** a module card; inside an expanded assembly its ports and parameters get the expose / pin toggles */
  /** the Main module shown in the dock (the first one; a second Main, from an old patch, stays a card) */
  /** the deck's bend and modulation wheels, placed in the dock under Main's jacks (set by the host, then rebuild) */
  dockWheels: { bend: HTMLElement; mod: HTMLElement } | null = null;
  /** the column beside the keyboard, as tall as the dock and the keyboard together, that holds the wheels (set by the host) */
  wheelHost: HTMLElement | null = null;
  /** the keyboard's octave buttons, shown under Main's output strip (set by the host, then rebuild) */
  dockOctave: HTMLElement | null = null;
  /** the transport's Play switch, PLAY in the dock's button block (set by the host, then rebuild) */
  dockPlay: HTMLElement | null = null;

  private docked(): ModuleInst | undefined {
    return this.dock ? this.patch.modules.find((m) => m.type === 'fm1') : undefined;
  }

  /**
   * The Main module as the panel above the keyboard: its jacks along the top edge (towards the canvas), the knobs
   * K1..K4 (bound to the focused page, their wires leaving fixed jacks on the edge), the FM-1's button block with the
   * patch buttons' jacks and traces (design board D, #113), then its settings.
   */
  private dockPanel(m: ModuleInst): HTMLElement {
    const def = DEFS[m.type];
    const el = document.createElement('div');
    el.className = 'dock-main';
    el.dataset.id = String(m.id);
    const title = document.createElement('span');
    title.className = 'dock-title';
    title.textContent = def.label;
    // a column: its jacks along the top (where the cables come down), the rest centred in the height that is left
    const col = (cls: string, top: HTMLElement | null, ...items: HTMLElement[]): HTMLElement => {
      const c = document.createElement('div');
      c.className = `dock-col ${cls}`;
      const body = document.createElement('div');
      body.className = 'dock-body';
      body.append(...items);
      c.append(...(top ? [top] : []), body);
      return c;
    };
    const jacks = (names: string[]): HTMLElement => {
      const row = document.createElement('div');
      row.className = 'dock-jacks';
      for (const p of def.outputs) if (names.includes(p.name)) {
        const port = this.port(m, p, 'out');
        // the long names in short, so the dock fits a 1280 px window (the tooltip keeps the full name)
        const short = DOCK_SHORT[p.name];
        const caption = short && port.querySelector(':scope > span:not(.dot)');
        if (caption) caption.textContent = short;
        row.append(port);
      }
      return row;
    };
    const param = (name: string): HTMLElement => this.paramRow(m, def, def.params.find((pd) => pd.name === name)!);
    // outputs with a home next to the control or setting that makes them; the rest in the strip
    const wheels = this.dockWheels;
    const WHEELS = wheels && this.wheelHost ? ['bend', 'mod'] : [], CLOCK = ['clock', 'run'];
    const homed = [...WHEELS, ...CLOCK, ...PANEL_BUTTONS];
    const strip = jacks(def.outputs.map((p) => p.name).filter((n) => !homed.includes(n)));
    this.focusCol = document.createElement('div');
    this.focusCol.className = 'dock-focus';
    this.fillFocus();
    // the FM-1's two button rows in device order; HOME SAVE SEQ REC are the device's (greyed), PLAY the transport
    const buttons = document.createElement('div');
    buttons.className = 'dock-buttons-grid';
    FM1_BUTTON_ROWS.forEach((row, r) => row.forEach((b, c) => {
      const kind = buttonKind(b);
      const btn = kind === 'patch' ? this.dockButton(m, b, PANEL_BUTTONS.indexOf(b))
        : kind === 'play' && this.dockPlay ? this.dockPlay : this.deviceButton(b);
      if (btn === this.dockPlay) btn.classList.add('panel-btn', 'play');
      btn.style.gridArea = `${r + 1} / ${c + 1}`;
      buttons.append(btn);
    }));
    // the patch buttons' jacks in a row on the dock's edge (the buttons name them), each over its button or lane
    const buttonJacks = jacks(PANEL_BUTTONS);
    buttonJacks.className = 'dock-button-jacks';
    for (const port of buttonJacks.querySelectorAll<HTMLElement>(':scope > .port')) {
      port.querySelectorAll(':scope > span:not(.dot)').forEach((s) => s.remove());
      port.style.gridColumn = String(jackColumn(port.querySelector<HTMLElement>('.dot')?.dataset.port ?? '') + 1);
    }
    const traces = document.createElementNS(SVGNS, 'svg');
    traces.setAttribute('class', 'button-traces');
    traces.setAttribute('aria-hidden', 'true');
    const morph = param('morph');
    // the morph slider's thumb is the morph input (Main has no p1 / p2): its cables are drawn to the thumb
    for (const pd of def.params) if (pd.input) {
      const jack = this.sliderPorts.find((s) => s.m === m && s.pd === pd)?.jack;
      if (jack) this.ports.set(this.key(m.id, pd.input, 'in'), jack);
    }
    // the bend and modulation wheels (the deck's, kept across redraws) each under its output's jack, in the column beside the keyboard
    if (wheels && this.wheelHost)
      this.wheelHost.replaceChildren(...(['bend', 'mod'] as const).map((n) => {
        const box = document.createElement('div');
        box.className = 'dock-wheel';
        // the wheel's own caption names it: the jack goes without a label (its tooltip still has the name)
        const row = jacks([n]);
        row.querySelectorAll('.port > span:not(.dot)').forEach((s) => s.remove());
        box.append(row, wheels[n]);
        return box;
      }));
    el.append(title,
      col('dock-outputs', strip, ...(this.dockOctave ? [this.dockOctave] : [])),
      col('dock-knobs', null, this.focusCol),
      this.buttonCol = col('dock-buttons', buttonJacks, buttons),
      // morph, its B side and the tempo share a column (so the dock fits a 1280 px window), the clock's jacks on its edge
      col('dock-morph', jacks(CLOCK), morph, this.morphRow(), param('tempo')));
    this.buttonCol.prepend(traces);
    return el;
  }

  /** one of the FM-1's own buttons (HOME, SAVE, SEQ, REC): shown in its place, greyed, not part of the patch */
  private deviceButton(b: string): HTMLElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'panel-btn device';
    btn.dataset.button = b;
    btn.textContent = buttonLabel(b);
    btn.disabled = true;
    btn.title = `${buttonLabel(b)}: the FM-1's own button (not part of the patch)`;
    return btn;
  }

  /** the gold traces from the patch buttons up to their jacks: straight up from the top row, ARP's through the gap
   * between the rows and up the lane right of REC (dock-buttons.ts) */
  private positionTraces(): void {
    const c = this.buttonCol, m = this.docked();
    const svg = c?.querySelector<SVGSVGElement>(':scope > svg.button-traces');
    if (!c || !svg || !m || !c.isConnected) return;
    const o = c.getBoundingClientRect();
    const top = c.querySelector(`.panel-btn[data-button="${FM1_BUTTON_ROWS[0][0]}"]`)?.getBoundingClientRect();
    const paths: SVGPathElement[] = [];
    for (const b of PANEL_BUTTONS) {
      const btn = c.querySelector(`.panel-btn[data-button="${b}"]`)?.getBoundingClientRect();
      const jack = this.ports.get(this.key(m.id, b, 'out'))?.getBoundingClientRect();
      if (!btn || !jack || !top || !btn.width || !jack.width) continue;
      const from = { x: btn.left + btn.width / 2 - o.left, y: btn.top - o.top };
      const to = { x: jack.left + jack.width / 2 - o.left, y: jack.bottom - o.top };
      const path = document.createElementNS(SVGNS, 'path');
      path.setAttribute('d', tracePath(from, to, (top.bottom + btn.top) / 2 - o.top));
      paths.push(path);
    }
    svg.replaceChildren(...paths);
  }


  private card(m: ModuleInst, def: ModuleDef, perVoice: number, open?: AssemblyInst): HTMLElement {
    const el = document.createElement('div');
    el.className = 'module' + (this.selected.has(m.id) ? ' selected' : '') + (open ? ' member' : '') + (this.picking(open) ? ' picking' : '') + (this.armedSet.has(`m${m.id}`) ? ' armed' : '');
    el.style.left = `${m.x}px`;
    el.style.top = `${m.y}px`;
    el.dataset.id = String(m.id);
    this.cards.set(m.id, el);

    const head = document.createElement('div');
    head.className = 'mhead';
    const title = document.createElement('span');
    title.append(this.tag(def.type), moduleName(def.type, def.label));
    if (perVoice) title.append(this.badge(perVoice));
    const tools = document.createElement('span');
    tools.className = 'tools';
    if (open) tools.append(this.outButton(open, () => this.takeOutModule(open, m)));
    if (!open && def.type !== 'steps' && armable(this.patch, `m${m.id}`)) tools.append(this.armButton(`m${m.id}`, moduleName(def.type, def.label)));
    if (def.type !== 'fm1' && def.type !== 'output' && !EDITOR_ONLY.has(def.type)) tools.append(this.bypassButton(m, def, el));
    const menu = (at: Pt): void => this.contextMenu(m, def, at);
    tools.append(this.moreButton(menu));
    head.append(title, tools);
    this.headMenu(head, menu);
    el.classList.toggle('off', !!m.bypass);
    this.moduleDrag(head, m);

    const body = document.createElement('div');
    body.className = 'mbody';
    const ins: EdgePort[] = [];
    for (const p of def.inputs) {
      if (!isPin(p.name)) ins.push({ el: this.port(m, p, 'in', { open, short: true }), module: m.id, port: p.name });
      else if (this.unrouted(m, p.name)) ins.push({ el: this.unroutedPort(m, p), module: m.id, port: p.name });
    }
    // a Drum map's rows go by their names (#137): a gate jack and a note row each, a click on the row's name renames it
    const row = (name: string): number => (def.type === 'drummap' && /^[gnv]\d$/.test(name) ? Number(name.slice(1)) - 1 : -1);
    const outs = def.outputs.map((p) => {
      const r = row(p.name);
      return this.port(m, p, 'out', { open, short: true, ...(r >= 0 && p.name[0] === 'g' ? { label: drumRowName(m.names, r) } : {}) });
    });
    // its displays first (an envelope's shape, the Scope's screen), then the parameters
    // (a Steps module's grid goes under the rows, across the card: 16 steps need the width)
    // in groups of four (one FM-1 page each)
    const steps = def.type === 'steps';
    const rows = moduleRows(def);
    const starts = groupStarts(rows.map((pd) => ({ knob: !pd.screen })));
    const params = rows.map((pd, i) => {
      const r = row(pd.name);
      const named = r >= 0 ? { label: drumRowName(m.names, r), rename: () => this.renameDrumRow(m, r) } : {};
      const pos = m.type === 'select' && pd.name === 'pos' ? { names: rowNames(this.patch, m.id, pd.name) } : {};
      return { el: this.paramRow(m, def, pd, { open, ...named, ...pos }), input: pd.input ? { module: m.id, port: pd.input } : undefined, gap: i > 0 && starts[i] };
    });
    // a second Main card (from an old patch) keeps its B side under the rows
    const extra = def.type === 'fm1' ? [this.morphRow()] : steps ? def.views!.map((pd) => this.paramRow(m, def, pd, { open })) : [];
    body.append(...this.edgeLayout(ins, outs, params, extra));
    el.append(head, body);
    // pick mode: one check box for all of its parameters (#186)
    if (open && this.picking(open)) {
      const rows = this.selRows.filter((r) => body.contains(r.el)).map(({ module, param }) => ({ module, param }));
      if (rows.length) title.prepend(this.pickAllBox(open, rows));
    }
    return el;
  }

  /** the Steps modules' grids drawn in this rebuild, by module id */
  private stepGrids = new Map<number, StepGrid>();

  /** where the Steps modules are (Engine.stepsView through the worklet): their grids' playheads and mute switches; the
   * pattern each plays and the one it waits for, the song entry (Engine.patternView, #375) */
  showSteps(view: { id: number; pos: number; mute: boolean }[], pats?: PatternView): void {
    for (const v of view) this.stepGrids.get(v.id)?.show(v.pos, v.mute);
    const r = this.roll && view.find((v) => v.id === this.roll!.id);
    if (r) this.roll!.view.show(r.pos);
    if (pats) {
      for (const t of pats.tracks) for (const s of this.strips.get(t.id) ?? []) s.show(t.pat, t.queued);
      this.songView?.showLive(pats.song, pats.tracks.map((t) => t.entry));
    }
  }

  /** the pattern strips drawn (a card's, the roll's), by module id */
  private strips = new Map<number, PatternStrip[]>();
  /** a Steps module as its grid and roll see it: its notes, length and rate those of the selected pattern (track.ts
   * patternOf; one it has not got shows its pattern 1) */
  private trackView(m: ModuleInst): ModuleInst {
    const pattern = (): number => this.pattern;
    return new Proxy(m, {
      get(t, k, r) {
        if (k === 'notes') return patternOf(t, pattern()).notes;
        if (k === 'params') {
          const v = patternOf(t, pattern());
          return { ...t.params, len: v.len, rate: v.rate };
        }
        return Reflect.get(t, k, r);
      },
    });
  }
  /** a pattern strip for a Steps module (#375) */
  private stripFor(id: number): PatternStrip {
    const m = (): ModuleInst | undefined => this.patch.modules.find((x) => x.id === id && x.type === 'steps');
    const strip = patternStrip({
      pattern: () => this.pattern,
      names: () => this.mainSeq()?.names,
      select: (p) => this.selectPattern(p),
      used: () => this.usedPatterns(),
      shape: (p) => {
        const t = m();
        if (!t) return { own: true };
        const x = p > 0 ? t.patterns?.[p - 1] ?? null : null;
        return { own: p === 0 || !!x, len: x?.len, rate: x?.rate };
      },
      setShape: (p, shape) => this.setPatternShape(id, p, shape),
      clear: (p) => {
        const t = m();
        if (!t) return;
        this.touch();
        this.setNotes(t, undefined, p);
        this.stepGrids.get(id)?.refresh();
        this.refreshStrips();
      },
      copy: (from, to) => this.copyPattern(from, to),
      nextEmpty: () => this.nextEmptyPattern(),
      song: () => (this.songView ? this.closeSong() : this.openSong()),
      playing: () => this.song,
    });
    const list = this.strips.get(id) ?? [];
    list.push(strip);
    this.strips.set(id, list);
    return strip;
  }
  private refreshStrips(): void {
    for (const list of this.strips.values()) for (const s of list) s.refresh();
  }

  /** the song drawer (song.ts), over the canvas like the roll */
  openSong(): void {
    const host = this.canvas.parentElement;
    if (!host || this.songView) return;
    const view = new SongView({
      songs: () => this.songs(),
      playing: () => this.song,
      pattern: () => this.pattern,
      names: () => this.mainSeq()?.names,
      setSong: (k, entries) => this.setSong(k, entries),
      play: (n) => this.selectSong(n),
      close: () => this.closeSong(),
    });
    this.songView = view;
    host.append(view.el);
    this.refreshStrips();
  }
  closeSong(): void {
    const v = this.songView as SongView | null;
    if (!v) return;
    this.songView = null;
    v.el.remove();
    this.refreshStrips();
  }

  /** a track edited on the FM-1's SEQ page (its notes as they are now, of pattern `pat`): into the patch and the grid, an
   * undo step like an edit here (an undo sends the patch back to the FM-1, so a change made there must be in the history) */
  trackFromDevice(id: number, notes: StepNote[] | undefined, pat = 0): void {
    const m = this.patch.modules.find((x) => x.id === id && x.type === 'steps');
    if (!m) return;
    this.touch();
    this.setNotes(m, notes, pat);
    this.stepGrids.get(id)?.refresh();
  }

  /** a Steps module's notes of pattern p (0-based; the selected one), valid, into the patch and the engines. A pattern the
   * track had not got is made (its notes are what the edit made of the pattern 1 it showed: track.ts patternOf) */
  private setNotes(m: ModuleInst, notes: StepNote[] | undefined, p = this.pattern): void {
    const n = fixNotes(notes);
    if (p <= 0) {
      if (n) m.notes = n;
      else delete m.notes;
    } else {
      const pats: (Pattern | null)[] = [...(m.patterns ?? [])];
      while (pats.length < p) pats.push(null);
      const x: Pattern = { ...(pats[p - 1] ?? {}) };
      if (n) x.notes = n;
      else delete x.notes;
      pats[p - 1] = x;
      m.patterns = fixPatterns(pats);
    }
    this.ev.onTrack?.(m.id, n, p);
    if (this.roll?.id === m.id) this.roll.view.render();
  }

  /* ---- patterns and songs (#375; track.ts SeqState on Main: the selected pattern, the song playing, the songs) */
  private mainSeq(): SeqState | undefined {
    return this.patch.modules.find((m) => m.type === 'fm1')?.seq;
  }
  /** the patch's selected pattern (0-based): every track's grid and roll show and edit it */
  get pattern(): number {
    return this.mainSeq()?.pattern ?? 0;
  }
  /** the song that plays (0: none, the selected pattern plays) */
  get song(): number {
    return this.mainSeq()?.song ?? 0;
  }
  /** the patch's songs (8 at most; an empty list for one with no entries) */
  songs(): SongEntry[][] {
    return Array.from({ length: SONGS_MAX }, (_, k) => (this.mainSeq()?.songs?.[k] ?? []).map((e) => ({ ...e })));
  }
  private putSeq(f: (s: SeqState) => void): void {
    const main = this.patch.modules.find((m) => m.type === 'fm1');
    if (!main) return;
    const s: SeqState = structuredClone(main.seq ?? {});
    f(s);
    const v = fixSeq(s);
    if (v) main.seq = v;
    else delete main.seq;
  }
  /** a track's pattern p as the editor shows it (track.ts patternOf: one it has not got shows its pattern 1) */
  patternOf(id: number, p = this.pattern): ReturnType<typeof patternOf> | null {
    const m = this.patch.modules.find((x) => x.id === id && x.type === 'steps');
    return m ? patternOf(m, p) : null;
  }
  /** which tracks' patterns hold notes (or exist), by pattern number: for the strip's marks */
  usedPatterns(): Set<number> {
    const out = new Set<number>();
    for (const m of this.patch.modules) {
      if (m.type !== 'steps') continue;
      if (m.notes?.length) out.add(0);
      m.patterns?.forEach((x, i) => { if (x) out.add(i + 1); });
    }
    return out;
  }
  /** choose the patch's pattern / song: where the patch plays, saved with it but no undo step (like the transport); the
   * grids and the roll show the pattern */
  selectPattern(p: number): void {
    p = Math.max(0, Math.min(PATTERNS_MAX - 1, Math.round(p)));
    if (p === this.pattern) return;
    this.putSeq((s) => (s.pattern = p));
    this.patternShown();
  }
  selectSong(n: number): void {
    n = Math.max(0, Math.min(SONGS_MAX, Math.round(n)));
    if (n === this.song) return;
    this.putSeq((s) => (s.song = n));
    this.patternShown();
  }
  private patternShown(): void {
    this.ev.onPattern?.(this.pattern, this.song);
    for (const g of this.stepGrids.values()) g.refresh();
    this.refreshStrips();
    this.roll?.view.render();
    this.songView?.render();
  }
  /** the FM-1 chose a pattern or a song (PATTERN_NOW): followed, not sent back (main.ts marks it) */
  patternFromDevice(pattern: number, song: number): void {
    this.putSeq((s) => { s.pattern = pattern; s.song = song; });
    this.patternShown();
  }
  /** song k's entries (an undo step) */
  setSong(k: number, entries: SongEntry[]): void {
    if (k < 0 || k >= SONGS_MAX) return;
    this.touch();
    this.putSeq((s) => {
      const songs = Array.from({ length: SONGS_MAX }, (_, j) => s.songs?.[j] ?? []);
      songs[k] = entries.map((e) => ({ ...e }));
      s.songs = songs;
    });
    this.ev.onSong?.(k, this.songs()[k]);
    this.songView?.render();
  }
  /** song k edited on the FM-1's SONG page (SONG_NOW): an undo step, as a track edited there */
  songFromDevice(k: number, entries: SongEntry[]): void {
    this.setSong(k, entries);
  }
  /** a track's pattern p's own length or rate (undefined: the track's); pattern 1 has none of its own: its track's are set */
  setPatternShape(id: number, p: number, shape: { len?: number | null; rate?: number | null }): void {
    const m = this.patch.modules.find((x) => x.id === id && x.type === 'steps');
    if (!m) return;
    if (p <= 0) {
      if (shape.len) this.setParam(id, 'len', shape.len);
      if (shape.rate !== undefined && shape.rate !== null) this.setParam(id, 'rate', shape.rate);
      return;
    }
    this.touch();
    const pats: (Pattern | null)[] = [...(m.patterns ?? [])];
    while (pats.length < p) pats.push(null);
    const x: Pattern = { ...(pats[p - 1] ?? { ...(m.notes ? { notes: m.notes.map((n) => ({ ...n })) } : {}) }) };
    for (const k of ['len', 'rate'] as const) {
      const v = shape[k];
      if (v === null) delete x[k];
      else if (v !== undefined) x[k] = v;
    }
    pats[p - 1] = x;
    m.patterns = fixPatterns(pats);
    this.ev.onStructure(this.patch);
    this.stepGrids.get(id)?.refresh();
    this.roll?.view.render();
  }
  /** copy pattern `from` of every track to pattern `to` (a track without `from` loses `to` too): an undo step */
  copyPattern(from: number, to: number): void {
    if (from === to || to < 0 || to >= PATTERNS_MAX) return;
    this.touch();
    for (const m of this.patch.modules) {
      if (m.type !== 'steps') continue;
      const src = from <= 0 ? { ...(m.notes ? { notes: m.notes } : {}) } : m.patterns?.[from - 1] ?? null;
      if (to <= 0) {
        if (src) {
          if (src.notes?.length) m.notes = structuredClone(src.notes);
          else delete m.notes;
        }
        continue;
      }
      const pats: (Pattern | null)[] = [...(m.patterns ?? [])];
      while (pats.length < to) pats.push(null);
      pats[to - 1] = src ? structuredClone(src) : null;
      const fixed = fixPatterns(pats);
      if (fixed) m.patterns = fixed;
      else delete m.patterns;
    }
    this.ev.onStructure(this.patch);
    for (const g of this.stepGrids.values()) g.refresh();
    this.roll?.view.render();
  }
  /** the first pattern no track has (for Copy to the next empty one), -1 when all 64 are used */
  nextEmptyPattern(): number {
    const used = this.usedPatterns();
    for (let p = 1; p < PATTERNS_MAX; p++) if (!used.has(p)) return p;
    return -1;
  }
  /** the open song drawer (song.ts), if any */
  songView: SongView | null = null;

  /** a Steps module's grid follows its length (the len slider) */
  refreshSteps(id: number): void {
    this.stepGrids.get(id)?.refresh();
  }

  /** a Steps module's grid: its edits go through the undo history and onTrack / onMute; a new name is a structure change
   * (the name is in the binary the FM-1 gets) */
  private stepsRow(m: ModuleInst): StepGrid {
    const index = this.patch.modules.filter((x) => x.type === 'steps').indexOf(m);
    const grid = stepGrid(this.trackView(m), index, {
      notes: (n) => {
        this.touch(); // a drag across the grid is one gesture: one undo step
        this.setNotes(m, n);
        this.refreshStrips();
      },
      begin: () => this.beginEdit(),
      name: (s) => {
        if ((m.name ?? '') === s) return;
        this.touch();
        if (s) m.name = s;
        else delete m.name;
        this.ev.onStructure(this.patch);
      },
      mute: (on) => this.ev.onMute?.(m.id, on),
      arm: (on) => this.toggleArm(`m${m.id}`, on),
      armed: () => this.armedSet.has(`m${m.id}`),
      rec: (on) => {
        if (on) this.armTrack(m.id);
        this.setRec(on && this.armedTrack === m.id);
      },
      recording: () => this.recOn && this.armedTrack === m.id,
      roll: () => (this.roll?.id === m.id ? this.closeRoll() : this.openRoll(m.id)),
    });
    this.stepGrids.set(m.id, grid);
    if (this.roll?.id === m.id) grid.rolled(true);
    grid.el.insertBefore(this.stripFor(m.id).el, grid.el.children[1] ?? null);   // (the pattern strip under the head, #375)
    return grid;
  }

  /** the armed devices (#190, docs/ledger/vocabulary.md "Arm"; `m<id>` / `a<id>`): Main's keys go to them, cable or not (Engine.arm).
   * Editor state: independent toggles, not saved, no undo step; another patch disarms them */
  armedSet = new Set<DeviceKey>();

  /** the Steps track REC records into (#134 / #135): the armed Steps track, while exactly one is armed */
  get armedTrack(): number | null {
    return this.trackOf(this.armedSet);
  }

  private trackOf(keys: Iterable<DeviceKey>): number | null {
    const ids = [...keys].filter((k) => k[0] === 'm').map((k) => Number(k.slice(1))).filter((id) => this.patch.modules.some((m) => m.id === id && m.type === 'steps'));
    return ids.length === 1 ? ids[0] : null;
  }

  /** arm exactly these devices (the ones that cannot be armed are left out) */
  setArmed(keys: Iterable<DeviceKey>): void {
    const next = keepArmed(this.patch, keys);
    if (next.length === this.armedSet.size && next.every((k) => this.armedSet.has(k))) return;
    if (this.trackOf(next) !== this.armedTrack) this.setRec(false);
    this.armedSet = new Set(next);
    for (const [k, g] of this.stepGrids) g.armed(this.armedSet.has(`m${k}`));
    for (const [k, card] of this.cards) card.classList.toggle('armed', this.armedSet.has(`m${k}`));
    for (const [k, card] of this.containers) card.classList.toggle('armed', this.armedSet.has(`a${k}`));
    for (const b of this.canvas.querySelectorAll<HTMLButtonElement>('button[data-arm]')) {
      const on = this.armedSet.has(b.dataset.arm!);
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    }
    this.markMuted();
    this.ev.onArm?.([...this.armedSet], this.armPlays());
    this.positionBindings();
    this.roll?.view.render();
  }

  /** ARM on one device: on / off, the others as they are */
  toggleArm(key: DeviceKey, on = !this.armedSet.has(key)): void {
    const next = new Set(this.armedSet);
    if (on) next.add(key);
    else next.delete(key);
    this.setArmed(next);
  }

  /** #134's form: arm this Steps track as the one armed track (other armed devices stay), or null: disarm everything */
  armTrack(id: number | null): void {
    if (id === null) return this.setArmed([]);
    if (!this.patch.modules.some((m) => m.id === id && m.type === 'steps')) return;
    this.setArmed([...[...this.armedSet].filter((k) => this.trackOf([k]) === null), `m${id}`]);
  }

  /** what the armed devices play, by the names the canvas shows: a Steps track, what it drives; anything else, itself */
  private armPlays(): string[] {
    const out: string[] = [];
    for (const k of this.armedSet) {
      const id = Number(k.slice(1));
      const names = k[0] === 'a' ? [assemblyById(this.patch, id)?.label ?? 'assembly']
        : this.patch.modules.find((m) => m.id === id)?.type === 'steps' ? this.trackPlays(id)
        : [moduleName(this.patch.modules.find((m) => m.id === id)?.type ?? '', DEFS[this.patch.modules.find((m) => m.id === id)?.type ?? '']?.label ?? '')];
      for (const n of names) if (!out.includes(n)) out.push(n);
    }
    return out;
  }

  /** Main's keys cables the arm overrides, drawn muted (#190) */
  private markMuted(): void {
    const muted = new Set(mutedCables(this.patch, this.armedSet));
    for (const { path, cable } of this.cablePaths) path.classList.toggle('muted', !!cable && muted.has(cable));
  }

  /** REC on the armed track (#135; editor state like the arming): stopped, step entry on its card; running, the engine
   * records what is played (recorded) */
  recOn = false;

  setRec(on: boolean): void {
    if (this.armedTrack === null) on = false;
    if (on === this.recOn) return;
    this.recOn = on;
    if (!on) this.endPass();
    const id = this.armedTrack;
    if (id === null) return;
    this.stepGrids.get(id)?.rec(on);
    this.ev.onRec?.(id, on);
    this.roll?.view.render();
  }

  /** Shift+R: REC on the armed track on / off; false when no track is armed */
  toggleRec(): boolean {
    if (this.armedTrack === null) return false;
    this.setRec(!this.recOn);
    return true;
  }

  /** the pass being recorded live: its track, the time round the pattern, the patch before it (one undo step per pass) */
  private pass: { id: number; loop: number; before: string } | null = null;

  private endPass(): void {
    const p = this.pass;
    this.pass = null;
    if (p) this.commit(p.before);
  }

  /** notes a track recorded live (Engine.takeRecorded): laid over its notes (overdub); each time round the pattern is one
   * undo step */
  recorded(took: { id: number; loop: number; note: StepNote }[]): void {
    for (const { id, loop, note } of took) {
      const m = this.patch.modules.find((x) => x.id === id && x.type === 'steps');
      if (!m) continue;
      if (this.pass && (this.pass.id !== id || this.pass.loop !== loop)) this.endPass();
      if (!this.pass) {
        this.endGesture();
        this.pass = { id, loop, before: this.snap() };
      }
      this.setNotes(m, overdub(patternOf(m, this.pattern).notes, [note]));
      this.stepGrids.get(id)?.refresh();
    }
  }

  /** the open piano roll (#136): one track's, over the canvas above the dock */
  private roll: { id: number; view: PianoRoll } | null = null;

  openRoll(id: number): void {
    const m = this.patch.modules.find((x) => x.id === id && x.type === 'steps');
    const host = this.canvas.parentElement;
    if (!m || !host) return;
    this.closeRoll();
    const found = (): ModuleInst | null => this.patch.modules.find((x) => x.id === id && x.type === 'steps') ?? null;
    const track = (): ModuleInst | null => { const t = found(); return t && this.trackView(t); };
    const view = new PianoRoll({
      track,
      strip: () => this.stripFor(id).el,
      label: () => trackLabel(this.patch, id),
      plays: () => this.trackPlays(id),
      drums: () => {
        const map = trackDrumMap(this.patch, id);
        return map ? Array.from({ length: DRUM_ROWS }, (_, r) => ({ name: drumRowName(map.names, r), note: Math.round(map.params[`n${r + 1}`] ?? 0) })) : null;
      },
      notes: (n) => {
        const t = found();
        if (!t) return;
        this.setNotes(t, n);
        this.stepGrids.get(id)?.refresh();
        this.refreshStrips();
      },
      begin: () => this.beginEdit(),
      len: (n) => (this.pattern > 0 ? this.setPatternShape(id, this.pattern, { len: n }) : this.setParam(id, 'len', n)),
      play: (note, vel) => this.ev.onThru?.(id, note, vel),
      arm: (on) => this.toggleArm(`m${id}`, on),
      armed: () => this.armedSet.has(`m${id}`),
      rec: (on) => {
        if (on) this.armTrack(id);
        this.setRec(on && this.armedTrack === id);
      },
      recording: () => this.recOn && this.armedTrack === id,
      close: () => this.closeRoll(),
    });
    this.roll = { id, view };
    host.append(view.el);
    host.classList.add('roll-open');
    // the canvas shrinks to the space above the roll, so every card can still be scrolled to (the #136 follow-up)
    const fit = (): void => {
      host.style.setProperty('--roll-h', `${view.el.offsetHeight}px`);
      this.positionBindings();
    };
    this.rollFit = new ResizeObserver(fit);
    this.rollFit.observe(view.el);
    fit();
    // the roll keeps its keys (Delete, the arrows ...) while the last press was in it, wherever the focus went
    this.rollActive = true;
    this.rollPress = (e: PointerEvent): void => { this.rollActive = view.el.contains(e.target as Node); };
    window.addEventListener('pointerdown', this.rollPress, true);
    view.render();
    view.el.focus({ preventScroll: true });
    this.positionBindings();
    for (const [k, g] of this.stepGrids) g.rolled(k === id);
  }

  closeRoll(): void {
    const r = this.roll;
    if (!r) return;
    this.roll = null;
    r.view.el.remove();
    this.rollFit?.disconnect();
    this.rollFit = null;
    if (this.rollPress) window.removeEventListener('pointerdown', this.rollPress, true);
    this.rollPress = null;
    this.rollActive = false;
    this.canvas.parentElement?.classList.remove('roll-open');
    this.canvas.parentElement?.style.removeProperty('--roll-h');
    for (const g of this.stepGrids.values()) g.rolled(false);
    this.positionBindings();
  }

  private rollFit: ResizeObserver | null = null;
  private rollPress: ((e: PointerEvent) => void) | null = null;
  private rollActive = false;

  /** a key while the focus is in the roll, or the last press was: true when the roll took it */
  rollKey(e: KeyboardEvent): boolean {
    return !!this.roll && (this.rollActive || this.roll.view.el.contains(e.target as Node)) && this.roll.view.key(e.key, e.shiftKey, e.metaKey || e.ctrlKey, e.altKey);
  }

  /** a key Main plays went down / up (the keyboard, the on-screen keys, MIDI): the open roll lights it */
  rollHeld(note: number, on: boolean): void {
    this.roll?.view.heldKey(note, on);
  }

  /** what a track plays, by the names the canvas shows */
  private trackPlays(id: number): string[] {
    return trackTargets(this.patch, id, (m) => moduleName(m.type, DEFS[m.type]?.label ?? m.type));
  }

  /** the Scope screens and envelope shapes drawn in this rebuild (onScreens) */
  private screens: ScreenSpec[] = [];
  private envScreens: EnvSpec[] = [];

  /** an undo step around a change made outside the editor's own controls (a drag on an envelope's shape): call the result when done */
  beginEdit(): () => void {
    this.touch();
    return () => this.endGesture();
  }

  /** a Scope's screen: it goes on an assembly card like a parameter (pick mode, Cmd / Ctrl-click) */
  private screenRow(m: ModuleInst, pd: ParamDef, o: { open?: AssemblyInst; label?: string; rename?: () => void }): HTMLElement {
    const open = o.open;
    const row = document.createElement('div');
    row.className = 'param screen';
    if (m.type === 'steps') {                 // a Steps module's grid (step-grid.ts)
      row.className = 'param screen steps';
      row.append(this.stepsRow(m).el);
      if (open) {
        const on = isPromoted(open, m.id, pd.name);
        row.classList.toggle('shown', on);
        this.promoteClick(row, open, () => (on ? demote(open, m.id, pd.name) : promote(open, m.id, pd.name, this.patch)), { module: m.id, param: pd.name });
        if (this.picking(open)) row.append(this.pickBox(on));
      }
      return row;
    }
    const isScope = m.type === 'scope'; // else an envelope's shape
    const screen = document.createElement('div');
    screen.className = isScope ? 'scope-screen' : 'scope-screen env-screen';
    row.append(screen);
    // its name in the corner: an assembly card's label for it (renamable there), else nothing
    if (o.label) {
      const name = document.createElement('span');
      name.className = 'screen-name' + (isScope ? '' : ' right');
      name.textContent = o.label;
      if (o.rename) {
        name.classList.add('rename');
        name.title = 'click to rename';
        name.onclick = (e) => { e.preventDefault(); o.rename!(); };
      }
      row.append(name);
    }
    if (open) {
      const on = isPromoted(open, m.id, pd.name);
      row.classList.toggle('shown', on);
      this.promoteClick(row, open, () => (on ? demote(open, m.id, pd.name) : promote(open, m.id, pd.name, this.patch)), { module: m.id, param: pd.name });
      if (this.picking(open)) row.append(this.pickBox(on));
    }
    if (!isScope) {
      this.envScreens.push({ m, el: screen });
      return row;
    }
    const chans = ['a', 'b'].map((port) => this.patch.cables
      .filter((c) => c.to.module === m.id && c.to.port === port)
      .flatMap((c) => {
        const from = this.patch.modules.find((x) => x.id === c.from.module);
        const kind = from && DEFS[from.type].outputs.find((q) => q.name === c.from.port)?.kind;
        return kind ? [{ id: c.from.module, port: c.from.port, kind }] : [];
      }));
    this.screens.push({ m, el: screen, chans });
    row.append(this.scopeTools(m));
    return row;
  }

  /** a Scope screen's hover toolbar: its window (− / +, a 1-2-5 series) and time / spectrum */
  private scopeTools(m: ModuleInst): HTMLElement {
    const def = DEFS[m.type];
    const bar = document.createElement('div');
    bar.className = 'scope-tools';
    const timePd = def.params.find((q) => q.name === 'time')!;
    const steps = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000].filter((v) => v >= timePd.min && v <= timePd.max);
    const value = document.createElement('span');
    value.className = 'scope-time';
    const show = (): void => {
      const t = m.params.time ?? timePd.default;
      const { num, unit } = t >= 1000 ? formatValue(t / 1000, 's', false) : formatValue(t, timePd.unit, false);
      value.textContent = `${num} ${unit}`;
    };
    const step = (dir: 1 | -1): void => {
      const t = m.params.time ?? timePd.default;
      const next = dir > 0 ? steps.find((v) => v > t * 1.001) : [...steps].reverse().find((v) => v < t * 0.999);
      if (next === undefined) return;
      this.setParam(m.id, 'time', next);
      show();
    };
    const shorter = this.button('−', 'Shorter window', () => step(-1), 'sm');
    const longer = this.button('+', 'Longer window', () => step(1), 'sm');
    const modes = (def.params.find((q) => q.name === 'mode')!.choices ?? []).map((name, i) => {
      const b = this.button(name === 'spectrum' ? 'FFT' : 'Wave', name === 'spectrum' ? 'Spectrum' : 'Waveform', () => {
        this.setParam(m.id, 'mode', i);
        for (const [k, x] of modes.entries()) x.setAttribute('aria-pressed', String(k === i));
      }, 'sm');
      b.setAttribute('aria-pressed', String(Math.round(m.params.mode ?? 0) === i));
      return b;
    });
    const rule = document.createElement('span');
    rule.className = 'scope-rule';
    show();
    bar.append(shorter, value, longer, rule, ...modes);
    // per voice (#54): only where something cabled in runs once per voice
    const copies = copiesOf(this.patch);
    const fed = this.patch.cables.filter((c) => c.to.module === m.id).some((c) => (copies.get(c.from.module) ?? 1) > 1);
    if (fed) {
      const on = (): boolean => Math.round(m.params.voices ?? 0) === 1;
      const each = this.button('Voices', 'Each voice as its own trace', () => {
        this.setParam(m.id, 'voices', on() ? 0 : 1);
        each.setAttribute('aria-pressed', String(on()));
      }, 'sm');
      each.setAttribute('aria-pressed', String(on()));
      const rule2 = document.createElement('span');
      rule2.className = 'scope-rule';
      bar.append(rule2, each);
    }
    // the toolbar's presses are its own: no card drag, no cable, no pick
    bar.addEventListener('pointerdown', (e) => e.stopPropagation());
    return bar;
  }

  /** the tag before a card's title (VCO, VCF, ENV ...), coloured by the module's family; an assembly's: ENG when it is an
   * engine (it takes keys into a Voicing or Drum map and makes sound, ADR 0001), else ASM */
  private tag(type: string | null, a?: AssemblyInst): HTMLElement {
    const t = document.createElement('span');
    const engine = !type && !!a && instIsEngine(this.patch, a);
    const { tag, family } = type ? moduleTag(type) : { tag: engine ? 'ENG' : 'ASM', family: 'asm' };
    t.className = `mtag ${family}`;
    t.textContent = tag;
    if (!type) t.title = engine ? 'Engine: an assembly that takes keys and makes sound' : 'Assembly';
    return t;
  }

  /**
   * A card's body: rows of [input jack | parameter | output jack]. A parameter's dedicated input (ParamDef.input) sits on
   * its row; at most EDGE_JACKS jacks hang on each side edge (the outputs from the top, the other inputs in the free rows),
   * the rest hang off the bottom edge with their labels above them. `extra` goes under the rows, across the card.
   * An assembly card can have columns (`col` starts one) and rows above a parameter (`above`: its heading): then the
   * inputs hang on the first column's left edge, the outputs on the last one's right edge, a dedicated input of a later
   * column joins the free inputs, and each side edge takes as many jacks as the tallest column has rows.
   */
  private edgeLayout(ins: EdgePort[], outs: HTMLElement[], params: EdgeParam[], extra: HTMLElement[] = []): HTMLElement[] {
    // a row of the card: a parameter (with its headings above it) or a row only for a jack; `l` / `r` are its jacks
    type Item = { el: HTMLElement | null; above: HTMLElement[]; below?: HTMLElement[]; param?: EdgeParam; l?: HTMLElement; r?: HTMLElement };
    const cols: Item[][] = [[]];
    for (const p of params) {
      if (p.col && cols[cols.length - 1].length) cols.push([]);
      cols[cols.length - 1].push({ el: p.el, above: p.above ?? [], below: p.below, param: p });
    }
    const n = cols.length;
    const height = (c: Item[]): number => c.reduce((h, it) => h + 1 + it.above.length + (it.below?.length ?? 0), 0);
    const cap = n > 1 ? Math.max(EDGE_JACKS, ...cols.map(height)) : EDGE_JACKS;
    // the k-th place for a jack on a side edge: the column's k-th row, then rows for jacks only under it
    const slot = (ci: number, k: number): Item => {
      const c = cols[ci];
      while (c.length <= k) c.push({ el: null, above: [] });
      return c[k];
    };
    const free = [...ins];
    let fixed = 0;
    for (const it of cols[0]) {
      const input = it.param?.input;
      const k = input ? free.findIndex((x) => x.module === input.module && x.port === input.port) : -1;
      if (k < 0) continue;
      it.l = free.splice(k, 1)[0].el;
      fixed++;
    }
    const sideIns = free.splice(0, Math.max(0, cap - fixed));
    let k = 0;
    for (const x of sideIns) {
      while (slot(0, k).l) k++;
      slot(0, k++).l = x.el;
    }
    const sideOuts = outs.slice(0, cap);
    sideOuts.forEach((el, i) => (slot(n - 1, i).r = el));
    const cell = (cls: string, child: HTMLElement | null): HTMLElement => {
      const c = document.createElement('div');
      c.className = cls;
      if (child) c.append(child);
      return c;
    };
    // a row element: the input track's cell when it reaches the card's left edge, the outputs' when it reaches the right
    const rowEl = (m: HTMLElement | null, first: boolean, last: boolean, l?: HTMLElement, r?: HTMLElement, across = 1): HTMLElement => {
      const el = document.createElement('div');
      el.className = 'erow';
      if (first) el.append(cell('el', l ?? null));
      const em = cell('em', m);
      if (across > 1) em.style.gridColumn = `span ${across}`;
      el.append(em);
      if (last) el.append(cell('er', r ?? null));
      return el;
    };
    const rowsOf = (it: Item, first: boolean, last: boolean, across = 1): HTMLElement[] => {
      const els = [...it.above.map((h) => rowEl(h, first, last, undefined, undefined, across)), rowEl(it.el, first, last, it.l, it.r, across),
        ...(it.below ?? []).map((h) => rowEl(h, first, last, undefined, undefined, across))];
      if (it.param?.gap) els[0].classList.add('gstart');
      return els;
    };
    const grid = document.createElement('div');
    grid.className = 'erows' + (n > 1 ? ' multi' : '');
    if (n === 1) for (const it of cols[0]) grid.append(...rowsOf(it, true, true));
    else {
      // each column stacks its own rows; the first one holds the input jacks' track, the last one the outputs'. A display
      // that spans (`spanPlan`) cuts the columns it covers into stacks above it and below it. Grid lines are the whole
      // card's (1 = the input track, column c starts at c + 2, n + 3 = after the output track); each block is a subgrid
      grid.style.gridTemplateColumns = `auto repeat(${n}, minmax(0, 1fr)) auto`;
      const lineA = (c: number): number => (c === 0 ? 1 : c + 2);
      const lineB = (c: number): number => (c === n ? n + 3 : c + 2);
      const place = (el: HTMLElement, from: number, to: number, base: number): void => {
        el.style.gridColumn = `${lineA(from) - base + 1} / ${lineB(to) - base + 1}`;
      };
      const blocks = (list: SpanBlock<Item>[], base: number): HTMLElement[] => list.map((b) => {
        const el = document.createElement('div');
        if ('col' in b) {
          el.className = 'ecol';
          place(el, b.col, b.col + 1, base);
          for (const it of b.items) el.append(...rowsOf(it, b.col === 0, b.col === n - 1));
          return el;
        }
        el.className = 'egrp';
        place(el, b.from, b.to, base);
        const inner = lineA(b.from);
        const seg = (sub: SpanBlock<Item>[]): void => {
          if (!sub.length) return;
          const s = document.createElement('div');
          s.className = 'eseg';
          s.append(...blocks(sub, inner));
          el.append(s);
        };
        seg(b.above);
        el.append(...rowsOf(b.band, b.from === 0, b.to === n, b.to - b.from));
        seg(b.below);
        return el;
      });
      grid.append(...blocks(spanPlan(cols, (it) => it.param?.span), 1));
    }
    const out: HTMLElement[] = cols.some((c) => c.length) ? [grid] : [];
    out.push(...extra);
    const bottomIns = free.map((x) => x.el), bottomOuts = outs.slice(cap);
    if (bottomIns.length || bottomOuts.length) {
      const foot = document.createElement('div');
      foot.className = 'mfoot';
      const group = (els: HTMLElement[]): HTMLElement => {
        const g = document.createElement('div');
        for (const el of els) {
          el.classList.add('bottom');
          const dot = el.querySelector<HTMLElement>('.dot');
          if (dot) dot.dataset.edge = 'bottom'; // its cables leave downwards
        }
        g.append(...els);
        return g;
      };
      foot.append(group(bottomIns), group(bottomOuts));
      out.push(foot);
    }
    return out;
  }

  /** the power button of a card: bypass on / off (the through input, or silence, replaces the module's outputs) */
  private bypassButton(m: ModuleInst, def: ModuleDef, card: HTMLElement): HTMLButtonElement {
    const b = this.button('⏻', `${def.label} on / off (bypass)`, () => {
      this.touch();
      m.bypass = !m.bypass;
      if (!m.bypass) delete m.bypass;
      card.classList.toggle('off', !!m.bypass);
      b.classList.toggle('on', !m.bypass);
      this.ev.onBypass(m.id, !!m.bypass);
    }, 'pw');
    b.classList.toggle('on', !m.bypass);
    b.setAttribute('aria-pressed', String(!m.bypass));
    return b;
  }

  /** one parameter slider (or check box); `label` overrides the name (a promoted parameter on an assembly card) */
  /** redraws the value of a parameter row (the synced delay shows its time as a note length) */
  private refreshers = new WeakMap<HTMLElement, () => void>();

  private paramRow(m: ModuleInst, def: ModuleDef, pd: ParamDef, o: { open?: AssemblyInst; label?: string; rename?: () => void; names?: string[]; ties?: number } = {}): HTMLElement {
    if (pd.screen) return this.screenRow(m, pd, o);
    const row = document.createElement('div');
    row.className = 'param bar';
    // a row the knobs can turn: a press on it puts its device page on Main's knobs (markFocus colours the bound ones)
    row.dataset.mod = String(m.id);
    row.dataset.param = pd.name;
    row.addEventListener('pointerdown', (e) => {
      if (e.altKey && this.addRowToList(m.id, pd.name)) { e.stopPropagation(); e.preventDefault(); return; }
      this.focusRow(m.id, pd.name);
    }, true);
    const name = document.createElement('span');
    name.textContent = o.label ?? longName(def.type, pd.name);
    // a card row that sets several parameters (#357): ×N on the collapsed card and on its first's member card, → the row's
    // name on the others
    const tie = o.open ? rowOf(o.open, m.id, pd.name) : undefined;
    const tieText = o.ties && o.ties > 1 ? `×${o.ties}` : tie?.also?.length ? (tie.module === m.id && tie.param === pd.name ? `×${tie.also.length + 1}` : `→ ${tie.label}`) : '';
    if (tieText) {
      const badge = document.createElement('span');
      badge.className = 'merged row-tie';
      badge.textContent = ` ${tieText}`;
      name.title = tieText.startsWith('×') ? `one row for ${tieText.slice(1)} parameters: turning it moves them all` : `set by the "${tie!.label}" row of the card`;
      name.append(badge);
    }
    // a Selector's position: over the positions in use (1..count, #358), by the names its card row gives them
    const range = (): ParamDef => rowRange(m.type, m.params, pd);
    const posNames = o.names && m.type === 'select' && pd.name === 'pos' ? o.names : undefined;
    const namesNow = (): string[] => Array.from({ length: range().max - pd.min + 1 }, (_, i) => posNames?.[i] || String(i + pd.min));
    /** a selector's index for a value: the choice, or a named position counted from the first */
    const off = posNames ? pd.min : 0;
    // an enum parameter is a selector (a detent rail, or a drum when the names do not fit) whose jack stands on the live choice
    const choice = (!!pd.choices && !pd.toggle) || !!posNames;
    // a switch has no thumb either: its jack stands the same way, above the check box
    const jacked = choice || !!pd.toggle;
    if (jacked) row.classList.add('choice');
    if (choice) row.classList.add('sel');
    if (pd.toggle) row.classList.add('toggle');
    let pickBox: HTMLElement | null = null; // pick mode's check box, last in the row (the name stays its first child)
    let rowTools: HTMLElement[] = []; // pick mode's tools for a row that sets several parameters or names positions
    if (o.open) {
      const a = o.open;
      const on = isPromoted(a, m.id, pd.name);
      row.classList.toggle('shown', on);
      this.promoteClick(row, a, () => (on ? demote(a, m.id, pd.name) : promote(a, m.id, pd.name, this.patch)), { module: m.id, param: pd.name });
      if (this.picking(a)) {
        pickBox = this.pickBox(on);
        rowTools = this.rowTools(a, m, pd);
      }
    }
    if (o.rename) {
      name.title = 'click to rename';
      name.classList.add('rename');
      name.onclick = (e) => {
        e.preventDefault();
        o.rename!();
      };
    }
    const val = document.createElement('output');
    // the number and its unit apart: the unit is drawn smaller (labels.ts formatValue)
    const parts = (v: number, params = m.params): { num: string; unit: string } =>
      pd.altText && params[pd.altText.when] >= 0.5 ? { num: pd.altText.text(v, params), unit: '' }
        : pd.choices ? { num: choiceName(def.type, pd.name, pd.choices[Math.round(v)] ?? ''), unit: '' }
        : posNames ? { num: namesNow()[Math.round(v) - off] ?? String(Math.round(v)), unit: '' }
        : formatValue(v, pd.unit, pd.min < 0);
    const fmt = (v: number, params = m.params): string => { const p = parts(v, params); return p.unit ? `${p.num} ${p.unit}` : p.num; };
    let shown = '';
    const show = (v: number, params = m.params): void => {
      const text = fmt(v, params);
      if (text === shown) return;
      shown = text;
      const p = parts(v, params);
      if (!p.unit) { val.textContent = p.num; return; }
      const unit = document.createElement('span');
      unit.className = 'unit';
      unit.textContent = p.unit;
      val.replaceChildren(p.num, unit);
    };
    show(m.params[pd.name]);
    this.refreshers.set(row, () => show(m.params[pd.name]));
    const input = document.createElement('input');
    input.type = 'range';
    if (pd.log) {
      // a logarithmic parameter: the slider position is the fraction of the octaves
      input.min = '0';
      input.max = '1000';
      input.step = '1';
      input.value = String(Math.round(toUnit(pd, m.params[pd.name]) * 1000));
    } else {
      input.min = String(pd.min);
      input.max = String(topOf(range())); // (the browser-only stretch too: the Delay's time to 1.6 s; a Selector's positions in use)
      input.step = String(pd.step ?? (pd.max - pd.min) / 200);
      input.value = String(m.params[pd.name]);
    }
    input.setAttribute('aria-label', `${def.label} ${o.label ?? pd.name}`);
    // The thumb shows the live (modulated) value; a tick on the track marks the base. A drag moves the base by the
    // thumb's travel, so the live value stays under the pointer: `offset` = thumb - base at the start of the edit, in
    // slider units. Pointer capture also releases the edit lock when a drag ends outside the card.
    let editing = false;
    let offset = 0;
    const posOf = (v: number): number => (pd.log ? Math.round(toUnit(pd, v) * 1000) : v);
    /** a value's place on the slider, 0..1 (its track spans the browser-only stretch too) */
    const trackOf = (v: number): number => (pd.log ? toUnit(pd, v) : (v - pd.min) / (topOf(range()) - pd.min));
    const begin = (): void => {
      if (!editing) offset = Number(input.value) - posOf(m.params[pd.name]);
      editing = true;
    };
    input.onpointerdown = (e) => {
      if (e.altKey && (pd.input || def.paramInputs) && !pd.toggle) return;
      begin();
      input.setPointerCapture(e.pointerId);
    };
    input.onpointerup = input.onpointercancel = input.onlostpointercapture = () => { editing = false; };
    input.onkeydown = (e) => {
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown', ' '].includes(e.key)) begin();
    };
    input.onkeyup = input.onblur = () => { editing = false; };
    // the value before the latest gesture began: a double-click's first press moves the thumb, typing puts it back
    let gestureFrom = m.params[pd.name];
    let lastInput = 0;
    input.oninput = () => {
      // a pinch took over from the finger on the slider (touchGestures put the value back): the thumb stays
      if (this.pinching) {
        input.value = String(posOf(m.params[pd.name]) + offset);
        return;
      }
      const now = performance.now();
      if (now - lastInput > TYPE_GAP_MS) gestureFrom = m.params[pd.name];
      lastInput = now;
      const pos = Math.min(Number(input.max), Math.max(Number(input.min), Number(input.value) - offset));
      const v = pd.log ? snapTo(pd, fromUnit(pd, pos / 1000)) : Number(pos.toFixed(6));
      if (m.params[pd.name] !== v) this.touch();
      m.params[pd.name] = v;
      // the text follows the thumb: the base itself, or with modulation the live value the drag holds under the pointer
      // (the engine's reports run a poll behind, so they are not shown until the edit ends)
      const at = Number(input.value);
      show(!offset ? v : pd.log ? snapTo(pd, fromUnit(pd, at / 1000)) : Number(at.toFixed(6)));
      thumb?.setBase(offset ? trackOf(v) : null);
      if (def.params.some((q) => q.altText?.when === pd.name)) for (const el of row.parentElement?.children ?? []) this.refreshers.get(el as HTMLElement)?.(); // (the LFO's range: how its rate shows)
      this.ev.onParam(m.id, pd.name, v);
      this.mirror(m.id, pd.name, v);
      this.chipsSoon();
      this.syncDials();
      this.relock(m.id);
    };
    if (m.type === ALLOC && pd.name === 'voices') input.addEventListener('change', () => this.rebuild()); // the ×N badges follow
    if (pd.toggle) {
      input.type = 'checkbox';
      input.checked = m.params[pd.name] >= 0.5;
      input.oninput = () => {
        const v = input.checked ? 1 : 0;
        this.touch();
        m.params[pd.name] = v;
        show(v);
        for (const el of row.parentElement?.children ?? []) this.refreshers.get(el as HTMLElement)?.(); // a toggle can change how its siblings show (altText)
        this.ev.onParam(m.id, pd.name, v);
        this.mirror(m.id, pd.name, v);
        this.chipsSoon();
        this.syncDials();
        this.relock(m.id);
      };
    }
    // a thumb or a picker is a jack only where a cable dropped on it has somewhere to go: the module's parameter inputs,
    // the parameter's dedicated input, or a side input already routed to it
    const canPatch = !!def.paramInputs || !!pd.input || parameterInputs(m, pd).length > 0;
    const thumb = canPatch && !pd.toggle && !choice ? sliderJack(input, (e, jack) => this.beginDrag(e, jack)) : null;
    // a slider with nothing to patch keeps the bar and a plain thumb (not a jack: no cable lands on it)
    const plain = !thumb && !pd.toggle && !choice ? sliderJack(input, () => {}) : null;
    plain?.jack.classList.replace('slider-port', 'slider-thumb');
    // the selector: its jack is the live choice's marker (routes and cables end on it, as on a slider's thumb)
    const sel = choice ? selector({
      label: longName(def.type, pd.name),
      names: posNames ? namesNow() : pd.choices!.map((c) => choiceName(def.type, pd.name, c)),
      get: () => Math.round(m.params[pd.name]) - off,
      set: (i) => {
        if (row.classList.contains('locked')) return;
        input.value = String(i + off);
        input.dispatchEvent(new Event('input'));
      },
      onPatch: canPatch ? (e, jack) => this.beginDrag(e, jack) : undefined,
    }) : null;
    if (sel && canPatch) {
      sel.jack.dataset.mod = String(m.id);
      sel.jack.dataset.param = pd.name;
      sel.jack.dataset.dir = 'in';
      sel.jack.title = `${def.label} ${longName(def.type, pd.name)}: drop a cable here to modulate it (depth in the ⋮ menu).`;
      this.sliderPorts.push({ m, pd, jack: sel.jack, ticks: sel.setKnobTicks });
    }
    // a switch's thumb is its jack: the same role as a slider's thumb (routes and cables end on it); it slides with the
    // switch's live state. A press switches; Alt, or a cable being patched, patches
    const pickJack = canPatch && pd.toggle ? document.createElement('span') : null;
    if (pickJack) {
      pickJack.className = 'dot control slider-port tog-jack';
      pickJack.dataset.mod = String(m.id);
      pickJack.dataset.param = pd.name;
      pickJack.dataset.dir = 'in';
      pickJack.title = `${def.label} ${longName(def.type, pd.name)}: drop a cable here to modulate it (depth in the ⋮ menu).`;
      pickJack.addEventListener('pointerdown', (e) => {
        if (e.altKey || pickJack.closest('.patching')) this.beginDrag(e, pickJack);
      });
      this.sliderPorts.push({ m, pd, jack: pickJack, ticks: () => {} });
    }
    const gesture = thumb ? 'Drag to adjust; Alt-drag to patch. Drop a cable on the thumb to connect.' : '';
    input.title = gesture;
    if (thumb) {
      thumb.jack.dataset.mod = String(m.id);
      thumb.jack.dataset.param = pd.name;
      thumb.jack.dataset.dir = 'in';
      thumb.jack.title = `${def.label} ${longName(def.type, pd.name)}: ${gesture}`;
      this.sliderPorts.push({ m, pd, jack: thumb.jack, ticks: thumb.setKnobTicks });
      input.addEventListener('input', () => this.positionCables());
    }
    this.parameterDisplays.push({ id: m.id, update: (values) => {
      const base = m.params[pd.name];
      const v = values?.[pd.name] ?? base;
      if (!Number.isFinite(v)) return;
      const automated = Math.abs(v - base) > 1e-6;
      const text = fmt(v, values ?? m.params);
      if (!editing) {
        const position = String(posOf(v));
        if (pd.toggle) input.checked = v >= 0.5;
        else if (input.value !== position) input.value = position;
        thumb?.update();
        thumb?.setBase(automated ? trackOf(base) : null);
        sel?.update(Math.round(v) - off, Math.round(base) - off);
        input.title = automated ? `Live: ${text}. Base: ${fmt(base)}. ${gesture || 'Drag to edit the base value.'}` : gesture;
      }
      if (editing) return; // the edit shows its own value (oninput); a report taken before the last move would set it back
      show(v, values ?? m.params);
      input.setAttribute('aria-valuetext', text);
      row.classList.toggle('automated', automated);
    } });
    row.append(name, choice ? sel!.element : pd.toggle ? document.createElement('span') : val);
    if (canPatch) {
      const key = `${m.id}:${pd.name}`;
      row.append(parameterMenu(m, def, pd, { ...this.ev, patch: () => this.patch, change: (fn) => this.change(fn), touch: () => this.touch() }, this.routingOpen.has(key), (on) => {
        if (on) {
          this.routingOpen.clear();
          this.routingOpen.add(key);
          for (const other of this.modulesEl.querySelectorAll<HTMLDetailsElement>('.parameter-routing[open]'))
            if (other.parentElement !== row) other.open = false;
        } else this.routingOpen.delete(key);
        this.drawCables();
      }));
    }
    // a selector moves the base value through the hidden range input, so editing, undo and Live work as for a slider
    if (pd.toggle) {
      const line = document.createElement('label');
      line.className = 'toggle-line';
      const sw = document.createElement('span');
      sw.className = 'tog-switch';
      sw.append(input, ...(pickJack ? [pickJack] : []));
      line.append(sw, val);
      row.append(line);
    } else if (!choice) row.append(thumb?.element ?? plain?.element ?? input);
    if (plain) this.parameterDisplays.push({ id: m.id, update: () => { if (!editing) plain.update(); } });
    if (pickBox) row.append(pickBox, ...rowTools);
    // a parameter with no effect in the module's current setting is dimmed and takes no direct edits (relevance.ts);
    // cables still reach its jack
    const relock = (): void => {
      if (range() !== pd && !pd.log) {   // a Selector's position: its count moved, so do the range and the names
        input.max = String(range().max);
        sel?.setNames(namesNow());
      }
      const why = lockOf(this.patch, m, def.params, pd.name);
      row.classList.toggle('locked', !!why);
      input.disabled = !!why;
      if (why) row.title = why;
      else row.removeAttribute('title');
    };
    relock();
    this.lockers.push({ id: m.id, run: relock });
    if (!pd.toggle) {
      const names = pd.choices?.map((c) => choiceName(def.type, pd.name, c));
      const type = (): void => {
        if (row.classList.contains('locked') || row.querySelector('.val-edit')) return;
        if (performance.now() - lastInput < TYPE_GAP_MS * 2 && m.params[pd.name] !== gestureFrom) this.setParam(m.id, pd.name, gestureFrom);
        this.endGesture(); // the double-click's own presses (moved and put back) leave no step
        this.typeValue(row, fmt(m.params[pd.name]), (text) => {
          if (posNames) {   // a named position: by its name, or its number
            const i = parseValue(text, { ...pd, choices: namesNow() }, namesNow());
            if (i === null) return false;
            this.setParam(m.id, pd.name, i + off);
            this.endGesture();
            return true;
          }
          let v = parseValue(text, range(), names);
          if (v === null) return false;
          if (pd.log) v = snapTo(pd, v);
          this.setParam(m.id, pd.name, v);
          this.endGesture();
          return true;
        });
      };
      this.typers.set(row, type);
      row.addEventListener('dblclick', (e) => {
        if ((e.target as Element).closest('.parameter-routing, .pickbox, .rename')) return;
        e.preventDefault();
        type();
      });
    }
    return row;
  }

  /** the rows' lock checks (relevance.ts), run again when a parameter of their module changes */
  private lockers: { id: number; run: () => void }[] = [];
  private relock(id: number): void {
    for (const l of this.lockers) if (l.id === id) l.run();
  }

  /** the bars that take a typed value, by row (Tab moves on to the next one in the card) */
  private typers = new WeakMap<HTMLElement, () => void>();

  /**
   * A text field over a parameter's bar: Enter sets what `commit` reads (false: it could not, the field stays with a red
   * edge), Esc or leaving it cancels, Tab / Shift+Tab set and move to the next / previous bar of the card.
   */
  private typeValue(row: HTMLElement, text: string, commit: (text: string) => boolean): void {
    const field = document.createElement('input');
    field.type = 'text';
    field.className = 'val-edit';
    field.value = text;
    field.spellcheck = false;
    field.setAttribute('aria-label', `Type a value for ${row.querySelector('span')?.textContent ?? 'the parameter'}`);
    field.title = 'Enter sets it, Esc cancels. Units work: 2k, 440 Hz, 120 ms, 50 %, a choice by name.';
    let closed = false;
    const close = (): void => {
      if (closed) return;
      closed = true;
      field.remove();
    };
    field.addEventListener('keydown', (e) => {
      e.stopPropagation(); // not a note key or a shortcut
      if (e.key === 'Escape') { e.preventDefault(); close(); return; }
      if (e.key !== 'Enter' && e.key !== 'Tab') return;
      e.preventDefault();
      if (!commit(field.value)) { field.classList.add('bad'); return; }
      close();
      if (e.key !== 'Tab') return;
      const rows = [...(row.closest('.module, .dock-main') ?? this.modulesEl).querySelectorAll<HTMLElement>('.param.bar')].filter((r) => this.typers.has(r) && !r.classList.contains('locked'));
      const next = rows[rows.indexOf(row) + (e.shiftKey ? -1 : 1)];
      if (next) this.typers.get(next)!();
    });
    field.addEventListener('input', () => field.classList.remove('bad'));
    field.addEventListener('blur', close);
    for (const ev of ['pointerdown', 'dblclick'] as const) field.addEventListener(ev, (e) => e.stopPropagation());
    row.append(field);
    field.focus();
    field.select();
  }

  /** the open flaws card (flaws-panel.ts), if any */
  private flawPanel: FlawPanel | null = null;

  /** open the flaws card of poly assembly `a` under `anchor`: slider moves play at once, a release is one undo step */
  private openFlaws(a: AssemblyInst, anchor: HTMLElement): void {
    const was = this.flawPanel;
    was?.close();
    const id = a.id;
    let before: string | null = null;
    let frame = 0;
    const cfg = (): { cards: PolyCards; parts: number; fed: boolean } | null => {
      const x = assembliesOf(this.patch).find((y) => y.id === id);
      return x?.poly ? { cards: x.poly, parts: this.voicesOfAsm(x), fed: polyGroups(this.patch).some((g) => g.asm.id === id) } : null;
    };
    this.flawPanel = new FlawPanel(
      {
        title: a.label,
        cfg,
        edit: (fn) => {
          const c = cfg();
          if (!c) return;
          this.touch();
          before ??= this.snap();
          fn(c.cards, c.parts);
          if (!frame) frame = requestAnimationFrame(() => {
            frame = 0;
            this.ev.onStructure(this.patch);
          });
        },
        commit: () => {
          if (before === null) return;
          this.endGesture();
          before = null;
          this.rebuild();
          this.ev.onStructure(this.patch);
        },
        closed: () => {
          if (this.flawPanel?.el.isConnected === false) this.flawPanel = null;
        },
      },
      anchor.getBoundingClientRect(),
    );
  }

  /** how many voices run a poly assembly's cards: its allocator's (1 when no allocator feeds it) */
  private voicesOfAsm(a: AssemblyInst): number {
    return polyGroups(this.patch).find((g) => g.asm.id === a.id)?.cfg.parts ?? 1;
  }

  /**
   * A poly assembly's voice control: a drop-down in its header that opens the voice cards' flaws (flaws-panel.ts), with how
   * many voices run the cards (the Voice allocator's) at its top. Marked when no allocator feeds the cards (they run once).
   */
  private voiceControlButton(a: AssemblyInst): HTMLButtonElement {
    const g = polyGroups(this.patch).find((x) => x.asm.id === a.id);
    const parts = g?.cfg.parts ?? 1;
    const n = Array.from({ length: parts }, (_, i) => flawOf(a.poly!, i)).filter((f) => !isFlawless(f)).length;
    const b = this.button('voices ▾', g
      ? `Voice control: each voice card's own detune, drift, brightness, envelope time and level (${n ? `${n} of ${parts} set` : 'all alike'})`
      : `No ${DEFS[ALLOC].label} feeds these cards, so they run once. Patch an allocator's outputs (pitch, gate, …) into them, and Main's keys into the allocator.`,
    () => {
      if (this.flawPanel?.el.isConnected) return this.flawPanel.close();
      this.openFlaws(a, b);
    }, 'sm vc-btn');
    b.classList.toggle('over', !g);
    b.classList.toggle('set', n > 0);
    b.setAttribute('aria-haspopup', 'dialog');
    b.dataset.asm = String(a.id);
    b.dataset.setting = 'flaws';
    return b;
  }

  /** the morph picker: the B side of the patch (another patch of the same structure); the `morph` slider above fades every parameter A -> B */
  private morphRow(): HTMLElement {
    const row = document.createElement('div');
    row.className = 'param bar morph-row';
    const name = document.createElement('span');
    name.textContent = 'B side';
    const cands = (this.ev.morphCandidates?.(this.patch) ?? []).filter((c) => sameStructure(this.patch, c.patch));
    // index 0 = none, then the candidates; the current B side is matched by name (it is a copy of a candidate's values)
    const current = (): number => (hasMorph(this.patch) ? cands.findIndex((c) => c.name === this.patch.morphName) + 1 : 0);
    const names = ['none', ...cands.map((c) => c.name)];
    // a B side that is no longer among the candidates (renamed, deleted) still shows its name
    if (hasMorph(this.patch) && current() === 0) names[0] = this.patch.morphName ?? 'set';
    row.classList.add('choice', 'sel');
    const sel = selector({
      label: 'B side', names, get: current,
      set: (i) => this.change(() => {
        if (i === 0) clearMorph(this.patch);
        else setMorphTarget(this.patch, cands[i - 1].patch, DEFS);
      }),
    });
    const show = (): void => {
      const has = hasMorph(this.patch);
      sel.update(current(), current());
      row.title = has
        ? `The morph slider fades every parameter from this patch (A) to "${this.patch.morphName ?? 'B'}" (B): in octaves for a logarithmic one, a choice or switch flips at 0.5. The Main module's morph input adds to the slider (an LFO morphs the patch). Choose "none" to drop the B side.`
        : cands.length
          ? 'Pick a patch with the same modules and cables as the B side; the morph slider then fades every parameter from this patch to it.'
          : 'No stored patch has the same modules and cables as this one. Save this patch under another name, change its sounds, and pick that copy here.';
    };
    show();
    row.append(name, sel.element);
    return row;
  }

  /** the transport runs (editor state: the Play switch, Space) */
  playing = false;

  // ---- zoom and touch: the cards and cables are scaled by `zoom`; offsets stay in layout pixels, pointer deltas are divided by it

  zoom = 1;
  /** `live`: the zoom slider's source moved it, not the user */
  onZoom: (z: number, live: boolean) => void = () => {};

  setZoom(z: number, live = false): void {
    // the user's zoom is in whole percent; a source's (live) is not rounded, so a small wobble stays smooth
    const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, live ? z : Math.round(z * 100) / 100));
    if (live && next === this.zoom) return;
    this.zoom = next;
    if (!live) {
      this.userZoom = next;
      this.queueView();
    }
    this.world.style.transform = this.zoom === 1 ? '' : `scale(${this.zoom})`;
    this.sizeCanvas();
    // a live zoom only moves the cables' ends (the same cables); the user's redraws them
    if (live) this.positionCables();
    else this.drawCables();
    this.onZoom(this.zoom, live);
  }

  /** the layout tidyUp made last: tidy reads the columns from the layout, so it is left alone until something moves or resizes */
  private tidied = '';
  /** the cards' places and sizes, the frames' and which assemblies are open */
  private layoutKey(): string {
    const sz = this.tidySizes();
    return JSON.stringify([
      this.patch.modules.map((m) => [m.id, m.x, m.y, sz.module(m.id)]),
      assembliesOf(this.patch).map((a) => [a.id, a.x, a.y, a.open, a.frameSize, sz.container(a.id)]),
    ]);
  }

  /** a patch that opens as a pile (a share link without its layout): tidied with the cards as drawn, part of the load */
  private untangle(): void {
    const docked = this.docked();
    const skip = new Set(docked ? [docked.id] : []);
    if (!isPile(this.patch, this.tidySizes(), skip)) return;
    tidy(this.patch, this.tidySizes(), skip);
    this.rebuild();
    this.tidied = this.layoutKey();
  }

  /** Tidy up: pack the cards, keeping their columns' order (tidy.ts); one undo step */
  tidyUp(): void {
    if (this.layoutKey() === this.tidied) return this.ev.onError('already tidy');
    const before = this.mark();
    const docked = this.docked();
    tidy(this.patch, this.tidySizes(), new Set(docked ? [docked.id] : []));
    const changed = this.commit(before);
    this.tidied = this.layoutKey();
    if (!changed) return this.ev.onError('already tidy');
    this.rebuild();
    this.canvas.scrollTo(0, 0);
    this.ev.onLayout(this.patch);
  }

  /** how far the cables sag (0..1): redraws them */
  setSlack(v: number): void {
    this.slack = Math.min(1, Math.max(0, v));
    this.positionCables();
  }

  /** the slack source's latest value (the host's watch of Patch.slackFrom): redraws the cables once per frame */
  modulateSlack(v: number): void {
    this.slackMod = this.patch.slackFrom ? v : 0;
    if (this.slackFrame) return;
    this.slackFrame = requestAnimationFrame(() => {
      this.slackFrame = 0;
      this.positionCables();
    });
  }

  /** patch an output into a sidebar slider (null: unplug it); an undo step, no engine reload */
  setSideSource(key: SideKey, from: Endpoint | null): void {
    const before = this.mark();
    if (from) this.patch[key] = { ...from };
    else delete this.patch[key];
    if (!this.commit(before)) return;
    if (key === 'slackFrom' && !from) this.slackMod = 0;
    this.rebuild();
    this.ev.onLayout(this.patch);
  }

  /** the zoom, holding a point in place: `at` (client px: the pointer, for the wheel and pinch) or else the canvas's centre (the
   *  zoom slider and its source); `live`: a modulation, not the user's */
  zoomAround(z: number, live = false, at?: Pt): void {
    const c = this.canvas;
    const r = c.getBoundingClientRect();
    const px = at ? at.x - r.left - c.clientLeft : c.clientWidth / 2, py = at ? at.y - r.top - c.clientTop : c.clientHeight / 2;
    const cx = (c.scrollLeft + px) / this.zoom, cy = (c.scrollTop + py) / this.zoom;
    const was = this.zoom;
    this.setZoom(z, live);
    if (this.zoom === was) return;
    c.scrollLeft = cx * this.zoom - px;
    c.scrollTop = cy * this.zoom - py;
  }

  /** every card in view: the zoom that fits the cards' extent into the canvas, scrolled to its top left */
  zoomToFit(): void {
    const elements = [...this.cards.values(), ...this.containers.values(), ...this.frames.values()];
    if (!elements.length) return;
    const PAD = 24;
    // an open frame's cables run in a gutter round it (ribbons.ts): fit that too
    const out = (el: HTMLElement): number => (el.classList.contains('frame') ? GUTTER_ROOM : 0);
    const x0 = Math.max(0, Math.min(...elements.map((el) => el.offsetLeft - out(el))) - PAD);
    const y0 = Math.max(0, Math.min(...elements.map((el) => el.offsetTop - out(el))) - PAD);
    const w = Math.max(...elements.map((el) => el.offsetLeft + el.offsetWidth + out(el))) + PAD - x0;
    const h = Math.max(...elements.map((el) => el.offsetTop + el.offsetHeight + out(el))) + PAD - y0;
    this.setZoom(Math.min(1.5, this.canvas.clientWidth / w, this.canvas.clientHeight / h));
    this.canvas.scrollTo(x0 * this.zoom, y0 * this.zoom);
  }

  /** two fingers are (or were, until every finger is up) on the canvas: the view's, no control's */
  private pinching = false;
  /** stops what one finger on the canvas is doing (a card drag, a pan) without finishing it: a second finger takes over */
  private oneFinger: (() => void) | null = null;

  /**
   * Touch (#153): a two-finger pinch zooms around the fingers' midpoint and a two-finger drag pans, wherever the fingers
   * start (.canvas has touch-action: none, so the browser leaves the gesture to us). The listeners are in the capture
   * phase, so fingers on controls that stop propagation count too. When the second finger lands, what the first one did is
   * put back: a card drag or a slider's change (the open gesture's snapshot), a cable being drawn. A pinch is only the
   * view, never an undo step. Ctrl / Cmd + wheel zooms (trackpads).
   */
  private touchGestures(): void {
    const pts = new Map<number, Pt>();
    let pinch: Pinch | null = null;
    let prev: [Pt, Pt] | null = null;
    this.canvas.addEventListener('wheel', (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      this.zoomAround(this.zoom * Math.exp(-e.deltaY / 400), false, { x: e.clientX, y: e.clientY });
    }, { passive: false });
    const two = (): [Pt, Pt] => [...pts.values()].slice(0, 2) as [Pt, Pt];
    this.canvas.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch') return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size < 2) return;
      // the second finger (or a third) starts nothing of its own
      e.stopImmediatePropagation();
      e.preventDefault();
      if (!this.pinching) {
        this.pinching = true;
        this.undoFirstFinger();
      }
      prev = two();
      pinch = pinchStart(prev[0], prev[1], this.zoom);
    }, true);
    const end = (e: PointerEvent): void => {
      if (!pts.delete(e.pointerId)) return;
      if (pts.size < 2) pinch = prev = null;
      else {
        prev = two();
        pinch = pinchStart(prev[0], prev[1], this.zoom);
      }
      if (!pts.size) this.pinching = false;
    };
    // (on the window: a finger lifted off the canvas, or one whose card the undo rebuilt, still ends)
    window.addEventListener('pointerup', end, true);
    window.addEventListener('pointercancel', end, true);
    window.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'touch' || !pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (!pinch || !prev) return;
      e.preventDefault();
      const now = two();
      const s = pinchStep(pinch, prev, now, ZOOM_MIN, ZOOM_MAX);
      prev = now;
      this.canvas.scrollBy(s.pan.x, s.pan.y);
      this.zoomAround(s.zoom, false, s.at);
    }, true);
  }

  /** a second finger landed: put back what the first one did on the canvas */
  private undoFirstFinger(): void {
    this.oneFinger?.();
    this.oneFinger = null;
    this.cancelArm(); // a cable being drawn
    const before = this.gesture;
    if (before === null || !this.gesturePointer) return;
    if (before === this.snap()) this.dropGesture();
    else this.restore(before); // a card dragged, a slider moved
  }

  /** a long press on a card header (touch): the context actions */
  private contextMenu(m: ModuleInst, def: ModuleDef, at: Pt): void {
    const items: MenuItem[] = [];
    if (def.type !== 'fm1' && def.type !== 'output') items.push({ text: m.bypass ? 'Turn on' : 'Bypass', key: 'B', run: () => {
      this.selected.clear();
      this.selected.add(m.id);
      this.bypassSelected();
    } });
    items.push({ text: 'Duplicate', key: '⌘D', run: () => {
      this.selected.clear();
      this.selected.add(m.id);
      this.duplicateSelected();
    } });
    items.push({ text: 'Select', run: () => {
      this.selected.add(m.id);
      this.showSelection();
    } });
    items.push({ text: 'Delete', key: 'Del', danger: true, rule: true, run: () => this.change(() => removeModule(this.patch, m.id)) });
    this.popMenu(items, at);
  }

  /** an assembly's menu (its header's ⋯, a right-click on its header) */
  private assemblyMenu(a: AssemblyInst, at: Pt): void {
    this.popMenu([
      { text: a.open ? 'Collapse' : 'Expand', key: a.open ? '▾' : '▸', run: () => this.toggleOpen(a) },
      { text: 'Choose what the card shows', run: () => {
        if (!a.open) this.toggleOpen(a);
        this.pickAsm = a.id;
        this.rebuild();
      } },
      { text: this.arrangeAsm === a.id ? 'Done arranging' : 'Arrange the card', run: () => {
        if (this.arrangeAsm === a.id) return void this.endPick();
        this.pickAsm = null;
        this.arrangeAsm = a.id;
        if (a.open) this.toggleOpen(a);
        else this.rebuild();
      } },
      { text: 'Rename', key: 'dbl-click', run: () => this.rename(a) },
      { text: 'Save to library', rule: true, run: () => this.saveAssembly(a) },
      ...(parentOf(this.patch, a.id) ? [] : this.presetItems(a)),
      { text: 'Ungroup', run: () => this.change(() => ungroup(this.patch, a.id)) },
      { text: 'Delete with its modules', danger: true, rule: true, run: () => this.change(() => deleteAssembly(this.patch, a.id)) },
    ], at);
  }

  /** the sizes Tidy up works with: the cards as drawn, a grid cell when one is not drawn */
  private tidySizes(): Parameters<typeof tidy>[1] {
    const size = (el: HTMLElement | undefined): { w: number; h: number } => ({ w: el?.offsetWidth || CARD_W, h: el?.offsetHeight || CARD_H });
    return {
      module: (id) => size(this.cards.get(id)),
      container: (id) => size(this.containers.get(id)),
      frame: () => ({ pad: FRAME_PAD, padX: FRAME_PAD_X, head: FRAME_HEAD, minW: 0 }),
    };
  }

  /** what opening `a` does to the layout: spread stacked members, make room for the copies, keep the frame on the canvas */
  private openLayout(a: AssemblyInst): void {
    if (overlapping(this.patch, a)) tileMembers(this.patch, a); // stacked cards (an old file, members added at one spot) spread out
    if (a.poly) makeRoom(this.patch, a);
    // the frame's header goes above the members: move them down when it would stick out of the canvas's top
    const ys = allModules(this.patch, a).map((id) => this.patch.modules.find((m) => m.id === id)?.y ?? Infinity);
    const room = FRAME_PAD + FRAME_HEAD + 8;
    if (Math.min(...ys) < room) moveAssembly(this.patch, a, 0, room - Math.min(...ys));
    // and right of the canvas's left edge, with room for the cables running round it (ribbons.ts)
    const xs = allModules(this.patch, a).map((id) => this.patch.modules.find((m) => m.id === id)?.x ?? Infinity);
    const roomX = FRAME_PAD_X + GUTTER_ROOM;
    if (Math.min(...xs) < roomX) moveAssembly(this.patch, a, roomX - Math.min(...xs), 0);
  }

  /** tidy the insides of assemblies opened for the first time this session, innermost first, once their cards have a size
   * (after rebuild's own frame: part of the expansion's undo step, not one of its own) */
  private tidyFirstOpened(ids: number[]): void {
    if (!ids.length) return;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const before = JSON.stringify(this.patch);
      const list = ids.map((id) => assembliesOf(this.patch).find((x) => x.id === id)).filter((x): x is AssemblyInst => !!x?.open);
      list.sort((u, v) => depthOf(this.patch, v) - depthOf(this.patch, u));
      for (const a of list) tidyAssembly(this.patch, a, this.tidySizes());
      if (JSON.stringify(this.patch) === before) return;
      this.rebuild();
      this.ev.onLayout(this.patch);
    }));
  }

  /** expand or collapse an assembly; its first expansion in a session tidies the inside once the cards have a size */
  private toggleOpen(a: AssemblyInst): void {
    const first = !a.open && !this.expandedOnce.has(a.id);
    const opened = this.change(() => {
      a.open = !a.open;
      if (a.open) this.openLayout(a);
    });
    if (!opened || !a.open) return;
    for (const x of [a, ...descendants(this.patch, a)]) this.expandedOnce.add(x.id);
    if (first) this.tidyFirstOpened([a.id]);
  }

  /** expand or collapse every assembly, nested ones too, as one undo step (the sidebar's EXPAND / COLLAPSE) */
  setAllOpen(open: boolean): void {
    const list = [...assembliesOf(this.patch)].sort((u, v) => depthOf(this.patch, u) - depthOf(this.patch, v)); // outermost first
    const first = open ? list.filter((a) => !a.open && !this.expandedOnce.has(a.id)).map((a) => a.id) : [];
    const changed = this.change(() => {
      for (const a of list) {
        if (a.open === open) continue;
        a.open = open;
        if (open) this.openLayout(a);
      }
    });
    if (!changed || !open) return;
    for (const a of list) this.expandedOnce.add(a.id);
    this.tidyFirstOpened(first);
  }


  /** a header's ⋯: opens the card's menu under it */
  private moreButton(open: (at: Pt) => void): HTMLButtonElement {
    const b = this.button('⋯', 'Menu (also right-click the header)', () => {
      const r = b.getBoundingClientRect();
      const w = this.world.getBoundingClientRect();
      open({ x: (r.right - w.left) / this.zoom - 190, y: (r.bottom - w.top) / this.zoom + 4 });
    }, 'more');
    return b;
  }

  /** right-click on a header opens its menu at the pointer */
  private headMenu(head: HTMLElement, open: (at: Pt) => void): void {
    head.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const w = this.world.getBoundingClientRect();
      open({ x: (e.clientX - w.left) / this.zoom, y: (e.clientY - w.top) / this.zoom });
    });
  }

  /** a small menu at a canvas point; a press anywhere else closes it */
  private popMenu(items: MenuItem[], at: Pt): void {
    document.querySelector('.ctx')?.remove();
    const menu = document.createElement('div');
    menu.className = 'ctx';
    menu.setAttribute('role', 'menu');
    for (const it of items) {
      const b = document.createElement('button');
      b.setAttribute('role', 'menuitem');
      b.className = (it.danger ? 'danger' : '') + (it.rule ? ' rule' : '');
      const label = document.createElement('span');
      label.textContent = it.text;
      b.append(label);
      if (it.key) {
        const k = document.createElement('kbd');
        k.textContent = it.key;
        b.append(k);
      }
      b.onclick = (e) => {
        e.stopPropagation();
        menu.remove();
        it.run();
      };
      menu.append(b);
    }
    Object.assign(menu.style, { left: `${Math.max(0, at.x)}px`, top: `${Math.max(0, at.y)}px` });
    this.modulesEl.append(menu);
    const away = (e: Event): void => {
      if (!menu.contains(e.target as Node)) {
        menu.remove();
        window.removeEventListener('pointerdown', away, true);
      }
    };
    setTimeout(() => window.addEventListener('pointerdown', away, true));
  }

  // ---- keyboard actions (main.ts shortcuts): the selection

  /** remove the selected modules (and their cables) */
  removeSelected(): boolean {
    const { mods, asms } = this.dragSet();
    if (!mods.length && !asms.length) return false;
    return this.change(() => {
      for (const a of asms) deleteAssembly(this.patch, a.id);
      for (const m of mods) if (this.patch.modules.includes(m)) removeModule(this.patch, m.id);
    });
  }

  /** flip the bypass of the selected modules (all on if any was off) */
  bypassSelected(): boolean {
    const { mods, asms } = this.dragSet();
    const inside = new Set(asms.flatMap((a) => allModules(this.patch, a)));
    const ms = this.patch.modules.filter((m) => (mods.includes(m) || inside.has(m.id)) && m.type !== 'fm1' && m.type !== 'output');
    if (!ms.length) return false;
    const on = ms.some((m) => !m.bypass);
    this.touch();
    for (const m of ms) {
      if (on) m.bypass = true;
      else delete m.bypass;
      this.ev.onBypass(m.id, on);
    }
    this.rebuild();
    this.ev.onLayout(this.patch);
    return true;
  }

  /** move the selected cards by (dx, dy) pixels */
  nudgeSelected(dx: number, dy: number): boolean {
    const set = this.dragSet();
    if (!set.mods.length && !set.asms.length) return false;
    this.touch();
    for (const m of set.mods) {
      m.x = Math.max(0, m.x + dx);
      m.y = Math.max(0, m.y + dy);
    }
    for (const a of set.asms) moveAssembly(this.patch, a, dx, dy);
    this.rebuild();
    this.ev.onLayout(this.patch);
    return true;
  }

  /** copies of the selected modules with their parameters, matrix and the cables among them, placed below the originals and selected */
  duplicateSelected(): boolean {
    const set = this.dragSet();
    const ids = set.mods.filter((m) => m.type !== 'fm1').map((m) => m.id);
    if (!ids.length && !set.asms.length) return false;
    return this.change(() => {
      // a selected assembly is copied through its definition, collapsed, below where it is
      const asmCopies = set.asms.map((a) => {
        const box = a.open ? this.frameRect(a) : { x: a.x, y: a.y, h: this.containers.get(a.id)?.offsetHeight ?? CARD_H / 2 };
        return insertAssembly(this.patch, DEFS, toDef(this.patch, a), box?.x ?? a.x, (box?.y ?? a.y) + Math.min(CARD_H / 2, (box?.h ?? 0) + 24)).id;
      });
      const map = new Map<number, number>();
      for (const id of ids) {
        const m = this.patch.modules.find((x) => x.id === id)!;
        const copy = addModule(this.patch, DEFS[m.type], m.x, m.y + CARD_H / 2);
        copy.params = { ...m.params };
        if (m.att) copy.att = [m.att[0], m.att[1]];
        if (m.map) copy.map = JSON.parse(JSON.stringify(m.map));
        if (m.range) copy.range = JSON.parse(JSON.stringify(m.range));
        if (m.bypass) copy.bypass = true;
        if (m.inputMap) copy.inputMap = structuredClone(m.inputMap);
        map.set(id, copy.id);
      }
      for (const c of [...this.patch.cables]) if (map.has(c.from.module) && map.has(c.to.module)) connect(this.patch, DEFS, { module: map.get(c.from.module)!, port: c.from.port }, { module: map.get(c.to.module)!, port: c.to.port });
      this.selected.clear();
      for (const id of map.values()) this.selected.add(id);
      this.selectedAsm.clear();
      for (const id of asmCopies) this.selectedAsm.add(id);
    });
  }

  // ---- copy / paste (clipboard.ts): the system clipboard is main.ts's; the editor turns a selection into a clip and back

  /** the clip last copied or pasted, and how many times it was pasted: each paste of it lands one PASTE_STEP further */
  private clipKey = '';
  private clipPastes = 0;

  /** the selection as a clip (Main and the Output are left out); null with nothing to copy */
  copySelection(): Clip | null {
    const set = this.dragSet();
    const clip = copyItems(this.patch, set.mods.map((m) => m.id), set.asms.map((a) => a.id));
    if (clip) {
      this.clipKey = clipText(clip);
      this.clipPastes = 0;
    }
    return clip;
  }

  /** put a clip into the patch, offset from where it was copied, as one undo step; the pasted items become the selection */
  paste(clip: Clip): boolean {
    const key = clipText(clip);
    this.clipPastes = key === this.clipKey ? this.clipPastes + 1 : 1;
    this.clipKey = key;
    const off = PASTE_STEP * this.clipPastes;
    return this.change(() => {
      const got = pasteClip(this.patch, DEFS, clip, Math.max(0, clip.x + off), Math.max(0, clip.y + off));
      this.selected.clear();
      for (const id of got.modules) this.selected.add(id);
      this.selectedAsm.clear();
      for (const id of got.assemblies) this.selectedAsm.add(id);
    });
  }

  // ---- click-to-connect: a click on a jack arms it, a click on a jack of the other direction connects; Esc cancels

  private armed: HTMLElement | null = null;
  /** the ghost cable from the armed jack to the pointer (stops following when the arm ends) */
  private armGhost: (() => void) | null = null;

  cancelArm(): void {
    this.armed?.classList.remove('armed');
    this.armed = null;
    this.armGhost?.();
    this.armGhost = null;
    this.setPatching(false);
    this.drag?.cancel();
  }

  /** the canvas is patching (a cable being dragged or a jack armed); the page knows too, so the sidebar's jack thumbs show it */
  private setPatching(on: boolean): void {
    this.canvas.classList.toggle('patching', on);
    document.documentElement.classList.toggle('patching-any', on);
  }

  /** click-to-connect onto a sidebar slider's thumb: with an output armed, patch it there. Whether it did */
  connectArmedToSide(key: SideKey): boolean {
    const armed = this.armed;
    if (!armed || armed.dataset.dir !== 'out' || !armed.dataset.mod) return false;
    this.cancelArm();
    this.setSideSource(key, { module: Number(armed.dataset.mod), port: armed.dataset.port! });
    return true;
  }

  // ---- A / B: two snapshots; the toggle swaps them, as a parameter-only update when the structure matches

  readonly snapshots: { A: string | null; B: string | null } = { A: null, B: null };
  side: 'A' | 'B' = 'A';

  /** keep the current patch as snapshot A or B */
  takeSnapshot(which: 'A' | 'B'): void {
    this.snapshots[which] = JSON.stringify(this.patch);
    this.side = which;
  }

  /** go to the other snapshot (false when it is empty) */
  toggleAB(): boolean {
    const other = this.side === 'A' ? 'B' : 'A';
    const s = this.snapshots[other];
    if (s === null) return false;
    this.snapshots[this.side] = JSON.stringify(this.patch); // the side we leave keeps what we did to it
    const from = this.side;
    this.side = other;
    this.applyLive(JSON.parse(s) as Patch, from);
    return true;
  }

  /** switch to `target`: with the same structure only the values move (onParam / onAtt / onBypass / onRange, no reload, the voices keep sounding), else a full load */
  applyLive(target: Patch, side = this.side): void {
    this.endGesture();
    const before = this.mark();
    if (!sameStructure(this.patch, target) || this.patch.modules.some((m, i) => m.id !== target.modules[i].id)) {
      this.patch = target;
      this.commit(before, side);
      this.selected.clear();
      this.rebuild();
      this.ev.onStructure(this.patch);
      return;
    }
    target.modules.forEach((t, i) => {
      const m = this.patch.modules[i];
      for (const pd of DEFS[m.type].params) if ((m.params[pd.name] ?? pd.default) !== (t.params[pd.name] ?? pd.default)) this.ev.onParam(m.id, pd.name, t.params[pd.name] ?? pd.default);
      if (m.att && t.att) for (const k of [0, 1] as const) if (m.att[k] !== t.att[k]) this.ev.onAtt(m.id, k, t.att[k]);
      if (!!m.bypass !== !!t.bypass) this.ev.onBypass(m.id, !!t.bypass);
      for (const s of ['p1', 'p2'] as const) {
        const names = new Set([...Object.keys(m.range?.[s] ?? {}), ...Object.keys(t.range?.[s] ?? {})]);
        for (const name of names) {
          const r = t.range?.[s]?.[name] ?? null;
          if (JSON.stringify(r) !== JSON.stringify(m.range?.[s]?.[name] ?? null)) this.ev.onRange(m.id, s === 'p1' ? 0 : 1, name, r);
        }
      }
    });
    const keepLayout = this.patch.modules.map((m) => [m.x, m.y]);
    this.patch = target;
    this.patch.modules.forEach((m, i) => ([m.x, m.y] = keepLayout[i]));
    this.commit(before, side);
    this.rebuild();
    this.ev.onLayout(this.patch);
  }
  /**
   * A port row. On a member card of an expanded assembly it gets the expose toggle; on an assembly card (`label`) the dot
   * still belongs to the inner module, so cables and drags work the same, and the label renames on click.
   */
  private port(m: ModuleInst, p: PortDef, dir: 'out' | 'in', o: { open?: AssemblyInst; label?: string; rename?: () => void; also?: Target[]; short?: boolean } = {}): HTMLElement {
    const row = document.createElement('div');
    row.className = `port ${dir}`;
    const dot = this.jack(m, p, dir);
    const long = longName(m.type, p.name);
    dot.title = (o.label ? `${o.label}: ${DEFS[m.type].label} ${long} (${p.kind})` : `${long} (${p.kind})`);
    const label = document.createElement('span');
    // a card's edge has little room: a long name gives way to the short one (the jack's tooltip has the long one)
    label.textContent = o.label ?? (o.short && long.length > 6 ? p.name : long);
    if (o.rename) {
      label.classList.add('rename');
      label.title = 'click to rename';
      label.onclick = o.rename;
    }
    const parts: HTMLElement[] = dir === 'in' ? [dot, label] : [label, dot];
    if (o.open) {
      const a = o.open;
      const on = isExposed(a, dir, m.id, p.name);
      const ref = findRef(a, dir, m.id, p.name);
      row.classList.toggle('shown', on);
      this.promoteClick(row, a, () => (on ? hidePort(this.patch, a, dir, m.id, p.name) : exposePort(a, dir, m.id, p.name, o.also, this.patch)));
      // pick mode: the check box between the label and the jack
      if (this.picking(a)) parts.splice(1, 0, this.pickBox(on));
      if (dir === 'in') parts.push(...this.mergeTools(a, m, p, ref, this.picking(a)));
    }
    if (o.also?.length) dot.dataset.also = JSON.stringify(o.also);
    if (o.also?.length && !o.open) {
      const n = document.createElement('span');
      n.className = 'merged';
      n.textContent = `×${o.also.length + 1}`;
      n.title = `one jack for ${o.also.length + 1} inputs: ${[{ module: m.id, port: p.name }, ...o.also].map((t) => `${DEFS[this.patch.modules.find((x) => x.id === t.module)!.type].label} ${t.port}`).join(', ')}`;
      parts.splice(dir === 'in' ? 2 : 1, 0, n);
    }
    row.append(...parts);
    return row;
  }

  /** briefly highlight the drawn cables of these model cables (the two sources holding a module's pins) */
  private flash(cables: Cable[]): void {
    const hit = (c?: Cable): boolean => !!c && cables.some((x) => sameEnd(x.from, c.from) && sameEnd(x.to, c.to));
    // after the redraw that follows the failed change
    setTimeout(() => {
      const paths = this.cablePaths.filter((e) => hit(e.cable)).map((e) => e.path);
      for (const path of paths) path.classList.add('flash');
      setTimeout(() => paths.forEach((path) => path.classList.remove('flash')), 1600);
    }, 60);
  }

  /** a pin with a cable that routes to no parameter (from an old patch): it gets a jack so the cable can be seen and removed */
  private unrouted(m: ModuleInst, pin: string): boolean {
    return isPin(pin) && !!m.map && !m.map[pin].length && this.patch.cables.some((c) => c.to.module === m.id && c.to.port === pin);
  }

  private unroutedPort(m: ModuleInst, p: PortDef): HTMLElement {
    const row = this.port(m, p, 'in', { label: 'unrouted' });
    row.classList.add('unrouted');
    row.title = 'This cable reaches no parameter (an old patch routed it nowhere). Click the cable to remove it, or patch to a thumb instead.';
    return row;
  }

  /** a port's jack: cables are drawn to it and dragged from it */
  private jack(m: ModuleInst, p: PortDef, dir: 'out' | 'in'): HTMLElement {
    const dot = document.createElement('span');
    dot.className = `dot ${p.kind}`;
    dot.dataset.mod = String(m.id);
    dot.dataset.port = p.name;
    dot.dataset.dir = dir;
    dot.title = `${longName(m.type, p.name)} (${p.kind})`;
    dot.addEventListener('pointerdown', (e) => this.beginDrag(e, dot));
    this.ports.set(this.key(m.id, p.name, dir), dot);
    return dot;
  }

  /** a patch button of the FM-1 in the dock (board E): its label and kind mark, the FM-1 name under them, a light (dark
   * unassigned, dim assigned or cabled, lit engaged); held while pressed or switched; right-click or ⋯: the button editor */
  private dockButton(m: ModuleInst, b: string, i: number): HTMLElement {
    if (b === 'arp' && arpFree(this.patch)) return this.freeArpButton();
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'panel-btn';
    btn.dataset.button = b;
    const panel = m.panel;
    const glo = b === 'glo';
    const fixed = FIXED_BUTTONS.has(b);
    const kind = fixed ? 'gate' : kindOf(panel, b);
    const name = buttonLabel(b);
    const top = document.createElement('span');
    top.className = 'pb-face';
    if (fixed) top.append(kindMark('main'));
    else if (kind !== 'nothing') top.append(kindMark(kind));
    const label = document.createElement('span');
    label.className = 'pb-label';
    label.textContent = glo ? 'GLOBAL' : fixed ? name : kind === 'nothing' ? name : panel?.labels?.[b] || name;
    top.append(label);
    const under = document.createElement('span');
    under.className = 'pb-hw';
    under.textContent = kind === 'nothing' ? 'unassigned' : name;
    const led = document.createElement('span');
    led.className = 'pb-led';
    led.setAttribute('aria-hidden', 'true');
    btn.append(top, under, led);
    btn.classList.toggle('unassigned', kind === 'nothing');
    btn.classList.toggle('assigned', buttonLight(this.patch, b, false) === 'dim');
    const engaged = glo ? this.gloOn : kind === 'page' ? this.pageOn?.b === b : kind === 'bypass' ? switches(panel, b) && toggleEngaged(this.patch, b) : switches(panel, b) && !!panel?.on?.includes(b);
    btn.setAttribute('aria-pressed', String(arpLitInverted(this.patch, b) ? !engaged : engaged));   // (ARP on Arpeggiators: lit while they play)
    const does = fixed ? FIXED_DOES[b] : kind === 'nothing' ? 'does nothing (its jack is high while held)' : kind === 'gate' ? 'a gate' : kind === 'page' ? 'a list of device pages (press: the next, hold: the first)' : 'bypasses its target';
    btn.title = fixed ? `${name}: ${does}` : `${name}: ${does}${kind === 'page' ? '' : switches(panel, b) ? ', switches on / off' : ', while held'} (right-click: edit the button)`;
    // touch (#153): the dock scrolls sideways from a button (touch-action: pan-x), so a switch flips when the finger is
    // let go, unless the browser took the touch for a scroll (pointercancel); a held button lets go on the cancel too
    let tap = false;
    btn.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      tap = e.pointerType === 'touch' && (glo || switches(m.panel, b));
      if (!tap) this.pressButton(i, true);
    });
    btn.addEventListener('pointerup', () => {
      if (tap) this.pressButton(i, true);
      tap = false;
    });
    btn.addEventListener('pointercancel', () => { tap = false; });
    for (const ev of ['pointerup', 'pointerleave', 'pointercancel'] as const) btn.addEventListener(ev, () => { if (!switches(m.panel, b) && btn.dataset.down === 'true') this.pressButton(i, false); });
    btn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (!glo) this.openButtonEditor(b);
    });
    if (glo) return btn;                    // GLO is fixed (#118): no editor
    const more = document.createElement('span');
    more.className = 'pb-more';
    more.textContent = '⋯';
    more.title = `Edit the ${name} button`;
    more.addEventListener('pointerdown', (e) => { e.stopPropagation(); e.preventDefault(); this.openButtonEditor(b); });
    btn.append(more);
    btn.addEventListener('keydown', (e) => {
      if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) { e.preventDefault(); this.openButtonEditor(b); }
    });
    return btn;
  }

  /** ARP with nothing on it (arp-button.ts): "+ ARP". A click puts an arpeggiator on it, at once when there is one way to,
   * else from a menu above the button; right-click or ⋯ still edits the button */
  private freeArpButton(): HTMLElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'panel-btn arp-free';
    btn.dataset.button = 'arp';
    const face = document.createElement('span');
    face.className = 'pb-face';
    const label = document.createElement('span');
    label.className = 'pb-label';
    label.textContent = '+ ARP';
    face.append(label);
    const under = document.createElement('span');
    under.className = 'pb-hw';
    under.textContent = 'add one';
    const choices = arpChoices(this.patch);
    const open = choices.filter((c) => !c.disabled);
    btn.title = open.length === 1 ? `ARP: nothing on it. Click: ${open[0].label} (${open[0].sub})`
      : `ARP: nothing on it. Click to add an arpeggiator: ${open.length} ways, a menu asks which`;
    btn.addEventListener('click', () => open.length === 1 ? this.takeArp(open[0]) : this.openArpMenu(btn, choices));
    btn.addEventListener('contextmenu', (e) => { e.preventDefault(); this.openButtonEditor('arp'); });
    const more = document.createElement('span');
    more.className = 'pb-more';
    more.textContent = '⋯';
    more.title = 'Edit the ARP button';
    more.addEventListener('pointerdown', (e) => { e.stopPropagation(); e.preventDefault(); this.openButtonEditor('arp'); });
    more.addEventListener('click', (e) => e.stopPropagation());
    btn.append(face, under, more);
    return btn;
  }

  /** the ARP menu: one row per choice; hovering a row glows the keys cables it takes over */
  private openArpMenu(btn: HTMLElement, choices: ArpChoice[]): void {
    document.querySelector('.arp-menu')?.remove();
    const menu = document.createElement('div');
    menu.className = 'arp-menu';
    menu.popover = 'auto';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', 'Put an arpeggiator on ARP');
    const head = document.createElement('div');
    head.className = 'arp-menu-head';
    head.textContent = 'ARP';
    menu.append(head);
    for (const c of choices) {
      const row = document.createElement('button');
      row.type = 'button';
      row.setAttribute('role', 'menuitem');
      row.disabled = !!c.disabled;
      const l = document.createElement('span');
      l.textContent = c.label;
      const sub = document.createElement('small');
      sub.textContent = c.sub;
      row.append(l, sub);
      row.addEventListener('pointerenter', () => this.glowCables(c.cables));
      row.addEventListener('focus', () => this.glowCables(c.cables));
      row.addEventListener('pointerleave', () => this.glowCables([]));
      row.addEventListener('click', () => { menu.hidePopover(); this.takeArp(c); });
      menu.append(row);
    }
    menu.addEventListener('toggle', () => { if (!menu.matches(':popover-open')) { this.glowCables([]); menu.remove(); } });
    document.body.append(menu);
    menu.showPopover();
    const r = btn.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(innerWidth - menu.offsetWidth - 8, r.left + r.width / 2 - menu.offsetWidth / 2))}px`;
    menu.style.top = `${Math.max(8, r.top - menu.offsetHeight - 8)}px`;
    menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }

  /** do one of the ARP choices: undoable, the arpeggiator selected, a toast with Undo */
  private takeArp(c: ArpChoice): void {
    let arp = null as ModuleInst | null;
    if (!this.change(() => { arp = c.apply(this.patch); })) return;
    if (arp) this.reveal(arp.id);
    showUndo(c.done, () => this.undo());
  }

  /** the button editor's popover (button-editor.ts): kept across redraws, anchored on its dock button */
  private buttonPop: { el: HTMLElement; b: string } | null = null;

  /** open (or move to) the editor of patch button b */
  openButtonEditor(b: string): void {
    if (!this.buttonPop) {
      const el = document.createElement('div');
      el.className = 'routing-controls button-editor';
      el.popover = 'auto';
      el.addEventListener('toggle', () => { if (!el.matches(':popover-open')) this.buttonPop = null; });
      el.addEventListener('keydown', (e) => { if (e.key !== 'Escape') e.stopPropagation(); });
      document.body.append(el);
      this.buttonPop = { el, b };
    }
    this.buttonPop.b = b;
    this.fillButtonEditor();
  }

  /** refill the open button editor (after a change, a redraw, undo) and keep it on its button */
  private fillButtonEditor(): void {
    const pop = this.buttonPop;
    const m = this.docked() ?? this.patch.modules.find((x) => x.type === 'fm1');
    if (!pop) return;
    const anchor = this.dock?.querySelector<HTMLElement>(`.panel-btn[data-button="${pop.b}"]`);
    if (!m || !anchor) { if (pop.el.matches(':popover-open')) pop.el.hidePopover(); pop.el.remove(); this.buttonPop = null; return; }
    pop.el.replaceChildren(...buttonEditor(pop.b, {
      patch: () => this.patch,
      change: (fn) => { this.change(fn); },
      label: (text) => this.setPanelLabel(m, pop.b, text),
      devices: () => this.devices,
    }, FIXED_BUTTONS.has(pop.b)));
    if (!pop.el.matches(':popover-open')) pop.el.showPopover();
    positionPopover(pop.el, anchor);
  }

  /**
   * Patch button i (PANEL_BUTTONS) pressed or let go, on the dock or elsewhere (CC 80..86 from the FM-1, which sends the
   * presses raw, #115): a switching one flips on the press and is saved with the patch, the others are on while held.
   * A Toggle (#116) bypasses its target while on: a switching one in the patch (an undo step, like the card's ⏻), one
   * that acts while held in the engine only. The engine applies the bypass itself (Engine.setButton), as the FM-1 does.
   */
  pressButton(i: number, down: boolean): void {
    const b = PANEL_BUTTONS[i];
    const m = this.patch.modules.find((x) => x.type === 'fm1');
    if (!m || b === undefined) return;
    const btn = this.dock?.querySelector<HTMLElement>(`.panel-btn[data-button="${b}"]`);
    const kind = kindOf(m.panel, b);
    if (b !== 'glo' && FIXED_BUTTONS.has(b)) {   // SEL, ENV (#197): the FM-1's own; here only their jacks (high while held)
      this.ev.onButton?.(i, down);
      btn?.setAttribute('aria-pressed', String(down));
      return;
    }
    if (b === 'glo') {                      // GLO (#199): the FM-1's own page (no rows here); again: back
      if (down) this.setGlo(!this.gloOn);
      this.ev.onButton?.(i, down);          // (its jack: high while held)
      btn?.setAttribute('aria-pressed', String(this.gloOn));
      return;
    }
    if (kind === 'page') return this.pagePress(i, b, down, btn);
    const t = kind === 'bypass' ? m.panel?.targets?.[b] : undefined;
    const a = t && 'asm' in t ? assembliesOf(this.patch).find((x) => x.id === t.asm) : undefined;
    if (!switches(m.panel, b)) {
      if (btn) btn.dataset.down = String(down);
      btn?.setAttribute('aria-pressed', String(kind === 'bypass' && arpLitInverted(this.patch, b) ? !down : down));
      if (kind === 'bypass') this.showBypass(toggleTargets(this.patch, b), down, a);
      this.ev.onButton?.(i, down);
      return;
    }
    if (!down) return;
    this.touch();
    let on: boolean;
    if (kind === 'bypass') {
      on = !toggleEngaged(this.patch, b);
      const ids = toggleTargets(this.patch, b);
      if (a) bypassAssembly(this.patch, a, on);
      else for (const id of ids) {
        const x = this.patch.modules.find((y) => y.id === id);
        if (!x) continue;
        if (on) x.bypass = true;
        else delete x.bypass;
      }
      this.showBypass(ids, on, a);
    } else {
      const panel = (m.panel ??= {});
      on = !panel.on?.includes(b);
      panel.on = on ? [...(panel.on ?? []), b] : (panel.on ?? []).filter((x) => x !== b);
      if (!panel.on.length) delete panel.on;
    }
    btn?.setAttribute('aria-pressed', String(kind === 'bypass' && arpLitInverted(this.patch, b) ? !on : on));
    this.ev.onButton?.(i, on);
    this.ev.onLayout(this.patch);           // saved with the patch (the device keeps switched buttons too)
  }

  // ---- Page buttons (#117): the same rules as on the FM-1, on the dock knobs. A press puts the next page of the list in
  // focus (the first press: the list's first page), a hold shows its first page while it is down; the list is left when
  // the focus moves any other way. Engaged (lit, its jack high) while the list is on.
  private pageOn: { b: string; step: number } | null = null;
  private pageHold: { b: string; timer: number; peeked: { on: { b: string; step: number } | null; focus: { device: string; page: number } | null } | null } | null = null;
  private listMoving = false;

  private pagePress(i: number, b: string, down: boolean, btn: HTMLElement | null | undefined): void {
    const list = pageList(this.patch, b, this.devices);
    if (down) {
      if (this.pageHold) clearTimeout(this.pageHold.timer);
      const hold = { b, timer: 0, peeked: null as { on: { b: string; step: number } | null; focus: { device: string; page: number } | null } | null };
      hold.timer = window.setTimeout(() => {
        if (this.pageHold !== hold || !list.length) return;
        hold.peeked = { on: this.pageOn, focus: this.focus ? { ...this.focus } : null };
        this.pageOn = { b, step: 0 };
        this.listFocus(list[0]);
      }, PAGE_HOLD_MS);
      this.pageHold = hold;
      this.ev.onButton?.(i, true);
      this.syncPageButtons();
      return;
    }
    const hold = this.pageHold;
    if (!hold || hold.b !== b) return;
    clearTimeout(hold.timer);
    this.pageHold = null;
    if (hold.peeked) {                       // the hold ends: back to what showed before it
      this.pageOn = hold.peeked.on;
      if (hold.peeked.focus) this.listFocus(hold.peeked.focus);
    } else if (list.length) {
      const step = this.pageOn?.b === b ? (this.pageOn.step + 1) % list.length : 0;
      this.pageOn = { b, step };
      this.listFocus(list[step]);
    }
    this.ev.onButton?.(i, this.pageOn?.b === b);
    this.syncPageButtons();
    void btn;
  }

  /** a page of a list into focus (setFocus leaves the list otherwise) */
  private listFocus(f: { device: string; page: number }): void {
    this.listMoving = true;
    try { this.setFocus(f); } finally { this.listMoving = false; }
    this.syncPageButtons();
  }

  /** the dock's Page buttons: lit while held or while their list is on */
  private syncPageButtons(): void {
    const m = this.patch.modules.find((x) => x.type === 'fm1');
    for (const b of PANEL_BUTTONS) {
      if (kindOf(m?.panel, b) !== 'page') continue;
      const on = this.pageOn?.b === b || this.pageHold?.b === b;
      this.dock?.querySelector<HTMLElement>(`.panel-btn[data-button="${b}"]`)?.setAttribute('aria-pressed', String(on));
    }
  }

  /** Alt-click on a card row while a Page button's editor is open: its page joins the list */
  private addRowToList(module: number, param: string): boolean {
    const b = this.buttonPop?.b;
    const m = this.patch.modules.find((x) => x.type === 'fm1');
    if (!b || kindOf(m?.panel, b) !== 'page') return false;
    const at = findRow(this.devices, module, param);
    if (!at) return false;
    const entry = { device: this.devices[at.device].key, page: at.page };
    const list = pageList(this.patch, b, this.devices);
    if (list.length >= PAGE_LIST_MAX) return true;
    this.change(() => setPages(this.patch, b, [...list, entry]));
    return true;
  }

  /** the cards of modules a Toggle bypasses show it (without a redraw: the dock button may be held) */
  private showBypass(ids: number[], on: boolean, a?: AssemblyInst): void {
    for (const id of ids) this.cards.get(id)?.classList.toggle('off', on);
    if (a) {
      this.containers.get(a.id)?.classList.toggle('off', on);
      this.frames.get(a.id)?.classList.toggle('off', on);
    }
  }

  /** a button's label on the FM-1's screen (patch.ts panelLabel: capitals, 10 characters; '' = none) */
  private setPanelLabel(m: ModuleInst, key: string, typed: string): void {
    const label = panelLabel(typed);
    this.change(() => {
      const panel = (m.panel ??= {});
      const labels = { ...(panel.labels ?? {}) };
      if (label) labels[key] = label;
      else delete labels[key];
      if (Object.keys(labels).length) panel.labels = labels;
      else delete panel.labels;
      if (!Object.keys(panel).length) delete m.panel;
    });
  }

  /** a small menu at a screen point (the dock is not in the canvas); a press anywhere else closes it */
  private dockMenu(items: MenuItem[], x: number, y: number): void {
    this.popMenu(items, { x, y });
    const menu = document.querySelector<HTMLElement>('.ctx');
    if (!menu) return;
    document.body.append(menu);
    Object.assign(menu.style, { position: 'fixed', left: `${x}px`, top: `${y - 8}px`, zIndex: '40', transform: 'translateY(-100%)' });
  }

  /**
   * On an exposed input inside an expanded assembly: a "merge into…" list of the other exposed inputs of the same kind, a
   * badge with the count on a merged jack and a button to split it again.
   */
  private mergeTools(a: AssemblyInst, m: ModuleInst, p: PortDef, ref: PortRef | undefined, tools: boolean): HTMLElement[] {
    if (!ref) return [];
    const out: HTMLElement[] = [];
    const me: Target = { module: m.id, port: p.name };
    const primary = ref.module === m.id && ref.port === p.name;
    if (ref.also?.length) {
      const n = document.createElement('span');
      n.className = 'merged';
      n.textContent = primary ? `×${ref.also.length + 1}` : `→ ${ref.label}`;
      n.title = primary ? `"${ref.label}" is one jack for ${ref.also.length + 1} inputs` : `fed by the "${ref.label}" jack`;
      out.push(n);
      if (primary && tools) out.push(this.button('split', `Split "${ref.label}": one jack per input again`, () => this.change(() => unmergePort(a, m.id, p.name))));
    }
    const kindOf = (t: Target): string => DEFS[this.patch.modules.find((x) => x.id === t.module)!.type].inputs.find((q) => q.name === t.port)!.kind;
    const others = a.inputs.filter((r) => r !== ref && kindOf(r) === p.kind);
    if (!others.length || !tools) return out; // merging is part of choosing the card: pick mode only
    const sel = document.createElement('select');
    sel.className = 'merge';
    sel.title = `Merge "${ref.label}" into another jack of the "${a.label}" card: one jack feeds both`;
    sel.setAttribute('aria-label', `merge ${ref.label} into`);
    sel.append(new Option('merge…', ''));
    for (const r of others) sel.append(new Option(r.label, `${r.module}:${r.port}`));
    sel.onchange = () => {
      const [mod, port] = sel.value.split(':');
      if (!mod) return;
      this.change(() => mergePorts(this.patch, a, DEFS, { module: Number(mod), port }, me));
    };
    sel.onpointerdown = (e) => e.stopPropagation();
    out.push(sel);
    return out;
  }

  // ---- assemblies on the canvas

  /** the expanded assembly whose collapsed card is being chosen (its frame's card button), else null */
  private pickAsm: number | null = null;

  /** leave pick mode (Esc); false when it was not on */
  endPick(): boolean {
    if (this.pickAsm === null && this.arrangeAsm === null) return false;
    this.pickAsm = null;
    this.arrangeAsm = null;
    this.newHeading = null;
    this.rebuild();
    return true;
  }

  private picking(a: AssemblyInst | undefined): boolean {
    return !!a && this.pickAsm === a.id;
  }

  /**
   * A row of a member card that can go on the assembly's collapsed card: a click adds it or takes it off in pick mode,
   * a Cmd / Ctrl-click any time. In pick mode a jack still patches (a plain press on it).
   */
  private promoteClick(el: HTMLElement, a: AssemblyInst, toggle: () => void, row?: PickRow): void {
    const mod = (e: MouseEvent): boolean => e.metaKey || e.ctrlKey;
    // a parameter row in pick mode can be selected (#186); a jack stays one click each
    const key = row && this.picking(a) ? this.selectable(el, row) : null;
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !(this.picking(a) || mod(e))) return;
      const t = e.target as HTMLElement;
      if (t.closest('select, button.sm')) return;
      if (!mod(e) && t.closest('.dot:not(.slider-port)')) return;
      e.preventDefault();
      e.stopPropagation();
      if (key) {
        // inside the mode Shift-click and Cmd / Ctrl-click only select; a finger selects with a long press
        if (e.shiftKey || mod(e)) return this.rowClick(key, e.shiftKey);
        if (e.pointerType === 'touch') return this.rowPress(e, key, () => this.change(toggle));
      }
      this.change(toggle);
    }, true);
    // macOS: Ctrl-click is also a right click; it toggled already, so no context menu
    el.addEventListener('contextmenu', (e) => { if (e.ctrlKey) { e.preventDefault(); e.stopPropagation(); } });
    el.title = key ? `Click: show on the "${a.label}" card or take it off; Shift / Cmd / Ctrl-click: select rows (Space shows or hides them)`
      : this.picking(a) ? `Click: show on the "${a.label}" card or take it off` : `Cmd / Ctrl-click: show on the "${a.label}" card or take it off`;
  }

  // ---- several rows at once in pick and arrange mode (#186)

  /** the rows selected in pick or arrange mode (`module:param`), the Shift range's anchor, and whether a finger started it */
  private rowSel = new Set<string>();
  private rowAnchor: string | null = null;
  private rowTouch = false;
  /** the mode the selection belongs to (`pickAsm:arrangeAsm`) */
  private rowMode = 'null:null';
  /** the rows that can be selected in this rebuild, in the order they were drawn */
  private selRows: (PickRow & { key: string; el: HTMLElement })[] = [];
  /** the mode bar's button for the selection (show / hide N in pick mode, take off N in arrange mode): a finger has no keys */
  private rowAction: HTMLButtonElement | null = null;

  /** a row that can be selected in the mode that is on; its key */
  private selectable(el: HTMLElement, r: PickRow): string {
    const key = `${r.module}:${r.param}`;
    el.dataset.rowKey = key;
    this.selRows.push({ module: r.module, param: r.param, key, el });
    return key;
  }

  private dropRows(): void {
    this.rowSel.clear();
    this.rowAnchor = null;
    this.rowTouch = false;
  }

  /** the selected rows in the order they were drawn */
  private selectedRows(): PickRow[] {
    return this.selRows.filter((r) => this.rowSel.has(r.key)).map(({ module, param }) => ({ module, param }));
  }

  private showRowSel(): void {
    for (const r of this.selRows) r.el.classList.toggle('row-sel', this.rowSel.has(r.key));
    const b = this.rowAction;
    if (!b) return;
    const n = this.rowSel.size;
    b.hidden = !n;
    const a = this.pickAsm !== null ? assemblyById(this.patch, this.pickAsm) : undefined;
    b.textContent = !a ? `take off ${n}` : pickState(a, this.selectedRows()) === 'all' ? `hide ${n}` : `show ${n}`;
  }

  /** Shift-click: add the rows from the last one clicked to this one; Cmd / Ctrl-click (or a tap while a finger selects):
   * add or remove this one */
  private rowClick(key: string, range: boolean): void {
    if (range) for (const k of keyRange(this.selRows.map((r) => r.key), this.rowAnchor, key)) this.rowSel.add(k);
    else if (this.rowSel.has(key)) this.rowSel.delete(key);
    else this.rowSel.add(key);
    if (!range || this.rowAnchor === null) this.rowAnchor = key;
    if (!this.rowSel.size) this.rowTouch = false;
    this.showRowSel();
  }

  /** a finger's long press on a row starts a selection with it (or adds it) */
  private rowHeld(key: string): void {
    if (!this.rowTouch) this.rowSel.clear();
    this.rowSel.add(key);
    this.rowAnchor = key;
    this.rowTouch = true;
    this.showRowSel();
  }

  /** a finger on a pick-mode row: a long press selects it, a tap adds or removes it while a finger selects, else `tap` */
  private rowPress(e: PointerEvent, key: string, tap: () => void): void {
    const x0 = e.clientX, y0 = e.clientY;
    let held = false;
    const hold = window.setTimeout(() => ((held = true), this.rowHeld(key)), LONG_PRESS_MS);
    const move = (ev: PointerEvent): void => {
      if (ev.pointerId === e.pointerId && Math.hypot(ev.clientX - x0, ev.clientY - y0) > 8) end();
    };
    const end = (): void => {
      window.clearTimeout(hold);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', end);
    };
    const up = (ev: PointerEvent): void => {
      if (ev.pointerId !== e.pointerId) return;
      end();
      if (held) return;
      if (this.rowTouch) this.rowClick(key, false);
      else tap();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', end);
  }

  /** whether pick or arrange mode is on */
  private inRowMode(): boolean {
    return this.pickAsm !== null || this.arrangeAsm !== null;
  }

  /** Esc in pick or arrange mode clears the row selection first: false when there was none */
  clearRows(): boolean {
    if (!this.rowSel.size) return false;
    this.dropRows();
    this.showRowSel();
    return true;
  }

  /** Ctrl / Cmd+A in pick or arrange mode: every row is selected, nothing changes; false outside the modes */
  selectAllRows(): boolean {
    if (!this.inRowMode()) return false;
    for (const r of this.selRows) this.rowSel.add(r.key);
    this.showRowSel();
    return true;
  }

  /** Space / Enter in pick mode: the selected rows all go on the card if any is off it, else all come off (one undo step);
   * false outside pick mode or with nothing selected */
  applyRows(): boolean {
    const a = this.pickAsm !== null ? assemblyById(this.patch, this.pickAsm) : undefined;
    const rows = this.selectedRows();
    if (!a || !rows.length) return false;
    this.change(() => pickRows(a, rows, this.patch));
    return true;
  }

  /** Delete in arrange mode: the selected rows come off the card (one undo step); false outside arrange mode or with
   * nothing selected */
  deleteRows(): boolean {
    const a = this.arrangeAsm !== null ? assemblyById(this.patch, this.arrangeAsm) : undefined;
    if (!a || !this.rowSel.size) return false;
    const gone = new Set(this.rowSel);
    this.dropRows();
    this.change(() => {
      // through the layout tree: a heading whose rows all go stays, empty
      const layout = layoutOf(a.params, a.heads);
      removeRows(layout, [...gone], this.knobOf());
      setLayout(a, layout);
    });
    return true;
  }

  /** the rows of pick mode's assembly that Select all / Select none act on: parameters only (#186 rule 1) */
  private pickBar(a: AssemblyInst): HTMLElement[] {
    const all = this.button('select all', `Select all: every parameter of the members goes on the "${a.label}" card (jacks stay one click each)`, () => {
      const off = this.selRows.filter((r) => !isPromoted(a, r.module, r.param));
      if (off.length) this.change(() => off.forEach((r) => promote(a, r.module, r.param, this.patch)));
    }, 'sm pick-all');
    const none = this.button('select none', `Select none: no parameter on the "${a.label}" card (jacks stay one click each)`, () => {
      if (a.params.length) this.change(() => (a.params = []));
    }, 'sm pick-none');
    const act = this.button('', 'The selected rows: on the card if any is off it, else off it (Space / Enter)', () => this.applyRows(), 'sm row-act');
    act.hidden = true;
    this.rowAction = act;
    return [all, none, act];
  }

  /** pick mode's check box on a member card's header: all its parameters on the card, none, or some (–); a click acts on
   * them all as Space does on a selection */
  private pickAllBox(a: AssemblyInst, rows: PickRow[]): HTMLElement {
    const state = pickState(a, rows);
    const box = document.createElement('button');
    box.type = 'button';
    box.className = 'pickbox pickall' + (state === 'all' ? ' on' : state === 'some' ? ' some' : '');
    box.textContent = state === 'all' ? '✓' : state === 'some' ? '–' : '';
    box.setAttribute('role', 'checkbox');
    box.setAttribute('aria-checked', state === 'all' ? 'true' : state === 'some' ? 'mixed' : 'false');
    const title = state === 'all' ? `Take its parameters off the "${a.label}" card` : `Show all its parameters on the "${a.label}" card`;
    box.title = title;
    box.setAttribute('aria-label', title);
    box.addEventListener('pointerdown', (e) => e.stopPropagation());
    box.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.change(() => pickRows(a, rows, this.patch));
    };
    return box;
  }

  /** pick mode's check box: on = shown on the assembly card */
  private pickBox(on: boolean): HTMLElement {
    const box = document.createElement('span');
    box.className = 'pickbox' + (on ? ' on' : '');
    box.textContent = on ? '✓' : '';
    box.setAttribute('aria-hidden', 'true');
    return box;
  }

  /** the frame's card button: pick mode on / off, with how many jacks and parameters the collapsed card has */
  private pickButton(a: AssemblyInst): HTMLButtonElement {
    const on = this.picking(a);
    const n = a.inputs.length + a.outputs.length + a.params.length;
    const b = this.button(on ? 'done' : `card · ${n}`, on
      ? 'Done choosing (Esc)'
      : `Choose what the collapsed "${a.label}" card shows: click jacks and parameters to add or remove them; Shift / Cmd / Ctrl-click or a band selects rows, Space shows or hides them (outside, Cmd / Ctrl-click does it any time)`,
    () => { this.pickAsm = on ? null : a.id; this.rebuild(); }, 'sm pick-btn');
    b.setAttribute('aria-pressed', String(on));
    b.dataset.asm = String(a.id);
    return b;
  }

  private rename(a: AssemblyInst): void {
    const v = window.prompt('Label of this assembly', a.label)?.trim();
    if (v && v !== a.label) this.change(() => (a.label = v));
  }

  private saveAssembly(a: AssemblyInst): void {
    const name = window.prompt('Save the assembly to the library as', a.name)?.trim();
    if (!name) return;
    if (name !== a.name) this.change(() => (a.name = name));
    this.ev.onSaveAssembly(toDef(this.patch, a));
  }

  private assemblyButtons(a: AssemblyInst): HTMLElement[] {
    const pw = this.button('⏻', `${a.label} on / off (bypass every module inside)`, () => {
      this.touch();
      const changed = bypassAssembly(this.patch, a, !a.bypass);
      for (const id of changed) this.ev.onBypass(id, !!this.patch.modules.find((m) => m.id === id)?.bypass);
      this.rebuild();
      this.ev.onLayout(this.patch);
    }, 'pw');
    pw.classList.toggle('on', !a.bypass);
    pw.setAttribute('aria-pressed', String(!a.bypass));
    const arm = !parentOf(this.patch, a.id) && armable(this.patch, `a${a.id}`) ? [this.armButton(`a${a.id}`, a.label)] : [];
    return [...arm, this.polyButton(a), pw, this.moreButton((at) => this.assemblyMenu(a, at))];
  }

  /** the preset chip on an assembly device that has presets (#192): ‹ name › steps through them (each load one undo
   * step), the name opens the list; a star after it once a value differs from the preset */
  private presetChip(a: AssemblyInst): HTMLElement | null {
    const list = presetsOf(this.patch, a);
    if (!list.length) return null;
    const chip = document.createElement('span');
    chip.className = 'preset-chip';
    const step = (dir: 1 | -1): void => {
      const pr = stepPreset(this.patch, a, dir);
      if (pr) this.loadPreset(a, pr.name);
    };
    const name = this.button('', '', () => {
        const r = name.getBoundingClientRect();
        const w = this.world.getBoundingClientRect();
        this.popMenu(this.presetItems(a), { x: (r.left - w.left) / this.zoom, y: (r.bottom - w.top) / this.zoom + 4 });
      }, 'sm preset-name');
    const show = (): void => {
      const edited = !!a.preset && !matchesPreset(this.patch, a);
      // (the preset's own spelling: the FM-1 names it in capitals)
      const shown = a.preset && (presetsOf(this.patch, a).find((x) => sameName(x.name, a.preset))?.name ?? a.preset);
      // (the star outside the cut text: a long name ends in "…" and keeps its star)
      const text = document.createElement('span');
      text.textContent = shown || `${list.length} preset${list.length === 1 ? '' : 's'}`;
      name.replaceChildren(text, ...(edited ? ['*'] : []));
      name.title = a.preset ? `Preset ${shown}${edited ? ' (edited since)' : ''}: click for the list` : 'Presets of this assembly: click for the list';
    };
    show();
    this.chips.set(a.id, show);
    chip.append(this.button('‹', 'Previous preset', () => step(-1), 'sm preset-step'), name, this.button('›', 'Next preset', () => step(1), 'sm preset-step'));
    return chip;
  }

  /** the preset chips drawn, by assembly: redraw their names (the star once a value differs) */
  private chips = new Map<number, () => void>();
  private chipsQueued = false;
  private chipsSoon(): void {
    if (this.chipsQueued || !this.chips.size) return;
    this.chipsQueued = true;
    requestAnimationFrame(() => {
      this.chipsQueued = false;
      for (const show of this.chips.values()) show();
    });
  }

  /** load a preset by name into an assembly: one undo step */
  private loadPreset(a: AssemblyInst, name: string): void {
    const pr = presetsOf(this.patch, a).find((x) => sameName(x.name, name));
    if (!pr) return;
    if (this.change(() => applyPreset(this.patch, a, pr))) this.ev.onError(`${a.label}: preset "${pr.name}"`);
  }

  /** the presets menu of an assembly device: load one, store, rename, delete */
  private presetItems(a: AssemblyInst): MenuItem[] {
    const list = presetsOf(this.patch, a);
    const cur = list.find((x) => sameName(x.name, a.preset));
    const items: MenuItem[] = list.map((pr) => ({ text: `${sameName(pr.name, a.preset) ? '● ' : ''}${pr.name}${pr.factory ? ' (factory)' : ''}`, run: () => this.loadPreset(a, pr.name) }));
    items.push({ text: cur && !cur.factory ? `Store over "${cur.name}"` : 'Store as a preset…', rule: !!list.length, run: () => {
      const n = cur && !cur.factory ? cur.name : window.prompt('Store the card’s values as the preset', nextPresetName(this.patch, a))?.trim();
      if (!n) return;
      this.change(() => storePreset(this.patch, a, n));
    } });
    if (cur && !cur.factory) {
      items.push({ text: 'Store as a new preset…', run: () => {
        const n = window.prompt('Store the card’s values as the new preset', nextPresetName(this.patch, a))?.trim();
        if (n) this.change(() => storePreset(this.patch, a, n));
      } });
      items.push({ text: 'Rename preset…', run: () => {
        const n = window.prompt('Rename the preset', cur.name)?.trim();
        if (n && n !== cur.name && renamePreset(structureOf(this.patch, a), cur.name, n)) this.change(() => (a.preset = n));
      } });
      items.push({ text: `Delete preset "${cur.name}"`, danger: true, run: () => {
        if (deletePreset(structureOf(this.patch, a), cur.name)) this.change(() => delete a.preset);
      } });
    }
    return items;
  }

  /** ARM on a device with a keys input (#190): an independent toggle; armed, Main's keys play it (and every other armed
   * device), cable or not */
  private armButton(key: DeviceKey, name: string): HTMLButtonElement {
    const b = this.button('', `ARM: Main’s keys play ${name} (with any other armed device), cable or not; again to disarm`, () => this.toggleArm(key), 'sm arm-btn arm-dot');
    b.setAttribute('aria-label', `Arm ${name}`);
    b.dataset.arm = key;
    b.classList.toggle('on', this.armedSet.has(key));
    b.setAttribute('aria-pressed', String(this.armedSet.has(key)));
    return b;
  }

  /** ▸ / ▾ before an assembly's title: expand or collapse */
  private chevron(a: AssemblyInst): HTMLButtonElement {
    const b = this.button('', a.open ? 'Collapse to one card' : 'Expand: show and edit the modules inside', () => this.toggleOpen(a), 'chev');
    // a drawn triangle (▸, turned down when open): the text glyph is tiny in the card fonts
    b.innerHTML = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3.5 1.5 L10 6 L3.5 10.5 Z"/></svg>';
    b.setAttribute('aria-expanded', String(!!a.open));
    b.dataset.asm = String(a.id);
    return b;
  }

  /** the Poly switch: the modules inside run once per part, with their own allocator (poly.ts setPoly) */
  private polyButton(a: AssemblyInst): HTMLButtonElement {
    const b = this.button('poly', a.poly
      ? 'Poly is on: these are voice cards, one copy per voice of the Voicing that feeds them. Click to turn it off (one copy, played by Main).'
      : 'Make it a rack of voice cards: a Voicing module is put beside it (Main\'s keys in, its pitch / gate / velocity into the cards), and the modules inside run once per voice.',
    () => this.change(() => setPoly(this.patch, DEFS, a, !a.poly)), 'sm poly-btn');
    b.setAttribute('aria-pressed', String(!!a.poly));
    b.dataset.asm = String(a.id);
    return b;
  }

  /** an assembly's title segment: the name, its ×N badge and, on a poly assembly, the voice control drop-down */
  private titleOf(a: AssemblyInst, perVoice: number): HTMLElement {
    const title = document.createElement('span');
    title.className = 'rename asm-title';
    title.title = `${a.name}: double-click to rename`;
    const name = document.createElement('span');
    name.className = 'asm-name';
    name.textContent = a.label;
    title.append(name);
    title.ondblclick = (e) => {
      if (!(e.target as HTMLElement).closest('button')) this.rename(a);
    };
    if (perVoice) title.append(this.badge(perVoice));
    if (a.poly) title.append(this.voiceControlButton(a));
    return title;
  }

  /**
   * The collapsed assembly: one card with the exposed ports and the promoted parameters. Inside an expanded parent (`open`)
   * its rows get the parent's expose / pin toggles, like a member card's.
   */
  private container(a: AssemblyInst, perVoice: number, parent?: AssemblyInst): HTMLElement {
    const arranging = this.arrangeAsm === a.id;
    // while its own card is arranged, the parent's pick toggles stay off it
    const open = arranging ? undefined : parent;
    const ncols = paramColumns(a.params).length;
    const el = document.createElement('div');
    el.className = 'module assembly' + (this.armedSet.has(`a${a.id}`) ? ' armed' : '') + (a.poly ? ' poly' : '') + (parent ? ' member' : '') + (a.bypass ? ' off' : '') + (this.picking(open) ? ' picking' : '') + (this.selectedAsm.has(a.id) ? ' selected' : '') + (arranging ? ' arranging' : '') + (ncols > 1 ? ' cols' : '');
    if (ncols > 1) el.style.setProperty('--cols', String(ncols));
    el.style.left = `${a.x}px`;
    el.style.top = `${a.y}px`;
    el.dataset.asm = String(a.id);
    this.containers.set(a.id, el);
    const head = document.createElement('div');
    head.className = 'mhead';
    const tools = document.createElement('span');
    tools.className = 'tools';
    if (arranging) {
      const act = this.button('', 'Take the selected rows off the card (Delete)', () => this.deleteRows(), 'sm row-act');
      act.hidden = true;
      this.rowAction = act;
      const done = this.button('done', 'Done arranging (Esc)', () => this.endPick(), 'sm pick-btn');
      done.setAttribute('aria-pressed', 'true');
      tools.append(act, done);
    }
    if (parent) tools.append(this.outButton(parent, () => this.takeOutAssembly(parent, a)));
    tools.append(...this.assemblyButtons(a));
    const title = this.titleOf(a, perVoice);
    title.prepend(this.tag(null, a));
    const chip = parent ? null : this.presetChip(a);
    head.append(this.chevron(a), title, ...(chip ? [chip] : []), tools);
    this.headMenu(head, (at) => this.assemblyMenu(a, at));
    this.assemblyDrag(el, head, a);

    const body = document.createElement('div');
    body.className = 'mbody';
    const mod = (id: number): ModuleInst => this.patch.modules.find((m) => m.id === id)!;
    const ins: EdgePort[] = [];
    a.inputs.forEach((r, i) => {
      const m = mod(r.module);
      const pd = DEFS[m.type].inputs.find((q) => q.name === r.port)!;
      if (isPin(pd.name) && !this.unrouted(m, pd.name)) return; // routed pins are shown as promoted parameters
      const port = this.port(m, pd, 'in', { label: r.label, rename: () => this.renameRef(r, 'input'), also: r.also, open });
      if (arranging) this.arrangeItem(port, a, 'in', i);
      ins.push({ el: port, module: m.id, port: pd.name });
    });
    const outs = a.outputs.map((r, i) => {
      const m = mod(r.module);
      const pd = DEFS[m.type].outputs.find((q) => q.name === r.port)!;
      const port = this.port(m, pd, 'out', { label: r.label, rename: () => this.renameRef(r, 'output'), open });
      if (arranging) this.arrangeItem(port, a, 'out', i);
      return port;
    });
    // how many columns a display on each row could reach across: its own and those to its right
    const spanRoom: number[] = [];
    paramColumns(a.params).forEach((c, ci) => c.forEach((i) => (spanRoom[i] = ncols - ci)));
    // where its groups (FM-1 pages) start: a divider above a group that has no heading or column of its own
    const shown = a.params.map((r) => rowDef(DEFS[mod(r.module).type], r.param)!);
    const kept = a.params.map((_, i) => i).filter((i) => !shown[i].onScreen);
    const copy = copyStarts(a.params);
    const starts = new Map(groupStarts(kept.map((i) => ({ ...a.params[i], copy: copy[i], knob: !shown[i].screen }))).map((st, k) => [kept[k], st && k > 0]));
    const tie = this.patch.assemblies?.some((x) => x.params.some((r) => r.also || r.names)) ? ties(this.patch) : null;
    // copies shown one at a time (the CZ's envelope steps): only the picked one, under a row that picks it
    const runs = copyRuns(a.params);
    const runOf = (i: number) => runs.find((x) => i >= x.at && i < x.at + x.rows * x.count);
    const params = arranging ? this.arrangeRows(a, body, spanRoom) : a.params.flatMap((r, i): EdgeParam[] => {
      const m = mod(r.module);
      const def = DEFS[m.type];
      const pd = shown[i];
      if (pd.onScreen) return [];
      const run = runOf(i);
      const picked = run ? this.copyPicked(a, run) : 0;
      if (run && Math.floor((i - run.at) / run.rows) !== picked) return [];
      const row = this.paramRow(m, def, pd, { label: r.label, rename: () => this.renameRef(r, 'parameter'), open, ...this.rowShow(r, tie) });
      const first = run && i === run.at + picked * run.rows;
      const lead = first ? a.params[run.at] : r;   // (the run's heading and column break stay above whichever copy shows)
      const above = [...(lead.head ? [this.heading(a, first ? run.at : i)] : []), ...(first ? [this.copyPicker(a, run)] : [])];
      return [{ el: row, input: pd.input ? { module: m.id, port: pd.input } : undefined, col: !!lead.col, above, span: pd.screen ? r.span : undefined, gap: !!starts.get(first ? run.at : i) && !lead.col && !lead.head && !run }];
    });
    body.append(...this.edgeLayout(ins, outs, params));
    if (!a.inputs.length && !a.outputs.length && !a.params.length) {
      const hint = document.createElement('p');
      hint.className = 'muted empty';
      hint.textContent = 'nothing exposed: open it and mark ports and parameters';
      body.append(hint);
    }
    el.append(head, body);
    return el;
  }

  // ---- arranging a collapsed assembly card: the order of its rows and jacks, column breaks, headings

  /** the collapsed assembly whose card is being arranged (its menu's Arrange the card), else null */
  private arrangeAsm: number | null = null;
  /** a heading just added (`asm:row`): drawn as an empty field with the focus until it gets a text */

  /** a layout change of an assembly card: undoable, saved, no engine reload */
  private layoutChange(fn: () => void): void {
    const before = this.mark();
    fn();
    if (!this.commit(before)) return this.rebuild();
    this.rebuild();
    this.ev.onLayout(this.patch);
  }

  /** a heading above row `i` on the collapsed card: plain text (double-click renames; empty removes it) */
  private heading(a: AssemblyInst, i: number): HTMLElement {
    const r = a.params[i];
    const h = document.createElement('div');
    h.className = 'ehead';
    h.textContent = r.head ?? '';
    h.title = 'double-click to rename';
    h.ondblclick = () => {
      const v = window.prompt('Heading (empty removes it)', r.head ?? '');
      if (v !== null) this.layoutChange(() => setHeading(a.params, i, v));
    };
    return h;
  }

  /** while arranging: the mark of a column break above the column's first row, with a button to join the columns */
  private columnChip(a: AssemblyInst, i: number): HTMLElement {
    const c = document.createElement('div');
    c.className = 'ebreak';
    c.textContent = 'new column';
    c.append(this.button('×', 'Join with the column before', () => this.layoutChange(() => setColumnBreak(a.params, i, false)), 'sm arr-x'));
    return c;
  }

  /** while arranging: on a row's top edge, a column break before it; on a display that could reach across `room`
   * columns, ↔ steps how many it spans (1 .. room, then back to 1) */
  private arrangeTools(a: AssemblyInst, i: number, room = 0): HTMLElement {
    const t = document.createElement('span');
    t.className = 'arr-tools';
    const r = a.params[i];
    if (i > 0 && !r.col) t.append(this.button('↦ column', 'Start a new column with this row', () => this.layoutChange(() => setColumnBreak(a.params, i, true)), 'sm'));
    if (room > 1) {
      const now = Math.min(r.span ?? 1, room);
      const next = now >= room ? 1 : now + 1;
      t.append(this.button(`↔ span ${now}`, next > 1 ? `Reach across ${next} columns` : 'Back to its own column', () => this.layoutChange(() => setSpan(a.params, i, next)), 'sm arr-span'));
    }
    const c = r.copies;
    t.append(this.button(c ? `⧉ ${c.count} × ${c.rows}` : '⧉ one at a time',
      'Copies of the same controls the original edits one at a time (the CZ\'s envelope steps): the card shows one, picked by a step row; the FM-1 starts each on a new page',
      () => this.askCopies(a, i), 'sm'));
    for (const b of t.querySelectorAll('button')) b.addEventListener('pointerdown', (e) => e.stopPropagation());
    return t;
  }

  /** ask how many copies of how many rows start at row `i` (`RowCopies`): "8 x 2 step" = eight steps of two rows */
  private askCopies(a: AssemblyInst, i: number): void {
    const c = a.params[i].copies;
    const v = window.prompt(`Copies shown one at a time from this row: how many copies, of how many rows each, and the picker's name (e.g. "8 x 2 step": eight steps of a rate and a level; up to ${COPIES_MAX} of ${COPY_ROWS_MAX} rows). Empty: plain rows again`, c ? `${c.count} x ${c.rows} ${c.name ?? 'step'}` : '8 x 2 step');
    if (v === null) return;
    const m = /^\s*(\d+)\s*[x×*]\s*(\d+)\s*(.*)$/i.exec(v);
    this.layoutChange(() => setCopies(a.params, i, m ? Number(m[2]) : 0, m ? Number(m[1]) : 0, m?.[3]));
  }

  // ---- Arrange mode's rows (D-616): sections (a heading and its rows) cut into pages (one FM-1 page each), read from
  // and written back through arrange.ts. An overlay over the card draws a faint outline around each section and each
  // page, the page's handle on its outline, the one line where a drag would land, + heading, + page break and the × of
  // a page break set by hand.

  /** "ci:at" of the heading field Arrange mode shows before it exists (+ heading): `${assembly id}:${column}:${index}` */
  private newHeading: string | null = null;

  /** whether a row takes a knob, is a display, or is not drawn (set from a module's screen, or gone): arrange.ts KnobOf */
  private knobOf(): KnobOf {
    return (r) => {
      const m = this.patch.modules.find((x) => x.id === r.module);
      const pd = m && rowDef(DEFS[m.type], r.param);
      return !pd || pd.onScreen ? null : !pd.screen;
    };
  }

  /** the rows of the card being arranged, from its layout tree; the overlay follows once the card is on the page */
  private arrangeRows(a: AssemblyInst, body: HTMLElement, spanRoom: number[]): EdgeParam[] {
    const knob = this.knobOf();
    const layout = layoutOf(a.params, a.heads);
    // + heading clicked: a field with no name yet, a new section there (or the name of the rows a column starts with)
    let transient: Sec | null = null;
    const want = this.newHeading?.startsWith(`${a.id}:`) ? this.newHeading.split(':').slice(1).map(Number) : null;
    if (want && layout[want[0]]) {
      const col = layout[want[0]];
      if (want[1] === 0 && col.secs[0]?.head === undefined) transient = col.secs[0];
      else col.secs.splice(want[1], 0, (transient = { rows: [] }));
      transient.head = '';
    }
    const ctx: ArrangeCtx = { a, layout, knob, body, secs: [], transient, line: null };
    const idx = new Map(a.params.map((r, i) => [rowKey(r), i]));
    const out: EdgeParam[] = [];
    layout.forEach((col, ci) => {
      let pending: HTMLElement[] = [];
      let firstInCol = true;
      let last: EdgeParam | null = null;
      col.secs.forEach((sec, si) => {
        const head = sec.head !== undefined ? this.arrangeHeading(ctx, sec, ci, si) : null;
        const entry: ArrSec = { sec, col: ci, index: si, head, empty: null,
          pages: pagesOf(sec, knob).map((rows) => ({ rows, drawn: rows.filter((r) => knob(r) !== null), els: [] })) };
        ctx.secs.push(entry);
        if (!entry.pages.some((pg) => pg.drawn.length)) {
          if (!head) return;
          const box = document.createElement('div');
          box.className = 'eempty';
          box.textContent = 'empty: drop rows here';
          entry.empty = box;
          head.classList.add('arr-secstart');
          pending.push(head, box);
          return;
        }
        let firstRow = true;
        for (const pg of entry.pages) for (const r of pg.drawn) {
          const i = idx.get(rowKey(r))!;
          const orig = a.params[i];
          const m = this.patch.modules.find((x) => x.id === r.module)!;
          const def = DEFS[m.type];
          const pd = rowDef(def, r.param)!;
          const row = this.paramRow(m, def, pd, { label: orig.label, rename: () => this.renameRef(orig, 'parameter'), ...this.rowShow(orig, null) });
          row.classList.add('arr-row');
          const above: HTMLElement[] = [];
          if (firstInCol && ci > 0) above.push(this.columnChip(a, i));
          above.push(...pending);
          pending = [];
          if (firstRow) {
            if (head) above.push(head);
            (head ?? row).classList.add('arr-secstart');
          } else if (!pg.els.length) row.classList.add('arr-pgstart');
          pg.els.push(row);
          this.arrangeRow(row, ctx, rowKey(r), this.selectable(row, orig));
          row.append(this.arrangeTools(a, i, pd.screen ? spanRoom[i] : 0));
          last = { el: row, input: pd.input ? { module: m.id, port: pd.input } : undefined, col: firstInCol && out.length > 0, above, span: pd.screen ? orig.span : undefined };
          out.push(last);
          firstInCol = false;
          firstRow = false;
        }
      });
      // headings with no rows at the column's end; the column's last element leaves room for + heading under it
      const tail = last as EdgeParam | null;
      if (tail && pending.length) tail.below = pending;
      if (tail) (tail.below?.[tail.below.length - 1] ?? tail.el).classList.add('arr-colend');
    });
    requestAnimationFrame(() => this.drawArrange(ctx));
    return out;
  }

  /** a heading of the card being arranged: its grip (drags the section), the field with the FM-1's page name in it, × */
  private arrangeHeading(ctx: ArrangeCtx, sec: Sec, ci: number, si: number): HTMLElement {
    const fresh = sec === ctx.transient;
    const h = document.createElement('div');
    h.className = 'ehead arr-head';
    if (!fresh) {
      const grip = document.createElement('span');
      grip.className = 'arr-grip';
      grip.textContent = '⠿';
      grip.title = 'Drag: move this section with its pages (between sections, in any column)';
      grip.addEventListener('pointerdown', (e) => this.dragSection(e, ctx, sec, h));
      h.append(grip);
    }
    const field = document.createElement('label');
    field.className = 'hfield';
    const input = document.createElement('input');
    input.type = 'text';
    input.value = sec.head ?? '';
    input.placeholder = 'heading';
    input.maxLength = 40;
    input.setAttribute('aria-label', 'Heading');
    const fm = document.createElement('span');
    fm.className = 'fm1';
    fm.title = "The FM-1's name for these pages";
    const name = (): void => { fm.textContent = `(${fm1Name(input.value, NAME_MAX)})`; };
    name();
    let done = false;
    const commit = (): void => {
      if (done) return;
      done = true;
      if (fresh && !input.value.trim()) {
        this.newHeading = null;
        this.rebuild();
        return;
      }
      if (!fresh && input.value.trim() === sec.head) return;
      this.arrangeChange(ctx, () => renameHeading(ctx.layout, sec, input.value));
    };
    input.oninput = name;
    input.onchange = commit;
    input.onblur = () => { if (fresh || !input.value.trim()) commit(); };
    input.onkeydown = (e) => {
      e.stopPropagation(); // typing is not shortcuts
      if (e.key === 'Enter' || e.key === 'Escape') input.blur();
    };
    input.onpointerdown = (e) => e.stopPropagation();
    field.append(input, fm);
    const x = this.button('×', sec.rows.length ? 'Remove the heading (its rows join the section above)' : 'Remove the heading', () => {
      if (fresh) { this.newHeading = null; this.rebuild(); return; }
      this.arrangeChange(ctx, () => removeHeading(ctx.layout, sec));
    }, 'sm arr-x');
    h.append(field, x);
    h.dataset.sec = `${ci}:${si}`;
    if (fresh) requestAnimationFrame(() => input.focus());
    return h;
  }

  /** an edit of the layout tree, written back to the card as one undo step */
  private arrangeChange(ctx: ArrangeCtx, fn: () => void): void {
    this.newHeading = null;
    this.layoutChange(() => {
      fn();
      // a + heading field that got no name is not part of the card
      const t = ctx.transient;
      if (t?.head === '') {
        if (t.rows.length) delete t.head;
        else for (const col of ctx.layout) col.secs = col.secs.filter((s) => s !== t);
      }
      setLayout(ctx.a, ctx.layout);
    });
  }

  /** the outlines of the sections and pages in client coordinates, measured now */
  private arrangeBoxes(ctx: ArrangeCtx): { sec: Box | null; pages: (Box | null)[] }[] {
    const rect = (el: HTMLElement): Box => el.getBoundingClientRect();
    const union = (bs: Box[]): Box | null => (bs.length ? { left: Math.min(...bs.map((b) => b.left)), top: Math.min(...bs.map((b) => b.top)),
      right: Math.max(...bs.map((b) => b.right)), bottom: Math.max(...bs.map((b) => b.bottom)) } : null);
    return ctx.secs.map((e) => {
      const pages = e.pages.map((pg) => {
        const u = union(pg.els.map(rect));
        return u && { left: u.left - ARR_HANDLE, top: u.top - 2, right: u.right + 2, bottom: u.bottom + 2 };
      });
      const u = union([...(e.head ? [rect(e.head)] : []), ...(e.empty ? [rect(e.empty)] : []), ...pages.filter((b): b is Box => !!b)]);
      return { sec: u && { left: u.left - 3, top: u.top - 3, right: u.right + 3, bottom: u.bottom + 3 }, pages };
    });
  }

  /** draw the overlay of the card being arranged (after layout: it measures the rows) */
  private drawArrange(ctx: ArrangeCtx): void {
    const body = ctx.body;
    if (!body.isConnected) return;
    body.querySelector(':scope > .arr-ov')?.remove();
    const ov = document.createElement('div');
    ov.className = 'arr-ov';
    body.append(ov);
    const br = body.getBoundingClientRect();
    const k = br.width / (body.offsetWidth || 1) || 1;
    const put = (el: HTMLElement, b: Box): HTMLElement => {
      Object.assign(el.style, { left: `${(b.left - br.left) / k}px`, top: `${(b.top - br.top) / k}px`, width: `${(b.right - b.left) / k}px`, height: `${(b.bottom - b.top) / k}px` });
      ov.append(el);
      return el;
    };
    const div = (cls: string): HTMLElement => { const d = document.createElement('div'); d.className = cls; return d; };
    const boxes = this.arrangeBoxes(ctx);
    const act = (fn: () => void) => () => this.arrangeChange(ctx, fn);
    ctx.secs.forEach((e, si) => {
      const b = boxes[si];
      if (b.sec) put(div('arr-secbox'), b.sec);
      e.pages.forEach((pg, pi) => {
        const pb = b.pages[pi];
        if (!pb) return;
        const box = put(div('arr-pgbox'), pb);
        const grip = div('arr-pghandle');
        grip.textContent = '⠿';
        grip.title = 'Drag: move this page (one FM-1 page)';
        grip.addEventListener('pointerdown', (ev) => this.dragPage(ev, ctx, e, pi, box));
        put(grip, { left: pb.left, top: pb.top, right: pb.left + ARR_HANDLE * k, bottom: pb.top + 20 * k });
        // between two rows of a page: + page break
        pg.els.forEach((el, j) => {
          if (j === 0) return;
          const y = (pg.els[j - 1].getBoundingClientRect().bottom + el.getBoundingClientRect().top) / 2;
          const z = put(div('arr-zone'), { left: pb.left + ARR_HANDLE * k, top: y - 5 * k, right: pb.right, bottom: y + 5 * k });
          const key = rowKey(pg.drawn[j]);
          z.append(this.button('+ page break', 'Start a new FM-1 page here', act(() => addBreak(ctx.layout, key, ctx.knob)), 'sm arr-zbtn'));
        });
        // a page break set by hand: its × between the two pages
        const prev = b.pages[pi - 1];
        if (pi > 0 && prev && pg.rows[0].group) {
          const y = (prev.bottom + pb.top) / 2;
          const z = put(div('arr-brk'), { left: pb.left + ARR_HANDLE * k, top: y - 7 * k, right: pb.right, bottom: y + 7 * k });
          const key = rowKey(pg.rows[0]);
          z.append(this.button('page break ×', 'Remove this page break: the two pages join', act(() => removeBreak(ctx.layout, key)), 'sm arr-brkx'));
        }
      });
    });
    // + heading: at the top of each column and under each section
    ctx.layout.forEach((col, ci) => {
      const own = ctx.secs.map((e, i) => ({ e, b: boxes[i].sec })).filter((x) => x.e.col === ci && x.b);
      if (!own.length) return;
      const add = (at: number, y: number, b: Box): void => {
        const z = put(div('arr-zone arr-hzone'), { left: b.left, top: y - 6 * k, right: b.right, bottom: y + 6 * k });
        z.append(this.button('+ heading', 'A heading here (it stays when it has no rows)', () => {
          this.newHeading = `${ctx.a.id}:${ci}:${at}`;
          this.rebuild();
        }, 'sm arr-zbtn'));
      };
      if (!ctx.transient || ctx.secs.find((e) => e.sec === ctx.transient)?.col !== ci) add(0, own[0].b!.top - 8 * k, own[0].b!);
      own.forEach((x) => add(x.e.index + 1, x.b!.bottom + 8 * k, x.b!));
    });
    ctx.line = div('arr-line');
    ctx.line.hidden = true;
    ov.append(ctx.line);
  }

  /** show the drop line at a spot (none: hide it); what arrangeDrag marks */
  private arrangeLine(ctx: ArrangeCtx, spot: ArrSpot | null): { el: HTMLElement; after: boolean } | null {
    const line = ctx.line;
    if (!line) return null;
    line.hidden = !spot;
    if (!spot) return null;
    const br = ctx.body.getBoundingClientRect();
    const k = br.width / (ctx.body.offsetWidth || 1) || 1;
    Object.assign(line.style, { left: `${(spot.x1 - br.left) / k}px`, top: `${(spot.y - br.top) / k - 1.5}px`, width: `${(spot.x2 - spot.x1) / k}px` });
    return { el: line, after: false };
  }

  /** the spot nearest the pointer, if one is close */
  private nearestSpot(spots: ArrSpot[], x: number, y: number): ArrSpot | null {
    let best: ArrSpot | null = null;
    let dist = 80;
    for (const s of spots) {
      const dx = Math.max(s.x1 - x, 0, x - s.x2);
      const d = Math.hypot(dx * 2, y - s.y);
      if (d < dist) { dist = d; best = s; }
    }
    return best;
  }

  /** where rows (their keys) can land: inside a page at its start, between its rows or at its end; into an empty
   * section. Never where nothing would change, and one knob row never into another page that has PAGE_ROWS knobs */
  private rowSpots(ctx: ArrangeCtx, keys: string[]): ArrSpot[] {
    const set = new Set(keys);
    const one = keys.length === 1 ? keys[0] : null;
    const oneKnob = one ? !!ctx.secs.flatMap((e) => e.sec.rows).find((r) => rowKey(r) === one && ctx.knob(r)) : false;
    const boxes = this.arrangeBoxes(ctx);
    const spots: ArrSpot[] = [];
    const go = (to: RowSpot) => () => moveRows(ctx.layout, keys, to, ctx.knob);
    ctx.secs.forEach((e, si) => {
      if (e.empty) {
        const r = e.empty.getBoundingClientRect();
        spots.push({ x1: r.left, x2: r.right, y: (r.top + r.bottom) / 2, act: go({ sec: e.sec }) });
        return;
      }
      e.pages.forEach((pg, pi) => {
        const b = boxes[si].pages[pi];
        if (!b) return;
        const own = pg.rows.some((r) => set.has(rowKey(r)));
        if (one && oneKnob && !own && pg.rows.filter((r) => ctx.knob(r)).length >= PAGE_ROWS) return;
        const x1 = b.left + ARR_HANDLE;
        const first = rowKey(pg.rows[0]);
        if (!set.has(first)) spots.push({ x1, x2: b.right, y: b.top + 3, act: go({ sec: e.sec, before: first, start: true }) });
        pg.drawn.forEach((r, j) => {
          if (j === 0) return;
          const key = rowKey(r);
          if (set.has(key) || set.has(rowKey(pg.drawn[j - 1]))) return;
          const y = (pg.els[j - 1].getBoundingClientRect().bottom + pg.els[j].getBoundingClientRect().top) / 2;
          spots.push({ x1, x2: b.right, y, act: go({ sec: e.sec, before: key }) });
        });
        const lastKey = rowKey(pg.rows[pg.rows.length - 1]);
        if (!set.has(lastKey)) spots.push({ x1, x2: b.right, y: b.bottom - 3, act: go({ sec: e.sec, after: lastKey }) });
      });
    });
    return spots;
  }

  /** a row of the card being arranged: dragging it (or the selection it is in) to a spot; Shift / Cmd / Ctrl-click
   * selects (#186); a finger drags after a long press */
  private arrangeRow(el: HTMLElement, ctx: ArrangeCtx, key: string, sel: string): void {
    el.classList.add('arr-item');
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || (e.target as HTMLElement).closest('.arr-tools, input[type=text]')) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.shiftKey || e.metaKey || e.ctrlKey) return this.rowClick(sel, e.shiftKey);
      const card = el.closest<HTMLElement>('.module')!;
      const touch = e.pointerType === 'touch';
      const block = (): boolean => this.rowSel.has(sel) && this.rowSel.size > 1;
      const keys = (): string[] => (block() ? ctx.secs.flatMap((s) => s.sec.rows.map(rowKey)).filter((k) => this.rowSel.has(k)) : [key]);
      let spots: ArrSpot[] | null = null;
      let spot: ArrSpot | null = null;
      this.arrangeDrag(e, card, {
        live: !touch || (this.rowTouch && this.rowSel.has(sel)),
        moving: () => (block() ? this.selRows.filter((r) => this.rowSel.has(r.key)).map((r) => r.el) : [el]),
        held: () => this.rowHeld(sel),
        tap: () => touch && this.rowTouch && this.rowClick(sel, false),
        aim: (x, y) => {
          spots ??= this.rowSpots(ctx, keys());
          spot = this.nearestSpot(spots, x, y);
          return this.arrangeLine(ctx, spot);
        },
        drop: () => { const s = spot; if (s) this.arrangeChange(ctx, s.act); },
      });
    }, true);
  }

  /** a page's handle: the page moves whole, between pages or into an empty section */
  private dragPage(e: PointerEvent, ctx: ArrangeCtx, entry: ArrSec, pi: number, box: HTMLElement): void {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const keys = entry.pages[pi].rows.map(rowKey);
    let spot: ArrSpot | null = null;
    let spots: ArrSpot[] | null = null;
    const make = (): ArrSpot[] => {
      const boxes = this.arrangeBoxes(ctx);
      const out: ArrSpot[] = [];
      ctx.secs.forEach((e2, si) => {
        const go = (to: RowSpot) => () => moveRows(ctx.layout, keys, to, ctx.knob, true);
        if (e2.empty) {
          const r = e2.empty.getBoundingClientRect();
          out.push({ x1: r.left, x2: r.right, y: (r.top + r.bottom) / 2, act: go({ sec: e2.sec }) });
          return;
        }
        const pbs = boxes[si].pages;
        const n = pbs.length;
        for (let q = 0; q <= n; q++) {
          if (e2 === entry && (q === pi || q === pi + 1)) continue;
          const b = pbs[Math.min(q, n - 1)];
          if (!b) continue;
          const y = q === 0 ? b.top - 4 : q === n ? b.bottom + 4 : (pbs[q - 1]!.bottom + b.top) / 2;
          out.push({ x1: b.left, x2: b.right, y, act: go(q < n ? { sec: e2.sec, before: rowKey(e2.pages[q].rows[0]) } : { sec: e2.sec }) });
        }
      });
      return out;
    };
    this.arrangeDrag(e, ctx.body.closest<HTMLElement>('.module')!, {
      live: e.pointerType !== 'touch',
      moving: () => [box, ...entry.pages[pi].els],
      aim: (x, y) => { spots ??= make(); spot = this.nearestSpot(spots, x, y); return this.arrangeLine(ctx, spot); },
      drop: () => { const s = spot; if (s) this.arrangeChange(ctx, s.act); },
    });
  }

  /** a heading's grip: the section moves whole, to the top or end of a column or between two sections */
  private dragSection(e: PointerEvent, ctx: ArrangeCtx, sec: Sec, head: HTMLElement): void {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const entry = ctx.secs.find((x) => x.sec === sec)!;
    let spot: ArrSpot | null = null;
    let spots: ArrSpot[] | null = null;
    const make = (): ArrSpot[] => {
      const boxes = this.arrangeBoxes(ctx);
      const out: ArrSpot[] = [];
      ctx.layout.forEach((_, ci) => {
        const own = ctx.secs.map((x, i) => ({ x, b: boxes[i].sec })).filter((y) => y.x.col === ci && y.b);
        const n = own.length;
        for (let q = 0; q <= n; q++) {
          if (q < n && own[q].x.sec.head === undefined) continue; // never above the rows a column goes on with
          if (q < n && own[q].x === entry) continue;
          if (q > 0 && own[q - 1].x === entry) continue;
          const b = own[Math.min(q, n - 1)].b!;
          const y = q === 0 ? b.top - 5 : q === n ? b.bottom + 5 : (own[q - 1].b!.bottom + b.top) / 2;
          const before = q < n ? own[q].x.sec : undefined;
          out.push({ x1: b.left, x2: b.right, y, act: () => moveSection(ctx.layout, sec, { col: ci, before }) });
        }
      });
      return out;
    };
    this.arrangeDrag(e, ctx.body.closest<HTMLElement>('.module')!, {
      live: e.pointerType !== 'touch',
      moving: () => [head, ...(entry.empty ? [entry.empty] : []), ...entry.pages.flatMap((pg) => pg.els)],
      aim: (x, y) => { spots ??= make(); spot = this.nearestSpot(spots, x, y); return this.arrangeLine(ctx, spot); },
      drop: () => { const s = spot; if (s) this.arrangeChange(ctx, s.act); },
    });
  }

  /**
   * While arranging, a row or jack can be dragged before or after another of its kind (rows among rows, inputs among
   * inputs, outputs among outputs). A mouse drags at once, a finger after a long press. A selected row (`key`, #186)
   * drags the whole selection as one block; Shift / Cmd / Ctrl-click selects. A finger's long press starts a selection
   * (and can drag on at once), then taps add or remove rows and a selected row drags at once.
   */
  private arrangeItem(el: HTMLElement, a: AssemblyInst, kind: 'in' | 'out', index: number, key?: string): void {
    el.dataset.arrKind = kind;
    el.dataset.arrIndex = String(index);
    el.classList.add('arr-item');
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || (e.target as HTMLElement).closest('.arr-tools, input[type=text]')) return;
      e.preventDefault();
      e.stopPropagation();
      if (key && (e.shiftKey || e.metaKey || e.ctrlKey)) return this.rowClick(key, e.shiftKey);
      const card = el.closest<HTMLElement>('.module')!;
      const touch = e.pointerType === 'touch';
      // the rows that move: the selection when this row is in it (more than one), else this row
      const block = (): number[] | null => {
        if (!key || !this.rowSel.has(key) || this.rowSel.size < 2) return null;
        return a.params.map((r, i) => (this.rowSel.has(`${r.module}:${r.param}`) ? i : -1)).filter((i) => i >= 0);
      };
      const moving = (): HTMLElement[] => (block() ? this.selRows.filter((r) => this.rowSel.has(r.key)).map((r) => r.el) : [el]);
      this.arrangeDrag(e, card, {
        live: !touch || (this.rowTouch && !!key && this.rowSel.has(key)),
        moving,
        held: () => key && this.rowHeld(key),
        tap: () => key && touch && this.rowTouch && this.rowClick(key, false),
        aim: (x, y) => {
          const b = block();
          const skip = (c: HTMLElement): boolean => c === el || (!!b && b.includes(Number(c.dataset.arrIndex)));
          return this.arrangeTarget(card, kind, skip, x, y);
        },
        drop: (t) => {
          const to = Number(t.el.dataset.arrIndex);
          const after = t.after && !t.el.dataset.arrBefore;
          const b = block();
          this.layoutChange(() => {
            if (kind === 'in') a.inputs = moveRef(a.inputs, index, to, after);
            else a.outputs = moveRef(a.outputs, index, to, after);
          });
        },
      });
    }, true);
  }

  /**
   * An arrange drag from a press on `card`: a mouse drags at once, a finger after a long press (or at once when `live`).
   * `aim` finds the drop place under the pointer (marked before / after an element), `drop` acts on it; a press that does
   * not move is a tap.
   */
  private arrangeDrag(e: PointerEvent, card: HTMLElement, o: {
    live: boolean;
    moving: () => HTMLElement[];
    held?: () => unknown;
    tap?: () => unknown;
    aim: (x: number, y: number) => { el: HTMLElement; after: boolean } | null;
    drop: (t: { el: HTMLElement; after: boolean }) => void;
  }): void {
    const x0 = e.clientX, y0 = e.clientY;
    let live = o.live;
    let started = false;
    let held = false;
    let moving: HTMLElement[] = [];
    let target: { el: HTMLElement; after: boolean } | null = null;
    const hold = live ? 0 : window.setTimeout(() => {
      live = true;
      held = true;
      o.held?.();
      moving = o.moving();
      for (const m of moving) m.classList.add('arr-held');
    }, LONG_PRESS_MS);
    const mark = (t: typeof target): void => {
      card.querySelectorAll('.arr-before, .arr-after').forEach((x) => x.classList.remove('arr-before', 'arr-after'));
      if (t) t.el.classList.add(t.after ? 'arr-after' : 'arr-before');
    };
    const move = (ev: PointerEvent): void => {
      if (ev.pointerId !== e.pointerId) return;
      if (!live) {
        if (Math.hypot(ev.clientX - x0, ev.clientY - y0) > 8) end(); // a swipe, not a long press
        return;
      }
      if (!started && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 4) return;
      if (!started) {
        started = true;
        moving = o.moving();
        for (const m of moving) m.classList.add('arr-dragging');
      }
      target = o.aim(ev.clientX, ev.clientY);
      mark(target);
    };
    const end = (): void => {
      window.clearTimeout(hold);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', end);
      for (const m of moving) m.classList.remove('arr-dragging', 'arr-held');
      mark(null);
    };
    const up = (ev: PointerEvent): void => {
      if (ev.pointerId !== e.pointerId) return;
      const t = target;
      end();
      if (!started) {
        if (!held) o.tap?.();
        return;
      }
      if (t) o.drop(t);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', end);
  }

  /** the item of `kind` nearest the pointer on the card (not one `skip` says), and whether the drop goes after it (below;
   * right of a bottom jack) */
  private arrangeTarget(card: HTMLElement, kind: string, skip: (c: HTMLElement) => boolean, x: number, y: number): { el: HTMLElement; after: boolean } | null {
    let best: { el: HTMLElement; after: boolean } | null = null;
    let dist = Infinity;
    for (const c of card.querySelectorAll<HTMLElement>(`[data-arr-kind="${kind}"]`)) {
      if (skip(c)) continue;
      const r = c.getBoundingClientRect();
      const d = Math.hypot(Math.max(r.left - x, 0, x - r.right), Math.max(r.top - y, 0, y - r.bottom));
      if (d >= dist) continue;
      dist = d;
      const across = c.classList.contains('bottom');
      best = { el: c, after: across ? x > r.left + r.width / 2 : y > r.top + r.height / 2 };
    }
    return best;
  }

  /** a Drum map row's name (the roll shows it; at most TRACK_NAME_MAX characters, empty: the default) */
  private renameDrumRow(m: ModuleInst, r: number): void {
    const was = drumRowName(m.names, r);
    const v = window.prompt(`Name of row ${r + 1} (${TRACK_NAME_MAX} characters; empty: ${drumRowName(undefined, r)})`, was);
    if (v === null) return;
    const name = trackName(v);
    if (name === (m.names?.[r] ?? '')) return;
    this.change(() => {
      m.names = Array.from({ length: DRUM_ROWS }, (_, k) => (k === r ? name : m.names?.[k] ?? ''));
      fixTrack(m);
    });
  }

  /** the copy each run of copies on a card shows (by `asm:first row`), 0 until another is picked; not saved */
  private copyAt = new Map<string, number>();
  private copyPicked(a: AssemblyInst, run: { at: number; count: number }): number {
    return Math.min(run.count - 1, this.copyAt.get(`${a.id}:${run.at}`) ?? 0);
  }

  /** the row that picks which copy of a run a collapsed card shows ("step 1 .. 8", the CZ's step select) */
  private copyPicker(a: AssemblyInst, run: { at: number; count: number; name: string }): HTMLElement {
    const row = document.createElement('div');
    row.className = 'param bar choice sel copy-pick';
    const name = document.createElement('span');
    name.textContent = run.name;
    const sel = selector({
      label: `${a.label} ${run.name}`,
      names: Array.from({ length: run.count }, (_, k) => String(k + 1)),
      get: () => this.copyPicked(a, run),
      set: (k) => {
        this.copyAt.set(`${a.id}:${run.at}`, k);
        this.rebuild();
      },
    });
    row.title = `Which ${run.name} the rows below set: the card shows one at a time, as the original does (the FM-1: each starts a new page)`;
    row.append(name, sel.element);
    return row;
  }

  /** what a collapsed card's row shows besides its parameter (#357, #358): how many parameters it sets (a nested card's
   * row's too), its positions' names (its own, else a nested card's row's) */
  private rowShow(r: ParamRef, tie: Ties | null): { names?: string[]; ties?: number } {
    const n = tie ? tie.tied(r.module, r.param).length : 1 + (r.also?.length ?? 0);
    const names = r.names ?? tie?.names(r.module, r.param);
    return { ...(n > 1 ? { ties: n } : {}), ...(names ? { names } : {}) };
  }

  /** the names of a Selector's positions on its card row (#358): typed as a list, position 1 first */
  private nameRow(a: AssemblyInst, r: ParamRef): void {
    const v = window.prompt(`Names of the positions of "${r.label}", separated by commas, position 1 first (up to ${ROW_NAMES_MAX} of ${ROW_NAME_MAX} characters; none: the numbers)`, r.names?.join(', ') ?? '');
    if (v === null) return;
    const i = a.params.indexOf(r);
    this.change(() => setRowNames(a.params, i, v.split(',')));
  }

  /**
   * On a parameter of a card row inside an expanded assembly, in pick mode (#357, #358): a "one row with…" list of the
   * card's other rows of the same range (the row then sets both), a button to split a row that sets several, and on a
   * Selector's position row a button for its positions' names.
   */
  private rowTools(a: AssemblyInst, m: ModuleInst, pd: ParamDef): HTMLElement[] {
    const ref = rowOf(a, m.id, pd.name);
    if (!ref) return [];
    const out: HTMLElement[] = [];
    const primary = ref.module === m.id && ref.param === pd.name;
    const stop = (el: HTMLElement): HTMLElement => {
      el.addEventListener('pointerdown', (e) => e.stopPropagation());
      el.addEventListener('click', (e) => e.stopPropagation());
      return el;
    };
    if (primary && ref.also?.length) out.push(stop(this.button('split', `Split "${ref.label}": one row per parameter again`, () => this.change(() => splitRow(a, m.id, pd.name)), 'sm')));
    if (primary && m.type === 'select' && pd.name === 'pos') out.push(stop(this.button('names', `Name the positions of "${ref.label}": the card, the Selector and the FM-1 show the names`, () => this.nameRow(a, ref), 'sm')));
    const pdOf = (r: ParamRef): ParamDef | undefined => { const x = this.patch.modules.find((q) => q.id === r.module); return x && x.type !== 'alloc' ? rowDef(DEFS[x.type], r.param) : undefined; };
    const others = m.type === 'alloc' ? [] : a.params.filter((r) => r !== ref && pdOf(r) && sameRange(pd, pdOf(r)!));
    if (others.length) {
      const sel = document.createElement('select');
      sel.className = 'merge';
      sel.title = `Let another row of the "${a.label}" card set this parameter too: one row for both (the same range only)`;
      sel.setAttribute('aria-label', `set ${ref.label} with another row`);
      sel.append(new Option('one row with…', ''));
      for (const r of others) sel.append(new Option(r.label, `${r.module}:${r.param}`));
      sel.onchange = () => {
        const [mod, ...rest] = sel.value.split(':');
        if (!mod) return;
        this.change(() => mergeRows(this.patch, a, DEFS, { module: Number(mod), param: rest.join(':') }, { module: m.id, param: pd.name }));
      };
      out.push(stop(sel));
    }
    if (!out.length) return [];
    const box = document.createElement('span');
    box.className = 'row-tools';
    box.append(...out);
    return [box];
  }

  private renameRef(r: { label: string }, what: string): void {
    const v = window.prompt(`Label of this ${what}`, r.label)?.trim();
    if (v && v !== r.label) this.change(() => (r.label = v));
  }

  /** the frame around an expanded assembly's cards, with its header; placed by layoutFrames() once the cards have a size */
  private frame(a: AssemblyInst, perVoice: number): HTMLElement {
    const el = document.createElement('div');
    el.className = 'frame' + (a.bypass ? ' off' : '') + (this.selectedAsm.has(a.id) ? ' selected' : '');
    el.dataset.asm = String(a.id);
    const head = document.createElement('div');
    head.className = 'fhead';
    const tools = document.createElement('span');
    tools.className = 'tools';
    if (this.picking(a)) tools.append(...this.pickBar(a));
    tools.append(this.pickButton(a), ...this.assemblyButtons(a));
    el.classList.toggle('picking', this.picking(a));
    const title = this.titleOf(a, perVoice);
    title.prepend(this.tag(null, a));
    const chip = parentOf(this.patch, a.id) ? null : this.presetChip(a);   // (expanded too: the same ‹ name › as its card)
    head.append(this.chevron(a), title, ...(chip ? [chip] : []), tools);
    this.headMenu(head, (at) => this.assemblyMenu(a, at));
    el.append(head);
    this.frames.set(a.id, el);
    const parent = parentOf(this.patch, a.id);
    if (parent) tools.prepend(this.outButton(parent, () => this.takeOutAssembly(parent, a)));
    this.frameDrag(head, a);
    this.resizeAssembly(el, a);
    return el;
  }

  /**
   * The box around what an expanded assembly shows: its member cards, its children's cards (collapsed) or frames (expanded), in
   * canvas coordinates; `exclude` leaves cards out and `excludeAsm` children (while they are dragged)
   */
  private frameRect(a: AssemblyInst, exclude?: Set<number>, excludeAsm?: number): Rect | null {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    const take = (r: Rect): void => {
      x0 = Math.min(x0, r.x);
      y0 = Math.min(y0, r.y);
      x1 = Math.max(x1, r.x + r.w);
      y1 = Math.max(y1, r.y + r.h);
    };
    const box = (c: HTMLElement): Rect => ({ x: c.offsetLeft, y: c.offsetTop, w: c.offsetWidth, h: c.offsetHeight });
    for (const id of a.modules) {
      if (exclude?.has(id)) continue;
      const c = this.cards.get(id);
      if (c) take(box(c));
    }
    for (const ch of childrenOf(this.patch, a)) {
      if (ch.id === excludeAsm) continue;
      const c = this.containers.get(ch.id);
      if (c) take(box(c));
      else if (ch.open) {
        const r = this.frameRect(ch, exclude, excludeAsm);
        if (r) take(r);
      }
    }
    if (x0 === Infinity) return null;
    const head = FRAME_HEAD;
    return { x: x0 - FRAME_PAD_X, y: y0 - FRAME_PAD - head, w: Math.max(x1 - x0 + 2 * FRAME_PAD_X, a.frameSize?.width ?? 0), h: Math.max(y1 - y0 + 2 * FRAME_PAD + head, a.frameSize?.height ?? 0) };
  }

  private layoutFrames(exclude?: Set<number>, excludeAsm?: number): void {
    for (const a of assembliesOf(this.patch)) {
      const el = this.frames.get(a.id);
      if (!el) continue;
      const r = this.frameRect(a, exclude, excludeAsm) ?? this.frameRect(a);
      if (!r) continue;
      el.style.left = `${Math.max(0, r.x)}px`;
      el.style.top = `${Math.max(0, r.y)}px`;
      el.style.width = `${r.w}px`;
      el.style.height = `${r.h}px`;
    }
  }

  // ---- dragging and selection

  /** pointer drag on a handle: `move` gets the delta since the previous event, `up` runs at the end */
  private dragOn(handle: HTMLElement, start: (e: PointerEvent) => boolean, move: (dx: number, dy: number) => void, up: () => void): void {
    handle.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).closest('button')) return;
      if (!start(e)) return;
      e.preventDefault();
      let lx = e.clientX;
      let ly = e.clientY;
      // a long press (touch, no movement) opens the context menu instead of dragging
      const card = handle.closest('.module') as HTMLElement | null;
      const sx = e.clientX, sy = e.clientY;
      let press = 0;
      if (e.pointerType === 'touch' && card?.dataset.id) {
        press = window.setTimeout(() => {
          press = 0;
          onUp();
          const m = this.patch.modules.find((x) => x.id === Number(card.dataset.id));
          if (m) this.contextMenu(m, DEFS[m.type], { x: m.x + 20, y: m.y + 30 });
        }, LONG_PRESS_MS);
      }
      const onMove = (ev: PointerEvent): void => {
        if (press && Math.hypot(ev.clientX - sx, ev.clientY - sy) > 8) {
          clearTimeout(press);
          press = 0;
        }
        move((ev.clientX - lx) / this.zoom, (ev.clientY - ly) / this.zoom);
        lx = ev.clientX;
        ly = ev.clientY;
      };
      // `drop`: stop without finishing (a second finger landed; the pinch puts the patch back)
      const stop = (): void => {
        if (press) clearTimeout(press);
        press = 0;
        if (this.oneFinger === drop) this.oneFinger = null;
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
      };
      const drop = (): void => stop();
      const onUp = (): void => {
        stop();
        up();
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
      if (e.pointerType === 'touch') this.oneFinger = drop;
    });
  }

  private place(m: ModuleInst, dx: number, dy: number): void {
    m.x = Math.max(0, m.x + dx);
    m.y = Math.max(0, m.y + dy);
    const el = this.cards.get(m.id);
    if (el) {
      el.style.left = `${m.x}px`;
      el.style.top = `${m.y}px`;
    }
  }

  /**
   * What a drag of the selection moves: the selected assemblies that are not inside another selected one (each with
   * everything inside it) and the selected modules that none of those holds.
   */
  private dragSet(): { mods: ModuleInst[]; asms: AssemblyInst[] } {
    const sel = assembliesOf(this.patch).filter((a) => this.selectedAsm.has(a.id));
    const asms = sel.filter((a) => !sel.some((b) => b !== a && descendants(this.patch, b).some((d) => d.id === a.id)));
    const covered = new Set(asms.flatMap((a) => allModules(this.patch, a)));
    const mods = this.patch.modules.filter((m) => this.selected.has(m.id) && !covered.has(m.id));
    return { mods, asms };
  }

  /** move a drag set by (dx, dy): model and elements; the frames follow (a member pushes its frame's edge out) */
  private moveSet(set: { mods: ModuleInst[]; asms: AssemblyInst[] }, dx: number, dy: number): void {
    for (const m of set.mods) this.place(m, dx, dy);
    for (const a of set.asms) this.moveTree(a, dx, dy, false);
    this.layoutFrames();
    this.drawCables();
  }

  /** a press on a card's or frame's handle: shift toggles the item in the selection, else the drag takes the selection with it */
  private groupDrag(handle: HTMLElement, item: { module?: ModuleInst; asm?: AssemblyInst }, drop: (set: { mods: ModuleInst[]; asms: AssemblyInst[] }) => void): void {
    let set: { mods: ModuleInst[]; asms: AssemblyInst[] } = { mods: [], asms: [] };
    this.dragOn(
      handle,
      (e) => {
        const on = item.module ? this.selected.has(item.module.id) : this.selectedAsm.has(item.asm!.id);
        if (e.shiftKey) {
          if (item.module) this.toggleSelect(item.module.id);
          else this.toggleSelectAsm(item.asm!.id);
          return false;
        }
        if (!on) this.select(item.module ? [item.module.id] : [], item.asm ? [item.asm.id] : []);
        set = this.dragSet();
        this.touch();
        return true;
      },
      (dx, dy) => this.moveSet(set, dx, dy),
      () => {
        this.sizeCanvas();
        this.ev.onLayout(this.patch);
        drop(set);
      },
    );
  }

  private moduleDrag(handle: HTMLElement, m: ModuleInst): void {
    this.groupDrag(handle, { module: m }, (set) => this.dropped(set, true));
  }

  /**
   * After a drag: modules and collapsed assemblies that belong to no assembly join the innermost expanded frame they are
   * dropped into. A member never leaves its assembly by a drag (its frame grows to hold it): the ⇱ button takes it out.
   */
  private dropped(set: { mods: ModuleInst[]; asms: AssemblyInst[] }, nest: boolean): void {
    const movedIds = new Set(set.mods.map((m) => m.id));
    const moving = new Set(set.asms.flatMap((a) => [a.id, ...descendants(this.patch, a).map((d) => d.id)]));
    const ops: (() => void)[] = [];
    const innermost = (el: HTMLElement, skip: (b: AssemblyInst) => boolean): AssemblyInst | undefined => {
      const cx = el.offsetLeft + el.offsetWidth / 2;
      const cy = el.offsetTop + HEAD_Y; // where the hand is: the card's header, not its middle (cards are tall)
      let target: AssemblyInst | undefined;
      for (const b of assembliesOf(this.patch)) {
        if (!b.open || skip(b) || !this.frames.has(b.id)) continue;
        const r = this.frameRect(b, movedIds);
        if (r && cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h && (!target || depthOf(this.patch, b) > depthOf(this.patch, target))) target = b;
      }
      return target;
    };
    for (const m of set.mods) {
      if (assemblyOf(this.patch, m.id)) continue;
      const c = this.cards.get(m.id);
      const target = c && innermost(c, (b) => moving.has(b.id));
      if (target) ops.push(() => addMember(this.patch, target, m.id));
    }
    if (nest)
      for (const a of set.asms) {
        const el = this.containers.get(a.id);
        if (!el || parentOf(this.patch, a.id)) continue;
        const target = innermost(el, (b) => moving.has(b.id));
        if (target) ops.push(() => addChild(this.patch, target, a.id));
      }
    if (!ops.length) {
      this.layoutFrames();
      return;
    }
    const keep = [...this.selected], keepAsm = [...this.selectedAsm];
    if (this.change(() => ops.forEach((op) => op()))) this.select(keep, keepAsm);
  }

  /** the ⇱ on a member's header: take it out of its assembly (one level up), placed beside the frame */
  private outButton(a: AssemblyInst, run: () => void): HTMLButtonElement {
    return this.button('⇱', `Take out of "${a.label}"`, run, 'sm out');
  }

  private takeOutModule(a: AssemblyInst, m: ModuleInst): void {
    const r = this.frameRect(a, new Set([m.id]));
    const up = parentOf(this.patch, a.id);
    this.change(() => {
      removeMember(this.patch, a, m.id);
      if (up && assembliesOf(this.patch).includes(up)) addMember(this.patch, up, m.id);
      if (r) { m.x = Math.max(0, r.x + r.w + 24); m.y = Math.max(0, r.y); }
    });
  }

  private takeOutAssembly(parent: AssemblyInst, a: AssemblyInst): void {
    const r = this.frameRect(parent, undefined, a.id);
    const up = parentOf(this.patch, parent.id);
    this.change(() => {
      removeChild(this.patch, parent, a.id);
      if (up && assembliesOf(this.patch).includes(up)) addChild(this.patch, up, a.id);
      if (r) {
        const box = a.open ? this.frameRect(a) : { x: a.x, y: a.y };
        if (box) moveAssembly(this.patch, a, Math.max(0, r.x + r.w + 24) - box.x, Math.max(0, r.y) - box.y);
      }
    });
  }

  /** move an assembly with everything inside it, model and elements; `layout` = redraw the frames and cables too */
  private moveTree(a: AssemblyInst, dx: number, dy: number, layout = true): void {
    moveAssembly(this.patch, a, dx, dy);
    const asms = [a, ...descendants(this.patch, a)];
    const ids = new Set(asms.flatMap((x) => x.modules));
    for (const m of this.patch.modules) {
      const el = this.cards.get(m.id);
      if (!ids.has(m.id) || !el) continue;
      el.style.left = `${m.x}px`;
      el.style.top = `${m.y}px`;
    }
    for (const x of asms) {
      const el = this.containers.get(x.id);
      if (!el) continue;
      el.style.left = `${x.x}px`;
      el.style.top = `${x.y}px`;
    }
    if (!layout) return;
    this.layoutFrames();
    this.drawCables();
  }

  private assemblyDrag(_el: HTMLElement, handle: HTMLElement, a: AssemblyInst): void {
    this.groupDrag(handle, { asm: a }, (set) => this.dropped(set, true));
  }

  private frameDrag(handle: HTMLElement, a: AssemblyInst): void {
    this.groupDrag(handle, { asm: a }, (set) => this.dropped({ mods: set.mods, asms: [] }, false));
  }

  private select(ids: number[], asms: number[] = []): void {
    this.selected.clear();
    this.selectedAsm.clear();
    for (const id of ids) this.selected.add(id);
    for (const id of asms) this.selectedAsm.add(id);
    this.showSelection();
  }

  /** Ctrl / Cmd+A: every module and assembly at the top of the canvas (the docked Main is not a card) */
  selectAll(): boolean {
    const docked = this.docked();
    const inAsm = new Set(assembliesOf(this.patch).flatMap((a) => a.modules));
    const mods = this.patch.modules.filter((m) => m !== docked && !inAsm.has(m.id)).map((m) => m.id);
    const asms = assembliesOf(this.patch).filter((a) => !parentOf(this.patch, a.id)).map((a) => a.id);
    if (!mods.length && !asms.length) return false;
    this.select(mods, asms);
    return true;
  }

  private toggleSelect(id: number): void {
    if (this.selected.has(id)) this.selected.delete(id);
    else this.selected.add(id);
    this.showSelection();
  }

  private toggleSelectAsm(id: number): void {
    if (this.selectedAsm.has(id)) this.selectedAsm.delete(id);
    else this.selectedAsm.add(id);
    this.showSelection();
  }

  private showSelection(): void {
    for (const [id, el] of this.cards) el.classList.toggle('selected', this.selected.has(id));
    for (const [id, el] of [...this.containers, ...this.frames]) el.classList.toggle('selected', this.selectedAsm.has(id));
  }

  /** a drag on empty canvas selects the cards it touches; a click on empty canvas clears the selection */
  private rubberBand(e: PointerEvent): void {
    const t = e.target as HTMLElement;
    if (e.button !== 0) return;
    // touch: one finger on a card's body (not on a control) pans as on the empty canvas (.canvas is touch-action: none,
    // so the browser no longer scrolls it)
    const body = e.pointerType === 'touch' && !this.armed && !!t.closest('.module')
      && !t.closest('.mhead, .fhead, .dot, button, input, select, textarea, summary, label, output, .ctx, .sel-track, .dial, .step, .resize-handle, .arr-item, .param.screen, .rename, .slider-thumb, .slider-knob');
    // in pick and arrange mode a band may also start on a card's empty space: it selects rows (#186)
    const rowMode = this.inRowMode();
    const cardSpace = rowMode && e.pointerType !== 'touch' && !!t.closest('.module')
      && !t.closest('.mhead, .dot, .param, .port, .ehead, .ebreak, .arr-item, button, input, select, textarea, summary, label, .ctx, .resize-handle');
    if (!body && !cardSpace && t.closest('.module, .fhead, .dot, button, input, select, .ctx')) return;
    e.preventDefault();
    // a click on the empty canvas drops an armed jack's ghost cable
    if (this.armed) return this.cancelArm();
    if (e.pointerType === 'touch') {
      // one finger on the empty canvas pans it (a rubber band needs a mouse or shift); a tap there ends a finger's row
      // selection (#186)
      const x0 = e.clientX, y0 = e.clientY;
      let lx = e.clientX, ly = e.clientY;
      const pan = (ev: PointerEvent): void => {
        if (ev.pointerId !== e.pointerId) return;
        this.canvas.scrollBy(lx - ev.clientX, ly - ev.clientY);
        lx = ev.clientX;
        ly = ev.clientY;
      };
      const stop = (ev?: PointerEvent): void => {
        if (ev && ev.pointerId !== e.pointerId) return;
        if (ev?.type === 'pointerup' && this.rowTouch && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 8) this.clearRows();
        if (this.oneFinger === stop) this.oneFinger = null;
        window.removeEventListener('pointermove', pan);
        window.removeEventListener('pointerup', stop);
        window.removeEventListener('pointercancel', stop);
      };
      window.addEventListener('pointermove', pan);
      window.addEventListener('pointerup', stop);
      window.addEventListener('pointercancel', stop);
      this.oneFinger = stop; // a second finger: the pinch pans
      return;
    }
    const base = this.canvas.getBoundingClientRect();
    const at = (ev: PointerEvent): Pt => ({ x: (ev.clientX - base.left) / this.zoom + this.canvas.scrollLeft / this.zoom, y: (ev.clientY - base.top) / this.zoom + this.canvas.scrollTop / this.zoom });
    const o = at(e);
    const box = document.createElement('div');
    box.className = rowMode ? 'rubber rows' : 'rubber';
    this.modulesEl.append(box);
    let r: Rect = { x: o.x, y: o.y, w: 0, h: 0 };
    const move = (ev: PointerEvent): void => {
      const p = at(ev);
      r = { x: Math.min(o.x, p.x), y: Math.min(o.y, p.y), w: Math.abs(p.x - o.x), h: Math.abs(p.y - o.y) };
      Object.assign(box.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
    };
    const up = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (rowMode) {
        // the rows the band touches; a click on empty space clears the selection
        const b = box.getBoundingClientRect();
        box.remove();
        const big = r.w > 4 || r.h > 4;
        const hit = !big ? [] : this.selRows.filter((x) => {
          const q = x.el.getBoundingClientRect();
          return q.left < b.right && q.right > b.left && q.top < b.bottom && q.bottom > b.top;
        });
        if (!(e.shiftKey || e.metaKey || e.ctrlKey)) this.rowSel.clear();
        for (const x of hit) this.rowSel.add(x.key);
        this.rowTouch = false;
        return this.showRowSel();
      }
      box.remove();
      const hit: number[] = [];
      const hitAsm: number[] = [];
      if (r.w > 4 || r.h > 4) {
        const touches = (c: HTMLElement): boolean => c.offsetLeft < r.x + r.w && c.offsetLeft + c.offsetWidth > r.x && c.offsetTop < r.y + r.h && c.offsetTop + c.offsetHeight > r.y;
        const holds = (c: HTMLElement): boolean => c.offsetLeft >= r.x && c.offsetLeft + c.offsetWidth <= r.x + r.w && c.offsetTop >= r.y && c.offsetTop + c.offsetHeight <= r.y + r.h;
        // a frame is taken when the band holds all of it (a band inside a frame picks cards in it), a collapsed card when touched
        for (const [id, f] of this.frames) if (holds(f)) hitAsm.push(id);
        for (const [id, c] of this.containers) if (touches(c)) hitAsm.push(id);
        const taken = assembliesOf(this.patch).filter((a) => hitAsm.includes(a.id));
        const coveredMods = new Set(taken.flatMap((a) => allModules(this.patch, a)));
        const coveredAsm = new Set(taken.flatMap((a) => descendants(this.patch, a).map((d) => d.id)));
        for (const id of [...hitAsm]) if (coveredAsm.has(id)) hitAsm.splice(hitAsm.indexOf(id), 1);
        for (const [id, c] of this.cards) if (!coveredMods.has(id) && touches(c)) hit.push(id);
      }
      if (e.shiftKey) {
        hit.forEach((id) => this.selected.add(id));
        hitAsm.forEach((id) => this.selectedAsm.add(id));
      } else this.select(hit, hitAsm);
      this.showSelection();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  // ---- cables

  private center(el: HTMLElement, origin = this.world): Pt {
    const r = el.getBoundingClientRect();
    const c = origin.getBoundingClientRect();
    return { x: (r.left - c.left + r.width / 2) / this.zoom - origin.clientLeft, y: (r.top - c.top + r.height / 2) / this.zoom - origin.clientTop };
  }

  /**
   * A cable's Bézier points from a to b. An end leaves its jack sideways (out to the right, in from the left), upwards on
   * a docked jack (the dock is below the canvas) and downwards on a jack under a card's bottom edge. Taut, it is one curve
   * (split in two at its middle). Slack drops only the middle and puts a short straight stub at each end (`CABLE_STUB` at
   * full slack): a plug holds the cable straight and it bends most where it hangs free, so a drooping cable still leaves
   * its jack square, and one from a docked jack to a module just below the view still rises out of the dock before it falls.
   */
  private curvePts(a: Pt, b: Pt, dirA: CableEnd = 'side', dirB: CableEnd = 'side'): Pt[] {
    const stub = this.sway * CABLE_STUB;
    if (stub <= 0) return this.spanPts(a, b, dirA, dirB);
    const away = (p: Pt, dir: CableEnd, sx: number, t: number): Pt =>
      dir === 'up' ? { x: p.x, y: p.y - t } : dir === 'down' ? { x: p.x, y: p.y + t } : { x: p.x + sx * t, y: p.y };
    const sa = (t: number): Pt => away(a, dirA, 1, t);
    const sb = (t: number): Pt => away(b, dirB, -1, t);
    return [a, sa(stub / 3), sa((2 * stub) / 3), ...this.spanPts(sa(stub), sb(stub), dirA, dirB), sb((2 * stub) / 3), sb(stub / 3), b];
  }

  /** the curve between the stubs: two cubic segments joined in the middle; slack drops the middle, the ends stay square */
  private spanPts(a: Pt, b: Pt, dirA: CableEnd, dirB: CableEnd): Pt[] {
    const dx = Math.max(40, Math.abs(b.x - a.x) / 2);
    const dy = Math.max(60, Math.abs(b.y - a.y) / 2);
    const handle = (p: Pt, dir: CableEnd, sx: number): Pt => (dir === 'up' ? { x: p.x, y: p.y - dy } : dir === 'down' ? { x: p.x, y: p.y + dy } : { x: p.x + sx, y: p.y });
    const mid = (u: Pt, v: Pt): Pt => ({ x: (u.x + v.x) / 2, y: (u.y + v.y) / 2 });
    const p1 = handle(a, dirA, dx);
    const p2 = handle(b, dirB, -dx);
    // de Casteljau split at t = 1/2
    const q0 = mid(a, p1), q1 = mid(p1, p2), q2 = mid(p2, b);
    const r0 = mid(q0, q1), r1 = mid(q1, q2), m = mid(r0, r1);
    // slack: the middle drops by a share of the cable's length, so a long cable droops more than a short one
    const sag = this.sway * 0.75 * (0.6 * Math.hypot(b.x - a.x, b.y - a.y) + 40);
    if (sag <= 0) return [a, q0, r0, m, r1, q2, b];
    const lead = (p: Pt, q: Pt): Pt => {
      const len = Math.hypot(q.x - p.x, q.y - p.y) || 1;
      // the lead shortens as the slack grows, so the bend comes close to the plug
      const k = (len * (1 - 0.55 * this.sway) + 0.08 * sag) / len;
      return { x: p.x + (q.x - p.x) * k, y: p.y + (q.y - p.y) * k };
    };
    const drop = (p: Pt): Pt => ({ x: p.x, y: p.y + sag });
    return [a, lead(a, q0), drop(r0), drop(m), drop(r1), lead(b, q2), b];
  }

  private curve(a: Pt, b: Pt, dirA: CableEnd = 'side', dirB: CableEnd = 'side'): string {
    return pathOf(this.curvePts(a, b, dirA, dirB));
  }

  /** which way a cable leaves this jack */
  private endOf(el: HTMLElement): CableEnd {
    return this.inDock(el) ? 'up' : el.dataset.edge === 'bottom' ? 'down' : 'side';
  }

  /** the cables' continuation over the dock (see positionCables) */
  private get dockCables(): SVGSVGElement | null {
    return (this.dock?.parentElement?.querySelector('svg.dock-cables') as SVGSVGElement | null) ?? null;
  }
  /** a cable's copy on the dock overlay, clipped to the strip above each docked jack it ends at */
  private overPaths = new Map<SVGPathElement, { copy: SVGPathElement; clips: { rect: SVGRectElement; jack: HTMLElement }[] }>();

  private inDock(el: HTMLElement): boolean {
    return !!this.dock?.contains(el) || !!this.wheelHost?.contains(el);
  }

  /**
   * Cable paths are retained so animation only moves their endpoints. A cable to a docked jack is clipped by the canvas;
   * its copy on the dock's overlay draws the rest (the same curve, mapped from world to overlay space), but only the
   * strip between the jack and the dock's top edge: a cable to a module below the canvas's view stays under the panel.
   */
  /** the sidebar sliders' source cables, over everything up to their thumbs; each hidden while either end is not shown */
  /** the layer over the whole window for the cables into the sidebar sliders and the cable being dragged */
  private sideOverlay(): SVGSVGElement {
    if (!this.sideLayer) {
      this.sideLayer = document.createElementNS(SVGNS, 'svg') as SVGSVGElement;
      this.sideLayer.setAttribute('class', 'cables slack-cable');
      this.sideLayer.setAttribute('aria-hidden', 'true');
      document.body.append(this.sideLayer);
    }
    return this.sideLayer;
  }

  // ---- Main's knobs: K1..K4 edit the rows of the device page in focus (pages.ts)

  /** the device and page in focus */
  private focusedDevice(): Device | undefined { return this.gloOn ? this.gloDevice() : this.devices.find((d) => d.key === this.focus?.device); }
  private focusedPage(): Page | undefined { return this.gloOn ? this.gloDevice().pages[0] : this.focusedDevice()?.pages[this.focus!.page]; }

  // ---- GLO (#199): the FM-1's own quick page (pages_ui.c glo_page: MIDI channel, clock in, MIDI out, LEDs), never the
  // patch's: the editor has no rows for it (the patch's tempo and morph are on Main's device page, #196). Not one of the
  // devices: the pickers leave it, the focus stays where it was.
  private gloOn = false;
  private gloDevice(): Device {
    return { key: '$glo', name: 'Global (the FM-1’s own)', pages: [{ name: 'Global', part: 0, parts: 1, rows: [] }] };
  }

  /** GLO's page on (or off: back to the focus it left) */
  private setGlo(on: boolean): void {
    if (on === this.gloOn) return;
    this.gloOn = on;
    if (on && this.pageOn) this.pageOn = null;
    this.fillFocus();
    this.markFocus();
    this.syncPageButtons();
    this.dock?.querySelector<HTMLElement>('.panel-btn[data-button="glo"]')?.setAttribute('aria-pressed', String(on));
  }

  /** the dock's knob column: the four dials, the DEVICE and PAGE pickers (the FM-1's SELECT and ALGO) under them */
  private fillFocus(): void {
    const col = this.focusCol;
    if (!col) return;
    this.parameterDisplays = this.parameterDisplays.filter((d) => !d.el || (d.el.isConnected && col.contains(d.el) === false));
    const dev = this.focusedDevice();
    const pg = this.focusedPage();
    const pick = (label: string, text: string, count: number, get: () => number, set: (i: number) => void): HTMLElement => {
      const value = document.createElement('span');
      value.textContent = value.title = text;
      const el = picker({ label, value, count: () => count, get, set });
      el.classList.add('focus-pick');
      return el;
    };
    const pickers = document.createElement('div');
    pickers.className = 'focus-pickers';
    const di = this.devices.findIndex((d) => d.key === dev?.key);
    pickers.append(
      pick('device (SELECT)', dev?.name ?? 'no device', this.devices.length, () => di, (i) => this.setFocus({ device: this.devices[i].key, page: 0 })),
      pick('page (ALGO)', dev && pg && dev.pages.includes(pg) ? pageLabel(dev, dev.pages.indexOf(pg)) : pg ? pageTitle(pg) : '—', dev?.pages.length ?? 0, () => this.focus?.page ?? 0, (i) => this.setFocus({ device: dev!.key, page: i })),
    );
    // one page (or none): nothing to pick, the picker only names the knobs
    if ((dev?.pages.length ?? 0) <= 1) for (const b of pickers.lastElementChild!.querySelectorAll('button')) b.disabled = true;
    pickers.title = 'The device and the page Main\u2019s knobs turn (SELECT and ALGO on the FM-1). Click any row on a card to put its page on the knobs.';
    const knobs = document.createElement('div');
    knobs.className = 'deck-knobs';
    this.dials = [];
    this.knobJacks = [];
    for (let i = 0; i < PAGE_ROWS; i++) knobs.append(this.boundKnob(i, pg?.rows[i]));
    // the pickers under the knobs' captions, so the binding wires (from the jacks on the edge) never cross them
    col.replaceChildren(knobs, pickers);
  }

  /** knob K(i + 1) on the dock, bound to a row of the page in focus (or idle when the page has fewer rows) */
  private boundKnob(i: number, r: PageRow | undefined): HTMLElement {
    const k = `k${i + 1}`;
    const box = document.createElement('div');
    box.className = 'deck-knob';
    box.dataset.param = k;
    box.style.setProperty('--knob', `var(--${k})`);
    const dial = document.createElement('div');
    dial.className = 'dial';
    const name = document.createElement('span');
    name.className = 'dial-name';
    name.textContent = `K${i + 1}`;
    dial.append(name);
    const caption = document.createElement('span');
    caption.className = 'dial-caption';
    // the binding wire's fixed end on the dock's top edge, a stem down to the dial: not a patch point
    const jack = document.createElement('span');
    jack.className = 'knob-jack';
    const stem = document.createElement('span');
    stem.className = 'knob-stem';
    box.append(jack, stem, dial, caption);
    this.dials[i] = dial;
    this.knobJacks[i] = jack;
    const m = r && this.patch.modules.find((x) => x.id === r.module);
    const pd = m && DEFS[m.type].params.find((q) => q.name === r!.param);
    if (!r || !m || !pd) {
      box.classList.add('off');
      caption.textContent = '—';
      dial.title = `K${i + 1}: this page has no row for it`;
      return box;
    }
    caption.textContent = r.label;
    // the dial is the row's position in its range (octaves for a log parameter; a Selector's positions in use, #358);
    // choices and switches snap
    const rd = (): ParamDef => rowRange(m.type, m.params, pd);
    const unitOf = (v: number): number => (pd.choices ? (pd.choices.length > 1 ? Math.round(v) / (pd.choices.length - 1) : 0) : toUnit(rd(), v));
    const valueOf = (u: number): number => {
      if (pd.toggle) return u >= 0.5 ? 1 : 0;
      if (pd.choices) return Math.round(u * (pd.choices.length - 1));
      const v = fromUnit(rd(), u);
      return pd.log ? snapTo(pd, v) : pd.step ? Math.round(v / pd.step) * pd.step : Number(v.toFixed(6));
    };
    const text = (v: number): string => {
      if (pd.choices) return choiceName(m.type, pd.name, pd.choices[Math.round(v)] ?? '');
      if (r.names?.[Math.round(v) - pd.min]) return r.names[Math.round(v) - pd.min];   // a Selector's named position (#358)
      const f = formatValue(v, pd.unit, pd.min < 0);
      return f.unit ? `${f.num} ${f.unit}` : f.num;
    };
    const c = dragControl(dial, `K${i + 1}: ${r.label}`, 0, 1, unitOf(m.params[r.param]), (u) => this.setParam(m.id, r.param, valueOf(u)), {
      reset: unitOf(pd.default),
      text: (u) => text(valueOf(u)),
      draw: (u) => dial.style.setProperty('--v', String(u)),
    });
    (dial as HTMLElement & { sync?: () => void }).sync = () => c.set(unitOf(m.params[r.param]));
    return box;
  }

  /** the dials follow their rows' base values (a slider moved, an undo, the FM-1) */
  private syncDials(): void {
    for (const d of this.dials) (d as HTMLElement & { sync?: () => void }).sync?.();
  }

  /** colour the rows of the page in focus with their knobs (a badge and a ring, K1..K4); while an assembly is arranged,
   * every row of it shows its knob and where its pages start */
  private markFocus(): void {
    for (const el of this.modulesEl.querySelectorAll<HTMLElement>('.param.bound, .param.page-start')) {
      el.classList.remove('bound', 'page-start', 'focused');
      delete el.dataset.kn;
      delete el.dataset.page;
      el.style.removeProperty('--knob');
    }
    const rowEls = (r: PageRow): HTMLElement[] => [...this.modulesEl.querySelectorAll<HTMLElement>(`.param[data-mod="${r.module}"][data-param="${r.param}"]`)];
    // the page in focus also fills its bars in the knobs' colours (`focused`), as the FM-1's page does
    const mark = (pg: Page, start: boolean): void => pg.rows.forEach((r, i) => rowEls(r).forEach((el) => {
      el.classList.add('bound');
      el.classList.toggle('focused', !start);
      el.dataset.kn = String(i + 1);
      el.style.setProperty('--knob', `var(--k${i + 1})`);
      if (start && i === 0) { el.classList.add('page-start'); el.dataset.page = pageTitle(pg); }
    }));
    const arranging = this.devices.find((d) => d.asm !== undefined && d.asm === this.arrangeAsm);
    if (arranging) arranging.pages.forEach((pg) => mark(pg, true));
    const pg = this.focusedPage();
    if (pg) mark(pg, false);
    this.positionBindings();
  }

  /** a press on a row: its device page goes on the knobs */
  private focusRow(module: number, param: string): void {
    const at = findRow(this.devices, module, param);
    if (at) this.setFocus({ device: this.devices[at.device].key, page: at.page });
  }

  /** put a device page on Main's knobs; `notify` tells the host (the FM-1 follows with Live on) */
  setFocus(f: { device: string; page: number } | null, notify = true): void {
    const next = fixFocus(this.devices, f);
    if (this.gloOn && !this.listMoving) {   // a device page chosen on GLO's page: GLO is left
      this.setGlo(false);
      const i = PANEL_BUTTONS.indexOf('glo');
      if (i >= 0) this.ev.onButton?.(i, false);
    }
    if (next?.device === this.focus?.device && next?.page === this.focus?.page) return;
    if (!this.listMoving && this.pageOn) {   // the focus moved some other way: the Page button's list is left
      const i = PANEL_BUTTONS.indexOf(this.pageOn.b);
      this.pageOn = null;
      if (i >= 0) this.ev.onButton?.(i, false);
      this.syncPageButtons();
    }
    this.focus = next;
    this.fillFocus();
    this.markFocus();
    if (notify && next) this.ev.onFocus?.(next.device, next.page);
  }

  /** Down / Up arrows: the next / previous page of the device in focus, wrapping within it (GLO's page: the device it left);
   *  false when there is no device */
  stepPage(d: number): boolean {
    const dev = this.devices.find((x) => x.key === this.focus?.device) ?? this.devices[0];
    if (!dev) return false;
    const at = this.focus?.device === dev.key && !this.gloOn ? this.focus.page : d > 0 ? -1 : 0;
    this.setFocus({ device: dev.key, page: (((at + d) % dev.pages.length) + dev.pages.length) % dev.pages.length });
    return true;
  }

  /** Left / Right arrows: the previous / next device's first page, wrapping; false when there is no device */
  stepDevice(d: number): boolean {
    const n = this.devices.length;
    if (!n) return false;
    const i = this.devices.findIndex((x) => x.key === this.focus?.device);
    const next = i < 0 ? (d > 0 ? 0 : n - 1) : this.gloOn ? i : (((i + d) % n) + n) % n;
    this.setFocus({ device: this.devices[next].key, page: 0 });
    return true;
  }

  /** a held 1..4 and the wheel: K(i + 1) by `notches` (a hundredth of its range each; a choice or a switch: one position) */
  nudgeKnob(i: number, notches: number): boolean {
    const r = this.focusedPage()?.rows[i];
    const m = r && this.patch.modules.find((x) => x.id === r.module);
    const pd = m && DEFS[m.type].params.find((q) => q.name === r!.param);
    if (!r || !m || !pd) return false;
    const v = m.params[r.param];
    const rd = rowRange(m.type, m.params, pd);   // (a Selector's positions in use, #358)
    const w = fromUnit(rd, Math.min(1, Math.max(0, toUnit(rd, v) + notches / 100)));
    this.setParam(m.id, r.param, pd.toggle ? (notches > 0 ? 1 : 0)
      : pd.choices ? Math.min(pd.choices.length - 1, Math.max(0, Math.round(v) + Math.sign(notches)))
      : pd.log ? snapTo(pd, w) : pd.step ? Math.round(w / pd.step) * pd.step : Number(w.toFixed(6)));
    return true;
  }

  /** the FM-1 shows another page (patchbin.ts editorPage turns its indices into this) */
  focusFrom(f: { device: string; page: number }): void {
    this.setFocus(f, false);
  }

  /** a knob turned elsewhere (MIDI CC 16..19, the FM-1): K(i + 1) to position u (0..1) of its row's range */
  turnKnob(i: number, u: number): void {
    const r = this.focusedPage()?.rows[i];
    const m = r && this.patch.modules.find((x) => x.id === r.module);
    const pd = m && DEFS[m.type].params.find((q) => q.name === r!.param);
    if (!r || !m || !pd) return;
    const x = Math.min(1, Math.max(0, u));
    const rd = rowRange(m.type, m.params, pd);   // (a Selector's positions in use, #358: as the FM-1's pages_set_unit)
    const v = pd.toggle ? (x >= 0.5 ? 1 : 0) : pd.choices ? Math.round(x * (pd.choices.length - 1)) : pd.log ? snapTo(pd, fromUnit(pd, x))
      : rd !== pd ? Math.round(fromUnit(rd, x)) : Number(fromUnit(pd, x).toFixed(6));
    this.setParam(m.id, r.param, v);
  }

  /** the rows of the page in focus (the FM-1's device page, the knobs' targets) */
  focusRows(): PageRow[] { return this.focusedPage()?.rows ?? []; }

  /** the dotted lines from the dials to the rows they turn, drawn over everything; a row out of view gets none */
  private positionBindings(): void {
    if (!this.bindLayer) {
      this.bindLayer = document.createElementNS(SVGNS, 'svg') as SVGSVGElement;
      this.bindLayer.setAttribute('class', 'bind-cables');
      this.bindLayer.setAttribute('aria-hidden', 'true');
      document.body.append(this.bindLayer);
    }
    const layer = this.bindLayer;
    const view = this.canvas.getBoundingClientRect();
    const paths: SVGPathElement[] = [];
    const pg = this.focusedPage();
    const roll = this.roll?.view.el.getBoundingClientRect();
    const under = (p: Pt): boolean => !!roll && p.x >= roll.left && p.x <= roll.right && p.y >= roll.top && p.y <= roll.bottom;
    if (pg && this.canvas.offsetParent !== null) pg.rows.forEach((r, i) => {
      const dial = this.dials[i];
      if (!dial?.isConnected) return;
      const thumb = this.sliderPorts.find((s) => s.m.id === r.module && s.pd.name === r.param)?.jack;
      const row = this.modulesEl.querySelector<HTMLElement>(`.param[data-mod="${r.module}"][data-param="${r.param}"]`);
      const end = thumb?.isConnected && thumb.offsetParent !== null ? thumb : row;
      if (!end || end.offsetParent === null) return;
      const e = end.getBoundingClientRect();
      const b = { x: e.left + e.width / 2, y: e.top + e.height / 2 };
      if (b.x < view.left || b.x > view.right || b.y < view.top || b.y > view.bottom) return;
      if (under(b)) return; // (a row under the roll)
      const d = (this.knobJacks[i]?.isConnected ? this.knobJacks[i] : dial).getBoundingClientRect();
      const a = { x: d.left + d.width / 2, y: d.top };
      const lift = Math.max(40, (a.y - b.y) * 0.45);
      const path = document.createElementNS(SVGNS, 'path');
      path.setAttribute('class', 'bind');
      path.style.setProperty('--knob', `var(--k${i + 1})`);
      path.setAttribute('d', `M${a.x} ${a.y} C${a.x} ${a.y - lift} ${b.x} ${b.y + lift} ${b.x} ${b.y}`);
      paths.push(path);
    });
    paths.push(...this.armRoutes(view));
    layer.replaceChildren(...paths);
    // (the open roll covers them: the lines from the dock to the cards above it pass under it, the #136 follow-up)
    layer.style.clipPath = roll ? `path(evenodd, "M0 0H${innerWidth}V${innerHeight}H0Z M${roll.left} ${roll.top}H${roll.right}V${roll.bottom}H${roll.left}Z")` : '';
  }

  /** the armed devices' routing (#134, #190): Main's keys into each one's keys input (on its card, else a Steps track's grid,
   * else its card), drawn as a keys ribbon cut into dashes (the ribbon, its core, its middle wire): virtual cables (not
   * saved, no undo, no click). One is left out while either end is out of view */
  private armRoutes(view: DOMRect): SVGPathElement[] {
    const main = this.patch.modules.find((m) => m.type === 'fm1');
    if (!this.armedSet.size || !main || this.canvas.offsetParent === null) return [];
    const from = this.ports.get(this.key(main.id, 'keys', 'out'));
    if (!from?.isConnected) return [];
    const f = from.getBoundingClientRect();
    const a = { x: f.left + f.width / 2, y: f.top + f.height / 2 };
    const out: SVGPathElement[] = [];
    for (const k of this.armedSet) {
      const id = Number(k.slice(1));
      const t0 = keysTargets(this.patch, k)[0];
      const jack = t0 && this.inputJack(t0);
      const card = k[0] === 'a' ? this.containers.get(id) : this.stepGrids.get(id)?.el ?? this.cards.get(id);
      const to = [jack, card].find((e) => e?.isConnected && e.offsetParent !== null);
      if (!to) continue;
      const t = to.getBoundingClientRect();
      const b = to === jack ? { x: t.left + t.width / 2, y: t.top + t.height / 2 } : { x: t.left, y: t.top + Math.min(12, t.height / 2) };
      if (b.x < view.left || b.x > view.right || b.y < view.top || b.y > view.bottom) continue;
      const lift = Math.max(40, (a.y - b.y) * 0.45);
      const d = `M${a.x} ${a.y} C${a.x} ${a.y - lift} ${b.x - lift * 0.6} ${b.y} ${b.x} ${b.y}`;
      for (const part of ['arm', 'arm-core', 'arm-wire']) {
        const path = document.createElementNS(SVGNS, 'path');
        path.setAttribute('class', `bind ${part}`);
        path.setAttribute('d', d);
        out.push(path);
      }
    }
    return out;
  }

  positionSideCables(): void {
    this.sideOverlay();
    const w = this.world.getBoundingClientRect();
    const keep = new Set<SVGPathElement>();
    for (const [key, thumb] of this.sideThumbs) {
      const from = this.patch[key];
      const src = from && this.ports.get(this.key(from.module, from.port, 'out'));
      if (!src || !src.isConnected || this.canvas.offsetParent === null || thumb.offsetParent === null) continue;
      let path = this.sideLayer!.querySelector<SVGPathElement>(`path[data-key="${key}"]`);
      if (!path) {
        path = document.createElementNS(SVGNS, 'path');
        path.dataset.key = key;
        path.addEventListener('click', () => this.setSideSource(key, null));
        this.sideLayer!.append(path);
      }
      keep.add(path);
      const m = this.patch.modules.find((x) => x.id === from!.module)!;
      const kind = DEFS[m.type].outputs.find((o) => o.name === from!.port)?.kind ?? 'control';
      path.setAttribute('class', `cable ${kind}`);
      path.setAttribute('aria-label', 'A sidebar slider\'s source: click to unplug');
      // into the thumb's centre (it moves with the live value), from above
      const r = thumb.getBoundingClientRect();
      const b = { x: (r.left + r.width / 2 - w.left) / this.zoom, y: (r.top + r.height / 2 - w.top) / this.zoom };
      path.setAttribute('d', this.curve(this.center(src), b, this.endOf(src), 'up'));
      path.setAttribute('transform', `translate(${w.left} ${w.top}) scale(${this.zoom})`);
    }
    for (const p of [...this.sideLayer!.querySelectorAll<SVGPathElement>('path[data-key]')]) if (!keep.has(p)) p.remove();
  }

  private positionCables(): void {
    this.positionSideCables();
    this.positionBindings();
    this.positionTraces();
    const w = this.world.getBoundingClientRect();
    const o = this.dockCables?.getBoundingClientRect();
    const routed = this.ribbonRoutes();
    for (const { path, from, to, origin } of this.cablePaths) {
      let pts = routed.get(from)?.get(to);
      if (pts && origin !== this.world) {
        // a copy on a card: the same route in the card's coordinates
        const a = this.center(to, origin), b = this.center(to);
        pts = pts.map((p) => ({ x: p.x + a.x - b.x, y: p.y + a.y - b.y }));
      }
      pts ??= this.curvePts(this.center(from, origin), this.center(to, origin), this.endOf(from), this.endOf(to));
      path.setAttribute('d', pathOf(pts));
      const over = this.overPaths.get(path);
      if (!over || !o) continue;
      over.copy.setAttribute('d', pathOf(pts.map((p) => ({ x: p.x * this.zoom + w.left - o.left, y: p.y * this.zoom + w.top - o.top }))));
      for (const { rect, jack } of over.clips) {
        const j = jack.getBoundingClientRect();
        rect.setAttribute('x', String(j.left - o.left - CLIP_HALF));
        rect.setAttribute('width', String(j.width + 2 * CLIP_HALF));
        rect.setAttribute('y', '0');
        rect.setAttribute('height', String(Math.max(0, j.top - o.top + j.height / 2)));
      }
    }
  }

  /** a frame's box in world coordinates (as `center`) */
  private worldRect(el: HTMLElement): Rect {
    const r = el.getBoundingClientRect();
    const c = this.world.getBoundingClientRect();
    return { x: (r.left - c.left) / this.zoom - this.world.clientLeft, y: (r.top - c.top) / this.zoom - this.world.clientTop, w: r.width / this.zoom, h: r.height / this.zoom };
  }

  private clampLayer: SVGGElement | null = null;

  /**
   * The routes of the cables that cross an expanded assembly's border (ribbons.ts, #85), by their drawn ends, in world
   * coordinates; also draws the ribbons' clamps. Every copy of a cable (on a card, over the dock) follows the same route.
   */
  private ribbonRoutes(): Map<HTMLElement, Map<HTMLElement, Pt[]>> {
    const out = new Map<HTMLElement, Map<HTMLElement, Pt[]>>();
    if (!this.clampLayer || !this.clampLayer.isConnected) {
      this.clampLayer = document.createElementNS(SVGNS, 'g') as SVGGElement;
      this.clampLayer.setAttribute('class', 'ribbon-clamps');
      this.svg.append(this.clampLayer);
    }
    this.clampLayer.replaceChildren();
    const frames: RibbonFrame[] = [];
    for (const [id, el] of this.frames) {
      const a = assemblyById(this.patch, id);
      if (!a?.open || !el.isConnected || !el.offsetWidth) continue;
      const nIn = a.inputs.length;
      frames.push({
        id,
        rect: this.worldRect(el),
        members: new Set(allModules(this.patch, a)),
        depth: depthOf(this.patch, a),
        rank: (dir, module, port, param) => {
          const t = { module, port };
          const i = param !== undefined
            ? a.params.findIndex((r) => r.module === module && r.param === param)
            : (dir === 'in' ? a.inputs : a.outputs).findIndex((r) => targetsOf(r).some((x) => sameEnd(x, t)));
          return i < 0 ? undefined : param !== undefined ? nIn + i : i;
        },
      });
    }
    if (!frames.length) return out;
    const entries = this.cablePaths.filter((e) => e.origin === this.world && e.cable && !e.path.classList.contains('alias'));
    const cables: RibbonCable[] = entries.map(({ from, to, cable }) => ({
      from: { pt: this.center(from), dir: this.endOf(from), module: cable!.from.module, port: cable!.from.port },
      to: { pt: this.center(to), dir: this.endOf(to), module: cable!.to.module, port: cable!.to.port, param: to.dataset.param },
    }));
    const { routes, clamps } = ribbons(frames, cables, (a, b, da, db) => this.curvePts(a, b, da, db));
    for (const [i, pts] of routes) {
      const { from, to } = entries[i];
      if (!out.has(from)) out.set(from, new Map());
      out.get(from)!.set(to, pts);
    }
    for (const c of clamps) {
      const r = document.createElementNS(SVGNS, 'rect');
      r.setAttribute('x', String(c.x));
      r.setAttribute('y', String(c.y));
      r.setAttribute('width', String(c.w));
      r.setAttribute('height', String(c.h));
      r.setAttribute('rx', '2');
      this.clampLayer.append(r);
    }
    return out;
  }

  /** a cable end as the status line names it: the module and its port */
  private endName(e: Endpoint): string {
    const m = this.patch.modules.find((x) => x.id === e.module);
    return m ? `${moduleName(m.type, DEFS[m.type]?.label ?? m.type)} ${e.port}` : e.port;
  }

  /** the hovered cable's glow (design A): a copy over the cards, so its whole run shows where it passes behind one, and
   * rings on its jacks on the canvas; it takes no pointer */
  private glow(paths: { path: SVGPathElement; from: HTMLElement; to: HTMLElement }[]): void {
    const layer = this.glowLayer;
    if (!layer) return;
    layer.replaceChildren();
    for (const { path, from, to } of paths) {
      const d = path.getAttribute('d');
      if (!d) continue;
      const g = document.createElementNS(SVGNS, 'g');
      g.setAttribute('class', `glow ${['audio', 'control', 'gate', 'keys'].find((k) => path.classList.contains(k)) ?? 'audio'}`);
      for (const cls of ['halo', 'core']) {
        const e = document.createElementNS(SVGNS, 'path');
        e.setAttribute('class', cls);
        e.setAttribute('d', d);
        g.append(e);
      }
      for (const jack of [from, to]) {
        if (this.inDock(jack)) continue;
        const c = this.center(jack);
        const ring = document.createElementNS(SVGNS, 'circle');
        ring.setAttribute('class', 'ring');
        ring.setAttribute('cx', String(c.x));
        ring.setAttribute('cy', String(c.y));
        ring.setAttribute('r', '9');
        g.append(ring);
      }
      layer.append(g);
    }
  }

  /** glow these cables (the ARP menu's rows show what they would take over); none: off */
  glowCables(cables: Cable[]): void {
    this.glow(this.cablePaths.filter((x) => x.origin === this.world && x.cable && cables.some((c) => sameEnd(c.from, x.cable!.from) && sameEnd(c.to, x.cable!.to))));
  }

  private inputJack(to: Endpoint): HTMLElement | undefined {
    return this.ports.get(this.key(to.module, to.port, 'in')) ?? [...this.ports.values()].find((dot) =>
      dot.dataset.also && (JSON.parse(dot.dataset.also) as Target[]).some((t) => sameEnd(t, to)));
  }

  /** Outside cables end at side jacks; internal branches are editable input-to-parameter routes. */
  drawCables(): void {
    this.positionSideCables();
    for (const { path } of this.cablePaths) path.remove();
    this.cablePaths = [];
    this.dockCables?.replaceChildren();
    this.overPaths.clear();
    // a removed path gets no pointerleave: the hovered cable's glow would stay behind (#150)
    this.glow([]);
    for (const svg of this.modulesEl.querySelectorAll('.internal-cables, .entry-cables')) svg.remove();
    // a card's cables are drawn over its thumbs (a layer that takes no pointer events), while their click areas lie
    // under the thumbs, so a thumb under a cable still drags and patches
    const cardLayers = new Map<HTMLElement, Map<string, SVGSVGElement>>();
    const cardLayer = (card: HTMLElement, cls: 'internal-cables' | 'entry-cables', hits = false): SVGSVGElement => {
      const key = `${cls}${hits ? ' hits' : ''}`;
      let byKey = cardLayers.get(card);
      if (!byKey) cardLayers.set(card, (byKey = new Map()));
      let svg = byKey.get(key);
      if (!svg) {
        svg = document.createElementNS(SVGNS, 'svg') as SVGSVGElement;
        svg.setAttribute('class', `cables ${key}`);
        card.append(svg);
        byKey.set(key, svg);
      }
      return svg;
    };
    for (const dot of [...this.ports.values(), ...this.sliderPorts.map((p) => p.jack)]) dot.classList.remove('connected');
    const add = (from: HTMLElement, to: HTMLElement, kind: string, remove: (() => void) | null, title: string, internal = false, cable?: Cable): void => {
      const path = document.createElementNS(SVGNS, 'path');
      path.setAttribute('class', `cable ${kind}${internal ? ' alias' : ''}${remove ? '' : ' fixed'}`);
      path.setAttribute('aria-label', title);
      if (remove) {
        path.setAttribute('role', 'button');
        path.setAttribute('tabindex', '0');
        path.addEventListener('pointerdown', (e) => e.stopPropagation());
        path.addEventListener('click', (e) => { e.stopPropagation(); remove(); });
        path.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); remove(); }
        });
      }
      const hint = document.createElementNS(SVGNS, 'title'); hint.textContent = title; path.append(hint);
      let layer = this.svg;
      let origin = this.world;
      if (internal) {
        const card = to.closest<HTMLElement>('.module');
        if (card && from.closest('.module') === card) {
          origin = card;
          layer = cardLayer(card, 'internal-cables');
        }
      }
      layer.prepend(path);
      this.cablePaths.push({ path, from, to, origin, cable });
      // a gate's rail and a keys ribbon (#156): their inner lines are extra paths over the cable, in the same place
      // (positionCables sets them like the cable; they take no pointer, carry no `cable`, so the ribbon routing and the
      // glow see only the cable). `inner` makes them for one copy of the cable, after it.
      const role = ['role-gate', 'role-keys'].find((r) => path.classList.contains(r));
      const inner = (after: SVGPathElement, at: HTMLElement): SVGPathElement[] => {
        if (!role) return [];
        const out = (role === 'role-keys' ? ['cable-core', 'cable-wire'] : ['cable-core']).map((cls) => {
          const e = document.createElementNS(SVGNS, 'path');
          e.setAttribute('class', `${cls} ${role}`);
          return e;
        });
        after.after(...out);
        for (const e of out) this.cablePaths.push({ path: e, from, to, origin: at });
        return out;
      };
      // hovering any part of a cable highlights all of it: the path and its copies on a card and over the dock
      const lines = inner(path, origin);
      const group: SVGPathElement[] = [path, ...lines];
      const hover = (on: boolean): void => {
        group.forEach((g) => g.classList.toggle('hover', on));
        if (origin === this.world) this.glow(on ? [{ path, from, to }] : []);
      };
      path.addEventListener('pointerenter', () => hover(true));
      path.addEventListener('pointerleave', () => hover(false));
      const over = this.dockCables;
      if (over && origin === this.world && (this.inDock(from) || this.inDock(to))) {
        const copy = document.createElementNS(SVGNS, 'path');
        copy.setAttribute('class', path.getAttribute('class')!);
        const clip = document.createElementNS(SVGNS, 'clipPath');
        clip.id = `dock-clip-${this.overPaths.size}`;
        const clips = [from, to].filter((j) => this.inDock(j)).map((jack) => {
          const rect = document.createElementNS(SVGNS, 'rect');
          clip.append(rect);
          return { rect, jack };
        });
        copy.setAttribute('clip-path', `url(#${clip.id})`);
        over.append(clip, copy);
        this.overPaths.set(path, { copy, clips });
        group.push(copy);
        // the rail's / ribbon's inner lines over the dock: copies of the main path's inner lines, clipped alike
        for (const e of lines) {
          const c = document.createElementNS(SVGNS, 'path');
          c.setAttribute('class', e.getAttribute('class')!);
          c.setAttribute('clip-path', `url(#${clip.id})`);
          over.append(c);
          this.overPaths.set(e, { copy: c, clips });
          group.push(c);
        }
      }
      // a cable into a card's interior (to a thumb, a picker's or a switch's jack) runs under the card like every cable;
      // a copy on the card, clipped to it, draws the stretch over the card up to the jack
      const card = !internal && origin === this.world ? to.closest<HTMLElement>('.module') : null;
      if (card && to.classList.contains('slider-port')) {
        const copy = document.createElementNS(SVGNS, 'path');
        copy.setAttribute('class', path.getAttribute('class')!);
        cardLayer(card, 'entry-cables').append(copy);
        this.cablePaths.push({ path: copy, from, to, origin: card, cable });
        group.push(copy, ...inner(copy, card));
        if (remove) {
          const hit = document.createElementNS(SVGNS, 'path');
          hit.setAttribute('class', 'cable-hit');
          hit.addEventListener('pointerdown', (e) => e.stopPropagation());
          hit.addEventListener('click', (e) => { e.stopPropagation(); remove(); });
          hit.addEventListener('pointerenter', () => hover(true));
          hit.addEventListener('pointerleave', () => hover(false));
          const t = document.createElementNS(SVGNS, 'title'); t.textContent = title; hit.append(t);
          cardLayer(card, 'entry-cables', true).append(hit);
          this.cablePaths.push({ path: hit, from, to, origin: card });
        }
      }
      if (internal && remove) {
        // a thin route is hard to hit: an invisible path 1.5x as wide takes the clicks, above the card's controls but
        // under its thumbs
        const hit = document.createElementNS(SVGNS, 'path');
        hit.setAttribute('class', 'cable-hit');
        hit.addEventListener('pointerdown', (e) => e.stopPropagation());
        hit.addEventListener('click', (e) => { e.stopPropagation(); remove(); });
        hit.addEventListener('pointerenter', () => hover(true));
        hit.addEventListener('pointerleave', () => hover(false));
        (origin === this.world ? layer : cardLayer(origin, 'internal-cables', true)).append(hit);
        this.cablePaths.push({ path: hit, from, to, origin });
      }
    };
    // Show the assignment even without an upstream cable, so it can be edited before patching a source. A dedicated
    // input's link (ParamDef.input) is built into the module: drawn grey, not editable.
    for (const { m, pd, jack } of this.sliderPorts) for (const port of parameterInputs(m, pd)) {
      const side = this.inputJack({ module: m.id, port });
      if (!side || (this.inDock(side) && this.inDock(jack))) continue; // the dock draws no routes inside itself
      if (port === pd.input) add(side, jack, 'control', null, `Built in: ${port} sets ${pd.name}`, true);
      else add(side, jack, 'control', () => this.change(() => {
        setInputRoute(m, DEFS[m.type], port, pd.name, false);
      }), `Disconnect ${DEFS[m.type].label} ${port} → ${pd.name}`, true);
    }
    const physicalCables = new Set<string>();
    for (const c of this.patch.cables) {
      const a = this.ports.get(this.key(c.from.module, c.from.port, 'out'));
      const b = this.inputJack(c.to);
      const thumbs = this.sliderPorts.filter(({ m, pd }) => m.id === c.to.module && parameterInputs(m, pd).includes(c.to.port));
      a?.classList.add('connected'); b?.classList.add('connected');
      for (const { jack } of thumbs) jack.classList.add('connected');
      if (!a) continue;
      const src = this.patch.modules.find((m) => m.id === c.from.module)!;
      // drawn by the role of the input it lands on (cable-role.ts), not the kind of the output
      const role = cableRole(DEFS[this.patch.modules.find((x) => x.id === c.to.module)!.type], c.to.port);
      const kind = `${role === 'signal' ? 'audio' : role === 'mod' ? 'control' : role} role-${role}`;
      void src;
      if (b) {
        const key = `${c.from.module}:${c.from.port}:${b.dataset.mod}:${b.dataset.port}`;
        if (!physicalCables.has(key)) add(a, b, kind, () => this.removeCable(c), `${this.endName(c.from)} → ${this.endName(c.to)}. Click to disconnect it`, false, c);
        physicalCables.add(key);
      } else
        // a pin has no jack: its cable is drawn to every thumb it feeds, and each drawn cable removes just that route
        for (const { jack, pd } of thumbs) add(a, jack, kind, () => this.change(() => {
          // (a card row that sets several parameters, #357: the same output's routes into the others go too)
          const tied = this.tiedCables(c).flatMap((end) => this.patch.cables.filter((x) => sameEnd(x.from, c.from) && sameEnd(x.to, end)));
          removeRoute(this.patch, c, pd.name);
          for (const x of tied) for (const t of tiedTo(this.patch, c.to.module, pd.name).slice(1)) if (t.module === x.to.module) removeRoute(this.patch, x, t.param);
        }), `Disconnect from ${longName(this.patch.modules.find((x) => x.id === c.to.module)!.type, pd.name)}`, false, c);
    }
    this.positionCables();
    this.markMuted();
  }

  /** set a parameter from outside the cards (the deck's knobs): as a slider would, the card follows on its next refresh */
  setParam(id: number, name: string, v: number): void {
    const m = this.patch.modules.find((x) => x.id === id);
    if (!m || m.params[name] === v) return;
    this.touch();
    m.params[name] = v;
    this.ev.onParam(id, name, v);
    this.mirror(id, name, v);
    this.chipsSoon();
    this.syncDials();
    for (const d of this.parameterDisplays) if (d.id === id) d.update(null);
    this.relock(id);
  }

  /** the parameters card rows tie to this one (#357) take its new value too, each clamped to its range (they share it) */
  private mirror(id: number, name: string, v: number): void {
    if (!assembliesOf(this.patch).some((a) => a.params.some((r) => r.also))) return;
    for (const t of tiedTo(this.patch, id, name).slice(1)) {
      const m = this.patch.modules.find((x) => x.id === t.module);
      const pd = m && DEFS[m.type].params.find((q) => q.name === t.param);
      if (!m || !pd) continue;
      const w = Math.min(topOf(pd), Math.max(pd.min, v));
      if (m.params[t.param] === w) continue;
      m.params[t.param] = w;
      this.ev.onParam(m.id, t.param, w);
      for (const d of this.parameterDisplays) if (d.id === m.id) d.update(null);
      this.relock(m.id);
    }
  }

  /** remove a cable; one drawn to a merged jack whose other inputs are hidden takes their cables (from the same output) with it,
   * and one into a parameter a card row ties to others (#357) takes the same output's cables into those */
  private removeCable(c: Cable): void {
    const hidden = hiddenModules(this.patch);
    const more: Endpoint[] = [...this.tiedCables(c)];
    for (const a of assembliesOf(this.patch)) {
      const ref = findRef(a, 'in', c.to.module, c.to.port);
      if (!ref?.also?.length) continue;
      for (const t of targetsOf(ref)) if (hidden.has(t.module) && !sameEnd(t, c.to) && !more.some((x) => sameEnd(x, t))) more.push(t);
    }
    this.change(() => {
      disconnect(this.patch, c);
      for (const t of more) disconnect(this.patch, { from: c.from, to: t });
    });
  }

  /** the ends of the cables from c's output into the parameters tied to those c feeds (#357: a cable made on a row) */
  private tiedCables(c: Cable): Endpoint[] {
    const m = this.patch.modules.find((x) => x.id === c.to.module);
    if (!m || !assembliesOf(this.patch).some((a) => a.params.some((r) => r.also))) return [];
    const out: Endpoint[] = [];
    const feeds = (x: ModuleInst, pd: ParamDef, port: string): boolean => pd.input === port || ((port === 'p1' || port === 'p2') && !!x.map?.[port]?.includes(pd.name));
    for (const pd of DEFS[m.type].params) {
      if (!feeds(m, pd, c.to.port)) continue;
      for (const t of tiedTo(this.patch, m.id, pd.name).slice(1)) {
        const tm = this.patch.modules.find((x) => x.id === t.module);
        const tp = tm && DEFS[tm.type].params.find((q) => q.name === t.param);
        if (!tm || !tp) continue;
        for (const port of [tp.input, 'p1', 'p2']) {
          const end = { module: tm.id, port: port ?? '' };
          if (port && feeds(tm, tp, port) && this.patch.cables.some((x) => sameEnd(x.from, c.from) && sameEnd(x.to, end)) && !out.some((e) => sameEnd(e, end))) out.push(end);
        }
      }
    }
    return out;
  }

  private internalPair(a: HTMLElement, b: HTMLElement): [HTMLElement, HTMLElement] | null {
    if (a.dataset.dir !== 'in' || b.dataset.dir !== 'in' || !!a.dataset.param === !!b.dataset.param) return null;
    return a.dataset.param ? [b, a] : [a, b]; // side jack, parameter thumb
  }

  private connectJacks(a: HTMLElement, b: HTMLElement): void {
    const internal = this.internalPair(a, b);
    if (internal) {
      const [side, thumb] = internal;
      this.change(() => {
        const m = this.patch.modules.find((m) => m.id === Number(thumb.dataset.mod))!;
        const pd = DEFS[m.type].params.find((pd) => pd.name === thumb.dataset.param)!;
        const targets: Target[] = [{ module: Number(side.dataset.mod), port: side.dataset.port! },
          ...(side.dataset.also ? JSON.parse(side.dataset.also) as Target[] : [])];
        const target = targets.find((t) => t.module === m.id);
        if (!target) throw new Error('Use a side input belonging to this parameter’s module.');
        setInputRoute(m, DEFS[m.type], target.port, pd.name, true);
      });
      return;
    }
    if (a.dataset.dir === b.dataset.dir) return this.ev.onError('connect an output to an input');
    const [out, input] = a.dataset.dir === 'out' ? [a, b] : [b, a];
    const from = { module: Number(out.dataset.mod), port: out.dataset.port! };
    this.change(() => {
      let to: Endpoint;
      if (input.dataset.param) {
        to = connectParameter(this.patch, DEFS, from, Number(input.dataset.mod), input.dataset.param);
        // a card row that sets several parameters (#357): the cable reaches every one of them
        for (const t of tiedTo(this.patch, Number(input.dataset.mod), input.dataset.param).slice(1)) connectParameter(this.patch, DEFS, from, t.module, t.param);
      } else {
        to = { module: Number(input.dataset.mod), port: input.dataset.port! };
        if (!this.patch.cables.some((c) => sameEnd(c.from, from) && sameEnd(c.to, to)) && !connect(this.patch, DEFS, from, to))
          throw new Error('cannot connect these ports');
      }
      // A thumb alias of a merged assembly jack feeds the same group of inputs.
      const physical = this.inputJack(to);
      const also = input.dataset.also ?? physical?.dataset.also;
      if (also) {
        if (physical) connect(this.patch, DEFS, from, { module: Number(physical.dataset.mod), port: physical.dataset.port! });
        for (const target of JSON.parse(also) as Target[]) connect(this.patch, DEFS, from, target);
      }
    });
  }

  private beginDrag(e: PointerEvent, start: HTMLElement): void {
    e.preventDefault();
    e.stopPropagation();
    const armed = this.armed;
    this.cancelArm();
    if (armed && (armed.dataset.dir !== start.dataset.dir || this.internalPair(armed, start))) {
      this.connectJacks(armed, start);
      return;
    }
    const kind = start.dataset.dir;
    const { path, move, stop } = this.ghostCable(start);
    this.setPatching(true);
    const cancel = (): void => {
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      stop();
      this.drag = null;
      this.setPatching(false);
    };
    const up = (ev: PointerEvent): void => {
      const t = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
      const dot = t?.closest('.dot') as HTMLElement | null;
      cancel();
      // an output dropped on the sidebar's cable slack bar sways the cables
      // an output dropped on a sidebar slider whose thumb is a jack (cable slack, zoom) patches it
      const side = kind === 'out' ? (t?.closest('[data-side]') as HTMLElement | null)?.dataset.side as SideKey | undefined : undefined;
      if (side) return this.setSideSource(side, { module: Number(start.dataset.mod), port: start.dataset.port! });
      if (dot === start) {
        this.armed = start;
        start.classList.add('armed');
        this.setPatching(true);
        // click-to-connect: a ghost cable follows the pointer, as while dragging, until the second click or Esc
        const ghost = this.ghostCable(start);
        ghost.move(ev);
        this.armGhost = ghost.stop;
      } else if (dot?.dataset.mod) this.connectJacks(start, dot);
    };
    this.drag = { path, cancel };
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    move(e);
  }

  /**
   * A cable from a jack to the pointer, following it until `stop`. It is drawn in the layer over the whole window (not the
   * canvas's), so it shows over the sidebar on its way to a sidebar slider's thumb.
   */
  private ghostCable(start: HTMLElement): { path: SVGPathElement; move: (ev: PointerEvent) => void; stop: () => void } {
    const kind = start.dataset.dir;
    const path = document.createElementNS(SVGNS, 'path');
    path.setAttribute('class', 'cable pending');
    this.sideOverlay().append(path);
    let last: PointerEvent | null = null;
    const move = (ev: PointerEvent): void => {
      last = ev;
      const c = this.world.getBoundingClientRect();
      const p = { x: (ev.clientX - c.left) / this.zoom, y: (ev.clientY - c.top) / this.zoom };
      const s = this.center(start);
      const end = this.endOf(start);
      path.setAttribute('d', kind === 'out' ? this.curve(s, p, end) : this.curve(p, s, 'side', end));
      path.setAttribute('transform', `translate(${c.left} ${c.top}) scale(${this.zoom})`);
    };
    // the canvas scrolling or zooming moves the jack under a still pointer
    const again = (): void => { if (last) move(last); };
    window.addEventListener('pointermove', move);
    this.canvas.addEventListener('scroll', again);
    return {
      path, move,
      stop: () => {
        window.removeEventListener('pointermove', move);
        this.canvas.removeEventListener('scroll', again);
        path.remove();
      },
    };
  }
}
