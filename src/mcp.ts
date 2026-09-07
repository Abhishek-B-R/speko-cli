import { userAgent } from './credentials.js';
import { CLI_VERSION } from './version.js';

/**
 * `speko-cli mcp` — how to point an MCP client at Speko, verified live.
 *
 * WHY THIS IS A SIGNPOST AND NOT A WIZARD. `@spekoai/mcp` already writes client
 * configuration for Claude Desktop, Cursor, VS Code, Codex, OpenCode, Cline,
 * Windsurf and Zed — about 1200 lines of it, published and versioned separately.
 * Reimplementing that here would put two tools in the business of editing the
 * same files on someone's machine, and the copy would drift the first time a
 * client changed its config format. So this command does the part that package
 * cannot: it checks what the hosted server says about itself right now, and
 * hands over the one command that does the writing.
 *
 * THE PLAN NAMED THIS "absorb the stdio bridge". There is no stdio bridge left
 * to absorb: `@spekoai/mcp` v2 dropped it for direct HTTP, and the description
 * of it in the repo's own CLAUDE.md is stale. Absorbing a component that no
 * longer exists would have meant writing one first.
 *
 * NO API KEY, WHICH IS THE POINT WORTH PRINTING. The server advertises an OAuth
 * authorization server in its protected-resource metadata, so a client
 * authenticates itself in a browser. This matters here specifically because the
 * CLI deliberately cannot create API keys — without saying this, the obvious
 * reading of "the MCP needs a token" is that the CLI has hit its own limit.
 */

export const MCP_URL = process.env['SPEKO_MCP_URL'] ?? 'https://mcp.speko.ai/mcp';

/** The MCP-spec discovery document, derived from the server URL. */
export function resourceMetadataUrl(mcpUrl: string): string {
  const url = new URL(mcpUrl);
  const path = url.pathname.replace(/^\/+/, '');
  return `${url.origin}/.well-known/oauth-protected-resource${path ? `/${path}` : ''}`;
}

export interface McpStatus {
  readonly url: string;
  readonly reachable: boolean;
  /** Present only when the server actually advertised one. */
  readonly authorizationServer?: string;
  readonly scopes?: readonly string[];
  /** Why the probe could not conclude, when it could not. */
  readonly problem?: string;
}

interface ResourceMetadata {
  readonly resource?: unknown;
  readonly authorization_servers?: unknown;
  readonly scopes_supported?: unknown;
}

/**
 * Reads the server's own discovery document.
 *
 * DELIBERATELY UNAUTHENTICATED. The metadata endpoint is public by design — it
 * is what a client reads before it has a token — so this works before login and
 * says the same thing to a signed-out reader as to a signed-in one.
 *
 * A failed probe is reported as a failed probe. Printing the OAuth details from
 * a constant when the server could not be reached would state as fact something
 * that was never checked, and the whole value of the command is that it checked.
 */
export async function probeMcp(
  mcpUrl: string = MCP_URL,
  fetchImpl: typeof fetch = fetch,
): Promise<McpStatus> {
  const metadataUrl = resourceMetadataUrl(mcpUrl);
  try {
    const response = await fetchImpl(metadataUrl, {
      headers: { 'User-Agent': userAgent(CLI_VERSION) },
    });
    if (!response.ok) {
      return {
        url: mcpUrl,
        reachable: false,
        problem: `metadata returned HTTP ${response.status}`,
      };
    }
    const body = (await response.json()) as ResourceMetadata;
    const servers = Array.isArray(body.authorization_servers) ? body.authorization_servers : [];
    const scopes = Array.isArray(body.scopes_supported) ? body.scopes_supported : [];
    const authorizationServer = servers.find((s): s is string => typeof s === 'string');
    return {
      url: mcpUrl,
      reachable: true,
      ...(authorizationServer ? { authorizationServer } : {}),
      ...(scopes.length > 0
        ? { scopes: scopes.filter((s): s is string => typeof s === 'string') }
        : {}),
    };
  } catch (error) {
    return {
      url: mcpUrl,
      reachable: false,
      problem: error instanceof Error ? error.message : String(error),
    };
  }
}

/** The config block, in the shape every HTTP-capable MCP client accepts. */
export function configBlock(mcpUrl: string): string {
  return JSON.stringify({ mcpServers: { speko: { type: 'http', url: mcpUrl } } }, null, 2);
}

export function formatMcp(status: McpStatus): string[] {
  const lines: string[] = [`  Server   ${status.url}`];

  if (!status.reachable) {
    lines.push(`  Status   could not be checked — ${status.problem ?? 'unknown error'}`);
    lines.push('');
    lines.push('  The configuration below is still correct; only the live check failed.');
  } else if (status.authorizationServer) {
    lines.push('  Status   reachable, and it authenticates by OAuth');
    lines.push(`  Sign in  ${status.authorizationServer}`);
    if (status.scopes) lines.push(`  Scopes   ${status.scopes.join(' ')}`);
    lines.push('');
    lines.push('  No API key needed. The client opens a browser and signs in as you,');
    lines.push('  which is why this works even though the CLI cannot create keys.');
  } else {
    // Reachable but advertising no authorization server: a real state, and not
    // one to paper over — a client will have nowhere to send the user.
    lines.push('  Status   reachable, but it advertises no authorization server');
    lines.push('  A client with no API key has no way to sign in. Worth reporting.');
  }

  lines.push('');
  lines.push('  To configure a client automatically:');
  lines.push('    npx @spekoai/mcp init');
  lines.push('');
  lines.push('  Or add this to it by hand:');
  for (const line of configBlock(status.url).split('\n')) lines.push(`    ${line}`);

  return lines;
}
