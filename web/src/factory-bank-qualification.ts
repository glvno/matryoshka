// SPDX-License-Identifier: GPL-3.0-only
/** Final-profile evidence is an audition gate, never owner listening or production approval.
 * Hash inputs: bank = JSON.stringify(bank, null, 2) + '\n'; patch = JSON.stringify(patch);
 * native/engine/firmware = exact bytes. Expected phases come from an independent preparation.
 */
export const FACTORY_QUALIFICATION_SCOPE = 'selected-fm1-final-profile';
export type FactoryQualificationPolicy = 'standard95' | 'full-matrix-clean-under100';

export interface FactoryQualificationPolicyDetails {
  id: FactoryQualificationPolicy;
  ceilingPercent: number;
  ceilingInclusive: boolean;
  exception: boolean;
  requirement: string;
}

const EXCEPTIONS: Readonly<Record<string, string>> = {
  Canvas: 'canvas-original-delay-no-harm',
  'Expander S': 'expander-s-v3-drive-chorus-delay-reverb',
};

export function factoryQualificationPolicy(sourceName: string, configurationId: string): FactoryQualificationPolicyDetails {
  const exception = EXCEPTIONS[sourceName] === configurationId;
  return {
    id: exception ? 'full-matrix-clean-under100' : 'standard95',
    ceilingPercent: exception ? 100 : 95,
    ceilingInclusive: !exception,
    exception,
    requirement: exception
      ? 'Explicit narrow exception: every expected phase below 100%; zero mute, shed and late events. Not a 95% headroom pass.'
      : 'Every expected phase at or below 95%; zero mute, shed and late events.',
  };
}

export function factoryQualificationPhaseIds(harmonizerPresent: boolean, addedDrivePresent: boolean): string[] {
  return (harmonizerPresent ? ['plain8', 'c9-root60'] : ['plain8', 'single60']).flatMap(notes =>
    ['off', 'on'].flatMap(arp => (addedDrivePresent ? ['softclip', 'fold'] : ['absent'])
      .map(drive => `${notes}-arp-${arp}-drive-${drive}`)));
}

export function factoryQualificationTargetSeconds(configurationId: string, phaseId: string): number {
  const longPhases: Readonly<Record<string, string>> = {
    'expander-s-v3-drive-chorus-delay-reverb': 'c9-root60-arp-on-drive-fold',
    'canvas-original-delay-no-harm': 'plain8-arp-on-drive-absent',
  };
  return longPhases[configurationId] === phaseId ? 60 : 5;
}

export interface ExpectedFactoryQualificationCase {
  sourceName: string;
  bankName: string;
  configurationId: string;
  defaultPatchSha256: string;
  defaultNativeSha256: string;
  harmonizerPresent: boolean;
  addedDrivePresent: boolean;
  phases: readonly { id: string; nativeSha256: string; targetSeconds: number }[];
}

export interface FactoryQualificationContext {
  bankSha256: string;
  engineSha256: string;
  firmwarePackageSha256: string | null;
  cases: readonly ExpectedFactoryQualificationCase[];
  physicalSource?: { sha256: string; data: unknown };
  physicalBinding?: { sha256: string; data: unknown };
}

export interface FactoryPhaseMeasurement {
  id: string;
  nativeSha256: string;
  peakPercent: number;
  mute: number;
  shed: number;
  late: number;
  completed: true;
  sampleStatus: 'complete';
  seconds: number;
  targetSeconds: number;
}

export interface FactoryPhysicalFxEvidence {
  scope: 'physical-fx-interface';
  firmwarePackageSha256: string;
  source: string;
  sourceSha256: string;
  passed: true;
  reused: boolean;
  bindingSource?: string;
  bindingSourceSha256?: string;
}

export interface FactoryCaseEvidence {
  sourceName: string;
  bankName: string;
  configurationId: string;
  defaultPatchSha256: string;
  defaultNativeSha256: string;
  policy: FactoryQualificationPolicy;
  phases: FactoryPhaseMeasurement[];
}

export interface FactoryQualificationEvidence {
  schemaVersion: 1;
  scope: typeof FACTORY_QUALIFICATION_SCOPE;
  bankSha256: string;
  engineSha256: string;
  firmwarePackageSha256: string;
  cases: FactoryCaseEvidence[];
  physicalFx?: FactoryPhysicalFxEvidence;
}

export interface FactoryCaseQualification {
  sourceName: string;
  bankName: string;
  configurationId: string;
  defaultPatchSha256: string;
  defaultNativeSha256: string;
  policy: FactoryQualificationPolicyDetails;
  measuredPeakPercent: number;
  phases: FactoryPhaseMeasurement[];
}

