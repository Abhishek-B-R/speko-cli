#!/usr/bin/env node

import { ApiError, apiFetch, NotSignedInError } from './api-client.js';
import { formatDeviceRows, listDevices, revokeAllDevices, revokeDevice } from './auth-commands.js';
import { fetchBench, formatBench, formatSessionBench, type SessionStack } from './bench.js';
import { builtinHelpFor, isHelpFlag, wantsHelp } from './builtin-help.js';
import {
  buildCallBody,
  type CallEvent,
  followEvents,
  formatEvent,
  formatTranscript,
  listCallEvents,
  placeCall,
  transcriptTurns,
  waitForCall,
} from './call.js';
import { API_URL, EXIT, type ExitCode } from './constants.js';
import {
  clearCredentials,
  clearPending,
  credentialsPath,
  deviceLabel,
  isExpired,
  readCredentials,
  readPending,
} from './credentials.js';
import { LoginError, resumeLogin, runLogin, startLogin } from './device-login.js';
import {
  buildChecks,
  fetchAgentReachability,
  fetchDiagnostics,
  formatChecks,
  hasBlockingProblem,
} from './doctor.js';
import {
  evalTrends,
  formatFailures,
  formatPreview,
  formatRuns,
  formatSuite,
  generateEvals,
  isRunRegressed,
  listEvals,
  startRun,
  waitForRuns,
} from './eval.js';
import { fetchExplanation, formatExplanation } from './explain.js';
import { COMMAND_GROUPS } from './generated/commands.js';
import { runInit } from './init.js';
import { formatMcp, probeMcp } from './mcp.js';
import { findCommand, groupHelp, parseFlags, runGeneratedCommand } from './run-command.js';

export { EXIT } from './constants.js';
export { CLI_CLIENT_ID, CLI_SCOPE } from './device-login.js';

const USAGE = `speko-cli — the Speko command-line interface

Usage
  speko-cli login             Sign this device in to your Speko account
  speko-cli logout            Forget the credential on this device
  speko-cli whoami            Show who this device is signed in as
  speko-cli auth list         List every terminal signed in to your account
  speko-cli auth revoke <id>  Sign out one device (--all for every device)
  speko-cli init              Add Speko guidance for coding agents to this repo
  speko-cli call --to <n>     Place a call, wait for it, print the transcript
                              (--agent <id> or --intent; --no-wait to return at once)
  speko-cli logs <id>         Call events (--follow to stream)
  speko-cli explain <CODE>    What an error code means, and whether to retry it
  speko-cli doctor            Why calls are failing: credit, providers, scopes
  speko-cli bench <stage>     Measured provider scores: stt, llm, tts, s2s
  speko-cli eval run          Prove a prompt change did not break the agent
  speko-cli mcp               Point an MCP client at Speko (no API key needed)
                              (also: eval list, eval generate, eval trends)

API commands (generated from the OpenAPI document)
  speko-cli <group> <command> [args] [--options]
  Groups: ${COMMAND_GROUPS.join(', ')}
  Run \`speko-cli <group>\` to list a group's operations.

Options
  --json                  Machine-readable output. The generated API commands
                          above already emit JSON, so it changes nothing there;
                          it is the flag that turns login, whoami, auth, init,
                          logs, explain and doctor from tables into JSON.
  -h, --help              Show this help
  -v, --version           Show the CLI version

Exit codes
  0  success                    4  not found
  1  runtime failure            5  out of credit, or rate limited
  2  usage error                6  an eval suite regressed
  3  not signed in

Docs: https://speko.ai/developers/cli
`;

/**
 * Maps an HTTP status onto the documented exit codes.
 *
 * The codes are the CLI's contract, so a caller in a script can branch without
 * parsing prose — which means a 404 has to exit 4 and a quota failure 5, not
 * both land on the generic 1. Everything unrecognised stays `runtime`: a code
 * that guessed would be worse than one that admits it does not know.
 */
