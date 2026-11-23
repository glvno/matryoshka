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
// of the bank read from the FM-1 itself (bankBackup: SLOT_GET and the kept copies, bank-backup.ts keeps it); firmware
// without SLOT_GET (only builds before it) gets no backup; tools/fm1_install.py refuses unless --force.
import { binLength, deviceName, knownCopy, type Candidate, type KnownCopy } from './bank';
import type { KeptCopy, LinkedEntry, SlotBackup } from './bank-backup';
import { linksOf } from './bin-links';
import { runningVersion } from './fm1-version';
import type { Patch } from './patch';
import { encodePatch } from './patchbin';
import { applyPayload, payloadHash, portablePatch, withLinks } from './pattern-store';
import { BANK_SLOTS, FEATURE25_PATTERNS_STORED, FEATURE25_SLOT_GET, SLOT_INLINE, SLOT_STORED, slotCount, slotLabel, type Info, type SlotInfo, type SlotRefusal, type StoredPatternEntry } from './protocol';
import type { BufferAllocation } from './signal-buffers';

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

/** the running 1.26 FM-1 sends its slots and kept copies for a backup (INFO byte 25 bit 2); a build of 1.26 before that
 *  cannot */
export const sendsBank = (info: Info): boolean => !!(info.features25 & FEATURE25_SLOT_GET);
export const NO_BACKUP_TEXT = 'This FM-1’s firmware cannot send its patches, so there is no backup to make: update it to the current firmware first to back up its bank.';

/** what the Install panel's dialog adds about the backup it offers */
export const BACKUP_TEXT = 'Back up the bank first: every slot with its patterns inside, as older firmware reads it, and the pattern store’s kept copies, '
  + 'to this browser or to a file (Load patch from .json brings it back); Library › Patches › Restore FM-1 bank backup writes it to an FM-1.';
/** what the dialog says of slots too big for older firmware with every pattern inside */
export const onlyNewText = (slots: readonly SlotInfo[]): string =>
  `${slotList(slots)} cannot go back to firmware older than 1.26 with every pattern inside; ${slots.length === 1 ? 'it is' : 'they are'} kept for restoring onto 1.26.`;
/** why a backup waits (SLOT_GET's refusals), and what the dialog asks before Retry */
export const HELD_TEXT: Record<'edited' | 'running', string> = {
  edited: 'The FM-1’s patch has unsaved edits (or the editor’s Live holds it, or a palette switch waits): save or discard the edits on the FM-1 first (or stop Live), then Retry.',
  running: 'The FM-1’s transport runs: stop it (PLAY), then Retry.',
};
/** a backup that cannot be read now (HELD_TEXT); nothing of it is kept */
export class BackupHeld extends Error {
  constructor(readonly reason: 'edited' | 'running') { super(HELD_TEXT[reason]); }
}

/** the bank of a 1.26 FM-1 as a backup: `slots` (bank-backup.ts), the patches this browser has a copy of with every
 *  pattern inside (`patches`, for Your patches), the kept copies, the slots kept as 1.26 stores them (`onlyNew`) and
 *  those the FM-1 could not read */
export interface BankBackup { slots: SlotBackup[]; patches: Patch[]; kept: KeptCopy[]; onlyNew: SlotInfo[]; unreadable: SlotInfo[] }
/** what a backup reads from the FM-1: a slot's binary (SLOT_GET), the store's list (PATS), an entry's payload (PAT_GET) */
export interface BankReader {
  slot(slot: number, mode: number): Promise<Uint8Array | SlotRefusal>;
  list(): Promise<StoredPatternEntry[]>;
  pattern(id: number): Promise<Uint8Array | null>;
}

/** this browser's copy of a slot's patch: a candidate of its name whose binary, with the slot's links (`stored`: the binary
 *  as the FM-1 stores it), is the slot's byte for byte; else one of its name and length (bank.ts knownCopy) */
function copyOf(s: SlotInfo, stored: Uint8Array, candidates: Candidate[], allocation: BufferAllocation): KnownCopy | null {
  const links = linksOf(stored);
  for (const c of candidates) {
    if (deviceName(c.name) !== s.name) continue;
    const p = c.patch();
    try {
      const l = Object.fromEntries(links.map(([q, id]) => [q, { id, hash: payloadHash(p, q) }]));
      const bin = encodePatch(withLinks(p, l), true, 0, allocation, new Map(links.map(([q, id]) => [id, l[q].hash])));
      if (bin.length === stored.length && bin.every((b, i) => b === stored[i])) return { name: c.name, patch: p, factory: !!c.factory };
    } catch {
      /* (a candidate that does not encode is no copy) */
    }
  }
  return knownCopy(s, candidates, (p) => binLength(p, 'every'));
}

/** the bank of a 1.26 FM-1 with SLOT_GET (its slots as SLOT_INFO read them) read for a backup: each used slot with every
 *  pattern inside (SLOT_INLINE), or, too big for that, as stored with the patterns it links (PAT_GET); this browser's copy
 *  of each slot's patch with the FM-1's patterns inside (portablePatch); every kept copy. Throws BackupHeld when the FM-1
 *  cannot lend its running patch now. `allocation`: the FM-1's buffer allocation rule, for matching copies */
export async function bankBackup(slots: readonly SlotInfo[], candidates: Candidate[], read: BankReader, allocation: BufferAllocation = 0, saved = Date.now()): Promise<BankBackup> {
  const entries = await read.list();
  const payload = async (id: number): Promise<Uint8Array> => {
    const p = await read.pattern(id);
    if (!p) throw new Error(`the FM-1 has no stored pattern ${id} any more`);
    return p;
  };
  const out: BankBackup = { slots: [], patches: [], kept: [], onlyNew: [], unreadable: [] };
  for (const e of entries.filter((x) => x.kept)) out.kept.push({ name: e.name, payload: await payload(e.id) });
  for (const s of slots.filter((x) => x.used)) {
    const inline = await read.slot(s.slot, SLOT_INLINE);
    if (inline === 'edited' || inline === 'running') throw new BackupHeld(inline);
    const stored = inline === 'empty' ? inline : await read.slot(s.slot, SLOT_STORED);
    if (inline === 'empty' || typeof stored === 'string') {
      out.unreadable.push(s);
      continue;
    }
    const links = linksOf(stored);
    const linked = new Map<number, Uint8Array>();
    for (const [, id] of links) if (!linked.has(id)) linked.set(id, await payload(id));
    if (inline === 'too big') {
      const patterns: LinkedEntry[] = [...linked].map(([id, p]) => ({ id, name: entries.find((e) => e.id === id)?.name ?? '', payload: p }));
      out.slots.push({ slot: s.slot, name: s.name, binary: stored, patterns, saved });
      out.onlyNew.push(s);
    } else out.slots.push({ slot: s.slot, name: s.name, binary: inline, saved });
    const copy = copyOf(s, stored, candidates, allocation);
    if (!copy) continue;
    const patch = structuredClone({ ...copy.patch, name: copy.name });
    for (const [q, id] of links) applyPayload(patch, q, linked.get(id)!);
    out.patches.push(portablePatch(patch));
  }
  return out;
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