// These are the existing physical interface checks, not new tests or audio/optical claims.
const PHYSICAL_CHECKS = [
  'input-integrity', 'registered-rig-preflight', 'live-only-native-upload',
  'harmony-lfo-runtime-button-state', 'fx-open-four-runtime-stages',
  'drive-select-and-knobs', 'drive-sel-on-off-no-parameter-edit',
  'chorus-select-and-knobs', 'chorus-sel-on-off-no-parameter-edit',
  'delay-select-and-knobs', 'delay-sel-on-off-no-parameter-edit',
  'reverb-select-and-knobs', 'reverb-sel-on-off-no-parameter-edit',
  'fx-and-home-exact-device-page-return', 'later-normal-fx-page-access',
  'final-fresh-ignore-and-allocation',
];

type ObjectValue = Record<string, unknown>;
function object(value: unknown, label: string): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}: expected an object`);
  return value as ObjectValue;
}
function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label}: expected an array`);
  return value;
}
function requireEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) throw new Error(`${label}: missing, stale or out-of-scope evidence`);
}
function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) throw new Error(`${label}: expected SHA-256`);
  return value;
}
function boundDigest(actual: unknown, expected: unknown, label: string): void {
  requireEqual(digest(actual, label), digest(expected, `${label} expected`), label);
}
function uniqueIds(values: readonly string[], label: string): void {
  if (values.some(id => !id) || new Set(values).size !== values.length) throw new Error(`${label}: empty or duplicate identity`);
}

function physicalQualification(value: unknown, expected: FactoryQualificationContext) {
  const record = object(value, 'physicalFx');
  requireEqual(record.scope, 'physical-fx-interface', 'physicalFx scope');
  requireEqual(record.passed, true, 'physicalFx passed');
  if (typeof record.reused !== 'boolean') throw new Error('physicalFx reused: explicit reuse decision required');
  if (typeof record.source !== 'string' || !record.source) throw new Error('physicalFx source is required');
  boundDigest(record.firmwarePackageSha256, expected.firmwarePackageSha256, 'physicalFx firmwarePackageSha256');
  if (!expected.physicalSource) throw new Error('physicalFx: source file was not supplied');
  boundDigest(record.sourceSha256, expected.physicalSource.sha256, 'physicalFx sourceSha256');
  const source = object(expected.physicalSource.data, 'physicalFx source');
  requireEqual(source.status, 'passed', 'physicalFx source status');
  const phases = array(source.phases, 'physicalFx source phases').map((phase, index) => object(phase, `physicalFx source phase ${index}`));
  uniqueIds(phases.map(phase => String(phase.name ?? '')), 'physicalFx checks');
  if (phases.some(phase => phase.status !== 'passed')) throw new Error('physicalFx: source contains an incomplete or failed check');
  for (const name of PHYSICAL_CHECKS) {
    requireEqual(phases.find(phase => phase.name === name)?.status, 'passed', `physicalFx ${name}`);
  }
  // Older raw interface records did not embed firmware identity. Their original qualification
  // can bind the unchanged raw proof to firmware, but none of its CPU booleans are reused.
  if (source.firmwarePackageSha256 !== undefined) {
    boundDigest(source.firmwarePackageSha256, expected.firmwarePackageSha256, 'physicalFx source firmware');
  } else {
    if (typeof record.bindingSource !== 'string' || !record.bindingSource || !expected.physicalBinding)
      throw new Error('physicalFx: original same-firmware binding is required');
    boundDigest(record.bindingSourceSha256, expected.physicalBinding.sha256, 'physicalFx bindingSourceSha256');
    const binding = object(expected.physicalBinding.data, 'physicalFx binding');
    boundDigest(binding.firmwarePackageSha256, expected.firmwarePackageSha256, 'physicalFx original firmware binding');
    const priorFx = object(binding.physicalFx, 'physicalFx original binding');
    boundDigest(priorFx.evidenceSha256, record.sourceSha256, 'physicalFx original proof binding');
    requireEqual(priorFx.passed, true, 'physicalFx original binding passed');
  }
  const limits = array(source.limits, 'physicalFx limits');
  if (!limits.length || limits.some(limit => typeof limit !== 'string')) throw new Error('physicalFx: original proof limits are required');
  return {
    scope: 'physical-fx-interface',
    source: record.source,
    sourceSha256: record.sourceSha256,
    firmwarePackageSha256: record.firmwarePackageSha256,
    reused: record.reused,
    checks: PHYSICAL_CHECKS,
    limits: limits as string[],
    bindingSource: record.bindingSource ?? null,
    bindingSourceSha256: record.bindingSourceSha256 ?? null,
  };
}

