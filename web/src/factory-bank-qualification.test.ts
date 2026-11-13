// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  FACTORY_QUALIFICATION_SCOPE, factoryQualificationPhaseIds, factoryQualificationPolicy,
  factoryQualificationTargetSeconds, validateFactoryQualification,
  type FactoryQualificationContext, type FactoryQualificationEvidence,
} from './factory-bank-qualification';

const BANK = 'a'.repeat(64), ENGINE = 'b'.repeat(64), FIRMWARE = 'c'.repeat(64);
const PATCH = 'd'.repeat(64), NATIVE = 'e'.repeat(64), OTHER = 'f'.repeat(64);

function fixture(sourceName = 'Algo Four', configurationId = 'algo-four-v4-drive-delay-reverb', harmonizerPresent = true, addedDrivePresent = true) {
  const phases = factoryQualificationPhaseIds(harmonizerPresent, addedDrivePresent).map(id => ({
    id, nativeSha256: NATIVE, targetSeconds: factoryQualificationTargetSeconds(configurationId, id),
  }));
  const identity = {
    sourceName, bankName: sourceName === 'Hera 4' ? 'Hera 3' : sourceName, configurationId,
    defaultPatchSha256: PATCH, defaultNativeSha256: NATIVE, harmonizerPresent, addedDrivePresent, phases,
  };
  const context: FactoryQualificationContext = {
    bankSha256: BANK, engineSha256: ENGINE, firmwarePackageSha256: FIRMWARE, cases: [identity],
  };
  const evidence: FactoryQualificationEvidence = {
    schemaVersion: 1, scope: FACTORY_QUALIFICATION_SCOPE,
    bankSha256: BANK, engineSha256: ENGINE, firmwarePackageSha256: FIRMWARE,
    cases: [{
      sourceName: identity.sourceName, bankName: identity.bankName, configurationId,
      defaultPatchSha256: PATCH, defaultNativeSha256: NATIVE,
      policy: factoryQualificationPolicy(sourceName, configurationId).id,
      phases: phases.map(phase => ({
        ...phase, peakPercent: 94, mute: 0, shed: 0, late: 0,
        seconds: phase.targetSeconds, completed: true, sampleStatus: 'complete',
      })),
    }],
  };
  return { context, evidence };
}

function physicalFixture() {
  const state = fixture();
  const names = [
    'input-integrity', 'registered-rig-preflight', 'live-only-native-upload',
    'harmony-lfo-runtime-button-state', 'fx-open-four-runtime-stages',
    'drive-select-and-knobs', 'drive-sel-on-off-no-parameter-edit',
    'chorus-select-and-knobs', 'chorus-sel-on-off-no-parameter-edit',
    'delay-select-and-knobs', 'delay-sel-on-off-no-parameter-edit',
    'reverb-select-and-knobs', 'reverb-sel-on-off-no-parameter-edit',
    'fx-and-home-exact-device-page-return', 'later-normal-fx-page-access',
    'final-fresh-ignore-and-allocation',
  ];
  state.evidence.physicalFx = {
    scope: 'physical-fx-interface', firmwarePackageSha256: FIRMWARE,
    source: 'native-fx.json', sourceSha256: PATCH, passed: true, reused: true,
    bindingSource: 'original-qualification.json', bindingSourceSha256: NATIVE,
  };
  const source = {
    status: 'passed', phases: names.map(name => ({ name, status: 'passed' })),
    limits: ['Runtime drawing/primary parameter events only; no optical LCD/LED or independent coupled-target proof.'],
  };
  const binding = { firmwarePackageSha256: FIRMWARE, physicalFx: { passed: true, evidenceSha256: PATCH } };
  state.context.physicalSource = { sha256: PATCH, data: source };
  state.context.physicalBinding = { sha256: NATIVE, data: binding };
  return { ...state, source, binding };
}

