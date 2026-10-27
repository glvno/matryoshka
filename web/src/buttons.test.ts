import { describe, expect, it } from 'vitest';
import { bypassAssembly, makeAssembly } from './assembly';
import { buttonLight, kindOf, pageList, setKind, setPages, switches, toggleEngaged, toggleTargets } from './buttons';
import { devicesOf } from './pages';
import { Engine } from './engine';
import { DEFS, PANEL_BUTTONS } from './modules';
import { addModule, connect, emptyPatch, newPatch, validatePatch, type Patch } from './patch';
import { FLAG_BUTTONS, formatOf, binaryPage, encodePatch } from './patchbin';

/** Main, an oscillator into a VCA into the Output: the VCA has nothing in cv (closed), bypassed it lets the oscillator through */
function rig(): { p: Patch; main: number; osc: number; vca: number } {
  const p = emptyPatch('t');
  const main = addModule(p, DEFS.fm1, 0, 0);
  const osc = addModule(p, DEFS.osc, 200, 0);
  const vca = addModule(p, DEFS.vca, 400, 0);
  const out = addModule(p, DEFS.output, 600, 0);
  connect(p, DEFS, { module: main.id, port: 'pitch' }, { module: osc.id, port: 'pitch' });
  connect(p, DEFS, { module: osc.id, port: 'out' }, { module: vca.id, port: 'in' });
  connect(p, DEFS, { module: vca.id, port: 'out' }, { module: out.id, port: 'l' });
  return { p, main: main.id, osc: osc.id, vca: vca.id };
}

const peak = (e: Engine): number => {
  const l = new Float32Array(2048), r = new Float32Array(2048);
  e.render(l, r);
  return l.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
};

