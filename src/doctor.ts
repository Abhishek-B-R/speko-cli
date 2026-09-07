import { apiFetch } from './api-client.js';
import { unwrapList } from './run-command.js';

/**
 * An agent's provider allowlist, and the voice it asks for.
 *
 * Read so `doctor` can answer the question neither half could answer alone:
 * `/v1/diagnostics` knows which providers this workspace can reach, and
 * `GET /v1/agents` knows which ones each agent asks for, and nothing joined
 * them. An account could therefore be reported all-green while its only agent
 * referenced a stage with no reachable provider at all — a cascade agent needs
 * STT, LLM and TTS, so one empty stage means every call fails regardless of
 * what the request said.
 */
export interface AgentProviderRefs {
  readonly id: string;
  readonly name?: string | null;
  readonly voice?: string | null;
  readonly stackPreferences?: {
    readonly allowedProviders?: {
      readonly stt?: readonly string[];
      readonly llm?: readonly string[];
      readonly tts?: readonly string[];
    } | null;
  } | null;
}

export interface VoiceRef {
  readonly id: string;
  readonly vendor: string;
}

/** `cartesia:sonic-3.5` → `cartesia`. A bare id has no vendor to check. */
export function vendorOf(providerId: string): string | null {
  const [vendor] = providerId.split(':');
  return vendor && vendor !== providerId ? vendor : providerId || null;
}

const STAGES = ['stt', 'llm', 'tts'] as const;
export type Stage = (typeof STAGES)[number];

export interface AgentReachability {
  readonly id: string;
  readonly name: string;
  /** Stages whose allowlist names nothing this workspace can reach. */
  readonly deadStages: readonly Stage[];
  /** Per stage: how many of the allowlisted vendors are usable. */
  readonly usableByStage: Readonly<Record<Stage, { usable: number; requested: number }>>;
  /** Set when the agent's voice resolves to a vendor that is not usable. */
  readonly unreachableVoice: { voice: string; vendor: string } | null;
}

/**
 * Which agents cannot actually run.
 *
 * A stage counts as dead only when it names providers AND none are reachable.
 * An EMPTY allowlist is not a problem — it means "router picks", which is the
 * default and the common case; treating it as a failure would warn on almost
 * every agent and teach the reader to ignore this section.
 */
export function assessAgents(
  agents: readonly AgentProviderRefs[],
  usableProviders: readonly string[],
  voices: readonly VoiceRef[],
): AgentReachability[] {
  const usable = new Set(usableProviders);
  const voiceVendor = new Map(voices.map((v) => [v.id.toLowerCase(), v.vendor]));

  return agents.map((agent) => {
    const allowed = agent.stackPreferences?.allowedProviders ?? {};
    const usableByStage = {} as Record<Stage, { usable: number; requested: number }>;
    const deadStages: Stage[] = [];

    for (const stage of STAGES) {
      const requested = allowed[stage] ?? [];
      const reachable = requested.filter((id) => {
        const vendor = vendorOf(id);
        return vendor !== null && usable.has(vendor);
      });
      usableByStage[stage] = { usable: reachable.length, requested: requested.length };
      if (requested.length > 0 && reachable.length === 0) deadStages.push(stage);
    }

    const vendor = agent.voice ? voiceVendor.get(agent.voice.toLowerCase()) : undefined;
    const unreachableVoice =
      agent.voice && vendor && !usable.has(vendor) ? { voice: agent.voice, vendor } : null;

    return {
      id: agent.id,
      name: agent.name ?? agent.id,
      deadStages,
      usableByStage,
      unreachableVoice,
    };
  });
}

/**
 * `speko-cli doctor` — the answer to "why did that fail", assembled before anyone
 * has to ask.
 *
 * The failures this exists for all look identical from outside: a managed
 * provider with no platform key, a workspace out of credit, a credential
 * narrower than the caller assumed, and a genuinely malformed request all
 * surface as an opaque error. So the checks are ordered by what a caller can
 * act on, and each one states the specific fact rather than a verdict — naming
 * the provider that needs a key beats reporting that routing failed.
 */

export interface Diagnostics {
  readonly identity: {
    readonly organization_id: string;
    readonly user_id: string | null;
    readonly principal: string;
    readonly session_origin: string | null;
    readonly role: string | null;
    readonly scopes: readonly string[];
    readonly email?: string;
  };
  readonly credit:
    | { readonly available: null; readonly note: string }
    | { readonly available_usd: number; readonly sufficient: boolean };
  readonly providers: {
    readonly usable: readonly { provider: string; byok: boolean; managed: boolean }[];
    readonly unusable: readonly { provider: string; reason: string }[];
  };
  readonly constraints: readonly {
    provider: string;
    applies_to: string;
    constraint: string;
  }[];
  readonly last_failure: {
    readonly session_id: string;
    readonly status: string;
    readonly ended_at: string | null;
  } | null;
}

export function fetchDiagnostics(): Promise<Diagnostics> {
  return apiFetch<Diagnostics>('/diagnostics');
}

/**
 * The two extra reads the agent check needs.
 *
 * Failure is not fatal: `doctor` exists to be useful when things are broken, so
 * a missing agent list degrades to omitting that section rather than taking the
 * whole report down with it.
 */