describe('exact final-profile audition qualification', () => {
  it('leaves absent measurements unqualified without promoting a release', () => {
    const { context } = fixture();
    expect(validateFactoryQualification(null, context)).toMatchObject({
      releaseQualified: false, ownerListening: 'pending', melodicCpuQualified: false,
      physicalFxVerified: false, cases: [], physicalFx: null,
    });
  });

  it('accepts complete, bound <=95% measurements without implying physical verification or listening', () => {
    const { context, evidence } = fixture();
    evidence.cases[0].phases[0].peakPercent = 95;
    const result = validateFactoryQualification(evidence, context);
    expect(result).toMatchObject({ releaseQualified: false, ownerListening: 'pending', melodicCpuQualified: true, physicalFxVerified: false });
    expect(result.cases[0]).toMatchObject({ measuredPeakPercent: 95, policy: { id: 'standard95', exception: false } });
    expect(result.cases[0].phases).toHaveLength(8);
  });

  it.each(['bankSha256', 'engineSha256', 'firmwarePackageSha256'] as const)('rejects stale %s', key => {
    const { context, evidence } = fixture();
    evidence[key] = OTHER;
    expect(() => validateFactoryQualification(evidence, context)).toThrow(key);
  });

  it.each(['defaultPatchSha256', 'defaultNativeSha256'] as const)('rejects a mismatched %s', key => {
    const { context, evidence } = fixture();
    evidence.cases[0][key] = OTHER;
    expect(() => validateFactoryQualification(evidence, context)).toThrow(key);
  });

  it('rejects mismatched native phase payloads even when all copied verdicts say passed', () => {
    const { context, evidence } = fixture();
    evidence.cases[0].phases[0].nativeSha256 = OTHER;
    expect(() => validateFactoryQualification({ ...evidence, passed: true, cpu: { allPassed: true } }, context)).toThrow('nativeSha256');
  });

  it('rejects missing measured phases and incomplete independent preparations', () => {
    const { context, evidence } = fixture();
    evidence.cases[0].phases.pop();
    expect(() => validateFactoryQualification(evidence, context)).toThrow('phase count');
    context.cases[0].phases = evidence.cases[0].phases;
    expect(() => validateFactoryQualification(evidence, context)).toThrow('complete phase matrix');
  });

  it('rejects duplicate phase IDs and absent selected cases', () => {
    const { context, evidence } = fixture();
    evidence.cases[0].phases[1].id = evidence.cases[0].phases[0].id;
    expect(() => validateFactoryQualification(evidence, context)).toThrow('duplicate');
    evidence.cases = [];
    expect(() => validateFactoryQualification(evidence, context)).toThrow('case count');
  });

  it.each(['mute', 'shed', 'late'] as const)('rejects %s guard activity', guard => {
    const { context, evidence } = fixture();
    evidence.cases[0].phases[0][guard] = 1;
    expect(() => validateFactoryQualification(evidence, context)).toThrow(guard);
  });

  it('rejects absent guard counters instead of treating them as zero', () => {
    const { context, evidence } = fixture();
    const { late: _late, ...incomplete } = evidence.cases[0].phases[0];
    expect(() => validateFactoryQualification({ ...evidence, cases: [{ ...evidence.cases[0], phases: [incomplete, ...evidence.cases[0].phases.slice(1)] }] }, context)).toThrow('late');
  });

  it('rejects absent scope, legacy aggregate booleans and unsupported schema', () => {
    const { context, evidence } = fixture();
    const { scope: _scope, ...unscoped } = evidence;
    expect(() => validateFactoryQualification(unscoped, context)).toThrow('scope');
    expect(() => validateFactoryQualification({ bankSha256: BANK, cpu: { allPassed: true, ceilingPercent: 95 } }, context)).toThrow('schemaVersion');
    expect(() => validateFactoryQualification({ ...evidence, schemaVersion: 2 }, context)).toThrow('schemaVersion');
  });

  it.each(['sourceName', 'bankName', 'configurationId'] as const)('rejects out-of-scope %s', key => {
    const { context, evidence } = fixture();
    evidence.cases[0][key] = 'legacy-profile';
    expect(() => validateFactoryQualification(evidence, context)).toThrow();
  });

  it('requires complete real sampling and held duration, not a requested target alone', () => {
    const { context, evidence } = fixture();
    evidence.cases[0].phases[0].seconds = 4.99;
    expect(() => validateFactoryQualification(evidence, context)).toThrow('held duration');
    evidence.cases[0].phases[0].seconds = 5;
    expect(() => validateFactoryQualification({ ...evidence, cases: [{ ...evidence.cases[0], phases: [{ ...evidence.cases[0].phases[0], sampleStatus: 'interrupted' }, ...evidence.cases[0].phases.slice(1)] }] }, context)).toThrow('sampleStatus');
    expect(() => validateFactoryQualification({ ...evidence, cases: [{ ...evidence.cases[0], phases: [{ ...evidence.cases[0].phases[0], completed: false }, ...evidence.cases[0].phases.slice(1)] }] }, context)).toThrow('completed');
  });

  it.each([
    ['Canvas', 'canvas-original-delay-no-harm', false, false],
    ['Expander S', 'expander-s-v3-drive-chorus-delay-reverb', true, true],
  ] as const)('permits only the complete clean <100%% exception for %s', (name, id, harm, drive) => {
    const { context, evidence } = fixture(name, id, harm, drive);
    for (const phase of evidence.cases[0].phases) phase.peakPercent = 99.9;
    const result = validateFactoryQualification(evidence, context);
    expect(result.cases[0].policy).toMatchObject({ id: 'full-matrix-clean-under100', ceilingInclusive: false, exception: true });
    const long = evidence.cases[0].phases.find(phase => phase.targetSeconds === 60)!;
    long.seconds = 59.99;
    expect(() => validateFactoryQualification(evidence, context)).toThrow('held duration');
    long.seconds = 60;
    long.peakPercent = 100;
    expect(() => validateFactoryQualification(evidence, context)).toThrow('CPU');
  });

  it.each([
    ['Canvas', 'selected-canvas'], ['Expander S', 'selected-expander-s'],
    ['Sallen 20', 'selected-sallen-20'], ['Algo Four', 'canvas-original-delay-no-harm'],
    ['Sallen 20', 'sallen-20-original-drive-chorus-delay-no-harm'],
    ['Sallen 20', 'sallen-20-original-chorus-delay-reverb-no-harm'],
  ])('does not widen exceptions to %s / %s', (name, id) => {
    const { context, evidence } = fixture(name, id);
    evidence.cases[0].policy = 'full-matrix-clean-under100';
    expect(() => validateFactoryQualification(evidence, context)).toThrow('policy');
  });

  it.each([95.001, NaN, Infinity, -1])('rejects invalid standard CPU observation %s', peak => {
    const { context, evidence } = fixture();
    evidence.cases[0].phases[0].peakPercent = peak;
    expect(() => validateFactoryQualification(evidence, context)).toThrow('CPU');
  });

  it('keeps renamed bank identity separate from the source profile key', () => {
    const { context, evidence } = fixture('Hera 4', 'hera-4-v3-none', true, false);
    expect(validateFactoryQualification(evidence, context).cases[0]).toMatchObject({ sourceName: 'Hera 4', bankName: 'Hera 3' });
    evidence.cases[0].bankName = 'Hera 4';
    expect(() => validateFactoryQualification(evidence, context)).toThrow('bankName');
  });
});