export function exitCodeForStatus(status: number): ExitCode {
  if (status === 401 || status === 403) return EXIT.auth;
  if (status === 404) return EXIT.notFound;
  // 402 Payment Required and 429 Too Many Requests are both "you cannot do
  // this right now, but the request was fine".
  if (status === 402 || status === 429) return EXIT.quota;
  return EXIT.runtime;
}

interface Output {
  readonly asJson: boolean;
  readonly text: (line: string) => void;
  readonly json: (value: unknown) => void;
}

function makeOutput(asJson: boolean): Output {
  return {
    asJson,
    text: (line) => {
      if (!asJson) console.log(line);
    },
    json: (value) => {
      if (asJson) console.log(JSON.stringify(value, null, 2));
    },
  };
}

async function auth(out: Output, args: readonly string[]): Promise<ExitCode> {
  const subcommand = args[1];

  if (subcommand === 'list') {
    const { devices } = await listDevices();
    if (devices.length === 0) {
      out.text('No terminals are signed in.');
      out.json({ devices: [] });
      return EXIT.ok;
    }
    for (const line of formatDeviceRows(devices)) out.text(line);
    out.json({ devices });
    return EXIT.ok;
  }

  if (subcommand === 'revoke') {
    const target = args[2];

    if (target === '--all') {
      const { count } = await revokeAllDevices();
      // Includes this device when this device is a CLI one, so say so rather
      // than leaving the next command to fail with a confusing 401.
      out.text(count === 1 ? '1 device signed out.' : `${count} devices signed out.`);
      out.text('If this terminal was one of them, run `speko-cli login` to sign in again.');
      out.json({ revoked: true, count });
      return EXIT.ok;
    }

    if (!target) {
      console.error('Which device? Pass an id from `speko-cli auth list`, or --all.');
      return EXIT.usage;
    }

    const result = await revokeDevice(target);
    out.text(`Device ${result.id} signed out.`);
    if (result.was_current) {
      out.text('That was this device. Run `speko-cli login` to sign in again.');
    }
    out.json(result);
    return EXIT.ok;
  }

  console.error(`Unknown auth command: ${subcommand ?? '(none)'}`);
  console.error('Run `speko-cli auth list` or `speko-cli auth revoke <id>`.');
  return EXIT.usage;
}

async function init(out: Output, args: readonly string[]): Promise<ExitCode> {
  const { flags } = parseFlags(args.slice(1));
  const result = runInit(process.cwd(), { force: flags['force'] !== undefined });

  for (const file of result.files) {
    const verb =
      file.outcome === 'written' ? 'wrote' : file.outcome === 'updated' ? 'updated' : 'kept';
    out.text(`  ${verb.padEnd(8)} ${file.path}`);
  }
  if (result.files.some((f) => f.outcome === 'skipped')) {
    // Silence here would read as "done", and someone would go looking for
    // guidance that was never written.
    out.text('');
    out.text('Existing files were left alone. Re-run with --force to replace them.');
  }
  out.json(result);
  return EXIT.ok;
}

