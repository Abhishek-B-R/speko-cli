import { apiFetch } from './api-client.js';

/**
 * `speko-cli eval` — proving a prompt change did not break anything.
 *
 * WHY THIS IS THE POINT OF THE WHOLE CLI. An agent editing a voice prompt is
 * blind: change one line, the agent quietly stops confirming before it books,
 * and nothing in a diff, a type check or a unit test registers it. Voice
 * regressions are invisible to every tool a coding agent has. So it ships
 * changes it cannot verify, the user finds out from a real customer, and the
 * agent looks incompetent. This is the difference between an agent that can
 * call the API and one that can safely ship on the platform.
 *
 * The engine was already here and already reachable — `/v1/agents/:id/evals`
 * answers a CLI token today. It was simply absent from the OpenAPI document, so
 * the generated commands never included it, which is the same reason `timezone`
 * looked unwritable. Nothing needed promoting; it needed finding.
 *
 * RUNS ARE ASYNCHRONOUS. `POST .../run` inserts a `queued` row and answers 202;
 * a separate service (apps/gate-worker) claims it, places the simulated call
 * and scores the result. So this command queues and then polls, and it says so
 * plainly when nothing claims the run — a local stack has no gate worker, and
 * silently waiting forever would read as a broken command rather than a missing
 * service.
 */

export interface EvalCase {
  readonly id: string;
  readonly name: string;
  readonly expected_behavior?: string | null;
  readonly assertion_kind?: string | null;
  readonly input_kind?: string | null;
  readonly block_deploy_on_fail?: boolean | null;
}

/**
 * A case the scenario-author proposed but nothing has stored yet.
 *
 * It has no `id` — that is the whole distinction from an `EvalCase`, and the
 * reason a preview cannot be run. `targetMode` names the failure mode the case
 * is probing, which is the most useful column in a preview: it says what the
 * suite is checking for rather than restating the prompt.
 */
export interface GeneratedScenario {
  readonly name: string;
  readonly expected_behavior: string;
  readonly assertion_kind: string;
  readonly input_kind: string;
  readonly block_deploy_on_fail: boolean;
  readonly targetMode?: string;
}

export interface EvalRun {
  readonly id: string;
  readonly eval_id: string;
  readonly status: string;
  readonly version_number?: number | null;
  readonly result?: unknown;
  readonly created_at: string;
  readonly updated_at: string;
}

/** Statuses the worker will not move on from. */
const TERMINAL = new Set(['passed', 'failed', 'error', 'complete']);
/** Of those, the ones that mean the behaviour under test is wrong. */
const REGRESSED = new Set(['failed', 'error']);

export const isRunFinished = (run: EvalRun): boolean => TERMINAL.has(run.status);
export const isRunRegressed = (run: EvalRun): boolean => REGRESSED.has(run.status);

export function listEvals(agentId: string): Promise<{ evals: EvalCase[] }> {
  return apiFetch(`/agents/${encodeURIComponent(agentId)}/evals`);
}

/**
 * Proposes a suite, and stores it only when asked.
 *
 * PREVIEW IS THE DEFAULT, matching the endpoint: `persist` is opt-in there, and
 * it is the right default here too. Generation calls a model, so the same agent
 * generates a different suite each time; writing on the first run would leave a
 * caller who only wanted to look at the proposal with rows to clean up.
 *
 * There is deliberately no `--count`: the route calls `generateScenarios(input)`
 * with no options, so a count flag would be accepted and then ignored, which is
 * worse than not offering it.
 */
export function generateEvals(
  agentId: string,
  persist: boolean,
): Promise<{
  generated?: GeneratedScenario[];
  persisted?: boolean;
  evals?: EvalCase[];
}> {
  return apiFetch(`/agents/${encodeURIComponent(agentId)}/evals/generate`, {
    method: 'POST',
    body: JSON.stringify({ persist }),
  });
}

