import { describe, expect, it } from 'vitest';
import { COMMAND_GROUPS, COMMANDS } from './generated/commands.js';
import { describeCommand, findCommand, groupHelp, parseFlags, unwrapList } from './run-command.js';

describe('parseFlags', () => {
  it('accepts both --flag value and --flag=value', () => {
    expect(parseFlags(['--limit', '10']).flags).toEqual({ limit: '10' });
    expect(parseFlags(['--limit=10']).flags).toEqual({ limit: '10' });
  });

  it('treats a bare flag as true', () => {
    expect(parseFlags(['--all']).flags).toEqual({ all: 'true' });
    expect(parseFlags(['--all', '--limit', '5']).flags).toEqual({ all: 'true', limit: '5' });
  });

  it('keeps positionals in order, which is how path params are bound', () => {
    expect(parseFlags(['agent_1', '--limit', '5', 'second']).positionals).toEqual([
      'agent_1',
      'second',
    ]);
  });

  it('does not swallow a value that looks like a flag', () => {
    // `--data --limit` must not consume `--limit` as data; that would silently
    // drop an option and send the wrong request.
    const { flags } = parseFlags(['--data', '--limit', '5']);
    expect(flags['data']).toBe('true');
    expect(flags['limit']).toBe('5');
  });
});

describe('findCommand', () => {
  it('resolves the canonical name and the REST alias to the same operation', () => {
    const byName = findCommand('agents', 'get-agent').command;
    const byAlias = findCommand('agents', 'get').command;
    expect(byName?.operationId).toBe('getAgent');
    expect(byAlias?.operationId).toBe('getAgent');
  });

  it('returns the group so an unknown command can list what exists', () => {
    const { command, groupCommands } = findCommand('agents', 'nope');
    expect(command).toBeNull();
    expect(groupCommands.length).toBeGreaterThan(0);
  });

  it('reports an unknown group as empty rather than throwing', () => {
    expect(findCommand('not-a-group', 'x')).toEqual({ command: null, groupCommands: [] });
  });
});

describe('the generated table', () => {
  it('covers every group and has no duplicate names within one', () => {
    expect(COMMAND_GROUPS.length).toBeGreaterThan(0);
    for (const group of COMMAND_GROUPS) {
      const names = COMMANDS.filter((c) => c.group === group).map((c) => c.name);
      expect(new Set(names).size).toBe(names.length);
    }
  });

  it('never offers the same alias twice in a group', () => {
    // The generator drops an alias claimed by two operations; if that ever
    // regresses, `speko-cli sms list` becomes a coin toss.
    for (const group of COMMAND_GROUPS) {
      const aliases = COMMANDS.filter((c) => c.group === group).flatMap((c) => c.aliases);
      expect(new Set(aliases).size).toBe(aliases.length);
    }
  });

  it('declares every placeholder its path template contains', () => {
    // The spec under-declares path parameters, so the generator reads the
    // template. A missing one means sending a literal `{callId}` to the server.
    for (const command of COMMANDS) {
      const inPath = [...command.path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
      expect(command.pathParams.map((p) => p.name)).toEqual(inPath);
    }
  });

  it('picked up the operations whose parameters the spec omits', () => {
    const call = COMMANDS.find((c) => c.operationId === 'getHumanCall');
    expect(call?.pathParams.map((p) => p.name)).toEqual(['callId']);
    const leg = COMMANDS.find((c) => c.operationId === 'commandHumanCallLeg');
    expect(leg?.pathParams.map((p) => p.name)).toEqual(['controlId', 'command']);
  });
});

describe('help output', () => {
  it('shows the invocation, the endpoint and the arguments', () => {
    const command = COMMANDS.find((c) => c.operationId === 'getAgent');
    if (!command) throw new Error('getAgent missing from the generated table');
    const text = describeCommand(command).join('\n');

    expect(text).toContain('speko-cli agents get-agent <id>');
    expect(text).toContain('GET /v1/agents/{id}');
    expect(text).toContain('Alias: speko-cli agents get');
  });

  it('tells the reader how to supply a body when one is needed', () => {
    const command = COMMANDS.find((c) => c.operationId === 'createAgent');
    if (!command) throw new Error('createAgent missing from the generated table');
    const text = describeCommand(command).join('\n');
    expect(text).toContain('--data JSON');
    expect(text).toContain('--file PATH');
  });

  it('lists a group with its aliases', () => {
    const text = groupHelp(
      'agents',
      COMMANDS.filter((c) => c.group === 'agents'),
    ).join('\n');
    expect(text).toContain('list-agents');
    expect(text).toContain('(list)');
  });
});

describe('unwrapList', () => {
  it('uses the key the spec declares, not a guess', () => {
    // `/sessions` wraps in `entries`, `/webhooks` in `data`, `/voices` in
    // `voices`. All three are declared correctly in the spec, so nothing has to
    // try candidate names in order — which is what the first version did, and
    // it failed silently the moment an endpoint used a word not on its list.
    expect(unwrapList<{ id: string }>('/sessions', 'GET', { entries: [{ id: 's' }] })).toEqual([
      { id: 's' },
    ]);
    expect(unwrapList('/webhooks', 'GET', { data: [1, 2] })).toEqual([1, 2]);
    expect(unwrapList('/voices', 'GET', { voices: [1], providers: [2] })).toEqual([1]);
  });

  it('treats a bare-array operation as the list itself', () => {
    expect(unwrapList('/agents', 'GET', [{ id: 'a' }])).toEqual([{ id: 'a' }]);
  });

  it('returns empty when the declared key is absent or not a list', () => {
    expect(unwrapList('/sessions', 'GET', {})).toEqual([]);
    expect(unwrapList('/sessions', 'GET', { entries: 'nope' })).toEqual([]);
    expect(unwrapList('/agents', 'GET', { wrapped: [] })).toEqual([]);
  });

  it('throws for a path with no generated command', () => {
    // A programming error, not runtime data. Falling back to a guess here is
    // how the silent-pass got in.
    expect(() => unwrapList('/not-a-real-path', 'GET', {})).toThrow(/No generated command/);
  });
});

describe('responseListKey in the generated table', () => {
  it('picks the resource-named key when several arrays are present', () => {
    // `/voices` returns both `voices` and `providers`. A "single array" rule
    // gave up and returned null, and the CLI then read an empty list.
    const voices = COMMANDS.find((c) => c.operationId === 'listVoices');
    expect(voices?.responseListKey).toBe('voices');
  });

  it('declines to pick when there is no single list', () => {
    // Four arrays, none of them "the" list.
    const providers = COMMANDS.find((c) => c.operationId === 'getKnownProviders');
    expect(providers?.responseListKey).toBeNull();
  });

  it('is null for a bare array', () => {
    expect(COMMANDS.find((c) => c.operationId === 'listAgents')?.responseListKey).toBeNull();
  });
});

describe('group help', () => {
  it('treats --help on a group as the listing request it is', () => {
    // `speko-cli agents --help` used to print `Unknown command: speko-cli
    // agents --help`, then the listing anyway, and exit 2 — answering the
    // question while insisting it had not understood it. The most natural way
    // to discover a group led with an error.
    const { command, groupCommands } = findCommand('agents', '--help');
    expect(command).toBeNull();
    expect(groupCommands.length).toBeGreaterThan(0);
  });
});
