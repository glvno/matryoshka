// @vitest-environment jsdom
// SPDX-License-Identifier: GPL-3.0-only
// The step grid's P-locks (#524, #519 Q11): a dot under a locked step, its list to edit or delete, a row to lock.
import { expect, it } from 'vitest';
import { DEFS } from './modules';
import type { ModuleInst } from './patch';
import { stepGrid, type LockRow } from './step-grid';
import type { StepLock } from './track';

it('a locked step shows a dot; its list edits, removes and adds locks', () => {
  const m: ModuleInst = { id: 3, type: 'steps', x: 0, y: 0, params: { len: 16 }, notes: [{ at: 0, len: 1, note: 60, vel: 100 }], locks: [{ at: 0, module: 7, param: 'cutoff', value: 500 }] };
  const pd = (name: string) => DEFS.filter.params.find((q) => q.name === name)!;
  const rows: LockRow[] = [
    { module: 7, param: 'cutoff', label: 'cutoff', pd: pd('cutoff'), value: 1200 },
    { module: 7, param: 'res', label: 'res', pd: pd('res'), value: 0.2 },
  ];
  const sent: (StepLock[] | undefined)[] = [];
  const g = stepGrid(m, 0, {
    notes: () => {}, begin: () => () => {}, name: () => {}, mute: () => {}, arm: () => {}, armed: () => false, rec: () => {}, recording: () => false, roll: () => {},
    lockRows: () => rows,
    locks: (l) => { sent.push(l); if (l) m.locks = l; else delete m.locks; },
  });
  document.body.append(g.el);
  const cells = g.el.querySelectorAll<HTMLElement>('.step');
  expect(cells[0].classList.contains('locked')).toBe(true);
  expect(cells[1].classList.contains('locked')).toBe(false);
  cells[0].querySelector<HTMLElement>('.lock-dot')!.dispatchEvent(new MouseEvent('pointerdown', { button: 0, bubbles: true }));
  const pop = (): HTMLElement => g.el.querySelector('.lock-pop')!;
  expect(pop().textContent).toContain('step 1');
  const input = pop().querySelector<HTMLInputElement>('.lock-row input')!;
  expect(input.value).toBe('500');
  input.value = '2000';
  input.dispatchEvent(new Event('change'));
  expect(m.locks).toEqual([{ at: 0, module: 7, param: 'cutoff', value: 2000 }]);
  const add = pop().querySelector<HTMLSelectElement>('.lock-add select')!;
  add.value = '0';   // the first free row: res, at its normal value
  add.dispatchEvent(new Event('change'));
  expect(m.locks).toEqual([{ at: 0, module: 7, param: 'cutoff', value: 2000 }, { at: 0, module: 7, param: 'res', value: 0.2 }]);
  pop().querySelector<HTMLButtonElement>('.lock-row button')!.click();
  expect(m.locks).toEqual([{ at: 0, module: 7, param: 'res', value: 0.2 }]);
  // a step without locks: right-click opens its list
  cells[2].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  expect(pop().textContent).toContain('step 3');
  expect(sent.length).toBe(3);
});