async function call(out: Output, args: readonly string[]): Promise<ExitCode> {
  const { flags } = parseFlags(args.slice(1));

  if (flags['to'] === undefined && flags['data'] === undefined) {
    console.error('Which number? Pass --to +15551234567.');
    return EXIT.usage;
  }

  const session = await placeCall(buildCallBody(flags));

  // Printed before the wait, unconditionally. The call is real from this moment
  // and the id is how anyone follows or ends it, so it must survive a timeout,
  // a Ctrl-C, or a closed terminal.
  out.text(`  Session  ${session.sessionId}`);
  if (session.to) out.text(`  To       ${session.to}`);
  if (session.status) out.text(`  Status   ${session.status}`);

  if (flags['no-wait'] !== undefined) {
    out.text('');
    out.text(`  speko-cli logs ${session.sessionId} --follow`);
    out.json(session);
    return EXIT.ok;
  }

  const timeoutSeconds = Number(flags['timeout'] ?? '300');
  const { call: detail, timedOut } = await waitForCall(session.sessionId, {
    timeoutMs: (Number.isFinite(timeoutSeconds) ? timeoutSeconds : 300) * 1000,
    onStatus: (status) => out.text(`  …        ${status}`),
  });

  if (timedOut) {
    out.text('');
    out.text(`  Still running after ${timeoutSeconds}s. Follow it with:`);
    out.text(`  speko-cli logs ${session.sessionId} --follow`);
    out.json({ ...session, timed_out: true, call: detail });
    return EXIT.ok;
  }

  out.text('');
  out.text(
    `  Ended    ${detail.status ?? 'unknown'}${
      detail.duration_seconds ? ` after ${detail.duration_seconds}s` : ''
    }`,
  );
  out.text('');
  for (const line of formatTranscript(transcriptTurns(detail.transcript))) out.text(`  ${line}`);

  if (detail.report) {
    out.text('');
    out.text('  Report');
    out.text(
      JSON.stringify(detail.report, null, 2)
        .split('\n')
        .map((line) => `  ${line}`)
        .join('\n'),
    );
  }

  out.json({ ...session, call: detail });

  // A call that failed must not exit 0 — a script that places calls in a loop
  // has no other way to notice.
  return detail.status === 'failed' ? EXIT.runtime : EXIT.ok;
}

async function logs(out: Output, args: readonly string[]): Promise<ExitCode> {
  const { flags, positionals } = parseFlags(args.slice(1));
  const id = positionals[0];
  if (!id) {
    console.error('Which session? Pass the id `speko-cli call` printed.');
    return EXIT.usage;
  }

  if (flags['follow'] !== undefined) {
    const timeoutSeconds = 600;
    // --json has no stream to write to, so the events are collected and
    // printed as one document at the end. Without this a --json follow
    // printed nothing at all, and a timeout printed nothing either way. Text
    // mode prints each event as it arrives, so it keeps none of them.
    const streamed: CallEvent[] = [];
    const { timedOut } = await followEvents(id, {
      timeoutMs: timeoutSeconds * 1000,
      onEvent: (event) => {
        if (out.asJson) streamed.push(event);
        out.text(formatEvent(event));
      },
    });
    if (timedOut) {
      out.text('');
      out.text(`  Still running after ${timeoutSeconds}s. Follow it again with:`);
      out.text(`  speko-cli logs ${id} --follow`);
    }
    // `timed_out` is always present, so a script can branch on it without
    // having to tell "still running" apart from "no such key".
    out.json({ events: streamed, timed_out: timedOut });
    return EXIT.ok;
  }

  const { events } = await listCallEvents(id);
  if (events.length === 0) {
    out.text('No events for that session yet.');
    out.json({ events: [] });
    return EXIT.ok;
  }
  for (const event of events) out.text(formatEvent(event));
  out.json({ events });
  return EXIT.ok;
}

async function explain(out: Output, args: readonly string[]): Promise<ExitCode> {
  const code = args[1];
  if (!code) {
    console.error('Which code? e.g. `speko-cli explain INSUFFICIENT_CREDITS`.');
    return EXIT.usage;
  }

  const explanation = await fetchExplanation(code);
  if (!explanation) {
    console.error(`${code.toUpperCase()} is not a known Speko error code.`);
    console.error('If the server returned it, that is a bug worth reporting.');
    return EXIT.notFound;
  }

  for (const line of formatExplanation(explanation)) out.text(line);
  out.json(explanation);
  return EXIT.ok;
}

