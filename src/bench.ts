import { API_URL } from './constants.js';
import { readCredentials, userAgent } from './credentials.js';
import { CLI_VERSION } from './version.js';

/**
 * `speko-cli bench` — the measured numbers behind a routing decision.
 *
 * WHY A COMMAND AND NOT A DOCS LINK. Choosing a provider is a decision an agent
 * makes while writing code, and the alternative to having the figures at hand
 * is choosing on vibes — or on a training set that predates every model in the
 * catalogue. This is the one thing on the platform a competitor cannot answer,
 * so it should be one command away rather than a site visit.
 *
 * UNAUTHENTICATED, like `explain`. These are published benchmarks and the
 * reader most likely to want them has not signed up yet. A stored credential is
 * used only for its `apiUrl`, so pointing at a local server still works.
 */

export interface BenchScore {
  readonly stage: string;
  readonly provider: string;
  readonly model: string;
  readonly language: string;
  readonly mode?: string | null;
  readonly status?: string | null;
  /** Absent when unmeasured — never zero-filled. See the endpoint's note. */
  readonly wer_p50?: number;
  /**
   * The stage's measured latency. One name for all four stages because it is
   * one measurement: the dataset carries a single `latency_ms` per model and
   * the adapter spells it `ttfp`/`ttfb`/`ttft`/`tool_call` per stage.
   */
  readonly latency_p50_ms?: number;
  readonly cost_per_min_usd?: number;
  readonly error_rate?: number;
  readonly sample_count?: number;
}

export interface BenchResponse {
  readonly total: number;
  readonly matched: number;
  readonly returned: number;
  readonly stages: readonly string[];
  readonly scores: readonly BenchScore[];
  readonly note: string;
}

