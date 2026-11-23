// SPDX-License-Identifier: GPL-3.0-only
// The FM-1 bank backup (#1202 P2, G8): what the Flash tab saves before firmware older than 1.26 goes onto a 1.26 FM-1
// (install-bank.ts bankBackup reads it), kept in this browser or in a browser backup file, and written back to an FM-1.
// - The slots: per used slot its number, name and binary. Normally the binary is the patch with every linked pattern
//   inside and no links (SLOT_GET mode 1), which any firmware reads. A slot too big for that is kept as the 1.26 FM-1
//   stores it, with links, beside the patterns it links (`patterns`: id, name, payload): it goes back only onto a 1.26 FM-1,
//   whose store takes the patterns first (an entry with the same payload is reused) and the binary's links are rewritten
//   to their ids there (bin-links.ts). localStorage BANK_BACKUP_KEY, a JSON array of { slot, name, binary (hex),
//   patterns?: [{ id, name, payload (hex) }], saved (ms) }.
// - The kept copies (FX+SAVE, Keep a copy): localStorage KEPT_PATTERNS_KEY, a JSON array of { name, payload (hex) }.
//   Library › Patterns puts them back into an FM-1's store (restoreKept: kept copies on a 1.26 FM-1, plain entries on an
//   older one) and drops each stored one from the list.
// Both keys are lists migrate.ts merges ('Load patch from .json' of a backup file): an identical entry is not added twice.
// Restore FM-1 bank backup (Library › Patches, Commands: restoreBankBackup) writes the newest backup of each slot into
// that slot (SLOT), asking first; a slot past the FM-1's bank is reported, not written.
import type { DeviceLink } from './device';
import { fromHex, fnv, FNV0, hexBytes } from './pattern-store';
import { withLinkIds } from './bin-links';
import { slotLabel, type StoredPatternEntry } from './protocol';
import { LINK_ID_MAX } from './track';

export const BANK_BACKUP_KEY = 'matryoshka.bank-backup';
export const KEPT_PATTERNS_KEY = 'matryoshka.kept-patterns';

/** a stored pattern a backed-up 1.26 slot links: its id there, its name and payload */
export interface LinkedEntry { id: number; name: string; payload: Uint8Array }
/** a backed-up slot: `patterns` set when its binary is as a 1.26 FM-1 stores it (links), else every pattern is inside */
export interface SlotBackup { slot: number; name: string; binary: Uint8Array; patterns?: LinkedEntry[]; saved: number }
/** a kept copy of the FM-1's pattern store */
export interface KeptCopy { name: string; payload: Uint8Array }

const isHex = (s: unknown): s is string => typeof s === 'string' && /^([0-9a-f]{2})*$/i.test(s);
const list = (text: string | null): Record<string, unknown>[] => {
  try {
    const a = JSON.parse(text ?? '[]') as unknown;
    return Array.isArray(a) ? a.filter((e): e is Record<string, unknown> => !!e && typeof e === 'object') : [];
  } catch {
    return [];
  }
};

/** the slots as their JSON list, and back (entries that are not whole are left out) */
export const slotsJson = (slots: readonly SlotBackup[]): string => JSON.stringify(slots.map((s) => ({
  slot: s.slot, name: s.name, binary: hexBytes(s.binary), ...(s.patterns ? { patterns: s.patterns.map((e) => ({ id: e.id, name: e.name, payload: hexBytes(e.payload) })) } : {}), saved: s.saved,
})));
export function readSlotsJson(text: string | null): SlotBackup[] {
  return list(text).flatMap((e): SlotBackup[] => {
    const pats = Array.isArray(e.patterns) ? e.patterns as Record<string, unknown>[] : undefined;
    if (typeof e.slot !== 'number' || typeof e.name !== 'string' || !isHex(e.binary) || (pats && !pats.every((x) => typeof x?.id === 'number' && typeof x.name === 'string' && isHex(x.payload)))) return [];
    return [{ slot: e.slot, name: e.name, binary: fromHex(e.binary), ...(pats ? { patterns: pats.map((x) => ({ id: x.id as number, name: x.name as string, payload: fromHex(x.payload as string) })) } : {}), saved: typeof e.saved === 'number' ? e.saved : 0 }];
  });
}
/** the kept copies as their JSON list, and back */
export const keptJson = (kept: readonly KeptCopy[]): string => JSON.stringify(kept.map((k) => ({ name: k.name, payload: hexBytes(k.payload) })));
export const readKeptJson = (text: string | null): KeptCopy[] =>
  list(text).flatMap((e) => (typeof e.name === 'string' && isHex(e.payload) ? [{ name: e.name, payload: fromHex(e.payload) }] : []));

/** `here` with the entries of `more` whose key it has not got */
function mergeBy<T>(here: readonly T[], more: readonly T[], key: (x: T) => string): T[] {
  const out = [...here], seen = new Set(here.map(key));
  for (const x of more) {
    if (seen.has(key(x))) continue;
    seen.add(key(x));
    out.push(x);
  }
  return out;
}
/** kept copies merged by name and payload; slots by slot, name and binary */
export const mergeKept = (here: readonly KeptCopy[], more: readonly KeptCopy[]): KeptCopy[] => mergeBy(here, more, (k) => `${k.name}\n${hexBytes(k.payload)}`);
export const mergeSlots = (here: readonly SlotBackup[], more: readonly SlotBackup[]): SlotBackup[] => mergeBy(here, more, (s) => `${s.slot}\n${s.name}\n${hexBytes(s.binary)}`);