async function bench(out: Output, args: readonly string[]): Promise<ExitCode> {
  const { flags, positionals } = parseFlags(args.slice(1));
  const stage = positionals[0];

  // `bench session <id>` needs a credential (the session is workspace-scoped)
  // while the boards do not, so it is handled before the unauthenticated path
  // rather than being gated behind a flag on it.
  if (stage === 'session') {
    const sessionId = positionals[1];
    if (!sessionId) {
      console.error('Which session? `speko-cli bench session <session_id>`.');
      return EXIT.usage;
    }
    const session = await apiFetch<SessionStack>(`/sessions/${encodeURIComponent(sessionId)}`);
    // Every measured row, unfiltered: the breakdown compares three stages at
    // once, so filtering server-side per stage would mean three round trips.
    const scores = await fetchBench({ limit: '1000' });
    out.text('');
    for (const line of formatSessionBench(session, scores.scores)) out.text(line);
    out.text('');
    out.json({ session, scores: scores.scores });
    return EXIT.ok;
  }

  const response = await fetchBench({
    ...(stage ? { stage } : {}),
    ...(flags['language'] ? { language: flags['language'] } : {}),
    ...(flags['provider'] ? { provider: flags['provider'] } : {}),
    ...(flags['limit'] ? { limit: flags['limit'] } : {}),
  });

  out.text('');
  for (const line of formatBench(response, stage)) out.text(line);
  out.text('');
  out.json(response);
  return EXIT.ok;
}

/**
 * `speko-cli eval` — the command that makes a prompt edit safe to ship.
 *
 * FOUR SUBCOMMANDS, ONE LOOP: `generate` proposes the suite so nobody
 * hand-authors test cases, `list` shows what is stored, `run` executes it and
 * `trends` shows whether it is getting better or worse over time.
 *
 * `run` EXITS 6 ON A REGRESSION rather than 1. A CI step needs to distinguish
 * "the agent's behaviour is wrong" from "the network was down", and collapsing
 * both into a non-zero exit makes an eval gate untrustworthy: the first failure
 * that was really a flake teaches everyone to ignore the gate.
 */
async function evalCommand(out: Output, args: readonly string[]): Promise<ExitCode> {
  const subcommand = args[1];
  const { flags } = parseFlags(args.slice(2));
  const agentId = flags['agent'];

  if (!subcommand) {
    console.error('Which one? `eval list`, `eval generate`, `eval run` or `eval trends`.');
    return EXIT.usage;
  }
  if (!agentId) {
    console.error('Which agent? Pass --agent <id>. `speko-cli agents list` shows them.');
    return EXIT.usage;
  }

  if (subcommand === 'list') {
    const { evals } = await listEvals(agentId);
    out.text('');
    for (const line of formatSuite(evals)) out.text(line);
    out.text('');
    out.json({ evals });
    return EXIT.ok;
  }

  if (subcommand === 'generate') {
    const persist = 'persist' in flags;
    const response = await generateEvals(agentId, persist);
    const scenarios = response.generated ?? [];
    out.text('');
    for (const line of formatPreview(scenarios, response.persisted === true)) out.text(line);
    out.text('');
    out.json(response);
    return EXIT.ok;
  }

  if (subcommand === 'trends') {
    const trends = await evalTrends(agentId);
    // Deliberately printed as-is. The endpoint's buckets are its own contract
    // and inventing a chart over numbers whose meaning is not documented here
    // would be a guess dressed as a summary.
    out.text(JSON.stringify(trends, null, 2));
    out.json(trends);
    return EXIT.ok;
  }

  if (subcommand !== 'run') {
    console.error(`Unknown command: speko-cli eval ${subcommand}`);
    return EXIT.usage;
  }

  const { evals } = await listEvals(agentId);
  const only = flags['eval'];
  const selected = only ? evals.filter((c) => c.id === only) : evals;

  if (selected.length === 0) {
    console.error(
      only
        ? `No test case ${only} on this agent. \`speko-cli eval list --agent ${agentId}\` lists them.`
        : `This agent has no test cases. Run \`speko-cli eval generate --agent ${agentId} --persist\` first.`,
    );
    return only ? EXIT.notFound : EXIT.usage;
  }

  // Queued before anything is awaited on, and the ids printed immediately, so a
  // timeout or a Ctrl-C does not lose track of runs that are already going.
  const started = [];
  for (const testCase of selected) started.push(await startRun(agentId, testCase.id));

  out.text('');
  out.text(`Queued ${started.length} run${started.length === 1 ? '' : 's'}:`);
  for (const run of started) out.text(`  ${run.id}`);

  if ('no-wait' in flags) {
    out.text('');
    out.text(
      `Not waiting. \`speko-cli eval trends --agent ${agentId}\` shows results as they land.`,
    );
    out.json({ runs: started, waited: false });
    return EXIT.ok;
  }

  const timeoutMs = Number(flags['timeout'] ?? 300) * 1000;
  const result = await waitForRuns(agentId, started, { timeoutMs });

  out.text('');
  for (const line of formatRuns(result.runs, selected)) out.text(line);
  for (const line of formatFailures(result.runs, selected, agentId)) out.text(line);

  if (result.neverClaimed) {
    // The distinction that saves an afternoon: the runs are recorded and valid,
    // nothing is scoring them. Reporting this as a failing suite would send
    // someone to edit a prompt that was never tested.
    out.text('');
    out.text(`${result.unfinished.length} run(s) never left \`queued\`.`);
    out.text('  Nothing is consuming the queue — the gate worker scores these,');
    out.text('  and it runs as a separate service. The runs are recorded and');
    out.text('  will be scored once it is up. This is not a test failure.');
    out.json({ runs: result.runs, unfinished: result.unfinished, never_claimed: true });
    return EXIT.runtime;
  }

  out.json({ runs: result.runs, unfinished: result.unfinished, never_claimed: false });

  if (result.runs.some(isRunRegressed)) return EXIT.evalRegression;
  return result.unfinished.length > 0 ? EXIT.runtime : EXIT.ok;
}

