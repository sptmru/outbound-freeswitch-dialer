import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { inboundFallbackCommand } from "./inbound-fallback.js";
import type { DurableCommand } from "./call-executor.js";
test("F03 U: fixed retained leg, bounded deadline and safe immutable audio path", () => {
  const id = randomUUID();
  const op: DurableCommand = {
    id: randomUUID(),
    call_id: id,
    target_uuid: id,
    command_uuid: randomUUID(),
    command_kind: "play_audio",
    generation: "1",
    state: "pending",
    deadline_at: new Date(),
    result: null,
    request: { inboundFallback: true, audio: "/a02/file.wav", deadlineEpoch: "1794839000" }
  };
  assert.equal(
    inboundFallbackCommand(op),
    `uuid_transfer ${id} inbound_fallback:${op.id}:1794839000:/a02/file.wav XML inbound-fallback`
  );
  for (const audio of [
    null,
    "/a02/../secret",
    "http://example.test/a.wav",
    "/a02/a.wav XML default",
    "/a02/a.wav\napi status"
  ])
    assert.throws(() => inboundFallbackCommand({ ...op, request: { ...op.request, audio } }));
  for (const deadlineEpoch of ["NaN", "0", "1794839000;status"])
    assert.throws(() => inboundFallbackCommand({ ...op, request: { ...op.request, deadlineEpoch } }));
  assert.throws(() => inboundFallbackCommand({ ...op, target_uuid: randomUUID() }));
  assert.equal(inboundFallbackCommand({ ...op, command_kind: "hangup" }), `uuid_kill ${id} NORMAL_CLEARING`);
});

test("F04 U: fixed caller identity, strict saved target, bounded command framing", async () => {
  const { forwardingDestination } = await import("./inbound-forwarding.js");
  const config = {
    SIP_TRUNK_MODE: "ip_auth" as const,
    SIP_TRUNK_PROXY: "127.0.0.1:5099",
    SIP_TRUNK_CALLER_ID: "+12025550100"
  };
  const destination = forwardingDestination("+14155550101", config)!;
  assert.equal(destination.dialString, "sofia/external/14155550101@127.0.0.1:5099");
  for (const target of ["invalid", "+12025550100", "+1 (415) 555-0101"])
    assert.equal(forwardingDestination(target, config), null);
  assert.equal(forwardingDestination("+14155550101"), null);
  assert.equal(
    forwardingDestination("+14155550101", { ...config, SIP_TRUNK_PROXY: "host;api status" }),
    null
  );
  const id = randomUUID();
  const op = {
    id: randomUUID(),
    call_id: id,
    target_uuid: id,
    command_kind: "forward_external",
    request: {
      inboundFallback: true,
      ...destination,
      externalUuid: randomUUID(),
      deadlineEpoch: "1794839000",
      flowDeadlineEpoch: "1794839010"
    }
  } as unknown as DurableCommand;
  assert.match(inboundFallbackCommand(op), /^uuid_transfer .* XML inbound-forward$/);
  for (const field of ["externalUuid", "callerId", "dialString", "deadlineEpoch", "flowDeadlineEpoch"])
    assert.throws(() =>
      inboundFallbackCommand({ ...op, request: { ...op.request, [field]: "bad\napi status" } })
    );
});
