/**
 * Where the CLI points, and the exit codes it promises.
 */

/** The API gateway. Overridable so a contributor can drive a local server. */
export const API_URL = process.env['SPEKO_API_URL'] ?? 'https://api.speko.dev';

/**
 * The console. Only used to render the URL a human opens during `speko-cli login`;
 * the authoritative value is whatever `/device/code` returns as
 * `verification_uri`, which the server builds from its own DASHBOARD_URL.
 */
export const DASHBOARD_URL = process.env['SPEKO_DASHBOARD_URL'] ?? 'https://platform.speko.ai';

export const AUTH_BASE_PATH = '/api/auth';

/**
 * Exit codes are part of the CLI's contract: the same invocation has to be
 * usable in a script and in CI, and a caller distinguishing "wrong flags" from
 * "not signed in" from "your eval regressed" cannot do it by parsing prose.
 *
 * Numbers are frozen once published. Add to the end; never renumber.
 */
export const EXIT = {
  ok: 0,
  /** Something failed at runtime — network, server 5xx, unexpected shape. */
  runtime: 1,
  /** The command line itself was wrong: unknown command, missing argument. */
  usage: 2,
  /** Not signed in, or the credential was rejected or revoked. */
  auth: 3,
  /** The named resource does not exist. */
  notFound: 4,
  /** Out of credit, or rate limited. */
  quota: 5,
  /** An eval suite regressed. Distinct from `runtime` so CI can tell them apart. */
  evalRegression: 6,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];
