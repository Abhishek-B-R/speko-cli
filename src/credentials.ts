import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, hostname, platform } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Where the CLI keeps the credential `speko-cli login` earned, and how it labels
 * itself to the server.
 *
 * WHAT IS STORED IS A SESSION TOKEN, not an API key. `/device/token` answers
 * with `access_token: session.token` — the same value a browser would hold in
 * its session cookie — so this file is exactly as powerful as being signed in
 * on the dashboard. Hence `0600` and a directory outside the repo: a token that
 * lands in a project folder ends up in a commit, and a commit is forever.
 *
 * NO OS KEYCHAIN YET. Every cross-platform keychain binding is a native module,
 * and a native module in a CLI that agents install with `npx` is a
 * compile-on-install failure waiting to happen on the first machine without
 * build tools. A 0600 file in the user's home is what `gh` shipped for years.
 * Revocation is the real mitigation, and that lives server-side.
 */

/**
 * `XDG_CONFIG_HOME` is honoured where set — containers and CI images routinely
 * relocate it, and a CLI that ignores it writes to a path that is not persisted.
 */
export function configDir(): string {
  const xdg = process.env['XDG_CONFIG_HOME'];
  const base = xdg?.startsWith('/') ? xdg : join(homedir(), '.config');
  return join(base, 'speko');
}

export function credentialsPath(): string {
  return join(configDir(), 'credentials.json');
}

export function pendingPath(): string {
  return join(configDir(), 'pending-login.json');
}

/**
 * A device grant that has been requested but not yet approved.
 *
 * Persisted because `login` must be able to return immediately when nothing is
 * watching a terminal — an agent that runs a command which blocks for fifteen
 * minutes hangs its own session, so it will refuse to run `login` at all and
 * hand the whole task back to the user. Writing the grant down lets the agent
 * print the URL, exit, and finish the job on a later invocation.
 *
 * Not a secret in the way `credentials.json` is: a device code is worthless
 * without someone approving it in a browser. Written 0600 anyway, since it is
 * one approval away from being a credential.
 */
export interface PendingLogin {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly intervalSeconds: number;
  /** ISO 8601. After this the grant is dead and must be restarted. */
  readonly expiresAt: string;
  /** Which API it was requested from; a grant is not portable across origins. */
  readonly apiUrl: string;
}

export function readPending(): PendingLogin | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(pendingPath(), 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    const p = parsed as Partial<PendingLogin>;
    if (!p.deviceCode || !p.userCode || !p.expiresAt) return null;
    return {
      deviceCode: p.deviceCode,
      userCode: p.userCode,
      verificationUri: p.verificationUri ?? '',
      intervalSeconds: typeof p.intervalSeconds === 'number' ? p.intervalSeconds : 5,
      expiresAt: p.expiresAt,
      apiUrl: p.apiUrl ?? '',
    };
  } catch {
    return null;
  }
}

export function writePending(pending: PendingLogin): void {
  const path = pendingPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(pending, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function clearPending(): void {
  rmSync(pendingPath(), { force: true });
}

/** Whether a pending grant is still worth polling. */
export function pendingIsLive(pending: PendingLogin, now: Date = new Date()): boolean {
  const expiry = Date.parse(pending.expiresAt);
  if (Number.isNaN(expiry)) return false;
  return expiry > now.getTime();
}

export interface StoredCredentials {
  /** The session token, sent as `Authorization: Bearer <token>`. */
  readonly accessToken: string;
  /** Absolute expiry, ISO 8601. Derived from the grant's `expires_in`. */
  readonly expiresAt: string;
  /** Which API this token is good for; a token is not portable across origins. */
  readonly apiUrl: string;
  /** The OAuth client the device grant was issued to. */
  readonly clientId: string;
  /** Scopes the grant reported, for `speko-cli whoami` to display. */
  readonly scope: string;
}

/**
 * The label this machine reports, so the devices page can say *which* terminal
 * is signed in. "Nowhere" is not an option: a list of identical unnamed
 * sessions cannot be revoked with any confidence.
 */
export function deviceLabel(): string {
  return `${hostname()} (${platform()})`;
}

/**
 * The User-Agent every request carries. The server reads it off
 * `/device/token` and stores it on the session row, and its `speko-cli/` prefix
 * is what marks a session as CLI-issued — so this string is the devices page's
 * only source of truth about which machine holds which credential.
 *
 * It is a label, not a credential: nothing is authorized by it, and revocation
 * is always by session id.
 */
export function userAgent(version: string): string {
  return `speko-cli/${version} (${hostname()}; ${platform()})`;
}

export function readCredentials(): StoredCredentials | null {
  try {
    const raw = readFileSync(credentialsPath(), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const candidate = parsed as Partial<StoredCredentials>;
    if (typeof candidate.accessToken !== 'string' || candidate.accessToken.length === 0) {
      return null;
    }
    return {
      accessToken: candidate.accessToken,
      expiresAt: typeof candidate.expiresAt === 'string' ? candidate.expiresAt : '',
      apiUrl: typeof candidate.apiUrl === 'string' ? candidate.apiUrl : '',
      clientId: typeof candidate.clientId === 'string' ? candidate.clientId : '',
      scope: typeof candidate.scope === 'string' ? candidate.scope : '',
    };
  } catch {
    // A missing or unreadable file means "not signed in", which is a normal
    // state and not worth an error. A corrupt one is treated the same way:
    // `speko-cli login` overwrites it.
    return null;
  }
}

export function writeCredentials(credentials: StoredCredentials): void {
  const path = credentialsPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // Write, then narrow. `writeFileSync`'s mode is masked by the process umask,
  // so it cannot be relied on alone to produce 0600.
  writeFileSync(path, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function clearCredentials(): void {
  rmSync(credentialsPath(), { force: true });
}

/** Whether a stored credential has passed its own expiry. */
export function isExpired(credentials: StoredCredentials, now: Date = new Date()): boolean {
  if (!credentials.expiresAt) return false;
  const expiry = Date.parse(credentials.expiresAt);
  if (Number.isNaN(expiry)) return false;
  return expiry <= now.getTime();
}
