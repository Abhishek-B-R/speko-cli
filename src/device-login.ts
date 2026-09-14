import { API_URL, AUTH_BASE_PATH } from './constants.js';
import {
  clearPending,
  deviceLabel,
  type PendingLogin,
  pendingIsLive,
  type StoredCredentials,
  userAgent,
  writeCredentials,
  writePending,
} from './credentials.js';
import { CLI_VERSION } from './version.js';

/**
 * `speko-cli login` — the client half of the RFC 8628 device authorization grant.
 *
 * The shape is forced by the spec and by the plugin serving it: ask for a code,
 * show the human a URL and a short code, then poll until they approve. The one
 * thing worth stating is what this file must NOT do — invent its own retry
 * cadence. The server returns an `interval`, and answers `slow_down` when a
 * client polls faster than it allowed. A CLI that ignores both gets throttled
 * and reports a timeout the user cannot act on.
 */

/**
 * The CLI's first-party public client id, seeded server-side by
 * `apps/server/scripts/seed-cli-oauth-client.ts`.
 *
 * Baked in rather than dynamically registered, and there is no secret to
 * protect: a device-flow public client authenticates nothing by possessing this
 * string — the human approving in a browser is the authentication. Dynamic
 * client registration is the alternative, but it requires `redirect_uris` this
 * grant never uses, and it would mint a fresh anonymous client row per machine,
 * which makes the consent screen unable to say who is asking.
 */
export const CLI_CLIENT_ID = 'speko-cli';

/** Scopes the CLI asks for. Never billing or credentials — see the plan. */
export const CLI_SCOPE = 'speko:read speko:write speko:execute';

interface DeviceCodeResponse {
  readonly device_code: string;
  readonly user_code: string;
  readonly verification_uri: string;
  readonly verification_uri_complete?: string;
  readonly expires_in: number;
  readonly interval: number;
}

interface TokenSuccess {
  readonly access_token: string;
  readonly token_type: string;
  readonly expires_in: number;
  readonly scope?: string;
}

interface OAuthErrorBody {
  readonly error?: string;
  readonly error_description?: string;
}

export class LoginError extends Error {
  constructor(
    message: string,
    /** What the user should do about it, printed on the next line. */
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'LoginError';
  }
}

function authUrl(path: string): string {
  return `${API_URL}${AUTH_BASE_PATH}${path}`;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // A non-JSON body from an auth endpoint means something in front of the
    // server answered — a proxy, an SSO wall, an error page. Say so rather than
    // reporting a parse failure the user cannot act on.
    throw new LoginError(
      `Unexpected response from ${API_URL} (HTTP ${response.status}).`,
      'Check SPEKO_API_URL, or whether a proxy is intercepting the request.',
    );
  }
}

/** Step one: ask the server to mint a device code and a human-typable code. */
export async function requestDeviceCode(
  fetchImpl: typeof fetch = fetch,
): Promise<DeviceCodeResponse> {
  const response = await fetchImpl(authUrl('/device/code'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // Read off this exact request and stored on the session row — it is how
      // the devices page knows which machine holds the credential.
      'User-Agent': userAgent(CLI_VERSION),
    },
    body: JSON.stringify({ client_id: CLI_CLIENT_ID, scope: CLI_SCOPE }),
  }).catch(() => {
    throw new LoginError(`Could not reach ${API_URL}.`, 'Check your connection, then try again.');
  });

  const body = await readJson(response);
  if (!response.ok) {
    const error = (body ?? {}) as OAuthErrorBody;
    if (error.error === 'invalid_client') {
      throw new LoginError(
        'This build of the Speko CLI is not registered with the server.',
        'Upgrade with `npm i -g @spekoai/cli@latest`; if it persists, report it.',
      );
    }
    throw new LoginError(
      error.error_description ?? `Could not start sign-in (HTTP ${response.status}).`,
    );
  }

  const code = body as Partial<DeviceCodeResponse>;
  if (!code.device_code || !code.user_code || !code.verification_uri) {
    throw new LoginError('The server did not return a usable device code.');
  }
  return {
    device_code: code.device_code,
    user_code: code.user_code,
    verification_uri: code.verification_uri,
    ...(code.verification_uri_complete
      ? { verification_uri_complete: code.verification_uri_complete }
      : {}),
    // Both have server-side defaults; fall back only if the field is absent.
    expires_in: typeof code.expires_in === 'number' ? code.expires_in : 900,
    interval: typeof code.interval === 'number' && code.interval > 0 ? code.interval : 5,
  };
}

export type PollOutcome =
  | { readonly kind: 'approved'; readonly credentials: StoredCredentials }
  | { readonly kind: 'denied' }
  | { readonly kind: 'expired' };

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Step two: poll `/device/token` until the human decides.
 *
 * `slow_down` widens the interval permanently rather than for one round — the
 * server is reporting a rate it will keep enforcing, so backing off once and
 * springing straight back is how a client gets stuck alternating between
 * `slow_down` and nothing.
 */
