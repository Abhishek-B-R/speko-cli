import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CallEvent, FollowOptions } from './call.js';

/**
 * `speko-cli logs <id> --follow --json` printed nothing at all.
 *
 * Events go to `out.text` and the timeout notice with them, and `--json`
 * suppresses text. So a script following a call in JSON mode read an empty
 * stdout and an exit code of 0, which says "no events" rather than "still
 * running after ten minutes" or "here is what happened".
 *
 * `followEvents` is stubbed because the command hardcodes a 600s deadline and
 * the real `sleep`. What is under test is what the command prints, not the
 * polling, which `call.spec.ts` covers.
 */
vi.mock('./credentials.js', () => ({
  readCredentials: () => null,
  userAgent: () => 'speko-cli/test',
  writeCredentials: () => undefined,
  clearCredentials: () => undefined,
  credentialsPath: () => '/tmp/nonexistent/credentials.json',
}));

const followEvents = vi.fn<(id: string, options: FollowOptions) => Promise<{ timedOut: boolean }>>();

vi.mock('./call.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./call.js')>()),
  followEvents: (id: string, options: FollowOptions) => followEvents(id, options),
}));

vi.stubGlobal(
  'fetch',
  vi.fn(() => {
    throw new Error('a followed log must not reach the network here');
  }),
);

const { run } = await import('./index.js');
const { EXIT } = await import('./constants.js');

const event = (id: string, type: string): CallEvent => ({
  id,
  event_type: type,
  occurred_at: '2026-09-24T09:15:32.000Z',
});

let out: string[];

beforeEach(() => {
  out = [];
  followEvents.mockReset();
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void out.push(a.join(' ')));
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('logs --follow --json', () => {
  it('prints the events and says the call timed out', async () => {
    followEvents.mockImplementation(async (_id, options) => {
      options.onEvent(event('e1', 'call.started'));
      options.onEvent(event('e2', 'call.ringing'));
      return { timedOut: true };
    });

    expect(await run(['logs', 'sess_1', '--follow', '--json'])).toBe(EXIT.ok);

    const document = JSON.parse(out.join('\n'));
    expect(document.timed_out).toBe(true);
    expect(document.events.map((e: CallEvent) => e.event_type)).toEqual([
      'call.started',
      'call.ringing',
    ]);
  });

  it('says so when the call ended, so `timed_out` is always there to branch on', async () => {
    followEvents.mockImplementation(async (_id, options) => {
      options.onEvent(event('e1', 'call.completed'));
      return { timedOut: false };
    });

    expect(await run(['logs', 'sess_1', '--follow', '--json'])).toBe(EXIT.ok);

    const document = JSON.parse(out.join('\n'));
    expect(document).toEqual({
      events: [event('e1', 'call.completed')],
      timed_out: false,
    });
  });

  it('passes the id it was given', async () => {
    followEvents.mockResolvedValue({ timedOut: false });
    await run(['logs', 'sess_abc', '--follow', '--json']);
    expect(followEvents.mock.calls[0]?.[0]).toBe('sess_abc');
  });
});

describe('logs --follow without --json', () => {
  it('still streams one line per event and no JSON', async () => {
    followEvents.mockImplementation(async (_id, options) => {
      options.onEvent(event('e1', 'call.started'));
      return { timedOut: false };
    });

    expect(await run(['logs', 'sess_1', '--follow'])).toBe(EXIT.ok);
    expect(out).toEqual(['09:15:32  call.started']);
  });

  it('tells a human the call is still running when it times out', async () => {
    followEvents.mockResolvedValue({ timedOut: true });

    expect(await run(['logs', 'sess_1', '--follow'])).toBe(EXIT.ok);
    expect(out.join('\n')).toContain('Still running after 600s');
    expect(out.join('\n')).toContain('speko-cli logs sess_1 --follow');
  });
});
