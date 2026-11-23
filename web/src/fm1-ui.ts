// SPDX-License-Identifier: GPL-3.0-only
// The FM-1's UI as WebAssembly (firmware/wasm/fm1_ui.c, built by `npm run fm1-wasm` into public/fm1-ui.wasm): the real
// panel core and screens on the C engine, with no hardware. The page loads a patch binary (patchbin.ts encodePatch),
// drives the panel and the clock, and draws the 240 x 240 RGB565 framebuffer. No DOM here: the editor's FM-1 tab
// (#110) and the tests use it.
import { wordsNotes, type SongEntry, type StepNote } from './track';
import { GUIDE_BYTES, parseGuideNow, type PanelState, type RawLock } from './protocol';

/** what the emulated FM-1 tells the page */
export interface Fm1Events {
  /** the device page in focus moved (SELECT / ALGO / HOME): the binary's device and page indices */
  focus?(device: number, page: number): void;
  /** a knob turned a parameter: module index (the device form's), parameter index (bit 7: a poly row, patchbin.ts
   * POLY_ROW), Q16 value */
  param?(module: number, param: number, value: number): void;
  /** PRESET turned: the next / previous patch */
  preset?(d: number): void;
  /** SAVE pressed */
  save?(): void;
  /** a MIDI message the panel sent (MENU > MIDI OUT) */
  midi?(status: number, d1: number, d2: number): void;
  /** PLAY started / stopped the transport */
  transport?(run: boolean): void;
  /** SEQ held + PLAY began play once (#632): the page's engine counts in and plays once itself (the emulated engine's
   * own starts and stops of it are not told) */
  once?(): void;
  /** REC's count-in began (its bars) or ended early (0) (D-803): the page's engine clicks on its beats, as play once's */
  cin?(bars: number): void;
  /** the SEQ page: a track's notes as they are after an edit there (of pattern `pat`, 0-based: the one it plays), a track
   * muted (module = its index in the binary) */
  origin?(module: number, pattern: number, identity: number): void;
  track?(module: number, notes: StepNote[], pat: number): void;
  /** the SEQ page: a track's P-locks of pattern `pat` after an edit there (#524; device-form indices, values Q16 / 65536) */
  locks?(module: number, pat: number, locks: RawLock[]): void;
  /** PRESET on the SEQ page or the SONG page chose the patch's pattern (0-based) or the song (0 none) (#375) */
  pattern?(pattern: number, song: number): void;
  /** the SONG page edited song s (0-based): its entries */
  song?(s: number, entries: SongEntry[]): void;
  /** the SEQ page ran a pattern command (#1177, #1178, as the device link's PATTERN_OP): op 1 pattern `from` (0-based)
   *  copied to `to`, op 2 every pattern and song cleared, op 4 pattern `from` doubled (`hash` always 0) */
  patternOp?(op: number, from: number, to: number, hash: number): void;
  mute?(module: number, on: boolean): void;
  /** the FM-1 armed or disarmed (#139, #191, #395: REC held + a black key, SEL, the SEQ page): the armed modules, by
   * their index in the binary, as a mask in ARM_WORDS words (#721) */
  arms?(words: number[]): void;
  /** GLO > PANEL > TEMPO, the global tempo or TIME SIG changed on the emulated FM-1 (its menu, PLAY held + PRESET, Main's
   * tempo row while global; D-907, #1011): global, the global tempo (0: not known yet) and the time signature (a METERS index) */
  tempo?(global: boolean, bpm: number, meter: number): void;
  /** the palette (#1196): HOME + black key `pos + 1` tapped (switch to palette position pos, 0..7) / held 1 s (save the
   * running sound there); the page answers with the copy's palette state (fm1w_palette) */
  paletteGo?(pos: number): void;
  paletteSave?(pos: number): void;
}

/** a note the panel's keys started or let go in the engine (panel.c panel_key): a key's own note at the octave, or a row
 * of the Drum map the keys reach (D-520: black keys 1..8 play rows 1..8); velocity Q16 (0 on a release) */
export interface KeyPlay { note: number; vel: number; on: boolean; kind?: number; target?: number }