/** Invalid attachments fail closed. Absence is allowed only as an explicitly unqualified audition. */
export function validateFactoryQualification(evidence: unknown, expected: FactoryQualificationContext) {
  const base = { releaseQualified: false as const, ownerListening: 'pending' as const };
  if (evidence === null || evidence === undefined) {
    return { ...base, melodicCpuQualified: false, physicalFxVerified: false, cases: [] as FactoryCaseQualification[], physicalFx: null };
  }
  const record = object(evidence, 'qualification');
  requireEqual(record.schemaVersion, 1, 'qualification schemaVersion');
  requireEqual(record.scope, FACTORY_QUALIFICATION_SCOPE, 'qualification scope');
  for (const key of ['bankSha256', 'engineSha256', 'firmwarePackageSha256'] as const)
    boundDigest(record[key], expected[key], key);
  if (!expected.cases.length) throw new Error('qualification: independent expected phase matrix is required');
  uniqueIds(expected.cases.map(entry => entry.sourceName), 'expected sources');
  uniqueIds(expected.cases.map(entry => entry.configurationId), 'expected configurations');
  const cases = array(record.cases, 'qualification cases').map((entry, index) => object(entry, `qualification case ${index}`));
  requireEqual(cases.length, expected.cases.length, 'qualification case count');
  uniqueIds(cases.map(entry => String(entry.sourceName ?? '')), 'qualification sources');
  const results: FactoryCaseQualification[] = expected.cases.map(wanted => {
    const label = wanted.sourceName;
    const entry = cases.find(candidate => candidate.sourceName === label);
    if (!entry) throw new Error(`${label}: missing selected case`);
    for (const key of ['sourceName', 'bankName', 'configurationId'] as const) requireEqual(entry[key], wanted[key], `${label} ${key}`);
    for (const key of ['defaultPatchSha256', 'defaultNativeSha256'] as const) boundDigest(entry[key], wanted[key], `${label} ${key}`);
    const policy = factoryQualificationPolicy(wanted.sourceName, wanted.configurationId);
    requireEqual(entry.policy, policy.id, `${label} policy`);
    const requiredIds = factoryQualificationPhaseIds(wanted.harmonizerPresent, wanted.addedDrivePresent);
    uniqueIds(wanted.phases.map(phase => phase.id), `${label} expected phases`);
    if (wanted.phases.length !== requiredIds.length || requiredIds.some(id => !wanted.phases.some(phase => phase.id === id)))
      throw new Error(`${label}: independent preparation does not cover the complete phase matrix`);
    const observed = array(entry.phases, `${label} phases`).map((phase, index) => object(phase, `${label} phase ${index}`));
    requireEqual(observed.length, wanted.phases.length, `${label} phase count`);
    uniqueIds(observed.map(phase => String(phase.id ?? '')), `${label} phases`);
    const phases: FactoryPhaseMeasurement[] = wanted.phases.map(phase => {
      const measured = observed.find(candidate => candidate.id === phase.id);
      if (!measured) throw new Error(`${label}: missing phase ${phase.id}`);
      boundDigest(measured.nativeSha256, phase.nativeSha256, `${label} ${phase.id} nativeSha256`);
      requireEqual(measured.completed, true, `${label} ${phase.id} completed`);
      requireEqual(measured.sampleStatus, 'complete', `${label} ${phase.id} sampleStatus`);
      const minimumSeconds = factoryQualificationTargetSeconds(wanted.configurationId, phase.id);
      if (!Number.isFinite(phase.targetSeconds) || phase.targetSeconds < minimumSeconds)
        throw new Error(`${label} ${phase.id}: expected targetSeconds must be at least ${minimumSeconds}`);
      requireEqual(measured.targetSeconds, phase.targetSeconds, `${label} ${phase.id} targetSeconds`);
      if (typeof measured.seconds !== 'number' || !Number.isFinite(measured.seconds) || measured.seconds < phase.targetSeconds)
        throw new Error(`${label} ${phase.id}: held duration is below targetSeconds`);
      for (const guard of ['mute', 'shed', 'late']) requireEqual(measured[guard], 0, `${label} ${phase.id} ${guard}`);
      const peak = measured.peakPercent;
      if (typeof peak !== 'number' || !Number.isFinite(peak) || peak < 0
        || (policy.ceilingInclusive ? peak > policy.ceilingPercent : peak >= policy.ceilingPercent))
        throw new Error(`${label} ${phase.id}: measured CPU violates ${policy.id}`);
      return {
        id: phase.id, nativeSha256: phase.nativeSha256, peakPercent: peak,
        mute: 0, shed: 0, late: 0, completed: true, sampleStatus: 'complete',
        seconds: measured.seconds, targetSeconds: phase.targetSeconds,
      };
    });
    return {
      sourceName: wanted.sourceName, bankName: wanted.bankName, configurationId: wanted.configurationId,
      defaultPatchSha256: wanted.defaultPatchSha256, defaultNativeSha256: wanted.defaultNativeSha256,
      policy, measuredPeakPercent: Math.max(...phases.map(phase => phase.peakPercent)), phases,
    };
  });
  const physicalFx = record.physicalFx === undefined ? null : physicalQualification(record.physicalFx, expected);
  return { ...base, melodicCpuQualified: true, physicalFxVerified: physicalFx !== null, cases: results, physicalFx };
}
