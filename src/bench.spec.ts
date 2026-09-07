import { describe, expect, it } from 'vitest';
import {
  type BenchResponse,
  type BenchScore,
  formatBench,
  formatSessionBench,
  rankScores,
  scoreFor,
  stackStages,
} from './bench.js';

const score = (over: Partial<BenchScore>): BenchScore => ({
  stage: 'stt',
  provider: 'p',
  model: 'm',
  language: 'nb',
  ...over,
});

const response = (scores: BenchScore[]): BenchResponse => ({
  total: 259,
  matched: scores.length,
  returned: scores.length,
  stages: ['stt', 'llm', 'tts', 's2s'],
  scores,
  note: 'n',
});

describe('rankScores', () => {
  it('ranks transcription by word error rate, lowest first', () => {
    const ranked = rankScores(
      [score({ provider: 'worse', wer_p50: 0.19 }), score({ provider: 'better', wer_p50: 0.056 })],
      'stt',
    );
    expect(ranked.map((s) => s.provider)).toEqual(['better', 'worse']);
  });

  it('sinks an unmeasured row instead of treating it as zero', () => {
    // On a lower-is-better board, a missing value sorted as 0 would appear as
    // the best result on the board. That is the worst possible presentation of
    // "nobody measured this".
    const ranked = rankScores(
      [score({ provider: 'unmeasured' }), score({ provider: 'measured', wer_p50: 0.2 })],
      'stt',
    );
    expect(ranked.map((s) => s.provider)).toEqual(['measured', 'unmeasured']);
  });

  it('leaves a stage with no ranking axis in dataset order', () => {
    // Sorting a board by a field its rows have no figure for puts an arbitrary
    // row on top and dresses it up as a ranking.
    const input = [score({ provider: 'a' }), score({ provider: 'b' })];
    expect(rankScores(input, 'unknown-stage').map((s) => s.provider)).toEqual(['a', 'b']);
    expect(rankScores(input, undefined).map((s) => s.provider)).toEqual(['a', 'b']);
  });
});

describe('formatBench', () => {
  it('shows an unmeasured metric as a dash, never as zero', () => {
    const [, row] = formatBench(response([score({ wer_p50: 0.1 })]), 'stt');
    expect(row).toContain('10.0%');
    // No cost and no latency were measured on that row.
    expect(row).toContain('—');
    expect(row).not.toContain('$0.0000');
  });

  it('prints a measured zero as a number, so it differs from a dash', () => {
    // The dataset records both: 22 rows cost exactly 0 and 3 have no figure.
    // Collapsing them would turn "unknown" into "free".
    const [, row] = formatBench(response([score({ cost_per_min_usd: 0 })]), 'stt');
    expect(row).toContain('$0.0000');
  });

  it('says what to try when a filter matches nothing', () => {
    const lines = formatBench(response([]), 'stt');
    expect(lines[0]).toMatch(/Nothing measured/);
    // The count of what does exist, so an empty result is not read as an
    // empty dataset.
    expect(lines.join('\n')).toContain('259 scores exist');
  });

  it('says the dash means unmeasured, on every listing', () => {
    const lines = formatBench(response([score({ wer_p50: 0.1 })]), 'stt');
    expect(lines.join('\n')).toContain('means unmeasured, not zero');
  });
});

describe('bench session', () => {
  const session = {
    id: 'sess_1',
    language: 'en',
    status: 'ended',
    durationSeconds: 41,
    pipelineConfig: {
      stt: { provider: 'deepgram', model: 'nova-3' },
      llm: { provider: 'openai', model: 'gpt-5-mini' },
      tts: { provider: 'cartesia', model: 'sonic-3.5' },
      intent: { language: 'en' },
      agentId: 'agent_1',
    },
  };

  const scores: BenchScore[] = [
    { stage: 'stt', provider: 'deepgram', model: 'nova-3', language: 'en', wer_p50: 0.129 },
    {
      stage: 'stt',
      provider: 'assemblyai',
      model: 'universal-3-5-pro',
      language: 'en',
      wer_p50: 0.02,
    },
    // Same provider and model, different language: must not be matched.
    { stage: 'stt', provider: 'deepgram', model: 'nova-3', language: 'de', wer_p50: 0.4 },
    { stage: 'tts', provider: 'cartesia', model: 'sonic-3.5', language: 'en', latency_p50_ms: 121 },
    { stage: 'llm', provider: 'openai', model: 'gpt-5-mini', language: 'en', latency_p50_ms: 746 },
  ];

  it('reads the stack out of the pipeline config, ignoring non-stage keys', () => {
    expect(stackStages(session).map((s) => `${s.stage}:${s.provider}`)).toEqual([
      'stt:deepgram',
      'llm:openai',
      'tts:cartesia',
    ]);
  });

  it('matches a score on provider, model AND language', () => {
    const stage = { stage: 'stt', provider: 'deepgram', model: 'nova-3' };
    expect(scoreFor(scores, stage, 'en')?.wer_p50).toBe(0.129);
    // Never loosened to a provider-wide average: two models from one vendor
    // differ more than two vendors do, so an average would be invented.
    expect(scoreFor(scores, { ...stage, model: 'nova-9' }, 'en')).toBeUndefined();
  });

  it('names a better measured option and omits a stage already on top', () => {
    const lines = formatSessionBench(session, scores).join('\n');
    expect(lines).toContain('assemblyai:universal-3-5-pro');
    // cartesia is the only measured `en` tts row, so it IS the best — printing
    // it as an alternative to itself would be a no-op row.
    expect(lines).not.toContain('tts  cartesia:sonic-3.5  121ms');
  });

  it('never claims to explain the routing decision', () => {
    // Nothing records why a stack was chosen. A command that implied otherwise
    // would be inventing a justification after the fact.
    expect(formatSessionBench(session, scores).join('\n')).toContain(
      'does not record why a stack was chosen',
    );
  });

  it('says so plainly for a session with no cascade stages', () => {
    const s2s = { id: 'sess_2', language: 'en', pipelineConfig: { agentId: 'agent_1' } };
    expect(formatSessionBench(s2s, scores).join('\n')).toContain('no cascade pipeline');
  });

  it('ranks tts and llm on the latency field that carries values', () => {
    // The endpoint used to expose `ttfp_p95_ms`, which the dataset hardcodes to
    // null for all 259 rows — so these boards looked sorted and were not.
    const ranked = rankScores(
      [
        { stage: 'tts', provider: 'slow', model: 'a', language: 'en', latency_p50_ms: 300 },
        { stage: 'tts', provider: 'fast', model: 'b', language: 'en', latency_p50_ms: 100 },
      ],
      'tts',
    );
    expect(ranked.map((r) => r.provider)).toEqual(['fast', 'slow']);
  });
});
