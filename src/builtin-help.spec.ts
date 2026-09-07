import { describe, expect, it } from 'vitest';
import { BUILTIN_HELP, builtinHelpFor, wantsHelp } from './builtin-help.js';

/**
 * The regression these guard is the worst one this CLI has had: `login --help`
 * did not print help, it started a real device grant, wrote a pending row to
 * the database and blocked for fifteen minutes. A coding agent ran the single
 * most obvious command for learning an unfamiliar tool and had to kill the task
 * to recover.
 */

/** Every command with a hand-written body, i.e. not in the generated table. */
const HAND_WRITTEN = [
  'login',
  'logout',
  'whoami',
  'auth',
  'init',
  'call',
  'logs',
  'explain',
  'doctor',
  'bench',
  'eval',
  'mcp',
] as const;

describe('builtin help', () => {
  it('covers every hand-written command', () => {
    // A command missing from here falls through to its body, which is exactly
    // how `login --help` came to log people in.
    for (const command of HAND_WRITTEN) {
      expect(builtinHelpFor(command), `no help for ${command}`).not.toBeNull();
    }
  });

  it('documents nothing that is not a command', () => {
    for (const key of Object.keys(BUILTIN_HELP)) {
      expect(HAND_WRITTEN as readonly string[]).toContain(key);
    }
  });

  it('leads every entry with its own usage line', () => {
    for (const command of HAND_WRITTEN) {
      expect(builtinHelpFor(command)?.[0]).toMatch(new RegExp(`^speko-cli ${command}\\b`));
    }
  });

  it('returns null for a generated command, which prints its own help', () => {
    expect(builtinHelpFor('agents')).toBeNull();
    expect(builtinHelpFor('telephony')).toBeNull();
  });

  it('tells the reader that login needs a person', () => {
    const text = (builtinHelpFor('login') ?? []).join('\n');
    expect(text).toMatch(/human approves it in a browser/);
    expect(text).toMatch(/--no-wait/);
    // The line that stops an agent from running a command that hangs it.
    expect(text).toMatch(/not a\s*\n?\s*terminal|is not a terminal/);
  });
});

describe('wantsHelp', () => {
  it('accepts both spellings, anywhere in the arguments', () => {
    expect(wantsHelp(['login', '--help'])).toBe(true);
    expect(wantsHelp(['call', '-h'])).toBe(true);
    expect(wantsHelp(['agents', 'get', 'agent_1', '--help'])).toBe(true);
  });

  it('is not fooled by a value that merely contains it', () => {
    expect(wantsHelp(['call', '--prompt', 'please help the caller'])).toBe(false);
    expect(wantsHelp(['logs', 'sess_help'])).toBe(false);
  });
});
