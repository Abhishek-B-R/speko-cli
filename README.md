# @spekoai/cli

The Speko command-line interface. Sign in, then build and operate voice agents
from the terminal — no dashboard round-trip.

```bash
npx @spekoai/cli login
```

## Commands

| Command | What it does |
| --- | --- |
| `speko-cli login` | Signs this device in via the RFC 8628 device authorization grant |
| `speko-cli logout` | Removes the credential from this device |
| `speko-cli whoami` | Shows the account, scopes and expiry this device holds |
| `speko-cli auth list` | Lists every terminal signed in to your account |
| `speko-cli auth revoke <id>` | Signs out one device (`--all` for every device) |
| `speko-cli init` | Writes Speko guidance for coding agents into this repository |
| `speko-cli call --to <e164>` | Places a call, waits for it, prints the transcript |
| `speko-cli logs <session_id>` | Call events, `--follow` to stream |
| `speko-cli doctor` | Why calls are failing: credit, providers, scopes, last failure |
| `speko-cli explain <CODE>` | What an error code means, and whether retrying helps |
| `speko-cli bench [stage]` | Measured provider scores — the numbers routing decides on |
| `speko-cli eval` | Generate a test suite for an agent, run it, report regressions |
| `speko-cli mcp` | Point an MCP client at Speko |

Every command takes `--help` — including a group, so `speko-cli agents --help`
lists that group's operations. Asking never performs the action.

## The development loop

```bash
speko-cli init                                  # add agent guidance to this repo
speko-cli call --to +15551234567 --agent <id>   # place it, wait, print the transcript
speko-cli logs <session_id> --follow            # events as they arrive
speko-cli logs <session_id>                     # why a call failed
```

`speko-cli call` prints the session id before it starts waiting, so the id survives
a timeout or a Ctrl-C. `--no-wait` returns immediately. A call that ends
`failed` exits 1, so a script placing calls in a loop can notice.

`speko-cli init` writes a skill file, `.env.example` and an `AGENTS.md` block. It
never writes a credential into the project, and never overwrites an existing
file without `--force`.

## When something fails

```bash
speko-cli doctor                     # credit, provider usability, scopes, last failure
speko-cli explain INSUFFICIENT_CREDITS
```

`doctor` exits non-zero when it finds something that will actually stop a call
working, so it works as a precondition in a script. It states facts rather than
verdicts — it names the provider that needs a key instead of reporting that
routing failed, and points at the last failed session without guessing its
cause.

Every error body carries `code`, `retryable` and `docs_url`, plus a `hint`
where one has been written. `retryable` is the field to branch on.

## Proving a change did not break the agent

```bash
speko-cli eval generate --agent <id>            # propose a suite; prints it, saves nothing
speko-cli eval generate --agent <id> --persist  # keep it
speko-cli eval run --agent <id>                 # run it, report what broke
speko-cli eval trends --agent <id>              # pass rate over time
```

A voice regression is invisible to a diff, a type check and a unit test: change
one line of a prompt and the agent quietly stops confirming before it books.
`eval generate` writes the suite from the agent's own prompt, tools and
knowledge base, so nobody hand-authors test cases.

`eval run` **exits 6** on a failing case, not 1. A CI step has to tell "the
agent's behaviour is wrong" from "the network was down", and collapsing the two
is how an eval gate stops being trusted.

Runs are queued for a worker that scores them, so a run that never leaves
`queued` means nothing is consuming the queue — reported as such rather than as
a test failure, because those need opposite responses.

## Choosing a provider

```bash
speko-cli bench stt --language nb     # ranked by word error rate
speko-cli bench llm                   # ranked by measured latency
speko-cli bench session <session_id>  # what one call actually ran on
```

The stage boards need no credential — they are published measurements, and the
person most likely to want them is deciding whether to sign up at all.
`bench session` is the exception: a session belongs to a workspace, so it
requires sign-in and exits 3 without it.

`—` means the metric was not measured; it never means zero, because the two are
different facts and a cost of nothing would otherwise look like the cheapest
option on the board.

`bench session` does **not** explain why a stack was chosen. Nothing records
that, so it reports what ran and what was measured about it, and says so.