/** this browser's backed-up slots and kept copies, and keeping more of them (merged) */
export const savedSlots = (storage: Pick<Storage, 'getItem'> = localStorage): SlotBackup[] => readSlotsJson(storage.getItem(BANK_BACKUP_KEY));
export const savedKept = (storage: Pick<Storage, 'getItem'> = localStorage): KeptCopy[] => readKeptJson(storage.getItem(KEPT_PATTERNS_KEY));
export function keepBackup(slots: readonly SlotBackup[], kept: readonly KeptCopy[], storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage): void {
  storage.setItem(BANK_BACKUP_KEY, slotsJson(mergeSlots(savedSlots(storage), slots)));
  storage.setItem(KEPT_PATTERNS_KEY, keptJson(mergeKept(savedKept(storage), kept)));
}

/** the parts of the editor link a restore takes */
export type RestoreLink = Pick<DeviceLink, 'connected' | 'bankSlots' | 'hasPatternStore' | 'patternsStored' | 'listPatterns' | 'putPattern' | 'uploadSlotBin'>;

/** a payload's id in the FM-1's store: an entry with the same payload (not read-only), else a new one under `name`
 *  (`entries` learns it) */
async function entryFor(link: RestoreLink, entries: StoredPatternEntry[], name: string, payload: Uint8Array, kept = false): Promise<number> {
  const hash = fnv(FNV0, payload);
  const same = entries.find((e) => e.hash === hash && e.len === payload.length && e.id <= LINK_ID_MAX && !e.readOnly && (!kept || e.kept));
  if (same) return same.id;
  const id = await link.putPattern(0, name, payload, kept);
  entries.push({ id, len: payload.length, hash, layout: 0, tracks: 0, readOnly: false, kept, name });
  return id;
}

/** the newest backup of each slot, those the FM-1's bank has a place for (`write`) and those past it (`past`) */
export function restorePlan(slots: readonly SlotBackup[], bankSlots: number): { write: SlotBackup[]; past: SlotBackup[] } {
  const newest = new Map<number, SlotBackup>();
  for (const s of slots) if ((newest.get(s.slot)?.saved ?? -1) <= s.saved) newest.set(s.slot, s);
  const all = [...newest.values()].sort((a, b) => a.slot - b.slot);
  return { write: all.filter((s) => s.slot < bankSlots), past: all.filter((s) => s.slot >= bankSlots) };
}

/** backed-up slot `s` into its slot: a slot kept as a 1.26 FM-1 stores it puts its patterns into the store first (an FM-1
 *  that stores every pattern only) and its links name their ids there */
export async function restoreSlot(link: RestoreLink, s: SlotBackup, entries: StoredPatternEntry[]): Promise<void> {
  let bin = s.binary;
  if (s.patterns) {
    if (!link.patternsStored) throw new Error(`slot ${slotLabel(s.slot)} "${s.name}" goes back only onto an FM-1 with firmware 1.26 or later`);
    const ids = new Map<number, number>();
    for (const e of s.patterns) ids.set(e.id, await entryFor(link, entries, e.name, e.payload));
    bin = withLinkIds(bin, ids);
  }
  await link.uploadSlotBin(s.slot, s.name, bin);
}

/** this browser's kept copies into the FM-1's store: kept copies on an FM-1 that stores every pattern, plain entries on an
 *  older one with a store (one with the same payload counts as there); each leaves this browser's list once stored. How
 *  many went; a refusal throws, the ones not stored yet staying in the list */
export async function restoreKept(link: RestoreLink, storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage): Promise<number> {
  if (!link.connected || !link.hasPatternStore) throw new Error('Connect an FM-1 whose pattern store is on.');
  const entries = await link.listPatterns(), left = savedKept(storage);
  let n = 0;
  while (left.length) {
    await entryFor(link, entries, left[0].name, left[0].payload, link.patternsStored);
    left.shift();
    storage.setItem(KEPT_PATTERNS_KEY, keptJson(left));
    n++;
  }
  return n;
}

/** Restore FM-1 bank backup: this browser's newest backup of each slot written into that slot, after `ask` (the slots it
 *  replaces named); what it did, as a line for the status */
export async function restoreBankBackup(link: RestoreLink, ask: (question: string) => boolean = (q) => window.confirm(q), storage: Pick<Storage, 'getItem'> = localStorage): Promise<string> {
  if (!link.connected) return 'Connect the FM-1 to restore its bank backup.';
  const { write, past } = restorePlan(savedSlots(storage), link.bankSlots);
  const pastText = past.length ? ` ${past.map((s) => `${slotLabel(s.slot)} ${s.name}`).join(', ')}: past this FM-1's ${link.bankSlots} slots, not written.` : '';
  if (!write.length) return past.length ? `Nothing restored.${pastText}` : 'This browser keeps no FM-1 bank backup (the Flash tab makes one before installing older firmware).';
  if (!ask(`Write the bank backup into slot${write.length === 1 ? '' : 's'} ${write.map((s) => `${slotLabel(s.slot)} ${s.name}`).join(', ')}? What ${write.length === 1 ? 'it holds' : 'they hold'} now is replaced.${pastText}`)) return 'Nothing restored.';
  const entries = write.some((s) => s.patterns) && link.hasPatternStore ? await link.listPatterns() : [];
  const done: string[] = [], failed: string[] = [];
  for (const s of write) {
    try {
      await restoreSlot(link, s, entries);
      done.push(slotLabel(s.slot));
    } catch (e) {
      failed.push(`${slotLabel(s.slot)}: ${(e as Error).message}`);
    }
  }
  return `Restored ${done.length} slot${done.length === 1 ? '' : 's'}${done.length ? ` (${done.join(', ')})` : ''}.${failed.length ? ` Not restored: ${failed.join('; ')}.` : ''}${pastText}`;
}