/** bits of lit buttons (matrix ids) and keys (key n = F3 + n) */
export interface Lights {
  buttons: { lit: number; dim: number; breath: number };
  keys: { lit: number; mid: number; dim: number };
}

/** the panel's encoders, as fm1w_encoder numbers them */
export const ENCODERS = { select: 0, algo: 1, k1: 2, k2: 3, k3: 4, k4: 5, preset: 6 } as const;
/** the panel's buttons by matrix id (M-VAVE's order, firmware/src/panel.c) */
export const BUTTONS = { octDown: 0, octUp: 1, fx: 2, scl: 3, env: 4, lfo: 5, edit: 6, glo: 7, home: 8, save: 9, arp: 10, seq: 11, play: 12, rec: 13 } as const;

interface Exports {
  memory: WebAssembly.Memory;
  fm1w_patch(): number; fm1w_patch_max(): number; fm1w_name(): number; fm1w_fb(): number;
  fm1w_led(kind: number, first: number): number; fm1w_page(): number; fm1w_take_dirty(): number;
  fm1w_load(len: number, slot: number, fresh: number): number;
  fm1w_tick(ms: number): void;
  fm1w_encoder(n: number, clicks: number): void;
  fm1w_button(id: number, down: number): void;
  fm1w_keys(bits: number): void;
  fm1w_focus(device: number, page: number): void;
  fm1w_param(module: number, param: number, value: number): void;
  fm1w_transport(run: number): void;
  fm1w_play_turned(): void;
  fm1w_mute(module: number, on: number): void;
  fm1w_arm_mask(w0: number, w1: number, w2: number, w3: number): void;
  /** (absent from a wasm built before D-907) */
  fm1w_tempo?(patch: number, bpm: number, meter: number): void;
  fm1w_focus_dev(): number; fm1w_focus_page(): number; fm1w_octave(): number;
  /** (absent from a wasm built before #549) */
  fm1w_held?(): number; fm1w_guide?(): number; fm1w_align_buf?(): number; fm1w_align?(): void;
  /** (absent from a wasm built before #1196) the palette the copy shows: 8 x 24 bytes {state, slot, pattern, pad,
   * name[20]} at fm1w_palette_buf, taken with the position playing and the one waiting (0xFF none) */
  fm1w_palette_buf?(): number; fm1w_palette?(cur: number, next: number): void;
}

export class Fm1Ui {
  private constructor(private x: Exports, private played: KeyPlay[]) {}

  /** instantiate from the module's bytes (a fetch of fm1-ui.wasm, or a file in tests) */
  static async create(bytes: BufferSource, ev: Fm1Events = {}): Promise<Fm1Ui> {
    let memory: WebAssembly.Memory | null = null;
    const played: KeyPlay[] = [];
    const env = {
      note: (n: number, v: number, on: number, kind: number, target: number) => { played.push({ note: n, vel: v, on: on !== 0, ...(kind ? { kind, target } : {}) }); },
      focus: (d: number, g: number) => ev.focus?.(d, g),
      param: (m: number, p: number, v: number) => ev.param?.(m, p, v),
      preset: (d: number) => ev.preset?.(d),
      save: () => ev.save?.(),
      midi: (s: number, a: number, b: number) => ev.midi?.(s, a, b),
      transport: (r: number) => ev.transport?.(r !== 0),
      once: () => ev.once?.(),
      cin: (bars: number) => ev.cin?.(bars),
      origin: (m: number, pat: number, identity: number) => ev.origin?.(m, pat, identity >>> 0),
      track: (m: number, at: number, n: number, pat: number) => ev.track?.(m, memory ? wordsNotes([...new Uint32Array(memory.buffer, at, n)]) : [], pat ?? 0),
      locks: (m: number, pat: number, at: number, n: number) => ev.locks?.(m, pat, memory ? Array.from({ length: n }, (_, j) => {
        const b = new Uint8Array(memory!.buffer, at + 7 * j, 7);
        return { at: b[0], module: b[1], param: b[2], value: (b[3] | (b[4] << 8) | (b[5] << 16) | (b[6] << 24)) / 65536 };
      }) : []),
      pattern: (p: number, song: number) => ev.pattern?.(p, song),
      song: (k: number, at: number, n: number) => ev.song?.(k, memory ? Array.from({ length: n }, (_, j) => {
        const b = new Uint8Array(memory!.buffer, at + 2 * j, 2);
        return { pat: b[0], shift: (b[1] << 24) >> 24 };
      }) : []),
      mute: (m: number, on: number) => ev.mute?.(m, on !== 0),
      pattern_op: (op: number, from: number, to: number, hash: number) => ev.patternOp?.(op, from, to, hash >>> 0),
      arms: (w0: number, w1: number, w2: number, w3: number) => ev.arms?.([w0 >>> 0, w1 >>> 0, w2 >>> 0, w3 >>> 0]),
      tempo: (patch: number, bpm: number, meter: number) => ev.tempo?.(patch === 0, bpm, meter),
      pal_go: (pos: number) => ev.paletteGo?.(pos),
      pal_save: (pos: number) => ev.paletteSave?.(pos),
    };
    const { instance } = await WebAssembly.instantiate(bytes, { fm1: env });
    memory = (instance.exports as unknown as Exports).memory;
    return new Fm1Ui(instance.exports as unknown as Exports, played);
  }

