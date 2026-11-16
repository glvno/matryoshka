// SPDX-License-Identifier: GPL-3.0-only
// "Which FM-1?" (D-965): Connect FM-1 found several FM-1s and none is remembered, so the user chooses one. One button
// each: its label (the test rig, its name, the end of its serial, or its place) and what else tells it apart.
import { fm1Detail, fm1Label, type Fm1Id } from './fm1-choice';

/** opens the chooser on `dialog` (index.html #fm1-pick) with `first` offered first; the index chosen, or null (Cancel, Esc) */
export function chooseFm1(dialog: HTMLDialogElement, found: Fm1Id[], first: number): Promise<number | null> {
  const list = dialog.querySelector<HTMLElement>('.fm1-pick-list')!;
  list.replaceChildren(...found.map((d, i) => {
    const b = document.createElement('button');
    b.value = String(i);
    b.className = i === first ? 'fm1-pick-item primary' : 'fm1-pick-item';
    const label = document.createElement('strong');
    label.textContent = fm1Label(d);
    const detail = document.createElement('span');
    detail.textContent = fm1Detail(d);
    b.append(label, detail);
    return b;
  }));
  dialog.returnValue = '';
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === '' ? null : Number(dialog.returnValue)), { once: true });
    dialog.showModal();
    list.querySelector<HTMLButtonElement>('.primary')?.focus();
  });
}
