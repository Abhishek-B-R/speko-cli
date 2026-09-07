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
| Creating an API key | A long-lived organization credential |

Everything else runs. `agents delete-agent` and `sms redact-sms-conversation`
are destructive and deliberately stay here: the first is how anyone iterating
discards a test agent, and the second is plausibly how a data-deletion request
gets serviced, which wants to be scriptable rather than clicked.

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

Two categories, for two different reasons.

**Refused outright**, because the act belongs to a person and the server records
it against their name:

| Operation | Why |
| --- | --- |
| `telephony submit-phone-number-kyb` | Asserts you are authorized to bind the business, and accepts indemnity for how the numbers are used |
| `telephony save-phone-number-kyb-draft` with `attestationAccepted` | The draft is fine; accepting the terms is not |
| Creating an API key | A long-lived organization credential belongs in the console |

**Needs `--yes`**, because it cannot be undone or it starts a charge:

| Operation | Consequence |
| --- | --- |
| `telephony delete-phone-number` | Released to the carrier, unrecoverable |
| `sms redact-sms-conversation` | Messages destroyed, not archived |
| `telephony create-phone-number` | Starts a recurring monthly charge |
| `agents delete-agent` | Configuration gone; the agent has to be rebuilt |

`--yes` is not a security boundary — an agent will pass it when you asked for
the thing, and that is correct. It makes the destruction deliberate rather than
a typo, and visible in the transcript.

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

The CLI never creates API keys. A key is a long-lived organization credential
destined for a production environment, so `speko-cli keys create` opens the console
page and a human authorizes it.

## Environment

| Variable | Default |
| --- | --- |
| `SPEKO_API_URL` | `https://api.speko.dev` |
| `SPEKO_DASHBOARD_URL` | `https://platform.speko.ai` |
| `XDG_CONFIG_HOME` | `~/.config` |

Docs: <https://speko.ai/developers/cli>
