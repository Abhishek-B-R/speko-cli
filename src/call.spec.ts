import { describe, expect, it, vi } from 'vitest';
import {
  buildCallBody,
  type CallDetail,
  type CallEvent,
  followEvents,
  formatEvent,
  formatTranscript,
  isFinished,
  transcriptTurns,
  waitForCall,
} from './call.js';

function fakeClock() {
  let current = 0;
  return {
    now: () => current,
    wait: async (ms: number) => {
      current += ms;
    },
    elapsed: () => current,
  };
}

describe('buildCallBody', () => {
  it('maps flags onto the API field names', () => {
    expect(
      buildCallBody({
        to: '+15551234567',
        agent: 'agent_1',
        prompt: 'Be brief.',
        'first-message': 'Hi there.',
      }),
    ).toEqual({
      to: '+15551234567',
      agentId: 'agent_1',
      systemPrompt: 'Be brief.',
      firstMessage: 'Hi there.',
    });
  });

  it('lets a named flag override --data', () => {
    // The shape an agent iterating on one field against a fixed rig needs.
    const body = buildCallBody({
      data: '{"to":"+1999","agentId":"agent_old","voice":"Ashley"}',
      agent: 'agent_new',
    });
    expect(body).toEqual({ to: '+1999', agentId: 'agent_new', voice: 'Ashley' });
  });

  it('rejects a --data payload that is not an object', () => {
    expect(() => buildCallBody({ data: '[1,2]' })).toThrow(/JSON object/);
  });
});

describe('isFinished', () => {
  it('trusts ended_at over the status string', () => {
    // A status this CLI has never heard of must not make it poll a finished
    // call until it times out.
    expect(isFinished({ id: 's', status: 'something-new', ended_at: '2026-09-03T00:00:00Z' })).toBe(
      true,
    );
  });

  it('recognises the terminal statuses when ended_at is absent', () => {
    for (const status of ['completed', 'failed', 'busy', 'canceled', 'cancelled', 'no_answer']) {
      expect(isFinished({ id: 's', status })).toBe(true);
    }
  });

  it('keeps waiting while the call is live', () => {
    for (const status of ['queued', 'ringing', 'active']) {
      expect(isFinished({ id: 's', status })).toBe(false);
    }
    expect(isFinished({ id: 's' })).toBe(false);
  });
});

describe('waitForCall', () => {
  it('polls until the call ends and reports each status change once', async () => {
    const clock = fakeClock();
    const states: CallDetail[] = [
      { id: 's', status: 'queued' },
      { id: 's', status: 'ringing' },
      { id: 's', status: 'ringing' },
      { id: 's', status: 'completed', ended_at: '2026-09-03T00:00:00Z', duration_seconds: 12 },
    ];
    let index = 0;
    const seen: string[] = [];

    const result = await waitForCall('s', {
      now: clock.now,
      wait: clock.wait,
      fetchCall: async () => states[Math.min(index++, states.length - 1)] as CallDetail,
      onStatus: (status) => seen.push(status),
    });

    expect(result.timedOut).toBe(false);
    expect(result.call.duration_seconds).toBe(12);
    // 'ringing' twice in a row narrates once.
    expect(seen).toEqual(['queued', 'ringing', 'completed']);
  });

  it('returns the last known state on timeout instead of throwing', async () => {
    // The call is real and still running; the id is the only useful thing in
    // this failure, so discarding it would be the wrong move.
    const clock = fakeClock();
    const result = await waitForCall('s', {
      timeoutMs: 10_000,
      intervalMs: 2_000,
      now: clock.now,
      wait: clock.wait,
      fetchCall: async () => ({ id: 's', status: 'active' }),
    });

    expect(result.timedOut).toBe(true);
    expect(result.call.status).toBe('active');
  });
});

describe('formatTranscript', () => {
  it('renders role and text, accepting either field name', () => {
    expect(
      formatTranscript([
        { role: 'agent', text: 'Hello.' },
        { speaker: 'caller', content: 'Hi.' },
      ]),
    ).toEqual(['agent     Hello.', 'caller    Hi.']);
  });

  it('says so when there is nothing, rather than printing blank', () => {
    expect(formatTranscript([])).toEqual(['(no transcript captured)']);
  });
});

describe('formatEvent', () => {
  it('leads with the failure cause when there is one', () => {
    // These are the fields that explain a failed call; burying them in a
    // payload dump is how someone ends up reading JSON to learn a line was busy.
    const line = formatEvent({
      id: 'e1',
      event_type: 'call.hangup',
      occurred_at: '2026-09-03T10:11:12.000Z',
      status: 'failed',
      failure_cause: 'USER_BUSY',
      sip_status_code: 486,
      sip_status: 'Busy Here',
      provider: 'telnyx',
    });

    expect(line).toContain('10:11:12');
    expect(line).toContain('call.hangup');
    expect(line).toContain('cause=USER_BUSY');
    expect(line).toContain('sip=486 Busy Here');
    expect(line).toContain('(telnyx)');
  });

  it('stays terse for an ordinary event', () => {
    expect(
      formatEvent({
        id: 'e',
        event_type: 'call.answered',
        occurred_at: '2026-09-03T10:00:00.000Z',
      }),
    ).toBe('10:00:00  call.answered');
  });
});

