import { describe, expect, it } from 'vitest';
import {
  type EvalCase,
  type EvalRun,
  formatFailures,
  formatPreview,
  formatRuns,
  formatSuite,
  isRunFinished,
  isRunRegressed,
  unwrapRun,
  waitForRuns,
} from './eval.js';

const run = (over: Partial<EvalRun> = {}): EvalRun => ({
  id: 'run_1',
  eval_id: 'eval_1',
  status: 'queued',
  created_at: '2026-09-04T00:00:00.000Z',
  updated_at: '2026-09-04T00:00:00.000Z',
  ...over,
});

const testCase = (over: Partial<EvalCase> = {}): EvalCase => ({
  id: 'eval_1',
  name: 'confirms before booking',
  assertion_kind: 'custom',
  ...over,
});

describe('run status', () => {
  it('treats every status the worker writes as terminal or not', () => {
    // The vocabulary comes from the route: queued, claimed, running, passed,
    // failed, error, complete. A status this does not classify would silently
    // poll forever.
    expect(
      ['queued', 'claimed', 'running'].map((status) => isRunFinished(run({ status }))),
    ).toEqual([false, false, false]);
    expect(
      ['passed', 'failed', 'error', 'complete'].map((status) => isRunFinished(run({ status }))),
    ).toEqual([true, true, true, true]);
  });

  it('counts only failed and error as a regression', () => {
    expect(isRunRegressed(run({ status: 'failed' }))).toBe(true);
    expect(isRunRegressed(run({ status: 'error' }))).toBe(true);
    // `complete` is terminal but carries no verdict of its own — treating it as
    // a failure would fail every suite the worker finished successfully.
    expect(isRunRegressed(run({ status: 'complete' }))).toBe(false);
    expect(isRunRegressed(run({ status: 'passed' }))).toBe(false);
  });
});

describe('waitForRuns', () => {
  const clock = () => {
    let t = 0;
    return { now: () => t, wait: async (ms: number) => void (t += ms) };
  };

  it('stops as soon as every run is terminal', async () => {
    const { now, wait } = clock();
    let calls = 0;
    const result = await waitForRuns('agent_1', [run()], {
      now,
      wait,
      intervalMs: 10,
      timeoutMs: 10_000,
      fetchRun: async (id) => {
        calls += 1;
        return run({ id, status: 'passed' });
      },
    });
    expect(calls).toBe(1);
    expect(result.unfinished).toHaveLength(0);
    expect(result.neverClaimed).toBe(false);
  });

  it('reports a run that never left queued as unclaimed, not as slow', async () => {
    // This is the local-stack case: no gate worker, so the row sits at `queued`
    // forever. Calling it a timeout would send someone to raise the timeout.
    const { now, wait } = clock();
    const result = await waitForRuns('agent_1', [run()], {
      now,
      wait,
      intervalMs: 10,
      timeoutMs: 50,
      fetchRun: async (id) => run({ id }),
    });
    expect(result.unfinished).toHaveLength(1);
    expect(result.neverClaimed).toBe(true);
  });

  it('does not call a slow run unclaimed once it started running', async () => {
    const { now, wait } = clock();
    const result = await waitForRuns('agent_1', [run()], {
      now,
      wait,
      intervalMs: 10,
      timeoutMs: 50,
      fetchRun: async (id) => run({ id, status: 'running' }),
    });
    expect(result.unfinished).toHaveLength(1);
    expect(result.neverClaimed).toBe(false);
  });

  it('keeps the last known state when a poll fails', async () => {
    // A dropped request mid-suite must not erase a result already observed.
    const { now, wait } = clock();
    let poll = 0;
    const result = await waitForRuns('agent_1', [run()], {
      now,
      wait,
      intervalMs: 10,
      timeoutMs: 100,
      fetchRun: async (id) => {
        poll += 1;
        if (poll === 1) return run({ id, status: 'running' });
        throw new Error('network');
      },
    });
    expect(result.runs[0]?.status).toBe('running');
  });
});

describe('formatting', () => {
  it('points an empty suite at generate', () => {
    expect(formatSuite([]).join('\n')).toContain('eval generate');
  });

  it('marks a failure with a symbol that survives a monochrome log', () => {
    const lines = formatRuns([run({ status: 'failed' })], [testCase()]).join('\n');
    expect(lines).toContain('✗');
    expect(lines).toContain('confirms before booking');
  });

  it('says plainly when a preview was not saved', () => {
    const scenario = {
      name: 'asks for a callback number',
      expected_behavior: 'agent asks',
      assertion_kind: 'custom',
      input_kind: 'assertion_only',
      block_deploy_on_fail: true,
      targetMode: 'missing_confirmation',
    };
    const preview = formatPreview([scenario], false).join('\n');
    expect(preview).toContain('NOT saved');
    expect(preview).toContain('--persist');
    expect(formatPreview([scenario], true).join('\n')).toContain('saved to the agent');
  });

  it('surfaces the worker result rather than dropping it', () => {
    const detail = formatFailures(
      [run({ status: 'failed', result: { reason: 'never confirmed the date' } })],
      [testCase()],
      'agent_1',
    ).join('\n');
    expect(detail).toContain('never confirmed the date');
    // The re-run hint has to carry the real ids or it cannot be copied.
    expect(detail).toContain('--agent agent_1 --eval eval_1');
  });

  it('falls back to the raw result when the worker used other field names', () => {
    // `result` is a JSON column the CLI does not own. Printing nothing because
    // the keys were unfamiliar would hide the only explanation of the failure.
    const detail = formatFailures(
      [run({ status: 'failed', result: { unexpected_shape: 42 } })],
      [testCase()],
      'agent_1',
    ).join('\n');
    expect(detail).toContain('unexpected_shape');
  });

  it('says nothing when everything passed', () => {
    expect(formatFailures([run({ status: 'passed' })], [testCase()], 'agent_1')).toEqual([]);
  });
});

describe('unwrapRun', () => {
  it('reads the wrapped shape GET /eval-runs/:id returns', () => {
    // The two endpoints disagree: POST .../run answers a bare row, GET
    // .../eval-runs/:id answers { run, eval }. Assuming one shape crashed the
    // first real poll of a queued suite.
    const row = run({ id: 'run_9', status: 'passed' });
    expect(unwrapRun({ run: row, eval: { id: 'eval_1' } })).toEqual(row);
  });

  it('reads the bare shape POST .../run returns', () => {
    const row = run({ id: 'run_9' });
    expect(unwrapRun(row)).toEqual(row);
  });

  it('refuses a payload with no run id rather than polling undefined', () => {
    expect(() => unwrapRun({ ok: true })).toThrow(/no run id/);
    expect(() => unwrapRun(null)).toThrow(/Unreadable/);
  });
});