describe('patch button kinds (#116)', () => {
  it('an old patch\'s buttons are Gates, a new patch\'s start as Nothing (GLO aside)', () => {
    const old = validatePatch(JSON.parse(JSON.stringify(rig().p)), DEFS);
    expect(PANEL_BUTTONS.map((b) => kindOf(old.modules[0].panel, b))).toEqual(PANEL_BUTTONS.map(() => 'gate'));
    const fresh = newPatch(DEFS);
    const panel = fresh.modules.find((m) => m.type === 'fm1')!.panel;
    expect(PANEL_BUTTONS.map((b) => kindOf(panel, b))).toEqual(['nothing', 'nothing', 'nothing', 'nothing', 'nothing', 'gate', 'nothing']);
  });

  it('validates kinds and targets: unknown kinds go, a button that does nothing never switches, a gone target is dropped', () => {
    const { p, vca } = rig();
    p.modules[0].panel = { toggle: ['fx', 'edit'], on: ['edit'], kinds: { fx: 'nothing', edit: 'bypass', env: 'bogus' as never }, targets: { edit: { module: vca }, lfo: { module: vca }, arp: { asm: 99 } } };
    const v = validatePatch(JSON.parse(JSON.stringify(p)), DEFS).modules[0].panel!;
    expect(v.kinds).toEqual({ fx: 'nothing', edit: 'bypass' });
    expect(v.targets).toEqual({ edit: { module: vca } });
    expect(v.toggle).toEqual(['edit']);
    expect(switches(v, 'fx')).toBe(false);
    const gone = JSON.parse(JSON.stringify(p));
    gone.modules = gone.modules.filter((m: { id: number }) => m.id !== vca);
    gone.cables = gone.cables.filter((c: { from: { module: number }; to: { module: number } }) => c.from.module !== vca && c.to.module !== vca);
    expect(validatePatch(gone, DEFS).modules[0].panel!.targets).toBeUndefined();
  });

  it('a Toggle on an assembly moves the members its own switch moves, never one bypassed on its own', () => {
    const { p, osc, vca } = rig();
    const a = makeAssembly(p, [osc, vca], 'voice');
    p.modules.find((m) => m.id === osc)!.bypass = true;               // bypassed on its own
    p.modules[0].panel = { kinds: { fx: 'bypass' }, targets: { fx: { asm: a.id } } };
    expect(toggleTargets(p, 'fx')).toEqual([vca]);
    expect(toggleEngaged(p, 'fx')).toBe(false);
    bypassAssembly(p, a, true);
    expect(toggleTargets(p, 'fx')).toEqual([vca]);                      // (the oscillator is the assembly's kept one)
    expect(toggleEngaged(p, 'fx')).toBe(true);
    expect(toggleTargets(p, 'edit')).toEqual([]);                        // a Gate has none
  });

  it('lights: dark unassigned and uncabled, dim assigned or cabled, lit engaged', () => {
    const { p, main, vca } = rig();
    p.modules[0].panel = { kinds: { fx: 'nothing', edit: 'nothing' } };
    connect(p, DEFS, { module: main, port: 'edit' }, { module: vca, port: 'cv' });
    expect(buttonLight(p, 'fx', false)).toBe('dark');
    expect(buttonLight(p, 'edit', false)).toBe('dim');
    expect(buttonLight(p, 'env', false)).toBe('dim');
    expect(buttonLight(p, 'fx', true)).toBe('lit');
  });

  it('encodes the kinds section only when a button is not a Gate; a switching Toggle is on while its target is bypassed', () => {
    const { p, vca } = rig();
    const flags = (b: Uint8Array): number => b[6] | (b[7] << 8);
    expect(flags(encodePatch(p)) & FLAG_BUTTONS).toBe(0);
    p.modules[0].panel = { toggle: ['arp'], kinds: { fx: 'nothing', arp: 'bypass' }, targets: { arp: { module: vca } } };
    p.modules.find((m) => m.id === vca)!.bypass = true;
    const b = encodePatch(p);
    expect(b[1]).toBe(formatOf(p));
    expect(flags(b) & FLAG_BUTTONS).toBe(FLAG_BUTTONS);
    // the section is the last one here (no ranges): seven kinds, then ARP's target list
    const tail = Array.from(b.slice(b.length - 9));
    expect(tail).toEqual([1, 0, 0, 0, 0, 0, 2, 1, p.modules.findIndex((m) => m.id === vca)]);
    const at = 8;                                                       // (no poly groups) the panel section's masks
    expect(b[at] | (b[at + 1] << 8)).toBe(1 << 6);
    expect(b[at + 2] | (b[at + 3] << 8)).toBe(1 << 6);
  });

  it('the engine: a Toggle bypasses its module while on; a switching one follows a bypass made elsewhere', () => {
    const { p, vca } = rig();
    p.modules[0].panel = { toggle: ['arp'], kinds: { fx: 'bypass', arp: 'bypass' }, targets: { fx: { module: vca }, arp: { module: vca } } };
    const e = new Engine(48000);
    e.load(p);
    e.noteOn(60, 1);
    expect(peak(e)).toBeLessThan(1e-4);                                 // the VCA is closed
    e.setButton(0, true);                                               // FX held: bypassed
    expect(peak(e)).toBeGreaterThan(0.1);
    expect(e.buttonMask & 1).toBe(1);
    e.setButton(0, false);
    expect(peak(e)).toBeLessThan(1e-3);
    e.setBypass(vca, true);                                             // a card's ⏻: ARP (switching) is on with it
    expect((e.buttonMask >> 6) & 1).toBe(1);
    e.setBypass(vca, false);
    expect((e.buttonMask >> 6) & 1).toBe(0);
  });

  it('Page buttons: a list of device pages, gone pages left out, encoded as the binary\'s (device, page) pairs; no PRESS', () => {
    const { p, osc, vca } = rig();
    setKind(p, 'edit', 'page');
    setPages(p, 'edit', [{ device: `m${vca}`, page: 0 }, { device: 'm999', page: 0 }, { device: `m${osc}`, page: 1 }]);
    const devs = devicesOf(p, DEFS);
    expect(pageList(p, 'edit', devs)).toEqual([{ device: `m${vca}`, page: 0 }, { device: `m${osc}`, page: 1 }]);
    p.modules[0].panel!.toggle = ['edit'];
    expect(switches(p.modules[0].panel, 'edit')).toBe(false);
    const v = validatePatch(JSON.parse(JSON.stringify(p)), DEFS).modules[0].panel!;
    expect(v.kinds?.edit).toBe('page');
    expect(v.toggle).toBeUndefined();
    const b = encodePatch(p);
    const pairs = [binaryPage(p, `m${vca}`, 0)!, binaryPage(p, `m${osc}`, 1)!];
    expect(Array.from(b.slice(b.length - 12))).toEqual([0, 0, 0, 0, 3, 0, 0, 2, ...pairs.flat()]);
    setKind(p, 'edit', 'gate');
    expect(p.modules[0].panel?.pages).toBeUndefined();
  });
});
