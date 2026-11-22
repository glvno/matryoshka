// SPDX-License-Identifier: GPL-3.0-only
// The Install panel's look at the bank before firmware 1.26 or later goes onto an FM-1 that runs older firmware (#1202,
// G9). Firmware 1.26 has 48 slots where the older bank has 60 (64 before the pattern store). At its first start it moves
// the patches of slots 49 and up into empty lower slots when there is room; with more than 48 patches it keeps the old
// layout and says so on its screen until slots are freed. The editor never installs over such a bank silently: it reads
// the bank (SLOT_INFO) first. Slots 49 and up empty: it installs. Occupied, with 48 patches or fewer: it says which move,
// then installs. More than 48: the user saves what this browser has a copy of, picks which to keep and the rest are
// erased (SLOT_ERASE) before the install; Cancel leaves everything as it was. tools/fm1_install.py refuses the same bank
// with the same explanation. These are the pure parts; flasher.ts asks and acts.
import { runningVersion } from './fm1-version';
import { BANK_SLOTS, FEATURE_PATTERNS_STORED, slotCount, slotLabel, type Info, type SlotInfo } from './protocol';

/** a firmware package (its product, FM-1_7MMmmpp) whose bank has BANK_SLOTS slots: Matryoshka 1.26 or later, or a dev or CI
 *  build (built from the current source) */
export function packageHasSmallBank(product: string): boolean {
  const v = runningVersion(null, product);
  return v === 'dev' || (!!v && (v.major > 1 || (v.major === 1 && v.minor >= 26)));
}

/** the running FM-1 (its INFO) has slots past BANK_SLOTS and firmware that does not keep its patterns in the pattern store
 *  (before 1.26): its bank must be looked at before the install. A 1.26 FM-1 that kept 60 slots handles them itself */
export const needsBankCheck = (info: Info): boolean => slotCount(info) > BANK_SLOTS && !((info.moreFeatures ?? 0) & FEATURE_PATTERNS_STORED);

/** what the install does with the bank: go on (`install`), go on once the user was told which slots move (`moves`), or
 *  wait until the user chose which patches to keep (`choose`: `over` of the `used` ones must go) */
export type BankPlan =
  | { kind: 'install' }
  | { kind: 'moves'; moving: SlotInfo[] }
  | { kind: 'choose'; used: SlotInfo[]; over: number };

/** the plan for a bank as SLOT_INFO read it */
export function bankPlan(slots: readonly SlotInfo[], room = BANK_SLOTS): BankPlan {
  const used = slots.filter((s) => s.used);
  const moving = used.filter((s) => s.slot >= room);
  if (!moving.length) return { kind: 'install' };
  if (used.length <= room) return { kind: 'moves', moving };
  return { kind: 'choose', used, over: used.length - room };
}

/** slots as a list: `52 VERONA 1, 57 BASS` */
export const slotList = (slots: readonly SlotInfo[]): string => slots.map((s) => `${slotLabel(s.slot)} ${s.name || '(no name)'}`).join(', ');

/** what the Install panel says before it installs over a bank whose slots past BANK_SLOTS move */
export const movesText = (moving: readonly SlotInfo[], room = BANK_SLOTS): string =>
  `Firmware 1.26 has ${room} slots. At its first start the FM-1 moves the patch${moving.length === 1 ? '' : 'es'} in slot${moving.length === 1 ? '' : 's'} ${slotList(moving)} to free slots below ${room + 1}.`;

/** the explanation for a bank of more than BANK_SLOTS patches: the Install panel's dialog and tools/fm1_install.py say it */
export const tooManyText = (used: readonly SlotInfo[], room = BANK_SLOTS): string => {
  const past = used.filter((s) => s.slot >= room);
  return `This FM-1 holds ${used.length} patches, and firmware 1.26 has ${room} slots. ${past.length ? `Slots ${slotLabel(room)} and up hold ${slotList(past)}. ` : ''}Free ${used.length - room} slot${used.length - room === 1 ? '' : 's'} first (the editor's Library > Patches erases a slot), then install.`;
};
