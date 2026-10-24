// SPDX-License-Identifier: GPL-3.0-only
// Which M-VAVE package an install to M-VAVE's update loader was writing: the official V15, Official Open, or the V15
// crossing back over Open's boot code (#183). That loader (ota-FM-1_015) rewrites the boot code (flash 0x0000-0x3FFF)
// from whatever package it is given, and the two packages carry different boot codes. So a cut-off install is finished
// only with the package it started with, remembered here in this browser; a cut-off crossing only with the crossing
// again, confirmed again (never on its own); without a memory the person says which one, knowing the cost of a wrong
// answer.

export type MvaveTarget = 'v15' | 'open' | 'v15-cross';

export const TARGET_KEY = 'matryoshka.mvave-target';
export const TARGET_NAME: Record<MvaveTarget, string> = { v15: 'Return to official V15', open: 'Restore Official Open', 'v15-cross': 'Cross back to V15' };
const MVAVE_LOADER = 'ota-FM-1_015';
const base = (t: MvaveTarget): 'v15' | 'open' => (t === 'open' ? 'open' : 'v15');

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
    return v === 'v15' || v === 'open' || v === 'v15-cross' ? v : null;
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

export const CROSS_RESUME =
  "The FM-1 waits in M-VAVE's update loader from an unfinished Cross back to V15. Nothing was sent: an interrupted crossing is never finished on its own. " +
  `The loader is running, so ${STARTUP} works, whichever one it is now. To finish with V15, read the warning on Cross back to V15 below and press Go back to V15 again.`;

/** for Updater.resume: refuses (throws) before anything is sent when M-VAVE's loader waits for another package, for an
 *  unknown one without `sure`, or from a crossing unless this is the crossing again with `sure` (its confirm); on its
 *  way through it remembers `want`, as the write is about to start */
export function targetGuard(want: MvaveTarget, sure: boolean, s: TargetStore | null = store()): (loader: string) => void {
  return (loader) => {
    if (loader !== MVAVE_LOADER) return;
    const was = rememberedTarget(s);
    if (was === 'v15-cross' && !(want === 'v15-cross' && sure)) throw fail('crossresume', CROSS_RESUME);
    if (was && base(was) !== base(want)) throw fail('wrongtarget', WRONG_TARGET(was));
    if (!was && !sure) throw fail('whichtarget', WHICH_TARGET);
    rememberTarget(want, s);
  };
}
