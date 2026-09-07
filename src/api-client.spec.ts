import { describe, expect, it, vi } from 'vitest';

// `apiFetch` reads the stored credential before it does anything else, so the
// module is stubbed rather than a real credentials file being written.
vi.mock('./credentials.js', () => ({
  readCredentials: () => ({ accessToken: 'tok', apiUrl: 'https://api.test' }),
  userAgent: () => 'speko-cli/test',
}));

const { ApiError, apiFetch, apiRequest, isJsonResponse } = await import('./api-client.js');

const respond = (body: string, init: ResponseInit & { type?: string }): typeof fetch =>
  (async () =>
    new Response(body, {
      ...init,
      headers: init.type ? { 'content-type': init.type } : {},
    })) as unknown as typeof fetch;

describe('isJsonResponse', () => {
  it('recognises the JSON content types a server actually sends', () => {
    const of = (type: string) => new Response('', { headers: { 'content-type': type } });
    expect(isJsonResponse(of('application/json'))).toBe(true);
    expect(isJsonResponse(of('application/json; charset=utf-8'))).toBe(true);
    expect(isJsonResponse(of('application/problem+json'))).toBe(true);
    expect(isJsonResponse(of('text/csv'))).toBe(false);
    expect(isJsonResponse(of('application/octet-stream'))).toBe(false);
    expect(isJsonResponse(new Response(''))).toBe(false);
  });
});

describe('apiFetch', () => {
  it('parses a JSON body', async () => {
    const data = await apiFetch<{ ok: boolean }>(
      '/x',
      {},
      respond('{"ok":true}', { status: 200, type: 'application/json' }),
    );
    expect(data.ok).toBe(true);
  });

  it('refuses a successful non-JSON body instead of crashing on parse', async () => {
    // `voice synthesize` answers with audio and the analysis export with CSV.
    // Both used to reach `JSON.parse` and throw SyntaxError on success.
    await expect(
      apiFetch('/synthesize', {}, respond('RIFF....', { status: 200, type: 'audio/wav' })),
    ).rejects.toThrow(/Expected JSON/);
  });

  it('reports an error status even when the error body is not JSON', async () => {
    // A gateway failure is usually HTML. The status is worth reporting even
    // when the body is not; parsing first threw SyntaxError and lost it.
    const failure = apiFetch(
      '/x',
      {},
      respond('<html>502 Bad Gateway</html>', { status: 502, type: 'text/html' }),
    );
    await expect(failure).rejects.toThrow(/HTTP 502/);
  });

  it('treats an empty body as null rather than a parse error', async () => {
    // `sms get-sms-settings` answers 200 with no body at all.
    expect(await apiFetch('/x', {}, respond('', { status: 200 }))).toBeNull();
  });

  it('turns a revoked session into an actionable message', async () => {
    await expect(
      apiFetch('/x', {}, respond('{}', { status: 401, type: 'application/json' })),
    ).rejects.toThrow(/no longer signed in/);
  });
});

describe('apiRequest', () => {
  it('hands back an unread body so the caller can choose how to read it', async () => {
    const response = await apiRequest(
      '/agents/a/analysis.csv',
      {},
      respond('a,b\n1,2\n', { status: 200, type: 'text/csv' }),
    );
    expect(response.bodyUsed).toBe(false);
    expect(await response.text()).toBe('a,b\n1,2\n');
  });

  it('still raises on a failed status', async () => {
    await expect(
      apiRequest('/x', {}, respond('{"error":"nope"}', { status: 400, type: 'application/json' })),
    ).rejects.toBeInstanceOf(ApiError);
  });
});
