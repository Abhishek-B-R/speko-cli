/**
 * `--help` for the hand-written commands.
 *
 * WHY THIS FILE EXISTS AT ALL. `--help` was wired into the GENERATED commands
 * only, so the ten hand-written ones fell straight through to their bodies.
 * `speko-cli login --help` therefore did not print help: it started a real
 * device grant, wrote a pending row to the database, and blocked for fifteen
 * minutes. A coding agent met this CLI, ran the single most obvious command for
 * learning an unfamiliar tool, and had to kill the task to recover.
 *
 * `--help` is checked before ANY command body runs — before auth, before
 * required-argument validation, before a single request. Asking what a command
 * does must never be able to do the thing.
 */

export interface BuiltinHelp {
  readonly usage: string;
  readonly lines: readonly string[];
}

export const BUILTIN_HELP: Readonly<Record<string, BuiltinHelp>> = {
  login: {
    usage: 'speko-cli login [--no-wait]',
    lines: [
      'Sign this device in to your Speko account.',
      '',
      '  Prints a short code and a URL. A human approves it in a browser — that',
      '  step cannot be automated, and it is the only one that cannot.',
      '',
      '  --no-wait   Print the code and URL, then exit immediately instead of',
      '              waiting. Run `speko-cli login` again to finish once it has',
      '              been approved. This is the default when output is not a',
      '              terminal, so an agent is never left holding a blocked',
      '              command.',
      '',
      '  Already signed in? The credential is checked against the server first,',
      '  so a session revoked from the console re-authenticates rather than',
      '  dead-ending.',
    ],
  },
  logout: {
    usage: 'speko-cli logout',
    lines: [
      'Forget the credential on this device.',
      '',
      '  Local only. The session stays valid server-side until it expires or is',
      '  revoked — use `speko-cli auth revoke` or the console for that.',
    ],
  },
  whoami: {
    usage: 'speko-cli whoami',
    lines: [
      'Show who this device is signed in as.',
      '',
      '  Exits 3 when it is not signed in, which is how a script or an agent',
      '  checks before assuming it can act.',
      '',
      '  --json   The same information as a JSON object.',
    ],
  },
  auth: {
    usage: 'speko-cli auth list | speko-cli auth revoke <id> | --all',
    lines: [
      'Manage the terminals signed in to your account.',
      '',
      '  list            Every signed-in device, with the current one marked.',
      '  revoke <id>     End one session. Takes an id from `auth list`.',
      '  revoke --all    End every CLI session, including this one.',
      '',
      "  Reads the same endpoints as the console's CLI devices page, so the two",
      '  cannot disagree about what is signed in.',
    ],
  },
  init: {
    usage: 'speko-cli init [--force]',
    lines: [
      'Add Speko guidance for coding agents to this repository.',
      '',
      '  Writes .claude/skills/speko/SKILL.md, .env.example, and a marked block',
      '  in AGENTS.md. Never writes a credential. Existing files are left alone',
      '  unless --force is given; the AGENTS.md block is replaced in place, so',
      '  running this twice does not duplicate it.',
    ],
  },
  call: {
    usage: 'speko-cli call --to <e164> [--agent <id>] [--no-wait]',
    lines: [
      'Place a call, wait for it, and print the transcript.',
      '',
      '  --to <e164>        Required. The number to call, e.g. +15551234567.',
      '  --agent <id>       The agent to run. Required unless --data carries an',
      '                     `intent` instead.',
      '  --from <e164>      Caller id. Defaults to a number on the workspace.',
      '  --prompt <text>    Override the system prompt for this call only.',
      '  --first-message    What the agent says first.',
      '  --data <json>      Full request body; named flags above override it.',
      '  --no-wait          Return as soon as the call is placed.',
      '  --timeout <secs>   How long to wait. Default 300.',
      '',
      '  The session id is printed before the wait begins, so it survives a',
      '  timeout or a Ctrl-C. A call that ends `failed` exits 1.',
    ],
  },
  logs: {
    usage: 'speko-cli logs <session_id> [--follow]',
    lines: [
      'Call events, newest last.',
      '',
      '  --follow    Keep printing as events arrive, until the call ends.',
      '',
      '  Leads with the failure cause and SIP status rather than a payload dump,',
      '  because those are the fields that explain a failed call.',
    ],
  },
  explain: {
    usage: 'speko-cli explain <CODE>',
    lines: [
      'What an error code means, and whether retrying could help.',
      '',
      '  Needs no credential — the catalogue is public, so explaining',
      '  UNAUTHORIZED does not fail with the error it is explaining.',
      '',
      '  Most codes carry only a category so far. Where no explanation has been',
      '  written, it says so rather than inventing one.',
    ],
  },
  bench: {
    usage: 'speko-cli bench [stage] [--language xx] [--provider name]',
    lines: [
      'Measured provider scores — the numbers routing decides on.',
      '',
      '  stage         stt, llm, tts or s2s. Omit for everything.',
      '  --language    ISO code, e.g. `nb`. Only what has been measured.',
      '  --provider    Narrow to one vendor.',
      '  --limit       Rows to return. Default 200.',
      '',
      '  Needs no credential — these are published benchmarks.',
      '',
      '  `—` means the metric was not measured. It never means zero: the',
      '  dataset records real zeros separately, and a cost of nothing and a',
      '  cost nobody measured are different facts.',
      '',
      '  --json   The same rows as JSON.',
      '',
      'speko-cli bench session <id>',
      '',
      '  The measured numbers for the stack one call actually ran on, stage by',
      '  stage, plus the best measured option for the same language. Needs a',
      '  credential — the session is workspace-scoped.',
      '',
      '  It does NOT say why that stack was chosen: a session records what ran',
      '  and no reason alongside it, so any explanation would be a guess.',
    ],
  },
  eval: {
    usage: 'speko-cli eval list | generate | run | trends --agent <id>',
    lines: [
      'Prove a prompt change did not break the agent.',
      '',
      '  list        The test cases stored on the agent.',
      "  generate    Propose a suite from the agent's prompt, tools and KB.",
      '              Prints the proposal WITHOUT saving it; add --persist to keep',
      '              it. Generation calls a model, so each run differs.',
      '  run         Queue every case and report what failed. --eval <id> for',
      '              one case; --no-wait to return as soon as they are queued;',
      '              --timeout <secs> (default 300).',
      '  trends      Pass rate over time, as the endpoint reports it.',
      '',
      '  --agent <id>   Required on all four.',
      '',
      '  `run` exits 6 when a case fails — not 1 — so a CI step can tell a real',
      '  regression from a network failure. A run that never leaves `queued`',
      '  exits 1 and says so: the gate worker scores runs and is a separate',
      '  service, so an unclaimed run is missing infrastructure, not a failure.',
      '',
      '  These endpoints are not in the OpenAPI document yet, which is why this',
      '  is hand-written rather than generated.',
    ],
  },
  mcp: {
    usage: 'speko-cli mcp',
    lines: [
      'Point an MCP client at Speko.',
      '',
      "  Reads the hosted server's own discovery document, so what it reports",
      '  about auth is what the server says right now, not a constant compiled',
      '  in here. Needs no credential — that document is public.',
      '',
      '  No API key is involved: the client signs you in through a browser. That',
      '  is why MCP works even though this CLI cannot create keys.',
      '',
      '  It prints the config rather than writing it. `npx @spekoai/mcp init`',
      '  does the writing for every supported client, and having two tools edit',
      '  the same files would only let them drift apart.',
      '',
      '  --json   The probe result as JSON.',
    ],
  },
  doctor: {
    usage: 'speko-cli doctor',
    lines: [
      'Why calls are failing: credit, provider reachability, scopes, last failure.',
      '',
      '  Exits non-zero only when something found will actually stop a call from',
      '  working, so it is usable as a precondition in a script.',
      '',
      '  It states facts rather than verdicts: it names the provider that needs',
      '  a key, and points at the last failed session without guessing its cause.',
      '',
      '  --json   The same information as a JSON object.',
    ],
  },
};

export function builtinHelpFor(command: string): readonly string[] | null {
  const help = BUILTIN_HELP[command];
  if (!help) return null;
  return [help.usage, '', ...help.lines];
}

/** True for `--help` or `-h` anywhere in the arguments. */
export function wantsHelp(args: readonly string[]): boolean {
  return args.includes('--help') || args.includes('-h');
}

/**
 * True when THIS argument is the help flag, rather than one appearing later.
 *
 * The distinction decides whether `speko-cli agents bogus --help` is a request
 * for the group listing or a typo. It is a typo, and answering it with the
 * listing and exit 0 would hide the mistake — the caller asked about `bogus`,
 * which does not exist, and a trailing `--help` does not make it exist.
 *
 * `wantsHelp` scans the whole argument list, which is right for a hand-written
 * command (its flags are its own) and wrong for choosing between a group and a
 * subcommand.
 */
export function isHelpFlag(arg: string | undefined): boolean {
  return arg === '--help' || arg === '-h';
}
