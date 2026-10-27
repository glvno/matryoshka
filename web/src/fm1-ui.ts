// SPDX-License-Identifier: GPL-3.0-only
// The FM-1's UI as WebAssembly (firmware/wasm/fm1_ui.c, built by `npm run fm1-wasm` into public/fm1-ui.wasm): the real
// panel core and screens on the C engine, with no hardware. The page loads a patch binary (patchbin.ts encodePatch),
// drives the panel and the clock, and draws the 240 x 240 RGB565 framebuffer. No DOM here: the editor's FM-1 tab
// (#110) and the tests use it.
import { wordNote, type SongEntry, type StepNote } from './track';

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
  /** the SEQ page: a track's notes as they are after an edit there (of pattern `pat`, 0-based: the one it plays), a track
   * muted (module = its index in the binary) */
  track?(module: number, notes: StepNote[], pat: number): void;
  /** PRESET on the SEQ page or the SONG page chose the patch's pattern (0-based) or the song (0 none) (#375) */
  pattern?(pattern: number, song: number): void;
  /** the SONG page edited song s (0-based): its entries */
  song?(s: number, entries: SongEntry[]): void;
  mute?(module: number, on: boolean): void;
  /** the FM-1 armed or disarmed (#139, #191: REC held + a black key, REC on an environment row): the armed modules, by
   * their index in the binary, as a mask in two halves */
  arms?(lo: number, hi: number): void;
}

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
  fm1w_mute(module: number, on: number): void;
  fm1w_arm_mask(lo: number, hi: number): void;
  fm1w_focus_dev(): number; fm1w_focus_page(): number; fm1w_octave(): number;
}

export class Fm1Ui {
  private constructor(private x: Exports) {}

  /** instantiate from the module's bytes (a fetch of fm1-ui.wasm, or a file in tests) */
  static async create(bytes: BufferSource, ev: Fm1Events = {}): Promise<Fm1Ui> {
    let memory: WebAssembly.Memory | null = null;
    const env = {
      focus: (d: number, g: number) => ev.focus?.(d, g),
      param: (m: number, p: number, v: number) => ev.param?.(m, p, v),
      preset: (d: number) => ev.preset?.(d),
      save: () => ev.save?.(),
      midi: (s: number, a: number, b: number) => ev.midi?.(s, a, b),
      transport: (r: number) => ev.transport?.(r !== 0),
      track: (m: number, at: number, n: number, pat: number) => ev.track?.(m, memory ? [...new Uint32Array(memory.buffer, at, n)].map(wordNote) : [], pat ?? 0),
      pattern: (p: number, song: number) => ev.pattern?.(p, song),
      song: (k: number, at: number, n: number) => ev.song?.(k, memory ? Array.from({ length: n }, (_, j) => {
        const b = new Uint8Array(memory!.buffer, at + 2 * j, 2);
        return { pat: b[0], shift: (b[1] << 24) >> 24 };
      }) : []),
      mute: (m: number, on: number) => ev.mute?.(m, on !== 0),
      arms: (lo: number, hi: number) => ev.arms?.(lo >>> 0, hi >>> 0),
    };
    const { instance } = await WebAssembly.instantiate(bytes, { fm1: env });
    memory = (instance.exports as unknown as Exports).memory;
    return new Fm1Ui(instance.exports as unknown as Exports);
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
  button(id: number, down: boolean): void { this.x.fm1w_button(id, down ? 1 : 0); }
  /** the 27 keys held now, bit 0 = F3 */
  keys(bits: number): void { this.x.fm1w_keys(bits >>> 0); }
  focus(device: number, page: number): void { this.x.fm1w_focus(device, page); }
  param(module: number, param: number, value: number): void { this.x.fm1w_param(module, param, value | 0); }
  transport(run: boolean): void { this.x.fm1w_transport(run ? 1 : 0); }
  /** a track muted / unmuted on the FM-1 it follows (MUTE_NOW): its black key's light follows */
  mute(module: number, on: boolean): void { this.x.fm1w_mute(module, on ? 1 : 0); }
  /** the editor's armed devices (#191): their modules as a mask (arm.ts armMask) */
  armMask(lo: number, hi: number): void { this.x.fm1w_arm_mask(lo >>> 0, hi >>> 0); }

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
