import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { readPending } from './credentials.js';
import {
  CLI_CLIENT_ID,
  LoginError,
  pollForToken,
  requestDeviceCode,
  resumeLogin,
} from './device-login.js';

const CODE = {
  device_code: 'dev-abc',
  user_code: 'WDJBMJHT',
  verification_uri: 'https://platform.speko.ai/device',
  expires_in: 60,
  interval: 5,
};

interface Reply {
  readonly status: number;
  readonly body: unknown;
  /** Raw text, for asserting on a body that is not JSON at all. */
  readonly text?: string;
}

const jsonResponse = (status: number, body: unknown): Reply => ({ status, body });

/**
 * Queues replies so a poll loop can be driven deterministically, constructing a
 * FRESH `Response` per call. A `Response` body is a stream that can only be
 * read once, so handing the same object back on a second poll would surface as
 * an empty body and a misleading generic error — which is exactly what the
 * first version of this helper did.
 */
function fetchSequence(replies: readonly Reply[]): typeof fetch {
  let index = 0;
  return (async () => {
    const reply = replies[Math.min(index, replies.length - 1)];
    index += 1;
    if (!reply) throw new Error('fetchSequence exhausted');
    const payload = reply.text ?? JSON.stringify(reply.body);
    return new Response(payload, {
      status: reply.status,
      headers: { 'Content-Type': reply.text ? 'text/html' : 'application/json' },
    });
  }) as unknown as typeof fetch;
}

/** Advances a fake clock by exactly the interval the CLI was told to wait. */
function fakeClock() {
  let current = 0;
  return {
    now: () => current,
    wait: async (ms: number) => {
      current += ms;
    },
    elapsed: () => current,
  };
}

describe('requestDeviceCode', () => {
  it('sends the CLI client id and returns the server codes', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify(CODE), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    ) as unknown as typeof fetch;
    const result = await requestDeviceCode(fetchImpl);

    expect(result.user_code).toBe('WDJBMJHT');
    expect(result.interval).toBe(5);
    const body = JSON.parse(
      (vi.mocked(fetchImpl).mock.calls[0]?.[1]?.body ?? '{}') as string,
    ) as Record<string, unknown>;
    expect(body['client_id']).toBe(CLI_CLIENT_ID);
  });

  it('explains invalid_client as an unregistered build, not a bad password', async () => {
    // This is the failure when seed-cli-oauth-client.ts has not run against the
    // environment. Without a specific message it reads as "your login is
    // wrong", which sends the user to reset a password that is fine.
    const fetchImpl = fetchSequence([jsonResponse(400, { error: 'invalid_client' })]);
    await expect(requestDeviceCode(fetchImpl)).rejects.toThrow(/not registered with the server/);
  });

  it('reports a non-JSON body as an unexpected response', async () => {
    const fetchImpl = fetchSequence([{ status: 200, body: null, text: '<html>SSO wall</html>' }]);
    await expect(requestDeviceCode(fetchImpl)).rejects.toBeInstanceOf(LoginError);
  });

  it('rejects a response missing the codes rather than proceeding', async () => {
    const fetchImpl = fetchSequence([jsonResponse(200, { user_code: 'X' })]);
    await expect(requestDeviceCode(fetchImpl)).rejects.toThrow(/usable device code/);
  });
});

