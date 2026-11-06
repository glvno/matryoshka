// SPDX-License-Identifier: GPL-3.0-only
// Drones and ties across the loop point (#384, format 50): the engine, the step view and its edits, the binary.
import { describe, expect, it } from 'vitest';
import { Engine } from './engine';
import { DEFS } from './modules';
import { addModule, connect, emptyPatch, validatePatch, type ModuleInst } from './patch';
import { encodePatch, formatOf, FORMAT_1_10 } from './patchbin';
import { cutBefore, droneRow, endOn, fixNotes, isDrone, isShortNote, noteThrough, noteWord, setStep, STEPS_MAX, stepView, wordNote, type StepNote } from './track';

const SR = 48000, STEP = 6000;
const n = (at: number, len: number, note = 60, wrap = false): StepNote => ({ at, len, note, vel: 100, ...(wrap ? { wrap: true } : {}) });

function rig(notes: StepNote[], dir = 0, len = 4) {
  const p = emptyPatch('drones');
  addModule(p, DEFS.fm1, 0, 0);
  const st = addModule(p, DEFS.steps, 0, 0), out = addModule(p, DEFS.output, 0, 0);
  Object.assign(st.params, { dir, len, gate: 0.25 });
  st.notes = notes;
  out.params.level = 1;
  connect(p, DEFS, { module: st.id, port: 'trig' }, { module: out.id, port: 'l' });
  const e = new Engine(SR);
  e.load(p);
  e.transport(true);
  return { e, p, st };
}
/** the trig output over `frames`: where it rises (a note starts) and whether it is up at a sample */
function play(e: Engine, frames: number): { starts: number[]; l: Float32Array } {
  const l = new Float32Array(frames), r = new Float32Array(frames);
  e.render(l, r);
  return { starts: [...l.keys()].filter((i) => l[i] > 0.5 && (i === 0 || l[i - 1] <= 0.5)), l };
}

describe('drones and ties across the loop point (#384)', () => {
  it('a drone starts once and holds through every pass, never starting again', () => {
    const { e } = rig([n(1, STEPS_MAX, 60, true)]);
    const { starts, l } = play(e, STEP * 16);
    expect(starts).toHaveLength(1);
    expect(Math.abs(starts[0] - STEP) < 300).toBe(true);
    expect([...l.subarray(STEP + 300)].every((x) => x > 0.5)).toBe(true);
  });

  it('a plain note through the whole pass starts again on every pass (D-538 unchanged)', () => {
    const { e } = rig([n(0, 4)]);
    expect(play(e, STEP * 12 - 10).starts.length).toBe(3);
  });

  it('a note tied across the loop point runs on into the next pass, then ends', () => {
    const { e } = rig([n(2, 3, 60, true)]); // steps 3, 4, then 1 of the next pass
    const { l, starts } = play(e, STEP * 8);
    expect(starts.length).toBe(2);
    expect(l[3 * STEP + STEP / 2]).toBe(1); // step 4: on through
    expect(l[4 * STEP + 1000]).toBe(1); // step 1 of pass 2: still sounding
    expect(l[4 * STEP + 2000]).toBe(0); // then it ends (gate 0.25 of its last step)
    const plain = play(rig([n(2, 3)]).e, STEP * 8).l;
    expect(plain[3 * STEP + 2000]).toBe(0); // (untied: cut at the end of the pass)
  });

  it('stop ends a drone, PLAY starts it again on its step', () => {
    const { e } = rig([n(0, STEPS_MAX, 60, true)]);
    play(e, STEP * 6);
    e.transport(false);
    const off = play(e, STEP * 4);
    expect(off.l[off.l.length - 1]).toBe(0);
    e.transport(true);
    expect(play(e, STEP * 8).starts).toHaveLength(1);
  });

  it('a drone taken out of the pattern ends; a muted track lets it end too', () => {
    const { e, st } = rig([n(0, STEPS_MAX, 60, true)]);
    play(e, STEP * 3);
    e.setTrack(st.id, [n(0, 1, 60)]);
    const a = play(e, STEP * 3);
    expect(a.l[STEP * 2]).toBe(0);
  });

  it('in ping-pong the end of a pass cuts a plain note there but not a tied one', () => {
    const tied = play(rig([n(1, STEPS_MAX, 60, true)], 2).e, STEP * 14);
    expect(tied.starts).toHaveLength(1);
    expect([...tied.l.subarray(STEP + 300)].every((x) => x > 0.5)).toBe(true);
  });
});