/**
 * `speko-cli mcp` — the live state of the hosted MCP server, and how to use it.
 *
 * Needs no credential: the discovery document it reads is public by design,
 * because a client reads it before it has a token. So this answers for a reader
 * who has not signed up yet.
 */
async function mcp(out: Output): Promise<ExitCode> {
  const status = await probeMcp();
  out.text('');
  for (const line of formatMcp(status)) out.text(line);
  out.text('');
  out.json(status);
  // A failed probe is not a failed command: the configuration it prints is
  // still correct, and exiting non-zero would fail a setup script over a
  // network blip that changed nothing about the answer.
  return EXIT.ok;
}

async function doctor(out: Output): Promise<ExitCode> {
  const diagnostics = await fetchDiagnostics();
  // Two extra reads, so the report can say whether the agents that exist can
  // actually run — neither endpoint can answer that alone.
  const agents = await fetchAgentReachability(diagnostics.providers.usable.map((p) => p.provider));
  const checks = buildChecks(diagnostics, agents);

  out.text('');
  for (const line of formatChecks(checks)) out.text(line);
  out.text('');
  out.json({ checks, diagnostics, agents });

  // Exit non-zero when something will actually stop a call working, so this is
  // usable as a precondition in a script rather than only read by a human.
  return hasBlockingProblem(checks) ? EXIT.runtime : EXIT.ok;
}

/**
 * `speko-cli login`.
 *
 * TWO MODES, and which one runs is not a preference. A human at a terminal
 * wants a single command that finishes, so it polls until approved. An agent
 * cannot run a command that blocks for fifteen minutes — it hangs its own
 * session — so when stdout is not a terminal, or `--no-wait` is passed, this
 * prints the URL, writes the grant down and exits 0. The agent hands the URL
 * to a person and finishes on a later call.
 *
 * Detecting a TTY rather than requiring a flag matters because the agent that
 * needs the non-blocking path is the one that has never read this help.
 */
