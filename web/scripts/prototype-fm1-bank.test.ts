// SPDX-License-Identifier: GPL-3.0-only
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import SOURCE from '../factory/bank.json';
import { backupKeys } from '../src/migrate';
import { factoryQualificationPhaseIds, factoryQualificationTargetSeconds } from '../src/factory-bank-qualification';
import { exportSelectedFactoryAudition, parseAuditionExportOptions } from './factory-bank-audition';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function directory() {
  const path = mkdtempSync(resolve(tmpdir(), 'fm1-audition-export-'));
  directories.push(path);
  return path;
}

describe('explicit final-profile audition export', () => {
  it('exports an importable backup, exact hashes, scoped exceptions and protected-patch trims', () => {
    const output = directory();
    const { manifest } = exportSelectedFactoryAudition({ output, created: new Date('2026-11-12T00:00:00Z') });
    const bankJson = readFileSync(resolve(output, 'bank.json'), 'utf8');
    const bank = JSON.parse(bankJson);
    const keys = backupKeys(JSON.parse(readFileSync(resolve(output, 'bank-backup.json'), 'utf8')))!;
    expect(JSON.parse(keys['matryoshka.bank'])).toEqual(bank);
    const presets = JSON.parse(readFileSync(resolve(output, 'audition-presets.json'), 'utf8'));
    expect(JSON.parse(keys['matryoshka.presets'])).toEqual(presets.presets);
    expect(presets.format).toBe('matryoshka-presets');
    expect(presets.presets.every((preset: { name: string }) => preset.name.startsWith('AUD '))).toBe(true);
    expect(bankJson).toBe(JSON.stringify(bank, null, 2) + '\n');
    expect(manifest.hashes.bankSha256).toBe(createHash('sha256').update(bankJson).digest('hex'));
    expect(manifest.counts.total).toBe(manifest.entries.length);
    expect(manifest.counts.protected).toBe(manifest.entries.filter(entry => entry.protected).length);
    expect(manifest.counts.melodic + manifest.counts.protected).toBe(manifest.counts.total);
    expect(manifest.qualification.exceptions.every(entry => !entry.qualified)).toBe(true);
    for (const entry of manifest.entries) {
      const exported = bank.find((candidate: { name: string }) => candidate.name === entry.bankName);
      expect(entry.defaultPatchSha256).toBe(createHash('sha256').update(JSON.stringify(exported.patch)).digest('hex'));
      expect(entry.defaultNativeSha256).toBe(createHash('sha256').update(readFileSync(resolve(output, entry.native.path))).digest('hex'));
      expect(entry.cpu.qualified).toBe(false);
      if (entry.protected) expect(exported).toEqual(SOURCE.find(source => source.name === entry.sourceName)!);
    }
  });

  it('rejects altered prepared native payload bytes before writing a qualified package', () => {
    const output = directory();
    const { manifest } = exportSelectedFactoryAudition({ output });
    const bank = JSON.parse(readFileSync(resolve(output, 'bank.json'), 'utf8'));
    // Synthetic independent preparation for exercising file integrity, not a hardware verdict.
    const cases = manifest.entries.filter(entry => !entry.protected).map(entry => {
      const defaultJson = resolve(output, `${entry.configurationId}.json`);
      writeFileSync(defaultJson, JSON.stringify(bank.find((candidate: { name: string }) => candidate.name === entry.bankName).patch, null, 2));
      const phasePath = resolve(output, `${entry.configurationId}-phase.bin`);
      writeFileSync(phasePath, readFileSync(resolve(output, entry.native.path)));
      return {
        originalName: entry.sourceName, selectedPatchName: entry.bankName, variantId: entry.configurationId,
        sourceSha256: entry.defaultPatchSha256, defaultNativeSha256: entry.defaultNativeSha256, defaultJson,
        defaultNativePath: resolve(output, entry.native.path),
        phases: factoryQualificationPhaseIds(entry.harmonizerPresent, entry.addedDrivePresent).map(id => ({
          id, binaryPath: phasePath, sha256: entry.defaultNativeSha256,
          targetSeconds: factoryQualificationTargetSeconds(entry.configurationId!, id),
          uploadable: true, allocationRule: 1, budgetBytes: entry.native.budgetBytes, memoryFits: true,
        })),
      };
    });
    const path = resolve(output, 'cases.json');
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, scope: 'selected-fm1-final-profile', ...manifest.hashes, cases }));
    const corrupted = cases[0].phases[0].binaryPath;
    const bytes = readFileSync(corrupted);
    bytes[bytes.length - 1] ^= 1;
    writeFileSync(corrupted, bytes);
    expect(() => exportSelectedFactoryAudition({ output: resolve(output, 'rejected'), cases: path })).toThrow('prepared native payload');
  });

  it('does not accept evidence without independent cases and firmware', () => {
    expect(() => exportSelectedFactoryAudition({ output: directory(), evidence: 'legacy.json' })).toThrow('--cases and --firmware');
  });

  it('preserves the old listening package and refuses that output directory', () => {
    expect(() => exportSelectedFactoryAudition({ output: new URL('../../build/selected-fm1-bank-untuned/', import.meta.url).pathname })).toThrow('published listening package');
  });

  it('accepts --output in either argument order and rejects incomplete or unknown arguments', () => {
    expect(parseAuditionExportOptions(['proof.json', '--output', '/tmp/audition', '--cases', 'cases.json', '--firmware', 'fm1.fwsc'])).toEqual({
      evidence: 'proof.json', output: '/tmp/audition', cases: 'cases.json', firmware: 'fm1.fwsc',
    });
    expect(parseAuditionExportOptions(['--output', '/tmp/audition', 'proof.json'])).toEqual({ output: '/tmp/audition', evidence: 'proof.json' });
    expect(() => parseAuditionExportOptions(['--output'])).toThrow('requires a path');
    expect(() => parseAuditionExportOptions(['--promote'])).toThrow('Unexpected');
  });
});
