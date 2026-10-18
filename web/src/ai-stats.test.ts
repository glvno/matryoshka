import { describe, expect, it } from 'vitest';
import { formatDay, formatHours, formatUsd, isAiStats, modelName, modelShares, sumSummaries, totalCost } from './ai-stats';

describe('AI usage figures', () => {
  it('sums the projects\' days, finds the first tracked day and adds the costs per model', () => {
    const a = { data: [
      { range: { date: '2026-10-09' }, grand_total: { total_seconds: 0 } },
      { range: { date: '2026-10-10' }, grand_total: { total_seconds: 3600 }, ai_model_costs: { 'claude-opus-5-5': 10 } },
    ] };
    const b = { data: [
      { range: { date: '2026-10-12' }, grand_total: { total_seconds: 1800, ai_model_costs: { 'claude-opus-5-5': 2, 'gpt-5.5-codex': 3 } } },
    ] };
    const s = sumSummaries([a, b], ['modular-1', 'matryoshka'], '2026-10-17');
    expect(s).toEqual({ asOf: '2026-10-17', since: '2026-10-10', projects: ['modular-1', 'matryoshka'], seconds: 5400,
      costs: { 'claude-opus-5-5': 12, 'gpt-5.5-codex': 3 } });
    expect(totalCost(s)).toBe(15);
    expect(isAiStats(s)).toBe(true);
  });

  it('an empty response gives zero and no first day', () => {
    expect(sumSummaries([{}], ['x'], '2026-10-17')).toMatchObject({ since: null, seconds: 0, costs: {} });
  });

  it('model shares are sorted, with the tiny ones as other', () => {
    const shares = modelShares({ asOf: '', since: null, projects: [], seconds: 0, costs: { a: 10, b: 89.5, c: 0.5 } });
    expect(shares.map((m) => m.model)).toEqual(['b', 'a', 'other']);
    expect(shares[0].share).toBeCloseTo(0.895);
  });

  it('formats hours, dollars and days', () => {
    expect(formatHours(1800)).toBe('30 min');
    expect(formatHours(3.5 * 3600)).toBe('3.5 hours');
    expect(formatHours(1234 * 3600)).toBe('1,234 hours');
    expect(formatUsd(12.345)).toBe('$12.35');
    expect(formatUsd(1234.6)).toBe('$1,235');
    expect(formatDay('2026-10-17')).toBe('Oct 17, 2026');
  });

  it('refuses a file of the wrong shape', () => {
    expect(isAiStats(null)).toBe(false);
    expect(isAiStats({ asOf: 'x' })).toBe(false);
  });
});

describe('model names', () => {
  it('reads WakaTime model ids', () => {
    expect(modelName('claude-opus-5-5')).toBe('Opus 5.5');
    expect(modelName('claude-fable-5-1')).toBe('Fable 5.1');
    expect(modelName('gpt-astra')).toBe('GPT Astra');
    expect(modelName('gpt-5.5-codex')).toBe('GPT 5.5 Codex');
    expect(modelName('other')).toBe('Other');
    expect(['Opus', 'Fable', 'GPT'].map(modelName)).toEqual(['Opus 5.5', 'Fable 5.1', 'GPT Astra']);
  });
});