export async function fetchBench(
  params: { stage?: string; language?: string; provider?: string; limit?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<BenchResponse> {
  const base = readCredentials()?.apiUrl || API_URL;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value) query.set(key, value);

  const response = await fetchImpl(`${base}/v1/benchmarks/scores?${query.toString()}`, {
    headers: { 'User-Agent': userAgent(CLI_VERSION) },
  });
  if (!response.ok) throw new Error(`Could not read the benchmarks (HTTP ${response.status}).`);
  return (await response.json()) as BenchResponse;
}

/** `—` for a metric nobody measured, so it cannot be mistaken for a zero. */
const cell = (value: number | undefined, format: (n: number) => string): string =>
  value === undefined ? '—' : format(value);

/**
 * Which column a stage is ranked on.
 *
 * Not one metric for everything: word error rate is the axis for transcription
 * and meaningless for a language model, and sorting an LLM board by a field it
 * has no figure for would put an arbitrary row on top. A stage with no ranking
 * axis is left in dataset order rather than sorted by something irrelevant.
 */
const RANK_BY: Record<string, keyof BenchScore | null> = {
  stt: 'wer_p50',
  tts: 'latency_p50_ms',
  llm: 'latency_p50_ms',
  s2s: 'latency_p50_ms',
};

export function rankScores(scores: readonly BenchScore[], stage: string | undefined): BenchScore[] {
  const key = stage ? RANK_BY[stage] : null;
  if (!key) return [...scores];
  return [...scores].sort((a, b) => {
    const left = a[key] as number | undefined;
    const right = b[key] as number | undefined;
    // Unmeasured rows sink rather than sorting as zero, which would put them
    // at the top of a lower-is-better board and read as the best result.
    if (left === undefined && right === undefined) return 0;
    if (left === undefined) return 1;
    if (right === undefined) return -1;
    return left - right;
  });
}

export function formatBench(response: BenchResponse, stage: string | undefined): string[] {
  if (response.scores.length === 0) {
    return [
      'Nothing measured for that filter.',
      `  ${response.total} scores exist across ${response.stages.join(', ')}.`,
      '  Try `speko-cli bench <stage>` with no language, or check the spelling.',
    ];
  }

  const ranked = rankScores(response.scores, stage);
  const idWidth = Math.max(8, ...ranked.map((s) => `${s.provider}:${s.model}`.length));

  const rows = ranked.map((score) => {
    const id = `${score.provider}:${score.model}`.padEnd(idWidth);
    const wer = cell(score.wer_p50, (n) => `${(n * 100).toFixed(1)}%`).padStart(6);
    const latency = cell(score.latency_p50_ms, (n) => `${Math.round(n)}ms`).padStart(7);
    const cost = cell(score.cost_per_min_usd, (n) => `$${n.toFixed(4)}`).padStart(8);
    return `  ${id}  ${score.language.padEnd(5)}  ${wer}  ${latency}  ${cost}`;
  });

  return [
    `  ${'PROVIDER:MODEL'.padEnd(idWidth)}  ${'LANG'.padEnd(5)}  ${'WER'.padStart(6)}  ${'LATENCY'.padStart(7)}  ${'$/MIN'.padStart(8)}`,
    ...rows,
    '',
    `  ${response.matched} measured${
      response.returned < response.matched ? `, showing ${response.returned}` : ''
    }. — means unmeasured, not zero.`,
  ];
}

/**
 * `speko-cli bench session <id>` — the measured numbers for the stack that ran.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not explain why the stack was
 * chosen, because nothing records that: a session persists `pipeline_config`
 * (what ran) and no reason alongside it. Re-deriving a justification after the
 * fact would be a rationalisation that drifts every time the dataset changes,
 * and presenting it as the decision would be worse than not answering.
 *
 * It also does not compare against `/v1/public/benchmarks/stack`. That endpoint
 * returns three hardcoded stacks with hardcoded latency, cost and quality
 * figures under `source: 'speko-probe'` — a different vocabulary from the
 * measured dataset (`Deepgram` vs `deepgram`) and not measured at all. The
 * comparison here comes from `/v1/benchmarks/scores`, the same rows `bench` prints.
 *
 * So the honest question it answers is the useful one: this call ran on these
 * providers, here is what was measured about them, and here is the best measured
 * option for the same stage and language.
 */

export interface SessionStack {
  readonly id: string;
  readonly language?: string | null;
  readonly status?: string | null;
  readonly durationSeconds?: number | null;
  readonly pipelineConfig?: Record<string, unknown> | null;
}

/** The three cascade stages, in pipeline order. A session may name only some. */
const STAGES = ['stt', 'llm', 'tts'] as const;

export interface StackStage {
  readonly stage: string;
  readonly provider: string;
  readonly model: string;
}

/** Reads the provider/model pairs out of a session's persisted pipeline config. */
export function stackStages(session: SessionStack): StackStage[] {
  const config = session.pipelineConfig ?? {};
  const stages: StackStage[] = [];
  for (const stage of STAGES) {
    const node = config[stage];
    if (!node || typeof node !== 'object') continue;
    const { provider, model } = node as { provider?: unknown; model?: unknown };
    if (typeof provider !== 'string' || typeof model !== 'string') continue;
    stages.push({ stage, provider, model });
  }
  return stages;
}

/**
 * The measured row for one exact provider:model at one language.
 *
 * Matched on provider AND model AND language, never loosened to a provider-wide
 * average: two models from the same vendor differ more than two vendors do, so
 * a vendor average attributed to a specific model would be a made-up number.
 */
export function scoreFor(
  scores: readonly BenchScore[],
  stage: StackStage,
  language: string | null | undefined,
): BenchScore | undefined {
  return scores.find(
    (s) =>
      s.stage === stage.stage &&
      s.provider.toLowerCase() === stage.provider.toLowerCase() &&
      s.model === stage.model &&
      (!language || s.language === language),
  );
}

/** The best measured row for a stage and language, on that stage's ranking axis. */
export function bestFor(
  scores: readonly BenchScore[],
  stage: string,
  language: string | null | undefined,
): BenchScore | undefined {
  const key = RANK_BY[stage];
  if (!key) return undefined;
  const candidates = scores.filter(
    (s) => s.stage === stage && (!language || s.language === language) && s[key] !== undefined,
  );
  return rankScores(candidates, stage)[0];
}

export function formatSessionBench(session: SessionStack, scores: readonly BenchScore[]): string[] {
  const stages = stackStages(session);
  if (stages.length === 0) {
    return [
      'This session records no cascade pipeline.',
      '  A speech-to-speech session runs one provider end to end rather than',
      '  three stages, so there is nothing to break down here.',
    ];
  }

  const language = session.language ?? null;
  const idWidth = Math.max(10, ...stages.map((s) => `${s.provider}:${s.model}`.length));
  const lines: string[] = [];

  const meta = [language ?? 'language unknown', session.status, `${session.durationSeconds ?? 0}s`]
    .filter(Boolean)
    .join('  ');
  lines.push(`  Session ${session.id}  ${meta}`);
  lines.push('');
  lines.push(
    `  ${'STAGE'.padEnd(5)}  ${'RAN'.padEnd(idWidth)}  ${'WER'.padStart(6)}  ${'LATENCY'.padStart(7)}  ${'$/MIN'.padStart(8)}`,
  );

  for (const stage of stages) {
    const score = scoreFor(scores, stage, language);
    const id = `${stage.provider}:${stage.model}`.padEnd(idWidth);
    const wer = cell(score?.wer_p50, (n) => `${(n * 100).toFixed(1)}%`).padStart(6);
    const latency = cell(score?.latency_p50_ms, (n) => `${Math.round(n)}ms`).padStart(7);
    const cost = cell(score?.cost_per_min_usd, (n) => `$${n.toFixed(4)}`).padStart(8);
    const note = score ? '' : '  (not in the measured set)';
    lines.push(`  ${stage.stage.padEnd(5)}  ${id}  ${wer}  ${latency}  ${cost}${note}`);
  }

  // The comparison, only where a better measured row actually exists. A stage
  // whose ran-provider is already top is left out rather than printed as a
  // no-op row, so what remains is a list of things worth changing.
  const alternatives: string[] = [];
  for (const stage of stages) {
    const best = bestFor(scores, stage.stage, language);
    if (!best) continue;
    if (
      best.provider.toLowerCase() === stage.provider.toLowerCase() &&
      best.model === stage.model
    ) {
      continue;
    }
    const key = RANK_BY[stage.stage];
    if (!key) continue;
    const format =
      key === 'wer_p50'
        ? (n: number) => `${(n * 100).toFixed(1)}% WER`
        : (n: number) => `${Math.round(n)}ms`;
    const bestValue = best[key] as number | undefined;
    const ranValue = scoreFor(scores, stage, language)?.[key] as number | undefined;
    if (bestValue === undefined) continue;
    const ran = ranValue === undefined ? 'unmeasured' : format(ranValue);
    alternatives.push(
      `    ${stage.stage.padEnd(3)}  ${best.provider}:${best.model}  ${format(bestValue)}   (ran ${ran})`,
    );
  }

  if (alternatives.length > 0) {
    lines.push('');
    lines.push(`  Best measured for ${language ?? 'this stage'}:`);
    lines.push(...alternatives);
  }

  lines.push('');
  lines.push('  Speko does not record why a stack was chosen. These are the measured');
  lines.push('  numbers for what ran — not a reconstruction of the decision.');
  return lines;
}
