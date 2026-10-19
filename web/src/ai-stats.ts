// The About card's AI usage figures. `scripts/ai-stats.ts` (run by the Pages workflow with the WAKATIME_API_KEY secret) sums the
// WakaTime summaries of the projects in `ai-projects.json` with `sumSummaries` and writes `public/ai-stats.json`; the card reads
// that file and formats it here. The prompt count comes from ai-prompts.ts.

/** what the build writes to public/ai-stats.json */
export interface AiStats {
  /** the day the numbers were fetched (YYYY-MM-DD) */
  asOf: string;
  /** the first day with tracked time (YYYY-MM-DD), or null when nothing was tracked */
  since: string | null;
  projects: string[];
  /** every category: coding, AI coding, debugging, browsing… */
  seconds: number;
  /** WakaTime's estimate at API token prices, per model, in USD (not a bill) */
  costs: Record<string, number>;
}

/** the parts of one day of `GET /users/current/summaries` this reads; WakaTime has put the AI fields on the day and on its grand_total */
interface Day {
  range?: { date?: string };
  grand_total?: { total_seconds?: number; ai_model_costs?: Record<string, number> };
  ai_model_costs?: Record<string, number>;
}

/** one project's summaries response */
export interface Summaries {
  data?: Day[];
}

/** adds up the summaries of several projects (one response per project) */
export function sumSummaries(responses: Summaries[], projects: string[], asOf: string): AiStats {
  let seconds = 0;
  let since: string | null = null;
  const costs: Record<string, number> = {};
  for (const r of responses) {
    for (const day of r.data ?? []) {
      const s = day.grand_total?.total_seconds ?? 0;
      seconds += s;
      const date = day.range?.date;
      if (s > 0 && date && (since === null || date < since)) since = date;
      for (const [model, usd] of Object.entries(day.ai_model_costs ?? day.grand_total?.ai_model_costs ?? {})) {
        if (Number.isFinite(usd) && usd > 0) costs[model] = (costs[model] ?? 0) + usd;
      }
    }
  }
  return { asOf, since, projects, seconds, costs };
}

/** "N hours", rounded to whole hours from 10 up */
export function formatHours(seconds: number): string {
  const h = seconds / 3600;
  if (h < 1) return `${Math.round(seconds / 60)} min`;
  return `${h < 10 ? h.toFixed(1) : Math.round(h).toLocaleString('en-US')} hours`;
}

/** "$1,234" (whole dollars from 100 up) */
export function formatUsd(usd: number): string {
  return usd < 100 ? `$${usd.toFixed(2)}` : `$${Math.round(usd).toLocaleString('en-US')}`;
}

export function totalCost(stats: AiStats): number {
  return Object.values(stats.costs).reduce((a, b) => a + b, 0);
}

/** the models' shares of the cost, largest first; models under 1 % are summed into "other" */
export function modelShares(stats: AiStats): { model: string; share: number }[] {
  const total = totalCost(stats);
  if (total <= 0) return [];
  const all = Object.entries(stats.costs).map(([model, usd]) => ({ model, share: usd / total })).sort((a, b) => b.share - a.share);
  const shown = all.filter((m) => m.share >= 0.01);
  const rest = all.filter((m) => m.share < 0.01).reduce((a, m) => a + m.share, 0);
  return rest > 0 ? [...shown, { model: 'other', share: rest }] : shown;
}

/** "Oct 17, 2026" from YYYY-MM-DD (read as a calendar day, not shifted by the time zone) */
export function formatDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

/** a fetched ai-stats.json is used only when it has the expected shape */
export function isAiStats(x: unknown): x is AiStats {
  const s = x as AiStats;
  return !!s && typeof s.asOf === 'string' && typeof s.seconds === 'number' && Array.isArray(s.projects) && !!s.costs && typeof s.costs === 'object';
}

/** WakaTime keys its costs by model family ("Opus", "Fable", "GPT"); the key names the versions used here (the owner's list) */
export const MODEL_VERSIONS: Record<string, string> = { Opus: 'Opus 5.5', Fable: 'Fable 5.1', GPT: 'GPT Astra' };

/** the model key's names: a family from MODEL_VERSIONS, else "Opus 5.5" from "claude-opus-5-5" (the Claude prefix dropped) */
export function modelName(id: string): string {
  if (MODEL_VERSIONS[id]) return MODEL_VERSIONS[id];
  const words: string[] = [];
  for (const w of id.split(/[-_ ]+/).filter(Boolean)) {
    const last = words[words.length - 1];
    if (/^\d+$/.test(w) && last !== undefined && /^\d+(\.\d+)*$/.test(last)) words[words.length - 1] = `${last}.${w}`;
    else words.push(/^(gpt|ai)$/i.test(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1));
  }
  if (words.length > 1 && words[0] === 'Claude') words.shift();
  return words.join(' ');
}
