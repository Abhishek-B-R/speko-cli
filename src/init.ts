import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * `speko-cli init` — leaves behind what a coding agent needs to build on Speko in
 * the repo it is already working in.
 *
 * The problem this solves is that an agent arriving in a project has no way to
 * know Speko is available, what the commands are, or which constraints will
 * silently break a call. It will otherwise infer an API from its training data
 * and write code against endpoints that may not exist. A skill file in the repo
 * is the one artefact every coding agent reads without being asked.
 *
 * WRITES NOTHING SECRET. The CLI's credential lives in the user's config
 * directory, never here — a token written into a project directory ends up in a
 * commit, and a commit is forever. `.env.example` documents the variable
 * without carrying a value.
 *
 * NEVER OVERWRITES SILENTLY. Someone running `init` twice, or in a repo a
 * colleague has already set up, must not lose local edits to these files; the
 * command reports what it skipped and `--force` is the way to mean it.
 */

export const SKILL_RELATIVE_PATH = join('.claude', 'skills', 'speko', 'SKILL.md');
export const ENV_EXAMPLE_PATH = '.env.example';
export const AGENTS_MARKER = '<!-- speko:begin -->';
const AGENTS_END = '<!-- speko:end -->';

function skillBody(): string {
  return `---
name: speko
description: >-
  Build and operate voice agents on Speko from this repo: place calls, read
  transcripts, inspect why a call failed. Use when working on voice agents,
  phone automation, STT/LLM/TTS pipelines, or anything calling the Speko API.
---

# Speko in this project

Speko is a voice AI gateway: one API for the whole speech-to-text, language
model and text-to-speech pipeline, with provider routing and failover. The
\`speko-cli\` command is installed and authenticated per-machine — run \`speko-cli whoami\`
to confirm before assuming it is.

## Do this first

\`\`\`bash
speko-cli whoami          # exits 3 when this machine is not signed in
speko-cli login           # prints a URL and code for a human to approve
\`\`\`

\`speko-cli login\` needs a person in a browser. If \`whoami\` exits 3, ask the user
to run \`speko-cli login\` rather than trying to authenticate another way.

## Commands

Every API operation is available, generated from the OpenAPI document:

\`\`\`bash
speko-cli agents                    # list the operations in a group
speko-cli agents list               # every agent in the workspace
speko-cli agents get <agent_id>
speko-cli agents create --data '{"name":"Front desk"}'
\`\`\`

Groups: \`agents\`, \`call-control\`, \`providers\`, \`sms\`, \`telephony\`,
\`voice\`, \`webhooks\`. Run \`speko-cli <group>\` to list one, and
\`speko-cli <group> <command> --help\` for its arguments.

Path arguments are positional; query parameters are \`--flags\`; request bodies
come from \`--data JSON\`, \`--file PATH\`, or stdin.

## The development loop

\`\`\`bash
speko-cli call --to +15551234567 --agent <agent_id>   # places it, waits, prints the transcript
speko-cli logs <session_id> --follow                  # events as they arrive
speko-cli logs <session_id>                           # why a call failed
\`\`\`

\`speko-cli call\` returns a \`sessionId\` immediately and then waits. Pass
\`--no-wait\` to return straight away. The transcript is the only way to verify
a prompt change actually altered behaviour — a diff cannot show that an agent
stopped confirming before it booked.

## Proving a prompt change did not break the agent

\`\`\`bash
speko-cli eval generate --agent <id>            # propose a suite; prints it, saves nothing
speko-cli eval generate --agent <id> --persist  # keep it
speko-cli eval run --agent <id>                 # run it; exits 6 on a regression
speko-cli eval trends --agent <id>              # pass rate over time
\`\`\`

A voice regression is invisible to a diff, a type check and a unit test. If you
change a system prompt, run the suite before reporting the change as done.
\`eval run\` exits **6** on a failing case, distinct from 1, so a script can tell a
broken agent from a broken network.

## Before choosing a provider

\`\`\`bash
speko-cli bench stt --language nb     # ranked by word error rate
speko-cli bench llm                   # ranked by measured latency
speko-cli bench session <session_id>  # what one call actually ran on
\`\`\`

The stage boards need no credential; \`bench session\` does, because a session
belongs to a workspace. \`—\` means unmeasured, never zero — do not read a
missing cost as free.

## When something fails

\`\`\`bash
speko-cli doctor                            # credit, provider reachability, scopes, last failure
speko-cli explain INSUFFICIENT_CREDITS      # what a code means, and whether to retry
\`\`\`

Run \`doctor\` before debugging a failing call — it exits non-zero only when
something will actually stop a call working, so it is usable as a precondition.

## Constraints that fail silently

These produce opaque errors rather than validation messages, so check them
before debugging anything else:

- **Managed vs BYOK.** Only some providers can be used without bringing your
  own key. When a session fails with an empty error body and no request id,
  suspect provisioning rather than your request.
- **Sample rate.** OpenAI's live transcription requires exactly 24000 Hz. 16000
  and 48000 both return an opaque 502, and telephony defaults to 16000.

## Exit codes

\`0\` success · \`1\` runtime · \`2\` usage · \`3\` not signed in · \`4\` not found
· \`5\` quota · \`6\` eval regression. Add \`--json\` to any command for
machine-readable output.

Docs: https://docs.speko.ai/cli — the CLI's own pages, including
evals, benchmarks and exit codes. Machine-readable index of the whole site at
https://docs.speko.ai/llms.txt, and any page with \`.md\` appended returns
markdown.
`;
}