describe('same-firmware physical FX interface evidence reuse', () => {
  it('accepts hashed original checks with an explicit binding and preserves their limits', () => {
    const { context, evidence, source } = physicalFixture();
    const result = validateFactoryQualification(evidence, context);
    expect(result.physicalFxVerified).toBe(true);
    expect(result.physicalFx).toMatchObject({ reused: true, scope: 'physical-fx-interface', limits: source.limits });
    expect(result.releaseQualified).toBe(false);
  });

  it('rejects original physical proof bound to another firmware', () => {
    const { context, evidence, binding } = physicalFixture();
    binding.firmwarePackageSha256 = OTHER;
    expect(() => validateFactoryQualification(evidence, context)).toThrow('original firmware binding');
  });

  it('rejects a stale original proof hash, absent binding, or missing actual checks', () => {
    const { context, evidence, binding, source } = physicalFixture();
    binding.physicalFx.evidenceSha256 = OTHER;
    expect(() => validateFactoryQualification(evidence, context)).toThrow('original proof binding');
    binding.physicalFx.evidenceSha256 = PATCH;
    context.physicalBinding = undefined;
    expect(() => validateFactoryQualification(evidence, context)).toThrow('binding');
    context.physicalBinding = { sha256: NATIVE, data: binding };
    source.phases.pop();
    expect(() => validateFactoryQualification(evidence, context)).toThrow('final-fresh-ignore-and-allocation');
  });

  it('never promotes a copied physical passed flag without source proof', () => {
    const { context, evidence } = physicalFixture();
    context.physicalSource = undefined;
    expect(() => validateFactoryQualification(evidence, context)).toThrow('source file');
  });
});