  /** run a patch binary (name as the FM-1 shows it; slot 0..63 shown as "01".., else none). `fresh`: another patch, the
   * focus goes to its first device; else the same patch edited, the focus stays. Returns eng_load's result (0 = runs) */
  load(bin: Uint8Array, name: string, opts: { slot?: number; fresh?: boolean } = {}): number {
    if (bin.length > this.x.fm1w_patch_max()) return -1;
    new Uint8Array(this.x.memory.buffer, this.x.fm1w_patch(), bin.length).set(bin);
    const nm = new Uint8Array(this.x.memory.buffer, this.x.fm1w_name(), 24);
    nm.fill(0);
    nm.set(new TextEncoder().encode(name).slice(0, 23));
    return this.x.fm1w_load(bin.length, opts.slot ?? 255, opts.fresh === false ? 0 : 1);
  }

  /** the clock, ms since start (call every animation frame) */
  tick(ms: number): void { this.x.fm1w_tick(ms >>> 0); }
  encoder(n: number, clicks: number): void { this.x.fm1w_encoder(n, clicks | 0); }
  /** Button gestures can end auditioned notes, such as switching step-record preview off. */
  button(id: number, down: boolean): KeyPlay[] {
    this.played.length = 0;
    this.x.fm1w_button(id, down ? 1 : 0);
    return this.played.splice(0);
  }
  /** the 27 keys held now, bit 0 = F3. Returns what the keys that changed played, as the FM-1 plays them (#467): the
   * page sounds these, not the keys' own notes */
  keys(bits: number): KeyPlay[] {
    this.played.length = 0;
    this.x.fm1w_keys(bits >>> 0);
    return this.played.splice(0);
  }
  focus(device: number, page: number): void { this.x.fm1w_focus(device, page); }
  param(module: number, param: number, value: number): void { this.x.fm1w_param(module, param, value | 0); }
  transport(run: boolean): void { this.x.fm1w_transport(run ? 1 : 0); }
  /** PRESET turned with PLAY held on the FM-1 it follows in sandbox mode (the browser's tempo): PLAY's release starts and
   *  stops nothing */
  playTurned(): void { this.x.fm1w_play_turned?.(); }
  /** a track muted / unmuted on the FM-1 it follows (MUTE_NOW): its black key's light follows */
  mute(module: number, on: boolean): void { this.x.fm1w_mute(module, on ? 1 : 0); }
  /** the page's TEMPO setting, global tempo and time signature (D-907, #1011): the emulated FM-1 plays and shows them */
  tempo(global: boolean, bpm: number, meter: number): void { this.x.fm1w_tempo?.(global ? 0 : 1, Math.round(bpm), meter); }
  /** the editor's armed devices (#191): their modules as a mask (arm.ts armMask, ARM_WORDS words, #721) */
  armMask(words: readonly number[]): void { this.x.fm1w_arm_mask(words[0] >>> 0, (words[1] ?? 0) >>> 0, (words[2] ?? 0) >>> 0, (words[3] ?? 0) >>> 0); }

