// SPDX-License-Identifier: GPL-3.0-only
// "Store to an FM-1 slot…" (#635): a dialog lists the FM-1's 64 slots, each with the name of the patch it holds or EMPTY
// (read with SLOT_INFO, as Library > Patches reads the bank), and offers the first empty slot. A used slot is still
// replaced only after the caller asks (D-580).
import { slotLabel, type SlotInfo } from './protocol';

/** the slot offered first: the first empty one, else `fallback` (the slot the FM-1 plays), else the first */
export function firstFree(slots: readonly SlotInfo[], fallback?: number): number {
  const free = slots.find((s) => !s.used);
  if (free) return free.slot;
  return fallback !== undefined && slots.some((s) => s.slot === fallback) ? fallback : (slots[0]?.slot ?? 0);
}

/** a slot as the list shows it: `03  VERONA 1`, `04  EMPTY` */
export const slotText = (s: SlotInfo): string => `${slotLabel(s.slot)}  ${s.used ? s.name || '(no name)' : 'EMPTY'}`;

/** the line under the list: what storing into slot `s` does */
export const slotNote = (s: SlotInfo | undefined, name: string): string =>
  !s ? '' : s.used ? `Slot ${slotLabel(s.slot)} holds "${s.name}": storing replaces it with "${name}".` : `Slot ${slotLabel(s.slot)} is empty.`;

/** ask which slot to store `name` into; the slot's index, or null on Cancel. `dlg` is index.html's #store-slot */
export function chooseSlot(dlg: HTMLDialogElement, slots: readonly SlotInfo[], name: string, fallback?: number): Promise<number | null> {
  const sel = dlg.querySelector<HTMLSelectElement>('#store-slot-list')!;
  const note = dlg.querySelector<HTMLElement>('#store-slot-note')!;
  const go = dlg.querySelector<HTMLButtonElement>('#store-slot-go')!;
  const free = slots.filter((s) => !s.used).length;
  dlg.querySelector<HTMLElement>('#store-slot-text')!.textContent =
    `Store "${name}" into a slot of the FM-1's bank. ${free ? `${free} of ${slots.length} slots are empty.` : 'Every slot is used: storing replaces a patch.'}`;
  sel.replaceChildren(...slots.map((s) => Object.assign(document.createElement('option'), { value: String(s.slot), textContent: slotText(s) })));
  sel.size = Math.min(12, Math.max(4, slots.length));
  sel.value = String(firstFree(slots, fallback));
  const show = (): void => {
    const s = slots.find((x) => x.slot === Number(sel.value));
    note.textContent = slotNote(s, name);
    go.textContent = s?.used ? 'Replace' : 'Store';
  };
  sel.onchange = show;
  sel.ondblclick = () => dlg.close('store');
  show();
  dlg.returnValue = '';
  return new Promise((done) => {
    dlg.addEventListener('close', () => done(dlg.returnValue === 'store' && sel.value !== '' ? Number(sel.value) : null), { once: true });
    dlg.showModal();
    sel.focus();
    sel.options[sel.selectedIndex]?.scrollIntoView({ block: 'nearest' });
  });
}
