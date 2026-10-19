import { describe, expect, it } from 'vitest';
import { claudePrompts, codexPrompts, inside, isAiPrompts, isPrompt, sumHosts } from './ai-prompts';

const ROOT = '/home/me/modular-1';
const user = (uuid: string, content: unknown, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ type: 'user', uuid, cwd: `${ROOT}/web`, message: { role: 'user', content }, ...extra });

describe('prompt count', () => {
  it('tells typed prompts from CLI commands, their output, notifications and interrupts', () => {
    expect(isPrompt('make the bars blue')).toBe(true);
    expect(isPrompt('[Image #1] the cable is wrong')).toBe(true);
    expect(isPrompt('<command-message>grill-me</command-message>\n<command-name>/grill-me</command-name>')).toBe(true);
    for (const t of ['', '  ', '<command-name>/exit</command-name>', '<command-name>/compact</command-name>', '<local-command-stdout>ok</local-command-stdout>',
      '<task-notification>done</task-notification>', '<bash-input>ls</bash-input>', '[Request interrupted by user]', 'Caveat: the messages below…']) {
      expect(isPrompt(t)).toBe(false);
    }
  });

  it('a working directory counts when it is the clone or inside it, not a sibling', () => {
    expect(inside(ROOT, ROOT)).toBe(true);
    expect(inside(`${ROOT}/.claude/worktrees/x`, ROOT)).toBe(true);
    expect(inside(`${ROOT}-native`, ROOT)).toBe(false);
    expect(inside(undefined, ROOT)).toBe(false);
  });

  it('counts Claude Code user turns once per uuid, skipping tool results, meta, subagent, summaries and other repos', () => {
    const seen = new Set<string>();
    const lines = [
      user('a', 'first prompt'),
      user('a', 'first prompt'), // a resumed session repeats it
      user('b', [{ type: 'text', text: 'second' }, { type: 'image' }]),
      user('c', [{ type: 'tool_result', content: 'x' }]),
      user('d', 'skill text', { isMeta: true }),
      user('e', 'agent prompt', { isSidechain: true }),
      user('f', 'summary', { isCompactSummary: true }),
      user('g', 'elsewhere', { cwd: '/home/me/other' }),
      JSON.stringify({ type: 'assistant', uuid: 'h', cwd: ROOT, message: { content: 'hi' } }),
      'not json',
    ];
    claudePrompts(lines, ROOT, seen);
    expect([...seen]).toEqual(['a', 'b']);
  });

  it('counts a Codex session\'s user messages only when it ran in the clone', () => {
    const meta = (cwd: string) => JSON.stringify({ type: 'session_meta', payload: { cwd } });
    const msg = JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'hi' } });
    const other = JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message' } });
    expect(codexPrompts([meta(ROOT), msg, other, msg], ROOT)).toBe(2);
    expect(codexPrompts([meta('/elsewhere'), msg], ROOT)).toBe(0);
    expect(codexPrompts([msg], ROOT)).toBe(0);
  });

  it('sums the clones\' variables, skipping other variables and bad values', () => {
    const sum = sumHosts({
      AI_PROMPTS_AB12: JSON.stringify({ claude: 400, codex: 88, asOf: '2026-10-19' }),
      AI_PROMPTS_CD34: JSON.stringify({ claude: 100, codex: 4, asOf: '2026-10-12' }),
      AI_PROMPTS_BAD: 'nope',
      OTHER: JSON.stringify({ claude: 1, codex: 1, asOf: '2026-10-20' }),
    });
    expect(sum).toEqual({ prompts: 592, claude: 500, codex: 92, hosts: 2, asOf: '2026-10-19' });
    expect(isAiPrompts(sum)).toBe(true);
    expect(sumHosts({ OTHER: '1' })).toBeNull();
    expect(isAiPrompts({ asOf: 'x' })).toBe(false);
  });
});
