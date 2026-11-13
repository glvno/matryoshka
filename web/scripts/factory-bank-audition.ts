// SPDX-License-Identifier: GPL-3.0-only
// Explicit audition export only. No production/default promotion, firmware or device access.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import SOURCE from '../factory/bank.json';
import { buildSelectedFactoryBank, factoryFile, factoryFxAudit, selectedFactoryProfile } from '../src/factory-bank';
import {
  FACTORY_QUALIFICATION_SCOPE, factoryQualificationPhaseIds, factoryQualificationPolicy,
  factoryQualificationTargetSeconds, validateFactoryQualification,
  type ExpectedFactoryQualificationCase, type FactoryQualificationContext,
} from '../src/factory-bank-qualification';
import { fxBusOf } from '../src/fx-bus';
import { backupFile } from '../src/migrate';
import { DEVICE, deviceBudget, encodePatch } from '../src/patchbin';
import '../src/factory-presets';
import { presetsOf, PRESET_NAME_MAX, type Preset } from '../src/device-presets';
import { devicesOf } from '../src/pages';
import { DEFS } from '../src/modules';
import { devicePresetName } from '../src/protocol';
import { FX_PRESET_KINDS, fxPresetInfo } from '../src/fx-preset-format';
import { FACTORY_FX_RECIPES, type FxRecipe } from '../src/factory-fx-recipes';
import { LOFI_PRESET_DESIGNS } from '../src/factory-lofi-presets';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const USAGE = `cd web && npx vite-node scripts/prototype-fm1-bank.ts [qualification.json]
  [--output ../build/release-audition-bank] [--cases prepared/cases.json] [--firmware package.bin]

Use the preparation and hardware runners archived with the exact measurement proof.
Those temporary producers are not a supported public CLI. This exporter never accesses a device.

Without evidence: exports an explicitly unqualified curated audition bank.
With evidence: --cases and --firmware are required. Evidence schemaVersion=1 and
scope=${FACTORY_QUALIFICATION_SCOPE}; exact bank/engine/firmware hashes and every
selected default patch/native/phase hash are required. Legacy allPassed flags are not evidence.
Prepared cases use originalName, selectedPatchName, variantId, sourceSha256 (canonical
JSON.stringify(defaultPatch)), defaultJson, phases[{id,binaryPath,sha256,targetSeconds,...}].
Normalized phase measurements: {id,nativeSha256,peakPercent,mute,shed,late,seconds,
targetSeconds,completed:true,sampleStatus:'complete'}. seconds is actual held duration,
not requested sleep time. Complete matrices and >=5s holds are mandatory, with >=60s
holds for configured worst-case exception phases. Physical proof requires its source hash
and matching firmware identity; older proof also needs its original same-firmware binding.
Owner listening is pending; this command never grants release qualification or overwrites the old listening package.`;

