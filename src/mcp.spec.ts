import { describe, expect, it } from 'vitest';
import { configBlock, formatMcp, probeMcp, resourceMetadataUrl } from './mcp.js';

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('resourceMetadataUrl', () => {
  it('appends the resource path, as the MCP spec requires', () => {
    // Not `/.well-known/oauth-protected-resource` at the origin: that path 404s
    // on the live server, and the document is served per-resource.
    expect(resourceMetadataUrl('https://mcp.speko.ai/mcp')).toBe(
      'https://mcp.speko.ai/.well-known/oauth-protected-resource/mcp',
    );
  });

  it('handles a server mounted at the root', () => {
    expect(resourceMetadataUrl('https://example.test/')).toBe(
      'https://example.test/.well-known/oauth-protected-resource',
    );
  });
});

describe('probeMcp', () => {
  const metadata = {
    resource: 'https://mcp.speko.ai/mcp',
    authorization_servers: ['https://platform.speko.ai/api/auth'],
    scopes_supported: ['openid', 'speko:read', 'speko:write'],
  };

  it('reports the authorization server the document names', async () => {
    const status = await probeMcp('https://mcp.speko.ai/mcp', async () => jsonResponse(metadata));
    expect(status.reachable).toBe(true);
    expect(status.authorizationServer).toBe('https://platform.speko.ai/api/auth');
    expect(status.scopes).toContain('speko:write');
  });

  it('reports a network failure as unchecked, never as a verdict', async () => {
    // The command's whole value is that it checked. Printing the OAuth details
    // from a constant after a failed probe would state something never verified.
    const status = await probeMcp('https://mcp.speko.ai/mcp', async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    });
    expect(status.reachable).toBe(false);
    expect(status.authorizationServer).toBeUndefined();
    expect(formatMcp(status).join('\n')).toContain('could not be checked');
  });

  it('reports a non-200 metadata response as unreachable with its status', async () => {
    const status = await probeMcp('https://mcp.speko.ai/mcp', async () => jsonResponse({}, 503));
    expect(status.reachable).toBe(false);
    expect(status.problem).toContain('503');
  });

  it('does not invent an authorization server when the document omits one', async () => {
    const status = await probeMcp('https://mcp.speko.ai/mcp', async () =>
      jsonResponse({ resource: 'https://mcp.speko.ai/mcp' }),
    );
    expect(status.reachable).toBe(true);
    expect(status.authorizationServer).toBeUndefined();
    // A real state worth surfacing: a client with no API key has nowhere to
    // send the user, so it must not read as a working setup.
    expect(formatMcp(status).join('\n')).toContain('advertises no authorization server');
  });
});

describe('formatMcp', () => {
  it('still prints usable configuration when the probe failed', async () => {
    const lines = formatMcp({
      url: 'https://mcp.speko.ai/mcp',
      reachable: false,
      problem: 'offline',
    }).join('\n');
    expect(lines).toContain('https://mcp.speko.ai/mcp');
    expect(lines).toContain('npx @spekoai/mcp init');
  });

  it('emits a config block a client can accept verbatim', () => {
    expect(JSON.parse(configBlock('https://mcp.speko.ai/mcp'))).toEqual({
      mcpServers: { speko: { type: 'http', url: 'https://mcp.speko.ai/mcp' } },
    });
  });

  it('says an API key is not needed', () => {
    // Without this the obvious reading of "the MCP needs a token" is that the
    // CLI has hit its own limit, since it deliberately cannot create keys.
    const lines = formatMcp({
      url: 'https://mcp.speko.ai/mcp',
      reachable: true,
      authorizationServer: 'https://platform.speko.ai/api/auth',
    }).join('\n');
    expect(lines).toContain('No API key needed');
  });
});
