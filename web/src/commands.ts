// SPDX-License-Identifier: GPL-3.0-only
import { score } from './fuzzy';

/** a key held with ⏎ that picks one of a command's other places */
export type CommandKey = 'shift' | 'alt';

/** another place an add command can put its card: an effect goes on the canvas with ⏎, into the current instrument's FX
 *  drawer with ⇧⏎ and into the Output FX with ⌥⏎ */
export interface CommandAlso {
  key: CommandKey;
  label: string;
  run: () => void;
}

export interface Command {
  kind: string;
  label: string;
  detail?: string;
  tags?: string[];
  keywords?: string;
  run: () => void;
  /** the other places it can add to, by the key held with ⏎ (shown under the selected row) */
  also?: CommandAlso[];
}

/** the type words a query can filter by, each with its plural */
const TYPES: Record<string, string> = { module: 'module', modules: 'module', assembly: 'assembly', assemblies: 'assembly', engine: 'engine', engines: 'engine', effect: 'effect', effects: 'effect' };

/** the key a ⏎ press held, if any (⇧ before ⌥ when both are held) */
export const keyOf = (e: { shiftKey: boolean; altKey: boolean }): CommandKey | null => (e.shiftKey ? 'shift' : e.altKey ? 'alt' : null);

/** what ⏎ with `key` held runs: the other place for that key, else the command itself */
export const runFor = (command: Command, key: CommandKey | null): (() => void) =>
  (key && command.also?.find((a) => a.key === key)?.run) || command.run;

/** Search every word across the name, action, shelf and description; prefer name matches. */
export function searchCommands(commands: Command[], query: string): Command[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return commands;
  return commands.map((command) => {
    let rank = 0;
    for (const word of words) {
      const type = TYPES[word];
      if (type) {
        const tagged = command.tags?.includes(type) || command.kind.split(' ').includes(type);
        const action = command.kind === 'command' && command.label.toLowerCase().includes(type);
        if (!tagged && !action) return { command, rank: -1 };
        rank += tagged ? 100 : 0;
        continue;
      }
      const name = score(word, command.label);
      const context = score(word, `${command.kind} ${command.tags?.join(' ') ?? ''} ${command.detail ?? ''} ${command.keywords ?? ''}`);
      if (name < 0 && context < 0) return { command, rank: -1 };
      rank += name >= 0 ? name + 100 : context;
    }
    return { command, rank };
  }).filter((r) => r.rank >= 0).sort((a, b) => b.rank - a.rank).map((r) => r.command);
}
