import { apiFetch } from './api-client.js';

/**
 * `speko-cli call` and `speko-cli logs` — the loop a developer or an agent actually
 * works in.
 *
 * The generated table already exposes `telephony create-phone-session`, so the
 * reason these are hand-written is everything that happens AFTER the request:
 * placing a call returns a session id and nothing else, and a voice change is
 * only verifiable by hearing (or reading) what the agent said. Without a
 * command that waits and then prints the transcript, the loop is "place a call,
 * then go and find it in the dashboard" — which is the round trip the CLI
 * exists to remove.
 */

export interface PhoneSessionResponse {
  readonly sessionId: string;
  readonly callControlId?: string | null;
  readonly roomName?: string | null;
  readonly status?: string | null;
  readonly to?: string | null;
  readonly from?: string | null;
}

export interface TranscriptTurn {
  readonly index?: number;
  /** The API's own field. `role`/`speaker` are accepted as aliases. */
  readonly source?: string | null;
  readonly role?: string | null;
  readonly speaker?: string | null;
  readonly text?: string | null;
  readonly content?: string | null;
}

/**
 * `GET /v1/calls/{id}` returns the transcript as `{ entries: [...] }`, not as a
 * bare array.
 *
 * Typing it as an array meant `speko-cli call` printed "(no transcript
 * captured)" after a perfectly good call — the one output the command exists to
 * produce. It surfaced only once there were real sessions to read, because
 * every earlier test either failed before a transcript existed or asserted
 * against a fixture I had shaped myself. Both forms are accepted so a fixture
 * and the live API cannot disagree again.
 */
export type TranscriptField =
  | readonly TranscriptTurn[]
  | { readonly entries?: readonly TranscriptTurn[] }
  | null;

export function transcriptTurns(transcript: TranscriptField | undefined): TranscriptTurn[] {
  if (!transcript) return [];
  if (Array.isArray(transcript)) return [...transcript];
  // Read through a cast rather than narrowing: an array also has an `entries`
  // member (the iterator method), so the union's else-branch does not narrow
  // to the object shape on its own.
  const entries = (transcript as { entries?: readonly TranscriptTurn[] }).entries;
  return entries ? [...entries] : [];
}

export interface CallDetail {
  readonly id: string;
  readonly status?: string | null;
  readonly ended_at?: string | null;
  readonly duration_seconds?: number | null;
  readonly transcript?: TranscriptField;
  readonly report?: unknown;
}

export interface CallEvent {
  readonly id: string;
  readonly event_type: string;
  readonly occurred_at: string;
  readonly provider?: string | null;
  readonly status?: string | null;
  readonly failure_cause?: string | null;
  readonly sip_status_code?: number | null;
  readonly sip_status?: string | null;
}

/**
 * Statuses that mean the call is over.
 *
 * Used only as a SECONDARY signal. `ended_at` is the primary one, because it
 * cannot be wrong: a session carrying an end timestamp is finished whatever its
 * status string happens to say, and a new status added server-side would
 * otherwise make this CLI poll a completed call until it timed out. Both
 * spellings of cancelled appear in the schema.
 */
const TERMINAL_STATUSES = new Set([
  'completed',
  'ended',
  'failed',
  'busy',
  'canceled',
  'cancelled',
  'no_answer',
]);

export function isFinished(call: CallDetail): boolean {
  if (call.ended_at) return true;
  return call.status ? TERMINAL_STATUSES.has(call.status) : false;
}

export interface CallFlags {
  readonly to?: string;
  readonly from?: string;
  readonly agent?: string;
  readonly prompt?: string;
  readonly 'first-message'?: string;
  readonly data?: string;
}

/**
 * Builds the request body.
 *
 * `--data` is merged UNDER the named flags rather than replacing them, so a
 * caller can pass a full configuration and still override one field on the
 * command line — the common shape when an agent iterates on a prompt against a
 * fixed rig.
 */
export function buildCallBody(flags: Record<string, string>): Record<string, unknown> {
  const base: Record<string, unknown> = {};
  if (flags['data']) {
    const parsed: unknown = JSON.parse(flags['data']);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('--data must be a JSON object.');
    }
    Object.assign(base, parsed);
  }
  if (flags['to']) base['to'] = flags['to'];
  if (flags['from']) base['from'] = flags['from'];
  if (flags['agent']) base['agentId'] = flags['agent'];
  if (flags['prompt']) base['systemPrompt'] = flags['prompt'];
  if (flags['first-message']) base['firstMessage'] = flags['first-message'];
  return base;
}

