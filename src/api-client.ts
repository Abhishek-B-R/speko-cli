import { API_URL } from './constants.js';
import { readCredentials, userAgent } from './credentials.js';
import { CLI_VERSION } from './version.js';

/**
 * Authenticated calls to the Speko API.
 *
 * The credential is the session token `speko-cli login` stored, sent as
 * `Authorization: Bearer`. The server accepts it because `bearer()` converts it
 * into the session cookie its routes already read — so a CLI request is
 * authenticated the same way a browser is, and is capped at the same three
 * scopes the CLI asked for.
 *
 * `apiUrl` is read from the stored credential, not from the current
 * environment. A token minted against a local server is not valid against
 * production, and silently pointing one at the other produces a 401 that looks
 * like an expired login rather than the configuration mistake it is.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export class NotSignedInError extends Error {
  constructor() {
    super('Not signed in. Run `speko-cli login`.');
    this.name = 'NotSignedInError';
  }
}

interface ErrorBody {
  readonly error?: string;
  readonly message?: string;
  readonly hint?: string;
  readonly code?: string;
}

function messageFrom(body: unknown, status: number): { message: string; hint?: string } {
  if (body && typeof body === 'object') {
    const { error, message, hint } = body as ErrorBody;
    const text = typeof error === 'string' ? error : typeof message === 'string' ? message : null;
    if (text) return hint ? { message: text, hint } : { message: text };
  }
  return { message: `Request failed (HTTP ${status}).` };
}

/** True when the server said this body is JSON. */
export function isJsonResponse(response: Response): boolean {
  return response.headers.get('content-type')?.includes('json') === true;
}

/**
 * A request with auth, transport failure and status handling — but the body
 * left unread.
 *
 * SPLIT OUT BECAUSE NOT EVERY ENDPOINT ANSWERS IN JSON. Five operations in the
 * generated set do not: `synthesize` returns binary audio, `transcribe`,
 * `complete` and the SMS stream return server-sent events, and the agent
 * analysis export returns CSV. The previous version parsed every non-empty body
 * as JSON before doing anything else, so all five threw `SyntaxError` on a
 * perfectly successful response — and a proxy's HTML 502 threw the same thing
 * instead of the error it was reporting.
 */
export async function apiRequest(
  path: string,
  options: RequestInit = {},
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const credentials = readCredentials();
  if (!credentials) throw new NotSignedInError();

  const base = credentials.apiUrl || API_URL;
  const response = await fetchImpl(`${base}/v1${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${credentials.accessToken}`,
      'User-Agent': userAgent(CLI_VERSION),
      ...options.headers,
    },
  }).catch(() => {
    throw new ApiError(0, `Could not reach ${base}.`, 'Check your connection, then try again.');
  });

  if (response.status === 401) {
    // Either revoked from the console or simply aged out; the CLI cannot tell
    // which, and both are fixed the same way.
    throw new ApiError(
      401,
      'This device is no longer signed in.',
      'It may have been signed out from the console. Run `speko-cli login` again.',
    );
  }

  if (!response.ok) {
    // An error body is read defensively: a gateway or proxy failure is often
    // HTML, and the status is worth reporting even when the body is not.
    const text = await response.text().catch(() => '');
    let body: unknown = null;
    try {
      body = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    const { message, hint } = messageFrom(body, response.status);
    throw new ApiError(response.status, message, hint);
  }

  return response;
}

/**
 * A JSON request. Use this wherever the endpoint is known to answer in JSON.
 *
 * A successful response that is NOT JSON is an error here rather than a parse
 * crash, because it means the caller picked the wrong helper — the fix is to
 * read the body some other way, and a `SyntaxError` from deep inside says none
 * of that.
 */
export async function apiFetch<T>(
  path: string,
  options: RequestInit = {},
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  const response = await apiRequest(path, options, fetchImpl);
  const text = await response.text();
  if (text.length === 0) return null as T;
  if (!isJsonResponse(response)) {
    throw new ApiError(
      response.status,
      `Expected JSON from ${path} but the server sent ${response.headers.get('content-type') ?? 'no content type'}.`,
    );
  }
  return JSON.parse(text) as T;
}