export interface AuditionExportOptions {
  output?: string;
  evidence?: string;
  cases?: string;
  firmware?: string;
  created?: Date;
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
function document(path: string) {
  const bytes = readFileSync(path);
  return { sha256: sha256(bytes), data: JSON.parse(bytes.toString('utf8')) };
}

interface PreparedPhase {
  id: string;
  binaryPath: string;
  sha256: string;
  targetSeconds: number;
  uploadable: boolean;
  allocationRule: number;
  budgetBytes: number;
  memoryFits: boolean;
}
interface PreparedCase {
  originalName: string;
  selectedPatchName: string;
  variantId: string;
  sourceSha256: string;
  defaultJson: string;
  defaultNativeSha256: string;
  defaultNativePath: string;
  phases: PreparedPhase[];
}

function preparedCases(
  path: string,
  identities: readonly ExpectedFactoryQualificationCase[],
  hashes: Pick<FactoryQualificationContext, 'bankSha256' | 'engineSha256' | 'firmwarePackageSha256'>,
) {
  const input = document(path);
  const prepared = input.data as {
    schemaVersion?: number; scope?: string; bankSha256?: string; engineSha256?: string;
    firmwarePackageSha256?: string; cases?: PreparedCase[];
  };
  if (prepared.schemaVersion !== 1 || prepared.scope !== FACTORY_QUALIFICATION_SCOPE
    || prepared.bankSha256 !== hashes.bankSha256 || prepared.engineSha256 !== hashes.engineSha256
    || hashes.firmwarePackageSha256 !== null && prepared.firmwarePackageSha256 !== hashes.firmwarePackageSha256)
    throw new Error('Preparation scope, bank, engine or firmware identity is absent or stale');
  if (!Array.isArray(prepared.cases) || prepared.cases.length !== identities.length)
    throw new Error('Preparation must cover exactly all selected melodic profiles');
  if (new Set(prepared.cases.map(entry => entry.originalName)).size !== identities.length)
    throw new Error('Preparation contains duplicate or missing sources');
  const cases = identities.map(identity => {
    const entry = prepared.cases!.find(candidate => candidate.originalName === identity.sourceName);
    if (!entry || entry.variantId !== identity.configurationId || entry.selectedPatchName !== identity.bankName
      || entry.sourceSha256 !== identity.defaultPatchSha256 || typeof entry.defaultJson !== 'string'
      || entry.defaultNativeSha256 !== identity.defaultNativeSha256 || typeof entry.defaultNativePath !== 'string')
      throw new Error(`${identity.sourceName}: stale or out-of-scope preparation`);
    const defaultPatch = document(resolve(dirname(path), entry.defaultJson)).data;
    if (sha256(JSON.stringify(defaultPatch)) !== identity.defaultPatchSha256)
      throw new Error(`${identity.sourceName}: preparation default patch differs from exported bank`);
    if (sha256(readFileSync(resolve(dirname(path), entry.defaultNativePath))) !== identity.defaultNativeSha256)
      throw new Error(`${identity.sourceName}: preparation default native payload differs from exported bank`);
    const required = factoryQualificationPhaseIds(identity.harmonizerPresent, identity.addedDrivePresent);
    if (!Array.isArray(entry.phases) || entry.phases.length !== required.length
      || new Set(entry.phases.map(phase => phase.id)).size !== required.length
      || required.some(id => !entry.phases.some(phase => phase.id === id)))
      throw new Error(`${identity.sourceName}: preparation is missing the complete phase matrix`);
    const phases = entry.phases.map(phase => {
      const bytes = readFileSync(resolve(dirname(path), phase.binaryPath));
      if (sha256(bytes) !== phase.sha256 || !/^[0-9a-f]{64}$/.test(phase.sha256)
        || bytes[0] !== 0xa1 || bytes[1] !== 55 || bytes.length > DEVICE.bytes
        || phase.uploadable !== true || phase.allocationRule !== 1 || phase.memoryFits !== true
        || !Number.isFinite(phase.budgetBytes) || phase.budgetBytes > DEVICE.bytes)
        throw new Error(`${identity.sourceName} ${phase.id}: changed or unsafe prepared native payload`);
      const minimum = factoryQualificationTargetSeconds(identity.configurationId, phase.id);
      if (!Number.isFinite(phase.targetSeconds) || phase.targetSeconds < minimum)
        throw new Error(`${identity.sourceName} ${phase.id}: targetSeconds must be at least ${minimum}`);
      return { id: phase.id, nativeSha256: phase.sha256, targetSeconds: phase.targetSeconds };
    });
    return { ...identity, phases };
  });
  return { sha256: input.sha256, cases };
}

export function exportSelectedFactoryAudition(options: AuditionExportOptions) {
  const output = resolve(options.output ?? resolve(ROOT, 'build/release-audition-bank'));
  const oldPackage = resolve(ROOT, 'build/selected-fm1-bank-untuned');
  if (output === oldPackage || output.startsWith(`${oldPackage}/`))
    throw new Error('Use --output for a new audition directory; the published listening package is preserved');
  if (options.evidence && (!options.cases || !options.firmware))
    throw new Error('Evidence requires independent --cases and --firmware inputs');
  const bank = buildSelectedFactoryBank();
  if (bank.length !== 22 || SOURCE.length !== bank.length || factoryFxAudit.length !== 13)
    throw new Error('Expected 22 bank entries, 13 melodic selections and nine protected patches');
  const created = options.created ?? new Date();
  const bankJson = JSON.stringify(bank, null, 2) + '\n';
  const curatedPresets = new Map<string, Preset>();
  const presetInventory: {
    instrument: string; originalName: string; auditionName: string; structure: string; values: number;
    recall: string; addedFxEnabled: string[]; fxReason: string; role: string | null; references: string[];
  }[] = [];
  for (const audit of factoryFxAudit) {
    const name = selectedFactoryProfile[audit.name].bankName ?? audit.name;
    const entry = bank.find(entry => entry.name === name)!;
    for (const device of devicesOf(entry.patch, DEFS).filter(device => device.asm !== undefined)) {
      const assembly = entry.patch.assemblies!.find(assembly => assembly.id === device.asm)!;
      for (const preset of presetsOf(entry.patch, assembly).filter(preset => preset.factory)) {
        const name = `AUD ${preset.name}`.slice(0, PRESET_NAME_MAX);
        const key = `${preset.structure}/${devicePresetName(name).toLowerCase()}`;
        if (curatedPresets.has(key)) throw new Error(`Audition preset names collide on the FM-1: ${entry.name}/${name}`);
        curatedPresets.set(key, { structure: preset.structure, name, values: [...preset.values] });
        const design = LOFI_PRESET_DESIGNS[audit.name]?.find(design => design.name === preset.name);
        const recipe: FxRecipe | undefined = design?.fx ?? FACTORY_FX_RECIPES[audit.name]?.[preset.name];
        presetInventory.push({
          instrument: entry.name, originalName: preset.name, auditionName: name, structure: preset.structure,
          values: preset.values.length, recall: fxPresetInfo(preset) ? 'Synth and complete master FX rack' : 'Synth card, including exposed intrinsic effects',
          addedFxEnabled: FX_PRESET_KINDS.filter(kind => !!recipe?.[kind]),
          fxReason: recipe?.reason ?? (preset.name === 'Init' ? 'Dry starting point; added stages off.' : 'Intrinsic instrument controls; no added rack.'),
          role: design?.role ?? null, references: design?.references ?? [],
        });
      }
    }
  }
  const presetLibrary = { format: 'matryoshka-presets', presets: [...curatedPresets.values()] };
  const presetJson = JSON.stringify(presetLibrary, null, 2) + '\n';
  const backupJson = JSON.stringify(backupFile({
    'matryoshka.bank': JSON.stringify(bank),
    'matryoshka.presets': JSON.stringify(presetLibrary.presets),
  }, 'release-audition-bank', created), null, 2) + '\n';
  const engineSha256 = sha256(readFileSync(resolve(ROOT, 'firmware/src/engine.c')));
  const firmwarePackageSha256 = options.firmware ? sha256(readFileSync(options.firmware)) : null;
  const encoded = bank.map(({ name, patch }, index) => {
    const budget = deviceBudget(patch, 1);
    const binary = encodePatch(patch, true, false, 1);
    const hardLimitFailures = budget.over.filter(item => item.key !== 'cpu');
    if (!budget.lines.fits || hardLimitFailures.length || binary.length > DEVICE.bytes)
      throw new Error(`${name}: default native payload exceeds device hard limits`);
    return {
      binary,
      facts: {
        path: `native/${factoryFile(index, name).replace(/\.json$/, '.bin')}`,
        sha256: sha256(binary), format: binary[1], bytes: binary.length, bytesMax: DEVICE.bytes,
        budgetBytes: budget.items.find(item => item.key === 'bytes')!.used,
        allocationRule: 1, memoryBytes: budget.lines.used, memoryFits: budget.lines.fits, hardLimitFailures,
      },
    };
  });
  const entries = bank.map(({ name, patch }, index) => {
    const sourceName = SOURCE[index].name;
    const audit = factoryFxAudit.find(entry => entry.name === sourceName);
    const selected = selectedFactoryProfile[sourceName];
    if (!audit && (name !== sourceName || JSON.stringify(patch) !== JSON.stringify(SOURCE[index].patch)))
      throw new Error(`${sourceName}: protected source changed`);
    if (audit && (!selected || name !== (selected.bankName ?? sourceName)))
      throw new Error(`${sourceName}: selected source/bank name mismatch`);
    const addedFx = fxBusOf(patch)?.stages.map(stage => stage.kind) ?? [];
    const allocations = patch.modules.filter(module => module.type === 'alloc').map(module => ({ id: module.id, voices: module.params.voices }));
    const paraphonic = ['Wanderer', 'Vernon 100'].includes(sourceName);
    const configurationId = selected?.configurationId ?? null;
    return {
      sourceName, bankName: name, name, configurationId, protected: !audit,
      defaultPatchSha256: sha256(JSON.stringify(patch)), defaultNativeSha256: encoded[index].facts.sha256,
      native: encoded[index].facts,
      voices: audit ? (paraphonic ? 2 : Math.max(...allocations.map(allocation => allocation.voices))) : null,
      allocations,
      articulation: sourceName === 'Hera 4'
        ? 'Three pitched notes; independent per-note filter, filter envelope, amplitude envelope and release. Auxiliary mono allocator is control only, not a fourth pitched note.'
        : paraphonic ? 'Original two-pitch paraphony preserved.'
          : audit ? 'Original independent/source articulation retained; only explicitly selected allocation reductions.'
            : 'Original synthesis, voices, mix balance, patterns and Output preserved.',
      addedFx, intrinsicFx: audit?.existingFx.map(effect => effect.kind) ?? [],
      harmonizer: audit ? (selected.harmonizer === 'removed' ? 'removed' : 'present, bypassed by default') : 'source unchanged',
      canvasCaptions: selected?.canvasCaptions === 'short' ? 'short; captions abbreviated to fit native byte budget' : null,
      outputLevel: audit ? selected.outputLevel ?? null : null,
      compromises: [
        ...(selected?.harmonizer === 'removed' ? ['Harmonizer removed; no Harmony control or C9 expansion.'] : []),
        ...(selected?.canvasCaptions === 'short' ? ['Canvas selector captions shortened; original DSP retained.'] : []),
      ],
      qualificationPolicy: audit && configurationId ? factoryQualificationPolicy(sourceName, configurationId) : null,
      harmonizerPresent: !!audit && patch.modules.some(module => module.type === 'harm'),
      addedDrivePresent: addedFx.includes('drive'),
    };
  });
  if (entries.filter(entry => entry.protected).length !== 9) throw new Error('Expected exactly nine protected instrument graphs');
  const identities: ExpectedFactoryQualificationCase[] = entries.filter(entry => !entry.protected).map(entry => ({
    sourceName: entry.sourceName, bankName: entry.bankName, configurationId: entry.configurationId!,
    defaultPatchSha256: entry.defaultPatchSha256, defaultNativeSha256: entry.defaultNativeSha256,
    harmonizerPresent: entry.harmonizerPresent, addedDrivePresent: entry.addedDrivePresent, phases: [],
  }));
  const hashes = { bankSha256: sha256(bankJson), engineSha256, firmwarePackageSha256 };
  const preparation = options.cases ? preparedCases(resolve(options.cases), identities, hashes) : null;
  const attachment = options.evidence ? document(resolve(options.evidence)) : null;
  const context: FactoryQualificationContext = {
    ...hashes,
    cases: preparation?.cases ?? identities,
  };
  const physicalFx = attachment?.data?.physicalFx;
  if (physicalFx && typeof physicalFx === 'object') {
    const base = dirname(resolve(options.evidence!));
    if (typeof physicalFx.source === 'string') context.physicalSource = document(resolve(base, physicalFx.source));
    if (typeof physicalFx.bindingSource === 'string') context.physicalBinding = document(resolve(base, physicalFx.bindingSource));
  }
  const qualification = validateFactoryQualification(attachment?.data, context);
  const manifest = {
    schemaVersion: 1, profile: 'owner-selected-final-profile-audition', created: created.toISOString(),
    status: qualification.melodicCpuQualified
      ? 'CURATED AUDITION — current default-profile full-matrix CPU evidence attached; owner listening pending; not a production release'
      : 'CURATED AUDITION — current hardware qualification absent; owner listening pending; not a production release',
    releaseQualified: false, ownerListening: 'pending', productionPromotion: false,
    hashes: { bankSha256: context.bankSha256, engineSha256, firmwarePackageSha256 },
    compatibility: {
      json: 'Load bank-backup.json through Patch actions > Load .json in the matching prototype editor, then open Library. bank.json is the internal slot-list array, not a single patch accepted by Load .json. Backup imports merge; existing same-name bank entries are kept.',
      nativeFx: 'Native FX-page bindings require format 55 support in BOTH editor and firmware. Do not use released 1.13 / format <=54 firmware for native bindings. Attached verification covers only the named prototype firmware.',
      fxPresets: 'Complete FXP1 sound recall requires INFO feature bit 24 in the matching prototype firmware. Earlier format-55 builds can play the rack graph but cannot recall these scoped presets. The editor refuses transfers to those builds.',
      legacy: 'No legacy binary conversion or stripping of FX bindings is performed.',
    },
    qualification: {
      ...qualification,
      scope: 'Exactly the selected melodic configurations and separately identified physical FX interface proof. Nine protected instrument graphs preserved byte for byte, not a fresh MCU survey. Only measured matrix states; arbitrary edits are not qualified.',
      physicalFxScope: 'Interface-only proof, explicitly reused where stated; not fresh validation of every refreshed bank control, audio, optical LCD/LED or coupled-target state.',
      evidence: attachment?.data ?? null,
      evidenceSha256: attachment?.sha256 ?? null,
      preparationSha256: preparation?.sha256 ?? null,
      exceptions: entries.filter(entry => entry.qualificationPolicy?.exception).map(entry => ({
        sourceName: entry.sourceName, configurationId: entry.configurationId, policy: entry.qualificationPolicy,
        qualified: qualification.cases.some(measured => measured.configurationId === entry.configurationId),
      })),
      next: 'Owner listening and final artifact approval precede any production/default promotion. releaseQualified remains false.',
    },
    defaults: 'Added FX, remaining Harmony and Arp off; intrinsic effects/defaults preserved. Removed harmonizers and shortened Canvas captions are explicit per-entry compromises. No DSP quality flags or modulation restrictions.',
    curatedPresets: {
      count: presetLibrary.presets.length, inventory: presetInventory, file: 'audition-presets.json',
      scope: 'All thirteen selected melodic engines, with intentional per-sound FX, nine additional lo-fi synth designs and the hardware-parity curation. Protected drum/drone presets are retained. Browser renders and owner listening are separate from CPU qualification.',
      transfer: 'The matching firmware contains the authored sounds as read-only factory presets; load the matching selected bank graphs to use them. AUD-prefixed saved copies are optional and can be sent with Send this patch’s presets. They consume user-store slots and do not replace ROM. Back up before import; an existing same-structure/same-name user copy can be replaced.',
    },
    counts: { total: bank.length, melodic: factoryFxAudit.length, protected: 9 },
    selectedProfile: selectedFactoryProfile,
    entries: entries.map(entry => {
      const measured = qualification.cases.find(candidate => candidate.configurationId === entry.configurationId);
      const expected = preparation?.cases.find(candidate => candidate.configurationId === entry.configurationId);
      return {
        ...entry,
        cpu: {
          qualified: !!measured, measuredPeakPercent: measured?.measuredPeakPercent ?? null,
          phases: measured?.phases ?? [], expectedPhases: expected?.phases ?? [],
          status: entry.protected ? 'Protected instrument data preserved byte for byte; not re-surveyed.'
            : measured ? 'Current exact-profile complete-matrix evidence accepted under the stated policy.'
              : 'No current exact-profile qualification evidence attached; do not infer a pass from legacy observations.',
        },
      };
    }),
    evidenceContract: { usage: USAGE, scope: FACTORY_QUALIFICATION_SCOPE, schemaVersion: 1 },
    files: [
      { path: 'bank.json', sha256: context.bankSha256 },
      { path: 'bank-backup.json', sha256: sha256(backupJson) },
      { path: 'audition-presets.json', sha256: sha256(presetJson) },
      ...encoded.map(entry => ({ path: entry.facts.path, sha256: entry.facts.sha256 })),
    ],
  };
  mkdirSync(resolve(output, 'native'), { recursive: true });
  for (const entry of encoded) writeFileSync(resolve(output, entry.facts.path), entry.binary);
  for (const [path, data] of [
    ['bank.json', bankJson], ['bank-backup.json', backupJson], ['audition-presets.json', presetJson], ['manifest.json', JSON.stringify(manifest, null, 2) + '\n'],
  ]) writeFileSync(resolve(output, path), data);
  return { output, manifest };
}

export function parseAuditionExportOptions(args: readonly string[]): AuditionExportOptions {
  const options: AuditionExportOptions = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (['--output', '--cases', '--firmware'].includes(arg)) {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a path`);
      if (arg === '--output') options.output = value;
      else if (arg === '--cases') options.cases = value;
      else options.firmware = value;
    } else if (arg.startsWith('--') || options.evidence) throw new Error(`Unexpected argument: ${arg}\n${USAGE}`);
    else options.evidence = arg;
  }
  return options;
}