/** Queues one case. Answers 202 with the bare row — see {@link getRun}. */
export function startRun(agentId: string, evalId: string): Promise<EvalRun> {
  return apiFetch<unknown>(
    `/agents/${encodeURIComponent(agentId)}/evals/${encodeURIComponent(evalId)}/run`,
    { method: 'POST', body: JSON.stringify({}) },
  ).then(unwrapRun);
}

/**
 * Reads one run back.
 *
 * THE TWO ENDPOINTS DISAGREE ABOUT THE ENVELOPE. `POST .../run` answers with a
 * bare serialized run; `GET .../eval-runs/:id` wraps the same row as
 * `{ run, eval }`. Assuming one shape for both is not a hypothetical mistake —
 * it made this command crash with "cannot read properties of undefined" on the
 * first real poll, because every field of the wrapper was undefined.
 *
 * So the unwrap is explicit and tolerates either shape: a response with a `run`
 * key is unwrapped, anything with an `id` is taken as the row itself. That keeps
 * the CLI working whichever way the envelope is eventually made consistent.
 */
export function getRun(agentId: string, runId: string): Promise<EvalRun> {
  return apiFetch<{ run?: EvalRun } | EvalRun>(
    `/agents/${encodeURIComponent(agentId)}/eval-runs/${encodeURIComponent(runId)}`,
  ).then(unwrapRun);
}

export function unwrapRun(payload: unknown): EvalRun {
  if (!payload || typeof payload !== 'object') throw new Error('Unreadable eval run response.');
  const wrapped = (payload as { run?: unknown }).run;
  const row = wrapped && typeof wrapped === 'object' ? wrapped : payload;
  if (typeof (row as { id?: unknown }).id !== 'string') {
    throw new Error('Eval run response carried no run id.');
  }
  return row as EvalRun;
}