describe('followEvents', () => {
  it('prints each event once across polls and stops when the call ends', async () => {
    const clock = fakeClock();
    const polls: CallEvent[][] = [
      [{ id: 'e1', event_type: 'call.initiated', occurred_at: '2026-09-03T10:00:00Z' }],
      [
        { id: 'e1', event_type: 'call.initiated', occurred_at: '2026-09-03T10:00:00Z' },
        { id: 'e2', event_type: 'call.answered', occurred_at: '2026-09-03T10:00:05Z' },
      ],
    ];
    let poll = 0;
    const calls: CallDetail[] = [
      { id: 's', status: 'active' },
      { id: 's', status: 'completed' },
    ];
    let callPoll = 0;
    const printed: string[] = [];

    await followEvents('s', {
      now: clock.now,
      wait: clock.wait,
      fetchEvents: async () => ({
        events: polls[Math.min(poll++, polls.length - 1)] as CallEvent[],
      }),
      fetchCall: async () => calls[Math.min(callPoll++, calls.length - 1)] as CallDetail,
      onEvent: (event) => printed.push(event.id),
    });

    expect(printed).toEqual(['e1', 'e2']);
  });

  it('does not loop forever on a call that is already finished', async () => {
    const clock = fakeClock();
    const fetchEvents = vi.fn(async () => ({ events: [] }));

    await followEvents('s', {
      now: clock.now,
      wait: clock.wait,
      fetchEvents,
      fetchCall: async () => ({ id: 's', ended_at: '2026-09-03T00:00:00Z' }),
      onEvent: () => undefined,
    });

    // One poll, then one final read after the call is seen to have ended.
    expect(fetchEvents).toHaveBeenCalledTimes(2);
    expect(clock.elapsed()).toBe(0);
  });

  it('prints the events that land as the call ends', async () => {
    const clock = fakeClock();
    const polls: CallEvent[][] = [
      [{ id: 'e1', event_type: 'call.started', occurred_at: '2026-09-03T10:00:00Z' }],
      [
        { id: 'e1', event_type: 'call.started', occurred_at: '2026-09-03T10:00:00Z' },
        {
          id: 'e2',
          event_type: 'call.failed',
          occurred_at: '2026-09-03T10:00:03Z',
          failure_cause: 'busy',
        },
      ],
    ];
    let poll = 0;
    const printed: string[] = [];

    const result = await followEvents('s', {
      now: clock.now,
      wait: clock.wait,
      fetchEvents: async () => ({
        events: polls[Math.min(poll++, polls.length - 1)] as CallEvent[],
      }),
      fetchCall: async () => ({ id: 's', status: 'failed' }),
      onEvent: (event) => printed.push(event.event_type),
    });

    expect(printed).toEqual(['call.started', 'call.failed']);
    expect(result).toEqual({ timedOut: false });
  });

  it('reports a timeout instead of returning as if the call ended', async () => {
    const clock = fakeClock();

    const result = await followEvents('s', {
      now: clock.now,
      wait: clock.wait,
      timeoutMs: 10_000,
      intervalMs: 2_000,
      fetchEvents: async () => ({ events: [] }),
      fetchCall: async () => ({ id: 's', status: 'active' }),
      onEvent: () => undefined,
    });

    expect(result).toEqual({ timedOut: true });
  });

  it('checks the status once more after the deadline', async () => {
    // The deadline passes during a pause, so a call that ends in that window
    // used to be reported as still running and the events that closed it were
    // never printed.
    const clock = fakeClock();
    const printed: string[] = [];
    let statusPolls = 0;

    const result = await followEvents('s', {
      now: clock.now,
      wait: clock.wait,
      timeoutMs: 4_000,
      intervalMs: 2_000,
      fetchEvents: async () => ({
        events:
          statusPolls < 2
            ? [{ id: 'e1', event_type: 'call.started', occurred_at: '' }]
            : [
                { id: 'e1', event_type: 'call.started', occurred_at: '' },
                { id: 'e2', event_type: 'call.completed', occurred_at: '' },
              ],
      }),
      fetchCall: async () => {
        statusPolls += 1;
        return { id: 's', status: statusPolls < 3 ? 'active' : 'completed' };
      },
      onEvent: (event) => printed.push(event.event_type),
    });

    expect(result).toEqual({ timedOut: false });
    expect(printed).toEqual(['call.started', 'call.completed']);
  });

  it('still times out when the last check says the call is running', async () => {
    const clock = fakeClock();
    const printed: string[] = [];

    const result = await followEvents('s', {
      now: clock.now,
      wait: clock.wait,
      timeoutMs: 4_000,
      intervalMs: 2_000,
      fetchEvents: async () => ({
        events: [{ id: 'e1', event_type: 'call.started', occurred_at: '' }],
      }),
      fetchCall: async () => ({ id: 's', status: 'active' }),
      onEvent: (event) => printed.push(event.event_type),
    });

    expect(result).toEqual({ timedOut: true });
    // Printed once: a re-fetch must not reprint an event already seen.
    expect(printed).toEqual(['call.started']);
  });
});

describe('transcriptTurns', () => {
  it('reads the shape the API actually returns', () => {
    // `GET /v1/calls/{id}` sends `{ entries: [...] }`. Typing this as a bare
    // array made `speko-cli call` print "(no transcript captured)" after a
    // successful call — the one output the command exists to produce — and it
    // only showed up once there were real sessions to read.
    expect(
      transcriptTurns({ entries: [{ source: 'agent', text: 'Hello.' }] }).map((t) => t.text),
    ).toEqual(['Hello.']);
  });

  it('still reads a bare array, so fixtures and the API cannot diverge', () => {
    expect(transcriptTurns([{ role: 'user', text: 'Hi.' }])).toHaveLength(1);
  });

  it('is empty for null, undefined and an entry-less object', () => {
    expect(transcriptTurns(null)).toEqual([]);
    expect(transcriptTurns(undefined)).toEqual([]);
    expect(transcriptTurns({})).toEqual([]);
  });

  it('renders `source`, which is the API field name', () => {
    expect(
      formatTranscript(transcriptTurns({ entries: [{ source: 'agent', text: 'Hi.' }] })),
    ).toEqual(['agent     Hi.']);
  });
});