## MCP

```bash
speko-cli mcp
```

Reads the hosted server's own discovery document, so what it reports about auth
is what the server says now rather than a constant compiled in. No API key is
involved — the client signs you in through a browser, which is why MCP works
even though this CLI cannot create keys.

It prints the configuration rather than writing it; `npx @spekoai/mcp init`
does the writing for every supported client.

## API commands

Every operation in the Speko OpenAPI document is available as a command,
generated rather than hand-written:

```bash
speko-cli agents list
speko-cli agents get agent_abc123
speko-cli agents create --data '{"name":"Front desk"}'
speko-cli agents                      # list the group's operations
speko-cli agents get-agent --help     # arguments for one operation
```

Groups come from the spec's tags: `agents`, `call-control`, `providers`, `sms`,
`telephony`, `voice`, `webhooks`. The canonical command name is the
operationId, kebab-cased (`listAgents` → `list-agents`); the REST five (`list`,
`get`, `create`, `update`, `delete`) are aliases where a group makes them
unambiguous.

Path parameters are positional, in URL order. Query parameters are `--flags`. A
request body comes from `--data JSON`, `--file PATH`, or stdin.

`speko-cli <group> <command> --help` lists the request-body fields, marks the
required ones, and links the full schema — so a body can be written without
fetching the spec first.

Add `--json` to any command for machine-readable output.

## What the CLI will not do

Some acts belong to a person. For those the CLI prints the console URL instead
of doing them:

| Operation | Why |
| --- | --- |
| `telephony submit-phone-number-kyb` | Asserts you are authorized to bind the business, and accepts indemnity for how the numbers are used |
| `telephony save-phone-number-kyb-draft` with `attestationAccepted` | The draft is fine; accepting the terms is not |
| `telephony create-phone-number` | Spends money and starts a recurring charge |
| `telephony delete-phone-number` | Returns the number to the carrier permanently |

Everything else runs. `agents delete-agent` and `sms redact-sms-conversation`
are destructive and deliberately stay here: the first is how anyone iterating
discards a test agent, and the second is plausibly how a data-deletion request
gets serviced, which wants to be scriptable rather than clicked.

## Exit codes

Stable, and part of the contract — a caller in CI must be able to tell these
apart without parsing prose.

| Code | Meaning |
| --- | --- |
| 0 | Success |
| 1 | Runtime failure (network, server error) |
| 2 | Usage error (unknown command, missing argument) |
| 3 | Not signed in, or the credential was rejected |
| 4 | Resource not found |
| 5 | Out of credit, or rate limited |
| 6 | An eval suite regressed |

## How sign-in works

`speko-cli login` asks the server for a short code, prints a URL and that code, and
polls until a human approves it in a browser. The device grant is used rather
than a loopback redirect because the CLI often runs where no browser can reach
it — a container, an SSH session, a coding agent's sandbox.

What it stores is a **session token**, in `~/.config/speko/credentials.json` at
mode `0600` (or under `XDG_CONFIG_HOME` where set). That token is as powerful as
being signed in on the dashboard, so treat the file as a secret and revoke the
device from the console rather than only deleting the file — `speko-cli logout` is
local, and says so.

`speko-cli auth revoke` and the console's CLI devices page read the same endpoints,
so the two can never disagree about what is signed in. Revoking is what actually
ends access — `speko-cli logout` only clears the local file.

The CLI never creates API keys, and has no command for them at all — the
API-key endpoints are not in the CLI's surface. A key is a long-lived
organization credential destined for a production environment, so it is issued
in the console by a person: <https://platform.speko.ai/agents/keys>.

A CLI session also cannot read one. `speko-cli whoami` shows three scopes where
a browser session holds six; `speko:credentials` is not among them, so the
organization's master MCP key and webhook signing secret are unreachable from a
terminal even though the same login works in both places.

## Environment

| Variable | Default |
| --- | --- |
| `SPEKO_API_URL` | `https://api.speko.dev` |
| `SPEKO_DASHBOARD_URL` | `https://platform.speko.ai` |
| `XDG_CONFIG_HOME` | `~/.config` |

Docs: <https://docs.speko.ai/cli>
