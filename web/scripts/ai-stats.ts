// Fetches the About card's AI usage figures from WakaTime and writes public/ai-stats.json (git-ignored; the Pages workflow keeps the
// last good file in its cache). Run: `npm run ai-stats` with WAKATIME_API_KEY set; the projects and the first day to ask for are in
// ai-projects.json. Exits 0 without writing when the key is missing or a request fails, so the last good file stays.
import { readFileSync, writeFileSync } from 'node:fs';
import { sumSummaries, totalCost, type Summaries } from '../src/ai-stats';

const here = new URL('..', import.meta.url);
const { projects, start } = JSON.parse(readFileSync(new URL('ai-projects.json', here), 'utf8')) as { projects: string[]; start: string };
const key = process.env.WAKATIME_API_KEY;
if (!key) {
  console.warn('::warning::ai-stats: WAKATIME_API_KEY is not set; keeping the last ai-stats.json');
  process.exit(0);
}
const today = new Date().toISOString().slice(0, 10);
const auth = `Basic ${Buffer.from(key).toString('base64')}`;

async function summaries(project: string): Promise<Summaries> {
  const url = new URL('https://wakatime.com/api/v1/users/current/summaries');
  url.search = new URLSearchParams({ project, start, end: today }).toString();
  const res = await fetch(url, { headers: { Authorization: auth } });
  if (res.status === 404) {
    console.warn(`::warning::ai-stats: no WakaTime project named ${project}; counting it as empty`);
    return {};
  }
  if (!res.ok) throw new Error(`${project}: HTTP ${res.status}`);
  return (await res.json()) as Summaries;
}

try {
  const responses = await Promise.all(projects.map(summaries));
  const stats = sumSummaries(responses, projects, today);
  writeFileSync(new URL('public/ai-stats.json', here), `${JSON.stringify(stats, null, 2)}\n`);
  console.log(`ai-stats: ${(stats.seconds / 3600).toFixed(1)} h since ${stats.since ?? '-'}, $${totalCost(stats).toFixed(2)} across ${Object.keys(stats.costs).length} model(s)`);
} catch (e) {
  console.warn(`::warning::ai-stats: ${(e as Error).message}; keeping the last ai-stats.json`);
}