export function evalTrends(agentId: string): Promise<unknown> {
  return apiFetch(`/agents/${encodeURIComponent(agentId)}/evals/trends`);
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export interface WaitOptions {
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
  readonly now?: () => number;
  readonly wait?: (ms: number) => Promise<void>;
  readonly fetchRun?: (runId: string) => Promise<EvalRun>;
}

export interface WaitResult {
  readonly runs: readonly EvalRun[];
  /** Runs still queued or running when the deadline passed. */
  readonly unfinished: readonly EvalRun[];
  /** True when nothing ever left `queued` — almost always a missing worker. */
  readonly neverClaimed: boolean;
}

/**
 * Polls every queued run until they finish or the deadline passes.
 *
 * `neverClaimed` is reported separately from "timed out" because they call for
 * different actions: a run that reached `running` and did not finish is slow,
 * while a run still `queued` after the deadline means nothing is consuming the
 * queue. Telling a developer their evals are slow when the worker is not
 * deployed sends them to the wrong place entirely.
 */
export async function waitForRuns(
  agentId: string,
  started: readonly EvalRun[],
  options: WaitOptions = {},
): Promise<WaitResult> {
  const timeoutMs = options.timeoutMs ?? 300_000;
  const intervalMs = options.intervalMs ?? 3_000;
  const now = options.now ?? Date.now;
  const pause = options.wait ?? sleep;
  const fetchRun = options.fetchRun ?? ((runId: string) => getRun(agentId, runId));

  const latest = new Map(started.map((run) => [run.id, run]));
  let everClaimed = started.some((run) => run.status !== 'queued');
  const deadline = now() + timeoutMs;

  while (now() < deadline) {
    const pending = [...latest.values()].filter((run) => !isRunFinished(run));
    if (pending.length === 0) break;

    await pause(intervalMs);

    for (const run of pending) {
      const fresh = await fetchRun(run.id).catch(() => null);
      if (!fresh) continue;
      latest.set(run.id, fresh);
      if (fresh.status !== 'queued') everClaimed = true;
    }
  }

  const runs = [...latest.values()];
  const unfinished = runs.filter((run) => !isRunFinished(run));
  return { runs, unfinished, neverClaimed: unfinished.length > 0 && !everClaimed };
}

/** One line per case, with the failures unmissable. */
export function formatRuns(runs: readonly EvalRun[], cases: readonly EvalCase[]): string[] {
  const nameOf = new Map(cases.map((c) => [c.id, c.name]));
  const width = Math.max(4, ...runs.map((r) => (nameOf.get(r.eval_id) ?? r.eval_id).length));

  return runs.map((run) => {
    const mark = isRunRegressed(run) ? '✗' : isRunFinished(run) ? '✓' : '·';
    const name = (nameOf.get(run.eval_id) ?? run.eval_id).padEnd(width);
    return `  ${mark} ${name}  ${run.status}`;
  });
}

/** The stored suite, one line per case. */
export function formatSuite(cases: readonly EvalCase[]): string[] {
  if (cases.length === 0) {
    return [
      'No test cases on this agent yet.',
      '  `speko-cli eval generate --agent <id>` proposes a suite from its prompt,',
      '  tools and knowledge base. Add --persist to keep it.',
    ];
  }

  const width = Math.max(4, ...cases.map((c) => c.name.length));
  const rows = cases.map((c) => {
    const gate = c.block_deploy_on_fail ? 'blocks deploy' : '';
    return `  ${c.name.padEnd(width)}  ${(c.assertion_kind ?? '—').padEnd(16)}  ${gate}`;
  });

  return [
    `  ${'CASE'.padEnd(width)}  ${'ASSERTION'.padEnd(16)}`,
    ...rows,
    '',
    `  ${cases.length} case${cases.length === 1 ? '' : 's'}.`,
  ];
}

/** A proposed suite. Says plainly that nothing was written. */
export function formatPreview(
  scenarios: readonly GeneratedScenario[],
  persisted: boolean,
): string[] {
  if (scenarios.length === 0) return ['The generator returned no scenarios.'];

  const width = Math.max(4, ...scenarios.map((s) => s.name.length));
  const rows = scenarios.map(
    (s) => `  ${s.name.padEnd(width)}  ${(s.targetMode ?? s.assertion_kind).padEnd(24)}`,
  );

  return [
    `  ${'CASE'.padEnd(width)}  ${'PROBES'.padEnd(24)}`,
    ...rows,
    '',
    persisted
      ? `  ${scenarios.length} case${scenarios.length === 1 ? '' : 's'} saved to the agent.`
      : `  ${scenarios.length} proposed. NOT saved — re-run with --persist to keep them.`,
    ...(persisted
      ? []
      : ['  Generation calls a model, so a second run proposes a different suite.']),
  ];
}

/**
 * What actually broke, for the cases that failed.
 *
 * `result` is written by the gate worker and is unavoidably loosely typed here —
 * it is a JSON column, and the CLI is not the schema authority for it. So this
 * reads the fields the worker is known to write and otherwise falls back to the
 * raw JSON rather than dropping the detail, because on a failing run that blob
 * is the only thing that explains the failure.
 */
export function formatFailures(
  runs: readonly EvalRun[],
  cases: readonly EvalCase[],
  agentId: string,
): string[] {
  const failed = runs.filter(isRunRegressed);
  if (failed.length === 0) return [];

  const nameOf = new Map(cases.map((c) => [c.id, c.name]));
  const lines: string[] = [''];

  for (const run of failed) {
    lines.push(`  ${nameOf.get(run.eval_id) ?? run.eval_id} — ${run.status}`);
    const result = run.result;
    if (result && typeof result === 'object') {
      const record = result as Record<string, unknown>;
      const reason = record['reason'] ?? record['message'] ?? record['error'];
      const expected = record['expected_behavior'] ?? record['expected'];
      if (typeof reason === 'string') lines.push(`    ${reason}`);
      if (typeof expected === 'string') lines.push(`    expected: ${expected}`);
      if (typeof reason !== 'string' && typeof expected !== 'string') {
        lines.push(`    ${JSON.stringify(result)}`);
      }
    }
    // The real agent id, not a placeholder: this line exists to be copied,
    // and a copied `<id>` is a usage error rather than a re-run.
    lines.push(`    speko-cli eval run --agent ${agentId} --eval ${run.eval_id}`);
    lines.push('');
  }

  return lines;
}
