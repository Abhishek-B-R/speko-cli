import { DASHBOARD_URL } from './constants.js';

/**
 * Operations the CLI can technically perform and deliberately will not.
 *
 * There is ONE mechanism here, not two. An earlier version also had a `--yes`
 * tier for irreversible-but-legitimate acts, and it was removed because it
 * gated nothing: an agent passes `--yes` the moment the user asks for the
 * thing, so the flag only ever documented an intention it could not verify.
 * Either an act belongs to a person — in which case the CLI sends them to the
 * console — or it belongs in the loop, in which case it just runs. Deleting an
 * agent and redacting a conversation stayed in the loop deliberately: the first
 * is how anyone iterating creates and discards test agents, and the second is
 * plausibly how a data-deletion request gets serviced, which wants to be
 * scriptable.
 *
 * The API does not stop these — a `speko-cli login` credential is a session
 * token, so anything a signed-in person can do over HTTP, the CLI can do too.
 * The line drawn here is narrower than the one the server enforces, and it is
 * drawn for one reason: some acts are only meaningful because a NAMED PERSON
 * performed them, and performing them from a script records that person as
 * having done something they did not do.
 *
 * `phone-numbers/kyb/submit` is the clearest case. Its body requires
 * `attestationAccepted: true`, whose text reads "I confirm that I am authorized
 * to bind the business named above… The business accepts responsibility for all
 * use of these numbers and agrees to Speko's Terms of Service, including
 * Acceptable Use and Indemnity." The server then stores the authenticated
 * user's name, email and organization role as the attestor. An agent posting
 * that flag writes a legal attestation into the record under a human's
 * identity, on a matter — carrier compliance, indemnity — where being wrong is
 * expensive for that human specifically.
 *
 * This is the same posture as not creating API keys: not a capability gap, a
 * decision about which acts belong to a person. The refusal names the console
 * URL so the agent has somewhere to send them rather than simply failing.
 */

export interface HumanGate {
  /** Matched against the generated table's operationId. */
  readonly operationId: string;
  /** Printed as the reason. One or two sentences, no lecture. */
  readonly reason: string;
  /** Where the human does it instead. */
  readonly path: string;
  /**
   * When present, the operation is refused ONLY if this returns true for the
   * parsed body — for calls that are benign in most shapes and binding in one.
   */
  readonly onlyWhen?: (body: unknown) => boolean;
}

const attestationClaimed = (body: unknown): boolean =>
  Boolean(
    body && typeof body === 'object' && (body as Record<string, unknown>)['attestationAccepted'],
  );

export const HUMAN_GATES: readonly HumanGate[] = [
  {
    operationId: 'submitPhoneNumberKyb',
    reason:
      'Submitting business verification asserts that you are authorized to bind the business, and accepts responsibility and indemnity for how the numbers are used. It is recorded against your name, so a person has to do it.',
    path: '/agents/phone-numbers',
  },
  {
    operationId: 'createPhoneNumber',
    reason:
      "Buying a number spends money and starts a recurring monthly charge. Choosing to do that is yours, not the CLI's.",
    path: '/agents/phone-numbers',
  },
  {
    operationId: 'deletePhoneNumber',
    reason:
      'Releasing a number returns it to the carrier permanently. It cannot be recovered, and anyone who calls it stops reaching you.',
    path: '/agents/phone-numbers',
  },
  {
    // The draft is a fine thing for an agent to fill in — business name,
    // address, representative. Only the attestation flag is off limits, and
    // only because a draft carrying it is one `submit` away from binding.
    operationId: 'savePhoneNumberKybDraft',
    reason:
      'A draft can be filled in from the CLI, but the attestation cannot be accepted on your behalf. Send the draft without `attestationAccepted`, then confirm the terms in the console.',
    path: '/agents/phone-numbers',
    onlyWhen: attestationClaimed,
  },
];

export interface Refusal {
  readonly reason: string;
  readonly url: string;
}

/**
 * Whether this operation is refused for this body.
 *
 * `rawBody` is the unparsed string because the executor validates JSON
 * separately; a body that does not parse is not a refusal, it is a usage error,
 * and reporting the wrong one of those sends the caller down the wrong path.
 */
export function humanGateFor(operationId: string, rawBody: string | undefined): Refusal | null {
  const gate = HUMAN_GATES.find((g) => g.operationId === operationId);
  if (!gate) return null;

  if (gate.onlyWhen) {
    if (rawBody === undefined) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      return null;
    }
    if (!gate.onlyWhen(parsed)) return null;
  }

  return { reason: gate.reason, url: `${DASHBOARD_URL}${gate.path}` };
}
