// SPDX-License-Identifier: GPL-3.0-only
// Experimental inspection UI. Its declarations are previews kept only in this panel.
import { capabilitiesOf, previewBypass } from './assembly-capabilities';
import type { AssemblyInst, PortRef } from './assembly';
import { DEFS } from './modules';
import { longName, moduleTitle } from './labels';
import { validatePatch, type Patch } from './patch';
import './capability-inspector.css';

export interface CapabilityInspectorHost { patch(): Patch; load(p: Patch): void }
const examples = import.meta.glob<unknown>('../../docs/capability-examples/*.json', { import: 'default' });
const text = <K extends keyof HTMLElementTagNameMap>(tag: K, value: string): HTMLElementTagNameMap[K] => {
  const el = document.createElement(tag); el.textContent = value; return el;
};

export class CapabilityInspector {
  readonly el = document.createElement('aside');
  private select = document.createElement('select');
  private body = document.createElement('div');
  private previousPatch: Patch | null = null;
  private previousFocus: HTMLElement | null = null;
  private selected = '';
  private summary = '';
  private readonly escape = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && !this.el.hidden && event.target instanceof Node && this.el.contains(event.target)) {
      event.preventDefault(); event.stopImmediatePropagation(); this.close();
    }
  };

  constructor(private host: CapabilityInspectorHost) {
    this.el.className = 'capability-inspector';
    this.el.hidden = true;
    this.el.setAttribute('aria-label', 'Assembly capability inspector');
    const heading = text('header', 'Capabilities · experimental');
    const close = text('button', 'Close'); close.type = 'button'; close.onclick = () => this.close();
    heading.append(close);
    const label = text('label', 'Assembly');
    this.select.setAttribute('aria-label', 'Assembly to inspect');
    this.select.onchange = () => { this.selected = this.select.value; this.summary = ''; this.sync(); };
    label.append(this.select);
    const load = document.createElement('select'); load.setAttribute('aria-label', 'Example patch');
    load.append(new Option('Choose an example…', ''));
    for (const key of Object.keys(examples).sort()) {
      const name = key.split('/').at(-1)!.replace('.json', '').replaceAll('-', ' ');
      load.append(new Option(name, key));
    }
    const button = text('button', 'Load example'); button.type = 'button'; button.disabled = true;
    load.onchange = () => { button.disabled = !load.value; };
    button.onclick = async () => {
      const key = load.value;
      if (!key) return;
      button.disabled = true;
      try { this.host.load(validatePatch(structuredClone(await examples[key]()), DEFS)); this.sync(); }
      catch (error) { this.body.replaceChildren(text('p', `Could not load example: ${String(error)}`)); }
      finally { button.disabled = !load.value; }
    };
    const exampleRow = document.createElement('div'); exampleRow.className = 'capability-examples'; exampleRow.append(load, button);
    this.el.append(heading, text('p', 'Inspect the open patch while editing. This panel does not change routing or play bypass previews.'), label, exampleRow,
      text('small', 'Loading an example opens it in the editor.'), this.body);
    document.body.append(this.el);
    document.addEventListener('keydown', this.escape, true);
  }

  open(): void {
    this.previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.el.hidden = false; this.summary = ''; this.sync(); this.select.focus();
  }
  close(): void { this.el.hidden = true; this.previousFocus?.focus(); }
  dispose(): void { document.removeEventListener('keydown', this.escape, true); this.el.remove(); }
  sync(): void {
    if (this.el.hidden) return;
    const p = this.host.patch();
    if (p !== this.previousPatch) { this.summary = ''; this.previousPatch = p; }
    const assemblies = p.assemblies ?? [];
    const key = JSON.stringify([this.selected, p.modules, p.cables, assemblies]);
    if (key === this.summary) return;
    this.summary = key;
    this.select.replaceChildren(...assemblies.map(a => new Option(`${a.label || a.name} · #${a.id}`, String(a.id))));
    if (!assemblies.some(a => String(a.id) === this.selected)) this.selected = String(assemblies[0]?.id ?? '');
    this.select.value = this.selected;
    this.select.disabled = !assemblies.length;
    this.body.replaceChildren();
    const a = assemblies.find(a => String(a.id) === this.selected);
    if (!a) { this.body.append(text('p', 'No assemblies in this patch. Group modules to inspect their capabilities.')); return; }
    this.render(p, a);
  }

  private render(p: Patch, a: AssemblyInst): void {
    const report = capabilitiesOf(p, a);
    const module = (id: number): string => {
      const m = this.host.patch().modules.find(item => item.id === id);
      return m ? `${moduleTitle(m, DEFS[m.type]?.label ?? m.type)} · #${id}` : `Missing module · #${id}`;
    };
    const port = (r: PortRef): string => {
      const m = this.host.patch().modules.find(item => item.id === r.module);
      const name = r.port === 'lp12' ? 'low pass · 12 dB/octave' : longName(m?.type ?? '', r.port);
      return `${r.label || name} → ${module(r.module)} · ${name} (#${r.module}.${r.port})`;
    };
    const parent = p.assemblies?.find(other => other.children?.includes(a.id));
    this.body.append(text('h3', `${a.label || a.name} · #${a.id}`), text('p', parent ? `Inside ${parent.label || parent.name} · #${parent.id}` : 'Top-level assembly'),
      text('p', 'Recognition coverage: engine and limited audio paths only. Performance recognition for Harmony (Harmonizer), Arp (Arpeggiator) and Steps is not implemented. This does not make those assemblies or their keys routes invalid.'));
    const list = document.createElement('ul');
    if (report.engine) {
      list.append(text('li', 'Engine recognized'));
      for (const input of report.engine.inputs) list.append(text('li', `${port(input.port)} reaches voicing ${input.voicing.map(module).join(', ')}`));
      list.append(text('li', `Audio outputs: ${report.engine.outputs.map(port).join('; ')}`));
      this.body.append(text('p', 'Engine recognition does not prove an audible voice-to-output path.'));
    }
    else list.append(text('li', 'Engine contract requirements not met: an exposed keys input must reach voicing, and an audio output must be exposed.'));
    if (report.audio) {
      list.append(text('li', 'Audio processing recognized'));
      for (const path of report.audio.paths) list.append(text('li', `${port(path.input)} → ${path.modules.map(module).join(' → ')} → ${port(path.output)}`));
    }
    else list.append(text('li', 'Audio-processing contract requirements not met: exposed audio inputs and outputs must all participate in supported paths.'));
    if (!report.engine && !report.audio) list.append(text('li', 'Neither implemented contract is recognized here. The assembly remains editable; performance recognition is not evaluated.'));
    this.body.append(list);
    for (const note of report.diagnostics) this.body.append(text('p', note));
    if (!report.audio) return;
    this.body.append(text('h4', 'Explicit bypass contract · preview'));
    const input = document.createElement('select'), output = document.createElement('select');
    input.setAttribute('aria-label', 'Dry input'); output.setAttribute('aria-label', 'Dry output');
    for (const [i, r] of report.audio.inputs.entries()) input.append(new Option(port(r), String(i)));
    for (const [i, r] of report.audio.outputs.entries()) output.append(new Option(port(r), String(i)));
    const result = document.createElement('p'); result.setAttribute('role', 'status');
    const preview = text('button', 'Validate dry route'); preview.type = 'button';
    preview.onclick = () => {
      // Resolve against the current graph at action time, even if the caller has not notified sync yet.
      const current = this.host.patch();
      const currentAssembly = current === p ? current.assemblies?.find(item => item.id === a.id) : undefined;
      if (!currentAssembly) { this.summary = ''; this.sync(); return; }
      const plan = previewBypass(current, currentAssembly, { input: report.audio!.inputs[Number(input.value)], output: report.audio!.outputs[Number(output.value)] });
      result.textContent = plan.ok
        ? `Valid for existing module bypass: ${port(plan.input)} passes to ${port(plan.output)}. Processing pauses, state and memory stay allocated, and tails are not heard while bypassed. Resuming may reveal retained state. Preview only; audio is unchanged.`
        : plan.reason;
    };
    const clear = () => { result.textContent = ''; }; input.onchange = clear; output.onchange = clear;
    this.body.append(input, output, preview, result);
  }
}