describe('pollForToken', () => {
  it('keeps waiting through authorization_pending, then stores the token', async () => {
    const clock = fakeClock();
    const outcome = await pollForToken(CODE, {
      fetchImpl: fetchSequence([
        jsonResponse(400, { error: 'authorization_pending' }),
        jsonResponse(400, { error: 'authorization_pending' }),
        jsonResponse(200, { access_token: 'sess-xyz', token_type: 'Bearer', expires_in: 604800 }),
      ]),
      now: clock.now,
      wait: clock.wait,
    });

    expect(outcome.kind).toBe('approved');
    if (outcome.kind !== 'approved') return;
    expect(outcome.credentials.accessToken).toBe('sess-xyz');
    // Three polls at the 5s interval it was given.
    expect(clock.elapsed()).toBe(15_000);
  });

  it('widens the interval permanently after slow_down', async () => {
    const clock = fakeClock();
    const outcome = await pollForToken(CODE, {
      fetchImpl: fetchSequence([
        jsonResponse(400, { error: 'slow_down' }),
        jsonResponse(200, { access_token: 'sess-xyz', token_type: 'Bearer', expires_in: 60 }),
      ]),
      now: clock.now,
      wait: clock.wait,
    });

    expect(outcome.kind).toBe('approved');
    // 5s for the first poll, then 10s — not back to 5s. Springing straight back
    // is how a client ends up alternating slow_down forever.
    expect(clock.elapsed()).toBe(15_000);
  });

  it('returns denied when the human rejects it', async () => {
    const clock = fakeClock();
    const outcome = await pollForToken(CODE, {
      fetchImpl: fetchSequence([jsonResponse(400, { error: 'access_denied' })]),
      now: clock.now,
      wait: clock.wait,
    });
    expect(outcome.kind).toBe('denied');
  });

  it('returns expired on expired_token', async () => {
    const clock = fakeClock();
    const outcome = await pollForToken(CODE, {
      fetchImpl: fetchSequence([jsonResponse(400, { error: 'expired_token' })]),
      now: clock.now,
      wait: clock.wait,
    });
    expect(outcome.kind).toBe('expired');
  });

  it('gives up at the deadline instead of polling forever', async () => {
    const clock = fakeClock();
    const outcome = await pollForToken(
      { ...CODE, expires_in: 12 },
      {
        fetchImpl: fetchSequence([jsonResponse(400, { error: 'authorization_pending' })]),
        now: clock.now,
        wait: clock.wait,
      },
    );
    expect(outcome.kind).toBe('expired');
    expect(clock.elapsed()).toBeLessThanOrEqual(15_000);
  });

  it('survives a dropped request mid-poll', async () => {
    // A network blip is not a failed login — the approval may still be coming.
    const clock = fakeClock();
    let call = 0;
    const fetchImpl = (async () => {
      call += 1;
      if (call === 1) throw new Error('ECONNRESET');
      return new Response(
        JSON.stringify({ access_token: 'sess-xyz', token_type: 'Bearer', expires_in: 60 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const outcome = await pollForToken(CODE, { fetchImpl, now: clock.now, wait: clock.wait });
    expect(outcome.kind).toBe('approved');
  });

  it('raises rather than storing nothing when the server approves with no token', async () => {
    const clock = fakeClock();
    await expect(
      pollForToken(CODE, {
        fetchImpl: fetchSequence([jsonResponse(200, { token_type: 'Bearer' })]),
        now: clock.now,
        wait: clock.wait,
      }),
    ).rejects.toThrow(/no token/);
  });
});

describe('resumeLogin', () => {
  const live = {
    deviceCode: 'dev-abc',
    userCode: 'WDJBMJHT',
    verificationUri: 'https://platform.speko.ai/device?user_code=WDJB-MJHT',
    intervalSeconds: 5,
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    apiUrl: 'http://localhost:3100',
  };

  it('reports pending without waiting, which is what lets an agent hand over', () => {
    // The whole reason this function exists: an agent cannot run a command that
    // blocks for fifteen minutes, so it declines to run `login` at all.
    return expect(
      resumeLogin(live, fetchSequence([jsonResponse(400, { error: 'authorization_pending' })])),
    ).resolves.toEqual({ kind: 'pending' });
  });

  it('completes once approved', async () => {
    process.env['XDG_CONFIG_HOME'] = mkdtempSync(join(tmpdir(), 'speko-resume-'));
    const outcome = await resumeLogin(
      live,
      fetchSequence([
        jsonResponse(200, { access_token: 'sess-xyz', token_type: 'Bearer', expires_in: 60 }),
      ]),
    );
    expect(outcome.kind).toBe('approved');
    if (outcome.kind !== 'approved') return;
    expect(outcome.credentials.accessToken).toBe('sess-xyz');
    // The grant is consumed; a stale pending file would make the next `login`
    // poll a code the server has already retired.
    expect(readPending()).toBeNull();
  });

  it('treats a dropped request as pending, not as a failure', async () => {
    const dead = (async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;
    await expect(resumeLogin(live, dead)).resolves.toEqual({ kind: 'pending' });
  });

  it('reports an expired grant without calling the server at all', async () => {
    process.env['XDG_CONFIG_HOME'] = mkdtempSync(join(tmpdir(), 'speko-resume-'));
    const never = (() => {
      throw new Error('should not be called');
    }) as unknown as typeof fetch;
    await expect(
      resumeLogin({ ...live, expiresAt: new Date(Date.now() - 1000).toISOString() }, never),
    ).resolves.toEqual({ kind: 'expired' });
  });

  it('reports denial distinctly, so the caller does not keep polling', async () => {
    process.env['XDG_CONFIG_HOME'] = mkdtempSync(join(tmpdir(), 'speko-resume-'));
    await expect(
      resumeLogin(live, fetchSequence([jsonResponse(400, { error: 'access_denied' })])),
    ).resolves.toEqual({ kind: 'denied' });
  });
});
