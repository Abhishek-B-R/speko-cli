import { describe, expect, it } from 'vitest';
import {
  assessAgents,
  buildChecks,
  type Diagnostics,
  formatChecks,
  hasBlockingProblem,
  vendorOf,
} from './doctor.js';

const base: Diagnostics = {
  identity: {
    organization_id: 'org_1',
    user_id: 'user_1',
    principal: 'oauth-user',
    session_origin: 'cli',
    role: 'owner',
    scopes: ['speko:read', 'speko:write', 'speko:execute'],
    email: 'dev@example.com',
  },
  credit: { available_usd: 100, sufficient: true },
  providers: {
    usable: [
      { provider: 'cartesia', byok: false, managed: true },
      { provider: 'elevenlabs', byok: false, managed: true },
      { provider: 'deepgram', byok: true, managed: false },
    ],
    unusable: [{ provider: 'anthropic', reason: 'no key' }],
  },
  constraints: [],
  last_failure: null,
};

const find = (d: Diagnostics, label: string) => buildChecks(d).find((c) => c.label === label);

describe('buildChecks', () => {
  it('passes a healthy workspace with nothing to warn about', () => {
    const checks = buildChecks(base);
    expect(hasBlockingProblem(checks)).toBe(false);
    expect(find(base, 'Credit')?.state).toBe('ok');
    expect(find(base, 'Providers')?.detail).toContain('3 usable');
  });

  it('warns, and blocks, when the workspace is out of credit', () => {
    // Placing a call with no credit fails, and the failure does not say "no
    // credit" anywhere a caller looks first.
    const d: Diagnostics = { ...base, credit: { available_usd: 0, sufficient: false } };
    expect(find(d, 'Credit')?.state).toBe('warn');
    expect(hasBlockingProblem(buildChecks(d))).toBe(true);
  });

  it('warns when no provider is usable at all', () => {
    // The condition that reads from outside as "every adapter is broken".
    const d: Diagnostics = {
      ...base,
      providers: { usable: [], unusable: [{ provider: 'cartesia', reason: 'no key' }] },
    };
    const check = find(d, 'Providers');
    expect(check?.state).toBe('warn');
    expect(check?.detail).toContain('Every session will fail regardless of the request');
    expect(hasBlockingProblem(buildChecks(d))).toBe(true);
  });

  it('separates managed from bring-your-own-key in the count', () => {
    // The distinction that decides whether a failure is provisioning or config.
    expect(find(base, 'Providers')?.detail).toBe('3 usable (2 managed, 1 your own key only)');
  });

  it('names unusable providers rather than only counting them', () => {
    const check = find(base, 'Not usable');
    expect(check?.detail).toContain('anthropic');
  });

  it('truncates a long unusable list but says that it did', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      provider: `p${i}`,
      reason: 'no key',
    }));
    const d: Diagnostics = { ...base, providers: { ...base.providers, unusable: many } };
    const detail = find(d, 'Not usable')?.detail ?? '';
    expect(detail.startsWith('12:')).toBe(true);
    expect(detail).toContain('…');
  });

  it('mentions the CLI scope narrowing, which explains an unexpected 403', () => {
    expect(find(base, 'Scopes')?.detail).toContain('cannot read org credentials');
  });

  it('does not mention it for a browser session', () => {
    const d: Diagnostics = {
      ...base,
      identity: { ...base.identity, session_origin: 'browser' },
    };
    expect(find(d, 'Scopes')?.detail).not.toContain('cannot read');
  });

  it('points at the last failure without guessing its cause', () => {
    const d: Diagnostics = {
      ...base,
      last_failure: { session_id: 'sess_9', status: 'failed', ended_at: null },
    };
    const check = find(d, 'Last failure');
    expect(check?.detail).toContain('speko-cli logs sess_9');
    // No verdict: the events carry failure_cause, and inventing one from a
    // status is exactly the guess doctor exists to prevent.
    expect(check?.state).toBe('info');
  });

  it('reports an unreadable balance as info, not as a failure', () => {
    const d: Diagnostics = { ...base, credit: { available: null, note: 'Balance unavailable.' } };
    expect(find(d, 'Credit')?.state).toBe('info');
    expect(hasBlockingProblem(buildChecks(d))).toBe(false);
  });

  it('surfaces constraints that fail opaquely', () => {
    const d: Diagnostics = {
      ...base,
      constraints: [
        { provider: 'openai', applies_to: 'gpt-live-transcribe', constraint: 'Needs 24000 Hz.' },
      ],
    };
    expect(find(d, 'gpt-live-transcribe')?.detail).toBe('Needs 24000 Hz.');
  });
});

