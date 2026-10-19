// The About card's prompt count: how many prompts the owner typed into Claude Code and Codex while working in this repo. The
// transcripts live on the machines that ran the CLIs, so `scripts/ai-prompts.ts count` counts them there and `push` (run by the
// pre-push hook in .githooks) stores one machine's count as the GitHub Actions variable `AI_PROMPTS_<clone id>`; the Pages workflow
// hands all variables to `collect`, which sums them with `sumHosts` into public/ai-prompts.json.

/** one machine's (one clone's) count, the value of an AI_PROMPTS_* variable */
export interface HostCount {
  claude: number;
  codex: number;
  /** the day it was counted (YYYY-MM-DD) */
  asOf: string;
}

/** what the build writes to public/ai-prompts.json */
export interface AiPrompts {
  prompts: number;
  claude: number;
  codex: number;
  hosts: number;
  /** the newest host count's day (YYYY-MM-DD) */
  asOf: string;
}

export const VAR_PREFIX = 'AI_PROMPTS_';

/** Claude Code's built-in slash commands: they run in the CLI and are not prompts (a skill invoked by name is) */
const BUILTIN = new Set(['exit', 'compact', 'clear', 'model', 'config', 'login', 'logout', 'resume', 'continue', 'effort', 'fast', 'mcp',
  'status', 'cost', 'usage', 'context', 'help', 'memory', 'permissions', 'plugin', 'plugins', 'rewind', 'add-dir', 'hooks', 'agents',
  'ide', 'theme', 'vim', 'doctor', 'export', 'release-notes', 'statusline', 'terminal-setup', 'upgrade', 'bashes', 'tasks', 'todos',
  'output-style', 'privacy-settings', 'feedback', 'bug', 'artifacts', 'workflows', 'keybindings', 'copy', 'branch', 'rename']);

/** is this text of a user turn something the owner typed for the model (not a CLI command, its output, a notification, an interrupt) */
export function isPrompt(text: string): boolean {
  const t = text.trim();
  if (t === '') return false;
  const cmd = /<command-name>\/?([^<\s]+)<\/command-name>/.exec(t);
  if (cmd) return !BUILTIN.has(cmd[1]);
  return !/^(<local-command-|<command-|<bash-|<task-notification>|<system-reminder>|\[Request interrupted|Caveat:)/.test(t);
}

/** is `cwd` the clone's root or inside it */
export function inside(cwd: unknown, root: string): boolean {
  return typeof cwd === 'string' && (cwd === root || cwd.startsWith(root.endsWith('/') ? root : `${root}/`));
}

interface ClaudeLine {
  type?: string;
  uuid?: string;
  cwd?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  isCompactSummary?: boolean;
  message?: { content?: string | { type?: string; text?: string }[] };
}

/** adds the prompts of Claude Code transcript lines (JSONL) run inside `root` to `seen` (keyed by uuid: resumed sessions repeat their history) */
export function claudePrompts(lines: Iterable<string>, root: string, seen: Set<string>): void {
  for (const line of lines) {
    if (!line.includes('"user"')) continue;
    let e: ClaudeLine;
    try { e = JSON.parse(line) as ClaudeLine; } catch { continue; }
    if (e.type !== 'user' || e.isMeta || e.isSidechain || e.isCompactSummary || !e.uuid || !inside(e.cwd, root)) continue;
    const c = e.message?.content;
    const text = typeof c === 'string' ? c : (c ?? []).filter((p) => p.type === 'text').map((p) => p.text ?? '').join(' ');
    if (isPrompt(text)) seen.add(e.uuid);
  }
}

/** the prompts of one Codex session (JSONL), 0 unless its session_meta says it ran inside `root` */
export function codexPrompts(lines: Iterable<string>, root: string): number {
  let n = 0;
  let ours: boolean | null = null;
  for (const line of lines) {
    let e: { type?: string; payload?: { type?: string; cwd?: string } };
    try { e = JSON.parse(line) as typeof e; } catch { continue; }
    if (ours === null && e.type === 'session_meta') {
      ours = inside(e.payload?.cwd, root);
      if (!ours) return 0;
    } else if (e.type === 'event_msg' && e.payload?.type === 'user_message') n++;
  }
  return ours ? n : 0;
}

function isHostCount(x: unknown): x is HostCount {
  const h = x as HostCount;
  return !!h && Number.isFinite(h.claude) && Number.isFinite(h.codex) && typeof h.asOf === 'string';
}

/** sums the AI_PROMPTS_* entries of the workflow's `vars` (values are HostCount JSON; bad ones are skipped); null when there are none */
export function sumHosts(vars: Record<string, string>): AiPrompts | null {
  const out: AiPrompts = { prompts: 0, claude: 0, codex: 0, hosts: 0, asOf: '' };
  for (const [name, value] of Object.entries(vars)) {
    if (!name.startsWith(VAR_PREFIX)) continue;
    let h: unknown;
    try { h = JSON.parse(value); } catch { continue; }
    if (!isHostCount(h)) continue;
    out.claude += h.claude;
    out.codex += h.codex;
    out.hosts++;
    if (h.asOf > out.asOf) out.asOf = h.asOf;
  }
  out.prompts = out.claude + out.codex;
  return out.hosts > 0 ? out : null;
}

/** a fetched ai-prompts.json is used only when it has the expected shape */
export function isAiPrompts(x: unknown): x is AiPrompts {
  const p = x as AiPrompts;
  return !!p && Number.isFinite(p.prompts) && typeof p.asOf === 'string';
}
