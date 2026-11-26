import assert from "node:assert/strict";
import { test } from "node:test";
import {
  offerTransitions,
  transferTransitions,
  operationTransitions,
  autoNextIntentTransitions,
  inboundPhaseTransitions,
  type DeskCoordination
} from "@outbound-dialer/shared";
import {
  startNextCallSchema,
  startLeadCallSchema,
  startManualCallSchema,
  deskRevisionSchema,
  createDeskSessionSchema,
  updateDeskSessionSchema,
  deskMutationSchema,
  createTransferSchema,
  deskCoordinationSchema,
  coordinationMutationResponseSchema,
  acceptCallOfferResponseSchema,
  coordinationErrorSchema,
  saveInboundNumberSchema,
  saveInboundQueueSchema,
  saveInboundFlowSchema,
  canTransition,
  requestFingerprint,
  idempotencyScope,
  resolveRequestReplay
} from "./call-coordination-contracts.js";

const id = "11111111-1111-4111-8111-111111111111";
const otherId = "22222222-2222-4222-8222-222222222222";
const mutation = {
  deskSessionId: id,
  expectedRevision: "9007199254740993",
  bindingGeneration: "2",
  idempotencyKey: id
};
const auto = { ...mutation, startReason: "automatic", sourceCallId: otherId };
const manual = { ...mutation, startReason: "manual" };

export function coordinationFixture(): DeskCoordination {
  return {
    contractVersion: 1,
    revision: mutation.expectedRevision,
    session: {
      id,
      revision: mutation.expectedRevision,
      bindingGeneration: "2",
      campaignId: id,
      endpointVerified: true,
      ready: true,
      expiresAt: "2026-11-15T12:00:00Z"
    },
    slot: { state: "free", callId: null, reservationId: null, generation: "2" },
    offer: {
      id,
      callId: otherId,
      kind: "inbound",
      transferId: null,
      state: "pending",
      deadlineAt: "2026-11-15T12:00:00Z",
      campaignId: id,
      callingNumber: "+14155550100",
      closureReason: null
    },
    transfer: null,
    autoNextIntent: { id, sourceCallId: id, state: "deferred", reason: "incoming_pending", callId: null },
    actions: {
      manualStart: { allowed: true, reason: null },
      autoNext: { allowed: false, reason: "incoming_pending" },
      accept: { allowed: true, reason: null },
      ignore: { allowed: true, reason: null },
      transfer: { allowed: false, reason: "no_active_call" }
    }
  };
}

test("B05.1 explicit intent and revision payloads validate without granting authority", () => {
  assert.deepEqual(startNextCallSchema.parse({}), {});
  assert.deepEqual(startNextCallSchema.parse({ intent: auto }).intent, auto);
  assert.ok(startNextCallSchema.safeParse({ intent: manual }).success);
  assert.ok(startManualCallSchema.safeParse({ phoneNumber: "+14155550100", intent: manual }).success);
  assert.ok(startLeadCallSchema.safeParse({ intent: manual, confirmRetryWait: true }).success);
  for (const payload of [
    { intent: { ...auto, sourceCallId: undefined } },
    { intent: { ...auto, expectedRevision: 1 } },
    { intent: { ...auto, bindingGeneration: "0" } },
    { intent: { ...manual, sourceCallId: id } },
    { intent: { ...manual, sipDestination: "sofia/evil" } },
    { intent: { ...manual, agentId: otherId } },
    { startReason: "manual" },
    { agentId: otherId },
    { intent: {} }
  ])
    assert.equal(startNextCallSchema.safeParse(payload).success, false, JSON.stringify(payload));
  assert.equal(startLeadCallSchema.safeParse({ intent: auto }).success, false);
  assert.equal(startManualCallSchema.safeParse({ phoneNumber: "+14155550100", intent: auto }).success, false);
  for (const bad of ["0", "-1", "01", "1.1", "9223372036854775808", 1])
    assert.equal(deskRevisionSchema.safeParse(bad).success, false);
  assert.equal(deskRevisionSchema.parse("9223372036854775807"), "9223372036854775807");
  assert.ok(
    createDeskSessionSchema.safeParse({ idempotencyKey: id, expectedRevision: null, campaignId: null })
      .success
  );
  assert.ok(updateDeskSessionSchema.safeParse({ ...mutation, campaignId: id, ready: true }).success);
  assert.ok(deskMutationSchema.safeParse(mutation).success);
  assert.ok(createTransferSchema.safeParse({ ...mutation, recipientAgentId: otherId }).success);
  assert.equal(
    updateDeskSessionSchema.safeParse({ ...mutation, campaignId: id, ready: true, verifiedEndpoint: "spoof" })
      .success,
    false
  );
});

