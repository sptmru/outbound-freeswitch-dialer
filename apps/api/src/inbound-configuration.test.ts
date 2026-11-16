import assert from "node:assert/strict";
import { test } from "node:test";
import {
  inboundFlowVersionSchema,
  inboundQueueConfigurationSchema,
  normalizeInboundNumber
} from "./inbound-configuration.js";

const recordingId = "11111111-1111-4111-8111-111111111111";
const audio = (timeoutMs = 30000) => ({ type: "play_audio", recordingId, timeoutMs });
const forward = (timeoutMs = 20000) => ({ type: "forward_external", target: "+1 (415) 555-0100", timeoutMs });

test("B01.1 DID/target normalization uses strict phone validation", () => {
  for (const input of [" +1 (415) 555-0100 ", "0014155550100", "+14155550100"]) {
    assert.equal(normalizeInboundNumber(input), "+14155550100");
  }
  assert.equal(normalizeInboundNumber("(415) 555-0100", "US"), "+14155550100");
  for (const input of ["", "+123", "+999123456789", "4155550100", "sip:user@example.com"]) {
    assert.throws(() => normalizeInboundNumber(input));
  }
});

test("B01.1 queue bounds match A06 and preserve independent deadlines", () => {
  const defaults = inboundQueueConfigurationSchema.parse({});
  assert.deepEqual(defaults, {
    offerTimeoutMs: 15000,
    queueTimeoutMs: 60000,
    connectTimeoutMs: 10000,
    transferTimeoutMs: 20000,
    maxWaitingCalls: 40,
    overflowPolicy: "reject",
    overflowFlowVersionId: null
  });
  for (const [key, min, max] of [
    ["offerTimeoutMs", 5000, 30000],
    ["queueTimeoutMs", 15000, 300000],
    ["connectTimeoutMs", 6000, 15000],
    ["transferTimeoutMs", 5000, 30000],
    ["maxWaitingCalls", 1, 200]
  ] as const) {
    for (const value of [min, max])
      assert.ok(inboundQueueConfigurationSchema.safeParse({ [key]: value }).success);
    for (const value of [min - 1, max + 1, min + 0.5, Infinity, NaN])
      assert.equal(inboundQueueConfigurationSchema.safeParse({ [key]: value }).success, false);
  }
  for (const input of [
    { connectTimeoutMs: 15000, queueTimeoutMs: 15000 },
    { overflowPolicy: "flow" },
    { overflowFlowVersionId: recordingId },
    { overflowPolicy: "requeue" }
  ])
    assert.equal(inboundQueueConfigurationSchema.safeParse(input).success, false);
  assert.ok(
    inboundQueueConfigurationSchema.safeParse({ overflowPolicy: "flow", overflowFlowVersionId: recordingId })
      .success
  );
});

test("B01.1–B01.2 bounded flows retain normalized targets, action order and duration", () => {
  const result = inboundFlowVersionSchema.parse({ actions: [audio(), forward(), audio()] });
  assert.equal(result.flowTimeoutMs, 90000);
  assert.equal(result.actions[1].type === "forward_external" && result.actions[1].target, "+14155550100");
  assert.ok(inboundFlowVersionSchema.safeParse({ actions: [{ type: "hangup" }] }).success);
  for (const actions of [
    [],
    [audio(), audio(), audio()],
    [forward(), forward()],
    [audio(), forward(), audio(), { type: "hangup" }],
    [{ type: "hangup" }, audio()],
    [{ ...audio(), nextFlowId: recordingId }],
    [{ ...forward(), target: "+123" }],
    [audio(999)],
    [forward(30001)]
  ]) {
    assert.equal(inboundFlowVersionSchema.safeParse({ actions }).success, false);
  }
  assert.equal(
    inboundFlowVersionSchema.safeParse({ actions: [audio(), forward()], flowTimeoutMs: 49999 }).success,
    false
  );
  assert.ok(
    inboundFlowVersionSchema.safeParse({ actions: [audio(), forward()], flowTimeoutMs: 50000 }).success
  );
});

test("F01.1–F01.2 flow validation keeps finite failure continuations and rejects dial/graph injection", () => {
  for (const actions of [[audio(), { type: "hangup" }], [forward()], [audio(), forward(), audio()]])
    assert.ok(inboundFlowVersionSchema.safeParse({ actions }).success);
  for (const actions of [
    [{ ...forward(), target: undefined }],
    [{ ...audio(), recordingId: undefined }],
    [{ ...forward(), retry: true }],
    [{ type: "forward_external", target: "+14155550100", timeoutMs: 20000, onFailure: recordingId }],
    [{ type: "flow", flowId: recordingId }],
    [{ type: "hangup", target: "+14155550100" }]
  ])
    assert.equal(inboundFlowVersionSchema.safeParse({ actions }).success, false);
  const saved = inboundFlowVersionSchema.parse({ actions: [forward()] });
  assert.equal(saved.actions[0].type === "forward_external" && saved.actions[0].target, "+14155550100");
});