async function login(out: Output, args: readonly string[]): Promise<ExitCode> {
  const { flags } = parseFlags(args.slice(1));
  const blocking = flags['no-wait'] === undefined && Boolean(process.stdout.isTTY);

  const existing = readCredentials();
  if (existing && !isExpired(existing)) {
    /**
     * A stored credential is not proof of a live session: revoking a device
     * from the console ends the session and leaves this file untouched.
     * Without this check the CLI dead-ends — `login` refuses because the file
     * exists, every other command refuses because the session does not, and
     * the user has to guess that `logout` is the way out of being unable to
     * log in.
     */
    const live = await listDevices().then(
      () => true,
      (error: unknown) => {
        // Only a 401 is evidence the credential is dead. Offline is not, and
        // discarding a good credential over a network blip would be worse.
        if (error instanceof ApiError && error.status === 401) return false;
        return true;
      },
    );

    if (live) {
      out.text(
        'This device is already signed in. Run `speko-cli logout` first to switch accounts.',
      );
      out.json({ status: 'already_signed_in', scope: existing.scope });
      return EXIT.ok;
    }

    clearCredentials();
    out.text('The previous session for this device was revoked. Signing in again.');
  }

  // Resume an unapproved grant rather than minting a second one. Two live codes
  // for one terminal means the user can approve the wrong one and the CLI waits
  // forever on the other.
  const pending = readPending();
  if (pending) {
    const outcome = await resumeLogin(pending);

    if (outcome.kind === 'approved') {
      out.text('');
      out.text(`  Signed in. Credential stored at ${credentialsPath()}`);
      out.text('');
      out.json({ status: 'signed_in', credentials_path: credentialsPath() });
      return EXIT.ok;
    }
    if (outcome.kind === 'denied') {
      out.text('That sign-in was denied. Run `speko-cli login` for a new code.');
      out.json({ status: 'denied' });
      return EXIT.auth;
    }
    if (outcome.kind === 'pending') {
      if (!blocking) {
        out.text('');
        out.text(`  Still waiting for approval. Open  ${pending.verificationUri}`);
        out.text(`  Enter code ${pending.userCode}`);
        out.text('');
        out.text('  Run `speko-cli login` again once it has been approved.');
        out.json({
          status: 'pending',
          verification_uri: pending.verificationUri,
          user_code: pending.userCode,
        });
        return EXIT.ok;
      }
      out.text('');
      out.text(`  Open       ${pending.verificationUri}`);
      out.text(`  Enter code ${pending.userCode}`);
      out.text('');
      out.text(`  Signing in as ${deviceLabel()}. Waiting for approval…`);
      const polled = await pollPending(pending);
      return reportLogin(out, polled);
    }
    // Expired: fall through and start a fresh grant.
    clearPending();
  }

  if (!blocking) {
    const code = await startLogin();
    out.text('');
    out.text(`  Open       ${code.verification_uri_complete ?? code.verification_uri}`);
    out.text(`  Enter code ${code.user_code}`);
    out.text('');
    out.text('  A person has to approve this in a browser. Once they have, run');
    out.text('  `speko-cli login` again to finish — this command does not wait.');
    out.json({
      status: 'awaiting_approval',
      verification_uri: code.verification_uri_complete ?? code.verification_uri,
      user_code: code.user_code,
      expires_in: code.expires_in,
    });
    return EXIT.ok;
  }

  return reportLogin(out, await runLogin(out.text));
}

/** Waits on an already-started grant, reusing the shared poller. */
async function pollPending(pending: ReturnType<typeof readPending>) {
  if (!pending) throw new LoginError('No sign-in is in progress.');
  const { pollForToken } = await import('./device-login.js');
  return pollForToken({
    device_code: pending.deviceCode,
    user_code: pending.userCode,
    verification_uri: pending.verificationUri,
    expires_in: Math.max(1, Math.round((Date.parse(pending.expiresAt) - Date.now()) / 1000)),
    interval: pending.intervalSeconds,
  });
}

function reportLogin(out: Output, outcome: Awaited<ReturnType<typeof runLogin>>): ExitCode {
  if (outcome.kind === 'denied') {
    out.text('');
    out.text('Sign-in was denied. Nothing was stored on this device.');
    out.json({ status: 'denied' });
    return EXIT.auth;
  }
  if (outcome.kind === 'expired') {
    out.text('');
    out.text('The code expired before it was approved. Run `speko-cli login` for a new one.');
    out.json({ status: 'expired' });
    return EXIT.auth;
  }

  out.text('');
  out.text(`  Signed in. Credential stored at ${credentialsPath()}`);
  out.text('');
  out.json({
    status: 'signed_in',
    scope: outcome.credentials.scope,
    expires_at: outcome.credentials.expiresAt,
    credentials_path: credentialsPath(),
  });
  return EXIT.ok;
}