test("B05.1 Desk independently exposes incoming priority, manual actions, transfer and slot state", () => {
  const fixture = coordinationFixture();
  const response = deskCoordinationSchema.parse(fixture);
  assert.equal(response.actions.manualStart.allowed, true);
  assert.equal(response.actions.autoNext.allowed, false);
  assert.equal(response.autoNextIntent?.state, "deferred");
  fixture.transfer = {
    id,
    callId: id,
    sourceAgentId: id,
    recipientAgentId: otherId,
    state: "offered",
    deadlineAt: "2026-11-15T12:00:00Z"
  };
  fixture.offer = { ...fixture.offer!, kind: "transfer", transferId: id };
  assert.ok(deskCoordinationSchema.safeParse(fixture).success);
  for (const invalid of [
    { ...fixture, revision: 1 },
    { ...fixture, session: { ...fixture.session, ready: true, endpointVerified: false } },
    { ...fixture, slot: { ...fixture.slot, reservationId: id } },
    { ...fixture, offer: { ...fixture.offer, transferId: null } },
    { ...fixture, offer: { ...fixture.offer, state: "ignored", closureReason: "user_ignored" } },
    { ...fixture, offer: { ...fixture.offer, state: "expired", closureReason: "user_ignored" } },
    { ...fixture, autoNextIntent: { ...fixture.autoNextIntent, callId: id } },
    { ...fixture, actions: { ...fixture.actions, autoNext: { allowed: true, reason: null } } }
  ])
    assert.equal(deskCoordinationSchema.safeParse(invalid).success, false);
});

test("B05.2 acceptance is connecting; deferred responses carry the same intent and no new call", () => {
  assert.equal(
    acceptCallOfferResponseSchema.safeParse({ status: "started", revision: "3", callId: id, operationId: id })
      .success,
    false
  );
  assert.ok(
    coordinationMutationResponseSchema.safeParse({
      status: "connecting",
      revision: "3",
      callId: id,
      offerId: id,
      operationId: id
    }).success
  );
  assert.equal(
    coordinationMutationResponseSchema.safeParse({
      status: "bridged",
      revision: "3",
      callId: id,
      offerId: id,
      operationId: id
    }).success,
    false
  );
  const deferred = {
    status: "deferred",
    revision: "3",
    reason: "incoming_pending",
    intent: coordinationFixture().autoNextIntent
  };
  assert.ok(coordinationMutationResponseSchema.safeParse(deferred).success);
  assert.equal(coordinationMutationResponseSchema.safeParse({ ...deferred, callId: id }).success, false);
  assert.ok(
    coordinationErrorSchema.safeParse({ message: "Refresh Desk", code: "revision_conflict", revision: "3" })
      .success
  );
});

test("B05.2 all state tables forbid terminal regression and executing/uncertain retries", () => {
  function assertTerminals<State extends string>(table: Record<State, readonly State[]>, terminals: State[]) {
    for (const from of terminals)
      for (const to of Object.keys(table) as State[])
        assert.equal(canTransition(table, from, to), from === to, `${from} -> ${to}`);
  }
  assertTerminals(offerTransitions, ["accepted", "ignored", "expired", "declined", "canceled", "failed"]);
  assertTerminals(transferTransitions, ["completed", "declined", "expired", "canceled", "failed"]);
  assertTerminals(operationTransitions, ["succeeded", "failed", "canceled"]);
  assertTerminals(autoNextIntentTransitions, ["started", "canceled"]);
  assertTerminals(inboundPhaseTransitions, ["completed", "failed", "canceled"]);
  assert.ok(canTransition(inboundPhaseTransitions, "queued", "connecting"));
  assert.ok(canTransition(inboundPhaseTransitions, "connecting", "queued"));
  assert.equal(canTransition(inboundPhaseTransitions, "fallback", "connecting"), false);
  assert.equal(canTransition(operationTransitions, "uncertain", "executing"), false);
  assert.equal(canTransition(operationTransitions, "executing", "pending"), false);
  assert.equal(canTransition(transferTransitions, "connecting", "offered"), false);
});

