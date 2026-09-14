import { describe, expect, it } from 'vitest';
import { COMMANDS } from './generated/commands.js';
import { HUMAN_GATES, humanGateFor } from './human-gated.js';

const known = new Set(COMMANDS.map((c) => c.operationId));

describe('every gate names a real operation', () => {
  it('holds for every refusal', () => {
    // A gate keyed on an operationId that no longer exists is silently OFF,
    // and nothing else would notice: the command keeps working and the guard
    // it was meant to have is gone. Writing this test caught three ids I had
    // guessed rather than looked up (releasePhoneNumber, buyPhoneNumber,
    // deleteSmsConversation — the real ones are deletePhoneNumber,
    // createPhoneNumber and redactSmsConversation).
    for (const gate of HUMAN_GATES) {
      expect(known.has(gate.operationId), `unknown operationId: ${gate.operationId}`).toBe(true);
    }
  });

  it('gates nothing twice', () => {
    const ids = HUMAN_GATES.map((g) => g.operationId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('humanGateFor', () => {
  it('refuses the KYB submission outright', () => {
    const refusal = humanGateFor('submitPhoneNumberKyb', undefined);
    expect(refusal?.reason).toMatch(/authorized to bind the business/);
    expect(refusal?.url).toContain('/agents/phone-numbers');
  });

  it('refuses a draft that claims the attestation', () => {
    expect(humanGateFor('savePhoneNumberKybDraft', '{"attestationAccepted":true}')).not.toBeNull();
  });

  it('allows a draft that does not', () => {
    // Filling in a business profile is ordinary work; only the attestation is
    // off limits. Refusing the whole draft would push the agent back to the
    // console for a form it could legitimately complete.
    expect(humanGateFor('savePhoneNumberKybDraft', '{"businessProfile":{"name":"X"}}')).toBeNull();
    expect(humanGateFor('savePhoneNumberKybDraft', undefined)).toBeNull();
  });

  it('treats an unparseable body as not-a-refusal', () => {
    // Malformed JSON is a usage error the executor reports separately; calling
    // it a refusal would send the caller to the console over a typo.
    expect(humanGateFor('savePhoneNumberKybDraft', '{not json')).toBeNull();
  });

  it('sends buying and releasing a number to the console', () => {
    expect(humanGateFor('createPhoneNumber', '{}')?.reason).toMatch(/recurring monthly charge/);
    expect(humanGateFor('deletePhoneNumber', undefined)?.reason).toMatch(/cannot be recovered/);
  });

  it('leaves the two destructive ops that belong in the loop alone', () => {
    // Deleting an agent is how anyone iterating discards a test agent, and
    // redacting a conversation is plausibly how a data-deletion request is
    // serviced — which wants to be scriptable, not clicked.
    expect(humanGateFor('deleteAgent', undefined)).toBeNull();
    expect(humanGateFor('redactSmsConversation', undefined)).toBeNull();
  });

  it('leaves everything else alone', () => {
    expect(humanGateFor('listAgents', undefined)).toBeNull();
    // Recording consent is NOT gated: it records an event with a source, not a
    // named person's assertion, and a webform calling the API is the intended
    // path. Gating it would break the primary use case.
    expect(humanGateFor('createSmsConsent', '{"recipient":"+1555"}')).toBeNull();
  });
});