export function placeCall(body: Record<string, unknown>): Promise<PhoneSessionResponse> {
  return apiFetch<PhoneSessionResponse>('/sessions/phone', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function getCall(id: string): Promise<CallDetail> {
  return apiFetch<CallDetail>(`/calls/${encodeURIComponent(id)}`);
}

export function listCallEvents(id: string): Promise<{ events: CallEvent[] }> {
  return apiFetch<{ events: CallEvent[] }>(`/calls/${encodeURIComponent(id)}/events`);
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
  readonly fetchCall?: (id: string) => Promise<CallDetail>;
  /** Called when the reported status changes, so a terminal can narrate. */
  readonly onStatus?: (status: string) => void;
}

/**
 * Polls until the call ends or the deadline passes.
 *
 * A timeout returns the last known state rather than throwing: the call is
 * real and still running, and the session id is the thing the caller needs in
 * order to follow it. Throwing here would discard the one useful piece of
 * information in the failure.
 */
export async function waitForCall(
  id: string,
  options: WaitOptions = {},
): Promise<{ call: CallDetail; timedOut: boolean }> {
  const timeoutMs = options.timeoutMs ?? 300_000;
  const intervalMs = options.intervalMs ?? 2_000;
  const now = options.now ?? Date.now;
  const pause = options.wait ?? sleep;
  const fetchCall = options.fetchCall ?? getCall;

  const deadline = now() + timeoutMs;
  let last: CallDetail = { id };
  let reported: string | null = null;

  while (now() < deadline) {
    last = await fetchCall(id);
    if (last.status && last.status !== reported) {
      reported = last.status;
      options.onStatus?.(last.status);
    }
    if (isFinished(last)) return { call: last, timedOut: false };
    await pause(intervalMs);
  }

  return { call: last, timedOut: true };
}

const turnText = (turn: TranscriptTurn): string => turn.text ?? turn.content ?? '';
const turnRole = (turn: TranscriptTurn): string =>
  turn.source ?? turn.role ?? turn.speaker ?? 'unknown';

/** The transcript as readable lines. */
export function formatTranscript(turns: readonly TranscriptTurn[]): string[] {
  if (turns.length === 0) return ['(no transcript captured)'];
  return turns.map((turn) => `${turnRole(turn).padEnd(9)} ${turnText(turn)}`.trimEnd());
}

/**
 * One line per event, leading with what went wrong when something did.
 *
 * `failure_cause` and `sip_status` are the fields that explain a failed call,
 * and burying them inside a payload dump is how a caller ends up reading a JSON
 * blob to find out that the number was busy.
 */
export function formatEvent(event: CallEvent): string {
  const time = event.occurred_at.slice(11, 19) || event.occurred_at;
  const parts = [time, event.event_type];
  if (event.status) parts.push(event.status);
  if (event.failure_cause) parts.push(`cause=${event.failure_cause}`);
  if (event.sip_status_code || event.sip_status) {
    parts.push(
      `sip=${event.sip_status_code ?? ''}${event.sip_status ? ` ${event.sip_status}` : ''}`.trim(),
    );
  }
  if (event.provider) parts.push(`(${event.provider})`);
  return parts.join('  ');
}

export interface FollowOptions {
  readonly intervalMs?: number;
  readonly timeoutMs?: number;
  readonly now?: () => number;
  readonly wait?: (ms: number) => Promise<void>;
  readonly fetchEvents?: (id: string) => Promise<{ events: CallEvent[] }>;
  readonly fetchCall?: (id: string) => Promise<CallDetail>;
  readonly onEvent: (event: CallEvent) => void;
}

/**
 * Streams events by polling, since the API exposes no cursor and no stream for
 * them. Seen ids are tracked so a re-fetch does not reprint the log, and the
 * loop stops once the call itself has ended — a follow that ran forever on a
 * finished call would look like a hang.
 *
 * Events are fetched once more after the call is seen to end, because the ones
 * that explain how it ended (a `call.failed` with its cause) usually land
 * between the last events poll and the status check. A timeout is reported
 * rather than returned silently, so the caller can say the call is still live,
 * and the status is checked one last time after the deadline so a call that
 * ended during the final pause is not reported as still running.
 */
export async function followEvents(
  id: string,
  options: FollowOptions,
): Promise<{ timedOut: boolean }> {
  const intervalMs = options.intervalMs ?? 2_000;
  const timeoutMs = options.timeoutMs ?? 600_000;
  const now = options.now ?? Date.now;
  const pause = options.wait ?? sleep;
  const fetchEvents = options.fetchEvents ?? listCallEvents;
  const fetchCall = options.fetchCall ?? getCall;

  const seen = new Set<string>();
  const deadline = now() + timeoutMs;

  const drain = async (): Promise<void> => {
    const { events } = await fetchEvents(id);
    for (const event of events) {
      if (seen.has(event.id)) continue;
      seen.add(event.id);
      options.onEvent(event);
    }
  };

  /** Prints what is new, then says whether the call has ended. */
  const settled = async (): Promise<boolean> => {
    await drain();
    const call = await fetchCall(id);
    if (!isFinished(call)) return false;
    await drain();
    return true;
  };

  while (now() < deadline) {
    if (await settled()) return { timedOut: false };
    await pause(intervalMs);
  }

  // The deadline lands in the middle of a pause, so the call may well have
  // ended while this was asleep. Ask once more before calling it a timeout:
  // telling a caller a finished call is still running sends them back to
  // follow something that has nothing left to say.
  return { timedOut: !(await settled()) };
}
