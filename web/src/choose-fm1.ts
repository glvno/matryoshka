// SPDX-License-Identifier: GPL-3.0-only
// Connect FM-1 with more than one FM-1 on the computer (#698): a dialog lists each one that answered, with its firmware
// and its port, and Connect links the one chosen. This browser remembers the choice, so the next Connect takes the same
// FM-1 without asking; Reconnect asks again. One FM-1 connects as before, with no dialog.
import type { FoundFm1 } from './device';
import type { Info } from './protocol';

/** where this browser keeps the chosen FM-1: its MIDI input's id (stable for a device at a USB socket on macOS) */
export const FM1_CHOICE = 'matryoshka.fm1-choice';

/** the firmware as the list shows it: "Matryoshka 1.10.0", "a dev build", "Matryoshka before 1.8" */
export function firmwareText(info: Info): string {
  const f = info.firmware;
  if (!f) return 'Matryoshka before 1.8';
  return f.major || f.minor || f.patch ? `Matryoshka ${f.major}.${f.minor}.${f.patch}` : 'Matryoshka, a dev build';
}

/** one FM-1 in the list: `1  Matryoshka 1.10.0 · port Matryoshka · test rig` */
export const fm1Text = (f: Pick<FoundFm1, 'info' | 'rig'> & { inp: { name?: string | null } }, i: number): string =>
  `${i + 1}  ${firmwareText(f.info)} · port ${f.inp.name || '(no name)'}${f.rig ? ' · test rig' : ''}`;

/** the remembered FM-1 among those that answered, or null */
export const rememberedFm1 = <T extends { inp: { id: string } }>(found: readonly T[], kept: string | null): T | null =>
  (kept && found.find((f) => f.inp.id === kept)) || null;

/** the one offered first: the remembered one, else the first that is not the test rig, else the first */
export const offeredFm1 = <T extends { inp: { id: string }; rig: boolean }>(found: readonly T[], kept: string | null): number => {
  const k = rememberedFm1(found, kept);
  if (k) return found.indexOf(k);
  const own = found.findIndex((f) => !f.rig);
  return own >= 0 ? own : 0;
};

export function readChoice(): string | null {
  try {
    return localStorage.getItem(FM1_CHOICE);
  } catch {
    return null;   // (storage blocked: Connect asks each time)
  }
}
export function keepChoice(id: string): void {
  try {
    localStorage.setItem(FM1_CHOICE, id);
  } catch {
    /* storage blocked: the choice lasts until the page is reloaded */
  }
}

/** Play a note: middle C on `out` now, its release 400 ms later by the page's timer, with no Web MIDI timestamp. The FM-1
 *  plays it with its current patch, so a patch where middle C sounds nothing (a drum patch's white keys, a patch no keys
 *  reach) or MASTER down is silent. On the test rig the dialog's note sounded 37 to 88 ms after the click (#698) */
export function playNote(out: Pick<MIDIOutput, 'send'>, later: (f: () => void, ms: number) => unknown = (f, ms) => setTimeout(f, ms)): void {
  out.send([0x90, 60, 100]);
  later(() => out.send([0x80, 60, 0]), 400);
}

/** ask which FM-1 to connect; null on Cancel. `dlg` is index.html's #choose-fm1. Play a note sends middle C to the one
 *  selected, so two FM-1s on the same firmware can be told apart by ear */
export function chooseFm1(dlg: HTMLDialogElement, found: readonly FoundFm1[], kept: string | null): Promise<FoundFm1 | null> {
  const sel = dlg.querySelector<HTMLSelectElement>('#choose-fm1-list')!;
  dlg.querySelector<HTMLElement>('#choose-fm1-text')!.textContent =
    `${found.length} FM-1s answered. Choose the one this page works with; this browser remembers it, and Reconnect asks again.`;
  sel.replaceChildren(...found.map((f, i) => Object.assign(document.createElement('option'), { value: String(i), textContent: fm1Text(f, i) })));
  sel.size = Math.min(8, Math.max(2, found.length));
  sel.value = String(offeredFm1(found, kept));
  sel.ondblclick = () => dlg.close('connect');
  dlg.querySelector<HTMLButtonElement>('#choose-fm1-play')!.onclick = (e) => {
    e.preventDefault();
    const out = found[Number(sel.value)]?.out;
    if (out) playNote(out);
  };
  dlg.returnValue = '';
  return new Promise((done) => {
    dlg.addEventListener('close', () => done(dlg.returnValue === 'connect' && sel.value !== '' ? found[Number(sel.value)] ?? null : null), { once: true });
    dlg.showModal();
    sel.focus();
  });
}