function logout(out: Output): ExitCode {
  const existing = readCredentials();
  clearCredentials();
  if (!existing) {
    out.text('This device was not signed in.');
    out.json({ status: 'not_signed_in' });
    return EXIT.ok;
  }
  // Local only, and say so: the session is still valid server-side until it is
  // revoked or expires. Claiming otherwise would leave a live credential the
  // user believes is dead.
  out.text('Credential removed from this device.');
  out.text('To revoke the session itself, use the CLI devices page in the console.');
  out.json({ status: 'signed_out', revoked_server_side: false });
  return EXIT.ok;
}

/**
 * `speko-cli whoami`.
 *
 * ASKS THE SERVER, and that is a change of character worth stating. It used to
 * read the credential file and nothing else, which made it fast but meant two
 * things: it could not name the account — the file holds a token, not an
 * identity, so "who am I" was answered with a hostname and an expiry — and it
 * reported a revoked session as signed in, because revocation happens
 * server-side and leaves the file untouched.
 *
 * The local read stays as the first gate, so "not signed in" is still answered
 * without a request. When the server is unreachable it degrades to what the
 * file knows rather than failing: being offline is not the same as being
 * signed out.
 */
async function whoami(out: Output): Promise<ExitCode> {
  const credentials = readCredentials();
  if (!credentials) {
    out.text('Not signed in. Run `speko-cli login`.');
    out.json({ status: 'not_signed_in' });
    return EXIT.auth;
  }
  if (isExpired(credentials)) {
    out.text('The credential on this device has expired. Run `speko-cli login`.');
    out.json({ status: 'expired', expires_at: credentials.expiresAt });
    return EXIT.auth;
  }

  const identity = await fetchDiagnostics().then(
    (d) => d.identity,
    (error: unknown) => {
      // A revoked or rejected credential is genuinely not signed in, and saying
      // otherwise from a stale file is the bug this replaced.
      if (error instanceof ApiError && error.status === 401) return 'revoked' as const;
      return null;
    },
  );

  if (identity === 'revoked') {
    out.text('This device is no longer signed in — the session was revoked.');
    out.text('Run `speko-cli login` to sign in again.');
    out.json({ status: 'revoked' });
    return EXIT.auth;
  }

  const api = credentials.apiUrl || API_URL;
  if (identity) {
    out.text(`Account  ${identity.email ?? identity.principal}`);
    out.text(`Org      ${identity.organization_id}${identity.role ? ` (${identity.role})` : ''}`);
  }
  out.text(`Device   ${deviceLabel()}`);
  out.text(`API      ${api}`);
  out.text(`Scope    ${identity ? identity.scopes.join(' ') : credentials.scope}`);
  out.text(`Expires  ${credentials.expiresAt}`);
  if (!identity) {
    // Say which half is missing rather than quietly printing less.
    out.text('');
    out.text('  Could not reach the server, so the account and org are not shown.');
  }

  out.json({
    status: 'signed_in',
    ...(identity
      ? {
          email: identity.email ?? null,
          organization_id: identity.organization_id,
          user_id: identity.user_id,
          role: identity.role,
          session_origin: identity.session_origin,
          scopes: identity.scopes,
        }
      : { offline: true }),
    device: deviceLabel(),
    api_url: api,
    scope: credentials.scope,
    expires_at: credentials.expiresAt,
  });
  return EXIT.ok;
}

