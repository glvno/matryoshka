// SPDX-License-Identifier: GPL-3.0-only
// @vitest-environment jsdom
// The owner, 2026-11-23: "if i remove the arp from hera 6 and then click the arp button again ... it seems to think there
// are two hera 6s in the patch ... also, the arp button shouldn't have an output port if we're not going to wire it to the
// arpeggiator when one is present." The dock as the owner uses it: the ARP press after a delete, and ARP's jack.
import { describe, expect, it, vi } from 'vitest';
import { arpsOf } from './arp-button';
import { setKind, toggleTargets } from './buttons';
import { Editor, type EditorEvents } from './editor';
import { addModule, connect, type Patch } from './patch';
import { DEFS } from './modules';
import { PRESETS } from './presets';

vi.hoisted(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  g.ResizeObserver ??= class { observe(): void {} unobserve(): void {} disconnect(): void {} };
  if (!(document as unknown as { fonts?: unknown }).fonts) Object.defineProperty(document, 'fonts', { value: { addEventListener() {}, ready: Promise.resolve() } });
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.checkVisibility ??= () => true;
  proto.scrollTo ??= () => {};
  proto.showPopover ??= function (this: HTMLElement) { this.setAttribute('data-open', ''); };
  proto.hidePopover ??= function (this: HTMLElement) { this.removeAttribute('data-open'); };
});

/** the editor on a patch with its dock */
function open(p: Patch): Editor {
  document.body.innerHTML = '<div id="canvas"><div id="canvas-space"><div id="patch-world"><svg id="cables"></svg><div id="modules"></div><svg id="cable-glow"></svg><svg id="patch-preview"></svg></div></div></div><div id="dock"></div>';
  const ev: EditorEvents = { onStructure() {}, onParam() {}, onAtt() {}, onBypass() {}, onRange() {}, onTrack() {}, onTransport() {}, onLayout() {}, onError() {}, onSaveAssembly() {} };
  const editor = new Editor(document.getElementById('canvas')!, p, ev, document.getElementById('dock'));
  editor.rebuild();
  return editor;
}

/** the patch buttons whose jacks the dock shows */
const jacks = (): string[] => [...document.querySelectorAll<HTMLElement>('.dock-button-jacks .dot')].map((d) => d.dataset.port!);

describe('ARP on the dock (owner 2026-11-23)', () => {
  it('Hera 6, Vernon 100, Monolith D: the Arpeggiator deleted, ARP adds it back with no menu, where it was', () => {
    for (const name of ['Hera 6', 'Vernon 100', 'Monolith D']) {
      const editor = open(PRESETS[name]());
      editor.selectOnly([arpsOf(editor.patch)[0].id]);
      expect(editor.removeSelected()).toBe(true);
      const free = document.querySelector<HTMLElement>('.panel-btn.arp-free')!;
      expect(free.title, name).toMatch(new RegExp(`^ARP: nothing on it\\. Click: New arpeggiator for ${name} \\(`));
      free.click();
      expect(document.querySelector('.arp-menu[data-open]'), name).toBeNull();
      const [arp] = arpsOf(editor.patch);
      expect(toggleTargets(editor.patch, 'arp'), name).toEqual([arp.id]);
      expect(editor.patch.cables.filter((c) => c.to.module === arp.id && c.to.port === 'keys')
        .map((c) => editor.patch.modules.find((m) => m.id === c.from.module)!.type), name).toEqual(['harm']);
    }
  });

  it('no jack for ARP while it switches an Arpeggiator; a Gate, Nothing or a cable already on it keeps the jack', () => {
    open(PRESETS['Hera 6']());
    expect(jacks()).toEqual(['fx', 'scl', 'env', 'lfo', 'edit', 'glo']);
    for (const kind of ['gate', 'nothing'] as const) {
      const q = PRESETS['Hera 6']();
      setKind(q, 'arp', kind);
      open(q);
      expect(jacks(), kind).toContain('arp');
    }
    const cabled = PRESETS['Hera 6']();
    const main = cabled.modules.find((m) => m.type === 'fm1')!;
    expect(connect(cabled, DEFS, { module: main.id, port: 'arp' }, { module: addModule(cabled, DEFS.adsr, 0, 0).id, port: 'gate' })).toBe(true);
    open(cabled);
    expect(jacks()).toContain('arp');
  });
});
