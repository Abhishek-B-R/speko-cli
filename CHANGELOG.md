# Changelog

## 0.1.0

First release.

- `login` / `logout` / `whoami` / `auth` — sign in by RFC 8628 device grant.
  A human approves the code in a browser; that step is the only one that
  cannot be automated. Non-interactive shells get the URL and exit rather than
  blocking, so an agent is never left holding a stalled command.
- 87 API operations generated from the OpenAPI document, in seven groups.
- `call` — place a call, wait for it, print the transcript.
- `logs` — call events, `--follow` to stream.
- `doctor` — why calls are failing: credit, provider reachability, scopes, and
  the last failure.
- `bench` — measured provider scores, including `bench session <id>` for the
  stack one call actually ran on.
- `eval` — generate a test suite from an agent's own config, run it, and exit
  6 on a regression so CI can tell a broken agent from a broken network.
- `explain` — what an error code means and whether retrying could help.
- `init` — Speko guidance for coding agents, written into the repo.
- `mcp` — point an MCP client at the hosted server, checked live.

Creating API keys, buying and releasing phone numbers, and submitting KYB are
deliberately absent: they open the dashboard instead.
