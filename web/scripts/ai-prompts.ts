// The prompt count for the About card (src/ai-prompts.ts has the rules).
//   npm run ai-prompts             counts this clone's Claude Code and Codex prompts and prints them
//   npm run ai-prompts -- push     ...and stores them as the repo's Actions variable AI_PROMPTS_<clone id> (the pre-push hook runs this)
//   npm run ai-prompts -- collect  (CI) sums the variables in $GH_VARS (the workflow's toJSON(vars)) into public/ai-prompts.json
// push and collect never fail the caller: on any error they warn and exit 0.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { claudePrompts, codexPrompts, sumHosts, VAR_PREFIX, type HostCount } from '../src/ai-prompts';

const mode = process.argv[2] ?? 'count';
const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).trim();

/** the main clone's root (worktrees under .claude/worktrees are inside it) and its git dir */
function clone(): { root: string; gitDir: string } {
  const gitDir = git('rev-parse', '--path-format=absolute', '--git-common-dir');
  return { root: dirname(gitDir), gitDir };
}

function lines(file: string): string[] {
  return readFileSync(file, 'utf8').split('\n');
}

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

function count(root: string): HostCount {
  // Claude Code: ~/.claude/projects/<cwd with every non-alphanumeric as ->/<session>.jsonl (subagent runs sit in subfolders: skipped)
  const projects = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects');
  const prefix = root.replace(/[^a-zA-Z0-9]/g, '-');
  const seen = new Set<string>();
  if (existsSync(projects)) {
    for (const d of readdirSync(projects).filter((d) => d.startsWith(prefix))) {
      for (const f of readdirSync(join(projects, d)).filter((f) => f.endsWith('.jsonl'))) claudePrompts(lines(join(projects, d, f)), root, seen);
    }
  }
  // Codex: ~/.codex/sessions/YYYY/MM/DD/*.jsonl, the first line names the working directory
  let codex = 0;
  for (const f of walk(join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'sessions'))) codex += codexPrompts(lines(f), root);
  return { claude: seen.size, codex, asOf: new Date().toISOString().slice(0, 10) };
}

/** a random id per clone, kept in its git dir (two clones count different transcripts, so each has its own variable) */
function cloneId(gitDir: string): string {
  const file = join(gitDir, 'ai-prompts-id');
  if (!existsSync(file)) writeFileSync(file, `${randomBytes(4).toString('hex').toUpperCase()}\n`);
  return readFileSync(file, 'utf8').trim();
}

/** owner/name of the origin remote on GitHub */
function repo(): string {
  const url = git('remote', 'get-url', 'origin');
  const m = /github\.com[:/](.+?)(\.git)?$/.exec(url);
  if (!m) throw new Error(`origin is not on GitHub: ${url}`);
  return m[1];
}

try {
  if (mode === 'collect') {
    const sum = sumHosts(JSON.parse(process.env.GH_VARS || '{}') as Record<string, string>);
    if (!sum) console.warn(`::warning::ai-prompts: no ${VAR_PREFIX}* variables; the card shows a dash`);
    else {
      writeFileSync(new URL('../public/ai-prompts.json', import.meta.url), `${JSON.stringify(sum, null, 2)}\n`);
      console.log(`ai-prompts: ${sum.prompts} (claude ${sum.claude}, codex ${sum.codex}) from ${sum.hosts} clone(s), newest ${sum.asOf}`);
    }
  } else {
    const { root, gitDir } = clone();
    const c = count(root);
    console.log(`ai-prompts: ${c.claude + c.codex} prompts in ${root} (claude ${c.claude}, codex ${c.codex})`);
    if (mode === 'push') {
      const name = `${VAR_PREFIX}${cloneId(gitDir)}`;
      execFileSync('gh', ['variable', 'set', name, '--repo', repo(), '--body', JSON.stringify(c)], { stdio: ['ignore', 'ignore', 'inherit'] });
      console.log(`ai-prompts: stored as ${name}`);
    } else if (mode !== 'count') throw new Error(`unknown mode ${mode}`);
  }
} catch (e) {
  console.warn(`ai-prompts: ${(e as Error).message}`);
}
