// SPDX-License-Identifier: GPL-3.0-only
// Which M-VAVE package an install to M-VAVE's update loader was writing: the official V15 or Official Open (#183). That
// loader (ota-FM-1_015) writes the software that starts the FM-1 (its boot code, flash 0x0000-0x3FFF) from whatever
// package it is given, and the two packages carry different ones. So a cut-off install is finished only with the
// package it started with, remembered here in this browser; without a memory the person says which one, knowing the
// cost of a wrong answer.

export type MvaveTarget = 'v15' | 'open';

export const TARGET_KEY = 'matryoshka.mvave-target';
export const TARGET_NAME: Record<MvaveTarget, string> = { v15: 'Return to official V15', open: 'Restore Official Open' };
const MVAVE_LOADER = 'ota-FM-1_015';

/** the storage it lives in: localStorage in the page, a Map in tests */
export interface TargetStore {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

const store = (): TargetStore | null => {
  try {
    return localStorage;
  } catch {
    return null;
  }
};

export function rememberedTarget(s: TargetStore | null = store()): MvaveTarget | null {
  try {
    const v = s?.getItem(TARGET_KEY);
    return v === 'v15' || v === 'open' ? v : null;
  } catch {
    return null;
  }
}

/** null forgets it (the install finished) */
export function rememberTarget(t: MvaveTarget | null, s: TargetStore | null = store()): void {
  try {
    if (t) s?.setItem(TARGET_KEY, t);
    else s?.removeItem(TARGET_KEY);
  } catch {
    /* storage blocked: a later resume asks instead */
  }
}

const fail = (code: string, msg: string): Error => Object.assign(new Error(msg), { code });

/** the start-up software, said plainly first */
const STARTUP = 'the small piece of software at the start of its memory that starts the FM-1 (its boot code)';
const POWER_CUT = "if the power is cut while that part is being replaced, the FM-1 will most likely not start any more until it is repaired in the chip's own repair mode";

export const WRONG_TARGET = (was: MvaveTarget): string =>
  `The FM-1 waits in M-VAVE's update loader from an unfinished ${TARGET_NAME[was]}. Nothing was sent. Press ${TARGET_NAME[was]} to finish it. ` +
  `The other package would also replace ${STARTUP}, and ${POWER_CUT}.`;

export const WHICH_TARGET =
  "The FM-1 waits in M-VAVE's update loader from an unfinished return to stock, and this browser does not remember whether it was Return to official V15 or Restore Official Open. Nothing was sent. " +
  `Tick “I know which one was cut off” and press that one again. The loader takes the other one too, but then also replaces ${STARTUP}, and ${POWER_CUT}.`;

/** for Updater.resume: refuses (throws) before anything is sent when M-VAVE's loader waits for the other package, or
 *  for an unknown one without `sure`; on its way through it remembers `want`, as the write is about to start */
export function targetGuard(want: MvaveTarget, sure: boolean, s: TargetStore | null = store()): (loader: string) => void {
  return (loader) => {
    if (loader !== MVAVE_LOADER) return;
    const was = rememberedTarget(s);
    if (was && was !== want) throw fail('wrongtarget', WRONG_TARGET(was));
    if (!was && !sure) throw fail('whichtarget', WHICH_TARGET);
    rememberTarget(want, s);
  };
}
