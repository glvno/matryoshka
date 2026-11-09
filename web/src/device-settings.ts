// SPDX-License-Identifier: GPL-3.0-only
import type { DeviceSettings } from './protocol';
interface SettingsDevice { deviceSettings(settings?: Pick<DeviceSettings, 'name' | 'returnLevel'>): Promise<DeviceSettings> }
/** Read before editing, and keep the dialog open on failed reads or writes. */
export async function openDeviceSettings(dialog: HTMLDialogElement, device: SettingsDevice): Promise<void> {
  const name = dialog.querySelector<HTMLInputElement>('#device-name')!;
  const level = dialog.querySelector<HTMLInputElement>('#device-return')!;
  const status = dialog.querySelector<HTMLElement>('#device-settings-status')!;
  const serial = dialog.querySelector<HTMLElement>('#device-serial')!;
  const save = dialog.querySelector<HTMLButtonElement>('#device-settings-save')!;
  const form = dialog.querySelector<HTMLFormElement>('form')!;
  dialog.querySelector<HTMLButtonElement>('#device-settings-close')!.onclick = () => dialog.close();
  const busy = (on: boolean): void => { save.disabled = name.disabled = level.disabled = on; };
  busy(true); name.value = ''; level.value = ''; serial.textContent = '';
  status.textContent = 'Reading the FM-1’s settings…';
  form.onsubmit = (e) => e.preventDefault();
  dialog.showModal();
  try {
    const settings = await device.deviceSettings();
    if (!dialog.open) return;
    name.value = settings.name; level.value = String(settings.returnLevel);
    serial.textContent = /^0+$|^F+$/.test(settings.serial) ? 'Device serial is unavailable.' : `Device serial: ${settings.serial}`;
    status.textContent = ''; busy(false); name.focus();
    form.onsubmit = async (e) => {
      e.preventDefault(); busy(true); status.textContent = 'Saving to the FM-1…';
      try {
        const saved = await device.deviceSettings({ name: name.value, returnLevel: Number(level.value) });
        name.value = saved.name; level.value = String(saved.returnLevel);
        status.textContent = 'Saved. Restart the FM-1 to apply its name. USB return level is ready now.';
      } catch (err) { status.textContent = err instanceof Error ? err.message : String(err); }
      finally { busy(false); }
    };
  } catch (err) { status.textContent = err instanceof Error ? err.message : String(err); }
}