describe('the step view and its edits (#384)', () => {
  it('a drone goes on through every step but its own; a tied note through its first steps', () => {
    const d = [n(5, STEPS_MAX, 60, true)];
    expect([0, 4, 6, 15].every((k) => stepView(d, k, 16).tie)).toBe(true);
    expect(stepView(d, 5, 16)).toMatchObject({ on: true, tie: false });
    const w = [n(12, 7, 60, true)]; // 12..15, then 0..2
    expect([13, 15, 0, 2].map((k) => noteThrough(w[0], k, 16))).toEqual([true, true, true, true]);
    expect(noteThrough(w[0], 3, 16)).toBe(false);
    expect(stepView(w, 1)).toMatchObject({ tie: false }); // (no length given: no wrap)
  });

  it('endOn and cutBefore keep the flag only while the note runs across the loop point', () => {
    expect(endOn(n(12, 1), 2, 16)).toEqual(n(12, 7, 60, true));
    expect(endOn(n(12, 7, 60, true), 14, 16)).toEqual(n(12, 3));
    expect(cutBefore(n(12, 7, 60, true), 2, 16)).toEqual(n(12, 6, 60, true));
    expect(cutBefore(n(12, 7, 60, true), 0, 16)).toEqual(n(12, 4));
    expect(cutBefore(n(5, STEPS_MAX, 60, true), 9, 16)).toEqual(n(5, 4));
    expect(cutBefore(n(5, STEPS_MAX, 60, true), 2, 16)).toEqual(n(5, 13, 60, true));
  });

  it('the card: a tie on step 1 carries the note on the last step across the loop point; onto its own step, a drone; again, one step', () => {
    let t = setStep([n(0, 16)], 0, { on: true, accent: false, chance: 100, tie: true }, 16);
    expect(t).toEqual([n(0, STEPS_MAX, 60, true)]);
    expect(isDrone(t![0])).toBe(true);
    t = setStep(t, 0, { on: true, accent: false, chance: 100, tie: true }, 16);
    expect(t).toEqual([n(0, 1)]);
    t = setStep([n(10, 6)], 0, { on: false, accent: false, chance: 100, tie: true }, 16);
    expect(t).toEqual([n(10, 7, 60, true)]);
    t = setStep(t, 0, { on: false, accent: false, chance: 100 }, 16); // untied: cut before step 1
    expect(t).toEqual([n(10, 6)]);
  });
});

describe('the binary (format 50)', () => {
  it('bit 31 of a note word is the tie across the loop point; such a note is never a short word', () => {
    const d = n(3, STEPS_MAX, 62, true);
    expect(noteWord(d) >>> 31).toBe(1);
    expect(wordNote(noteWord(d))).toEqual(d);
    expect(noteWord(n(3, 4)) >>> 31).toBe(0);
    expect(isShortNote({ ...n(3, 2), wrap: true })).toBe(false);
    expect(fixNotes([{ ...d }, { at: 1, len: 1, note: 60, vel: 100, wrap: 'yes' }])).toEqual([{ at: 1, len: 1, note: 60, vel: 100 }, d]);
  });

  it('a patch with a tied note is written in format 50, one without stays older', () => {
    const p = emptyPatch('f');
    addModule(p, DEFS.fm1, 0, 0);
    const st: ModuleInst = addModule(p, DEFS.steps, 0, 0);
    st.notes = [n(0, 4)];
    const v = validatePatch(p, DEFS);
    expect(formatOf(v)).toBeLessThan(FORMAT_1_10);
    st.notes = [n(0, STEPS_MAX, 60, true)];
    const w = validatePatch(p, DEFS);
    expect(formatOf(w)).toBe(FORMAT_1_10);
    expect(encodePatch(w)[1]).toBe(FORMAT_1_10);
    expect(w.modules.find((m) => m.type === 'steps')!.notes).toEqual([n(0, STEPS_MAX, 60, true)]);
  });
});

describe('the row drone and the live-record drone (#384, the owner rulings of 2026-11-04)', () => {
  it('a row becomes one drone: its first note, the other notes of the row gone; again: one step; an empty row: nothing', () => {
    const t = [n(2, 1, 60), n(6, 2, 60), n(9, 1, 60), n(4, 1, 64)];
    const r = droneRow(t, 60)!;
    expect(r.say).toBe('DRONE');
    expect(r.notes).toEqual([n(2, STEPS_MAX, 60, true), n(4, 1, 64)]);
    const back = droneRow(r.notes, 60)!;
    expect(back.say).toBe('DRONE OFF');
    expect(back.notes).toEqual([n(2, 1, 60), n(4, 1, 64)]);
    expect(droneRow(t, 50)).toBeUndefined();
  });

  it('live record: a note held round the loop back to where it started becomes a drone; a shorter one stays a note', () => {
    for (const [held, drone] of [[4.2, true], [5.5, true], [2.6, false]] as const) {
      const { e, st } = rig([]);
      e.arm(st.id);
      e.setRec(st.id, true);
      play(e, 1000);
      e.noteOn(67, 1);
      play(e, Math.round(STEP * held));
      e.noteOff(67);
      play(e, 256);
      const rec = e.takeRecorded();
      expect(rec).toHaveLength(1);
      expect(isDrone(rec[0].note), `held ${held} steps`).toBe(drone);
    }
  });
});
