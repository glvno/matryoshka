// SPDX-License-Identifier: GPL-3.0-only
// The FM-1's master EQ from the editor (#1107): GLO › EQ's LOW, MID, HIGH and MID FREQ over the link (MASTER_EQ). A setting
// of the FM-1, not of a patch: it shapes the FM-1's speaker and headphone output for every patch, and the browser's own
// sound is left alone. Read when the dialog opens; each change plays on the FM-1 at once, which keeps it as from its menu.
import { MASTER_EQ_DB, MASTER_EQ_FREQS, masterEqHz, type MasterEq } from './protocol';

interface EqDevice { masterEq(eq?: MasterEq): Promise<MasterEq> }

/** MID FREQ as the FM-1 shows it: 250 Hz, 1.0 kHz */
export const masterEqFreqText = (i: number): string => {
  const hz = Math.round(masterEqHz(i));
  return hz < 1000 ? `${hz} Hz` : `${(Math.round(hz / 100) / 10).toFixed(1)} kHz`;
};
/** a gain as the FM-1 shows it: 0 dB, +1.5 dB, −12.0 dB */
export const masterEqGainText = (db: number): string => (db ? `${db > 0 ? '+' : '−'}${Math.abs(db).toFixed(1)} dB` : '0 dB');

export async function openMasterEq(dialog: HTMLDialogElement, device: EqDevice): Promise<void> {
  const gains = (['low', 'mid', 'high'] as const).map((k) => dialog.querySelector<HTMLInputElement>(`#meq-${k}`)!);
  const freq = dialog.querySelector<HTMLInputElement>('#meq-freq')!;
  const status = dialog.querySelector<HTMLElement>('#meq-status')!;
  const flat = dialog.querySelector<HTMLButtonElement>('#meq-flat')!;
  const inputs = [...gains, freq];
  const show = (): void => {
    gains.forEach((g) => { g.nextElementSibling!.textContent = masterEqGainText(Number(g.value)); });
    freq.nextElementSibling!.textContent = masterEqFreqText(Number(freq.value));
  };
  const set = (eq: MasterEq): void => {
    [eq.low, eq.mid, eq.high].forEach((db, i) => { gains[i].value = String(db); });
    freq.value = String(eq.freq);
    show();
  };
  for (const g of gains) Object.assign(g, { min: String(-MASTER_EQ_DB), max: String(MASTER_EQ_DB), step: '0.5' });
  Object.assign(freq, { min: '0', max: String(MASTER_EQ_FREQS - 1), step: '1' });
  dialog.querySelector<HTMLButtonElement>('#meq-close')!.onclick = () => dialog.close();
  const busy = (on: boolean): void => { for (const x of [...inputs, flat]) x.disabled = on; };
  busy(true);
  status.textContent = 'Reading the FM-1’s master EQ…';
  dialog.showModal();
  let sending: Promise<void> = Promise.resolve();
  let due: MasterEq | null = null;
  // one change at a time on the link; a drag sends its latest value once the one before is answered
  const send = (): void => {
    due = { low: Number(gains[0].value), mid: Number(gains[1].value), high: Number(gains[2].value), freq: Number(freq.value) };
    sending = sending.then(async () => {
      const eq = due;
      if (!eq) return;
      due = null;
      try {
        await device.masterEq(eq);
        status.textContent = '';
      } catch (err) { status.textContent = err instanceof Error ? err.message : String(err); }
    });
  };
  try {
    set(await device.masterEq());
    if (!dialog.open) return;
    status.textContent = '';
    busy(false);
    for (const x of inputs) x.oninput = () => { show(); send(); };
    flat.onclick = () => { set({ low: 0, mid: 0, high: 0, freq: Number(freq.value) }); send(); };
  } catch (err) { status.textContent = err instanceof Error ? err.message : String(err); }
}
