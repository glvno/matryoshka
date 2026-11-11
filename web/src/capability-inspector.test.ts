// @vitest-environment jsdom
// SPDX-License-Identifier: GPL-3.0-only
import { afterEach, describe, expect, it } from 'vitest';
import { CapabilityInspector } from './capability-inspector';
import { DEFS } from './modules';
import { newPatch, validatePatch } from './patch';

let inspector: CapabilityInspector | undefined;
afterEach(() => { inspector?.dispose(); document.body.replaceChildren(); });
const examples = import.meta.glob<unknown>('../../docs/capability-examples/02-custom-effects.json', { eager: true, import: 'default' });
const fixture = () => validatePatch(structuredClone(Object.values(examples)[0]), DEFS);
describe('experimental capability inspector', () => {
  it('updates after structural edits and patch replacement without editing patch state', () => {
    let p = fixture(); const before = structuredClone(p);
    inspector = new CapabilityInspector({ patch: () => p, load: next => { p = next; } });
    inspector.open();
    const selection = inspector.el.querySelector<HTMLSelectElement>('[aria-label="Assembly to inspect"]')!;
    const a = p.assemblies!.find(a => a.name === 'Two filters')!;
    selection.value = String(a.id); selection.dispatchEvent(new Event('change'));
    expect(inspector.el.textContent).toContain('Audio processing recognized');
    const preview = [...inspector.el.querySelectorAll('button')].find(b => b.textContent === 'Validate dry route')!;
    preview.click();
    expect(inspector.el.textContent).toContain('Valid for existing module bypass');
    expect(p).toEqual(before);
    p.cables = p.cables.filter(c => !(a.modules.includes(c.from.module) && a.modules.includes(c.to.module)));
    inspector.sync();
    expect(inspector.el.textContent).not.toContain('Audio processing recognized');
    expect(inspector.el.textContent).not.toContain('Valid for existing module bypass');
    // Undo restores a snapshot as a new object; keep inspecting the same assembly.
    p = structuredClone(before); inspector.sync();
    expect(selection.value).toBe(String(a.id));
    expect(inspector.el.textContent).toContain('Audio processing recognized');
    expect(inspector.el.textContent).not.toContain('Valid for existing module bypass');
    p = newPatch(DEFS); inspector.sync();
    expect(inspector.el.textContent).toContain('No assemblies in this patch');
  });
  it('revalidates bypass at action time and closes with Escape while restoring focus', () => {
    const p = fixture();
    const opener = document.createElement('button'); document.body.append(opener); opener.focus();
    inspector = new CapabilityInspector({ patch: () => p, load() {} }); inspector.open();
    const a = p.assemblies!.find(a => a.name === 'Two filters')!;
    const selection = inspector.el.querySelector<HTMLSelectElement>('[aria-label="Assembly to inspect"]')!;
    selection.value = String(a.id); selection.dispatchEvent(new Event('change'));
    p.cables = p.cables.filter(c => !(a.modules.includes(c.from.module) && a.modules.includes(c.to.module)));
    [...inspector.el.querySelectorAll('button')].find(b => b.textContent === 'Validate dry route')!.click();
    expect(inspector.el.textContent).not.toContain('Valid for existing module bypass');
    selection.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(inspector.el.hidden).toBe(true); expect(document.activeElement).toBe(opener);
  });
});