export async function run(argv: readonly string[]): Promise<ExitCode> {
  const asJson = argv.includes('--json');
  const args = argv.filter((arg) => arg !== '--json');
  const out = makeOutput(asJson);
  const command = args[0];

  if (!command || command === '-h' || command === '--help' || command === 'help') {
    // Help on an empty invocation is not an error — it is the answer to "what
    // is this". Only an *unknown* command is a usage failure.
    console.log(USAGE);
    return command ? EXIT.ok : EXIT.usage;
  }

  /**
   * `--help` short-circuits before ANY command body.
   *
   * This is where `login --help` used to fall through and start a real device
   * grant. Asking what a command does must never be able to do the thing, so
   * the check sits above auth, above required-argument validation, and above
   * every request. Generated commands keep handling `--help` themselves — they
   * can print their own parameters — so only the hand-written ones are
   * intercepted here.
   */
  if (wantsHelp(args)) {
    const help = builtinHelpFor(command);
    if (help) {
      for (const line of help) console.log(line);
      return EXIT.ok;
    }
  }

  if (command === '-v' || command === '--version') {
    // `package.json` ships in `files`, so this resolves from `dist/` once
    // published. A JSON import is namespaced under `default`.
    const pkg = await import('../package.json', { with: { type: 'json' } });
    console.log(pkg.default.version);
    return EXIT.ok;
  }

  switch (command) {
    case 'login':
      return await login(out, args);
    case 'logout':
      return logout(out);
    case 'whoami':
      return await whoami(out);
    case 'auth':
      return await auth(out, args);
    case 'init':
      return await init(out, args);
    case 'call':
      return await call(out, args);
    case 'logs':
      return await logs(out, args);
    case 'explain':
      return await explain(out, args);
    case 'doctor':
      return await doctor(out);
    case 'bench':
      return await bench(out, args);
    case 'eval':
      return await evalCommand(out, args);
    case 'mcp':
      return await mcp(out);
    default: {
      // Anything not hand-written is looked up in the generated table, so a new
      // API endpoint becomes available by regenerating rather than by editing
      // this switch.
      const { command: found, groupCommands } = findCommand(command, args[1]);

      if (found) {
        const result = await runGeneratedCommand(found, args.slice(2));
        for (const line of result.lines) console.log(line);
        return result.exitCode;
      }

      if (groupCommands.length > 0) {
        /**
         * `speko-cli agents --help` is a request for the group listing, not a
         * command called `--help`. Matched on `args[1]` alone: a help flag
         * appearing LATER belongs to a subcommand, and
         * `speko-cli agents bogus --help` is a typo that must still fail.
         *
         * It used to fall through to the unknown-command branch below: it
         * printed `Unknown command: speko-cli agents --help`, then the listing
         * anyway, and exited 2. So the most natural way to discover a group led
         * with an error, which is the same trap `login --help` fell into — the
         * difference being that this one answered the question while insisting
         * it had not understood it.
         */
        if (isHelpFlag(args[1])) {
          for (const line of groupHelp(command, groupCommands)) console.log(line);
          return EXIT.ok;
        }

        // A real group with no (or an unknown) command: list what it has rather
        // than repeating that the input was wrong.
        if (args[1]) console.error(`Unknown command: speko-cli ${command} ${args[1]}`);
        for (const line of groupHelp(command, groupCommands)) console.log(line);
        return args[1] ? EXIT.usage : EXIT.ok;
      }

      console.error(`Unknown command: ${command}`);
      console.error('Run `speko-cli --help` for the list of commands.');
      return EXIT.usage;
    }
  }
}

async function main(): Promise<void> {
  try {
    process.exitCode = await run(process.argv.slice(2));
  } catch (error) {
    if (error instanceof NotSignedInError) {
      console.error(error.message);
      process.exitCode = EXIT.auth;
      return;
    }
    if (error instanceof ApiError) {
      console.error(error.message);
      if (error.hint) console.error(error.hint);
      process.exitCode = exitCodeForStatus(error.status);
      return;
    }
    if (error instanceof LoginError) {
      console.error(error.message);
      if (error.hint) console.error(error.hint);
      process.exitCode = EXIT.auth;
      return;
    }
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = EXIT.runtime;
  }
}

// Only run when invoked as the binary, so the module stays importable in tests.
if (process.argv[1]?.includes('speko') || process.env['SPEKO_CLI_FORCE_MAIN'] === '1') {
  await main();
}
