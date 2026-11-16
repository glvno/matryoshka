// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { mergeShards, planShards, scenarioTiming, stamp } from './emu-shards.mjs';

describe('emu:scenarios timing records', () => {
  it('stamps each check with its scenario and the wall time since the one before', () => {
    const clock = { scenario: 'arp', last: 1000 };
    expect(stamp({ name: 'a' }, clock, 1400)).toEqual({ name: 'a', scenario: 'arp', ms: 400 });
    expect(stamp({ name: 'b' }, clock, 1450)).toEqual({ name: 'b', scenario: 'arp', ms: 50 });
    expect(stamp({ name: 'before any scenario' }, { scenario: null, last: 0 }, 5)).toEqual({ name: 'before any scenario' });
  });
  it("sums a scenario's checks", () => {
    const checks = [{ ok: true }, { ok: false }, { ok: true, skipped: true }];
    expect(scenarioTiming('oct', 2500, 1800, checks)).toEqual({ scenario: 'oct', wallMs: 2500, emuMs: 1800, checks: 3, failed: 1, skipped: 1 });
    expect(scenarioTiming('oct', 2500, undefined, []).emuMs).toBe(null);
  });
});

describe('emu:scenarios over several emulators (--shards)', () => {
  const names = ['a', 'b', 'c', 'd', 'e', 'f'];
  it('deals every scenario once, each shard in run order', () => {
    const plan = planShards(names, 3, { a: 60, b: 10, c: 50, d: 10, e: 40, f: 10 });
    expect(plan.flatMap((s) => s.names).sort()).toEqual(names);
    for (const s of plan) expect(s.names).toEqual([...s.names].sort((x, y) => names.indexOf(x) - names.indexOf(y)));
  });
  it("evens out the last run's times: the longest first onto the least loaded shard", () => {
    const plan = planShards(names, 3, { a: 60, b: 10, c: 50, d: 10, e: 40, f: 10 });
    expect(plan.map((s) => s.names)).toEqual([['a'], ['c', 'd'], ['b', 'e', 'f']]);
    expect(plan.map((s) => s.ms)).toEqual([60, 60, 60]);
  });
  it('counts a scenario with no time as the median, and deals unmeasured runs round the shards in order', () => {
    expect(planShards(names, 2).map((s) => s.names)).toEqual([['a', 'c', 'e'], ['b', 'd', 'f']]);
    const plan = planShards(['a', 'b', 'c', 'new'], 2, { a: 10, b: 20, c: 30 });
    expect(plan.map((s) => s.names)).toEqual([['a', 'c'], ['b', 'new']]);
  });
  it('leaves out shards with nothing to run and refuses a count that is no whole number', () => {
    expect(planShards(['a'], 4)).toHaveLength(1);
    expect(() => planShards(names, 0)).toThrow('--shards 0');
    expect(() => planShards(names, 1.5)).toThrow();
  });
  it("merges the shards' checks in run order, each with its shard, and fails a shard that ended without saying why", () => {
    const merged = mergeShards(['x', 'y'], [
      { exit: 0, results: [{ name: 'c1', scenario: 'connect', ok: true }, { name: 'y1', scenario: 'y', ok: true }] },
      { exit: 2, results: [{ name: 'c2', scenario: 'connect', ok: true }, { name: 'x1', scenario: 'x', ok: true }] },
      { exit: 1, results: [{ name: 'x2', scenario: 'x', ok: false }] },
    ]);
    expect(merged.map((r) => `${r.shard} ${r.name}`)).toEqual(['1 c1', '2 c2', '2 x1', '3 x2', '1 y1', '2 shard 2: ran to the end']);
    expect(merged.at(-1).ok).toBe(false);
  });
});