export async function pollForToken(
  code: DeviceCodeResponse,
  options: {
    readonly fetchImpl?: typeof fetch;
    readonly now?: () => number;
    readonly wait?: (ms: number) => Promise<void>;
    /** Called before each wait, so a terminal can show a countdown. */
    readonly onTick?: (secondsRemaining: number) => void;
  } = {},
): Promise<PollOutcome> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const wait = options.wait ?? sleep;

  const deadline = now() + code.expires_in * 1000;
  let intervalSeconds = code.interval;

  while (now() < deadline) {
    options.onTick?.(Math.max(0, Math.round((deadline - now()) / 1000)));
    await wait(intervalSeconds * 1000);

    const response = await fetchImpl(authUrl('/device/token'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': userAgent(CLI_VERSION),
      },
      body: JSON.stringify({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: code.device_code,
        client_id: CLI_CLIENT_ID,
      }),
    }).catch(() => null);

    // A dropped request mid-poll is not a failed login: the approval may still
    // be coming. Keep waiting until the code itself expires.
    if (!response) continue;

    const body = await readJson(response).catch(() => null);

    if (response.ok) {
      const token = body as Partial<TokenSuccess>;
      if (!token.access_token)
        throw new LoginError('The server approved sign-in but sent no token.');
      const expiresAt = new Date(
        now() + (typeof token.expires_in === 'number' ? token.expires_in : 0) * 1000,
      ).toISOString();
      const credentials: StoredCredentials = {
        accessToken: token.access_token,
        expiresAt,
        apiUrl: API_URL,
        clientId: CLI_CLIENT_ID,
        scope: token.scope ?? CLI_SCOPE,
      };
      return { kind: 'approved', credentials };
    }

    const error = ((body ?? {}) as OAuthErrorBody).error;
    if (error === 'authorization_pending') continue;
    if (error === 'slow_down') {
      intervalSeconds += 5;
      continue;
    }
    if (error === 'access_denied') return { kind: 'denied' };
    if (error === 'expired_token') return { kind: 'expired' };

    throw new LoginError(
      ((body ?? {}) as OAuthErrorBody).error_description ??
        `Sign-in failed (HTTP ${response.status}).`,
    );
  }

  return { kind: 'expired' };
}

/**
 * Ask for a grant and write it down, without waiting for anyone.
 *
 * Separate from the polling half because `login` has two callers with
 * incompatible needs. A human at a terminal wants one command that finishes.
 * An AGENT cannot run a command that blocks for fifteen minutes — it hangs its
 * own session — so it will decline to run `login` at all and hand the task
 * back, which is exactly what happened the first time a coding agent met this
 * CLI. Starting and resuming as two steps lets the agent print the URL, exit,
 * and finish later.
 */
export async function startLogin(): Promise<DeviceCodeResponse> {
  const code = await requestDeviceCode();
  writePending({
    deviceCode: code.device_code,
    userCode: code.user_code,
    verificationUri: code.verification_uri_complete ?? code.verification_uri,
    intervalSeconds: code.interval,
    expiresAt: new Date(Date.now() + code.expires_in * 1000).toISOString(),
    apiUrl: API_URL,
  });
  return code;
}

/** How the pending grant reads right now, without waiting for a decision. */
export type ResumeOutcome =
  | { readonly kind: 'approved'; readonly credentials: StoredCredentials }
  | { readonly kind: 'pending' }
  | { readonly kind: 'denied' }
  | { readonly kind: 'expired' };

/**
 * Check a stored grant once.
 *
 * One poll, not a loop: the caller that wants to wait already has
 * `pollForToken`. This is for the non-blocking path, where the honest answer to
 * "am I signed in yet" is whatever the server says this instant.
 */
export async function resumeLogin(
  pending: PendingLogin,
  fetchImpl: typeof fetch = fetch,
): Promise<ResumeOutcome> {
  if (!pendingIsLive(pending)) {
    clearPending();
    return { kind: 'expired' };
  }

  const response = await fetchImpl(authUrl('/device/token'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': userAgent(CLI_VERSION) },
    body: JSON.stringify({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: pending.deviceCode,
      client_id: CLI_CLIENT_ID,
    }),
  }).catch(() => null);

  // A dropped request says nothing about the approval; leave the grant alone.
  if (!response) return { kind: 'pending' };

  const body = await readJson(response).catch(() => null);

  if (response.ok) {
    const token = body as Partial<TokenSuccess>;
    if (!token.access_token) throw new LoginError('The server approved sign-in but sent no token.');
    const credentials: StoredCredentials = {
      accessToken: token.access_token,
      expiresAt: new Date(
        Date.now() + (typeof token.expires_in === 'number' ? token.expires_in : 0) * 1000,
      ).toISOString(),
      apiUrl: pending.apiUrl || API_URL,
      clientId: CLI_CLIENT_ID,
      scope: token.scope ?? CLI_SCOPE,
    };
    writeCredentials(credentials);
    clearPending();
    return { kind: 'approved', credentials };
  }

  const error = ((body ?? {}) as OAuthErrorBody).error;
  if (error === 'access_denied') {
    clearPending();
    return { kind: 'denied' };
  }
  if (error === 'expired_token') {
    clearPending();
    return { kind: 'expired' };
  }
  // `authorization_pending` and `slow_down` both mean "not yet".
  return { kind: 'pending' };
}

/** The blocking flow, for a human watching a terminal. */
export async function runLogin(write: (line: string) => void): Promise<PollOutcome> {
  const code = await startLogin();

  write('');
  write(`  Open       ${code.verification_uri_complete ?? code.verification_uri}`);
  write(`  Enter code ${code.user_code}`);
  write('');
  write(`  Signing in as ${deviceLabel()}. Waiting for approval…`);

  const outcome = await pollForToken(code);
  if (outcome.kind === 'approved') {
    writeCredentials(outcome.credentials);
    clearPending();
  }
  return outcome;
}
