import { API_URL } from './constants.js';
import { readCredentials, userAgent } from './credentials.js';
import { CLI_VERSION } from './version.js';

/**
 * `speko-cli explain <CODE>` — what an error code means and whether to retry it.
 *
 * UNAUTHENTICATED ON PURPOSE. The catalogue is documentation, and the caller
 * most likely to reach for it is holding a code and a credential that was just
 * rejected. Requiring a credential would make `speko-cli explain UNAUTHORIZED` fail
 * with the error it was asked to explain. A stored credential is used for its
 * `apiUrl` only, so explaining a code against a local server works.
 */

export interface ErrorExplanation {
  readonly code: string;
  readonly category: string;
  readonly retryable: boolean;
  readonly documented: boolean;
  readonly docs_url: string;
  readonly meaning?: string;
  readonly hint?: string;
  readonly sources?: readonly string[];
}

export async function fetchExplanation(
  code: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ErrorExplanation | null> {
  const base = readCredentials()?.apiUrl || API_URL;
  const response = await fetchImpl(`${base}/v1/errors/${encodeURIComponent(code.toUpperCase())}`, {
    headers: { 'User-Agent': userAgent(CLI_VERSION) },
  });
  if (response.status === 404) return null;
  if (!response.ok)
    throw new Error(`Could not reach the error catalogue (HTTP ${response.status}).`);
  return (await response.json()) as ErrorExplanation;
}

export function formatExplanation(explanation: ErrorExplanation): string[] {
  const lines = [explanation.code, ''];
  if (explanation.meaning) lines.push(`  ${explanation.meaning}`, '');
  else {
    // Saying so is the point. An agent told only the category can still decide
    // whether to retry, and is not misled into thinking it has been advised.
    lines.push(`  No written explanation yet — only its category is known.`, '');
  }
  lines.push(`  Category   ${explanation.category}`);
  lines.push(`  Retryable  ${explanation.retryable ? 'yes' : 'no'}`);
  lines.push(`  Docs       ${explanation.docs_url}`);
  if (explanation.hint) lines.push('', `  ${explanation.hint}`);
  return lines;
}
