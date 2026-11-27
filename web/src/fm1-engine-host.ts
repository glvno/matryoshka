// SPDX-License-Identifier: GPL-3.0-only
// The page's side of the FM-1 engine (#941, fm1-engine.ts): the binary it loads and the module-index messages it takes,
// made from the editor's patch and its messages to the browser engine as the device link makes them (device.ts): the
// binary is encodePatch of the device form, a parameter is PARAM (module index, parameter index, Q16), and an edit the link
// answers by sending the whole patch again reloads it.
import './device-shown';   // (what the FM-1 shows, for the device compile pass)
import { armMask } from './arm';
import type { Fm1Op } from './fm1-engine';
import { DEFS } from './modules';
import type { Patch } from './patch';
import { encodePatch, toQ16 } from './patchbin';
import { ALLOC, deviceView } from './poly';
import { noteWords, TRACK_NOTES_MAX } from './track';
import type { HostMsg } from './worklet';

/** the bypass as a parameter index (fm1_engine.c fm1e_param, the link's PARAM_NOW sentinel) */
const BYPASS = 0xff;

export class Fm1Bridge {
  /** module id -> index in the binary last loaded */
  private index = new Map<number, number>();

  /** the binary the FM-1 would get for `patch` (as the Emulator view's: over the budget still goes in), with no pattern store
   *  (every linked pattern written out); throws what encodePatch throws (a key routing the FM-1 cannot play) */
  load(patch: Patch): Fm1Op {
    const bin = encodePatch(patch, true, 0, 0, 'none');
    this.index = new Map(deviceView(patch, true).patch.modules.map((m, i) => [m.id, i]));
    return { op: 'load', bin };
  }

  /** what a message to the browser engine is for the FM-1 engine: module-index messages, 'reload' (the whole patch again),
   *  or none (the messages without a module index go to it as they are: worklet.ts) */
  translate(patch: Patch, m: HostMsg): Fm1Op[] | 'reload' {
    const mod = 'id' in m && typeof m.id === 'number' ? this.index.get(m.id) : undefined;
    const type = 'id' in m ? patch.modules.find((x) => x.id === m.id)?.type : undefined;
    switch (m.t) {
      case 'param': {
        if (!type) return [];
        const par = DEFS[type].params.findIndex((q) => q.name === m.name);
        // a Voice allocator's setting (the poly groups: in the device form the allocator is its group's Part) and a parameter
        // fixed at load (a Delay's length) reach the FM-1 only with the whole patch (main.ts onParam)
        if (type === ALLOC || DEFS[type].params[par]?.fixed) return 'reload';
        return mod === undefined || par < 0 ? [] : [{ op: 'param', mod, par, v: toQ16(m.value) }];
      }
      case 'att': return mod === undefined ? [] : [{ op: 'att', mod, input: m.index, v: toQ16(m.value) }];
      case 'bypass': return mod === undefined ? [] : [{ op: 'param', mod, par: BYPASS, v: m.on ? 1 : 0 }];
      case 'mute': return mod === undefined ? [] : [{ op: 'mute', mod, on: m.on }];
      case 'track': return mod === undefined ? [] : [{ op: 'track', mod, pat: m.pat ?? -1, words: noteWords(m.notes).slice(0, TRACK_NOTES_MAX) }];
      case 'thru': return mod === undefined ? [] : [{ op: 'thru', mod, note: m.note, vel: m.vel }];
      case 'arm': return [{ op: 'arm', words: armMask(patch, m.devices) }];
      // (rare edits the link sends in its own frames, a DX7's voice: here the whole patch again)
      case 'range': case 'songs': case 'voice': return 'reload';
      default: return [];
    }
  }
}
