// SPDX-License-Identifier: GPL-3.0-only
// The Install panel's look at the bank before firmware 1.26 or later goes onto an FM-1 that runs older firmware (#1202,
// G9). Firmware 1.26 has 48 slots where the older bank has 60 (64 before the pattern store). At its first start it moves
// the patches of slots 49 and up into empty lower slots when there is room; with more than 48 patches it keeps the old
// layout and says so on its screen until slots are freed. The editor never installs over such a bank silently: it reads
// the bank (SLOT_INFO) first. Slots 49 and up empty: it installs. Occupied, with 48 patches or fewer: it says which move,
// then installs. More than 48: the user saves what this browser has a copy of, picks which to keep and the rest are
// erased (SLOT_ERASE) before the install; Cancel leaves everything as it was. tools/fm1_install.py refuses the same bank
// with the same explanation. These are the pure parts; flasher.ts asks and acts.
// The other way round (#1202, P2): a Matryoshka package older than 1.26 over an FM-1 that keeps every pattern 2..64 in its
// pattern store (1.26). The older firmware cannot read those patterns, so the Install panel warns first and offers a backup
// of the bank with every pattern inside each patch (bankBackup); tools/fm1_install.py refuses unless --force.
import { binLength, knownCopy, type Candidate } from './bank';
import { runningVersion } from './fm1-version';
import type { Patch } from './patch';
import { applyPayload, portablePatch } from './pattern-store';
import { BANK_SLOTS, FEATURE25_PATTERNS_STORED, slotCount, slotLabel, type Info, type SlotInfo } from './protocol';

/** a firmware package (its product, FM-1_7MMmmpp) whose bank has BANK_SLOTS slots: Matryoshka 1.26 or later, or a dev or CI
 *  build (built from the current source) */
export function packageHasSmallBank(product: string): boolean {
  const v = runningVersion(null, product);
  return v === 'dev' || (!!v && (v.major > 1 || (v.major === 1 && v.minor >= 26)));
}

/** a Matryoshka package older than 1.26 (a dev or CI build is not): its firmware cannot read the patterns a 1.26 FM-1
 *  keeps in its pattern store */
export const packageBeforeStore = (product: string): boolean => runningVersion(null, product) !== null && !packageHasSmallBank(product);

/** the running FM-1 (its INFO) keeps every pattern 2..64 in its pattern store: firmware 1.26 (INFO byte 25 bit 1) */
export const storesEveryPattern = (info: Info): boolean => !!(info.features25 & FEATURE25_PATTERNS_STORED);

/** the running FM-1 (its INFO) has slots past BANK_SLOTS and firmware that does not keep its patterns in the pattern store
 *  (before 1.26): its bank must be looked at before the install. A 1.26 FM-1 that kept 60 slots handles them itself */
export const needsBankCheck = (info: Info): boolean => slotCount(info) > BANK_SLOTS && !storesEveryPattern(info);

/** why a package older than 1.26 does not go onto a 1.26 FM-1 unasked: the Install panel's dialog and tools/fm1_install.py
 *  say it */
export const OLDER_FIRMWARE_TEXT = 'This FM-1 runs firmware 1.26 or later, which keeps patterns 2 to 64 of its patches in the pattern store. Firmware older than 1.26 cannot read them.';

/** what the Install panel's dialog adds about the backup it offers */
export const BACKUP_TEXT = 'Back up the bank first, with every pattern inside each patch: to this browser (Your patches) or to a file (Load patch from .json brings it back). '
  + 'The FM-1 cannot send its patches, so the backup holds this browser’s copy of each slot’s patch (the same name and length), with the patterns it links as the FM-1’s pattern store holds them now.';

/** what of the bank can be backed up: each used slot's patch this browser has a copy of, with every pattern inside it, and
 *  the used slots it has none of */
export interface BankBackup { patches: { slot: number; patch: Patch }[]; missing: SlotInfo[] }

/** the bank of a 1.26 FM-1 (its slots as SLOT_INFO read them) as the editor can back it up: the FM-1 cannot send a patch,
 *  so each slot gets this browser's copy of it (`candidates`, the same name and length as a 1.26 slot counts it, as the
 *  Library matches). Each pattern the copy links gets the entry's payload as the FM-1 holds it now (`stored`: PAT_GET, null
 *  when the FM-1 has no such entry, and the copy's own pattern stays), then the patch leaves its links (portablePatch) */
export async function bankBackup(slots: readonly SlotInfo[], candidates: Candidate[], stored: (id: number) => Promise<Uint8Array | null>): Promise<BankBackup> {
  const patches: BankBackup['patches'] = [], missing: SlotInfo[] = [];
  for (const s of slots.filter((x) => x.used)) {
    const copy = knownCopy(s, candidates, (p) => binLength(p, 'every'));
    if (!copy) {
      missing.push(s);
      continue;
    }
    const patch = structuredClone({ ...copy.patch, name: copy.name });
    const links = patch.modules.find((m) => m.type === 'fm1')?.seq?.links ?? {};
    for (const [k, l] of Object.entries(links)) {
      const payload = await stored(l.id);
      if (payload) applyPayload(patch, Number(k), payload);
    }
    patches.push({ slot: s.slot, patch: portablePatch(patch) });
  }
  return { patches, missing };
}

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