test("B05.2 canonical fingerprints, scoped retries and changed-payload conflict", () => {
  const fingerprint = (payload: unknown, resourceId = id) =>
    requestFingerprint("POST", "/agent/call-next", resourceId, payload);
  const payload = { campaignId: id, intent: auto };
  assert.equal(fingerprint(payload), fingerprint({ intent: { ...auto }, campaignId: id }));
  assert.equal(
    fingerprint(payload),
    fingerprint({ ...payload, intent: { ...auto, idempotencyKey: otherId } })
  );
  for (const changed of [
    { ...payload, campaignId: otherId },
    { ...payload, intent: manual },
    { ...payload, intent: { ...auto, expectedRevision: "2" } },
    { ...payload, intent: { ...auto, sourceCallId: id } },
    { ...payload, intent: { ...auto, bindingGeneration: "3" } }
  ])
    assert.notEqual(fingerprint(payload), fingerprint(changed));
  assert.notEqual(fingerprint(payload), fingerprint(payload, otherId));
  const scope = idempotencyScope(id, "POST", "/agent/call-next", null);
  assert.notEqual(scope, idempotencyScope(otherId, "POST", "/agent/call-next", null));
  assert.notEqual(scope, idempotencyScope(id, "POST", "/agent/leads/:contactId/call", id));
  assert.ok(scope.length <= 200);
  const request = { scope, key: id, fingerprint: fingerprint(payload) };
  const result = { status: "started", callId: id, state: "completed" };
  const stored = { ...request, state: "succeeded" as const, result };
  assert.deepEqual(resolveRequestReplay(stored, request), { status: "replay", result });
  assert.deepEqual(
    resolveRequestReplay(stored, {
      ...request,
      fingerprint: fingerprint({ ...payload, campaignId: otherId })
    }),
    { status: "conflict" }
  );
  assert.deepEqual(resolveRequestReplay(null, request), { status: "new" });
  for (const state of ["pending", "executing", "uncertain"] as const) {
    assert.deepEqual(resolveRequestReplay({ ...stored, state, result: null }, request), {
      status: "pending",
      state
    });
  }
});

test("B05.1/B05.4 admin payloads reuse bounded B01 validators and normalized DID", () => {
  const mutation = { idempotencyKey: id, expectedRevision: null };
  const number = { ...mutation, label: "Main", queueId: id, enabled: false };
  assert.equal(saveInboundNumberSchema.parse({ ...number, did: "+1 (415) 555-0100" }).did, "+14155550100");
  assert.equal(saveInboundNumberSchema.parse({ ...number, did: " 61491570006 " }).did, "+61491570006");
  for (const did of ["0491570006", "999123456789", "sip:61491570006@example.com"]) {
    assert.equal(saveInboundNumberSchema.safeParse({ ...number, did }).success, false);
  }
  const queue = {
    ...mutation,
    name: "Queue",
    campaignId: id,
    waitingRecordingId: null,
    noAnswerFlowVersionId: null,
    configuration: {}
  };
  assert.ok(saveInboundQueueSchema.safeParse(queue).success);
  assert.equal(
    saveInboundQueueSchema.safeParse({ ...queue, configuration: { maxWaitingCalls: 1000 } }).success,
    false
  );
  assert.ok(
    saveInboundFlowSchema.safeParse({
      ...mutation,
      name: "Close",
      campaignId: id,
      definition: { actions: [{ type: "hangup" }] }
    }).success
  );
  assert.equal(
    saveInboundFlowSchema.safeParse({
      ...mutation,
      name: "Loop",
      campaignId: id,
      definition: { actions: [{ type: "goto", flowId: id }] }
    }).success,
    false
  );
});
