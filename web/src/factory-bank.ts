// SPDX-License-Identifier: GPL-3.0-only
// Hardware-derived candidates; editor examples live separately in factory/examples.json.
import SOURCE from '../factory/bank.json';
import AUDIT from '../factory/fx-audit.json';
import { kindOf, setKind, setPages, setSwitches, setTarget, switches } from './buttons';
import { fxBusOf, withFxBus, type FxStageKind } from './fx-bus';
import { sharedFilterFactory } from './factory-paraphony';
import { sharedCassiaContours } from './factory-cassia-sharing';
import { sharedAlgoContours } from './factory-algo-sharing';
import { sharedArticulationFactory } from './factory-shared-articulation';
import { fitCanvasFactory } from './factory-canvas-fit';
import { DEFS } from './modules';
import { devicesOf } from './pages';
import { addModule, connect, disconnect, removeModule, type Patch } from './patch';

/** Original card bindings, including selectors controlling an existing effect. Row indices are zero-based. */
export const factoryFxAudit = AUDIT;
export const melodicFactoryNames = AUDIT.map(entry => entry.name);
export const factoryFile = (index: number, name: string): string => `${String(index).padStart(2, '0')}-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}.json`;

export interface FactoryCandidate { name: string; patch: Patch }
export interface FactoryMeasurementOptions {
  voices?: number;
  omit?: readonly FxStageKind[];
  paraphony?: 'shared-filter' | 'shared-articulation' | 'shared-contours' | 'shared-operator4';
  harmonizer?: 'removed';
  bankName?: string;
  canvasCaptions?: 'short';
}
export type FactoryMeasurementProfile = Readonly<Record<string, FactoryMeasurementOptions>>;

export interface SelectedFactoryOptions extends FactoryMeasurementOptions {
  configurationId: string;
  /** Owner-approved final Output that brings the patch as it is onto the factory loudness rule (#448, levels.ts): a pure
   * gain after everything, which moves every preset of the patch by the same factor. Melodic selections only. */
  outputLevel?: number;
}

/** Owner-approved factory selections.
 * Omissions apply only to added FX; intrinsic effects and original DSP remain.
 * Configuration IDs identify evidence, never runtime FX recognition.
 */
export const selectedFactoryProfile: Readonly<Record<string, SelectedFactoryOptions>> = {
  'Monolith D': { configurationId: 'selected-monolith-d' },
  'Silver Box': { configurationId: 'selected-silver-box' },
  'Algo Four': { voices: 4, omit: ['chorus'], configurationId: 'algo-four-v4-drive-delay-reverb', outputLevel: 0.88 },
  'Oracle V': { omit: ['delay', 'reverb'], configurationId: 'selected-oracle-v' },
  Canvas: { omit: ['drive', 'chorus', 'reverb'], harmonizer: 'removed', canvasCaptions: 'short', configurationId: 'canvas-original-delay-no-harm' },
  'Expander S': { voices: 3, configurationId: 'expander-s-v3-drive-chorus-delay-reverb', outputLevel: 0.68 },
  'Briefcase 3': { harmonizer: 'removed', configurationId: 'briefcase-3-original-drive-chorus-delay-no-harm' },
  Wanderer: { omit: ['chorus'], configurationId: 'selected-wanderer' },
  'Cassia 1': { omit: ['reverb'], configurationId: 'selected-cassia-1' },
  'Vernon 100': { omit: ['reverb'], configurationId: 'selected-vernon-100' },
  'Sallen 20': { omit: ['reverb'], harmonizer: 'removed', configurationId: 'sallen-20-original-drive-chorus-delay-no-harm' },
  'Hera 4': { bankName: 'Hera 3', voices: 3, omit: ['drive', 'chorus', 'delay', 'reverb'], configurationId: 'hera-4-v3-none', outputLevel: 0.47 },
  'Io 4': { omit: ['reverb'], configurationId: 'selected-io-4' },
};

/** Selected names in source order, without building the patch graphs. */
export const selectedFactoryNames = SOURCE.map(({ name }) => selectedFactoryProfile[name]?.bankName ?? name);