describe('formatChecks', () => {
  it('aligns labels and marks each state', () => {
    const lines = formatChecks(buildChecks(base));
    expect(lines[0]).toMatch(/^ {2}✓ Signed in\s+dev@example\.com/);
    expect(lines.some((l) => l.includes('· Scopes'))).toBe(true);
  });
});

describe('assessAgents', () => {
  const usable = ['csm', 'speko-uz', 'openai'];
  const voices = [
    { id: 'Ashley', vendor: 'inworld' },
    { id: 'alloy', vendor: 'openai' },
  ];

  it('flags a stage whose allowlist names nothing reachable', () => {
    // The real finding: an account reported all-green while its only agent
    // allowlisted 4 STT and 4 TTS providers, none of them reachable. A cascade
    // agent needs all three stages, so every call fails whatever it sends.
    const [assessed] = assessAgents(
      [
        {
          id: 'agent_1',
          name: 'Front desk',
          stackPreferences: {
            allowedProviders: {
              stt: ['assemblyai:universal-3-5-pro', 'soniox:stt-rt-v5'],
              llm: ['openai:gpt-5.6-luna', 'anthropic:claude-haiku-4-5'],
              tts: ['inworld:inworld-tts-2'],
            },
          },
        },
      ],
      usable,
      voices,
    );

    expect(assessed?.deadStages).toEqual(['stt', 'tts']);
    // LLM survives because openai is reachable, so it is not reported.
    expect(assessed?.usableByStage.llm).toEqual({ usable: 1, requested: 2 });
  });

  it('does not treat an empty allowlist as broken', () => {
    // Empty means "router picks", which is the default and the common case.
    // Warning on it would fire for almost every agent and teach the reader to
    // skip this section.
    const [assessed] = assessAgents(
      [{ id: 'agent_2', name: 'Default', stackPreferences: { allowedProviders: {} } }],
      usable,
      voices,
    );
    expect(assessed?.deadStages).toEqual([]);
  });

  it('resolves a voice name to its vendor and checks that too', () => {
    const [assessed] = assessAgents([{ id: 'a', name: 'A', voice: 'Ashley' }], usable, voices);
    expect(assessed?.unreachableVoice).toEqual({ voice: 'Ashley', vendor: 'inworld' });
  });

  it('accepts a reachable voice without complaint', () => {
    const [assessed] = assessAgents([{ id: 'a', name: 'A', voice: 'alloy' }], usable, voices);
    expect(assessed?.unreachableVoice).toBeNull();
  });

  it('cannot check a voice it has no catalogue for, and says nothing rather than passing it', () => {
    // The silent miss this replaced: /v1/voices wraps its list in `{ voices }`,
    // the client assumed a bare array, so the catalogue arrived empty and every
    // voice looked fine — including one on an unreachable vendor.
    const [assessed] = assessAgents([{ id: 'a', name: 'A', voice: 'Ashley' }], usable, []);
    expect(assessed?.unreachableVoice).toBeNull();
  });
});

describe('vendorOf', () => {
  it('takes the part before the colon', () => {
    expect(vendorOf('cartesia:sonic-3.5')).toBe('cartesia');
  });

  it('treats a bare id as its own vendor', () => {
    expect(vendorOf('openai')).toBe('openai');
  });
});

describe('buildChecks with agents', () => {
  it('blocks when an agent cannot reach a stage', () => {
    const agents = assessAgents(
      [{ id: 'a', name: 'Front desk', stackPreferences: { allowedProviders: { stt: ['x:y'] } } }],
      ['openai'],
      [],
    );
    const checks = buildChecks(base, agents);
    expect(hasBlockingProblem(checks)).toBe(true);
  });

  it('says so once when every agent is fine, rather than once per agent', () => {
    const agents = assessAgents(
      [
        { id: 'a', name: 'A' },
        { id: 'b', name: 'B' },
      ],
      ['openai'],
      [],
    );
    const checks = buildChecks(base, agents);
    expect(checks.filter((c) => c.label === 'Agents')).toHaveLength(1);
    expect(hasBlockingProblem(checks)).toBe(false);
  });

  it('omits the section entirely when the agent list could not be read', () => {
    const checks = buildChecks(base, null);
    expect(checks.some((c) => c.label === 'Agents')).toBe(false);
  });
});