  /** the buttons held (bit: matrix id), as the panel logic took them; null from a wasm built before #549 */
  get held(): number | null { return this.x.fm1w_held ? this.x.fm1w_held() : null; }
  /** the panel's state as the FM-1's GUIDE_NOW says its own (#549, firmware/src/help_ui.c guide_state); null from a wasm
   *  built before it */
  guide(): PanelState | null {
    const at = this.x.fm1w_guide?.();
    return at === undefined ? null : parseGuideNow(new Uint8Array(this.x.memory.buffer, at, GUIDE_BYTES));
  }
  /** following an FM-1 (#549): put the panel logic back where the FM-1 says it is (its GUIDE_NOW's bytes), quietly: no
   *  control's edge is played, nothing is told (firmware/src/panel.c panel_align) */
  align(fm1: PanelState): void {
    const at = this.x.fm1w_align_buf?.();
    if (at === undefined || !this.x.fm1w_align) return;
    new Uint8Array(this.x.memory.buffer, at, GUIDE_BYTES).set(fm1.raw.slice(0, GUIDE_BYTES));
    this.x.fm1w_align();
  }
  /** the palette the copy's HOME-held overview shows (#1196): 8 positions {state 0 empty / 1 ok / 2 missing, slot,
   *  pattern, name}, the one playing and the one waiting (null none); a wasm built before it ignores it */
  palette(positions: readonly { state: number; slot: number; pattern: number; name: string }[], cur: number | null, next: number | null): void {
    const at = this.x.fm1w_palette_buf?.();
    if (at === undefined || !this.x.fm1w_palette) return;
    const buf = new Uint8Array(this.x.memory.buffer, at, 8 * 24);
    buf.fill(0);
    positions.slice(0, 8).forEach((p, i) => {
      buf.set([p.state, p.slot, p.pattern, 0], i * 24);
      for (let k = 0; k < 20 && k < p.name.length; k++) buf[i * 24 + 4 + k] = p.name.charCodeAt(k) & 0x7f;
    });
    this.x.fm1w_palette(cur ?? 0xff, next ?? 0xff);
  }

  get page(): number { return this.x.fm1w_page(); }
  get focusDevice(): number { return this.x.fm1w_focus_dev(); }
  get focusPage(): number { return this.x.fm1w_focus_page(); }
  get octave(): number { return this.x.fm1w_octave(); }
  /** the panel's lights as the firmware sets them (after X0X's browser emulator): the buttons by matrix id, the 27 keys
   * from F3; lit, a dim glow, the mid level (the SEQ page's playhead), breathing (PLAY running, a shifted octave) */
  lights(): Lights {
    const m = (kind: number, first: number): number => this.x.fm1w_led(kind, first) >>> 0;
    return {
      buttons: { lit: m(0, 0) & 0x3fff, dim: m(1, 0) & 0x3fff, breath: m(3, 0) & 0x3fff },
      keys: { lit: m(0, 14), mid: m(2, 14), dim: m(1, 14) },
    };
  }
  /** whether the screen changed since the last call */
  takeDirty(): boolean { return this.x.fm1w_take_dirty() !== 0; }
  /** the framebuffer, 240 x 240 RGB565 (a view into the module's memory: copy it to keep it) */
  framebuffer(): Uint16Array { return new Uint16Array(this.x.memory.buffer, this.x.fm1w_fb(), 240 * 240); }
  /** the framebuffer as RGBA bytes for an ImageData */
  rgba(out = new Uint8ClampedArray(240 * 240 * 4)): Uint8ClampedArray {
    const fb = this.framebuffer();
    for (let i = 0; i < fb.length; i++) {
      const c = fb[i];
      out[4 * i] = (((c >> 11) & 31) * 255 / 31) | 0;
      out[4 * i + 1] = (((c >> 5) & 63) * 255 / 63) | 0;
      out[4 * i + 2] = ((c & 31) * 255 / 31) | 0;
      out[4 * i + 3] = 255;
    }
    return out;
  }
}