export async function fetchAgentReachability(
  usableProviders: readonly string[],
): Promise<AgentReachability[] | null> {
  try {
    const [agents, voices] = await Promise.all([
      apiFetch<unknown>('/agents'),
      apiFetch<unknown>('/voices').catch(() => null),
    ]);
    return assessAgents(
      unwrapList<AgentProviderRefs>('/agents', 'GET', agents),
      usableProviders,
      unwrapList<VoiceRef>('/voices', 'GET', voices),
    );
  } catch {
    return null;
  }
}

export type CheckState = 'ok' | 'warn' | 'info';

export interface Check {
  readonly state: CheckState;
  readonly label: string;
  readonly detail: string;
}

const MARK: Record<CheckState, string> = { ok: '✓', warn: '!', info: '·' };

/**
 * Turns the report into checks.
 *
 * `warn` is reserved for something that will actually stop a call working. A
 * doctor that warns about everything it notices trains the reader to skim it,
 * and then the one line that mattered gets skimmed too.
 */
export function buildChecks(
  d: Diagnostics,
  agents: readonly AgentReachability[] | null = null,
): Check[] {
  const checks: Check[] = [];

  checks.push({
    state: 'ok',
    label: 'Signed in',
    detail: `${d.identity.email ?? d.identity.principal} · org ${d.identity.organization_id}`,
  });

  checks.push({
    state: 'info',
    label: 'Scopes',
    detail:
      d.identity.session_origin === 'cli'
        ? `${d.identity.scopes.join(' ')} (CLI sessions cannot read org credentials or billing)`
        : d.identity.scopes.join(' '),
  });

  if ('available_usd' in d.credit) {
    checks.push({
      state: d.credit.sufficient ? 'ok' : 'warn',
      label: 'Credit',
      detail: d.credit.sufficient
        ? `$${d.credit.available_usd.toFixed(2)} available`
        : 'No credit remaining — calls will fail until the workspace is topped up.',
    });
  } else {
    checks.push({ state: 'info', label: 'Credit', detail: d.credit.note });
  }

  const usable = d.providers.usable;
  if (usable.length === 0) {
    // The condition behind the "N broken adapters" misreading: nothing is
    // dispatchable, so every provider looks dead from the outside.
    checks.push({
      state: 'warn',
      label: 'Providers',
      detail:
        'No provider is usable by this workspace. Every session will fail regardless of the request. Add a BYOK key, or have a platform key configured.',
    });
  } else {
    const byokOnly = usable.filter((p) => p.byok && !p.managed).length;
    const managedCount = usable.filter((p) => p.managed).length;
    checks.push({
      state: 'ok',
      label: 'Providers',
      detail: `${usable.length} usable (${managedCount} managed, ${byokOnly} your own key only)`,
    });
  }

  if (d.providers.unusable.length > 0) {
    checks.push({
      state: 'info',
      label: 'Not usable',
      detail: `${d.providers.unusable.length}: ${d.providers.unusable
        .map((p) => p.provider)
        .slice(0, 8)
        .join(', ')}${d.providers.unusable.length > 8 ? ', …' : ''}`,
    });
  }

  for (const constraint of d.constraints) {
    checks.push({
      state: 'info',
      label: constraint.applies_to,
      detail: constraint.constraint,
    });
  }

  /**
   * The join. Reported per agent and only when there is something wrong,
   * because a line saying "this agent is fine" for every agent is noise that
   * pushes the one broken agent off the screen.
   */
  if (agents) {
    const broken = agents.filter((a) => a.deadStages.length > 0 || a.unreachableVoice);
    if (broken.length === 0 && agents.length > 0) {
      checks.push({
        state: 'ok',
        label: 'Agents',
        detail: `${agents.length} configured, all referencing reachable providers`,
      });
    }
    for (const agent of broken) {
      if (agent.deadStages.length > 0) {
        const stages = agent.deadStages
          .map((stage) => `${stage} (0 of ${agent.usableByStage[stage].requested})`)
          .join(', ');
        checks.push({
          state: 'warn',
          label: agent.name,
          detail: `Allowlists no reachable provider for ${stages}. A cascade agent needs all three stages, so every call fails whatever the request says.`,
        });
      }
      if (agent.unreachableVoice) {
        checks.push({
          state: 'warn',
          label: agent.name,
          detail: `Voice "${agent.unreachableVoice.voice}" is ${agent.unreachableVoice.vendor}, which this workspace cannot reach.`,
        });
      }
    }
  }

  if (d.last_failure) {
    checks.push({
      state: 'info',
      label: 'Last failure',
      // The id, because the next useful action is reading its events — and
      // doctor deliberately does not guess at the cause.
      detail: `${d.last_failure.session_id} — inspect with \`speko-cli logs ${d.last_failure.session_id}\``,
    });
  }

  return checks;
}

export function formatChecks(checks: readonly Check[]): string[] {
  const width = Math.max(...checks.map((c) => c.label.length));
  return checks.map((c) => `  ${MARK[c.state]} ${c.label.padEnd(width)}  ${c.detail}`);
}

/** Non-zero when something found will stop a call from working. */
export function hasBlockingProblem(checks: readonly Check[]): boolean {
  return checks.some((c) => c.state === 'warn');
}
