# Changelog

## 0.1.2

- `speko-cli <group> --help` now lists the group's operations and exits 0. It
  used to print `Unknown command: speko-cli agents --help`, then the listing
  anyway, and exit 2 — answering the question while insisting it had not
  understood it. A help flag after an unknown subcommand still fails:
  `speko-cli agents bogus --help` is a typo, not a listing request.
- Correct the claim that `bench` needs no credential: the stage boards do not,
  but `bench session` does, because a session belongs to a workspace.

- Document `eval`, `bench`, `mcp`, `doctor` and `explain` in the README and in
  the skill file `init` writes. All five shipped in 0.1.0 undocumented; the
  skill file even referenced exit code 6 without saying `eval` existed.
- Remove a stale README section describing a `--yes` flag that was never
  shipped, and a reference to `speko-cli keys create`, which is not a command.
- Point at the CLI's new documentation section, which did not exist before:
  https://docs.speko.ai/cli/overview. The CLI was absent from the docs site and
  from its `llms.txt` index entirely, so an agent following the old link found
  nothing about it.

## 0.1.1

- Fix `bench`: it called `/v1/benchmarks`, which the API moved to
  `/v1/benchmarks/scores` to stop it shadowing the routing dataset.

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