/** The approved bank shared by browser defaults, numeric exports and firmware. */
export function buildSelectedFactoryBank(): FactoryCandidate[] {
  const measurements = Object.fromEntries(Object.entries(selectedFactoryProfile).map(([name, { configurationId: _id, outputLevel: _level, ...options }]) => [name, options]));
  const bank = buildFactoryBank(measurements);
  for (const [sourceName, options] of Object.entries(selectedFactoryProfile)) {
    if (options.outputLevel === undefined) continue;
    if (!AUDIT.some(entry => entry.name === sourceName)) throw new Error(`${sourceName}: protected drums/drones keep their source Output`);
    if (!Number.isFinite(options.outputLevel) || options.outputLevel <= 0 || options.outputLevel > 1)
      throw new Error(`${sourceName}: selected Output must be within the Output's range`);
    const patch = bank.find(entry => entry.name === (options.bankName ?? sourceName))!.patch;
    patch.modules.find(module => module.type === 'output')!.params.level = options.outputLevel;
  }
  return bank;
}

/** Explicit measurement reductions only; the unselected bank retains every original allocation and interface. */
function reduceVoices(p: Patch, voices: number, minimum: number): void {
  const poly = p.modules.filter(m => m.type === 'alloc' && m.params.voices > 1);
  if (!Number.isInteger(voices) || voices < minimum || !poly.length || poly.some(m => voices > m.params.voices)) {
    throw new Error(`${p.name}: voices must be an integer from ${minimum} through each original polyphonic allocation`);
  }
  for (const m of poly) {
    m.params.voices = voices;
    for (const a of p.assemblies ?? []) {
      for (const row of a.params) {
        if (row.module === m.id && row.param === 'voices') row.top = Math.min(row.top ?? voices, voices);
      }
    }
  }
}

/** Remove the mono chord player without removing Steps, Arp or their key path. */
function removeHarmony(p: Patch): void {
  for (const harm of p.modules.filter(m => m.type === 'harm')) {
    const inputs = p.cables.filter(c => c.to.module === harm.id);
    const outputs = p.cables.filter(c => c.from.module === harm.id);
    if (inputs.length !== 1 || inputs[0].to.port !== 'keys' || outputs.some(c => c.from.port !== 'keys' || c.to.port !== 'keys')) {
      throw new Error(`${p.name}: unsupported Harmony keys route`);
    }
    const from = { ...inputs[0].from }, destinations = outputs.map(c => ({ ...c.to }));
    for (const m of p.modules) {
      const panel = m.panel;
      if (!panel) continue;
      for (const [key, target] of Object.entries(panel.targets ?? {})) if ('module' in target && target.module === harm.id) {
        panel.toggle = panel.toggle?.filter(k => k !== key);
        panel.on = panel.on?.filter(k => k !== key);
        delete panel.targets?.[key];
        if (panel.kinds) panel.kinds[key] = 'nothing';
        delete panel.labels?.[key];
        delete panel.pages?.[key];
      }
    }
    removeModule(p, harm.id);
    for (const to of destinations) if (!connect(p, DEFS, from, to)) throw new Error(`${p.name}: cannot reconnect Harmony keys`);
  }
}

