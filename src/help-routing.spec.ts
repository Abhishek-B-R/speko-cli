import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * END-TO-END routing for `--help`, through `run()` rather than through
 * `findCommand`.
 *
 * The unit test on `findCommand` passed while the routing was wrong, which is
 * the reason these exist: the group branch searched the WHOLE argument list for
 * a help flag, so `speko-cli agents bogus --help` printed the group listing and
 * exited 0 — turning a typo into a success. Only a test that drives `run()` and
 * reads the exit code catches that.
 *
 * Credentials are stubbed absent to prove none of these paths touch the network:
 * asking what a command does must never require being signed in.
 */
vi.mock('./credentials.js', () => ({
  readCredentials: () => null,
  userAgent: () => 'speko-cli/test',
  writeCredentials: () => undefined,
  clearCredentials: () => undefined,
  credentialsPath: () => '/tmp/nonexistent/credentials.json',
}));

const fetchSpy = vi.fn(() => {
  throw new Error('help must not reach the network');
});
vi.stubGlobal('fetch', fetchSpy);

const { run } = await import('./index.js');
const { EXIT } = await import('./constants.js');

let out: string[];
let err: string[];

beforeEach(() => {
  out = [];
  err = [];
  fetchSpy.mockClear();
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void out.push(a.join(' ')));
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void err.push(a.join(' ')));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('`--help` on a generated group', () => {
  it('lists the group and exits 0', async () => {
    expect(await run(['agents', '--help'])).toBe(EXIT.ok);
    expect(out.join('\n')).toContain('speko-cli agents');
    expect(err).toEqual([]);
  });

  it('accepts the short form too', async () => {
    expect(await run(['agents', '-h'])).toBe(EXIT.ok);
    expect(out.join('\n')).toContain('operations');
  });

  it('still lists the group when no subcommand is given', async () => {
    expect(await run(['agents'])).toBe(EXIT.ok);
    expect(err).toEqual([]);
  });
});

describe('a trailing `--help` does not excuse an unknown subcommand', () => {
  it('fails `agents bogus --help` as a usage error', async () => {
    // The regression. A help flag AFTER the subcommand belongs to that
    // subcommand; it cannot conjure one that does not exist.
    expect(await run(['agents', 'bogus', '--help'])).toBe(EXIT.usage);
    expect(err.join('\n')).toContain('Unknown command: speko-cli agents bogus');
  });

  it('fails it identically without the flag', async () => {
    expect(await run(['agents', 'bogus'])).toBe(EXIT.usage);
  });

  it('fails an unknown group whatever follows it', async () => {
    expect(await run(['nonsense', '--help'])).toBe(EXIT.usage);
    expect(await run(['nonsense'])).toBe(EXIT.usage);
  });
});

describe('`--help` on a leaf command', () => {
  it('describes the operation and exits 0', async () => {
    expect(await run(['agents', 'list', '--help'])).toBe(EXIT.ok);
    expect(out.join('\n')).toContain('List agents');
  });

  it('works through a REST alias', async () => {
    expect(await run(['agents', 'get', '--help'])).toBe(EXIT.ok);
  });
});

describe('help never performs the action', () => {
  it('reaches no network for any help form', async () => {
    // `login --help` once started a real device grant and blocked for fifteen
    // minutes. Nothing here may touch the wire.
    for (const argv of [
      ['agents', '--help'],
      ['agents', 'list', '--help'],
      ['agents', 'bogus', '--help'],
      ['login', '--help'],
      ['eval', '--help'],
      ['bench', '--help'],
    ]) {
      await run(argv);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('needs no credential, for every hand-written command', async () => {
    const { BUILTIN_HELP } = await import('./builtin-help.js');
    for (const name of Object.keys(BUILTIN_HELP)) {
      expect(await run([name, '--help']), `${name} --help`).toBe(EXIT.ok);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