function envExampleBody(): string {
  return `# Speko — https://speko.ai
#
# The CLI keeps its own credential in your config directory, so it does NOT
# read this. This is for application code that calls the Speko API at runtime.
#
# Create a key in the console; the CLI deliberately cannot create one, because
# a key is a long-lived organization credential and issuing it should be a
# deliberate human act:
#   https://platform.speko.ai/agents/keys
SPEKO_API_KEY=
`;
}

function agentsBlock(): string {
  return `${AGENTS_MARKER}
## Speko

This project uses Speko for voice AI. The \`speko-cli\` command is the interface — run
\`speko-cli whoami\` to check this machine is signed in, and \`speko-cli --help\` for
the command surface. Full guidance: \`${SKILL_RELATIVE_PATH}\`.
${AGENTS_END}`;
}

export type FileOutcome = 'written' | 'skipped' | 'updated';

export interface InitResult {
  readonly files: readonly { path: string; outcome: FileOutcome }[];
}

function writeIfAbsent(
  path: string,
  contents: string,
  force: boolean,
): { path: string; outcome: FileOutcome } {
  if (existsSync(path) && !force) return { path, outcome: 'skipped' };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  return { path, outcome: existsSync(path) && force ? 'written' : 'written' };
}

/**
 * Adds the Speko block to an existing AGENTS.md, or creates the file.
 *
 * Bounded by markers and replaced as a unit, so a second run updates the block
 * instead of appending a duplicate — an agent instruction file that says the
 * same thing three times is how contradictory guidance creeps in.
 */
function upsertAgentsFile(path: string): { path: string; outcome: FileOutcome } {
  const block = agentsBlock();

  if (!existsSync(path)) {
    writeFileSync(path, `# Agent guidance\n\n${block}\n`);
    return { path, outcome: 'written' };
  }

  const current = readFileSync(path, 'utf8');
  const start = current.indexOf(AGENTS_MARKER);
  const end = current.indexOf(AGENTS_END);

  if (start !== -1 && end !== -1) {
    const next = current.slice(0, start) + block + current.slice(end + AGENTS_END.length);
    if (next === current) return { path, outcome: 'skipped' };
    writeFileSync(path, next);
    return { path, outcome: 'updated' };
  }

  writeFileSync(path, `${current.trimEnd()}\n\n${block}\n`);
  return { path, outcome: 'updated' };
}

export function runInit(cwd: string, options: { force?: boolean } = {}): InitResult {
  const force = options.force ?? false;
  return {
    files: [
      writeIfAbsent(join(cwd, SKILL_RELATIVE_PATH), skillBody(), force),
      writeIfAbsent(join(cwd, ENV_EXAMPLE_PATH), envExampleBody(), force),
      upsertAgentsFile(join(cwd, 'AGENTS.md')),
    ],
  };
}