/** Build unqualified candidates, optionally reducing polyphony or omitting additional new FX for measurement. */
export function buildFactoryBank(profile: FactoryMeasurementProfile = {}): FactoryCandidate[] {
  for (const name of Object.keys(profile)) {
    if (!SOURCE.some(entry => entry.name === name)) throw new Error(`Unknown factory candidate: ${name}`);
    if (profile[name].omit?.some(kind => !['drive', 'chorus', 'delay', 'reverb'].includes(kind))) {
      throw new Error(`${name}: unknown omitted FX stage`);
    }
  }
  const names = SOURCE.map(entry => profile[entry.name]?.bankName ?? entry.name);
  if (names.some(name => !name.trim()) || new Set(names).size !== names.length) throw new Error('Factory bank names must be nonempty and unique');
  return SOURCE.map(({ name, patch }: { name: string; patch: unknown }) => {
    let p = name === 'Canvas' ? fitCanvasFactory(patch as Patch) : structuredClone(patch) as Patch;
    const audit = AUDIT.find(entry => entry.name === name);
    const options = profile[name];
    if (!audit && options && Object.keys(options).length) {
      throw new Error(`${name}: protected drums/drones cannot use a measurement profile`);
    }
    if (options?.harmonizer && (!audit || audit.voices.length !== 1 || audit.voices[0].voices !== 1)) {
      throw new Error(`${name}: Harmony removal is limited to originally monophonic instruments`);
    }
    if (options?.canvasCaptions && name !== 'Canvas') throw new Error(`${name}: Canvas captions require Canvas`);
    if (options?.voices !== undefined) reduceVoices(p, options.voices, name === 'Expander S' ? 1 : 3);
    // Protected drums/drones never pass through validation, FX, player or button rewriting.
    if (!audit) return { name, patch: p };
    if (options?.paraphony === 'shared-filter') p = sharedFilterFactory(p);
    else if (options?.paraphony === 'shared-articulation') p = sharedArticulationFactory(p);
    else if (options?.paraphony === 'shared-contours' && name === 'Cassia 1') p = sharedCassiaContours(p);
    else if (options?.paraphony === 'shared-contours' && name === 'Algo Four') p = sharedAlgoContours(p);
    else if (options?.paraphony === 'shared-operator4' && name === 'Algo Four') p = sharedAlgoContours(p, '4');
    else if (options?.paraphony) throw new Error(`${name}: unsupported sharing trial ${options.paraphony}`);
    const main = p.modules.find(m => m.type === 'fm1')!;
    const arp = p.modules.find(m => m.type === 'arp')!;
    let harmony = p.modules.find(m => m.type === 'harm');
    if (!harmony) {
      const feed = p.cables.find(c => c.to.module === arp.id && c.to.port === 'keys')!;
      let track = p.modules.find(m => m.id === feed.from.module && m.type === 'steps');
      if (!track) {
        track = addModule(p, DEFS.steps, 20, Math.max(...p.modules.map(m => m.y)) + 300);
        track.name = 'PATTERN';
        track.notes = [];
        disconnect(p, feed);
        connect(p, DEFS, feed.from, { module: track.id, port: 'keys' });
      } else {
        disconnect(p, feed);
      }
      harmony = addModule(p, DEFS.harm, track.x + 380, track.y);
      harmony.params.type = 0;
      connect(p, DEFS, { module: track.id, port: 'keys' }, { module: harmony.id, port: 'keys' });
      connect(p, DEFS, { module: harmony.id, port: 'keys' }, { module: arp.id, port: 'keys' });
    }
    harmony.bypass = true;
    arp.bypass = true;
    // Harmony vacates the prototype's EDIT binding.
    const editTarget = main.panel?.targets?.edit;
    if (editTarget && 'module' in editTarget && editTarget.module === harmony.id) {
      setKind(p, 'edit', 'nothing');
      delete main.panel!.labels?.edit;
    }
    setKind(p, 'arp', 'bypass');
    setTarget(p, 'arp', { module: arp.id });
    setSwitches(p, 'arp', true);
    setKind(p, 'lfo', 'bypass');
    setTarget(p, 'lfo', { module: harmony.id });
    setSwitches(p, 'lfo', true);
    main.panel!.labels = { ...main.panel?.labels, lfo: 'BYP HARM' };
    // Preserve Sallen's SWITCH and Canvas's PULSER gate on EDIT; FX always opens the bus.
    const fxCables = p.cables.filter(c => c.from.module === main.id && c.from.port === 'fx');
    if (fxCables.length) {
      setKind(p, 'edit', kindOf(main.panel, 'fx'));
      setSwitches(p, 'edit', switches(main.panel, 'fx'));
      if (main.panel?.on?.includes('fx')) main.panel.on.push('edit');
      main.panel!.labels!.edit = main.panel?.labels?.fx ?? 'PULSER';
      delete main.panel!.labels!.fx;
      for (const cable of fxCables) cable.from.port = 'edit';
    }
    p = withFxBus(p, { omit: [...new Set([...(audit.omit as FxStageKind[]), ...(options?.omit ?? [])])] });
    const bus = fxBusOf(p);
    if (bus) {
      const device = devicesOf(p, DEFS).find(d => d.asm === bus.assembly)!;
      setKind(p, 'fx', 'page');
      setPages(p, 'fx', device.pages.map((_, page) => ({ device: device.key, page })));
    }
    if (options?.harmonizer === 'removed') removeHarmony(p);
    if (options?.canvasCaptions) p = fitCanvasFactory(p, options.canvasCaptions);
    if (options?.bankName) {
      p.name = options.bankName;
      for (const a of p.assemblies ?? []) if (a.label === name) a.label = options.bankName;
    }
    return { name: options?.bankName ?? name, patch: p };
  });
}
